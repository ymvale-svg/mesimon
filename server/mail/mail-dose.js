'use strict';
/**
 * 📉 מינון המייל לפי שימוש ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 3; המדרגות אושרו 16.11.26).
 *
 * מי שמשתמש בהצעות המייל — מקבל הכול. מי שלא — כל שבוע עבודה בלי שימוש מוריד מדרגה:
 *
 *   מדרגה | בבוט                                          | מאחורי הקלעים
 *   100%  | הכול, כמו היום                                | סריקה שוטפת כל 10 דק', תשובה מוכנה מראש לכל מייל
 *   50%   | חצי: דחוף / חשוב תמיד, והשאר — אחד כן ואחד לא   | סריקה שוטפת כל 30 דק', תשובה נכתבת רק למייל שמוצע
 *   20%   | הצעה אחת ביום, רק דחוף / חשוב                  | רק סריקת הבוקר, תשובה רק למייל שמוצע
 *   0%    | אין הצעות מייל ותזכורות "זכרת?"; הודעה אחת      | אין סריקת מייל
 *
 * תמיד, בכל מדרגה: הכנה לפגישה, יומן, וכל מה שהעובד מבקש בעצמו ("מיילים לענות", "תענה ל…").
 *
 * **שימוש** (מחזיר מיד ל-100%): תשובה למייל שנשלחה מהבוט, תיקון נוסח, "מיילים לענות", בקשה יזומה על מייל,
 * אישור או דחייה של הצעה במשימון, ו"כן" על הודעת ההשהיה. **לא שימוש:** "לא" על הצעה — 3 ברצף מורידים מדרגה.
 * ימים שאינם ימי עבודה של העובד (‎Workdays‎) לא נספרים.
 *
 * המצב — בהעדפות העובד (‎user_prefs.mailDose‎): ‎{ lastUse, drops, rejects, pausedNotice, day, eligible, offered }‎.
 */
const D = require('../core').Db;
const W = require('../core').Workdays;

const STEPS = Object.freeze([100, 50, 20, 0]);
const PAUSED = STEPS.length - 1;
const REJECT_LIMIT = 3;
/** כל כמה דקות סריקה שוטפת, לפי מדרגה. ‎null‎ — אין סריקה שוטפת */
const LIVE_MINUTES = Object.freeze([null, 30, null, null]);

const enabled = () => Boolean(D.getSetting('ai_dose_enabled', true));
const weekDays = () => Math.max(1, Number(D.getSetting('ai_dose_week_days', 5)) || 5);
const stateOf = (userId) => D.userPrefs(userId)?.mailDose ?? null;
const save = (userId, patch) => D.setUserPref(userId, 'mailDose', { ...(stateOf(userId) ?? {}), ...patch });

/** ימי העבודה של העובד מאז ‎iso‎ (לא כולל היום שבו השתמש, כולל היום) */
function workDaysSince(userId, iso, today = W.todayIL()) {
  const from = W.ilDateOf(iso);
  let n = 0;
  for (let d = W.addDays(from, 1), i = 0; d <= today && i < 120; d = W.addDays(d, 1), i++) {
    if (W.isWorkDay(userId, d)) n++;
  }
  return n;
}

/**
 * המדרגה של העובד: 0 (100%) עד 3 (מושהה). עובד בלי מצב — מתחיל עכשיו ב-100% (לא יורדים לכולם ביום ההפעלה).
 */
function level(userId, { today = W.todayIL() } = {}) {
  if (!enabled() || !userId) return 0;
  const s = stateOf(userId);
  if (!s?.lastUse) {
    save(userId, { lastUse: D.nowIso(), drops: 0, rejects: 0 });
    return 0;
  }
  const weeks = Math.floor(workDaysSince(userId, s.lastUse, today) / weekDays());
  return Math.min(PAUSED, weeks + Number(s.drops ?? 0));
}

const percent = (userId) => STEPS[level(userId)];
const paused = (userId) => level(userId) === PAUSED;

/**
 * שימוש — חוזרים ל-100%. מחזיר ‎true‎ אם העובד היה מושהה (כדי לומר לו "חזרתי").
 * ‎kind‎ — לתיעוד (‎reply_sent‎ / ‎walk‎ / ‎edit‎ / ‎ask‎ / ‎app‎ / ‎resume‎).
 */
