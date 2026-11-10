'use strict';
/**
 * משימה שהיא פנייה החוצה — "לשלוח מייל לדני", "לבקש הצעת מחיר מהדפוס".
 *
 * מי שקיבל משימה כזו לא צריך לפתוח אשף ולהקליד מחדש את מה שכבר כתוב בה:
 * ליד המשימה (ובבוט הוואטסאפ, מיד אחרי "קיבלת משימה") מחכה לו נוסח מייל
 * מוכן, לנמען שנמצא באנשי הקשר. "שליחה" — המייל יוצא מתיבת ה-Gmail שלו
 * והמשימה הקיימת הופכת למשימת AI שעוקבת אחרי התשובה, כמו כל משימת AI.
 *
 * הזיהוי בשני שלבים, כדי לא לשלם על AI בכל משימה:
 *   1. סינון מילולי זול (‎looksLikeOutreach‎) — מייל, הצעת מחיר, לבקש מ…
 *   2. רק אז ה-AI (‎skills/task-outreach.md‎) מחליט, מוציא נמען והוראה,
 *      והנוסח עצמו נכתב באותו סקיל של משימות ה-AI (‎AiTasks.draftInitial‎).
 *
 * התוצאה נשמרת לכל משימה ועובד (‎task_outreach‎), ומחושבת מחדש רק כשכותרת
 * המשימה או התיאור שלה השתנו. שום דבר לא יוצא בלי לחיצה או "כן" של העובד.
 */
const fs = require('node:fs');
const Paths = require('../paths');
const path = require('node:path');
const crypto = require('node:crypto');

const D = require('../db');
const Claude = require('./claude');
const AiTasks = require('../ai-tasks');
const Gmail = require('../gmail');
const GContacts = require('../google-contacts');

const SKILL_PATH = Paths.skill('task-outreach.md');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CANDIDATES_SHOWN = 5;

/** ‎searchContacts(actor, q)‎ — מוזרק מנקודות הקצה, שם הוא מאחד את כל המקורות */
const hooks = { searchContacts: null };
const init = (h) => Object.assign(hooks, h);

// הטבלה ‎task_outreach‎ מוגדרת ב-db.js, עם שאר הטבלאות


/*
 * מצבים:
 *   none       — המשימה אינה פנייה (או שלא היה אפשר להחליט)
 *   ready      — יש נמען עם מייל ונוסח מוכן
 *   no_contact — פנייה, אבל הנמען לא נמצא או שיש כמה — העובד בוחר / מקליד מייל
 *   dismissed  — העובד אמר "לא עכשיו"
 *   sent       — נשלח; המשימה כבר משימת AI
 */

const OUTREACH_WORDS = /(?:מייל|אימייל|דוא["״]?ל|e-?mail|הצע(?:ת|ות)\s+מחיר|הצעה\s+מ|לבקש|לפנות|לכתוב\s+ל|לשלוח\s+ל|לברר\s+(?:עם|מול)|לקבל\s+מ|להשיג\s+מ|לעדכן\s+את|לשאול\s+את)/i;

/** סינון זול לפני ה-AI: רק משימה שיש בה מילה של פנייה */
function looksLikeOutreach(task) {
  return OUTREACH_WORDS.test(`${task.title ?? ''}\n${task.description ?? ''}`);
}

const fingerprintOf = (task) => crypto.createHash('sha1').update(`${task.title ?? ''}\n${task.description ?? ''}`).digest('hex').slice(0, 16);
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

function rowOf(taskId, userId) {
  const r = D.get('SELECT * FROM task_outreach WHERE task_id = ? AND user_id = ?', taskId, userId);
  return r ? { ...r, data: parse(r.data) } : null;
}

function save(taskId, userId, state, fingerprint, data) {
  const now = D.nowIso();
  D.run(
    `INSERT INTO task_outreach (task_id, user_id, state, fingerprint, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(task_id, user_id) DO UPDATE SET state = excluded.state, fingerprint = excluded.fingerprint,
       data = excluded.data, updated_at = excluded.updated_at`,
    taskId, userId, state, fingerprint, JSON.stringify(data ?? {}), now, now
  );
  return rowOf(taskId, userId);
}

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    outreach: { type: 'boolean' },
    recipient_name: { type: 'string' },
    recipient_org: { type: 'string' },
    recipient_email: { type: 'string' },
    instruction: { type: 'string' }
  },
  required: ['outreach', 'recipient_name', 'recipient_org', 'recipient_email', 'instruction'],
  additionalProperties: false
};

async function analyze(task) {
  const project = task.project_id ? D.get('SELECT name FROM projects WHERE id = ?', task.project_id)?.name : null;
  return Claude.json({
    system: fs.readFileSync(SKILL_PATH, 'utf8'),
    content: [{
      type: 'text',
      text: [
        `כותרת המשימה: ${task.title ?? ''}`,
        task.description ? `תיאור המשימה:\n${String(task.description).slice(0, 3000)}` : 'אין תיאור.',
        project ? `פרויקט: ${project}` : null
      ].filter(Boolean).join('\n')
    }],
    schema: ANALYZE_SCHEMA,
    effort: 'low'
  });
}

