'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const A = require('../../../server/ai/wa-actions');

boot();
const emp = { type: 'user', id: 1, role: 'employee' };
const mgr = { type: 'user', id: 2, role: 'manager' };
const admin = { type: 'user', id: 3, role: 'admin' };
const vendor = { type: 'vendor', id: 4, role: 'vendor' };

test('list — הקטלוג עם ברירות המחדל', () => {
  D.setSetting('wa_actions', {});
  const l = A.list();
  assert.ok(l.length > 10);
  assert.equal(new Set(l.map((a) => a.key)).size, l.length, 'מפתחות ייחודיים');
  for (const a of l) {
    assert.ok(['private', 'group', 'proactive'].includes(a.channel), a.key);
    assert.equal(a.audience, 'all');
    assert.deepEqual(a.examples, a.defaultExamples);
  }
});

test('byKey — פעולה קיימת, ולא קיימת — null', () => {
  assert.equal(A.byKey('create_task').label, 'פתיחת משימה');
  assert.equal(A.byKey('nope'), null);
});

test('isManager — כל מי שאינו עובד מן השורה, וספק לא', () => {
  assert.equal(A.isManager(emp), false);
  assert.equal(A.isManager(mgr), true);
  assert.equal(A.isManager(vendor), false);
  assert.equal(A.isManager(null), false);
});

test('inPilot — רק מנהלי מערכת', () => {
  assert.equal(A.inPilot(admin), true);
  assert.equal(A.inPilot({ type: 'user', role: 'superadmin' }), true);
  assert.equal(A.inPilot(mgr), false);
  assert.equal(A.inPilot({ type: 'vendor', role: 'admin' }), false);
});

test('save — כיבוי, קהל מנהלים ודוגמאות מנוקות', () => {
  A.save([
    { key: 'create_task', enabled: false },
    { key: 'my_tasks', enabled: true, audience: 'managers', examples: ['  א  ', '', 'ב'.repeat(300), 1, 2, 3, 4, 5, 6] },
    { key: 'nope', enabled: true },
    { key: 'complete', enabled: true, audience: 'everyone' }
  ]);
  assert.equal(A.byKey('create_task').enabled, false);
  const mt = A.byKey('my_tasks');
  assert.equal(mt.audience, 'managers');
  assert.equal(mt.examples.length, 6);
  assert.equal(mt.examples[0], 'א');
  assert.equal(mt.examples[1].length, 200);
  assert.equal(A.byKey('complete').audience, 'all', 'קהל לא מוכר — כולם');
  assert.ok(!('nope' in D.getSetting('wa_actions', {})));
});

test('allowed — פעולה כבויה לאף אחד; קהל מנהלים לא לעובד', () => {
  A.save([{ key: 'create_task', enabled: false }, { key: 'my_tasks', enabled: true, audience: 'managers' }, { key: 'help', enabled: true }]);
  assert.equal(A.allowed(mgr, 'create_task'), false);
  assert.equal(A.allowed(emp, 'my_tasks'), false);
  assert.equal(A.allowed(mgr, 'my_tasks'), true);
  assert.equal(A.allowed(emp, 'help'), true);
  assert.equal(A.allowed(emp, 'nope'), false);
});

test('allowed — פיילוט פתוח רק למנהלי מערכת', () => {
  A.save([{ key: 'reminders', enabled: true }]);
  assert.ok(A.PILOT_KEYS.has('reminders'));
  D.setSetting('bot_pilot', true);
  assert.equal(A.allowed(emp, 'reminders'), false);
  assert.equal(A.allowed(mgr, 'reminders'), false);
  assert.equal(A.allowed(admin, 'reminders'), true);
  D.setSetting('bot_pilot', false);
  assert.equal(A.allowed(emp, 'reminders'), true);
});

test('forActor — רק פעולות בשיחה פרטית שמותרות לו', () => {
  D.setSetting('wa_actions', {});
  const keys = A.forActor(emp).map((a) => a.key);
  assert.ok(keys.includes('create_task'));
  assert.ok(!keys.includes('group_tasks'), 'קבוצה');
  assert.ok(!keys.includes('summary'), 'יזומה');
  assert.ok(A.forActor(emp).every((a) => a.channel === 'private' && a.enabled));
});
