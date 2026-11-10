'use strict';
/**
 * 🔒 סיווג מידע לפי נושא ורמת רגישות — מקור האמת היחיד למי רואה ידע ארגוני.
 * האפיון: "אפיון — סיווג מידע רגיש.md".
 *
 * כל פריט מסווג לפי התוכן שלו, לא לפי מי כתב אותו או באיזו תיבה הוא נמצא.
 * לכל פריט נושא (מטבלת הנושאים) ורמה:
 *   1 🟢 כללי   — כל העובדים
 *   2 🔵 מקצועי — כל העובדים במחלקות של הנושא
 *   3 🟠 רגיש   — רק מנהלי המחלקות של הנושא, וההנהלה
 *   4 🔴 סודי   — ההנהלה בלבד
 *
 * ההנהלה (רואה הכול): אדמין על, ומשתמש בתפקיד "הנהלה" שאינו משויך למחלקה מקצועית
 * (בלי מחלקה, או מחלקה בשם "הנהלה" / "מנכ"ל"). "הנהלה" שמשויך למחלקה אחרת —
 * למשל סמנכ"ל כספים במחלקת כספים — מקבל את הסיווג של מנהל המחלקה שלו.
 * מנהל מערכת אינו הנהלה לעניין הזה (החלטת ההנהלה, 11.2026).
 *
 * כשל לכיוון הסגור: נושא לא מוכר, פריט שלא סווג, או שואל לא ידוע — הנהלה בלבד.
 */
const fs = require('node:fs');
const Paths = require('./paths');
const path = require('node:path');

const D = require('./db');

const LEVELS = [1, 2, 3, 4];
const LEVEL_LABELS = { 1: '🟢 כללי', 2: '🔵 מקצועי', 3: '🟠 רגיש', 4: '🔴 סודי' };
const LEVEL_HINTS = {
  1: 'כל העובדים',
  2: 'כל העובדים במחלקות של הנושא',
  3: 'רק מנהלי המחלקות של הנושא, וההנהלה',
  4: 'ההנהלה בלבד'
};
const LEADERSHIP_DEPT = /הנהלה|מנכ["״']?ל|דירקטור/;

const DEFAULTS = JSON.parse(fs.readFileSync(Paths.TOPICS, 'utf8')).topics;

const norm = (s) => String(s ?? '').trim().replace(/^מחלקת\s+/, '').replace(/["״׳']/g, '').toLowerCase();

function cleanTopic(t, fallback = {}) {
  const deps = Array.isArray(t?.departments) ? t.departments : String(t?.departments ?? '').split(/[,\n]+/);
  return {
    label: String(t?.label ?? fallback.label ?? '').trim().slice(0, 60) || fallback.label || '',
    departments: deps.map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
    floor: LEVELS.includes(Number(t?.floor)) ? Number(t.floor) : (fallback.floor ?? 4),
    examples: String(t?.examples ?? fallback.examples ?? '').trim().slice(0, 600)
  };
}

/** טבלת הנושאים — עם זיכרון קצר, כי בדיקת משימות קוראת לה לכל שורה */
let memo = { at: 0, table: null };
function topics() {
  if (memo.table && Date.now() - memo.at < 5000) return memo.table;
  memo = { at: Date.now(), table: loadTopics() };
  return memo.table;
}

/** טבלת הנושאים: ברירת המחדל, ומעליה מה שנערך במסך הניהול */
function loadTopics() {
  const saved = D.getSetting('knowledge_topics', null);
  const out = {};
  for (const [key, t] of Object.entries(DEFAULTS)) out[key] = cleanTopic(t);
  if (saved && typeof saved === 'object') {
    for (const [key, t] of Object.entries(saved)) {
      if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) continue;
      if (t === null) { delete out[key]; continue; }
      out[key] = cleanTopic(t, out[key]);
    }
  }
  return out;
}

function saveTopics(next) {
  if (!next || typeof next !== 'object') throw Object.assign(new Error('טבלה לא תקינה'), { status: 400 });
  const out = {};
  for (const [key, t] of Object.entries(next)) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) throw Object.assign(new Error(`מזהה נושא לא תקין: ${key}`), { status: 400 });
    out[key] = t === null ? null : cleanTopic(t, topics()[key]);
    if (out[key] && !out[key].label) throw Object.assign(new Error('לכל נושא צריך שם'), { status: 400 });
  }
  D.setSetting('knowledge_topics', out);
  memo = { at: 0, table: null };
  return topics();
}

// ---------------------------------------------------------------------------
// השואל — מחלקה, תפקיד, הנהלה
// ---------------------------------------------------------------------------

