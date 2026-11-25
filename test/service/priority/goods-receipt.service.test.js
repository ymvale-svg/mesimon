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
function priority(t, { status = 'טיוטא', reads = {}, writes = {} } = {}) {
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
      cancelReceipt: async () => { state.status = 'מבוטלת'; return {}; },
      ...writes
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
async function toProject(say, file = H.photo()) {
  let r = await say('קבלת סחורה', { file });
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

test('תנאי תשלום אחרי אישור הכותרת ("תעשה שוטף" בשאלת ההזמנה) — מתעדכנים, והשאלה נשארת', async (t) => {
  // מהסקירה של 17.11: העובד אישר את הכותרת, ובשאלת ההזמנה כתב "תעשה שוטף". הבוט חזר על השאלה, 👎 לא החזיר לכותרת,
  // והעובד ביטל ושלח את המסמך מחדש רק כדי לשנות את תנאי התשלום
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  let r = await say(BTN.yes);                   // ← "יש מספר הזמנה?"
  assert.match(r.text, /אין הזמנות פתוחות/);
  r = await say('תעשה שוטף');
  assert.match(r.text, /תנאי התשלום עודכנו: \*שוטף\*/);
  assert.match(r.text, /אין הזמנות פתוחות/, 'שאלת ההזמנה חוזרת');
  H.assertButtons(r.buttons, ['בלי הזמנה ❌', BTN.cancel]);
  r = await say('בלי הזמנה ❌');
  assert.match(r.text, /זה מה שהתקבל בפועל/);
  r = await say('שוטף 60');                     // גם בשלב השורות
  assert.match(r.text, /תנאי התשלום עודכנו: \*שוטף \+ 60\*/);
  assert.match(r.text, /זה מה שהתקבל בפועל/);
  r = await say(BTN.yes);
  r = await say(BTN.yes);
  r = await say('נהריה מגרש 12');
  r = await say(BTN.done);
  assert.match(r.text, /טיוטא לבדיקה/);
  assert.equal(pr.state.head.payCode, require('../../../server/integrations/priority').payFromText('שוטף 60').code);
});

test('הערה לדו-שיח בעוד ניסוחים: "להכניס הערה ש…", "לציין בהערות …", "תכתבי בדו"ח שיח …"', async (t) => {
  // מסקירה 05.11 (PR #112, הועבר לנתיב החדש ב-19.11): "להכניס הערה ש…" לא נרשם כהערה
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  await say(BTN.yes);                           // ← "יש מספר הזמנה?"
  for (const [said, note] of [['להכניס הערה שהסחורה הגיעה רטובה', 'שהסחורה הגיעה רטובה'], ['לציין בהערות שחסר משטח', 'שחסר משטח'], ['תכתבי בדו"ח שיח: נהג איחר', 'נהג איחר']]) {
    const r = await say(said);
    assert.match(r.text, /📝 נרשם בדו-שיח הפנימי/, said);
    assert.match(r.text, new RegExp(note), said);
    assert.match(r.text, /אין הזמנות פתוחות/, 'השאלה הפתוחה חוזרת');
  }
});

test('תעודה של ספק אחר באמצע קליטה — "קבלה נפרדת ⏭️": נכנסת לתור, הנוכחית ממשיכה, ואחרי הסופית — עוברים אליה (סקירה 22.11)', async (t) => {
  // עובד שלח 13 תעודות של ספקים שונים אחת אחרי השנייה; "קבלה חדשה" ביטלה את הנוכחית, אז בחר "צרף כנספח" — וכולן
  // נצמדו לקבלה אחת. עכשיו יש "קבלה נפרדת" — לתור, בלי לבטל
  H.at(t);
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  let extracted = 0;
  H.claude(t, {
    extract: () => (++extracted === 1 ? doc() : doc({ supplier_name: 'בטון הצפון', doc_number: '7702' })),
    project: () => ({ codes: [], question: '', unrelated: false }),
    classify: () => ({ kind: 'new', doc_type: 'delivery_note', doc_number: '7702', supplier_name: 'ספק אחר' })
  });
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  let r = await say(BTN.yes);                                  // ← "יש מספר הזמנה?"
  r = await say('', { file: H.photo() });
  assert.match(r.text, /זה נראה כמו מסמך חדש: תעודת משלוח 7702/);
  H.assertButtons(r.buttons, ['צרף כנספח', 'קבלה נפרדת ⏭️', 'להתעלם ❌']);
  r = await say('קבלה נפרדת ⏭️');
  assert.match(r.text, /📥 .*בתור/);
  assert.match(r.text, /אין הזמנות פתוחות/, 'הנוכחית ממשיכה מאותה שאלה');
  assert.equal(pr.writes.filter((w) => w.fn === 'cancelReceipt').length, 0, 'שום דבר לא בוטל');
  // עד הסופית — ואז עוברים לתעודה שבתור
  await say('בלי הזמנה ❌');
  await say(BTN.yes);
  await say(BTN.yes);
  await say('נהריה מגרש 12');
  await say(BTN.done);
  await say(BTN.approve);
  r = await say('כן, לסגור ✅');
  assert.match(r.text, /נקלטה כסופית/);
  assert.match(r.text, /עובר למסמך הבא/);
  assert.match(r.text, /7702/);
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

test('עריכה ישירה בטבלה: "שורה 1 כמות 3" בטיוטא — הכמות מתעדכנת בפריוריטי, בלי AI', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());                                  // אין מטפל למשימה "reply" — קריאה ל-AI תכשיל את הבדיקה
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('נהריה מגרש 12');
  let r = await say(BTN.done);
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);

  r = await say('שורה 1 כמות 3');
  const [q] = pr.wrote('setLineQty');
  assert.deepEqual(q.args.slice(1), ['GR26000123', 1, 3], 'הכמות נכתבה לשורה 1 בטיוטא');
  H.assertButtons(r.buttons, [BTN.approve, BTN.cancel]);
});

test('נספח (כמו מהמסך): "נספח" + תמונה בשלב הנספחים — מצורף בלי סיווג AI, ו"סיום" פותח טיוטא עם שניהם', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());                                  // אין מטפל ל-"classify" — סיווג יכשיל את הבדיקה
  const { say } = H.chat(t, u);
  await toProject(say);
  let r = await say('נהריה מגרש 12');
  assert.match(r.text, /נספחים/);
  r = await say('נספח', { file: H.photo() });
  assert.doesNotMatch(r.text, /מסמך חדש/);
  r = await say(BTN.done);
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);
  assert.equal(pr.wrote('attach').length, 2, 'המסמך והנספח צורפו לטיוטא');
});

