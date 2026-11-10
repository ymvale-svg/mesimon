'use strict';
/**
 * מייל או וואטסאפ שעונה על משימה שפתחתי (אפיון, פרק 11א).
 *
 * מה נבדק: הודעות שכבר עוברות סריקה ממילא —
 *   • מייל נכנס בתיבת ה-Gmail של המשתמש (‎mail-scan.js‎),
 *   • וואטסאפ אישי, רק מאנשי קשר עסקיים (‎whatsapp-scan.js‎),
 *   • הודעות בקבוצות של הבוט שהמשתמש חבר בהן (‎wa-bot.js‎).
 * הודעה ששויכה כבר למשימת AI בשרשור שלה ממשיכה במסלול של משימת ה-AI ואינה
 * מגיעה לכאן.
 *
 * מול מה: המשימות הפתוחות שהמשתמש פתח (‎created_by‎) — כל משימה, גם ששייך
 * למישהו אחר: הוא זה שמחכה לתוצאה.
 *
 * איך: סינון זול בוחר עד ‎MAX_CANDIDATES‎ משימות (אותם אנשים — מייל או טלפון,
 * אותו פרויקט, מילים משותפות, משימה חדשה יחסית). רק כשיש מועמדים — קריאה
 * אחת ל-AI, שמחליט לכל אחת: עונה במלואה (הצעה "לסגור?"), עדכון חלקי (הצעה
 * להוסיף הערה, ואולי לשנות יעד או סטטוס — עם ערכים מוצעים), או לא קשור.
 *
 * ההצעה נשמרת ב-‎ai_suggestions‎ (‎task_close‎ / ‎task_update‎, עם ‎task_id‎) —
 * ומופיעה ב"ממתין לאישורך", ב-Today ובבוט ("אשר א"). שום דבר לא נסגר ולא
 * משתנה בלי אישור. "לא קשור" — אותה הודעה לא תוצע שוב לאותה משימה (השורה
 * הדחויה נשארת, והבדיקה כאן מדלגת על כל זוג הודעה-משימה שכבר הוצע).
 *
 * פרטיות: נשמר רק קטע ההודעה שיתווסף כהערה (עד ‎COMMENT_MAX‎ תווים), ורק כשיש
 * הצעה — כדי שבאישור יהיה מה להוסיף למשימה. קבצים מהמייל נקראים מחדש מ-Gmail
 * רק באישור.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const W = require('../workdays');
const Claude = require('./claude');
const Match = require('./task-match');
const Gmail = require('../gmail');
const Mime = require('../mime');

const SKILL = path.join(__dirname, 'skills', 'task-sync.md');
const MAX_CANDIDATES = 6;
const MIN_SCORE = 2;
const COMMENT_MAX = 2000;
const KINDS = ['task_close', 'task_update'];

const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

/**
 * מוזרק מ-api.js — אותם מסלולים של האפליקציה, עם ההרשאות של המאשר:
 * ‎canSee(actor, task)‎, ‎comment(actor, task, body, files)‎, ‎complete(actor, taskId, note)‎,
 * ‎setDue(actor, taskId, ymd)‎, ‎setStatus(actor, taskId, key)‎.
 */
const hooks = { canSee: null, comment: null, complete: null, setDue: null, setStatus: null };
const setHooks = (h) => Object.assign(hooks, h);

// ---------------------------------------------------------------------------
// המשימות שפתחתי
// ---------------------------------------------------------------------------

const phoneKey = (p) => {
  const digits = String(p ?? '').replace(/\D/g, '');
  // השוואה לפי 9 הספרות האחרונות: ‎054…‎, ‎+97254…‎ ו-‎97254…‎ הם אותו מספר
  return digits.length >= 9 ? digits.slice(-9) : '';
};

const openColumns = (boardId) => D.all('SELECT key, label FROM board_columns WHERE board_id = ? AND is_final = 0 ORDER BY position', boardId);

