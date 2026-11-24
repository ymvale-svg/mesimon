'use strict';
/**
 * 🧾 חשבונית ספק מקצה לקצה — מהמסך של משימון פריוריטי (‎priority-desk.js‎ ← ‎supplier-invoice.js‎), ה-AI ופריוריטי מזויפים.
 * הוחלט 24.11.26: חשבונית ספק — רק באתר. בבוט כל מסמך הוא קבלת סחורה.
 * המקרה האמיתי: חשבונית מס 10288 של "הרמן עיצוב וניהול פרויקטים" לרבץ רכסים, על GR26000033 — שנקלט על חשבונית העסקה 90016.
 * בודק: הבסיס נבחר לפי השורות (GR או חשבון חלקי), כפתורים, שום כתיבה לפני "כן", מה נכתב אחרי "כן", כפילות, אין בסיס, בחירה, ביטול.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Access = require('../../../server/priority/priority-access');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

/** עובד הנהלת חשבונות — חשבונית ספק במטריצה */
function accountant(docs = ['invoice']) {
  const u = H.worker();
  Access.save([{ id: u.id, docs, companies: null }]);
  return u;
}

/** החשבונית כפי שה-AI קורא אותה */
const invoice = (o = {}) => ({
  doc_type: 'invoice', doc_label: 'חשבונית מס', recipient_name: 'רבץ רכסים בע"מ', recipient_vat: '516941705', other_ids: [],
  supplier_name: 'הרמן עיצוב וניהול פרויקטים', supplier_vat: '021792445', doc_number: '10288', po_number: '', supplier_order_ref: '',
  date: '2026-11-18', doc_date: '2026-11-18', delivery_place: '', project_hint: '', purchase_type: 'office',
  lines: [{ description: 'עיצוב משרד מכירות רכסים', supplier_code: '', qty: 1, unit: '', unit_price: 3000, discount_pct: 0, line_total: 3000, handwritten: '', unclear: false, options: [] }],
  totals: { subtotal: 3000, doc_discount_pct: 0, doc_discount: 0, before_vat: 3000, vat: 540, total: 3540 },
  allocation_number: '', contract_refs: [], blank_area: { x: 0, y: 0, w: 0, h: 0 }, warnings: [], ...o
});
const GR33 = { DOCNO: 'GR26000033', BOOKNUM: '90016', CURDATE: '2026-09-27T00:00:00Z', ORDNAME: null, PROJDOCNO: 'PR26000008', PROJDES: 'הפסגה הירוקה', DISPRICE: 3000, VAT: 540, TOTPRICE: 3540 };
const GR40 = { DOCNO: 'GR26000040', BOOKNUM: '777', CURDATE: '2026-10-01T00:00:00Z', ORDNAME: null, PROJDOCNO: 'PR26000008', PROJDES: 'הפסגה הירוקה', DISPRICE: 1250, VAT: 225, TOTPRICE: 1475 };
const LINES = {
  GR26000033: [{ KLINE: 1, PDES: 'משרד מכירות- עיצוב משרד רכסים', TQUANT: 1, PRICE: 3000, QPRICE: 3000 }],
  GR26000040: [{ KLINE: 1, PDES: 'הדמיות', TQUANT: 5, PRICE: 250, QPRICE: 1250 }]
};

