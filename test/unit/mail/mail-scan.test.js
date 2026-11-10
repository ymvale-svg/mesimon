'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../../helpers/db');
const Scan = require('../../../server/mail/mail-scan');

boot();
const { sanitize } = Scan._internal;
const me = { id: 1, full_name: 'אני' };
const users = [me, { id: 2, full_name: 'דנה' }, { id: 3, full_name: 'יוסי' }];

test('rangeOf — היום: מחצות בשעון ישראל', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T10:00:00Z') });
  const r = Scan.rangeOf({});
  assert.equal(r.from.toISOString(), '2026-11-09T21:00:00.000Z');
  assert.equal(r.to, null);
});

test('rangeOf — אתמול ושבוע: מתחילת היום ההוא', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T10:00:00Z') });
  assert.equal(Scan.rangeOf({ range: 'yesterday' }).from.toISOString(), '2026-11-08T21:00:00.000Z');
  assert.equal(Scan.rangeOf({ range: 'week' }).from.toISOString(), '2026-11-02T21:00:00.000Z');
});

test('rangeOf — טווח מותאם: עד סוף היום של "עד"', () => {
  const r = Scan.rangeOf({ range: 'custom', from: '2026-11-01', to: '2026-11-05' });
  assert.equal(r.from.toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-11-05T21:00:00.000Z');
  assert.equal(Scan.rangeOf({ range: 'custom', from: '2026-11-01', to: 'x' }).to, null);
  assert.throws(() => Scan.rangeOf({ range: 'custom', from: '1.11.2026' }), /נדרש תאריך התחלה/);
});

test('sanitize — ברירות מחדל לתשובה ריקה', () => {
  const s = sanitize({}, me, users);
  assert.deepEqual(s, { forMe: true, replyExpected: false, addressedTo: '', skipReason: '', warning: '', tasks: [], goods: null, form: null });
});

test('sanitize — אחראי ראשי אחד; עובד לא מוכר ואני עצמי יוצאים', () => {
  const s = sanitize({ tasks: [{
    title: '  להחליף מזגן ', priority: 'super', due_date: 'מחר',
    people: [
      { user_id: 2, role: 'assignee' }, { user_id: 3, role: 'assignee' }, { user_id: 2, role: 'assignee' },
      { user_id: 99, role: 'assignee' }, { user_id: 1, role: 'assignee' }
    ]
  }] }, me, users);
  const t = s.tasks[0];
  assert.equal(t.title, 'להחליף מזגן');
  assert.equal(t.priority, 'normal');
  assert.equal(t.dueDate, '');
  assert.deepEqual(t.people.map((p) => [p.userId, p.role, p.name]), [[2, 'assignee', 'דנה'], [3, 'co_assignee', 'יוסי']]);
});

test('sanitize — סעיף צ׳קליסט מחוץ לטווח נזרק', () => {
  const s = sanitize({ tasks: [{ title: 'x', checklist: ['א', ' ', 'ב'], people: [
    { user_id: 2, role: 'checklist', checklist_index: 2 }, { user_id: 3, role: 'checklist', checklist_index: 5 }
  ] }] }, me, users);
  assert.deepEqual(s.tasks[0].checklist, ['א', 'ב']);
  assert.deepEqual(s.tasks[0].people.map((p) => [p.userId, p.checklistIndex]), [[2, 2]]);
});

test('sanitize — עד 5 משימות, וכותרת ריקה מקבלת שם', () => {
  const s = sanitize({ tasks: Array.from({ length: 8 }, () => ({ title: '' })) }, me, users);
  assert.equal(s.tasks.length, 5);
  assert.equal(s.tasks[0].title, 'משימה מהמייל');
});

test('sanitize — אזהרה מבטלת פנייה החוצה, תשובה צפויה, סחורה וטופס', () => {
  const ai = { needed: true, contact_name: 'אורן', contact_email: ' OREN@X.TEST ', instruction: 'לבקש הסכם' };
  const clean = sanitize({ reply_expected: true, goods_document: { a: 1 }, tasks: [{ title: 'x', ai_request: ai }] }, me, users);
  assert.equal(clean.replyExpected, true);
  assert.deepEqual(clean.goods, { a: 1 });
  assert.equal(clean.tasks[0].aiRequest.contactEmail, 'oren@x.test');
  const warned = sanitize({ warning: 'פישינג', reply_expected: true, goods_document: { a: 1 }, blank_form: {}, tasks: [{ title: 'x', ai_request: ai }] }, me, users);
  assert.equal(warned.replyExpected, false);
  assert.equal(warned.goods, null);
  assert.equal(warned.form, null);
  assert.equal(warned.tasks[0].aiRequest, null);
});

test('sanitize — for_me=false נשמר; הכתובת באותיות קטנות', () => {
  const s = sanitize({ for_me: false, addressed_to_email: ' Boss@X.test ', skip_reason: 'לא אליי' }, me, users);
  assert.equal(s.forMe, false);
  assert.equal(s.addressedTo, 'boss@x.test');
  assert.equal(s.skipReason, 'לא אליי');
});

test('sourceLink — רק למי שהמשימה נוצרה מהמייל שלו', () => {
  assert.equal(Scan.sourceLink({ id: 1, source: 'manual', source_user_id: 5 }, 5), null);
  assert.equal(Scan.sourceLink({ id: 1, source: 'email', source_user_id: 5 }, 6), null);
});
