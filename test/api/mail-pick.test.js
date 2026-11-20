'use strict';
/** 📧 משימה ממייל שבוחרים — דרך השרת האמיתי: בלי Gmail מחובר, הודעה ברורה; בלי התחברות — לא נגיש. */
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

test('GET /api/ai/mail-pick — בלי Gmail מחובר: 400 עם הפניה ל"החשבון שלי"', async () => {
  const r = await srv.api('GET', '/api/ai/mail-pick?q=test', { cookie });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /החשבון שלי/);
});

test('POST /api/ai/mail-pick/:gmailId — בלי Gmail מחובר: 400, ולא נוצרת הצעה', async () => {
  const r = await srv.api('POST', '/api/ai/mail-pick/abcdef123', { cookie, body: { box: 0 } });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /החשבון שלי/);
  const inbox = await srv.api('GET', '/api/ai/inbox', { cookie });
  assert.equal(inbox.json.suggestions.pending.length, 0);
});

test('בלי התחברות — 401', async () => {
  assert.equal((await srv.api('GET', '/api/ai/mail-pick')).status, 401);
});
