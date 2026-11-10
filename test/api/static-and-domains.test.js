'use strict';
/**
 * קבצים סטטיים, נתיבי API לא קיימים, ונקודות קריאה של תחומים אחרים (Today, אלפון, פגישות, מה חדש) —
 * בלי שום שירות חיצוני מוגדר הם חייבים לענות 200 ולא ליפול.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Server = require('./server');

let srv;
let admin;
before(async () => {
  srv = await Server.start();
  admin = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
});
after(async () => { await srv?.stop(); });

const get = (p) => srv.api('GET', p, { cookie: admin });
const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

// --- קבצים סטטיים ---

test('/ מגיש את index.html עם כותרות ההגנה', async () => {
  const r = await srv.api('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.equal(r.text, INDEX);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('קבצי CSS ו-JS מוגשים עם סוג התוכן הנכון', async () => {
  const css = await srv.api('GET', '/css/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const js = await srv.api('GET', '/js/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  const manifest = await srv.api('GET', '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
});

test('נתיב צד-לקוח לא מוכר מוגש כאפליקציה (index.html)', async () => {
  const r = await srv.api('GET', '/board/some/deep/route');
  assert.equal(r.status, 200);
  assert.equal(r.text, INDEX);
});

test('בקשת טווח (Range) מקבלת 206 עם החלק המבוקש', async () => {
  const r = await srv.api('GET', '/robots.txt', { headers: { range: 'bytes=0-3' } });
  const full = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'robots.txt'), 'utf8');
  assert.equal(r.status, 206);
  assert.equal(r.text, Buffer.from(full).subarray(0, 4).toString('utf8'));
  assert.match(r.headers.get('content-range'), new RegExp(`^bytes 0-3/${Buffer.byteLength(full)}$`));
});

test('טווח מחוץ לקובץ — 416', async () => {
  const r = await srv.api('GET', '/robots.txt', { headers: { range: 'bytes=99999999-' } });
  assert.equal(r.status, 416);
});

test('מעבר תיקיות מקודד (‎..%2f‎) נחסם — 403 בלי תוכן', async () => {
  for (const p of ['/..%2fpackage.json', '/..%2f..%2fetc%2fpasswd', '/css/..%2f..%2fserver%2findex.js', '/%2e%2e%2fpackage.json']) {
    const r = await srv.raw('GET', p);
    assert.equal(r.status, 403, p);
    assert.equal(r.text, '', p);
  }
});

test('מעבר תיקיות לא מקודד מנורמל לתוך public — לא דולפים קבצים מחוצה לה', async () => {
  for (const p of ['/../package.json', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/css/../../server/index.js']) {
    const r = await srv.raw('GET', p);
    assert.ok([200, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.doesNotMatch(r.text, /"name": "mesimon"|root:x:0:0|require\('\.\/core'\)/, p);
  }
});

test('קידוד אחוזים שבור בנתיב — 400 ולא 500', async () => {
  for (const p of ['/%E0%A4%A', '/js/%E0%A4%A.js']) {
    const r = await srv.raw('GET', p);
    assert.equal(r.status, 400, p);
  }
});

test('נתיב API לא קיים — 404 JSON, גם עם התחברות', async () => {
  for (const [method, p, cookie] of [['GET', '/api/nope'], ['GET', '/api/nope', admin], ['POST', '/api/tasks/1/teleport', admin], ['GET', '/api/']]) {
    const r = await srv.api(method, p, { cookie });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.json.error, 'נקודת קצה לא קיימת');
  }
});

test('מתודה לא נתמכת על נתיב קיים — 404 ולא הגשת האפליקציה', async () => {
  const r = await srv.api('DELETE', '/api/branding', { cookie: admin });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'נקודת קצה לא קיימת');
});

// --- תחומים אחרים: קריאה בלבד, בלי שירותים חיצוניים ---

test('נקודות הקריאה של התחומים דורשות התחברות — 401', async () => {
  for (const p of ['/api/today', '/api/today/count', '/api/phonebook', '/api/meetings/pending', '/api/meetings/calendars', '/api/whats-new', '/api/home', '/api/notifications']) {
    const r = await srv.api('GET', p);
    assert.equal(r.status, 401, p);
  }
});

test('Today עונה בלי Gmail, יומן ו-AI', async () => {
  const r = await get('/api/today');
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(r.json.tasks.overdue));
  assert.ok(Array.isArray(r.json.tasks.today));
  assert.equal(typeof r.json.isWorkDay, 'boolean');
});

test('Today: המונה והתובנות עונים גם בלי מקורות', async () => {
  const count = await get('/api/today/count');
  assert.equal(count.status, 200);
  assert.equal(typeof count.json.count, 'number');
  const insights = await get('/api/today/insights');
  assert.equal(insights.status, 200);
  assert.equal(insights.json.insights, null);
});

test('Today: משימה שהיעד שלה היום מופיעה ב-Today', async () => {
  const today = (await get('/api/today')).json.date;
  const t = (await srv.api('POST', '/api/tasks', { cookie: admin, body: { title: 'יעד היום', dueDate: today, assigneeType: 'user', assigneeId: 1 } })).json.task;
  const r = await get('/api/today');
  assert.ok(JSON.stringify(r.json.tasks).includes(`"id":${t.id}`), 'המשימה מופיעה ברשימות Today');
});

test('אלפון: הרשימה כוללת את משתמשי המערכת', async () => {
  const r = await get('/api/phonebook');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.items));
  assert.equal(typeof r.json.total, 'number');
  assert.ok(r.json.items.some((i) => i.email === Server.ADMIN.email));
});

test('אלפון: רשומה חדשה נמצאת בחיפוש', async () => {
  const c = await srv.api('POST', '/api/phonebook', { cookie: admin, body: { name: 'ספק הבדיקות בע"מ', phone: '03-5551234' } });
  assert.equal(c.status, 201, c.text);
  const r = await get(`/api/phonebook?q=${encodeURIComponent('ספק הבדיקות')}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((i) => i.name === 'ספק הבדיקות בע"מ'));
});

test('פגישות: היומנים ומה שממתין לקביעה עונים בלי Google ו-Zoom', async () => {
  const cal = await get('/api/meetings/calendars');
  assert.equal(cal.status, 200, cal.text);
  assert.equal(cal.json.google.calendar, false);
  assert.equal(cal.json.zoom.enabled, false);
  const pending = await get('/api/meetings/pending');
  assert.equal(pending.status, 200);
  assert.ok(Array.isArray(pending.json.tasks));
});

test('פגישות: משימה שכותרתה "פגישה עם…" ממתינה לקביעה', async () => {
  const t = (await srv.api('POST', '/api/tasks', { cookie: admin, body: { title: 'פגישה עם הספק' } })).json.task;
  assert.equal(t.meetingPending, true);
  const pending = await get('/api/meetings/pending');
  assert.ok(pending.json.tasks.some((x) => x.id === t.id));
});

test('פגישות: טווח יומן לא תקין — 400', async () => {
  assert.equal((await get('/api/meetings/range')).status, 400);
  assert.equal((await get('/api/meetings/range?from=2026-11-10&to=2026-11-01')).status, 400);
});

test('מה חדש: הבאנר והרשימה למנהל עונים', async () => {
  const r = await get('/api/whats-new');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.releases));
  assert.ok(Array.isArray(r.json.screens));
  const seen = await srv.api('POST', '/api/whats-new/seen', { cookie: admin, body: {} });
  assert.equal(seen.status, 200);
  const admins = await get('/api/admin/releases');
  assert.equal(admins.status, 200);
  assert.ok(Array.isArray(admins.json.releases));
  assert.equal(admins.json.mailEnabled, false, 'בלי SMTP אין מייל');
});

test('דף הבית, התראות, פרויקטים, דוחות וחיפוש עונים 200', async () => {
  for (const p of ['/api/home', '/api/notifications', '/api/projects', '/api/reports', '/api/departments', '/api/templates', '/api/status-list', `/api/search?q=${encodeURIComponent('משימה')}`, '/api/ai/status']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} → ${r.status} ${r.text.slice(0, 120)}`);
  }
});

test('מצב ה-AI: כבוי כשאין מפתח', async () => {
  const r = await get('/api/ai/status');
  assert.equal(r.json.enabled, false);
});

test('השרת לא נפל ולא ניסה לפנות לרשת במהלך הבדיקות', () => {
  assert.equal(srv.exited(), null);
  assert.doesNotMatch(srv.output(), /שרת הבדיקה ניסה לפנות לרשת/);
  assert.doesNotMatch(srv.output(), /שגיאת שרת/);
});
