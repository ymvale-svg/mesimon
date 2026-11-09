'use strict';
/**
 * Zoom — חשבונות ה-Zoom של החברה.
 *
 * חיבור ארגוני (Server-to-Server OAuth), ולא חיבור לכל עובד: בעל החשבון ב-Zoom
 * יוצר פעם אחת אפליקציה ב-Zoom Marketplace, ושלושה ערכים נכנסים לשרת —
 * ‎ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET‎. חשבון שני, אם יש —
 * אותם שלושה עם הקידומת ‎ZOOM2_‎.
 *
 * בחשבון כמה משתמשי Zoom (רישיונות), כדי שאפשר יהיה לקיים כמה פגישות במקביל:
 * כל משתמש Zoom מארח פגישה אחת בכל רגע. כל עובד במשימון מקושר למשתמש Zoom
 * ייעודי (‎users.zoom_user_id‎) — לא בהכרח המייל שלו. כשהוא תפוס באותה שעה,
 * נבחר לבד משתמש Zoom פנוי אחר מהחשבון.
 *
 * ההזמנה ליומן יוצאת תמיד מהמייל של העובד (‎meetings.js‎) — Zoom רק נותן קישור.
 *
 * הקלטות בענן — רשימה לחודש, וצפייה בקובץ דרך השרת (‎recordingFileUrl‎), כך
 * שאסימון החשבון לא מגיע לדפדפן.
 */
const D = require('./db');
const P = require('./permissions');

const OAUTH = 'https://zoom.us/oauth/token';
const API = 'https://api.zoom.us/v2';

/*
 * עד שני חשבונות Zoom. כל אחד — אפליקציית Server-to-Server OAuth משלו, שבעל
 * החשבון יוצר אצלו. משתמשי שני החשבונות נכנסים לאותה רשימה, וכשמשתמש תפוס
 * נבחר משתמש פנוי מכל אחד מהם. ‎zoom_users.account‎ זוכר לאיזה חשבון שייך כל משתמש.
 */
const ACCOUNTS = [
  { key: '1', prefix: 'ZOOM_' },
  { key: '2', prefix: 'ZOOM2_' }
];

const cfg = (key = '1') => {
  const { prefix } = ACCOUNTS.find((a) => a.key === key) ?? ACCOUNTS[0];
  return {
    key,
    prefix,
    accountId: process.env[`${prefix}ACCOUNT_ID`] ?? '',
    clientId: process.env[`${prefix}CLIENT_ID`] ?? '',
    clientSecret: process.env[`${prefix}CLIENT_SECRET`] ?? ''
  };
};
const accountEnabled = (key) => {
  const c = cfg(key);
  return Boolean(c.accountId && c.clientId && c.clientSecret);
};
const enabledAccounts = () => ACCOUNTS.map((a) => a.key).filter(accountEnabled);
const isEnabled = () => enabledAccounts().length > 0;
const missingOf = (key) => {
  const c = cfg(key);
  return Object.entries({ [`${c.prefix}ACCOUNT_ID`]: c.accountId, [`${c.prefix}CLIENT_ID`]: c.clientId, [`${c.prefix}CLIENT_SECRET`]: c.clientSecret })
    .filter(([, v]) => !v).map(([k]) => k);
};
/** מה חסר — של החשבון הראשון; כשחשבון כלשהו מחובר, אין "חסר" */
const missing = () => (isEnabled() ? [] : missingOf('1'));
/** מצב כל חשבון — למסך הניהול. חשבון שני שחצי מוגדר מסומן כחסר */
const accounts = () => ACCOUNTS.map(({ key }) => ({
  key,
  enabled: accountEnabled(key),
  missing: missingOf(key),
  users: D.get('SELECT COUNT(*) c FROM zoom_users WHERE account = ?', key).c
})).filter((a) => a.key === '1' || a.enabled || a.missing.length < 3);

class ZoomError extends Error {}

const tokens = new Map(); // account → { value, expires }

