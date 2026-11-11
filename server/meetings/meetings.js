'use strict';
/**
 * קביעת פגישות מתוך משימה.
 *
 *   • איפה: ביומן Google של העובד — הוא המארגן, וההזמנה יוצאת בשמו. מזכירה
 *     קובעת ביומן של עובד רק אם העובד שיתף איתה את היומן לעריכה ב-Google;
 *     משימון פועל דרך החיבור שלה, ולא מקבל שום גישה מעבר למה שהעובד נתן.
 *   • התנגשויות: זמינות (‎freeBusy‎) לכל המשתתפים מהארגון. פרטי הפגישות — רק
 *     ביומנים שמי שקובעת רשאית לראות.
 *   • מועדים פנויים: חלונות שבהם כולם פנויים, בימי העבודה ובשעות הפגישות.
 *   • חלופות: אילו פגישות חופפות להזיז ולאן — ה-AI מסדר ומנמק; היעד של כל
 *     הזזה הוא תמיד מועד שהקוד וידא שכולם בו פנויים. שום דבר לא זז בלי לחיצה.
 *   • Zoom: מחשבון החברה (‎zoom.js‎), מהמשתמש המקושר לעובד או ממשתמש פנוי.
 *   • סנכרון: היומן הוא מקור האמת. ביטול ביומן מבטל אצלנו בשקט ומחזיר את
 *     המשימה לרשימת האישור; הזזה מעדכנת את ההתראה ואת ה-Zoom.
 *   • התראה כמה דקות לפני — במשימון, ובבוט הוואטסאפ הארגוני.
 */
const fs = require('node:fs');
const Paths = require('../core').Paths;
const path = require('node:path');

const D = require('../core').Db;
const W = require('../core').Workdays;
const Gmail = require('../integrations').Gmail;
const Zoom = require('../integrations').Zoom;
const Secretariat = require('../core').Secretariat;
const Claude = require('../integrations').Claude;

const CAL = 'https://www.googleapis.com/calendar/v3';
const TZ = W.TZ;
const MIN = 60000;
const SKILL_PATH = Paths.skill('meeting-alternatives.md');

// מוזרק מ-api.js: יצירת משימה וצורת משימה עם כל ההרשאות, ובוט הוואטסאפ
const hooks = { sendWhatsApp: null, botReady: () => false, botAllowed: () => false };
const init = (h) => Object.assign(hooks, h);

class MeetingError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const userById = (id) => D.get("SELECT id, full_name, email, phone, is_secretary, zoom_user_id FROM users WHERE id = ? AND status = 'active'", id);
const userByEmail = (email) => D.get("SELECT id, full_name, email, phone FROM users WHERE lower(email) = ? AND status = 'active'", String(email ?? '').toLowerCase());
const isSecretary = (actor) => actor?.type === 'user' && Secretariat.isSecretary(actor.id);

/**
 * Zoom — מי פותח איפה:
 *   • מזכירות והנהלה — בכל משתמש Zoom משני החשבונות (בחירה, או "אוטומטי"),
 *     ומקבלים את קישור המארח לכל פגישה.
 *   • כל השאר (גם מנהלי מחלקות) — רק במשתמש ה-Zoom המשויך להם בכרטיס העובד.
 *     אין משויך, או שהוא תפוס בשעה — אין Zoom, עם הסבר.
 */
const ZOOM_MANAGERS = ['superadmin', 'admin', 'executive'];
const isZoomManager = (actor) => actor?.type === 'user' && (ZOOM_MANAGERS.includes(actor.role) || isSecretary(actor));
const canChooseZoomHost = isZoomManager;

/** משתמש ה-Zoom המשויך לעובד — שורה מ-‎zoom_users‎, או ‎null‎ */
const ownZoomUser = (userId) => {
  const id = D.get('SELECT zoom_user_id FROM users WHERE id = ?', userId)?.zoom_user_id;
  return id ? D.get('SELECT * FROM zoom_users WHERE id = ?', id) ?? null : null;
};

function meetingHours() {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(D.getSetting('meeting_hours', '08:30-18:00')));
  return m ? { from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] } : { from: [8, 30], to: [18, 0] };
}

// ---------------------------------------------------------------------------
// גישה ליומנים
// ---------------------------------------------------------------------------

const ACCESS_RANK = { none: 0, freebusy: 1, read: 2, write: 3, owner: 4 };
const ROLE_TO_ACCESS = { freeBusyReader: 'freebusy', reader: 'read', writer: 'write', owner: 'write' };
const accessCache = new Map(); // actorId → { at, map }

/**
 * רמת הגישה של המשתמש ליומן של כל עובד, כפי ש-Google רואה אותה: מה שהעובד
 * שיתף איתו. ליומן של עצמו — ‎owner‎, אם חיבר את היומן.
 *
 * @returns {Map<number, string>} userId → none | freebusy | read | write | owner
 */
