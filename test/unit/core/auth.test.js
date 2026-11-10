'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const A = require('../../../server/core/auth');

boot();

const PASS = 'Sod-Gadol-123';
const member = (extra = {}) => user({ full_name: 'דנה כהן', role: 'employee', password_hash: D.hashPassword(PASS), ...extra });
function vendor(extra = {}) {
  const email = `v${Date.now()}${Math.random().toString(36).slice(2, 6)}@vendor.test`;
  const info = D.run('INSERT INTO vendors (name, email, password_hash, status, created_at) VALUES (?,?,?,?,?)',
    'ספק בע״מ', email, D.hashPassword(PASS), 'active', new Date().toISOString());
  const id = Number(info.lastInsertRowid);
  if (extra.status) D.run('UPDATE vendors SET status = ? WHERE id = ?', extra.status, id);
  return D.get('SELECT * FROM vendors WHERE id = ?', id);
}
const reqWith = (cookie, extra = {}) => ({ headers: { cookie, ...extra.headers }, socket: extra.socket ?? {} });
const ipReq = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: {} });

test('hashPassword — מלח אקראי, פורמט salt:hash', () => {
  const a = D.hashPassword('x');
  const b = D.hashPassword('x');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(D.hashPassword('x', 'abc'), D.hashPassword('x', 'abc'));
});

test('verifyPassword — נכונה, שגויה, ערך פגום', () => {
  const h = D.hashPassword('סיסמה');
  assert.ok(D.verifyPassword('סיסמה', h));
  assert.ok(!D.verifyPassword('סיסמא', h));
  assert.ok(!D.verifyPassword('סיסמה', ''));
  assert.ok(!D.verifyPassword('סיסמה', null));
  assert.ok(!D.verifyPassword('סיסמה', 'nocolon'));
  assert.ok(!D.verifyPassword('סיסמה', `${h}00`));
});

test('createSession — אסימון ותפוגה של 14 יום', () => {
  const u = member();
  const before = Date.now();
  const { token, expires } = A.createSession('user', u.id);
  assert.match(token, /^[0-9a-f]{64}$/);
  const days = (expires.getTime() - before) / 86400000;
  assert.ok(days > 13.99 && days < 14.01);
  const row = D.get('SELECT * FROM sessions WHERE token = ?', token);
  assert.equal(row.actor_type, 'user');
  assert.equal(row.actor_id, u.id);
});

test('actorFromRequest — סשן תקף מחזיר משתמש', () => {
  const u = member();
  const { token } = A.createSession('user', u.id);
  const actor = A.actorFromRequest(reqWith(`other=1; ${A.COOKIE}=${token}`));
  assert.equal(actor.type, 'user');
  assert.equal(actor.id, u.id);
  assert.equal(actor.name, 'דנה כהן');
  assert.equal(actor.role, 'employee');
  assert.equal(actor.token, token);
  assert.deepEqual(actor.grants, []);
  assert.deepEqual(actor.departmentIds, []);
});

test('actorFromRequest — בלי עוגייה או אסימון לא מוכר', () => {
  assert.equal(A.actorFromRequest(reqWith(undefined)), null);
  assert.equal(A.actorFromRequest(reqWith(`${A.COOKIE}=deadbeef`)), null);
});

test('actorFromRequest — סשן שפג נמחק', () => {
  const u = member();
  const { token } = A.createSession('user', u.id);
  D.run('UPDATE sessions SET expires_at = ? WHERE token = ?', '2000-01-01T00:00:00.000Z', token);
  assert.equal(A.actorFromRequest(reqWith(`${A.COOKIE}=${token}`)), null);
  assert.equal(D.get('SELECT 1 FROM sessions WHERE token = ?', token), undefined);
});

test('actorFromRequest — משתמש לא פעיל: null', () => {
  const u = member({ status: 'inactive' });
  const { token } = A.createSession('user', u.id);
  assert.equal(A.actorFromRequest(reqWith(`${A.COOKIE}=${token}`)), null);
});

