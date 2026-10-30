'use strict';
/**
 * המקליט הווירטואלי — משתתף שנכנס לשיחת ה-Zoom ומקליט אותה.
 *
 * למה שירות חיצוני (Recall.ai) ולא ההקלטה בענן של Zoom: הקלטה בענן קיימת רק
 * בפגישות שהחברה מארחת, ורק ברישיון בתשלום. פגישה שלקוח או ספק הזמין אליה —
 * Zoom של מישהו אחר — אי אפשר להקליט מבחוץ. משתתף וירטואלי נכנס לכל קישור,
 * כמו כל אורח, בשם שכולם רואים ("משימון — מקליט הפגישה"), ומודיע בצ'אט שהוא מקליט.
 *
 * הגדרה: חשבון ב-Recall.ai ← API Key ← ‎RECALL_API_KEY‎. האזור — ‎RECALL_REGION‎
 * (‎us-west-2‎ כברירת מחדל; ‎eu-central-1‎ לחשבון באירופה). המפתח שייך לאזור שבו נפתח.
 *
 * הקובץ הזה הוא כל המגע עם Recall: יצירה, תזמון, מצב, והורדת התוצרים.
 */

const apiKey = () => process.env.RECALL_API_KEY ?? '';
const region = () => String(process.env.RECALL_REGION || 'us-west-2').trim();
const base = () => `https://${region()}.recall.ai/api/v1`;
const isEnabled = () => Boolean(apiKey());

class RecallError extends Error {}

async function call(method, path, body = null) {
  if (!isEnabled()) throw new RecallError('המקליט אינו מוגדר בשרת (RECALL_API_KEY)');
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { authorization: `Token ${apiKey()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.detail ?? j.message ?? JSON.stringify(j).slice(0, 300);
    } catch { /* טקסט */ }
    const err = new RecallError(`Recall החזיר ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * מקליט לפגישה. ‎joinAt‎ — מתי להיכנס (ריק = עכשיו). Recall מבטיח הגעה בזמן
 * רק לתזמון של 10 דקות ומעלה מראש; פחות מזה — נכנס מיד כשיש מקליט פנוי.
 */
async function createBot({ meetingUrl, joinAt = null, botName, message = '', language = 'he', metadata = {} }) {
  const bot = await call('POST', '/bot/', {
    meeting_url: meetingUrl,
    bot_name: String(botName || 'משימון').slice(0, 100),
    ...(joinAt && new Date(joinAt).getTime() > Date.now() + 10 * 60 * 1000 ? { join_at: new Date(joinAt).toISOString() } : {}),
    recording_config: {
      transcript: { provider: { recallai_streaming: { language_code: language || 'he', mode: 'prioritize_accuracy' } } }
    },
    ...(message ? { chat: { on_bot_join: { send_to: 'everyone', message: String(message).slice(0, 500) } } } : {}),
    // אף אחד לא הגיע / כולם יצאו — המקליט יוצא ולא נשאר לשווא
    automatic_leave: { waiting_room_timeout: 1200, noone_joined_timeout: 1200 },
    metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)]))
  });
  return { id: bot.id };
}

/** הזזת מועד הכניסה — רק למקליט שעוד לא נכנס */
async function reschedule(botId, joinAt) {
  await call('PATCH', `/bot/${encodeURIComponent(botId)}/`, { join_at: new Date(joinAt).toISOString() });
}

/** ביטול — מקליט מתוזמן נמחק; מקליט שכבר בשיחה יוצא ממנה */
async function cancel(botId) {
  try {
    await call('DELETE', `/bot/${encodeURIComponent(botId)}/`);
  } catch (err) {
    if (err.status === 404) return;
    // כבר נכנס — אי אפשר למחוק, אפשר להוציא
    await call('POST', `/bot/${encodeURIComponent(botId)}/leave_call/`).catch(() => {});
  }
}

/*
 * מצב המקליט, בשפה של משימון:
 *   scheduled — עוד לא נכנס · joining — בכניסה / בחדר ההמתנה · recording — בשיחה
 *   ended — השיחה הסתיימה, התוצרים בעיבוד · done — התוצרים מוכנים · failed — לא הצליח
 */