async function accessMap(actor, { fresh = false } = {}) {
  const hit = accessCache.get(actor.id);
  if (!fresh && hit && Date.now() - hit.at < 10 * MIN) return hit.map;
  const map = new Map();
  let error = '';
  if (Gmail.has(actor.id, 'calendar')) map.set(actor.id, 'owner');
  if (isSecretary(actor) && Gmail.has(actor.id, 'calendarList')) {
    try {
      let pageToken;
      do {
        const page = await Gmail.googleCall(actor.id, `${CAL}/users/me/calendarList`, { maxResults: 250, pageToken });
        for (const c of page.items ?? []) {
          const u = userByEmail(c.id);
          if (!u || u.id === actor.id) continue;
          const level = ROLE_TO_ACCESS[c.accessRole] ?? 'none';
          if (ACCESS_RANK[level] > ACCESS_RANK[map.get(u.id) ?? 'none']) map.set(u.id, level);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      console.error('[משימון] קריאת היומנים המשותפים נכשלה:', err.message);
      error = `Google לא החזיר את רשימת היומנים: ${err.message}`;
    }
  }
  /*
   * רענון ידני: יומן ששותף עם המזכירה לא תמיד נכנס לרשימת היומנים שלה ב-Google
   * (עד שלוחצים "הוספת יומן" במייל השיתוף). לכל עובד שלא נמצא — בודקים ישירות:
   * רשימת האירועים מחזירה גם את רמת הגישה (‎accessRole‎).
   */
  if (fresh && isSecretary(actor) && Gmail.has(actor.id, 'calendar')) {
    const rest = D.all("SELECT id, email FROM users WHERE status = 'active' AND email <> '' AND id <> ?", actor.id)
      .filter((u) => (map.get(u.id) ?? 'none') === 'none');
    const probe = async (u) => {
      try {
        const r = await Gmail.googleCall(actor.id, `${CAL}/calendars/${encodeURIComponent(u.email)}/events`, { maxResults: 1, timeMin: new Date().toISOString() });
        const level = ROLE_TO_ACCESS[r.accessRole] ?? 'none';
        if (ACCESS_RANK[level] > ACCESS_RANK[map.get(u.id) ?? 'none']) map.set(u.id, level);
      } catch { /* לא שיתף — נשאר "לא שיתף" */ }
    };
    for (let i = 0; i < rest.length; i += 6) await Promise.all(rest.slice(i, i + 6).map(probe));
  }
  accessCache.set(actor.id, { at: Date.now(), map, error });
  return map;
}

/** השגיאה מהקריאה האחרונה של רשימת היומנים, אם הייתה */
const accessError = (actorId) => accessCache.get(actorId)?.error ?? '';

const forgetAccess = (actorId) => accessCache.delete(actorId);

/** היומנים שאפשר לקבוע בהם — לבורר "ביומן של" ולמסך היומן */
async function calendarsFor(actor, { fresh = false } = {}) {
  const map = await accessMap(actor, { fresh });
  const secretary = isSecretary(actor);
  const users = secretary
    ? D.all("SELECT id, full_name, email, department FROM users WHERE status = 'active' ORDER BY full_name")
    : D.all('SELECT id, full_name, email, department FROM users WHERE id = ?', actor.id);
  return users.map((u) => ({
    userId: u.id,
    name: u.full_name,
    email: u.email,
    department: u.department ?? '',
    self: u.id === actor.id,
    access: u.id === actor.id ? (map.get(u.id) ? 'owner' : 'none') : (map.get(u.id) ?? 'none')
  }));
}

/**
 * דרך איזה חיבור ובאיזה יומן פועלים ביומן של ‎ownerId‎. העובד עצמו — היומן
 * הראשי שלו. מזכירה — היומן המשותף, רק אם העובד שיתף איתה לעריכה.
 */
async function resolveCalendar(actor, ownerId, { need = 'write' } = {}) {
  const owner = userById(ownerId);
  if (!owner) throw new MeetingError('העובד שנבחר אינו פעיל');
  if (owner.id === actor.id) {
    if (!Gmail.has(actor.id, 'calendar')) throw new MeetingError('כדי לקבוע פגישות צריך לחבר את היומן של Google ("החשבון שלי ← חיבור Google")');
    return { owner, viaUserId: actor.id, calendarId: 'primary', calendarEmail: owner.email };
  }
  if (!isSecretary(actor)) throw new MeetingError('אפשר לקבוע פגישות רק ביומן שלך', 403);
  const level = (await accessMap(actor)).get(owner.id) ?? 'none';
  if (ACCESS_RANK[level] < ACCESS_RANK[need]) {
    throw new MeetingError(`${owner.full_name} לא שיתף/ה איתך את היומן ${need === 'write' ? 'לעריכה' : 'לצפייה'} ב-Google`, 403);
  }
  return { owner, viaUserId: actor.id, calendarId: owner.email, calendarEmail: owner.email };
}

/** האם המשתמש רשאי לפעול ביומן של העובד בפועל — לפי מה שהעובד שיתף */
async function canWrite(actor, userId) {
  if (userId === actor.id) return Gmail.has(actor.id, 'calendar');
  if (!isSecretary(actor)) return false;
  return ACCESS_RANK[(await accessMap(actor)).get(userId) ?? 'none'] >= ACCESS_RANK.write;
}

// ---------------------------------------------------------------------------
// זמינות
// ---------------------------------------------------------------------------

/** ‎freeBusy‎ לכתובות, דרך החיבור של המשתמש. כתובת שאין עליה מידע — ‎error‎ */
async function freeBusy(actor, emails, fromIso, toIso) {
  const out = new Map();
  const list = [...new Set(emails.map((e) => String(e).toLowerCase()).filter(Boolean))];
  if (!list.length) return out;
  if (!Gmail.has(actor.id, 'freebusy')) {
    for (const e of list) out.set(e, { busy: [], error: 'reconnect' });
    return out;
  }
  // עד 50 יומנים בבקשה אחת
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const res = await Gmail.googleCall(actor.id, `${CAL}/freeBusy`, {}, {
      method: 'POST',
      body: { timeMin: fromIso, timeMax: toIso, timeZone: TZ, items: chunk.map((id) => ({ id })) }
    });
    for (const e of chunk) {
      const c = res.calendars?.[e] ?? Object.entries(res.calendars ?? {}).find(([k]) => k.toLowerCase() === e)?.[1];
      out.set(e, c?.errors?.length ? { busy: [], error: c.errors[0].reason ?? 'notFound' } : { busy: (c?.busy ?? []).map((b) => ({ start: b.start, end: b.end })) });
    }
  }
  return out;
}

/** אירועים עם פרטים ביומן שמותר לקרוא — לשמות בהתנגשות ולחלופות */
async function eventsOf(actor, calendarEmail, fromIso, toIso, calendarId = calendarEmail) {
  const items = [];
  let pageToken;
  do {
    const page = await Gmail.googleCall(actor.id, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: 250, pageToken
    });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items
    .filter((e) => e.status !== 'cancelled' && e.start?.dateTime && e.transparency !== 'transparent')
    .filter((e) => (e.attendees ?? []).find((a) => a.self)?.responseStatus !== 'declined')
    .map((e) => shapeEvent(e, calendarEmail, calendarId));
}

function shapeEvent(e, calendarEmail, calendarId) {
  const hidden = e.visibility === 'private' || e.visibility === 'confidential';
  const organizer = String(e.organizer?.email ?? '').toLowerCase();
  const attendees = (e.attendees ?? []).filter((a) => !a.resource);
  const orgDomain = String(calendarEmail).split('@')[1] ?? '';
  return {
    eventId: e.id,
    calendarId,
    calendarEmail,
    title: hidden ? null : String(e.summary ?? '(ללא כותרת)'),
    start: e.start.dateTime,
    end: e.end.dateTime,
    private: hidden,
    recurring: Boolean(e.recurringEventId),
    organizer,
    organizerIsOwner: organizer === String(calendarEmail).toLowerCase() || Boolean(e.organizer?.self),
    attendees: attendees.map((a) => ({ email: String(a.email ?? '').toLowerCase(), name: a.displayName ?? '', response: a.responseStatus ?? 'needsAction' })),
    external: attendees.some((a) => !String(a.email ?? '').toLowerCase().endsWith(`@${orgDomain}`) && !userByEmail(a.email)),
    createdAt: e.created ?? null,
    mesimon: Boolean(e.extendedProperties?.private?.mesimon)
  };
}

/**
 * מי מהמשתתפים "מהארגון" — יש לנו עליו מידע זמינות. עובד במשימון, או כתובת
 * בדומיין של בעל היומן. כל השאר — מחוץ לארגון, בלי זמינות.
 */
function splitPeople(ownerEmail, emails) {
  const domain = String(ownerEmail).split('@')[1] ?? '';
  const internal = [];
  const external = [];
  for (const raw of emails) {
    const e = String(raw ?? '').trim().toLowerCase();
    if (!e) continue;
    if (userByEmail(e) || (domain && e.endsWith(`@${domain}`))) internal.push(e);
    else external.push(e);
  }
  return { internal: [...new Set(internal)], external: [...new Set(external)] };
}

/**
 * שורת הזמינות ליום אחד: לכל משתתף מהארגון — הבלוקים התפוסים, עם שם הפגישה
 * כשמותר לראות אותו.
 */
async function availability(actor, { ownerId, emails = [], date }) {
  const owner = userById(ownerId) ?? userById(actor.id);
  if (!W.isDate(date)) throw new MeetingError('תאריך לא תקין');
  const fromIso = W.ilWallToUtc(date, 0, 0).toISOString();
  const toIso = W.ilWallToUtc(W.addDays(date, 1), 0, 0).toISOString();
  const { internal, external } = splitPeople(owner.email, [owner.email, ...emails]);
  const fb = await freeBusy(actor, internal, fromIso, toIso);
  const access = await accessMap(actor);

  const rows = [];
  for (const email of internal) {
    const u = userByEmail(email);
    const info = fb.get(email) ?? { busy: [] };
    let details = null;
    const level = u ? (u.id === actor.id ? 'owner' : access.get(u.id) ?? 'none') : 'none';
    if (ACCESS_RANK[level] >= ACCESS_RANK.read) {
      try {
        details = await eventsOf(actor, email, fromIso, toIso, u.id === actor.id ? 'primary' : email);
      } catch { /* בלי פרטים — רק "תפוס" */ }
    }
    const busy = details
      ? details.map((e) => ({ start: e.start, end: e.end, title: e.title, eventId: e.eventId, private: e.private }))
      : info.busy.map((b) => ({ ...b, title: null }));
    rows.push({ email, name: u?.full_name ?? email, userId: u?.id ?? null, internal: true, access: level, busy, error: info.error ?? null });
  }
  for (const email of external) rows.push({ email, name: email, userId: null, internal: false, busy: [], error: null });
  const h = meetingHours();
  return { date, hours: { from: `${String(h.from[0]).padStart(2, '0')}:${String(h.from[1]).padStart(2, '0')}`, to: `${String(h.to[0]).padStart(2, '0')}:${String(h.to[1]).padStart(2, '0')}` }, rows };
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * מועדים שבהם כל המשתתפים מהארגון פנויים: בימי העבודה של כולם, בשעות
 * הפגישות, עם מרווח מפגישה צמודה. הקרוב קודם, עד 3 ביום.
 */
async function suggest(actor, { ownerId, emails = [], minutes, days = 7, max = 8, avoid = [] }) {
  const owner = userById(ownerId) ?? userById(actor.id);
  const dur = Math.max(10, Math.min(8 * 60, Number(minutes) || Number(D.getSetting('meeting_default_minutes', 30))));
  const buffer = Number(D.getSetting('meeting_buffer_minutes', 10)) * MIN;
  const { internal } = splitPeople(owner.email, [owner.email, ...emails]);

  // ימי עבודה משותפים לכל המשתתפים שהם עובדים במשימון
  const ids = internal.map((e) => userByEmail(e)?.id).filter(Boolean);
  const workDays = ids.reduce((acc, id) => acc.filter((d) => W.workDaysOf(id).includes(d)), [0, 1, 2, 3, 4, 5]);
  const today = W.todayIL();
  const dates = [];
  for (let d = today; dates.length < days && dates.length < 30; d = W.addDays(d, 1)) {
    if (workDays.includes(W.weekdayOf(d))) dates.push(d);
    if (W.addDays(today, 40) < d) break;
  }
  if (!dates.length) return { slots: [], people: internal.length };

  const fromIso = W.ilWallToUtc(dates[0], 0, 0).toISOString();
  const toIso = W.ilWallToUtc(W.addDays(dates[dates.length - 1], 1), 0, 0).toISOString();
  const fb = await freeBusy(actor, internal, fromIso, toIso);
  const busy = [...fb.values()].flatMap((x) => x.busy).map((b) => [new Date(b.start).getTime() - buffer, new Date(b.end).getTime() + buffer]);
  for (const a of avoid) busy.push([new Date(a.start).getTime(), new Date(a.end).getTime()]);

  const h = meetingHours();
  // מהרבע שעה הנוכחי — ב-15:47 גם 15:45 מוצע (כמו שהדיאלוג מאפשר לקבוע)
  const now = quarterStart();
  const slots = [];
  for (const d of dates) {
    let perDay = 0;
    const dayStart = W.ilWallToUtc(d, h.from[0], h.from[1]).getTime();
    const dayEnd = W.ilWallToUtc(d, h.to[0], h.to[1]).getTime();
    for (let t = dayStart; t + dur * MIN <= dayEnd && perDay < 3; t += 15 * MIN) {
      if (t < now) continue;
      const end = t + dur * MIN;
      if (busy.some(([s, e]) => overlaps(t, end, s, e))) continue;
      slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
      perDay++;
      t += 45 * MIN; // הצעות מפוזרות, לא רבע שעה אחרי רבע שעה
      if (slots.length >= max) return { slots, people: internal.length, buffer: buffer / MIN, unknown: [...fb.entries()].filter(([, v]) => v.error).map(([k]) => k) };
    }
  }
  return { slots, people: internal.length, buffer: buffer / MIN, unknown: [...fb.entries()].filter(([, v]) => v.error).map(([k]) => k) };
}

// ---------------------------------------------------------------------------
// חלופות — אילו פגישות להזיז
// ---------------------------------------------------------------------------

/**
 * כשהמועד המבוקש תפוס: לכל פגישה חופפת שמותר לראות — לאן אפשר להזיז אותה
 * (מועד שכל המשתתפים שלה פנויים בו), ובנוסף מועד פנוי לפגישה החדשה עצמה.
 * ה-AI מסדר ומנמק; בלי AI — סדר לפי כללים פשוטים.
 */
async function alternatives(actor, { ownerId, emails = [], start, minutes }) {
  const owner = userById(ownerId) ?? userById(actor.id);
  const dur = Math.max(10, Number(minutes) || 30);
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) throw new MeetingError('מועד לא תקין');
  const endIso = new Date(startMs + dur * MIN).toISOString();
  const date = W.ilDateOf(start);
  const avail = await availability(actor, { ownerId: owner.id, emails, date });

  // הבלוקים שחופפים למועד המבוקש
  const conflicts = [];
  for (const row of avail.rows) {
    for (const b of row.busy) {
      if (!overlaps(new Date(b.start).getTime(), new Date(b.end).getTime(), startMs, startMs + dur * MIN)) continue;
      conflicts.push({ person: row, block: b });
    }
  }
  const options = [];
  const seen = new Set();
  for (const { person, block } of conflicts) {
    if (!block.eventId) {
      // אין פרטים (העובד לא שיתף) — אפשר רק לבקש ממנו
      options.push({
        id: `ask-${person.email}-${block.start}`, type: 'ask', who: person.name, userId: person.userId,
        conflict: { title: null, start: block.start, end: block.end, person: person.name }, to: null, action: 'request'
      });
      continue;
    }
    if (seen.has(block.eventId)) continue;
    seen.add(block.eventId);
    let ev;
    try {
      ev = (await eventsOf(actor, person.email, block.start, block.end, person.userId === actor.id ? 'primary' : person.email))
        .find((e) => e.eventId === block.eventId);
    } catch { ev = null; }
    if (!ev || ev.private) continue;
    // לאן להזיז: מועד שכל המשתתפים מהארגון בפגישה החופפת פנויים בו, ולא חופף לחדשה
    const participants = [person.email, ...ev.attendees.map((a) => a.email)];
    const evMinutes = Math.round((new Date(ev.end) - new Date(ev.start)) / MIN);
    const { slots } = await suggest(actor, {
      ownerId: person.userId ?? owner.id, emails: participants, minutes: evMinutes, days: 5, max: 2,
      avoid: [{ start, end: endIso }]
    });
    const organizerUser = userByEmail(ev.organizer);
    const movable = ev.organizerIsOwner && person.userId && await canWrite(actor, person.userId);
    for (const to of slots.slice(0, 2)) {
      options.push({
        id: `move-${ev.eventId}-${to.start}`, type: 'move',
        conflict: {
          eventId: ev.eventId, calendarEmail: ev.calendarEmail, ownerId: person.userId, title: ev.title, start: ev.start, end: ev.end,
          person: person.name, recurring: ev.recurring, attendees: ev.attendees.length, external: ev.external,
          organizer: organizerUser?.full_name ?? ev.organizer
        },
        to,
        action: movable ? 'move' : organizerUser ? 'request' : 'none',
        requestTo: movable ? null : organizerUser?.id ?? null
      });
    }
  }
  // במקום להזיז — מועד פנוי לפגישה החדשה
  const own = await suggest(actor, { ownerId: owner.id, emails, minutes: dur, days: 7, max: 2 });
  for (const s of own.slots) options.push({ id: `slot-${s.start}`, type: 'slot', to: s, action: 'schedule' });

  const ranked = await rank(options, { title: emails.length ? `פגישה עם ${emails.length} משתתפים` : 'פגישה חדשה', start, minutes: dur });
  return { conflicts: conflicts.length, options: ranked.filter((o) => o.action !== 'none').slice(0, 5) };
}

/** סדר לפי כללים — מה שמפריע פחות קודם. בסיס גם לסדר של ה-AI */
function ruleScore(o) {
  if (o.type === 'slot') return 2;
  if (o.type === 'ask') return 0;
  const c = o.conflict;
  return (c.recurring ? 2 : 0) + (c.attendees <= 3 ? 1 : 0) + (c.external ? -3 : 1) + (o.action === 'move' ? 1 : 0);
}

const RANK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ranking'],
  properties: {
    ranking: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } }
    }
  }
};

