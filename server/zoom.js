'use strict';
/**
 * Zoom — חשבון ה-Zoom של החברה.
 *
 * חיבור ארגוני אחד (Server-to-Server OAuth), ולא חיבור לכל עובד: מנהל ה-Zoom
 * יוצר פעם אחת אפליקציה ב-Zoom Marketplace, ושלושה ערכים נכנסים לשרת —
 * ‎ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET‎.
 *
 * בחשבון כמה משתמשי Zoom (רישיונות), כדי שאפשר יהיה לקיים כמה פגישות במקביל:
 * כל משתמש Zoom מארח פגישה אחת בכל רגע. כל עובד במשימון מקושר למשתמש Zoom
 * ייעודי (‎users.zoom_user_id‎) — לא בהכרח המייל שלו. כשהוא תפוס באותה שעה,
 * נבחר לבד משתמש Zoom פנוי אחר מהחשבון.
 *
 * ההזמנה ליומן יוצאת תמיד מהמייל של העובד (‎meetings.js‎) — Zoom רק נותן קישור.
 */
const D = require('./db');

const OAUTH = 'https://zoom.us/oauth/token';
const API = 'https://api.zoom.us/v2';

const cfg = () => ({
  accountId: process.env.ZOOM_ACCOUNT_ID ?? '',
  clientId: process.env.ZOOM_CLIENT_ID ?? '',
  clientSecret: process.env.ZOOM_CLIENT_SECRET ?? ''
});
const isEnabled = () => {
  const c = cfg();
  return Boolean(c.accountId && c.clientId && c.clientSecret);
};
const missing = () => Object.entries({ ZOOM_ACCOUNT_ID: cfg().accountId, ZOOM_CLIENT_ID: cfg().clientId, ZOOM_CLIENT_SECRET: cfg().clientSecret })
  .filter(([, v]) => !v).map(([k]) => k);

class ZoomError extends Error {}

let token = null; // { value, expires }

