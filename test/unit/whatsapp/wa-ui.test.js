'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../../../server/whatsapp/wa-ui');

test('BTN — הכיתובים לפי המוסכמה', () => {
  assert.equal(UI.BTN.yes, 'כן ✅');
  assert.equal(UI.BTN.no, 'לא ❌');
  assert.equal(UI.BTN.cancel, 'ביטול 🗑️');
  assert.equal(UI.BTN.confirmCancel, 'כן, לבטל 🗑️');
  assert.equal(UI.BTN.done, 'סיום 🏁');
  assert.ok(Object.isFrozen(UI.BTN));
});

test('YES — כן, מאשר, 👍 והכפתור עצמו', () => {
  for (const t of ['כן', 'כן ✅', 'מאשר', 'מאשר ✅', '👍', 'אוקי', 'ok', 'כן, תודה', 'סבבה!']) {
    assert.ok(UI.YES.test(UI.normalize(t)), t);
  }
  for (const t of ['לא', 'כנראה', 'מאשרים אולי', '']) assert.ok(!UI.YES.test(UI.normalize(t)), t);
});

test('NO — לא, 👎, ❌', () => {
  for (const t of ['לא', 'לא ❌', '👎', '❌', 'no', 'ממש לא']) assert.ok(UI.NO.test(UI.normalize(t)), t);
  for (const t of ['לאן', 'כן']) assert.ok(!UI.NO.test(UI.normalize(t)), t);
});

test('CANCEL — ביטול והכפתור', () => {
  for (const t of ['ביטול', 'ביטול 🗑️', 'בטל', 'עזוב', '🗑️']) assert.ok(UI.CANCEL.test(UI.normalize(t)), t);
  assert.ok(!UI.CANCEL.test(UI.normalize('בטלה')));
});

test('normalize — גוון עור ואימוג׳י כפולים', () => {
  assert.equal(UI.normalize('👍🏽'), '👍');
  assert.equal(UI.normalize('👍👍👍'), '👍');
  assert.equal(UI.normalize('  כן  '), 'כן');
  assert.equal(UI.normalize(null), '');
});

test('label — עד 20 תווים', () => {
  assert.equal(UI.label('קצר'), 'קצר');
  const long = UI.label('שם ארוך מאוד של פרויקט בניה בחיפה');
  assert.ok(long.length <= 20);
  assert.ok(long.endsWith('…'));
  assert.equal(UI.label('  רווחים   כפולים '), 'רווחים כפולים');
});

test('labels — כיתובים שונים זה מזה כשהקיצור מתנגש', () => {
  const names = ['מבואות חיפה sea&cloud מגרש 207', 'מבואות חיפה sea&cloud מגרש 208'];
  const out = UI.labels(names);
  assert.equal(new Set(out).size, 2);
  out.forEach((l) => assert.ok(l.length <= 20, l));
  assert.deepEqual(UI.labels(['א', 'ב']), ['א', 'ב']);
});

test('sameLabel — לחיצה על כפתור מקוצר מזוהה כשם המלא', () => {
  const full = 'שם ארוך מאוד של פרויקט בניה בחיפה';
  assert.ok(UI.sameLabel(full, UI.label(full)));
  assert.ok(UI.sameLabel('כן ✅', 'כן ✅'));
  assert.ok(!UI.sameLabel('פרויקט א', 'פרויקט ב'));
});

test('yesNo / yesCancel', () => {
  assert.deepEqual(UI.yesNo(), ['כן ✅', 'לא ❌']);
  assert.deepEqual(UI.yesCancel(), ['כן ✅', 'ביטול 🗑️']);
});
