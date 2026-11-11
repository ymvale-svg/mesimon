'use strict';
/**
 * קבלת סחורה מקצה לקצה: העובד מדבר עם הבוט (‎handleDirect‎), ה-AI ופריוריטי מזויפים.
 * בודק את כללי השיחה של CLAUDE.md: כפתורים (עד 3, הכיתוב הוא התשובה), ברירות מחדל של המשתמש,
 * רמז מהמסמך גובר על ברירת המחדל, ביטול טיוטא רק אחרי "כן, לבטל 🗑️", 👍 = כן — ושאין כתיבה לחברה סגורה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Prefs = require('../../../server/priority/priority-prefs');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

const PROJECTS = [
  { code: 'PR1', des: 'אלעד 49 צפון', warehouse: 'W1' },
  { code: 'PR2', des: 'נהריה מגרש 12', warehouse: 'W2' }
];
const WAREHOUSES = [{ code: 'W1', name: 'מחסן אלעד' }, { code: 'W2', name: 'מחסן נהריה' }, { code: 'Main', name: 'ראשי' }];

/** מסמך כפי שה-AI קורא אותו (‎EXTRACT_SCHEMA‎). ח.פ. הנמען — אשל הירדן יזום ובנין (a160226, עותק הבדיקה test11) */
function doc(o = {}) {
  return {
    doc_type: 'delivery_note', doc_label: 'תעודת משלוח', recipient_name: 'אשל הירדן יזום ובנין', recipient_vat: '512061185', other_ids: [],
    supplier_name: 'בטון הצפון', supplier_vat: '', doc_number: '5501', po_number: '', supplier_order_ref: '',
    date: '2026-11-09', doc_date: '2026-11-09', delivery_place: '', project_hint: '', purchase_type: 'site',
    lines: [{ description: 'בטון ב-30', supplier_code: '', qty: 5, unit: 'קוב', unit_price: 200, discount_pct: 0, line_total: 1000, handwritten: '', unclear: false, options: [] }],
    totals: { subtotal: 1000, doc_discount_pct: 0, doc_discount: 0, before_vat: 1000, vat: 180, total: 1180 },
    warnings: [],
    ...o
  };
}

/** פריוריטי מזויף: קריאות של חברה עם ספק אחד, שני פרויקטים, בלי הזמנות פתוחות. ‎status‎ — הסטטוס של ה-GR */
function priority(t, { status = 'טיוטא', reads = {} } = {}) {
  const state = { status, head: null };
  const pr = H.Fakes.priority(t, {
    findSuppliers: async () => ({ list: [{ SUPNAME: 'S100', SUPDES: 'בטון הצפון' }], by: 'name' }),
    findReceiptByBooknum: async () => null,
    openOrders: async () => [],
    getOrder: async () => null,
    findPartExact: async (c, des) => ({ PARTNAME: 'B-30', PARTDES: des, BUD_SUBCHAPTERNAME: '20', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '20-10', BUD_SUBTOPICDES: 'בטון' }),
    supplierHistory: async () => [],
    recentLines: async () => [],
    generalCoding: async () => null,
    partByCode: async () => null,
    projects: async () => PROJECTS,
    projectWarehouses: async (c, code) => WAREHOUSES.filter((w) => w.code === PROJECTS.find((p) => p.code === code)?.warehouse),
    warehouseExists: async (c, code) => WAREHOUSES.some((w) => w.code === code),
    warehouses: async () => WAREHOUSES,
    warehouseOf: async () => 'Main',
    defaultWarehouse: async () => 'Main',
    receiptStatus: async () => state.status,
    readDialog: async () => [],
    readReceipt: async (c, docno) => {
      const p = PROJECTS.find((x) => x.code === state.head?.project);
      return {
        DOCNO: docno, CDES: 'בטון הצפון', SUPNAME: 'S100', BOOKNUM: '5501', CURDATE: '2026-11-09', STATDES: state.status,
        PROJDOCNO: p?.code ?? '', PROJDES: p?.des ?? '', TOWARHSNAME: state.head?.warehouse ?? '', MED_MXPAYCODE: '04',
        DISPRICE: 1000, VAT: 180, TOTPRICE: 1180,
        lines: [{ KLINE: 1, PARTNAME: 'B-30', PDES: 'בטון ב-30', TQUANT: 5, TUNITNAME: 'קוב', PRICE: 200, QPRICE: 1000 }],
        files: [{ EXTFILENUM: 1 }]
      };
    },
    ...reads
  }, {
    writes: {
      createReceipt: async (c, head) => { state.head = head; return 'GR26000123'; },
      finalizeReceipt: async () => { state.status = 'סופית'; return {}; },
      cancelReceipt: async () => { state.status = 'מבוטלת'; return {}; }
    }
  });
  return { ...pr, state };
}

