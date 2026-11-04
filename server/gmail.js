'use strict';
/**
 * חיבור Gmail אישי — קריאה ושליחה (‎gmail.readonly‎ + ‎gmail.send‎).
 *
 * על הלקוח GOOGLE_CLIENT_ID (שמשמש גם לכניסה, אלא אם הוגדר לה לקוח נפרד),
 * ועם אותה כתובת חזרה — כך אין צורך לרשום ב-Google Cloud כתובת נוספת. ההבחנה בין "כניסה" ל"חיבור תיבה" היא
 * לפי ה-state: מצב שנוצר כאן שייך לחיבור תיבה של משתמש מסוים.
 *
 * מה עושים עם התיבה:
 *   • שליחה — כל מייל של משימת AI יוצא מכאן, מהכתובת של המשתמש עצמו, ונשאר
 *     אצלו ב"דואר יוצא". רק מה שאושר או מה שהמדיניות מתירה (תזכורת, תודה).
 *     אין שליחה מתיבת מערכת: מי שלא חיבר — משימת AI במייל אינה זמינה לו.
 *   • תשובות — הנמען עונה ישירות למשתמש, והן נקלטות מכאן
 *   • סריקה — מיילים שלא נקראו הופכים להצעות משימה (‎ai/mail-scan.js‎)
 *   • זיהוי קשר — המשתמש כתב לנמען בעצמו, והמעקב עוצר לשאול
 *
 * משימון לא מוחק ולא מסמן כנקרא — ההרשאות אינן מאפשרות זאת.
 *
 * אותו חיבור — "חיבור Google" בממשק — משמש גם את היומן ואת אנשי הקשר (‎SCOPES‎).
 *
 * כמה תיבות לעובד אחד: החיבור הראשון הוא התיבה הראשית (‎mail_connections‎),
 * ואפשר להוסיף עוד חשבונות Google (‎mail_accounts‎). כל תיבה נסרקת, נכנסת
 * לתובנות, לאנשי הקשר וליומן, ואפשר לשלוח ממנה.
 *
 * ‎who‎ — "ידית" לתיבה, בכל פונקציה כאן שמקבלת משתמש: מספר המשתמש = התיבה
 * הראשית שלו (כמו תמיד, ולכן כל הקוד הקיים ממשיך לעבוד), או ‎"12:3"‎ — תיבה
 * נוספת 3 של משתמש 12 (‎handle‎). ‎boxesOf‎ — כל התיבות של משתמש.
 */
const crypto = require('node:crypto');
const D = require('./db');
const Google = require('./google-auth');
const Secrets = require('./secrets');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/*
 * חיבור Google אחד, ולא חיבור לכל שירות: אותו אסימון משמש גם את היומן
 * (‎calendar.js‎) וגם את אנשי הקשר (‎google-contacts.js‎).
 *
 * היומן בקריאה וכתיבה של אירועים (‎calendar.events‎) — כדי שפיצ'ר עתידי שכותב
 * ליומן לא יחייב את כולם לחבר שוב. כרגע משימון רק קורא ממנו.
 * אנשי הקשר בקריאה וכתיבה (‎contacts‎) — לשמירת איש קשר חדש בלחיצה, ותו לא.
 */
const SCOPES = {
  mail: SCOPE,
  send: SEND_SCOPE,
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  // זמינות עמיתים — התנגשויות והצעת מועדים בקביעת פגישה
  freebusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  contacts: 'https://www.googleapis.com/auth/contacts',
  otherContacts: 'https://www.googleapis.com/auth/contacts.other.readonly',
  directory: 'https://www.googleapis.com/auth/directory.readonly'
};
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

const isEnabled = () => Google.isGmailClientEnabled();

/*
 * כתובות פרטיות (Gmail, Outlook, Hotmail, Yahoo, Walla…) — לא התיבה של
 * הארגון. עובד שנכנס עם כתובת כזו מחבר את התיבה הארגונית שלו (‎work_email‎).
 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.il', 'hotmail.com', 'hotmail.co.il', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.il', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'walla.co.il', 'walla.com', 'bezeqint.net', 'netvision.net.il', '012.net.il', '013.net', 'zahav.net.il', 'inter.net.il'
]);
const domainOf = (email) => String(email ?? '').trim().toLowerCase().split('@')[1] ?? '';
const isPersonalEmail = (email) => PERSONAL_DOMAINS.has(domainOf(email));
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? '').trim());

/**
 * התיבה שהעובד צריך לחבר כתיבה ראשית: המייל הארגוני שנשמר לו, ואם אין —
 * הכתובת שאיתה הוא נכנס, אם היא ארגונית. כתובת פרטית בלי מייל ארגוני — ריק:
 * צריך קודם לשאול אותו מה המייל הארגוני.
 */
