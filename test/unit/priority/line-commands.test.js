'use strict';
/**
 * ✏️ פקודות שורה מדויקות (‎server/priority/line-commands.js‎) — מה שהעריכה הישירה בטבלה שולחת למנוע.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../../server/priority/line-commands');

test('כמות, תיאור והסרה — בכמה ניסוחים', () => {
  assert.deepEqual(L.parse('שורה 2 כמות 100'), { updates: [{ line: 2, qty: 100 }], renames: [], removes: [] });
  assert.deepEqual(L.parse('שורה 2: כמות 2.5').updates, [{ line: 2, qty: 2.5 }]);
  assert.deepEqual(L.parse('שורה 3 תיאור: כבל HDMI 2 מטר').renames, [{ line: 3, description: 'כבל HDMI 2 מטר' }]);
  assert.deepEqual(L.parse('שורה 4 הסרה').removes, [4]);
  assert.deepEqual(L.parse('מחק שורה 5').removes, [5]);
  assert.deepEqual(L.parse('שורה 1 כמות 3; שורה 2 כמות 0\nשורה 3 הסרה'), { updates: [{ line: 1, qty: 3 }, { line: 2, qty: 0 }], renames: [], removes: [3] });
});

test('לא פקודה מדויקת — null, והמנוע ממשיך בשפה חופשית', () => {
  for (const t of ['', 'מלט קיבלתי רק 100', 'שורה 2 קיבלתי רק חצי', 'שורה 2 כמות', 'שורה 2 כמות 100 ועוד משהו', 'שורה 3 תיאור:', 'שורה 1 כמות 3; תודה']) {
    assert.equal(L.parse(t), null, t);
  }
});

test('לקבלת סחורה: כמות קודם; הסרה = כמות 0; לדרישת רכש: עדכון חלקי והסרה', () => {
  assert.equal(L.asReceiptReply(L.parse('שורה 1 כמות 3')).action, 'update');
  assert.equal(L.asReceiptReply(L.parse('שורה 1 תיאור: x')).action, 'rename');
  assert.deepEqual(L.asReceiptReply(L.parse('שורה 2 הסרה')).updates, [{ line: 2, qty: 0 }]);
  const r = L.asReceiptReply(L.parse('שורה 1 כמות 3'));
  for (const k of ['updates', 'renames', 'adds', 'note', 'choice', 'question']) assert.ok(k in r, k);
  const d = L.asDemandEdit(L.parse('שורה 1 כמות 4; שורה 2 תיאור: מלט לבן; שורה 3 הסרה'));
  assert.deepEqual(d.updates, [{ line: 1, qty: 4, description: '' }, { line: 2, qty: 0, description: 'מלט לבן' }]);
  assert.deepEqual(d.removes, [3]);
  assert.equal(d.action, 'edit');
});