test('🏷️ סופית — מספר ה-GR נכתב על המסמך (במקום הריק שבצד שמאל), נשמר כנספח ב-GR ונשלח לעובד', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc({ blank_area: { x: 0.04, y: 0.04, w: 0.4, h: 0.15 } }));
  const { say } = H.chat(t, u);
  await toProject(say, { buf: require('../../helpers/png').png(), mime: 'image/png', name: 'תעודה.png' });
  await say('נהריה מגרש 12');
  await say(BTN.done);
  await say(BTN.approve);
  const r = await say(BTN.confirmFinal);
  assert.match(r.text, /נקלטה כסופית/);
  assert.match(r.text, /מספר ה-GR נכתב על ה/);
  const att = pr.wrote('attach').map((w) => w.args[2]);
  const st = att.find((a) => /עם מספר ה-GR/.test(a.description));
  assert.ok(st, 'החותמת צורפה ל-GR');
  assert.equal(st.mime, 'application/pdf');
  // ‎sendFile(channel, chatId, file)‎ — הקובץ החתום נשלח לעובד בוואטסאפ
  assert.ok(r.files.some((c) => /GR26000123/.test(c.body[2]?.fileName ?? '')), 'נשלחה לעובד');
});

test('🏷️ החותמת לא הצליחה (קובץ שאי אפשר לקרוא) — הקבלה סופית כרגיל, בלי חותמת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toProject(say);
  await say('נהריה מגרש 12');
  await say(BTN.done);
  await say(BTN.approve);
  const r = await say(BTN.confirmFinal);
  assert.match(r.text, /נקלטה כסופית/);
  assert.doesNotMatch(r.text, /מספר ה-GR נכתב/);
  assert.equal(pr.wrote('attach').filter((w) => /עם מספר ה-GR/.test(w.args[2].description)).length, 0);
});

// ---------------------------------------------------------------------------
// 🔒 תשובה מאוחרת או על הודעה אחרת לא הופכת קבלה לסופית (#171)
// ---------------------------------------------------------------------------

const Q = require('../../../server/whatsapp/wa-questions');

