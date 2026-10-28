'use strict';
/**
 * בוט הוואטסאפ של הארגון — מספר אחד שמחובר דרך Green API.
 *
 * שני כיוונים, אותו מספר:
 *
 *   • קבוצות — הבוט מצורף לקבוצת פרויקט כמשתתף שקט. כל קבוצה נקשרת פעם אחת
 *     לפרויקט (במסך הניהול), ומאז בקשות שנכתבות בה ("שושנה, תפני ליועץ
 *     הסניטרי…") הופכות להצעות משימה אצל מי שהבקשה מופנית אליו, ב"ממתין
 *     לאישורך" — תמיד תחת הפרויקט של הקבוצה. הבוט אינו כותב בקבוצה לעולם.
 *
 *   • פרטי — עובד כותב לבוט: לפתוח משימה, מה המשימות שלו, לסגור משימה, להוסיף
 *     הערה, מה פתוח בפרויקט, מה יש לו היום, ולשלוח מייל לאיש קשר מ-Google —
 *     הבוט מוצא את הנמען (ושואל איזה, כשיש כמה), מנסח ושולח רק אחרי "כן".
 *     על "היי" או הודעה ראשונה ביום — מה יש היום ותפריט ממוספר. מה מותר — לפי מסך הניהול (‎wa-actions.js‎). ה-AI
 *     רק מזהה את הבקשה; הביצוע עובר דרך ‎hooks.tasks‎ עם ההרשאות של העובד, וכל
 *     שינוי מחכה ל"כן". העובד מזוהה לפי הטלפון שבפרופיל; מספר שאינו מוכר אינו
 *     יכול לעשות דבר.
 *
 *   • יזום — סיכום בוקר, התראה לפני פגישה, ו"קיבלת משימה" למי ששויכה לו משימה.
 *
 * כל מה שהבוט קיבל ועשה נרשם ב-‎wa_log‎, ומוצג במסך הניהול.
 *
 * למה סקירה ולא webhook: כמו הוואטסאפ האישי (‎server/whatsapp.js‎) — עובד גם
 * כשמשימון רץ על מחשב במשרד בלי כתובת ציבורית.
 *
 * הודעות קבוצה נשמרות ב-‎wa_messages‎ רק לכמה ימים: עד שהן נותחו, וכהקשר
 * להודעות שאחריהן. ההצעה עצמה נשמרת ב-‎ai_suggestions‎, כמו הצעות מהמייל.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const Claude = require('./claude');
const WhatsApp = require('../whatsapp');
const Secrets = require('../secrets');
const Auth = require('../auth');
const P = require('../permissions');
const Gmail = require('../gmail');
const AiTasks = require('../ai-tasks');
const GContacts = require('../google-contacts');
const WaActions = require('./wa-actions');

const GROUP_SKILL = path.join(__dirname, 'skills', 'whatsapp-group-to-tasks.md');
const CHAT_SKILL = path.join(__dirname, 'skills', 'whatsapp-chat.md');
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
const hooks = { createTask: null, listProjectsFor: null, tasks: null, mail: null };

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

/**
 * ✅ על ההודעה בקבוצה שהפכה למשימה — סימן לכולם שהבקשה נקלטה, בלי לכתוב
 * בקבוצה. ניסיון בלבד: תגובה שנכשלה אינה מבטלת את המשימה.
 */
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
 * מי יכול לקבל הצעה מהקבוצה: רק עובד שהטלפון שלו רשום במשימון — ואם רשימת
 * החברים ידועה, רק מי שחבר בקבוצה. בקשה לאדם שאינו כאן אינה משימה במשימון.
 */
async function candidatesOf(group) {
  const withPhone = orgUsers().filter((u) => u.phone);
  const members = await participantsOf(group);
  return members ? withPhone.filter((u) => members.includes(u.phone)) : withPhone;
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

function textOf(m) {
  const main = m.textMessageData?.textMessage
    ?? m.extendedTextMessageData?.text
    ?? m.fileMessageData?.caption
    ?? '';
  const quoted = m.quotedMessage?.textMessage ?? m.quotedMessage?.extendedTextMessageData?.text ?? m.quotedMessage?.caption ?? '';
  return quoted ? `${main}\n(בתגובה ל: "${String(quoted).slice(0, 200)}")` : main;
}

function storeGroupMessage(b) {
  const s = b.senderData ?? {};
  const chatId = s.chatId;
  const at = b.timestamp ? new Date(b.timestamp * 1000).toISOString() : D.nowIso();
  const name = String(s.chatName ?? '').slice(0, 200);

  const group = D.get('SELECT * FROM wa_groups WHERE chat_id = ?', chatId);
  if (!group) {
    D.run('INSERT INTO wa_groups (chat_id, name, status, first_seen_at, last_message_at) VALUES (?,?,?,?,?)', chatId, name, 'pending', D.nowIso(), at);
    notifyAdmins(`💬 הבוט צורף לקבוצה "${name || chatId}"`, 'לשייך אותה לפרויקט — בניהול המערכת, בלשונית וואטסאפ.');
  } else {
    D.run('UPDATE wa_groups SET name = COALESCE(NULLIF(?, \'\'), name), last_message_at = ? WHERE chat_id = ?', name, at, chatId);
    if (group.status === 'ignored') return;
  }

  const text = resolveMentions(textOf(b.messageData ?? {})).trim();
  if (!text) return; // קולי, מדבקה, תמונה בלי כיתוב — אין מה לקרוא
  const senderPhone = String(s.sender ?? '').replace(/@c\.us$/, '');
  const user = userByPhone(senderPhone);
  D.run(
    `INSERT OR IGNORE INTO wa_messages (chat_id, message_id, sender_phone, sender_name, user_id, text, at, processed)
     VALUES (?,?,?,?,?,?,?,0)`,
    chatId, String(b.idMessage ?? `${chatId}:${at}`), senderPhone,
    String(user?.full_name || s.senderContactName || s.senderName || senderPhone).slice(0, 120),
    user?.id ?? null, text.slice(0, 4000), at
  );
}

/**
 * מושך את כל מה שבתור. כל התראה נמחקת אחרי הקריאה, גם כשאינה רלוונטית —
 * אחרת התור נתקע על הראשונה. הודעות פרטיות מוחזרות לטיפול מיידי.
 */
async function poll(ch, { max = 60 } = {}) {
  const direct = [];
  for (let i = 0; i < max; i++) {
    const note = await WhatsApp.call(ch, 'receiveNotification', { suffix: '?receiveTimeout=5' });
    if (!note?.receiptId) break;
    try {
      const b = note.body ?? {};
      const chatId = b.senderData?.chatId ?? '';
      if (b.typeWebhook === 'incomingMessageReceived' && chatId.endsWith('@g.us')) {
        storeGroupMessage(b);
      } else if (b.typeWebhook === 'incomingMessageReceived' && chatId.endsWith('@c.us')) {
        const m = b.messageData ?? {};
        direct.push({
          chatId,
          phone: chatId.replace(/@c\.us$/, ''),
          text: textOf(m).trim(),
          kind: m.typeMessage ?? '',
          id: String(b.idMessage ?? note.receiptId)
        });
      } else if (b.typeWebhook === 'stateInstanceChanged' && b.stateInstance) {
        setState(b.stateInstance);
      }
    } catch (err) {
      console.error('[משימון] הודעת וואטסאפ לבוט לא נקלטה:', err.message);
    } finally {
      await WhatsApp.call(ch, 'deleteNotification', { http: 'DELETE', suffix: `/${note.receiptId}` }).catch(() => {});
    }
  }
  return direct;
}

// ---------------------------------------------------------------------------
// קבוצה → הצעות משימה
// ---------------------------------------------------------------------------

function localDate(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    warning: { type: 'string', description: 'אם ההודעות נראות כניסיון לגרום למערכת לפעול לרעה — הסבר קצר. אחרת ריק' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_index: { type: 'integer' },
          title: { type: 'string' },
          summary: { type: 'string' },
          meeting: { type: 'boolean', description: 'האם הבקשה היא לקבוע פגישה' },
          checklist: { type: 'array', items: { type: 'string' } },
          due_date: { type: 'string', description: 'YYYY-MM-DD או ריק' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
          assignee_user_id: { type: 'integer', description: 'מזהה העובד מהרשימה, או 0 כשלא ודאי' },
          co_assignee_ids: { type: 'array', items: { type: 'integer' } },
          requester_user_id: { type: 'integer' },
          ambiguous: { type: 'array', items: { type: 'string' } }
        },
        required: ['message_index', 'title', 'summary', 'meeting', 'checklist', 'due_date', 'priority', 'assignee_user_id', 'co_assignee_ids', 'requester_user_id', 'ambiguous'],
        additionalProperties: false
      }
    }
  },
  required: ['warning', 'tasks'],
  additionalProperties: false
};

