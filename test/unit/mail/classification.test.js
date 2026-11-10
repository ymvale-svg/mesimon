'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const C = require('../../../server/core/classification');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });
const dept = (name, parentId = null) => {
  const id = Number(D.run('INSERT INTO departments (name, created_at, parent_id) VALUES (?,?,?)', name, D.nowIso(), parentId).lastInsertRowid);
  return id;
};

const TABLE = {
  eng: { label: 'הנדסה', departments: ['הנדסה'], floor: 1, examples: '' },
  fin: { label: 'כספים', departments: ['כספים'], floor: 3, examples: '' },
  all: { label: 'כללי', departments: ['*'], floor: 1, examples: '' }
};
const scope = (o) => ({ known: true, leader: false, manager: false, departments: ['הנדסה'], ...o });

test('effectiveLevel — הרצפה של הנושא גוברת; לא מוכר — סודי', () => {
  assert.equal(C.effectiveLevel('eng', 2, TABLE), 2);
  assert.equal(C.effectiveLevel('fin', 1, TABLE), 3);
  assert.equal(C.effectiveLevel('nope', 1, TABLE), 4);
  assert.equal(C.effectiveLevel('eng', 9, TABLE), 4, 'רמה לא תקינה — סודי');
});

test('mayRead — שואל לא ידוע לא רואה כלום, ההנהלה רואה הכול', () => {
  assert.equal(C.mayRead({ known: false }, 'eng', 1, TABLE), false);
  assert.equal(C.mayRead(null, 'eng', 1, TABLE), false);
  assert.equal(C.mayRead(scope({ leader: true }), 'fin', 4, TABLE), true);
});

test('mayRead — כללי לכולם, סודי לאף אחד מלבד ההנהלה', () => {
  assert.equal(C.mayRead(scope({ departments: ['שיווק'] }), 'eng', 1, TABLE), true);
  assert.equal(C.mayRead(scope({ manager: true }), 'eng', 4, TABLE), false);
});

test('mayRead — מקצועי: רק במחלקות הנושא', () => {
  assert.equal(C.mayRead(scope(), 'eng', 2, TABLE), true);
  assert.equal(C.mayRead(scope({ departments: ['שיווק'] }), 'eng', 2, TABLE), false);
  assert.equal(C.mayRead(scope({ departments: ['שיווק'] }), 'all', 2, TABLE), true, '* — כל המחלקות');
});

test('mayRead — רגיש: רק מנהל במחלקת הנושא', () => {
  assert.equal(C.mayRead(scope({ departments: ['כספים'] }), 'fin', 3, TABLE), false);
  assert.equal(C.mayRead(scope({ departments: ['כספים'], manager: true }), 'fin', 3, TABLE), true);
  assert.equal(C.mayRead(scope({ manager: true }), 'fin', 3, TABLE), false);
});

test('mayRead — בלי רמה או נושא לא מוכר: סגור', () => {
  assert.equal(C.mayRead(scope(), 'eng', 0, TABLE), false);
  assert.equal(C.mayRead(scope(), 'nope', 1, TABLE), false);
});

test('norm — בלי "מחלקת", בלי גרשיים, באותיות קטנות', () => {
  assert.equal(C._internal.norm(' מחלקת הנדסה '), 'הנדסה');
  assert.equal(C._internal.norm('מנכ"ל'), 'מנכל');
  assert.equal(C._internal.norm('IT'), 'it');
});

test('scopeOf — ספק, לא קיים ולא פעיל: לא ידוע', () => {
  assert.deepEqual(C.scopeOf(null), { known: false });
  assert.deepEqual(C.scopeOf({ type: 'vendor', id: 1 }), { known: false });
  assert.deepEqual(C.scopeOf({ type: 'user', id: 999999 }), { known: false });
  const off = user({ role: 'employee', status: 'inactive' });
  assert.deepEqual(C.scopeOf({ type: 'user', id: off.id }), { known: false });
});

test('scopeOf — הנהלה בלי מחלקה מקצועית היא הנהלה; במחלקה מקצועית — מנהל', () => {
  const ceo = user({ role: 'executive' });
  assert.equal(C.scopeOf({ type: 'user', id: ceo.id }).leader, true);
  const cfo = user({ role: 'executive', department_id: dept('כספים-בדיקה') });
  const s = C.scopeOf({ type: 'user', id: cfo.id });
  assert.equal(s.leader, false);
  assert.equal(s.manager, true);
  const sa = user({ role: 'superadmin' });
  assert.equal(C.scopeOf({ type: 'user', id: sa.id }).leader, true);
});

