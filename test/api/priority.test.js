'use strict';
/**
 * 🗂 משימון פריוריטי מקצה לקצה: המסך הנפרד (‎/priority‎), ‎/api/priority/*‎ — מי נכנס, הגדרות בלי סיסמה בתשובה,
 * ומטריצת ההרשאות. השרת האמיתי, בלי פנייה לפריוריטי (הרשת חסומה).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
let admin;
let emp;
let empId;
const worker = { name: 'עובד שטח', email: 'field@test.local', password: 'Field-Pass-1' };

before(async () => {
  srv = await Server.start();
  admin = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
  const r = await srv.api('POST', '/api/admin/users', { cookie: admin, body: { ...worker, role: 'employee', invite: false } });
  assert.equal(r.status, 201, r.text);
  empId = r.json.userId;
  emp = await srv.login(worker.email, worker.password);
});
after(async () => { await srv?.stop(); });

const as = (cookie) => (method, path, body) => srv.api(method, path, { cookie, body });

test('המסך הנפרד מוגש ב-/priority ובכל נתיב תחתיו', async () => {
  for (const p of ['/priority', '/priority/', '/priority/settings']) {
    const r = await srv.api('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /משימון פריוריטי/);
    assert.match(r.text, /\/priority\/priority\.js/);
  }
  assert.equal((await srv.api('GET', '/priority/priority.js')).status, 200);
});

test('בלי התחברות — 401', async () => {
  assert.equal((await srv.api('GET', '/api/priority/me')).status, 401);
});

test('עובד: רואה את עצמו, לא נכנס להגדרות ולהרשאות', async () => {
  const me = await as(emp)('GET', '/api/priority/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.admin, false);
  assert.equal(me.json.docs.length, 6);
  for (const [m, p] of [['GET', '/api/priority/settings'], ['PUT', '/api/priority/settings'], ['GET', '/api/priority/access'], ['PUT', '/api/priority/access'], ['GET', '/api/priority/log'], ['POST', '/api/priority/settings/test']]) {
    assert.equal((await as(emp)(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  }
});

test('מנהל: שומר חיבור — הסיסמה לא חוזרת לעולם', async () => {
  const r = await as(admin)('PUT', '/api/priority/settings', { connection: { user: 'PAT-123', password: 'Very-Secret-9' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.connection.hasPassword, true);
  assert.equal(r.text.includes('Very-Secret-9'), false);
  const g = await as(admin)('GET', '/api/priority/settings');
  assert.equal(g.text.includes('Very-Secret-9'), false);
  assert.equal(g.json.connection.user, 'PAT-123');
  assert.equal(g.json.testLock, true);
  const log = await as(admin)('GET', '/api/priority/log');
  assert.ok(log.json.items[0].changes.some((c) => c.includes('סיסמה')));
  assert.equal(log.text.includes('Very-Secret-9'), false);
});

test('מנהל: חברה לא תקינה — 400', async () => {
  const r = await as(admin)('PUT', '/api/priority/settings', { companies: [{ code: 'bad code' }] });
  assert.equal(r.status, 400);
});

test('בדיקת חיבור בסביבת בדיקות — נכשלת בשקט (אין רשת), לא קורסת', async () => {
  const r = await as(admin)('POST', '/api/priority/settings/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
});

test('מנהל: מטריצת ההרשאות — מסמך וחברות לעובד', async () => {
  const m = await as(admin)('GET', '/api/priority/access');
  assert.equal(m.status, 200);
  assert.ok(m.json.users.some((u) => u.id === empId));
  const s = await as(admin)('PUT', '/api/priority/access', { rows: [{ id: empId, docs: ['receipt'], companies: ['elad1'] }] });
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.changes.length);
  const me = await as(emp)('GET', '/api/priority/me');
  assert.deepEqual(me.json.docs.filter((d) => d.allowed).map((d) => d.key), ['receipt']);
  assert.deepEqual(me.json.companies.map((c) => c.code), ['elad1']);
  assert.equal(me.json.allCompanies, false);
  assert.equal((await as(admin)('PUT', '/api/priority/access', { rows: [{ id: 999999, docs: [] }] })).status, 400);
});
