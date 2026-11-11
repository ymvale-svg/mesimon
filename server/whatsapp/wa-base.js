'use strict';
/**
 * בוט הוואטסאפ — החיבור לוואטסאפ, שליחה וכפתורים, מי זה, היומן ושעות הפעילות, ועזרים משותפים לכל הזרימות.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: —.
 */
const Paths = require('../core').Paths;
const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const WhatsApp = require('../integrations').Whatsapp;
const Secrets = require('../core').Secrets;
const Auth = require('../core').Auth;
const Workdays = require('../core').Workdays;
const Gmail = require('../integrations').Gmail;
const Speech = require('../integrations').Speech;
const WaActions = require('./wa-actions');
const WaQuestions = require('./wa-questions');


const GROUP_SKILL = Paths.skill('whatsapp-group-to-tasks.md');

const CHAT_SKILL = Paths.skill('whatsapp-chat.md');

const TZ = 'Asia/Jerusalem';

const DAY = 24 * 60 * 60 * 1000;

const KEEP_DAYS = 7;          // כמה זמן נשמרות הודעות קבוצה

const BACKLOG_DAYS = 3;       // בקשירת קבוצה: מנתחים רק את מה שנכתב בימים האחרונים

const CONTEXT_MESSAGES = 15;  // הודעות קודמות שנשלחות להקשר

const BATCH_MAX = 40;         // הודעות חדשות בניתוח אחד

const HISTORY_TURNS = 8;      // שורות שיחה פרטית שנשמרות להקשר


const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };


/**
 * פעולות שתלויות ב-api.js — מוזרקות משם. ‎tasks‎: רשימות, סגירה והערה עם
 * הרשאות העובד. ‎mail‎: חיפוש נמען ופתיחת משימת AI — אותן פונקציות של האשף.
 */
const hooks = { createTask: null, listProjectsFor: null, newTaskProjects: null, assignableUserIds: null, assignBlockReason: null, taskTemplates: null, tasks: null, mail: null, files: null };


// ---------------------------------------------------------------------------
// החיבור
// ---------------------------------------------------------------------------

const botRow = () => D.get('SELECT * FROM wa_bot WHERE id = 1');


/** החיבור עם האסימון מפוענח — לשימוש בשרת בלבד */
function channel() {
  const row = botRow();
  if (!row?.instance_id || !row.api_token) return null;
  const token = Secrets.decrypt(row.api_token);
  return token ? { ...row, api_token: token } : null;
}


const isConfigured = () => Boolean(channel());


/** תצוגה ללקוח — בלי האסימון */
function publicStatus() {
  const row = botRow();
  return {
    enabled: Boolean(D.getSetting('wa_bot_enabled', true)),
    ai: Claude.isEnabled(),
    // תמלול הודעות קוליות: הספקים המוגדרים לפי הסדר, ומצב ההשוואה
    speech: Speech.providers(),
    speechCompare: Boolean(D.getSetting('speech_compare', false)),
    connection: row ? {
      apiUrl: row.api_url,
      instanceId: row.instance_id,
      phone: row.phone,
      state: row.state,
      checkedAt: row.checked_at,
      hasToken: Boolean(row.api_token)
    } : null
  };
}


function save({ apiUrl, instanceId, apiToken, phone }) {
  const existing = botRow();
  const token = apiToken ? Secrets.encrypt(String(apiToken).trim()) : existing?.api_token ?? '';
  D.run(
    `INSERT INTO wa_bot (id, api_url, instance_id, api_token, phone, state, created_at)
     VALUES (1, ?, ?, ?, ?, 'unknown', ?)
     ON CONFLICT(id) DO UPDATE SET
       api_url = excluded.api_url, instance_id = excluded.instance_id, api_token = excluded.api_token,
       phone = excluded.phone, state = 'unknown'`,
    String(apiUrl || WhatsApp.DEFAULT_API_URL).trim(),
    String(instanceId ?? '').trim(),
    token,
    WhatsApp.normalizePhone(phone) ?? '',
    D.nowIso()
  );
}


const remove = () => D.run('DELETE FROM wa_bot WHERE id = 1');


const setState = (state) => D.run('UPDATE wa_bot SET state = ?, checked_at = ? WHERE id = 1', state, D.nowIso());