test('scopeOf — מנהל מערכת אינו הנהלה; המחלקות כולל ההורה', () => {
  const root = dept('הנדסה-אב');
  const child = dept('ביצוע-בן', root);
  const admin = user({ role: 'admin', department_id: child });
  const s = C.scopeOf({ type: 'user', id: admin.id });
  assert.equal(s.leader, false);
  assert.deepEqual(s.departments, ['הנדסה-אב', 'ביצוע-בן']);
});

test('scopeOf — עובד שמנהל מחלקה נחשב מנהל', () => {
  const d = dept('בדק-מנהל');
  const u = user({ role: 'employee', department_id: d });
  D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', u.id, d);
  assert.equal(C.scopeOf({ type: 'user', id: u.id }).manager, true);
});

test('parseClass — נושא לא מוכר או בלי רמה: ביטול; אחרת לפי הרצפה', () => {
  assert.deepEqual(C.parseClass('', 2), { topic: '', sens: 0 });
  assert.deepEqual(C.parseClass('nope', 2), { topic: '', sens: 0 });
  assert.deepEqual(C.parseClass('legal', 0), { topic: '', sens: 0 });
  assert.deepEqual(C.parseClass('legal', 1), { topic: 'legal', sens: 2 });
});

test('classView — תווית עם הרמה בפועל', () => {
  assert.equal(C.classView({ topic: 'fin', sens: 1 }, TABLE).label, 'כספים · 🟠 רגיש');
  assert.equal(C.classView({ topic: 'fin', sens: 0 }, TABLE), null);
  assert.equal(C.classView(null, TABLE), null);
});

test('promptTable — כל נושא בשורה', () => {
  const p = C.promptTable(TABLE);
  assert.ok(p.includes('- eng — הנדסה · מינימום 1'));
  assert.ok(p.includes('- fin — כספים · מינימום 3'));
});

test('saveTopics — מזהה לא תקין או נושא בלי שם נדחים', () => {
  assert.throws(() => C.saveTopics({ 'Bad Key': { label: 'x' } }), /מזהה נושא לא תקין/);
  assert.throws(() => C.saveTopics({ newtopic: { label: '' } }), /לכל נושא צריך שם/);
  assert.throws(() => C.saveTopics(null), /טבלה לא תקינה/);
});

test('saveTopics — נושא חדש נוסף, null מוחק נושא מובנה', () => {
  const t = C.saveTopics({ drones: { label: 'רחפנים', departments: 'הנדסה, ביצוע', floor: 2 }, leadership: null });
  assert.deepEqual(t.drones.departments, ['הנדסה', 'ביצוע']);
  assert.equal(t.drones.floor, 2);
  assert.equal(t.leadership, undefined);
  assert.ok(t.engineering, 'שאר הנושאים נשארים');
  C.saveTopics({});
});

test('mayReadTask — בלי סיווג פתוח; סודי סגור למי שאינו משתתף', () => {
  const owner = user({ role: 'employee' });
  const other = user({ role: 'employee' });
  assert.equal(C.mayReadTask({ type: 'user', id: other.id }, { id: 1, topic: '', sens: 0 }), true);
  const secret = { id: 999001, topic: 'hr_personal', sens: 4, assignee_type: 'user', assignee_id: owner.id, created_by: owner.id };
  assert.equal(C.mayReadTask({ type: 'user', id: owner.id }, secret), true);
  assert.equal(C.mayReadTask({ type: 'user', id: other.id }, secret), false);
  assert.equal(C.mayReadTask(null, secret), false);
  assert.equal(C.mayReadTask({ type: 'user', id: other.id }, null), false);
});

test('preview — עובד בלי מחלקה: כללי, ומקצועי רק בנושא של כל המחלקות', () => {
  const rows = C.preview({ role: 'employee' });
  const by = Object.fromEntries(rows.map((r) => [r.key, r.upTo]));
  assert.equal(by.engineering, 1);
  assert.equal(by.office, 2, 'נושא * — כל העובדים בתוכו');
  assert.equal(by.legal, 0);
  assert.equal(by.leadership, 0);
  const exec = Object.fromEntries(C.preview({ role: 'executive' }).map((r) => [r.key, r.upTo]));
  assert.equal(exec.leadership, 4);
});