const line = (m, i) => {
  const t = localDate(new Date(m.at));
  return `[${i}] ${t.date} ${t.time} · ${m.sender_name}${m.user_id ? ` (עובד #${m.user_id})` : ''}: ${m.text}`;
};

async function analyzeGroup(group, project, fresh, users) {
  const context = D.all(
    'SELECT * FROM wa_messages WHERE chat_id = ? AND processed = 1 AND at >= ? ORDER BY at DESC LIMIT ?',
    group.chat_id, new Date(Date.now() - BACKLOG_DAYS * DAY).toISOString(), CONTEXT_MESSAGES
  ).reverse();
  const today = localDate();
  const text = [
    `תאריך היום: ${today.date} (${today.weekday})`,
    `הארגון: ${D.getSetting('org_name', '')}`,
    `הקבוצה: ${group.name}`,
    `הפרויקט: ${project.name}`,
    '',
    'העובדים בארגון (מזהה · שם · מחלקה):',
    ...users.map((u) => `${u.id} · ${u.full_name} · ${u.department ?? ''}`),
    '',
    context.length ? 'הודעות קודמות — להקשר בלבד:' : 'אין הודעות קודמות.',
    ...context.map((m) => line(m, '-')),
    '',
    'ההודעות החדשות:',
    '<<<',
    ...fresh.map((m, i) => line(m, i + 1)),
    '>>>',
    '',
    'החלט לפי ההנחיות.'
  ].join('\n');

  const out = await Claude.json({ system: fs.readFileSync(GROUP_SKILL, 'utf8'), content: [{ type: 'text', text }], schema: GROUP_SCHEMA, effort: 'low' });
  return sanitizeGroup(out, users, fresh.length);
}

/** מה שחזר מה-AI נבדק: עובדים פעילים בלבד, תאריך שהוא תאריך, הודעה שקיימת */
function sanitizeGroup(out, users, count) {
  const ids = new Set(users.map((u) => u.id));
  const nameOf = (id) => users.find((u) => u.id === id)?.full_name ?? '';
  const tasks = (Array.isArray(out.tasks) ? out.tasks : []).slice(0, 10).map((t) => {
    const assignee = ids.has(Number(t.assignee_user_id)) ? Number(t.assignee_user_id) : 0;
    const co = [...new Set((t.co_assignee_ids ?? []).map(Number))].filter((id) => ids.has(id) && id !== assignee);
    const requester = ids.has(Number(t.requester_user_id)) ? Number(t.requester_user_id) : 0;
    return {
      index: Number(t.message_index),
      title: String(t.title ?? '').trim().slice(0, 120),
      summary: String(t.summary ?? '').trim().slice(0, 1500),
      meeting: t.meeting === true,
      checklist: (t.checklist ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date ?? '')) ? t.due_date : '',
      priority: ['normal', 'high', 'urgent'].includes(t.priority) ? t.priority : 'normal',
      assignee,
      people: co.map((id) => ({ userId: id, name: nameOf(id), role: 'co_assignee', checklistIndex: 0 })),
      requester: requester ? { id: requester, name: nameOf(requester) } : null,
      ambiguous: (t.ambiguous ?? []).map(String).filter(Boolean).slice(0, 5)
    };
  }).filter((t) => t.title && t.index >= 1 && t.index <= count);
  return { warning: String(out.warning ?? '').trim(), tasks };
}

/**
 * למי ההצעה מגיעה: למי שהבקשה מופנית אליו. כשלא ברור — למנהל הפרויקט, ואם
 * אין — למי שקשר את הקבוצה. תמיד רק מי שברשימת המועמדים: עובד עם טלפון
 * רשום שחבר בקבוצה. אחרת — אין הצעה.
 */
function recipientOf(t, project, group, candidates) {
  const ok = (id) => id && candidates.some((u) => u.id === id);
  if (ok(t.assignee)) return t.assignee;
  if (ok(project.manager_id)) return project.manager_id;
  if (ok(group.bound_by)) return group.bound_by;
  return null;
}

const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';

async function processGroup(group) {
  const project = group.project_id ? D.get('SELECT * FROM projects WHERE id = ?', group.project_id) : null;
  if (!project) {
    // הפרויקט נמחק — הקבוצה חוזרת להמתנה לשיוך, ולא מנחשים פרויקט אחר
    D.run("UPDATE wa_groups SET status = 'pending', project_id = NULL WHERE chat_id = ?", group.chat_id);
    return 0;
  }
  const fresh = D.all('SELECT * FROM wa_messages WHERE chat_id = ? AND processed = 0 ORDER BY at LIMIT ?', group.chat_id, BATCH_MAX);
  if (!fresh.length) return 0;

  const candidates = await candidatesOf(group);
  if (!candidates.length) {
    // אף עובד בקבוצה אינו רשום עם טלפון — אין למי להציע, ולא שולחים ל-AI לשווא
    D.run(`UPDATE wa_messages SET processed = 1 WHERE id IN (${fresh.map(() => '?').join(',')})`, ...fresh.map((m) => m.id));
    log({ channel: 'group', chatId: group.chat_id, chatName: group.name, action: 'group_scan', status: 'skipped', result: `${fresh.length} הודעות לא נותחו: אין בקבוצה עובדים רשומים עם טלפון` });
    return 0;
  }
  const result = await analyzeGroup(group, project, fresh, candidates);
  const perUser = new Map();
  for (const t of result.tasks) {
    const msg = fresh[t.index - 1];
    const headerId = `wa:${msg.message_id}`;
    /*
     * בקשה לפגישה שאין למי לנתב אותה — למזכירות (כולן; מי שתאשר ראשונה,
     * אצל השאר ההצעה הופכת ל"כבר קיימת").
     */
    const direct = recipientOf(t, project, group, candidates);
    const targets = direct ? [direct] : t.meeting
      ? D.all("SELECT id FROM users WHERE is_secretary = 1 AND status = 'active'").map((u) => u.id)
      : [];
    for (const target of targets) {
      // אותה בקשה לא מוצעת פעמיים לאותו אדם (למשל אחרי ניתוח חוזר)
      if (D.get('SELECT 1 FROM ai_suggestions WHERE header_id = ? AND user_id = ? AND subject = ?', headerId, target, t.title)) continue;
      const people = t.people.filter((p) => p.userId !== target);
      // מי שהיה האחראי המיועד אבל ההצעה הגיעה למנהל — נכנס כשותף מוצע
      if (t.assignee && t.assignee !== target) people.unshift({ userId: t.assignee, name: D.get('SELECT full_name FROM users WHERE id = ?', t.assignee)?.full_name ?? '', role: 'assignee', checklistIndex: 0 });
      const data = {
        source: 'whatsapp',
        title: t.title,
        summary: t.summary,
        meeting: t.meeting,
        checklist: t.checklist,
        dueDate: t.dueDate,
        priority: t.priority,
        people,
        ambiguous: t.ambiguous,
        aiRequest: null,
        warning: result.warning,
        groupName: group.name,
        chatId: group.chat_id,
        projectId: project.id,
        projectName: project.name,
        requester: t.requester,
        // ההצעה הגיעה כי לא היה ברור למי — אומרים את זה במפורש
        routedAsManager: !t.assignee,
        receivedAt: msg.at
      };
      D.run(
        `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
         VALUES (?, 'task', 'pending', '', ?, ?, '', ?, ?, ?, ?)`,
        target, headerId, msg.sender_name, t.title, msg.at, JSON.stringify(data), D.nowIso()
      );
      perUser.set(target, (perUser.get(target) ?? 0) + 1);
      log({
        channel: 'group', chatId: group.chat_id, chatName: group.name, userId: msg.user_id, who: msg.sender_name, text: msg.text,
        action: 'group_task', status: t.ambiguous.length ? 'unclear' : 'ok',
        result: `הצעה ל${nameOf(target)}${!direct ? ' (מזכירות — בקשה לפגישה)' : !t.assignee ? ' (כמנהל הפרויקט — לא ברור למי)' : ''}: ${t.title}`
      });
    }
  }
  if (!result.tasks.length) {
    log({ channel: 'group', chatId: group.chat_id, chatName: group.name, action: 'group_scan', status: 'ok', result: `נותחו ${fresh.length} הודעות — אין בקשות` });
  }
  if (result.warning) {
    log({ channel: 'group', chatId: group.chat_id, chatName: group.name, action: 'warning', status: 'denied', result: result.warning });
  }

  D.run(`UPDATE wa_messages SET processed = 1 WHERE id IN (${fresh.map(() => '?').join(',')})`, ...fresh.map((m) => m.id));

  for (const [userId, n] of perUser) {
    D.notify({
      targetType: 'user', targetId: userId, kind: 'ai',
      title: `💬 מקבוצת "${group.name}": ${n === 1 ? 'משימה ממתינה' : `${n} משימות ממתינות`} לאישורך`,
      body: `פרויקט ${project.name} · אישור, עריכה או דחייה — בדף הבית.`
    });
  }
  return perUser.size;
}

/** קבוצה נותחת אחרי הפסקה בשיחה — רצף הודעות נקרא יחד, עם ההקשר שלו */
async function processGroups() {
  const quiet = Math.max(0, Number(D.getSetting('wa_quiet_minutes', 3)) || 0) * 60000;
  const due = D.all(
    `SELECT g.* FROM wa_groups g
      WHERE g.status = 'active'
        AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.chat_id = g.chat_id AND m.processed = 0)
        AND (g.last_message_at IS NULL OR g.last_message_at <= ?)`,
    new Date(Date.now() - quiet).toISOString()
  );
  for (const g of due) {
    try {
      await processGroup(g);
    } catch (err) {
      // תקלה זמנית (AI עמוס, רשת) — ההודעות נשארות לא מעובדות ויינותחו בסבב הבא
      console.error(`[משימון] ניתוח קבוצת הוואטסאפ "${g.name}" נכשל:`, err.message);
      log({ channel: 'group', chatId: g.chat_id, chatName: g.name, action: 'group_scan', status: 'error', result: `הניתוח נכשל וינוסה שוב: ${err.message}` });
    }
  }
}

