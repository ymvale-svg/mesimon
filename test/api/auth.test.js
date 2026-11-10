'use strict';
/** התחברות, סשן ויציאה — מול השרת האמיתי (תהליך-בן). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
before(async () => { srv = await Server.start(); });
after(async () => { await srv?.stop(); });

const { ADMIN } = Server;

test('הכניסה מצליחה עם הסיסמה מ-ADMIN_PASSWORD ומחזירה את המנהל הראשון', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(r.status, 200);
  assert.equal(r.json.actor.email, ADMIN.email);
  assert.equal(r.json.actor.name, ADMIN.name);
  assert.equal(r.json.actor.role, 'superadmin');
  assert.equal(r.json.actor.type, 'user');
  assert.equal(typeof r.json.permissions, 'object');
  assert.ok(r.cookie, 'עוגיית סשן נשלחה');
  assert.match(r.cookie, /^mesimon_sid=[0-9a-f]{64}$/);
});

test('עוגיית הסשן היא HttpOnly ו-SameSite=Lax, בלי Secure ב-HTTP', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  const raw = r.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Path=\//);
  assert.doesNotMatch(raw, /Secure/);
});

test('מאחורי פרוקסי HTTPS (‏x-forwarded-proto) העוגייה מסומנת Secure', async () => {
  const r = await srv.api('POST', '/api/auth/login', {
    body: { email: ADMIN.email, password: ADMIN.password },
    headers: { 'x-forwarded-proto': 'https' }
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /; Secure/);
});

test('האימייל בכניסה אינו תלוי באותיות גדולות ורווחים', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: { email: `  ${ADMIN.email.toUpperCase()} `, password: ADMIN.password } });
  assert.equal(r.status, 200);
  assert.equal(r.json.actor.email, ADMIN.email);
});

test('סיסמה שגויה — 401 בלי עוגייה', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: 'wrong' } });
  assert.equal(r.status, 401);
  assert.equal(r.cookie, null);
  assert.ok(r.json.error);
});

test('משתמש שאינו קיים — 401 עם אותה הודעה כמו סיסמה שגויה', async () => {
  const wrongPass = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: 'nope' } });
  const noUser = await srv.api('POST', '/api/auth/login', { body: { email: 'ghost@test.local', password: 'nope' } });
  assert.equal(noUser.status, 401);
  assert.equal(noUser.json.error, wrongPass.json.error, 'לא חושפים אם החשבון קיים');
});

test('אימייל או סיסמה חסרים — 400', async () => {
  const noPass = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email } });
  assert.equal(noPass.status, 400);
  const noMail = await srv.api('POST', '/api/auth/login', { body: { password: 'x' } });
  assert.equal(noMail.status, 400);
  const empty = await srv.api('POST', '/api/auth/login', { body: {} });
  assert.equal(empty.status, 400);
});

test('גוף שאינו JSON תקין — 400 עם הודעה בעברית', async () => {
  const r = await srv.api('POST', '/api/auth/login', { body: '{"email": "a@b", ', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'גוף הבקשה אינו JSON תקין');
});

test('/api/bootstrap בלי עוגייה — 401', async () => {
  const r = await srv.api('GET', '/api/bootstrap');
  assert.equal(r.status, 401);
  assert.ok(r.json.error);
});

test('/api/bootstrap עם עוגייה מזויפת — 401', async () => {
  const r = await srv.api('GET', '/api/bootstrap', { cookie: `mesimon_sid=${'0'.repeat(64)}` });
  assert.equal(r.status, 401);
});

test('/api/bootstrap עם סשן תקף מחזיר את המשתמש, ההרשאות והבורדים', async () => {
  const cookie = await srv.login(ADMIN.email, ADMIN.password);
  const r = await srv.api('GET', '/api/bootstrap', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.actor.email, ADMIN.email);
  assert.equal(r.json.actor.roleLabel, 'אדמין על');
  assert.ok(Array.isArray(r.json.boards) && r.json.boards.length >= 1);
  const internal = r.json.boards.find((b) => b.type === 'internal');
  assert.ok(internal, 'יש בורד פנימי');
  assert.deepEqual(internal.columns.map((c) => c.key), ['new', 'in_progress', 'done']);
  assert.ok(Array.isArray(r.json.priorities));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('יציאה מבטלת את הסשן בשרת ומוחקת את העוגייה', async () => {
  const cookie = await srv.login(ADMIN.email, ADMIN.password);
  assert.equal((await srv.api('GET', '/api/bootstrap', { cookie })).status, 200);

  const out = await srv.api('POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true });
  assert.match(out.headers.get('set-cookie'), /mesimon_sid=;.*Max-Age=0/);

  // גם מי ששומר את העוגייה הישנה כבר לא מחובר
  assert.equal((await srv.api('GET', '/api/bootstrap', { cookie })).status, 401);
});

test('יציאה בלי סשן אינה שגיאה', async () => {
  const r = await srv.api('POST', '/api/auth/logout');
  assert.equal(r.status, 200);
});

test('יציאה מסשן אחד אינה מנתקת סשן אחר של אותו משתמש', async () => {
  const a = await srv.login(ADMIN.email, ADMIN.password);
  const b = await srv.login(ADMIN.email, ADMIN.password);
  assert.notEqual(a, b);
  await srv.api('POST', '/api/auth/logout', { cookie: a });
  assert.equal((await srv.api('GET', '/api/bootstrap', { cookie: a })).status, 401);
  assert.equal((await srv.api('GET', '/api/bootstrap', { cookie: b })).status, 200);
});

test('הגבלת ניסיונות: אחרי 10 כישלונות מאותה כתובת — חסימה גם לסיסמה נכונה', async () => {
  // כתובת נפרדת (x-forwarded-for) כדי לא לחסום את שאר הבדיקות בקובץ
  const headers = { 'x-forwarded-for': '10.99.0.1' };
  for (let i = 0; i < 10; i++) {
    const r = await srv.api('POST', '/api/auth/login', { headers, body: { email: `nobody${i}@test.local`, password: 'x' } });
    assert.equal(r.status, 401);
  }
  const blocked = await srv.api('POST', '/api/auth/login', { headers, body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(blocked.status, 401);
  assert.match(blocked.json.error, /יותר מדי ניסיונות/);
  assert.equal(blocked.cookie, null);

  // כתובת אחרת אינה מושפעת
  const other = await srv.api('POST', '/api/auth/login', { headers: { 'x-forwarded-for': '10.99.0.2' }, body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(other.status, 200);
});

test('/api/branding זמין בלי התחברות, וכניסה עם Google כבויה כשאינה מוגדרת', async () => {
  const r = await srv.api('GET', '/api/branding');
  assert.equal(r.status, 200);
  assert.equal(r.json.googleLogin, false);
  assert.ok('companyLogo' in r.json);
});

test('כניסה עם Google כשאינה מוגדרת — 400 ולא הפניה', async () => {
  const r = await srv.api('GET', '/api/auth/google/start');
  assert.equal(r.status, 400);
});

test('כניסה עם גוף JSON שאינו אובייקט (null) — 400 ולא 500', async () => {
  for (const raw of ['null', '1', '"x"']) {
    const r = await srv.api('POST', '/api/auth/login', { body: raw });
    assert.equal(r.status, 400, `${raw}: ${r.text}`);
  }
});

test('עוגייה בקידוד שבור לא שוברת את הבקשה — הסשן עדיין מזוהה', async () => {
  const login = await srv.api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  const r = await srv.api('GET', '/api/bootstrap', { cookie: `junk=%E0%A4%A; ${login.cookie}` });
  assert.equal(r.status, 200, r.text);
});

test('השרת לא נפל, לא החזיר 500 ולא ניסה לפנות לרשת במהלך הבדיקות', () => {
  assert.equal(srv.exited(), null);
  assert.doesNotMatch(srv.output(), /שרת הבדיקה ניסה לפנות לרשת/);
  assert.doesNotMatch(srv.output(), /שגיאת שרת/);
});
