'use strict';
/**
 * כניסה למערכת דרך חשבון Google (OAuth 2.0).
 *
 * מופעל רק אם הוגדרו משתני הסביבה GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET.
 * בלעדיהם הכפתור פשוט לא מוצג, והכניסה עם סיסמה ממשיכה לעבוד כרגיל.
 *
 * עיקרון אבטחה מרכזי: הכניסה מותרת אך ורק לכתובת אימייל שכבר קיימת במערכת
 * כמשתמש פעיל או כספק פעיל. חשבון Google אינו יוצר משתמש חדש — אחרת כל אדם
 * בעולם עם חשבון Google היה נכנס למערכת.
 */
const crypto = require('node:crypto');
const D = require('./db');
const Auth = require('./auth');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

const isEnabled = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/**
 * כתובת הבסיס הציבורית של המערכת — לקישורי ההזמנות ולכתובת החזרה מ-Google.
 *
 * סדר העדיפות: ההגדרה במסך הניהול, אחריה משתנה הסביבה, ולבסוף הכתובת שממנה
 * הגיעה הבקשה. ההגדרה ראשונה כדי שמנהל יוכל לשנות את הדומיין מתוך המערכת
 * בלי לגעת בהגדרות השרת — אחרת קישור בהזמנה ממשיך להצביע לכתובת הזמנית.
 */
function publicBase(req) {
  const configured = D.getSetting('public_url', '');
  if (configured) return String(configured).replace(/\/+$/, '');
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, '');

  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  return `${proto}://${host}`;
}

const redirectUri = (req) => `${publicBase(req)}/api/auth/google/callback`;

// ---------------------------------------------------------------------------
// מצב זמני בין הפנייה ל-Google לבין החזרה ממנו
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

function createState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

/** מאמת שהחזרה מ-Google שייכת לבקשה שיצאה מכאן, ומונע שימוש חוזר */
function consumeState(state) {
  const expires = pendingStates.get(state);
  if (!expires) return false;
  pendingStates.delete(state);
  return Date.now() <= expires;
}

setInterval(() => {
  const now = Date.now();
  for (const [state, expires] of pendingStates) if (now > expires) pendingStates.delete(state);
}, STATE_TTL_MS).unref?.();

// ---------------------------------------------------------------------------
// הזרימה
// ---------------------------------------------------------------------------

function authorizeUrl(req) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: createState(),
    prompt: 'select_account',
    access_type: 'online'
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

async function exchangeCodeForProfile(code, req) {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    throw new Error(`Google דחה את הבקשה (${tokenRes.status}): ${detail.slice(0, 200)}`);
  }

  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) throw new Error('לא התקבל אסימון גישה מ-Google');

  const profileRes = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!profileRes.ok) throw new Error('לא ניתן לקרוא את פרטי החשבון מ-Google');

  return profileRes.json();
}

/**
 * מאתר משתמש או ספק לפי כתובת האימייל של חשבון ה-Google.
 * מחזיר { actorType, id } או זורק שגיאה מוסברת בעברית.
 */
function matchAccount(profile) {
  if (!profile?.email) throw new Error('חשבון ה-Google אינו כולל כתובת אימייל');
  if (profile.email_verified === false) throw new Error('כתובת האימייל בחשבון ה-Google אינה מאומתת');

  const email = String(profile.email).trim().toLowerCase();

  const user = D.get('SELECT id, status FROM users WHERE lower(email) = ?', email);
  if (user) {
    if (user.status !== 'active') throw new Error('המשתמש אינו פעיל. פנה למנהל המערכת.');
    return { actorType: 'user', id: user.id, email };
  }

  const vendor = D.get('SELECT id, status FROM vendors WHERE lower(email) = ?', email);
  if (vendor) {
    if (vendor.status !== 'active') throw new Error('חשבון הספק מושהה. פנה למנהל המחלקה.');
    return { actorType: 'vendor', id: vendor.id, email };
  }

  throw new Error(`הכתובת ${email} אינה רשומה במערכת. יש לפנות למנהל המערכת כדי שיוסיף אותה.`);
}

module.exports = { isEnabled, authorizeUrl, exchangeCodeForProfile, matchAccount, consumeState, publicBase };