/**
 * ההיקף של השואל לעניין הסיווג. ‎actor‎ יכול להיות שחקן מלא או ‎{type, id, role}‎ —
 * המחלקה נשלפת מהמסד לפי המזהה, כדי שאף קורא לא יצטרך לזכור להעביר אותה.
 */
function scopeOf(actor) {
  if (!actor || actor.type === 'vendor' || !actor.id) return { known: false };
  const u = D.get("SELECT id, role, department, department_id, status FROM users WHERE id = ?", actor.id);
  if (!u || u.status !== 'active' || u.role === 'vendor') return { known: false };
  const pathNames = u.department_id ? D.departmentPath(u.department_id).split(' › ') : [];
  const names = (pathNames.length ? pathNames : [u.department]).map(norm).filter(Boolean);
  const managesDept = !!u.department_id && !!D.get('SELECT 1 FROM departments WHERE manager_user_id = ? LIMIT 1', u.id);
  const leader = u.role === 'superadmin' || (u.role === 'executive' && (!names.length || names.some((n) => LEADERSHIP_DEPT.test(n))));
  const manager = !leader && (u.role === 'manager' || u.role === 'executive' || managesDept);
  return { known: true, id: u.id, role: u.role, leader, manager, departments: names };
}

const inTopic = (scope, topic) =>
  topic.departments.includes('*') || topic.departments.some((d) => {
    const p = norm(d);
    return p && scope.departments.some((n) => n.includes(p));
  });

/** הרמה בפועל — הרצפה של הנושא גוברת על ה-AI. נושא לא מוכר — סודי */
function effectiveLevel(topicKey, level, table = topics()) {
  const topic = table[topicKey];
  if (!topic) return 4;
  const lvl = LEVELS.includes(Number(level)) ? Number(level) : 4;
  return Math.max(lvl, topic.floor);
}

/** האם שואל בהיקף הזה רשאי לראות פריט בנושא וברמה האלה */
function mayRead(scope, topicKey, level, table = topics()) {
  if (!scope?.known) return false;
  if (scope.leader) return true;
  const topic = table[topicKey];
  if (!topic || !level) return false;
  const lvl = effectiveLevel(topicKey, level, table);
  if (lvl === 1) return true;
  if (lvl === 4) return false;
  if (!inTopic(scope, topic)) return false;
  return lvl === 2 || scope.manager;
}

/** מסנן לרשימת פריטים עם ‎topic‎ ו-‎sens‎ — פעם אחת שליפת השואל והטבלה */
function readerFor(actor) {
  const scope = scopeOf(actor);
  const table = topics();
  // לא מסווג — הנהלה בלבד
  return { scope, may: (item) => !!item && (scope.leader || (!!item.classified && mayRead(scope, item.topic, item.sens, table))) };
}

// ---------------------------------------------------------------------------
// משימות ופרויקטים
// ---------------------------------------------------------------------------

/*
 * משימה או פרויקט בלי סיווג (‎sens = 0‎) — ההרשאות הרגילות בלבד, כמו תמיד.
 * עם סיווג, נוסף תנאי: משתתף במשימה (אחראי, אחראי נוסף, יוצר, מנהל הפרויקט),
 * או מי שטבלת הרגישות מתירה לו. התנאי רק מצמצם — לא פותח למי שלא ראה קודם.
 * משימה בלי סיווג משלה יורשת את הסיווג של הפרויקט שלה.
 */
const scopes = new WeakMap();
function cachedScope(actor) {
  if (!actor || typeof actor !== 'object') return scopeOf(actor);
  if (!scopes.has(actor)) scopes.set(actor, scopeOf(actor));
  return scopes.get(actor);
}

const ownClass = (row) => (row?.topic && Number(row.sens) > 0 ? { topic: row.topic, sens: Number(row.sens) } : null);

/** הסיווג בפועל של משימה: שלה, ואם אין — של הפרויקט */
function taskClass(task) {
  const own = ownClass(task);
  if (own || !task?.project_id) return own;
  return ownClass(D.get('SELECT topic, sens FROM projects WHERE id = ?', task.project_id));
}

function isTaskParticipant(actor, task) {
  const type = actor.type === 'vendor' ? 'vendor' : 'user';
  if (task.assignee_type === type && task.assignee_id === actor.id) return true;
  if (type === 'user' && task.created_by === actor.id) return true;
  if (D.get('SELECT 1 FROM task_assignees WHERE task_id = ? AND assignee_type = ? AND assignee_id = ?', task.id, type, actor.id)) return true;
  return type === 'user' && !!task.project_id && !!D.get('SELECT 1 FROM projects WHERE id = ? AND manager_id = ?', task.project_id, actor.id);
}

