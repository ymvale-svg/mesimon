'use strict';
/**
 * הטווח של "תובנות" — מאיזה רגע בודקים. משמש את התובנות בבוט, בעוזר
 * באפליקציה, ב-Today ובמייל הבוקר, כדי שכולם יחשבו אותו טווח באותה דרך.
 *
 * שני סוגי בקשות:
 *   • בשעות — "48 שעות": שעון רגיל אחורה מעכשיו. רק בכפולות של 24: מספר כמו
 *     30 מעוגל למעלה ל-48, והתשובה אומרת את זה (‎note‎).
 *   • בימים — "מהיומיים האחרונים", "מאתמול": ימי עבודה של העובד אחורה, בלי
 *     היום. הטווח מתחיל ב-00:00 של יום העבודה המוקדם וממשיך עד עכשיו — כולל
 *     שישי, שבת והיום עד עכשיו.
 *
 * ברירת המחדל: 24 שעות. ביום העבודה הראשון אחרי סוף שבוע — מאז תחילת יום
 * העבודה הקודם, אחרת ביום ראשון בבוקר היה נראה שאין כלום מחמישי.
 *
 * התאריכים מחושבים כאן, בקוד — ה-AI רק מחזיר יחידה ומספר.
 * החלק החישובי אינו נוגע במסד הנתונים (‎windowOf‎, ‎defaultSpec‎, ‎parseRange‎)
 * ומקבל את ימי העבודה כרשימה, כדי שאפשר יהיה לבדוק אותו בלי שרת.
 */
const W = require('../core').Workdays;

const DAY_HOURS = 24;
const MAX_HOURS = 168;
const MAX_WORKDAYS = 7;

const DEFAULT = Object.freeze({ unit: 'hours', n: DAY_HOURS });

/** "יום עבודה אחד" / "2 ימי עבודה" */
const workdaysLabel = (n) => (n === 1 ? 'יום עבודה אחד' : `${n} ימי עבודה`);

/** "יום רביעי 28.10" */
function dayLabel(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `יום ${W.DAY_NAMES[W.weekdayOf(dateStr)]} ${Number(d)}.${Number(m)}`;
}

/**
 * בקשה ← בקשה תקינה: שעות בכפולות של 24 (מעוגל למעלה), עד 168; ימי עבודה
 * 1–7. מה שהשתנה נאמר ב-‎note‎, כדי שהמשתמש ידע מה נבדק בפועל.
 */
function normalize(spec) {
  const unit = spec?.unit === 'workdays' ? 'workdays' : 'hours';
  const asked = Math.floor(Number(spec?.n) || 0);
  const notes = [];
  let n;
  if (unit === 'hours') {
    n = Math.max(DAY_HOURS, Math.ceil(Math.max(asked, 1) / DAY_HOURS) * DAY_HOURS);
    if (n > MAX_HOURS) {
      n = MAX_HOURS;
      notes.push(`אפשר עד ${MAX_HOURS} שעות — בדקתי ${MAX_HOURS}.`);
    } else if (asked > 0 && n !== asked) {
      notes.push(`התובנות לפי כפולות של 24 שעות — עיגלתי ל-${n}.`);
    }
  } else {
    n = Math.max(1, asked || 1);
    if (n > MAX_WORKDAYS) {
      n = MAX_WORKDAYS;
      notes.push(`אפשר עד ${MAX_WORKDAYS} ימי עבודה — בדקתי ${MAX_WORKDAYS}.`);
    }
  }
  return { unit, n, note: notes.join(' '), auto: Boolean(spec?.auto) };
}

/** ‎n‎ ימי עבודה אחורה מ-‎today‎, בלי ‎today‎ עצמו */
function workdaysBack(workDays, today, n) {
  const days = new Set(workDays?.length ? workDays : W.DEFAULT_DAYS);
  let d = today;
  let count = 0;
  // 7 ימי עבודה של מי שעובד יום אחד בשבוע — עד 7 שבועות אחורה
  for (let i = 0; i < 60; i++) {
    d = W.addDays(d, -1);
    if (days.has(W.weekdayOf(d)) && ++count === n) return d;
  }
  return W.addDays(today, -n);
}

/**
 * ברירת המחדל לרגע נתון: ביום עבודה שהיום שלפניו אינו יום עבודה — "מאז יום
 * העבודה הקודם" (יום עבודה אחד אחורה). אחרת 24 שעות.
 */
function defaultSpec(workDays, now = new Date()) {
  const days = new Set(workDays?.length ? workDays : W.DEFAULT_DAYS);
  const today = W.ilParts(now).date;
  const afterBreak = days.has(W.weekdayOf(today)) && !days.has(W.weekdayOf(W.addDays(today, -1)));
  return afterBreak ? { unit: 'workdays', n: 1, auto: true } : { ...DEFAULT, auto: true };
}

