'use strict';
/**
 * הרשאות מקצה לקצה: מנהל המערכת הראשון יוצר מחלקה ושני עובדים פנימיים דרך ה-API,
 * ובודקים שעובד אינו מגיע לפעולות ניהול ולמשימות של אחרים — ושהמנהל כן.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
let admin;           // עוגיית המנהל
let dept;            // המחלקה שנוצרה
const alice = { name: 'אליס עובדת', email: 'alice@test.local', password: 'Alice-Pass-1' };
const bob = { name: 'בוב עובד', email: 'bob@test.local', password: 'Bob-Pass-1' };

before(async () => {
  srv = await Server.start();
  admin = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
});
after(async () => { await srv?.stop(); });

const as = (cookie) => (method, path, body) => srv.api(method, path, { cookie, body });

test('מנהל יוצר מחלקה', async () => {
  const r = await as(admin)('POST', '/api/departments', { name: 'מחלקת בדיקות' });
  assert.equal(r.status, 201, r.text);
  dept = r.json.department;
  assert.ok(dept.id);
  const dup = await as(admin)('POST', '/api/departments', { name: 'מחלקת בדיקות' });
  assert.equal(dup.status, 400, 'שם כפול נדחה');
  assert.equal((await as(admin)('POST', '/api/departments', { name: '  ' })).status, 400);
});

test('מנהל יוצר עובדים פנימיים (בלי שליחת הזמנה)', async () => {
  for (const u of [alice, bob]) {
    const r = await as(admin)('POST', '/api/admin/users', {
      name: u.name, email: u.email, password: u.password, role: 'employee', departmentId: dept.id, invite: false
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.invite, null);
    u.id = r.json.userId;
  }
  const list = await as(admin)('GET', '/api/admin/users');
  assert.equal(list.status, 200);
  const emails = list.json.users.map((u) => u.email);
  assert.ok(emails.includes(alice.email) && emails.includes(bob.email));
  assert.equal(list.json.users.find((u) => u.email === alice.email).departmentId, dept.id);
});

test('יצירת משתמש: אימייל כפול, רמת גישה לא תקינה ושדות חסרים — 400', async () => {
  const dup = await as(admin)('POST', '/api/admin/users', { name: 'שוב', email: alice.email.toUpperCase(), role: 'employee', invite: false });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'כתובת האימייל כבר קיימת במערכת');
  assert.equal((await as(admin)('POST', '/api/admin/users', { name: 'x', email: 'x@test.local', role: 'god', invite: false })).status, 400);
  assert.equal((await as(admin)('POST', '/api/admin/users', { name: 'x', email: 'x2@test.local', role: 'vendor', invite: false })).status, 400);
  assert.equal((await as(admin)('POST', '/api/admin/users', { email: 'x3@test.local', role: 'employee', invite: false })).status, 400);
  assert.equal((await as(admin)('POST', '/api/admin/users', { name: 'x', role: 'employee', invite: false })).status, 400);
});

test('עובד מתחבר עם הסיסמה שנקבעה, בלי תווית רמת גישה', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: { email: alice.email, password: alice.password } });
  assert.equal(r.status, 200);
  assert.equal(r.json.actor.role, 'employee');
  assert.equal(r.json.actor.departmentId, dept.id);
  assert.equal(r.json.actor.seesRoles, false);
  assert.equal(r.json.actor.roleLabel, null);
  alice.cookie = r.cookie;
  bob.cookie = await srv.login(bob.email, bob.password);
});

test('עובד אינו נכנס למסכי הניהול — 403', async () => {
  const a = as(alice.cookie);
  const cases = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { name: 'פורץ', email: 'intruder@test.local', role: 'admin', invite: false }],
    ['PATCH', `/api/admin/users/${bob.id}`, { role: 'admin' }],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', { settings: { org_name: 'נפרץ' } }],
    ['POST', '/api/admin/rules', { triggerKey: 'x', actionKey: 'y' }],
    ['POST', '/api/departments', { name: 'מחלקה פיראטית' }],
    ['POST', '/api/admin/wipe', { confirm: 'לא' }],
    ['GET', '/api/admin/releases'],
    ['GET', '/api/admin/signup-link'],
    ['GET', '/api/reports'],
    ['GET', '/api/tasks?scope=vendors']
  ];
  for (const [method, path, body] of cases) {
    const r = await a(method, path, body);
    assert.equal(r.status, 403, `${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
  }
});

test('הניסיונות של העובד לא שינו דבר', async () => {
  const users = (await as(admin)('GET', '/api/admin/users')).json.users;
  assert.ok(!users.some((u) => u.email === 'intruder@test.local'));
  assert.equal(users.find((u) => u.id === bob.id).role, 'employee');
  const settings = (await as(admin)('GET', '/api/admin/settings')).json.settings;
  assert.notEqual(settings.org_name, 'נפרץ');
  const depts = (await as(admin)('GET', '/api/departments')).json.departments;
  assert.ok(!depts.some((d) => d.name === 'מחלקה פיראטית'));
});

test('מנהל המערכת כן מגיע לאותם מסכים — 200', async () => {
  const a = as(admin);
  for (const path of ['/api/admin/users', '/api/admin/settings', '/api/admin/releases', '/api/reports', '/api/tasks?scope=vendors', '/api/departments?includeInactive=1']) {
    const r = await a('GET', path);
    assert.equal(r.status, 200, `${path} → ${r.status} ${r.text.slice(0, 120)}`);
  }
});

test('מנהל משנה הגדרה, ועובד רואה את שם הארגון החדש', async () => {
  const r = await as(admin)('PUT', '/api/admin/settings', { settings: { org_name: 'ארגון הבדיקות', not_a_setting: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.org_name, 'ארגון הבדיקות');
  assert.ok(!('not_a_setting' in r.json.settings), 'מפתח לא מוכר אינו נשמר');
  const boot = await as(alice.cookie)('GET', '/api/bootstrap');
  assert.equal(boot.json.settings.orgName, 'ארגון הבדיקות');
});

test('כתובת מערכת לא תקינה בהגדרות — 400', async () => {
  const r = await as(admin)('PUT', '/api/admin/settings', { settings: { public_url: 'ftp//nope' } });
  assert.equal(r.status, 400);
});

test('עובד אינו רואה, עורך או מוחק משימה של המנהל — 403', async () => {
  const t = (await as(admin)('POST', '/api/tasks', { title: 'סודי של המנהל' })).json.task;
  const a = as(alice.cookie);
  assert.equal((await a('GET', `/api/tasks/${t.id}`)).status, 403);
  assert.equal((await a('PATCH', `/api/tasks/${t.id}`, { status: 'done' })).status, 403);
  assert.equal((await a('PATCH', `/api/tasks/${t.id}`, { title: 'נפרץ' })).status, 403);
  assert.equal((await a('DELETE', `/api/tasks/${t.id}`)).status, 403);
  const list = (await a('GET', '/api/tasks')).json.tasks.map((x) => x.id);
  assert.ok(!list.includes(t.id), 'המשימה לא ברשימה של העובד');

  const still = await as(admin)('GET', `/api/tasks/${t.id}`);
  assert.equal(still.json.task.title, 'סודי של המנהל');
  assert.equal(still.json.task.status, 'new');
});

test('עובד יוצר משימה לעצמו, מעדכן ומוחק אותה; המנהל רואה אותה', async () => {
  const a = as(alice.cookie);
  const c = await a('POST', '/api/tasks', { title: 'המשימה של אליס', assigneeType: 'user', assigneeId: alice.id });
  assert.equal(c.status, 201, c.text);
  const t = c.json.task;
  assert.equal(t.assigneeId, alice.id);

  assert.equal((await a('PATCH', `/api/tasks/${t.id}`, { status: 'in_progress' })).json.task.status, 'in_progress');
  assert.ok((await a('GET', '/api/tasks')).json.tasks.some((x) => x.id === t.id));
  assert.equal((await as(admin)('GET', `/api/tasks/${t.id}`)).status, 200);

  // עובד אחר באותה מחלקה, בלי הרשאה אישית — לא רואה
  assert.equal((await as(bob.cookie)('GET', `/api/tasks/${t.id}`)).status, 403);

  assert.equal((await a('DELETE', `/api/tasks/${t.id}`)).status, 200);
});

test('עובד אינו מקצה משימה לעובד אחר — 403', async () => {
  const r = await as(alice.cookie)('POST', '/api/tasks', { title: 'לבוב', assigneeType: 'user', assigneeId: bob.id });
  assert.equal(r.status, 403);
  const mine = (await as(alice.cookie)('POST', '/api/tasks', { title: 'שלי ואז לבוב' })).json.task;
  const move = await as(alice.cookie)('PATCH', `/api/tasks/${mine.id}`, { assigneeType: 'user', assigneeId: bob.id });
  assert.equal(move.status, 403, 'גם לא בעריכה');
});

test('עובד אינו מקצה משימה לספק — 403', async () => {
  const r = await as(alice.cookie)('POST', '/api/tasks', { title: 'לספק', assigneeType: 'vendor', assigneeId: 1 });
  assert.equal(r.status, 403);
});

test('הרשאה אישית "צפייה בכל משימות המחלקה" פותחת לבוב את משימות אליס', async () => {
  const t = (await as(alice.cookie)('POST', '/api/tasks', { title: 'מחלקתית של אליס' })).json.task;
  assert.equal((await as(bob.cookie)('GET', `/api/tasks/${t.id}`)).status, 403);

  // עובד אינו מעניק הרשאות לעצמו
  assert.equal((await as(bob.cookie)('PUT', `/api/admin/users/${bob.id}/grants`, { grants: ['view_department_tasks'] })).status, 403);

  const g = await as(admin)('PUT', `/api/admin/users/${bob.id}/grants`, { grants: ['view_department_tasks', 'not_a_grant'] });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.grants, ['view_department_tasks']);

  // ההרשאות נטענות עם הסשן — אותה עוגייה רואה מיד
  assert.equal((await as(bob.cookie)('GET', `/api/tasks/${t.id}`)).status, 200);
  assert.ok((await as(bob.cookie)('GET', '/api/tasks')).json.tasks.some((x) => x.id === t.id));
  // צפייה אינה עריכה
  assert.equal((await as(bob.cookie)('PATCH', `/api/tasks/${t.id}`, { title: 'של בוב' })).status, 403);

  await as(admin)('PUT', `/api/admin/users/${bob.id}/grants`, { grants: [] });
  assert.equal((await as(bob.cookie)('GET', `/api/tasks/${t.id}`)).status, 403);
});

test('מנהל בלי מחלקה אינו מקצה לעובד שאינו "מתחתיו" — 403 (היררכיה, ‎assertMayAssignTo‎)', async () => {
  const r = await as(admin)('POST', '/api/tasks', { title: 'לבוב בלי היררכיה', assigneeType: 'user', assigneeId: bob.id });
  assert.equal(r.status, 403);
});

test('משימה שהמנהל מקצה לעובד במחלקה שלו: העובד רואה אותה ומקבל התראה', async () => {
  // המנהל הראשון נוצר בלי מחלקה — משייכים אותו למחלקת הבדיקות, שמעליה הוא מקצה
  const me = (await as(admin)('GET', '/api/bootstrap')).json.actor;
  assert.equal((await as(admin)('PATCH', `/api/admin/users/${me.id}`, { departmentId: dept.id })).status, 200);
  const c = await as(admin)('POST', '/api/tasks', { title: 'משימה לבוב מהמנהל', assigneeType: 'user', assigneeId: bob.id });
  assert.equal(c.status, 201, c.text);
  const t = c.json.task;
  const b = as(bob.cookie);
  assert.equal((await b('GET', `/api/tasks/${t.id}`)).status, 200);
  assert.ok((await b('GET', '/api/tasks')).json.tasks.some((x) => x.id === t.id));
  // האחראי משנה סטטוס
  assert.equal((await b('PATCH', `/api/tasks/${t.id}`, { status: 'done' })).status, 200);

  const n = await b('GET', '/api/notifications');
  assert.equal(n.status, 200);
  const note = n.json.notifications.find((x) => x.taskId === t.id);
  assert.ok(note, 'נוצרה התראה');
  assert.equal(note.kind, 'assignment');
  assert.equal(note.isRead, false);

  await b('POST', '/api/notifications/read', {});
  const after = await b('GET', '/api/notifications');
  assert.equal(after.json.unread, 0);
});

test('השבתת עובד: הסשן שלו מפסיק לעבוד והכניסה נחסמת', async () => {
  const carol = { email: 'carol@test.local', password: 'Carol-Pass-1' };
  const c = await as(admin)('POST', '/api/admin/users', { name: 'קרול', ...carol, role: 'employee', departmentId: dept.id, invite: false });
  const cookie = await srv.login(carol.email, carol.password);
  assert.equal((await as(cookie)('GET', '/api/bootstrap')).status, 200);

  const off = await as(admin)('PATCH', `/api/admin/users/${c.json.userId}`, { status: 'inactive' });
  assert.equal(off.status, 200, off.text);
  assert.equal((await as(cookie)('GET', '/api/bootstrap')).status, 401);
  const relog = await srv.api('POST', '/api/auth/login', { body: carol });
  assert.equal(relog.status, 401);
  assert.match(relog.json.error, /אינו פעיל/);
});

test('מנהל אינו משבית את עצמו — 400', async () => {
  const me = (await as(admin)('GET', '/api/bootstrap')).json.actor;
  const r = await as(admin)('PATCH', `/api/admin/users/${me.id}`, { status: 'inactive' });
  assert.equal(r.status, 400);
  assert.equal((await as(admin)('GET', '/api/bootstrap')).status, 200);
});

test('עריכת משתמש שאינו קיים — 404', async () => {
  assert.equal((await as(admin)('PATCH', '/api/admin/users/99999', { name: 'x' })).status, 404);
});

test('אתחול המערכת דורש מילת אישור מפורשת גם למנהל — 400', async () => {
  const r = await as(admin)('POST', '/api/admin/wipe', { confirm: 'כן' });
  assert.equal(r.status, 400);
  assert.ok((await as(admin)('GET', '/api/admin/users')).json.users.length >= 3, 'שום דבר לא נמחק');
});

test('השרת לא נפל, לא החזיר 500 ולא ניסה לפנות לרשת במהלך הבדיקות', () => {
  assert.equal(srv.exited(), null);
  assert.doesNotMatch(srv.output(), /שרת הבדיקה ניסה לפנות לרשת/);
  assert.doesNotMatch(srv.output(), /שגיאת שרת/);
});