/** המשימות הפתוחות שהמשתמש פתח, עם כל מה שהסינון וה-AI צריכים לדעת עליהן */
function openCreatedBy(userId) {
  const rows = D.all(
    `SELECT t.* FROM tasks t
       LEFT JOIN board_columns bc ON bc.board_id = t.board_id AND bc.key = t.status
      WHERE t.created_by = ? AND t.archived = 0 AND COALESCE(bc.is_final, 0) = 0 AND t.merged_into_task_id IS NULL
      ORDER BY t.id DESC LIMIT 300`,
    userId
  );
  return rows.map(contextOf);
}

function contextOf(t) {
  const people = [];
  const add = (name, email, phone) => people.push({ name: String(name ?? ''), email: String(email ?? '').toLowerCase(), phone: phoneKey(phone) });
  if (t.assignee_type === 'user' && t.assignee_id) {
    const u = D.get('SELECT full_name, email, phone FROM users WHERE id = ?', t.assignee_id);
    if (u) add(u.full_name, u.email, u.phone);
  } else if (t.assignee_type === 'vendor' && t.assignee_id) {
    const v = D.get('SELECT name, contact_name, email, phone FROM vendors WHERE id = ?', t.assignee_id);
    if (v) add(v.contact_name || v.name, v.email, v.phone);
  }
  for (const a of D.all('SELECT assignee_type, assignee_id FROM task_assignees WHERE task_id = ?', t.id)) {
    const u = a.assignee_type === 'user'
      ? D.get('SELECT full_name AS name, email, phone FROM users WHERE id = ?', a.assignee_id)
      : D.get('SELECT COALESCE(NULLIF(contact_name, \'\'), name) AS name, email, phone FROM vendors WHERE id = ?', a.assignee_id);
    if (u) add(u.name, u.email, u.phone);
  }
  // משימת AI — מי שפנו אליו
  const req = D.get('SELECT contact_name, contact_email, contact_phone FROM ai_requests WHERE task_id = ?', t.id);
  if (req) add(req.contact_name, req.contact_email, req.contact_phone);
  const project = t.project_id ? D.get('SELECT name FROM projects WHERE id = ?', t.project_id)?.name ?? '' : '';
  const checklist = D.all('SELECT text FROM checklist_items WHERE task_id = ? ORDER BY position LIMIT 12', t.id).map((r) => r.text);
  const files = D.all('SELECT DISTINCT filename FROM attachments WHERE task_id = ? LIMIT 10', t.id).map((r) => r.filename);
  return {
    id: t.id,
    title: t.title,
    description: String(t.description ?? ''),
    projectId: t.project_id ?? null,
    project,
    people,
    checklist,
    files,
    dueDate: t.due_date,
    status: t.status,
    boardId: t.board_id,
    createdAt: t.created_at
  };
}

// ---------------------------------------------------------------------------
// הסינון הזול
// ---------------------------------------------------------------------------

/**
 * ציון של משימה מול ההודעה. טהורה — ‎ctx‎ מ-‎contextOf‎, ‎msg‎ כפי שמגיע ל-‎check‎.
 * אנשים (מייל/טלפון זהים) הם הסימן החזק; פרויקט ומילים משותפות מוסיפים;
 * משימה חדשה — מעט יותר מישנה.
 */
function score(ctx, msg, now = Date.now()) {
  let s = 0;
  const email = String(msg.fromEmail ?? '').toLowerCase();
  // בקבוצה לכל הודעה שולח משלה
  const phones = new Set([msg.fromPhone, ...(msg.messages ?? []).map((m) => m.fromPhone)].map(phoneKey).filter(Boolean));
  const samePerson = ctx.people.some((p) => (email && p.email && p.email === email) || (p.phone && phones.has(p.phone)));
  if (samePerson) s += 4;
  if (msg.projectId && ctx.projectId === msg.projectId) s += 1.5;

  const text = [msg.subject, ...(msg.messages ?? []).map((m) => m.text), ...(msg.files ?? [])].join(' ');
  const said = Match.tokens(text);
  const title = Match.tokens(ctx.title);
  const rest = Match.tokens([ctx.description.slice(0, 600), ctx.project, ...ctx.checklist, ...ctx.files].join(' '));
  const titleHits = Match.shared(title, said);
  let restHits = 0;
  for (const w of rest) if (!title.has(w) && said.has(w)) restHits++;
  s += Math.min(6, titleHits * 1.5 + Math.min(3, restHits * 0.5));
  // שם האחראי או מי שפנו אליו מופיע בהודעה ("דני, הטופס בדרך")
  if (!samePerson && ctx.people.some((p) => p.name && Match.shared(Match.tokens(p.name), said) > 0)) s += 0.5;
  // משימה מהחודש האחרון — מעט יותר סביר שעליה מדברים
  if (ctx.createdAt && now - new Date(ctx.createdAt).getTime() < 30 * 864e5) s += 0.5;
  // בלי שום מילה משותפת ובלי אותו אדם — לא מועמדת, גם אם חדשה ובאותו פרויקט
  if (!samePerson && !titleHits && restHits < 2) return 0;
  return Number(s.toFixed(2));
}