function priority(t, { receipts = [GR33, GR40], dup = null, pcs = [], pcLines = {}, lines = LINES } = {}) {
  return H.Fakes.priority(t, {
    findSuppliers: async () => ({ list: [{ SUPNAME: '621259', SUPDES: 'הרמן עיצוב וניהול פרויקטים' }], by: 'vat' }),
    findInvoiceByBooknum: async () => dup,
    receiptsToInvoice: async () => receipts,
    receiptLines: async (c, docno) => lines[docno] ?? [],
    partialBills: async () => pcs,
    partialBillLines: async (c, docno) => pcLines[docno] ?? [],
    readPartialBill: async (c, docno) => pcs.find((x) => x.DOCNO === docno) ?? null,
    partialBillStatus: async (c, docno) => { const x = pcs.find((y) => y.DOCNO === docno); return x ? { DOCNO: docno, STATDES: x.STATDES, IVALL: x.IVALL } : null; },
    readSupplierInvoice: async (c, iv) => ({ IVNUM: iv, DISPRICE: 3000, VAT: 540, TOTPRICE: 3540, lines: [], receipts: [] }),
    readReceipt: async () => ({ lines: [] })
  }, { writes: { createSupplierInvoice: async () => 'T10', attachInvoice: async () => 1 } });
}
const ai = (t, d = invoice()) => H.claude(t, { extract: () => d });

test('חשבונית מס על GR שנקלט על חשבונית העסקה: נמצא לפי השורות, סיכום בכפתורים, "כן ✅" ← חשבונית זמנית שמושכת את ה-GR', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const pr = priority(t);
  ai(t);
  const { open, say } = H.desk(u, 'invoice');

  let r = await open();
  assert.match(r.text, /רבץ רכסים/);
  assert.match(r.text, /הרמן עיצוב וניהול פרויקטים \(621259\)/);
  assert.match(r.text, /חשבונית מס 10288 מ-18\.11\.2026/);
  assert.match(r.text, /GR26000033\* \(מסמך 90016\)/);
  assert.match(r.text, /לפי השורות/);
  assert.match(r.text, /✅ תואם/);
  assert.doesNotMatch(r.text, /GR26000040/, 'GR אחר של הספק — לא נמשך');
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
  assert.equal(r.state.view.receipts[0].docno, 'GR26000033', 'התצוגה במסך');
  assert.equal(pr.writes.length, 0, 'לפני "כן" — שום דבר לא נכתב בפריוריטי');

  r = await say(BTN.yes);
  assert.match(r.text, /חשבונית ספק \*T10\* נקלטה בפריוריטי \(זמנית\)/);
  assert.match(r.text, /נמשכו: GR26000033/);
  assert.ok(pr.writes.every((w) => w.args[0] === 'raba'));
  assert.deepEqual(pr.wrote('createSupplierInvoice')[0].args[1], { supname: '621259', booknum: '10288', date: '2026-11-18', details: 'ח-ן הרמן עיצוב וניהול פרויקטים', allocation: '' });
  assert.deepEqual(pr.wrote('addInvoiceReceipt').map((w) => w.args.slice(1)), [['T10', 'GR26000033']]);
  assert.equal(pr.wrote('attachInvoice').length, 1, 'צילום החשבונית — נספח');
  const dialog = pr.wrote('setInvoiceDialog')[0].args[2].join('\n');
  assert.match(dialog, new RegExp(`נקלט ע"י: ${u.full_name}`));
  assert.match(dialog, /קבלות סחורה: GR26000033 \(90016\)/);
  assert.equal(r.state.active, false, 'הקליטה הסתיימה');
  assert.equal(H.D.get("SELECT docno FROM priority_docs WHERE user_id = ? AND doc = 'invoice' AND docno = 'T10'", u.id)?.docno, 'T10', 'בשרשרת');
});

test('השורות גוברות על הסכום: שני GR באותו סכום — נבחר זה שהשורות שלו כמו בחשבונית', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const other = { ...GR40, DOCNO: 'GR26000041', BOOKNUM: '888', DISPRICE: 3000 };
  priority(t, { receipts: [other, GR33], lines: { ...LINES, GR26000041: [{ PDES: 'תכנון חשמל', TQUANT: 2, PRICE: 1500, QPRICE: 3000 }] } });
  ai(t);
  const r = await H.desk(u, 'invoice').open();
  assert.match(r.text, /GR26000033/);
  assert.doesNotMatch(r.text, /GR26000041/);
});

