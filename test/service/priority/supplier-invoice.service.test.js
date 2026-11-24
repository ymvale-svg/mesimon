'use strict';
/**
 * 🧾 חשבונית ספק מקצה לקצה: העובד מדבר עם הבוט (‎handleDirect‎), ה-AI ופריוריטי מזויפים.
 * המקרה האמיתי (24.11.26): חשבונית מס 10288 של "הרמן עיצוב וניהול פרויקטים" לרבץ רכסים, על GR26000033 — שנקלט
 * על חשבונית העסקה 90016. בודק: כפתורים, שום כתיבה לפני "כן", מה נכתב אחרי "כן", כפילות, אין GR, בחירה, ביטול.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Access = require('../../../server/priority/priority-access');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

function enable() {
  const on = { enabled: true, audience: 'all', examples: [] };
  H.D.setSetting('wa_actions', { goods_receipt: on, purchase_demand: on, supplier_invoice: on });
}
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
  blank_area: { x: 0, y: 0, w: 0, h: 0 }, warnings: [], ...o
});
const GR33 = { DOCNO: 'GR26000033', BOOKNUM: '90016', CURDATE: '2026-09-27T00:00:00Z', ORDNAME: null, PROJDOCNO: 'PR26000008', PROJDES: 'הפסגה הירוקה', DISPRICE: 3000, VAT: 540, TOTPRICE: 3540 };
const GR40 = { DOCNO: 'GR26000040', BOOKNUM: '777', CURDATE: '2026-10-01T00:00:00Z', ORDNAME: null, PROJDOCNO: 'PR26000008', PROJDES: 'הפסגה הירוקה', DISPRICE: 1250, VAT: 225, TOTPRICE: 1475 };

function priority(t, { receipts = [GR33, GR40], dup = null } = {}) {
  return H.Fakes.priority(t, {
    findSuppliers: async () => ({ list: [{ SUPNAME: '621259', SUPDES: 'הרמן עיצוב וניהול פרויקטים' }], by: 'vat' }),
    findInvoiceByBooknum: async () => dup,
    receiptsToInvoice: async () => receipts,
    readSupplierInvoice: async (c, iv) => ({ IVNUM: iv, DISPRICE: 3000, VAT: 540, TOTPRICE: 3540, receipts: [{ DOCNO: 'GR26000033' }] }),
    readReceipt: async () => ({ lines: [] })
  }, { writes: { createSupplierInvoice: async () => 'T10', attachInvoice: async () => 1 } });
}
const ai = (t, d = invoice()) => H.claude(t, { extract: () => d });

test('חשבונית מס על GR שנקלט על חשבונית העסקה: נמצא לפי הסכום, סיכום בכפתורים, "כן ✅" ← חשבונית זמנית שמושכת את ה-GR', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  let r = await say('חשבונית ספק', { file: H.photo() });
  assert.match(r.text, /רבץ רכסים/);
  assert.match(r.text, /הרמן עיצוב וניהול פרויקטים \(621259\)/);
  assert.match(r.text, /חשבונית מס 10288 מ-18\.11\.2026/);
  assert.match(r.text, /GR26000033\* \(מסמך 90016\)/);
  assert.match(r.text, /לפי הסכום/);
  assert.match(r.text, /✅ תואם/);
  assert.doesNotMatch(r.text, /GR26000040/, 'GR אחר של הספק — לא נמשך');
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
  assert.equal(pr.writes.length, 0, 'לפני "כן" — שום דבר לא נכתב בפריוריטי');

  r = await say(BTN.yes);
  assert.match(r.text, /חשבונית ספק \*T10\* נקלטה בפריוריטי \(זמנית\)/);
  assert.match(r.text, /נמשכו: GR26000033/);
  assert.match(r.text, /הסכום תואם/);
  assert.ok(pr.writes.every((w) => w.args[0] === 'raba'));
  assert.deepEqual(pr.wrote('createSupplierInvoice')[0].args[1], { supname: '621259', booknum: '10288', date: '2026-11-18', details: 'ח-ן הרמן עיצוב וניהול פרויקטים' });
  assert.deepEqual(pr.wrote('addInvoiceReceipt').map((w) => w.args.slice(1)), [['T10', 'GR26000033']]);
  assert.equal(pr.wrote('attachInvoice').length, 1, 'צילום החשבונית — נספח');
  const dialog = pr.wrote('setInvoiceDialog')[0].args[2].join('\n');
  assert.match(dialog, new RegExp(`נקלט ע"י: ${u.full_name}`));
  assert.match(dialog, /קבלות סחורה: GR26000033 \(90016\)/);
  assert.match(dialog, /השוואה: תואם/);
  assert.equal(H.D.get("SELECT stage, docno FROM priority_docs WHERE user_id = ? AND doc = 'invoice'", u.id)?.docno, 'T10', 'בשרשרת — מחכה לאישור');

  // 👎 מיד אחרי — חשבונית זמנית אי אפשר למחוק מהבוט: הנחיה, ולא נכתב דבר
  const before = pr.writes.length;
  r = await say('👎');
  assert.match(r.text, /אי אפשר למחוק מהבוט/);
  assert.match(r.text, /מחיקת חשבונית זמנית/);
  assert.equal(pr.writes.length, before);
});

test('חשבונית שכבר נקלטה (אותו ספק ואותו מספר) — "כבר נקלטה: GI…", בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant();
  const pr = priority(t, { dup: { IVNUM: 'GI26000060', STATDES: 'סופית', TOTPRICE: 3540 } });
  ai(t);
  const { say } = H.chat(t, u);
  const r = await say('חשבונית ספק', { file: H.photo() });
  assert.match(r.text, /כבר נקלטה בפריוריטי: \*GI26000060\*/);
  assert.equal(pr.writes.length, 0);
});