async function rank(options, meeting) {
  const byRule = [...options].sort((a, b) => ruleScore(b) - ruleScore(a));
  if (!byRule.length || !Claude.isEnabled() || !D.getSetting('meeting_ai_alternatives', true)) return byRule;
  const fmt = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const lines = byRule.map((o) => {
    if (o.type === 'slot') return `${o.id}: לקבוע את הפגישה החדשה ב-${fmt(o.to.start)} (כולם פנויים) — בלי להזיז כלום`;
    if (o.type === 'ask') return `${o.id}: ${o.who} תפוס/ה (אין פרטים) — לבקש ממנו/ה לפנות זמן`;
    const c = o.conflict;
    return `${o.id}: להזיז את "${c.title}" (${c.person}; ${c.attendees} משתתפים; ${c.recurring ? 'חוזרת' : 'חד-פעמית'}; ${c.external ? 'יש משתתפים מבחוץ' : 'פנימית'}; מארגן: ${c.organizer}) מ-${fmt(c.start)} ל-${fmt(o.to.start)}${o.action === 'request' ? ' — דרך בקשה מהמארגן' : ''}`;
  });
  try {
    const out = await Claude.json({
      system: fs.readFileSync(SKILL_PATH, 'utf8'),
      content: [{ type: 'text', text: `הפגישה החדשה: ${meeting.title}, ${fmt(meeting.start)}, ${meeting.minutes} דקות.\n\nהחלופות:\n${lines.join('\n')}` }],
      schema: RANK_SCHEMA,
      effort: 'low'
    });
    const reasons = new Map(out.ranking.map((r, i) => [r.id, { i, reason: String(r.reason).slice(0, 200) }]));
    return byRule
      .map((o) => ({ ...o, reason: reasons.get(o.id)?.reason ?? '' }))
      .sort((a, b) => (reasons.get(a.id)?.i ?? 99) - (reasons.get(b.id)?.i ?? 99));
  } catch (err) {
    console.error('[משימון] דירוג חלופות לפגישה נכשל:', err.message);
    return byRule;
  }
}

// ---------------------------------------------------------------------------
// קביעה, שינוי, ביטול
// ---------------------------------------------------------------------------

