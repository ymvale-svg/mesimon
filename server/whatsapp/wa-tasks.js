'use strict';
/**
 * בוט הוואטסאפ — קיבלת משימה — הודעה לאחראי, תיבת הדואר היוצא של הבוט, ופנייה החוצה.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups ← wa-private.
 */
const D = require('../core').Db;
const WhatsApp = require('../integrations').Whatsapp;
const Auth = require('../core').Auth;
const WaActions = require('./wa-actions');
const WaScan = require('./whatsapp-scan');
const TaskOutreach = require('../tasks').TaskOutreach;
const PurchaseDemand = require('../priority').PurchaseDemand;
const MailActions = require('../mail').MailActions;
const MeetCoord = require('../meetings').MeetingCoord;
const { DAY, HISTORY_TURNS, channel, emailText, firstName, hooks, isConfigured, localDate, log, pickText, sendButtons, sendText, signatureFields, splitMessage, taskLink, workHours } = require('./wa-base');
const { nameOf } = require('./wa-groups');
const { PRIORITY, chatOf, saveChat, shortDate } = require('./wa-private');


// ---------------------------------------------------------------------------
// קיבלת משימה
// ---------------------------------------------------------------------------

const OUTBOX_DAYS = 3;


/*
 * הודעה שהבוט שלח מיוזמתו ("קיבלת משימה", נוסח מייל למשימה) — נכנסת להיסטוריה
 * של השיחה. בלעדיה תשובה של העובד עליה ("רק תנסח לי את המלל") נקראת מול
 * השיחה הקודמת, ומקבלת תשובה על נושא שכבר נגמר.
 */
function rememberBot(userId, text) {
  const st = chatOf(userId);
  saveChat(userId, { ...st, history: [...st.history, { role: 'bot', text: String(text).slice(0, 500) }].slice(-HISTORY_TURNS) });
}


/** אחרי ההודעה, "סיימתי את 1" ו"תוסיף ל-1" מתייחסים למשימה שהתקבלה */
function sendProactive(userId, chatId, text, { taskId = null, action = 'assignment_notice', who = '' } = {}) {
  return sendText(chatId, text).then(async () => {
    MailActions.noteProactive(userId);
    if (taskId) saveChat(userId, { ...chatOf(userId), lastList: [taskId] });
    rememberBot(userId, text);
    log({ channel: 'summary', chatId, userId, who, action, status: 'ok', result: text.split('\n')[0].slice(0, 300), taskId });
    if (taskId && action === 'assignment_notice') await offerOutreach(userId, chatId, taskId, who);
  }).catch((err) => {
    log({ channel: 'summary', chatId, userId, who, action, status: 'error', result: err.message, taskId });
  });
}


/**
 * משימה שהיא פנייה החוצה ("לשלוח מייל לדני", "לבקש הצעת מחיר מהדפוס") — מיד
 * אחרי "קיבלת משימה", הודעה שנייה עם נוסח מייל מוכן. "כן" שולח מהתיבה של
 * העובד, והמשימה עצמה נעשית משימת AI שעוקבת אחרי התשובה. אותו נוסח מחכה גם
 * בכרטיס המשימה. נמען שלא נמצא, או כמה באותו שם — שואלים, כמו "שלח מייל ל…".
 *
 * עובד שבאמצע משהו אחר מול הבוט (טיוטה שמחכה ל"כן") — לא דורסים לו: רק
 * שורה שהנוסח מחכה בכרטיס. לעולם לא זורקת.
 */
