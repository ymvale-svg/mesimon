'use strict';
/**
 * היומן של Google — האירועים של היום, למסך Today ולמייל הבוקר.
 *
 * על אותו חיבור Google של התיבה (‎gmail.js‎), עם ההרשאה ‎calendar.events‎.
 * ההרשאה כוללת כתיבה, כדי שפיצ'ר עתידי שכותב ליומן לא יחייב חיבור מחדש —
 * אבל כאן רק קוראים. שום דבר מהיומן אינו נשמר במסד: מטמון קצר בזיכרון בלבד.
 *
 * אילו יומנים: הראשי, ומה שהמשתמש סימן בהגדרות (‎user_prefs.todayCalendars‎) —
 * בחשבון הראשי. מכל חשבון Google נוסף של העובד — היומן הראשי שלו. אותה פגישה
 * בשני החשבונות (הזמנה לשתי הכתובות) — מוצגת פעם אחת.
 */
const D = require('../core').Db;
const Secretariat = require('../core').Secretariat;
const Gmail = require('../integrations').Gmail;
const W = require('../core').Workdays;

const API = 'https://www.googleapis.com/calendar/v3';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // `${userId}:${date}` → { at, value }

/** יש לו יומן בלפחות אחת מהתיבות */
const isConnected = (userId) => Gmail.boxesOf(userId, 'calendar').length > 0;

/** היומנים שנבחרו ל-Today. ברירת מחדל — הראשי בלבד */
function selectedCalendars(userId) {
  const list = D.userPrefs(userId).todayCalendars;
  return Array.isArray(list) && list.length ? list.map(String).slice(0, 10) : ['primary'];
}

/*
 * קישור מאירוע ביומן — רק https. אירוע יכול להגיע מהזמנה של כל אדם בעולם,
 * וקישור ‎javascript:‎ בתוכו היה רץ בלחיצה בתוך משימון.
 */
const safeLink = (url) => (/^https:\/\//i.test(String(url ?? '')) ? String(url) : null);

/*
 * קישור לפגישה מקוונת — רק לדומיין של ספק מוכר (בדיקת host מדויקת). הבוט שולח את הקישור בוואטסאפ,
 * ואירוע מהזמנה חיצונית יכול להכיל ‎https://secure-zoom.us/…‎ או ‎https://evil.example/zoom.us/…‎.
 */
const VIDEO_HOSTS = ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'webex.com'];
function videoLink(url, hosts = VIDEO_HOSTS) {
  const link = safeLink(url);
  if (!link) return null;
  let host;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? link : null;
}