/** המועמדות — עד ‎limit‎, מהציון הגבוה. טהורה */
function prefilter(contexts, msg, { limit = MAX_CANDIDATES, min = MIN_SCORE, now = Date.now() } = {}) {
  return contexts
    .map((ctx) => ({ ctx, score: score(ctx, msg, now) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score || b.ctx.id - a.ctx.id)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// ה-AI
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['task_id', 'message_index', 'verdict', 'reason', 'update_summary', 'due_date', 'status'],
        properties: {
          task_id: { type: 'integer' },
          message_index: { type: 'integer', description: 'מספר ההודעה (מ-1) שעליה ההחלטה' },
          verdict: { type: 'string', enum: ['answers', 'update', 'none'] },
          reason: { type: 'string', description: 'משפט קצר: למה' },
          update_summary: { type: 'string', description: 'בעדכון חלקי — מה התעדכן, בשורה אחת. אחרת ריק' },
          due_date: { type: 'string', description: 'בעדכון — יעד חדש שנובע מההודעה, YYYY-MM-DD. אחרת ריק' },
          status: { type: 'string', description: 'בעדכון — מפתח סטטוס חדש מהרשימה של המשימה, או ריק' }
        }
      }
    }
  }
};

const ymd = (iso) => (iso ? W.ilDateOf(iso) : '');

function prompt(user, msg, candidates) {
  const today = W.todayIL();
  const where = msg.source === 'mail' ? 'מייל' : msg.source === 'group' ? `הודעות בקבוצת הוואטסאפ "${msg.groupName}"` : `הודעות וואטסאפ פרטיות מ${msg.fromName}`;
  return [
    `תאריך היום: ${today} (${W.hebrewDate(today)})`,
    `המשתמש: ${user.full_name}`,
    '',
    'המשימות הפתוחות שהמשתמש פתח (מזהה · כותרת · פרטים):',
    ...candidates.map(({ ctx }) => [
      `#${ctx.id} · "${ctx.title}"`,
      ctx.project ? `  פרויקט: ${ctx.project}` : null,
      ctx.people.length ? `  אנשים: ${ctx.people.map((p) => [p.name, p.email].filter(Boolean).join(' ')).join('; ')}` : null,
      ctx.description.trim() ? `  תיאור: ${ctx.description.replace(/\s+/g, ' ').slice(0, 400)}` : null,
      ctx.checklist.length ? `  צ'קליסט: ${ctx.checklist.join('; ')}` : null,
      ctx.files.length ? `  קבצים במשימה: ${ctx.files.join(', ')}` : null,
      `  יעד: ${ymd(ctx.dueDate) || 'אין'} · סטטוס: ${ctx.status}`,
      `  סטטוסים אפשריים: ${openColumns(ctx.boardId).map((c) => `${c.key}=${c.label}`).join(', ')}`
    ].filter(Boolean).join('\n')),
    '',
    `ה${where}:`,
    msg.source === 'mail' ? `מאת: ${msg.fromName} <${msg.fromEmail}>\nנושא: ${msg.subject}` : null,
    msg.files?.length ? `קבצים מצורפים: ${msg.files.join(', ')}` : null,
    '<<<',
    ...msg.messages.map((m, i) => `[${i + 1}] ${m.fromName ?? msg.fromName}${m.at ? ` · ${String(m.at).slice(0, 16).replace('T', ' ')}` : ''}: ${String(m.text ?? '').slice(0, msg.source === 'mail' ? 6000 : 800)}`),
    '>>>',
    '',
    'החלט לפי ההנחיות.'
  ].filter((l) => l !== null).join('\n');
}

