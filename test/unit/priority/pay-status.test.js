'use strict';
/**
 * 💸 שולם — שלב 2 של רשימת התשלומים (‎server/priority/pay-status.js‎; "אפיון — מעקב אישורים ותשלומים.md" סעיף 5):
 * ההתאמה בין חשבונית לתשלום (התאמה בכרטיס / לפי סכום), סימון "שולם", מי מקבל מייל, "לא שולם ב-15", ותצוגת "שולם".
 * הנתונים — לפי מה שנבדק בפריוריטי (24.11.26): GI26000328 נסגרה ב-BT26000233.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Priority = require('../../../server/integrations/priority');
const Settings = require('../../../server/priority/priority-settings');
const PS = require('../../../server/priority/pay-status');
const Payments = require('../../../server/priority/payments');

boot();
const NOW = '2026-11-24T10:00:00.000Z';
const notes = (uid) => D.all('SELECT title, body FROM notifications WHERE target_type = ? AND target_id = ? ORDER BY id', 'user', uid);

// ---------------------------------------------------------------- ההתאמה
const INV = { IVNUM: 'GI26000328', IVDATE: '2026-10-07T00:00:00Z', TOTPRICE: 409045.82, recon: 0 };
const BT = (o = {}) => ({ fncnum: '26001817', ref: 'BT26000233', kind: 'העב', date: '2026-10-05', sum: 409045.82, recon: 0, ...o });

test('matchPayment — התאמה בכרטיס הספק קודמת לסכום', () => {
  const m = PS.matchPayment({ ...INV, recon: 7 }, [BT({ ref: 'BT-A' }), BT({ ref: 'BT-B', sum: 1, recon: 7 })]);
  assert.equal(m.how, 'reconciled');
  assert.equal(m.payment.ref, 'BT-B');
});

test('matchPayment — לפי סכום: עד שקל וחצי, גם תשלום שקדם לחשבונית ביומיים', () => {
  const m = PS.matchPayment(INV, [BT({ sum: 409045.82 - 1.2 })]);
  assert.equal(m.how, 'amount');
  assert.equal(m.payment.ref, 'BT26000233');
  assert.equal(PS.matchPayment(INV, [BT({ sum: 409000 })]), null, 'סכום אחר');
});

test('matchPayment — לא תשלום שכבר נתפס, לא תשלום שהותאם למשהו אחר, לא תשלום ישן מדי', () => {
  assert.equal(PS.matchPayment(INV, [BT()], new Set(['BT26000233'])), null);
  assert.equal(PS.matchPayment(INV, [BT({ recon: 3 })]), null);
  assert.equal(PS.matchPayment(INV, [BT({ date: '2026-08-01' })]), null);
});

test('matchPayment — כמה מתאימים: הראשון לפי תאריך', () => {
  const m = PS.matchPayment(INV, [BT({ ref: 'BT-late', date: '2026-11-01' }), BT({ ref: 'BT-early', date: '2026-10-20' })]);
  assert.equal(m.payment.ref, 'BT-early');
});

test('combine — כל החשבוניות שולמו: התאריך האחרון; אחת לפי סכום ← "לפי סכום"', () => {
  const r = PS.combine([{ payment: BT({ date: '2026-10-05' }), how: 'reconciled' }, { payment: BT({ ref: 'BT9', date: '2026-11-01' }), how: 'amount' }]);
  assert.deepEqual(r, { paidAt: '2026-11-01', ref: 'BT26000233, BT9', how: 'amount', kind: 'העב' });
  assert.equal(PS.combine([{ payment: BT(), how: 'reconciled' }, null]), null, 'חשבונית אחת לא שולמה');
  assert.equal(PS.combine([]), null);
});

// ---------------------------------------------------------------- הבדיקה מול פריוריטי
function addItem(ref, o = {}) {
  const [company, type, docno] = ref.split(':');
  const it = { ref, company, type, docno, supplier: { code: '601679', name: 'אב אדריכלות נוף' }, project: { code: 'PR1', name: 'יוקנעם' },
    currency: 'ש"ח', amount: 409045.82, date: '2026-10-01', payDay: '2026-12-15', initiator: 'SariE', people: ['SariE'], ...o.it };
  D.run(`INSERT OR REPLACE INTO payment_items (ref, org_id, company, type, docno, stage, amount, pay_day, first_pay_day, invoices, data, first_seen, last_seen, stage_at)
    VALUES (?,1,?,?,?,?,?,?,?,'[]',?,?,?,?)`, ref, company, type, docno, o.stage ?? 'invoiced', it.amount, o.payDay ?? it.payDay, it.payDay, JSON.stringify(it),
  '2026-10-01T00:00:00Z', NOW, o.stageAt ?? '2026-10-08T00:00:00Z');
  return it;
}
const stage = (ref) => D.get('SELECT stage, paid_at, payment_ref, paid_how, paid_checked_at FROM payment_items WHERE ref = ?', ref);

function fakePriority(t, { invoices = {}, recon = {}, payments = [] } = {}) {
  const calls = { pays: 0 };
  t.mock.method(Priority, 'invoicesForDoc', async (c, sup, docno) => (invoices[docno] ?? []).map((x) => ({ ...x })));
  t.mock.method(Priority, 'dealInvoice', async (c, ivnum) => invoices[ivnum]?.[0] ?? null);
  t.mock.method(Priority, 'invoiceRecon', async (c, fnc) => recon[fnc] ?? 0);
  t.mock.method(Priority, 'supplierPayments', async () => { calls.pays += 1; return payments; });
  return calls;
}

test('checkPaid — חשבון חלקי ← GI ← BT באותו סכום: שולם, לפי סכום', async (t) => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:partial:PC1');
  fakePriority(t, { invoices: { PC1: [{ ...INV, FNCNUM: '26001915' }] }, payments: [BT()] });
  const told = [];
  const r = await PS.checkPaid(NOW, { notify: async (ref) => told.push(ref) });
  assert.deepEqual(r, { checked: 1, paid: 1 });
  assert.deepEqual({ ...stage('a160226:partial:PC1'), paid_checked_at: undefined },
    { stage: 'paid', paid_at: '2026-10-05', payment_ref: 'BT26000233', paid_how: 'amount:העב', paid_checked_at: undefined });
  assert.deepEqual(told, ['a160226:partial:PC1']);
});

test('checkPaid — התאמה בכרטיס הספק: "reconciled"', async (t) => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:receipt:GR1');
  fakePriority(t, { invoices: { GR1: [{ ...INV, FNCNUM: 'F1' }] }, recon: { F1: 12 }, payments: [BT({ ref: 'BT-X', sum: 5, recon: 12 })] });
  await PS.checkPaid(NOW, { notify: async () => {} });
  assert.equal(stage('a160226:receipt:GR1').paid_how, 'reconciled:העב');
  assert.equal(stage('a160226:receipt:GR1').payment_ref, 'BT-X');
});

test('checkPaid — אין חשבונית / אין תשלום: נשאר, ונרשם שנבדק (הבא בתור — מי שלא נבדק)', async (t) => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:partial:PC2');
  addItem('a160226:partial:PC3');
  fakePriority(t, { invoices: { PC3: [{ ...INV, FNCNUM: 'F3' }] }, payments: [] });
  const r = await PS.checkPaid(NOW, { max: 1, notify: async () => {} });
  assert.equal(r.paid, 0);
  assert.equal(stage('a160226:partial:PC2').stage, 'invoiced');
  assert.equal(stage('a160226:partial:PC2').paid_checked_at, NOW);
  assert.equal(stage('a160226:partial:PC3').paid_checked_at, '', 'עוד לא נבדק — הבא בתור');
});

test('checkPaid — תשלום אחד לא נתפס בשתי חשבוניות', async (t) => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:partial:PA');
  addItem('a160226:partial:PB');
  fakePriority(t, { invoices: { PA: [{ ...INV, IVNUM: 'GA', FNCNUM: 'FA' }], PB: [{ ...INV, IVNUM: 'GB', FNCNUM: 'FB' }] }, payments: [BT()] });
  const r = await PS.checkPaid(NOW, { notify: async () => {} });
  assert.equal(r.paid, 1);
  assert.deepEqual([stage('a160226:partial:PA').stage, stage('a160226:partial:PB').stage].sort(), ['invoiced', 'paid']);
});

test('checkPaid — חשבון עסקה: הוא עצמו החשבונית, רק כשהוא סופי', async (t) => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:deal:T18');
  fakePriority(t, { invoices: { T18: [{ ...INV, IVNUM: 'T18', STATDES: 'סופית', FNCNUM: 'FT' }] }, payments: [BT()] });
  await PS.checkPaid(NOW, { notify: async () => {} });
  assert.equal(stage('a160226:deal:T18').stage, 'paid');
});

// ---------------------------------------------------------------- מי מקבל
const dept = (name, manager) => Number(D.run("INSERT INTO departments (name, manager_user_id, created_at) VALUES (?,?,?)", name, manager?.id ?? null, NOW).lastInsertRowid);

test('paidRecipients — היוזם, מנהל המחלקה, ומי שבהגדרה לאותה מחלקה (המזכירה של התכנון)', (t) => {
  const mgr = user({ full_name: 'מנהלת תכנון' });
  const sec = user({ full_name: 'שושנה' });
  const other = user({ full_name: 'מישהו ממחלקה אחרת' });
  const plan = dept(`תכנון ${Date.now()}`, mgr);
  const ops = dept(`תפעול ${Date.now()}`, null);
  D.run('UPDATE users SET department_id = ? WHERE id = ?', plan, mgr.id);
  const ini = user({ full_name: 'יוזמת' });
  D.run('UPDATE users SET department_id = ? WHERE id = ?', plan, ini.id);
  t.mock.method(Settings, 'defaults', () => ({ paidNotify: { [plan]: [sec.id], [ops]: [other.id] } }));
  const u = (x) => D.get('SELECT id, full_name, email, department_id FROM users WHERE id = ?', x.id);
  assert.deepEqual(PS.paidRecipients(u(ini)).map((r) => r.user.full_name), ['יוזמת', 'מנהלת תכנון', 'שושנה']);
  // מנהלת התכנון יזמה בעצמה — שושנה מקבלת גם
  assert.deepEqual(PS.paidRecipients(u(mgr)).map((r) => r.user.full_name), ['מנהלת תכנון', 'שושנה']);
  assert.deepEqual(PS.paidRecipients(null), []);
});

test('onPaid — מייל (והתראה) לנמענים, פעם אחת; תשלום ישן — בלי מייל', async (t) => {
  D.run('DELETE FROM payment_items');
  const ini = user({ full_name: 'שרית' });
  t.mock.method(Priority, 'priorityUsers', async () => [{ USERLOGIN: 'SariE', SNAME: 'שרית', EMAIL: ini.email, STATDES: 'עובד פעיל' }]);
  t.mock.method(Settings, 'defaults', () => ({ paidNotify: {} }));
  addItem('a160226:partial:PN', { stage: 'paid' });
  PS.markPaid('a160226:partial:PN', { paidAt: '2026-11-23', ref: 'BT26000339', how: 'reconciled', kind: 'העב' }, NOW);
  const to = await PS.onPaid('a160226:partial:PN', NOW);
  assert.deepEqual(to.map((r) => r.user.id), [ini.id]);
  const n = notes(ini.id).pop();
  assert.match(n.title, /✅ שולם: אב אדריכלות נוף — חשבון חלקי PN/);
  assert.match(n.body, /שולם ב-23\.11\.2026 \(העברה בנקאית BT26000339\)/);
  assert.match(n.body, /קיבלת את ההודעה כי יזמת/);
  assert.deepEqual(await PS.onPaid('a160226:partial:PN', NOW), [], 'פעם אחת');

  addItem('a160226:partial:OLD', { stage: 'paid' });
  PS.markPaid('a160226:partial:OLD', { paidAt: '2026-10-05', ref: 'BT1', how: 'amount' }, NOW);
  const before = notes(ini.id).length;
  assert.deepEqual(await PS.onPaid('a160226:partial:OLD', NOW), []);
  assert.equal(notes(ini.id).length, before, 'תשלום מלפני יותר משבוע — בלי מייל');
});

test('paidMail — לפני המועד, ולפי סכום', () => {
  const it = { type: 'partial', docno: 'PC1', supplier: { name: 'ספק' }, currency: 'ש"ח', amount: 100, company: 'a160226', payDay: '2026-12-15', project: {} };
  const m = PS.paidMail(it, { paid_at: '2026-11-20', payment_ref: 'BT1', paid_how: 'amount:תשצ' }, 'יזמת');
  assert.match(m.text, /\(המחאה BT1\) — לפני המועד \(ה-15 היה 15\.12\.2026\)/);
  assert.match(m.text, /זוהה לפי הסכום/);
  assert.match(m.html, /<p/);
});

// ---------------------------------------------------------------- לא שולם ב-15
test('sweepLate — רק ליוזם, פעם אחת, לא על הסבה, לא על מה ששולם ולא על מועד ישן', async (t) => {
  D.run('DELETE FROM payment_items');
  const ini = user({ full_name: 'רביב' });
  t.mock.method(Priority, 'priorityUsers', async () => [{ USERLOGIN: 'RavivK', SNAME: 'רביב', EMAIL: ini.email, STATDES: 'עובד פעיל' }]);
  t.mock.method(Priority, 'supplierPayments', async () => []);
  const base = { initiator: 'RavivK', people: ['RavivK'] };
  addItem('a160226:partial:L1', { payDay: '2026-11-15', it: base });
  addItem('a160226:partial:L2', { payDay: '2026-11-15', it: { ...base, endorsed: true } });
  addItem('a160226:partial:L3', { payDay: '2026-11-15', stage: 'paid', it: base });
  addItem('a160226:partial:L4', { payDay: '2026-09-15', it: base });
  addItem('a160226:receipt:L5', { payDay: '2026-11-15', stage: 'open', it: base });
  addItem('a160226:partial:L6', { payDay: '2026-12-15', it: base });
  const out = await PS.sweepLate('2026-11-16', NOW);
  assert.deepEqual(out.map((x) => x.ref).sort(), ['a160226:partial:L1', 'a160226:receipt:L5']);
  assert.ok(out.every((x) => x.user.id === ini.id));
  assert.match(notes(ini.id).pop().body, /המועד היה ה-15 \(15\.11\.2026\)/);
  assert.deepEqual(await PS.sweepLate('2026-11-17', NOW), [], 'פעם אחת');
});

// ---------------------------------------------------------------- תצוגה ו"הוסב"
test('fromPartial — "הוסב" נשמר במסמך', () => {
  assert.equal(Payments.fromPartial({ DOCNO: 'PC1', CURDATE: '2026-10-01T00:00:00Z', MEDR_ENDORSED: 'Y' }, 'a160226').endorsed, true);
  assert.equal(Payments.fromPartial({ DOCNO: 'PC1', CURDATE: '2026-10-01T00:00:00Z', MEDR_ENDORSED: null }, 'a160226').endorsed, false);
});

test('paidItems — מה ששולם ב-120 הימים האחרונים, עם "לפני המועד"', () => {
  D.run('DELETE FROM payment_items');
  addItem('a160226:partial:P1', { stage: 'paid' });
  PS.markPaid('a160226:partial:P1', { paidAt: '2026-11-20', ref: 'BT1', how: 'reconciled', kind: 'העב' }, NOW);
  addItem('a160226:partial:P2', { stage: 'paid' });
  PS.markPaid('a160226:partial:P2', { paidAt: '2026-05-01', ref: 'BT2', how: 'amount' }, NOW);
  const list = Payments.paidItems('2026-11-24');
  assert.deepEqual(list.map((x) => x.docno), ['P1']);
  assert.equal(list[0].paidAt, '2026-11-20');
  assert.equal(list[0].paidHow, 'reconciled');
  assert.equal(list[0].paidKind, 'העב');
  assert.equal(list[0].early, true, 'שולם לפני 15.12');
});

// ---------------------------------------------------------------- ההגדרה
test('settings — paidNotify: נשמר לפי מחלקה; מחלקה שלא קיימת נדחית', () => {
  const sec = user({ full_name: 'מזכירה' });
  const d = dept(`מחלקה ${Date.now()}`, null);
  const r = Settings.save({ defaults: { paidNotify: { [d]: [sec.id, sec.id] } } }, { by: 'test' }).defaults;
  assert.deepEqual(r.paidNotify, { [String(d)]: [sec.id] });
  assert.throws(() => Settings.save({ defaults: { paidNotify: { 99998: [sec.id] } } }), /לא קיימת/);
});

test('sweepLate — הספק קיבל סביב ה-15 תשלומים שמכסים את הסכום (ניכוי במקור / המחאה לכמה חשבוניות): לא מתריעים', async (t) => {
  D.run('DELETE FROM payment_items');
  const ini = user({ full_name: 'רביב 2' });
  t.mock.method(Priority, 'priorityUsers', async () => [{ USERLOGIN: 'RavivK', SNAME: 'רביב', EMAIL: ini.email, STATDES: 'עובד פעיל' }]);
  t.mock.method(Priority, 'supplierPayments', async () => [{ ref: 'CH1', date: '2026-11-15', sum: 100000 }, { ref: 'CH2', date: '2026-11-15', sum: 280000 }]);
  addItem('a160226:partial:M1', { payDay: '2026-11-15', it: { initiator: 'RavivK', people: ['RavivK'] } });
  assert.deepEqual(await PS.sweepLate('2026-11-16', NOW), []);
  t.mock.method(Priority, 'supplierPayments', async () => { throw new Error('down'); });
  addItem('a160226:partial:M2', { payDay: '2026-11-15', it: { initiator: 'RavivK', people: ['RavivK'] } });
  assert.deepEqual(await PS.sweepLate('2026-11-16', NOW), [], 'פריוריטי לא זמין — שותקים');
  t.mock.method(Priority, 'supplierPayments', async () => []);
  assert.deepEqual((await PS.sweepLate('2026-11-16', NOW)).map((x) => x.ref), ['a160226:partial:M2'], 'וכשחוזר — שולחים');
});