/** מהצילום עד "להפוך לסופית?" */
async function toConfirmFinal(say) {
  await toProject(say);
  await say('אלעד 49 צפון');
  await say('סיום');
  const r = await say('👍');
  assert.match(r.text, /לסופית\?/);
  return r;
}

/** המצב השמור "התיישן": ‎min‎ דקות בלי תנועה (וגם שאלת "סופית?" נשאלה אז) */
function age(u, min) {
  const k = `goods_receipt:${u.id}`;
  const s = H.D.getSetting(k);
  const at = Date.now() - min * 60 * 1000;
  H.D.setSetting(k, { ...s, at, ...(s.confirmFinal ? { confirmFinalAt: at } : {}) });
}

test('🔒 👍 כתגובה על הודעה אחרת (לא על "להפוך לסופית?") — לא סוגר; על השאלה עצמה — סוגר', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toConfirmFinal(say);

  let r = await say('👍', { reaction: true, on: 'some-other-message' });
  assert.match(r.text, /על הודעה אחרת/);
  assert.equal(pr.wrote('finalizeReceipt').length, 0, '👍 על הודעה אחרת אינו תשובה');

  r = await say('👍', { reaction: true });
  assert.match(r.text, /נקלטה כסופית/);
  assert.equal(pr.wrote('finalizeReceipt').length, 1);
});

test('🔒 הכפתורים נרשמים עם מספר ה-GR — "כן ✅" ישן של קבלה אחרת: "השאלה כבר לא פתוחה", ולא נסגר', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  const asked = await toConfirmFinal(say);
  assert.equal(Q.find(u.id, asked.questionId).draft.doc, 'GR26000123');

  Q.record(u.id, 'OLD-GR-BTN', { owner: 'goods_receipt', draft: { doc: 'GR25000999' } });
  let r = await say(BTN.confirmFinal, { press: 'OLD-GR-BTN' });
  assert.deepEqual(r.texts, [Q.CLOSED_TEXT]);
  assert.equal(pr.wrote('finalizeReceipt').length, 0);

  r = await say(BTN.confirmFinal, { press: asked.questionId });
  assert.match(r.text, /נקלטה כסופית/);
  assert.equal(pr.wrote('finalizeReceipt').length, 1);
});

test('⏳ "להפוך לסופית?" לפני 20 דקות — 👍 לא סוגר: הטיוטא מוצגת שוב, ושואלים מחדש', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t, doc());
  const { say } = H.chat(t, u);
  await toConfirmFinal(say);
  age(u, 20);

  let r = await say('👍', { reaction: true });
  assert.match(r.text, /עבר זמן/);
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);
  H.assertButtons(r.buttons, [BTN.approve, BTN.cancel]);
  assert.equal(pr.wrote('finalizeReceipt').length, 0, 'תשובה מאוחרת אינה אישור סופי');

  r = await say('👍');
  assert.match(r.text, /לסופית\?/);
  assert.equal(pr.wrote('finalizeReceipt').length, 0);
  r = await say('👍');
  assert.match(r.text, /נקלטה כסופית/);
  assert.equal(pr.wrote('finalizeReceipt').length, 1);
});

// ---------------------------------------------------------------------------
// 🆕 מק"טים לבנייה (‎pd-parts.js‎): שורה בלי מק"ט ← "לשלוח למנהלת הרכש?" ← מייל; הקליטה ממשיכה על 000
// ---------------------------------------------------------------------------

const Settings = require('../../../server/priority/priority-settings');
const Mailer = require('../../../server/integrations/mailer');
const Parts = require('../../../server/priority/pd-parts');
const { D } = require('../../helpers/db');

let grPhone = 0;
const grWorker = () => { grPhone += 1; return H.worker({ phone: `97259${String(4000000 + grPhone)}` }); };
function buyer(t) {
  t.mock.method(Settings, 'defaults', () => ({ ...Settings.DEFAULTS, buyerName: 'רותי רכש', buyerEmail: 'ruti@example.com' }));
  t.mock.method(Mailer, 'isEnabled', () => true);
  const sent = [];
  t.mock.method(Mailer, 'send', async (m) => { sent.push(m); return {}; });
  return sent;
}
/** עד שאלת המק"טים, כשאין לבטון מק"ט בקטלוג (מק"ט כללי 000) */
async function toParts(say) {
  await say('קבלת סחורה', { file: H.photo() });
  await say('👍');
  await say('בלי הזמנה ❌');
  const r = await say(BTN.yes);
  assert.match(r.text, /000/);
  return say(BTN.yes);
}
const noPart = { findPartExact: async () => null, searchParts: async () => [] };