async function accessToken() {
  if (token && token.expires > Date.now()) return token.value;
  const c = cfg();
  const res = await fetch(`${OAUTH}?grant_type=account_credentials&account_id=${encodeURIComponent(c.accountId)}`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}` },
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ZoomError(`Zoom דחה את החיבור (${res.status}): ${data.reason ?? data.error ?? ''}`.trim());
  token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

async function call(method, path, body = null) {
  if (!isEnabled()) throw new ZoomError('חיבור Zoom אינו מוגדר בשרת');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 401) token = null;
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message ?? msg; } catch { /* טקסט */ }
    const err = new ZoomError(`Zoom החזיר ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// משתמשי ה-Zoom של החברה
// ---------------------------------------------------------------------------

/** סוג הרישיון: 1 = חינמי (Basic, פגישות של 3+ נקטעות אחרי 40 דקות), 2 = בתשלום */
const LICENSE = { 1: 'basic', 2: 'licensed', 3: 'onprem' };

/** משיכת המשתמשים מ-Zoom לטבלה המקומית — לשיוך במסך הניהול */
async function syncUsers() {
  const users = [];
  let next = '';
  do {
    const page = await call('GET', `/users?status=active&page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`);
    users.push(...(page.users ?? []));
    next = page.next_page_token ?? '';
  } while (next);
  const at = D.nowIso();
  for (const u of users) {
    D.run(
      `INSERT INTO zoom_users (id, email, name, license, synced_at) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, license = excluded.license, synced_at = excluded.synced_at`,
      u.id, String(u.email ?? '').toLowerCase(), [u.first_name, u.last_name].filter(Boolean).join(' ') || u.display_name || u.email,
      LICENSE[u.type] ?? 'basic', at
    );
  }
  // מי שנמחק מ-Zoom — יוצא מהרשימה, והעובדים שהיו מקושרים אליו נשארים בלי שיוך
  const ids = new Set(users.map((u) => u.id));
  for (const row of D.all('SELECT id FROM zoom_users')) {
    if (!ids.has(row.id)) {
      D.run('UPDATE users SET zoom_user_id = NULL WHERE zoom_user_id = ?', row.id);
      D.run('DELETE FROM zoom_users WHERE id = ?', row.id);
    }
  }
  return listUsers();
}

const listUsers = () => D.all('SELECT * FROM zoom_users ORDER BY name').map((u) => ({
  id: u.id, email: u.email, name: u.name, license: u.license,
  linked: D.all("SELECT id, full_name FROM users WHERE zoom_user_id = ? AND status = 'active'", u.id).map((x) => ({ id: x.id, name: x.full_name }))
}));

// ---------------------------------------------------------------------------
// בחירת משתמש Zoom פנוי
// ---------------------------------------------------------------------------

/**
 * משתמש ה-Zoom שיארח פגישה בטווח הזה. קודם המקושר לעובד; אם הוא מארח
 * באותה שעה פגישה אחרת של משימון — משתמש פנוי אחר מהחשבון.
 *
 * @returns {{zoomUser: object|null, swapped: boolean, reason?: string}}
 */
function pickHost(userId, startIso, endIso, { excludeMeetingId = null } = {}) {
  const busy = new Set(D.all(
    `SELECT zoom_user_id FROM meetings
      WHERE status = 'scheduled' AND zoom_user_id IS NOT NULL AND start_at < ? AND end_at > ? AND id IS NOT ?`,
    endIso, startIso, excludeMeetingId
  ).map((r) => r.zoom_user_id));
  const linked = D.get('SELECT zoom_user_id FROM users WHERE id = ?', userId)?.zoom_user_id ?? null;
  const own = linked ? D.get('SELECT * FROM zoom_users WHERE id = ?', linked) : null;
  if (own && !busy.has(own.id)) return { zoomUser: own, swapped: false };
  // חשבונות בתשלום קודם — חינמי נקטע אחרי 40 דקות
  const free = D.all("SELECT * FROM zoom_users ORDER BY CASE license WHEN 'licensed' THEN 0 ELSE 1 END, name")
    .find((z) => !busy.has(z.id));
  if (!free) return { zoomUser: null, swapped: false, reason: 'אין משתמש Zoom פנוי בשעה הזו' };
  return { zoomUser: free, swapped: Boolean(own), reason: own ? `${own.name} תפוס בשעה הזו` : (linked ? '' : 'לעובד לא שויך משתמש Zoom') };
}

// ---------------------------------------------------------------------------
// פגישות
// ---------------------------------------------------------------------------

const zoomTime = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

function meetingBody({ title, startIso, minutes, agenda = '' }) {
  return {
    topic: String(title).slice(0, 200),
    type: 2,
    start_time: zoomTime(startIso),
    duration: minutes,
    timezone: 'Asia/Jerusalem',
    agenda: String(agenda).slice(0, 1900),
    settings: {
      // הפגישה מתחילה בזמן גם בלי שהמארח "פותח" אותה
      join_before_host: true,
      jbh_time: 10,
      waiting_room: false,
      mute_upon_entry: true
    }
  };
}

async function createMeeting(zoomUserId, opts) {
  const m = await call('POST', `/users/${encodeURIComponent(zoomUserId)}/meetings`, meetingBody(opts));
  return { id: String(m.id), joinUrl: m.join_url, password: m.password ?? '' };
}

async function updateMeeting(meetingId, opts) {
  await call('PATCH', `/meetings/${encodeURIComponent(meetingId)}`, meetingBody(opts));
}

async function deleteMeeting(meetingId) {
  try {
    await call('DELETE', `/meetings/${encodeURIComponent(meetingId)}`);
  } catch (err) {
    // נמחקה כבר ב-Zoom — זה בדיוק מה שרצינו
    if (err.status !== 404) throw err;
  }
}

/** קישור המארח — נוצר מחדש בכל בקשה, כי הוא תקף לשעתיים בלבד */
async function startUrl(meetingId) {
  const m = await call('GET', `/meetings/${encodeURIComponent(meetingId)}`);
  return m.start_url;
}

module.exports = {
  isEnabled, missing, syncUsers, listUsers, pickHost, createMeeting, updateMeeting, deleteMeeting, startUrl, ZoomError,
  _internal: { meetingBody, call }
};
