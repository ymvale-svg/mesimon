'use strict';
/**
 * 🩺 שירות ה-AI לא זמין — מה עושים (הוחלט 10.11.26, אחרי 12 שעות של "קרדיט נגמר" שאף מנהל לא ידע עליהן):
 *
 *   1. מנהלי המערכת מקבלים התראה בוואטסאפ מיד — ושוב כל שעה כל עוד זה נמשך — עם הסיבה ומה לעשות.
 *      כשהשירות חוזר — הודעה אחת: כמה זמן זה נמשך וכמה בקשות נשמרו.
 *   2. העובד לא מתבקש "לנסות שוב": הבקשה שלו נשמרת ("קיבלתי ✋"), והבוט מטפל בה בעצמו כשהשירות חוזר.
 *
 * תקלה = אין חיבור, מפתח שנדחה (401/403), עומס (429), תקלה אצל הספק (5xx), או קרדיט שנגמר.
 * שגיאה אחרת (בקשה לא תקינה, סירוב) היא באג או תוכן — לא "השירות לא זמין".
 *
 * המצב נשמר במסד (‎settings‎), כך שהוא שורד הפעלה מחדש של השרת.
 */
const D = require('../core').Db;

const STATE_KEY = 'ai_outage';
const RETRY_KEY = 'ai_retry';
const ALERT_EVERY_MS = 60 * 60 * 1000;   // התראה חוזרת למנהלים — פעם בשעה, כל עוד זה נמשך
const RETRY_EVERY_MS = 5 * 60 * 1000;    // בזמן תקלה — ניסיון (אחד) כל 5 דקות, שהוא גם הבדיקה אם השירות חזר
const KEEP_MS = 12 * 60 * 60 * 1000;     // בקשה שלא טופלה תוך 12 שעות — יורדת, והעובד מקבל הודעה
const PER_USER = 5;

/** מה קרה, במילים של מנהל — ומה לעשות */
function reasonOf(message) {
  const m = String(message ?? '');
  if (/credit balance|billing|purchase credits/i.test(m)) return { kind: 'credit', text: 'נגמר הקרדיט בחשבון ה-AI (Anthropic)', fix: 'לטעון קרדיט ב-console.anthropic.com ← Plans & Billing, ומומלץ להפעיל טעינה אוטומטית.' };
  if (/שגיאה (401|403)\b/.test(m)) return { kind: 'key', text: 'מפתח ה-AI נדחה', fix: 'לבדוק את ANTHROPIC_API_KEY בהגדרות השרת (Render).' };
  if (/שגיאה 429\b/.test(m)) return { kind: 'rate', text: 'עומס — חריגה ממגבלת הקריאות של ה-AI', fix: 'בדרך כלל חולף לבד תוך דקות.' };
  if (/שגיאה 5\d\d\b/.test(m)) return { kind: 'provider', text: 'תקלה אצל ספק ה-AI', fix: 'בדרך כלל חולף לבד. מצב השירות: status.anthropic.com' };
  if (/אין חיבור לשירות ה-AI/.test(m)) return { kind: 'network', text: 'אין חיבור לשירות ה-AI', fix: 'בדרך כלל חולף לבד. אם זה נמשך — לבדוק את השרת.' };
  return null;
}
const isOutage = (message) => Boolean(reasonOf(message));

const state = () => D.getSetting(STATE_KEY, null);
const active = () => Boolean(state()?.since);

/**
 * תקלה נרשמה. מחזיר הודעה למנהלים — כשזו תחילת התקלה, או כשעברה שעה מההתראה הקודמת; אחרת ‎null‎.
 * שגיאה שאינה תקלת שירות — מתעלמים (‎null‎).
 */
function noteFailure(message, now = Date.now()) {
  const why = reasonOf(message);
  if (!why) return null;
  const s = state() ?? {};
  const since = s.since ?? now;
  const due = !s.lastAlert || now - s.lastAlert >= ALERT_EVERY_MS;
  D.setSetting(STATE_KEY, { since, lastAlert: due ? now : s.lastAlert, kind: why.kind, failures: (s.failures ?? 0) + 1 });
  if (!due) return null;
  const waiting = pending().length;
  const first = !s.since;
  return [
    `⚠️ *שירות ה-AI לא זמין${first ? '' : ` — עדיין, מ-${hhmm(since)}`}*`,
    `${why.text}.`,
    `מה לעשות: ${why.fix}`,
    '',
    `עד שזה יחזור הבוט לא מבין בקשות חופשיות. ${waiting ? `${waiting} בקשות של עובדים נשמרו` : 'בקשות של עובדים נשמרות'} ויטופלו לבד כשהשירות יחזור.`,
    '_התראה הבאה — בעוד שעה, אם זה נמשך._'
  ].join('\n');
}

