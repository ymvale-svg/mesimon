'use strict';
/**
 * ימי עבודה ותאריכים בשעון ישראל.
 *
 * כל מה שמחשב "מחר" עובר כאן — ברירת המחדל של משימה מהקלטה, "📅 מחר" ב-Today,
 * ומייל הבוקר — כדי שלא יהיו שלושה חישובים שמתפצלים.
 *
 * ימי השבוע נספרים כמו ב-JavaScript: 0 = ראשון … 6 = שבת.
 *   • ברירת המחדל: א׳–ה׳.
 *   • מחלקה יכולה לקבוע אחרת (‎departments.work_days‎) — למשל הנדסה א׳–ו׳.
 *   • עובד שטח (‎users.field_worker‎) עובד גם בשישי, מעבר למחלקה שלו.
 *   • שבת אינה יום עבודה לעולם — היא מוסרת כאן בקוד ולא רק בממשק.
 *
 * תאריך הוא מחרוזת ‎YYYY-MM-DD‎ בשעון ישראל. השרת בענן רץ ב-UTC, ולכן אסור
 * לקחת את היום מ-‎new Date().getDay()‎.
 */
const D = require('./db');

const TZ = 'Asia/Jerusalem';
const SATURDAY = 6;
const FRIDAY = 5;
const DEFAULT_DAYS = [0, 1, 2, 3, 4];
const DAY_LABELS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

/** חלקי השעון בישראל לרגע נתון */
function ilParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    minutes: Number(p.hour) * 60 + Number(p.minute)
  };
}

const todayIL = () => ilParts().date;

/** התאריך בישראל של רגע שמור (‎due_date‎ נשמר כ-ISO ב-UTC) */
const ilDateOf = (iso) => (iso ? ilParts(new Date(iso)).date : null);

/** היום בשבוע של תאריך — בלי תלות באזור הזמן של השרת */
const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * הרגע ב-UTC של שעה בשעון ישראל. ההפרש מ-UTC הוא 2 או 3 שעות לפי שעון
 * הקיץ, ולכן הוא נמדד בפועל לאותו יום ולא נכתב כקבוע.
 */
function ilWallToUtc(dateStr, hour = 17, minute = 0) {
  const guess = Date.UTC(...dateStr.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)), hour, minute);
  const seen = ilParts(new Date(guess));
  const seenUtc = Date.UTC(...seen.date.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)), seen.hour, seen.minute);
  return new Date(guess - (seenUtc - guess));
}

/** יעד של משימה: 17:00 בשעון ישראל — כמו בדיאלוג "משימה חדשה" */
const dueIso = (dateStr) => ilWallToUtc(dateStr, 17, 0).toISOString();

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

/** רשימת ימים ממחרוזת שמורה. ערך לא תקין = ברירת המחדל, ושבת תמיד בחוץ */
function parseDays(value) {
  const days = String(value ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-6]$/.test(s)).map(Number);
  const clean = [...new Set(days)].filter((d) => d !== SATURDAY).sort();
  return clean.length ? clean : [...DEFAULT_DAYS];
}

/** ימים לשמירה — מחרוזת, בלי שבת. רשימה ריקה = ברירת המחדל */
function serializeDays(days) {
  const clean = [...new Set((Array.isArray(days) ? days : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 5).sort();
  return clean.length ? clean.join(',') : '';
}

/** ימי העבודה של עובד: המחלקה, ועובד שטח מוסיף שישי */
function workDaysOf(userId) {
  const row = D.get(
    `SELECT u.field_worker, d.work_days FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`,
    userId
  );
  const days = new Set(parseDays(row?.work_days));
  if (row?.field_worker) days.add(FRIDAY);
  days.delete(SATURDAY);
  return [...days].sort();
}

const isWorkDay = (userId, dateStr) => workDaysOf(userId).includes(weekdayOf(dateStr));

/** יום העבודה הבא אחרי התאריך — "מחר" במובן של העובד */
function nextWorkDay(userId, fromDate = todayIL()) {
  const days = new Set(workDaysOf(userId));
  let d = fromDate;
  for (let i = 0; i < 14; i++) {
    d = addDays(d, 1);
    if (days.has(weekdayOf(d))) return d;
  }
  return addDays(fromDate, 1);
}

/** ‎n‎ ימי עבודה קדימה */
function addWorkDays(userId, fromDate, n) {
  let d = fromDate;
  for (let i = 0; i < Math.max(1, n); i++) d = nextWorkDay(userId, d);
  return d;
}

const daysLabel = (days) => {
  const list = [...days].sort();
  // רצף רציף מוצג כטווח — "א׳–ה׳" ולא "א׳, ב׳, ג׳, ד׳, ה׳"
  const contiguous = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  if (contiguous && list.length > 2) return `${DAY_LABELS[list[0]]}–${DAY_LABELS[list[list.length - 1]]}`;
  return list.map((d) => DAY_LABELS[d]).join(', ');
};

/** "יום חמישי, 29.10" */
function hebrewDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `יום ${DAY_NAMES[weekdayOf(dateStr)]}, ${Number(d)}.${Number(m)}`;
}

module.exports = {
  TZ, DEFAULT_DAYS, DAY_LABELS, DAY_NAMES, SATURDAY, FRIDAY,
  ilParts, todayIL, ilDateOf, weekdayOf, addDays, ilWallToUtc, dueIso, isDate,
  parseDays, serializeDays, workDaysOf, isWorkDay, nextWorkDay, addWorkDays, daysLabel, hebrewDate
};