const eventUrl = (calendarId, eventId = '') => `${CAL}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

function cleanAttendees(list, ownerEmail) {
  const out = [];
  const seen = new Set([String(ownerEmail).toLowerCase()]);
  for (const a of Array.isArray(list) ? list : []) {
    const email = String(a?.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: String(a?.name ?? '').trim().slice(0, 120), response: 'needsAction' });
  }
  if (out.length > 100) throw new MeetingError('יותר מדי משתתפים');
  return out;
}

function eventBody(m, { zoomJoinUrl = null } = {}) {
  const loc = m.location_type === 'zoom' ? zoomJoinUrl ?? m.zoom_join_url ?? '' : m.location;
  const desc = [
    m.notes,
    m.location_type === 'zoom' && (zoomJoinUrl ?? m.zoom_join_url) ? `\nהצטרפות ב-Zoom: ${zoomJoinUrl ?? m.zoom_join_url}` : null,
    m.location_type === 'link' && m.location ? `\nקישור: ${m.location}` : null
  ].filter(Boolean).join('\n').trim();
  return {
    summary: m.title,
    description: desc,
    location: loc,
    start: { dateTime: m.start_at, timeZone: TZ },
    end: { dateTime: m.end_at, timeZone: TZ },
    attendees: parseJson(m.attendees, []).map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) })),
    extendedProperties: { private: { mesimon: '1', mesimonMeetingId: String(m.id), mesimonTaskId: m.task_id ? String(m.task_id) : '' } }
  };
}

const meetingById = (id) => D.get('SELECT * FROM meetings WHERE id = ?', id);

function shape(m) {
  if (!m) return null;
  const owner = m.owner_id ? userById(m.owner_id) : null;
  const zoomUser = m.zoom_user_id ? D.get('SELECT name, email, license FROM zoom_users WHERE id = ?', m.zoom_user_id) : null;
  return {
    id: m.id,
    taskId: m.task_id,
    title: m.title,
    notes: m.notes,
    ownerId: m.owner_id,
    ownerName: owner?.full_name ?? '',
    createdBy: m.created_by,
    locationType: m.location_type,
    location: m.location,
    start: m.start_at,
    end: m.end_at,
    minutes: Math.round((new Date(m.end_at) - new Date(m.start_at)) / MIN),
    attendees: parseJson(m.attendees, []),
    zoom: m.zoom_meeting_id ? { userId: m.zoom_user_id, joinUrl: m.zoom_join_url, host: zoomUser?.name ?? '', hostEmail: zoomUser?.email ?? '', basic: zoomUser?.license === 'basic', record: Boolean(m.zoom_record) } : null,
    status: m.status,
    past: new Date(m.end_at).getTime() < Date.now(),
    syncError: m.sync_error,
    eventLink: null
  };
}

/**
 * מועד שכבר עבר — לא קובעים. מותר מתחילת הרבע שעה הנוכחי: ב-15:47 אפשר עוד
 * לקבוע ל-15:45 (פגישה שמתחילה עכשיו), לא ל-15:30.
 */
/** Zoom סירב ליצור פגישה — התראה למנהלי המערכת, עם מה ש-Zoom החזיר */
function zoomAlert(actor, zoomUser, title, startIso, err) {
  console.error(`[משימון] יצירת פגישת Zoom נכשלה (${zoomUser?.email ?? zoomUser?.id}):`, err.firstError ?? '', err.message);
  const body = [`קבע/ה: ${actor?.name ?? ''}`, `פגישה: ${title} · ${fmtWhen(startIso)}`, `משתמש Zoom: ${zoomUser?.name ?? ''} ${zoomUser?.email ?? ''}`,
    err.firstError ? `ניסיון ראשון: ${err.firstError}` : null, `שגיאה: ${err.message}`].filter(Boolean).join('\n');
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      D.notify({ targetType: 'user', targetId: u.id, kind: 'meeting', title: '🎥 Zoom: יצירת פגישה נכשלה', body });
    }
  } catch (e) {
    console.error('[משימון] התראה למנהלים על Zoom:', e.message);
  }
}

const quarterStart = (ms = Date.now()) => Math.floor(ms / (15 * MIN)) * 15 * MIN;
function assertNotPast(startMs) {
  if (startMs < quarterStart()) throw new MeetingError('המועד כבר עבר — בחרו מועד מעכשיו והלאה');
}

/**
 * ‎input‎: ‎{ taskId, ownerId, title, attendees: [{email,name}], start (ISO),
 * minutes, locationType: zoom|place|link|none, location, notes, sendInvites,
 * record }‎ — ‎record‎: הקלטה אוטומטית לענן ב-Zoom
 */
async function create(actor, input) {
  const cal = await resolveCalendar(actor, Number(input.ownerId) || actor.id);
  const title = String(input.title ?? '').trim().slice(0, 200);
  if (!title) throw new MeetingError('נדרש נושא לפגישה');
  const startMs = new Date(input.start).getTime();
  if (!Number.isFinite(startMs)) throw new MeetingError('נדרש מועד לפגישה');
  assertNotPast(startMs);
  const minutes = Math.max(5, Math.min(12 * 60, Math.round(Number(input.minutes) || 30)));
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + minutes * MIN).toISOString();
  const locationType = ['zoom', 'place', 'link', 'none'].includes(input.locationType) ? input.locationType : 'none';
  const record = locationType === 'zoom' && Boolean(input.record);
  const attendees = cleanAttendees(input.attendees, cal.calendarEmail);
  const now = D.nowIso();

  // Zoom קודם — בלי קישור אין מה לשלוח בהזמנה
  let zoom = null;
  let zoomNote = '';
  if (locationType === 'zoom') {
    if (!Zoom.isEnabled()) throw new MeetingError('חיבור Zoom אינו מוגדר בשרת — בחרו מיקום אחר, או בקשו ממנהל המערכת להגדיר');
    let prefer = input.zoomUserId && canChooseZoomHost(actor) ? String(input.zoomUserId) : null;
    if (!canChooseZoomHost(actor)) {
      // עובד — רק במשתמש ה-Zoom שלו
      const own = ownZoomUser(actor.id);
      if (!own) throw new MeetingError('לא שויך לך משתמש Zoom, ולכן אי אפשר לפתוח פגישת Zoom. בחרו מיקום אחר, או בקשו מהמזכירות לקבוע את הפגישה.');
      prefer = own.id;
    }
    const pick = Zoom.pickHost(cal.owner.id, startIso, endIso, { prefer });
    if (!pick.zoomUser) throw new MeetingError(`${pick.reason}. בחרו ${prefer && canChooseZoomHost(actor) ? 'משתמש Zoom אחר, ' : ''}מועד אחר, או מיקום אחר.`);
    zoomNote = pick.swapped || pick.reason ? `הפגישה ב-Zoom של ${pick.zoomUser.name}${pick.reason ? ` (${pick.reason})` : ''}` : '';
    let z;
    try {
      z = await Zoom.createMeeting(pick.zoomUser.id, { title, startIso, minutes, agenda: String(input.notes ?? ''), record });
    } catch (err) {
      // לעובד — מה אפשר לעשות; הפרטים הטכניים — למנהלי המערכת
      zoomAlert(actor, pick.zoomUser, title, startIso, err);
      throw new MeetingError('לא הצלחנו ליצור את קישור ה-Zoom, והפגישה לא נקבעה. אפשר לנסות שוב, לבחור מארח Zoom אחר, או לקבוע ב"במשרד" / "קישור משלי" — מנהלי המערכת קיבלו את פרטי התקלה.');
    }
    if (z.warning) zoomNote = [zoomNote, z.warning].filter(Boolean).join(' · ');
    zoom = { userId: pick.zoomUser.id, id: z.id, joinUrl: z.joinUrl, password: z.password };
  }

  const r = D.run(
    `INSERT INTO meetings (task_id, created_by, owner_id, via_user_id, calendar_id, title, notes, location_type, location,
       start_at, end_at, attendees, zoom_user_id, zoom_meeting_id, zoom_join_url, zoom_record, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?)`,
    input.taskId ? Number(input.taskId) : null, actor.id, cal.owner.id, cal.viaUserId, cal.calendarId, title,
    String(input.notes ?? '').slice(0, 4000), locationType, String(input.location ?? '').slice(0, 500),
    startIso, endIso, JSON.stringify(attendees), zoom?.userId ?? null, zoom?.id ?? null, zoom?.joinUrl ?? null, record ? 1 : 0, now, now
  );
  const id = Number(r.lastInsertRowid);
  let m = meetingById(id);
  try {
    const ev = await Gmail.googleCall(cal.viaUserId, eventUrl(cal.calendarId), { sendUpdates: input.sendInvites === false ? 'none' : 'all' }, {
      method: 'POST', body: eventBody(m)
    });
    D.run('UPDATE meetings SET google_event_id = ?, etag = ?, synced_at = ? WHERE id = ?', ev.id, ev.etag ?? null, D.nowIso(), id);
  } catch (err) {
    // היומן סירב — אין פגישה. ה-Zoom שנוצר נמחק, כדי לא להשאיר פגישה יתומה
    D.run('DELETE FROM meetings WHERE id = ?', id);
    if (zoom) await Zoom.deleteMeeting(zoom.id).catch(() => {});
    throw new MeetingError(`היומן של Google סירב לקבוע את הפגישה: ${err.message}`);
  }
  m = meetingById(id);
  const taskClosed = m.task_id ? afterScheduled(m, actor) : false;
  // ‎taskClosed‎ — משימה למזכירות שנסגרה לבד; הלקוח לא שואל "לסגור את המשימה?"
  return { meeting: shape(m), note: zoomNote, taskClosed };
}

const fmtWhen = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** המשימה אחרי שנקבעה פגישה: יומן פעולות, סטטוס קצר, ויעד לא מוקדם מהפגישה */
function afterScheduled(m, actor, verb = 'נקבעה') {
  const task = D.get('SELECT * FROM tasks WHERE id = ?', m.task_id);
  if (!task) return false;
  const people = parseJson(m.attendees, []).map((a) => a.name || a.email).slice(0, 5).join(', ');
  D.run('UPDATE tasks SET meeting_pending = 0, status_short = ? WHERE id = ?', `📅 ${verb} ל-${fmtWhen(m.start_at)}`.slice(0, 200), task.id);
  const day = W.ilDateOf(m.start_at);
  if (!task.due_date || W.ilDateOf(task.due_date) < day) D.run('UPDATE tasks SET due_date = ? WHERE id = ?', W.dueIso(day), task.id);
  D.audit(task.id, actor ? { type: 'user', id: actor.id, name: actor.name } : { type: 'system', id: null, name: 'יומן Google' },
    'meeting', `פגישה ${verb} ל-${fmtWhen(m.start_at)}${people ? ` עם ${people}` : ''}`);
  return Boolean(task.secretary_request && verb === 'נקבעה' && closeSecretaryRequest(task, m, actor));
}

/**
 * משימה למזכירות — הפגישה נקבעה ביומן, והעבודה של המזכירה הסתיימה: המשימה
 * עוברת לסטטוס הסופי של הבורד שלה, ומי שביקש מקבל התראה.
 */
function closeSecretaryRequest(task, m, actor) {
  const final = D.get('SELECT key, label FROM board_columns WHERE board_id = ? AND is_final = 1 ORDER BY position LIMIT 1', task.board_id);
  const current = D.get('SELECT label, is_final FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status);
  if (!final || current?.is_final) return false;
  // משימה שתלויה במשימה פתוחה — לא נסגרת לבד (אותו כלל של סגירה ידנית)
  if (task.depends_on_task_id) {
    const dep = D.get('SELECT t.status, t.board_id FROM tasks t WHERE t.id = ?', task.depends_on_task_id);
    if (dep && !D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', dep.board_id, dep.status)?.is_final) return false;
  }
  const now = D.nowIso();
  D.run('UPDATE tasks SET status = ?, status_changed_at = ?, completed_at = ?, escalated = 0 WHERE id = ?', final.key, now, now, task.id);
  D.audit(task.id, actor ? { type: 'user', id: actor.id, name: actor.name } : { type: 'system', id: null, name: 'יומן Google' },
    'status_changed', `סטטוס: ${current?.label ?? task.status} ← ${final.label} | נסגרה אוטומטית — הפגישה נקבעה ביומן`);
  if (task.created_by && task.created_by !== actor?.id) {
    D.notify({
      targetType: 'user', targetId: task.created_by, kind: 'meeting',
      title: '📅 הפגישה נקבעה — המשימה נסגרה',
      body: `${task.title} — ${fmtWhen(m.start_at)}${actor?.name ? ` (קבע/ה: ${actor.name})` : ''}`,
      taskId: task.id
    });
  }
  return true;
}

/**
 * הפגישה של משימה למזכירות בוטלה — המשימה, שנסגרה כשנקבעה, נפתחת מחדש כדי
 * שהמזכירה תקבע שוב.
 */
function reopenSecretaryRequest(task) {
  if (!task.secretary_request) return;
  const current = D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status);
  if (!current?.is_final) return;
  const first = D.get('SELECT key FROM board_columns WHERE board_id = ? AND is_final = 0 ORDER BY position LIMIT 1', task.board_id);
  if (!first) return;
  D.run('UPDATE tasks SET status = ?, status_changed_at = ?, completed_at = NULL WHERE id = ?', first.key, D.nowIso(), task.id);
  D.audit(task.id, { type: 'system', id: null, name: 'משימון' }, 'status_changed', 'המשימה נפתחה מחדש — הפגישה בוטלה ויש לקבוע אותה שוב');
}

async function update(actor, id, input) {
  const m = meetingById(id);
  if (!m || m.status !== 'scheduled') throw new MeetingError('הפגישה לא נמצאה או שבוטלה', 404);
  if (!(await canWrite(actor, m.owner_id)) && m.created_by !== actor.id) throw new MeetingError('אין לך גישה ליומן הזה', 403);
  const via = (await canWrite(actor, m.owner_id)) ? actor.id : m.via_user_id;
  const calendarId = via === m.owner_id ? 'primary' : (userById(m.owner_id)?.email ?? m.calendar_id);

  const title = input.title !== undefined ? String(input.title).trim().slice(0, 200) || m.title : m.title;
  const minutes = input.minutes !== undefined ? Math.max(5, Math.round(Number(input.minutes) || 30)) : Math.round((new Date(m.end_at) - new Date(m.start_at)) / MIN);
  const startMs = input.start !== undefined ? new Date(input.start).getTime() : new Date(m.start_at).getTime();
  if (!Number.isFinite(startMs)) throw new MeetingError('מועד לא תקין');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + minutes * MIN).toISOString();
  const attendees = input.attendees !== undefined ? cleanAttendees(input.attendees, userById(m.owner_id)?.email) : parseJson(m.attendees, []);
  const notes = input.notes !== undefined ? String(input.notes).slice(0, 4000) : m.notes;
  const moved = startIso !== m.start_at || endIso !== m.end_at;
  if (input.start !== undefined && startIso !== m.start_at) assertNotPast(startMs);
  const record = input.record !== undefined && m.zoom_meeting_id ? Boolean(input.record) : Boolean(m.zoom_record);
  const recordChanged = record !== Boolean(m.zoom_record);

  let zoomUserId = m.zoom_user_id;
  // העברת הפגישה למשתמש Zoom אחר (גם בחשבון השני)
  const wanted = input.zoomUserId && canChooseZoomHost(actor) && m.zoom_meeting_id ? String(input.zoomUserId) : null;
  if (wanted && wanted !== m.zoom_user_id) {
    const pick = Zoom.pickHost(m.owner_id, startIso, endIso, { excludeMeetingId: m.id, prefer: wanted });
    if (!pick.zoomUser) throw new MeetingError(pick.reason);
    const z = await Zoom.createMeeting(pick.zoomUser.id, { title, startIso, minutes, agenda: notes, record });
    await Zoom.deleteMeeting(m.zoom_meeting_id).catch(() => {});
    D.run('UPDATE meetings SET zoom_user_id = ?, zoom_meeting_id = ?, zoom_join_url = ?, reminded_at = NULL WHERE id = ?', pick.zoomUser.id, z.id, z.joinUrl, m.id);
    zoomUserId = pick.zoomUser.id;
  } else if (m.zoom_meeting_id && (moved || recordChanged)) {
    // עובד שאינו מזכירה או הנהלה — הפגישה נשארת אצל אותו מארח; תפוס במועד החדש — לא מזיזים
    if (moved && !canChooseZoomHost(actor) && m.zoom_user_id && Zoom.hostsAt(startIso, endIso, m.id).some((h) => h.id === m.zoom_user_id && h.busy)) {
      throw new MeetingError('משתמש ה-Zoom של הפגישה מארח פגישה אחרת במועד החדש. בחרו מועד אחר, או בקשו מהמזכירות להזיז.');
    }
    // המארח תפוס במועד החדש — הפגישה עוברת למשתמש Zoom פנוי
    const pick = Zoom.pickHost(m.owner_id, startIso, endIso, { excludeMeetingId: m.id });
    if (moved && pick.zoomUser && pick.zoomUser.id !== m.zoom_user_id && D.get(
      "SELECT 1 FROM meetings WHERE zoom_user_id = ? AND status = 'scheduled' AND id <> ? AND start_at < ? AND end_at > ?", m.zoom_user_id, m.id, endIso, startIso)) {
      await Zoom.deleteMeeting(m.zoom_meeting_id).catch(() => {});
      const z = await Zoom.createMeeting(pick.zoomUser.id, { title, startIso, minutes, agenda: notes, record });
      D.run('UPDATE meetings SET zoom_user_id = ?, zoom_meeting_id = ?, zoom_join_url = ? WHERE id = ?', pick.zoomUser.id, z.id, z.joinUrl, m.id);
      zoomUserId = pick.zoomUser.id;
    } else {
      await Zoom.updateMeeting(m.zoom_meeting_id, { title, startIso, minutes, agenda: notes, record }).catch((err) => console.error('[משימון] עדכון Zoom נכשל:', err.message));
    }
  }
  D.run(
    `UPDATE meetings SET title = ?, notes = ?, start_at = ?, end_at = ?, attendees = ?, reminded_at = CASE WHEN ? THEN NULL ELSE reminded_at END,
       zoom_user_id = ?, zoom_record = ?, updated_at = ? WHERE id = ?`,
    title, notes, startIso, endIso, JSON.stringify(attendees), moved ? 1 : 0, zoomUserId, record ? 1 : 0, D.nowIso(), m.id
  );
  const fresh = meetingById(m.id);
  const ev = await Gmail.googleCall(via, eventUrl(calendarId, m.google_event_id), { sendUpdates: 'all' }, { method: 'PATCH', body: eventBody(fresh) });
  D.run('UPDATE meetings SET etag = ?, synced_at = ? WHERE id = ?', ev.etag ?? null, D.nowIso(), m.id);
  if (moved && fresh.task_id) afterScheduled(fresh, actor, 'הוזזה');
  return { meeting: shape(meetingById(m.id)) };
}

/**
 * ביטול. ‎fromCalendar‎ — בוטלה ביומן עצמו (סנכרון): לא נוגעים ביומן ולא
 * שולחים כלום, ומחזירים את המשימה לרשימת האישור.
 */
async function cancel(actor, id, { fromCalendar = false } = {}) {
  const m = meetingById(id);
  if (!m || m.status === 'cancelled') return null;
  if (!fromCalendar) {
    if (!(await canWrite(actor, m.owner_id)) && m.created_by !== actor.id) throw new MeetingError('אין לך גישה ליומן הזה', 403);
    const via = (await canWrite(actor, m.owner_id)) ? actor.id : m.via_user_id;
    const calendarId = via === m.owner_id ? 'primary' : (userById(m.owner_id)?.email ?? m.calendar_id);
    if (m.google_event_id) {
      try {
        await Gmail.googleCall(via, eventUrl(calendarId, m.google_event_id), { sendUpdates: 'all' }, { method: 'DELETE' });
      } catch (err) {
        if (![404, 410].includes(err.status)) throw new MeetingError(`ביטול ביומן נכשל: ${err.message}`);
      }
    }
  }
  if (m.zoom_meeting_id) await Zoom.deleteMeeting(m.zoom_meeting_id).catch((err) => console.error('[משימון] מחיקת Zoom נכשלה:', err.message));
  D.run("UPDATE meetings SET status = 'cancelled', updated_at = ? WHERE id = ?", D.nowIso(), m.id);
  if (m.task_id) {
    const task = D.get('SELECT * FROM tasks WHERE id = ?', m.task_id);
    if (task) {
      D.run("UPDATE tasks SET meeting_pending = 1, status_short = '📅 הפגישה בוטלה — לקביעה מחדש' WHERE id = ?", task.id);
      reopenSecretaryRequest(task);
      D.audit(task.id, fromCalendar ? { type: 'system', id: null, name: 'יומן Google' } : { type: 'user', id: actor.id, name: actor.name },
        'meeting', `הפגישה של ${fmtWhen(m.start_at)} בוטלה${fromCalendar ? ' ביומן' : ''}`);
      if (fromCalendar) returnForApproval(m, task);
    }
  }
  return shape(meetingById(m.id));
}

/** פגישה שבוטלה ביומן חוזרת ל"ממתין לאישורך" של מי שקבע אותה: לקבוע מחדש או לדחות */
function returnForApproval(m, task) {
  const target = m.created_by ?? m.owner_id;
  if (!target) return;
  D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, task_id, created_at)
     VALUES (?, 'meeting_cancelled', 'pending', '', ?, 'יומן Google', '', ?, ?, ?, ?, ?)`,
    target, `meeting:${m.id}`, m.title, D.nowIso(),
    JSON.stringify({ title: m.title, meetingId: m.id, taskId: task.id, start: m.start_at, owner: userById(m.owner_id)?.full_name ?? '' }),
    task.id, D.nowIso()
  );
  D.notify({ targetType: 'user', targetId: target, kind: 'meeting', title: '📅 פגישה בוטלה ביומן', body: `${m.title} — לקבוע מחדש או לדחות?`, taskId: task.id });
}

