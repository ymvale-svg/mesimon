'use strict';
/**
 * חיבור Gmail אישי — קריאה בלבד (‎gmail.readonly‎).
 *
 * על אותו לקוח Google שמשמש לכניסה, ועם אותה כתובת חזרה — כך אין צורך
 * לרשום ב-Google Cloud כתובת נוספת. ההבחנה בין "כניסה" ל"חיבור תיבה" היא
 * לפי ה-state: מצב שנוצר כאן שייך לחיבור תיבה של משתמש מסוים.
 *
 * משימון לא שולח, לא מוחק ולא מסמן כנקרא — ההרשאה עצמה אינה מאפשרת זאת.
 *
 * מה עושים עם התיבה:
 *   • סריקה — מיילים שלא נקראו הופכים להצעות משימה (‎ai/mail-scan.js‎)
 *   • זיהוי תשובות — נמען שענה ישירות למשתמש ולא לתיבת המערכת
 *   • זיהוי קשר — המשתמש כתב לנמען בעצמו, והמעקב עוצר לשאול
 */
const crypto = require('node:crypto');
const D = require('./db');
const Google = require('./google-auth');
const Secrets = require('./secrets');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

const isEnabled = () => Google.isEnabled();

// --- מצב זמני בין הפנייה ל-Google לחזרה ממנו, לכל משתמש ---

const STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map();

function authorizeUrl(req, user) {
  const state = `gm_${crypto.randomBytes(24).toString('hex')}`;
  pending.set(state, { userId: user.id, expires: Date.now() + STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: Google.CLIENT_ID,
    redirect_uri: Google.redirectUri(req),
    response_type: 'code',
    scope: `openid email ${SCOPE}`,
    state,
    // ‎offline‎ + ‎consent‎ — כדי לקבל אסימון רענון גם ממי שכבר אישר בעבר
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: user.email ?? ''
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const isGmailState = (state) => String(state ?? '').startsWith('gm_');

/** המשתמש שהחזרה הזו שייכת לו, או ‎null‎ — שימוש חד-פעמי */
function consumeState(state) {
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  return Date.now() <= entry.expires ? entry.userId : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now > v.expires) pending.delete(k);
}, STATE_TTL_MS).unref?.();

// --- אסימונים ---

const tokens = new Map(); // userId → { access, expires }

async function tokenRequest(params) {
  const res = await fetch(Google.TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: Google.CLIENT_ID, client_secret: Google.CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google דחה את הבקשה (${res.status}): ${data.error_description ?? data.error ?? ''}`.trim());
    err.revoked = data.error === 'invalid_grant';
    throw err;
  }
  return data;
}

async function connect(userId, code, req) {
  const data = await tokenRequest({ code, redirect_uri: Google.redirectUri(req), grant_type: 'authorization_code' });
  if (!String(data.scope ?? '').includes(SCOPE)) throw new Error('לא אושרה הרשאת קריאת הדואר. יש לסמן את התיבה במסך האישור של Google.');
  if (!data.refresh_token) throw new Error('Google לא החזיר אסימון רענון. נסו לנתק את משימון בהגדרות חשבון ה-Google ולחבר שוב.');
  tokens.set(userId, { access: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3000) - 60) * 1000 });
  const profile = await call(userId, '/profile');
  D.run(
    `INSERT INTO mail_connections (user_id, email, refresh_token, scope, state, error, created_at)
     VALUES (?,?,?,?,'ok','',?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token,
       scope = excluded.scope, state = 'ok', error = ''`,
    userId, String(profile.emailAddress ?? '').toLowerCase(), Secrets.encrypt(data.refresh_token), String(data.scope), D.nowIso()
  );
}

const connectionOf = (userId) => D.get('SELECT * FROM mail_connections WHERE user_id = ?', userId);

async function accessToken(userId) {
  const cached = tokens.get(userId);
  if (cached && cached.expires > Date.now()) return cached.access;
  const conn = connectionOf(userId);
  if (!conn || conn.state === 'revoked') throw new Error('תיבת ה-Gmail אינה מחוברת');
  const refresh = Secrets.decrypt(conn.refresh_token);
  if (!refresh) {
    D.run("UPDATE mail_connections SET state = 'revoked', error = ? WHERE user_id = ?", 'החיבור אינו קריא — יש לחבר מחדש', userId);
    throw new Error('החיבור לתיבה אינו קריא — יש לחבר את Gmail מחדש');
  }
  try {
    const data = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
    tokens.set(userId, { access: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3000) - 60) * 1000 });
    if (conn.state !== 'ok') D.run("UPDATE mail_connections SET state = 'ok', error = '' WHERE user_id = ?", userId);
    return data.access_token;
  } catch (err) {
    // ההרשאה בוטלה בצד של Google — אין טעם לנסות שוב עד שיחבר מחדש
    if (err.revoked) D.run("UPDATE mail_connections SET state = 'revoked', error = ? WHERE user_id = ?", 'ההרשאה בוטלה ב-Google — יש לחבר מחדש', userId);
    throw err;
  }
}

async function call(userId, path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const url = `${API}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken(userId)}` },
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) tokens.delete(userId);
    throw new Error(`Gmail החזיר ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** מזהי ההודעות לחיפוש — בתחביר החיפוש של Gmail */
async function search(userId, q, { max = 100 } = {}) {
  const ids = [];
  let pageToken;
  do {
    const page = await call(userId, '/messages', { q, maxResults: Math.min(100, max - ids.length), pageToken });
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

/** ההודעה המלאה כ-RFC 822 — לפענוח ב-‎mime.js‎, כמו דואר שהגיע ב-IMAP */
async function raw(userId, id) {
  const m = await call(userId, `/messages/${encodeURIComponent(id)}`, { format: 'raw' });
  return {
    id: m.id,
    threadId: m.threadId,
    labels: m.labelIds ?? [],
    internalDate: m.internalDate ? new Date(Number(m.internalDate)) : null,
    raw: Buffer.from(String(m.raw ?? ''), 'base64url')
  };
}

async function disconnect(userId) {
  const conn = connectionOf(userId);
  tokens.delete(userId);
  if (!conn) return;
  const refresh = Secrets.decrypt(conn.refresh_token);
  if (refresh) {
    // ביטול ההרשאה גם בצד של Google — לא רק מחיקה אצלנו
    await fetch(`${REVOKE}?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  D.run('DELETE FROM mail_connections WHERE user_id = ?', userId);
}

const connectedUsers = () => D.all(
  "SELECT c.user_id FROM mail_connections c JOIN users u ON u.id = c.user_id WHERE c.state = 'ok' AND u.status = 'active'"
).map((r) => r.user_id);

const isConnected = (userId) => connectionOf(userId)?.state === 'ok';

/** תצוגה ללקוח — בלי האסימון */
function publicStatus(userId) {
  const c = connectionOf(userId);
  if (!c) return null;
  return {
    email: c.email,
    state: c.state,
    error: c.error,
    scanning: Boolean(c.scan_running),
    progress: (() => { try { return JSON.parse(c.scan_progress); } catch { return {}; } })(),
    lastScanAt: c.last_scan_at,
    connectedAt: c.created_at
  };
}

/** קישור למייל בתוך Gmail — נפתח רק אצל בעל התיבה */
const webLink = (email, gmailId) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(gmailId)}`;

module.exports = {
  isEnabled, authorizeUrl, isGmailState, consumeState, connect, disconnect,
  search, raw, connectedUsers, isConnected, connectionOf, publicStatus, webLink, SCOPE
};
