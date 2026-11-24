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

// --- כל סבבי האישורים (הוחלט 24.11.26) ---
const Settings = require('../../../server/priority/priority-settings');

const CONTRACT = { ORDNAME: 'CO260000125', MED_TYPE: 'CO', CDES: 'סער מהנדסים בע"מ', PROJDES: 'מבואות דרומיים', CURDATE: '2026-11-24T00:00:00Z', TOTPRICE: 126024, CODE: 'ש"ח', USERLOGIN: 'Eladh', OWNERLOGIN: 'MatanR' };
const PARTIAL = { DOCNO: 'PC260000236', CDES: 'עגלוני לחפירות', PROJDES: 'אלעד סנטר', CURDATE: '2026-10-14T00:00:00Z', TOTPRICE: 49492.41, MED_USERLOGIN: 'Eladh', USERLOGIN: 'AlexP', OWNERLOGIN: 'MatanR' };

test('KINDS — כל הסבבים: דרישה, הזמנה, חוזה, חשבון חלקי, חשבון עסקה', () => {
  assert.deepEqual(A.KINDS(), ['demand', 'order', 'contract', 'partial', 'deal']);
});

test('messageFor — חוזה: מספר, ספק, סכום, מי שלח', () => {
  const t = A.messageFor('mordot', CONTRACT, 'מתן רוזן', 'contract');
  assert.match(t, /^📝 ממתין לך בפריוריטי \*חוזה CO260000125\* לאישורך\./);
  assert.match(t, /🏢 מורדות הכרמל נכסים · 📁 מבואות דרומיים/);
  assert.match(t, /🤝 סער מהנדסים בע"מ · 126,024 ש"ח/);
  assert.match(t, /נשלח ע"י מתן רוזן · מ-24\.11\.2026/);
  assert.match(t, /\n\nהאישור — בפריוריטי/);
});

test('messageFor — חוזה CH הוא שינוי בחוזה; חשבון עסקה — הספק מ-SUPDES', () => {
  assert.match(A.messageFor('mordot', { ...CONTRACT, MED_TYPE: 'CH', ORDNAME: 'CH260000018' }, '', 'contract'), /\*שינוי בחוזה CH260000018\*/);
  const t = A.messageFor('mordot', { IVNUM: 'T18', SUPDES: 'ספק עסקה', IVDATE: '2026-09-24T00:00:00Z' }, '', 'deal');
  assert.match(t, /\*חשבון עסקה T18\*/);
  assert.match(t, /🤝 ספק עסקה/);
  assert.match(t, /^מ-24\.09\.2026$/m);
  assert.doesNotMatch(t, /נשלח ע"י/);
});

test('digestFor — כמה מסמכים בהודעה אחת, עד 10 שורות', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ company: 'mordot', kind: 'partial', d: { ...PARTIAL, DOCNO: `PC${i}` } }));
  const t = A.digestFor(items);
  assert.match(t, /\*12 מסמכים\*/);
  assert.match(t, /• 🧾 \*חשבון חלקי PC0\* · עגלוני לחפירות · 49,492 ש"ח · מורדות הכרמל נכסים/);
  assert.doesNotMatch(t, /PC10/);
  assert.match(t, /ועוד 2\./);
});

test('notifyDoc — חשבון חלקי: נשלח לחותם הבא פעם אחת, מפתח עם הסוג', async (t) => {
  usersMock(t);
  const sent = [];
  const send = async (id, text) => { sent.push({ id, text }); return true; };
  const r = await A.notifyDoc('test11', 'partial', PARTIAL, send);
  assert.equal(r.sent, true);
  assert.equal(r.signer, 'Eladh');
  assert.equal(sent[0].id, elad.id);
  assert.match(sent[0].text, /חשבון חלקי PC260000236/);
  assert.ok(D.getSetting('pd_approval_notified', {})['test11:partial:PC260000236:Eladh']);
  assert.equal((await A.notifyDoc('test11', 'partial', PARTIAL, send)).why, 'כבר קיבל');
  assert.equal(sent.length, 1);
});

test('sweep — עובר על כל הסוגים; כמה מסמכים לאותו חותם — הודעה אחת מרוכזת', async (t) => {
  usersMock(t);
  t.mock.method(Priority, 'isEnabled', () => true);
  t.mock.method(Settings, 'pdNotifyCompanies', () => ['test11']);
  t.mock.method(Priority, 'waitingDemands', async () => [{ PRDNO: 'PD-SW', USERLOGIN: 'Eladh' }]);
  const asked = [];
  t.mock.method(Priority, 'waitingForApproval', async (c, kind) => {
    asked.push(kind);
    if (kind === 'contract') return [{ ...CONTRACT, ORDNAME: 'CO-SW' }];
    if (kind === 'partial') return [{ ...PARTIAL, DOCNO: 'PC-SW' }];
    if (kind === 'deal') throw new Error('down');
    return [];
  });
  const sent = [];
  const out = await A.sweep(async (id, text) => { sent.push({ id, text }); return true; }, { force: true });
  assert.deepEqual(asked, ['order', 'contract', 'partial', 'deal']);
  assert.equal(sent.length, 1, 'הודעה אחת לחותם');
  assert.match(sent[0].text, /\*3 מסמכים\*/);
  assert.match(sent[0].text, /דרישת רכש PD-SW/);
  assert.match(sent[0].text, /חוזה CO-SW/);
  assert.match(sent[0].text, /חשבון חלקי PC-SW/);
  assert.deepEqual(out.map((x) => [x.kind, x.no, x.sent]), [['demand', 'PD-SW', true], ['contract', 'CO-SW', true], ['partial', 'PC-SW', true]]);
  const done = D.getSetting('pd_approval_notified', {});
  assert.ok(done['test11:PD-SW:Eladh'] && done['test11:contract:CO-SW:Eladh'] && done['test11:partial:PC-SW:Eladh']);
  // בסבב הבא — כבר קיבל, לא נשלח שוב
  await A.sweep(async (id, text) => { sent.push({ id, text }); return true; }, { force: true });
  assert.equal(sent.length, 1);
});

test('sweep — מסמך אחד: ההודעה הרגילה; מחוץ לשעות — לא נרשם', async (t) => {
  usersMock(t);
  t.mock.method(Priority, 'isEnabled', () => true);
  t.mock.method(Settings, 'pdNotifyCompanies', () => ['test11']);
  t.mock.method(Priority, 'waitingDemands', async () => []);
  t.mock.method(Priority, 'waitingForApproval', async (c, kind) => (kind === 'order' ? [{ ORDNAME: 'PO-ONE', CDES: 'ספק', PORDERUSER_SUBFORM: [{ USERLOGIN: 'Eladh' }] }] : []));
  const texts = [];
  const later = await A.sweep(async (id, text) => { texts.push(text); return 'later'; }, { force: true });
  assert.equal(later[0].later, true);
  assert.match(texts[0], /^📦 ממתין לך בפריוריטי \*הזמנת רכש PO-ONE\*/);
  const ok = await A.sweep(async () => true, { force: true });
  assert.equal(ok[0].sent, true);
});
