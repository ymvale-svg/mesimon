'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const RFQ = require('../../../server/priority/rfq');

boot();
const { itemLine, reviewText } = RFQ._internal;

test('isRequest — בקשה לפנות לספקים', () => {
  for (const t of ['תפנה לספקים להצעת מחיר על 30 שקי מלט', 'צריך הצעות מחיר לפיגומים', 'תשלח פנייה לספקים על חול']) assert.ok(RFQ.isRequest(t), t);
});

test('isRequest — בלי פעולה או בלי הצעת מחיר: לא', () => {
  for (const t of ['הצעת מחיר', 'תשלח לי את הקובץ', 'מלט 30 שקים']) assert.ok(!RFQ.isRequest(t), t);
});

test('isRequest — שאלה אינה בקשה', () => {
  assert.ok(!RFQ.isRequest('מה עם הצעת המחיר שביקשתי לשלוח?'));
  assert.ok(!RFQ.isRequest('האם צריך הצעת מחיר?'));
});

test('itemLine — פריט, מפרט, כמות ומקום', () => {
  assert.equal(itemLine({ item: 'מלט', spec: 'CEM II', quantity: '30 שק', location: 'לחיפה' }), 'מלט · CEM II · 30 שק · אספקה לחיפה');
  assert.equal(itemLine({ item: 'חול', spec: '', quantity: '', location: '' }), 'חול');
  assert.equal(itemLine({ item: 'חצץ', location: 'נהריה' }), 'חצץ · אספקה לנהריה');
});

test('SUMMARY_ASK — בקשת הסיכום', () => {
  for (const t of ['טבלת הצעות', 'סיכום הצעות מחיר', 'מה עם ההצעות?', 'טבלת ההצעות']) assert.ok(RFQ.SUMMARY_ASK.test(t), t);
  for (const t of ['תשלח הצעות', 'סיכום הפגישה']) assert.ok(!RFQ.SUMMARY_ASK.test(t), t);
});

test('BTN — כיתובים ייחודיים, קפוא', () => {
  const v = Object.values(RFQ.BTN);
  assert.equal(new Set(v).size, v.length);
  assert.ok(Object.isFrozen(RFQ.BTN));
  assert.equal(RFQ.BTN.cancel, 'ביטול 🗑️');
  assert.equal(RFQ.BTN.done, 'סיום 🏁');
});

test('reviewText — ספקים, בלי מייל, נוסח ומועד', () => {
  const r = { item: { item: 'מלט' }, draft: { subject: 'בקשה להצעת מחיר', body: 'שלום,\n\nנבקש   הצעה' }, deadline_at: '2026-11-11T14:00:00Z' };
  const t = reviewText(r, [
    { name: 'א בע"מ', email: 'a@x.co', source: 'פריוריטי', reason: 'ספק קבוע' },
    { name: 'ב', email: '', phone: '050-1', source: 'רשת' }
  ]);
  assert.match(t, /\*הצעת מחיר: מלט\*/);
  assert.match(t, /\*הספקים \(2, 1 עם מייל\):\*/);
  assert.match(t, /1\. \*א בע"מ\* — a@x\.co · פריוריטי · _ספק קבוע_/);
  assert.match(t, /2\. \*ב\* — אין מייל, טל׳ 050-1 \(לפנות בטלפון\) · רשת/);
  assert.match(t, /_שלום, נבקש הצעה_/);
  assert.match(t, /⏰ סיכום וטבלת השוואה: .*16:00/);
});

test('reviewText — כולם עם מייל: בלי ספירה', () => {
  const t = reviewText({ item: { item: 'x' }, draft: { subject: 's', body: 'b' }, deadline_at: '2026-11-11T14:00:00Z' }, [{ name: 'א', email: 'a@x.co', source: 'רשת' }]);
  assert.match(t, /\*הספקים \(1\):\*/);
});

test('ownsReply — בלי מזהים או מזהה לא מוכר: לא', () => {
  assert.equal(RFQ.ownsReply({}), false);
  assert.equal(RFQ.ownsReply({ inReplyTo: ['<nope@x>'] }), false);
});

function seed() {
  const u = user({ full_name: 'קניין', email: `buyer-${Date.now()}-${Math.random()}@test.local` });
  const now = new Date().toISOString();
  const id = Number(D.run("INSERT INTO rfq (user_id, status, item, draft, deadline_at, sent_at, created_at) VALUES (?, 'sent', ?, '{}', ?, ?, ?)",
    u.id, JSON.stringify({ item: 'מלט/אפור' }), now, now, now).lastInsertRowid);
  const v = (name, status, offer = null, mid = null) => D.run('INSERT INTO rfq_vendors (rfq_id, name, email, status, offer, message_id) VALUES (?,?,?,?,?,?)',
    id, name, `${name}@v.test`, status, offer ? JSON.stringify(offer) : null, mid);
  return { u, id, v };
}

test('summaryOf — הזולה, השנייה, מי לא ענה, וקובץ', () => {
  const { id, v } = seed();
  v('יקר', 'replied', { total_number: 2000, total_price: '2,000 ₪', vat: 'לא כולל', delivery: '3 ימים' });
  v('זול', 'replied', { total_number: 1500, total_price: '1,500 ₪', vat: 'לא צוין' });
  v('שותק', 'sent');
  v('מסרב', 'declined', { declined: true });
  v('בלי מייל', 'no_email');
  const s = RFQ.summaryOf(id);
  assert.match(s.text, /\*סיכום הצעות מחיר: מלט\/אפור\*/);
  assert.match(s.text, /2 הצעות מתוך 4 פניות · ספק אחד לא ענה\./);
  assert.match(s.text, /💰 הזולה: \*זול\* — 1,500 ₪\n/);
  assert.match(s.text, /🥈 אחריה: יקר — 2,000 ₪/);
  assert.match(s.text, /🚚 אספקה: יקר — 3 ימים/);
  assert.match(s.text, /⏳ לא ענו: שותק/);
  assert.deepEqual(s.buttons, [RFQ.BTN.remind, RFQ.BTN.demand, RFQ.BTN.done]);
  assert.equal(s.files[0].fileName, 'הצעות מחיר — מלטאפור.xlsx');
  assert.ok(Buffer.isBuffer(s.files[0].buf));
  assert.deepEqual(s.draft, { kind: 'rfq_done', rfqId: id });
});

test('summaryOf — אין הצעות: רק סיום ותזכורת', () => {
  const { id, v } = seed();
  v('א', 'sent');
  const s = RFQ.summaryOf(id);
  assert.match(s.text, /0 הצעות מתוך 1 פניות/);
  assert.doesNotMatch(s.text, /הזולה/);
  assert.deepEqual(s.buttons, [RFQ.BTN.remind, RFQ.BTN.done]);
});

test('ownsReply — תשובה למייל שנשלח לספק', () => {
  const { v } = seed();
  v('א', 'sent', null, '<abc@mail.test>');
  assert.equal(RFQ.ownsReply({ references: ['<x@y>', '<abc@mail.test>'] }), true);
});

test('lastSummary — הפנייה האחרונה של המשתמש', () => {
  const { u, id, v } = seed();
  v('א', 'replied', { total_number: 10, total_price: '10', vat: 'כולל' });
  assert.equal(RFQ.lastSummary(u.id).draft.rfqId, id);
  assert.equal(RFQ.lastSummary(999999), null);
});
