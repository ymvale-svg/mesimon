'use strict';
/**
 * 💰 רשימת התשלומים ל-15 (‎server/priority/payments.js‎; "אפיון — רשימת תשלומים ל-15.md"):
 * חישוב ה-15, שלושת המסמכים במבנה אחד (קבלה שחויבה בחלקה — רק היתרה), מי רואה מה, סינון וסכומים,
 * ומעקב אחרי חוב שיצא מהרשימה (מוכן לשלב 2 — "שולם").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Payments = require('../../../server/priority/payments');
const Access = require('../../../server/priority/priority-access');
const Docs = require('../../../server/priority/priority-docs');

boot();
const TODAY = '2026-11-24';          // ה-15 הקרוב: 15.12.26
const actor = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
const reset = () => { Payments._reset(); D.run('DELETE FROM payment_items'); };

// ---------------------------------------------------------------- מסמכים מזויפים
const gr = (docno, o = {}) => ({
  DOCNO: docno, CURDATE: '2026-10-06T00:00:00Z', SUPNAME: '601709', CDES: 'אפקון', BOOKNUM: '77', PROJDOCNO: 'PR1', PROJDES: 'יוקנעם',
  QPRICE: 1000, PERCENT: 0, DISPRICE: 1000, VAT: 180, TOTPRICE: 1180, CODE: 'ש"ח', MED_MXPAYCODE: '04', USERLOGIN: 'RavivK', OWNERLOGIN: 'RavivK',
  TRANSORDER_P_SUBFORM: [{ KLINE: 1, QPRICE: 1000, IVNUM: null }], ...o
});
const pc = (docno, o = {}) => ({ DOCNO: docno, CURDATE: '2026-10-31T00:00:00Z', SUPNAME: '619027', CDES: 'קום אדריכלים', ORDNAME: 'CO1',
  BOOKNUM: '5', PROJDOCNO: 'PR2', PROJDES: 'ביאליק', TOTPRICE: 6619.8, CODE: 'ש"ח', MED_PAYCODE: '05', USERLOGIN: 'GiladK', OWNERLOGIN: 'RavivK', ...o });
const deal = (ivnum, o = {}) => ({ IVNUM: ivnum, IVDATE: '2026-08-20T00:00:00Z', SUPNAME: '617066', SUPDES: 'עו"ד פולק', BOOKNUM: '1012',
  PROJDOCNO: 'PR2', PROJDES: 'ביאליק', TOTPRICE: 1888, CODE: 'ש"ח', PAYDATE: '2026-10-15T00:00:00Z', OWNERLOGIN: 'RavivK', ...o });

/** פריוריטי מזויף: ‎data[company] = { receipt: [...], partial: [...], deal: [...] }‎; ‎fail‎ — חברות שהקריאה מהן נכשלת */
function fake(t, data, { fail = [], status = {} } = {}) {
  const of = (k) => async (c) => { if (fail.includes(c)) throw new Error('אין חיבור'); return data[c]?.[k] ?? []; };
  return Fakes.priority(t, {
    payReceipts: of('receipt'), payPartials: of('partial'), payDeals: of('deal'),
    payDocStatus: async (c, type, docno) => status[`${c}:${type}:${docno}`] ?? null,
    priorityUsers: async () => [{ USERLOGIN: 'RavivK', SNAME: 'רביב ק' }, { USERLOGIN: 'GiladK', SNAME: 'גלעד ק' }]
  });
}

// ---------------------------------------------------------------- חישוב ה-15
test('מועד התשלום: ה-15 הראשון אחרי סוף החודש + ימי התנאי (הטבלה מהאפיון, מסמך מאוקטובר)', () => {
  const P = require('../../../server/integrations/priority');
  const day = (code) => Payments.payDay(P.dueDate(code, '2026-10-06'));
  assert.equal(day('01'), '2026-11-15', 'שוטף: 31.10 ← 15.11');
  assert.equal(day('03'), '2026-12-15', 'שוטף + 30: 30.11 ← 15.12');
  assert.equal(day('04'), '2026-12-15', 'שוטף + 45: 15.12 בדיוק');
  assert.equal(day('05'), '2027-01-15', 'שוטף + 60: 30.12 ← 15.01, מעבר שנה');
  assert.equal(Payments.payDay(P.dueDate('02', '2026-02-10')), '2026-03-15', 'פברואר: 28.02 + 15 = 15.03');
  assert.equal(Payments.payDay('2026-12-16'), '2027-01-15');
  assert.equal(Payments.payDay(''), '');
});