test('requireActor — בלי סשן זורק 401', () => {
  assert.throws(() => A.requireActor(reqWith(undefined)), (e) => e.status === 401);
  const u = member();
  const { token } = A.createSession('user', u.id);
  assert.equal(A.requireActor(reqWith(`${A.COOKIE}=${token}`)).id, u.id);
});

test('destroySession — מוחק, ואסימון ריק לא עושה כלום', () => {
  const u = member();
  const { token } = A.createSession('user', u.id);
  A.destroySession(token);
  assert.equal(A.actorFromRequest(reqWith(`${A.COOKIE}=${token}`)), null);
  assert.doesNotThrow(() => A.destroySession(null));
});

test('purgeExpired — מוחק רק סשנים שפגו', () => {
  const u = member();
  const live = A.createSession('user', u.id).token;
  const dead = A.createSession('user', u.id).token;
  D.run('UPDATE sessions SET expires_at = ? WHERE token = ?', '2000-01-01T00:00:00.000Z', dead);
  A.purgeExpired();
  assert.ok(D.get('SELECT 1 FROM sessions WHERE token = ?', live));
  assert.equal(D.get('SELECT 1 FROM sessions WHERE token = ?', dead), undefined);
});

test('loadActor — הרשאות אישיות ותת-מחלקות', () => {
  const now = new Date().toISOString();
  const parent = Number(D.run('INSERT INTO departments (name, created_at) VALUES (?,?)', 'הנדסה-אב', now).lastInsertRowid);
  const child = Number(D.run('INSERT INTO departments (name, created_at, parent_id) VALUES (?,?,?)', 'אתר-בן', now, parent).lastInsertRowid);
  const u = member({ department_id: parent });
  D.run('INSERT INTO user_grants (user_id, grant_key, created_at) VALUES (?,?,?)', u.id, 'view_department_tasks', now);
  const actor = A.loadActor('user', u.id);
  assert.equal(actor.departmentId, parent);
  assert.deepEqual([...actor.departmentIds].sort(), [parent, child].sort());
  assert.deepEqual(actor.grants, ['view_department_tasks']);
  assert.equal(actor.token, null);
});

test('loadActor — ספק עם בורד ובלי', () => {
  const v = vendor();
  const a = A.loadActor('vendor', v.id, 'tok');
  assert.equal(a.type, 'vendor');
  assert.equal(a.role, 'vendor');
  assert.equal(a.boardId, null);
  assert.equal(a.readOnly, false);
  assert.equal(a.token, 'tok');
  const board = Number(D.run("INSERT INTO boards (name, type, vendor_id, created_at) VALUES ('ב','vendor',?,?)", v.id, new Date().toISOString()).lastInsertRowid);
  assert.equal(A.loadActor('vendor', v.id).boardId, board);
});

test('loadActor — ספק מושהה או לא קיים: null', () => {
  assert.equal(A.loadActor('vendor', vendor({ status: 'suspended' }).id), null);
  assert.equal(A.loadActor('vendor', 999999), null);
  assert.equal(A.loadActor('user', 999999), null);
});

test('login — משתמש, אימייל לא תלוי רישיות ורווחים', () => {
  const u = member();
  const r = A.login(`  ${u.email.toUpperCase()} `, PASS);
  assert.equal(r.actorType, 'user');
  assert.equal(r.actor.id, u.id);
});

test('login — סיסמה שגויה ואימייל לא קיים: אותה הודעה', () => {
  const u = member();
  const msg = 'אימייל או סיסמה שגויים';
  assert.throws(() => A.login(u.email, 'wrong'), (e) => e.status === 401 && e.message === msg);
  assert.throws(() => A.login('nobody@nowhere.test', PASS), (e) => e.status === 401 && e.message === msg);
});

