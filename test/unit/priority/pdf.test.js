'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { orderPdf } = require('../../../server/ai/po-pdf');
const { receiptPdf } = require('../../../server/ai/gr-pdf');

const pageCount = (buf) => Number(buf.toString('latin1').match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)[1]);
const titleHex = (t) => [...t].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
const hasTitle = (buf, t) => buf.toString('latin1').toLowerCase().includes(`/title <feff${titleHex(t)}>`);
/** כל זרמי התוכן, פתוחים — לבדיקת צבעים ופקודות ציור */
function contents(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /\/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    try { out.push(zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1')); } catch { /* לא זרם תוכן */ }
  }
  return out.join('\n');
}

const po = (over = {}) => ({
  ORDNAME: 'PO26000045', CDES: 'ספק', SUPNAME: '1001', STATDES: 'אושרה', CURDATE: '2026-11-01', PROJDOCNO: 'PR-7', PROJDES: 'מבואות',
  QPRICE: 1000, PERCENT: 0, DISPRICE: 1000, VAT: 180, TOTPRICE: 1180, CODE: 'ש"ח',
  lines: [{ PARTNAME: 'M-1', PDES: 'מלט אפור', TQUANT: 10, TUNITNAME: 'שק', PRICE: 50, QPRICE: 500, DUEDATE: '2026-11-20' }],
  ...over
});

const gr = (over = {}) => ({
  DOCNO: 'GR26000010', CDES: 'ספק', SUPNAME: '1001', STATDES: 'טיוטא', CURDATE: '2026-11-01', BOOKNUM: '5555', PROJDOCNO: 'PR-7', PROJDES: 'מבואות',
  TOWARHSNAME: 'Main', MED_MXPAYDES: 'ש45', QPRICE: 1000, PERCENT: 0, DISPRICE: 1000, VAT: 180, TOTPRICE: 1180,
  lines: [{ KLINE: 1, PARTNAME: '000', PDES: 'מוצר כללי', TQUANT: 1, PRICE: 1000, QPRICE: 1000, BUD_SUBCHAPTERNAME: '101', BUD_SUBTOPICNAME: '98-10' }],
  files: [{ EXTFILENUM: 1, EXTFILEDES: 'תעודת משלוח', SUFFIX: 'pdf' }],
  ...over
});

test('orderPdf — קובץ PDF תקין, עמוד אחד, כותרת', () => {
  const buf = orderPdf(po(), { companyLabel: 'מורדות' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.toString('latin1').trimEnd().endsWith('%%EOF'));
  assert.equal(pageCount(buf), 1);
  assert.ok(hasTitle(buf, 'הזמנת רכש PO26000045'));
});

test('orderPdf — שורות רבות: כמה עמודים', () => {
  const lines = Array.from({ length: 120 }, (_, i) => ({ PARTNAME: `P${i}`, PDES: `פריט מספר ${i} עם תיאור ארוך שנמשך לכמה שורות בטבלה`, TQUANT: 1, PRICE: 1, QPRICE: 1 }));
  assert.ok(pageCount(orderPdf(po({ lines }))) >= 3);
});

test('orderPdf — סביבת בדיקה: פס אדום', () => {
  const plain = contents(orderPdf(po()));
  const t = contents(orderPdf(po(), { test: true }));
  const pink = /0\.99 0\.91 0\.91 rg/;
  assert.match(t, pink);
  assert.doesNotMatch(plain, pink);
});

test('orderPdf — בלי שדות רשות (ship, DETAILS, REMARK) לא נופל', () => {
  const buf = orderPdf({ ORDNAME: 'PO1', lines: [{}] });
  assert.equal(pageCount(buf), 1);
});

test('orderPdf — הנחת מסמך ואיש קשר לא נופלים', () => {
  const buf = orderPdf(po({ PERCENT: 5, DISPRICE: 950, DETAILS: 'הערה', ship: { NAME: 'דני‏', PHONENUM: '04-1234567' } }), { manager: 'דנה', initiators: ['יוסי', 'רון'], updated: true });
  assert.ok(hasTitle(buf, 'הזמנת רכש PO26000045'));
});

test('receiptPdf — קובץ PDF תקין, עמוד אחד, כותרת', () => {
  const buf = receiptPdf(gr(), { companyLabel: 'מורדות', order: 'PO1' });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(buf), 1);
  assert.ok(hasTitle(buf, 'קבלת סחורה GR26000010'));
});

test('receiptPdf — שורות רבות ודו-שיח: כמה עמודים', () => {
  const lines = Array.from({ length: 90 }, (_, i) => ({ PARTNAME: `P${i}`, PDES: `פריט ${i} תיאור ארוך שנמשך לכמה שורות בטבלה של הקבלה`, TQUANT: 1, PRICE: 1, QPRICE: 1, ORDNAME: 'PO1', OLINE: i }));
  const dialog = Array.from({ length: 30 }, (_, i) => `שורה ${i} בדו-שיח הפנימי`);
  assert.ok(pageCount(receiptPdf(gr({ lines }), { dialog })) >= 3);
});

test('receiptPdf — סה"כ תואם למסמך: ירוק; הפרש: אדום', () => {
  const green = /0\.16 0\.48 0\.16 rg/;
  const red = /0\.67 0\.2 0\.2 rg/;
  const ok = contents(receiptPdf(gr(), { docTotal: 1180, order: 'PO1' }));
  const off = contents(receiptPdf(gr(), { docTotal: 1200, order: 'PO1' }));
  assert.match(ok, green);
  assert.doesNotMatch(ok, red);
  assert.doesNotMatch(off, green);
  assert.match(off, red);
});

test('receiptPdf — בלי הזמנה, בלי נספחים, תיאור חסר: לא נופל', () => {
  const buf = receiptPdf(gr({ files: [], lines: [{ TQUANT: 1 }] }), { due: '2026-12-31' });
  assert.equal(pageCount(buf), 1);
});