async function offerOutreach(userId, chatId, taskId, who = '') {
  try {
    const actor = Auth.loadActor('user', userId);
    // 📅 משימה של "פגישה לקביעה" — הצעה לתאם אותה (3 מועדים במייל), במקום נוסח מייל רגיל
    const task = D.get('SELECT id, title, description, meeting_pending FROM tasks WHERE id = ?', taskId);
    if (actor && task?.meeting_pending && WaActions.allowed(actor, 'meet_coord')) {
      const st = chatOf(userId);
      const offer = st.awaiting ? null : await MeetCoord.offerForTask(actor, task, { searchContacts: hooks.mail?.searchContacts }).catch(() => null);
      if (offer) {
        await sendButtons(chatId, offer.text, offer.buttons);
        rememberBot(userId, offer.text);
        const now = chatOf(userId);
        if (!now.awaiting) saveChat(userId, { ...now, draft: { ...offer.draft, askedAt: D.nowIso() }, awaiting: true });
        MailActions.noteProactive(userId);
        log({ channel: 'summary', chatId, userId, who, action: 'meet_coord', status: 'ok', result: `לתאם: ${task.title}`.slice(0, 300), taskId });
        return;
      }
    }
    if (!actor || !hooks.mail?.sendOutreach || !WaActions.allowed(actor, 'send_email')) return;
    const row = await TaskOutreach.prepare(taskId, actor);
    if (!row || !['ready', 'no_contact'].includes(row.state)) return;
    const state = chatOf(userId);
    const link = taskLink(taskId);
    const busy = state.awaiting || ['email_pick', 'reply_ask'].includes(state.draft?.kind);
    const d = row.data;
    let text;
    let draft = null;
    if (busy) {
      text = `✉️ למשימה הזו הכנתי נוסח מייל${d.contact ? ` ל${d.contact.name || d.contact.email}` : ''} — מחכה לך בכרטיס המשימה.${link ? `\n${link}` : ''}`;
    } else if (row.state === 'ready') {
      draft = {
        kind: 'email', taskId, instruction: d.instruction, contact: d.contact, draft: d.draft,
        suggestions: d.suggestions ?? [], notes: d.notes ?? '', cc: [], ccAsk: [], ...await signatureFields(userId)
      };
      text = `✉️ *הכנתי לך נוסח מייל למשימה הזו:*\n\n${emailText(draft)}`;
    } else if (d.candidates?.length) {
      draft = { kind: 'email_pick', name: d.recipient?.name || d.recipient?.org || '', request: d.instruction, candidates: d.candidates, taskId };
      text = `✉️ *אפשר לשלוח את המייל למשימה הזו מכאן.*\n${pickText(draft.name, d.candidates)}`;
    } else {
      const name = [d.recipient?.name, d.recipient?.org].filter(Boolean).join(' · ');
      draft = { kind: 'email_pick', name: d.recipient?.name || '', request: d.instruction, candidates: [], taskId };
      text = `✉️ *אפשר לשלוח את המייל למשימה הזו מכאן* — ${name ? `אבל לא מצאתי את "${name}" באנשי הקשר` : 'אבל לא ברור למי'}.\nכתבו את כתובת המייל של הנמען, ואכין נוסח. *ביטול* — לא עכשיו.`;
    }
    await sendText(chatId, text);
    rememberBot(userId, text);
    // המצב נקרא שוב רגע לפני השמירה — הודעה שהגיעה בינתיים מהעובד גוברת
    const now = chatOf(userId);
    if (draft && !now.awaiting && !['email_pick', 'reply_ask'].includes(now.draft?.kind)) {
      saveChat(userId, { ...now, draft: { ...draft, askedAt: D.nowIso() }, awaiting: draft.kind === 'email' });
    }
    log({ channel: 'summary', chatId, userId, who, action: 'send_email', status: 'ok', result: text.split('\n')[0].slice(0, 300), taskId });
  } catch (err) {
    log({ channel: 'summary', chatId, userId, who, action: 'send_email', status: 'error', result: `נוסח למשימה: ${err.message}`, taskId });
  }
}


/**
 * "📌 קיבלת משימה" למי ששויכה לו משימה — בנוסף להתראה במערכת ולמייל. רק
 * לעובד עם טלפון, כשהפעולה מופעלת במסך הניהול ולא כובתה בהגדרות האישיות
 * שלו. מחוץ לשעות הפעילות — נשמרת ונשלחת כשהחלון נפתח. לעולם לא זורקת.
 */
function notifyAssignment({ taskId, userId, assigner = null, extra = false }) {
  try {
    if (!D.getSetting('wa_bot_enabled', true) || !isConfigured() || !WaActions.byKey('assignment_notice')?.enabled) return;
    const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active' AND role <> 'vendor'", userId);
    if (!u?.phone || D.userPrefs(u.id)?.assignChannels?.whatsapp === false) return;
    const actor = Auth.loadActor('user', u.id);
    if (!actor || !WaActions.allowed(actor, 'assignment_notice')) return;
    const task = D.get('SELECT id, title, due_date, priority, project_id FROM tasks WHERE id = ?', taskId);
    if (!task) return;
    const project = task.project_id ? D.get('SELECT name FROM projects WHERE id = ?', task.project_id)?.name : null;
    const link = taskLink(task.id);
    const hints = [
      WaActions.allowed(actor, 'complete') ? 'כשמסיימים: "סיימתי את 1"' : null,
      WaActions.allowed(actor, 'comment') ? 'להערה: "תוסיף ל-1: …"' : null
    ].filter(Boolean);
    const text = [
      `📌 ${firstName(u.full_name)}, ${extra ? 'הוגדרת אחראי/ת נוסף/ת על משימה' : 'קיבלת משימה חדשה'}${assigner?.name ? ` מ${assigner.name}` : ''}:`,
      `*${task.title}*`,
      task.due_date ? `📅 יעד: ${shortDate(localDate(new Date(task.due_date)).date)}` : null,
      project ? `📁 ${project}` : null,
      ['urgent', 'high'].includes(task.priority) ? `⚡ עדיפות: ${PRIORITY[task.priority]}` : null,
      link,
      hints.length ? '' : null,
      hints.length ? `${hints.join(' · ')}.` : null
    ].filter((l) => l !== null).join('\n');
    const chatId = `${u.phone}@c.us`;
    if (workHours(u.id)) {
      void sendProactive(u.id, chatId, text, { taskId: task.id, who: u.full_name });
    } else {
      D.run('INSERT INTO wa_outbox (user_id, chat_id, text, task_id, action, created_at) VALUES (?,?,?,?,?,?)',
        u.id, chatId, text, task.id, 'assignment_notice', D.nowIso());
    }
  } catch (err) {
    console.error('[משימון] הודעת "קיבלת משימה" בוואטסאפ נכשלה:', err.message);
  }
}


