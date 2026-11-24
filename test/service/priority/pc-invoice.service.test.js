'use strict';
/**
 * 🧾 חוזה ← חשבון חלקי ← חשבונית ספק, מקצה לקצה — מהמסך של משימון פריוריטי (‎supplier-invoice.js‎ ← ‎pc-invoice.js‎).
 * הוחלט 24.11.26: חשבונית ספק — רק באתר; בבוט כל מסמך הוא קבלת סחורה.
 * המקרה האמיתי (24.11.26): חשבונית 01/000807 של סלע ס.ט תשתיות על 609,317 ₪ לפני מע"מ, והחשבון החלקי PC260000262
 * מתוך החוזה CO260000102: 609,317.10 פחות עכבון 5% (30,465.86) = 578,851.24 — הספק לא קיזז עכבון.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Access = require('../../../server/priority/priority-access');
const PcInvoice = require('../../../server/priority/pc-invoice');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

/** חשבונית המס של הספק כפי שה-AI קורא אותה */
function invoice(o = {}) {
  return {
    doc_type: 'invoice', doc_label: 'חשבונית מס', recipient_name: 'אשל הירדן יזום ובנין', recipient_vat: '512061185', other_ids: [],
    supplier_name: 'סלע ס.ט תשתיות', supplier_vat: '515431138', doc_number: '01/000807', po_number: '', supplier_order_ref: '',
    date: '2026-10-31', doc_date: '2026-10-31', delivery_place: '', project_hint: 'הפסגה הירוקה רכסים', purchase_type: 'site',
    lines: [{ description: 'חשבון חלקי 1 - אתר הפסגה הירוקה - רכסים - חודש ביצוע 09.26', supplier_code: '0', qty: 1, unit: '', unit_price: 609317, discount_pct: 0, line_total: 609317, handwritten: '', unclear: false, options: [] }],
    totals: { subtotal: 609317, doc_discount_pct: 0, doc_discount: 0.03, before_vat: 609317.03, vat: 109677.07, total: 718994.10 },
    allocation_number: '320727438', contract_refs: [], warnings: [],
    ...o
  };
}

const PC = (o = {}) => ({
  DOCNO: 'PC260000262', ORDNAME: 'CO260000102', SUPNAME: '615142', CDES: 'סלע ס.ט תשתיות בע"מ', CURDATE: '2026-09-30', STATDES: 'סופית', IVALL: 'N',
  PROJDOCNO: 'PR26000019', PROJDES: "הפסגה הירוקה א'", MED_QPRICE: 578851.24, DISPRICE: 578851.24, VAT: 104193.22, TOTPRICE: 683044.46,
  MED_DOCTOTPRICE: 609317.1, MED_PAYDES: 'ש45', MED_EXEMONTH: '09/26',
  retention: [{ PERCENT: 5, RETDES: 'עכבון לפי חוזה', QPRICE: 30465.86, QPRICE_PREV: 0, QPRICE_TO: 30465.86 }],
  approvers: [{ USERNAME: 'גולן ברזילי', USERLOGIN: 'GolanB', ALTUSERLOGIN: 'GiladK', UFLAG: 'Y' }, { USERNAME: 'גילעד קוגלמן', USERLOGIN: 'GiladK', ALTUSERLOGIN: 'AlexO', UFLAG: null }],
  ...o
});

/** פריוריטי: ספק אחד, חשבון חלקי אחד; החשבונית שנקלטת — לפי מה שנמשך ומה שאופס */
function priority(t, { pc = PC(), open = null } = {}) {
  const state = { pc, retZero: false };
  const pr = H.Fakes.priority(t, {
    findSuppliers: async () => ({ list: [{ SUPNAME: '615142', SUPDES: 'סלע ס.ט תשתיות בע"מ' }], by: 'vat' }),
    findReceiptByBooknum: async () => null,
    receiptsToInvoice: async () => [],
    receiptLines: async () => [],
    partialBillLines: async () => [{ MED_SECDES: 'חפירה ופינוי', TQUANT: 20310.57, MED_PRICE: 30, MED_CQPRICE_BD: 609317.1 }, { MED_SECDES: 'עכבון לפי חוזה', TQUANT: 1, MED_PRICE: -30465.86, MED_CQPRICE_BD: -30465.86 }],
    partialBills: async () => open ?? (state.pc.IVALL === 'Y' || state.pc.STATDES === 'מבוטלת' ? [] : [state.pc]),
    readPartialBill: async (c, no) => (no === state.pc.DOCNO ? state.pc : null),
    partialBillStatus: async (c, no) => (no === state.pc.DOCNO ? { DOCNO: no, STATDES: state.pc.STATDES, IVALL: state.pc.IVALL } : null),
    findInvoiceByBooknum: async () => null,
    readSupplierInvoice: async (c, ivnum) => {
      const ret = state.retZero ? 0 : -30465.86;
      const net = 609317.1 + ret;
      return { IVNUM: ivnum, DISPRICE: net, QPRICE: net, VAT: Math.round(net * 18) / 100, TOTPRICE: Math.round(net * 118) / 100,
        lines: [{ KLINE: 2, PARTNAME: '710', MED_SECDES: 'חפירה ופינוי', QPRICE: 609317.1, PRICE: 30 }, { KLINE: 9, PARTNAME: '708', MED_SECDES: 'עכבון', TQUANT: 1, PRICE: ret, QPRICE: ret }] };
    }
  }, {
    writes: {
      createSupplierInvoice: async () => 'T501',
      setInvoiceLine: async (c, iv, kline, f) => { if (kline === 9 && f.PRICE === 0) state.retZero = true; return {}; }
    }
  });
  return { ...pr, state };
}