/**
 * מה שחזר מה-AI — נבדק לפני שנשמר: משימה מהרשימה בלבד, הודעה שקיימת, יעד
 * שהוא תאריך, סטטוס פתוח מהבורד של המשימה ושונה מהנוכחי. לכל משימה — החלטה
 * אחת לכל היותר, ועד שתי הצעות להודעה. טהורה (‎columnsOf‎ מוזרק לבדיקה).
 */
function sanitize(out, candidates, count, columnsOf = openColumns) {
  const byId = new Map(candidates.map(({ ctx }) => [ctx.id, ctx]));
  const seen = new Set();
  const result = [];
  for (const m of Array.isArray(out?.matches) ? out.matches : []) {
    const ctx = byId.get(Number(m.task_id));
    if (!ctx || seen.has(ctx.id) || !['answers', 'update'].includes(m.verdict)) continue;
    const index = Number(m.message_index) >= 1 && Number(m.message_index) <= count ? Number(m.message_index) : count;
    const update = m.verdict === 'update';
    const due = update && W.isDate(m.due_date) && m.due_date !== ymd(ctx.dueDate) ? m.due_date : '';
    const col = update ? columnsOf(ctx.boardId).find((c) => c.key === String(m.status ?? '').trim()) : null;
    seen.add(ctx.id);
    result.push({
      taskId: ctx.id,
      kind: update ? 'task_update' : 'task_close',
      index,
      reason: String(m.reason ?? '').trim().slice(0, 300),
      summary: String(m.update_summary ?? '').trim().slice(0, 300),
      dueDate: due,
      status: col && col.key !== ctx.status ? col.key : '',
      statusLabel: col && col.key !== ctx.status ? col.label : ''
    });
  }
  return result.slice(0, 2);
}

// ---------------------------------------------------------------------------
// ההצעה
// ---------------------------------------------------------------------------

const dm = (date) => (date ? `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}` : '');

/** השורה שמוצגת בכל מקום (Today, בוט, מייל הבוקר) — השאלה עצמה */
function displayTitle(kind, d) {
  const what = d.channel === 'mail' ? 'המייל' : 'ההודעה';
  if (kind === 'task_close') return `נראה ש${what} מ${d.fromName} עונה על "${d.taskTitle}" — לסגור?`;
  const extra = [
    d.proposed?.dueDate ? `ולעדכן את היעד ל-${dm(d.proposed.dueDate)}` : null,
    d.proposed?.status ? `ולשנות סטטוס ל"${d.proposed.statusLabel}"` : null
  ].filter(Boolean).join(' ');
  return `יש עדכון ל"${d.taskTitle}"${d.summary ? `: ${d.summary}` : ''} — להוסיף כהערה${extra ? ` ${extra}` : ''}?`;
}

const already = (userId, taskId, ref) => Boolean(D.get(
  `SELECT 1 FROM ai_suggestions WHERE user_id = ? AND task_id = ? AND header_id = ? AND kind IN ('task_close','task_update')`, userId, taskId, ref
));

/**
 * ‎msg‎ — ‎{ source: 'mail'|'personal'|'group', fromName, fromEmail, fromPhone,
 * subject, gmailId, projectId, groupName, chatId, chatPhone, files: [שמות],
 * messages: [{ text, at, ref, fromName, fromUserId }] }‎. ‎ref‎ — מזהה ההודעה
 * (‎header_id‎ של ההצעה): Message-ID של המייל, ‎wap:…‎ או ‎wa:…‎.
 *
 * @returns {Promise<number>} כמה הצעות נוספו
 */