/** ה-AI: קריאת המסמך — ‎d‎; פרויקט בשפה חופשית — לא מוצא */
const ai = (t, d) => H.claude(t, {
  extract: () => d,
  project: () => ({ codes: [], question: '', unrelated: false })
});

/** מהצילום ועד שאלת הפרויקט (או מה שבא אחריה), דרך כל הכפתורים — כל כפתור נלחץ בכיתוב שלו */
async function toProject(say) {
  let r = await say('קבלת סחורה', { file: H.photo() });
  assert.match(r.text, /קבלת סחורה\* — תעודת משלוח 5501/);
  assert.match(r.text, /סביבת בדיקה/);
  assert.match(r.text, /בטון הצפון/);
  H.assertButtons(r.buttons, [BTN.yes, 'ללא מע"מ', BTN.cancel]);

  r = await say('👍');                        // 👍 = כן
  assert.match(r.text, /אין הזמנות פתוחות/);
  H.assertButtons(r.buttons, ['בלי הזמנה ❌', BTN.cancel]);

  r = await say('בלי הזמנה ❌');
  assert.match(r.text, /זה מה שהתקבל בפועל/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);

  r = await say(BTN.yes);
  assert.match(r.text, /מק"ט, תת פרק ומשאב/);
  assert.match(r.text, /B-30/);
  H.assertButtons(r.buttons, [BTN.yes, 'כללי']);

  return say(BTN.yes);
}

test('קבלת סחורה מלאה בכפתורים: כל שאלה עם עד 3 כפתורים, כל כפתור מובן, טיוטא ← "מאשר ✅" ← סופית', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);

  // אין ברירת מחדל ואין רמז במסמך — שואלים, בכפתורים עם שמות הפרויקטים
  let r = await toProject(say);
  assert.match(r.text, /לאיזה פרויקט לשייך/);
  H.assertButtons(r.buttons, ['אלעד 49 צפון', 'נהריה מגרש 12']);
  assert.equal(pr.writes.length, 0, 'עד הנספחים — שום דבר לא נכתב בפריוריטי');

  r = await say('נהריה מגרש 12');
  assert.match(r.text, /מחסן: \*מחסן נהריה\* \(W2\)/);
  assert.match(r.text, /נספחים/);
  H.assertButtons(r.buttons, [BTN.done]);

  r = await say(BTN.done);
  assert.match(r.text, /קבלת סחורה GR26000123\* — טיוטא לבדיקה/);
  H.assertButtons(r.buttons, [BTN.approve, BTN.cancel]);
  assert.equal(r.files.length, 1, 'ה-PDF לבדיקה נשלח');
  assert.ok(r.last.method === 'sendInteractiveButtonsReply', 'השאלה "מאשר?" היא ההודעה האחרונה');

  // מה נכתב — רק לעותק הבדיקה, עם מה שנבחר
  assert.ok(pr.writes.every((w) => w.args[0] === 'test11'), 'כל הכתיבות ל-test11');
  const [head] = pr.wrote('createReceipt');
  assert.deepEqual(head.args[1], { supname: 'S100', booknum: '5501', date: '2026-11-09', project: 'PR2', warehouse: 'W2', payCode: '04' });
  const [line] = pr.wrote('addFreeLine');
  assert.deepEqual(line.args.slice(1), ['GR26000123', { part: 'B-30', qty: 5, price: 200, discount: 0, chapter: '20', topic: '20-10' }]);
  assert.equal(pr.wrote('attach').length, 1, 'צילום המסמך — נספח');
  assert.equal(pr.wrote('setDialog').length, 1, 'דו-שיח פנימי');
  assert.equal(pr.wrote('finalizeReceipt').length, 0, 'עוד לא סופית');
  assert.equal(pr.wrote('cancelReceipt').length, 0);

  // "מאשר" — שאלת אישור לפני סגירה (אחרי הסגירה אי אפשר לבטל מהבוט), ורק אחריה סופית
  r = await say(BTN.approve);
  assert.match(r.text, /להפוך את \*GR26000123\* לסופית\?/);
  H.assertButtons(r.buttons, [BTN.confirmFinal, BTN.backToDraft]);
  assert.equal(pr.wrote('finalizeReceipt').length, 0, 'עוד לא נסגרה — מחכה לאישור');
  r = await say(BTN.confirmFinal);
  assert.match(r.text, /קבלת סחורה GR26000123\* נקלטה כסופית/);
  assert.deepEqual(pr.wrote('finalizeReceipt').map((w) => w.args), [['test11', 'GR26000123']]);
  assert.equal(pr.wrote('cancelReceipt').length, 0);

  // הבחירה נשמרה — ברירת המחדל לפעם הבאה
  assert.equal(Prefs.of(u.id, 'test11').project.code, 'PR2');
  assert.equal(Prefs.warehouseFor(u.id, 'test11', 'PR2'), 'W2');
});

