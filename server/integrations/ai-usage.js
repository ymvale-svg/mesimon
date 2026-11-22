'use strict';
/**
 * 💰 צריכת ה-AI — כמה כל עובד וכל תכונה עולים ("תוכנית — חיסכון בקרדיטי AI.md", שלב 0).
 *
 * כל קריאה ל-Claude (‎claude.js‎) נרשמת כאן מתוך ‎usage‎ שבתשובה: טוקנים נכנסים, כתיבה וקריאה מהמטמון, יוצאים,
 * חיפושים ברשת — והערכת עלות לפי המחירון. הרישום מצטבר לשורה אחת ליום × עובד × תכונה × מודל × מהירות.
 *
 * מי העובד: ‎userId‎ שהועבר לקריאה; אחרת — ההקשר של הבקשה (‎forUser‎: בקשה מהאתר, הודעה לבוט, סריקת התיבה
 * של עובד); אחרת 0 — עבודת רקע של הארגון כולו.
 * התכונה: ‎feature‎ שהועבר לקריאה — חובה בכל קריאה (נאכף ב-‎test/unit/integrations/ai-usage.test.js‎).
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const D = require('../core').Db;
const W = require('../core').Workdays;

/*
 * מחירון לכל מיליון טוקנים (דולר) — להערכה בלבד, לא לחיוב. ‎cacheWrite‎ — כתיבה למטמון (×1.25 מהקלט),
 * ‎cacheRead‎ — קריאה ממנו. מצב מהיר (‎speed: fast‎) — פי 2. חיפוש ברשת — 10$ לאלף.
 * מודל שאינו כאן — העלות 0 והטוקנים נרשמים.
 */
const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.10 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.20 }
};
const FAST_FACTOR = 2;
const SEARCH_USD = 0.01;
const priceOf = (id) => PRICES[String(id ?? '').trim()] ?? null;

/** התכונות — השם שמוצג במסך העלות. תכונה חדשה: מוסיפים כאן (הבדיקה דורשת) */
const FEATURES = Object.freeze({
  'mail.scan': '📧 סריקת מיילים (הצעות משימה)',
  'mail.insights': '📬 תובנות מהתיבה',
  'mail.reply': '✍️ הצעת תשובה למייל',
  'mail.reply_learn': '🎓 לימוד מתשובות שנשלחו',
  'mail.memory': '🧠 זיכרון העבודה',
  'mail.ask': '🔎 שאל את המיילים',
  'mail.docs': '📎 מסמכים מהמייל',
  'mail.forms': '📝 מילוי טפסים',
  'mail.followup': '📤 מעקב אחרי מיילים שנשלחו',
  'bot.chat': '🤖 בוט — הבנת בקשה',
  'bot.voice': '🎤 בוט — פיצול הקלטה',
  'bot.reminders': '⏰ בוט — תזכורות',
  'bot.solve': '🛠 בוט — פתרון תקלה',
  'bot.notice': '📢 בוט — מודעות',
  'bot.groups': '👥 קבוצות וואטסאפ',
  'bot.wa_scan': '💬 סריקת הוואטסאפ האישי',
  'bot.instinct': '🦉 אינסטינקט',
  'tasks.ai': '📨 משימות AI (פנייה ומעקב)',
  'tasks.voice': '🎙 משימה בקול',
  'tasks.sync': '🔄 סנכרון משימות',
  'tasks.closure': '✅ הצעה לסגירת משימה',
  'tasks.outreach': '📣 פנייה לספקים',
  'tasks.dupes': '👯 משימות כפולות',
  'meetings.briefing': '📋 הכנה לפגישה',
  'meetings.summary': '📝 סיכום פגישה',
  'meetings.followup': '🔁 מעקב אחרי פגישה',
  'meetings.coord': '📅 תיאום פגישות',
  'meetings.timeless': '🎞 הקלטות Timeless',
  'agents.ask': '✨ שאל — סוכנים',
  'agents.knowledge': '📚 ידע ארגוני',
  'agents.health': '🩺 בדיקת חיבור',
  'priority.goods': '📦 קבלת סחורה',
  'priority.demand': '🛒 דרישת רכש',
  'priority.rfq': '💬 בקשה להצעת מחיר',
  'priority.po': '🧾 התראות הזמנות רכש',
  other: '❔ לא מסווג'
});

const als = new AsyncLocalStorage();
/** מריץ את ‎fn‎ בהקשר של עובד — קריאות ל-AI בתוכה נרשמות לו (אם לא הועבר ‎userId‎ אחר) */
const forUser = (userId, fn) => als.run({ userId: Number(userId) || 0 }, fn);
const currentUser = () => als.getStore()?.userId ?? 0;

/** עלות משוערת בדולרים של תשובה אחת */
function costOf(model, usage = {}, { fast = false } = {}) {
  const p = priceOf(model);
  const searches = Number(usage.server_tool_use?.web_search_requests ?? 0);
  if (!p) return searches * SEARCH_USD;
  const tokens = (Number(usage.input_tokens ?? 0) * p.input
    + Number(usage.cache_creation_input_tokens ?? 0) * p.cacheWrite
    + Number(usage.cache_read_input_tokens ?? 0) * p.cacheRead
    + Number(usage.output_tokens ?? 0) * p.output) / 1e6;
  return tokens * (fast ? FAST_FACTOR : 1) + searches * SEARCH_USD;
}

