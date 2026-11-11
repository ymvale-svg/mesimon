'use strict';
/**
 * בוט הוואטסאפ — הודעות יזומות — מתי מותר לפנות לעובד, שאלה פתוחה שפגה, תיאום פגישות ובקשות להצעת מחיר.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups ← wa-private ← wa-tasks.
 */
const D = require('../core').Db;
const WhatsApp = require('../integrations').Whatsapp;
const Auth = require('../core').Auth;
const WaActions = require('./wa-actions');
const ReplyWatch = require('../mail').ReplyWatch;
const WaUi = require('./wa-ui');
const MailActions = require('../mail').MailActions;
const Rfq = require('../priority').Rfq;
const MeetCoord = require('../meetings').MeetingCoord;
const { channel, currentMsg, doneEmoji, firstName, hooks, inHours, isConfigured, localDate, log, mailAlertUsers, orgUsers, react, sendButtons, sendText, splitMessage, workHours } = require('./wa-base');
const { CANCEL, LIST_SHOWN, RANGES, chatOf, formatList, saveChat } = require('./wa-private');
const { rememberBot } = require('./wa-tasks');


// ---------------------------------------------------------------------------
// סיכום בוקר
// ---------------------------------------------------------------------------

async function sendSummaries() {
  if (!WaActions.byKey('summary')?.enabled || !hooks.tasks) return;
  const now = localDate();
  if (now.weekday === 'Friday' || now.weekday === 'Saturday') return;
  if (now.time < String(D.getSetting('wa_summary_time', '08:15'))) return;
  if (D.getSetting('wa_summary_sent', '') === now.date) return;
  // מסמנים לפני השליחה: תקלה באמצע לא תשלח לחצי מהעובדים פעמיים
  D.setSetting('wa_summary_sent', now.date);

  for (const u of orgUsers().filter((x) => x.phone && workHours(x.id))) {
    const actor = Auth.loadActor('user', u.id);
    if (!actor || !WaActions.allowed(actor, 'summary')) continue;
    const tasks = hooks.tasks.myTasks(actor).filter(RANGES.today.pick);
    if (!tasks.length) continue;
    const text = formatList(`☀️ בוקר טוב ${firstName(u.full_name)}! להיום ${tasks.length === 1 ? 'משימה אחת' : `${tasks.length} משימות`}:`, tasks, { actor });
    try {
      await sendText(`${u.phone}@c.us`, text);
      const state = chatOf(u.id);
      saveChat(u.id, { ...state, lastList: tasks.slice(0, LIST_SHOWN).map((x) => x.id) });
      log({ channel: 'summary', chatId: `${u.phone}@c.us`, userId: u.id, who: u.full_name, action: 'summary', status: 'ok', result: `סיכום בוקר: ${tasks.length} משימות` });
    } catch (err) {
      log({ channel: 'summary', userId: u.id, who: u.full_name, action: 'summary', status: 'error', result: err.message });
    }
  }
}


// ---------------------------------------------------------------------------
// ⏳ שאלה פתוחה שלא נענתה — פגה אחרי שעתיים (הוחלט 10.11.26)
// ---------------------------------------------------------------------------

/*
 * הבוט לא קוטע שאלה פתוחה. אבל שאלה שאיש לא ענה עליה ("זכרת? 🐣" שהמנכ"ל התעלם ממנו) עצרה את כל ההודעות
 * היזומות — גם בימים הבאים. עכשיו: שאלה פתוחה שאין בה תנועה שעתיים (לא נשאלה ולא נכתב לבוט) — יורדת, והבאה
 * בתור יכולה לבוא. הפריט עצמו נשאר במקומו (ב"ממתין לאישורך", ברשימת התזכורות).
 */
const userLastAt = new Map(); // ‎userId‎ → מתי העובד כתב לבוט

const STALE_QUESTION_MS = 2 * 60 * 60 * 1000;


/*
 * ⏳ "מאשר / ביטול" שלא נענה 15 דקות (הוחלט 10.11.26): מודעה שחיכתה ל"מאשר" בלעה בקשה אחרת שהגיעה אחר כך.
 * עכשיו: שאלה שממתינה ועברו עליה 15 דקות בלי אישור ובלי ביטול — יורדת כשהעובד כותב שוב, וההודעה שלו מתחילה
 * מההתחלה. לחיצה על כפתור (או 👍 / 👎, או "מאשר" / "ביטול" לבד) — תקפה גם אחרי 15 דקות: היא תשובה לשאלה הזו.
 * תפריט אינו שאלת אישור. קבלת סחורה ודרישת רכש — מצב משלהן (‎goods-receipt.js‎), לא כאן.
 */
const questionTtlMin = () => Math.max(1, Number(D.getSetting('wa_question_ttl_min', 15)) || 15);


