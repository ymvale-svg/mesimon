'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const H = require('../../../server/http-kit');

/** בקשה מזויפת: זרם עם כותרות */
function fakeReq(chunks = [], headers = {}) {
  const req = Readable.from(chunks.map((c) => Buffer.from(c)));
  req.headers = headers;
  return req;
}

/** תשובה מזויפת: אוספת סטטוס, כותרות וגוף */
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); }
  });
  res.status = null;
  res.headers = null;
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers; return res; };
  res.body = () => Buffer.concat(chunks);
  res.done = new Promise((resolve) => res.on('finish', resolve));
  return res;
}

test('HttpError — סטטוס והודעה', () => {
  const e = new H.HttpError(418, 'קומקום');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 418);
  assert.equal(e.message, 'קומקום');
});

test('קיצורי שגיאות — סטטוסים וברירות מחדל', () => {
  assert.equal(H.badRequest('x').status, 400);
  assert.equal(H.unauthorized().status, 401);
  assert.equal(H.unauthorized().message, 'נדרשת התחברות מחדש');
  assert.equal(H.forbidden().status, 403);
  assert.equal(H.notFound().status, 404);
  assert.equal(H.notFound('אין').message, 'אין');
});

test('parseCookies — כמה עוגיות ופענוח', () => {
  const out = H.parseCookies({ headers: { cookie: 'a=1; mesimon_sid=abc ; name=%D7%A9; flag' } });
  assert.deepEqual(out, { a: '1', mesimon_sid: 'abc', name: 'ש' });
});

test('parseCookies — בלי כותרת', () => {
  assert.deepEqual(H.parseCookies({ headers: {} }), {});
});

test('parseCookies — "=" בתוך הערך נשמר', () => {
  assert.deepEqual(H.parseCookies({ headers: { cookie: 't=a=b==' } }), { t: 'a=b==' });
});

test('readBody — מחבר חלקים', async () => {
  const buf = await H.readBody(fakeReq(['ab', 'cd']));
  assert.equal(buf.toString(), 'abcd');
});

test('readJson — JSON תקין בכמה חלקים', async () => {
  const body = JSON.stringify({ title: 'משימה', n: 3 });
  const data = await H.readJson(fakeReq([body.slice(0, 5), body.slice(5)]));
  assert.deepEqual(data, { title: 'משימה', n: 3 });
});

test('readJson — גוף ריק הוא אובייקט ריק', async () => {
  assert.deepEqual(await H.readJson(fakeReq([])), {});
});

test('readJson — JSON שבור הוא 400', async () => {
  await assert.rejects(H.readJson(fakeReq(['{bad'])), (e) => e instanceof H.HttpError && e.status === 400);
});

test('readBody — גוף מעל 60MB הוא 413', async () => {
  const big = Buffer.alloc(61 * 1024 * 1024);
  const req = Readable.from([big]);
  req.headers = {};
  await assert.rejects(H.readBody(req), (e) => e.status === 413);
});

test('readBody — שגיאת זרם עוברת הלאה', async () => {
  const req = new Readable({ read() { this.destroy(new Error('נותק')); } });
  await assert.rejects(H.readBody(req), /נותק/);
});

test('sendJson — כותרות וגוף', async () => {
  const res = fakeRes();
  H.sendJson(res, 201, { ok: true, שם: 'דנה' });
  await res.done;
  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-length'], res.body().length);
  assert.deepEqual(JSON.parse(res.body().toString('utf8')), { ok: true, שם: 'דנה' });
});

test('sendJson — undefined נשלח כ-null', async () => {
  const res = fakeRes();
  H.sendJson(res, 200, undefined);
  await res.done;
  assert.equal(res.body().toString(), 'null');
});

test('sendText — אורך בבתים וכותרות נוספות', async () => {
  const res = fakeRes();
  H.sendText(res, 200, 'שלום', 'text/csv', { 'x-a': '1' });
  await res.done;
  assert.equal(res.headers['content-type'], 'text/csv');
  assert.equal(res.headers['content-length'], 8);
  assert.equal(res.headers['x-a'], '1');
  assert.equal(res.body().toString('utf8'), 'שלום');
});

test('sendText — סוג ברירת מחדל', async () => {
  const res = fakeRes();
  H.sendText(res, 404, 'x');
  await res.done;
  assert.equal(res.status, 404);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
});

test('parseUrl — נתיב ופרמטרים', () => {
  const u = H.parseUrl({ url: '/api/tasks?q=%D7%A9&x=1', headers: { host: 'example.com' } });
  assert.equal(u.pathname, '/api/tasks');
  assert.equal(u.searchParams.get('q'), 'ש');
  assert.equal(u.host, 'example.com');
  assert.equal(H.parseUrl({ url: '/a', headers: {} }).host, 'localhost');
});

test('Router — התאמה לפי שיטה ופרמטרים', () => {
  const r = new H.Router();
  const h1 = () => 1;
  const h2 = () => 2;
  r.get('/api/tasks/:id', h1).post('/api/tasks/:id/comments/:cid', h2);
  assert.deepEqual(r.match('GET', '/api/tasks/12'), { handler: h1, params: { id: '12' } });
  assert.deepEqual(r.match('POST', '/api/tasks/5/comments/%D7%90'), { handler: h2, params: { id: '5', cid: 'א' } });
  assert.equal(r.match('POST', '/api/tasks/12'), null);
  assert.equal(r.match('GET', '/api/tasks/12/x'), null);
  assert.equal(r.match('GET', '/api/tasks/'), null);
});