/**
 * רישום של תשובה אחת. לעולם לא זורק — מעקב בלבד.
 * @param {{ feature?: string, userId?: number, model: string, fast?: boolean, usage: object }} r
 */
function record({ feature, userId = null, model, fast = false, usage }) {
  if (!usage) return;
  try {
    const f = FEATURES[feature] ? feature : 'other';
    const who = Number(userId ?? currentUser()) || 0;
    const isFast = usage.speed ? usage.speed === 'fast' : Boolean(fast);
    const micro = Math.round(costOf(model, usage, { fast: isFast }) * 1e6);
    D.run(
      `INSERT INTO ai_usage (day, user_id, feature, model, fast, calls, input, cache_write, cache_read, output, searches, cost_micro)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, user_id, feature, model, fast) DO UPDATE SET
         calls = calls + 1, input = input + excluded.input, cache_write = cache_write + excluded.cache_write,
         cache_read = cache_read + excluded.cache_read, output = output + excluded.output,
         searches = searches + excluded.searches, cost_micro = cost_micro + excluded.cost_micro`,
      W.todayIL(), who, f, String(model ?? ''), isFast ? 1 : 0,
      Number(usage.input_tokens ?? 0), Number(usage.cache_creation_input_tokens ?? 0), Number(usage.cache_read_input_tokens ?? 0),
      Number(usage.output_tokens ?? 0), Number(usage.server_tool_use?.web_search_requests ?? 0), micro
    );
  } catch (err) {
    console.error('[משימון] רישום צריכת ה-AI נכשל:', err.message);
  }
}

const usd = (micro) => Math.round(Number(micro ?? 0) / 1e4) / 100;

/**
 * הדוח למסך הניהול: ‎days‎ אחרונים — סך הכול, לפי תכונה, לפי עובד (עם התכונות של כל אחד), לפי יום ולפי מודל.
 */
function report({ days = 30 } = {}) {
  const n = Math.min(365, Math.max(1, Number(days) || 30));
  const from = W.addDays(W.todayIL(), -(n - 1));
  const sum = 'SUM(calls) calls, SUM(input) input, SUM(cache_write) cache_write, SUM(cache_read) cache_read, SUM(output) output, SUM(searches) searches, SUM(cost_micro) cost';
  const shape = (r) => ({
    calls: r.calls ?? 0, input: r.input ?? 0, cacheWrite: r.cache_write ?? 0, cacheRead: r.cache_read ?? 0,
    output: r.output ?? 0, searches: r.searches ?? 0, usd: usd(r.cost)
  });
  const total = shape(D.get(`SELECT ${sum} FROM ai_usage WHERE day >= ?`, from) ?? {});
  const byFeature = D.all(`SELECT feature, ${sum} FROM ai_usage WHERE day >= ? GROUP BY feature ORDER BY cost DESC`, from)
    .map((r) => ({ feature: r.feature, label: FEATURES[r.feature] ?? r.feature, ...shape(r) }));
  const perUser = D.all(`SELECT a.user_id, a.feature, ${sum} FROM ai_usage a WHERE a.day >= ? GROUP BY a.user_id, a.feature`, from);
  const names = new Map(D.all('SELECT id, full_name FROM users').map((u) => [u.id, u.full_name]));
  const users = new Map();
  for (const r of perUser) {
    const u = users.get(r.user_id) ?? { userId: r.user_id, name: r.user_id ? (names.get(r.user_id) ?? `#${r.user_id}`) : '🏢 הארגון (רקע)', cost: 0, calls: 0, features: [] };
    u.cost += r.cost ?? 0;
    u.calls += r.calls ?? 0;
    u.features.push({ feature: r.feature, label: FEATURES[r.feature] ?? r.feature, calls: r.calls ?? 0, usd: usd(r.cost) });
    users.set(r.user_id, u);
  }
  const byUser = [...users.values()]
    .map((u) => ({ userId: u.userId, name: u.name, calls: u.calls, usd: usd(u.cost), features: u.features.sort((a, b) => b.usd - a.usd) }))
    .sort((a, b) => b.usd - a.usd);
  const byDay = D.all(`SELECT day, SUM(calls) calls, SUM(cost_micro) cost FROM ai_usage WHERE day >= ? GROUP BY day ORDER BY day`, from)
    .map((r) => ({ day: r.day, calls: r.calls, usd: usd(r.cost) }));
  const byModel = D.all(`SELECT model, fast, ${sum} FROM ai_usage WHERE day >= ? GROUP BY model, fast ORDER BY cost DESC`, from)
    .map((r) => ({ model: r.model, fast: Boolean(r.fast), ...shape(r) }));
  return { days: n, from, total, byFeature, byUser, byDay, byModel };
}

module.exports = { record, report, costOf, priceOf, forUser, currentUser, FEATURES, PRICES };