test('login — שדות חסרים: 400', () => {
  assert.throws(() => A.login('', PASS), (e) => e.status === 400);
  assert.throws(() => A.login('a@b.c', ''), (e) => e.status === 400);
  assert.throws(() => A.login(null, null), (e) => e.status === 400);
});

test('login — לא פעיל מול ממתין לאישור', () => {
  const off = member({ status: 'inactive' });
  assert.throws(() => A.login(off.email, PASS), /אינו פעיל/);
  const pending = member({ status: 'inactive', signup_at: new Date().toISOString() });
  assert.throws(() => A.login(pending.email, PASS), /ממתינה לאישור/);
});

test('login — ספק פעיל ומושהה', () => {
  const v = vendor();
  const r = A.login(v.email, PASS);
  assert.equal(r.actorType, 'vendor');
  assert.equal(r.actor.id, v.id);
  assert.throws(() => A.login(v.email, 'bad'), (e) => e.status === 401);
  const s = vendor({ status: 'suspended' });
  assert.throws(() => A.login(s.email, PASS), /מושהה/);
});

test('isSecureRequest — הצפנה ישירה או x-forwarded-proto', () => {
  assert.ok(A.isSecureRequest({ headers: {}, socket: { encrypted: true } }));
  assert.ok(A.isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }));
  assert.ok(!A.isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }));
  assert.ok(!A.isSecureRequest({ headers: {} }));
});

test('cookieHeader — Secure רק ב-HTTPS', () => {
  const exp = new Date('2026-11-24T00:00:00Z');
  const plain = A.cookieHeader('abc', exp, { headers: {} });
  assert.equal(plain, 'mesimon_sid=abc; Path=/; HttpOnly; SameSite=Lax; Expires=Tue, 24 Nov 2026 00:00:00 GMT');
  assert.match(A.cookieHeader('abc', exp, { headers: { 'x-forwarded-proto': 'https' } }), /SameSite=Lax; Secure; Expires=/);
  assert.doesNotMatch(A.cookieHeader('abc', exp), /Secure/);
});

test('clearCookieHeader — מוחק את העוגייה', () => {
  assert.equal(A.clearCookieHeader(), 'mesimon_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

test('הגבלת ניסיונות — 10 לכתובת', () => {
  const req = ipReq('10.0.0.1');
  for (let i = 0; i < 9; i++) A.noteFailedLogin(req);
  assert.doesNotThrow(() => A.checkLoginRate(req));
  A.noteFailedLogin(req);
  assert.throws(() => A.checkLoginRate(req), (e) => e.status === 401 && /יותר מדי ניסיונות/.test(e.message) && /15 דקות/.test(e.message));
  // כתובת אחרת לא מושפעת
  assert.doesNotThrow(() => A.checkLoginRate(ipReq('10.0.0.2')));
  A.clearLoginRate(req);
  assert.doesNotThrow(() => A.checkLoginRate(req));
});

test('הגבלת ניסיונות — 20 לחשבון גם כשהכתובת מתחלפת', () => {
  const account = 'Target@Example.com';
  for (let i = 0; i < 20; i++) A.noteFailedLogin(ipReq(`10.1.0.${i}`), account);
  assert.throws(() => A.checkLoginRate(ipReq('10.1.1.1'), ' target@example.com '), (e) => e.status === 401);
  assert.doesNotThrow(() => A.checkLoginRate(ipReq('10.1.1.1'), 'other@example.com'));
  A.clearLoginRate(ipReq('10.1.1.1'), account);
  assert.doesNotThrow(() => A.checkLoginRate(ipReq('10.1.1.1'), account));
});

test('הגבלת ניסיונות — כתובת מהשקע כשאין x-forwarded-for', () => {
  const req = { headers: {}, socket: { remoteAddress: '192.168.9.9' } };
  for (let i = 0; i < 10; i++) A.noteFailedLogin(req);
  assert.throws(() => A.checkLoginRate(req));
  assert.throws(() => A.checkLoginRate(ipReq('192.168.9.9')));
  A.clearLoginRate(req);
});
