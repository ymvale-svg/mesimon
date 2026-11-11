'use strict';
/**
 * 📧 הסקירה הלילית קוראת גם הערות על משימון מהמייל של מנהלי המערכת: מוסווה, בלי מענה אוטומטי,
 * בלי מה שמשימון עצמו שלח, ותקלה בתיבה לא מפילה את הייצוא. Gmail מזויף — בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations/gmail');
const Review = require('../../../server/whatsapp/bot-review');

boot();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const mail = ({ from, subject, text, date = 'Wed, 11 Nov 2026 10:00:00 +0200', extra = [] }) => ({
  payload: {
    mimeType: 'text/plain',
    headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }, ...extra],
    body: { data: b64(text) }
  }
});

test('mailFeedback — מיילים על משימון מהתיבה של המנהל, מוסווים; מענה אוטומטי — לא', async (t) => {
  D.setSetting('bot_review_mailboxes', null);
  const admin = user({ role: 'superadmin', full_name: 'מנהל' });
  const queries = [];
  t.mock.method(Gmail, 'boxesOf', (userId) => (userId === admin.id ? [`${admin.id}:0`] : []));
  t.mock.method(Gmail, 'search', async (who, q) => { queries.push(q); return ['m1', 'm2']; });
  t.mock.method(Gmail, 'messageFull', async (who, id) => (id === 'm1'
    ? mail({ from: 'דנה כהן <dana@example.com>', subject: 'הערה על משימון', text: 'הבוט לא שולח לי את המשימות. הטלפון שלי 050-1234567' })
    : mail({ from: 'auto@example.com', subject: 'משימון: מענה אוטומטי', text: 'אני מחוץ למשרד', extra: [{ name: 'Auto-Submitted', value: 'auto-replied' }] })));
  const r = await Review.mailFeedback('2026-11-10T19:40:00.000Z');
  assert.equal(r.mails.length, 1);
  assert.equal(r.mails[0].from, 'דנה כהן');
  assert.equal(r.mails[0].subject, 'הערה על משימון');
  assert.match(r.mails[0].text, /הבוט לא שולח לי את המשימות/);
  assert.match(r.mails[0].text, /\[טלפון\]/);
  assert.doesNotMatch(r.mails[0].text, /050-1234567/);
  assert.match(queries[0], /^after:\d+ /);
  assert.match(queries[0], /משימון/);
  assert.match(queries[0], /-subject:"סקירת הבוט"/);
});

test('mailFeedback — ‎bot_review_mailboxes‎ קובע את מי לקרוא; תקלה בתיבה נרשמת ולא מפילה', async (t) => {
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