function staleQuestion(userId, st, text, msg = {}) {
  if (!st.draft || st.draft.kind === 'menu') return false;
  const asked = Date.parse(st.draft.askedAt ?? '') || Date.parse(D.get('SELECT updated_at FROM wa_chats WHERE user_id = ?', userId)?.updated_at ?? '') || 0;
  if (!asked || Date.now() - asked < questionTtlMin() * 60 * 1000) return false;
  return !answerLike(text, msg);
}


/** לחיצה על כפתור, 👍 / 👎, או "מאשר" / "ביטול" לבד — תשובה לשאלה שממתינה, גם אחרי 15 דקות */
function answerLike(text, msg = {}) {
  const n = WaUi.normalize(String(text ?? ''));
  const short = n.split(/\s+/).filter(Boolean).length <= 3;
  return Boolean(msg.button || msg.kind === 'reactionMessage' || (n && short && (WaUi.YES.test(n) || WaUi.NO.test(n) || WaUi.CANCEL.test(n) || CANCEL.test(n))));
}


/** אפשר לשמור שאלה יזומה חדשה: אין שאלה פתוחה, או שהיא כבר לא חוסמת (‎busyFor‎) — ואז היא מוחלפת */
function freeToAsk(userId, st) {
  if (!st.awaiting && !(st.draft && st.draft.kind !== 'menu')) return true;
  if (busyFor(userId)) return false;
  releaseQuestion(st.draft);
  return true;
}


/**
 * שאלה שירדה בלי תשובה — לא חוזרת (הוחלט 11.11.26, ישראל: "אם הוא לא ענה — אל תשגע אותו. אם הוא יתעלם, אז הוא
 * יתעלם"). הצעה לקבלת סחורה / למילוי טופס שלא נענתה — נסגרת כ"התעלם"; הפריט עצמו נשאר ב"היום".
 */
function releaseQuestion(draft) {
  if (draft?.kind === 'goods_offer') D.run("UPDATE mail_goods_docs SET status = 'ignored' WHERE id = ? AND status = 'asked'", draft.goodsId);
  if (draft?.kind === 'form_fill' && draft.step === 'offer') D.run("UPDATE mail_forms SET status = 'ignored' WHERE id = ? AND status = 'asked'", draft.formId);
}


function busyFor(userId) {
  const st = chatOf(userId);
  if (!(st.awaiting || (st.draft && st.draft.kind !== 'menu'))) return false;
  const chatAt = Date.parse(D.get('SELECT updated_at FROM wa_chats WHERE user_id = ?', userId)?.updated_at ?? '') || 0;
  // מתי הייתה תנועה: מתי נשאלה השאלה ומתי העובד כתב. שמירת השיחה לא נחשבת — הבוט שומר גם כשהוא שולח לבד.
  // שאלה בלי חותמת זמן (מלפני העדכון) ועובד שלא כתב מאז שהשרת עלה — לפי השמירה האחרונה
  const asked = Date.parse(st.draft?.askedAt ?? '') || 0;
  const since = Math.max(userLastAt.get(userId) ?? 0, asked || chatAt);
  // אחרי 15 דקות בלי אישור / ביטול השאלה כבר לא חוסמת הודעות יזומות (היא נשארת, למקרה שילחצו על הכפתור —
  // ושאלה יזומה חדשה מחליפה אותה: ‎freeToAsk‎). אחרי שעתיים — יורדת
  if (Date.now() - since < questionTtlMin() * 60 * 1000) return true;
  if (Date.now() - since < STALE_QUESTION_MS) return false;
  releaseQuestion(st.draft);
  saveChat(userId, { ...st, draft: null, awaiting: false });
  log({ channel: 'summary', userId, action: 'other', status: 'ok', result: `שאלה פתוחה פגה אחרי שעתיים בלי תשובה: ${st.draft?.kind ?? ''}` });
  return false;
}


// ---------------------------------------------------------------------------
// הודעה יזומה עם קבצים וכפתורים — וטיוטה שמחכה לתשובה (כשהעובד לא באמצע משהו אחר)
// ---------------------------------------------------------------------------

