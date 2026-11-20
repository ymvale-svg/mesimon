'use strict';
/**
 * 📧 "המייל עצמו" בדיאלוג "משימה מהמייל" — העובד רואה את המייל שממנו נולדה ההצעה, ואם הוא שלח אותו
 * או קיבל אותו (מהערה של עובד: "לא ברור אם זה מייל שנשלח או תזכורת ממיילים ישנים"). Gmail מזויף — בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations/gmail');
const Scan = require('../../../server/mail/mail-scan');

boot();
const b64 = (s) => Buffer.from(s).toString('base64');
const rawMail = (from, to) => [
  `From: =?UTF-8?B?${b64('שולח')}?= <${from}>`,
  `To: ${to}`,
  `Subject: =?UTF-8?B?${b64('הצעת מחיר לפרויקט')}?=`,
  'Date: Tue, 10 Nov 2026 09:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('שלום,\nמצורפת הצעת המחיר. נא לאשר עד יום חמישי.')
].join('\r\n');

function owner(email) {
  const u = user();
  D.run('INSERT INTO mail_connections (user_id, email, created_at) VALUES (?,?,?)', u.id, email, new Date().toISOString());
  return u;
}
function suggestion(userId, data = {}, gmailId = 'g1') {
  return Number(D.run('INSERT INTO ai_suggestions (user_id, gmail_id, from_name, subject, data, created_at) VALUES (?,?,?,?,?,?)',
    userId, gmailId, 'x', 'y', JSON.stringify(data), new Date().toISOString()).lastInsertRowid);
}

test('suggestionMail — מייל שהעובד קיבל: sent=false, עם מאת, אל, תאריך וטקסט', async (t) => {
  const u = owner('me@org.example');
  const asked = [];
  t.mock.method(Gmail, 'raw', async (who, id) => { asked.push([who, id]); return { raw: Buffer.from(rawMail('vendor@supplier.example', 'me@org.example')) }; });
  const m = await Scan.suggestionMail(suggestion(u.id), u.id);
  assert.deepEqual(asked, [[u.id, 'g1']]);
  assert.equal(m.sent, false);
  assert.equal(m.fromEmail, 'vendor@supplier.example');
  assert.equal(m.to, 'me@org.example');
  assert.equal(m.subject, 'הצעת מחיר לפרויקט');
  assert.equal(m.date, '2026-11-10T07:00:00.000Z');
  assert.match(m.text, /נא לאשר עד יום חמישי/);
  assert.deepEqual(m.files, []);
});

test('suggestionMail — מייל שהעובד שלח מהתיבה שלו: sent=true (בלי תלות באותיות גדולות)', async (t) => {
  const u = owner('Me2@Org.example');
  t.mock.method(Gmail, 'raw', async () => ({ raw: Buffer.from(rawMail('me2@org.example', 'vendor@supplier.example')) }));
  const m = await Scan.suggestionMail(suggestion(u.id), u.id);
  assert.equal(m.sent, true);
});

test('suggestionMail — עובד אחר: 404, ולא פונים ל-Gmail', async (t) => {
  const u = owner('me3@org.example');
  const other = user();
  let called = 0;
  t.mock.method(Gmail, 'raw', async () => { called += 1; return { raw: Buffer.from(rawMail('a@b.example', 'c@d.example')) }; });
  await assert.rejects(Scan.suggestionMail(suggestion(u.id), other.id), (e) => e.status === 404);
  assert.equal(called, 0);
});

test('suggestionMail — הצעה מוואטסאפ: 404', async (t) => {
  const u = owner('me4@org.example');
  let called = 0;
  t.mock.method(Gmail, 'raw', async () => { called += 1; return { raw: Buffer.from(rawMail('a@b.example', 'c@d.example')) }; });
  await assert.rejects(Scan.suggestionMail(suggestion(u.id, { source: 'whatsapp', groupName: 'קבוצה' }, ''), u.id), (e) => e.status === 404);
  assert.equal(called, 0);
});

test('suggestionMail — Gmail נכשל: שגיאה ברורה בעברית (502), לא קריסה', async (t) => {
  const u = owner('me5@org.example');
  t.mock.method(Gmail, 'raw', async () => { throw new Error('invalid_grant'); });
  t.mock.method(console, 'error', () => {});
  await assert.rejects(Scan.suggestionMail(suggestion(u.id), u.id), (e) => e.status === 502 && /Gmail/.test(e.message) && !/invalid_grant/.test(e.message));
});

test('captureSourceMail — העותק במשימה כולל גם אל ו-sent', async (t) => {
  const u = owner('me6@org.example');
  const board = D.get('SELECT id FROM boards ORDER BY id LIMIT 1').id;
  const ts = new Date().toISOString();
  const taskId = Number(D.run("INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at, source) VALUES (?,?,'new',0,0,?,?,'email')",
    'משימה', board, ts, ts).lastInsertRowid);
  t.mock.method(Gmail, 'raw', async () => ({ raw: Buffer.from(rawMail('me6@org.example', 'vendor@supplier.example')) }));
  await Scan.captureSourceMail(taskId, D.get('SELECT * FROM ai_suggestions WHERE id = ?', suggestion(u.id)));
  const m = Scan.sourceMailOf(D.get('SELECT source_mail FROM tasks WHERE id = ?', taskId));
  assert.equal(m.sent, true);
  assert.equal(m.to, 'vendor@supplier.example');
});

test('listFor — לכל הצעה sent: מהתיבה שלי (true) או מבחוץ (false), בלי לפנות ל-Gmail', async (t) => {
  const u = owner('me7@org.example');
  let called = 0;
  t.mock.method(Gmail, 'raw', async () => { called += 1; return { raw: Buffer.from('') }; });
  const add = (email, gmailId) => Number(D.run("INSERT INTO ai_suggestions (user_id, gmail_id, from_name, from_email, subject, data, received_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
    u.id, gmailId, 'שם', email, 'נושא', '{}', new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  const mine = add('ME7@org.example', 'g1');
  const theirs = add('vendor@supplier.example', 'g2');
  const list = Scan.listFor(u.id).pending;
  assert.equal(list.find((s) => s.id === mine).sent, true);
  assert.equal(list.find((s) => s.id === theirs).sent, false);
  assert.equal(called, 0);
});