/** "לדחות" אחרי ביטול: המשימה נסגרת, וההצעה יורדת מהרשימה */
function declineReschedule(actor, suggestionId) {
  const s = D.get("SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ? AND kind = 'meeting_cancelled'", suggestionId, actor.id);
  if (!s) throw new MeetingError('ההצעה לא נמצאה', 404);
  D.run("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE id = ?", D.nowIso(), s.id);
  return s.task_id;
}

/** לקבוע מחדש — ההצעה יורדת מהרשימה כשהפגישה החדשה נקבעה */
function markRescheduled(taskId) {
  D.run("UPDATE ai_suggestions SET status = 'approved', decided_at = ? WHERE kind = 'meeting_cancelled' AND task_id = ? AND status = 'pending'", D.nowIso(), taskId);
}

// ---------------------------------------------------------------------------
// הזזת פגישה אחרת (מהחלופות)
// ---------------------------------------------------------------------------

/**
 * הזזה בפועל — רק פגישה שהמארגן שלה הוא בעל היומן, ורק כשמותר לערוך את
 * היומן שלו. Google שולח עדכון למשתתפים שלה בשם המארגן.
 */
async function moveEvent(actor, { ownerId, eventId, start, end }) {
  if (!(await canWrite(actor, ownerId))) throw new MeetingError('אין לך גישת עריכה ליומן הזה', 403);
  const owner = userById(ownerId);
  const calendarId = ownerId === actor.id ? 'primary' : owner.email;
  const ev = await Gmail.googleCall(actor.id, eventUrl(calendarId, eventId));
  const organizer = String(ev.organizer?.email ?? '').toLowerCase();
  if (!(ev.organizer?.self || organizer === owner.email.toLowerCase())) {
    throw new MeetingError('אפשר להזיז רק פגישה שבעל היומן הוא המארגן שלה');
  }
  const updated = await Gmail.googleCall(actor.id, eventUrl(calendarId, eventId), { sendUpdates: 'all' }, {
    method: 'PATCH', body: { start: { dateTime: new Date(start).toISOString(), timeZone: TZ }, end: { dateTime: new Date(end).toISOString(), timeZone: TZ } }
  });
  // פגישה של משימון שזזה מכאן — מתעדכנת גם אצלנו
  const ours = D.get("SELECT * FROM meetings WHERE google_event_id = ? AND status = 'scheduled'", eventId);
  if (ours) {
    D.run('UPDATE meetings SET start_at = ?, end_at = ?, reminded_at = NULL, etag = ?, updated_at = ? WHERE id = ?',
      new Date(start).toISOString(), new Date(end).toISOString(), updated.etag ?? null, D.nowIso(), ours.id);
    if (ours.zoom_meeting_id) {
      await Zoom.updateMeeting(ours.zoom_meeting_id, { title: ours.title, startIso: new Date(start).toISOString(), minutes: Math.round((new Date(end) - new Date(start)) / MIN) }).catch(() => {});
    }
    if (ours.task_id) afterScheduled(meetingById(ours.id), actor, 'הוזזה');
  }
  return { title: ev.summary ?? '', start, end };
}