async function checkState() {
  const ch = channel();
  if (!ch) return { state: 'not_configured' };
  try {
    const state = (await WhatsApp.call(ch, 'getStateInstance'))?.stateInstance ?? 'unknown';
    setState(state);
    if (state === 'authorized') {
      // רק הודעות נכנסות. בלי דיווח על יוצאות — הבוט כותב רק בפרטי, ואת זה הוא יודע ממילא
      await WhatsApp.call(ch, 'setSettings', { http: 'POST', body: { incomingWebhook: 'yes', outgoingMessageWebhook: 'no', outgoingAPIMessageWebhook: 'no' } })
        .catch((err) => console.error('[משימון] הגדרת בוט הוואטסאפ נכשלה:', err.message));
    }
    return { state };
  } catch (err) {
    setState('error');
    return { state: 'error', error: err.message };
  }
}


/** קוד QR לקישור הטלפון של הבוט, כמו בוואטסאפ ווב */
async function qr() {
  const ch = channel();
  if (!ch) throw new Error('הבוט אינו מוגדר');
  const out = await WhatsApp.call(ch, 'qr');
  if (out?.type === 'alreadyLogged') return { linked: true };
  if (out?.type === 'qrCode') return { image: `data:image/png;base64,${out.message}` };
  throw new Error(out?.message || 'לא התקבל קוד QR');
}


async function sendText(chatId, message) {
  const ch = channel();
  if (!ch) return;
  await WhatsApp.call(ch, 'sendMessage', { http: 'POST', body: { chatId, message } });
}


/*
 * הודעה עם כפתורי תשובה (Green API ‎sendInteractiveButtonsReply‎: עד 3 כפתורים, כיתוב קצר). הכיתוב של הכפתור הוא
 * התשובה שהבוט מבין, ולכן גם לחיצה שחוזרת כטקסט עובדת. נכשל (החשבון / הלקוח לא תומך) — טקסט רגיל, ולא מנסים
 * שוב שעה. גוף ארוך מ-1000 תווים — הטקסט לבד, והכפתורים בהודעה קצרה אחריו.
 */
let buttonsOffUntil = 0;

/**
 * ‎q‎ — מי שואל ועל מה (‎{ owner, draft, awaiting }‎): ההודעה נרשמת לפי המזהה שוואטסאפ מחזיר, כדי שלחיצה
 * עליה תגיע לשאלה הזו גם אם בינתיים נפתח משהו אחר (‎wa-questions.js‎)
 */
async function sendButtons(chatId, message, buttons, q = null) {
  const ch = channel();
  if (!ch) return;
  if (!buttons?.length) return sendText(chatId, message);
  // הכפתורים כבויים (נכשלו לאחרונה) — הטקסט, והאפשרויות כשורות, כדי שלא יאבדו
  if (Date.now() < buttonsOffUntil) return sendText(chatId, `${message}\n\n${buttons.slice(0, 3).map((b) => `▫️ ${b}`).join('\n')}`);
  let body = message;
  if (String(message).length > 1000) { await sendText(chatId, message); body = '👇'; }
  try {
    const sent = await WhatsApp.call(ch, 'sendInteractiveButtonsReply', { http: 'POST', body: {
      chatId, body,
      buttons: buttons.slice(0, 3).map((t, i) => ({ buttonId: String(i + 1), buttonText: String(t).slice(0, 20) }))
    } });
    if (q && sent?.idMessage) {
      const u = userByPhone(String(chatId).replace(/@c\.us$/, ''));
      if (u) WaQuestions.record(u.id, sent.idMessage, q);
    }
  } catch (err) {
    console.error('[משימון] כפתורים בוואטסאפ לא נשלחו, נשלח טקסט:', err.message);
    buttonsOffUntil = Date.now() + 60 * 60 * 1000;
    await sendText(chatId, `${body !== '👇' ? `${message}\n\n` : ''}${buttons.slice(0, 3).map((b) => `▫️ ${b}`).join('\n')}`);
  }
}