function workMailbox(userId) {
  const u = D.get('SELECT email, work_email FROM users WHERE id = ?', userId);
  if (!u) return '';
  if (u.work_email) return String(u.work_email).toLowerCase();
  return isPersonalEmail(u.email) ? '' : String(u.email ?? '').toLowerCase();
}

// --- תיבות ---

/** ‎who‎ ← ‎{ userId, boxId }‎. ‎boxId‎ ‎0‎ — התיבה הראשית */
function parse(who) {
  if (typeof who === 'string' && who.includes(':')) {
    const [u, b] = who.split(':').map(Number);
    return { userId: u, boxId: b || 0 };
  }
  return { userId: Number(who), boxId: 0 };
}
/** הידית לתיבה: הראשית — מספר המשתמש עצמו; נוספת — ‎"משתמש:תיבה"‎ */
const handle = (userId, boxId = 0) => (Number(boxId) ? `${Number(userId)}:${Number(boxId)}` : Number(userId));
const userOf = (who) => parse(who).userId;
const boxOf = (who) => parse(who).boxId;
const keyOf = (who) => String(handle(parse(who).userId, parse(who).boxId));

// --- מצב זמני בין הפנייה ל-Google לחזרה ממנו, לכל משתמש ---

const STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map();

/** ‎add‎ — חשבון Google נוסף (ולא חיבור, או חיבור מחדש, של הראשי) */
/**
 * ‎expect‎ — המייל הארגוני שהעובד הקליד לפני החיבור. הוא לא נשמר עד ש-Google
 * מאשר שהעובד שולט בו (ב-‎connect‎): כתובת שלא אומתה לא נשמרת ב-‎work_email‎,
 * כי לפיה אפשר להיכנס למערכת.
 */