/**
 * הטווח עצמו. ‎label‎ — מה נבדק, לכותרת; ‎span‎ — היחידה, לסוגריים שאחריה.
 *
 * @returns {{unit, n, auto, since: Date, sinceIso: string, hours: number, startDay: string|null, label: string, span: string, note: string}}
 */
function windowOf(workDays, spec = DEFAULT, now = new Date()) {
  const s = normalize(spec);
  if (s.unit === 'hours') {
    const since = new Date(now.getTime() - s.n * 3600e3);
    return {
      ...s, since, sinceIso: since.toISOString(), hours: s.n, startDay: null,
      label: `${s.n} שעות`, span: `${s.n} שעות`
    };
  }
  const today = W.ilParts(now).date;
  const startDay = workdaysBack(workDays, today, s.n);
  const since = W.ilWallToUtc(startDay, 0, 0);
  return {
    ...s, since, sinceIso: since.toISOString(), startDay,
    hours: Math.round((now.getTime() - since.getTime()) / 3600e3),
    label: `מ${dayLabel(startDay)} עד עכשיו`,
    span: s.auto ? 'מאז יום העבודה הקודם' : workdaysLabel(s.n)
  };
}

// ---------------------------------------------------------------------------
// הבנת הבקשה בלי AI — גיבוי, וגם מה שה-AI לא החזיר
// ---------------------------------------------------------------------------

const NUMBER_WORDS = {
  אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, שלושת: 3,
  ארבעה: 4, ארבע: 4, ארבעת: 4, חמישה: 5, חמש: 5, חמשת: 5, שישה: 6, שש: 6, ששת: 6, שבעה: 7, שבע: 7, שבעת: 7
};
const WORD = Object.keys(NUMBER_WORDS).join('|');
// אין ‎\b‎ לעברית ב-JavaScript — גבול מילה הוא תחילת הטקסט, רווח או אות שימוש
const B = '(?:^|[\\s,.("\'״׳-]|[מהלבו])';

/**
 * "48 שעות" / "מהיומיים האחרונים" / "מאתמול" / "משלושת הימים האחרונים".
 * @returns {{unit: 'hours'|'workdays', n: number}|null}  ‎null‎ — לא נאמר טווח
 */
function parseRange(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let m = /(\d{1,4})\s*(?:שעות|שעה|ש['׳]|h\b)/i.exec(t);
  if (m) return { unit: 'hours', n: Number(m[1]) };
  if (new RegExp(`${B}יממתיים`).test(t)) return { unit: 'hours', n: 48 };
  if (new RegExp(`${B}יממה`).test(t)) return { unit: 'hours', n: 24 };
  m = /(\d{1,2})\s*(?:ימי עבודה|ימים|יום)/.exec(t);
  if (m) return { unit: 'workdays', n: Number(m[1]) };
  m = new RegExp(`${B}(${WORD})\\s+(?:ה)?(?:ימים|ימי)`).exec(t);
  if (m) return { unit: 'workdays', n: NUMBER_WORDS[m[1]] };
  if (new RegExp(`${B}יומיים`).test(t)) return { unit: 'workdays', n: 2 };
  if (new RegExp(`${B}שלשום`).test(t)) return { unit: 'workdays', n: 2 };
  if (new RegExp(`${B}אתמול`).test(t)) return { unit: 'workdays', n: 1 };
  if (new RegExp(`${B}(?:השבוע|שבוע)`).test(t)) return { unit: 'hours', n: MAX_HOURS };
  return null;
}

/** מה שה-AI החזיר (‎insight_range_unit‎, ‎insight_range_n‎), ואם לא — מהטקסט */
function specFrom({ unit, n } = {}, text = '') {
  if (['hours', 'workdays'].includes(unit) && Number(n) > 0) return { unit, n: Number(n) };
  return parseRange(text);
}

// ---------------------------------------------------------------------------
// לעובד מסוים
// ---------------------------------------------------------------------------

/** הטווח לעובד: מה שביקש, ואם לא ביקש — ברירת המחדל של היום */
function forUser(userId, spec = null, now = new Date()) {
  const days = W.workDaysOf(userId);
  return windowOf(days, spec ?? defaultSpec(days, now), now);
}

module.exports = {
  DAY_HOURS, MAX_HOURS, MAX_WORKDAYS, DEFAULT,
  normalize, workdaysBack, defaultSpec, windowOf, parseRange, specFrom, forUser, dayLabel, workdaysLabel
};