/** קישור Zoom מהאירוע — מתוסף ה-Zoom (‎conferenceData‎), מהמיקום או מהתיאור */
function zoomOf(e) {
  const fromConf = (e.conferenceData?.entryPoints ?? []).find((p) => p.entryPointType === 'video' && videoLink(p.uri, ['zoom.us']))?.uri;
  const inText = [...`${e.location ?? ''} ${e.description ?? ''}`.matchAll(/https:\/\/[\w.-]*zoom\.us\/[^\s<>"')]+/gi)]
    .map((m) => m[0]).find((u) => videoLink(u, ['zoom.us']));
  return videoLink(fromConf || inText, ['zoom.us']);
}

function shapeEvent(e, calendar) {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  const self = (e.attendees ?? []).find((a) => a.self);
  return {
    id: e.id,
    calendarId: calendar.id,
    calendarName: calendar.primary ? null : calendar.name,
    title: String(e.summary ?? '').trim() || '(ללא כותרת)',
    start: allDay ? e.start.date : e.start?.dateTime,
    end: allDay ? e.end?.date : e.end?.dateTime,
    allDay,
    location: String(e.location ?? ''),
    meetLink: videoLink(e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri),
    zoomLink: zoomOf(e),
    // מי משתתף — לשאלה "מי בפגישה?" בבוט. מארגן מסומן; חדרים ומשאבים — לא
    people: (e.attendees ?? []).filter((a) => !a.resource && a.email).map((a) => ({
      email: String(a.email).toLowerCase(), name: String(a.displayName ?? ''), response: a.responseStatus ?? 'needsAction', organizer: Boolean(a.organizer)
    })),
    organizer: { email: String(e.organizer?.email ?? '').toLowerCase(), name: String(e.organizer?.displayName ?? '') },
    link: safeLink(e.htmlLink),
    declined: self?.responseStatus === 'declined',
    // המשתתפים (ומארגן הפגישה) — משימה מהפגישה מוצעת רק להם
    participants: [...new Set([e.organizer?.email, ...(e.attendees ?? []).filter((a) => !a.resource).map((a) => a.email)]
      .map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => x.includes('@')))],
    // נוצר על ידי משימון — מסומן לפיצ'רים שכותבים ליומן
    mesimon: Boolean(e.extendedProperties?.private?.mesimon),
    // סוג האירוע ב-Google (‎workingLocation‎ / ‎outOfOffice‎ / ‎focusTime‎ — סטטוס, לא פגישה), ו"פנוי" (‎transparent‎)
    eventType: String(e.eventType ?? 'default'),
    transparent: e.transparency === 'transparent',
    uid: e.iCalUID ?? e.id
  };
}

/**
 * אירועי היום, ממוינים: אירועי יום שלם קודם, ואחריהם לפי שעה. אירוע שדחיתי
 * או שבוטל אינו מוצג — הוא לא חלק מהיום שלי.
 *
 * @returns {{connected: boolean, events: Array, error?: string}}
 */
async function eventsForDay(userId, dateStr = W.todayIL(), { fresh = false } = {}) {
  if (!isConnected(userId)) return { connected: false, events: [] };
  const key = `${userId}:${dateStr}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const timeMin = W.ilWallToUtc(dateStr, 0, 0).toISOString();
  const timeMax = W.ilWallToUtc(W.addDays(dateStr, 1), 0, 0).toISOString();
  const names = await calendarNames(userId).catch(() => ({}));

  const events = [];
  const errors = [];
  // היומנים שנבחרו בחשבון הראשי, והיומן הראשי של כל חשבון נוסף
  const sources = [
    ...(Gmail.has(userId, 'calendar') ? selectedCalendars(userId).map((id) => ({ who: userId, id, label: null })) : []),
    ...Gmail.boxesOf(userId, 'calendar').filter((who) => Gmail.boxOf(who))
      .map((who) => ({ who, id: 'primary', label: Gmail.connectionOf(who)?.email ?? '' }))
  ];
  const seen = new Set();
  for (const { who, id, label } of sources) {
    try {
      const data = await Gmail.googleCall(who, `${API}/calendars/${encodeURIComponent(id)}/events`, {
        timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 100, timeZone: W.TZ
      });
      const calendar = label ? { id, primary: false, name: label } : { id, primary: id === 'primary', name: names[id] ?? '' };
      for (const e of data.items ?? []) {
        if (e.status === 'cancelled') continue;
        const ev = shapeEvent(e, calendar);
        if (ev.declined || seen.has(`${ev.uid}|${ev.start}`)) continue;
        seen.add(`${ev.uid}|${ev.start}`);
        events.push(ev);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  events.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return String(a.start).localeCompare(String(b.start));
  });
  const value = { connected: true, events, ...(errors.length && !events.length ? { error: 'היומן אינו זמין כרגע' } : {}) };
  // תקלה אינה נשמרת במטמון — הניסיון הבא ינסה שוב
  if (!errors.length) cache.set(key, { at: Date.now(), value });
  return value;
}

/** רשימת היומנים של המשתמש — לבחירה בהגדרות */
async function listCalendars(userId) {
  if (!Gmail.has(userId, 'calendarList')) return [];
  const data = await Gmail.googleCall(userId, `${API}/users/me/calendarList`, { maxResults: 100 });
  const chosen = new Set(selectedCalendars(userId));
  return (data.items ?? []).map((c) => ({
    id: c.primary ? 'primary' : c.id,
    name: c.summaryOverride || c.summary || c.id,
    primary: Boolean(c.primary),
    color: c.backgroundColor ?? null,
    selected: chosen.has(c.primary ? 'primary' : c.id)
  }));
}

const namesCache = new Map();
async function calendarNames(userId) {
  const hit = namesCache.get(userId);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.value;
  const value = Object.fromEntries((await listCalendars(userId)).map((c) => [c.id, c.name]));
  namesCache.set(userId, { at: Date.now(), value });
  return value;
}

function forget(userId) {
  for (const key of cache.keys()) if (key.startsWith(`${userId}:`)) cache.delete(key);
  namesCache.delete(userId);
}

/*
 * 📅 פגישה אמיתית — לא סטטוס ולא תזכורת אישית (הוחלט 10.11.26, ישראל: "למזכירות — רק פגישות, לא סטטוסים של
 * עובדים: במשרד כל היום, יום ארוך, תזכורות אישיות שלהם ביומן"):
 *   • לא יום שלם, לא נדחה, לא מסומן "פנוי";
 *   • לא סטטוס של Google (מיקום עבודה, מחוץ למשרד, זמן מיקוד);
 *   • לא כותרת של סטטוס ("במשרד", "עבודה מהבית", "יום ארוך", "חופש", "מחלה", "מילואים", "OOO"…);
 *   • ויש בה עוד מישהו (משתתף נוסף) או קישור לשיחה (Zoom / Meet). אירוע בלי אף אחד מהם — תזכורת אישית.
 */
const STATUS_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime', 'birthday']);
const STATUS_TITLE = /^\s*(?:ב?משרד|ב?בית|מהבית|עבודה\s+מה?בית|עובד(?:ת)?\s+מה?בית|יום\s+(?:ארוך|קצר|חופש|מחלה)|חופש(?:ה)?|מחלה|מילואים|לא\s+זמי(?:ן|נה)|לא\s+במשרד|בחוץ|ooo|out\s+of\s+office|wfh|office|home|vacation|sick)(?:\s|$|[-–—:,.!(])|כל\s+היום/i;
/** סטטוס ולא אירוע: יום שלם, "פנוי", סוג סטטוס של Google, או כותרת של סטטוס — לא מתריעים עליו לאף אחד */
const isStatus = (ev) => Boolean(ev) && (ev.allDay || ev.transparent || STATUS_TYPES.has(ev.eventType) || STATUS_TITLE.test(String(ev.title ?? '')));

/**
 * ב"היום" בבוט: מה מוצג ביומן. יום שלם — כן (דיון בבית משפט, יום עיון), אלא אם הוא סטטוס ("משרד", "חופש");
 * אירוע עם שעה שמסומן "פנוי" — סטטוס (ביום שלם "פנוי" היא ברירת המחדל של Google, ולא אומרת כלום)
 */
const isDayStatus = (ev) => Boolean(ev) && (STATUS_TYPES.has(ev.eventType) || STATUS_TITLE.test(String(ev.title ?? '')) || (!ev.allDay && ev.transparent));

function isRealMeeting(ev, ownerEmail = '') {
  if (!ev || ev.declined || isStatus(ev)) return false;
  const me = String(ownerEmail ?? '').toLowerCase();
  // המזכירה שקבעה / הוזמנה — לא משתתפת (10.11.26): אירוע שרק היא בו — תזכורת אישית, לא פגישה
  const { withoutSecretaries } = Secretariat;
  const people = withoutSecretaries(ev.people ?? []);
  const others = people.filter((p) => p.email && p.email !== me && p.email !== String(ev.organizer?.email ?? '').toLowerCase());
  return others.length > 0 || people.length > 1 || Boolean(ev.zoomLink || ev.meetLink);
}

/** האירוע הוא של העובד עצמו: ביומן הראשי שלו, או שהוא משתתף / מארגן (ולא רק יומן של מישהו אחר שהוא עוקב אחריו) */
function isOwnEvent(ev, ownerEmail = '') {
  const me = String(ownerEmail ?? '').toLowerCase();
  return !ev.calendarName || (Boolean(me) && (ev.organizer?.email === me || (ev.people ?? []).some((p) => p.email === me)));
}

module.exports = { videoLink, isConnected, eventsForDay, listCalendars, selectedCalendars, forget, isRealMeeting, isOwnEvent, isStatus, isDayStatus, _internal: { shapeEvent } };
