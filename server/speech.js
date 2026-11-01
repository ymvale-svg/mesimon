'use strict';
/**
 * תמלול הודעות קוליות, בעברית.
 *
 * משמש את בוט הוואטסאפ: הודעה קולית לבוט מתומללת ומטופלת בדיוק כמו הודעה
 * כתובה. ההקלטה באפליקציה אינה עוברת כאן — שם הדפדפן מתמלל בעצמו.
 *
 * שלושה ספקים, לפי הסדר הזה — כל אחד גיבוי לקודם (נכשל, או החזיר ריק):
 *   1. ivrit.ai על RunPod (‎RUNPOD_API_KEY‎ + ‎RUNPOD_ENDPOINT_ID‎) — Whisper שאומן
 *      על עברית, ב-endpoint בחשבון ה-RunPod של הארגון. המודל:
 *      ‎RUNPOD_TRANSCRIBE_MODEL‎ (ברירת מחדל: ‎ivrit-ai/whisper-large-v3-turbo-ct2‎).
 *      endpoint שלא היה בשימוש "מתעורר" — הבקשה הראשונה אחרי הפסקה איטית.
 *   2. OpenAI (‎OPENAI_API_KEY‎) — מקבל את קובץ ה-ogg של וואטסאפ כמו שהוא.
 *      המודל: ‎OPENAI_TRANSCRIBE_MODEL‎ (ברירת מחדל: ‎gpt-4o-transcribe‎).
 *   3. Google Cloud Speech-to-Text (‎GOOGLE_SPEECH_API_KEY‎).
 * בלי אף אחד מהם — הבוט ממשיך לבקש טקסט.
 *
 * מצב השוואה (‎compare‎): כל הספקים המוגדרים רצים במקביל על אותה הקלטה, כדי
 * להשוות דיוק ומהירות. התשובה לעובד — מהספק הראשון בסדר שהצליח.
 *
 * הקובץ אינו נשמר: הוא נמשך מ-Green API, נשלח לתמלול, ונזרק. רק הטקסט נשאר.
 */

// ---------------------------------------------------------------------------
// ivrit.ai על RunPod
//
// הפרוטוקול כמו בחבילת ‎ivrit‎ של ivrit.ai (‎RunPodModel‎): שליחת עבודה ל-‎/run‎
// עם ההקלטה ב-base64, וקריאת התוצאות מ-‎/stream‎ עד שהעבודה מסתיימת. ‎/stream‎
// מדווח "הסתיים" גם על עבודה שנכשלה — ולכן הסטטוס האמיתי נקרא מ-‎/status‎.
// ---------------------------------------------------------------------------

