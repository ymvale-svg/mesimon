'use strict';
/**
 * משימות כפולות במחלקה — הצעה למיזוג (אפיון, פרק 11ב).
 *
 * מתי בודקים:
 *   • בפתיחת משימה בדיאלוג — לפני היצירה (‎similarForNew‎). המשתמש בוחר: לפתוח
 *     בכל זאת / לא לפתוח / להצטרף למשימה שכבר קיימת.
 *   • בפתיחה מכל מסלול אחר (הצעה מהמייל, הקלטה, בוט, משימת AI) — אין את מי
 *     לשאול באותו רגע, ולכן המשימה נפתחת, ומיד אחר כך נבדק אם יש כפולה
 *     (‎checkCreated‎). אם כן — הצעת מיזוג.
 *   • סריקה יומית של המשימות הפתוחות בכל מחלקה (‎dailyScan‎).
 *
 * רק בתוך המחלקה (‎tasks.department_id‎ זהה): "בטון לשלב ב'" אצל הרכש ואצל
 * ההנדסה הן לעיתים שתי עבודות שונות של אותו פרויקט.
 *
 * ההכרעה: סינון זול (‎task-match.js‎) בוחר מועמדים מעטים, וה-AI מחליט אם זו
 * אותה עבודה. בלי AI — הציון לבדו, בסף גבוה יותר.
 *
 * הצעת המיזוג נשלחת לאחראים של שתי המשימות. מספיק אישור אחד, ואז ההצעה
 * נעלמת אצל השאר. "לא כפולות" — הזוג לא יוצע שוב לעולם (‎task_pair_decisions‎).
 *
 * המיזוג: הוותיקה נשארת; החדשה נסגרת ומצביעה עליה. האחראים, ההערות, הקבצים
 * והצ'קליסט עוברים לוותיקה, והיעד — המוקדם מבין השניים.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const Claude = require('./claude');
const Match = require('./task-match');

const SKILL = path.join(__dirname, 'skills', 'task-duplicates.md');
// מעל זה — מועמד שה-AI יבדוק
const PREFILTER = 0.45;
// בלי AI — רק מעל זה נחשב כפול
const HEURISTIC_MIN = 0.85;
// בדיאלוג מחכים ל-AI לכל היותר כך, ואחר כך מסתפקים בציון
const DIALOG_AI_MS = 8000;
// בסריקה היומית — כמה זוגות לכל מחלקה, לכל היותר
const DAILY_PAIRS = 12;

const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

/** מוזרק מ-api.js: סגירה במסלול הרגיל (יומן, התראות), וראייה לפי ההרשאות */
const hooks = { closeTask: null, canSeeTask: null };
const setHooks = (h) => Object.assign(hooks, h);

// ---------------------------------------------------------------------------
// המשימות
// ---------------------------------------------------------------------------

const OPEN_SQL = `SELECT t.* FROM tasks t
   JOIN boards b ON b.id = t.board_id AND b.type = 'internal'
   LEFT JOIN board_columns bc ON bc.board_id = t.board_id AND bc.key = t.status
  WHERE t.archived = 0 AND COALESCE(bc.is_final, 0) = 0 AND t.merged_into_task_id IS NULL
    AND (t.activate_at IS NULL OR t.activate_at <= ?)`;

/** המשימות הפתוחות של מחלקה אחת — בבורד הפנימי, לא מתוזמנות לעתיד */
const openInDepartment = (departmentId) => (departmentId
  ? D.all(`${OPEN_SQL} AND t.department_id = ? ORDER BY t.id`, D.nowIso(), departmentId)
  : []);

const taskById = (id) => D.get('SELECT * FROM tasks WHERE id = ?', id);

function isOpen(task) {
  if (!task || task.archived || task.merged_into_task_id) return false;
  return !D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status)?.is_final;
}

const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';

/** "אצל מי" — האחראי הראשי, ואם אין — מי שפתח */
function ownerName(task) {
  if (task.assignee_type === 'vendor') return D.get('SELECT name FROM vendors WHERE id = ?', task.assignee_id)?.name ?? 'ספק';
  return nameOf(task.assignee_id ?? task.created_by) || 'ללא אחראי';
}

