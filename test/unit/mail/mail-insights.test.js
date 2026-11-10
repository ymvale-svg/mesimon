'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const I = require('../../../server/ai/mail-insights');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });

test('mask — מספר כרטיס: רק 4 הספרות האחרונות', () => {
  assert.equal(I.mask('כרטיס 4580 1234 5678 9012 חויב'), 'כרטיס ***9012 חויב');
  assert.equal(I.mask('4580-1234-5678-9012'), '***9012');
});

test('mask — מספר ארוך (חשבון) מוסתר, קצר נשאר', () => {
  assert.equal(I.mask('חשבון 123456789'), 'חשבון ***6789');
  assert.equal(I.mask('הזמנה 1234567'), 'הזמנה 1234567');
  assert.equal(I.mask(null), '');
});

test('label — שם וחברה; כשהשם כבר כולל את החברה — החברה', () => {
  assert.equal(I.label({ who: 'אורן', org: 'כהן ושות׳' }), 'אורן (כהן ושות׳)');
  assert.equal(I.label({ who: 'בנק לאומי - אורן', org: 'בנק לאומי' }), 'בנק לאומי');
  assert.equal(I.label({ fromName: 'דנה' }), 'דנה');
  assert.equal(I.label({ org: 'עירייה' }), 'עירייה');
});

test('GROUPS — כל סוג בקבוצה אחת לכל היותר', () => {
  const kinds = I.GROUPS.flatMap((g) => g.kinds);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.ok(!kinds.includes('newsletter'), 'ניוזלטר לא מוצג');
  assert.equal(I.HOURS, 24);
  assert.ok(I.MAX_MAILS_LONG > I.MAX_MAILS);
});

test('itemOf — מה שנשמר, ו-null כשאין', () => {
  const u = user();
  D.run('INSERT INTO mail_insights (user_id, gmail_id, data, received_at, created_at) VALUES (?,?,?,?,?)', u.id, 'g1', JSON.stringify({ box: 1, insight: 'x' }), D.nowIso(), D.nowIso());
  assert.deepEqual(I.itemOf(u.id, 'g1'), { box: 1, insight: 'x' });
  assert.equal(I.itemOf(u.id, 'none'), null);
});

test('prune — מוחק תובנות בנות יותר משבוע', () => {
  const u = user();
  const old = new Date(Date.now() - 8 * 864e5).toISOString();
  D.run('INSERT INTO mail_insights (user_id, gmail_id, data, received_at, created_at) VALUES (?,?,?,?,?)', u.id, 'old', '{}', old, old);
  D.run('INSERT INTO mail_insights (user_id, gmail_id, data, received_at, created_at) VALUES (?,?,?,?,?)', u.id, 'new', '{}', D.nowIso(), D.nowIso());
  I.prune();
  assert.equal(I.itemOf(u.id, 'old'), null);
  assert.deepEqual(I.itemOf(u.id, 'new'), {});
});

test('completeReply — הצעה שלמה חוזרת בלי לקרוא את המייל', async () => {
  const r = { gmailId: 'g', threadId: 't', inReplyTo: '<m@x>', to: 'a@x', body: 'שלום' };
  assert.deepEqual(await I.completeReply(1, r), { ...r, box: 0 });
});

test('alreadyLearned — תשובה שלא נלמדה', () => {
  assert.equal(I.alreadyLearned('sent-1'), false);
});

test('available — בלי AI: לא זמין', () => {
  assert.equal(I.available(1), false);
});
