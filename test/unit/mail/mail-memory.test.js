'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const M = require('../../../server/mail/mail-memory');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });
const at = (iso) => ({ apis: ['Date'], now: new Date(iso) });

test('normalize — אותיות סופיות מתיישרות, אותיות קטנות', () => {
  assert.equal(M.normalize('מזגן'), 'מזגנ');
  assert.equal(M.normalize('ךםןףץ'), 'כמנפצ');
  assert.equal(M.normalize('ABC'), 'abc');
  assert.equal(M.normalize(null), '');
});

test('terms — מילים של שתי אותיות ומעלה, בלי כפילויות', () => {
  assert.deepEqual(M.terms('המזגן, המזגן! ב חדר-ישיבות'), ['המזגן', 'חדר', 'ישיבות']);
  assert.deepEqual(M.terms(''), []);
  assert.equal(M.terms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')).length, 12);
});

test('allowed — ספק אף פעם; * לכולם', () => {
  assert.equal(M.allowed(null), false);
  assert.equal(M.allowed({ role: 'vendor', email: 'v@x' }), false);
  D.setSetting('mail_memory_users', '*');
  assert.equal(M.allowed({ role: 'employee', email: 'a@x' }), true);
});

test('allowed — ריק: מנהלי מערכת בלבד; רשימה: לפי כתובת', () => {
  D.setSetting('mail_memory_users', '');
  assert.equal(M.allowed({ role: 'employee', email: 'a@x' }), false);
  assert.equal(M.allowed({ role: 'admin', email: 'a@x' }), true);
  D.setSetting('mail_memory_users', 'A@x, b@x');
  assert.equal(M.allowed({ role: 'employee', email: 'a@X' }), true);
  assert.equal(M.allowed({ role: 'employee', email: 'c@x' }), false);
  D.setSetting('mail_memory_users', '*');
});

test('allowed — הזיכרון כבוי: אף אחד', () => {
  D.setSetting('mail_memory_enabled', false);
  assert.equal(M.allowed({ role: 'admin', email: 'a@x' }), false);
  D.setSetting('mail_memory_enabled', true);
});

test('isNight — חלון שחוצה חצות, שעון ישראל', (t) => {
  D.setSetting('mail_memory_night', true);
  D.setSetting('mail_memory_night_hours', '19:00-07:00');
  t.mock.timers.enable(at('2026-11-10T20:00:00Z')); // 22:00 בישראל
  assert.equal(M.isNight(), true);
  t.mock.timers.setTime(new Date('2026-11-10T10:00:00Z').getTime()); // 12:00
  assert.equal(M.isNight(), false);
  t.mock.timers.setTime(new Date('2026-11-10T04:30:00Z').getTime()); // 06:30
  assert.equal(M.isNight(), true);
});

test('isNight — כבוי בהגדרה, או חלון לא תקין', (t) => {
  t.mock.timers.enable(at('2026-11-10T20:00:00Z'));
  D.setSetting('mail_memory_night', false);
  assert.equal(M.isNight(), false);
  D.setSetting('mail_memory_night', true);
  D.setSetting('mail_memory_night_hours', 'בלילה');
  assert.equal(M.isNight(), false);
  D.setSetting('mail_memory_night_hours', '19:00-07:00');
});

test('inHours — ריק: תמיד; חלון רגיל לפי השעה', (t) => {
  t.mock.timers.enable(at('2026-11-10T10:00:00Z')); // 12:00
  D.setSetting('mail_memory_hours', '');
  assert.equal(M._internal.inHours(), true);
  D.setSetting('mail_memory_hours', '08:00-17:00');
  assert.equal(M._internal.inHours(), true);
  D.setSetting('mail_memory_hours', '13:00-17:00');
  assert.equal(M._internal.inHours(), false);
  D.setSetting('mail_memory_hours', '');
});

test('savePerson — טלפון חוזר מאומת; טלפון אחר מתחיל מאחד', () => {
  const u = user();
  M._internal.savePerson(u.id, 'oren@law.test', { name: 'אורן', company: 'כהן', role: 'עו"ד', phone: '0501234567', internal: false });
  assert.equal(M.personByEmail(u.id, 'OREN@law.test').phoneVerified, false);
  M._internal.savePerson(u.id, 'oren@law.test', { name: 'אורן', phone: '0501234567' });
  const p = M.personByEmail(u.id, 'oren@law.test');
  assert.equal(p.phoneVerified, true);
  assert.equal(p.company, 'כהן', 'חברה ריקה לא דורסת');
  M._internal.savePerson(u.id, 'oren@law.test', { name: 'אורן', phone: '0529999999' });
  assert.equal(M.personByEmail(u.id, 'oren@law.test').phoneVerified, false);
  assert.equal(M.personByEmail(u.id, 'nobody@x'), null);
});

test('editPerson — תיקון ידני נשמר, וה-AI לא דורס תפקיד וחברה', () => {
  const u = user();
  M._internal.savePerson(u.id, 'dan@x.test', { name: 'דן', company: 'א', role: 'טכנאי', phone: '', internal: false });
  const id = M.personByEmail(u.id, 'dan@x.test').id;
  const p = M.editPerson(u.id, id, { role: 'מודד', phone: '050-111 2222' });
  assert.equal(p.role, 'מודד');
  assert.equal(p.phone, '0501112222');
  assert.equal(p.phoneVerified, true);
  assert.equal(p.edited, true);
  M._internal.savePerson(u.id, 'dan@x.test', { name: 'דן', company: 'ב', role: 'אחר', phone: '' });
  const after = M.personByEmail(u.id, 'dan@x.test');
  assert.equal(after.role, 'מודד');
  assert.equal(after.company, 'א');
  assert.throws(() => M.editPerson(u.id, 999999, {}), /לא נמצא/);
});

test('remove — סוג לא מוכר, או של משתמש אחר: שגיאה', () => {
  const u = user();
  const other = user();
  M._internal.savePerson(u.id, 'x@x.test', { name: 'x', phone: '' });
  const id = M.personByEmail(u.id, 'x@x.test').id;
  assert.throws(() => M.remove(u.id, 'nope', id), /סוג לא מוכר/);
  assert.throws(() => M.remove(other.id, 'person', id), /לא נמצא/);
  M.remove(u.id, 'person', id);
  assert.equal(M.personByEmail(u.id, 'x@x.test'), null);
});

test('search — מוצא גם בלי אות שימוש ובלי אות סופית', () => {
  const u = user();
  M._internal.savePerson(u.id, 'ac@cool.test', { name: 'יוסי', company: 'קירור', role: 'טכנאי מזגנים', phone: '' });
  D.run('INSERT INTO mail_memory (user_id, thread_id, summary, domain, keywords, happened_at, created_at) VALUES (?,?,?,?,?,?,?)',
    u.id, 't1', 'יוסי תיקן את המזגן בחדר הישיבות', 'תיקון מזגן', 'מזגן תיקון', '2026-11-01', D.nowIso());
  const r = M.search(u.id, 'המזגן');
  assert.equal(r.people.length, 1);
  assert.equal(r.people[0].email, 'ac@cool.test');
  assert.equal(r.events.length, 1);
  assert.deepEqual(M.search(u.id, 'א'), { people: [], events: [], docs: [] });
  assert.equal(M.search(user().id, 'מזגן').people.length, 0, 'רק הזיכרון של המשתמש');
});
