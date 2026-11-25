'use strict';
/**
 * 💰 תשלומים, שלב 2 — "שולם" (‎payments-paid.js‎, ‎payments-notify.js‎): התאמת חשבוניות לתשלומים בכרטיס הספק
 * (התאמה בכרטיס, לפי סכום, העברה אחת לכמה חשבוניות), מסמך ← GI ← שולם, "נראה ששולם", התצוגות וההודעות.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Paid = require('../../../server/priority/payments-paid');
const Notify = require('../../../server/priority/payments-notify');
const Payments = require('../../../server/priority/payments');
const Settings = require('../../../server/priority/priority-settings');
const Mailer = require('../../../server/integrations/mailer');

boot();
const TODAY = '2026-11-24';
const actor = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
const L = (o) => ({ supplier: 'S1', ivnum: '', ref: '', pattern: 'העב', debit: 0, credit: 0, date: '2026-10-01', recon: -1, ...o });
const inv = (ivnum, credit, date = '2026-10-01', o = {}) => L({ ivnum, ref: ivnum, pattern: 'חסמ', credit, date, ...o });
const pay = (ref, debit, date = '2026-10-10', o = {}) => L({ ivnum: ref, ref, debit, date, ...o });

test('התאמה: בכרטיס (FRECONNUM) · לפי סכום · העברה אחת לכמה חשבוניות · תשלום שהקדים את החשבונית · מה שלא הותאם', () => {
  const { paid, left } = Paid.matchLedger([
    inv('GI1', 100, '2026-09-01', { recon: 7 }), pay('BT1', 100, '2026-09-20', { recon: 7 }),
    inv('GI2', 409045.82, '2026-10-07'), pay('BT2', 409045.82, '2026-10-05'),                 // התשלום לפני החשבונית (כמו GI26000328)
    inv('GI3', 300, '2026-10-01'), inv('GI4', 200, '2026-10-02'), inv('GI5', 50, '2026-10-03'), pay('BT3', 550, '2026-10-20'),
    inv('GI6', 999, '2026-10-01'),
    pay('BT4', 777, '2026-11-01'),
    inv('GI7', 120, '2026-10-01', { supplier: 'S2' }), pay('BT5', 120, '2026-10-02', { supplier: 'S1' })   // ספק אחר — לא
  ]);
  assert.deepEqual(paid.get('GI1'), { date: '2026-09-20', ref: 'BT1', how: 'recon', kind: 'transfer' });
  assert.deepEqual(paid.get('GI2'), { date: '2026-10-05', ref: 'BT2', how: 'amount', kind: 'transfer' });
  for (const g of ['GI3', 'GI4', 'GI5']) assert.equal(paid.get(g)?.ref, 'BT3', `${g} — העברה אחת שסוגרת שלוש`);
  assert.equal(paid.has('GI6'), false);
  assert.equal(paid.has('GI7'), false, 'תשלום לספק אחר');
  assert.deepEqual(left.map((d) => d.ref).sort(), ['BT4', 'BT5']);
});

test('מספר התאמה בחשבונית בלי תשלום מותאם (GI26000044 / BT26000033) — עדיין מותאם לפי סכום', () => {
  const { paid } = Paid.matchLedger([pay('BT26000033', 47200, '2026-07-19'), inv('GI26000044', 47200, '2026-07-21', { recon: 1 })]);
  assert.deepEqual(paid.get('GI26000044'), { date: '2026-07-19', ref: 'BT26000033', how: 'amount', kind: 'transfer' });
});

test('חשבונית פחות זיכוי (GI26000326 = המחאה 57,348 + זיכוי 885) · המחאה דחויה — "הופקה", לפירעון במועדה · המחאה שבוטלה — לא תשלום', () => {
  const { paid } = Paid.matchLedger([
    inv('GI26000326', 58233, '2026-10-15', { recon: 3 }), pay('CH26000122', 57348, '2026-10-15'), pay('CV26000006', 885, '2026-10-15', { recon: 4 }),
    inv('GI2', 5000, '2026-11-01'), pay('CH2', 5000, '2026-12-15'),
    inv('GI3', 7000, '2026-09-01'), pay('CH3', 7000, '2026-09-07'), pay('CH4', -7000, '2026-09-07')
  ], { today: '2026-11-24' });
  assert.deepEqual(paid.get('GI26000326'), { date: '2026-10-15', ref: 'CH26000122, CV26000006', how: 'amount', kind: 'cheque' });
  assert.deepEqual(paid.get('GI2'), { date: '2026-12-15', ref: 'CH2', how: 'amount', kind: 'cheque' }, 'המחאה ל-15.12 — הופקה, לפירעון 15.12');
  assert.equal(paid.has('GI3'), false, 'ההמחאה בוטלה');
});

test('תשלום = העברה (BT) או המחאה (CH) בלבד: פקודת יומן, וזיכוי לבד — לא תשלום; העברה עתידית — עוד לא', () => {
  const { paid, left } = Paid.matchLedger([
    inv('GI1', 1947, '2026-06-01'), pay('478514', 1947, '2026-06-11', { pattern: 'פ' }),
    inv('GI2', 885, '2026-06-01'), pay('CV1', 885, '2026-06-10', { pattern: 'חסז' }),
    inv('GI3', 500, '2026-11-01'), pay('BT3', 500, '2026-12-01')
  ], { today: '2026-11-24' });
  assert.equal(paid.size, 0);
  assert.deepEqual(left, [], 'פקודה וזיכוי אינם "תשלום שלא נקשר"');
  assert.equal(Paid.kindOf({ ivnum: 'CH26000122' }), 'cheque');
  assert.equal(Paid.kindOf({ ivnum: 'BT26000233' }), 'transfer');
  assert.equal(Paid.kindOf({ ivnum: '', ref: 'העברה 26004988' }), 'transfer', "פקודה \"העב' ל…\"");
  assert.equal(Paid.kindOf({ ivnum: '', ref: 'המחאה 26003772' }), 'cheque', 'פקודה "שיק …"');
  assert.equal(Paid.payStatus({ paidAt: '2026-06-04', paymentRef: 'העברה 26004988' }, '2026-11-25').label, 'שולם בהעברה 04.06.26 · העברה 26004988');
});

test('תשלום שהקדים את החשבונית ביותר מ-60 יום — לא נחשב', () => {
  const { paid } = Paid.matchLedger([inv('GI1', 100, '2026-12-15'), pay('BT1', 100, '2026-09-01')]);
  assert.equal(paid.has('GI1'), false);
});

// ---------------------------------------------------------------- מסמך ← GI ← שולם
const row = (ref, o = {}) => {
  const [company, type, docno] = ref.split(':');
  const data = { ref, company, type, docno, date: '2026-10-01', supplier: { code: 'S1', name: 'ספק' }, project: { code: 'P', name: 'פרויקט' },
    amount: 1000, total: 1000, currency: 'ש"ח', payDay: '2026-11-15', owners: o.owners ?? [], people: [], invoices: [], booknum: '1', ...o.data };
  D.run(`INSERT INTO payment_items (ref, org_id, company, type, docno, stage, amount, pay_day, first_pay_day, invoices, data, first_seen, last_seen, stage_at)
    VALUES (?, 1, ?, ?, ?, ?, 1000, ?, ?, ?, ?, ?, ?, ?)`, ref, company, type, docno, o.stage ?? 'open', data.payDay, data.payDay,
  JSON.stringify(o.invoices ?? []), JSON.stringify(data), '2026-10-01', '2026-10-01', '2026-10-01');
};
const get = (ref) => ({ ...D.get('SELECT stage, invoices, paid_at, payment_ref, paid_how FROM payment_items WHERE ref = ?', ref) });
const pool = async (jobs) => { for (const j of jobs) await j(); };

test('resolvePaid: יצא לחשבונית ששולמה — "שולם"; GI שלא שולם — "בחשבונית"; עוד ברשימה ובאותו סכום — "נראה ששולם" בלי לצאת', async (t) => {
  D.run('DELETE FROM payment_items');
  row('a160226:receipt:GR1', { stage: 'gone' });
  row('a160226:receipt:GR2', { stage: 'gone' });
  row('a160226:partial:PC1', { stage: 'gone' });
  row('a160226:partial:PC2', { data: { total: 5000, amount: 5000 } });                     // עוד "אושרה" — שולם באותו סכום
  row('a160226:receipt:GR3');                                                                // עוד ברשימה — לא נוגעים
  Fakes.priority(t, {
    payInvoices: async () => [
      { IVNUM: 'GI10', PIVDOC_SUBFORM: [{ DOCNO: 'GR1' }, { DOCNO: 'PC1' }] },
      { IVNUM: 'GI11', PIVDOC_SUBFORM: [{ DOCNO: 'GR2' }] }
    ],
    payLedger: async () => [inv('GI10', 1500, '2026-10-05', { recon: 3 }), pay('BT9', 1500, '2026-10-20', { recon: 3 }), inv('GI11', 700), pay('BT8', 5000, '2026-10-15')]
  });
  const r = await Paid.resolvePaid(['a160226'], { today: TODAY, pool });
  assert.deepEqual(r.newlyPaid.sort(), ['a160226:partial:PC1', 'a160226:receipt:GR1']);
  assert.deepEqual(get('a160226:receipt:GR1'), { stage: 'paid', invoices: '["GI10"]', paid_at: '2026-10-20', payment_ref: 'BT9', paid_how: 'recon' });
  assert.equal(get('a160226:receipt:GR2').stage, 'invoiced');
  assert.deepEqual(get('a160226:partial:PC2'), { stage: 'open', invoices: '[]', paid_at: '2026-10-15', payment_ref: 'BT8', paid_how: 'guess' });
  assert.equal(get('a160226:receipt:GR3').stage, 'open');
  assert.equal(get('a160226:receipt:GR3').paid_how, '');
});

test('התצוגות: ממתין (עם "נראה ששולם") · בחשבונית · שולם — וגם אקסל עם עמודת "תשלום"', async (t) => {
  D.run('DELETE FROM payment_items');
  Payments._reset();
  const admin = user({ role: 'admin' });
  row('a160226:receipt:GR5', { stage: 'paid' });
  D.run("UPDATE payment_items SET paid_at = '2026-11-20', payment_ref = 'BT1', paid_how = 'recon', invoices = '[\"GI1\"]' WHERE ref = 'a160226:receipt:GR5'");
  row('a160226:receipt:GR6', { stage: 'invoiced', invoices: ['GI2'] });
  row('a160226:receipt:GR7', { stage: 'paid' });
  D.run("UPDATE payment_items SET paid_at = '2026-01-01' WHERE ref = 'a160226:receipt:GR7'");   // לפני 120 יום — לא מוצג
  Fakes.priority(t, { payReceipts: async () => [], payPartials: async () => [], payDeals: async () => [], priorityUsers: async () => [] });
  const paid = await Payments.report(actor(admin), { today: TODAY, view: 'paid' });
  assert.deepEqual(paid.items.map((i) => [i.docno, i.paidAt, i.paymentRef]), [['GR5', '2026-11-20', 'BT1']]);
  assert.deepEqual(paid.runs, [], 'בלי מועדים בתצוגת "שולם"');
  assert.equal(paid.viewCounts.invoiced, 1);
  const invd = await Payments.report(actor(admin), { today: TODAY, view: 'invoiced' });
  assert.deepEqual(invd.items.map((i) => [i.docno, i.invoices]), [['GR6', ['GI2']]]);
  assert.match(Payments.toXlsx(paid).toString('utf8'), /שולם בהעברה 20\.11\.26 · BT1/);
});

// ---------------------------------------------------------------- הודעות
test('"שולם": למי שהעביר, למנהל המחלקה שלו ולמי שבהגדרה למחלקה; פעם אחת; לא על תשלום מלפני ההפעלה', async (t) => {
  D.run('DELETE FROM payment_items');
  const now = new Date().toISOString();
  D.run('INSERT OR IGNORE INTO departments (name, created_at) VALUES (?, ?)', 'תכנון-בדיקה', now);
  const dept = D.get("SELECT id FROM departments WHERE name = 'תכנון-בדיקה'").id;
  const mgr = user({ role: 'manager', department_id: dept });
  D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', mgr.id, dept);
  const worker = user({ role: 'employee', department_id: dept });
  const secretary = user({ role: 'employee' });
  const stranger = user({ role: 'employee' });
  const cur = Settings.defaults();
  t.mock.method(Settings, 'defaults', () => ({ ...cur, paidCc: { [dept]: [secretary.id] } }));
  const mails = [];
  t.mock.method(Mailer, 'isEnabled', () => true);
  t.mock.method(Mailer, 'send', async (m) => { mails.push(m); return {}; });
  D.setSetting(Notify.FROM_KEY, '2026-11-01');

  row('a160226:receipt:GR8', { stage: 'paid', owners: [worker.id] });
  D.run("UPDATE payment_items SET paid_at = '2026-11-20', payment_ref = 'BT7' WHERE ref = 'a160226:receipt:GR8'");
  row('a160226:receipt:GR9', { stage: 'paid', owners: [worker.id] });
  D.run("UPDATE payment_items SET paid_at = '2026-10-01' WHERE ref = 'a160226:receipt:GR9'");   // לפני ההפעלה
  assert.deepEqual(Notify.paidRecipients([worker.id]).sort(), [worker.id, mgr.id, secretary.id].sort());
  assert.equal(await Notify.paid(['a160226:receipt:GR8', 'a160226:receipt:GR9']), 1);
  const to = mails.map((m) => m.toName).sort();
  assert.deepEqual(to, [worker.full_name, mgr.full_name, secretary.full_name].sort());
  assert.equal(to.includes(stranger.full_name), false);
  assert.match(mails[0].subject, /שולם/);
  assert.equal(await Notify.paid(['a160226:receipt:GR8']), 0, 'פעם אחת');
  D.setSetting(Notify.FROM_KEY, null);
});

test('"לא שולם ב-15": בימים 16–20, רק למי שהעביר, פעם אחת למועד; לא על חשבון הסבה ולא על "נראה ששולם"', async (t) => {
  D.run('DELETE FROM payment_items');
  const a = user({ role: 'employee' });
  const mails = [];
  t.mock.method(Mailer, 'isEnabled', () => true);
  t.mock.method(Mailer, 'send', async (m) => { mails.push(m); return {}; });
  D.setSetting(Notify.FROM_KEY, '2026-11-01');
  row('a160226:receipt:GR10', { owners: [a.id], data: { payDay: '2026-12-15' } });
  row('a160226:partial:PC10', { owners: [a.id], data: { payDay: '2026-12-15', project: { code: 'X', name: 'הסבה — רחוב הרצל' } } });
  row('a160226:partial:PC11', { owners: [a.id], data: { payDay: '2026-12-15' } });
  D.run("UPDATE payment_items SET paid_how = 'guess' WHERE ref = 'a160226:partial:PC11'");
  assert.equal(await Notify.unpaid({ today: '2026-12-14' }), 0, 'לפני ה-16');
  assert.equal(await Notify.unpaid({ today: '2026-12-16' }), 1);
  assert.deepEqual(mails.map((m) => m.toName), [a.full_name]);
  assert.match(mails[0].subject, /לא שולם ב-15\.12\.2026/);
  assert.equal(await Notify.unpaid({ today: '2026-12-17' }), 0, 'פעם אחת למועד');
  assert.equal(await Notify.unpaid({ today: '2026-12-25' }), 0, 'אחרי ה-20 — לא');
  D.setSetting(Notify.FROM_KEY, null);
});

test('הגדרות: "מי עוד מקבל שולם" — מחלקה קיימת ומשתמשים פעילים בלבד', () => {
  const u = user({ role: 'employee' });
  const now = new Date().toISOString();
  D.run('INSERT OR IGNORE INTO departments (name, created_at) VALUES (?, ?)', 'מזכירות-בדיקה', now);
  const dept = D.get("SELECT id FROM departments WHERE name = 'מזכירות-בדיקה'").id;
  const s = Settings.save({ defaults: { paidCc: { [dept]: [u.id] } } });
  assert.deepEqual(s.defaults.paidCc, { [dept]: [u.id] });
  assert.ok(s.departments.some((d) => d.id === dept));
  assert.throws(() => Settings.save({ defaults: { paidCc: { 999999: [u.id] } } }), /מחלקה/);
  assert.throws(() => Settings.save({ defaults: { paidCc: { [dept]: [999999] } } }), /משתמש/);
  Settings.save({ defaults: { paidCc: {} } });
});

test('איך שולם: העברה · המחאה הופקה (לפירעון) · המחאה נפרעה', () => {
  const T = '2026-11-25';
  assert.deepEqual(Paid.payStatus({ paidAt: '2026-11-20', paymentRef: 'BT26000376' }, T), { kind: 'transfer', label: 'שולם בהעברה 20.11.26 · BT26000376' });
  assert.deepEqual(Paid.payStatus({ paidAt: '2026-12-15', paymentRef: 'CH26000071' }, T), { kind: 'cheque-issued', label: 'המחאה הופקה CH26000071 · לפירעון 15.12.26' });
  assert.deepEqual(Paid.payStatus({ paidAt: '2026-10-15', paymentRef: 'CH26000122, CV26000006' }, T), { kind: 'cheque-cleared', label: 'המחאה נפרעה 15.10.26 · CH26000122' });
  assert.equal(Paid.payStatus({}, T).kind, '');
});

test('"לא שולם ב-15" — גם על מה שכבר בחשבונית ועוד לא שולם', async (t) => {
  D.run('DELETE FROM payment_items');
  const a = user({ role: 'employee' });
  const mails = [];
  t.mock.method(Mailer, 'isEnabled', () => true);
  t.mock.method(Mailer, 'send', async (m) => { mails.push(m); return {}; });
  D.setSetting(Notify.FROM_KEY, '2026-11-01');
  row('a160226:receipt:GR20', { stage: 'invoiced', owners: [a.id], invoices: ['GI9'], data: { payDay: '2026-12-15' } });
  row('a160226:receipt:GR21', { stage: 'paid', owners: [a.id], data: { payDay: '2026-12-15' } });
  assert.equal(await Notify.unpaid({ today: '2026-12-16' }), 1);
  assert.match(mails[0].text, /GR20/);
  D.setSetting(Notify.FROM_KEY, null);
});

test('לפי ספק: חשבוניות 6 חודשים — שולמה (במה) / פתוחה / באיחור, ותשלומים עם מה שסגרו; רק להנהלה ולכספים', async (t) => {
  const admin = user({ role: 'admin' });
  const worker = user({ role: 'employee' });
  let asked = null;
  Fakes.priority(t, {
    payInvoices: async (c, since, o) => { asked = { since, ...o }; return [
      { IVNUM: 'GI1', IVDATE: '2026-09-01T00:00:00Z', TOTPRICE: 1000, PAYDATE: '2026-10-15T00:00:00Z', PIVDOC_SUBFORM: [{ DOCNO: 'GR1' }] },
      { IVNUM: 'GI2', IVDATE: '2026-10-01T00:00:00Z', TOTPRICE: 500, PAYDATE: '2026-11-15T00:00:00Z', PIVDOC_SUBFORM: [] },
      { IVNUM: 'GI3', IVDATE: '2026-11-01T00:00:00Z', TOTPRICE: 300, PAYDATE: '2026-12-15T00:00:00Z', PIVDOC_SUBFORM: [] }
    ]; },
    payLedger: async () => [inv('GI1', 1000, '2026-09-01'), pay('BT1', 1000, '2026-10-10'), inv('GI2', 500, '2026-10-01'), inv('GI3', 300, '2026-11-01'), pay('CH1', 300, '2026-12-15')],
    supplierByCode: async () => ({ SUPDES: 'ספק בדיקה' })
  });
  const h = await Payments.supplierHistory(actor(admin), { company: 'a160226', supplier: 'S1', today: '2026-11-25' });
  assert.equal(asked.supplier, 'S1');
  assert.equal(h.since, '2026-05-25', '6 חודשים');
  const by = Object.fromEntries(h.invoices.map((i) => [i.ivnum, i]));
  assert.equal(by.GI1.payKind, 'transfer');
  assert.deepEqual(by.GI1.docs, ['GR1']);
  assert.equal(by.GI2.paid, false);
  assert.equal(by.GI2.late, true, 'מועד 15.11 עבר');
  assert.equal(by.GI3.payKind, 'cheque-issued', 'המחאה ל-15.12 — הופקה');
  assert.deepEqual(h.payments.map((p) => [p.ref, p.invoices]), [['CH1', ['GI3']], ['BT1', ['GI1']]]);
  assert.deepEqual(h.totals, { open: 500, openCount: 1, paid: 1300, payments: 1300 });
  await assert.rejects(() => Payments.supplierHistory(actor(worker), { company: 'a160226', supplier: 'S1' }), /כספים/);
});
