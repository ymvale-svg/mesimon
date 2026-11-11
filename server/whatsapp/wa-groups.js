'use strict';
/**
 * בוט הוואטסאפ — קבוצות — הודעות בקבוצה הופכות להצעות משימה, וניהול הקבוצות.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base.
 */
const fs = require('node:fs');
const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const MailInsights = require('../mail').MailInsights;
const Insights = require('../agents').Insights;
const TaskSync = require('../tasks').TaskSync;
const { BACKLOG_DAYS, BATCH_MAX, CONTEXT_MESSAGES, DAY, GROUP_SKILL, KEEP_DAYS, LOG_DAYS, candidatesOf, localDate, log, orgUsers, parseJson } = require('./wa-base');


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
    },
    insights: {
      type: 'array',
      description: 'מה שחברי הקבוצה ירצו לדעת מההודעות החדשות — שורה לכל עניין, רק מה שחשוב',
      items: {
        type: 'object',
        properties: {
          message_index: { type: 'integer' },
          kind: { type: 'string', enum: ['action', 'approval', 'document', 'money', 'deadline', 'meeting', 'info'] },
          importance: { type: 'integer', description: '1–3' },
          who: { type: 'string' },
          insight: { type: 'string' },
          due_date: { type: 'string', description: 'YYYY-MM-DD או ריק' }
        },
        required: ['message_index', 'kind', 'importance', 'who', 'insight', 'due_date'],
        additionalProperties: false
      }
    }
  },
  required: ['warning', 'tasks', 'insights'],
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
  const insights = (Array.isArray(out.insights) ? out.insights : []).slice(0, 10)
    .map((x) => ({ ...x, index: Number(x.message_index) }))
    .filter((x) => x.index >= 1 && x.index <= count && String(x.insight ?? '').trim());
  return { warning: String(out.warning ?? '').trim(), tasks, insights };
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
    log({ channel: 'group', chatId: group.chat_id, chatName: group.name, action: 'group_scan', status: 'skipped', result: `${fresh.length} הודעות לא נותחו: ${group.participants_at ? 'אין בקבוצה עובדים רשומים עם טלפון' : 'רשימת המשתתפים של הקבוצה לא ידועה'}` });
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
  /*
   * תובנות — פעם אחת לקבוצה, לא לכל עובד. נראות רק לחברי הקבוצה (‎insights.js‎),
   * ונשמרת רק התובנה — לא ההודעה.
   */
  let insightCount = 0;
  for (const x of result.insights ?? []) {
    if (Insights.storeGroup(group.chat_id, fresh[x.index - 1], x)) insightCount++;
  }
  /*
   * הודעה בקבוצה שעונה על משימה שפתח אחד מחברי הקבוצה, או מעדכנת אותה
   * (‎task-sync.js‎) — לכל חבר בנפרד, מול המשימות שהוא פתח. ה-AI נקרא רק למי
   * שיש לו משימה מועמדת; הודעות שהוא עצמו כתב — לא נבדקות מולו.
   */
  for (const member of candidates) {
    await TaskSync.checkQuietly(member.id, {
      source: 'group',
      groupName: group.name,
      chatId: group.chat_id,
      projectId: project.id,
      messages: fresh.map((m) => ({ text: m.text, at: m.at, ref: `wa:${m.message_id}`, fromName: m.sender_name, fromUserId: m.user_id, fromPhone: m.sender_phone }))
    });
  }
  if (!result.tasks.length) {
    log({ channel: 'group', chatId: group.chat_id, chatName: group.name, action: 'group_scan', status: 'ok', result: `נותחו ${fresh.length} הודעות — אין בקשות${insightCount ? ` · ${insightCount} תובנות` : ''}` });
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
  MailInsights.prune();
  Insights.prune();
  D.run('DELETE FROM wa_messages WHERE at < ?', new Date(Date.now() - KEEP_DAYS * DAY).toISOString());
  D.run("DELETE FROM wa_messages WHERE chat_id IN (SELECT chat_id FROM wa_groups WHERE status = 'ignored')");
  D.run('DELETE FROM wa_log WHERE at < ?', new Date(Date.now() - LOG_DAYS * DAY).toISOString());
  D.run('DELETE FROM wa_forwards WHERE at < ?', new Date(Date.now() - DAY).toISOString());
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

module.exports = {
  analyzeGroup, bindGroup, listGroups, nameOf, notifyAdmins, processGroup, processGroups, prune, recipientOf, sanitizeGroup
};
