'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Prefs = require('../../../server/priority/priority-prefs');

boot();
let next = 9000;
const uid = () => { next += 1; return next; };
const P1 = { code: 'P-100', des: 'מבואות חיפה' };
const P2 = { code: 'P-200', des: 'אלעד סנטר' };

test('אין משתמש או חברה — null', () => {
  assert.equal(Prefs.of(null, 'test11'), null);
  assert.equal(Prefs.of(uid(), null), null);
  assert.equal(Prefs.lastCompany(null), null);
  assert.equal(Prefs.warehouseFor(null, 'test11', 'P-100'), null);
});

test('משתמש חדש — אין ברירות מחדל', () => {
  const u = uid();
  assert.equal(Prefs.of(u, 'test11'), null);
  assert.equal(Prefs.lastCompany(u), null);
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-100'), null);
});

test('remember — חברה בלבד: הסביבה נשמרת, בלי פרויקט', () => {
  const u = uid();
  Prefs.remember(u, { company: 'mordot' });
  assert.equal(Prefs.lastCompany(u), 'mordot');
  assert.equal(Prefs.of(u, 'mordot'), null);
});

test('remember — פרויקט ומחסן', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  const p = Prefs.of(u, 'test11');
  assert.deepEqual(p.project, { code: 'P-100', des: 'מבואות חיפה' });
  assert.equal(p.warehouse, 'W1');
  assert.deepEqual(p.byProject, { 'P-100': 'W1' });
  assert.equal(typeof p.at, 'number');
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-100'), 'W1');
});

test('remember — מחסן לכל פרויקט, האחרון הוא ברירת המחדל', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  Prefs.remember(u, { company: 'test11', project: P2, warehouse: 'W2' });
  const p = Prefs.of(u, 'test11');
  assert.equal(p.project.code, 'P-200');
  assert.equal(p.warehouse, 'W2');
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-100'), 'W1');
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-200'), 'W2');
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-999'), null);
});

test('remember — פרויקט בלי מחסן משאיר את המחסן הקודם', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  Prefs.remember(u, { company: 'test11', project: P2 });
  const p = Prefs.of(u, 'test11');
  assert.equal(p.project.code, 'P-200');
  assert.equal(p.warehouse, 'W1');
  assert.equal(Prefs.warehouseFor(u, 'test11', 'P-200'), null);
});

test('remember — פרויקט בלי שם: שם ריק', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: { code: 'X1' } });
  assert.deepEqual(Prefs.of(u, 'test11').project, { code: 'X1', des: '' });
});

test('remember — פרויקט בלי קוד אינו נשמר', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: { des: 'בלי קוד' }, warehouse: 'W1' });
  assert.equal(Prefs.lastCompany(u), 'test11');
  assert.equal(Prefs.of(u, 'test11'), null);
});

test('remember — בלי חברה לא נשמר כלום', () => {
  const u = uid();
  Prefs.remember(u, { company: '', project: P1, warehouse: 'W1' });
  Prefs.remember(null, { company: 'test11' });
  assert.equal(Prefs.lastCompany(u), null);
});

test('לכל חברה בנפרד, והסביבה היא האחרונה', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  Prefs.remember(u, { company: 'mordot', project: P2, warehouse: 'M2' });
  assert.equal(Prefs.lastCompany(u), 'mordot');
  assert.equal(Prefs.of(u, 'test11').project.code, 'P-100');
  assert.equal(Prefs.of(u, 'mordot').project.code, 'P-200');
  assert.equal(Prefs.warehouseFor(u, 'mordot', 'P-100'), null);
});

test('לכל משתמש בנפרד', () => {
  const a = uid();
  const b = uid();
  Prefs.remember(a, { company: 'test11', project: P1, warehouse: 'W1' });
  assert.equal(Prefs.of(b, 'test11'), null);
  assert.equal(Prefs.lastCompany(b), null);
});

test('set — שדה נוסף לחברה, בלי למחוק את הפרויקט', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  Prefs.set(u, 'test11', 'demandCode', { code: '7', des: 'בדק' });
  const p = Prefs.of(u, 'test11');
  assert.deepEqual(p.demandCode, { code: '7', des: 'בדק' });
  assert.equal(p.project.code, 'P-100');
});

test('set — בלי משתמש או חברה לא נשמר', () => {
  const u = uid();
  Prefs.set(u, '', 'x', 1);
  Prefs.set(null, 'test11', 'x', 1);
  assert.equal(Prefs.of(u, 'test11'), null);
});

test('set — לא משנה את הסביבה האחרונה', () => {
  const u = uid();
  Prefs.remember(u, { company: 'mordot' });
  Prefs.set(u, 'test11', 'demandCode', 'x');
  assert.equal(Prefs.lastCompany(u), 'mordot');
});

test('ערך פגום במסד — כאילו אין העדפות', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1, warehouse: 'W1' });
  D.run('UPDATE settings SET value = ? WHERE key = ?', '{not json', `goods_receipt_prefs:${u}`);
  assert.equal(Prefs.of(u, 'test11'), null);
  assert.equal(Prefs.lastCompany(u), null);
  // ושמירה חדשה מתקנת
  Prefs.remember(u, { company: 'test11', project: P2, warehouse: 'W2' });
  assert.equal(Prefs.of(u, 'test11').project.code, 'P-200');
});

test('נשמר במפתח ההיסטורי של קבלת הסחורה', () => {
  const u = uid();
  Prefs.remember(u, { company: 'test11', project: P1 });
  const v = D.getSetting(`goods_receipt_prefs:${u}`, null);
  assert.equal(v._company, 'test11');
  assert.equal(v.test11.project.code, 'P-100');
});
