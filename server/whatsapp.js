'use strict';
/**
 * וואטסאפ מהמספר האישי של המשתמש — דרך Green API.
 *
 * למה Green API ולא WhatsApp Business Cloud של מטא: הבקשה היא שההודעה תצא
 * מהמספר של המשתמש עצמו, כדי שהנמען יראה את מי שהוא מכיר. ה-API הרשמי של
 * מטא מחייב מספר עסקי נפרד. Green API מחבר את הוואטסאפ הקיים כ"מכשיר מקושר"
 * (סריקת QR, כמו וואטסאפ ווב), והמשתמש ממשיך לראות את ההתכתבות בטלפון שלו.
 *
 * תשובות נמשכות בסקירה (‎receiveNotification‎) ולא ב-webhook — כך זה עובד
 * גם כשמשימון רץ על מחשב במשרד בלי כתובת ציבורית.
 *
 * לכל משתמש חיבור משלו (טבלת ‎user_channels‎). האסימון אינו נשלח לעולם ללקוח.
 */
const D = require('./db');

const DEFAULT_API_URL = 'https://api.green-api.com';

function channelOf(userId) {
  const row = D.get("SELECT * FROM user_channels WHERE user_id = ? AND provider = 'green_api'", userId);
  return row && row.instance_id && row.api_token ? row : null;
}

/** תצוגה ללקוח — בלי האסימון */
function publicChannel(userId) {
  const row = D.get("SELECT * FROM user_channels WHERE user_id = ? AND provider = 'green_api'", userId);
  if (!row) return null;
  return {
    provider: 'green_api',
    apiUrl: row.api_url,
    instanceId: row.instance_id,
    phone: row.phone,
    state: row.state,
    checkedAt: row.checked_at,
    hasToken: Boolean(row.api_token)
  };
}

/**
 * מספר בפורמט שוואטסאפ מכיר: קידומת מדינה בלי אפס ובלי סימנים.
 * ‎054-123-4567‎ → ‎972541234567‎. ברירת המחדל לקידומת היא ישראל.
 */
function normalizePhone(phone) {
  let digits = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `972${digits.slice(1)}`;
  return /^\d{9,15}$/.test(digits) ? digits : null;
}

const chatIdOf = (phone) => {
  const n = normalizePhone(phone);
  return n ? `${n}@c.us` : null;
};

