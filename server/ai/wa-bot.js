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
 *   • פרטי — עובד כותב לבוט "תפתח לי משימה…". הבוט ממלא טיוטה, מציג אותה,
 *     ופותח את המשימה רק אחרי "כן". העובד מזוהה לפי הטלפון שבפרופיל שלו;
 *     מספר שאינו מוכר אינו יכול לפתוח דבר.
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

/** פעולות שתלויות ב-api.js — מוזרקות משם */
const hooks = { createTask: null, listProjectsFor: null };

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

// ---------------------------------------------------------------------------
// מי זה
// ---------------------------------------------------------------------------

const orgUsers = () => D.all(
  `SELECT u.id, u.full_name, u.phone, d.name AS department FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.status = 'active' AND u.role <> 'vendor' ORDER BY u.full_name`
);

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
          checklist: { type: 'array', items: { type: 'string' } },
          due_date: { type: 'string', description: 'YYYY-MM-DD או ריק' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
          assignee_user_id: { type: 'integer', description: 'מזהה העובד מהרשימה, או 0 כשלא ודאי' },
          co_assignee_ids: { type: 'array', items: { type: 'integer' } },
          requester_user_id: { type: 'integer' },
          ambiguous: { type: 'array', items: { type: 'string' } }
        },
        required: ['message_index', 'title', 'summary', 'checklist', 'due_date', 'priority', 'assignee_user_id', 'co_assignee_ids', 'requester_user_id', 'ambiguous'],
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