function authorizeUrl(req, user, { add = false, expect = '' } = {}) {
  const state = `gm_${crypto.randomBytes(24).toString('hex')}`;
  expect = add ? '' : String(expect ?? '').trim().toLowerCase();
  pending.set(state, { userId: user.id, add, expect, expires: Date.now() + STATE_TTL_MS });
  /*
   * התיבה הראשית — ההסכמה ניתנת מהמייל הארגוני, לא מה-Gmail הפרטי שאיתו
   * נכנס: ‎login_hint‎ מכוון אליו, ‎hd‎ מצמצם את בחירת החשבון לדומיין של
   * הארגון (Google Workspace), ו-‎select_account‎ — כדי ש-Google לא ייכנס
   * אוטומטית לחשבון הפרטי שכבר מחובר בדפדפן.
   */
  const work = add ? '' : (expect || workMailbox(user.id));
  const workDomain = work && !isPersonalEmail(work) ? domainOf(work) : '';
  const params = new URLSearchParams({
    client_id: Google.CLIENT_ID,
    redirect_uri: Google.redirectUri(req),
    response_type: 'code',
    scope: `openid email ${Object.values(SCOPES).join(' ')}`,
    state,
    // ‎offline‎ + ‎consent‎ — כדי לקבל אסימון רענון גם ממי שכבר אישר בעבר
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    // חשבון נוסף — Google מציג את בחירת החשבון, ולא נכנס ישר לראשי
    ...(add ? { prompt: 'consent select_account' } : {
      prompt: 'consent select_account',
      ...(work ? { login_hint: work } : {}),
      ...(workDomain ? { hd: workDomain } : {})
    })
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const isGmailState = (state) => String(state ?? '').startsWith('gm_');

/** המשתמש שהחזרה הזו שייכת לו, או ‎null‎ — שימוש חד-פעמי */
function consumeState(state) {
  const entry = consumeStateFull(state);
  return entry ? entry.userId : null;
}

/** ‎{ userId, add }‎, או ‎null‎ */
function consumeStateFull(state) {
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  return Date.now() <= entry.expires ? { userId: entry.userId, add: Boolean(entry.add), expect: entry.expect || '' } : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now > v.expires) pending.delete(k);
}, STATE_TTL_MS).unref?.();

// --- אסימונים ---

const tokens = new Map(); // ‎keyOf(who)‎ → { access, expires }

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

/**
 * החזרה מ-Google. התיבה נקבעת לפי הכתובת שאושרה: כתובת שכבר מחוברת אצלו
 * (ראשית או נוספת) — מתעדכנת. אחרת: ‎add‎ — תיבה נוספת; בלי ‎add‎ — התיבה
 * הראשית (חיבור ראשון, או חיבור מחדש).
 *
 * @returns {Promise<{box: number, email: string, added: boolean}>}
 */
async function connect(userId, code, req, { add = false, expect = '' } = {}) {
  const data = await tokenRequest({ code, redirect_uri: Google.redirectUri(req), grant_type: 'authorization_code' });
  /*
   * מה שאושר נשמר כמו שהוא, וכל פיצ'ר בודק את ההרשאה שלו (‎has‎). מי שלא סימן
   * את היומן — מקבל דואר ואנשי קשר, והיומן מציע לו לחבר מחדש. חיבור בלי שום
   * הרשאה שימושית אינו חיבור.
   */
  const granted = new Set(String(data.scope ?? '').split(/\s+/));
  if (!Object.values(SCOPES).some((s) => granted.has(s))) {
    throw new Error('לא אושרה אף הרשאה. יש לסמן במסך של Google את התיבות של הדואר, היומן ואנשי הקשר.');
  }
  if (!data.refresh_token) throw new Error('Google לא החזיר אסימון רענון. נסו לנתק את משימון בהגדרות חשבון ה-Google ולחבר שוב.');
  const email = await emailOf(data);
  const primary = D.get('SELECT email FROM mail_connections WHERE user_id = ?', userId);
  /*
   * התיבה הראשית חייבת להיות המייל הארגוני. נבחר חשבון אחר (בדרך כלל ה-Gmail
   * הפרטי, שכבר מחובר בדפדפן) — לא מחברים, ואומרים איזה חשבון לבחור.
   */
  const work = expect || workMailbox(userId);
  const isExtra = email && D.get('SELECT 1 FROM mail_accounts WHERE user_id = ? AND lower(email) = ?', userId, email);
  // סירוב — ההרשאה שניתנה מהחשבון הלא נכון מבוטלת מיד, ולא נשארת פתוחה
  const refuse = async (message) => {
    await fetch(`${REVOKE}?token=${encodeURIComponent(data.refresh_token ?? data.access_token ?? '')}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
    throw new Error(message);
  };
  if (!add && !isExtra && email) {
    if (work && email !== work) {
      await refuse(`חובר החשבון ${email}, אבל המייל הארגוני שלך הוא ${work}. יש לחבר שוב ולבחור במסך של Google את ${work}.`);
    }
    if (!work && isPersonalEmail(email)) {
      await refuse(`${email} הוא חשבון פרטי. יש לחבר את המייל הארגוני / המחלקתי שלך — כתבו אותו במסך "חיבור Google" ונסו שוב.`);
    }
    // נכנס עם כתובת פרטית ובחר בחשבון ארגוני — זה המייל הארגוני שלו מעכשיו
    if (!work) D.run("UPDATE users SET work_email = ? WHERE id = ? AND work_email = ''", email, userId);
    // המייל שהקליד אומת עכשיו מול Google — רק עכשיו הוא נשמר כמייל הארגוני שלו
    if (expect && email === expect) {
      if (D.get('SELECT id FROM users WHERE id <> ? AND (lower(work_email) = ? OR lower(email) = ?)', userId, email, email)) {
        await refuse('המייל הזה כבר משויך לעובד אחר. פנו למנהל המערכת');
      }
      D.run('UPDATE users SET work_email = ? WHERE id = ?', email, userId);
    }
  }
  const extra = email ? D.get('SELECT id FROM mail_accounts WHERE user_id = ? AND lower(email) = ?', userId, email) : null;
  const refresh = Secrets.encrypt(data.refresh_token);
  let box = 0;
  let added = false;
  if (extra) {
    box = extra.id;
    D.run("UPDATE mail_accounts SET refresh_token = ?, scope = ?, state = 'ok', error = '' WHERE id = ?", refresh, String(data.scope), box);
  } else if (add && primary && primary.email !== email) {
    box = Number(D.run(
      "INSERT INTO mail_accounts (user_id, email, refresh_token, scope, state, error, created_at) VALUES (?,?,?,?,'ok','',?)",
      userId, email, refresh, String(data.scope), D.nowIso()
    ).lastInsertRowid);
    added = true;
  } else {
    D.run(
      `INSERT INTO mail_connections (user_id, email, refresh_token, scope, state, error, created_at)
       VALUES (?,?,?,?,'ok','',?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token,
         scope = excluded.scope, state = 'ok', error = ''`,
      userId, email, refresh, String(data.scope), D.nowIso()
    );
  }
  const who = handle(userId, box);
  tokens.set(keyOf(who), { access: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3000) - 60) * 1000 });
  // חיבור מחדש הוא גם הדרך לרענן מיד חתימה ששונתה ב-Gmail
  signatures.delete(keyOf(who));
  return { box, email, added };
}

/** הכתובת של החשבון שאושר — מ-Gmail, ואם אין הרשאת דואר — מאסימון הזיהוי */
async function emailOf(data) {
  try {
    const res = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const p = await res.json();
      if (p.emailAddress) return String(p.emailAddress).toLowerCase();
    }
  } catch { /* ננסה מאסימון הזיהוי */ }
  try {
    const payload = JSON.parse(Buffer.from(String(data.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8'));
    return String(payload.email ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/** החיבור של תיבה — ‎{ ...row, user_id, box }‎, או ‎undefined‎ */
function connectionOf(who) {
  const { userId, boxId } = parse(who);
  const row = boxId
    ? D.get('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', boxId, userId)
    : D.get('SELECT * FROM mail_connections WHERE user_id = ?', userId);
  return row ? { ...row, user_id: userId, box: boxId } : undefined;
}

const CONN_FIELDS = new Set(['state', 'error', 'scan_running', 'scan_progress', 'last_scan_at']);
/** עדכון שדות בחיבור של תיבה (מצב, סריקה) — בטבלה הנכונה */
function setConn(who, fields) {
  const { userId, boxId } = parse(who);
  const keys = Object.keys(fields).filter((k) => CONN_FIELDS.has(k));
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  if (boxId) D.run(`UPDATE mail_accounts SET ${set} WHERE id = ? AND user_id = ?`, ...values, boxId, userId);
  else D.run(`UPDATE mail_connections SET ${set} WHERE user_id = ?`, ...values, userId);
}

/** תפיסת התיבה לסריקה — ‎false‎ אם סריקה כבר רצה בה */
function claimScan(who) {
  const { userId, boxId } = parse(who);
  const r = boxId
    ? D.run('UPDATE mail_accounts SET scan_running = 1 WHERE id = ? AND user_id = ? AND scan_running = 0', boxId, userId)
    : D.run('UPDATE mail_connections SET scan_running = 1 WHERE user_id = ? AND scan_running = 0', userId);
  return r.changes > 0;
}

/** הכתובות של כל התיבות של המשתמש — "ממני" בסריקה */
const emailsOf = (userId) => [
  D.get('SELECT email FROM mail_connections WHERE user_id = ?', userId)?.email,
  ...D.all('SELECT email FROM mail_accounts WHERE user_id = ?', userId).map((r) => r.email)
].filter(Boolean).map((e) => e.toLowerCase());

/**
 * כל התיבות של המשתמש שאושרה בהן ההרשאה — הראשית קודם. ‎feature‎ ריק — כל
 * התיבות המחוברות, בלי קשר להרשאה.
 */
function boxesOf(userId, feature = 'mail') {
  const ids = [0, ...D.all('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id', userId).map((r) => r.id)];
  return ids.map((b) => handle(userId, b)).filter((who) => (feature ? has(who, feature) : connectionOf(who)));
}

/** כל התיבות של כל העובדים הפעילים — לסריקת הבוקר ולקליטת תשובות */
const allBoxes = (feature = 'mail') => connectedUsers(null).flatMap((id) => boxesOf(id, feature));

async function accessToken(who) {
  const key = keyOf(who);
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.access;
  const conn = connectionOf(who);
  if (!conn || conn.state === 'revoked') throw new Error(`תיבת ה-Gmail${conn?.email ? ` ${conn.email}` : ''} אינה מחוברת`);
  const refresh = Secrets.decrypt(conn.refresh_token);
  if (!refresh) {
    setConn(who, { state: 'revoked', error: 'החיבור אינו קריא — יש לחבר מחדש' });
    throw new Error('החיבור לתיבה אינו קריא — יש לחבר את Gmail מחדש');
  }
  try {
    const data = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
    tokens.set(key, { access: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3000) - 60) * 1000 });
    if (conn.state !== 'ok') setConn(who, { state: 'ok', error: '' });
    return data.access_token;
  } catch (err) {
    // ההרשאה בוטלה בצד של Google — אין טעם לנסות שוב עד שיחבר מחדש
    if (err.revoked) setConn(who, { state: 'revoked', error: 'ההרשאה בוטלה ב-Google — יש לחבר מחדש' });
    throw err;
  }
}

/**
 * קריאה לכל API של Google בשם המשתמש — Gmail, יומן, אנשי קשר. ‎url‎ מלא.
 * שגיאה נושאת ‎status‎, כדי שהקורא יבדיל בין "אין הרשאה" לתקלה זמנית.
 */
async function googleCall(userId, url, params = {}, { method = 'GET', body = null } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // פרמטר שחוזר על עצמו (‎sources=…&sources=…‎) מגיע כמערך
    for (const one of [v].flat()) qs.append(k, one);
  }
  const full = `${url}${qs.toString() ? `${url.includes('?') ? '&' : '?'}${qs}` : ''}`;
  const res = await fetch(full, {
    method,
    headers: { authorization: `Bearer ${await accessToken(userId)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) tokens.delete(keyOf(userId));
    const err = new Error(`Google החזיר ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function call(userId, path, params = {}, { method = 'GET', body = null } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // פרמטר שחוזר על עצמו (‎metadataHeaders=From&metadataHeaders=To‎) מגיע כמערך
    for (const one of [v].flat()) qs.append(k, one);
  }
  const url = `${API}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken(userId)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) tokens.delete(keyOf(userId));
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

/**
 * ההודעות בשרשור של מייל — מזהה, תוויות ותאריך בלבד, בלי התוכן. משמש
 * לבדיקה "האם עניתי כבר": הודעה עם התווית ‎SENT‎ אחרי המייל שהתקבל.
 */
async function threadOf(userId, gmailId) {
  const m = await call(userId, `/messages/${encodeURIComponent(gmailId)}`, { format: 'minimal' });
  const t = await call(userId, `/threads/${encodeURIComponent(m.threadId)}`, { format: 'minimal' });
  return (t.messages ?? []).map((x) => ({
    id: x.id,
    labels: x.labelIds ?? [],
    at: x.internalDate ? new Date(Number(x.internalDate)) : null
  }));
}

/**
 * עמוד אחד של שרשורים לפי חיפוש — לסריקת ההיסטוריה, שעוברת על כל התיבה
 * בעמודים ושומרת את ‎pageToken‎ כדי להמשיך מאותה נקודה.
 */
async function listThreads(userId, q, { pageToken = null, max = 500 } = {}) {
  const page = await call(userId, '/threads', { q, maxResults: Math.min(500, max), pageToken });
  return { ids: (page.threads ?? []).map((t) => t.id), next: page.nextPageToken ?? null };
}

const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'];

/**
 * שרשור בכותרות בלבד, בלי תוכן: מי, למי, מתי, נושא ותוויות — לכל הודעה.
 * ‎hasFiles‎ — לפי מבנה ההודעה (‎multipart/mixed‎), סימן לקובץ מצורף בלי לקרוא אותו.
 */
async function threadMeta(userId, threadId) {
  const t = await call(userId, `/threads/${encodeURIComponent(threadId)}`, { format: 'metadata', metadataHeaders: META_HEADERS });
  return (t.messages ?? []).map((m) => {
    const h = {};
    for (const x of m.payload?.headers ?? []) h[x.name.toLowerCase()] = x.value;
    return {
      id: m.id,
      labels: m.labelIds ?? [],
      at: m.internalDate ? new Date(Number(m.internalDate)) : null,
      headers: h,
      hasFiles: /multipart\/mixed/i.test(m.payload?.mimeType ?? '')
    };
  });
}

/** הודעה אחת בכותרות בלבד — מי, למי, נושא, מתי */
async function messageMeta(userId, id) {
  const m = await call(userId, `/messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: META_HEADERS });
  const h = {};
  for (const x of m.payload?.headers ?? []) h[x.name.toLowerCase()] = x.value;
  return { id: m.id, threadId: m.threadId, labels: m.labelIds ?? [], at: m.internalDate ? new Date(Number(m.internalDate)) : null, headers: h };
}

/** התוויות של התיבה — כדי להחריג לפי שם ("אישי") */
async function labels(userId) {
  const r = await call(userId, '/labels');
  return (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
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

/**
 * שליחה מהתיבה של המשתמש. ‎raw‎ — ההודעה המלאה (‎Mailer.buildMessage‎).
 * ‎threadId‎ — השרשור ב-Gmail, כדי שתזכורת תיכנס לאותה שיחה גם אצל השולח.
 *
 * מחזיר את ה-Message-ID כפי שנשמר בפועל ב-Gmail — הוא זה שהנמען יצטט
 * בתשובה, ולפיו התשובה מזוהה. Gmail עשוי להחליף את זה ששלחנו, ולכן נקרא שוב.
 */
async function send(userId, raw, { threadId = null } = {}) {
  const sent = await call(userId, '/messages/send', {}, {
    method: 'POST',
    body: { raw: Buffer.from(raw, 'utf8').toString('base64url'), ...(threadId ? { threadId } : {}) }
  });
  let messageId = null;
  try {
    const meta = await call(userId, `/messages/${encodeURIComponent(sent.id)}`, { format: 'metadata', metadataHeaders: 'Message-ID' });
    messageId = (meta.payload?.headers ?? []).find((h) => /^message-id$/i.test(h.name))?.value ?? null;
  } catch { /* ההודעה יצאה; בלי המזהה התשובה תזוהה לפי השולח */ }
  return { gmailId: sent.id, threadId: sent.threadId, messageId };
}

/**
 * ניתוק תיבה. ‎who‎ — הראשית (מספר המשתמש) או נוספת. ניתוק הראשית כשיש
 * נוספות — הנוספת הראשונה הופכת לראשית, עם ההצעות, אנשי הקשר והמשימות שלה.
 */
async function disconnect(who) {
  const { userId, boxId } = parse(who);
  const conn = connectionOf(who);
  tokens.delete(keyOf(who));
  signatures.delete(keyOf(who));
  if (!conn) return;
  const refresh = Secrets.decrypt(conn.refresh_token);
  if (refresh) {
    // ביטול ההרשאה גם בצד של Google — לא רק מחיקה אצלנו
    await fetch(`${REVOKE}?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  // אנשי הקשר שסונכרנו שייכים לחיבור — בלעדיו אין להם מקום אצלנו
  D.run('DELETE FROM google_contacts WHERE user_id = ? AND box = ?', userId, boxId);
  if (boxId) {
    D.run('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', boxId, userId);
    // מה שהגיע מהתיבה הזו נשאר (הצעות, משימות) — רק בלי קישור לתיבה שאינה
    D.run('UPDATE ai_requests SET from_box = 0 WHERE owner_id = ? AND from_box = ?', userId, boxId);
    return;
  }
  D.run('DELETE FROM mail_connections WHERE user_id = ?', userId);
  const next = D.get('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY id LIMIT 1', userId);
  if (!next) {
    D.run('DELETE FROM google_contact_sync WHERE user_id = ?', userId);
    return;
  }
  // הנוספת הראשונה עולה לראשית — כל מה שמסומן בה עובר לתיבה 0
  D.run(
    `INSERT INTO mail_connections (user_id, email, refresh_token, scope, state, error, scan_running, scan_progress, last_scan_at, created_at)
     VALUES (?,?,?,?,?,?,0,?,?,?)`,
    userId, next.email, next.refresh_token, next.scope, next.state, next.error, next.scan_progress, next.last_scan_at, next.created_at
  );
  D.run('DELETE FROM mail_accounts WHERE id = ?', next.id);
  for (const [table, col, owner] of [['ai_suggestions', 'box', 'user_id'], ['google_contacts', 'box', 'user_id'], ['ai_requests', 'from_box', 'owner_id']]) {
    D.run(`UPDATE ${table} SET ${col} = 0 WHERE ${owner} = ? AND ${col} = ?`, userId, next.id);
  }
  const moved = tokens.get(keyOf(handle(userId, next.id)));
  tokens.delete(keyOf(handle(userId, next.id)));
  if (moved) tokens.set(keyOf(userId), moved);
}

/*
 * ההרשאות שאושרו, כמילים שלמות. לא ‎includes‎ על המחרוזת: ‎.../auth/contacts‎
 * הוא תת-מחרוזת של ‎.../auth/contacts.other.readonly‎, וכך מי שאישר רק את
 * "אנשי קשר אחרים" היה נראה כמי שאישר שמירת אנשי קשר.
 */
const grantedScopes = (c) => new Set(String(c?.scope ?? '').split(/\s+/).filter(Boolean));

/** האם החיבור תקין ואושרה בו ההרשאה של הפיצ'ר: ‎mail · send · calendar · contacts · …‎ */
function has(who, feature) {
  const c = connectionOf(who);
  return c?.state === 'ok' && Boolean(SCOPES[feature]) && grantedScopes(c).has(SCOPES[feature]);
}

/** משתמשים שהתיבה שלהם מחוברת לקריאה — לסריקה ולקליטת תשובות */
/*
 * ‎feature‎ ‎null‎ — כל מי שיש לו חיבור (ראשי). הנוספות תלויות בראשית: ניתוק
 * הראשית מעלה נוספת במקומה, ולכן אין משתמש עם נוספות בלי ראשית.
 */
const connectedUsers = (feature = 'mail') => D.all(
  "SELECT c.user_id FROM mail_connections c JOIN users u ON u.id = c.user_id WHERE u.status = 'active'"
).map((r) => r.user_id).filter((id) => (feature ? boxesOf(id, feature).length > 0 : true));

/** יש לו לפחות תיבה אחת מחוברת לקריאה */
const isConnected = (userId) => boxesOf(userId, 'mail').length > 0;

/** חיבור שאושרה בו גם שליחה. חיבור ישן (קריאה בלבד) צריך להתחבר מחדש */
const canSend = (who) => {
  const c = connectionOf(who);
  return c?.state === 'ok' && String(c.scope).includes(SEND_SCOPE);
};

function statusOf(c) {
  const granted = grantedScopes(c);
  const scopes = Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, granted.has(v)]));
  return {
    box: c.box ?? 0,
    email: c.email,
    state: c.state,
    canSend: String(c.scope).includes(SEND_SCOPE),
    scopes,
    // מה שעוד לא אושר — לפס "חברו מחדש" (חיבור ישן מלפני היומן ואנשי הקשר)
    missing: Object.keys(SCOPES).filter((k) => !scopes[k]),
    error: c.error,
    scanning: Boolean(c.scan_running),
    progress: (() => { try { return JSON.parse(c.scan_progress); } catch { return {}; } })(),
    lastScanAt: c.last_scan_at,
    connectedAt: c.created_at
  };
}

/** תצוגה ללקוח — בלי האסימון. הראשית, ו-‎accounts‎ — התיבות הנוספות */
function publicStatus(userId) {
  const c = connectionOf(userId);
  if (!c) return null;
  const accounts = D.all('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id', userId)
    .map((r) => statusOf(connectionOf(handle(userId, r.id))));
  const main = statusOf(c);
  return { ...main, accounts, scanningAny: main.scanning || accounts.some((a) => a.scanning) };
}

/** התיבות שאפשר לשלוח מהן — לבחירת "שליחה מ…" */
const sendBoxes = (userId) => boxesOf(userId, null)
  .filter((who) => canSend(who))
  .map((who) => ({ box: boxOf(who), email: connectionOf(who).email }));

// ---------------------------------------------------------------------------
// החתימה
// ---------------------------------------------------------------------------

const SIGNATURE_TTL = 3 * 60 * 60 * 1000;
// "אין חתימה" נזכר לזמן קצר: מי שהגדיר חתימה ב-Gmail עכשיו לא צריך לחכות שעות
const NO_SIGNATURE_TTL = 10 * 60 * 1000;
const signatures = new Map(); // ‎keyOf(who)‎ → { at, info }

/**
 * מה לומר למשתמש כשאין חתימה, לפי הסיבה. חוזר במסך החשבון, בטיוטת משימת
 * AI ובבוט — אותו נוסח בכל מקום.
 *
 * הסיבה הנפוצה: החתימה מוגדרת רק ב-Outlook שבמחשב. Outlook מוסיף אותה
 * במחשב שלו בלבד, ומשימון — ששולח דרך Gmail — אינו רואה אותה.
 */
const SIGNATURE_HELP = {
  none: 'לא נמצאה חתימה ב-Gmail. המיילים ממשימון יוצאים דרך Gmail, ולכן חתימה שמוגדרת רק ב-Outlook לא מספיקה — צריך להגדיר אותה גם ב-Gmail: הגדרות ← כללי ← חתימה, ולבחור אותה ב"ברירת מחדל לאימיילים חדשים".',
  no_read: 'כדי לצרף את החתימה שלך מ-Gmail, משימון צריך גם הרשאת קריאה. התחברו מחדש ל-Google ("החשבון שלי ← חיבור Google") וסמנו את כל התיבות.',
  error: 'לא הצלחנו לקרוא את החתימה מ-Gmail כרגע. ננסה שוב בשליחה הבאה.',
  not_connected: 'תיבת ה-Gmail אינה מחוברת.'
};

/**
 * החתימה האישית כפי שהוגדרה ב-Gmail (הגדרות ← כללי ← חתימה) — של כתובת
 * השליחה של החיבור, וליתר דיוק החתימה שנבחרה ב"ברירת מחדל לאימיילים
 * חדשים". נקראת מ-Gmail בלבד ואינה נערכת במשימון.
 *
 * ‎state‎: ‎ok‎ · ‎none‎ (אין חתימה ב-Gmail) · ‎no_read‎ (אושרה שליחה בלי
 * קריאה — אי אפשר לקרוא את ההגדרות) · ‎error‎ · ‎not_connected‎.
 * ‎fresh‎ — לעקוף את הזיכרון (כפתור "רענון חתימה").
 *
 * @returns {Promise<{state: string, html?: string, text?: string, help?: string}>}
 */
async function signatureInfo(userId, { fresh = false } = {}) {
  const hit = signatures.get(keyOf(userId));
  if (!fresh && hit && Date.now() - hit.at < (hit.info.state === 'ok' ? SIGNATURE_TTL : NO_SIGNATURE_TTL)) return hit.info;
  const conn = connectionOf(userId);
  const done = (info) => {
    const out = info.state === 'ok' ? info : { ...info, help: SIGNATURE_HELP[info.state] };
    if (info.state !== 'error') signatures.set(keyOf(userId), { at: Date.now(), info: out });
    return out;
  };
  if (!conn || conn.state !== 'ok') return done({ state: 'not_connected' });
  if (!has(userId, 'mail')) return done({ state: 'no_read' });
  try {
    const list = (await call(userId, '/settings/sendAs')).sendAs ?? [];
    const mine = list.find((x) => String(x.sendAsEmail).toLowerCase() === conn.email)
      ?? list.find((x) => x.isPrimary) ?? list.find((x) => x.isDefault);
    const html = String(mine?.signature ?? '').trim();
    // בלי ‎require‎ בראש הקובץ: ‎mime.js‎ עצמאי, וכך אין סיכוי לתלות מעגלית
    const text = html ? require('./mime').htmlToText(html).trim() : '';
    return done(html && text ? { state: 'ok', html, text } : { state: 'none' });
  } catch (err) {
    console.error(`[משימון] קריאת החתימה מ-Gmail למשתמש ${userId} נכשלה:`, err.message);
    // חתימה שכבר נקראה עדיפה על מייל בלי חתימה בגלל תקלה רגעית
    return hit?.info?.state === 'ok' ? hit.info : done({ state: 'error' });
  }
}

/** החתימה, או ‎null‎ — לקוראים שרק צריכים לדעת אם יש */
async function signature(userId) {
  const info = await signatureInfo(userId);
  return info.state === 'ok' ? { html: info.html, text: info.text } : null;
}

/**
 * כשאין חתימה ב-Gmail — לפחות השם והמחלקה מהפרופיל במשימון. ה-AI מנוסח
 * בלי שם (הוא סומך על החתימה), ובלי זה המייל היה יוצא בלי שם השולח בכלל.
 */
function fallbackSignature(userId) {
  const u = D.get('SELECT full_name, department FROM users WHERE id = ?', userOf(userId));
  const lines = [u?.full_name, u?.department].map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!lines.length) return null;
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { text: lines.join('\n'), html: lines.map(esc).join('<br>') };
}

/**
 * מייל שיוצא מהתיבה של המשתמש, עם החתימה שלו מ-Gmail בסוף. אין חתימה —
 * השם והמחלקה מהפרופיל, ו-‎missing‎ אומר למה (לרישום ולהודעה למשתמש).
 */
async function signed(userId, { text, html }) {
  const info = await signatureInfo(userId);
  const sig = info.state === 'ok' ? info : fallbackSignature(userId);
  const missing = info.state === 'ok' ? null : info.state;
  if (!sig) return { text, html, signature: null, missing };
  const block = `<br><div dir="auto" class="gmail_signature" data-smartmail="gmail_signature">${sig.html}</div>`;
  return {
    text: `${String(text).replace(/\s+$/, '')}\n\n${sig.text}`,
    html: /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`,
    signature: info.state === 'ok' ? sig : null,
    missing
  };
}

/** קישור למייל בתוך Gmail — נפתח רק אצל בעל התיבה */
const webLink = (email, gmailId) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(gmailId)}`;

module.exports = {
  parse, handle, userOf, boxOf, boxesOf, allBoxes, setConn, sendBoxes, consumeStateFull, claimScan, emailsOf,
  isEnabled, authorizeUrl, isGmailState, consumeState, connect, disconnect, workMailbox, isPersonalEmail, validEmail,
  search, raw, threadOf, send, listThreads, threadMeta, messageMeta, labels, connectedUsers, isConnected, canSend, connectionOf, publicStatus, webLink, SCOPE, SEND_SCOPE,
  SCOPES, has, googleCall, signature, signatureInfo, fallbackSignature, signed, SIGNATURE_HELP
};