const STATE = {
  ready: 'scheduled', joining_call: 'joining', in_waiting_room: 'joining',
  in_call_not_recording: 'recording', recording_permission_allowed: 'recording', in_call_recording: 'recording',
  call_ended: 'ended', recording_done: 'ended', done: 'done',
  fatal: 'failed', recording_permission_denied: 'failed', analysis_failed: 'failed'
};

/** הסבר בעברית לסיבת הכישלון — מה שהמשתמש צריך לדעת כדי שזה לא יקרה שוב */
const FAIL_REASON = {
  meeting_not_found: 'הקישור לפגישה אינו תקף',
  meeting_password_incorrect: 'הסיסמה בקישור שגויה',
  meeting_requires_registration: 'הפגישה דורשת הרשמה מראש',
  meeting_requires_sign_in: 'הפגישה פתוחה רק למשתמשי Zoom מחוברים',
  timeout_exceeded_waiting_room: 'המארח לא הכניס את המקליט מחדר ההמתנה',
  timeout_exceeded_noone_joined: 'אף משתתף לא הגיע לפגישה',
  timeout_exceeded_everyone_left: 'כל המשתתפים יצאו',
  recording_permission_denied: 'המארח לא אישר הקלטה',
  bot_kicked_from_call: 'המקליט הוצא מהשיחה',
  bot_kicked_from_waiting_room: 'המקליט נדחה מחדר ההמתנה',
  zoom_meeting_not_started: 'הפגישה לא התחילה'
};

function shapeBot(bot) {
  const last = bot.status_changes?.at?.(-1) ?? bot.status ?? {};
  const code = String(last.code ?? '');
  const sub = String(last.sub_code ?? '');
  const rec = (bot.recordings ?? [])[0] ?? null;
  const media = rec?.media_shortcuts ?? {};
  const ready = (m) => (m?.status?.code === 'done' ? m.data?.download_url ?? null : null);
  return {
    code,
    state: STATE[code] ?? (code ? 'joining' : 'scheduled'),
    reason: FAIL_REASON[sub] ?? FAIL_REASON[code] ?? (sub || code),
    videoUrl: ready(media.video_mixed),
    // התמלול מעובד אחרי שהשיחה נגמרת — ‎processing‎ = לחכות, ‎failed‎ = לא יגיע
    transcriptUrl: ready(media.transcript),
    transcriptState: media.transcript?.status?.code ?? (rec ? 'processing' : 'none'),
    videoState: media.video_mixed?.status?.code ?? (rec ? 'processing' : 'none')
  };
}

async function getBot(botId) {
  return shapeBot(await call('GET', `/bot/${encodeURIComponent(botId)}/`));
}

/**
 * התמלול כטקסט קריא: "[12:04] דנה: ..." — פסקה לכל דובר רצוף.
 * הפורמט של Recall: ‎[{ participant: { name }, words: [{ text, start_timestamp: { relative } }] }]‎
 */
async function transcriptText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new RecallError(`הורדת התמלול נכשלה (${res.status})`);
  const parts = await res.json();
  const stamp = (s) => {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const lines = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    const words = p.words ?? [];
    if (!words.length) continue;
    const text = words.map((w) => w.text).join(' ').replace(/\s+([,.?!])/g, '$1').trim();
    if (!text) continue;
    const who = p.participant?.name || 'משתתף';
    const prev = lines.at(-1);
    if (prev && prev.who === who) prev.text += ` ${text}`;
    else lines.push({ at: stamp(words[0].start_timestamp?.relative), who, text });
  }
  return lines.map((l) => `[${l.at}] ${l.who}: ${l.text}`).join('\n');
}

/** הווידאו כזרם — לא נטען לזיכרון. ‎size‎ מהכותרות, כשידוע */
async function openVideo(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!res.ok || !res.body) throw new RecallError(`הורדת הווידאו נכשלה (${res.status})`);
  return { body: res.body, size: Number(res.headers.get('content-length')) || null, type: res.headers.get('content-type') || 'video/mp4' };
}

module.exports = { isEnabled, region, createBot, reschedule, cancel, getBot, transcriptText, openVideo, RecallError, _internal: { shapeBot } };