function prune() {
  D.run('DELETE FROM wa_messages WHERE at < ?', new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
  D.run("DELETE FROM wa_messages WHERE chat_id IN (SELECT chat_id FROM wa_groups WHERE status = 'ignored')");
  D.run('DELETE FROM wa_log WHERE at < ?', new Date(Date.now() - LOG_DAYS * DAY).toISOString());
}

function notifyAdmins(title, body) {
  for (const u of D.all("SELECT * FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
    const actor = Auth.loadActor('user', u.id);
    if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title, body });
  }
}

// ---------------------------------------------------------------------------
// ניהול הקבוצות
// ---------------------------------------------------------------------------

function listGroups() {
  const withPhone = orgUsers().filter((u) => u.phone);
  // הצעות לפי קבוצה ומצב — כמה הוצעו, אושרו, נדחו וממתינות
  const stats = new Map();
  for (const r of D.all(
    `SELECT json_extract(data, '$.chatId') AS chat_id, status, COUNT(*) AS n
       FROM ai_suggestions WHERE header_id LIKE 'wa:%' GROUP BY 1, 2`
  )) {
    const s = stats.get(r.chat_id) ?? { total: 0, approved: 0, rejected: 0, pending: 0 };
    s.total += r.n;
    if (r.status in s) s[r.status] += r.n;
    stats.set(r.chat_id, s);
  }
  return D.all(
    `SELECT g.*, p.name AS project_name, u.full_name AS bound_by_name,
            (SELECT COUNT(*) FROM wa_messages m WHERE m.chat_id = g.chat_id AND m.processed = 0) AS waiting
       FROM wa_groups g
       LEFT JOIN projects p ON p.id = g.project_id
       LEFT JOIN users u ON u.id = g.bound_by
      ORDER BY CASE g.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, g.last_message_at DESC`
  ).map((g) => {
    // מי מחברי הקבוצה רשום במשימון עם טלפון — רק להם הבוט מציע משימות
    const members = g.participants_at ? parseJson(g.participants, []) : null;
    return {
      chatId: g.chat_id,
      name: g.name,
      status: g.status,
      projectId: g.project_id,
      projectName: g.project_name,
      boundBy: g.bound_by_name,
      boundAt: g.bound_at,
      firstSeenAt: g.first_seen_at,
      lastMessageAt: g.last_message_at,
      waiting: g.waiting,
      members: members ? members.length : null,
      registered: members ? withPhone.filter((u) => members.includes(u.phone)).map((u) => u.full_name) : null,
      suggestions: stats.get(g.chat_id) ?? { total: 0, approved: 0, rejected: 0, pending: 0 }
    };
  });
}

/**
 * שיוך קבוצה לפרויקט, או התעלמות ממנה. בשיוך ראשון מנותח רק מה שנכתב בימים
 * האחרונים — לא כל ההיסטוריה שהצטברה מאז שהבוט צורף.
 */
function bindGroup(chatId, actor, { projectId = null, ignore = false } = {}) {
  const group = D.get('SELECT * FROM wa_groups WHERE chat_id = ?', chatId);
  if (!group) throw new Error('הקבוצה לא נמצאה');
  if (ignore) {
    D.run("UPDATE wa_groups SET status = 'ignored', project_id = NULL, bound_by = ?, bound_at = ? WHERE chat_id = ?", actor.id, D.nowIso(), chatId);
    D.run('DELETE FROM wa_messages WHERE chat_id = ?', chatId);
    return;
  }
  const project = D.get('SELECT id FROM projects WHERE id = ?', Number(projectId));
  if (!project) throw new Error('יש לבחור פרויקט');
  D.run("UPDATE wa_groups SET status = 'active', project_id = ?, bound_by = ?, bound_at = ? WHERE chat_id = ?", project.id, actor.id, D.nowIso(), chatId);
  if (group.status !== 'active') {
    D.run('UPDATE wa_messages SET processed = 1 WHERE chat_id = ? AND processed = 0 AND at < ?', chatId, new Date(Date.now() - BACKLOG_DAYS * DAY).toISOString());
  }
}


// ---------------------------------------------------------------------------
// יומן ושעות פעילות
// ---------------------------------------------------------------------------

const LOG_DAYS = 90;

