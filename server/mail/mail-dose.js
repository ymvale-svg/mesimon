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
const Gmail = require('../integrations').Gmail;

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

/** 👁 הצעות יזומות ברצף שנמסרו ולא נקראו (‎whatsapp/wa-reads.js‎) — מדרגה למטה מיד */
function noteUnread(userId) {
  if (!userId || !enabled()) return;
  const s = stateOf(userId) ?? {};
  save(userId, { drops: Number(s.drops ?? 0) + 1, unreadAt: D.nowIso() });
}

/**
 * 📜 נקודת ההתחלה מההיסטוריה (הוחלט 17.11.26: "על סמך נתוני שימוש של לפני כשבועיים") — פעם אחת, בעלייה הראשונה
 * של הגרסה. לכל עובד שחיבר תיבה: השימוש האחרון ב-‎days‎ הימים האחרונים —
 *   • בבוט (‎wa_log‎): "מיילים לענות", טיוטת תשובה / תיקון שלה, תשובה שנשלחה מהצעה יזומה;
 *   • במשימון (‎ai_suggestions‎): הצעה שאושרה או צורפה, תשובה מוכנה שנשלחה.
 * נמצא — השעון מתחיל ממנו. לא נמצא — כאילו השתמש לפני ‎days‎ ימים (או ביום שנוסף למערכת, אם מאוחר יותר):
 * שבועיים בלי שימוש הם 2 מדרגות (20%), ואף אחד לא מושהה ביום ההפעלה — רק אחרי עוד שבוע בלי שימוש.
 * עובד שכבר השתמש מאז העלייה (‎noteUse‎) — לא נדרס. ‎force‎ — שוב (לבדיקות ולמנהל).
 * @returns {{ users: number, used: number, levels: number[] } | null}  ‎null‎ — כבר רץ
 */
function seedFromHistory({ days = 14, now = new Date(), force = false } = {}) {
  if (!force && D.getSetting('ai_dose_seeded_at', '')) return null;
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const users = D.all("SELECT id, created_at FROM users WHERE status = 'active'").filter((u) => Gmail.boxesOf(u.id, 'mail').length > 0);
  const out = { users: 0, used: 0, levels: [0, 0, 0, 0] };
  for (const u of users) {
    const s = stateOf(u.id);
    if (s?.lastKind && s.lastKind !== 'history') continue;
    const bot = D.get(
      `SELECT MAX(at) at FROM wa_log WHERE user_id = ? AND channel = 'private' AND status = 'ok' AND at >= ?
         AND (action IN ('mail_walk', 'mail_insights') OR (action = 'mail_alert' AND result LIKE 'תשובה ל%'))`,
      u.id, since
    )?.at;
    const app = D.get(
      "SELECT MAX(decided_at) at FROM ai_suggestions WHERE user_id = ? AND status IN ('approved', 'joined') AND decided_at >= ?",
      u.id, since
    )?.at;
    const replied = D.get(
      "SELECT MAX(json_extract(data, '$.reply.sent')) at FROM ai_suggestions WHERE user_id = ? AND json_extract(data, '$.reply.sent') >= ?",
      u.id, since
    )?.at;
    const last = [bot, app, replied].filter(Boolean).sort().pop() ?? null;
    const start = last ?? [since, u.created_at].filter(Boolean).sort().pop();
    save(u.id, { lastUse: start, lastKind: last ? 'history' : '', drops: 0, rejects: 0, pausedNotice: null, seeded: D.nowIso() });
    out.users++;
    if (last) out.used++;
    out.levels[level(u.id, { today: W.ilDateOf(now.toISOString()) })]++;
  }
  D.setSetting('ai_dose_seeded_at', D.nowIso());
  return out;
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
  level, percent, paused, noteUse, noteReject, noteUnread, seedFromHistory, prepareReplies, liveDue, morningScan, mayOffer, takePauseNotice, summary, workDaysSince
};
