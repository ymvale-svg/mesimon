'use strict';
/**
 * Timeless (timeless.day) — הקלטות, תמלולים ומסמכי AI של פגישות זום.
 *
 * רק ה-API הרשמי: ‎https://api.timeless.day/v1‎ עם ‎Authorization: Bearer‎.
 * לא נוגעים ב-API הלא רשמי (my.timeless.day/api), לא בהעלאות ולא ב-webhooks.
 *
 * שני מקורות לאסימון, לפי הסדר:
 *  1. אסימון אישי — שמור מוצפן (‎server/secrets.js‎) בטבלת ‎user_channels‎ עם
 *     ‎provider = 'timeless'‎. רואה את מה שהחשבון שלו ב-Timeless רואה, בלי סינון.
 *  2. אסימון ארגוני — משתנה הסביבה ‎TIMELESS_ACCESS_TOKEN‎, לכל מי שלא חיבר אישי.
 *     הנהלה (‎permissions.isManagement‎) רואה את כל פגישות הארגון; עובד — רק
 *     פגישות שהוא המארח או משתתף בהן, לפי האימייל שלו או המייל הארגוני בכרטיס.
 *     הסינון כאן בשרת, לפני שמשהו מגיע למודל: פגישה של אחרים לא מופיעה ברשימה,
 *     ותמלול או מסמך שלה נחסמים גם כשמבקשים לפי מזהה.
 * האסימון לא נשלח לעולם ללקוח ולא חוזר מהכלים.
 *
 * שדות התשובה שעליהם הקוד נשען (לפי התיעוד, לבדוק מול חשבון אמיתי):
 *  GET /meetings            → { data: [{ id, title, status, start_time, end_time, duration (שניות),
 *                                host: {name,email}, participants: [{name,email}], documents? }],
 *                               next_cursor, has_more }
 *  GET /meetings/{id}/transcript → { meeting_id, speakers: [{id,name}],
 *                                    segments: [{speaker_id, start_time (שניות), text}] }
 *  GET /documents/{id}?format=markdown → { id, title, format, content, created_at }
 *  GET /rooms               → { data: [{ id, title, meeting_count, ... }], next_cursor, has_more }
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const D = require('../core').Db;
const secrets = require('../core').Secrets;
const Permissions = require('../core').Permissions;

const BASE_URL = 'https://api.timeless.day/v1';
const PROVIDER = 'timeless';
const TIMEOUT_MS = 30000;
const PAGE_MAX = 100;          // התיעוד: ‎limit‎ בין 1 ל-100
const LIST_HARD_MAX = 200;     // תקרה לכמה פגישות נאסוף בקריאה אחת
const MAX_PAGES = 10;          // הגנה מלולאת דפדוף אינסופית

const RECONNECT_MSG = 'החיבור ל-Timeless פג או בוטל. יש לחבר מחדש את Timeless בהגדרות עם אסימון API חדש (my.timeless.day/api-token).';
const ORG_RECONNECT_MSG = 'האסימון הארגוני של Timeless פג או בוטל. מנהל המערכת צריך להחליף את TIMELESS_ACCESS_TOKEN בהגדרות השרת.';
const NOT_ATTENDED_MSG = 'הפגישה לא נמצאה ב-Timeless, או שלא השתתפת בה. עובדים רואים רק פגישות שהשתתפו בהן.';

// ---------- אחסון ----------

const rowOf = (userId) =>
  D.get('SELECT * FROM user_channels WHERE user_id = ? AND provider = ?', userId, PROVIDER);

function setState(userId, state) {
  D.run('UPDATE user_channels SET state = ?, checked_at = ? WHERE user_id = ? AND provider = ?',
    state, D.nowIso(), userId, PROVIDER);
}

function tokenOf(userId) {
  const row = rowOf(userId);
  if (!row || !row.api_token) return null;
  return secrets.decrypt(row.api_token);
}

const hasPersonal = (row) => Boolean(row && row.api_token && row.state !== 'revoked');

/** האסימון הארגוני מסביבת השרת, או ריק */
const orgToken = () => String(process.env.TIMELESS_ACCESS_TOKEN ?? '').trim().replace(/^Bearer\s+/i, '');

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

/**
 * מה המשתמש רואה דרך האסימון הארגוני: ‎{ all: true }‎ להנהלה, ‎{ all: false, emails }‎
 * לעובד, ‎null‎ כשאין אסימון ארגוני או שאין משתמש פעיל כזה
 */
function orgAccess(userId) {
  if (!orgToken()) return null;
  const u = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u || u.status !== 'active') return null;
  const { isManagement } = Permissions;
  if (isManagement(u)) return { all: true };
  const emails = new Set([u.email, u.work_email].map(normEmail).filter((e) => e.includes('@')));
  return emails.size ? { all: false, emails } : null;
}

/**
 * דרך מה פונים בשם המשתמש: ‎{ source: 'personal', token }‎, ‎{ source: 'org', token, emails? }‎
 * (‎emails‎ — רק לעובד, שרואה רק פגישות שלו), או ‎null‎
 */