async function call(channel, method, { http = 'GET', body = null, suffix = '' } = {}) {
  const base = String(channel.api_url || DEFAULT_API_URL).replace(/\/+$/, '');
  const url = `${base}/waInstance${channel.instance_id}/${method}/${channel.api_token}${suffix}`;
  const res = await fetch(url, {
    method: http,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`שירות הוואטסאפ החזיר ${res.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** מצב החיבור: ‎authorized‎ פירושו שהטלפון מקושר ואפשר לשלוח */
async function checkState(userId) {
  const channel = channelOf(userId);
  if (!channel) return { state: 'not_configured' };
  let state = 'error';
  try {
    state = (await call(channel, 'getStateInstance'))?.stateInstance ?? 'unknown';
  } catch (err) {
    D.run('UPDATE user_channels SET state = ?, checked_at = ? WHERE user_id = ?', 'error', D.nowIso(), userId);
    return { state: 'error', error: err.message };
  }
  D.run('UPDATE user_channels SET state = ?, checked_at = ? WHERE user_id = ?', state, D.nowIso(), userId);
  return { state };
}

const isReady = (userId) => {
  const channel = channelOf(userId);
  return Boolean(channel) && channel.state === 'authorized';
};

async function send(userId, phone, message) {
  const channel = channelOf(userId);
  if (!channel) throw new Error('למשתמש לא חובר וואטסאפ');
  const chatId = chatIdOf(phone);
  if (!chatId) throw new Error(`מספר הטלפון "${phone}" אינו תקין`);
  const out = await call(channel, 'sendMessage', { http: 'POST', body: { chatId, message } });
  return { externalId: out?.idMessage ?? null };
}

/** הורדת קובץ שהתקבל בהודעה — הקישור של Green API זמני */
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`הורדת הקובץ נכשלה (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * מושך את ההודעות הנכנסות שבתור של המשתמש.
 *
 * כל התראה נמחקת מהתור אחרי הקריאה, גם אם אינה רלוונטית — אחרת התור נתקע
 * על ההתראה הראשונה ושום הודעה אחריה לא תגיע. מה שאינו הודעה נכנסת (אישורי
 * מסירה, שינויי מצב) פשוט מדולג.
 *
 * גם הודעות שהמשתמש כתב בעצמו מהטלפון (‎outgoingMessageReceived‎) מוחזרות,
 * מסומנות ‎outgoing‎ — כך המעקב יודע שהמשתמש דיבר עם הנמען ועוצר לשאול.
 * ‎from‎ בהן הוא המספר של מי שקיבל את ההודעה. הודעות שמשימון עצמו שלח
 * (‎outgoingAPIMessageReceived‎) מדולגות: הן כבר רשומות אצלנו.
 *
 * @returns {Promise<Array<{from: string, text: string, file: ?{url, filename, mime}, id: string, at: Date, outgoing: boolean}>>}
 */
async function receive(userId, { max = 20 } = {}) {
  const channel = channelOf(userId);
  if (!channel) return [];
  const out = [];
  for (let i = 0; i < max; i++) {
    const note = await call(channel, 'receiveNotification', { suffix: '?receiveTimeout=5' });
    if (!note?.receiptId) break;
    try {
      const b = note.body ?? {};
      const outgoing = b.typeWebhook === 'outgoingMessageReceived';
      if ((b.typeWebhook === 'incomingMessageReceived' || outgoing) && /@c\.us$/.test(b.senderData?.chatId ?? '')) {
        const m = b.messageData ?? {};
        const file = m.fileMessageData?.downloadUrl
          ? { url: m.fileMessageData.downloadUrl, filename: m.fileMessageData.fileName || 'whatsapp-file', mime: m.fileMessageData.mimeType || 'application/octet-stream' }
          : null;
        out.push({
          from: b.senderData.chatId.replace(/@c\.us$/, ''),
          text: m.textMessageData?.textMessage
            ?? m.extendedTextMessageData?.text
            ?? m.fileMessageData?.caption
            ?? '',
          file,
          id: b.idMessage ?? String(note.receiptId),
          at: b.timestamp ? new Date(b.timestamp * 1000) : new Date(),
          outgoing
        });
      } else if (b.typeWebhook === 'stateInstanceChanged' && b.stateInstance) {
        D.run('UPDATE user_channels SET state = ?, checked_at = ? WHERE user_id = ?', b.stateInstance, D.nowIso(), userId);
      }
    } finally {
      await call(channel, 'deleteNotification', { http: 'DELETE', suffix: `/${note.receiptId}` }).catch(() => {});
    }
  }
  return out;
}

function save(userId, { apiUrl, instanceId, apiToken, phone }) {
  const existing = D.get("SELECT * FROM user_channels WHERE user_id = ? AND provider = 'green_api'", userId);
  const token = apiToken ? String(apiToken).trim() : existing?.api_token ?? '';
  D.run(
    `INSERT INTO user_channels (user_id, provider, api_url, instance_id, api_token, phone, state, created_at)
     VALUES (?, 'green_api', ?, ?, ?, ?, 'unknown', ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       api_url = excluded.api_url, instance_id = excluded.instance_id, api_token = excluded.api_token,
       phone = excluded.phone, state = 'unknown'`,
    userId,
    String(apiUrl || DEFAULT_API_URL).trim(),
    String(instanceId ?? '').trim(),
    token,
    String(phone ?? '').trim(),
    D.nowIso()
  );
}

/**
 * מבקש מ-Green API לדווח גם על הודעות שנשלחו מהטלפון. בלי זה המעקב לא
 * יודע שהמשתמש כבר התכתב עם הנמען. ניסיון בלבד — חשבון שאינו מאפשר את
 * ההגדרה ממשיך לעבוד, רק בלי הזיהוי הזה.
 */
async function enableOutgoingNotifications(userId) {
  const channel = channelOf(userId);
  if (!channel) return;
  try {
    await call(channel, 'setSettings', { http: 'POST', body: { incomingWebhook: 'yes', outgoingMessageWebhook: 'yes' } });
  } catch (err) {
    console.error('[משימון] הפעלת הדיווח על הודעות יוצאות בוואטסאפ נכשלה:', err.message);
  }
}

const remove = (userId) => D.run("DELETE FROM user_channels WHERE user_id = ? AND provider = 'green_api'", userId);

/** משתמשים שיש להם חיבור — רק אצלם יש תור לסרוק */
const connectedUsers = () => D.all(
  "SELECT user_id FROM user_channels WHERE provider = 'green_api' AND instance_id <> '' AND api_token <> ''"
).map((r) => r.user_id);

module.exports = {
  send, receive, download, checkState, isReady, save, remove, publicChannel, connectedUsers, enableOutgoingNotifications,
  normalizePhone, chatIdOf, DEFAULT_API_URL,
  // לבוט הארגוני (‎server/ai/wa-bot.js‎), שמחזיק חיבור משלו ולא של משתמש
  call
};
