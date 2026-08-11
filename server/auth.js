'use strict';
/** התחברות, סשנים וזיהוי השחקן הפועל (משתמש פנימי או ספק חיצוני). */
const crypto = require('node:crypto');
const D = require('./db');
const { unauthorized, badRequest, parseCookies } = require('./http-kit');

const COOKIE = 'mesimon_sid';
const SESSION_DAYS = 14;

function createSession(actorType, actorId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  D.run(
    'INSERT INTO sessions (token, actor_type, actor_id, created_at, expires_at) VALUES (?,?,?,?,?)',
    token, actorType, actorId, now.toISOString(), expires.toISOString()
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) D.run('DELETE FROM sessions WHERE token = ?', token);
}

function purgeExpired() {
  D.run('DELETE FROM sessions WHERE expires_at < ?', D.nowIso());
}

/** מחזירה את אובייקט השחקן, או null אם אין סשן תקף */
function actorFromRequest(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = D.get('SELECT * FROM sessions WHERE token = ?', token);
  if (!session) return null;
  if (session.expires_at < D.nowIso()) {
    destroySession(token);
    return null;
  }
  return loadActor(session.actor_type, session.actor_id, token);
}

function loadActor(type, id, token = null) {
  if (type === 'user') {
    const u = D.get('SELECT * FROM users WHERE id = ?', id);
    if (!u || u.status !== 'active') return null;
    return {
      type: 'user',
      id: u.id,
      name: u.full_name,
      email: u.email,
      role: u.role,
      department: u.department,
      departmentId: u.department_id ?? null,
      token
    };
  }
  const v = D.get('SELECT * FROM vendors WHERE id = ?', id);
  if (!v || v.status !== 'active') return null;
  const board = D.get("SELECT * FROM boards WHERE type='vendor' AND vendor_id = ?", v.id);
  return {
    type: 'vendor',
    id: v.id,
    name: v.name,
    email: v.email,
    role: 'vendor',
    contactName: v.contact_name,
    readOnly: !!v.read_only,
    boardId: board ? board.id : null,
    token
  };
}

function login(email, password) {
  const mail = String(email ?? '').trim().toLowerCase();
  if (!mail || !password) throw badRequest('נא להזין אימייל וסיסמה');

  const user = D.get('SELECT * FROM users WHERE lower(email) = ?', mail);
  if (user) {
    if (user.status !== 'active') throw unauthorized('המשתמש אינו פעיל. פנה למנהל המערכת.');
    if (!D.verifyPassword(password, user.password_hash)) throw unauthorized('אימייל או סיסמה שגויים');
    return { actorType: 'user', actor: loadActor('user', user.id) };
  }

  const vendor = D.get('SELECT * FROM vendors WHERE lower(email) = ?', mail);
  if (vendor) {
    if (vendor.status !== 'active') throw unauthorized('חשבון הספק מושהה. פנה למנהל המחלקה.');
    if (!D.verifyPassword(password, vendor.password_hash)) throw unauthorized('אימייל או סיסמה שגויים');
    return { actorType: 'vendor', actor: loadActor('vendor', vendor.id) };
  }

  throw unauthorized('אימייל או סיסמה שגויים');
}

/**
 * האם הבקשה הגיעה ב-HTTPS. מאחורי פרוקסי של ספק ענן החיבור הפנימי הוא HTTP,
 * והפרוטוקול המקורי מגיע בכותרת x-forwarded-proto.
 */
function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https';
}

function cookieHeader(token, expires, req) {
  // עוגיית סשן חייבת להיות Secure כשהאתר מוגש ב-HTTPS, אחרת היא נשלחת גם בחיבור לא מוצפן
  const secure = req && isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires.toUTCString()}`;
}

const clearCookieHeader = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ---------------------------------------------------------------------------
// הגנה על מסך הכניסה מפני ניחוש סיסמאות
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

function checkLoginRate(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && now > entry.resetAt) attempts.delete(ip);
  const current = attempts.get(ip);
  if (current && current.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((current.resetAt - now) / 60000);
    throw unauthorized(`יותר מדי ניסיונות התחברות. נסה שוב בעוד ${minutes} דקות.`);
  }
}

function noteFailedLogin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && now <= entry.resetAt) entry.count++;
  else attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
}

const clearLoginRate = (req) => attempts.delete(clientIp(req));

// ניקוי תקופתי כדי שהמפה לא תגדל ללא הגבלה
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) if (now > entry.resetAt) attempts.delete(ip);
}, WINDOW_MS).unref?.();

function requireActor(req) {
  const actor = actorFromRequest(req);
  if (!actor) throw unauthorized();
  return actor;
}

module.exports = {
  COOKIE, createSession, destroySession, purgeExpired,
  actorFromRequest, requireActor, loadActor, login,
  cookieHeader, clearCookieHeader, isSecureRequest,
  checkLoginRate, noteFailedLogin, clearLoginRate
};
