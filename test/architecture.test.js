'use strict';
/**
 * בדיקת הארכיטקטורה — "רשימת חריגים שרק מצטמצמת".
 * ‎test/architecture-baseline.json‎ הוא רשימת ההפרות שעוד לא תוקנו.
 *   • הפרה חדשה שלא ברשימה → הבדיקה נכשלת. מתקנים את הקוד, לא מוסיפים לרשימה.
 *   • הפרה שתוקנה ועדיין ברשימה → הבדיקה נכשלת, כדי שתוסר ממנה (והרשימה לא תתנפח שוב).
 * לעדכון אחרי תיקון: ‎node tools/arch.js --json > test/architecture-baseline.json‎
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Arch = require('../tools/arch');
const baseline = require('./architecture-baseline.json');

const current = Arch.violations();

test('אין הפרות ארכיטקטורה חדשות', () => {
  const added = current.filter((v) => !baseline.includes(v));
  assert.deepEqual(added, [], `הפרות חדשות:\n${added.join('\n')}`);
});

test('רשימת החריגים מעודכנת — מה שתוקן הוסר ממנה', () => {
  const fixed = baseline.filter((v) => !current.includes(v));
  assert.deepEqual(fixed, [], `תוקנו — להסיר מ-architecture-baseline.json:\n${fixed.join('\n')}`);
});

test('אין תלויות מעגליות', { todo: baseline.some((v) => v.startsWith('cycle:')) }, () => {
  assert.deepEqual(current.filter((v) => v.startsWith('cycle:')), []);
});