/** השירות חזר. מחזיר הודעה למנהלים — רק אם הייתה תקלה פעילה; אחרת ‎null‎ */
function noteRecovery(now = Date.now()) {
  const s = state();
  if (!s?.since) return null;
  D.setSetting(STATE_KEY, null);
  const mins = Math.max(1, Math.round((now - s.since) / 60000));
  const waiting = pending().length;
  return `✅ *שירות ה-AI חזר* (לא היה זמין ${mins < 90 ? `${mins} דקות` : `כ-${Math.round(mins / 60)} שעות`}, מ-${hhmm(s.since)}).${waiting ? `\n${waiting} בקשות שנשמרו מטופלות עכשיו.` : ''}`;
}

// ---------------------------------------------------------------------------
// בקשות שנשמרו לניסיון חוזר
// ---------------------------------------------------------------------------

const pending = () => { const v = D.getSetting(RETRY_KEY, []); return Array.isArray(v) ? v : []; };
const put = (list) => D.setSetting(RETRY_KEY, list);

/** שמירת בקשה. אותה בקשה מאותו עובד — פעם אחת. מחזיר את הרשומה (או ‎null‎ כשאין מה לשמור) */
function save(userId, text, { voice = false } = {}, now = Date.now()) {
  const t = String(text ?? '').trim();
  if (!userId || !t) return null;
  const list = pending();
  const same = list.find((x) => x.userId === userId && x.text === t);
  if (same) return same;
  const mine = list.filter((x) => x.userId === userId);
  const item = { id: `r${now}-${userId}-${list.length}`, userId, text: t.slice(0, 2000), voice: Boolean(voice), at: now, tries: 0, lastTry: 0 };
  // יותר מדי בקשות מאותו עובד — הישנה ביותר יורדת
  const keep = mine.length >= PER_USER ? list.filter((x) => x.id !== mine[0].id) : list;
  put([...keep, item]);
  return item;
}

const done = (id) => put(pending().filter((x) => x.id !== id));
function failed(id, now = Date.now()) {
  put(pending().map((x) => (x.id === id ? { ...x, tries: x.tries + 1, lastTry: now } : x)));
}

/**
 * מה לנסות עכשיו: ‎{ next, expired }‎. ‎expired‎ — בקשות ישנות מדי (יורדות כאן; העובד מקבל הודעה).
 * ‎next‎ — הוותיקה שלא נוסתה ב-5 הדקות האחרונות. בזמן תקלה — ניסיון אחד כל 5 דקות (הוא גם הבדיקה אם השירות חזר).
 */
function due(now = Date.now()) {
  const list = pending();
  const expired = list.filter((x) => now - x.at > KEEP_MS);
  if (expired.length) put(list.filter((x) => now - x.at <= KEEP_MS));
  const left = pending().sort((a, b) => a.at - b.at);
  if (active() && left.some((x) => now - x.lastTry < RETRY_EVERY_MS)) return { next: null, expired };
  return { next: left.find((x) => now - x.lastTry >= RETRY_EVERY_MS) ?? null, expired };
}

const hhmm = (ms) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/** לעובד, כשהבקשה נשמרה */
const SAVED_TEXT = 'קיבלתי ✋ שירות ה-AI לא זמין כרגע, ולכן אני לא יכול לטפל בזה עכשיו. *שמרתי את הבקשה* — אטפל בה לבד ברגע שהשירות יחזור, ואין צורך לשלוח שוב.';
const retryHeader = (item) => `↩️ השירות חזר — מטפל בבקשה ששלחת${item.voice ? ' בהקלטה' : ''}: "${item.text.length > 120 ? `${item.text.slice(0, 119)}…` : item.text}"`;
const EXPIRED_TEXT = (item) => `😕 לא הצלחתי לטפל בבקשה ששלחת (\"${item.text.slice(0, 80)}\") — שירות ה-AI לא חזר בזמן. אפשר לשלוח אותה שוב עכשיו.`;

module.exports = {
  reasonOf, isOutage, active, noteFailure, noteRecovery, save, done, failed, due, pending,
  SAVED_TEXT, retryHeader, EXPIRED_TEXT, ALERT_EVERY_MS, RETRY_EVERY_MS, KEEP_MS
};
