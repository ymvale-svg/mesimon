'use strict';
/**
 * תמלול הודעות קוליות, בעברית.
 *
 * משמש את בוט הוואטסאפ: הודעה קולית לבוט מתומללת ומטופלת בדיוק כמו הודעה
 * כתובה. ההקלטה באפליקציה אינה עוברת כאן — שם הדפדפן מתמלל בעצמו.
 *
 * שני ספקים, לפי מה שמוגדר בשרת (OpenAI קודם, אם שניהם מוגדרים):
 *   • OpenAI (‎OPENAI_API_KEY‎) — ההגדרה הפשוטה: מפתח API אחד, בלי פרויקט ענן.
 *     מקבל את קובץ ה-ogg של וואטסאפ כמו שהוא, עם סימני פיסוק. המודל ניתן
 *     לשינוי ב-‎OPENAI_TRANSCRIBE_MODEL‎ (ברירת מחדל: ‎gpt-4o-transcribe‎).
 *   • Google Cloud Speech-to-Text (‎GOOGLE_SPEECH_API_KEY‎).
 * בלי אף אחד מהם — הבוט ממשיך לבקש טקסט.
 *
 * הקובץ אינו נשמר: הוא נמשך מ-Green API, נשלח לתמלול, ונזרק. רק הטקסט נשאר.
 */

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

/** איזה ספק מוגדר: ‎'openai'‎ · ‎'google'‎ · ‎null‎ */
const provider = () => (openaiKey() ? 'openai' : apiKey() ? 'google' : null);
const isEnabled = () => Boolean(provider());

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

/** תמלול של קובץ שמע. מחזיר טקסט, או מחרוזת ריקה כשלא נשמע דיבור */
async function transcribe(buf, mime) {
  const p = provider();
  if (!p) throw new Error('תמלול הודעות קוליות אינו מוגדר (OPENAI_API_KEY או GOOGLE_SPEECH_API_KEY)');
  if (p === 'openai') return transcribeOpenAI(buf, mime);
  if (buf.length > MAX_BYTES) throw new Error('ההודעה הקולית ארוכה מדי לתמלול');
  const body = { config: configFor(mime, buf), audio: { content: buf.toString('base64') } };
  try {
    return joinResults(await call('/speech:recognize', body));
  } catch (err) {
    if (err.status === 400 && /too long|longrunningrecognize/i.test(err.body ?? '')) return longRecognize(body);
    throw err;
  }
}

/** הורדת הקובץ מהכתובת ש-Green API נתן, ותמלול */
async function transcribeUrl(url, mime) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`הורדת ההודעה הקולית נכשלה (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return transcribe(buf, mime || res.headers.get('content-type'));
}

module.exports = { isEnabled, provider, transcribe, transcribeUrl, _internal: { configFor, opusRate, extOf } };