test('המועד הקרוב והחלוקה: באיחור · כל חודש לחוד · חסר תנאי', () => {
  assert.equal(Payments.nextRun('2026-11-24'), '2026-12-15');
  assert.equal(Payments.nextRun('2026-12-15'), '2026-12-15', 'ב-15 עצמו — היום');
  const run = '2026-12-15';
  assert.equal(Payments.bucketOf('2026-11-15', run), 'late');
  assert.equal(Payments.bucketOf('2026-12-15', run), '2026-12-15');
  assert.equal(Payments.bucketOf('2027-06-15', run), '2027-06-15', 'כל חודש — בלי גבול');
  assert.equal(Payments.bucketOf('', run), 'none');
});

// ---------------------------------------------------------------- המבנה האחיד
test('קבלת סחורה: בלי חשבונית — כל הסכום; חלק בחשבונית — רק השורות הפתוחות (אחרי הנחה, עם מע״מ); הכל בחשבונית — לא נכנסת', () => {
  const full = Payments.fromReceipt(gr('GR1'), 'a160226');
  assert.equal(full.ref, 'a160226:receipt:GR1');
  assert.equal(full.amount, 1180);
  assert.equal(full.payDay, '2026-12-15', 'שוטף + 45 מ-06.10');
  assert.equal(full.partialInvoiced, false);

  // GR26000218 מהאפיון: ביקור טכנאי 500 בלי חשבונית; מטענים ומשלוח ב-GI26000322
  const part = Payments.fromReceipt(gr('GR26000218', {
    QPRICE: 10350, DISPRICE: 10350, VAT: 1863, TOTPRICE: 12213,
    TRANSORDER_P_SUBFORM: [{ KLINE: 1, QPRICE: 500, IVNUM: null }, { KLINE: 2, QPRICE: 9500, IVNUM: 'GI26000322' }, { KLINE: 3, QPRICE: 350, IVNUM: 'GI26000322' }]
  }), 'a160226');
  assert.equal(part.amount, 590, '500 + 18% מע״מ');
  assert.equal(part.total, 12213);
  assert.deepEqual(part.invoices, ['GI26000322']);
  assert.equal(part.partialInvoiced, true);

  const disc = Payments.fromReceipt(gr('GR2', { PERCENT: 10, DISPRICE: 900, VAT: 162,
    TRANSORDER_P_SUBFORM: [{ QPRICE: 400, IVNUM: null }, { QPRICE: 600, IVNUM: 'GI1' }] }), 'a160226');
  assert.equal(disc.amount, 424.8, '400 − 10% = 360, + 18%');

  assert.equal(Payments.fromReceipt(gr('GR3', { TRANSORDER_P_SUBFORM: [{ QPRICE: 1000, IVNUM: 'GI2' }] }), 'a160226'), null);
});

test('חשבון חלקי — מתאריך החשבון ולפי התנאי; חשבון עסקה — לפי PAYDATE של פריוריטי; בלי תנאי — בלי מועד', () => {
  const p = Payments.fromPartial(pc('PC1'), 'a160226');
  assert.equal(p.payDay, '2027-01-15', 'שוטף + 60 מ-31.10');
  assert.equal(p.contract, 'CO1');
  assert.deepEqual(p.people, ['GiladK', 'RavivK']);
  const d = Payments.fromDeal(deal('T13'), 'a160226');
  assert.equal(d.payDay, '2026-10-15');
  assert.equal(d.supplier.name, 'עו"ד פולק');
  assert.equal(Payments.fromPartial(pc('PC2', { MED_PAYCODE: null }), 'a160226').payDay, '');
});