/** כל העובדים האחראים על המשימה — ראשי ונוספים, פעילים בלבד */
function assigneeUsers(task) {
  const ids = new Set();
  if (task.assignee_type === 'user' && task.assignee_id) ids.add(task.assignee_id);
  for (const r of D.all("SELECT assignee_id FROM task_assignees WHERE task_id = ? AND assignee_type = 'user'", task.id)) ids.add(r.assignee_id);
  return [...ids].filter((id) => D.get("SELECT 1 FROM users WHERE id = ? AND status = 'active'", id));
}

const involved = (userId, task) => assigneeUsers(task).includes(userId) || task.created_by === userId;

const spec = (t) => ({ id: t.id, title: t.title, description: t.description ?? '', projectId: t.project_id ?? null });

const projectName = (id) => (id ? D.get('SELECT name FROM projects WHERE id = ?', id)?.name ?? '' : '');

// ---------------------------------------------------------------------------
// זוגות והחלטות
// ---------------------------------------------------------------------------

const pair = (a, b) => (a < b ? [a, b] : [b, a]);
const pairKey = (a, b) => `merge:${pair(a, b).join(':')}`;

const decision = (a, b) => D.get('SELECT decision FROM task_pair_decisions WHERE task_a = ? AND task_b = ?', ...pair(a, b))?.decision ?? null;