test('Router — נקודה בנתיב אינה תו כללי', () => {
  const r = new H.Router().get('/robots.txt', () => 0);
  assert.ok(r.match('GET', '/robots.txt'));
  assert.equal(r.match('GET', '/robotsXtxt'), null);
});

test('Router — put, patch, delete', () => {
  const r = new H.Router();
  r.put('/a', () => 'p').patch('/a', () => 'pa').delete('/a', () => 'd');
  assert.equal(r.match('PUT', '/a').handler(), 'p');
  assert.equal(r.match('PATCH', '/a').handler(), 'pa');
  assert.equal(r.match('DELETE', '/a').handler(), 'd');
});

// ---------------------------------------------------------------------------
// serveStatic
// ---------------------------------------------------------------------------

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimon-static-'));
const root = path.join(base, 'public');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'index.html'), '<h1>בית</h1>');
fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(root, 'sub', 'data.bin'), Buffer.from('0123456789'));
fs.writeFileSync(path.join(root, 'manifest.webmanifest'), '{}');
fs.writeFileSync(path.join(base, 'secret.txt'), 'סוד');

test('serveStatic — "/" מגיש את index.html עם כותרות הגנה', async () => {
  const res = fakeRes();
  assert.equal(H.serveStatic(res, root, '/'), true);
  await res.done;
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.body().toString('utf8'), '<h1>בית</h1>');
});

test('serveStatic — סוג לפי סיומת, מחרוזת שאילתה מתעלמת', async () => {
  const res = fakeRes();
  H.serveStatic(res, root, '/app.js?v=3');
  await res.done;
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  const m = fakeRes();
  H.serveStatic(m, root, '/manifest.webmanifest');
  await m.done;
  assert.equal(m.headers['content-type'], 'application/manifest+json; charset=utf-8');
});

test('serveStatic — סיומת לא מוכרת: זרם בתים', async () => {
  const res = fakeRes();
  H.serveStatic(res, root, '/sub/data.bin');
  await res.done;
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['content-length'], 10);
});

test('serveStatic — קובץ חסר או תיקייה: false', () => {
  assert.equal(H.serveStatic(fakeRes(), root, '/nope.html'), false);
  assert.equal(H.serveStatic(fakeRes(), root, '/sub'), false);
});

test('serveStatic — יציאה מהתיקייה חסומה ב-403', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/sub/../../secret.txt']) {
    const res = fakeRes();
    assert.equal(H.serveStatic(res, root, p), true, p);
    await res.done;
    assert.equal(res.status, 403, p);
    assert.equal(res.body().length, 0, p);
  }
});

test('serveStatic — טווח בתים 206', async () => {
  const res = fakeRes();
  H.serveStatic(res, root, '/sub/data.bin', { headers: { range: 'bytes=2-5' } });
  await res.done;
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  assert.equal(res.headers['content-length'], 4);
  assert.equal(res.body().toString(), '2345');
});

test('serveStatic — טווח פתוח ומהסוף', async () => {
  const a = fakeRes();
  H.serveStatic(a, root, '/sub/data.bin', { headers: { range: 'bytes=7-' } });
  await a.done;
  assert.equal(a.body().toString(), '789');
  const b = fakeRes();
  H.serveStatic(b, root, '/sub/data.bin', { headers: { range: 'bytes=-3' } });
  await b.done;
  assert.equal(b.headers['content-range'], 'bytes 7-9/10');
  assert.equal(b.body().toString(), '789');
});

test('serveStatic — סוף טווח מעבר לקובץ נחתך', async () => {
  const res = fakeRes();
  H.serveStatic(res, root, '/sub/data.bin', { headers: { range: 'bytes=8-100' } });
  await res.done;
  assert.equal(res.headers['content-range'], 'bytes 8-9/10');
  assert.equal(res.body().toString(), '89');
});

test('serveStatic — טווח לא תקין 416', async () => {
  const res = fakeRes();
  H.serveStatic(res, root, '/sub/data.bin', { headers: { range: 'bytes=20-30' } });
  await res.done;
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], 'bytes */10');
});

test('serveStatic — טווח ריק או בפורמט אחר: קובץ מלא', async () => {
  for (const range of ['bytes=-', 'items=1-2']) {
    const res = fakeRes();
    H.serveStatic(res, root, '/sub/data.bin', { headers: { range } });
    await res.done;
    assert.equal(res.status, 200, range);
    assert.equal(res.body().length, 10, range);
  }
});

test('MIME — סוגים חשובים', () => {
  assert.equal(H.MIME['.wav'], 'audio/wav');
  assert.equal(H.MIME['.mp4'], 'video/mp4');
  assert.equal(H.MIME['.pdf'], 'application/pdf');
  assert.equal(H.MIME['.csv'], 'text/csv; charset=utf-8');
});