/** טקסט מהיומן להודעה: שורה אחת, קצר, בלי סימני עיצוב של וואטסאפ */
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e*_~`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'פגישה';

const validDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

// עד 10 בקשות הזזה לשעה מכל משתמש — כדי שהבוט לא יהפוך לערוץ הצפה
const MOVE_LIMIT = 10;
const moveSent = new Map(); // actorId → [timestamps]
function moveRateOk(actorId) {
  const recent = (moveSent.get(actorId) ?? []).filter((t) => Date.now() - t < 60 * MIN);
  if (recent.length >= MOVE_LIMIT) return false;
  recent.push(Date.now());
  moveSent.set(actorId, recent);
  return true;
}

/**
 * בקשה מהמארגן להזיז — כשאין גישה ליומן שלו. מגיעה אליו ל"ממתין לאישורך"
 * ובבוט; "אשר" מזיז מהחיבור שלו עצמו.
 *
 * רק על פגישה אמיתית שהמבקש רואה ביומן (שלו, או יומן ששותף עם המזכירה)
 * ושהמארגן שלה הוא הנמען. הכותרת והמועד נקראים מהיומן — לא ממה שהדפדפן שלח.
 */
async function requestMove(actor, { organizerId, eventId, calendarEmail, to }) {
  const organizer = userById(organizerId);
  if (!organizer) throw new MeetingError('המארגן אינו משתמש במשימון — אפשר רק לפנות אליו ישירות');
  if (organizer.id === actor.id) throw new MeetingError('זו פגישה שלך — אפשר להזיז אותה ישירות');
  if (!eventId) throw new MeetingError('לא נבחרה פגישה');
  if (!validDate(to?.start)) throw new MeetingError('המועד החדש אינו תקין');
  const newStart = new Date(to.start);
  if (newStart.getTime() < Date.now()) throw new MeetingError('המועד החדש כבר עבר');
  if (newStart.getTime() > Date.now() + 90 * 24 * 60 * MIN) throw new MeetingError('המועד החדש רחוק מדי');

  // היומן שבו המבקש רואה את הפגישה — שלו, או של עובד ששיתף איתו לקריאה
  const calUser = userByEmail(calendarEmail);
  if (!calUser) throw new MeetingError('היומן אינו של עובד במשימון', 403);
  const level = calUser.id === actor.id ? (Gmail.has(actor.id, 'calendar') ? 'owner' : 'none') : (await accessMap(actor)).get(calUser.id) ?? 'none';
  if (ACCESS_RANK[level] < ACCESS_RANK.read) throw new MeetingError('אין לך גישה ליומן שבו הפגישה הזו', 403);
  let ev;
  try {
    ev = await Gmail.googleCall(actor.id, eventUrl(calUser.id === actor.id ? 'primary' : calUser.email, eventId));
  } catch {
    throw new MeetingError('הפגישה לא נמצאה ביומן', 404);
  }
  if (ev.status === 'cancelled' || !ev.start?.dateTime || !ev.end?.dateTime) throw new MeetingError('הפגישה לא נמצאה ביומן', 404);
  if (String(ev.organizer?.email ?? '').toLowerCase() !== String(organizer.email).toLowerCase()) {
    throw new MeetingError(`${organizer.full_name} אינו/ה המארגן/ת של הפגישה הזו`, 403);
  }
  if (ev.visibility === 'private' || ev.visibility === 'confidential') throw new MeetingError('זו פגישה פרטית — אפשר רק לפנות למארגן ישירות');
  const from = { start: new Date(ev.start.dateTime).toISOString(), end: new Date(ev.end.dateTime).toISOString() };
  // אותו אורך כמו הפגישה המקורית
  const target = { start: newStart.toISOString(), end: new Date(newStart.getTime() + (Date.parse(from.end) - Date.parse(from.start))).toISOString() };
  const title = cleanTitle(ev.summary);

  // אותה בקשה שכבר ממתינה — לא שולחים שוב
  const headerId = `move:${eventId}:${target.start}`;
  if (D.get("SELECT id FROM ai_suggestions WHERE user_id = ? AND kind = 'meeting_move' AND status = 'pending' AND header_id = ?", organizer.id, headerId)) {
    return { requested: true, organizer: organizer.full_name, duplicate: true };
  }
  if (!moveRateOk(actor.id)) throw new MeetingError('נשלחו יותר מדי בקשות הזזה בשעה האחרונה. נסו שוב מאוחר יותר', 429);

  D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
     VALUES (?, 'meeting_move', 'pending', '', ?, ?, ?, ?, ?, ?, ?)`,
    organizer.id, headerId, actor.name, actor.email ?? '', title, D.nowIso(),
    JSON.stringify({ title, eventId, from, to: target, requestedBy: actor.name, requestedById: actor.id }), D.nowIso()
  );
  const text = `${actor.name} מבקש/ת להזיז את "${title}" מ-${fmtWhen(from.start)} ל-${fmtWhen(target.start)}, כדי לפנות זמן לפגישה אחרת.`;
  D.notify({ targetType: 'user', targetId: organizer.id, kind: 'meeting', title: '📅 בקשה להזיז פגישה', body: text });
  // בוואטסאפ — בלי כותרת הפגישה ובלי טקסט חופשי: רק מי ביקש ומתי. הפרטים במשימון
  if (organizer.phone && hooks.botReady()) {
    hooks.sendWhatsApp?.(`${organizer.phone}@c.us`, `📅 ${actor.name} מבקש/ת להזיז פגישה שלך מ-${fmtWhen(from.start)} ל-${fmtWhen(target.start)}. לפרטים ולאישור — "ממתין לאישורך" במשימון.`).catch(() => {});
  }
  return { requested: true, organizer: organizer.full_name };
}

/** הבקשה, והפגישה כפי שהיא עכשיו ביומן של המארגן */
async function loadMove(actor, suggestionId) {
  const s = D.get("SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ? AND kind = 'meeting_move' AND status = 'pending'", suggestionId, actor.id);
  if (!s) throw new MeetingError('הבקשה לא נמצאה או שטופלה', 404);
  if (!Gmail.has(actor.id, 'calendar')) throw new MeetingError('כדי לאשר צריך לחבר את היומן של Google ("החשבון שלי ← חיבור Google")');
  const d = parseJson(s.data, {});
  if (!d.eventId || !validDate(d.to?.start) || !validDate(d.to?.end)) throw new MeetingError('הבקשה פגומה');
  let ev;
  try {
    ev = await Gmail.googleCall(actor.id, eventUrl('primary', d.eventId));
  } catch {
    throw new MeetingError('הפגישה לא נמצאה ביומן שלך', 404);
  }
  if (ev.status === 'cancelled' || !ev.start?.dateTime || !ev.end?.dateTime) throw new MeetingError('הפגישה לא נמצאה ביומן שלך', 404);
  if (!ev.organizer?.self) throw new MeetingError('אינך המארגן/ת של הפגישה הזו', 403);
  return { s, d, ev };
}