/**
 * הנמען לפי השם (ואם נאמרה חברה — רק מי שהיא מופיעה אצלו). מייל הוא תנאי:
 * זו הצעת מייל. עובד בארגון נשלח כמו כל נמען — מייל, לא שיוך במשימון.
 */
function findContacts(actor, name, org) {
  if (!hooks.searchContacts || !(name || org)) return [];
  const found = (hooks.searchContacts(actor, name || org) ?? []).filter((c) => c.email && EMAIL_RE.test(c.email));
  const tokens = GContacts.fold(org).split(/\s+/).filter((w) => w.length >= 2);
  const narrowed = name && tokens.length
    ? found.filter((c) => tokens.some((tk) => GContacts.fold([c.name, c.organization, c.title, c.email].join(' ')).includes(tk)))
    : found;
  return (narrowed.length ? narrowed : found).map(contactOf);
}

const contactOf = (c) => ({
  name: String(c.name ?? '').trim(),
  email: String(c.email ?? '').trim().toLowerCase(),
  phone: String(c.phone ?? '').trim(),
  // עובד בארגון — במייל רגיל, ולכן "חיצוני" מבחינת המעקב
  type: c.type === 'vendor' ? 'vendor' : 'external',
  refId: c.type === 'vendor' ? c.refId ?? null : null,
  organization: String(c.organization ?? '').trim()
});

async function draftFor(actor, contact, instruction, { feedback = '', previous = null } = {}) {
  const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
  const context = previous ? '' : await AiTasks.mailContext(actor.id, contact.email);
  const d = await AiTasks.draftInitial({ owner, instruction, contact, channel: 'email', context, feedback, previous });
  return {
    draft: {
      title: String(d.title ?? '').trim().slice(0, 120),
      goal: String(d.goal ?? '').trim(),
      success_criteria: String(d.success_criteria ?? '').trim(),
      subject: String(d.subject ?? '').trim().slice(0, 200),
      body: String(d.body ?? '').trim()
    },
    suggestions: (Array.isArray(d.suggestions) ? d.suggestions : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4),
    notes: String(d.notes ?? '').trim().slice(0, 300)
  };
}

/** מי רשאי לקבל הצעה על המשימה — מי שהיא אצלו: האחראי או אחראי נוסף */
function isAssignee(taskId, userId) {
  const t = D.get('SELECT assignee_type, assignee_id FROM tasks WHERE id = ?', taskId);
  if (!t) return false;
  if (t.assignee_type === 'user' && t.assignee_id === userId) return true;
  return Boolean(D.get("SELECT 1 FROM task_assignees WHERE task_id = ? AND assignee_type = 'user' AND assignee_id = ?", taskId, userId));
}

/** האם בכלל לנסות — בלי AI, בלי Gmail לשליחה, משימה סגורה או שכבר עוקבת — לא */
function eligible(task, actor) {
  if (!task || actor?.type !== 'user') return false;
  if (!Claude.isEnabled() || !Gmail.canSend(actor.id)) return false;
  if (task.completed_at || task.archived || AiTasks.requestByTask(task.id)) return false;
  if (!isAssignee(task.id, actor.id)) return false;
  return looksLikeOutreach(task);
}

// אותה משימה לאותו עובד — חישוב אחד, גם כשהכרטיס והבוט מבקשים יחד
const inflight = new Map();

/**
 * ההצעה למשימה, ואם אין — מחשבים אותה. ‎null‎ — אין מה להציע.
 * לעולם לא זורק: תקלת AI אינה מפילה את פתיחת הכרטיס או את הודעת הבוט.
 */