test('חשבונית של קבלן משנה: השורות שלה הן של חשבון חלקי (PC) מאושר — נבחר החשבון החלקי, "כן ✅" ← חשבונית זמנית שמושכת אותו', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const PC = { DOCNO: 'PC260000262', ORDNAME: 'CO260000102', SUPNAME: '621259', CDES: 'הרמן עיצוב וניהול פרויקטים', CURDATE: '2026-09-30', STATDES: 'סופית', IVALL: 'N',
    PROJDOCNO: 'PR26000008', PROJDES: 'הפסגה הירוקה', MED_QPRICE: 3000, DISPRICE: 3000, VAT: 540, TOTPRICE: 3540, MED_DOCTOTPRICE: 3000, MED_EXEMONTH: '10/26',
    retention: [], approvers: [] };
  // גם GR של הספק באותו סכום — אבל השורות של החשבונית הן של החשבון החלקי
  const pr = priority(t, { receipts: [{ ...GR40, DISPRICE: 3000 }], pcs: [PC],
    lines: { GR26000040: [{ PDES: 'הדמיות', TQUANT: 5, PRICE: 600, QPRICE: 3000 }] },
    pcLines: { PC260000262: [{ MED_SECDES: 'ליווי אדריכלי — אוקטובר', TQUANT: 1, MED_PRICE: 3000, MED_CQPRICE_BD: 3000 }] } });
  ai(t, invoice({ lines: [{ description: 'ליווי אדריכלי אוקטובר', qty: 1, unit_price: 3000, line_total: 3000 }], allocation_number: '320727438' }));
  const { open, say } = H.desk(u, 'invoice');
  let r = await open();
  assert.match(r.text, /חשבונית ספק מחשבון חלקי/);
  assert.match(r.text, /PC260000262/);
  assert.match(r.text, /הסכומים מתאימים/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
  assert.equal(pr.writes.length, 0);

  r = await say(BTN.yes);
  assert.match(r.text, /\*T10\* — חשבונית ספק זמנית מהחשבון החלקי \*PC260000262\*/);
  assert.deepEqual(pr.wrote('addInvoiceReceipt')[0].args, ['raba', 'T10', 'PC260000262']);
  assert.equal(pr.wrote('createSupplierInvoice')[0].args[1].allocation, '320727438', 'מספר ההקצאה מהחשבונית');
});

test('חשבון חלקי שעוד לא מאושר — אומרים אצל מי, ולא נכתב דבר', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const PC = { DOCNO: 'PC260000300', ORDNAME: 'CO260000102', SUPNAME: '621259', CDES: 'הרמן', STATDES: 'מחכה לאישור', IVALL: 'N', MED_QPRICE: 3000, VAT: 540, TOTPRICE: 3540,
    retention: [], approvers: [{ USERNAME: 'גילעד קוגלמן', USERLOGIN: 'GiladK', ALTUSERLOGIN: 'AlexO', UFLAG: null }] };
  const pr = priority(t, { receipts: [], pcs: [PC], pcLines: { PC260000300: [{ MED_SECDES: 'עיצוב משרד מכירות', TQUANT: 1, MED_PRICE: 3000, MED_CQPRICE_BD: 3000 }] } });
  ai(t);
  const r = await H.desk(u, 'invoice').open();
  assert.match(r.text, /PC260000300\* עוד \*מחכה לאישור\*/);
  assert.match(r.text, /גילעד קוגלמן \(או AlexO\)/);
  assert.match(r.text, /לא נכתב דבר/);
  assert.equal(pr.writes.length, 0);
});

test('חשבונית שכבר נקלטה (אותו ספק ואותו מספר) — "כבר נקלטה: GI…", בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const pr = priority(t, { dup: { IVNUM: 'GI26000060', STATDES: 'סופית', TOTPRICE: 3540 } });
  ai(t);
  const r = await H.desk(u, 'invoice').open();
  assert.match(r.text, /כבר נקלטה בפריוריטי: \*GI26000060\*/);
  assert.equal(pr.writes.length, 0);
});