/** הכיתוב של כפתור שנלחץ — בכל צורה שהשירות מחזיר (‎buttonsResponseMessage‎, ‎templateButtonReplyMessage‎, ‎interactiveButtons…‎) */
function buttonReplyText(m) {
  for (const [k, v] of Object.entries(m ?? {})) {
    if (!/button|interactive/i.test(k) || !v || typeof v !== 'object') continue;
    for (const f of ['selectedButtonText', 'selectedDisplayText', 'buttonText', 'selectedText', 'titleText', 'title', 'text']) {
      if (typeof v[f] === 'string' && v[f].trim()) return v[f].trim();
    }
  }
  return '';
}


/**
 * ✅ על ההודעה בקבוצה שהפכה למשימה — סימן לכולם שהבקשה נקלטה, בלי לכתוב
 * בקבוצה. ניסיון בלבד: תגובה שנכשלה אינה מבטלת את המשימה.
 */
/*
 * 😀 אימוג'י על ההודעה של העובד במקום הודעות "רגע…" (הוחלט 10.11.26, ישראל):
 *   ✍️ מתמלל · 🤔 חושב · 👀 מחפש · 🧐 קורא מסמך · 📝 מנסח · 📅 ביומן · 📤 שולח · ⏳ עבודה ארוכה ברקע
 *   📥 קיבלתי (מועברות) · ✅ בוצע · 👌 "לא" / "התעלם" · ⚠️ תקלה (ואז גם טקסט קצר)
 * אימוג'י אחד בכל רגע — מתחלף לפי השלב; כשהתשובה מגיעה הוא יורד, או מתחלף ל-✅ כשבוצעה פעולה.
 * ניסיון בלבד: תגובה שנכשלה לא עוצרת כלום.
 */
const currentMsg = new Map(); // ‎userId‎ → ‎{ chatId, id }‎ — ההודעה האחרונה של העובד, שעליה מגיבים

const reacted = new Map();    // ‎messageId‎ → האימוג'י שעליה עכשיו (בלי "להסיר" כשאין מה להסיר)

async function react(ref, emoji) {
  const ch = channel();
  if (!ch || !ref?.id || !ref?.chatId || /^(bot-|mail-goods-|sim)/.test(String(ref.id))) return;
  if ((reacted.get(ref.id) ?? '') === emoji) return;
  if (emoji) reacted.set(ref.id, emoji); else reacted.delete(ref.id);
  if (reacted.size > 500) reacted.delete(reacted.keys().next().value);
  try {
    await WhatsApp.call(ch, 'sendReaction', { http: 'POST', body: { chatId: ref.chatId, idMessage: ref.id, reaction: emoji } });
  } catch { /* רק סימון */ }
}

const reactNow = (userId, emoji) => { void react(currentMsg.get(userId), emoji); };

/** האימוג'י בסוף עבודה ברקע: ✅ כשבוצעה פעולה, ⚠️ בתקלה, אחרת יורד */
const doneEmoji = (text, error = false) => (error ? '⚠️' : /^\s*✅/.test(String(text ?? '')) ? '✅' : '');


async function markDone(messageId, chatId = null, { taskId = null, title = '', by = null, groupName = '' } = {}) {
  const chat = chatId ?? D.get('SELECT chat_id FROM wa_messages WHERE message_id = ?', messageId)?.chat_id;
  const entry = { channel: 'group', chatId: chat ?? '', chatName: groupName, userId: by?.id ?? null, who: by?.name ?? '', action: 'approved', taskId };
  const ch = channel();
  if (!ch || !messageId || !chat) {
    log({ ...entry, result: `אושרה ונפתחה: ${title}` });
    return;
  }
  try {
    await WhatsApp.call(ch, 'sendReaction', { http: 'POST', body: { chatId: chat, idMessage: messageId, reaction: '✅' } });
    log({ ...entry, result: `אושרה ונפתחה: ${title} · ✅ על ההודעה` });
  } catch (err) {
    console.error('[משימון] סימון ✅ בקבוצה נכשל:', err.message);
    log({ ...entry, status: 'error', result: `אושרה ונפתחה: ${title} · ה-✅ נכשל: ${err.message}` });
  }
}


// ---------------------------------------------------------------------------
// מי זה
// ---------------------------------------------------------------------------

const orgUsers = () => D.all(
  `SELECT u.id, u.full_name, u.phone, d.name AS department FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.status = 'active' AND u.role <> 'vendor' ORDER BY u.full_name`
);


