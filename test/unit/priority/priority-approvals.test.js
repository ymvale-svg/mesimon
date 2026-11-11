'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Priority = require('../../../server/integrations/priority');
const A = require('../../../server/priority/priority-approvals');

boot();
const PR_USERS = [
  { USERLOGIN: 'Eladh', SNAME: 'אלעד חדד', FIRSTNAME: 'אלעד', FAMILYNAME: 'חדד', EMAIL: 'ELAD@corp.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'MatanR', SNAME: 'מתן רוזן', FIRSTNAME: 'מתן', FAMILYNAME: 'רוזן', EMAIL: '', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'Ghost', SNAME: 'רוח רפאים', EMAIL: 'ghost@nowhere.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'Old', SNAME: 'עובד ישן', EMAIL: 'old@corp.test', STATDES: 'לא פעיל' }
];
const usersMock = (t, list = PR_USERS) => t.mock.method(Priority, 'priorityUsers', async () => list);

const elad = user({ full_name: 'אלעד חדד', email: 'elad@corp.test', phone: '0501111111' });
const matan = user({ full_name: 'רוזן מתן', email: 'matan@mesimon.test', phone: '' });
const old = user({ full_name: 'עובד ישן', email: 'old@corp.test', phone: '0502222222' });

test('words — בלי סימנים, ממוין', () => {
  assert.equal(A._words('חדד (אלעד)'), 'אלעד חדד');
  assert.equal(A._words("בן-דוד 'יוסי'"), 'בן דוד יוסי');
  assert.equal(A._words(null), '');
});

test('mesimonUserFor — לפי המייל, בלי תלות ברישיות', async (t) => {
  usersMock(t);
  const m = await A.mesimonUserFor('eladh');
  assert.equal(m.how, 'email');
  assert.equal(m.user.id, elad.id);
  assert.equal(m.pr.USERLOGIN, 'Eladh');
});

test('mesimonUserFor — לפי השם, בכל סדר', async (t) => {
  usersMock(t);
  const m = await A.mesimonUserFor('MatanR');
  assert.equal(m.how, 'name');
  assert.equal(m.user.id, matan.id);
});

test('mesimonUserFor — מיפוי ידני קודם לכל', async (t) => {
  usersMock(t);
  D.setSetting('priority_user_map', { Ghost: elad.id });
  t.after(() => D.setSetting('priority_user_map', {}));
  const m = await A.mesimonUserFor('Ghost');
  assert.equal(m.how, 'manual');
  assert.equal(m.user.id, elad.id);
});

test('mesimonUserFor — לא נמצא', async (t) => {
  usersMock(t);
  assert.deepEqual(await A.mesimonUserFor('Ghost'), { user: null, how: null, pr: PR_USERS[2] });
  assert.deepEqual(await A.mesimonUserFor('Nobody'), { user: null, how: null, pr: null });
  assert.deepEqual(await A.mesimonUserFor('  '), { user: null, how: null, pr: null });
});

test('priorityLoginFor — לפי המייל', async (t) => {
  usersMock(t);
  assert.equal(await A.priorityLoginFor(elad), 'Eladh');
  assert.equal(await A.priorityLoginFor({ id: elad.id }), 'Eladh');
});

test('priorityLoginFor — לפי השם, ורק עובד פעיל', async (t) => {
  usersMock(t);
  assert.equal(await A.priorityLoginFor(matan), 'MatanR');
  assert.equal(await A.priorityLoginFor(old), null);
});

test('priorityLoginFor — פריוריטי לא זמין: null', async (t) => {
  t.mock.method(Priority, 'priorityUsers', async () => { throw new Error('down'); });
  assert.equal(await A.priorityLoginFor(elad), null);
});

test('mapping — רק עובדים פעילים, עם התרגום', async (t) => {
  usersMock(t);
  const m = await A.mapping();
  assert.deepEqual(m.map((x) => x.login), ['Eladh', 'MatanR', 'Ghost']);
  assert.deepEqual(m[0].mesimon, { id: elad.id, name: 'אלעד חדד', phone: true });
  assert.equal(m[1].mesimon.phone, false);
  assert.equal(m[2].mesimon, null);
});

const DEMAND = { PRDNO: 'PD26000123', PROJDES: 'מבואות חיפה', CURDATE: '2026-11-09T00:00:00Z', PRDITEMS_SUBFORM: [{}, {}, {}] };