function noteUse(userId, kind = '') {
  if (!userId) return false;
  const was = enabled() && stateOf(userId)?.lastUse ? level(userId) : 0;
  save(userId, { lastUse: D.nowIso(), lastKind: kind, drops: 0, rejects: 0, pausedNotice: null });
  return was === PAUSED;
}

/** "לא" על הצעת מייל. ‎REJECT_LIMIT‎ ברצף — מדרגה למטה */
function noteReject(userId) {
  if (!userId || !enabled()) return;
  const s = stateOf(userId) ?? {};
  const rejects = Number(s.rejects ?? 0) + 1;
  if (rejects >= REJECT_LIMIT) save(userId, { rejects: 0, drops: Number(s.drops ?? 0) + 1 });
  else save(userId, { rejects });
}

/** להכין תשובה מראש בסריקה — רק ב-100% */
const prepareReplies = (userId) => level(userId) === 0;

/** האם התיבה נסרקת בסריקה השוטפת עכשיו. ‎lastScanAt‎ — הסריקה הקודמת שלה */
function liveDue(userId, lastScanAt, { now = Date.now(), baseMinutes = 10 } = {}) {
  const l = level(userId);
  if (l === 0) return true;
  const every = LIVE_MINUTES[l];
  if (!every) return false;
  return !lastScanAt || now - new Date(lastScanAt).getTime() >= (every - Math.min(every, baseMinutes) / 2) * 60000;
}

/** סריקת הבוקר — לכל מי שאינו מושהה */
const morningScan = (userId) => !paused(userId);

/**
 * הצעה יזומה על מייל בבוט — כן או לא, לפי המדרגה. סופר את הניסיונות והמוצעים של היום.
 * ‎priority‎ — של ההצעה (‎normal‎ / ‎high‎ / ‎urgent‎).
 */
function mayOffer(userId, priority = 'normal', { today = W.todayIL() } = {}) {
  const l = level(userId, { today });
  if (l === 0) return true;
  if (l === PAUSED) return false;
  const s = stateOf(userId) ?? {};
  const fresh = s.day === today ? s : { day: today, eligible: 0, offered: 0 };
  const eligible = Number(fresh.eligible ?? 0) + 1;
  const important = priority === 'high' || priority === 'urgent';
  const ok = l === 1
    ? important || eligible % 2 === 1
    : important && Number(fresh.offered ?? 0) < 1;
  save(userId, { day: today, eligible, offered: Number(fresh.offered ?? 0) + (ok ? 1 : 0) });
  return ok;
}

/** הודעת ההשהיה — פעם אחת לכל השהיה. מחזיר ‎true‎ אם צריך לשלוח עכשיו (ומסמן שנשלחה) */
function takePauseNotice(userId) {
  if (!paused(userId) || stateOf(userId)?.pausedNotice) return false;
  save(userId, { pausedNotice: D.nowIso() });
  return true;
}

const PAUSE_BTN = Object.freeze({ resume: 'כן, תחזור ✅', stay: 'לא ❌' });
const PAUSE_TEXT = '📭 לא השתמשת בהצעות התשובה למיילים בשבועות האחרונים, אז הפסקתי להציע אותן.\n'
  + 'הכנה לפגישות, יומן וכל מה שתבקש — ממשיכים כרגיל.\n'
  + 'רוצה שאחזור להציע? (אפשר גם בכל רגע: *מיילים לענות*)';

/** למסך העלות ולבדיקות: המדרגה של כל עובד */
function summary(userId) {
  const s = stateOf(userId) ?? {};
  return { level: level(userId), percent: percent(userId), lastUse: s.lastUse ?? null, lastKind: s.lastKind ?? '' };
}

module.exports = {
  STEPS, PAUSED, REJECT_LIMIT, LIVE_MINUTES, PAUSE_BTN, PAUSE_TEXT,
  level, percent, paused, noteUse, noteReject, prepareReplies, liveDue, morningScan, mayOffer, takePauseNotice, summary, workDaysSince
};