const PARTICIPANTS_TTL = 6 * 60 * 60 * 1000;


/** מספרי חברי הקבוצה, מ-Green API — נשמרים לכמה שעות. ‎null‎ כשאין דרך לדעת */
async function participantsOf(group) {
  const fresh = group.participants_at && Date.now() - new Date(group.participants_at).getTime() < PARTICIPANTS_TTL;
  if (fresh) return parseJson(group.participants, null);
  const ch = channel();
  try {
    const out = ch ? await WhatsApp.call(ch, 'getGroupData', { http: 'POST', body: { groupId: group.chat_id } }) : null;
    const phones = (out?.participants ?? []).map((p) => String(p.id ?? '').replace(/@c\.us$/, '')).filter(Boolean);
    if (!phones.length) throw new Error('לא התקבלה רשימת משתתפים');
    D.run('UPDATE wa_groups SET participants = ?, participants_at = ? WHERE chat_id = ?', JSON.stringify(phones), D.nowIso(), group.chat_id);
    return phones;
  } catch (err) {
    console.error(`[משימון] רשימת המשתתפים של "${group.name}" לא נטענה:`, err.message);
    // הרשימה הקודמת עדיפה על כלום, גם אם ישנה
    return group.participants_at ? parseJson(group.participants, null) : null;
  }
}


/**
 * מי יכול לקבל הצעה מהקבוצה: רק עובד שהטלפון שלו רשום במשימון ושחבר בקבוצה.
 * בקשה לאדם שאינו כאן אינה משימה במשימון. רשימת החברים לא ידועה — אין למי:
 * אחרת הצעה (ותובנה) מהקבוצה הייתה מגיעה גם למי שאינו חבר בה.
 */
async function candidatesOf(group) {
  const members = await participantsOf(group);
  if (!members) return [];
  return orgUsers().filter((u) => u.phone && members.includes(u.phone));
}


/** עובד לפי מספר וואטסאפ (‎972…‎) — הטלפון בפרופיל נשמר מנורמל */
function userByPhone(phone) {
  const n = WhatsApp.normalizePhone(phone);
  return n ? D.get("SELECT id, full_name FROM users WHERE phone = ? AND status = 'active' AND role <> 'vendor'", n) ?? null : null;
}


/** תיוג בקבוצה מגיע כ-‎@972541234567‎ — מוחלף בשם העובד כשהמספר מוכר */
function resolveMentions(text) {
  return String(text).replace(/@(\d{9,15})/g, (all, digits) => {
    const u = userByPhone(digits);
    return u ? `@${u.full_name}` : all;
  });
}


// ---------------------------------------------------------------------------
// קליטה
// ---------------------------------------------------------------------------

/** הקובץ האחרון שהעובד שלח ולא נקלט — ל"קבלת סחורה" שנכתבת אחריו (עד 15 דקות) */
const recentFiles = new Map();


// ---------------------------------------------------------------------------
// קבוצה → הצעות משימה
// ---------------------------------------------------------------------------

function localDate(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}



// ---------------------------------------------------------------------------
// יומן ושעות פעילות
// ---------------------------------------------------------------------------

const LOG_DAYS = 90;