async function analyzeGroup(group, project, fresh) {
  const context = D.all(
    'SELECT * FROM wa_messages WHERE chat_id = ? AND processed = 1 AND at >= ? ORDER BY at DESC LIMIT ?',
    group.chat_id, new Date(Date.now() - BACKLOG_DAYS * DAY).toISOString(), CONTEXT_MESSAGES
  ).reverse();
  const users = orgUsers();
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
 * אין — למי שקשר את הקבוצה. כך שום בקשה לא נופלת בין הכיסאות.
 */
function recipientOf(t, project, group) {
  const active = (id) => id && D.get("SELECT 1 FROM users WHERE id = ? AND status = 'active'", id);
  if (active(t.assignee)) return t.assignee;
  if (active(project.manager_id)) return project.manager_id;
  if (active(group.bound_by)) return group.bound_by;
  return null;
}

async function processGroup(group) {
  const project = group.project_id ? D.get('SELECT * FROM projects WHERE id = ?', group.project_id) : null;
  if (!project) {
    // הפרויקט נמחק — הקבוצה חוזרת להמתנה לשיוך, ולא מנחשים פרויקט אחר
    D.run("UPDATE wa_groups SET status = 'pending', project_id = NULL WHERE chat_id = ?", group.chat_id);
    return 0;
  }
  const fresh = D.all('SELECT * FROM wa_messages WHERE chat_id = ? AND processed = 0 ORDER BY at LIMIT ?', group.chat_id, BATCH_MAX);
  if (!fresh.length) return 0;

  const result = await analyzeGroup(group, project, fresh);
  const perUser = new Map();
  for (const t of result.tasks) {
    const msg = fresh[t.index - 1];
    const headerId = `wa:${msg.message_id}`;
    const target = recipientOf(t, project, group);
    if (!target) continue;
    // אותה בקשה לא מוצעת פעמיים לאותו אדם (למשל אחרי ניתוח חוזר)
    if (D.get('SELECT 1 FROM ai_suggestions WHERE header_id = ? AND user_id = ? AND subject = ?', headerId, target, t.title)) continue;
    const people = t.people.filter((p) => p.userId !== target);
    // מי שהיה האחראי המיועד אבל ההצעה הגיעה למנהל — נכנס כשותף מוצע
    if (t.assignee && t.assignee !== target) people.unshift({ userId: t.assignee, name: D.get('SELECT full_name FROM users WHERE id = ?', t.assignee)?.full_name ?? '', role: 'assignee', checklistIndex: 0 });
    const data = {
      source: 'whatsapp',
      title: t.title,
      summary: t.summary,
      checklist: t.checklist,
      dueDate: t.dueDate,
      priority: t.priority,
      people,
      ambiguous: t.ambiguous,
      aiRequest: null,
      warning: result.warning,
      groupName: group.name,
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
    }
  }
}

function prune() {
  D.run('DELETE FROM wa_messages WHERE at < ?', new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
  D.run("DELETE FROM wa_messages WHERE chat_id IN (SELECT chat_id FROM wa_groups WHERE status = 'ignored')");
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
  return D.all(
    `SELECT g.*, p.name AS project_name, u.full_name AS bound_by_name,
            (SELECT COUNT(*) FROM wa_messages m WHERE m.chat_id = g.chat_id AND m.processed = 0) AS waiting
       FROM wa_groups g
       LEFT JOIN projects p ON p.id = g.project_id
       LEFT JOIN users u ON u.id = g.bound_by
      ORDER BY CASE g.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, g.last_message_at DESC`
  ).map((g) => ({
    chatId: g.chat_id,
    name: g.name,
    status: g.status,
    projectId: g.project_id,
    projectName: g.project_name,
    boundBy: g.bound_by_name,
    boundAt: g.bound_at,
    firstSeenAt: g.first_seen_at,
    lastMessageAt: g.last_message_at,
    waiting: g.waiting
  }));
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
// שיחה פרטית → משימה
// ---------------------------------------------------------------------------

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['task', 'cancel', 'other'] },
    ready: { type: 'boolean' },
    reply: { type: 'string' },
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
  required: ['intent', 'ready', 'reply', 'draft'],
  additionalProperties: false
};

const YES = /^(כן|יאללה|אשר|מאשר|מאשרת|פתח|תפתח|פתחי|תפתחי|אוקי|אוקיי|סבבה|ok|okay|yes|👍|✅)([\s,.!]|$)/i;
const CANCEL = /^(ביטול|בטל|עזוב|לא צריך)([\s,.!]|$)/;

const chatOf = (userId) => D.get('SELECT * FROM wa_chats WHERE user_id = ?', userId)
  ?? { user_id: userId, draft: '', awaiting: 0, history: '[]' };

function saveChat(userId, { draft, awaiting, history }) {
  D.run(
    `INSERT INTO wa_chats (user_id, draft, awaiting, history, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET draft = excluded.draft, awaiting = excluded.awaiting, history = excluded.history, updated_at = excluded.updated_at`,
    userId, draft ? JSON.stringify(draft) : '', awaiting ? 1 : 0, JSON.stringify(history.slice(-HISTORY_TURNS)), D.nowIso()
  );
}

const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
const PRIORITY = { urgent: 'דחוף', high: 'גבוהה', normal: 'רגילה' };

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

async function understand(user, actor, state, text) {
  const users = orgUsers();
  const projects = (hooks.listProjectsFor?.(actor) ?? []).filter((p) => p.status === 'active').slice(0, 80);
  const today = localDate();
  const history = parseJson(state.history, []);
  const prompt = [
    `תאריך היום: ${today.date} (${today.weekday})`,
    `הכותב: ${user.full_name} (מזהה ${user.id})`,
    '',
    'העובדים (מזהה · שם · מחלקה):',
    ...users.map((u) => `${u.id} · ${u.full_name} · ${u.department ?? ''}`),
    '',
    'הפרויקטים (מזהה · שם):',
    ...(projects.length ? projects.map((p) => `${p.id} · ${p.name}`) : ['(אין)']),
    '',
    `הטיוטה הנוכחית: ${state.draft || '(אין)'}`,
    '',
    'השיחה עד כה:',
    ...(history.length ? history.map((h) => `${h.role === 'bot' ? 'הבוט' : 'הכותב'}: ${h.text}`) : ['(התחלה)']),
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
    intent: out.intent,
    ready: Boolean(out.ready),
    reply: String(out.reply ?? '').trim().slice(0, 1000),
    draft: {
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

function createFromDraft(actor, draft) {
  const assignee = draft.assigneeId || actor.id;
  const id = hooks.createTask(actor, {
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
  return id;
}

const taskLink = (id) => {
  const root = String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return root ? `${root}/?task=${id}` : null;
};

/** למספר שאינו מוכר עונים פעם ביום — לא יותר, כדי לא לנהל שיחה עם זרים */
const unknownReplied = new Map();

async function handleDirect(msg) {
  const user = userByPhone(msg.phone);
  if (!user) {
    const last = unknownReplied.get(msg.phone) ?? 0;
    if (Date.now() - last > DAY) {
      unknownReplied.set(msg.phone, Date.now());
      await sendText(msg.chatId, 'שלום! אני הבוט של משימון. המספר הזה אינו מוכר במערכת. כדי לפתוח משימות דרכי, בקשו ממנהל המערכת להוסיף את הטלפון שלכם בפרופיל.');
    }
    return;
  }
  const actor = Auth.loadActor('user', user.id);
  if (!actor) return;
  const state = chatOf(user.id);
  const history = parseJson(state.history, []);
  const text = msg.text;

  if (!text) {
    await sendText(msg.chatId, msg.kind === 'audioMessage' ? 'עדיין אינני מבין הודעות קוליות. כתבו לי בטקסט 🙏' : 'כתבו לי בטקסט מה לפתוח.');
    return;
  }
  history.push({ role: 'user', text: text.slice(0, 500) });

  const reply = async (out, next) => {
    history.push({ role: 'bot', text: out.slice(0, 500) });
    saveChat(user.id, { ...next, history });
    await sendText(msg.chatId, out);
  };

  if (state.awaiting && state.draft && YES.test(text.trim())) {
    const draft = parseJson(state.draft, null);
    try {
      const id = createFromDraft(actor, draft);
      const link = taskLink(id);
      return reply(`✅ נפתחה משימה: ${draft.title}${link ? `\n${link}` : ''}`, { draft: null, awaiting: false });
    } catch (err) {
      // הרשאה, למשל שיוך לעובד שאסור לשייך אליו — הטיוטה נשארת לתיקון
      return reply(`❌ לא הצלחתי לפתוח: ${err.message}\nכתבו מה לשנות, או "ביטול".`, { draft, awaiting: false });
    }
  }
  if (CANCEL.test(text.trim())) {
    return reply('בוטל 👍', { draft: null, awaiting: false });
  }

  if (!Claude.isEnabled()) return reply('חיבור ה-AI אינו מוגדר כרגע במשימון, ולכן אינני יכול לפתוח משימות.', { draft: parseJson(state.draft, null), awaiting: false });

  let out;
  try {
    out = await understand(user, actor, { ...state, history: JSON.stringify(history.slice(0, -1)) }, text);
  } catch (err) {
    console.error('[משימון] בוט הוואטסאפ לא הבין הודעה:', err.message);
    return reply('משהו השתבש אצלי. נסו שוב בעוד רגע.', { draft: parseJson(state.draft, null), awaiting: Boolean(state.awaiting) });
  }

  if (out.intent === 'cancel') return reply('בוטל 👍', { draft: null, awaiting: false });
  if (out.intent === 'other') return reply(out.reply || 'אני יודע לפתוח משימות במשימון. למשל: "תפתח משימה לשלוח הצעת מחיר לאלון, מלכה אחראית, עד חמישי".', { draft: parseJson(state.draft, null), awaiting: false });
  if (out.ready && out.draft.title) return reply(draftText(out.draft, user), { draft: out.draft, awaiting: true });
  return reply(out.reply || 'מה לכתוב בכותרת המשימה?', { draft: out.draft.title ? out.draft : null, awaiting: false });
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
    for (const m of direct) {
      await handleDirect(m).catch((err) => console.error('[משימון] הודעה פרטית לבוט נכשלה:', err.message));
    }
    if (Claude.isEnabled()) await processGroups();
    prune();
  } catch (err) {
    console.error('[משימון] סבב בוט הוואטסאפ נכשל:', err.message);
  } finally {
    busy = false;
  }
}

function init({ createTask, listProjectsFor }) {
  Object.assign(hooks, { createTask, listProjectsFor });
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 15000);
  timer.unref?.();
}

module.exports = {
  init, start, tick, publicStatus, save, remove, checkState, qr, isConfigured,
  listGroups, bindGroup, userByPhone,
  _internal: { storeGroupMessage, processGroup, handleDirect, sanitizeGroup, resolveMentions, YES }
};