/** מהשאלה "לאיזה פרויקט" — עד "נקלטה כסופית" */
async function toFinal(say) {
  let r = await say('נהריה מגרש 12');
  for (let i = 0; i < 8 && !/נקלטה כסופית/.test(r.text); i++) {
    const btn = r.buttons.includes(BTN.confirmFinal) ? BTN.confirmFinal : r.buttons.includes(BTN.approve) ? BTN.approve
      : r.buttons.includes(BTN.done) ? BTN.done : r.buttons.includes(BTN.yes) ? BTN.yes : r.buttons[0];
    r = await say(btn);
  }
  return r;
}

test('פער 4 (25.11.26): קבלה בלי הזמנה עם 000 — בלי שאלה לעובד; כשהקבלה סופית — לרכש אוטומטית, והמק"ט שנבנה מודיע', async (t) => {
  H.at(t);                                      // שעות העבודה — ההודעות לעובד יוצאות מיד
  H.companies(t, 'test11');
  const u = grWorker();
  let built = false;
  const NEW = { PARTNAME: 'B-31', PARTDES: 'בטון ב-30 מובא', STATDES: 'פעיל', BUD_SUBCHAPTERNAME: '20', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '20-10', BUD_SUBTOPICDES: 'בטון' };
  const pr = priority(t, { reads: { findPartExact: async () => null, searchParts: async () => (built ? [{ p: NEW, score: 2, full: true }] : []) } });
  ai(t, doc());
  const sent = buyer(t);
  const { say, wa } = H.chat(t, u);

  let r = await toParts(say);
  assert.doesNotMatch(r.text, /לשלוח ל.* לבניית מק"טים\?/, 'בלי שאלה');
  assert.match(r.text, /לאיזה פרויקט לשייך/);
  assert.equal(sent.length, 0, 'עוד לא — רק כשהקבלה סופית');

  r = await toFinal(say);
  assert.match(r.text, /נקלטה כסופית/);
  assert.equal(pr.wrote('addFreeLine')[0].args[2].part, '000', 'הקבלה נקלטת על 000 — לא מחכים לרכש');
  assert.match(r.text, /שורה אחת נקלטה על מק"ט כללי — עבר לרותי רכש \(רכש\) לבניית מק"ט/);
  const mail = sent.find((m) => /מק"טים נדרשים לבנייה/.test(m.subject));
  assert.ok(mail);
  assert.match(mail.text, /קבלת סחורה מבוט משימון/);
  assert.match(mail.text, /1\. בטון ב-30 — 5 קוב/);

  // הרכש בנה — רק הודעה, בלי שאלה על בנייה מחדש
  D.run("UPDATE pd_part_requests SET status = 'expired' WHERE user_id != ?", u.id);
  built = true;
  wa.clear();
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 1 });
  const note = wa.texts().join('\n');
  assert.match(note, /בטון ב-30 — 5 קוב ← \*בטון ב-30 מובא\* \(B-31\)/);
  assert.doesNotMatch(note, /לבנות/);
});