/** שורה ביומן הבוט. יומן שנכשל אינו עוצר את הבוט */
function log(entry) {
  try {
    D.run(
      `INSERT INTO wa_log (at, channel, chat_id, chat_name, user_id, who, text, action, result, status, task_id, reply, forwarded)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      D.nowIso(), entry.channel, entry.chatId ?? '', String(entry.chatName ?? '').slice(0, 200), entry.userId ?? null,
      String(entry.who ?? '').slice(0, 120), String(entry.text ?? '').slice(0, 1000), entry.action ?? '',
      String(entry.result ?? '').slice(0, 1000), entry.status ?? 'ok', entry.taskId ?? null,
      String(entry.reply ?? '').slice(0, 2000), entry.forwarded ? 1 : 0
    );
  } catch (err) {
    console.error('[משימון] יומן הבוט:', err.message);
  }
}


function readLog({ channel = '', status = '', userId = 0, chatId = '', q = '', before = 0, limit = 100 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (channel) { where.push('l.channel = ?'); params.push(channel); }
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (userId) { where.push('l.user_id = ?'); params.push(Number(userId)); }
  if (chatId) { where.push('l.chat_id = ?'); params.push(chatId); }
  if (q) { where.push('(l.text LIKE ? OR l.result LIKE ? OR l.who LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (before) { where.push('l.id < ?'); params.push(Number(before)); }
  return D.all(
    `SELECT l.* FROM wa_log l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`,
    ...params, Math.min(200, Number(limit) || 100)
  ).map((r) => ({
    id: r.id, at: r.at, channel: r.channel, chatId: r.chat_id, chatName: r.chat_name, userId: r.user_id,
    who: r.who, text: r.text, action: r.action, result: r.result, status: r.status, taskId: r.task_id,
    reply: r.reply ?? '', forwarded: Boolean(r.forwarded)
  }));
}


/** סיכום היום למסך הניהול */
function todayStats() {
  const since = new Date(Date.now() - DAY).toISOString();
  const count = (sql, ...p) => D.get(`SELECT COUNT(*) c FROM wa_log WHERE at >= ? AND ${sql}`, since, ...p).c;
  return {
    privateMessages: count("channel = 'private'"),
    tasksOpened: count("action IN ('create_task', 'approved') AND status = 'ok' AND task_id IS NOT NULL"),
    suggestions: count("channel = 'group' AND action = 'group_task'"),
    unclear: count("status IN ('unclear', 'error')")
  };
}


/**
 * האם הבוט שולח עכשיו. בשבת (מערב שישי עד מוצאי שבת) ומחוץ לשעות שנקבעו —
 * לא. הודעות פרטיות שמגיעות אז נשמרות ונענות כשהחלון נפתח.
 */
function inHours(date = new Date()) {
  const t = localDate(date);
  if (D.getSetting('wa_shabbat', true)) {
    if (t.weekday === 'Friday' && t.time >= '15:00') return false;
    if (t.weekday === 'Saturday' && t.time < '20:30') return false;
  }
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(String(D.getSetting('wa_hours', '') ?? '').trim());
  if (!m) return true;
  const [, from, to] = m;
  return from <= to ? t.time >= from && t.time < to : t.time >= from || t.time < to;
}


/*
 * 🕗 הודעות יזומות — רק בשעות העבודה (הוחלט 11.11.26, ישראל: "תרכז את כל ההודעות היזומות רק לשעות העבודה, 8–5.
 * 8:15 ההודעה הראשונה של הבוקר, 5 ההודעה האחרונה — מה נשאר לך למחר — וזהו"):
 *   • בימי העבודה של העובד (‎Workdays.isWorkDay‎), 08:15–17:00 (‎wa_proactive_hours‎). הראשונה — סיכום הבוקר
 *     ב-08:15; האחרונה — סיכום סוף היום ב-17:00 (לו בלבד ‎DIGEST_GRACE_MIN‎ דקות, שלא ייפול בין שני סבבים).
 *   • מחוץ להן — שום הצעה, תזכורת או הודעה על מייל. הודעה שחייבת להגיע ("קיבלת משימה") — נשמרת לבוקר.
 *   • חוץ מזה: תשובה למי שפנה לבוט, תשובה שהוא ביקש וחיכה לה (‎deliver‎), ותזכורת שהוא ביקש בעצמו בשעה שקבע.
 */
const PROACTIVE_HOURS = '08:15-17:00';

const DIGEST_GRACE_MIN = 30;

const plusMin = (hhmm, n) => { const [h, m] = hhmm.split(':').map(Number); const t = Math.min(h * 60 + m + n, 24 * 60 - 1); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };


/** אפשר לשלוח עכשיו הודעה יזומה? ‎userId‎ — גם יום העבודה שלו; ‎graceMin‎ — לסיכום סוף היום */
function workHours(userId = null, { graceMin = 0, date = new Date() } = {}) {
  if (!inHours(date)) return false;
  const t = localDate(date);
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(String(D.getSetting('wa_proactive_hours', PROACTIVE_HOURS) || PROACTIVE_HOURS).trim())
    ?? /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(PROACTIVE_HOURS);
  if (!(t.time >= m[1] && t.time < plusMin(m[2], graceMin))) return false;
  if (userId == null) return true;
  try { return Workdays.isWorkDay(userId, t.date); } catch { return true; }
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';


const LETTERS = ['א', 'ב', 'ג', 'ד', 'ה'];


const usableClosure = (c) => Boolean(c && !c.dismissed && ['contact', 'assign', 'self'].includes(c.kind));


/** הצעה עם אנשים נוספים, ספק, פנייה החוצה או אזהרה — רק אחרי מבט באפליקציה */
const needsLook = (d) => Boolean(d.people?.length || d.ambiguous?.length || d.warning || d.aiRequest);


/*
 * ☀️ "היום" בוואטסאפ — "מה דורש ממך היום" (הוחלט 10.11.26, ישראל: "ההצעות, התובנות, המשימות — לא יעיל, לא
 * פרודוקטיבי. לאשר א', לדחות — זה לא מעניין אותי"):
 *   • יומן — רק פגישות ואירועים של ממש (בלי "משרד", "יום ארוך": ‎Calendar.isDayStatus‎).
 *   • 🔥 רשימה אחת: משימות באיחור ולהיום, הצעות מהמייל ומהוואטסאפ, ומיילים שמחכים לתשובה (התובנות "דורש
 *     ממך") — מדורגת לפי דחיפות, 3 הראשונות בהודעה, בלי כפילויות ובלי כותרות נפרדות.
 *   • [לעבור עליהם 👉] — פריט אחר פריט, עם כפתורים שמתאימים לסוגו (‎walkText‎ / ‎walkButtons‎). בלי "אשר א".
 */
const WALK = Object.freeze({
  start: 'לעבור עליהם 👉', next: 'הבא ⏭️', done: 'סיימתי ✅', tomorrow: 'למחר ➡️',
  task: 'למשימה ✅', handle: 'לטפל 💡', ignore: 'להתעלם 🙈', reply: 'לענות ✍️', approve: 'מאשר ✅'
});


/**
 * הודעה ארוכה מדי לוואטסאפ — מתפצלת בין פסקאות, ובפסקה ארוכה מדי — בין שורות.
 * טהורה.
 */
function splitMessage(text, max = 3500) {
  const t = String(text ?? '');
  if (t.length <= max) return [t];
  const parts = [];
  let cur = '';
  const push = (chunk, sep) => {
    if (cur && cur.length + sep.length + chunk.length > max) {
      parts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}${sep}${chunk}` : chunk;
  };
  // שורה ארוכה מהמקסימום — בחלקים משלה, נחתכת ברווח (או באמצע, כשאין רווח סביר); שום תו לא אובד
  const pushLong = (ln) => {
    if (cur) parts.push(cur);
    let rest = ln;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      parts.push(rest.slice(0, cut));
      rest = rest[cut] === ' ' ? rest.slice(cut + 1) : rest.slice(cut);
    }
    cur = rest;
  };
  for (const para of t.split('\n\n')) {
    if (para.length <= max) push(para, '\n\n');
    else for (const ln of para.split('\n')) (ln.length > max ? pushLong(ln) : push(ln, '\n'));
  }
  if (cur) parts.push(cur);
  return parts;
}