test('אין GR סופי פתוח לספק — הסבר מה לעשות (קודם קבלת סחורה), בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant();
  const pr = priority(t, { receipts: [] });
  ai(t);
  const { say } = H.chat(t, u);
  const r = await say('חשבונית ספק', { file: H.photo() });
  assert.match(r.text, /לא מצאתי אצל הספק קבלת סחורה \*סופית\*/);
  assert.match(r.text, /קודם \*קבלת סחורה\*/);
  assert.equal(pr.writes.length, 0);
});

test('לא ברור איזה GR — בחירה בכפתורים (מספרי ה-GR); אחר כך שינוי בשפה חופשית ("גם GR…"), ו"ביטול" — בלי כתיבה', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant();
  const twin = { ...GR40, DOCNO: 'GR26000041', DISPRICE: 3000, BOOKNUM: '888' };
  const pr = priority(t, { receipts: [GR33, twin, GR40] });
  ai(t);
  const { say } = H.chat(t, u);
  let r = await say('חשבונית ספק', { file: H.photo() });
  assert.match(r.text, /איזו קבלת סחורה החשבונית מושכת/);
  H.assertButtons(r.buttons, ['GR26000033', 'GR26000041']);

  r = await say('GR26000041');
  assert.match(r.text, /ימשכו לחשבונית \(בחרת\)/);
  assert.match(r.text, /GR26000041/);

  r = await say('גם GR26000040');
  assert.match(r.text, /GR26000041/);
  assert.match(r.text, /GR26000040/);
  assert.match(r.text, /⚠️ פער של \*1,250\.00 ₪\*/);

  r = await say('GR123');
  assert.match(r.text, /GR123|לא הבנתי|\*כן\*/);

  r = await say(BTN.cancel);
  assert.match(r.text, /החשבונית בוטלה. לא נכתב דבר בפריוריטי/);
  assert.equal(pr.writes.length, 0);
});

test('תפריט פריוריטי: מי שמורשה לחשבונית ספק רואה "🧾 חשבונית ספק", והכפתור מתחיל אותה', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant(['receipt', 'invoice']);
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  let r = await say('פריוריטי');
  H.assertButtons(r.buttons, ['📦 קבלת סחורה', '🧾 חשבונית ספק']);
  r = await say('🧾 חשבונית ספק');
  assert.match(r.text, /\*חשבונית ספק\* — שלחו צילום של החשבונית/);
  H.assertButtons(r.buttons, [BTN.cancel]);
  r = await say('', { file: H.photo() });
  assert.match(r.text, /GR26000033/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
});

test('בלי הרשאה לחשבונית ספק — "חשבונית ספק" לא נכנס לזרימה ולא פונה לפריוריטי', async (t) => {
  H.companies(t, 'raba');
  enable();
  const u = accountant(['receipt']);
  const pr = priority(t);
  H.Fakes.claude(t, () => ({ action: 'chat', reply: 'שלום' }));
  const { say } = H.chat(t, u);
  const r = await say('פריוריטי');
  assert.ok(!r.buttons.includes('🧾 חשבונית ספק'));
  assert.equal(pr.writes.length, 0);
});
