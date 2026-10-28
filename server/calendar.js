'use strict';
/**
 * היומן של Google — האירועים של היום, למסך Today ולמייל הבוקר.
 *
 * על אותו חיבור Google של התיבה (‎gmail.js‎), עם ההרשאה ‎calendar.events‎.
 * ההרשאה כוללת כתיבה, כדי שפיצ'ר עתידי שכותב ליומן לא יחייב חיבור מחדש —
 * אבל כאן רק קוראים. שום דבר מהיומן אינו נשמר במסד: מטמון קצר בזיכרון בלבד.
 *
 * אילו יומנים: הראשי, ומה שהמשתמש סימן בהגדרות (‎user_prefs.todayCalendars‎).
 */
const D = require('./db');
const Gmail = require('./gmail');
const W = require('./workdays');

const API = 'https://www.googleapis.com/calendar/v3';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // `${userId}:${date}` → { at, value }

const isConnected = (userId) => Gmail.has(userId, 'calendar');

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
    meetLink: safeLink(e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri),
    link: safeLink(e.htmlLink),
    declined: self?.responseStatus === 'declined',
    // נוצר על ידי משימון — מסומן לפיצ'רים שכותבים ליומן
    mesimon: Boolean(e.extendedProperties?.private?.mesimon)
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
  for (const id of selectedCalendars(userId)) {
    try {
      const data = await Gmail.googleCall(userId, `${API}/calendars/${encodeURIComponent(id)}/events`, {
        timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 100, timeZone: W.TZ
      });
      const calendar = { id, primary: id === 'primary', name: names[id] ?? '' };
      for (const e of data.items ?? []) {
        if (e.status === 'cancelled') continue;
        const ev = shapeEvent(e, calendar);
        if (!ev.declined) events.push(ev);
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

module.exports = { isConnected, eventsForDay, listCalendars, selectedCalendars, forget };