test('👍 על הטיוטא = מאשר, ו-👍 על "להפוך לסופית?" = כן: ה-GR הופך לסופי', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  await say('סיום');
  let r = await say('👍');
  assert.match(r.text, /לסופית\?/);
  assert.equal(pr.wrote('finalizeReceipt').length, 0);
  r = await say('👍');
  assert.match(r.text, /נקלטה כסופית/);
  assert.equal(pr.wrote('finalizeReceipt').length, 1);
});

test('ברירת מחדל: הפרויקט והמחסן האחרונים — מוצגים ("הבחירה האחרונה שלך") והשיחה לא עוצרת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);

  const r = await toProject(say);
  assert.match(r.text, /פרויקט: \*אלעד 49 צפון\* \(PR1\) — הבחירה האחרונה שלך/);
  assert.match(r.text, /מחסן: \*מחסן אלעד\* \(W1\) — הבחירה האחרונה שלך/);
  assert.match(r.text, /נספחים/, 'ממשיכים ישר לנספחים, בלי שאלת פרויקט');
  H.assertButtons(r.buttons, [BTN.done]);

  await say(BTN.done);
  const [head] = pr.wrote('createReceipt');
  assert.equal(head.args[1].project, 'PR1');
  assert.equal(head.args[1].warehouse, 'W1');
});

test('המסמך גובר: רמז (עיר) שמתאים לפרויקט אחר — מוצע לאישור, ו"כן ✅" משייך אליו', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t, doc({ project_hint: 'נהריה' }));
  const { say } = H.chat(t, u);

  let r = await toProject(say);
  assert.match(r.text, /לפי המסמך \(נהריה\): \*נהריה מגרש 12\* \(PR2\)\?/);
  assert.match(r.text, /בפעם האחרונה: אלעד 49 צפון/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.no]);

  r = await say(BTN.yes);
  assert.match(r.text, /מחסן נהריה/);
  assert.match(r.text, /נספחים/);
  await say(BTN.done);
  assert.equal(pr.wrote('createReceipt')[0].args[1].project, 'PR2');
});

test('המסמך גובר: "לא ❌" להצעה מהמסמך — שואלים לאיזה פרויקט, ולא נופלים לברירת המחדל בשקט', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t, doc({ project_hint: 'נהריה' }));
  const { say } = H.chat(t, u);

  await toProject(say);
  const r = await say(BTN.no);
  assert.match(r.text, /לאיזה פרויקט, אם כך/);
  assert.equal(pr.writes.length, 0);
});

test('אחרי "לא ❌" להצעה מהמסמך — הפרויקטים של החברה (2) מוצעים בכפתורים', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t, doc({ project_hint: 'נהריה' }));
  const { say } = H.chat(t, u);
  await toProject(say);
  let r = await say(BTN.no);
  assert.match(r.text, /לאיזה פרויקט, אם כך/);
  // הבחירה האחרונה מוצעת; הפרויקט שנדחה (נהריה) — לא
  H.assertButtons(r.buttons, ['אלעד 49 צפון']);
  r = await say('אלעד 49 צפון');
  assert.match(r.text, /נספחים/);
  await say(BTN.done);
  assert.equal(pr.wrote('createReceipt')[0].args[1].project, 'PR1');
});