const ai = (t, d) => H.claude(t, { extract: () => d });

/** עובד שמורשה לחשבוניות ספק (וגם לקבלת סחורה) */
function accountant() {
  const u = H.worker();
  Access.save([{ id: u.id, docs: ['receipt', 'invoice'], companies: null }]);
  return u;
}

test('חשבון סופי והספק לא קיזז עכבון: מתריע, "עכבון בחשבון הבא" ← חשבונית זמנית כמו של הספק, העכבון נרשם לחשבון הבא', async (t) => {
  H.companies(t, 'test11');
  const u = accountant();
  const pr = priority(t);
  ai(t, invoice());
  const { open, say } = H.desk(u, 'invoice');

  let r = await open();
  assert.match(r.text, /חשבונית ספק מחשבון חלקי/);
  assert.match(r.text, /PC260000262/);
  assert.match(r.text, /CO260000102/);
  assert.match(r.text, /הספק לא קיזז עכבון/);
  assert.match(r.text, /30,465\.86/);
  assert.doesNotMatch(r.text, /אין מספר הקצאה/);
  H.assertButtons(r.buttons, [PcInvoice.BTN_DEFER, PcInvoice.BTN_NOW, BTN.cancel]);
  assert.equal(pr.writes.length, 0, 'לפני התשובה — שום דבר לא נכתב');

  r = await say(PcInvoice.BTN_DEFER);
  assert.match(r.text, /T501/);
  assert.match(r.text, /כמו חשבונית הספק/);
  assert.match(r.text, /נרשם לקיזוז בחשבון הבא/);
  const [create] = pr.wrote('createSupplierInvoice');
  assert.equal(create.args[0], 'test11');
  assert.deepEqual({ ...create.args[1], details: undefined }, { supname: '615142', booknum: '01/000807', date: '2026-10-31', allocation: '320727438', details: undefined });
  assert.deepEqual(pr.wrote('addInvoiceReceipt')[0].args, ['test11', 'T501', 'PC260000262']);
  assert.deepEqual(pr.wrote('setInvoiceLine')[0].args, ['test11', 'T501', 9, { PRICE: 0 }]);
  assert.equal(pr.wrote('attachInvoice').length, 1);
  assert.match(pr.wrote('setInvoiceDialog')[0].args[2].join('\n'), /יקוזז בחשבון הבא של החוזה CO260000102/);
  assert.equal(PcInvoice.deferred().filter((x) => x.pc === 'PC260000262').length, 1);
  assert.equal(r.state.active, false, 'הקליטה הסתיימה');
});

test('החשבון הבא של אותו חוזה: מזכירים את העכבון שנדחה, ואחרי ההמרה — נרשם שקוזז', async (t) => {
  H.companies(t, 'test11');
  const u = accountant();
  const pc2 = PC({ DOCNO: 'PC260000300', MED_QPRICE: 95000, DISPRICE: 95000, VAT: 17100, TOTPRICE: 112100, MED_EXEMONTH: '10/26', retention: [{ PERCENT: 5, QPRICE: 5000 }] });
  priority(t, { pc: pc2 });
  ai(t, invoice({ doc_number: '01/000900', totals: { subtotal: 95000, doc_discount_pct: 0, doc_discount: 0, before_vat: 95000, vat: 17100, total: 112100 } }));
  const { open, say } = H.desk(u, 'invoice');
  let r = await open();
  assert.match(r.text, /עכבון שנדחה מ-PC260000262/);
  assert.match(r.text, /✅ הסכומים מתאימים/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
  r = await say('👍');
  assert.match(r.text, /T501/);
  assert.equal(PcInvoice.deferred().filter((x) => x.pc === 'PC260000262').length, 0, 'העכבון שנדחה סומן כמקוזז');
});

test('ביטול לפני ההמרה — בלי כתיבה', async (t) => {
  H.companies(t, 'test11');
  const u = accountant();
  const pr = priority(t);
  ai(t, invoice());
  const { open, say } = H.desk(u, 'invoice');
  await open();
  const r = await say(BTN.cancel);
  assert.match(r.text, /בוטלה/);
  assert.equal(pr.writes.length, 0);
});

test('בבוט: חשבונית של קבלן משנה — קבלת סחורה (גם למי שמורשה לחשבוניות ספק), בלי חשבון חלקי', async (t) => {
  H.companies(t, 'test11');
  H.at(t);
  const u = accountant();
  priority(t);
  t.mock.method(require('../../../server/integrations/priority'), 'openOrders', async () => []);
  ai(t, invoice());
  const { say } = H.chat(t, u);
  await say('', { file: H.photo() });
  const r = await say(BTN.yes);
  assert.match(r.text, /קבלת סחורה\* — חשבונית 01\/000807/);
  assert.doesNotMatch(r.text, /חשבון חלקי/);
});

test('השוואה: עיגול, עכבון שלא קוזז, פער אחר', () => {
  const a = PcInvoice._amountsOf(PC());
  assert.deepEqual(a, { net: 578851.24, retention: 30465.86, pct: 5, gross: 609317.1, vat: 104193.22, total: 683044.46 });
  assert.equal(PcInvoice._compare(578851.5, a).kind, 'match');
  assert.equal(PcInvoice._compare(609317.03, a).kind, 'retention');
  assert.equal(PcInvoice._compare(500000, a).kind, 'gap');
  assert.equal(PcInvoice._compare(0, a).kind, 'unknown');
});