async function check(userId, msg, { classify = null } = {}) {
  const user = D.get("SELECT id, full_name FROM users WHERE id = ? AND status = 'active'", userId);
  const messages = (msg.messages ?? []).filter((m) => String(m.text ?? '').trim() && m.ref && m.fromUserId !== userId);
  if (!user || !messages.length) return 0;
  if (!classify && !Claude.isEnabled()) return 0;
  const shaped = { ...msg, messages };
  // משימה שכל ההודעות האלה כבר הוצעו לה (בכל מצב, גם "לא קשור") — יוצאת מהמועמדות
  const contexts = openCreatedBy(userId).filter((ctx) => !messages.every((m) => already(userId, ctx.id, m.ref)));
  const candidates = prefilter(contexts, shaped);
  if (!candidates.length) return 0;

  const run = classify ?? ((text) => Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text }], schema: SCHEMA, effort: 'low' }));
  const out = await run(prompt(user, shaped, candidates), candidates);
  let added = 0;
  for (const m of sanitize(out, candidates, messages.length)) {
    const message = messages[m.index - 1];
    if (already(userId, m.taskId, message.ref)) continue;
    const ctx = candidates.find((c) => c.ctx.id === m.taskId).ctx;
    const fromName = message.fromName || msg.fromName || '';
    const data = {
      sync: true,
      channel: msg.source,
      // מאיפה — אותם שדות של הצעות הוואטסאפ, כדי שהמקור יוצג כמו בכל הצעה
      ...(msg.source === 'mail' ? {} : { source: 'whatsapp', personal: msg.source === 'personal', groupName: msg.groupName ?? '', chatId: msg.chatId ?? null, chatPhone: msg.chatPhone ?? null, projectId: msg.projectId ?? null }),
      taskId: ctx.id,
      taskTitle: ctx.title,
      fromName,
      reason: m.reason,
      summary: m.summary,
      comment: String(message.text).trim().slice(0, COMMENT_MAX),
      proposed: m.kind === 'task_update' ? { dueDate: m.dueDate, status: m.status, statusLabel: m.statusLabel } : null,
      currentDue: ymd(ctx.dueDate) || '',
      files: msg.source === 'mail' ? (msg.files ?? []).slice(0, 10) : [],
      receivedAt: message.at ? new Date(message.at).toISOString() : D.nowIso()
    };
    data.title = displayTitle(m.kind, data);
    D.run(
      `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, task_id, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, m.kind, msg.gmailId ?? '', message.ref, fromName, msg.fromEmail ?? '',
      String(msg.subject || message.text).slice(0, 300), data.receivedAt, JSON.stringify(data), ctx.id, D.nowIso()
    );
    added++;
    D.notify({
      targetType: 'user', targetId: userId, kind: 'ai',
      title: m.kind === 'task_close' ? `✅ נראה שהמשימה "${ctx.title}" נענתה — לסגור?` : `📝 יש עדכון למשימה "${ctx.title}"`,
      body: `מ${fromName} · ב"ממתין לאישורך"`,
      taskId: ctx.id
    });
  }
  return added;
}

/** כמו ‎check‎, בלי לעצור את הסריקה שקראה לה — תקלה כאן נרשמת ונבלעת */
const checkQuietly = (userId, msg) => check(userId, msg).catch((err) => {
  console.error('[משימון] בדיקת הודעה מול משימות שפתחתי נכשלה:', err.message);
  return 0;
});

// ---------------------------------------------------------------------------
// אישור
// ---------------------------------------------------------------------------

const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString('he-IL', { timeZone: W.TZ }) : '');

/** שורת המקור שבסוף ההערה — מאיפה, ממי, מתי, וקישור כשיש */
function sourceLine(sug, d, link) {
  if (d.channel === 'mail') {
    return [`📧 מהמייל של ${sug.from_name}${sug.from_email && sug.from_email !== sug.from_name ? ` · ${sug.from_email}` : ''} · ${shortDate(sug.received_at)}`,
      sug.subject ? `נושא: ${sug.subject}` : null, link ? `קישור למייל: ${link}` : null].filter(Boolean).join('\n');
  }
  if (d.personal) return `💬 מוואטסאפ של ${sug.from_name} · ${shortDate(sug.received_at)}${d.chatPhone ? `\nקישור לשיחה: https://wa.me/${d.chatPhone}` : ''}`;
  return `👥 מקבוצת הוואטסאפ "${d.groupName}" · ${sug.from_name} · ${shortDate(sug.received_at)}`;
}

/** הקבצים מהמייל — נקראים מחדש מ-Gmail רק עכשיו, באישור */
async function mailFiles(sug) {
  if (!sug.gmail_id) return [];
  try {
    const mail = Mime.parse((await Gmail.raw(Gmail.handle(sug.user_id, sug.box ?? 0), sug.gmail_id)).raw);
    return mail.attachments.map((a) => ({ filename: a.filename, mime: a.mime, data: a.data.toString('base64') }));
  } catch (err) {
    console.error('[משימון] קריאת הקבצים מהמייל נכשלה:', err.message);
    return [];
  }
}

/**
 * אישור. ‎edits‎:
 *   ‎comment‎ — ההערה אחרי עריכה (ברירת מחדל: קטע ההודעה)
 *   ‎close‎ — בעדכון: לסגור בכל זאת; בסגירה: ‎false‎ = רק הערה
 *   ‎applyDue‎ + ‎dueDate‎, ‎applyStatus‎ + ‎status‎ — רק מה שסומן במפורש
 * @returns {Promise<number>} מזהה המשימה
 */
async function approve(sug, actor, edits = {}) {
  if (sug.status !== 'pending' || !KINDS.includes(sug.kind)) throw new Error('ההצעה כבר טופלה');
  const d = parseJson(sug.data, {});
  const task = sug.task_id ? D.get('SELECT * FROM tasks WHERE id = ?', sug.task_id) : null;
  if (!task) {
    D.run("UPDATE ai_suggestions SET status = 'skipped', decided_at = ? WHERE id = ?", D.nowIso(), sug.id);
    throw new Error('המשימה כבר לא קיימת');
  }
  if (hooks.canSee && !hooks.canSee(actor, task)) throw Object.assign(new Error('אין לך גישה למשימה הזו'), { status: 403 });
  if (D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status)?.is_final) {
    D.run("UPDATE ai_suggestions SET status = 'skipped', decided_at = ? WHERE id = ?", D.nowIso(), sug.id);
    throw new Error('המשימה כבר סגורה');
  }
  const close = sug.kind === 'task_close' ? edits.close !== false : edits.close === true;

  // ההערה — ההודעה עצמה (או מה שהמשתמש ערך), עם המקור והקישור
  let link = null;
  if (d.channel === 'mail' && sug.gmail_id) {
    const conn = Gmail.connectionOf(sug.user_id);
    if (conn?.email) link = Gmail.webLink(conn.email, sug.gmail_id);
  }
  const text = String(edits.comment ?? d.comment ?? '').trim();
  const body = [text, '', sourceLine(sug, d, link)].join('\n').trim();
  const files = d.channel === 'mail' ? await mailFiles(sug) : [];
  const result = hooks.comment(actor, task, body, files);

  const done = [];
  if (close) {
    hooks.complete(actor, task.id, `${d.channel === 'mail' ? 'המייל' : 'ההודעה'} מ${sug.from_name} ענה/תה על המשימה`);
    done.push('נסגרה');
  } else {
    if (edits.applyDue && W.isDate(edits.dueDate ?? d.proposed?.dueDate)) {
      hooks.setDue(actor, task.id, edits.dueDate ?? d.proposed.dueDate);
      done.push('יעד');
    }
    if (edits.applyStatus && (edits.status ?? d.proposed?.status)) {
      hooks.setStatus(actor, task.id, edits.status ?? d.proposed.status);
      done.push('סטטוס');
    }
  }
  D.run("UPDATE ai_suggestions SET status = 'approved', decided_at = ? WHERE id = ?", D.nowIso(), sug.id);
  // נסגרה — הצעות אחרות על אותה משימה כבר לא רלוונטיות
  if (close) {
    D.run(`UPDATE ai_suggestions SET status = 'skipped', decided_at = ?
            WHERE task_id = ? AND status = 'pending' AND kind IN ('task_close','task_update') AND id <> ?`, D.nowIso(), task.id, sug.id);
  }
  return { taskId: task.id, done, files: result?.saved ?? 0, skippedFiles: result?.skipped ?? [] };
}

module.exports = {
  setHooks, check, checkQuietly, approve, displayTitle, KINDS,
  _internal: { score, prefilter, sanitize, prompt, contextOf, openCreatedBy, phoneKey, sourceLine }
};