/** שורה ביומן הבוט. יומן שנכשל אינו עוצר את הבוט */
function log(entry) {
  try {
    D.run(
      `INSERT INTO wa_log (at, channel, chat_id, chat_name, user_id, who, text, action, result, status, task_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      D.nowIso(), entry.channel, entry.chatId ?? '', String(entry.chatName ?? '').slice(0, 200), entry.userId ?? null,
      String(entry.who ?? '').slice(0, 120), String(entry.text ?? '').slice(0, 1000), entry.action ?? '',
      String(entry.result ?? '').slice(0, 1000), entry.status ?? 'ok', entry.taskId ?? null
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
    who: r.who, text: r.text, action: r.action, result: r.result, status: r.status, taskId: r.task_id
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

// ---------------------------------------------------------------------------
// שיחה פרטית — הפעולות
// ---------------------------------------------------------------------------

const INTENTS = ['create_task', 'my_tasks', 'complete', 'comment', 'project_tasks', 'send_email', 'today', 'today_email', 'menu', 'help', 'cancel', 'other'];

/** הכוונה ← הפעולה במסך הניהול שמפעילה אותה */
const ACTION_OF = { menu: 'today', today_email: 'today' };
const actionOf = (intent) => ACTION_OF[intent] ?? intent;

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    ready: { type: 'boolean' },
    reply: { type: 'string' },
    range: { type: 'string', enum: ['today', 'overdue', 'week', 'all'] },
    task_id: { type: 'integer', description: 'למשימה קיימת (סימון כבוצע, הערה): מזהה מהרשימות שסופקו, או 0' },
    comment: { type: 'string' },
    project_id: { type: 'integer', description: 'למשימות פרויקט: מזהה מרשימת הפרויקטים, או 0' },
    recipient_name: { type: 'string', description: 'במייל: שם הנמען כפי שנכתב ("אורן", "שושנה חן"). אחרת ריק' },
    recipient_org: { type: 'string', description: 'במייל: רק השם המזהה של החברה או המשרד ("כהן" מתוך "משרד עורכי הדין כהן"). אחרת ריק' },
    recipient_email: { type: 'string', description: 'במייל: כתובת אם נכתבה במפורש. אחרת ריק' },
    request: { type: 'string', description: 'במייל: מה לבקש או לכתוב לנמען, במילים של הכותב. אחרת ריק' },
    draft: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        assignee_user_id: { type: 'integer' },
        due_date: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
        project_id: { type: 'integer' },
        checklist: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'summary', 'assignee_user_id', 'due_date', 'priority', 'project_id', 'checklist'],
      additionalProperties: false
    }
  },
  required: ['intent', 'ready', 'reply', 'range', 'task_id', 'comment', 'project_id', 'recipient_name', 'recipient_org', 'recipient_email', 'request', 'draft'],
  additionalProperties: false
};

const YES = /^(כן|יאללה|אשר|מאשר|מאשרת|פתח|תפתח|פתחי|תפתחי|סגור|תסגור|אוקי|אוקיי|סבבה|ok|okay|yes|👍|✅)([\s,.!]|$)/i;
const CANCEL = /^(ביטול|בטל|עזוב|לא צריך)([\s,.!]|$)/;
// בלי AI עדיין אפשר לבקש את הרשימה ועזרה
const PLAIN_LIST = /^(המשימות שלי|משימות|מה יש לי)/;
const PLAIN_HELP = /^(עזרה|help|\?|מה אתה יודע)/i;

// ‎greetedOn‎ — היום שבו כבר הוצגו לו ה-Today והתפריט, כדי שהודעה ראשונה ביום תפתח בהם
const emptyChat = { draft: null, awaiting: false, history: [], lastList: [], greetedOn: '' };

function chatOf(userId) {
  const row = D.get('SELECT * FROM wa_chats WHERE user_id = ?', userId);
  if (!row) return { ...emptyChat };
  return {
    draft: parseJson(row.draft, null), awaiting: Boolean(row.awaiting), history: parseJson(row.history, []),
    lastList: parseJson(row.last_list, []), greetedOn: row.greeted_on ?? ''
  };
}

function saveChat(userId, { draft, awaiting, history, lastList, greetedOn = '' }) {
  D.run(
    `INSERT INTO wa_chats (user_id, draft, awaiting, history, last_list, greeted_on, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET draft = excluded.draft, awaiting = excluded.awaiting, history = excluded.history,
       last_list = excluded.last_list, greeted_on = excluded.greeted_on, updated_at = excluded.updated_at`,
    userId, draft ? JSON.stringify(draft) : '', awaiting ? 1 : 0, JSON.stringify(history.slice(-HISTORY_TURNS)),
    JSON.stringify(lastList ?? []), greetedOn ?? '', D.nowIso()
  );
}

const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
const PRIORITY = { urgent: 'דחוף', high: 'גבוהה', normal: 'רגילה' };
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

/** תאריך מקומי (YYYY-MM-DD) בעוד ‎days‎ ימים */
const localDay = (days = 0) => localDate(new Date(Date.now() + days * DAY)).date;
const dueDay = (t) => (t.dueDate ? localDate(new Date(t.dueDate)).date : null);

function draftText(draft, user) {
  const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name;
  const project = draft.projectId ? D.get('SELECT name FROM projects WHERE id = ?', draft.projectId)?.name : null;
  return [
    `📝 *${draft.title}*`,
    draft.summary || null,
    `👤 אחראי/ת: ${draft.assigneeId && draft.assigneeId !== user.id ? nameOf(draft.assigneeId) : 'את/ה'}`,
    `📅 יעד: ${draft.dueDate ? shortDate(draft.dueDate) : 'ללא'}`,
    `📁 פרויקט: ${project ?? 'ללא'}`,
    draft.priority !== 'normal' ? `⚡ עדיפות: ${PRIORITY[draft.priority]}` : null,
    draft.checklist.length ? `☑ ${draft.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : null,
    '',
    'לפתוח? השיבו *כן*, או כתבו מה לתקן.'
  ].filter((l) => l !== null).join('\n');
}

const LIST_SHOWN = 15;

function dueLabel(t) {
  const d = dueDay(t);
  if (!d) return '';
  if (d === localDay(0)) return 'היום';
  if (d === localDay(1)) return 'מחר';
  const [, mm, dd] = d.split('-');
  return `${Number(dd)}.${Number(mm)}`;
}

/** רשימה ממוספרת. המספרים הם מה ש"סיימתי את 2" מתייחס אליו */
function formatList(heading, tasks, { showProject = true, showAssignee = false, actor = null } = {}) {
  const shown = tasks.slice(0, LIST_SHOWN);
  const lines = shown.map((t, i) => {
    const due = dueLabel(t);
    return `${i + 1}. ${t.title}${due ? ` · 📅 ${due}` : ''}${t.overdue ? ' ⚠️' : ''}`
      + `${showProject && t.projectName ? ` · 📁 ${t.projectName}` : ''}${showAssignee && t.assignee ? ` · 👤 ${t.assignee}` : ''}`;
  });
  const more = tasks.length > shown.length ? `ועוד ${tasks.length - shown.length} — באפליקציה.` : null;
  const hint = actor && WaActions.allowed(actor, 'complete') ? 'לסגור משימה: "סיימתי את 1".' : null;
  return [heading, ...lines, more, hint ? '' : null, hint].filter((l) => l !== null).join('\n');
}

const RANGES = {
  today: { title: 'להיום', pick: (t) => dueDay(t) && dueDay(t) <= localDay(0), empty: 'אין לך משימות להיום 🎉' },
  overdue: { title: 'באיחור', pick: (t) => t.overdue, empty: 'אין לך משימות באיחור 👏' },
  week: { title: 'לשבוע הקרוב', pick: (t) => dueDay(t) && dueDay(t) <= localDay(7), empty: 'אין לך משימות לשבוע הקרוב.' },
  all: { title: 'הפתוחות', pick: () => true, empty: 'אין לך משימות פתוחות 🎉' }
};

function helpText(actor) {
  const actions = WaActions.forActor(actor);
  if (!actions.length) return 'כרגע אין פעולות זמינות לך בוואטסאפ.';
  return [
    'אני הבוט של משימון. אפשר לכתוב לי:',
    ...actions.filter((a) => a.key !== 'help').map((a) => `${a.icon} *${a.label}*${a.examples[0] ? ` — "${a.examples[0]}"` : ''}`),
    '',
    'בכל שלב: "ביטול".'
  ].join('\n');
}

async function understand(user, actor, state, text, projects, myOpen) {
  const users = orgUsers();
  const actions = WaActions.forActor(actor);
  const lastList = state.lastList
    .map((id, i) => ({ n: i + 1, id, title: D.get('SELECT title FROM tasks WHERE id = ?', id)?.title }))
    .filter((x) => x.title);
  const today = localDate();
  const prompt = [
    `תאריך היום: ${today.date} (${today.weekday})`,
    `הכותב: ${user.full_name} (מזהה ${user.id})`,
    '',
    'הפעולות שמופעלות לכותב (מפתח · שם · דוגמאות):',
    ...actions.map((a) => `${a.key} · ${a.label} · ${a.examples.join(' / ')}`),
    '',
    'העובדים (מזהה · שם · מחלקה):',
    ...users.map((u) => `${u.id} · ${u.full_name} · ${u.department ?? ''}`),
    '',
    'הפרויקטים (מזהה · שם):',
    ...(projects.length ? projects.map((p) => `${p.id} · ${p.name}`) : ['(אין)']),
    '',
    'המשימות הפתוחות של הכותב (מזהה · כותרת):',
    ...(myOpen.length ? myOpen.map((t) => `${t.id} · ${t.title}`) : ['(אין)']),
    '',
    'הרשימה האחרונה שנשלחה לו (מספר ברשימה → מזהה · כותרת):',
    ...(lastList.length ? lastList.map((x) => `${x.n} → ${x.id} · ${x.title}`) : ['(אין)']),
    '',
    `הטיוטה הנוכחית: ${state.draft && (state.draft.kind ?? 'task') === 'task' ? JSON.stringify(state.draft) : '(אין)'}`,
    '',
    'השיחה עד כה:',
    ...(state.history.length ? state.history.map((h) => `${h.role === 'bot' ? 'הבוט' : 'הכותב'}: ${h.text}`) : ['(התחלה)']),
    '',
    'ההודעה החדשה:',
    '<<<',
    text.slice(0, 3000),
    '>>>'
  ].join('\n');

  const out = await Claude.json({ system: fs.readFileSync(CHAT_SKILL, 'utf8'), content: [{ type: 'text', text: prompt }], schema: CHAT_SCHEMA, effort: 'low' });
  const ids = new Set(users.map((u) => u.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const d = out.draft ?? {};
  return {
    intent: INTENTS.includes(out.intent) ? out.intent : 'other',
    ready: Boolean(out.ready),
    reply: String(out.reply ?? '').trim().slice(0, 1000),
    range: RANGES[out.range] ? out.range : 'today',
    taskId: Number(out.task_id) || 0,
    comment: String(out.comment ?? '').trim().slice(0, 2000),
    projectId: projectIds.has(Number(out.project_id)) ? Number(out.project_id) : 0,
    recipient: {
      name: String(out.recipient_name ?? '').trim().slice(0, 80),
      org: String(out.recipient_org ?? '').trim().slice(0, 80),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(out.recipient_email ?? '').trim()) ? String(out.recipient_email).trim().toLowerCase() : ''
    },
    request: String(out.request ?? '').trim().slice(0, 2000),
    draft: {
      kind: 'task',
      title: String(d.title ?? '').trim().slice(0, 120),
      summary: String(d.summary ?? '').trim().slice(0, 1500),
      assigneeId: ids.has(Number(d.assignee_user_id)) ? Number(d.assignee_user_id) : 0,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.due_date ?? '')) ? d.due_date : '',
      priority: ['normal', 'high', 'urgent'].includes(d.priority) ? d.priority : 'normal',
      projectId: projectIds.has(Number(d.project_id)) ? Number(d.project_id) : 0,
      checklist: (d.checklist ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
    }
  };
}

// ---------------------------------------------------------------------------
// היום שלי ותפריט
// ---------------------------------------------------------------------------

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/** מה אפשר לבחור בתפריט — רק פעולות שמופעלות לכותב */
function menuOptions(actor) {
  return [
    ['today', 'today', '☀️ מה יש לי היום'],
    ['send_email', 'send_email', '✉️ לשלוח מייל לאיש קשר'],
    ['create_task', 'create_task', '📝 לפתוח משימה'],
    ['my_tasks', 'my_tasks', '📋 כל המשימות הפתוחות שלי'],
    ['overdue', 'my_tasks', '⚠️ מה באיחור'],
    ['project_tasks', 'project_tasks', '📁 מה פתוח בפרויקט'],
    ['today_email', 'today', '📧 לשלוח לי את Today במייל']
  ].filter(([, action]) => WaActions.allowed(actor, action)).map(([key, , label]) => ({ key, label }));
}

const menuText = (options) => [
  '*במה אפשר לעזור היום?*',
  ...options.map((o, i) => `${KEYCAPS[i] ?? `${i + 1}.`} ${o.label}`),
  '',
  'השיבו במספר, או פשוט כתבו לי.'
].join('\n');

const timeOf = (iso) => new Date(iso).toLocaleTimeString('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * ה-Today בוואטסאפ — אותו ‎Today.build‎ של המסך ושל מייל הבוקר, כדי שכולם
 * יראו אותו דבר. המשימות ממוספרות, ו"סיימתי את 2" מתייחס אליהן.
 */
async function todayText(actor) {
  const Today = require('../today'); // בעצלתיים: ‎today.js‎ טוען את סריקת המיילים, שטוענת את הבוט
  const t = await Today.build(actor);
  const now = new Date();
  const events = t.calendar.events.filter((e) => e.allDay || new Date(e.end) > now);
  const tasks = [...t.tasks.overdue.map((x) => ({ ...x, overdue: true })), ...t.tasks.today];
  const shown = tasks.slice(0, LIST_SHOWN);
  const lines = [`☀️ *היום — ${t.dateLabel}*`];
  if (events.length) {
    lines.push('', `📅 *ביומן* (${events.length}):`, ...events.slice(0, 8).map((e) => `• ${e.allDay ? 'כל היום' : timeOf(e.start)} ${e.title}`));
  }
  if (shown.length) {
    lines.push('', `📋 *משימות* (${tasks.length}${t.counts.overdue ? `, מהן ${t.counts.overdue} באיחור` : ''}):`,
      ...shown.map((x, i) => `${i + 1}. ${x.title}${x.overdue ? ` · ⚠️ ${dueLabel(x)}` : ''}${x.projectName ? ` · 📁 ${x.projectName}` : ''}`));
    if (tasks.length > shown.length) lines.push(`ועוד ${tasks.length - shown.length} — באפליקציה.`);
  }
  if (t.counts.mail) lines.push('', `📧 ${t.counts.mail === 1 ? 'מייל אחד מחכה' : `${t.counts.mail} מיילים מחכים`} להחלטה — ב"ממתין לאישורך" באפליקציה.`);
  if (t.counts.meetings) lines.push(`🗓 ${t.counts.meetings === 1 ? 'פגישה אחת מחכה' : `${t.counts.meetings} פגישות מחכות`} להחלטה.`);
  if (!events.length && !tasks.length && !t.counts.mail && !t.counts.meetings) lines.push('', 'אין לך משהו מתוכנן להיום 🎉');
  return { text: lines.join('\n'), ids: shown.map((x) => x.id) };
}

// ---------------------------------------------------------------------------
// מייל לאיש קשר
// ---------------------------------------------------------------------------

const PICK_SHOWN = 8;
// מילים שאינן מזהות חברה — "משרד עורכי הדין כהן" מזוהה לפי "כהן"
const ORG_NOISE = new Set(['משרד', 'עורכי', 'עורך', 'דין', 'עוד', 'עו״ד', 'חברת', 'חברה', 'קבוצת', 'בעמ', 'של', 'מהמשרד', 'ממשרד', 'מחברת', 'מהחברה', 'יועץ', 'היועץ']);

/**
 * הנמען לפי שם, ואם נאמרה חברה — רק מי שהחברה מופיעה אצלו (בארגון, בתפקיד
 * או בכתובת). רק מי שיש לו מייל, או עובד בארגון.
 */
function findRecipients(actor, name, org = '') {
  const results = (hooks.mail?.searchContacts(actor, name || org) ?? []).filter((c) => c.email || c.type === 'user');
  const tokens = GContacts.fold(org).split(/\s+/).map((w) => w.replace(/^(מה|מ|ה|ב|ל)(?=\S{3})/, '')).filter((w) => w.length >= 2 && !ORG_NOISE.has(w));
  if (!name || !tokens.length) return results;
  const narrowed = results.filter((c) => {
    const hay = GContacts.fold([c.name, c.organization, c.title, ...(c.emails ?? []).map((e) => e.value)].join(' '));
    return tokens.some((tk) => hay.includes(tk));
  });
  return narrowed.length ? narrowed : results;
}

const contactOf = (c) => ({ name: c.name, email: c.email ?? '', phone: c.phone ?? '', type: c.type, refId: c.refId ?? null, organization: c.organization ?? '' });

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

function emailText(p) {
  const internal = p.contact.type === 'user';
  const lines = [
    `✉️ *טיוטה ל${p.contact.name || p.contact.email}*${!internal && p.contact.email ? ` <${p.contact.email}>` : ''}`,
    internal ? '👤 עובד/ת בארגון — לא יישלח מייל: המשימה תשויך במשימון, עם התראה.' : `*נושא:* ${p.draft.subject}`,
    '',
    p.draft.body.slice(0, 2500)
  ];
  if (p.suggestions.length) {
    lines.push('', '💡 *מההתכתבות האחרונה — אולי להוסיף:*', ...p.suggestions.map((x, i) => `${i + 1}. ${x}`));
  }
  if (p.notes) lines.push('', `ℹ️ ${p.notes}`);
  lines.push('', `${internal ? 'להעביר' : 'לשלוח'}? השיבו *כן*, כתבו מה לתקן${p.suggestions.length ? ', או "תוסיף את 1"' : ''}. *ביטול* — לא ${internal ? 'להעביר' : 'לשלוח'}.`);
  return lines.join('\n');
}

/** טיוטה (או תיקון שלה) — עם ההתכתבות האחרונה עם הנמען, להצעות מה להוסיף */
async function draftEmail(actor, contact, instruction, { feedback = '', previous = null } = {}) {
  const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
  const context = contact.type === 'user' || previous ? '' : await AiTasks.mailContext(actor.id, contact.email);
  const d = await AiTasks.draftInitial({
    owner, instruction, contact, channel: 'email', context,
    feedback, previous: previous ? previous.draft : null
  });
  const suggestions = (Array.isArray(d.suggestions) ? d.suggestions : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
  return {
    kind: 'email',
    instruction,
    contact,
    draft: {
      title: String(d.title ?? '').trim().slice(0, 120),
      goal: String(d.goal ?? '').trim(),
      success_criteria: String(d.success_criteria ?? '').trim(),
      subject: String(d.subject ?? '').trim().slice(0, 200),
      body: String(d.body ?? '').trim()
    },
    // בתיקון ההתכתבות אינה נקראת שוב — ההצעות שעוד לא נוספו נשארות
    suggestions: previous ? (suggestions.length ? suggestions : previous.suggestions.filter((x) => !feedback.includes(x))) : suggestions,
    notes: String(d.notes ?? '').trim().slice(0, 300)
  };
}

/** הבקשה להוסיף הצעה לפי מספר: "תוסיף את 1", "1 ו-3", "2" */
function suggestionFeedback(text, suggestions) {
  const m = /^(?:כן[\s,]*)?(?:תוסיף|תוסיפי|הוסף|להוסיף|גם)?\s*(?:את)?\s*((?:\d\s*(?:,|ו-?|\s)?\s*)+)$/.exec(text.trim());
  if (!m || !suggestions.length) return null;
  const picked = [...new Set((m[1].match(/\d/g) ?? []).map(Number))].map((n) => suggestions[n - 1]).filter(Boolean);
  return picked.length ? `הוסף למייל: ${picked.join('; ')}` : null;
}

function createFromDraft(actor, draft) {
  const assignee = draft.assigneeId || actor.id;
  return hooks.createTask(actor, {
    title: draft.title,
    description: [draft.summary, '', '💬 נפתחה מוואטסאפ'].join('\n').trim(),
    projectId: draft.projectId || null,
    assigneeType: 'user',
    assigneeId: assignee,
    // מי שפתח למישהו אחר נשאר שותף — אחרת המשימה נעלמת לו מהעיניים
    extraAssignees: assignee !== actor.id ? [{ type: 'user', id: actor.id }] : [],
    priority: draft.priority,
    dueDate: draft.dueDate ? new Date(`${draft.dueDate}T17:00:00+03:00`).toISOString() : null,
    checklist: draft.checklist,
    source: 'whatsapp',
    sourceUserId: actor.id,
    auditNote: 'המשימה נפתחה מוואטסאפ'
  });
}

const taskLink = (id) => {
  const root = String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return root ? `${root}/?task=${id}` : null;
};

/** ביצוע מה שהעובד אישר ב"כן". בבדיקה ממסך הניהול (‎dry‎) — רק מתארים */
async function confirmPending(actor, pending, dry) {
  const kind = pending.kind ?? 'task';
  const action = { task: 'create_task', email: 'send_email' }[kind] ?? kind;
  if (!WaActions.allowed(actor, action)) {
    return { reply: 'הפעולה הזו כבר אינה זמינה לך בוואטסאפ.', action, status: 'denied', result: 'הפעולה כובתה' };
  }
  const test = dry ? ' (בדיקה — לא בוצע באמת)' : '';
  try {
    if (kind === 'task') {
      const id = dry ? null : createFromDraft(actor, pending);
      const link = id ? taskLink(id) : null;
      return { reply: `✅ נפתחה משימה: ${pending.title}${test}${link ? `\n${link}` : ''}`, action, status: 'ok', result: `נפתחה משימה: ${pending.title}`, taskId: id };
    }
    if (kind === 'complete') {
      if (!dry) hooks.tasks.complete(actor, pending.taskId);
      return { reply: `✅ סומן כבוצע: ${pending.title}${test}`, action, status: 'ok', result: `נסגרה: ${pending.title}`, taskId: pending.taskId };
    }
    if (kind === 'comment') {
      if (!dry) hooks.tasks.comment(actor, pending.taskId, pending.text);
      return { reply: `💬 ההערה נוספה ל: ${pending.title}${test}`, action, status: 'ok', result: `הערה ל"${pending.title}": ${pending.text}`, taskId: pending.taskId };
    }
    if (kind === 'email') {
      const who = pending.contact.name || pending.contact.email;
      const internal = pending.contact.type === 'user';
      if (!P.may(actor, 'create_task')) throw new Error('אין לך הרשאה לפתוח משימות');
      // אותה פתיחה של האשף באפליקציה: משימת AI שעוקבת אחרי התשובה
      const r = dry ? { taskId: null, sendError: null } : await hooks.mail.createAiTask(actor, {
        instruction: pending.instruction, draft: pending.draft, contact: pending.contact, channel: 'email'
      });
      const link = r.taskId ? taskLink(r.taskId) : null;
      if (r.sendError) {
        return { reply: `⚠️ המשימה נפתחה, אבל המייל לא יצא: ${r.sendError}\nאפשר לשלוח שוב מכרטיס המשימה.${link ? `\n${link}` : ''}`, action, status: 'error', result: `המייל ל${who} לא יצא: ${r.sendError}`, taskId: r.taskId };
      }
      return {
        reply: `${internal ? `👤 הועבר ל${who} — המשימה אצלו/ה במשימון.` : `📧 נשלח ל${who}. אעקוב אחרי התשובה ואעדכן אותך.`}${test}${link ? `\n${link}` : ''}`,
        action, status: 'ok', result: `${internal ? 'הועבר' : 'נשלח מייל'} ל${who}: ${pending.draft.subject || pending.draft.title}`, taskId: r.taskId
      };
    }
  } catch (err) {
    // הרשאה, תלות שלא הושלמה, משימה שנסגרה בינתיים — העובד שומע למה
    return { reply: `❌ לא הצלחתי: ${err.message}`, action, status: 'error', result: err.message, keep: kind === 'task' || kind === 'email' };
  }
  return { reply: 'לא ברור מה לאשר.', action, status: 'unclear', result: '' };
}

/**
 * הודעה אחת בשיחה פרטית: מה עונים, ומה המצב אחריה. אינה שולחת ואינה שומרת —
 * כך אותה פונקציה משמשת גם את תיבת הבדיקה במסך הניהול.
 */
async function converse(user, actor, text, state, { dry = false } = {}) {
  const t = text.trim();
  const keep = { draft: state.draft, awaiting: false, lastList: state.lastList, greetedOn: state.greetedOn ?? '' };
  const out = (reply, next, meta) => ({ reply, next: { ...keep, ...next }, ...meta });

  if (state.awaiting && state.draft && YES.test(t)) {
    const r = await confirmPending(actor, state.draft, dry);
    return out(r.reply, { draft: r.keep ? state.draft : null, awaiting: Boolean(r.keep) }, r);
  }
  if (CANCEL.test(t)) return out('בוטל 👍', { draft: null }, { action: 'cancel', status: 'ok', result: 'בוטל' });

  const kind = state.draft?.kind;

  const projects = (hooks.listProjectsFor?.(actor) ?? []).filter((p) => p.status === 'active').slice(0, 80);
  const myOpen = hooks.tasks?.myTasks(actor) ?? [];
  const listReply = (range) => {
    const r = RANGES[range];
    const tasks = myOpen.filter(r.pick);
    if (!tasks.length) return out(r.empty, {}, { action: 'my_tasks', status: 'ok', result: r.empty });
    return out(formatList(`📋 המשימות שלך ${r.title} (${tasks.length}):`, tasks, { actor }), { lastList: tasks.slice(0, LIST_SHOWN).map((x) => x.id) },
      { action: 'my_tasks', status: 'ok', result: `נשלחה רשימה ${r.title}: ${tasks.length} משימות` });
  };
  if (kind === 'menu' && /^\d$/.test(t) && ['my_tasks', 'overdue'].includes(state.draft.options?.[Number(t) - 1])) {
    const key = state.draft.options[Number(t) - 1];
    const r = listReply(key === 'overdue' ? 'overdue' : 'all');
    return { ...r, next: { ...r.next, draft: null } };
  }

  /** ה-Today, ואחריו התפריט כשמבקשים. המשימות בו הן "הרשימה האחרונה" */
  const todayReply = async ({ withMenu = true, prefix = '' } = {}) => {
    const options = menuOptions(actor);
    let today = null;
    if (WaActions.allowed(actor, 'today')) {
      try {
        today = await todayText(actor);
      } catch (err) {
        console.error('[משימון] ה-Today לבוט נכשל:', err.message);
      }
    }
    const parts = [prefix || null, today?.text ?? null, withMenu && options.length ? menuText(options) : null].filter(Boolean);
    if (!parts.length) return out(helpText(actor), {}, { action: 'help', status: 'ok', result: 'עזרה' });
    return out(parts.join('\n\n'), {
      ...(today ? { lastList: today.ids } : {}),
      ...(withMenu && options.length ? { draft: { kind: 'menu', options: options.map((o) => o.key) } } : {}),
      greetedOn: localDay(0)
    }, { action: 'today', status: 'ok', result: `Today${withMenu ? ' ותפריט' : ''}: ${today?.ids.length ?? 0} משימות` });
  };

  const sendTodayEmail = async () => {
    if (dry) return out('📧 ה-Today נשלח אליך במייל (בדיקה — לא נשלח באמת)', {}, { action: 'today', status: 'ok', result: 'Today במייל' });
    const Today = require('../today');
    const r = await Today.sendDigest(actor.id, { force: true }).catch((err) => ({ sent: false, reason: err.message }));
    if (r.sent) return out('📧 שלחתי לך את ה-Today במייל.', {}, { action: 'today', status: 'ok', result: 'Today במייל' });
    return out(`לא הצלחתי לשלוח את ה-Today במייל: ${r.reason}`, {}, { action: 'today', status: 'error', result: r.reason });
  };

  /** מייל לאיש קשר: חיפוש הנמען, ובהתאמה אחת — ישר לטיוטה */
  const startEmail = async ({ name, org, email }, request) => {
    if (!hooks.mail) return out('שליחת מיילים מהבוט אינה זמינה כרגע.', {}, { action: 'send_email', status: 'error', result: 'אין חיבור לאשף' });
    const ask = (reply, result) => out(reply, { draft: { kind: 'email_pick', name, request, candidates: [] } }, { action: 'send_email', status: 'unclear', result });
    if (!email && !name && !org) return out('למי לשלוח?', {}, { action: 'send_email', status: 'unclear', result: 'חסר נמען' });
    const candidates = email
      ? [{ name: name || email, email, type: 'external' }]
      : findRecipients(actor, name, org).map(contactOf);
    if (!candidates.length) {
      const where = GContacts.status(actor.id).available ? 'באנשי הקשר שלך ב-Google ובמשימון' : 'במשימון (אנשי הקשר של Google לא מחוברים)';
      return ask(`לא מצאתי את "${[name, org].filter(Boolean).join(' · ')}" ${where}.\nכתבו שם אחר, או את כתובת המייל.`, 'הנמען לא נמצא');
    }
    if (candidates.length > 1) {
      return out(pickText(name || org, candidates), { draft: { kind: 'email_pick', name: name || org, request, candidates: candidates.slice(0, PICK_SHOWN) } },
        { action: 'send_email', status: 'unclear', result: `${candidates.length} נמענים אפשריים ל"${name || org}"` });
    }
    return composeTo(candidates[0], request);
  };

  const composeTo = async (contact, request) => {
    if (contact.type !== 'user' && !Gmail.canSend(actor.id)) {
      return out('כדי לשלוח מייל מהבוט צריך לחבר את תיבת ה-Gmail שלך באפליקציה: "החשבון שלי ← Gmail ועוזר ה-AI".', { draft: null },
        { action: 'send_email', status: 'error', result: 'Gmail לא מחובר לשליחה' });
    }
    if (!request) {
      return out(`מה לכתוב ל${contact.name || contact.email}?`, { draft: { kind: 'email_pick', name: contact.name, request: '', candidates: [contact] } },
        { action: 'send_email', status: 'unclear', result: 'חסר תוכן' });
    }
    const pending = await draftEmail(actor, contact, request);
    return out(emailText(pending), { draft: pending, awaiting: true },
      { action: 'send_email', status: 'ok', result: `טיוטת מייל ל${contact.name || contact.email}: ${pending.draft.subject}${pending.suggestions.length ? ` · ${pending.suggestions.length} הצעות` : ''}` });
  };

  // טיוטת מייל שממתינה: כל הודעה שאינה "כן" או "ביטול" היא תיקון
  if (kind === 'email' && state.awaiting && Claude.isEnabled() && WaActions.allowed(actor, 'send_email')) {
    const feedback = suggestionFeedback(t, state.draft.suggestions ?? []) ?? t;
    const pending = await draftEmail(actor, state.draft.contact, state.draft.instruction, { feedback, previous: state.draft });
    return out(emailText(pending), { draft: pending, awaiting: true }, { action: 'send_email', status: 'ok', result: `תיקון טיוטה: ${feedback.slice(0, 200)}` });
  }

  // בחירת הנמען מהרשימה: מספר, כתובת מייל, או שם מלא יותר
  if (kind === 'email_pick' && Claude.isEnabled() && WaActions.allowed(actor, 'send_email')) {
    const pick = state.draft;
    if (/^\d{1,2}$/.test(t) && pick.candidates.length) {
      const c = pick.candidates[Number(t) - 1];
      if (!c) return out(`בחרו מספר מ-1 עד ${pick.candidates.length}.`, {}, { action: 'send_email', status: 'unclear', result: 'מספר לא ברשימה' });
      return composeTo(c, pick.request);
    }
    const mail = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.exec(t)?.[0];
    if (mail) return startEmail({ name: pick.name, org: '', email: mail.toLowerCase() }, pick.request);
    // נמען כבר ידוע ורק חסר תוכן — ההודעה היא התוכן
    if (pick.candidates.length === 1 && !pick.request) return composeTo(pick.candidates[0], t);
    if (t.split(/\s+/).length <= 4) {
      const found = findRecipients(actor, t).map(contactOf);
      if (found.length) return startEmail({ name: t, org: '', email: '' }, pick.request);
    }
    // אחרת — אולי בקשה חדשה; ה-AI יחליט
  }

  // בחירה מהתפריט במספר
  if (kind === 'menu' && /^\d$/.test(t)) {
    const key = state.draft.options?.[Number(t) - 1];
    const go = (reply) => out(reply, { draft: null }, { action: 'menu', status: 'ok', result: `תפריט: ${key}` });
    switch (key) {
      case 'today': return todayReply({ withMenu: false });
      case 'today_email': return sendTodayEmail();
      case 'send_email': return go('למי לשלוח, ומה לבקש?\nלמשל: "לאורן ממשרד עורכי הדין כהן — שיעביר לי את טיוטת ההסכם"');
      case 'create_task': return go('מה המשימה? אפשר לציין למי ועד מתי.\nלמשל: "לשושנה לפנות ליועץ הסניטרי, עד חמישי"');
      case 'project_tasks': return go('באיזה פרויקט?');
      default:
        return out(`בחרו מספר מ-1 עד ${state.draft.options?.length ?? 1}.`, {}, { action: 'menu', status: 'unclear', result: 'מספר לא בתפריט' });
    }
  }

  if (!Claude.isEnabled()) {
    if (PLAIN_HELP.test(t) && WaActions.allowed(actor, 'help')) return out(helpText(actor), {}, { action: 'help', status: 'ok', result: 'עזרה' });
    if (PLAIN_LIST.test(t) && WaActions.allowed(actor, 'my_tasks')) return listReply('all');
    return out('חיבור ה-AI אינו מוגדר כרגע במשימון. אפשר לכתוב "המשימות שלי" או "עזרה".', {}, { action: 'other', status: 'error', result: 'אין AI' });
  }

  const u = await understand(user, actor, state, t, projects, myOpen);
  if (u.intent === 'cancel') return out('בוטל 👍', { draft: null }, { action: 'cancel', status: 'ok', result: 'בוטל' });
  // "היי", "מה נשמע", או משהו שאינו פעולה — ובהודעה הראשונה של היום: ה-Today והתפריט
  const firstToday = state.greetedOn !== localDay(0);
  if (u.intent === 'menu' || (u.intent === 'other' && firstToday)) {
    if (WaActions.allowed(actor, 'today') || menuOptions(actor).length) {
      const hello = firstToday ? `${localDate().time < '12:00' ? 'בוקר טוב' : 'שלום'} ${firstName(user.full_name)} 👋` : '';
      return todayReply({ prefix: u.intent === 'other' && u.reply ? u.reply : hello });
    }
  }
  if (u.intent === 'other') {
    const options = menuOptions(actor);
    if (options.length) {
      return out([u.reply, menuText(options)].filter(Boolean).join('\n\n'), { draft: { kind: 'menu', options: options.map((o) => o.key) } },
        { action: 'other', status: 'unclear', result: 'לא זוהתה פעולה — הוצג התפריט' });
    }
    return out(u.reply || helpText(actor), {}, { action: 'other', status: 'unclear', result: 'לא זוהתה פעולה' });
  }
  if (!WaActions.allowed(actor, actionOf(u.intent))) {
    const label = WaActions.byKey(actionOf(u.intent))?.label ?? u.intent;
    return out(`הפעולה "${label}" אינה זמינה לך בוואטסאפ.`, {}, { action: u.intent, status: 'denied', result: 'פעולה כבויה או לא מורשית' });
  }

  switch (u.intent) {
    case 'menu':
    case 'today':
      return todayReply({ withMenu: u.intent === 'menu' || firstToday });

    case 'today_email':
      return sendTodayEmail();

    case 'send_email':
      if (!P.may(actor, 'create_task')) return out('אין לך הרשאה לפתוח משימות, ולכן גם לא לשלוח מייל מהבוט.', {}, { action: 'send_email', status: 'denied', result: 'אין הרשאת פתיחת משימה' });
      if (!u.ready && u.reply && !u.recipient.name && !u.recipient.email && !u.recipient.org) {
        return out(u.reply, { draft: null }, { action: 'send_email', status: 'unclear', result: 'חסרים פרטים' });
      }
      return startEmail(u.recipient, u.request);

    case 'help':
      return out(helpText(actor), {}, { action: 'help', status: 'ok', result: 'עזרה' });

    case 'my_tasks':
      return listReply(u.range);

    case 'project_tasks': {
      const project = projects.find((p) => p.id === u.projectId);
      if (!project) return out(u.reply || 'באיזה פרויקט?', {}, { action: 'project_tasks', status: 'unclear', result: 'הפרויקט לא זוהה' });
      const tasks = hooks.tasks.projectTasks(actor, project.id);
      if (!tasks.length) return out(`אין משימות פתוחות ב${project.name}.`, {}, { action: 'project_tasks', status: 'ok', result: `${project.name}: אין פתוחות` });
      return out(formatList(`📁 ${project.name} — פתוחות (${tasks.length}):`, tasks, { showProject: false, showAssignee: true, actor }),
        { lastList: tasks.slice(0, LIST_SHOWN).map((x) => x.id) },
        { action: 'project_tasks', status: 'ok', result: `${project.name}: ${tasks.length} משימות` });
    }

    case 'complete':
    case 'comment': {
      // רק משימה מהרשימות שהעובד ראה, ורק כזו שמותר לו לראות — לא מזהה שה-AI המציא
      const known = new Set([...myOpen.map((x) => x.id), ...state.lastList]);
      const task = known.has(u.taskId) && hooks.tasks.canSee(actor, u.taskId) ? D.get('SELECT id, title FROM tasks WHERE id = ?', u.taskId) : null;
      if (!task) return out(u.reply || 'איזו משימה? כתבו את המספר מהרשימה, או "המשימות שלי".', {}, { action: u.intent, status: 'unclear', result: 'המשימה לא זוהתה' });
      if (u.intent === 'complete') {
        return out(`לסמן כבוצע: *${task.title}*?\nהשיבו *כן*.`, { draft: { kind: 'complete', taskId: task.id, title: task.title }, awaiting: true },
          { action: 'complete', status: 'ok', result: `ממתין לאישור סגירה: ${task.title}`, taskId: task.id });
      }
      if (!u.comment) return out(u.reply || `מה לכתוב בהערה ל"${task.title}"?`, {}, { action: 'comment', status: 'unclear', result: 'חסר תוכן' });
      return out(`להוסיף ל-*${task.title}* את ההערה:\n"${u.comment}"\nהשיבו *כן*.`, { draft: { kind: 'comment', taskId: task.id, title: task.title, text: u.comment }, awaiting: true },
        { action: 'comment', status: 'ok', result: `ממתין לאישור הערה: ${task.title}`, taskId: task.id });
    }

    case 'create_task':
    default:
      if (u.ready && u.draft.title) return out(draftText(u.draft, user), { draft: u.draft, awaiting: true }, { action: 'create_task', status: 'ok', result: `טיוטה: ${u.draft.title}` });
      return out(u.reply || 'מה לכתוב בכותרת המשימה?', { draft: u.draft.title ? u.draft : null },
        { action: 'create_task', status: 'unclear', result: 'חסרים פרטים' });
  }
}

/** למספר שאינו מוכר עונים פעם ביום — לא יותר, כדי לא לנהל שיחה עם זרים */
const unknownReplied = new Map();

async function handleDirect(msg) {
  const user = userByPhone(msg.phone);
  if (!user) {
    log({ channel: 'private', chatId: msg.chatId, who: msg.phone, text: msg.text, action: 'unknown', status: 'denied', result: 'מספר לא מוכר' });
    const last = unknownReplied.get(msg.phone) ?? 0;
    if (Date.now() - last > DAY) {
      unknownReplied.set(msg.phone, Date.now());
      await sendText(msg.chatId, 'שלום! אני הבוט של משימון. המספר הזה אינו מוכר במערכת. כדי לעבוד איתי, בקשו ממנהל המערכת להוסיף את הטלפון שלכם בפרופיל.');
    }
    return;
  }
  const actor = Auth.loadActor('user', user.id);
  if (!actor) return;
  const base = { channel: 'private', chatId: msg.chatId, userId: user.id, who: user.full_name, text: msg.text };

  if (!msg.text) {
    log({ ...base, text: `[${msg.kind || 'הודעה ללא טקסט'}]`, action: 'other', status: 'unclear', result: 'לא טקסט' });
    await sendText(msg.chatId, msg.kind === 'audioMessage' ? 'עדיין אינני מבין הודעות קוליות. כתבו לי בטקסט 🙏' : 'כתבו לי בטקסט 🙏');
    return;
  }

  const state = chatOf(user.id);
  let r;
  try {
    r = await converse(user, actor, msg.text, state);
  } catch (err) {
    console.error('[משימון] בוט הוואטסאפ לא הבין הודעה:', err.message);
    log({ ...base, action: 'other', status: 'error', result: err.message });
    await sendText(msg.chatId, 'משהו השתבש אצלי. נסו שוב בעוד רגע.');
    return;
  }
  const history = [...state.history, { role: 'user', text: msg.text.slice(0, 500) }, { role: 'bot', text: r.reply.slice(0, 500) }];
  saveChat(user.id, { ...r.next, history });
  log({ ...base, action: r.action, status: r.status, result: r.result, taskId: r.taskId ?? null });
  await sendText(msg.chatId, r.reply);
}

/** הודעות פרטיות שהגיעו מחוץ לשעות — נשמרות עד שהחלון נפתח */
function defer(messages) {
  for (const m of messages) {
    D.run('INSERT OR IGNORE INTO wa_messages (chat_id, message_id, sender_phone, text, at, processed) VALUES (?,?,?,?,?,0)',
      m.chatId, m.id, m.phone, JSON.stringify(m), D.nowIso());
  }
}

function takeDeferred() {
  const rows = D.all("SELECT * FROM wa_messages WHERE chat_id LIKE '%@c.us' ORDER BY at");
  if (rows.length) D.run(`DELETE FROM wa_messages WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
  return rows.map((r) => parseJson(r.text, null)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// סיכום בוקר
// ---------------------------------------------------------------------------

async function sendSummaries() {
  if (!WaActions.byKey('summary')?.enabled || !hooks.tasks) return;
  const now = localDate();
  if (now.weekday === 'Friday' || now.weekday === 'Saturday') return;
  if (now.time < String(D.getSetting('wa_summary_time', '08:00'))) return;
  if (D.getSetting('wa_summary_sent', '') === now.date) return;
  // מסמנים לפני השליחה: תקלה באמצע לא תשלח לחצי מהעובדים פעמיים
  D.setSetting('wa_summary_sent', now.date);

  for (const u of orgUsers().filter((x) => x.phone)) {
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
// קיבלת משימה
// ---------------------------------------------------------------------------

const OUTBOX_DAYS = 3;

/** אחרי ההודעה, "סיימתי את 1" ו"תוסיף ל-1" מתייחסים למשימה שהתקבלה */
function sendProactive(userId, chatId, text, { taskId = null, action = 'assignment_notice', who = '' } = {}) {
  return sendText(chatId, text).then(() => {
    if (taskId) saveChat(userId, { ...chatOf(userId), lastList: [taskId] });
    log({ channel: 'summary', chatId, userId, who, action, status: 'ok', result: text.split('\n')[0].slice(0, 300), taskId });
  }).catch((err) => {
    log({ channel: 'summary', chatId, userId, who, action, status: 'error', result: err.message, taskId });
  });
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
    if (inHours()) {
      void sendProactive(u.id, chatId, text, { taskId: task.id, who: u.full_name });
    } else {
      D.run('INSERT INTO wa_outbox (user_id, chat_id, text, task_id, action, created_at) VALUES (?,?,?,?,?,?)',
        u.id, chatId, text, task.id, 'assignment_notice', D.nowIso());
    }
  } catch (err) {
    console.error('[משימון] הודעת "קיבלת משימה" בוואטסאפ נכשלה:', err.message);
  }
}

/** מה שנשמר מחוץ לשעות — נשלח כשהחלון נפתח. ישן מדי כבר אינו חדשות */
async function flushOutbox() {
  D.run('DELETE FROM wa_outbox WHERE created_at < ?', new Date(Date.now() - OUTBOX_DAYS * DAY).toISOString());
  for (const row of D.all('SELECT * FROM wa_outbox ORDER BY id LIMIT 30')) {
    D.run('DELETE FROM wa_outbox WHERE id = ?', row.id);
    await sendProactive(row.user_id, row.chat_id, row.text, { taskId: row.task_id, action: row.action, who: nameOf(row.user_id) });
  }
}

// ---------------------------------------------------------------------------
// בדיקה ממסך הניהול — בלי וואטסאפ ובלי לבצע
// ---------------------------------------------------------------------------

const sims = new Map();

/** שיחה פרטית מדומה בשם עובד. המצב נשמר בזיכרון, כך שאפשר לבדוק גם "כן" */
async function simulate(admin, { userId, text, reset = false }) {
  const user = D.get("SELECT id, full_name FROM users WHERE id = ? AND status = 'active'", Number(userId));
  if (!user) throw new Error('העובד לא נמצא');
  const actor = Auth.loadActor('user', user.id);
  const key = `${admin.id}:${user.id}`;
  if (reset) sims.delete(key);
  if (!String(text ?? '').trim()) return { reply: '', reset: true };
  const state = sims.get(key) ?? { ...emptyChat, lastList: chatOf(user.id).lastList };
  const r = await converse(user, actor, String(text), state, { dry: true });
  sims.set(key, { ...r.next, history: [...state.history, { role: 'user', text: String(text).slice(0, 500) }, { role: 'bot', text: r.reply.slice(0, 500) }].slice(-HISTORY_TURNS) });
  return { reply: r.reply, action: r.action, status: r.status, result: r.result };
}

/** הודעה מדומה בקבוצה: אילו הצעות היו נוצרות, ולמי */
async function simulateGroup({ chatId, userId, text }) {
  const group = D.get('SELECT * FROM wa_groups WHERE chat_id = ?', chatId);
  if (!group) throw new Error('הקבוצה לא נמצאה');
  const project = group.project_id ? D.get('SELECT * FROM projects WHERE id = ?', group.project_id) : null;
  if (!project) throw new Error('הקבוצה עדיין לא שויכה לפרויקט');
  const sender = userId ? D.get('SELECT id, full_name FROM users WHERE id = ?', Number(userId)) : null;
  const candidates = await candidatesOf(group);
  if (!candidates.length) return { candidates: [], tasks: [], warning: '', note: 'אין בקבוצה עובדים רשומים עם טלפון — הבוט לא מנתח אותה.' };
  const fresh = [{ at: D.nowIso(), sender_name: sender?.full_name ?? 'משתתף', user_id: sender?.id ?? null, text: resolveMentions(String(text ?? '')).slice(0, 4000) }];
  const result = await analyzeGroup(group, project, fresh, candidates);
  const nameOf = (id) => candidates.find((c) => c.id === id)?.full_name ?? null;
  return {
    candidates: candidates.map((c) => c.full_name),
    warning: result.warning,
    tasks: result.tasks.map((t) => {
      const target = recipientOf(t, project, group, candidates);
      return {
        title: t.title, summary: t.summary, dueDate: t.dueDate, priority: t.priority,
        recipient: target ? nameOf(target) ?? D.get('SELECT full_name FROM users WHERE id = ?', target)?.full_name : null,
        routedAsManager: Boolean(target && !t.assignee),
        ambiguous: t.ambiguous
      };
    })
  };
}

// ---------------------------------------------------------------------------
// הסבב
// ---------------------------------------------------------------------------

let busy = false;
let timer = null;

/**
 * סבב משלו ולא של משימות ה-AI (כל 2 דקות): בשיחה פרטית מצפים לתשובה תוך
 * שניות. בקבוצות הקצב נקבע ממילא לפי ההפסקה בשיחה (‎wa_quiet_minutes‎).
 */
async function tick() {
  if (busy || !D.getSetting('wa_bot_enabled', true)) return;
  const ch = channel();
  if (!ch) return;
  busy = true;
  try {
    const direct = await poll(ch);
    if (inHours()) {
      for (const m of [...takeDeferred(), ...direct]) {
        await handleDirect(m).catch((err) => console.error('[משימון] הודעה פרטית לבוט נכשלה:', err.message));
      }
      await sendSummaries();
      await flushOutbox();
    } else {
      defer(direct);
    }
    if (Claude.isEnabled() && WaActions.byKey('group_tasks')?.enabled) await processGroups();
    prune();
  } catch (err) {
    console.error('[משימון] סבב בוט הוואטסאפ נכשל:', err.message);
  } finally {
    busy = false;
  }
}

function init({ createTask, listProjectsFor, tasks, mail }) {
  Object.assign(hooks, { createTask, listProjectsFor, tasks, mail });
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 15000);
  timer.unref?.();
}

module.exports = {
  init, start, tick, publicStatus, save, remove, checkState, qr, isConfigured,
  listGroups, bindGroup, userByPhone, markDone, readLog, todayStats, simulate, simulateGroup, inHours,
  // לשליחה ממודולים אחרים — התראה לפני פגישה (‎meetings.js‎), עם רישום ביומן הבוט
  sendText, log, notifyAssignment,
  _internal: { storeGroupMessage, processGroup, handleDirect, sanitizeGroup, resolveMentions, candidatesOf, converse, sendSummaries, YES, findRecipients, suggestionFeedback, flushOutbox }
};