// ---------------------------------------------------------------- מי רואה מה
test('מורשה "תשלומים" — הכל בחברות שלו; עובד אחר — רק מה שיזם (בפריוריטי או דרך הבוט)', async (t) => {
  reset();
  fake(t, {
    a160226: { receipt: [gr('GR10'), gr('GR11', { USERLOGIN: 'API VPLANS', OWNERLOGIN: 'API VPLANS' })], partial: [pc('PC10')], deal: [deal('T10')] },
    elad1: { receipt: [gr('GR20', { USERLOGIN: 'Other', OWNERLOGIN: 'Other' }), gr('GR21', { USERLOGIN: 'API VPLANS', OWNERLOGIN: 'API VPLANS' })] }
  });
  const admin = user({ role: 'admin' });
  const acct = user({ role: 'employee' });
  Access.save([{ id: acct.id, docs: ['payments'], companies: ['elad1'] }]);
  const raviv = user({ role: 'employee' });
  D.setSetting('priority_user_map', { RavivK: raviv.id });
  const botUser = user({ role: 'employee' });
  Docs.upload(botUser, { doc: 'receipt', filename: 'x.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\n').toString('base64') });
  D.run("UPDATE priority_docs SET docno = 'GR11', company = 'a160226' WHERE user_id = ?", botUser.id);

  const all = await Payments.report(actor(admin), { today: TODAY });
  assert.equal(all.scope, 'all');
  assert.deepEqual(all.items.map((i) => i.docno).sort(), ['GR10', 'GR11', 'GR20', 'GR21', 'PC10', 'T10']);
  assert.equal(all.items.find((i) => i.docno === 'GR21').initiatorName, 'הבוט', 'נקלט בבוט לפני שהשרשרת רשמה מי');
  assert.equal(all.items.find((i) => i.docno === 'GR11').initiatorName, botUser.full_name, 'נפתח בבוט — שם העובד, לא משתמש ה-API');
  assert.equal(all.items.find((i) => i.docno === 'GR10').initiatorName, 'רביב ק');
  assert.equal(all.items.find((i) => i.docno === 'GR20').initiatorName, 'Other', 'לא מוכר — שם המשתמש בפריוריטי');

  const a = await Payments.report(actor(acct), { today: TODAY });
  assert.deepEqual(a.items.map((i) => i.docno).sort(), ['GR20', 'GR21'], 'רק החברות שלו');

  const r = await Payments.report(actor(raviv), { today: TODAY });
  assert.equal(r.scope, 'mine');
  assert.deepEqual(r.items.map((i) => i.docno).sort(), ['GR10', 'PC10', 'T10'], 'יוזם או בעלים בפריוריטי');
  const b = await Payments.report(actor(botUser), { today: TODAY });
  assert.deepEqual(b.items.map((i) => i.docno), ['GR11'], 'מה שקלט בבוט');
  assert.deepEqual(b.errors, [], 'פרטים טכניים — רק למורשה');
  D.setSetting('priority_user_map', {});
});