test('messageFor — חברה אמיתית', () => {
  const t = A.messageFor('mordot', DEMAND, 'דנה');
  assert.match(t, /\*דרישת רכש PD26000123\*/);
  assert.match(t, /🏢 מורדות הכרמל נכסים · 📁 מבואות חיפה/);
  assert.match(t, /נפתחה ע"י דנה · 3 פריטים · מ-09\.11\.2026/);
  assert.match(t, /האישור — בפריוריטי/);
});

test('messageFor — סביבת בדיקה, פריט אחד, בלי בעלים', () => {
  const t = A.messageFor('test11', { PRDNO: 'PD1', PRDITEMS_SUBFORM: [{}] }, '');
  assert.match(t, /🧪 test11 \(סביבת בדיקה\)/);
  assert.match(t, /^פריט אחד$/m);
  assert.doesNotMatch(t, /נפתחה/);
});

test('notifyDemand — אין חותם', async () => {
  const r = await A.notifyDemand('test11', { PRDNO: 'PD-X' }, async () => true);
  assert.equal(r.signer, null);
  assert.equal(r.sent, false);
});

test('notifyDemand — שולח לחותם הבא פעם אחת', async (t) => {
  usersMock(t);
  const sent = [];
  const send = async (id, text) => { sent.push({ id, text }); return true; };
  const d = { ...DEMAND, PRDNO: 'PD-A', USERLOGIN: 'Eladh', OWNERLOGIN: 'MatanR' };
  const r = await A.notifyDemand('test11', d, send);
  assert.equal(r.sent, true);
  assert.equal(r.user.id, elad.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, elad.id);
  assert.match(sent[0].text, /נפתחה ע"י מתן רוזן/);
  const again = await A.notifyDemand('test11', d, send);
  assert.equal(again.sent, false);
  assert.equal(again.why, 'כבר קיבל');
  assert.equal(sent.length, 1);
});

test('notifyDemand — עבר לחותם הבא: גם הוא מקבל', async (t) => {
  usersMock(t);
  D.setSetting('priority_user_map', { Next: elad.id });
  t.after(() => D.setSetting('priority_user_map', {}));
  const sent = [];
  const send = async (id) => { sent.push(id); return true; };
  await A.notifyDemand('test11', { PRDNO: 'PD-B', USERLOGIN: 'Eladh' }, send);
  await A.notifyDemand('test11', { PRDNO: 'PD-B', USERLOGIN: 'Next' }, send);
  assert.equal(sent.length, 2);
});

test('notifyDemand — שליחה נכשלה: לא נרשם, ינסה שוב', async (t) => {
  usersMock(t);
  const d = { PRDNO: 'PD-C', USERLOGIN: 'Eladh' };
  const r = await A.notifyDemand('test11', d, async () => false);
  assert.equal(r.sent, false);
  assert.equal(r.why, 'הבוט לא שלח');
  const r2 = await A.notifyDemand('test11', d, async () => true);
  assert.equal(r2.sent, true);
});

const alerts = (like) => D.get('SELECT COUNT(*) AS n FROM notifications WHERE title LIKE ?', `%${like}%`).n;

test('notifyDemand — אין טלפון: לא שולח, והמנהלים מקבלים התראה פעם אחת', async (t) => {
  usersMock(t);
  let called = false;
  const before = alerts('אין טלפון');
  const r = await A.notifyDemand('test11', { PRDNO: 'PD-D', USERLOGIN: 'MatanR' }, async () => { called = true; return true; });
  assert.equal(r.why, 'אין טלפון בפרופיל');
  assert.equal(called, false);
  const after = alerts('אין טלפון');
  assert.ok(after > before, 'מנהל המערכת קיבל התראה');
  await A.notifyDemand('test11', { PRDNO: 'PD-D2', USERLOGIN: 'MatanR' }, async () => true);
  assert.equal(alerts('אין טלפון'), after, 'פעם אחת לכל משתמש');
});

test('notifyDemand — מחוץ לשעות הפעילות: לא נרשם כ"קיבל", נשלח בסבב הבא', async (t) => {
  usersMock(t);
  const d = { PRDNO: 'PD-G', USERLOGIN: 'Eladh' };
  const r = await A.notifyDemand('test11', d, async () => 'later');
  assert.equal(r.sent, false);
  assert.equal(r.later, true);
  const r2 = await A.notifyDemand('test11', d, async () => true);
  assert.equal(r2.sent, true);
});

test('notifyDemand — השליחה נכשלה שוב ושוב: התראה למנהלים אחרי MAX_FAILS, פעם אחת', async (t) => {
  usersMock(t);
  const d = { PRDNO: 'PD-H', USERLOGIN: 'Eladh' };
  const before = alerts('לא נשלחה');
  for (let i = 1; i < A.MAX_FAILS; i++) await A.notifyDemand('test11', d, async () => false);
  assert.equal(alerts('לא נשלחה'), before, 'עוד לא');
  await A.notifyDemand('test11', d, async () => false);
  const after = alerts('לא נשלחה');
  assert.ok(after > before, 'מנהל המערכת קיבל התראה');
  await A.notifyDemand('test11', d, async () => false);
  assert.equal(alerts('לא נשלחה'), after, 'פעם אחת');
  const ok = await A.notifyDemand('test11', d, async () => true);
  assert.equal(ok.sent, true);
  assert.equal(D.getSetting('pd_approval_failed', {})['test11:PD-H:Eladh'], undefined);
});

test('notifyDemand — חותם לא ממופה: התראה למנהלים פעם אחת', async (t) => {
  usersMock(t);
  const count = () => D.get("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%Ghost%'").n;
  const before = count();
  const r = await A.notifyDemand('test11', { PRDNO: 'PD-E', USERLOGIN: 'Ghost' }, async () => true);
  assert.equal(r.why, 'לא נמצא במשימון');
  assert.ok(D.getSetting('pd_approval_unmapped', {}).Ghost);
  const after = count();
  await A.notifyDemand('test11', { PRDNO: 'PD-F', USERLOGIN: 'Ghost' }, async () => true);
  assert.equal(count(), after);
  assert.ok(after > before, "מנהל המערכת קיבל התראה");
});

test('sweep — כבוי בלי חיבור לפריוריטי', async (t) => {
  const w = t.mock.method(Priority, 'waitingDemands', async () => []);
  assert.deepEqual(await A.sweep(async () => true, { force: true }), []);
  assert.equal(w.mock.callCount(), 0);
});
