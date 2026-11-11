'use strict';
/**
 * ❓ כפתור שזוכר את השאלה: רישום, זיהוי ההודעה שעליה לחצו, והחלטה (פתוחה / להחזיר / סגורה / חופשי).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../../helpers/db');
const Q = require('../../../server/whatsapp/wa-questions');

boot();
let uid = 9100;

test('draftKey — בלי askedAt ובלי תלות בסדר המפתחות, גם בתוך אובייקטים', () => {
  assert.equal(Q.draftKey({ kind: 'mail_task', x: { b: 2, a: 1 }, askedAt: '1' }), Q.draftKey({ x: { a: 1, b: 2 }, kind: 'mail_task', askedAt: '2' }));
  assert.notEqual(Q.draftKey({ kind: 'mail_task', id: 1 }), Q.draftKey({ kind: 'mail_task', id: 2 }));
  assert.equal(Q.draftKey(null), '');
});

test('record / find / markAnswered — עד 15 אחרונות לעובד, ופג אחרי יומיים', () => {
  const u = ++uid;
  const t0 = Date.now();
  for (let i = 0; i < 17; i++) Q.record(u, `m${i}`, { owner: 'chat', draft: { kind: 'x', i }, awaiting: true }, t0 + i);
  assert.equal(Q.find(u, 'm0'), null);
  assert.equal(Q.find(u, 'm16').draft.i, 16);
  Q.markAnswered(u, 'm16');
  assert.equal(Q.find(u, 'm16').answered, true);
  Q.record(u, 'late', { owner: 'chat' }, t0 + 3 * 24 * 3600 * 1000);
  assert.equal(Q.find(u, 'm16'), null, 'ישנות מיומיים — יורדות ברישום הבא');
});

test('decide — פתוחה / להחזיר (יזומה שנדחקה) / סגורה / חופשי', () => {
  const offer = { kind: 'goods_offer', goodsId: 5 };
  const mailTask = { kind: 'mail_task', suggestionIds: [3] };
  const q = (draft, extra = {}) => ({ owner: 'chat', awaiting: true, draft, key: Q.draftKey(draft), answered: false, ...extra });
  assert.equal(Q.decide(q(mailTask), { ...mailTask, askedAt: 'x' }), 'current');
  assert.equal(Q.decide(q(offer), { kind: 'email' }), 'restore');
  assert.equal(Q.decide(q(offer, { answered: true }), { kind: 'email' }), 'closed');
  assert.equal(Q.decide(q(mailTask), { kind: 'email' }), 'closed', '"כן" על משימה מהמייל — לא מאשר טיוטת מייל אחרת');
  assert.equal(Q.decide(q(mailTask), null), 'closed');
  assert.equal(Q.decide({ owner: 'chat', awaiting: false, draft: { kind: 'menu' } }, { kind: 'email' }), 'free', 'תפריט — תמיד עובד');
  assert.equal(Q.decide({ owner: 'goods_receipt', awaiting: true, draft: null }, null), 'free');
});

test('replyToOf — מזהה ההודעה מכל צורת כפתור, וציטוט', () => {
  assert.deepEqual(Q.replyToOf({ typeMessage: 'interactiveButtonsResponse', interactiveButtonsResponse: { stanzaId: 'ABC', selectedButtonText: 'כן ✅' } }), { id: 'ABC', button: true });
  assert.deepEqual(Q.replyToOf({ buttonsResponseMessage: { stanzaId: 'B1', selectedButtonId: '1' } }), { id: 'B1', button: true });
  assert.deepEqual(Q.replyToOf({ templateButtonReplyMessage: { stanzaId: 'T1', selectedId: '1' } }), { id: 'T1', button: true });
  assert.deepEqual(Q.replyToOf({ textMessageData: { textMessage: 'לבטל' }, quotedMessage: { stanzaId: 'Q9', textMessage: 'x' } }), { id: 'Q9', button: false });
  assert.deepEqual(Q.replyToOf({ textMessageData: { textMessage: 'שלום' } }), { id: '', button: false });
});