function decide(a, b, value, userId) {
  const [x, y] = pair(a, b);
  D.run(
    `INSERT INTO task_pair_decisions (task_a, task_b, decision, decided_by, decided_at) VALUES (?,?,?,?,?)
     ON CONFLICT(task_a, task_b) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
    x, y, value, userId ?? null, D.nowIso()
  );
}

/** הזוג כבר הוכרע, או כבר הוצע (בכל מצב) — לא מציעים שוב */
const settled = (a, b) => Boolean(decision(a, b) || D.get("SELECT 1 FROM ai_suggestions WHERE kind = 'task_merge' AND header_id = ?", pairKey(a, b)));

/** אב ותת-משימה שלו, או משימה והמשימה שהיא תלויה בה — אינן כפולות */
function related(a, b) {
  return a.parent_task_id === b.id || b.parent_task_id === a.id
    || a.depends_on_task_id === b.id || b.depends_on_task_id === a.id
    || a.recurrence_parent === b.id || b.recurrence_parent === a.id
    || (a.recurrence_parent && a.recurrence_parent === b.recurrence_parent);
}

// ---------------------------------------------------------------------------
// ההכרעה
// ---------------------------------------------------------------------------

/** מועמדים לפי הציון בלבד — ‎[{task, score}]‎, מהדומה ביותר */
function candidates(target, pool, { limit = 3, min = PREFILTER } = {}) {
  return pool
    .filter((t) => t.id !== target.id && !related(target, t))
    .map((t) => ({ task: t, score: Match.similarity(spec(target), spec(t)) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score || a.task.id - b.task.id)
    .slice(0, limit);
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pairs'],
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['pair', 'same', 'reason'],
        properties: {
          pair: { type: 'integer', description: 'מספר הזוג מהרשימה' },
          same: { type: 'boolean', description: 'true רק כשזו בבירור אותה עבודה' },
          reason: { type: 'string', description: 'משפט קצר' }
        }
      }
    }
  }
};

const describe = (t) => [
  `"${t.title}"`,
  t.project_id ? `פרויקט: ${projectName(t.project_id)}` : null,
  `אצל: ${ownerName(t)}`,
  t.due_date ? `יעד: ${String(t.due_date).slice(0, 10)}` : null,
  t.description ? `תיאור: ${String(t.description).replace(/\s+/g, ' ').slice(0, 300)}` : null
].filter(Boolean).join(' · ');

/**
 * מה שחזר מה-AI — רק מספרי זוגות שקיימים, ורק "same". טהורה.
 * @returns {Set<number>}  מספרי הזוגות (מ-1) שה-AI אישר
 */
function sanitizeJudgement(out, count) {
  const ok = new Set();
  for (const p of Array.isArray(out?.pairs) ? out.pairs : []) {
    const n = Number(p.pair);
    if (p.same === true && Number.isInteger(n) && n >= 1 && n <= count) ok.add(n);
  }
  return ok;
}

/**
 * אילו מהזוגות הם באמת אותה עבודה. ‎pairs‎ — ‎[{a, b, score}]‎ (משימות, או
 * טיוטה בלי מזהה ב-‎a‎). בלי AI, או כשה-AI נכשל — לפי הציון בסף הגבוה.
 */
async function judge(pairs, { timeoutMs = 0 } = {}) {
  if (!pairs.length) return [];
  const fallback = () => pairs.filter((p) => p.score >= HEURISTIC_MIN);
  if (!Claude.isEnabled()) return fallback();
  const text = [
    'לכל זוג — האם שתי המשימות הן אותה עבודה (מישהו יעשה אותה פעמיים), או שתי עבודות שונות.',
    '',
    ...pairs.map((p, i) => `זוג ${i + 1}:\n  א. ${describe(p.a)}\n  ב. ${describe(p.b)}`)
  ].join('\n');
  try {
    const call = Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text }], schema: SCHEMA, effort: 'low' });
    const out = timeoutMs
      ? await Promise.race([call, new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.(); })])
      : await call;
    const ok = sanitizeJudgement(out, pairs.length);
    return pairs.filter((_, i) => ok.has(i + 1));
  } catch (err) {
    console.error('[משימון] בדיקת משימות כפולות ב-AI נכשלה — לפי הציון בלבד:', err.message);
    return fallback();
  }
}

// ---------------------------------------------------------------------------
// בפתיחת משימה
// ---------------------------------------------------------------------------

/**
 * הדיאלוג "משימה חדשה", לפני היצירה: יש כבר משימה פתוחה דומה במחלקה?
 * ‎departmentId‎ — המחלקה שהמשימה תיפתח בה (כמו ב-‎createTask‎).
 */
async function similarForNew(actor, { title, description = '', projectId = null, departmentId = null }) {
  if (!departmentId || !String(title ?? '').trim()) return [];
  const draft = { id: 0, title: String(title), description: String(description ?? ''), project_id: projectId ? Number(projectId) : null };
  const pool = openInDepartment(departmentId);
  const found = await judge(candidates(draft, pool).map((c) => ({ a: draft, b: c.task, score: c.score })), { timeoutMs: DIALOG_AI_MS });
  return found.map(({ b: t, score }) => ({
    id: t.id,
    title: t.title,
    owner: ownerName(t),
    ownerId: t.assignee_type === 'user' ? t.assignee_id : null,
    projectName: projectName(t.project_id) || null,
    dueDate: t.due_date,
    score,
    // מי שכבר בתוכה — "להצטרף" אינו רלוונטי
    involved: involved(actor.id, t),
    visible: hooks.canSeeTask ? hooks.canSeeTask(actor, t) : false
  }));
}

/**
 * "להצטרף למשימה של יוסי" — אחראי נוסף, בלי משימה חדשה. מותר כשהמשימה פתוחה
 * ובמחלקה של המצטרף (שם היא נמצאה), או כשהוא כבר רואה אותה.
 */
function join(actor, taskId) {
  const task = taskById(Number(taskId));
  if (!task || !isOpen(task)) throw Object.assign(new Error('המשימה כבר לא פתוחה'), { status: 400 });
  const inDept = task.department_id && (actor.departmentIds ?? [actor.departmentId]).includes(task.department_id);
  if (!inDept && !(hooks.canSeeTask && hooks.canSeeTask(actor, task))) throw Object.assign(new Error('אין לך גישה למשימה הזו'), { status: 403 });
  if (involved(actor.id, task) && task.created_by !== actor.id) return task.id;
  D.run(`INSERT OR IGNORE INTO task_assignees (task_id, assignee_type, assignee_id, added_at, added_by) VALUES (?, 'user', ?, ?, ?)`,
    task.id, actor.id, D.nowIso(), actor.id);
  D.audit(task.id, { type: 'user', id: actor.id, name: actor.name }, 'assignees', `${actor.name} הצטרף/ה כאחראי/ת נוסף/ת (במקום לפתוח משימה כפולה)`);
  for (const uid of assigneeUsers(task)) {
    if (uid === actor.id) continue;
    D.notify({ targetType: 'user', targetId: uid, kind: 'assignment', title: `${actor.name} הצטרף/ה למשימה`, body: task.title, taskId: task.id });
  }
  return task.id;
}

/** "לפתוח בכל זאת" — הזוגות שהוצגו בדיאלוג לא יוצעו שוב כמיזוג */
function keepApart(taskId, otherIds, userId) {
  for (const id of otherIds) {
    if (Number(id) && Number(id) !== taskId && taskById(Number(id))) decide(taskId, Number(id), 'not_duplicate', userId);
  }
}

/**
 * אחרי יצירה ממסלול שאין בו את מי לשאול (הצעה, הקלטה, בוט, משימת AI): אם
 * יש במחלקה משימה פתוחה שזו אותה עבודה — הצעת מיזוג לאחראים של שתיהן.
 */
async function checkCreated(taskId) {
  const task = taskById(taskId);
  if (!task || !isOpen(task)) return null;
  const pool = openInDepartment(task.department_id).filter((t) => t.id !== task.id && !settled(task.id, t.id));
  const found = await judge(candidates(task, pool, { limit: 2 }).map((c) => ({ a: c.task, b: task, score: c.score })));
  if (!found.length) return null;
  return raise(found[0].a, task, { reason: 'בפתיחת המשימה' });
}

// ---------------------------------------------------------------------------
// ההצעה
// ---------------------------------------------------------------------------

/** הוותיקה נשארת — לפי זמן הפתיחה, ובשוויון לפי המזהה */
const order = (x, y) => ((x.created_at < y.created_at || (x.created_at === y.created_at && x.id < y.id)) ? [x, y] : [y, x]);

const mergeTitle = (keep, drop) => `🔀 למזג? "${drop.title}" (אצל ${ownerName(drop)}) ו"${keep.title}" (אצל ${ownerName(keep)})`;

/**
 * הצעת מיזוג — שורה לכל אחראי של שתי המשימות (ובלי אחראים — למי שפתח אותן).
 * כולן באותו ‎header_id‎: אישור או דחייה של אחד סוגרים את כולן.
 */
function raise(t1, t2, { reason = '' } = {}) {
  if (!isOpen(t1) || !isOpen(t2) || settled(t1.id, t2.id)) return null;
  const [keep, drop] = order(t1, t2);
  let users = [...new Set([...assigneeUsers(keep), ...assigneeUsers(drop)])];
  if (!users.length) users = [...new Set([keep.created_by, drop.created_by].filter(Boolean))];
  if (!users.length) return null;
  const header = pairKey(keep.id, drop.id);
  const data = {
    merge: true,
    title: mergeTitle(keep, drop),
    keepId: keep.id, keepTitle: keep.title, keepOwner: ownerName(keep),
    dropId: drop.id, dropTitle: drop.title, dropOwner: ownerName(drop),
    projectName: projectName(keep.project_id) || projectName(drop.project_id) || null,
    reason,
    receivedAt: D.nowIso()
  };
  const ids = [];
  for (const uid of users) {
    const r = D.run(
      `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, task_id, created_at)
       VALUES (?, 'task_merge', 'pending', '', ?, 'משימון', '', ?, ?, ?, ?, ?)`,
      uid, header, `${drop.title} / ${keep.title}`.slice(0, 300), D.nowIso(), JSON.stringify(data), drop.id, D.nowIso()
    );
    ids.push(Number(r.lastInsertRowid));
    D.notify({
      targetType: 'user', targetId: uid, kind: 'ai',
      title: '🔀 נראה שיש משימה כפולה במחלקה',
      body: `"${drop.title}" (אצל ${data.dropOwner}) ו"${keep.title}" (אצל ${data.keepOwner}) — למזג? ב"ממתין לאישורך".`,
      taskId: keep.id
    });
  }
  return { header, ids, keepId: keep.id, dropId: drop.id };
}

// ---------------------------------------------------------------------------
// המיזוג
// ---------------------------------------------------------------------------

const actorRef = (actor) => (actor ? { type: 'user', id: actor.id, name: actor.name } : { type: 'system', id: null, name: 'המערכת' });

/**
 * מיזוג ‎drop‎ לתוך ‎keep‎. הליבה — פעולות על המסד בלבד; הסגירה של ‎drop‎
 * עוברת ב-‎hooks.closeTask‎ (המסלול הרגיל של שינוי סטטוס: יומן והתראות).
 * @returns {{moved: object}}  מה עבר
 */
function mergeInto(keepId, dropId, actor) {
  const keep = taskById(keepId);
  const drop = taskById(dropId);
  if (!keep || !drop) throw new Error('אחת המשימות כבר לא קיימת');
  if (!isOpen(keep) || !isOpen(drop)) throw new Error('אחת המשימות כבר סגורה');
  const now = D.nowIso();
  const moved = { assignees: [], comments: 0, attachments: 0, checklist: 0, subtasks: 0, due: null };

  D.db.exec('BEGIN');
  try {
    // האחראים — של שתיהן, על הוותיקה. הראשי של הוותיקה נשאר ראשי
    const have = new Set([keep.assignee_type && keep.assignee_id ? `${keep.assignee_type}:${keep.assignee_id}` : null,
      ...D.all('SELECT assignee_type, assignee_id FROM task_assignees WHERE task_id = ?', keep.id).map((r) => `${r.assignee_type}:${r.assignee_id}`)].filter(Boolean));
    const incoming = [drop.assignee_type && drop.assignee_id ? { type: drop.assignee_type, id: drop.assignee_id } : null,
      ...D.all('SELECT assignee_type AS type, assignee_id AS id FROM task_assignees WHERE task_id = ?', drop.id)].filter(Boolean);
    for (const a of incoming) {
      if (have.has(`${a.type}:${a.id}`)) continue;
      have.add(`${a.type}:${a.id}`);
      D.run('INSERT OR IGNORE INTO task_assignees (task_id, assignee_type, assignee_id, added_at, added_by) VALUES (?,?,?,?,?)',
        keep.id, a.type, a.id, now, actor?.id ?? null);
      moved.assignees.push(a.type === 'vendor' ? D.get('SELECT name FROM vendors WHERE id = ?', a.id)?.name ?? 'ספק' : nameOf(a.id));
    }
    // משימה בלי אחראי ראשי מקבלת את הראשי של השנייה
    if (!keep.assignee_id && drop.assignee_type === 'user' && drop.assignee_id) {
      D.run('UPDATE tasks SET assignee_type = ?, assignee_id = ? WHERE id = ?', 'user', drop.assignee_id, keep.id);
      D.run("DELETE FROM task_assignees WHERE task_id = ? AND assignee_type = 'user' AND assignee_id = ?", keep.id, drop.assignee_id);
    }

    // הערות וקבצים — עוברים כמו שהם, עם הכותב והזמן המקוריים
    moved.comments = Number(D.run('UPDATE comments SET task_id = ? WHERE task_id = ?', keep.id, drop.id).changes);
    moved.attachments = Number(D.run('UPDATE attachments SET task_id = ? WHERE task_id = ?', keep.id, drop.id).changes);
    // הצ'קליסט — בסוף הרשימה של הוותיקה, באותו סדר
    const base = (D.get('SELECT MAX(position) p FROM checklist_items WHERE task_id = ?', keep.id)?.p ?? -1) + 1;
    moved.checklist = Number(D.run('UPDATE checklist_items SET task_id = ?, position = position + ? WHERE task_id = ?', keep.id, base, drop.id).changes);
    // תתי-משימות ותלויות — מצביעות מעכשיו על מה שנשאר
    moved.subtasks = Number(D.run('UPDATE tasks SET parent_task_id = ? WHERE parent_task_id = ? AND id <> ?', keep.id, drop.id, keep.id).changes);
    D.run('UPDATE tasks SET depends_on_task_id = ? WHERE depends_on_task_id = ? AND id <> ?', keep.id, drop.id, keep.id);

    // היעד — המוקדם מבין השניים
    const dues = [keep.due_date, drop.due_date].filter(Boolean).sort();
    if (dues.length && dues[0] !== keep.due_date) {
      D.run('UPDATE tasks SET due_date = ? WHERE id = ?', dues[0], keep.id);
      moved.due = dues[0];
    }

    // התיאור של החדשה לא הולך לאיבוד — הערה על הוותיקה
    D.run('INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,1,?)',
      keep.id, 'system', null,
      `🔀 מוזגה לכאן המשימה #${drop.id} "${drop.title}" (אצל ${ownerName(drop)})${drop.description?.trim() ? `\n${drop.description.trim()}` : ''}`, now);
    D.run('INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,1,?)',
      drop.id, 'system', null, `🔀 המשימה מוזגה אל #${keep.id} "${keep.title}" — ההמשך שם.`, now);
    D.run('UPDATE tasks SET merged_into_task_id = ? WHERE id = ?', keep.id, drop.id);
    decide(keep.id, drop.id, 'merged', actor?.id);

    const parts = [
      moved.assignees.length ? `אחראים: ${moved.assignees.join(', ')}` : null,
      moved.comments ? `${moved.comments} הערות` : null,
      moved.attachments ? `${moved.attachments} קבצים` : null,
      moved.checklist ? `${moved.checklist} סעיפים` : null,
      moved.due ? `יעד: ${moved.due.slice(0, 10)}` : null
    ].filter(Boolean);
    D.audit(keep.id, actorRef(actor), 'merged', `מוזגה לכאן המשימה #${drop.id} "${drop.title}"${parts.length ? ` — עברו: ${parts.join(' · ')}` : ''}`);
    D.audit(drop.id, actorRef(actor), 'merged', `המשימה מוזגה אל #${keep.id} "${keep.title}"`);
    D.db.exec('COMMIT');
  } catch (err) {
    D.db.exec('ROLLBACK');
    throw err;
  }

  // סגירה במסלול הרגיל — מחוץ לעסקה: הוא שולח התראות ומיילים
  if (hooks.closeTask) hooks.closeTask(actor, drop.id, `מוזגה אל #${keep.id}`);

  // הצעות פתוחות על המשימה שנסגרה — כבר לא רלוונטיות
  D.run(`UPDATE ai_suggestions SET status = 'skipped', decided_at = ?
          WHERE status = 'pending' AND kind IN ('task_merge','task_close','task_update') AND task_id = ? AND header_id <> ?`,
  D.nowIso(), drop.id, pairKey(keep.id, drop.id));
  return { keepId: keep.id, dropId: drop.id, moved };
}

