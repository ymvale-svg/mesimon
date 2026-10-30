'use strict';
/**
 * הדרייב הייעודי של החברה — חשבון שירות (Service Account) של Google.
 *
 * ההקלטות אינן נשמרות בדרייב של עובד מסוים: עובד שעוזב היה לוקח איתו את כל
 * ההקלטות. במקום זה — חשבון שירות אחד, שחבר ב-Shared Drive ייעודי של החברה
 * ("הקלטות פגישות"), ומשימון מעלה לשם בשמו. הגדרה פעם אחת:
 *   1. Google Cloud ← IAM ← Service Accounts ← יצירה ← Keys ← JSON.
 *   2. התוכן של קובץ ה-JSON נכנס לשרת: ‎GOOGLE_SERVICE_ACCOUNT_JSON‎ (כמו שהוא, או ב-base64).
 *   3. ב-Drive: Shared Drive חדש ← חברים ← כתובת חשבון השירות כ"מנהל תוכן".
 *   4. במסך הניהול: "הקלטות: תיקייה בדרייב" — הקישור לתיקייה (או ל-Shared Drive).
 *
 * אופציונלי — יומני כל העובדים בלי שכל אחד יחבר את Google: Domain-Wide
 * Delegation בקונסולת הניהול של Google Workspace, עם ההרשאה
 * ‎calendar.events.readonly‎, ו-‎GOOGLE_WORKSPACE_DELEGATION=1‎. בלעדיו נקראים
 * היומנים של מי שחיבר את Google בעצמו.
 *
 * ללא תלויות: ה-JWT נחתם ב-‎node:crypto‎.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive';
const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

class DriveError extends Error {}

let parsed;
function account() {
  if (parsed !== undefined) return parsed;
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  parsed = null;
  if (!raw) return parsed;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (j.client_email && j.private_key) parsed = { email: j.client_email, key: j.private_key, tokenUri: j.token_uri || 'https://oauth2.googleapis.com/token' };
  } catch {
    console.error('[משימון] GOOGLE_SERVICE_ACCOUNT_JSON אינו JSON תקין של חשבון שירות');
  }
  return parsed;
}

const isEnabled = () => Boolean(account());
const delegationEnabled = () => isEnabled() && ['1', 'true', 'yes'].includes(String(process.env.GOOGLE_WORKSPACE_DELEGATION ?? '').toLowerCase());
const serviceEmail = () => account()?.email ?? '';

// ---------------------------------------------------------------------------
// אסימונים — JWT חתום, לכל צירוף של הרשאה ומשתמש מתחזה
// ---------------------------------------------------------------------------

const tokens = new Map(); // `${scope}|${sub}` → { value, expires }
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function accessToken(scope, sub = '') {
  const key = `${scope}|${sub}`;
  const hit = tokens.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const a = account();
  if (!a) throw new DriveError('חשבון השירות של Google אינו מוגדר בשרת (GOOGLE_SERVICE_ACCOUNT_JSON)');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: a.email, scope, aud: a.tokenUri, iat: now, exp: now + 3600, ...(sub ? { sub } : {})
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(a.key, 'base64url');
  const res = await fetch(a.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new DriveError(`Google דחה את חשבון השירות (${res.status}): ${data.error_description ?? data.error ?? ''}`.trim());
    err.status = res.status;
    throw err;
  }
  tokens.set(key, { value: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 });
  return data.access_token;
}

async function call(method, url, { body = null, headers = {}, scope = SCOPE_DRIVE, sub = '', timeout = 60000, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken(scope, sub)}`, ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) tokens.clear();
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* טקסט */ }
    const err = new DriveError(`Google Drive החזיר ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// הדרייב
// ---------------------------------------------------------------------------

/** מזהה תיקייה מתוך קישור — ‎/folders/<id>‎, ‎/drive/u/0/folders/<id>‎ או ‎?id=<id>‎ — או המזהה עצמו */
function folderIdOf(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const m = v.match(/\/folders\/([\w-]{10,})/) ?? v.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(v) ? v : '';
}

const ALL = 'supportsAllDrives=true';

/** בדיקה שהתיקייה קיימת ושחשבון השירות רשאי לכתוב בה — למסך הניהול */
async function checkFolder(folderId) {
  const f = await call('GET', `${DRIVE}/files/${encodeURIComponent(folderId)}?${ALL}&fields=id,name,mimeType,driveId,capabilities(canAddChildren)`);
  if (f.mimeType !== 'application/vnd.google-apps.folder') throw new DriveError('הקישור אינו לתיקייה');
  if (!f.capabilities?.canAddChildren) throw new DriveError(`לחשבון השירות אין הרשאת כתיבה בתיקייה "${f.name}"`);
  return { id: f.id, name: f.name, shared: Boolean(f.driveId) };
}

async function createFolder(name, parentId) {
  const f = await call('POST', `${DRIVE}/files?${ALL}&fields=id,webViewLink`, {
    body: { name: String(name).slice(0, 200), mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }
  });
  return { id: f.id, link: f.webViewLink ?? null };
}

/**
 * העלאה לדרייב. ‎body‎ — Buffer (טקסט קצר), או ‎filePath‎ — קובץ בדיסק שעולה
 * בזרם, בלי להיטען לזיכרון: וידאו של שעה הוא מאות MB.
 */
async function upload({ name, mimeType, parentId, body = null, filePath = null }) {
  const size = filePath ? fs.statSync(filePath).size : body.length;
  const init = await call('POST', `${UPLOAD}?uploadType=resumable&${ALL}&fields=id,webViewLink,size`, {
    body: { name: String(name).slice(0, 200), parents: [parentId] },
    headers: { 'x-upload-content-type': mimeType, 'x-upload-content-length': String(size) },
    raw: true
  });
  if (!init.ok) throw new DriveError(`פתיחת ההעלאה לדרייב נכשלה (${init.status}): ${(await init.text()).slice(0, 200)}`);
  const location = init.headers.get('location');
  const { status, text } = await new Promise((resolve, reject) => {
    const req = https.request(location, { method: 'PUT', headers: { 'content-type': mimeType, 'content-length': size }, timeout: 60 * 60 * 1000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new DriveError('ההעלאה לדרייב ארכה יותר מדי')));
    if (filePath) fs.createReadStream(filePath).on('error', reject).pipe(req);
    else req.end(body);
  });
  if (status < 200 || status >= 300) throw new DriveError(`ההעלאה לדרייב נכשלה (${status}): ${text.slice(0, 200)}`);
  const f = JSON.parse(text);
  return { id: f.id, link: f.webViewLink ?? null, size: Number(f.size ?? size) };
}

/** הורדה, עם ‎Range‎ — לנגן הווידאו במשימון. מחזיר את ה-Response כמו שהוא */
async function download(fileId, range = '') {
  return call('GET', `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&${ALL}`, {
    headers: range ? { range } : {}, raw: true, timeout: 60 * 60 * 1000
  });
}

// ---------------------------------------------------------------------------
// יומני העובדים — Domain-Wide Delegation
// ---------------------------------------------------------------------------

/** אירועים מהיומן הראשי של עובד, בהתחזות אליו. אותו פורמט של Calendar API */
async function calendarEvents(email, params) {
  const qs = new URLSearchParams(params);
  return call('GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, { scope: SCOPE_CALENDAR, sub: email });
}

module.exports = {
  isEnabled, delegationEnabled, serviceEmail, folderIdOf, checkFolder, createFolder, upload, download, calendarEvents, DriveError
};
