'use strict';
/**
 * 🔐 מטריצת ההרשאות (‎server/priority/priority-access.js‎): כן/לא לכל מסמך, חברות לכל משתמש,
 * מנהלי מערכת תמיד הכל, ומעבר בלי הפתעות מ-‎wa_actions‎ — וגם שהבוט מכבד אותה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Access = require('../../../server/priority/priority-access');
const WaActions = require('../../../server/whatsapp/wa-actions');

boot();
const actor = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
test.afterEach(() => { D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_access%'); D.run("DELETE FROM settings WHERE key = 'wa_actions'"); });

test('מנהל מערכת — כל המסמכים וכל החברות, ולא נשמר במטריצה', () => {
  const a = user({ role: 'admin' });
  assert.equal(Access.can(actor(a), 'invoice', 'elad1'), true);
  assert.deepEqual(Access.of(a).docs, Access.DOC_KEYS);
  assert.deepEqual(Access.save([{ id: a.id, docs: [] }]), []);
  assert.equal(Access.can(actor(a), 'receipt'), true);
});

test('בלי שורה במטריצה — מה שהיה מותר בבוט: קהל "כולם" או "מנהלים"', () => {
  const emp = user({ role: 'employee' });
  const mgr = user({ role: 'manager' });
  D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'managers' }, purchase_demand: { enabled: true, audience: 'all' } });
  assert.deepEqual(Access.of(emp).docs, ['demand']);
  assert.deepEqual(Access.of(mgr).docs.sort(), ['demand', 'receipt']);
  assert.equal(Access.of(emp).companies, null);
});

test('כן/לא לכל מסמך, וחברות לכל משתמש', () => {
  const u = user({ role: 'employee' });
  const changes = Access.save([{ id: u.id, docs: ['receipt', 'nope'], companies: ['a160226', 'elad1', 'elad1'] }]);
  assert.ok(changes.length >= 2);
  assert.deepEqual(Access.of(u), { docs: ['receipt'], companies: ['a160226', 'elad1'] });
  assert.equal(Access.can(actor(u), 'receipt'), true);
  assert.equal(Access.can(actor(u), 'receipt', 'elad1'), true);
  assert.equal(Access.can(actor(u), 'receipt', 'mordot'), false, 'חברה שאינה משויכת');
  assert.equal(Access.can(actor(u), 'demand'), false, 'מסמך שלא סומן');
  assert.deepEqual(Access.filterForUser(u.id, ['mordot', 'elad1', 'a160226']), ['elad1', 'a160226']);
  Access.save([{ id: u.id, docs: ['receipt'], companies: null }]);
  assert.deepEqual(Access.filterForUser(u.id, ['mordot', 'elad1']), ['mordot', 'elad1'], 'כל החברות');
});

test('ספק ושחקן שאינו משתמש — אין הרשאה', () => {
  assert.equal(Access.can({ type: 'vendor', id: 1 }, 'receipt'), false);
  assert.equal(Access.can(null, 'receipt'), false);
  assert.deepEqual(Access.filterCompanies({ type: 'vendor' }, ['elad1']), []);
});

test('משתמש לא קיים — נדחה בשמירה', () => {
  assert.throws(() => Access.save([{ id: 999999, docs: [] }]), /לא נמצא/);
});

test('הבוט: קבלת סחורה ודרישת רכש לפי המטריצה (ההדלקה — עדיין ב-wa_actions)', () => {
  const u = user({ role: 'employee' });
  D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'all' } });
  Access.save([{ id: u.id, docs: ['demand'], companies: null }]);
  assert.equal(WaActions.allowed(actor(u), 'purchase_demand'), true);
  assert.equal(WaActions.allowed(actor(u), 'goods_receipt'), false);
  D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: false, audience: 'all' } });
  assert.equal(WaActions.allowed(actor(u), 'purchase_demand'), false, 'כבוי — כבוי לכולם');
});

test('המטריצה למסך — בלי ספקים, עם סוגי המסמכים', () => {
  const m = Access.matrix();
  assert.deepEqual(m.docs.map((d) => d.key), ['demand', 'order', 'receipt', 'partial', 'invoice', 'income']);
  assert.equal(m.users.some((u) => u.role === 'vendor'), false);
});