/** אישור הצעת מיזוג — מי שההצעה אצלו, כשהוא עדיין אחראי על אחת מהן */
function approve(sug, actor) {
  if (sug.status !== 'pending') throw new Error('ההצעה כבר טופלה');
  const d = parseJson(sug.data, {});
  const keep = taskById(d.keepId);
  const drop = taskById(d.dropId);
  if (!keep || !drop || !isOpen(keep) || !isOpen(drop)) {
    D.run("UPDATE ai_suggestions SET status = 'skipped', decided_at = ? WHERE header_id = ? AND status = 'pending'", D.nowIso(), sug.header_id);
    throw new Error('אחת המשימות כבר סגורה — אין מה למזג');
  }
  // האחראים על אחת מהשתיים (ובלי אחראים — מי שפתח אותן), כמו מקבלי ההצעה
  const owners = [...assigneeUsers(keep), ...assigneeUsers(drop)];
  const allowed = owners.length ? owners.includes(actor.id) : [keep.created_by, drop.created_by].includes(actor.id);
  if (!allowed) throw Object.assign(new Error('רק האחראים על המשימות יכולים למזג אותן'), { status: 403 });
  const out = mergeInto(keep.id, drop.id, actor);
  // אישור אחד מספיק — אצל השאר ההצעה נעלמת
  D.run("UPDATE ai_suggestions SET status = 'approved', decided_at = ? WHERE header_id = ? AND id <> ? AND status = 'pending'", D.nowIso(), sug.header_id, sug.id);
  D.run("UPDATE ai_suggestions SET status = 'approved', task_id = ?, decided_at = ? WHERE id = ?", keep.id, D.nowIso(), sug.id);
  for (const uid of assigneeUsers(taskById(keep.id))) {
    if (uid === actor.id) continue;
    D.notify({ targetType: 'user', targetId: uid, kind: 'assignment', title: `${actor.name} מיזג/ה משימות כפולות`, body: `"${drop.title}" מוזגה אל "${keep.title}"`, taskId: keep.id });
  }
  return out.keepId;
}