test('פער 4: אגרה / שכר טרחה על 000 — לא נשלחת לבניית מק"ט; בלי מנהלת רכש — כלום', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = grWorker();
  priority(t, { reads: noPart });
  ai(t, doc({ lines: [{ ...doc().lines[0], description: 'אגרת שילוט שנתית' }] }));
  const sent = buyer(t);
  const { say } = H.chat(t, u);
  await toParts(say);
  const r = await toFinal(say);
  assert.match(r.text, /נקלטה כסופית/);
  assert.doesNotMatch(r.text, /לבניית מק"ט/);
  assert.equal(sent.filter((m) => /מק"טים נדרשים לבנייה/.test(m.subject)).length, 0);
});

test('מק"טים לבנייה בקבלת סחורה: בלי מנהלת רכש מוגדרת — ישר לפרויקט, כמו קודם', async (t) => {
  H.companies(t, 'test11');
  const u = grWorker();
  priority(t, { reads: noPart });
  ai(t, doc());
  const { say } = H.chat(t, u);
  const r = await toParts(say);
  assert.doesNotMatch(r.text, /לבניית מק"טים/);
  assert.match(r.text, /לאיזה פרויקט לשייך/);
});

// ---------------------------------------------------------------------------
// 📣 לרכש מקבלת סחורה (18.11.26): שורה שלא בהזמנה — נקלטת ומסומנת; תעודה בלי מספר הזמנה — לדוח השבועי
// ---------------------------------------------------------------------------

const BuyerNotices = require('../../../server/priority/buyer-notices');
const PO = { ORDNAME: 'PO26000050', CURDATE: '2026-11-01', PROJDOCNO: 'PR1', PROJDES: 'אלעד 49 צפון', PAYCODE: '04', WARHSNAME: 'W1',
  lines: [{ LINE: 1, KLINE: 1, PARTNAME: 'B-30', PDES: 'בטון ב-30', TQUANT: 50, TBALANCE: 45, TUNITNAME: 'קוב', PRICE: 200, PERCENT: 0 }] };
const WAIT_LINE = { description: 'המתנה במשאבה — שעתיים', supplier_code: '', qty: 2, unit: 'שעה', unit_price: 300, discount_pct: 0, line_total: 600, handwritten: '', unclear: false, options: [] };

/** מהצילום עד "נקלטה כסופית", מול ההזמנה PO26000050 (שורה 1 — בהזמנה, שורה 2 "המתנה" — לא) */
async function toFinalWithOrder(t, { poNumber = '', reads = {}, writes = {} } = {}) {
  H.at(t);
  H.companies(t, 'test11');
  const u = grWorker();
  const pr = priority(t, { writes, reads: { openOrders: async () => [PO], getOrder: async (c, n) => (n === PO.ORDNAME ? { ...PO, SUPNAME: 'S100', STATDES: 'אושרה' } : null), ...reads } });
  H.claude(t, {
    extract: () => doc({ po_number: poNumber, lines: [doc().lines[0], WAIT_LINE] }),
    project: () => ({ codes: [], question: '', unrelated: false }),
    match: () => ({ best_order: PO.ORDNAME, matches: [{ doc_line: 1, order: PO.ORDNAME, line: 1, confidence: 'high' }] })
  });
  const sent = buyer(t);
  const { say } = H.chat(t, u);
  let r = await say('קבלת סחורה', { file: H.photo() });
  r = await say('👍');
  assert.match(r.text, /לפי הזמנה \*PO26000050\*/);
  assert.match(r.text, /המתנה במשאבה — שעתיים\n {3}התקבל: \*2\* שעה\n {3}⚠️ לא בהזמנה — יסומן לרכש/);
  const steps = [];
  for (let i = 0; i < 8 && !/נקלטה כסופית/.test(r.text); i++) {
    const btn = r.buttons.includes(BTN.confirmFinal) ? BTN.confirmFinal : r.buttons.includes(BTN.approve) ? BTN.approve
      : r.buttons.includes(BTN.done) ? BTN.done : r.buttons.includes(BTN.yes) ? BTN.yes : r.buttons[0];
    steps.push(btn);
    r = await say(btn);
  }
  assert.match(r.text, /נקלטה כסופית/, `השלבים: ${steps.join(' → ')}`);
  return { u, pr, sent, r };
}

test('שורה שלא בהזמנה: נקלטת, מסומנת בדו-שיח, וכשהקבלה סופית — מייל לרכש שמחליט; העובד יודע', async (t) => {
  const { u, pr, sent, r } = await toFinalWithOrder(t, { poNumber: 'PO26000050' });
  assert.match(r.text, /שורה אחת לא בהזמנה — סומנה לרכש, והרכש מחליט אם לקבל/);
  // נקלטה (לא נעצרה)
  assert.equal(pr.wrote('addOrderLine').length, 1);
  assert.equal(pr.wrote('addFreeLine').length, 1);
  const dialog = pr.wrote('setDialog').at(-1).args[2].join('\n');
  assert.match(dialog, /שורה 2 \(המתנה במשאבה — שעתיים\) — לא בהזמנה PO26000050; לבדיקת הרכש/);
  const mail = sent.find((m) => /לא בהזמנה/.test(m.subject));
  assert.ok(mail, 'מייל לרכש');
  assert.equal(mail.to, 'ruti@example.com');
  assert.match(mail.subject, /שורה שלא בהזמנה — GR26000123 · בטון הצפון/);
  assert.match(mail.text, /1\. המתנה במשאבה — שעתיים — 2 שעה × 300\.00/);
  assert.match(mail.text, /נקלטה ע"י: /);
  assert.doesNotMatch(mail.text, /בטון ב-30 — 5/, 'רק מה שלא בהזמנה');
  // מספר ההזמנה הופיע בתעודה — לא לדוח
  assert.equal(D.get('SELECT COUNT(*) n FROM gr_no_po WHERE user_id = ?', u.id).n, 0);
});

test('תעודה בלי מספר הזמנה, שנקלטה מול הזמנה — נרשמת לדוח השבועי; ביום ראשון בבוקר — דוח אחד לרכש, לפי ספק', async (t) => {
  const { u, sent } = await toFinalWithOrder(t, { poNumber: '' });
  const row = D.get('SELECT * FROM gr_no_po WHERE user_id = ?', u.id);
  assert.ok(row);
  assert.deepEqual([row.supname, row.booknum, row.docno, row.ordname, row.reported_at], ['S100', '5501', 'GR26000123', 'PO26000050', null]);
  D.run('UPDATE gr_no_po SET reported_at = ? WHERE user_id != ? AND reported_at IS NULL', D.nowIso(), u.id);
  D.setSetting('gr_no_po_report_last', '');
  const before = sent.length;

  t.mock.timers.setTime(new Date('2026-11-10T08:00:00Z').getTime());   // שלישי — לא יום הדוח
  assert.deepEqual(await BuyerNotices.weekly(), { sent: false, rows: 0 });
  t.mock.timers.setTime(new Date('2026-11-15T05:00:00Z').getTime());   // ראשון 07:00 — לפני סיכום הבוקר
  assert.deepEqual(await BuyerNotices.weekly(), { sent: false, rows: 0 });
  t.mock.timers.setTime(new Date('2026-11-15T07:00:00Z').getTime());   // ראשון 09:00
  assert.deepEqual(await BuyerNotices.weekly(), { sent: true, rows: 1 });
  const rep = sent.slice(before).find((m) => /בלי מספר הזמנה/.test(m.subject));
  assert.ok(rep);
  assert.match(rep.text, /בטון הצפון \(S100, test11\) — 1/);
  assert.match(rep.text, /תעודה 5501 · .* · GR26000123 · הזמנה PO26000050/);
  assert.ok(D.get('SELECT reported_at FROM gr_no_po WHERE id = ?', row.id).reported_at);
  assert.deepEqual(await BuyerNotices.weekly(), { sent: false, rows: 0 }, 'פעם אחת ביום ראשון');
});

test('קבלה בלי הזמנה — לא נרשמת לדוח, ובלי סימון "לא בהזמנה"', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = grWorker();
  priority(t);
  ai(t, doc());
  buyer(t);
  const { say } = H.chat(t, u);
  const r = await toProject(say);
  assert.doesNotMatch(r.text, /לא בהזמנה/);
  await say('נהריה מגרש 12');
  await say(BTN.done);
  await say(BTN.approve);
  const fin = await say(BTN.confirmFinal);
  assert.match(fin.text, /נקלטה כסופית/);
  assert.doesNotMatch(fin.text, /לא בהזמנה/);
  assert.equal(D.get('SELECT COUNT(*) n FROM gr_no_po WHERE user_id = ?', u.id).n, 0);
});

// ---------------------------------------------------------------------------
// 📧 חוסר / פגם מול התעודה — מייל לספק, עותק לרכש (23.11.26)
// ---------------------------------------------------------------------------

/** קבלה בלי הזמנה, בטון 5 קוב בתעודה — "קיבלתי רק 3" — עד "נקלטה כסופית" ושאלת החוסר */
async function toShortage(t, { supplierEmail = 'orders@beton.example' } = {}) {
  H.at(t);
  H.companies(t, 'test11');
  const u = grWorker();
  const pr = priority(t, { reads: { supplierContact: async () => ({ email: supplierEmail, phone: '04-1234567', contact: null }) } });
  H.claude(t, {
    extract: () => doc(),
    project: () => ({ codes: [], question: '', unrelated: false }),
    reply: () => ({ action: 'update', renames: [], updates: [{ line: 1, qty: 3 }], adds: [], note: '2 קוב חזרו — סדוק', question: '', answer: '' })
  });
  const sent = buyer(t);
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  await say('👍');
  await say('בלי הזמנה ❌');
  let r = await say('קיבלתי רק 3 קוב, 2 חזרו סדוקים');
  assert.match(r.text, /בטון ב-30/);
  for (let i = 0; i < 8 && !/נקלטה כסופית/.test(r.text); i++) {
    const btn = r.buttons.includes(BTN.confirmFinal) ? BTN.confirmFinal : r.buttons.includes(BTN.approve) ? BTN.approve
      : r.buttons.includes(BTN.done) ? BTN.done : r.buttons.includes(BTN.yes) ? BTN.yes : r.buttons[0] ?? 'נהריה מגרש 12';
    r = await say(btn);
  }
  assert.match(r.text, /נקלטה כסופית/);
  return { u, pr, sent, r, say };
}

test('📧 חוסר מול התעודה: אחרי "סופית" — "לשלוח לספק ולרכש?" ← כן: מייל לספק, עותק לרכש, עם הקבלה והתמונות', async (t) => {
  const { sent, r, say } = await toShortage(t);
  assert.match(r.text, /חוסר \/ פגם מול התעודה:\*\n• בטון ב-30 — בתעודה 5, התקבל 3/);
  assert.match(r.text, /לשלוח לספק ולרכש\?/);
  H.assertButtons(r.buttons, [BTN.yes, BTN.no]);
  const before = sent.length;

  const a = await say(BTN.yes);
  assert.match(a.text, /נשלח לספק \(orders@beton\.example\), עם עותק לרכש/);
  const m = sent.slice(before).find((x) => /חוסר \/ פגם/.test(x.subject));
  assert.ok(m, 'המייל יצא');
  assert.equal(m.to, 'orders@beton.example');
  assert.deepEqual(m.cc, ['ruti@example.com']);
  assert.match(m.subject, /בטון הצפון · תעודה 5501 · GR26000123/);
  assert.match(m.text, /1\. בטון ב-30 — בתעודה 5, התקבל בפועל 3 קוב \(חסר 2\)/);
  assert.deepEqual(m.attachments.map((f) => f.fileName), ['GR26000123.pdf', 'תמונה 1.jpg']);
});

test('📧 חוסר — אין מייל לספק בכרטיס: נשלח לרכש כנמענת ראשית, והעובד יודע', async (t) => {
  const { sent, say } = await toShortage(t, { supplierEmail: '' });
  const before = sent.length;
  const a = await say(BTN.yes);
  assert.match(a.text, /אין מייל לספק בכרטיס בפריוריטי — נשלח לרכש \(ruti@example\.com\)/);
  const m = sent.slice(before).find((x) => /חוסר \/ פגם/.test(x.subject));
  assert.equal(m.to, 'ruti@example.com');
  assert.deepEqual(m.cc, []);
});

test('📧 חוסר — "לא": שום מייל לא יוצא; בלי חוסר — בלי שאלה', async (t) => {
  const { sent, say } = await toShortage(t);
  const before = sent.length;
  const a = await say(BTN.no);
  assert.match(a.text, /לא נשלח/);
  assert.equal(sent.slice(before).filter((x) => /חוסר/.test(x.subject)).length, 0);
});

// רעיון מסקירה 24.11 (נבנה 24.11): המק"ט "כמו בקליטות קודמות" נדחה בפריוריטי לפרויקט (תת הפרק לא במהדורת התכנון),
// והשורה נקלטה על 000 — 4 פעמים ברצף, כל פעם עם תקלה. עכשיו: הדחייה נזכרת לפי חברה ופרויקט, ובקליטה הבאה — ישר
// לקידוד שעבד, בלי לנסות שוב ובלי תקלה.
test('מק"ט שנדחה בפרויקט — בקליטה הבאה לאותו פרויקט נקלט ישר על הקידוד שעבד, בלי ניסיון ובלי תקלה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const tries = [];
  const pr = priority(t, { writes: { addFreeLine: async (c, docno, line) => {
    tries.push(line.part);
    if (line.part === 'B-30') throw Object.assign(new Error('קודתת פרק 20: יש לבחור תת פרק מרשימת הבחירה'), { status: 400 });
    return {};
  } } });
  ai(t, doc());
  const { say } = H.chat(t, u);

  // קליטה ראשונה: B-30 נדחה ← 000 (כמו היום)
  await toProject(say);
  await say('נהריה מגרש 12');
  let r = await say(BTN.done);
  assert.match(r.text, /GR26000123\* — טיוטא לבדיקה/);
  assert.deepEqual(tries, ['B-30', '000']);
  await say(BTN.approve);
  await say(BTN.confirmFinal);

  // קליטה שנייה לאותו פרויקט (ברירת המחדל): ישר 000, בלי לנסות את B-30
  tries.length = 0;
  await toProject(say);
  r = await say(BTN.done);
  assert.match(r.text, /טיוטא לבדיקה/);
  assert.deepEqual(tries, ['000'], 'בלי ניסיון נוסף של המק"ט שנדחה');
  // לדו-שיח הפנימי (כמו כל הערת קליטה) — שהנהלת החשבונות תדע למה 000
  assert.match(JSON.stringify(pr.wrote('setDialog').at(-1).args), /B-30 לא פתוח בפרויקט הזה/);
  const line = pr.wrote('addFreeLine').at(-1).args[2];
  assert.equal(line.part, '000');
});

test('פער 3 (25.11.26): קבלה מול הזמנה — שורה שלא בהזמנה ובלי מק"ט לא נקלטת על 000, ועוברת לרכש', async (t) => {
  // "המתנה במשאבה" — אין לה מק"ט בקטלוג (רק הבטון)
  const { pr, sent, r } = await toFinalWithOrder(t, { poNumber: 'PO26000050', reads: { findPartExact: async (c, des) => (/בטון/.test(des) ? { PARTNAME: 'B-30', PARTDES: des, BUD_SUBCHAPTERNAME: '20', BUD_SUBTOPICNAME: '20-10' } : null) } });
  assert.equal(pr.wrote('addFreeLine').length, 0, 'אין שורת 000 בקבלה מול הזמנה');
  assert.equal(pr.wrote('addOrderLine').length, 1);
  assert.match(r.text, /שורה אחת לא בהזמנה ובלי מק"ט — לא נקלטה ועברה לרכש/);
  const mail = sent.find((m) => /לא בהזמנה/.test(m.subject));
  assert.match(mail.text, /לא נקלטו — אין להן מק"ט/);
  assert.match(mail.text, /המתנה במשאבה — שעתיים — 2 שעה × 300\.00 — לא נקלטה \(בלי מק"ט\)/);
});

test('פער 5 (25.11.26): קבלה מול הזמנה — שורה עם מק"ט שפריוריטי דחה לא חוזרת ל-000', async (t) => {
  const { pr, r } = await toFinalWithOrder(t, { poNumber: 'PO26000050', writes: { addFreeLine: async () => { throw new Error('יש לקשר תת פרק'); } } });
  const written = pr.wrote('addFreeLine').map((w) => w.args[2].part);
  assert.ok(!written.includes('000'), `לא ניסה 000: ${written.join(', ')}`);
  assert.match(r.text, /לא בהזמנה/);
});

test('פער 6 (25.11.26): מק"ט שהרכש בנה לפריט מספק — הקבלה הבאה של אותו פריט נקלטת עליו, לא על 000', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = grWorker();
  const NEW = { PARTNAME: 'B-31', PARTDES: 'בטון ב-30 מובא', STATDES: 'פעיל', BUD_SUBCHAPTERNAME: '20', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '20-10', BUD_SUBTOPICDES: 'בטון' };
  priority(t, { reads: { findPartExact: async () => null, searchParts: async () => [], partByCode: async (c, code) => (code === 'B-31' ? NEW : null) } });
  ai(t, doc());
  buyer(t);
  // הרכש בנה בעבר את B-31 ל"בטון ב30" מהספק S100 (בכתיב קצת אחר)
  Parts._remember({ company: 'test11', header: { supcode: 'S100' } }, { description: 'בטון ב30', built: { code: 'B-31' } });
  assert.equal(Parts.aliasOf('test11', 'S100', 'בטון ב-30'), 'B-31');
  assert.equal(Parts.aliasOf('test11', 'S999', 'בטון ב-30'), null, 'ספק אחר — לא');
  const { say } = H.chat(t, u);
  await say('קבלת סחורה', { file: H.photo() });
  await say('👍');
  await say('בלי הזמנה ❌');
  const r = await say(BTN.yes);
  assert.match(r.text, /B-31/);
  assert.match(r.text, /המק"ט שהרכש בנה לפריט הזה/);
  assert.doesNotMatch(r.text, /← 000/);
});
