'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const B = require('../../../server/ai/wa-business');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });

test('classify — "לא לסרוק" גוברת על עסקי', () => {
  const lists = { ignore: new Set(['972501111111']), business: new Set(['972501111111', '972502222222']), auto: new Set(['972503333333']) };
  assert.equal(B.classify('050-1111111', lists), 'ignore');
  assert.equal(B.classify('0502222222', lists), 'business');
  assert.equal(B.classify('+972 50 333 3333', lists), 'business');
  assert.equal(B.classify('0504444444', lists), 'unknown');
});

test('classify — מספר לא תקין או רשימות חסרות: לא מוכר', () => {
  assert.equal(B.classify('abc', { ignore: new Set(), business: new Set(), auto: new Set() }), 'unknown');
  assert.equal(B.classify('0501111111', {}), 'unknown');
});

test('display — נייד ישראלי עם מקף, אחר עם אפס, זר כמו שהוא', () => {
  assert.equal(B.display('972501234567'), '050-1234567');
  assert.equal(B.display('97231234567'), '031234567');
  assert.equal(B.display('12125550100'), '12125550100');
  assert.equal(B.display(null), '');
});

test('ASK_AFTER — שואלים אחרי 3 הודעות', () => {
  assert.equal(B.ASK_AFTER, 3);
});

test('resolve — מספר שנכתב מנורמל בלי חיפוש', () => {
  const u = user();
  assert.deepEqual(B.resolve(u.id, '050-123 4567'), [{ phone: '972501234567', name: '' }]);
  assert.deepEqual(B.resolve(u.id, '  '), []);
});

test('resolve — לפי שם: מספרים לא מוכרים, האלפון ועובדים', () => {
  const u = user();
  user({ full_name: 'דני עובד', phone: '972505555555' });
  D.run('INSERT INTO phonebook (name, phone, phone2, created_at, updated_at) VALUES (?,?,?,?,?)', 'דני ספק', '0506666666', '', D.nowIso(), D.nowIso());
  const r = B.resolve(u.id, 'את דני?', { '972507777777': { name: 'דני מהשיחות' } });
  const phones = r.map((x) => x.phone);
  assert.ok(phones.includes('972507777777'));
  assert.ok(phones.includes('972506666666'));
  assert.ok(phones.includes('972505555555'));
  assert.equal(r.find((x) => x.phone === '972507777777').name, 'דני מהשיחות');
});

test('autoPhones — עובדים, אלפון וספקים; איש קשר בגוגל רק עם חברה', () => {
  const u = user();
  user({ phone: '972508000001' });
  D.run('INSERT INTO phonebook (name, phone, phone2, created_at, updated_at) VALUES (?,?,?,?,?)', 'x', '050-8000002', '0508000003', D.nowIso(), D.nowIso());
  D.run('INSERT INTO vendors (name, email, phone, password_hash, created_at) VALUES (?,?,?,?,?)', 'ספק', `v${Date.now()}@x.test`, '0508000004', 'x', D.nowIso());
  const gc = (rn, phone, org) => D.run('INSERT INTO google_contacts (user_id, resource_name, source, name, phones, organization, updated_at) VALUES (?,?,?,?,?,?,?)',
    u.id, rn, 'contacts', 'n', JSON.stringify([{ value: phone }]), org, D.nowIso());
  gc('people/1', '0508000005', 'חברה בע"מ');
  gc('people/2', '0508000006', '');
  const set = B.autoPhones(u.id);
  for (const p of ['972508000001', '972508000002', '972508000003', '972508000004', '972508000005']) assert.ok(set.has(p), p);
  assert.ok(!set.has('972508000006'), 'אמא אינה איש קשר עסקי');
});