/** "לא כפולות" — הזוג לא יוצע שוב, אצל אף אחד */
function reject(sug, actor) {
  if (sug.status !== 'pending') return;
  const d = parseJson(sug.data, {});
  if (d.keepId && d.dropId) decide(d.keepId, d.dropId, 'not_duplicate', actor.id);
  D.run("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE header_id = ? AND status = 'pending'", D.nowIso(), sug.header_id);
}

/** "ביטול" מיד אחרי "לא כפולות" — ההחלטה נמחקת וההצעה חוזרת לכולם */
function restore(sug) {
  if (sug.status !== 'rejected') throw new Error('ההצעה אינה דחויה');
  if (sug.decided_at && Date.now() - new Date(sug.decided_at).getTime() > 3600e3) throw new Error('עבר יותר מדי זמן מהדחייה');
  const d = parseJson(sug.data, {});
  if (d.keepId && d.dropId && decision(d.keepId, d.dropId) === 'not_duplicate') {
    D.run('DELETE FROM task_pair_decisions WHERE task_a = ? AND task_b = ?', ...pair(d.keepId, d.dropId));
  }
  D.run("UPDATE ai_suggestions SET status = 'pending', decided_at = NULL WHERE header_id = ? AND status = 'rejected' AND decided_at >= ?",
    sug.header_id, new Date(new Date(sug.decided_at ?? Date.now()).getTime() - 5000).toISOString());
}