function accessOf(userId) {
  const row = rowOf(userId);
  if (hasPersonal(row)) {
    const token = secrets.decrypt(row.api_token);
    if (token) return { source: 'personal', token };
    setState(userId, 'revoked'); // שמור אך לא ניתן לפענוח (מפתח הוחלף)
  }
  const org = orgAccess(userId);
  if (org) return { source: 'org', token: orgToken(), emails: org.all ? null : org.emails };
  return null;
}

/** סינון לפגישות של המשתמש — ‎null‎ כשרואה הכול */
function restrictionOf(userId) {
  const a = accessOf(userId);
  return a && a.source === 'org' ? a.emails : null;
}

function isConnected(userId) {
  return hasPersonal(rowOf(userId)) || Boolean(orgAccess(userId));
}

/** תצוגה ללקוח — בלי האסימון. ‎source‎: ‎personal‎ / ‎org‎; ‎scope‎ (ארגוני): ‎all‎ / ‎mine‎ */
function publicStatus(userId) {
  const row = rowOf(userId);
  if (hasPersonal(row)) return { connected: true, source: 'personal', state: row.state, checkedAt: row.checked_at || null };
  const org = orgAccess(userId);
  if (org) return { connected: true, source: 'org', scope: org.all ? 'all' : 'mine', state: 'connected', checkedAt: null };
  if (!row) return { connected: false, state: 'disconnected', checkedAt: null };
  return { connected: false, state: row.state, checkedAt: row.checked_at || null };
}

