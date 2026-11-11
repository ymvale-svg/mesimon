'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const W = require('../../../server/core/workdays');

boot();

// 2026-11-08 = ראשון … 2026-11-13 = שישי, 2026-11-14 = שבת
const SUN = '2026-11-08';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const SAT = '2026-11-14';

let deptSeq = 0;
function department(workDays, parentId = null) {
  deptSeq += 1;
  const info = D.run('INSERT INTO departments (name, created_at, work_days, parent_id) VALUES (?,?,?,?)',
    `מחלקה ${deptSeq}`, new Date().toISOString(), workDays, parentId);
  return Number(info.lastInsertRowid);
}
const worker = (extra = {}) => user({ full_name: 'עובד', role: 'employee', ...extra });

test('ilParts — שעון ישראל בחורף (UTC+2)', () => {
  const p = W.ilParts(new Date('2026-01-15T10:30:00Z'));
  assert.deepEqual(p, { date: '2026-01-15', hour: 12, minute: 30, minutes: 750 });
});

test('ilParts — שעון קיץ (UTC+3)', () => {
  const p = W.ilParts(new Date('2026-07-01T10:30:00Z'));
  assert.equal(p.hour, 13);
  assert.equal(p.minutes, 13 * 60 + 30);
});

test('ilParts — חצות UTC כבר יום אחר בישראל', () => {
  assert.equal(W.ilParts(new Date('2026-07-01T22:00:00Z')).date, '2026-07-02');
  assert.equal(W.ilParts(new Date('2026-07-01T20:59:00Z')).date, '2026-07-01');
});

test('ilParts — חצות מוצגת כ-0 ולא 24', () => {
  const p = W.ilParts(new Date('2026-01-14T22:00:00Z'));
  assert.equal(p.date, '2026-01-15');
  assert.equal(p.hour, 0);
  assert.equal(p.minutes, 0);
});

test('todayIL — תואם ל-ilParts של עכשיו', () => {
  assert.equal(W.todayIL(), W.ilParts(new Date()).date);
  assert.match(W.todayIL(), /^\d{4}-\d{2}-\d{2}$/);
});

test('ilDateOf — ריק מחזיר null, ISO מחזיר תאריך ישראלי', () => {
  assert.equal(W.ilDateOf(null), null);
  assert.equal(W.ilDateOf(''), null);
  assert.equal(W.ilDateOf('2026-03-10T23:30:00Z'), '2026-03-11');
});

test('weekdayOf — ימי השבוע', () => {
  assert.equal(W.weekdayOf(SUN), 0);
  assert.equal(W.weekdayOf(THU), 4);
  assert.equal(W.weekdayOf(FRI), 5);
  assert.equal(W.weekdayOf(SAT), 6);
});