test('אין GR סופי ואין חשבון חלקי פתוח — הסבר מה לעשות, בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const pr = priority(t, { receipts: [] });
  ai(t);
  const r = await H.desk(u, 'invoice').open();
  assert.match(r.text, /לא מצאתי אצל הספק קבלת סחורה \*סופית\*/);
  assert.match(r.text, /וגם לא חשבון חלקי/);
  assert.equal(pr.writes.length, 0);
});

test('לא ברור — בחירה בכפתורים (מספרי GR / PC); שינוי בשפה חופשית ("גם GR…"), ו"ביטול" — בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const twin = { ...GR40, DOCNO: 'GR26000041', DISPRICE: 3000, BOOKNUM: '888' };
  const same = [{ PDES: 'שירות', TQUANT: 1, PRICE: 3000, QPRICE: 3000 }];
  const pr = priority(t, { receipts: [GR33, twin, GR40], lines: { GR26000033: same, GR26000041: same, GR26000040: LINES.GR26000040 } });
  ai(t);
  const { open, say } = H.desk(u, 'invoice');
  let r = await open();
  assert.match(r.text, /מה למשוך/);
  H.assertButtons(r.buttons.slice(0, 2), ['GR26000033', 'GR26000041']);

  r = await say('GR26000041');
  assert.match(r.text, /ימשכו לחשבונית \(בחרת\)/);
  r = await say('גם GR26000040');
  assert.match(r.text, /GR26000041/);
  assert.match(r.text, /GR26000040/);
  assert.match(r.text, /⚠️ פער של \*1,250\.00 ₪\*/);

  r = await say(BTN.cancel);
  assert.match(r.text, /החשבונית בוטלה. לא נכתב דבר בפריוריטי/);
  assert.equal(pr.writes.length, 0);
});

test('מספר הקצאה: מהחשבונית ← SDINUMIT ("לאמת"); מעל 5,000 ₪ בלעדיו — אזהרה בסיכום', async (t) => {
  H.companies(t, 'raba');
  const u = accountant();
  const big = { ...GR33, DISPRICE: 12000, VAT: 2160, TOTPRICE: 14160 };
  const totals = { subtotal: 12000, doc_discount_pct: 0, doc_discount: 0, before_vat: 12000, vat: 2160, total: 14160 };
  const lines = [{ description: 'עיצוב משרד מכירות רכסים', qty: 1, unit_price: 12000, line_total: 12000 }];
  const pr = priority(t, { receipts: [big], lines: { GR26000033: [{ PDES: 'עיצוב משרד', TQUANT: 1, PRICE: 12000, QPRICE: 12000 }] } });
  let d = invoice({ totals, lines, allocation_number: '' });
  H.claude(t, { extract: () => d });
  const dk = H.desk(u, 'invoice');
  let r = await dk.open();
  assert.match(r.text, /אין מספר הקצאה/);
  await dk.say(BTN.cancel);

  d = invoice({ totals, lines, allocation_number: '3207-27438' });
  r = await dk.open();
  assert.match(r.text, /מספר הקצאה 320727438 — לאמת/);
  await dk.say(BTN.yes);
  assert.equal(pr.wrote('createSupplierInvoice')[0].args[1].allocation, '320727438');
});

test('בבוט אין חשבונית ספק: "חשבונית ספק" לא נכנס לזרימה, ובתפריט פריוריטי אין כפתור כזה', async (t) => {
  H.companies(t, 'raba');
  const u = accountant(['receipt', 'invoice']);
  const pr = priority(t);
  H.Fakes.claude(t, () => ({ action: 'chat', reply: 'שלום' }));
  const { say } = H.chat(t, u);
  const r = await say('פריוריטי');
  assert.ok(!r.buttons.some((b) => /חשבונית ספק/.test(b)), JSON.stringify(r.buttons));
  assert.equal(pr.writes.length, 0);
});
