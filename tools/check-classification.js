'use strict';
/**
 * בדיקת הסיווג לפי נושא ורמת רגישות (‎server/ai/classification.js‎) — על מסד זמני.
 *   node tools/check-classification.js
 * ה-AI מוחלף בתשובות קבועות, כדי לבדוק את הזיקוק, האיחוד והסיווג מחדש בלי רשת.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimon-cls-'));
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';

const D = require('../server/db');
const Claude = require('../server/ai/claude');
D.bootstrap();

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

// --- מחלקות ומשתמשים ---------------------------------------------------------
const now = D.nowIso();
const dept = (name, parent = null) => Number(D.run('INSERT INTO departments (name, created_at, parent_id) VALUES (?,?,?)', name, now, parent).lastInsertRowid);
let seq = 0;
const user = (name, role, deptId) => Number(D.run(
  "INSERT INTO users (full_name, email, password_hash, role, department, department_id, status, created_at) VALUES (?,?,?,?,?,?,'active',?)",
  name, `u${++seq}@t.test`, D.hashPassword('1234'), role, '', deptId, now).lastInsertRowid);

const bedek = dept('בדק');
const coord = dept('מתאמות בדק', bedek);
const finance = dept('כספים');
const ops = dept('תפעול');
const hr = dept('משאבי אנוש');
const mgmt = dept('הנהלה');

const U = {
  coordinator: user('מתאמת', 'employee', coord),
  bedekMgr: user('מנהל בדק', 'manager', bedek),
  opsEmp: user('עובד תפעול', 'employee', ops),
  cfo: user('סמנכל כספים', 'executive', finance),
  hrMgr: user('מנהלת משאבי אנוש', 'manager', hr),
  sysAdmin: user('מנהל מערכת', 'admin', ops),
  ceo: user('מנכל', 'executive', mgmt),
  owner: user('אדמין על', 'superadmin', null),
  opsMgr: user('מנהל תפעול', 'manager', ops)
};
D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', U.bedekMgr, bedek);
const actor = (id) => ({ type: 'user', id, role: D.get('SELECT role FROM users WHERE id = ?', id).role });

// --- ערכים לפני הסיווג: נעולים במעבר ------------------------------------------
D.db.exec(`CREATE TABLE IF NOT EXISTS org_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, dept TEXT NOT NULL DEFAULT 'other', project TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, cases INTEGER NOT NULL DEFAULT 0, contributors INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, dept_only INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'pro', classified INTEGER NOT NULL DEFAULT 0, scheme INTEGER NOT NULL DEFAULT 0)`);
D.run("INSERT INTO org_knowledge (domain, text, level, classified, scheme, created_at, updated_at) VALUES ('מנהל פרויקט אלעד', 'מנהל הפרויקט של אלעד קיבל רכב שכור מהחברה', 'pro', 1, 2, ?, ?)", now, now);

const Org = require('../server/ai/org-knowledge');
const Cls = require('../server/ai/classification');

const legacy = D.get('SELECT * FROM org_knowledge WHERE id = 1');
check('מעבר: ערך "מקצועי" ישן ננעל (לא מסווג)', legacy.classified === 0);
check('מעבר: עובד תפעול לא מקבל ערך ישן לפני סיווג', Org.search('מנהל פרויקט אלעד רכב', { actor: actor(U.opsEmp) }).length === 0);
check('מעבר: אדמין על מקבל ערך ישן', Org.search('מנהל פרויקט אלעד רכב', { actor: actor(U.owner) }).length === 1);

// --- מטריצה ----------------------------------------------------------------
const table = Cls.topics();
const expect = {
  //                  coordinator bedekMgr opsEmp cfo  hrMgr sysAdmin ceo owner
  'service:1':       [1, 1, 1, 1, 1, 1, 1, 1],
  'service:2':       [1, 1, 0, 0, 0, 0, 1, 1],
  'service:3':       [0, 1, 0, 0, 0, 0, 1, 1],
  'finance_biz:1':   [0, 0, 0, 1, 0, 0, 1, 1], // הרצפה 3 גוברת
  'finance_biz:3':   [0, 0, 0, 1, 0, 0, 1, 1],
  'hr_personal:1':   [0, 0, 0, 0, 1, 0, 1, 1],
  'hr_personal:4':   [0, 0, 0, 0, 0, 0, 1, 1],
  'legal:3':         [0, 0, 0, 0, 0, 0, 1, 1],
  'leadership:1':    [0, 0, 0, 0, 0, 0, 1, 1],
  'procurement:2':   [1, 1, 1, 1, 1, 1, 1, 1],
  'nope:1':          [0, 0, 0, 0, 0, 0, 1, 1]  // נושא לא מוכר
};
const order = ['coordinator', 'bedekMgr', 'opsEmp', 'cfo', 'hrMgr', 'sysAdmin', 'ceo', 'owner'];
for (const [k, row] of Object.entries(expect)) {
  const [topic, lvl] = k.split(':');
  const got = order.map((who) => (Cls.mayRead(Cls.scopeOf(actor(U[who])), topic, Number(lvl), table) ? 1 : 0));
  check(`מטריצה ${k}: ${got.join('')}`, got.join('') === row.join(''));
}
check('ספק לא רואה כלום', !Cls.mayRead(Cls.scopeOf({ type: 'vendor', id: 1 }), 'service', 1, table));
check('סמנכ"ל כספים (הנהלה במחלקת כספים) אינו הנהלה לעניין הסיווג', Cls.scopeOf(actor(U.cfo)).leader === false);
check('מנכ"ל (הנהלה במחלקת הנהלה) הוא הנהלה', Cls.scopeOf(actor(U.ceo)).leader === true);
check('מנהל מערכת אינו הנהלה', Cls.scopeOf(actor(U.sysAdmin)).leader === false);

// --- זיקוק עם פיצול: מייל המנכ"ל → בדק 2 + כספים עסקי 3 ---------------------------
D.run("INSERT INTO mail_memory (user_id, thread_id, domain, summary, created_at, happened_at) VALUES (?, 't1', 'תלונות דיירים', 'תלונות על רטיבות ודוח רווח והפסד', ?, ?)", U.ceo, now, now);
const fake = { distill: null, merge: null, classify: null };
Claude.json = async ({ schema }) => {
  const props = Object.keys(schema.properties);
  if (props.includes('lessons')) return fake.distill;
  if (props.includes('items')) return fake.classify;
  return fake.merge(schema);
};
fake.distill = { lessons: [
  { domain: 'רטיבות בדירות', dept: 'realestate', project: '', text: 'תלונות דיירים על רטיבות — מחלקת בדק פנתה לקבלן איטום', record_numbers: [1], topic: 'service', sens: 2, skip: false },
  { domain: 'רווח והפסד פרויקט', dept: 'finance', project: '', text: 'הפרויקט הפסיד 2 מיליון', record_numbers: [1], topic: 'finance_biz', sens: 1, skip: false }
] };
let mergeCalls = 0;
fake.merge = () => {
  mergeCalls++;
  return mergeCalls === 1
    ? { domain: 'רטיבות בדירות', dept: 'realestate', topic: 'service', sens: 2, text: 'תלונות דיירים על רטיבות — מחלקת בדק פנתה לקבלן איטום' }
    : { domain: 'רווח והפסד פרויקט', dept: 'finance', topic: 'service', sens: 1, text: 'הפרויקט הפסיד 2 מיליון' }; // ה-AI טועה בכוונה
};
fake.classify = { items: [{ n: 1, topic: 'hr_personal', sens: 1 }] };

(async () => {
  await Org.distillUser(U.ceo);
  await Org.classifyPending();
  await Org.mergeAll();

  const svc = D.get("SELECT * FROM org_knowledge WHERE domain = 'רטיבות בדירות'");
  const pnl = D.get("SELECT * FROM org_knowledge WHERE domain = 'רווח והפסד פרויקט'");
  check('פיצול: ערך בדק ברמה 2', svc?.topic === 'service' && svc.sens === 2);
  check('פיצול: רווח והפסד נשאר בנושא כספים עסקי ברמה 3, גם כשה-AI טעה באיחוד', pnl?.topic === 'finance_biz' && pnl.sens === 3);
  check('מתאמת בדק מקבלת את תלונות הדיירים ממייל המנכ"ל', Org.search('רטיבות בדירות', { actor: actor(U.coordinator) }).length === 1);
  check('מתאמת בדק לא מקבלת רווח והפסד', Org.search('רווח והפסד פרויקט', { actor: actor(U.coordinator) }).length === 0);
  check('סמנכ"ל כספים מקבל רווח והפסד', Org.search('רווח והפסד פרויקט', { actor: actor(U.cfo) }).length === 1);

  // רגרסיה 4.11
  const car = D.get('SELECT * FROM org_knowledge WHERE id = 1');
  check('סיווג מחדש: הרכב של מנהל הפרויקט → משאבי אנוש אישי, רמה 3 (רצפה)', car.topic === 'hr_personal' && car.sens === 3 && car.classified === 1);
  check('4.11: עובד תפעול ששואל על מנהל הפרויקט באלעד לא מקבל את הרכב', Org.search('מנהל פרויקט אלעד רכב', { actor: actor(U.opsEmp) }).length === 0);
  check('4.11: מנהלת משאבי אנוש כן מקבלת', Org.search('מנהל פרויקט אלעד רכב', { actor: actor(U.hrMgr) }).length === 1);

  // מסך הניהול: מנהל מערכת רואה שהערך קיים, לא את התוכן
  const adminList = Org.list({ actor: actor(U.sysAdmin) }).entries.find((e) => e.id === 1);
  check('מסך ניהול: מנהל מערכת מקבל ערך מסווג מוסתר', adminList?.masked === true && !adminList.text.includes('רכב'));
  check('מסך ניהול: מנהל מערכת לא מקבל מקורות של ערך מסווג', Org.sources(1, actor(U.sysAdmin)).length === 0);
  let blocked = false;
  try { Org.edit(1, { sens: 1 }, actor(U.sysAdmin)); } catch (err) { blocked = err.status === 403; }
  check('מסך ניהול: מנהל מערכת לא יכול לפתוח ערך מסווג', blocked);
  Org.edit(1, { sens: 4 }, actor(U.sysAdmin));
  check('מסך ניהול: מנהל מערכת יכול להחמיר לסודי', D.get('SELECT sens FROM org_knowledge WHERE id = 1').sens === 4);
  Org.edit(1, { topic: 'hr_personal', sens: 1 }, actor(U.owner));
  check('עריכה ידנית לא יורדת מתחת לרצפה', D.get('SELECT sens FROM org_knowledge WHERE id = 1').sens === 3);

  const pv = Cls.preview({ departmentId: coord, role: 'employee' });
  check('"איך זה נראה": מתאמת רואה בדק עד רמה 2', pv.find((x) => x.key === 'service').upTo === 2);
  check('"איך זה נראה": מתאמת לא רואה משאבי אנוש אישי', pv.find((x) => x.key === 'hr_personal').upTo === 0);

  await taskChecks();

  console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nכל הבדיקות עברו');
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

// ---------------------------------------------------------------------------
// משימות ופרויקטים — דרך השרת האמיתי, ב-HTTP
// ---------------------------------------------------------------------------

async function taskChecks() {
  const { spawn } = require('node:child_process');
  const PORT = 3900 + Math.floor(Math.random() * 90);
  const board = D.internalBoard().id;
  const status = D.get('SELECT key FROM board_columns WHERE board_id = ? AND is_final = 0 ORDER BY position LIMIT 1', board).key;
  const task = (title, { dept: d, assignee, by, topic = '', sens = 0, project = null }) => Number(D.run(
    `INSERT INTO tasks (title, description, board_id, assignee_type, assignee_id, status, priority, created_at, created_by, status_changed_at, department_id, topic, sens, project_id)
     VALUES (?, '', ?, 'user', ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?)`,
    title, board, assignee, status, now, by, now, d, topic, sens, project).lastInsertRowid);

  const plain = task('הזמנת ציוד משרדי', { dept: ops, assignee: U.opsEmp, by: U.opsMgr });
  const hearing = task('בירור משמעתי לעובד תפעול', { dept: ops, assignee: U.hrMgr, by: U.hrMgr, topic: 'hr_personal', sens: 3 });
  const proj = Number(D.run("INSERT INTO projects (name, description, status, created_at, created_by, topic, sens) VALUES ('בדיקת רווחיות', '', 'active', ?, ?, 'finance_biz', 3)", now, U.cfo).lastInsertRowid);
  const inherited = task('לאסוף חשבוניות לבדיקת הרווחיות', { dept: bedek, assignee: U.coordinator, by: U.cfo, project: proj });

  D.audit(hearing, { type: 'user', id: U.hrMgr }, 'comment', 'בירור משמעתי — נקבע שימוע');
  D.audit(plain, { type: 'user', id: U.opsMgr }, 'comment', 'הוזמן ציוד');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://localhost:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    const login = async (id) => {
      const email = D.get('SELECT email FROM users WHERE id = ?', id).email;
      const r = await fetch(`http://localhost:${PORT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: '1234' }) });
      const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).map((c) => String(c).split(';')[0]).join('; ');
      return (p, opts = {}) => fetch(`http://localhost:${PORT}${p}`, { ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers ?? {}) } });
    };
    const sees = async (who) => {
      const api = await login(U[who]);
      const r = await (await api('/api/tasks')).json();
      return new Set((r.tasks ?? []).map((t) => t.id));
    };

    const row = {};
    for (const who of ['hrMgr', 'opsMgr', 'sysAdmin', 'cfo', 'ceo', 'owner', 'coordinator', 'bedekMgr']) row[who] = await sees(who);
    check('משימה רגילה: מנהל תפעול רואה כרגיל', row.opsMgr.has(plain));
    check('משימה רגישה (משאבי אנוש אישי): מנהלת משאבי אנוש — משתתפת — רואה', row.hrMgr.has(hearing));
    check('משימה רגישה: מנהל תפעול לא רואה, גם שהיא במחלקה שלו', !row.opsMgr.has(hearing));
    check('משימה רגישה: מנהל מערכת לא רואה', !row.sysAdmin.has(hearing));
    check('משימה רגישה: סמנכ"ל כספים (הנהלה במחלקת כספים) לא רואה', !row.cfo.has(hearing));
    check('משימה רגישה: מנכ"ל ואדמין על רואים', row.ceo.has(hearing) && row.owner.has(hearing));
    check('ירושה מפרויקט כספים: המתאמת — אחראית — רואה', row.coordinator.has(inherited));
    check('ירושה מפרויקט כספים: מנהל בדק לא רואה, גם שהיא במחלקה שלו', !row.bedekMgr.has(inherited));
    check('ירושה מפרויקט כספים: סמנכ"ל כספים רואה', row.cfo.has(inherited));

    const admin = await login(U.sysAdmin);
    check('פתיחה ישירה (‎/api/tasks/:id‎) של משימה רגישה ע"י מנהל מערכת — 403', (await admin(`/api/tasks/${hearing}`)).status === 403);

    const coord = await login(U.coordinator);
    const lower = await coord(`/api/tasks/${inherited}`, { method: 'PATCH', body: JSON.stringify({ topic: 'service', sens: 1 }) });
    check('משתתפת לא יכולה להקל סיווג שעובר בירושה (403)', lower.status === 403);
    const raise = await coord(`/api/tasks/${inherited}`, { method: 'PATCH', body: JSON.stringify({ topic: 'finance_biz', sens: 4 }) });
    check('משתתפת יכולה להחמיר', raise.ok && D.get('SELECT sens FROM tasks WHERE id = ?', inherited).sens === 4);

    const projectsOf = async (who) => new Set(((await (await (await login(U[who]))('/api/projects')).json()).projects ?? []).map((p) => p.id));
    check('פרויקט מסווג: מי שיש לו בו משימה רואה אותו', (await projectsOf('coordinator')).has(proj));
    check('פרויקט מסווג: מנהל מערכת לא רואה אותו', !(await projectsOf('sysAdmin')).has(proj));

    const opsApi = await login(U.opsMgr);
    const home = await (await opsApi('/api/home')).json();
    check('דף הבית של מנהל תפעול — "משימות המחלקה" בלי המשימה הרגישה', !(home.tasks?.department ?? []).some((t) => t.id === hearing)
      && JSON.stringify(home).indexOf('בירור משמעתי') === -1);
    const adminHome = JSON.stringify(await (await admin('/api/home')).json());
    check('פיד העדכונים של מנהל מערכת — בלי המשימה הרגישה, עם הרגילה', !adminHome.includes('בירור משמעתי') && !adminHome.includes('שימוע') && adminHome.includes('הזמנת ציוד'));
    const searchAll = async (api) => JSON.stringify(await (await api(`/api/search?q=${encodeURIComponent('בירור משמעתי')}&scope=all`)).json());
    check('חיפוש של מנהל מערכת לא מוצא את המשימה הרגישה', !(await searchAll(admin)).includes('בירור משמעתי לעובד'));
    check('חיפוש של מנכ"ל מוצא אותה', (await searchAll(await login(U.ceo))).includes('בירור משמעתי לעובד'));

    const cls = (await (await (await login(U.hrMgr))(`/api/tasks/${hearing}`)).json()).task?.classification;
    check('הכרטיס מחזיר את הסיווג', cls?.topic === 'hr_personal' && cls.sens === 3);
  } finally {
    server.kill();
  }

  // התראה למי שלא רשאי — בלי כותרת
  D.notify({ targetType: 'user', targetId: U.opsMgr, kind: 'comment', title: 'בירור משמעתי לעובד תפעול', body: 'פרטים', taskId: hearing });
  D.notify({ targetType: 'user', targetId: U.ceo, kind: 'comment', title: 'בירור משמעתי לעובד תפעול', body: 'פרטים', taskId: hearing });
  const n = (id) => D.get('SELECT title, body FROM notifications WHERE target_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1', id, hearing);
  check('התראה למי שלא רשאי — בלי כותרת ובלי תוכן', n(U.opsMgr).title === '🔒 עדכון במשימה מסווגת' && n(U.opsMgr).body === '');
  check('התראה למורשה — כרגיל', n(U.ceo).title === 'בירור משמעתי לעובד תפעול');
}