/** האם הסיווג מתיר לשחקן לראות את המשימה (בנוסף להרשאות הרגילות) */
function mayReadTask(actor, task) {
  if (!task) return false;
  const c = taskClass(task);
  if (!c) return true;
  const table = topics();
  if (effectiveLevel(c.topic, c.sens, table) <= 1) return true;
  if (!actor) return false;
  if (isTaskParticipant(actor, task)) return true;
  return actor.type !== 'vendor' && mayRead(cachedScope(actor), c.topic, c.sens, table);
}

/** האם הסיווג מתיר לשחקן לראות את הפרויקט — מנהלו ופותחו תמיד, ומי שיש לו בו משימה */
function mayReadProject(actor, project) {
  const c = ownClass(project);
  if (!c) return true;
  const table = topics();
  if (effectiveLevel(c.topic, c.sens, table) <= 1) return true;
  if (!actor || actor.type === 'vendor') return false;
  if (project.manager_id === actor.id || project.created_by === actor.id) return true;
  if (mayRead(cachedScope(actor), c.topic, c.sens, table)) return true;
  return !!D.get(`SELECT 1 FROM tasks t WHERE t.project_id = ? AND ((t.assignee_type = 'user' AND t.assignee_id = ?)
    OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.assignee_type = 'user' AND ta.assignee_id = ?)) LIMIT 1`, project.id, actor.id, actor.id);
}

/** סיווג לתצוגה — ‎null‎ כשאין */
function classView(row, table = topics()) {
  const c = ownClass(row);
  if (!c) return null;
  const level = effectiveLevel(c.topic, c.sens, table);
  return { topic: c.topic, sens: level, label: `${table[c.topic]?.label ?? c.topic} · ${LEVEL_LABELS[level]}` };
}

/** קלט מטופס: ‎{topic, sens}‎ תקין, או ‎{topic: '', sens: 0}‎ לביטול */
function parseClass(topic, sens) {
  const table = topics();
  if (!topic || !table[topic] || !Number(sens)) return { topic: '', sens: 0 };
  return { topic, sens: effectiveLevel(topic, Number(sens), table) };
}

/** הטקסט לסקיל הזיקוק והסיווג: הנושאים, המחלקות והדוגמאות */
function promptTable(table = topics()) {
  return [
    'טבלת הנושאים (key — שם · רמת מינימום · דוגמאות):',
    ...Object.entries(table).map(([k, t]) => `- ${k} — ${t.label} · מינימום ${t.floor} · ${t.examples}`),
    '',
    'הרמות: 1 כללי (כל העובדים) · 2 מקצועי (עובדי המחלקות של הנושא) · 3 רגיש (מנהלי המחלקות של הנושא והנהלה) · 4 סודי (הנהלה בלבד).'
  ].join('\n');
}

/** מי ההנהלה לפי ההגדרה — למסך הניהול, כדי שיהיה ברור מי רואה הכול */
function leadershipList() {
  return D.all("SELECT id, full_name, role FROM users WHERE status = 'active' AND role IN ('superadmin', 'executive') ORDER BY full_name")
    .map((u) => ({ ...u, scope: scopeOf({ type: 'user', id: u.id }) }))
    .map(({ id, full_name, role, scope }) => ({ id, name: full_name, role, leader: scope.leader, departments: scope.departments }));
}

/** "איך זה נראה לעובד": לכל נושא — עד איזו רמה עובד בהיקף הזה רואה */
function preview({ departmentId = null, role = 'employee' } = {}) {
  const pathNames = departmentId ? D.departmentPath(Number(departmentId)).split(' › ') : [];
  const names = pathNames.map(norm).filter(Boolean);
  const leader = role === 'superadmin' || (role === 'executive' && (!names.length || names.some((n) => LEADERSHIP_DEPT.test(n))));
  const scope = { known: true, leader, manager: !leader && ['manager', 'executive'].includes(role), departments: names };
  const table = topics();
  return Object.entries(table).map(([key, t]) => ({
    key, label: t.label,
    upTo: [4, 3, 2, 1].find((l) => l >= t.floor && mayRead(scope, key, l, table)) ?? 0
  }));
}

module.exports = {
  LEVELS, LEVEL_LABELS, LEVEL_HINTS, DEFAULTS,
  topics, saveTopics, scopeOf, mayRead, effectiveLevel, readerFor, promptTable, leadershipList, preview,
  taskClass, mayReadTask, mayReadProject, classView, parseClass,
  _internal: { inTopic, norm }
};