/** לפני האישור — הכותרת והמועד האמיתיים מהיומן, לא מה שנשמר בבקשה */
async function previewMove(actor, suggestionId) {
  const { d, ev } = await loadMove(actor, suggestionId);
  return {
    title: String(ev.summary ?? '(ללא כותרת)'),
    from: { start: new Date(ev.start.dateTime).toISOString(), end: new Date(ev.end.dateTime).toISOString() },
    to: d.to,
    requestedBy: d.requestedBy ?? ''
  };
}

/** המארגן אישר — הזזה מהחיבור שלו */
async function approveMove(actor, suggestionId) {
  const { s, d, ev } = await loadMove(actor, suggestionId);
  // הפגישה זזה מאז הבקשה — המועד שבבקשה כבר לא מתאר אותה
  if (d.from?.start && Date.parse(ev.start.dateTime) !== Date.parse(d.from.start)) {
    D.run("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE id = ?", D.nowIso(), s.id);
    throw new MeetingError('הפגישה הוזזה מאז שנשלחה הבקשה — הבקשה בוטלה');
  }
  const r = await moveEvent(actor, { ownerId: actor.id, eventId: d.eventId, start: d.to.start, end: d.to.end });
  D.run("UPDATE ai_suggestions SET status = 'approved', decided_at = ? WHERE id = ?", D.nowIso(), s.id);
  return r;
}

// ---------------------------------------------------------------------------
// לפי משימה, וקישור מארח
// ---------------------------------------------------------------------------

/**
 * ההקלטה של פגישה — לכל מי שרשאי לראות את הפגישה (‎canSee‎ נבדק ב-API).
 * ‎null‎ — אין הקלטה עדיין.
 */
async function recording(id) {
  const m = meetingById(id);
  if (!m?.zoom_meeting_id) throw new MeetingError('אין לפגישה הזו Zoom', 404);
  return Zoom.meetingRecording(m.zoom_meeting_id);
}

const forTask = (taskId) => D.all("SELECT * FROM meetings WHERE task_id = ? ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, start_at DESC", taskId).map(shape);

async function joinLink(actor, id) {
  const m = meetingById(id);
  if (!m?.zoom_meeting_id) throw new MeetingError('אין לפגישה הזו Zoom', 404);
  // קישור מארח טרי — לבעל היומן, למי שקבע, ולהנהלה ולמזכירות; כל השאר — קישור ההצטרפות
  if (actor.id === m.owner_id || actor.id === m.created_by || isZoomManager(actor)) {
    try { return { url: await Zoom.startUrl(m.zoom_meeting_id), host: true }; } catch { /* קישור הצטרפות */ }
  }
  return { url: m.zoom_join_url, host: false };
}

// ---------------------------------------------------------------------------
// סנכרון מול היומן
// ---------------------------------------------------------------------------

/** החיבור שדרכו אפשר לקרוא את האירוע: מי שקבעה, ואם אין — בעל היומן */
function syncRoute(m) {
  const owner = userById(m.owner_id);
  if (m.via_user_id && Gmail.has(m.via_user_id, 'calendar')) {
    return { via: m.via_user_id, calendarId: m.via_user_id === m.owner_id ? 'primary' : owner?.email ?? m.calendar_id };
  }
  if (owner && Gmail.has(owner.id, 'calendar')) return { via: owner.id, calendarId: 'primary' };
  return null;
}

async function syncOne(m) {
  if (!m.google_event_id) return;
  const route = syncRoute(m);
  if (!route) {
    D.run("UPDATE meetings SET sync_error = 'אין גישה ליומן — הסנכרון נעצר' WHERE id = ?", m.id);
    return;
  }
  let ev;
  try {
    ev = await Gmail.googleCall(route.via, eventUrl(route.calendarId, m.google_event_id));
  } catch (err) {
    if ([404, 410].includes(err.status)) return void await cancel(null, m.id, { fromCalendar: true });
    D.run('UPDATE meetings SET sync_error = ? WHERE id = ?', err.status === 403 ? 'אין גישה ליומן — הסנכרון נעצר' : '', m.id);
    return;
  }
  if (ev.status === 'cancelled') return void await cancel(null, m.id, { fromCalendar: true });

  const start = ev.start?.dateTime ? new Date(ev.start.dateTime).toISOString() : m.start_at;
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : m.end_at;
  const known = new Map(parseJson(m.attendees, []).map((a) => [a.email, a]));
  const attendees = (ev.attendees ?? []).filter((a) => !a.organizer && !a.self && !a.resource)
    .map((a) => ({ email: String(a.email).toLowerCase(), name: a.displayName ?? known.get(String(a.email).toLowerCase())?.name ?? '', response: a.responseStatus ?? 'needsAction' }));
  const moved = start !== m.start_at || end !== m.end_at;

  // משתתף מרכזי דחה — המזכירה שקבעה יודעת
  for (const a of attendees) {
    const was = known.get(a.email)?.response;
    if (a.response === 'declined' && was !== 'declined' && m.created_by) {
      D.notify({ targetType: 'user', targetId: m.created_by, kind: 'meeting', title: `📅 ${a.name || a.email} דחה/תה את הפגישה`, body: `${m.title} · ${fmtWhen(start)}`, taskId: m.task_id });
    }
  }
  D.run(
    `UPDATE meetings SET title = ?, start_at = ?, end_at = ?, attendees = ?, etag = ?, sync_error = '', synced_at = ?,
       reminded_at = CASE WHEN ? THEN NULL ELSE reminded_at END, updated_at = ? WHERE id = ?`,
    String(ev.summary ?? m.title), start, end, JSON.stringify(attendees), ev.etag ?? null, D.nowIso(), moved ? 1 : 0, D.nowIso(), m.id
  );
  if (moved) {
    if (m.zoom_meeting_id) {
      await Zoom.updateMeeting(m.zoom_meeting_id, { title: ev.summary ?? m.title, startIso: start, minutes: Math.round((new Date(end) - new Date(start)) / MIN) }).catch(() => {});
    }
    if (m.task_id) afterScheduled(meetingById(m.id), null, 'הוזזה ביומן');
  }
}

/** פגישות שעוד לא נגמרו (ועד יום אחרי) — מול היומן */
async function syncAll() {
  const since = new Date(Date.now() - 24 * 60 * MIN).toISOString();
  for (const m of D.all("SELECT * FROM meetings WHERE status = 'scheduled' AND end_at > ?", since)) {
    try { await syncOne(m); } catch (err) { console.error(`[משימון] סנכרון פגישה ${m.id} נכשל:`, err.message); }
  }
  // שבוע אחרי — "התקיימה", ולא נבדקת יותר
  D.run("UPDATE meetings SET status = 'done' WHERE status = 'scheduled' AND end_at < ?", new Date(Date.now() - 7 * 24 * 60 * MIN).toISOString());
}

// ---------------------------------------------------------------------------
// התראה לפני פגישה
// ---------------------------------------------------------------------------

/**
 * מי מקבל: בעל היומן, מי שקבע, וכל משתתף שהוא משתמש במשימון. מוזמן מחוץ
 * לארגון אינו מקבל הודעה מהבוט — רק את ההזמנה ביומן מ-Google.
 */
function recipientsOf(m) {
  const ids = new Set([m.owner_id, m.created_by].filter(Boolean));
  for (const a of parseJson(m.attendees, [])) {
    if (a.response === 'declined') continue;
    const u = userByEmail(a.email);
    if (u) ids.add(u.id);
  }
  return [...ids].map(userById).filter(Boolean);
}

function reminderText(m) {
  const people = [userById(m.owner_id)?.full_name, ...parseJson(m.attendees, []).map((a) => a.name || a.email)].filter(Boolean).slice(0, 6).join(', ');
  const until = Math.max(1, Math.round((new Date(m.start_at) - Date.now()) / MIN));
  const hhmm = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return [
    `📅 בעוד ${until} דקות: ${m.title}`,
    `${hhmm(m.start_at)}–${hhmm(m.end_at)} · ${people}`,
    m.zoom_join_url ? `🎥 Zoom: ${m.zoom_join_url}` : m.location ? `📍 ${m.location}` : null
  ].filter(Boolean).join('\n');
}