// ---------------------------------------------------------------------------
// מייל לאיש קשר
// ---------------------------------------------------------------------------

const PICK_SHOWN = 8;


function pickText(name, candidates) {
  const shown = candidates.slice(0, PICK_SHOWN);
  return [
    `מצאתי ${candidates.length > PICK_SHOWN ? `${candidates.length}` : shown.length} בשם "${name}". למי מהם?`,
    ...shown.map((c, i) => `${i + 1}. ${c.name}${c.organization ? ` · ${c.organization}` : ''}${c.type === 'user' ? ' · עובד/ת בארגון' : c.email ? ` · ${c.email}` : ''}`),
    candidates.length > PICK_SHOWN ? `ועוד ${candidates.length - PICK_SHOWN} — כתבו שם מלא או את שם החברה.` : null,
    '',
    'השיבו במספר, או כתבו שם מלא.'
  ].filter((l) => l !== null).join('\n');
}


/** אין חתימה ב-Gmail — שורה קצרה בטיוטה, כדי שלא יגלו את זה רק אחרי השליחה */
const NO_SIGNATURE_LINE = {
  none: '⚠️ _המייל ייצא בלי חתימה: אין חתימה ב-Gmail (חתימה ב-Outlook בלבד לא מספיקה). בינתיים יתווסף השם שלך._',
  no_read: '⚠️ _המייל ייצא בלי חתימה: חסרה הרשאת קריאה ל-Gmail — התחברו מחדש באפליקציה. בינתיים יתווסף השם שלך._'
};