async function prepare(taskId, actor) {
  const task = D.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!eligible(task, actor)) {
    const row = task && actor ? rowOf(task.id, actor.id) : null;
    return row?.state === 'sent' ? row : null;
  }
  const fp = fingerprintOf(task);
  const cached = rowOf(task.id, actor.id);
  if (cached && (cached.fingerprint === fp || ['dismissed', 'sent'].includes(cached.state))) return cached;

  const key = `${task.id}:${actor.id}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    try {
      const a = await analyze(task);
      if (!a?.outreach || !String(a.instruction ?? '').trim()) return save(task.id, actor.id, 'none', fp, {});
      const instruction = String(a.instruction).trim().slice(0, 1000);
      const recipient = { name: String(a.recipient_name ?? '').trim(), org: String(a.recipient_org ?? '').trim() };
      const typed = String(a.recipient_email ?? '').trim().toLowerCase();
      const candidates = EMAIL_RE.test(typed)
        ? [{ name: recipient.name || typed, email: typed, phone: '', type: 'external', refId: null, organization: recipient.org }]
        : findContacts(actor, recipient.name, recipient.org);
      if (candidates.length !== 1) {
        return save(task.id, actor.id, 'no_contact', fp, { instruction, recipient, candidates: candidates.slice(0, CANDIDATES_SHOWN) });
      }
      const contact = candidates[0];
      const d = await draftFor(actor, contact, instruction);
      return save(task.id, actor.id, 'ready', fp, { instruction, recipient, contact, ...d });
    } catch (err) {
      console.error('[משימון] הצעת מייל למשימה נכשלה:', err.message);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** נמען אחר (מהרשימה, או מייל שהוקלד) ו/או תיקון לנוסח */
async function redraft(taskId, actor, { contact = null, feedback = '' } = {}) {
  const row = rowOf(taskId, actor.id);
  if (!row || !['ready', 'no_contact'].includes(row.state)) throw new Error('אין הצעת מייל למשימה הזו');
  const next = contact ? contactOf(contact) : row.data.contact;
  if (!next || !EMAIL_RE.test(next.email)) throw new Error('נדרשת כתובת מייל תקינה לנמען');
  const sameContact = row.data.contact && row.data.contact.email === next.email;
  const d = await draftFor(actor, next, row.data.instruction, sameContact && feedback ? { feedback, previous: row.data.draft } : {});
  return save(taskId, actor.id, 'ready', row.fingerprint, { ...row.data, contact: next, candidates: [], ...d });
}

function dismiss(taskId, userId) {
  const row = rowOf(taskId, userId);
  if (row) save(taskId, userId, 'dismissed', row.fingerprint, row.data);
}

/**
 * שליחה: המייל יוצא מהתיבה של העובד, והמשימה הקיימת נעשית משימת AI —
 * תזכורות, וקליטת התשובה. ‎edits‎ — מה שהעובד שינה בנוסח לפני השליחה.
 */
async function send(taskId, actor, edits = {}) {
  const row = rowOf(taskId, actor.id);
  // ‎no_contact‎ — הנמען נבחר בבוט, והנוסח נכתב שם (‎edits.draft‎)
  if (!row || !['ready', 'no_contact'].includes(row.state)) throw new Error('אין נוסח מוכן לשליחה');
  if (AiTasks.requestByTask(taskId)) throw new Error('המשימה כבר במעקב AI');
  if (!Gmail.canSend(actor.id)) throw new Error('כדי לשלוח מייל צריך לחבר את תיבת ה-Gmail שלך ("החשבון שלי ← Gmail ועוזר ה-AI")');
  const contact = edits.contact?.email ? contactOf({ ...(row.data.contact ?? {}), ...edits.contact }) : row.data.contact;
  if (!contact || !EMAIL_RE.test(contact.email)) throw new Error('נדרשת כתובת מייל תקינה לנמען');
  const base = { ...(row.data.draft ?? {}), ...(edits.draft ?? {}) };
  const draft = {
    title: String(base.title ?? ''), goal: String(base.goal ?? ''), success_criteria: String(base.success_criteria ?? ''),
    subject: String(edits.subject ?? base.subject ?? '').trim().slice(0, 200),
    body: String(edits.body ?? base.body ?? '').trim()
  };
  if (!draft.subject) throw new Error('נדרש נושא למייל');
  if (!draft.body) throw new Error('אין נוסח לשליחה');
  const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
  const cc = AiTasks.cleanCc(edits.cc ?? [], { contactEmail: contact.email, ownerEmail: owner.email });
  // השורה מסומנת לפני השליחה — "כן" כפול מהבוט לא ישלח פעמיים
  save(taskId, actor.id, 'sent', row.fingerprint, { ...row.data, contact, draft });
  try {
    await AiTasks.launch({ taskId, owner, instruction: row.data.instruction, draft, contact, cc, policy: {}, channel: 'email' });
  } catch (err) {
    // המעקב נפתח עם הטיוטה (אפשר לשלוח שוב מהכרטיס) — אם בכלל נוצר; אחרת חוזרים להצעה
    if (!AiTasks.requestByTask(taskId)) save(taskId, actor.id, row.state, row.fingerprint, row.data);
    throw err;
  }
  return { contact, draft };
}

/** מה שהלקוח רואה */
function shape(row) {
  if (!row || !['ready', 'no_contact'].includes(row.state)) return null;
  const d = row.data;
  return {
    state: row.state,
    instruction: d.instruction,
    recipient: d.recipient ?? {},
    contact: d.contact ?? null,
    candidates: d.candidates ?? [],
    draft: d.draft ?? null,
    suggestions: d.suggestions ?? [],
    notes: d.notes ?? ''
  };
}

module.exports = { init, prepare, redraft, dismiss, send, shape, rowOf, looksLikeOutreach, eligible };
