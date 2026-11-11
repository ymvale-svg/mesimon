'use strict';
/**
 * 📧 הסקירה הלילית קוראת גם הערות על משימון מהמייל — רק מהתיבה שביקשו, רק "משימון", עם צילומי המסך.
 * מוסווה, בלי מענה אוטומטי, ותקלה בתיבה לא מפילה את הייצוא. Gmail מזויף — בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations/gmail');
const Review = require('../../../server/whatsapp/bot-review');

boot();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const mail = ({ from, subject, text, date = 'Wed, 11 Nov 2026 10:00:00 +0200', extra = [], images = [] }) => ({
  payload: images.length ? {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }, ...extra],
    parts: [
      { partId: '0', mimeType: 'text/plain', headers: [], body: { data: b64(text) } },
      ...images.map((im, i) => ({ partId: String(i + 1), mimeType: 'image/png', filename: im.name,
        headers: [{ name: 'Content-Disposition', value: `attachment; filename="${im.name}"` }], body: { attachmentId: `att${i}`, size: im.size } }))
    ]
  } : {
    mimeType: 'text/plain',
    headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }, ...extra],
    body: { data: b64(text) }
  }
});

test('mailFeedback — בלי תיבה מבוקשת: לא קוראים מייל בכלל', async (t) => {
  D.setSetting('bot_review_mailboxes', null);
  user({ role: 'superadmin' });
  let read = 0;
  t.mock.method(Gmail, 'boxesOf', () => { read += 1; return []; });
  const r = await Review.mailFeedback('2026-11-10T19:40:00.000Z');
  assert.deepEqual(r.mails, []);
  assert.equal(read, 0);
});

test('mailFeedback — רק התיבה שביקשו, רק משימון והבוט; מוסווה; מענה אוטומטי — לא; צילום מסך מצורף', async (t) => {
  D.setSetting('bot_review_mailboxes', null);
  const admin = user({ role: 'superadmin', full_name: 'מנהל' });
  user({ role: 'superadmin', full_name: 'מנהל אחר' });
  const queries = [];
  const boxes = [];
  t.mock.method(Gmail, 'boxesOf', (userId) => { boxes.push(userId); return [`${userId}:0`]; });
  t.mock.method(Gmail, 'search', async (who, q) => { queries.push(q); return ['m1', 'm2']; });
  t.mock.method(Gmail, 'messageFull', async (who, id) => (id === 'm1'
    ? mail({ from: 'דנה כהן <dana@example.com>', subject: 'הערה על משימון', text: 'הבוט לא שולח לי את המשימות. הטלפון שלי 050-1234567',
      images: [{ name: 'screenshot.png', size: 1000 }, { name: 'huge.png', size: 9 * 1024 * 1024 }] })
    : mail({ from: 'auto@example.com', subject: 'משימון: מענה אוטומטי', text: 'אני מחוץ למשרד', extra: [{ name: 'Auto-Submitted', value: 'auto-replied' }] })));
  t.mock.method(Gmail, 'attachment', async () => Buffer.from('PNGDATA'));
  const r = await Review.mailFeedback('2026-11-10T19:40:00.000Z', { users: [admin.id] });
  assert.deepEqual(boxes, [admin.id], 'רק התיבה שביקשו — לא של מנהל אחר');
  assert.equal(r.mails[0].images.length, 1, 'תמונה גדולה מדי — לא');
  assert.equal(r.mails[0].images[0].name, 'screenshot.png');
  assert.equal(Buffer.from(r.mails[0].images[0].data, 'base64').toString(), 'PNGDATA');
  assert.equal(r.mails.length, 1);
  assert.equal(r.mails[0].from, 'דנה כהן');
  assert.equal(r.mails[0].subject, 'הערה על משימון');
  assert.match(r.mails[0].text, /הבוט לא שולח לי את המשימות/);
  assert.match(r.mails[0].text, /\[טלפון\]/);
  assert.doesNotMatch(r.mails[0].text, /050-1234567/);
  assert.match(queries[0], /^after:\d+ /);
  assert.match(queries[0], /\(משימון OR mesimon OR "אשל שלי" OR בוט OR הבוט\)/);
  assert.match(queries[0], /-subject:"סקירת הבוט"/);
});

test('mailFeedback — בלי תיבה מבוקשת, ההגדרה ‎bot_review_mailboxes‎; תקלה בתיבה נרשמת ולא מפילה', async (t) => {
  const other = user({ role: 'admin' });
  D.setSetting('bot_review_mailboxes', [other.id]);
  t.after(() => D.setSetting('bot_review_mailboxes', null));
  const asked = [];
  t.mock.method(Gmail, 'boxesOf', (userId) => { asked.push(userId); return [`${userId}:0`]; });
  t.mock.method(Gmail, 'search', async () => { throw new Error('invalid_grant'); });
  const r = await Review.mailFeedback('2026-11-10T19:40:00.000Z');
  assert.deepEqual(asked, [other.id]);
  assert.deepEqual(r.mails, []);
  assert.match(r.errors[0], /invalid_grant/);
});

test('sendReport — רעיון מהמייל (kind: idea) נשמר כהצעה בלי קישור', async () => {
  const r = await Review.sendReport({ subject: 'סקירה', summary: 'x', fixes: [{ title: 'סיכום פגישה למשתתפים', problem: 'עובדת ביקשה במייל', kind: 'idea' }] });
  const saved = JSON.parse(D.get('SELECT fixes FROM bot_reviews WHERE id = ?', r.id).fixes);
  assert.equal(saved[0].kind, 'idea');
  assert.equal(saved[0].url, '');
});
