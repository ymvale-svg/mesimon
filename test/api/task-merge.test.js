'use strict';
/** 🔀 איחוד ידני של משימות — ‎POST /api/tasks/:id/merge‎: המשימה נסגרת והתוכן עובר לזו שנבחרה. מנהל המערכת פועל. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
let cookie;
before(async () => {
  srv = await Server.start();
  cookie = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
});
after(async () => { await srv?.stop(); });

const call = (method, path, body) => srv.api(method, path, { cookie, body });
async function create(body) {
  const r = await call('POST', '/api/tasks', body);
  assert.equal(r.status, 201, r.text);
  return r.json.task;
}

test('איחוד: הצ\'קליסט וההערות עוברים, המשימה שאוחדה נסגרת, ובמה שנשאר נרשם מה אוחד', async () => {
  const keep = await create({ title: 'צוקרמן — מגדלי הנשיא', checklist: ['כתב תביעה'] });
  const drop = await create({ title: 'צוקרמן תביעה', description: 'פרטים מהלקוח', checklist: ['ייפוי כוח'], dupChecked: true });
  const c = await call('POST', `/api/tasks/${drop.id}/comments`, { body: 'הערה על התביעה' });
  assert.ok([200, 201].includes(c.status), c.text);

  const r = await call('POST', `/api/tasks/${drop.id}/merge`, { intoId: keep.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.task.id, keep.id);
  assert.equal(r.json.task.checklistTotal, 2);

  const after1 = (await call('GET', `/api/tasks/${keep.id}`)).json.task;
  const bodies = after1.comments.map((x) => x.body).join('\n');
  assert.match(bodies, /הערה על התביעה/);
  assert.match(bodies, /מוזגה לכאן המשימה #\d+ "צוקרמן תביעה"/);
  assert.match(bodies, /פרטים מהלקוח/, 'התיאור של מה שאוחד לא הולך לאיבוד');
  const gone = (await call('GET', `/api/tasks/${drop.id}`)).json.task;
  assert.equal(gone.isFinal, true, 'המשימה שאוחדה נסגרה');
});

test('איחוד: עם עצמה, משימה שלא קיימת, או משימה סגורה — שגיאה', async () => {
  const a = await create({ title: 'משימה א' });
  const b = await create({ title: 'משימה ב', dupChecked: true });
  assert.equal((await call('POST', `/api/tasks/${a.id}/merge`, { intoId: a.id })).status, 400);
  assert.equal((await call('POST', `/api/tasks/${a.id}/merge`, { intoId: 999999 })).status, 404);
  assert.equal((await call('POST', `/api/tasks/${a.id}/merge`, { intoId: b.id })).status, 200);
  assert.equal((await call('POST', `/api/tasks/${b.id}/merge`, { intoId: a.id })).status, 400, 'א כבר סגורה');
});