test('סינון, מועדים וסכומים: לכל מועד מספר ושקלים; מטבע זר — בנפרד; לפי ספק', async (t) => {
  reset();
  fake(t, { a160226: {
    receipt: [gr('GR30'), gr('GR31', { CURDATE: '2026-09-01T00:00:00Z' }), gr('GR32', { CODE: '$', TOTPRICE: 100 }), gr('GR33', { MED_MXPAYCODE: '06', CURDATE: '2026-11-20T00:00:00Z' })],
    partial: [pc('PC30'), pc('PC31', { MED_PAYCODE: null })]
  } });
  const admin = user({ role: 'admin' });
  const r = await Payments.report(actor(admin), { today: TODAY });
  assert.deepEqual(r.runs, ['2026-12-15', '2027-01-15', '2027-02-15', '2027-03-15'], 'שלושת הקרובים, ועוד כל חודש שיש בו תשלום');
  const far = await Payments.report(actor(admin), { today: '2026-09-20' });
  assert.ok(far.runs.includes('2027-01-15'), 'חודש רחוק שיש בו תשלום — מופיע');
  assert.equal(r.byBucket['2026-12-15'].count, 2, 'GR30 ו-GR32');
  assert.equal(r.byBucket['2026-12-15'].ils, 1180);
  assert.deepEqual(r.byBucket['2026-12-15'].other, { $: 100 });
  assert.equal(r.byBucket.late.count, 1, 'GR31 — 15.11 עבר');
  assert.equal(r.byBucket['2027-01-15'].count, 1);
  assert.equal(r.byBucket.none.count, 1, 'חסר תנאי תשלום');
  assert.equal(r.items.length, 6, 'בלי מועד — הכל');
  assert.equal(r.byBucket['2027-03-15'].count, 1, 'שוטף + 90 מ-20.11 — 15.03');

  const r0 = await Payments.report(actor(admin), { today: TODAY, bucket: 'next' });
  assert.equal(r0.bucket, '2026-12-15', 'next — ה-15 הקרוב');
  assert.deepEqual(r0.items.map((i) => i.docno).sort(), ['GR30', 'GR32']);
  assert.equal(r0.totals.suppliers[0].supplier, 'אפקון');
  const onlyPc = await Payments.report(actor(admin), { today: TODAY, type: 'partial' });
  assert.equal(onlyPc.byBucket['2026-12-15'].count, 0, 'הספירה לכל מועד — לפי שאר הסינונים');
  assert.equal(onlyPc.items.length, 2);
  assert.equal((await Payments.report(actor(admin), { today: TODAY, supplier: 'קום' })).items.length, 2);
  assert.equal((await Payments.report(actor(admin), { today: TODAY, project: 'PR1' })).items.length, 4);
  assert.equal(r.items[0].docno, 'GR31', 'מסודר לפי מועד');
});

// ---------------------------------------------------------------- מעקב — מוכן לשלב 2
test('חוב שיצא מהרשימה: נשמר, והשלב מתעדכן לפי פריוריטי (חשבונית / בוטל / שולם); חזר — פתוח שוב', async (t) => {
  reset();
  const admin = user({ role: 'admin' });
  const data = { a160226: { receipt: [gr('GR40'), gr('GR41')], partial: [pc('PC40'), pc('PC41')], deal: [deal('T40')] } };
  fake(t, data);
  await Payments.report(actor(admin), { today: TODAY });
  const stage = (ref) => D.get('SELECT stage FROM payment_items WHERE ref = ?', ref)?.stage;
  assert.equal(stage('a160226:receipt:GR40'), 'open');
  assert.equal(D.get("SELECT first_pay_day FROM payment_items WHERE ref = 'a160226:receipt:GR40'").first_pay_day, '2026-12-15');

  t.mock.restoreAll();
  fake(t, { a160226: { receipt: [gr('GR41')], partial: [], deal: [] } }, { status: {
    'a160226:receipt:GR40': { status: 'סופית', invoiced: true },
    'a160226:partial:PC40': { status: 'שולם', invoiced: false },
    'a160226:partial:PC41': { status: 'מבוטלת', invoiced: false }
  } });
  Payments._reset();
  await Payments.report(actor(admin), { today: TODAY });
  assert.equal(stage('a160226:receipt:GR40'), 'invoiced');
  assert.equal(stage('a160226:partial:PC40'), 'paid', 'חשבון חלקי בסטטוס "שולם"');
  assert.equal(stage('a160226:partial:PC41'), 'cancelled');
  assert.equal(stage('a160226:deal:T40'), 'gone', 'לא ידוע עדיין לאן — נשאר לבדיקה');

  t.mock.restoreAll();
  fake(t, { a160226: { receipt: [gr('GR40'), gr('GR41')] } });
  Payments._reset();
  await Payments.report(actor(admin), { today: TODAY });
  assert.equal(stage('a160226:receipt:GR40'), 'open', 'חזר לרשימה');
});

test('חברה שהקריאה ממנה נכשלה: המסמכים שלה לא "יוצאים", והתקלה מדווחת רק למורשה', async (t) => {
  reset();
  const admin = user({ role: 'admin' });
  fake(t, { elad1: { receipt: [gr('GR50')] } });
  await Payments.report(actor(admin), { today: TODAY });
  t.mock.restoreAll();
  fake(t, {}, { fail: ['elad1'] });
  Payments._reset();
  const r = await Payments.report(actor(admin), { today: TODAY });
  assert.ok(r.errors.some((e) => e.company === 'elad1'));
  assert.equal(D.get("SELECT stage FROM payment_items WHERE ref = 'elad1:receipt:GR50'").stage, 'open');
});