test('המסמך גובר: רמז שמתאים לבחירה האחרונה — היא נקבעת בלי לעצור', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR2', des: 'נהריה מגרש 12' }, warehouse: 'W2' });
  priority(t);
  ai(t, doc({ delivery_place: 'נהריה' }));
  const { say } = H.chat(t, u);

  const r = await toProject(say);
  assert.match(r.text, /נהריה מגרש 12\* \(PR2\) — הבחירה האחרונה שלך/);
  H.assertButtons(r.buttons, [BTN.done]);
});

test('המסמך גובר: רמז שלא מתאים לאף פרויקט — הבחירה האחרונה מוצעת לאישור, לא נקבעת לבד', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t, doc({ project_hint: 'באר שבע' }));
  const { say } = H.chat(t, u);

  let r = await toProject(say);
  assert.match(r.text, /במסמך: באר שבע — לא מצאתי פרויקט שמתאים/);
  assert.match(r.text, /אלעד 49 צפון\* \(PR1\), הבחירה האחרונה שלך\?/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.no]);

  r = await say('👍');                         // 👍 = כן
  assert.match(r.text, /נספחים/);
  await say(BTN.done);
  assert.equal(pr.wrote('createReceipt')[0].args[1].project, 'PR1');
});

test('ברירת המחדל נלמדת: קבלה שנייה של אותו עובד לא שואלת שוב על הפרויקט', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);

  let r = await toProject(say);
  assert.match(r.text, /לאיזה פרויקט לשייך/);
  await say('אלעד 49 צפון');
  await say(BTN.done);
  await say(BTN.approve);
  await say(BTN.confirmFinal);

  r = await toProject(say);
  assert.match(r.text, /אלעד 49 צפון\* \(PR1\) — הבחירה האחרונה שלך/);
  H.assertButtons(r.buttons, [BTN.done]);
  assert.equal(pr.wrote('createReceipt').length, 1, 'הקבלה השנייה עוד לא נכתבה');
});

test('ביטול טיוטא: 👎 שואל "כן, לבטל 🗑️" — ורק הכפתור הזה מבטל בפריוריטי', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  await say(BTN.done);
  assert.equal(pr.wrote('createReceipt').length, 1);

  let r = await say('👎');
  assert.match(r.text, /לבטל את הטיוטא \*GR26000123\*/);
  H.assertButtons(r.buttons, [BTN.confirmCancel, 'חזרה לטיוטא']);
  assert.equal(pr.wrote('cancelReceipt').length, 0, 'עדיין לא בוטל');

  r = await say(BTN.confirmCancel);
  assert.match(r.text, /הטיוטא GR26000123 בוטלה בפריוריטי/);
  assert.deepEqual(pr.wrote('cancelReceipt').map((w) => w.args), [['test11', 'GR26000123']]);
  assert.equal(pr.wrote('finalizeReceipt').length, 0);
  assert.deepEqual(r.buttons, [], 'הקליטה נסגרה — בלי כפתורים');
});

test('ביטול טיוטא: 👎 כתגובה (Reaction) גם הוא שואל קודם, ו"חזרה לטיוטא" לא מבטל', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  await say(BTN.done);

  let r = await say('👎', { reaction: true });
  H.assertButtons(r.buttons, [BTN.confirmCancel, 'חזרה לטיוטא']);

  r = await say('חזרה לטיוטא');
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);
  H.assertButtons(r.buttons, [BTN.approve, BTN.cancel]);
  assert.equal(pr.wrote('cancelReceipt').length, 0);
  assert.equal(pr.wrote('finalizeReceipt').length, 0, '"חזרה" אינה אישור');
});

test('ביטול טיוטא: "ביטול 🗑️" בבדיקת הטיוטא — שואל "כן, לבטל 🗑️" לפני cancelReceipt', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  await say(BTN.done);

  let r = await say(BTN.cancel);
  assert.match(r.text, /לבטל את הטיוטא \*GR26000123\*/);
  assert.equal(pr.wrote('cancelReceipt').length, 0, 'לא מבטלים לפני אישור');
  H.assertButtons(r.buttons, [BTN.confirmCancel, 'חזרה לטיוטא']);

  r = await say(BTN.confirmCancel);
  assert.match(r.text, /הטיוטא GR26000123 בוטלה בפריוריטי/);
  assert.deepEqual(pr.wrote('cancelReceipt').map((w) => w.args), [['test11', 'GR26000123']]);
});