async function pushToUser(userId, { text, files = [], buttons = [], draft = null }, action, { requested = false, graceMin = 0 } = {}) {
  // 🕗 רק בשעות העבודה — חוץ מתזכורת שהעובד ביקש בעצמו (‎requested‎)
  if (!requested && !workHours(userId, { graceMin })) return false;
  const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", userId);
  const ch = channel();
  if (!u?.phone || !ch) return false;
  const chatId = `${u.phone}@c.us`;
  const st = chatOf(userId);
  const busy = busyFor(userId) && chatOf(userId).draft?.kind !== draft?.kind;
  try {
    for (const f of files) await WhatsApp.sendFile(ch, chatId, f);
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1 && buttons.length && !busy) await sendButtons(chatId, parts[i], buttons, { owner: 'chat', draft, awaiting: Boolean(draft) });
      else await sendText(chatId, parts[i]);
    }
    rememberBot(userId, text);
    if (draft && !busy) saveChat(userId, { ...chatOf(userId), draft: { ...draft, askedAt: D.nowIso() }, awaiting: true });
    MailActions.noteProactive(userId);
    log({ channel: 'summary', chatId, userId, who: u.full_name, action, status: 'ok', result: text.split('\n')[0].slice(0, 300) });
    return true;
  } catch (err) {
    log({ channel: 'summary', chatId, userId, who: u.full_name, action, status: 'error', result: err.message });
    return false;
  }
}


// 📅 תיאום פגישה — שליחה / קביעה ברקע, ותשובות שמגיעות
function meetCoordRun(actor, fn) {
  const ref = currentMsg.get(actor.id);
  setImmediate(async () => {
    try {
      const text = await fn();
      void react(ref, doneEmoji(text));
      await pushToUser(actor.id, { text }, 'meet_coord');
    } catch (err) {
      void react(ref, '⚠️');
      console.error('[משימון] תיאום פגישה נכשל:', err.message);
      await pushToUser(actor.id, { text: `לא הצלחתי להשלים את תיאום הפגישה: ${err.message}` }, 'meet_coord');
    }
  });
}

let meetCoordAt = 0;

async function meetCoordTick() {
  if (!WaActions.byKey('meet_coord')?.enabled || Date.now() - meetCoordAt < 5 * 60 * 1000) return;
  meetCoordAt = Date.now();
  await MeetCoord.tick({ push: (userId, m) => pushToUser(userId, m, 'meet_coord') }).catch((err) => console.error('[משימון] מעקב תיאום פגישות נכשל:', err.message));
}


// 📬 "קיבלת תשובה" — למייל שיצא ממשימון (‎reply-watch.js‎). מידע בלבד, לכן לא מחכה לשאלה פתוחה
async function replyWatchTick() {
  if (!D.getSetting('wa_bot_enabled', true) || !isConfigured() || !WaActions.byKey('mail_alert')?.enabled || !inHours()) return;
  const allowed = new Set(mailAlertUsers());
  await ReplyWatch.tick({
    may: (userId) => allowed.has(userId),
    push: (userId, m) => pushToUser(userId, m, 'mail_alert')
  }).catch((err) => console.error('[משימון] מעקב תשובות למייל נכשל:', err.message));
}


// 🛒 פנייה לספקים — החיפוש והשליחה ברקע (חיפוש ברשת לוקח זמן)
function rfqPrepare(actor, rfqId) {
  const ref = currentMsg.get(actor.id);
  setImmediate(async () => {
    try {
      const r = await Rfq.prepare(actor.id, rfqId);
      void react(ref, '');
      await pushToUser(actor.id, { text: r.text, buttons: r.buttons ?? [], draft: r.draft ?? null }, 'rfq');
    } catch (err) {
      void react(ref, '⚠️');
      console.error('[משימון] חיפוש ספקים נכשל:', err.message);
      await pushToUser(actor.id, { text: 'לא הצלחתי למצוא ספקים כרגע 😕 נסו שוב בעוד כמה דקות.' }, 'rfq');
    }
  });
}

function rfqSend(actor, rfqId) {
  const ref = currentMsg.get(actor.id);
  setImmediate(async () => {
    try {
      const text = await Rfq.send(actor.id, rfqId, { createTask: hooks.createTask, actor });
      void react(ref, doneEmoji(text));
      await pushToUser(actor.id, { text }, 'rfq');
    } catch (err) {
      void react(ref, '⚠️');
      console.error('[משימון] שליחה לספקים נכשלה:', err.message);
      await pushToUser(actor.id, { text: `השליחה לספקים נכשלה: ${err.message}` }, 'rfq');
    }
  });
}

let rfqAt = 0;

async function rfqTick() {
  if (!WaActions.byKey('rfq')?.enabled || Date.now() - rfqAt < 5 * 60 * 1000) return;
  rfqAt = Date.now();
  await Rfq.tick({
    notify: (userId, text) => pushToUser(userId, { text }, 'rfq'),
    summary: (userId, s) => pushToUser(userId, s, 'rfq')
  }).catch((err) => console.error('[משימון] מעקב הצעות מחיר נכשל:', err.message));
}

module.exports = {
  answerLike, busyFor, freeToAsk, meetCoordRun, meetCoordTick, pushToUser, questionTtlMin, releaseQuestion, replyWatchTick, rfqPrepare, rfqSend, rfqTick, sendSummaries, staleQuestion, userLastAt
};
