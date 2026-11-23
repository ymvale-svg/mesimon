'use strict';
/**
 * 🔓 הודעה לעובד כשנפתחה לו הרשאה בבוט לפריוריטי (מטריצת ההרשאות, ‎priority-access.js‎) — מיד בשמירה,
 * גם מחוץ לשעות: המנהל פתח עכשיו, והעובד צריך לדעת שאפשר להתחיל.
 *
 *   • רק מה שעובד היום בבוט: מסמך ‎ready‎ שהפעולה שלו דלוקה (‎wa_actions‎). מסמך שעוד לא עובד — אין מה להודיע.
 *   • נוספו רק חברות — הודעה על החברות, אם יש לו מסמך שעובד בבוט.
 *   • כפתור ‎🗂 פריוריטי‎ — בדיוק מה שהבוט מבין בתפריט (‎wa-menu.js‎).
 *   • אין בוט או אין טלפון — התראה במשימון במקום.
 */
const D = require('../core').Db;
const Access = require('./priority-access');
const Settings = require('./priority-settings');
const WaBot = require('../whatsapp').WaBot;
const WaActions = require('../whatsapp').WaActions;

const BUTTON = '🗂 פריוריטי';

const docLabel = (k) => Access.DOCS.find((d) => d.key === k)?.label ?? k;
/** המסמכים שעובדים עכשיו בבוט (מוכנים, והפעולה דלוקה) */
const liveInBot = (docs) => docs.filter((k) => {
  const d = Access.DOCS.find((x) => x.key === k);
  return d?.ready && d.waAction && Boolean(WaActions.byKey(d.waAction)?.enabled);
});
const companyNames = (codes) => {
  const list = Settings.companies();
  return codes.map((c) => list.find((x) => x.code === c)?.name || c).join(', ');
};

/** נוסח ההודעה, או ‎null‎ — אין מה להודיע (לא נפתח דבר שעובד בבוט) */
function text(g) {
  const now = liveInBot(g.now.docs);
  if (!now.length) return null;
  const added = liveInBot(g.docs);
  const allCompanies = g.now.companies === null;
  if (g.now.companies !== null && !g.now.companies.length) return null;
  const where = allCompanies ? 'בכל החברות' : `בחברות: ${companyNames(g.now.companies)}`;
  if (added.length) {
    return [
      '🔓 *נפתחה לך הרשאה לפריוריטי בבוט*',
      `מעכשיו אפשר לעשות כאן: ${added.map((k) => `*${docLabel(k)}*`).join(', ')}`,
      `🏢 ${where}`,
      '',
      `להתחיל — לחצו *${BUTTON}* או כתבו *פריוריטי*.`
    ].join('\n');
  }
  const more = g.companies === null ? 'כל החברות' : g.companies.length ? companyNames(g.companies) : '';
  if (!more) return null;
  return [
    '🔓 *נוספו לך חברות בפריוריטי בבוט*',
    `🏢 ${more}`,
    `(${now.map(docLabel).join(', ')})`,
    '',
    `להתחיל — לחצו *${BUTTON}* או כתבו *פריוריטי*.`
  ].join('\n');
}

/**
 * שולח לכל מי שנפתחה לו הרשאה (‎granted‎ מ-‎Access.saveRows‎). מחזיר את מי שקיבל הודעה: ‎[{ userId, name, via }]‎
 * (‎via‎ — ‎whatsapp‎ או ‎app‎). שגיאה בשליחה לא מפילה את השמירה.
 */
async function send(granted = []) {
  const sent = [];
  for (const g of granted) {
    const body = text(g);
    if (!body) continue;
    const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", g.userId);
    if (!u) continue;
    let via = null;
    try {
      if (u.phone && D.getSetting('wa_bot_enabled', true) && WaBot.isConfigured()) {
        const chatId = `${u.phone}@c.us`;
        await WaBot.sendButtons(chatId, body, [BUTTON]);
        WaBot.log({ channel: 'private', chatId, userId: u.id, who: u.full_name, action: 'priority_access', status: 'ok', result: body.split('\n')[0].replace(/\*/g, '') });
        via = 'whatsapp';
      }
    } catch (err) {
      console.error('[משימון] הודעה על הרשאת פריוריטי נכשלה:', err.message);
    }
    if (!via) {
      D.notify({ targetType: 'user', targetId: u.id, kind: 'system', title: body.split('\n')[0].replace(/\*/g, ''), body: body.split('\n').slice(1).join('\n').replace(/\*/g, '').trim() });
      via = 'app';
    }
    sent.push({ userId: u.id, name: u.full_name, via });
  }
  return sent;
}

module.exports = { send, _internal: { text, BUTTON } };