test('ביטול טיוטא: "ביטול" ואז "חזרה לטיוטא" — לא מבטל', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  await say(BTN.done);

  await say('ביטול');
  const r = await say('חזרה לטיוטא');
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);
  assert.match(r.text, /\*ביטול\* 👎 — מבטל את הטיוטא \(אחרי שאלת אישור\)/);
  H.assertButtons(r.buttons, [BTN.approve, BTN.cancel]);
  assert.equal(pr.wrote('cancelReceipt').length, 0);
});

test('ביטול לפני הטיוטא — אין מה לבטל בפריוריטי: נסגר בלי שום כתיבה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  const r = await say(BTN.cancel);
  assert.match(r.text, /קבלת הסחורה בוטלה\./);
  assert.equal(pr.writes.length, 0);
});

test('👎 כהודעה נפרדת לפני הטיוטא — שלב אחד אחורה, עם הכפתורים של השאלה הקודמת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  await say(BTN.yes);                           // ← "יש מספר הזמנה?"
  await say('בלי הזמנה ❌');                     // ← "זה מה שהתקבל בפועל?"
  const back = await say('👎');
  assert.match(back.text, /חזרתי שלב אחד אחורה/);
  assert.match(back.text, /אין הזמנות פתוחות/);
  H.assertButtons(back.buttons, ['בלי הזמנה ❌', BTN.cancel]);
  assert.equal(pr.writes.length, 0);
});

test('👎 כתגובה (Reaction) = לא: בשאלת "יש מספר הזמנה?" — בלי הזמנה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  await say(BTN.yes);
  const r = await say('👎', { reaction: true });
  assert.match(r.text, /ללא הזמנה/);
  assert.match(r.text, /זה מה שהתקבל בפועל/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.cancel]);
});

// ---------------------------------------------------------------------------
// בטיחות: אין כתיבה לחברה שאינה ב-PRIORITY_COMPANIES
// ---------------------------------------------------------------------------

test('בטיחות: המסמך מופנה לחברה שאינה פתוחה — הודעה ברורה לעובד, ואף פונקציית כתיבה לא נקראת', async (t) => {
  // ברירת המחדל של הבדיקות: '__none__' — גם test11 (עותק הבדיקה של a160226) סגור
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);

  const r = await say('קבלת סחורה', { file: H.photo() });
  assert.match(r.text, /מופנה ל\*אשל הירדן יזום ובנין\* \(a160226\), שעדיין לא פתוחה לקליטה מהבוט/);
  assert.doesNotMatch(r.text, /PRIORITY_COMPANIES/, 'בלי פרטים טכניים לעובד');
  assert.deepEqual(r.buttons, []);
  assert.deepEqual(pr.writes, []);
  // השיחה נסגרה — "כן" אחר כך לא ממשיך לשום קליטה (הוא הולך לבוט הרגיל)
  t.mock.method(console, 'error', () => {});
  await say('כן');
  assert.deepEqual(pr.writes, []);
});

test('בטיחות: חברה אמיתית פתוחה ועותק הבדיקה סגור — לא נקלט לעותק, ולא לחברה האחרת', async (t) => {
  H.companies(t, 'elad1');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);

  const r = await say('קבלת סחורה', { file: H.photo() });
  assert.match(r.text, /a160226\), שעדיין לא פתוחה לקליטה מהבוט/);
  assert.deepEqual(pr.writes, []);
});

test('בטיחות: החברה נסגרה (PRIORITY_COMPANIES) בין הקריאה לקליטה — "סיום" לא מנסה לכתוב, והעובד מקבל הסבר', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('אלעד 49 צפון');
  process.env.PRIORITY_COMPANIES = 'elad1';
  let r = await say(BTN.done);
  assert.deepEqual(pr.writes, []);
  assert.match(r.text, /\(test11\) עדיין לא פתוחה לקליטה מהבוט/);
  assert.doesNotMatch(r.text, /PRIORITY_COMPANIES|מחסן/, 'בלי פרטים טכניים, ובלי לשאול על מחסן');
  H.assertButtons(r.buttons, [BTN.done]);
  // נפתחה שוב — "סיום" כותב
  process.env.PRIORITY_COMPANIES = 'test11';
  r = await say(BTN.done);
  assert.equal(pr.wrote('createReceipt').length, 1);
  assert.match(r.text, /טיוטא לבדיקה/);
});