async function accessToken(key) {
  const t = tokens.get(key);
  if (t && t.expires > Date.now()) return t.value;
  const c = cfg(key);
  const res = await fetch(`${OAUTH}?grant_type=account_credentials&account_id=${encodeURIComponent(c.accountId)}`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}` },
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ZoomError(`Zoom דחה את החיבור לחשבון ${key} (${res.status}): ${data.reason ?? data.error ?? ''}`.trim());
  tokens.set(key, { value: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 });
  return data.access_token;
}

async function call(key, method, path, body = null) {
  if (!accountEnabled(key)) throw new ZoomError(key === '1' ? 'חיבור Zoom אינו מוגדר בשרת' : `חשבון Zoom ${key} אינו מוגדר בשרת`);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(key)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 401) tokens.delete(key);
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

/** החשבון של משתמש Zoom */
const accountOfUser = (zoomUserId) => D.get('SELECT account FROM zoom_users WHERE id = ?', zoomUserId)?.account ?? '1';

/**
 * פעולה על פגישה קיימת: בחשבון של המשתמש שמארח אותה. פגישה שהמארח שלה כבר
 * לא ברשימה — מנסים בכל החשבונות, עד שאחד מכיר אותה.
 */
async function onMeeting(meetingId, fn) {
  const known = D.get(
    'SELECT z.account FROM meetings m JOIN zoom_users z ON z.id = m.zoom_user_id WHERE m.zoom_meeting_id = ?', String(meetingId)
  )?.account;
  const order = known ? [known] : enabledAccounts();
  let last = null;
  for (const key of order) {
    try {
      return await fn(key);
    } catch (err) {
      last = err;
      if (err.status !== 404) throw err;
    }
  }
  throw last ?? new ZoomError('חיבור Zoom אינו מוגדר בשרת');
}

// ---------------------------------------------------------------------------
// משתמשי ה-Zoom של החברה
// ---------------------------------------------------------------------------

/** סוג הרישיון: 1 = חינמי (Basic, פגישות של 3+ נקטעות אחרי 40 דקות), 2 = בתשלום */
const LICENSE = { 1: 'basic', 2: 'licensed', 3: 'onprem' };

/**
 * משיכת המשתמשים מכל החשבונות לטבלה המקומית — לשיוך במסך הניהול. חשבון
 * שהמשיכה ממנו נכשלה — המשתמשים שלו נשארים כמו שהיו, ולא נמחקים.
 */
async function syncUsers() {
  const errors = [];
  for (const key of enabledAccounts()) {
    let users = [];
    try {
      let next = '';
      do {
        const page = await call(key, 'GET', `/users?status=active&page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`);
        users.push(...(page.users ?? []));
        next = page.next_page_token ?? '';
      } while (next);
    } catch (err) {
      errors.push(`חשבון ${key}: ${err.message}`);
      continue;
    }
    const at = D.nowIso();
    for (const u of users) {
      D.run(
        `INSERT INTO zoom_users (id, account, email, name, license, synced_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET account = excluded.account, email = excluded.email, name = excluded.name,
           license = excluded.license, synced_at = excluded.synced_at`,
        u.id, key, String(u.email ?? '').toLowerCase(), [u.first_name, u.last_name].filter(Boolean).join(' ') || u.display_name || u.email,
        LICENSE[u.type] ?? 'basic', at
      );
    }
    // מי שנמחק מהחשבון ב-Zoom — יוצא מהרשימה, והעובדים שהיו מקושרים אליו נשארים בלי שיוך
    const ids = new Set(users.map((u) => u.id));
    for (const row of D.all('SELECT id FROM zoom_users WHERE account = ?', key)) {
      if (!ids.has(row.id)) {
        D.run('UPDATE users SET zoom_user_id = NULL WHERE zoom_user_id = ?', row.id);
        D.run('DELETE FROM zoom_users WHERE id = ?', row.id);
      }
    }
  }
  // חשבון שהוסר מהשרת — המשתמשים שלו כבר לא זמינים לפגישות
  const live = enabledAccounts();
  for (const row of D.all('SELECT id, account FROM zoom_users')) {
    if (!live.includes(row.account)) {
      D.run('UPDATE users SET zoom_user_id = NULL WHERE zoom_user_id = ?', row.id);
      D.run('DELETE FROM zoom_users WHERE id = ?', row.id);
    }
  }
  if (errors.length && errors.length === live.length) throw new ZoomError(errors.join(' · '));
  return { users: listUsers(), errors };
}

const listUsers = () => D.all('SELECT * FROM zoom_users ORDER BY account, name').map((u) => ({
  id: u.id, account: u.account, email: u.email, name: u.name, license: u.license,
  linked: D.all("SELECT id, full_name FROM users WHERE zoom_user_id = ? AND status = 'active'", u.id).map((x) => ({ id: x.id, name: x.full_name }))
}));

// ---------------------------------------------------------------------------
// בחירת משתמש Zoom פנוי
// ---------------------------------------------------------------------------

/** משתמשי ה-Zoom שמארחים פגישת משימון אחרת בטווח */
const busyHosts = (startIso, endIso, excludeMeetingId = null) => new Set(D.all(
  `SELECT zoom_user_id FROM meetings
    WHERE status = 'scheduled' AND zoom_user_id IS NOT NULL AND start_at < ? AND end_at > ? AND id IS NOT ?`,
  endIso, startIso, excludeMeetingId
).map((r) => r.zoom_user_id));

/**
 * משתמש ה-Zoom שיארח פגישה בטווח הזה. ‎prefer‎ — מארח שנבחר במפורש (הנהלה
 * ומזכירות, מכל אחד מהחשבונות): תפוס — אין פגישה, עם הסבר. בלי בחירה — קודם
 * המקושר לעובד, ואם אין או שהוא תפוס — משתמש פנוי מכל החשבונות. כך גם עובד
 * שאינו רשום ב-Zoom מקבל פגישה.
 *
 * @returns {{zoomUser: object|null, swapped: boolean, reason?: string}}
 */
function pickHost(userId, startIso, endIso, { excludeMeetingId = null, prefer = null } = {}) {
  const busy = busyHosts(startIso, endIso, excludeMeetingId);
  const live = enabledAccounts();
  if (prefer) {
    const z = D.get('SELECT * FROM zoom_users WHERE id = ?', prefer);
    if (!z || !live.includes(z.account)) return { zoomUser: null, swapped: false, reason: 'משתמש ה-Zoom שנבחר אינו זמין עוד — רעננו את רשימת משתמשי ה-Zoom' };
    if (busy.has(z.id)) return { zoomUser: null, swapped: false, reason: `${z.name} מארח/ת פגישה אחרת בשעה הזו` };
    return { zoomUser: z, swapped: false };
  }
  const linked = D.get('SELECT zoom_user_id FROM users WHERE id = ?', userId)?.zoom_user_id ?? null;
  const own = linked ? D.get('SELECT * FROM zoom_users WHERE id = ?', linked) : null;
  if (own && !busy.has(own.id) && live.includes(own.account)) return { zoomUser: own, swapped: false };
  // חשבונות בתשלום קודם — חינמי נקטע אחרי 40 דקות
  const free = D.all("SELECT * FROM zoom_users ORDER BY CASE license WHEN 'licensed' THEN 0 ELSE 1 END, account, name")
    .find((z) => !busy.has(z.id) && live.includes(z.account));
  if (!free) return { zoomUser: null, swapped: false, reason: 'אין משתמש Zoom פנוי בשעה הזו' };
  return { zoomUser: free, swapped: Boolean(own), reason: own ? `${own.name} תפוס בשעה הזו` : '' };
}

/** כל משתמשי ה-Zoom בחשבונות הפעילים, ומי מהם תפוס בטווח — לבורר המארח */
function hostsAt(startIso, endIso, excludeMeetingId = null) {
  const busy = startIso && endIso ? busyHosts(startIso, endIso, excludeMeetingId) : new Set();
  const live = enabledAccounts();
  return D.all('SELECT * FROM zoom_users ORDER BY account, name').filter((z) => live.includes(z.account))
    .map((z) => ({ id: z.id, name: z.name, email: z.email, account: z.account, license: z.license, busy: busy.has(z.id) }));
}

// ---------------------------------------------------------------------------
// פגישות
// ---------------------------------------------------------------------------

const zoomTime = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * ‎record‎ — הקלטה אוטומטית לענן. רק כשנמסר: עדכון שלא נגע בהקלטה (הזזה
 * מהיומן) לא משנה אותה ב-Zoom.
 */
function meetingBody({ title, startIso, minutes, agenda = '', record }) {
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
      mute_upon_entry: true,
      ...(record === undefined ? {} : { auto_recording: record ? 'cloud' : 'none' })
    }
  };
}

/**
 * יצירת פגישה. Zoom מחזיר 400 על הגדרה שהחשבון או המשתמש לא מאפשרים (הקלטה
 * לענן במשתמש חינמי, "כניסה לפני המארח" שנעולה בחשבון) או על מועד שכבר
 * התחיל — אז מנסים שוב: מועד מעכשיו, ובלי ההגדרות האלה. ‎warning‎ — מה ירד.
 */
async function createMeeting(zoomUserId, opts) {
  const key = accountOfUser(zoomUserId);
  const path = `/users/${encodeURIComponent(zoomUserId)}/meetings`;
  // פגישה שמתחילה עכשיו (נקבעה ל-15:45 ב-15:47) — ל-Zoom שולחים מועד עתידי; הקישור זהה
  const startMs = Math.max(new Date(opts.startIso).getTime(), Date.now() + 60000);
  const body = meetingBody({ ...opts, startIso: new Date(startMs).toISOString() });
  let m;
  let warning = '';
  try {
    m = await call(key, 'POST', path, body);
  } catch (err) {
    if (err.status !== 400) throw err;
    console.error(`[משימון] Zoom דחה יצירת פגישה (${zoomUserId}): ${err.message} — מנסה שוב בלי הגדרות נוספות`);
    const plain = { ...body, settings: {} };
    try {
      m = await call(key, 'POST', path, plain);
    } catch (err2) {
      err2.firstError = err.message;
      throw err2;
    }
    warning = opts.record ? 'Zoom לא אפשר הקלטה אוטומטית לענן במשתמש הזה — הפגישה נוצרה בלי הקלטה' : '';
  }
  return { id: String(m.id), joinUrl: m.join_url, password: m.password ?? '', warning };
}

async function updateMeeting(meetingId, opts) {
  await onMeeting(meetingId, (key) => call(key, 'PATCH', `/meetings/${encodeURIComponent(meetingId)}`, meetingBody(opts)));
}

async function deleteMeeting(meetingId) {
  try {
    await onMeeting(meetingId, (key) => call(key, 'DELETE', `/meetings/${encodeURIComponent(meetingId)}`));
  } catch (err) {
    // נמחקה כבר ב-Zoom — זה בדיוק מה שרצינו
    if (err.status !== 404) throw err;
  }
}

/** קישור המארח — נוצר מחדש בכל בקשה, כי הוא תקף לשעתיים בלבד */
async function startUrl(meetingId) {
  const m = await onMeeting(meetingId, (key) => call(key, 'GET', `/meetings/${encodeURIComponent(meetingId)}`));
  return m.start_url;
}

// ---------------------------------------------------------------------------
// הקלטות בענן
// ---------------------------------------------------------------------------

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/*
 * מזהה פגישה (uuid) שמתחיל ב-/ או מכיל // — Zoom דורש קידוד כפול בנתיב.
 */
const uuidPath = (uuid) => {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(once) : once;
};

const FILE_KIND = {
  MP4: 'video', M4A: 'audio', TRANSCRIPT: 'transcript', VTT: 'transcript', CHAT: 'chat', TXT: 'chat', CC: 'transcript', SUMMARY: 'summary'
};

/** הקלטה של פגישה, כפי שמשימון מציג אותה. ‎host‎ — שורה מ-‎zoom_users‎, אם ידועה */
const shapeRecording = (m, host = null) => ({
  uuid: m.uuid,
  meetingId: String(m.id),
  topic: m.topic ?? '',
  start: m.start_time,
  minutes: Number(m.duration ?? 0),
  host: host ? { id: host.id, name: host.name, email: host.email, account: host.account } : { id: m.host_id ?? '', name: '', email: m.host_email ?? '', account: '' },
  // בלי קישור השיתוף של Zoom ובלי קוד הצפייה: מי שמקבל אותם צופה בלי בדיקת הרשאה.
  // הצפייה רק דרך ‎/api/zoom/recordings/file‎, שבודק הרשאה בכל פעם (issue #65)
  files: (m.recording_files ?? []).map(shapeFile)
});

const shapeFile = (f) => ({
  id: f.id,
  kind: FILE_KIND[f.file_type] ?? 'other',
  type: f.file_type,
  view: f.recording_type ?? '',
  size: Number(f.file_size ?? 0),
  start: f.recording_start ?? null,
  end: f.recording_end ?? null,
  ready: f.status !== 'processing'
});

/**
 * ההקלטות של משתמשי Zoom בטווח — ‎from‎ ו-‎to‎ בפורמט YYYY-MM-DD. Zoom מחזיר
 * עד חודש בכל בקשה, ולכן טווח ארוך מתחלק לחלונות של 30 יום.
 *
 * @param {string[]} zoomUserIds  משתמשי ה-Zoom (מהטבלה המקומית)
 * @returns {{recordings: object[], errors: string[]}}
 */
async function listRecordings(zoomUserIds, from, to) {
  const windows = [];
  for (let a = new Date(`${from}T00:00:00Z`); a <= new Date(`${to}T00:00:00Z`);) {
    const b = new Date(Math.min(a.getTime() + 29 * 86400000, new Date(`${to}T00:00:00Z`).getTime()));
    windows.push([ymd(a), ymd(b)]);
    a = new Date(b.getTime() + 86400000);
  }
  const live = enabledAccounts();
  const hosts = zoomUserIds.map((id) => D.get('SELECT * FROM zoom_users WHERE id = ?', id)).filter((z) => z && live.includes(z.account));
  const out = [];
  const errors = [];
  await Promise.all(hosts.map(async (z) => {
    try {
      for (const [f, t] of windows) {
        let next = '';
        do {
          const page = await call(z.account, 'GET',
            `/users/${encodeURIComponent(z.id)}/recordings?from=${f}&to=${t}&page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`);
          for (const m of page.meetings ?? []) {
            out.push(shapeRecording(m, z));
          }
          next = page.next_page_token ?? '';
        } while (next);
      }
    } catch (err) {
      errors.push(`${z.name}: ${err.status === 400 || err.status === 403 || err.status === 404 ? 'אין הרשאה להקלטות — הוסיפו לאפליקציה ב-Zoom את הרשאות Cloud Recording' : err.message}`);
    }
  }));
  // אותה פגישה יכולה לחזור בשני חלונות סמוכים — פעם אחת בלבד
  const seen = new Set();
  const recordings = out.filter((r) => (seen.has(r.uuid) ? false : seen.add(r.uuid)))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return { recordings, errors };
}

/**
 * קישור לצפייה בקובץ הקלטה. השרת מבקש את הקובץ מ-Zoom עם האסימון, ו-Zoom
 * מפנה לכתובת חתומה לזמן קצר — אותה מקבל הדפדפן. אם Zoom לא הפנה — קישור
 * הצפייה של Zoom (שדורש כניסה לחשבון או את קוד ההקלטה).
 *
 * @returns {{url: string, hostZoomUserId: string, meetingId: string}}
 */
async function recordingFileUrl(uuid, fileId) {
  let rec = null;
  let account = null;
  let last = null;
  for (const key of enabledAccounts()) {
    try {
      rec = await call(key, 'GET', `/meetings/${uuidPath(uuid)}/recordings`);
      account = key;
      break;
    } catch (err) {
      last = err;
      if (err.status !== 404) throw err;
    }
  }
  if (!rec) throw last ?? new ZoomError('ההקלטה לא נמצאה');
  const file = (rec.recording_files ?? []).find((f) => f.id === fileId);
  if (!file) throw Object.assign(new ZoomError('הקובץ לא נמצא בהקלטה'), { status: 404 });
  const meta = { hostZoomUserId: rec.host_id ?? '', meetingId: String(rec.id ?? '') };
  if (file.download_url) {
    const res = await fetch(file.download_url, {
      headers: { authorization: `Bearer ${await accessToken(account)}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    });
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400 && location) return { url: location, ...meta };
  }
  if (file.play_url) return { url: file.play_url, ...meta };
  throw new ZoomError('Zoom לא החזיר קישור לקובץ');
}