test('addDays — מעבר חודש, שנה ושנה מעוברת', () => {
  assert.equal(W.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(W.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(W.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(W.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(W.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(W.addDays(SUN, 0), SUN);
});

test('addDays — לא מושפע ממעבר שעון קיץ', () => {
  assert.equal(W.addDays('2026-03-26', 1), '2026-03-27');
  assert.equal(W.addDays('2026-03-27', 1), '2026-03-28');
  assert.equal(W.addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(W.addDays('2026-10-25', 1), '2026-10-26');
});

test('ilWallToUtc — חורף וקיץ', () => {
  assert.equal(W.ilWallToUtc('2026-01-15', 9, 0).toISOString(), '2026-01-15T07:00:00.000Z');
  assert.equal(W.ilWallToUtc('2026-07-01', 9, 15).toISOString(), '2026-07-01T06:15:00.000Z');
});

test('ilWallToUtc — ברירת מחדל 17:00', () => {
  assert.equal(W.ilWallToUtc('2026-01-15').toISOString(), '2026-01-15T15:00:00.000Z');
});

test('ilWallToUtc — שעה מוקדמת עוברת ליום הקודם ב-UTC', () => {
  assert.equal(W.ilWallToUtc('2026-07-01', 1, 0).toISOString(), '2026-06-30T22:00:00.000Z');
});

test('dueIso — 17:00 בישראל סביב מעברי השעון', () => {
  // מעבר לשעון קיץ: שישי 27.03.2026; חזרה לחורף: ראשון 25.10.2026
  assert.equal(W.dueIso('2026-03-26'), '2026-03-26T15:00:00.000Z');
  assert.equal(W.dueIso('2026-03-27'), '2026-03-27T14:00:00.000Z');
  assert.equal(W.dueIso('2026-10-24'), '2026-10-24T14:00:00.000Z');
  assert.equal(W.dueIso('2026-10-25'), '2026-10-25T15:00:00.000Z');
});

test('dueIso — חוזר לאותו תאריך ושעה בשעון ישראל', () => {
  for (const d of ['2026-01-01', '2026-03-27', '2026-06-15', '2026-10-25', '2026-12-31']) {
    const p = W.ilParts(new Date(W.dueIso(d)));
    assert.equal(p.date, d);
    assert.equal(p.hour, 17);
    assert.equal(p.minute, 0);
  }
});

test('isDate — תקין ולא תקין', () => {
  assert.ok(W.isDate('2026-11-10'));
  for (const v of ['2026-1-10', '10/11/2026', '', null, undefined, '2026-13-01', 'abcd-ef-gh', '2026-11-10T00:00']) {
    assert.ok(!W.isDate(v), String(v));
  }
});

test('parseDays — ערך שמור', () => {
  assert.deepEqual(W.parseDays('0,1,2,3,4,5'), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(W.parseDays(' 3 , 1,1 '), [1, 3]);
});

test('parseDays — שבת מוסרת תמיד', () => {
  assert.deepEqual(W.parseDays('5,6'), [5]);
  assert.deepEqual(W.parseDays('6'), W.DEFAULT_DAYS);
});

test('parseDays — ריק או לא תקין = ברירת מחדל', () => {
  for (const v of ['', null, undefined, 'abc', '7,8', '-1']) assert.deepEqual(W.parseDays(v), [0, 1, 2, 3, 4], String(v));
  const a = W.parseDays('');
  a.push(9);
  assert.deepEqual(W.DEFAULT_DAYS, [0, 1, 2, 3, 4], 'ברירת המחדל לא משתנה דרך העתק');
});

test('serializeDays — מסנן, ממיין, בלי שבת', () => {
  assert.equal(W.serializeDays([4, 0, 2, 2]), '0,2,4');
  assert.equal(W.serializeDays(['1', '5', 6, 7, -1, 1.5]), '1,5');
  assert.equal(W.serializeDays([6]), '');
  assert.equal(W.serializeDays([]), '');
  assert.equal(W.serializeDays(null), '');
});

test('serializeDays ו-parseDays — הלוך ושוב', () => {
  const days = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(W.parseDays(W.serializeDays(days)), days);
});

test('workDaysOf — בלי מחלקה: א׳–ה׳', () => {
  const u = worker();
  assert.deepEqual(W.workDaysOf(u.id), [0, 1, 2, 3, 4]);
});

test('workDaysOf — לפי המחלקה', () => {
  const dep = department('0,1,2,3,4,5');
  const u = worker({ department_id: dep });
  assert.deepEqual(W.workDaysOf(u.id), [0, 1, 2, 3, 4, 5]);
});

test('workDaysOf — עובד שטח מוסיף שישי', () => {
  const dep = department('1,2,3');
  const u = worker({ department_id: dep, field_worker: 1 });
  assert.deepEqual(W.workDaysOf(u.id), [1, 2, 3, 5]);
});

test('workDaysOf — מחלקה עם ערך ריק = ברירת מחדל', () => {
  const u = worker({ department_id: department('') });
  assert.deepEqual(W.workDaysOf(u.id), [0, 1, 2, 3, 4]);
});

test('workDaysOf — משתמש שלא קיים: ברירת מחדל', () => {
  assert.deepEqual(W.workDaysOf(999999), [0, 1, 2, 3, 4]);
});

test('isWorkDay — שישי ושבת', () => {
  const u = worker();
  assert.ok(W.isWorkDay(u.id, SUN));
  assert.ok(!W.isWorkDay(u.id, FRI));
  assert.ok(!W.isWorkDay(u.id, SAT));
  const field = worker({ field_worker: 1 });
  assert.ok(W.isWorkDay(field.id, FRI));
  assert.ok(!W.isWorkDay(field.id, SAT));
});

test('nextWorkDay — מחמישי לראשון', () => {
  const u = worker();
  assert.equal(W.nextWorkDay(u.id, THU), '2026-11-15');
  assert.equal(W.nextWorkDay(u.id, FRI), '2026-11-15');
  assert.equal(W.nextWorkDay(u.id, SAT), '2026-11-15');
  assert.equal(W.nextWorkDay(u.id, SUN), '2026-11-09');
});

test('nextWorkDay — עובד שטח: מחמישי לשישי, משישי לראשון', () => {
  const u = worker({ field_worker: 1 });
  assert.equal(W.nextWorkDay(u.id, THU), FRI);
  assert.equal(W.nextWorkDay(u.id, FRI), '2026-11-15');
});

test('nextWorkDay — מחלקה של יום אחד בשבוע', () => {
  const u = worker({ department_id: department('2') });
  assert.equal(W.nextWorkDay(u.id, SUN), '2026-11-10');
  assert.equal(W.nextWorkDay(u.id, '2026-11-10'), '2026-11-17');
});

test('nextWorkDay — ברירת המחדל היא מהיום', () => {
  const u = worker({ field_worker: 1 });
  const next = W.nextWorkDay(u.id);
  assert.ok(next > W.todayIL());
  assert.notEqual(W.weekdayOf(next), 6);
});

test('addWorkDays — מדלג על סוף שבוע', () => {
  const u = worker();
  assert.equal(W.addWorkDays(u.id, THU, 1), '2026-11-15');
  assert.equal(W.addWorkDays(u.id, THU, 2), '2026-11-16');
  assert.equal(W.addWorkDays(u.id, SUN, 5), '2026-11-15');
});

test('addWorkDays — 0 או שלילי נחשב כיום אחד', () => {
  const u = worker();
  assert.equal(W.addWorkDays(u.id, SUN, 0), '2026-11-09');
  assert.equal(W.addWorkDays(u.id, SUN, -3), '2026-11-09');
});

test('daysLabel — רצף כטווח, אחרת רשימה', () => {
  assert.equal(W.daysLabel([0, 1, 2, 3, 4]), 'א׳–ה׳');
  assert.equal(W.daysLabel([4, 2, 3]), 'ג׳–ה׳');
  assert.equal(W.daysLabel([0, 1]), 'א׳, ב׳');
  assert.equal(W.daysLabel([0, 2, 4]), 'א׳, ג׳, ה׳');
  assert.equal(W.daysLabel([5]), 'ו׳');
  assert.equal(W.daysLabel([]), '');
});

test('hebrewDate — שם היום ותאריך בלי אפסים', () => {
  assert.equal(W.hebrewDate('2026-10-29'), 'יום חמישי, 29.10');
  assert.equal(W.hebrewDate('2026-11-07'), 'יום שבת, 7.11');
  assert.equal(W.hebrewDate(SUN), 'יום ראשון, 8.11');
});

test('קבועים', () => {
  assert.equal(W.TZ, 'Asia/Jerusalem');
  assert.equal(W.SATURDAY, 6);
  assert.equal(W.FRIDAY, 5);
  assert.equal(W.DAY_LABELS.length, 7);
  assert.equal(W.DAY_NAMES[6], 'שבת');
});
