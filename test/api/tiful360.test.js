'use strict';
/**
 * 🎫 תפעול 360 ↔ משימון, דרך השרת האמיתי: קריאה שנסגרה בתפעול 360 סוגרת את המשימה שנוצרה ממנה,
 * בלי לשלוח את הסגירה בחזרה (בלי לולאה). "תפעול 360" כאן הוא שרת מקומי שסופר את הפניות אליו.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Server = require('./server');

const KEY = 'tiful360-test-key';
let srv;
let cookie;
let tiful;
const closeCalls = [];

before(async () => {
  // תפעול 360 המזויף: כל פנייה של משימון לסגירת קריאה נרשמת
  tiful = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      closeCalls.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'done' }));
    });
  });
  await new Promise((r) => tiful.listen(0, '127.0.0.1', r));
  srv = await Server.start({
    env: {
      TIFUL360_INBOUND_KEY: KEY,
      TIFUL360_API_URL: `http://127.0.0.1:${tiful.address().port}/it-api`,
      TIFUL360_API_KEY: 'k'
    }
  });
  cookie = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
  const d = await srv.api('POST', '/api/departments', { cookie, body: { name: 'תפעול' } });
  assert.equal(d.status, 201, d.text);
});
after(async () => {
  await srv?.stop();
  await new Promise((r) => tiful?.close(r));
});

const inbound = (path, body, key = KEY) =>
  srv.api('POST', `/api/integrations/tiful360${path}`, { body, headers: { authorization: `Bearer ${key}` } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ticketTask(ticketCode) {
  const r = await inbound('/tasks', { ticketCode, title: `קריאה ${ticketCode}`, subjectLabel: 'מיחשוב' });
  assert.equal(r.status, 201, r.text);
  return r.json.taskId;
}
const getTask = async (id) => (await srv.api('GET', `/api/tasks/${id}`, { cookie })).json.task;

test('קריאה שנסגרה בתפעול 360 — המשימה נסגרת, והסגירה לא נשלחת בחזרה', async () => {
  const id = await ticketTask('IT-9001');
  const r = await inbound('/tasks/close', { ticketCode: 'IT-9001', closedBy: 'אבי (IT)', message: 'הוחלף מסך' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, taskId: id, alreadyClosed: false });

  const task = await getTask(id);
  assert.equal(task.isFinal, true);
  assert.ok(task.completedAt);
  await sleep(300);
  assert.equal(closeCalls.filter((c) => c.ticket_code === 'IT-9001').length, 0, 'לא נשלחה בקשה לסגור את הקריאה בתפעול 360');
});

test('סגירה חוזרת — המשימה כבר סגורה, שום דבר לא משתנה', async () => {
  const id = await ticketTask('IT-9002');
  await inbound('/tasks/close', { ticketCode: 'IT-9002' });
  const r = await inbound('/tasks/close', { ticketCode: 'IT-9002' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, taskId: id, alreadyClosed: true });
});

test('סגירה במשימון עדיין סוגרת את הקריאה בתפעול 360 (הכיוון הקיים)', async () => {
  const id = await ticketTask('IT-9003');
  const r = await srv.api('PATCH', `/api/tasks/${id}`, { cookie, body: { status: 'done' } });
  assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 20 && !closeCalls.some((c) => c.ticket_code === 'IT-9003'); i++) await sleep(100);
  const call = closeCalls.find((c) => c.ticket_code === 'IT-9003');
  assert.ok(call, 'נשלחה בקשה לסגור את הקריאה');
  assert.equal(call.action, 'close_ticket');
});

test('קריאה שאין לה משימה — 404; מפתח שגוי — 401', async () => {
  assert.equal((await inbound('/tasks/close', { ticketCode: 'IT-0000' })).status, 404);
  assert.equal((await inbound('/tasks/close', { ticketCode: 'IT-9001' }, 'wrong')).status, 401);
});