const signatureLine = (p) => (p.signature ? '✍️ _+ החתימה שלך מ-Gmail_' : NO_SIGNATURE_LINE[p.noSignature] ?? null);


async function signatureFields(userId) {
  const info = await Gmail.signatureInfo(userId);
  return { signature: info.state === 'ok', noSignature: info.state === 'ok' ? null : info.state };
}


/**
 * מתחת לטיוטה מ"💡 פתרון לבעיה": להחליף ערוץ ("בוואטסאפ" / "במייל") או
 * לפנות לאחר מהחלופות ("2"). רק מה שאפשר באמת — ערוץ שלא מחובר לא מוצע.
 */
function solveAlternatives(p) {
  if (!p.solve) return '';
  const out = [];
  if (p.contact.type !== 'user') {
    if (p.channel === 'whatsapp' && p.solve.can?.email) out.push('*במייל* — אותה פנייה במייל');
    if (p.channel !== 'whatsapp' && p.solve.can?.whatsapp) out.push('*בוואטסאפ* — אותה פנייה בוואטסאפ');
  }
  (p.solve.options ?? []).forEach((o, i) => {
    if (o.contact.name === p.contact.name && (o.contact.email || o.contact.phone) === (p.contact.email || p.contact.phone)) return;
    out.push(`*${i + 1}* — לפנות ל${o.contact.name}${o.why ? ` (${o.why})` : ''} במקום`);
  });
  return out.length ? `🔀 ${out.join('\n🔀 ')}` : '';
}


function emailText(p) {
  const colleague = p.contact.type === 'user';
  const wa = p.channel === 'whatsapp';
  const lines = wa ? [
    `💬 *הודעת וואטסאפ ל${p.contact.name}* · ${p.contact.mobile || p.contact.phone}`,
    '',
    p.draft.body.slice(0, 2500)
  ] : [
    `✉️ *טיוטה ל${p.contact.name || p.contact.email}*${p.contact.email ? ` <${p.contact.email}>` : ''}${colleague ? ' · 👤 עובד/ת בארגון' : ''}`,
    `*נושא:* ${p.draft.subject}`,
    p.replyThread ? `↩️ *בהמשך לשרשור* "${p.replyThread.subject}" — לא כמייל חדש. _("מייל חדש" — אם לא)_` : null,
    '',
    p.draft.body.slice(0, 2500),
    // החתימה עצמה מ-Gmail — לא מוצגת כאן במלואה, רק שהיא תצורף (או שאין)
    colleague ? null : signatureLine(p)
  ].filter((l) => l !== null);
  if (!colleague && p.cc?.length) {
    lines.splice(1, 0, `📎 *בהעתק:* ${p.cc.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email)).join(', ')}`);
  }
  // שם להעתק שלא ברור למי הכוונה — שואלים, ולא שולחים עותק לאדם הלא נכון
  for (const a of (!colleague && p.ccAsk) || []) {
    lines.push('', a.options.length
      ? `❓ *בהעתק — למי התכוונת ב"${a.name}"?*\n${a.options.map((o, i) => `${i + 1}. ${o.name} <${o.email}>${o.org ? ` · ${o.org}` : ''}`).join('\n')}\nכתבו למשל: *בהעתק ${a.options[0].name}*`
      : `❓ *לא מצאתי את "${a.name}" באנשי הקשר* — כתבו את כתובת המייל שלו/ה לשים בהעתק, או *בלי ${a.name}*.`);
  }
  if (p.suggestions.length) {
    lines.push('', '💡 *מההתכתבות האחרונה — אולי להוסיף:*', ...p.suggestions.map((x, i) => `${i + 1}. ${x}`));
  }
  if (p.notes) lines.push('', `ℹ️ ${p.notes}`);
  const alt = solveAlternatives(p);
  if (alt) lines.push('', alt);
  lines.push('', wa
    ? `לשלוח בוואטסאפ מהמספר שלך? השיבו *כן*, כתבו מה לתקן, או *ביטול*.`
    : colleague
    ? `לשלוח במייל? השיבו *כן*. *במשימון* — במקום מייל, משימה שתשויך ל${firstName(p.contact.name) || 'עובד'} במשימון. אפשר גם לכתוב מה לתקן, או *ביטול*.`
    : `לשלוח? השיבו *כן*, כתבו מה לתקן${p.suggestions.length ? ', או "תוסיף את 1"' : ''}. *ביטול* — לא לשלוח.`);
  // 🌐 תרגום הטיוטה — "באנגלית" / "בערבית" הוא תיקון כמו כל תיקון
  if (!colleague) lines.push('_🌐 לתרגם: "באנגלית" · "בערבית"_');
  return lines.join('\n');
}