test('נתונים נשמרים בזיכרון; רענון קורא מחדש', async (t) => {
  reset();
  let calls = 0;
  Fakes.priority(t, { payReceipts: async () => { calls += 1; return []; }, payPartials: async () => [], payDeals: async () => [], priorityUsers: async () => [] });
  const admin = user({ role: 'admin' });
  await Payments.report(actor(admin), { today: TODAY });
  const first = calls;
  await Payments.report(actor(admin), { today: TODAY });
  assert.equal(calls, first, 'מהזיכרון');
  await Payments.report(actor(admin), { today: TODAY, refresh: true });
  assert.equal(calls, first, 'רענון — לא יותר מפעם ב-30 שניות');
});

test('ייצוא לאקסל — גיליון "הכל" וגיליון לכל חברה, עם סה"כ', async (t) => {
  reset();
  fake(t, { a160226: { receipt: [gr('GR60')] }, elad1: { receipt: [gr('GR61', { TOTPRICE: 500 })] } });
  const r = await Payments.report(actor(user({ role: 'admin' })), { today: TODAY });
  assert.deepEqual(r.totals.companies.map((c) => [c.company, c.ils]), [['a160226', 1180], ['elad1', 500]]);
  const buf = Payments.toXlsx(r);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const text = buf.toString('utf8');
  assert.match(text, /GR60/);
  assert.equal((text.match(/worksheets\/sheet\d\.xml/g) ?? []).length > 0, true);
  assert.match(text, /sheet3\.xml/, 'הכל + שתי חברות');
  assert.match(text, /1680\.00/, 'סה"כ בגיליון הכל');
  assert.match(text, /לפי חברה/);
});

test('"תשלומים" הוא דוח — אי אפשר להעלות אליו מסמך', () => {
  const u = user({ role: 'admin' });
  assert.throws(() => Docs.upload(u, { doc: 'payments', filename: 'x.pdf', mime: 'application/pdf', data: 'JVBERg==' }), /סוג מסמך לא מוכר/);
});

test('מחלקת כספים / הנהלת חשבונות (וגם תת-מחלקה): כל התשלומים בכל החברות — גם כשבמטריצה סומנו חברות אחרות', async (t) => {
  reset();
  fake(t, { a160226: { receipt: [gr('GR70', { USERLOGIN: 'X', OWNERLOGIN: 'X' })] }, elad1: { receipt: [gr('GR71', { USERLOGIN: 'X', OWNERLOGIN: 'X' })] } });
  const now = new Date().toISOString();
  const dept = (name, parent = null) => {
    D.run('INSERT OR IGNORE INTO departments (name, created_at) VALUES (?, ?)', name, now);
    const id = D.get('SELECT id FROM departments WHERE name = ?', name).id;
    if (parent) D.run('UPDATE departments SET parent_id = ? WHERE id = ?', parent, id);
    return id;
  };
  const fin = dept('כספים');
  const acct = dept('הנהלת חשבונות', fin);
  const eng = dept('הנדסה וביצוע');
  const a = user({ role: 'employee', department_id: fin });
  const b = user({ role: 'employee', department_id: acct });
  const c = user({ role: 'employee', department: 'הנה"ח' });
  const e = user({ role: 'employee', department_id: eng });
  Access.save([{ id: b.id, docs: ['receipt'], companies: ['elad1'] }]);

  for (const u of [a, b, c]) {
    assert.equal(Access.isFinance(u), true, u.full_name);
    const r = await Payments.report(actor(u), { today: TODAY });
    assert.equal(r.scope, 'all');
    assert.deepEqual(r.items.map((i) => i.docno).sort(), ['GR70', 'GR71'], 'כל החברות');
  }
  assert.equal(Access.matrix().users.find((x) => x.id === b.id).finance, true, 'במטריצה — מסומן ונעול');
  assert.equal(Access.isFinance(e), false);
  const r = await Payments.report(actor(e), { today: TODAY });
  assert.equal(r.scope, 'mine');
  assert.deepEqual(r.items, [], 'עובד הנדסה — רק מה שיזם');
});