async function sendReminders() {
  const lead = Math.max(1, Number(D.getSetting('meeting_reminder_minutes', 15)));
  const now = Date.now();
  const due = D.all(
    "SELECT * FROM meetings WHERE status = 'scheduled' AND reminded_at IS NULL AND start_at > ? AND start_at <= ?",
    new Date(now).toISOString(), new Date(now + lead * MIN).toISOString()
  );
  for (const row of due) {
    // בדיקה אחרונה מול היומן — פגישה שבוטלה לא שולחת כלום, שהוזזה — לפי המועד החדש
    try { await syncOne(row); } catch { /* לפי מה שידוע */ }
    const m = meetingById(row.id);
    if (m.status !== 'scheduled' || m.reminded_at) continue;
    if (new Date(m.start_at).getTime() > Date.now() + lead * MIN) continue;
    D.run('UPDATE meetings SET reminded_at = ? WHERE id = ?', D.nowIso(), m.id);
    const text = reminderText(m);
    const wa = hooks.botReady() && hooks.botAllowed();
    const sent = new Set();
    for (const u of recipientsOf(m)) {
      D.notify({ targetType: 'user', targetId: u.id, kind: 'meeting', title: text.split('\n')[0], body: text.split('\n').slice(1).join(' · '), taskId: m.task_id });
      if (wa && u.phone && !sent.has(u.phone)) {
        sent.add(u.phone);
        try { await hooks.sendWhatsApp(`${u.phone}@c.us`, text); } catch (err) { console.error('[משימון] התראת פגישה בוואטסאפ נכשלה:', err.message); }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 📅 התראה לפני פגישה מיומן Google — גם כשלא נקבעה ממשימון (הוחלט 09.11.26)
// ---------------------------------------------------------------------------

/*
 * לכל עובד עם יומן מחובר: האירועים של היום (מטמון 5 דקות ב-‎calendar.js‎). אירוע
 * שמתחיל בתוך זמן ההתראה — הודעה בבוט לכל משתתף שהוא משתמש משימון עם טלפון
 * (גם מי שלא חיבר יומן), פעם אחת לכל אחד (‎calendar_reminders‎). פגישה שמשימון
 * קבע — ההתראה הרגילה למעלה. מי שדחה את ההזמנה — לא מקבל. אירוע יום שלם — לא.
 */
const Calendar = require('./calendar');

const RESPONSE = { accepted: '✅', declined: '✕', tentative: '❔', needsAction: '⏳' };

function shortPeople(people, n = 4) {
  const names = people.map((p) => p.name).filter(Boolean);
  return names.length ? `${names.slice(0, n).join(', ')}${names.length > n ? ` ועוד ${names.length - n}` : ''}` : '';
}

/** המשתתפים — בשמות משימון כשיש, אחרת השם מהיומן או הכתובת */
function peopleOf(ev) {
  const all = [...(ev.organizer?.email && !ev.people.some((p) => p.email === ev.organizer.email) ? [{ ...ev.organizer, organizer: true, response: 'accepted' }] : []), ...ev.people];
  return all.map((p) => ({ ...p, name: userByEmail(p.email)?.full_name || p.name || p.email }));
}

function calendarReminderText(ev, people) {
  const until = Math.max(1, Math.round((new Date(ev.start) - Date.now()) / MIN));
  const hhmm = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const where = ev.zoomLink ? `🎥 Zoom: ${ev.zoomLink}`
    : ev.meetLink ? `🎥 Meet: ${ev.meetLink}`
      : ev.location ? `📍 ${ev.location}` : null;
  const going = people.filter((p) => p.response !== 'declined');
  return [
    `📅 בעוד ${until} דקות: *${ev.title}*`,
    `🕐 ${hhmm(ev.start)}–${hhmm(ev.end)}`,
    where,
    going.length ? `👥 ${going.length} משתתפים${shortPeople(going) ? `: ${shortPeople(going)}` : ''}` : null
  ].filter(Boolean).join('\n');
}

async function sendCalendarReminders() {
  if (!hooks.botReady() || !hooks.botAllowed()) return;
  const lead = Math.max(1, Number(D.getSetting('meeting_reminder_minutes', 15)));
  const now = Date.now();
  D.run('DELETE FROM calendar_reminders WHERE sent_at < ?', new Date(now - 2 * 24 * 60 * MIN).toISOString());
  const users = D.all("SELECT id FROM users WHERE status = 'active' AND role <> 'vendor'").map((r) => r.id).filter((id) => Calendar.isConnected(id));
  for (const userId of users) {
    let day;
    try { day = await Calendar.eventsForDay(userId); } catch { continue; }
    for (const ev of day.events ?? []) {
      if (ev.allDay || ev.mesimon || !ev.start) continue;
      const at = new Date(ev.start).getTime();
      if (!(at > now && at <= now + lead * MIN)) continue;
      // פגישה שמשימון קבע (גם בלי הסימון ביומן) — יש לה התראה משלה
      if (D.get("SELECT 1 FROM meetings WHERE google_event_id = ? AND status = 'scheduled'", ev.id)) continue;
      // סטטוס ("במשרד", "יום ארוך", "פנוי", מיקום עבודה) — לא מתריעים לאף אחד; תזכורת אישית — לבעליה, לא למזכירות
      if (Calendar.isStatus(ev)) continue;
      const people = peopleOf(ev);
      const owner = userById(userId);
      const targets = new Map();
      // 📅 מזכירות — רק פגישות אמיתיות: לא "במשרד", "יום ארוך" או תזכורות אישיות של העובדים שהיומנים שלהם אצלן
      const ownerGets = owner?.phone && (!Secretariat.isSecretary(owner.id) || Calendar.isRealMeeting(ev, owner.email));
      if (ownerGets) targets.set(owner.id, owner);
      for (const p of people) {
        if (p.response === 'declined') continue;
        const u = userByEmail(p.email);
        if (u?.phone) targets.set(u.id, u);
      }
      const text = calendarReminderText(ev, people);
      const data = JSON.stringify({ title: ev.title, start: ev.start, end: ev.end, zoom: ev.zoomLink, meet: ev.meetLink, location: ev.location, people });
      for (const u of targets.values()) {
        // מי שדחה בעצמו — לא; אחד לכל משתתף, גם כשהאירוע מופיע בכמה יומנים
        if (people.find((p) => p.email === String(u.email ?? '').toLowerCase())?.response === 'declined') continue;
        const fresh = D.run('INSERT OR IGNORE INTO calendar_reminders (uid, start_at, user_id, data, sent_at) VALUES (?,?,?,?,?)', ev.uid, ev.start, u.id, data, D.nowIso()).changes;
        if (!fresh) continue;
        try {
          await (hooks.sendButtons ?? ((c, t) => hooks.sendWhatsApp(c, t)))(`${u.phone}@c.us`, text, ['👥 מי משתתף?']);
        } catch (err) {
          console.error('[משימון] התראת פגישה מהיומן בוואטסאפ נכשלה:', err.message);
        }
      }
    }
  }
}

const PARTICIPANTS_Q = /^(?:מי\s+(?:משתתף|משתתפת|משתתפים|מוזמן|מוזמנים|מגיע|מגיעים|יהיה|יהיו|בפגישה)|משתתפים|מוזמנים)(?=[\s?!.,]|$)/;

/**
 * "מי משתתף?" בבוט — הפגישה שעליה הגיעה ההתראה האחרונה (3 שעות אחורה), ואם אין —
 * מהיומן של היום: זו שהשם שלה בהודעה, או זו שמתקיימת עכשיו / הבאה.
 * ‎null‎ — ההודעה אינה שאלה כזו.
 */
async function participantsAnswer(userId, text) {
  const t = String(text ?? '').replace(/[👥]/gu, '').trim();
  if (!PARTICIPANTS_Q.test(t) || t.length > 120) return null;
  const words = t.replace(PARTICIPANTS_Q, ' ').replace(/[?!.,]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['בפגישה', 'בפגישת', 'הפגישה', 'עם', 'של', 'היום', 'הבאה'].includes(w));
  let meeting = null;
  if (Calendar.isConnected(userId)) {
    const day = await Calendar.eventsForDay(userId).catch(() => ({ events: [] }));
    const timed = (day.events ?? []).filter((e) => !e.allDay && !e.mesimon);
    const byName = words.length ? timed.find((e) => words.some((w) => e.title.includes(w))) : null;
    const now = Date.now();
    const current = timed.find((e) => new Date(e.start).getTime() - 20 * MIN <= now && new Date(e.end).getTime() > now)
      ?? timed.find((e) => new Date(e.start).getTime() > now);
    const ev = byName ?? (words.length ? null : current);
    if (ev) meeting = { title: ev.title, start: ev.start, people: peopleOf(ev) };
  }
  if (!meeting && !words.length) {
    const last = D.get('SELECT data FROM calendar_reminders WHERE user_id = ? AND sent_at > ? ORDER BY sent_at DESC LIMIT 1', userId, new Date(Date.now() - 3 * 60 * MIN).toISOString());
    if (last) meeting = parseJson(last.data, null);
  }
  if (!meeting) return words.length ? `לא מצאתי היום פגישה בשם "${words.join(' ')}" ביומן.` : 'לא מצאתי פגישה קרובה ביומן שלך היום.';
  const hhmm = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(meeting.start));
  const list = (meeting.people ?? []).map((p) => `${RESPONSE[p.response] ?? '⏳'} ${p.name}${p.organizer ? ' (מארגן/ת)' : ''}`);
  return [
    `👥 *${meeting.title}* · ${hhmm}`,
    list.length ? list.join('\n') : 'אין משתתפים ברשימה — רק את/ה.',
    list.length ? '\n✅ אישר/ה · ⏳ לא ענה/תה · ❔ אולי · ✕ דחה/תה' : null
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// מתזמן
// ---------------------------------------------------------------------------

let timer = null;
let running = false;
let lastSync = 0;

async function tick() {
  if (running) return;
  running = true;
  try {
    await sendReminders();
    await sendCalendarReminders().catch((err) => console.error('[משימון] התראות מהיומן נכשלו:', err.message));
    if (Date.now() - lastSync > 5 * MIN) {
      lastSync = Date.now();
      await syncAll();
    }
  } finally {
    running = false;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => console.error('[משימון] מתזמן הפגישות נכשל:', err.message)), MIN);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 30000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  init, MeetingError, isSecretary, isZoomManager, canChooseZoomHost, ownZoomUser, accessMap, accessError, forgetAccess, calendarsFor, resolveCalendar, canWrite,
  freeBusy, availability, suggest, alternatives, create, update, cancel, declineReschedule, markRescheduled,
  moveEvent, requestMove, previewMove, approveMove, forTask, joinLink, recording, shape, meetingById, syncOne, syncAll, sendReminders,
  recipientsOf, reminderText, sendCalendarReminders, participantsAnswer, start, stop, tick,
  _internal: { splitPeople, cleanAttendees, eventBody, shapeEvent, ruleScore, rank, meetingHours }
};
