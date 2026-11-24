'use strict';
/**
 * 🧾 חשבונית ספק (‎server/priority/supplier-invoice.js‎) — ההתאמה ל-GR וההשוואה (פונקציות טהורות), התצוגה למסך, וההרשאה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const SI = require('../../../server/priority/supplier-invoice');
const Access = require('../../../server/priority/priority-access');

boot();

const doc = (o = {}) => ({ doc_type: 'invoice', doc_label: 'חשבונית מס', doc_number: '10288', po_number: '', supplier_order_ref: '', other_ids: [],
  lines: [{ description: 'עיצוב משרד מכירות רכסים', supplier_code: '', qty: 1, unit_price: 3000, discount_pct: 0, line_total: 3000 }],
  totals: { subtotal: 3000, before_vat: 3000, vat: 540, total: 3540 }, ...o });
const gr = (DOCNO, DISPRICE, o = {}) => ({ DOCNO, DISPRICE, BOOKNUM: '', ORDNAME: '', ...o });

test('התאמה לפי מספר: GR שה-BOOKNUM שלו הוא מספר החשבונית / ההזמנה — גם כשהסכום שונה', () => {
  const grs = [gr('GR1', 999, { BOOKNUM: '10288' }), gr('GR2', 3000)];
  assert.deepEqual(SI.matchReceipts(doc(), grs), { picked: [grs[0]], how: 'ref', options: [grs[0]] });
  const byPo = [gr('GR3', 1, { ORDNAME: 'PO26000110' }), gr('GR4', 3000)];
  assert.equal(SI.matchReceipts(doc({ po_number: 'PO26000110' }), byPo).picked[0].DOCNO, 'GR3');
  // "ת.מ 5501" בשורה — מספר תעודה
  const byLine = [gr('GR5', 1, { BOOKNUM: '5501' })];
  assert.equal(SI.matchReceipts(doc({ lines: [{ description: 'לפי ת.מ 5501', qty: 1, unit_price: 3000 }] }), byLine).how, 'ref');
});

test('התאמה לפי סכום: חשבונית מס על GR שנקלט על חשבונית העסקה (הרמן: 10288 ← GR על 90016)', () => {
  const grs = [gr('GR26000040', 2000, { BOOKNUM: '777' }), gr('GR26000033', 3000, { BOOKNUM: '90016' })];
  const m = SI.matchReceipts(doc(), grs);
  assert.equal(m.how, 'amount');
  assert.deepEqual(m.picked.map((g) => g.DOCNO), ['GR26000033']);
  // עיגול של עד שקל — עדיין תואם
  assert.equal(SI.matchReceipts(doc(), [gr('GR9', 3000.6)]).how, 'amount');
});

test('צירוף של כמה GR (חשבונית מרכזת) — רק כשיש צירוף אחד; שני GR באותו סכום — לא מנחשים', () => {
  const grs = [gr('A', 1000), gr('B', 500), gr('C', 2000), gr('D', 70)];
  const m = SI.matchReceipts(doc(), grs);
  assert.equal(m.how, 'sum');
  assert.deepEqual(m.picked.map((g) => g.DOCNO).sort(), ['A', 'C']);
  const twin = SI.matchReceipts(doc(), [gr('X', 3000), gr('Y', 3000)]);
  assert.deepEqual(twin.picked, []);
  assert.deepEqual(twin.options.map((g) => g.DOCNO), ['X', 'Y']);
  // שני צירופים אפשריים — לא מנחשים; ההצעות — הקרובים בסכום
  const two = SI.matchReceipts(doc(), [gr('P', 1000), gr('Q', 2000), gr('R', 1500), gr('S', 1500)]);
  assert.deepEqual(two.picked, []);
  assert.equal(two.options.length, 3);
});

test('השוואה: תואם / עיגול / פער — וממה הוא נובע, שורה-שורה', () => {
  assert.deepEqual(SI.compare(doc(), [gr('G', 3000)]).ok, true);
  const r = SI.compare(doc(), [gr('G', 2999.5)]);
  assert.equal(r.ok, true);
  assert.equal(r.rounding, true);
  const invoice = doc({
    lines: [
      { description: 'מלט', qty: 200, unit_price: 10, line_total: 2000 },
      { description: 'הובלה', qty: 1, unit_price: 350, line_total: 350 },
      { description: 'מעדר', qty: 10, unit_price: 45, line_total: 450 }
    ],
    totals: { before_vat: 2800, vat: 504, total: 3304 }
  });
  const lines = [
    { PDES: 'מלט', TQUANT: 100, PRICE: 10, QPRICE: 1000 },
    { PDES: 'מעדר', TQUANT: 10, PRICE: 40, QPRICE: 400 },
    { PDES: 'בקבוק', TQUANT: 3, PRICE: 5, QPRICE: 15 }
  ];
  const gap = SI.compare(invoice, [gr('G', 1415)], lines);
  assert.equal(gap.ok, false);
  assert.equal(gap.diff, 1385);
  assert.ok(gap.lines.some((l) => /מלט/.test(l) && /כמות: בחשבונית 200, ב-GR 100/.test(l)), gap.lines.join('\n'));
  assert.ok(gap.lines.some((l) => /מעדר/.test(l) && /מחיר/.test(l)), gap.lines.join('\n'));
  assert.ok(gap.lines.some((l) => /בחשבונית ולא ב-GR: הובלה/.test(l)));
  assert.ok(gap.lines.some((l) => /ב-GR ולא בחשבונית: בקבוק/.test(l)));
});

test('טריגר: "חשבונית ספק" והכפתור בתפריט — כן; "קליטת חשבונית" (קבלת סחורה) ובקשה אחרת — לא', () => {
  for (const t of ['חשבונית ספק', '🧾 חשבונית ספק', 'קליטת חשבונית ספק', 'חשבוניות ספקים']) assert.ok(SI.opens(t), t);
  for (const t of ['קליטת חשבונית', 'קבלת סחורה', 'שלח מייל לספק על החשבונית']) assert.ok(!SI.opens(t), t);
});

test('בלי הרשאה לחשבונית ספק (מטריצה) — "פריוריטי לא פתוח לך", ושום פנייה לפריוריטי', async (t) => {
  const u = user({ role: 'employee' });
  Access.save([{ id: u.id, docs: ['receipt'], companies: null }]);
  Fakes.priority(t, {});
  Fakes.claude(t);
  const r = await SI.handle({ user: u, text: 'חשבונית ספק' });
  assert.equal(r.status, 'denied');
  assert.equal(r.replies[0], Access.NO_ACCESS);
  assert.equal(SI.view(u.id), null);
});

test('התצוגה למסך — מהמצב השמור: ספק, מסמך, ה-GR שנבחרו וההשוואה', () => {
  const u = user({ role: 'employee' });
  assert.equal(SI.view(u.id), null);
  D.setUserPref(u.id, 'supplierInvoice', {
    step: 'confirm', at: Date.now(), startedAt: 1, company: 'test11', supplier: { code: '621259', name: 'הרמן עיצוב' }, doc: doc({ doc_date: '2026-11-18' }),
    available: [gr('GR26000033', 3000, { BOOKNUM: '90016', TOTPRICE: 3540 })], picked: ['GR26000033'], compare: { ok: true, diff: 0 }
  });
  const v = SI.view(u.id);
  assert.equal(v.flow, 'invoice');
  assert.equal(v.stepLabel, 'לבדיקה — מחכה ל"כן"');
  assert.equal(v.docNumber, '10288');
  assert.equal(v.supplier.name, 'הרמן עיצוב');
  assert.deepEqual(v.receipts.map((r) => r.docno), ['GR26000033']);
  assert.match(v.lines[0].description, /GR26000033 · מסמך 90016/);
  assert.deepEqual(v.match, { ok: true, diff: 0 });
});

test('הבסיס לפי השורות: שורת סיכום של קבלן מול סעיף בחשבון החלקי (סלע, PC260000262) — והשורה השלילית (עכבון) לא נספרת', () => {
  const sela = doc({ doc_number: '01/000807', lines: [{ description: 'חשבון חלקי 1 - אתר הפסגה הירוקה - רכסים', qty: 1, unit_price: 609317, line_total: 609317 }],
    totals: { before_vat: 609317.03, vat: 109677.07, total: 718994.1 } });
  const pc = { kind: 'pc', id: 'PC260000262', ordname: 'CO260000102', amount: 578851.24, gross: 609317.1,
    lines: [{ des: 'חפירה ופינוי', qty: 20310.57, price: 30, total: 609317.1 }, { des: 'עכבון לפי חוזה', qty: 1, price: -30465.86, total: -30465.86 }] };
  const gr = { kind: 'gr', id: 'GR26000099', amount: 1000, lines: [{ des: 'צנרת', qty: 10, price: 100, total: 1000 }] };
  const m = SI.pickBasis(sela, [gr, pc]);
  assert.deepEqual(m.picked.map((c) => c.id), ['PC260000262']);
  // מספר החוזה על החשבונית — גובר
  assert.equal(SI.pickBasis(doc({ contract_refs: ['CO260000102'] }), [gr, pc]).how, 'ref');
  // אין שורות ואין סכום מתאים — לא מנחשים
  assert.deepEqual(SI.pickBasis(doc(), [gr, { ...pc, gross: 1, amount: 1 }]).picked, []);
});