const RUNPOD_MAX_BYTES = 7 * 1024 * 1024; // ‎10MB‎ לבקשה כולה, ו-base64 מגדיל בשליש
const runpodKey = () => String(process.env.RUNPOD_API_KEY ?? '').trim();
const runpodEndpoint = () => String(process.env.RUNPOD_ENDPOINT_ID ?? '').trim();
const runpodModel = () => String(process.env.RUNPOD_TRANSCRIBE_MODEL ?? '').trim() || 'ivrit-ai/whisper-large-v3-turbo-ct2';
// כולל "התעוררות" של endpoint שלא היה בשימוש — אחרי זה עוברים לגיבוי
const runpodTimeout = () => (Number(process.env.RUNPOD_TIMEOUT_SECONDS) || 90) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runpod(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(runpodEndpoint())}${path}`, {
    method,
    headers: { authorization: `Bearer ${runpodKey()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  if (res.status === 401) throw new Error('RunPod דחה את המפתח (RUNPOD_API_KEY)');
  if (!res.ok) throw new Error(`RunPod החזיר ${res.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function transcribeRunPod(buf) {
  if (buf.length > RUNPOD_MAX_BYTES) throw new Error('ההודעה הקולית ארוכה מדי לתמלול ב-RunPod');
  const job = await runpod('/run', {
    method: 'POST',
    body: {
      input: {
        type: 'blob',
        model: runpodModel(),
        engine: 'faster-whisper',
        streaming: true,
        transcribe_args: {
          language: 'he',
          diarize: false,
          diarization_args: null,
          // בלי חותמות זמן למילים — רק הטקסט, וכך התשובה קטנה
          output_options: { word_timestamps: false, extra_data: false },
          verbose: false,
          blob: buf.toString('base64')
        }
      }
    }
  });
  if (!job.id) throw new Error('RunPod לא החזיר מזהה עבודה');

  const parts = [];
  const until = Date.now() + runpodTimeout();
  try {
    while (Date.now() < until) {
      const data = await runpod(`/stream/${encodeURIComponent(job.id)}`);
      for (const item of data.stream ?? []) {
        for (const entry of Array.isArray(item.output) ? item.output : []) {
          if (entry?.type === 'segments') parts.push(...(entry.data ?? []).map((seg) => String(seg?.text ?? '')));
          else if (entry?.type === 'error') throw new Error(`ivrit.ai: ${String(entry.data).slice(0, 200)}`);
        }
      }
      if (data.status === 'COMPLETED' || !['IN_QUEUE', 'IN_PROGRESS'].includes(data.status)) {
        const status = await runpod(`/status/${encodeURIComponent(job.id)}`);
        if (status.status === 'COMPLETED') return parts.join(' ').replace(/\s+/g, ' ').trim();
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error(`עבודת RunPod ${status.status}: ${String(status.error ?? '').slice(0, 200)}`);
      }
      await sleep(1000);
    }
  } catch (err) {
    runpod(`/cancel/${encodeURIComponent(job.id)}`, { method: 'POST' }).catch(() => {});
    throw err;
  }
  // לא נגמר בזמן (בדרך כלל endpoint שמתעורר) — מבטלים, והגיבוי ממשיך
  runpod(`/cancel/${encodeURIComponent(job.id)}`, { method: 'POST' }).catch(() => {});
  throw new Error(`RunPod לא סיים תוך ${Math.round(runpodTimeout() / 1000)} שניות`);
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_MAX_BYTES = 25 * 1024 * 1024; // המגבלה של OpenAI לקובץ
const openaiKey = () => String(process.env.OPENAI_API_KEY ?? '').trim();
const openaiModel = () => String(process.env.OPENAI_TRANSCRIBE_MODEL ?? '').trim() || 'gpt-4o-transcribe';

/** סיומת לפי סוג הקובץ — OpenAI מזהה את הפורמט לפי שם הקובץ */
function extOf(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg'; // הודעה קולית של וואטסאפ: ‎audio/ogg; codecs=opus‎
}

async function transcribeOpenAI(buf, mime) {
  if (buf.length > OPENAI_MAX_BYTES) throw new Error('ההודעה הקולית ארוכה מדי לתמלול');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: String(mime || 'audio/ogg').split(';')[0] }), `voice.${extOf(mime)}`);
  form.append('model', openaiModel());
  form.append('language', 'he');
  form.append('response_format', 'json');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiKey()}` },
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI החזיר ${res.status}: ${text.slice(0, 200)}`);
  try {
    return String(JSON.parse(text).text ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Speech-to-Text
//
// עד דקה — תמלול מיידי (‎speech:recognize‎). ארוך מזה — ‎longrunningrecognize‎,
// עם המתנה לתוצאה. ‎v1p1beta1‎ ולא ‎v1‎: רק בה יש MP3.
// ---------------------------------------------------------------------------

const API = 'https://speech.googleapis.com/v1p1beta1';
const MAX_BYTES = 10 * 1024 * 1024; // המגבלה של Google לתוכן שנשלח בבקשה עצמה
const LONG_WAIT_MS = 120000;

const apiKey = () => String(process.env.GOOGLE_SPEECH_API_KEY ?? '').trim();

/** תדר הדגימה ממה שבכותרת ‎OpusHead‎. ‎Google‎ מקבל רק תדרים מסוימים לאופוס */
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
function opusRate(buf) {
  const at = buf.indexOf('OpusHead');
  if (at < 0 || buf.length < at + 16) return 48000;
  const rate = buf.readUInt32LE(at + 12);
  return OPUS_RATES.includes(rate) ? rate : 48000;
}

function configFor(mime, buf) {
  const m = String(mime ?? '').toLowerCase();
  // הגדרה מינימלית: פיסוק אוטומטי ושפה חלופית אינם נתמכים בכל שפה ובכל מודל,
  // ובקשה עם שדה שאינו נתמך לעברית נכשלת כולה — עדיף תמלול בלי פיסוק
  const base = { languageCode: 'he-IL' };
  if (m.includes('mpeg') || m.includes('mp3')) return { ...base, encoding: 'MP3', sampleRateHertz: 44100 };
  if (m.includes('wav')) return { ...base, encoding: 'LINEAR16' };
  if (m.includes('webm')) return { ...base, encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (m.includes('amr')) return { ...base, encoding: 'AMR', sampleRateHertz: 8000 };
  // הודעה קולית של וואטסאפ: ‎audio/ogg; codecs=opus‎
  return { ...base, encoding: 'OGG_OPUS', sampleRateHertz: opusRate(buf) };
}

async function call(path, body = null) {
  const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey())}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Google Speech החזיר ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const joinResults = (out) => (out?.results ?? [])
  .map((r) => r.alternatives?.[0]?.transcript ?? '')
  .join(' ').replace(/\s+/g, ' ').trim();

/** ארוך מדקה: עבודה ברקע, ובודקים כל שתי שניות עד שהיא מסתיימת */
async function longRecognize(body) {
  const op = await call('/speech:longrunningrecognize', body);
  const until = Date.now() + LONG_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const state = await call(`/operations/${encodeURIComponent(op.name)}`);
    if (state.error) throw new Error(state.error.message || 'התמלול נכשל');
    if (state.done) return joinResults(state.response);
  }
  throw new Error('התמלול לקח יותר מדי זמן');
}

async function transcribeGoogle(buf, mime) {
  if (buf.length > MAX_BYTES) throw new Error('ההודעה הקולית ארוכה מדי לתמלול');
  const body = { config: configFor(mime, buf), audio: { content: buf.toString('base64') } };
  try {
    return joinResults(await call('/speech:recognize', body));
  } catch (err) {
    if (err.status === 400 && /too long|longrunningrecognize/i.test(err.body ?? '')) return longRecognize(body);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// הסדר, הגיבוי וההשוואה
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { key: 'ivrit', name: 'ivrit.ai', ready: () => Boolean(runpodKey() && runpodEndpoint()), run: (buf) => transcribeRunPod(buf) },
  { key: 'openai', name: 'OpenAI', ready: () => Boolean(openaiKey()), run: (buf, mime) => transcribeOpenAI(buf, mime) },
  { key: 'google', name: 'Google', ready: () => Boolean(apiKey()), run: (buf, mime) => transcribeGoogle(buf, mime) }
];

/** הספקים המוגדרים, לפי הסדר — ‎[{ key, name }]‎ */
const providers = () => PROVIDERS.filter((p) => p.ready()).map(({ key, name }) => ({ key, name }));
const isEnabled = () => providers().length > 0;
const nameOf = (key) => PROVIDERS.find((p) => p.key === key)?.name ?? key;

/** ספק אחד, עם מדידת זמן. לעולם לא זורק — השגיאה חוזרת בתוצאה */
async function attempt(p, buf, mime) {
  const t0 = Date.now();
  try {
    const text = await p.run(buf, mime);
    return { key: p.key, name: p.name, text, ms: Date.now() - t0, error: null };
  } catch (err) {
    return { key: p.key, name: p.name, text: '', ms: Date.now() - t0, error: err.message };
  }
}

/**
 * תמלול: ספק אחרי ספק, לפי הסדר, עד הראשון שהחזיר טקסט.
 *
 * ‎compare‎ — כל הספקים רצים במקביל. התשובה — מהראשון בסדר שהצליח (ולכן
 * גם הגיבוי מהיר יותר: הוא כבר רץ). ‎all‎ — הבטחה לתוצאות של כולם, להשוואה.
 *
 * @returns {Promise<{text: string, used: object|null, attempts: object[], all: Promise<object[]>|null}>}
 */
async function transcribeDetailed(buf, mime, { compare = false } = {}) {
  const ready = PROVIDERS.filter((p) => p.ready());
  if (!ready.length) throw new Error('תמלול הודעות קוליות אינו מוגדר (RUNPOD_API_KEY, OPENAI_API_KEY או GOOGLE_SPEECH_API_KEY)');
  if (compare && ready.length > 1) {
    const running = ready.map((p) => attempt(p, buf, mime));
    const attempts = [];
    for (const r of running) {
      const res = await r;
      attempts.push(res);
      if (!res.error && res.text) return { text: res.text, used: res, attempts, all: Promise.all(running) };
    }
    return { text: '', used: null, attempts, all: Promise.all(running) };
  }
  const attempts = [];
  for (const p of ready) {
    const res = await attempt(p, buf, mime);
    attempts.push(res);
    if (!res.error && res.text) return { text: res.text, used: res, attempts, all: null };
  }
  // אף ספק לא החזיר טקסט: אם כולם נכשלו — שגיאה; אחרת פשוט לא נשמע דיבור
  if (attempts.every((a) => a.error)) throw new Error(attempts.map((a) => `${a.name}: ${a.error}`).join(' · '));
  return { text: '', used: null, attempts, all: null };
}

/** תמלול של קובץ שמע. מחזיר טקסט, או מחרוזת ריקה כשלא נשמע דיבור */
async function transcribe(buf, mime) {
  return (await transcribeDetailed(buf, mime)).text;
}

/** ההקלטה מהכתובת ש-Green API נתן */
async function download(url, mime) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`הורדת ההודעה הקולית נכשלה (${res.status})`);
  return { buf: Buffer.from(await res.arrayBuffer()), mime: mime || res.headers.get('content-type') || '' };
}

/** הורדת הקובץ מהכתובת ש-Green API נתן, ותמלול */
async function transcribeUrl(url, mime) {
  const file = await download(url, mime);
  return transcribe(file.buf, file.mime);
}

module.exports = {
  isEnabled, providers, nameOf, transcribe, transcribeDetailed, transcribeUrl, download,
  _internal: { configFor, opusRate, extOf, transcribeRunPod }
};