/**
 * ההקלטה של פגישה שמשימון קבע — לפי מזהה הפגישה ב-Zoom (המופע האחרון שלה).
 * אין הקלטה (עוד לא הסתיימה, לא הוקלטה, או ש-Zoom עוד מעבד) — ‎null‎.
 */
async function meetingRecording(zoomMeetingId) {
  try {
    const m = await onMeeting(zoomMeetingId, (key) => call(key, 'GET', `/meetings/${encodeURIComponent(zoomMeetingId)}/recordings`));
    const host = m.host_id ? D.get('SELECT * FROM zoom_users WHERE id = ?', m.host_id) : null;
    return shapeRecording(m, host);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// מי רואה אילו הקלטות
// ---------------------------------------------------------------------------

/**
 * מי שמנהל את כל המשתמשים בארגון (לא מנהל מחלקה) — את כל ההקלטות בחשבונות. עובד אחר — רק של פגישות
 * משימון שהוא בעל היומן שלהן, קבע אותן או הוזמן אליהן. לא לפי שיוך רישיון Zoom: הרישיונות משותפים,
 * ופגישות של הנהלה ומזכירות יושבות על כל רישיון פנוי (issue #65). אותו כלל באפליקציה ובבוט.
 */
function recordingScope(actor) {
  if (P.can(actor, 'manage_users')) return { all: true, hosts: D.all('SELECT id FROM zoom_users').map((z) => z.id), meetingIds: new Set() };
  const email = String(D.get('SELECT email FROM users WHERE id = ?', actor.id)?.email ?? '').toLowerCase();
  const mine = D.all(
    `SELECT zoom_user_id, zoom_meeting_id FROM meetings
      WHERE zoom_meeting_id IS NOT NULL AND (owner_id = ? OR created_by = ? OR via_user_id = ? OR (? <> '' AND lower(attendees) LIKE ?))`,
    actor.id, actor.id, actor.id, email, `%"${email}"%`
  );
  return {
    all: false,
    hosts: [...new Set(mine.map((m) => m.zoom_user_id).filter(Boolean))],
    meetingIds: new Set(mine.map((m) => String(m.zoom_meeting_id)))
  };
}

const mayWatch = (scope, meetingId) => scope.all || scope.meetingIds.has(String(meetingId));

/**
 * ההקלטות שהעובד רשאי לראות בטווח, וליד כל אחת — פגישת משימון שלה, אם יש
 * (נושא, משתתפים, משימה).
 */
async function recordingsFor(actor, from, to) {
  const scope = recordingScope(actor);
  const { recordings, errors } = await listRecordings(scope.hosts, from, to);
  const ours = new Map();
  const list = recordings.filter((r) => mayWatch(scope, r.meetingId)).map((r) => {
    if (!ours.has(r.meetingId)) {
      ours.set(r.meetingId, D.get('SELECT id, task_id, title, attendees FROM meetings WHERE zoom_meeting_id = ? ORDER BY id DESC LIMIT 1', r.meetingId) ?? null);
    }
    const m = ours.get(r.meetingId);
    let attendees = [];
    try { attendees = m ? JSON.parse(m.attendees) : []; } catch { /* ריק */ }
    return { ...r, meeting: m ? { id: m.id, taskId: m.task_id, title: m.title, attendees: attendees.map((a) => a.name || a.email) } : null };
  });
  return { all: scope.all, recordings: list, errors };
}

module.exports = {
  isEnabled, missing, accounts, syncUsers, listUsers, pickHost, hostsAt, createMeeting, updateMeeting, deleteMeeting, startUrl,
  listRecordings, recordingFileUrl, meetingRecording, recordingScope, mayWatch, recordingsFor, ZoomError,
  _internal: { meetingBody, call }
};