/**
 * 📎 תשובה שהעובד ביקש וחיכה לה (פענוח קובץ, ‎mail-doc-queue.js‎) — נשלחת מיד,
 * גם מחוץ לשעות: הוא שאל ונאמר לו שנודיע. ‎false‎ — אין בוט או אין טלפון.
 */
async function deliver(userId, text) {
  if (!D.getSetting('wa_bot_enabled', true) || !isConfigured()) return false;
  const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", userId);
  if (!u?.phone) return false;
  const chatId = `${u.phone}@c.us`;
  for (const part of splitMessage(text)) await sendText(chatId, part);
  log({ channel: 'private', chatId, userId: u.id, who: u.full_name, action: 'mail_ask', status: 'ok', result: `📎 תשובה אחרי פענוח: ${String(text).slice(0, 120)}` });
  return true;
}


/**
 * הודעה יזומה עם קבצים (PDF) — להתראה על הזמנת רכש (‎po-notify.js‎). הקבצים קודם, והטקסט אחרון.
 * ‎false‎ — אין בוט פעיל, או שלעובד אין טלפון. בלי בדיקת שעות: מי שקורא אחראי לכך.
 */
async function sendFilesToUser(userId, { files = [], text = '', action = 'notice', result = '' }) {
  if (!D.getSetting('wa_bot_enabled', true) || !isConfigured()) return false;
  const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", userId);
  const ch = channel();
  if (!u?.phone || !ch) return false;
  const chatId = `${u.phone}@c.us`;
  for (const f of files) await WhatsApp.sendFile(ch, chatId, f);
  for (const part of splitMessage(text)) await sendText(chatId, part);
  log({ channel: 'private', chatId, userId: u.id, who: u.full_name, action, status: 'ok', text: files.map((f) => `[📄 ${f.fileName}]`).join(' '), result: result || String(text).slice(0, 200) });
  return true;
}


/**
 * הודעה יזומה לעובד מהבוט — לשאלת "עסקי או אישי?" ולהודעת המעבר בוואטסאפ
 * האישי. מחוץ לשעות — לתור. ‎false‎ — אין בוט, או שלעובד אין טלפון: אז מי
 * שקרא לכאן שולח התראה במערכת במקום.
 */
function messageUser(userId, text, action) {
  if (!D.getSetting('wa_bot_enabled', true) || !isConfigured()) return false;
  const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", userId);
  if (!u?.phone) return false;
  const chatId = `${u.phone}@c.us`;
  if (workHours(u.id)) void sendProactive(u.id, chatId, text, { action, who: u.full_name });
  else D.run('INSERT INTO wa_outbox (user_id, chat_id, text, task_id, action, created_at) VALUES (?,?,?,?,?,?)', u.id, chatId, text, null, action, D.nowIso());
  return true;
}

PurchaseDemand.setHooks({ send: (userId, text) => messageUser(userId, text, 'purchase_demand') });

WaScan.setHooks({
  ask: (userId, text) => messageUser(userId, text, 'wa_scan_ask'),
  notice: (userId, text) => messageUser(userId, text, 'wa_scan_notice')
});


/** מה שנשמר מחוץ לשעות — נשלח כשהחלון נפתח. ישן מדי כבר אינו חדשות */
async function flushOutbox() {
  D.run('DELETE FROM wa_outbox WHERE created_at < ?', new Date(Date.now() - OUTBOX_DAYS * DAY).toISOString());
  let sent = 0;
  for (const row of D.all('SELECT * FROM wa_outbox ORDER BY id')) {
    if (sent >= 30) break;
    // לא יום העבודה של העובד — מחכה לשלו
    if (!workHours(row.user_id)) continue;
    sent++;
    D.run('DELETE FROM wa_outbox WHERE id = ?', row.id);
    await sendProactive(row.user_id, row.chat_id, row.text, { taskId: row.task_id, action: row.action, who: nameOf(row.user_id) });
  }
}

module.exports = {
  deliver, flushOutbox, messageUser, notifyAssignment, rememberBot, sendFilesToUser
};
