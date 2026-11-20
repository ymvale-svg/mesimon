'use strict';
/**
 * 💡 הטיפ היומי — "ידעת שהבוט יודע…?" (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 4).
 *
 * פעם ביום עבודה, ב-09:00 (‎bot_tip_time‎), 4–5 שורות על משהו שהעובד עוד לא יודע שהבוט עושה, עם כפתור "נסו עכשיו"
 * שהכיתוב שלו הוא בדיוק מה שהבוט מבין. העובד באמצע שיחה או בפגישה — מחכים עד 10:00 (‎bot_tip_until‎); לא התפנה —
 * אין טיפ היום.
 *
 * איזה טיפ: מהקטלוג (‎server/whats-new/bot-tips.json‎), החדש קודם —
 *   • רק פעולה שמותרת לעובד (‎WaActions.allowed‎ — כולל פריוריטי לפי מטריצת ההרשאות);
 *   • רק פעולה שהעובד עוד לא השתמש בה (יומן הבוט, ‎USED_DAYS‎ ימים אחרונים);
 *   • לא טיפ שכבר קיבל. נגמרו — לא שולחים, עד שנוסף פיצ'ר.
 * "מספיק טיפים" — מפסיק (‎botPrefs.tips = false‎); "תחזיר את הטיפים" — מחזיר.
 *
 * המודול לא שולח בעצמו: ‎tick‎ מקבל ‎users‎, ‎push‎ ו-‎quiet‎ מהסבב (‎wa-bot.js‎).
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('../core').Db;
const Paths = require('../core').Paths;
const W = require('../core').Workdays;
const WaActions = require('./wa-actions');
const WaUi = require('./wa-ui');

const FILE = path.join(Paths.WHATS_NEW, 'bot-tips.json');
const USED_DAYS = 60;
const STOP_BTN = 'מספיק טיפים 🙅';

let cache = null;
/** הקטלוג — החדש קודם */
function catalog() {
  if (!cache) {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = [...(raw.tips ?? [])].sort((a, b) => String(b.added).localeCompare(String(a.added)));
  }
  return cache;
}

const prefsOf = (userId) => D.userPrefs(userId)?.botPrefs ?? {};
const savePrefs = (userId, patch) => D.setUserPref(userId, 'botPrefs', { ...prefsOf(userId), ...patch });

/** הפעולות שהעובד כבר השתמש בהן בבוט (מהיומן) */
function usedActions(userId) {
  const since = new Date(Date.now() - USED_DAYS * 86400000).toISOString();
  return new Set(D.all("SELECT DISTINCT action FROM wa_log WHERE user_id = ? AND channel = 'private' AND status = 'ok' AND at >= ?", userId, since).map((r) => r.action));
}

/** הטיפ הבא לעובד, או ‎null‎ */
function nextFor(actor) {
  const sent = new Set(prefsOf(actor.id).tipsSent ?? []);
  const used = usedActions(actor.id);
  return catalog().find((tip) => !sent.has(tip.id) && WaActions.allowed(actor, tip.action) && !used.has(tip.used ?? tip.action)) ?? null;
}

/** ההודעה: כותרת, 2–3 שורות, ו"נסו עכשיו" */
function message(tip) {
  const buttons = [tip.button, STOP_BTN].filter(Boolean);
  return {
    text: [`💡 *ידעת?* ${tip.icon} ${tip.title}`, ...tip.lines, '', tip.button ? 'נסו עכשיו 👇' : 'נסו עכשיו — פשוט כותבים לי.'].join('\n'),
    buttons
  };
}

const hm = (now) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);

/**
 * הסבב: מ-09:00 עד 10:00, לכל עובד — טיפ אחד ביום. ‎quiet(userId)‎ — לא באמצע שיחה ולא בפגישה (מחכים לסבב הבא).
 * מחזיר כמה טיפים נשלחו.
 */
async function tick({ users, push, quiet = async () => true, now = new Date() }) {
  const t = hm(now);
  if (t < String(D.getSetting('bot_tip_time', '09:00')) || t >= String(D.getSetting('bot_tip_until', '10:00'))) return 0;
  const today = W.todayIL();
  let sent = 0;
  for (const u of users()) {
    const p = prefsOf(u.id);
    if (p.tips === false || p.tipOn === today) continue;
    const actor = { type: 'user', id: u.id, role: u.role };
    const tip = nextFor(actor);
    if (!tip) continue;
    if (!(await quiet(u.id))) continue;
    // מסמנים לפני השליחה — תקלה באמצע לא תשלח פעמיים
    savePrefs(u.id, { tipOn: today, tipsSent: [...(p.tipsSent ?? []), tip.id] });
    if (await push(u.id, message(tip))) sent++;
  }
  return sent;
}

/** "מספיק טיפים" / "תחזיר את הטיפים" — ‎{ text }‎, או ‎null‎ כשזו לא הבקשה */
function command(userId, text) {
  const n = WaUi.normalize(text).replace(/[.!]+$/, '');
  if (WaUi.sameLabel(text, STOP_BTN) || /^(?:מספיק|די|בלי|תפסיק(?:\s+לשלוח)?|לא\s+צריך)\s+(?:עם\s+)?(?:ה)?טיפים$/.test(n)) {
    savePrefs(userId, { tips: false });
    return { text: 'בסדר 👍 לא אשלח יותר טיפים. להחזיר — "תחזיר את הטיפים".', result: 'הפסיק טיפים' };
  }
  if (/^(?:תחזיר|להחזיר|החזר)\s+(?:את\s+)?(?:ה)?טיפים$/.test(n)) {
    savePrefs(userId, { tips: true });
    return { text: '💡 חזרנו — טיפ אחד ביום, ב-9 בבוקר.', result: 'החזיר טיפים' };
  }
  return null;
}

module.exports = { catalog, nextFor, message, tick, command, STOP_BTN, _reset: () => { cache = null; } };