/** האם המשתמש מארח או משתתף בפגישה (לפי האימייל) */
function attended(m, emails) {
  if (!m) return false;
  for (const p of [m.host, ...(Array.isArray(m.participants) ? m.participants : [])]) {
    if (!p) continue;
    const found = typeof p === 'string' ? (p.match(/[^\s<>"']+@[^\s<>"']+/g) || []) : [p.email];
    if (found.some((e) => emails.has(normEmail(e)))) return true;
  }
  return false;
}

function disconnect(userId) {
  D.run('DELETE FROM user_channels WHERE user_id = ? AND provider = ?', userId, PROVIDER);
  return publicStatus(userId);
}

// ---------- HTTP ----------

function apiError(message, { status = 0, retryable = false, code = '' } = {}) {
  const err = new Error(message);
  err.status = status;
  err.retryable = retryable;
  if (code) err.code = code;
  return err;
}

// ---------- הגנה על מגבלת הקצב (429) ----------
// כל הזרימות (מסך ההקלטות, הנגן, מעקב הבוט אחרי פגישות, בדיקת "לא מוקלטת", כרטיס המשימה)
// חולקות בדרך כלל את האסימון הארגוני, ול-Timeless יש מגבלה של 60 בקשות בדקה לאסימון:
//  1. תור לכל אסימון — לא יותר מ-RATE_MAX בקשות בדקה; בקשה עודפת מחכה בתור ולא נכשלת.
//  2. מטמון — רשימות פגישות 3 דקות; תמליל ומסמכים (לא משתנים אחרי שהפגישה עובדה) חצי שעה;
//     קישור צפייה דקה. בקשות זהות שרצות במקביל מתאחדות לבקשה אחת.
//  3. Timeless מגביל בכל זאת (429) או נופל (5xx) — מוגשת התשובה האחרונה שנשמרה (עד שעתיים),
//     ורק כשאין — ניסיון חוזר אחד אחרי ‎Retry-After‎ קצר, ואחר כך הודעה.
const RATE_MAX = 45;            // מתחת ל-60 — מרווח לסוכנים ולאסימונים אישיים של אותו חשבון
const BG_MAX = 20;              // עבודות רקע (סבב "איך היה?", בדיקת "לא מוקלטת") — רק עד כאן; השאר שמור למסכים
const RATE_WINDOW_MS = 60000;
const QUEUE_MAX_WAIT_MS = 25000; // יותר מזה — לא מחזיקים את המסך; מוגש מהמטמון או הודעה
const BG_MAX_WAIT_MS = 10 * 60000; // עבודת רקע מחכה בסבלנות
const bgContext = new AsyncLocalStorage();
const blockedUntil = new Map();  // ‎tokenKey‎ ← עד מתי Timeless ביקש לחכות (‎Retry-After‎)

/**
 * עבודת רקע: הבקשות שבתוך ‎fn‎ נכנסות לתור הרקע (עד ‎BG_MAX‎ בדקה, ותמיד אחרי מסכים פתוחים),
 * ורשימות הפגישות של עובדים נמשכות ברשימה ארגונית אחת שמשותפת לכולם (ראו ‎listMeetings‎).
 */
const background = (fn) => bgContext.run(true, fn);
const inBackground = () => bgContext.getStore() === true;
const CACHE_MAX = 600;
const STALE_MS = 2 * 60 * 60000;
const RETRY_429_MAX_SEC = 8;
const cache = new Map();        // ‎key‎ ← ‎{ at, body, ttl }‎
const inflight = new Map();     // ‎key‎ ← ‎Promise‎
const sent = new Map();         // ‎tokenKey‎ ← זמני הבקשות בדקה האחרונה
const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

/** כמה זמן תשובה נשמרת, לפי סוג הבקשה */
function ttlOf(path) {
  if (path === '/meetings') return 3 * 60000;
  if (/^\/meetings\/[^/]+\/recording$/.test(path)) return 60000;  // כתובת חתומה לזמן קצר
  if (/^\/meetings\/[^/]+\/transcript$/.test(path) || /^\/documents\//.test(path)) return 30 * 60000;
  return 0;
}

/**
 * מחכה לתור הפנוי הבא של האסימון; ‎false‎ — ההמתנה ארוכה מדי. בקשת רקע נכנסת רק כשבדקה
 * האחרונה היו פחות מ-‎BG_MAX‎ בקשות, כך שתמיד נשאר מקום לבקשה ממסך פתוח.
 */
async function takeSlot(tk, bg = false) {
  const limit = bg ? BG_MAX : RATE_MAX;
  const deadline = Date.now() + (bg ? BG_MAX_WAIT_MS : QUEUE_MAX_WAIT_MS);
  for (;;) {
    const now = Date.now();
    const list = (sent.get(tk) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    sent.set(tk, list);
    const blocked = blockedUntil.get(tk) ?? 0;
    if (blocked <= now && list.length < limit) {
      list.push(now);
      return true;
    }
    const wait = Math.max(blocked - now, list.length >= limit ? list[list.length - limit] + RATE_WINDOW_MS - now : 0) + 50;
    if (now + wait > deadline) return false;
    await new Promise((r) => setTimeout(r, wait));
  }
}

function remember(key, body, ttl) {
  cache.set(key, { at: Date.now(), body, ttl });
  if (cache.size > CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at > STALE_MS || cache.size > CACHE_MAX) cache.delete(k);
  }
}

/**
 * קריאה עם אסימון נתון (לא קורא מהמסד) — משמש גם לאימות לפני שמירה (‎fresh‎: בלי מטמון).
 */
async function rawCall(token, path, query, { fresh = false } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const tk = tokenKey(token);
  const key = `${tk}|${url.toString()}`;
  const ttl = fresh ? 0 : ttlOf(path);
  const hit = cache.get(key);
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.body;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const body = await limited(token, tk, url);
      if (ttl) remember(key, body, ttl);
      return body;
    } catch (err) {
      // Timeless מגביל או לא זמין — התשובה האחרונה שנשמרה עדיפה על מסך שגיאה
      if (hit && (err.status === 429 || err.retryable) && Date.now() - hit.at < STALE_MS) {
        diag.staleServed += 1;
        console.warn(`[משימון] Timeless (${url.pathname}): ${err.status || 'שגיאה'} — מוגש מהמטמון`);
        return hit.body;
      }
      throw err;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- אבחון: מה קורה מול Timeless (‎/api/admin/timeless/status‎) ----------
// בזיכרון בלבד, בלי האסימון ובלי תוכן פגישות: כמה בקשות יצאו בדקה (מסך / רקע), מה Timeless
// אמר על המכסה (‎X-RateLimit-*‎), ו-20 ה-429 האחרונים עם הכותרות שלהם.
const diag = { since: Date.now(), requests: [], limited: [], queueFull: 0, staleServed: 0, server: null };
function noteRequest(url, bg, status) {
  const now = Date.now();
  diag.requests.push({ at: now, path: url.pathname.replace(/\/(mtg|doc)_[\w-]+/g, '/$1_…'), bg, status });
  while (diag.requests.length && now - diag.requests[0].at > 10 * 60000) diag.requests.shift();
}
function status() {
  const now = Date.now();
  const lastMin = diag.requests.filter((r) => now - r.at < 60000);
  const byPath = {};
  for (const r of diag.requests) byPath[r.path] = (byPath[r.path] ?? 0) + 1;
  return {
    since: new Date(diag.since).toISOString(),
    orgToken: Boolean(orgToken()),
    lastMinute: { total: lastMin.length, background: lastMin.filter((r) => r.bg).length, screens: lastMin.filter((r) => !r.bg).length },
    last10MinByPath: byPath,
    queueFull: diag.queueFull,
    staleServed: diag.staleServed,
    timelessSays: diag.server,
    blockedFor: Math.max(0, ...[...blockedUntil.values()].map((t) => Math.round((t - now) / 1000))),
    recent429: diag.limited.slice(-20)
  };
}

/**
 * המונה של Timeless עצמו (‎X-RateLimit-Remaining/Reset‎) — כולל בקשות מתהליכים אחרים על אותו
 * אסימון (סוכנים, שרת נוסף). נשארו מעט — מחכים לאיפוס במקום לקבל 429.
 */
function syncFromHeaders(tk, headers) {
  const remaining = Number(headers?.get?.('x-ratelimit-remaining'));
  const limit = Number(headers?.get?.('x-ratelimit-limit'));
  const resetRaw = Number(headers?.get?.('x-ratelimit-reset'));
  if (!Number.isFinite(remaining)) return;
  const now = Date.now();
  // ‎Reset‎ — זמן Unix בשניות, או מספר שניות עד האיפוס
  const resetAt = Number.isFinite(resetRaw) ? (resetRaw > 1e9 ? resetRaw * 1000 : now + resetRaw * 1000) : now + 60000;
  diag.server = { remaining, limit: Number.isFinite(limit) ? limit : null, resetAt: new Date(resetAt).toISOString(), at: new Date(now).toISOString() };
  if (remaining <= 3 && resetAt > now) blockedUntil.set(tk, Math.max(blockedUntil.get(tk) ?? 0, Math.min(resetAt, now + 120000)));
}

async function limited(token, tk, url) {
  const bg = inBackground();
  if (!(await takeSlot(tk, bg))) {
    diag.queueFull += 1;
    throw apiError('Timeless עמוס כרגע — נסו שוב בעוד דקה.', { status: 429, retryable: true });
  }
  try {
    const body = await fetchOnce(token, url, tk);
    noteRequest(url, bg, 200);
    return body;
  } catch (err) {
    noteRequest(url, bg, err.status || 0);
    if (err.status !== 429) throw err;
    diag.limited.push({ at: new Date().toISOString(), path: url.pathname.replace(/\/(mtg|doc)_[\w-]+/g, '/$1_…'), background: bg, retryAfter: err.retryAfterSeconds ?? null, headers: err.rateHeaders ?? null, body: err.bodySnippet ?? '' });
    if (diag.limited.length > 50) diag.limited.splice(0, diag.limited.length - 50);
    // מגביל למרות התור (סוכן או מערכת אחרת על אותו חשבון) — כל הבקשות מחכות כמה ש-Timeless ביקש
    const wait = err.retryAfterSeconds ?? 2;
    blockedUntil.set(tk, Date.now() + Math.min(wait, 120) * 1000);
    if (wait > RETRY_429_MAX_SEC) throw err;
    console.warn(`[משימון] Timeless החזיר 429 (${url.pathname}) — ניסיון חוזר בעוד ${wait} שניות`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    const body = await fetchOnce(token, url, tk);
    noteRequest(url, bg, 200);
    return body;
  }
}

async function fetchOnce(token, url, tk = null) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw apiError(timeout ? 'Timeless לא הגיב בזמן. נסו שוב בעוד רגע.' : `שגיאת רשת בפנייה ל-Timeless: ${err.message}`,
      { retryable: true });
  }
  let body = null;
  const text = await res.text().catch(() => '');
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (tk) syncFromHeaders(tk, res.headers);
  if (res.ok) return body ?? {};

  const apiMsg = body?.error?.message || '';
  const code = body?.error?.code || '';
  if (res.status === 401) throw apiError(RECONNECT_MSG, { status: 401, code: code || 'unauthorized' });
  if (res.status === 429) {
    const err = apiError('Timeless מגביל כרגע את קצב הבקשות. נסו שוב בעוד דקה.', { status: 429, retryable: true, code });
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfterSeconds = ra;
    // לאבחון: כותרות המכסה ותחילת התשובה (בלי האסימון)
    err.rateHeaders = Object.fromEntries(['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']
      .map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null));
    err.bodySnippet = text.slice(0, 200);
    throw err;
  }
  if (res.status >= 500) throw apiError(`שגיאה זמנית בשרת Timeless (${res.status}). נסו שוב מאוחר יותר.`, { status: res.status, retryable: true, code });
  if (res.status === 403) throw apiError('אין הרשאה לפריט הזה ב-Timeless.', { status: 403, code });
  if (res.status === 404) throw apiError('הפריט לא נמצא ב-Timeless. בדקו את המזהה.', { status: 404, code });
  throw apiError(`Timeless החזיר שגיאה (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`, { status: res.status, code });
}

/**
 * קריאה בשם משתמש — באסימון האישי, ואם אין, בארגוני. ‎401‎ מסמן חיבור אישי
 * כמבוטל; בארגוני — הודעה שמנהל המערכת צריך להחליף אותו
 */
async function call(userId, path, query) {
  const access = accessOf(userId);
  if (!access) {
    throw apiError(rowOf(userId) ? RECONNECT_MSG : 'Timeless אינו מחובר. יש לחבר אותו בהגדרות עם אסימון API.',
      { status: 401, code: 'not_connected' });
  }
  if (access.source === 'org') {
    try {
      return await rawCall(access.token, path, query);
    } catch (err) {
      if (err.status === 401) err.message = ORG_RECONNECT_MSG;
      throw err;
    }
  }
  try {
    const out = await rawCall(access.token, path, query);
    const row = rowOf(userId);
    if (row && row.state !== 'connected') setState(userId, 'connected');
    return out;
  } catch (err) {
    if (err.status === 401) setState(userId, 'revoked');
    throw err;
  }
}

// ---------- חיבור ----------

async function connect(userId, token) {
  const clean = String(token ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!clean) throw apiError('יש להזין אסימון API של Timeless.', { status: 400 });
  // אימות בקריאה זולה אמיתית; 401 כאן לא נוגע בחיבור קיים
  await rawCall(clean, '/meetings', { limit: 1 }, { fresh: true });
  const now = D.nowIso();
  D.run(
    `INSERT INTO user_channels (user_id, provider, api_token, state, checked_at, created_at)
     VALUES (?, ?, ?, 'connected', ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       api_token = excluded.api_token, state = 'connected', checked_at = excluded.checked_at`,
    userId, PROVIDER, secrets.encrypt(clean), now, now
  );
  return publicStatus(userId);
}

// ---------- נרמול ----------

function toDate(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function personLabel(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  const name = p.name ? String(p.name).trim() : '';
  const email = p.email ? String(p.email).trim() : '';
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

function normalizeMeeting(m) {
  let durationMinutes = null;
  if (Number.isFinite(Number(m.duration)) && m.duration !== null && m.duration !== '') {
    durationMinutes = Math.round(Number(m.duration) / 60);
  } else if (m.start_time && m.end_time) {
    const ms = new Date(m.end_time) - new Date(m.start_time);
    if (Number.isFinite(ms) && ms >= 0) durationMinutes = Math.round(ms / 60000);
  }
  const people = [];
  const seen = new Set();
  for (const p of [m.host, ...(Array.isArray(m.participants) ? m.participants : [])]) {
    const label = personLabel(p);
    const key = label.toLowerCase();
    if (label && !seen.has(key)) { seen.add(key); people.push(label); }
  }
  const out = {
    id: m.id,
    title: m.title || '',
    start: m.start_time || null,
    end: m.end_time || null,
    durationMinutes,
    participants: people,
    status: m.status || null
  };
  if (Array.isArray(m.documents)) out.documents = m.documents.map(normalizeDocRef);
  return out;
}

const normalizeDocRef = (d) => ({ id: d.id, title: d.title || '', createdAt: d.created_at || null });

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

function truncate(text, maxChars) {
  const max = Math.max(1000, Number(maxChars) || 60000);
  if (text.length <= max) return { text, truncated: false };
  const marker = `\n\n[... התמלול קוצר: הוצגו ${max} תווים מתוך ${text.length} ...]`;
  return { text: text.slice(0, max) + marker, truncated: true };
}

// ---------- פעולות ----------

/** פגישות — דפדוף לפי ‎next_cursor‎/‎has_more‎ עד ‎limit‎ */
async function listMeetings(userId, { search, from, to, limit = 20, status, scope = 'all', semantic = false, expandDocuments = false } = {}) {
  const want = Math.min(LIST_HARD_MAX, Math.max(1, Math.floor(Number(limit) || 20)));
  const query = {
    scope,
    status,
    start_date: toDate(from),
    end_date: toDate(to),
    expand: expandDocuments ? 'documents' : undefined
  };
  const term = search ? String(search).trim() : '';
  if (term) query[semantic ? 'q' : 'search'] = term;

  /*
   * עובד באסימון הארגוני — רק פגישות שלו. Timeless מסנן לפי משתתף (‎participant‎) כבר
   * בבקשה, אז לא מדפדפים בכל פגישות הארגון כדי למצוא את שלו; הסינון כאן נשאר בכל מקרה.
   * גודל הדף קבוע (100) — כך כל הזרימות מבקשות אותה כתובת, והמטמון משותף להן.
   */
  const emails = restrictionOf(userId);
  const out = [];
  const seen = new Set();
  // עבודת רקע (סבב על כל העובדים) — רשימה ארגונית אחת, אותה כתובת לכולם, מסוננת כאן לכל עובד
  const byParticipant = emails && !inBackground();
  for (const participant of byParticipant ? [...emails] : [undefined]) {
    let cursor;
    for (let page = 0; page < MAX_PAGES && out.length < want; page++) {
      const body = await call(userId, '/meetings', { ...query, participant, limit: PAGE_MAX, cursor });
      const items = Array.isArray(body.data) ? body.data : [];
      for (const m of items) {
        if (!m || !m.id || seen.has(m.id) || out.length >= want || (emails && !attended(m, emails))) continue;
        seen.add(m.id);
        out.push(normalizeMeeting(m));
      }
      if (!body.has_more || !body.next_cursor || body.next_cursor === cursor || !items.length) break;
      cursor = body.next_cursor;
    }
  }
  if (emails && out.length > 1) out.sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')));
  return out;
}

/** מוצא פגישה בודדת (אין ‎GET /meetings/{id}‎ מתועד; משתמשים ב-‎?id=‎ שמוזכר בתיעוד) */
async function findMeeting(userId, meetingId, { expandDocuments = false } = {}) {
  const body = await call(userId, '/meetings', { id: meetingId, scope: 'all', limit: 1, expand: expandDocuments ? 'documents' : undefined });
  const items = Array.isArray(body.data) ? body.data : [];
  // אם השרת מתעלם מ-‎id‎ — לא נחזיר פגישה אחרת בטעות
  const m = items.find((x) => x && x.id === meetingId) || null;
  // עובד באסימון הארגוני — פגישה שלא השתתף בה כאילו לא קיימת
  const emails = restrictionOf(userId);
  return m && emails && !attended(m, emails) ? null : m;
}

async function transcript(userId, meetingId, { maxChars = 60000 } = {}) {
  const id = String(meetingId ?? '').trim();
  if (!id) throw apiError('חסר מזהה פגישה.', { status: 400 });
  // עובד באסימון הארגוני — קודם מוודאים שהשתתף, ורק אז מושכים את התמלול
  let title = '';
  if (restrictionOf(userId)) {
    const m = await findMeeting(userId, id);
    if (!m) throw apiError(NOT_ATTENDED_MSG, { status: 404 });
    title = m.title || '';
  }
  const body = await call(userId, `/meetings/${encodeURIComponent(id)}/transcript`);
  const names = new Map((Array.isArray(body.speakers) ? body.speakers : []).map((s) => [s.id, s.name || s.id]));
  const lines = (Array.isArray(body.segments) ? body.segments : [])
    .filter((s) => s && s.text)
    .map((s) => `[${fmtTime(s.start_time)}] ${names.get(s.speaker_id) || s.speaker_name || s.speaker_id || 'דובר'}: ${String(s.text).trim()}`);
  if (!title) {
    try { title = (await findMeeting(userId, id))?.title || ''; } catch (err) { if (err.status === 401) throw err; }
  }
  const t = truncate(lines.join('\n'), maxChars);
  return { meetingId: body.meeting_id || id, title, language: body.language || null, text: t.text, truncated: t.truncated };
}

/** מסמכי ה-AI של פגישה — דרך ‎expand=documents‎ ברשימת הפגישות */
async function documents(userId, meetingId) {
  const id = String(meetingId ?? '').trim();
  if (!id) throw apiError('חסר מזהה פגישה.', { status: 400 });
  const m = await findMeeting(userId, id, { expandDocuments: true });
  if (!m) throw apiError(restrictionOf(userId) ? NOT_ATTENDED_MSG : 'הפגישה לא נמצאה ב-Timeless.', { status: 404 });
  return (Array.isArray(m.documents) ? m.documents : []).map(normalizeDocRef);
}

/**
 * מסמך AI. לעובד באסימון הארגוני מזהה מסמך לבדו אינו מספיק — אי אפשר לדעת של
 * איזו פגישה הוא. צריך ‎meetingId‎ של פגישה שהשתתף בה, והמסמך חייב להיות שלה.
 * ‎verified‎ — הקורא כבר בדק (רשימת המסמכים של אותה פגישה)
 */
async function document(userId, docId, { meetingId, verified = false } = {}) {
  const id = String(docId ?? '').trim();
  if (!id) throw apiError('חסר מזהה מסמך.', { status: 400 });
  if (!verified && restrictionOf(userId)) {
    if (!meetingId) throw apiError('כדי לקרוא מסמך יש לתת גם את מזהה הפגישה (meeting_id).', { status: 400 });
    const refs = await documents(userId, meetingId);
    if (!refs.some((r) => r.id === id)) throw apiError(NOT_ATTENDED_MSG, { status: 404 });
  }
  const body = await call(userId, `/documents/${encodeURIComponent(id)}`, { format: 'markdown' });
  return typeof body.content === 'string' ? body.content : '';
}

async function listRooms(userId, { search, limit = 25 } = {}) {
  // חדר מאגד פגישות של כמה אנשים — לעובד באסימון הארגוני אין דרך לסנן אותו
  if (restrictionOf(userId)) throw apiError('חדרי Timeless זמינים רק להנהלה או עם אסימון אישי.', { status: 403 });
  const want = Math.min(LIST_HARD_MAX, Math.max(1, Math.floor(Number(limit) || 25)));
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES && out.length < want; page++) {
    const body = await call(userId, '/rooms', { scope: 'all', search: search || undefined, limit: Math.min(PAGE_MAX, want - out.length), cursor });
    const items = Array.isArray(body.data) ? body.data : [];
    for (const r of items) if (r && r.id && out.length < want) out.push({ id: r.id, title: r.title || '', meetingCount: r.meeting_count ?? null, updatedAt: r.updated_at || null });
    if (!body.has_more || !body.next_cursor || body.next_cursor === cursor || !items.length) break;
    cursor = body.next_cursor;
  }
  return out;
}

// ---------- מסך ההקלטות (🎥 בלשונית היומן) ----------

/**
 * ההקלטות בטווח — הפגישות שהושלמו, עם מסמכי ה-AI. אותו סינון כמו בכלים:
 * עובד באסימון הארגוני — רק פגישות שהשתתף בהן.
 */
async function recordings(userId, from, to) {
  const meetings = await listMeetings(userId, { from, to, status: 'completed', limit: LIST_HARD_MAX, expandDocuments: true });
  return meetings.sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')));
}

/**
 * קישור לצפייה בהקלטה — כתובת חתומה לזמן קצר מ-Timeless. נמשך מחדש בכל לחיצה,
 * ורק אחרי בדיקה שהפגישה נראית למשתמש. ‎null‎ — אין הקלטה (רק תמלול).
 */
async function recordingUrl(userId, meetingId) {
  const id = String(meetingId ?? '').trim();
  if (!id) throw apiError('חסר מזהה פגישה.', { status: 400 });
  if (restrictionOf(userId) && !(await findMeeting(userId, id))) throw apiError(NOT_ATTENDED_MSG, { status: 404 });
  const body = await call(userId, `/meetings/${encodeURIComponent(id)}/recording`);
  const url = body.recording_url;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

/**
 * התמליל כקטעים — לנגן: דובר, התחלה וסוף בשניות, טקסט. אותה בדיקת הרשאה כמו ‎transcript‎.
 */
async function segments(userId, meetingId) {
  const id = String(meetingId ?? '').trim();
  if (!id) throw apiError('חסר מזהה פגישה.', { status: 400 });
  if (restrictionOf(userId) && !(await findMeeting(userId, id))) throw apiError(NOT_ATTENDED_MSG, { status: 404 });
  const body = await call(userId, `/meetings/${encodeURIComponent(id)}/transcript`);
  const speakers = (Array.isArray(body.speakers) ? body.speakers : []).map((x) => ({ id: String(x.id), name: x.name || String(x.id) }));
  const list = (Array.isArray(body.segments) ? body.segments : [])
    .filter((x) => x && x.text)
    .map((x) => ({ s: Number(x.start_time) || 0, e: Number(x.end_time) || Number(x.start_time) || 0, speaker: String(x.speaker_id ?? ''), text: String(x.text).trim() }));
  return { meetingId: id, language: body.language || null, speakers, segments: list };
}

/** פגישה אחת, מנורמלת — ‎null‎ כשאינה נראית למשתמש */
async function meeting(userId, meetingId) {
  const m = await findMeeting(userId, String(meetingId ?? '').trim(), { expandDocuments: true });
  return m ? normalizeMeeting(m) : null;
}

/**
 * לבדיקת "לא מוקלטת": כל הפגישות ב-Timeless ביום, בכל סטטוס (גם ‎scheduled‎ —
 * Timeless מתכונן להצטרף), באסימון נתון. בלי סינון משתתפים — רק לשרת, לא למשתמש.
 */
async function meetingsOnDay(token, date) {
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await rawCall(token, '/meetings', { scope: 'all', start_date: date, end_date: date, limit: PAGE_MAX, cursor });
    const items = Array.isArray(body.data) ? body.data : [];
    for (const m of items) if (m && m.id) out.push(m);
    if (!body.has_more || !body.next_cursor || body.next_cursor === cursor || !items.length) break;
    cursor = body.next_cursor;
  }
  return out;
}

/** האסימון לבדיקות הרקע: הארגוני, ואם אין — האישי של העובד (רואה את הפגישות שלו) */
function backgroundToken(userId) {
  if (orgToken()) return orgToken();
  const row = rowOf(userId);
  return hasPersonal(row) ? secrets.decrypt(row.api_token) : null;
}

// ---------- לשמירה המקומית (‎meetings/timeless-store.js‎) ----------
// הצינור היחיד מ-Timeless: הפגישות נמשכות פעם אחת ונשמרות במשימון, וכל המסכים והבוט קוראים משם.
// כאן — רק הפניות עצמן, באסימון נתון ובלי סינון משתמש (הסינון בשמירה המקומית, ‎scopeOf‎).

/** מה המשתמש רואה מההקלטות השמורות: ‎{ all: true }‎ (הנהלה), ‎{ all: false, emails }‎, או ‎null‎ */
function scopeOf(userId) {
  if (!isConnected(userId)) return null;
  const u = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u || u.status !== 'active') return null;
  if (Permissions.isManagement(u)) return { all: true };
  const emails = new Set([u.email, u.work_email].map(normEmail).filter((e) => e.includes('@')));
  return emails.size ? { all: false, emails } : null;
}

/** האסימונים שמהם מושכים: הארגוני, ואם אין — האישיים של מי שחיבר */
function syncTokens() {
  if (orgToken()) return [orgToken()];
  const out = new Set();
  for (const r of D.all("SELECT api_token FROM user_channels WHERE provider = ? AND api_token <> '' AND state <> 'revoked'", PROVIDER)) {
    const t = secrets.decrypt(r.api_token);
    if (t) out.add(t);
  }
  return [...out];
}

const org = {
  /** כל הפגישות בטווח, בכל סטטוס, עם מסמכי ה-AI (הפניות) */
  async meetings(token, from, to, { fresh = false } = {}) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES * 3; page++) {
      const body = await rawCall(token, '/meetings', { scope: 'all', start_date: from, end_date: to, expand: 'documents', limit: PAGE_MAX, cursor }, { fresh });
      const items = Array.isArray(body.data) ? body.data : [];
      for (const m of items) if (m && m.id) out.push(m);
      if (!body.has_more || !body.next_cursor || body.next_cursor === cursor || !items.length) break;
      cursor = body.next_cursor;
    }
    return out;
  },
  async meeting(token, id) {
    const body = await rawCall(token, '/meetings', { id, scope: 'all', limit: 1, expand: 'documents' }, { fresh: true });
    return (Array.isArray(body.data) ? body.data : []).find((x) => x && x.id === id) ?? null;
  },
  async transcript(token, id) {
    const body = await rawCall(token, `/meetings/${encodeURIComponent(id)}/transcript`, {}, { fresh: true });
    return {
      language: body.language || null,
      speakers: (Array.isArray(body.speakers) ? body.speakers : []).map((x) => ({ id: String(x.id), name: x.name || String(x.id) })),
      segments: (Array.isArray(body.segments) ? body.segments : []).filter((x) => x && x.text)
        .map((x) => ({ s: Number(x.start_time) || 0, e: Number(x.end_time) || Number(x.start_time) || 0, speaker: String(x.speaker_id ?? ''), text: String(x.text).trim() }))
    };
  },
  /** קישור צפייה — כתובת חתומה לזמן קצר (נשמרת דקה במטמון של ‎rawCall‎) */
  async recordingUrl(token, id) {
    const body = await rawCall(token, `/meetings/${encodeURIComponent(id)}/recording`, {});
    const url = body.recording_url;
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  },
  async document(token, docId) {
    const body = await rawCall(token, `/documents/${encodeURIComponent(docId)}`, { format: 'markdown' }, { fresh: true });
    return typeof body.content === 'string' ? body.content : '';
  },
  /** ‎webhook‎ — Timeless מודיע כשתמליל / סיכום מוכן. מחזיר ‎{ id, secret }‎ (הסוד מגיע רק עכשיו) */
  async createWebhook(token, url, events) {
    const res = await fetch(`${BASE_URL}/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ url, events }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await res.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(text); } catch { /* ריק */ }
    if (!res.ok) throw apiError(`Timeless לא יצר webhook (${res.status})${body?.error?.message ? `: ${body.error.message}` : ''}`, { status: res.status });
    const w = body.data ?? body;
    return { id: w.id ?? null, secret: w.secret ?? '' };
  }
};

// ---------- כלים למודל ----------

const TOOLS = [
  {
    name: 'timeless_list_meetings',
    description: 'מחפש ומציג את פגישות הזום המוקלטות של המשתמש ב-Timeless: כותרת, מועד, משך, משתתפים וסטטוס, ואת מזהי מסמכי ה-AI (סיכומים) של כל פגישה. השתמש כדי למצוא מזהה פגישה לפני קריאת תמלול או סיכום.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'חיפוש בכותרת הפגישה (מחרוזת חלקית)' },
        semantic: { type: 'boolean', description: 'true לחיפוש סמנטי בתוכן הפגישות במקום בכותרת' },
        from: { type: 'string', description: 'מתאריך, YYYY-MM-DD' },
        to: { type: 'string', description: 'עד תאריך, YYYY-MM-DD' },
        status: { type: 'string', enum: ['completed', 'processing', 'scheduled', 'failed'], description: 'סינון לפי סטטוס' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'מספר פגישות מרבי (ברירת מחדל 20)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'timeless_get_transcript',
    description: 'מחזיר את התמלול המלא של פגישה ב-Timeless, שורה לכל דובר עם חותמת זמן. תמלול ארוך מקוצר.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'מזהה הפגישה (למשל mtg_abc123) מתוך timeless_list_meetings' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 120000, description: 'אורך מרבי בתווים (ברירת מחדל 60000)' }
      },
      required: ['meeting_id'],
      additionalProperties: false
    }
  },
  {
    name: 'timeless_get_document',
    description: 'מחזיר מסמך AI של Timeless (סיכום, משימות לביצוע, הערות) כטקסט Markdown. אפשר לתת מזהה פגישה כדי לקבל את כל מסמכיה, או מזהה מסמך — תמיד יחד עם מזהה הפגישה שלו.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'מזהה המסמך (למשל doc_abc123). לתת יחד עם meeting_id' },
        meeting_id: { type: 'string', description: 'מזהה פגישה — מחזיר את כל מסמכי ה-AI שלה' }
      },
      additionalProperties: false
    }
  }
];

const DOC_TOOL_MAX = 60000;

/** מריץ כלי בשם המשתמש הקורא בלבד; מחזיר תמיד אובייקט שניתן להמיר ל-JSON */
async function runTool(userId, name, input = {}) {
  const args = input && typeof input === 'object' ? input : {};
  try {
    if (!isConnected(userId)) {
      return { error: rowOf(userId) ? RECONNECT_MSG : 'Timeless אינו מחובר. בקשו מהמשתמש לחבר את Timeless בהגדרות.', needsReconnect: true };
    }
    switch (name) {
      case 'timeless_list_meetings': {
        const meetings = await listMeetings(userId, {
          search: args.search, from: args.from, to: args.to, status: args.status,
          semantic: Boolean(args.semantic), expandDocuments: true,
          limit: Math.min(50, Math.max(1, Number(args.limit) || 20))
        });
        return { count: meetings.length, meetings };
      }
      case 'timeless_get_transcript':
        return await transcript(userId, args.meeting_id, { maxChars: Math.min(120000, Number(args.max_chars) || 60000) });
      case 'timeless_get_document': {
        if (args.document_id) {
          const t = truncate(await document(userId, args.document_id, { meetingId: args.meeting_id }), DOC_TOOL_MAX);
          return { documentId: args.document_id, markdown: t.text, truncated: t.truncated };
        }
        if (args.meeting_id) {
          const refs = await documents(userId, args.meeting_id);
          const docs = [];
          let budget = DOC_TOOL_MAX;
          for (const ref of refs.slice(0, 5)) {
            if (budget <= 1000) break;
            const t = truncate(await document(userId, ref.id, { verified: true }), budget);
            budget -= t.text.length;
            docs.push({ ...ref, markdown: t.text, truncated: t.truncated });
          }
          return { meetingId: args.meeting_id, count: refs.length, documents: docs };
        }
        return { error: 'יש לתת document_id או meeting_id.' };
      }
      default:
        return { error: `כלי לא מוכר: ${name}` };
    }
  } catch (err) {
    return { error: err.message, retryable: Boolean(err.retryable), ...(err.status === 401 ? { needsReconnect: true } : {}) };
  }
}

module.exports = {
  connect, disconnect, isConnected, publicStatus, hasOrgToken: () => Boolean(orgToken()),
  listMeetings, transcript, documents, document, listRooms, recordings, recordingUrl, segments, meeting, meetingsOnDay, backgroundToken,
  background, status, scopeOf, syncTokens, org, normalizeMeeting, TOOLS, runTool,
  BASE_URL
};