// ---------------------------------------------------------------------------
// הסריקה היומית
// ---------------------------------------------------------------------------

/** זוגות מועמדים במחלקה אחת, מהדומה ביותר — טהורה מול רשימת המשימות */
function departmentPairs(tasks, { limit = DAILY_PAIRS, skip = () => false } = {}) {
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (related(a, b) || skip(a, b)) continue;
      const score = Match.similarity(spec(a), spec(b));
      if (score >= PREFILTER) out.push({ a, b, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

let scanning = false;

/** פעם ביום, מהשעה שהוגדרה (ברירת מחדל 06:30): כל מחלקה, זוגות חדשים בלבד */
async function dailyScan({ force = false } = {}) {
  if (scanning) return null;
  const W = require('../workdays');
  const now = W.ilParts();
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(D.getSetting('dup_scan_time', '06:30')));
  const at = m ? Number(m[1]) * 60 + Number(m[2]) : 390;
  if (!force && (now.minutes < at || D.getSetting('dup_scan_last', '') === now.date)) return null;
  if (!force && D.getSetting('dup_scan_enabled', true) === false) return null;
  D.setSetting('dup_scan_last', now.date);
  scanning = true;
  const summary = { departments: 0, checked: 0, raised: 0 };
  try {
    for (const { department_id: dept } of D.all('SELECT DISTINCT department_id FROM tasks WHERE department_id IS NOT NULL AND archived = 0')) {
      const tasks = openInDepartment(dept);
      if (tasks.length < 2) continue;
      summary.departments++;
      const pairs = departmentPairs(tasks, { skip: (a, b) => settled(a.id, b.id) });
      summary.checked += pairs.length;
      const used = new Set();
      for (const p of await judge(pairs)) {
        // משימה אחת — בהצעה אחת ביום, כדי שלא ייפתחו שלוש הצעות על אותה משימה
        if (used.has(p.a.id) || used.has(p.b.id)) continue;
        if (raise(p.a, p.b, { reason: 'סריקה יומית' })) {
          used.add(p.a.id);
          used.add(p.b.id);
          summary.raised++;
        }
      }
    }
  } finally {
    scanning = false;
  }
  return summary;
}

let timer = null;
function start() {
  if (timer) clearInterval(timer);
  const run = () => dailyScan().catch((err) => console.error('[משימון] הסריקה היומית של משימות כפולות נכשלה:', err.message));
  timer = setInterval(run, 10 * 60000);
  timer.unref?.();
  setTimeout(run, 60000).unref?.();
}

module.exports = {
  setHooks, similarForNew, join, keepApart, checkCreated, raise, approve, reject, restore, mergeInto, dailyScan, start,
  pairKey, decision, PREFILTER, HEURISTIC_MIN,
  _internal: { candidates, departmentPairs, sanitizeJudgement, judge, related, order, openInDepartment, assigneeUsers }
};
