'use strict';
/**
 * 📧 משימה שנולדה ממייל — עותק של המייל נשמר במשימה, כדי שכל מי שעובד עליה יבין על מה מדובר
 * (הקישור ל-Gmail עובד רק למי שהמייל בתיבה שלו). Gmail מזויף — בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations/gmail');
const Scan = require('../../../server/mail/mail-scan');

boot();
const board = D.get('SELECT id FROM boards ORDER BY id LIMIT 1').id;
function newTask() {
  const ts = new Date().toISOString();
  return Number(D.run("INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at, source) VALUES (?,?,'new',0,0,?,?,'email')",
    'משימה ממייל', board, ts, ts).lastInsertRowid);
}
const RAW = [
  'From: =?UTF-8?B?' + Buffer.from('עו"ד דורית').toString('base64') + '?= <dorit@law.example>',
  'Subject: =?UTF-8?B?' + Buffer.from('כתב הסכמה – שאול').toString('base64') + '?=',
  'Date: Tue, 10 Nov 2026 09:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('בוקר טוב,\nמצ"ב כתב הסכמה חתום. נא לקלוט.\n\nבברכה').toString('base64')
].join('\r\n');

test('captureSourceMail — מאת, נושא, תאריך וטקסט נשמרים במשימה; sourceMailOf קורא אותם', async (t) => {
  const taskId = newTask();
  const asked = [];
  t.mock.method(Gmail, 'raw', async (who, id) => { asked.push([who, id]); return { raw: Buffer.from(RAW) }; });
  await Scan.captureSourceMail(taskId, { user_id: 7, box: 0, gmail_id: 'g1', from_name: 'x', subject: 'y' });
  assert.deepEqual(asked, [[7, 'g1']], 'מהתיבה של מי שהמייל אצלו');
  const m = Scan.sourceMailOf(D.get('SELECT source_mail FROM tasks WHERE id = ?', taskId));
  assert.equal(m.from, 'עו"ד דורית');
  assert.equal(m.fromEmail, 'dorit@law.example');
  assert.equal(m.subject, 'כתב הסכמה – שאול');
  assert.equal(m.date, '2026-11-10T07:00:00.000Z');
  assert.match(m.text, /מצ"ב כתב הסכמה חתום/);
});

test('sourceMailOf — אין עותק / עותק פגום: null', () => {
  assert.equal(Scan.sourceMailOf({ source_mail: '' }), null);
  assert.equal(Scan.sourceMailOf({ source_mail: '{bad' }), null);
  assert.equal(Scan.sourceMailOf(null), null);
});

test('captureSourceMail — בלי מזהה מייל: לא פונה ל-Gmail', async (t) => {
  let called = 0;
  t.mock.method(Gmail, 'raw', async () => { called += 1; return { raw: Buffer.from(RAW) }; });
  assert.equal(await Scan.captureSourceMail(newTask(), { user_id: 7 }), null);
  assert.equal(called, 0);
});