const appRoot = () => String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

const taskLink = (id) => {
  const root = appRoot();
  return root ? `${root}/?task=${id}` : null;
};


/** מי מקבל פנייה על מייל חדש: בוט פעיל, הפעולה מופעלת לו, טלפון, Gmail מחובר, ולא כיבה לעצמו */
function mailAlertUsers() {
  if (!D.getSetting('wa_bot_enabled', true) || !isConfigured() || !WaActions.byKey('mail_alert')?.enabled || !inHours()) return [];
  return orgUsers().filter((u) => {
    if (!u.phone || !workHours(u.id) || D.userPrefs(u.id)?.botPrefs?.mailAlert === false || !Gmail.boxesOf(u.id, 'mail').length) return false;
    const actor = Auth.loadActor('user', u.id);
    return Boolean(actor && WaActions.allowed(actor, 'mail_alert'));
  }).map((u) => u.id);
}


/*
 * מי מטפל בהודעה פרטית — ‎handleDirect‎ של ‎wa-bot.js‎, שנרשם בטעינה (‎onDirect‎).
 * כך זרימה בשכבה נמוכה (קבלת סחורה ממייל, דרישת רכש, ניסיון חוזר) מכניסה הודעה לתור של העובד בלי לייבא את הניתוב.
 */
let directHandler = () => { throw new Error('הבוט עוד לא נרשם לטיפול בהודעות (wa-bot.js)'); };
function onDirect(fn) { directHandler = fn; }

/** הודעה מדומה לתור של העובד (אחרי התשובה הנוכחית) — "קבלת סחורה" עם קובץ, "דרישת רכש …" */
function enqueueAs(userId, m) {
  const u = D.get('SELECT phone FROM users WHERE id = ?', userId);
  if (!u?.phone) return;
  const msg = { chatId: `${u.phone}@c.us`, phone: u.phone, kind: 'textMessage', forwarded: false, audio: null, file: null, id: `bot-${Date.now()}`, ...m };
  const prev = chains.get(msg.phone) ?? Promise.resolve();
  const next = prev.then(() => directHandler(msg))
    .catch((err) => console.error('[משימון] הודעה פנימית לבוט נכשלה:', err.message))
    .finally(() => { if (chains.get(msg.phone) === next) chains.delete(msg.phone); });
  chains.set(msg.phone, next);
  return next;
}


/*
 * הודעות פרטיות מטופלות מיד, בשרשרת נפרדת לכל עובד: הודעות של אותו עובד —
 * לפי הסדר; של עובדים שונים — במקביל, כך שתשובה ארוכה לאחד אינה מעכבת אחר.
 */
const chains = new Map();

module.exports = {
  appRoot, BACKLOG_DAYS, BATCH_MAX, buttonReplyText, candidatesOf, chains, channel, CHAT_SKILL, checkState, CONTEXT_MESSAGES, currentMsg, DAY, DIGEST_GRACE_MIN, doneEmoji, emailText, enqueueAs, firstName, GROUP_SKILL, HISTORY_TURNS, hooks, inHours, isConfigured, KEEP_DAYS, LETTERS, localDate, log, LOG_DAYS, mailAlertUsers, markDone, needsLook, onDirect, orgUsers, parseJson, PICK_SHOWN, pickText, publicStatus, qr, react, reactNow, readLog, recentFiles, remove, resolveMentions, save, sendButtons, sendText, setState, signatureFields, signatureLine, splitMessage, taskLink, todayStats, TZ, usableClosure, userByPhone, WALK, workHours
};
