'use strict';
/**
 * 🏷️ הוספה למחירון ספק מהזמנה — מקצה לקצה: הזמנה סופית ← הודעה למי שברשימה "רכש — מחירונים" ← בחירה ← סיכום ←
 * "מאשר" ← כתיבה למחירון ול"מוצרים לספק" ← ביטול. פריוריטי ווואטסאפ מזויפים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, worker, at, chat, assertButtons, Fakes, D } = require('./helpers');
const Settings = require('../../../server/priority/priority-settings');
const PL = require('../../../server/priority/po-pricelist');

setup();

const order = (o = {}) => ({
  ORDNAME: `PO2600${Math.floor(Math.random() * 1e6)}`, SUPNAME: 'S-1', CDES: 'ספק הדוגמה', PROJDOCNO: 'PR7', PROJDES: 'אלעד סנטר', CODE: 'ש"ח', CURVERSION: 1,
  lines: [
    { LINE: 1, PARTNAME: 'A-1', PDES: 'צינור PVC 110', TUNITNAME: 'מטר', PRICE: 32.5, PERCENT: 0 },
    { LINE: 2, PARTNAME: 'B-2', PDES: 'זווית PVC', TUNITNAME: "יח'", PRICE: 10, PERCENT: 11 },
    { LINE: 3, PARTNAME: 'C-3', PDES: 'דבק PVC', TUNITNAME: "יח'", PRICE: 41, PERCENT: 0 },
    { LINE: 4, PARTNAME: 'K-4', PDES: 'בלוק 20', TUNITNAME: "יח'", PRICE: 5, PERCENT: 0 },
    { LINE: 5, PARTNAME: '000', PDES: 'מוצר כללי', PRICE: 0 }
  ],
  ...o
});
const LISTS = () => [
  { name: '0007', des: 'אלעד', date: '2026-09-01T00:00:00Z', code: 'ש"ח', projects: ['PR7'], projectNames: ['אלעד סנטר'], parts: new Set(['K-4']) },
  { name: '0003', des: 'כללי', date: '2026-08-01T00:00:00Z', code: 'ש"ח', projects: [], projectNames: [], parts: new Set() },
  { name: '0009', des: 'אחר', date: '2026-10-01T00:00:00Z', code: 'ש"ח', projects: ['PR8'], projectNames: ['אחר'], parts: new Set(['A-1']) }
];

function world(t, { lists = LISTS, supParts = [{ PARTNAME: 'C-3', KLINE: 1 }] } = {}) {
  // העובד לפני השעון הקבוע — המייל שלו נבנה מהשעה, ושעה קבועה מתנגשת בין בדיקות
  const buyer = worker({ role: 'manager', full_name: 'שקמה רכש' });
  at(t);
  const on = { enabled: true, audience: 'all', examples: [] };
  D.setSetting('wa_actions', { ...D.getSetting('wa_actions', {}), po_pricelist: on });
  t.mock.method(Settings, 'defaults', () => ({ ...Settings.DEFAULTS, pricelistHandlers: [buyer.id] }));
  t.mock.method(Settings, 'writable', () => ['test11']);
  let seq = 100;
  const pr = Fakes.priority(t, { supplierPriceLists: async () => lists(), supplierParts: async () => (typeof supParts === 'function' ? supParts() : supParts) }, {
    writes: { addPriceListItem: async () => ({ PART: ++seq, QUANT: 1 }), addSupplierPart: async () => ({ KLINE: ++seq }) }
  });
  return { buyer, pr };
}

test('הזמנה סופית ← הודעה לרכש: רק מה שלא במחירון הפרויקט / הכללי, במחיר אחרי הנחה; 000 — לא', async (t) => {
  const { buyer } = world(t);
  const c = chat(t, buyer);
  const b = await PL.offer('test11', order());
  assert.equal(b.status, 'pending');
  const msg = c.wa.texts().join('\n');
  assert.match(msg, /פריטים שלא במחירון של ספק הדוגמה/);
  assert.match(msg, /1\. צינור PVC 110 \(A-1\) — 32\.50 ₪ למטר/, 'A-1 במחירון של פרויקט אחר — עדיין מוצע');
  assert.match(msg, /2\. זווית PVC \(B-2\) — 8\.90 ₪/);
  assert.match(msg, /3\. דבק PVC/);
  assert.doesNotMatch(msg, /בלוק 20|מוצר כללי/);
  assert.match(msg, /מחירון: 0007 אלעד \(אלעד סנטר\)/);
  assertButtons(c.wa.buttons(), [PL.BTN.all, PL.BTN.pick, PL.BTN.no]);
});

test('"רק 1 ו-3" ← סיכום ← "מאשר" ← למחירון, ול"מוצרים לספק" רק מה שעוד לא שם', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  const po = order();
  await PL.offer('test11', po);
  let r = await c.say('רק 1 ו-3');
  assert.match(r.text, /לכתוב למחירון של ספק הדוגמה/);
  assert.match(r.text, /צינור PVC 110/);
  assert.doesNotMatch(r.text, /זווית/);
  assertButtons(r.buttons, [PL.BTN.ok, PL.BTN.cancel]);
  r = await c.say(PL.BTN.ok, { press: r.questionId });
  assert.match(r.text, /נוספו 2 פריטים למחירון של ספק הדוגמה \(0007\)/);
  assert.deepEqual(pr.wrote('addPriceListItem').map((w) => [w.args[1].name, w.args[2].part, w.args[2].price]), [['0007', 'A-1', 32.5], ['0007', 'C-3', 41]]);
  assert.deepEqual(pr.wrote('addSupplierPart').map((w) => w.args[2]), ['A-1'], 'C-3 כבר ב"מוצרים לספק"');
  const row = D.get('SELECT status, handler_id FROM po_pricelist_offers WHERE ordname = ?', po.ORDNAME);
  assert.deepEqual([row.status, row.handler_id], ['done', buyer.id]);
});

test('"לבטל את ההוספה למחירון" ← "כן, לבטל" ← נמחק רק מה שנכתב', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  await PL.offer('test11', order());
  await c.say(PL.BTN.all);
  await c.say(PL.BTN.ok);
  let r = await c.say('לבטל את ההוספה למחירון');
  assertButtons(r.buttons, [PL.BTN.undo, PL.BTN.keep]);
  r = await c.say(PL.BTN.undo);
  assert.match(r.text, /בוטל: 3 פריטים הוסרו/);
  assert.equal(pr.wrote('deletePriceListItem').length, 3);
  assert.equal(pr.wrote('deleteSupplierPart').length, 2);
});

test('"לא" — לא נכתב כלום; ולספק בלי מחירון — רק הודעה, פעם אחת', async (t) => {
  const { buyer, pr } = world(t, { lists: () => [] });
  const c = chat(t, buyer);
  const b = await PL.offer('test11', order({ SUPNAME: 'S-NO' }));
  assert.equal(b.status, 'no_list');
  assert.match(c.wa.texts().join('\n'), /אין מחירון בפריוריטי/);
  assert.deepEqual(c.wa.buttons(), []);
  c.wa.clear();
  await PL.offer('test11', order({ SUPNAME: 'S-NO' }));
  assert.deepEqual(c.wa.texts(), [], 'אותו ספק — לא שוב');
  assert.equal(pr.writes.length, 0);
});

test('"לא ❌" על ההצעה — נסגרת בלי כתיבה', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  const po = order();
  await PL.offer('test11', po);
  await c.say(PL.BTN.no);
  assert.equal(D.get('SELECT status FROM po_pricelist_offers WHERE ordname = ?', po.ORDNAME).status, 'declined');
  assert.equal(pr.writes.length, 0);
});

test('כל הפריטים כבר במחירון — אין הודעה; ומי שאינו ברשימה — לא מקבל ולא יכול לבקש', async (t) => {
  const { buyer } = world(t, { lists: () => [{ name: '0003', des: '', date: '2026-08-01T00:00:00Z', projects: [], projectNames: [], parts: new Set(['A-1', 'B-2', 'C-3', 'K-4']) }] });
  const other = worker({ email: `other-${process.hrtime.bigint()}@test.local` });
  const c = chat(t, buyer);
  const b = await PL.offer('test11', order());
  assert.equal(b.status, 'none');
  assert.deepEqual(c.wa.texts(), []);
  const o = chat(t, other);
  const r = await o.say('מחירון PO26000123');
  assert.doesNotMatch(r.text, /פריטים שלא במחירון/);
});

test('חברה שאינה פתוחה לכתיבה — לא מציעים', async (t) => {
  const { buyer } = world(t);
  t.mock.method(Settings, 'writable', () => []);
  const c = chat(t, buyer);
  assert.equal(await PL.offer('test11', order()), null);
  assert.deepEqual(c.wa.texts(), []);
});

test('פריוריטי מוסיף לבד ל"מוצרים לספק" — לא מוסיפים שוב, והביטול מוחק גם את השורה שנוצרה', async (t) => {
  // כמו בפריוריטי: אחרי שנכתבה שורת מחירון — יש שורה ב"מוצרים לספק"
  let pr = null;
  const auto = () => (pr?.wrote('addPriceListItem').length ? [{ PARTNAME: 'A-1', KLINE: 77 }] : []);
  const w = world(t, { supParts: auto });
  pr = w.pr;
  const c = chat(t, w.buyer);
  await PL.offer('test11', order());
  await c.say('רק 1');
  const r = await c.say(PL.BTN.ok);
  assert.match(r.text, /נוסף פריט אחד/);
  assert.equal(pr.wrote('addSupplierPart').length, 0);
  await c.say('לבטל את ההוספה למחירון');
  await c.say(PL.BTN.undo);
  assert.deepEqual(pr.wrote('deleteSupplierPart').map((w) => w.args[2]), [77]);
});

test('🗂 מהמסך: בחירה, מחיר ומחירון ← כתיבה; אחר כך ביטול; ומי שאינו ברשימה — 403', async (t) => {
  const { buyer, pr } = world(t);
  chat(t, buyer);
  const po = order();
  const b = await PL.offer('test11', po);
  const scr = PL.forScreen(buyer.id);
  const o = scr.open.find((x) => x.id === b.id);
  assert.ok(o, 'ההצעה ברשימה של המסך');
  assert.deepEqual(o.items.map((x) => x.part), ['A-1', 'B-2', 'C-3']);
  const general = o.lists.find((l) => l.general);
  const r = await PL.act(buyer.id, b.id, { action: 'write', list: general, items: [{ n: 1, pick: true, price: 30 }, { n: 2, pick: false }, { n: 3, pick: false }] });
  assert.match(r.text, /נוסף פריט אחד למחירון של ספק הדוגמה \(0003\)/);
  assert.deepEqual(pr.wrote('addPriceListItem').map((w) => [w.args[1].name, w.args[2].part, w.args[2].price]), [['0003', 'A-1', 30]]);
  assert.equal(r.offer.status, 'done');
  assert.equal(r.offer.canUndo, true);
  await assert.rejects(PL.act(buyer.id, b.id, { action: 'write' }), (e) => e.status === 409);
  const u = await PL.act(buyer.id, b.id, { action: 'undo' });
  assert.equal(u.offer.status, 'undone');
  assert.equal(pr.wrote('deletePriceListItem').length, 1);
  const other = worker({ email: `scr-${process.hrtime.bigint()}@test.local` });
  assert.throws(() => PL.forScreen(other.id), (e) => e.status === 403);
});

test('🗂 מהמסך: הצעה שמישהו אחר כבר מטפל בה בבוט — 409; "לא" — נסגרת', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  const b = await PL.offer('test11', order());
  await c.say('רק 1');
  const admin = worker({ role: 'admin', email: `adm-${process.hrtime.bigint()}@test.local` });
  assert.equal(PL.forScreen(admin.id).open.find((x) => x.id === b.id).busy, true);
  await assert.rejects(PL.act(admin.id, b.id, { action: 'decline' }), (e) => e.status === 409);
  const r = await PL.act(buyer.id, b.id, { action: 'decline' });
  assert.equal(r.offer.status, 'declined');
  assert.equal(pr.writes.length, 0);
});

/** מזהה ההודעה האחרונה עם כפתורים — ההודעה של השאלה (בשביל תגובה עליה) */
const askedId = (c) => c.wa.calls.filter((x) => x.method === 'sendInteractiveButtonsReply').at(-1)?.id;

test('👍 כתגובה על השאלה = כן: על ההצעה ← סיכום, על הסיכום ← נכתב', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  await PL.offer('test11', order());
  let r = await c.say('👍', { reaction: true, on: askedId(c) });
  assert.match(r.text, /לכתוב למחירון של ספק הדוגמה/);
  r = await c.say('👍', { reaction: true });
  assert.match(r.text, /נוספו 3 פריטים/);
  assert.equal(pr.wrote('addPriceListItem').length, 3);
});

test('👎 כהודעה על הסיכום = שלב אחורה (חזרה לבחירה, בלי כתיבה); 👎 כתגובה על הסיכום = לא', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  const po = order();
  await PL.offer('test11', po);
  await c.say('רק 1');
  let r = await c.say('👎');
  assert.match(r.text, /חזרה לבחירה/);
  assertButtons(r.buttons, [PL.BTN.all, PL.BTN.pick, PL.BTN.no]);
  assert.equal(pr.writes.length, 0);
  r = await c.say('רק 2');
  assert.match(r.text, /זווית/);
  await c.say('👎', { reaction: true });
  assert.equal(D.get('SELECT status FROM po_pricelist_offers WHERE ordname = ?', po.ORDNAME).status, 'declined');
  assert.equal(pr.writes.length, 0);
});

test('👎 כהודעה מיד אחרי ההוספה ← "לבטל?" ← 👍 על השאלה ← נמחק', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  await PL.offer('test11', order());
  await c.say('רק 1');
  await c.say(PL.BTN.ok);
  let r = await c.say('👎');
  assert.match(r.text, /לבטל את ההוספה למחירון של ספק הדוגמה/);
  assertButtons(r.buttons, [PL.BTN.undo, PL.BTN.keep]);
  assert.equal(pr.wrote('deletePriceListItem').length, 0, 'לא מבטלים בלי אישור');
  r = await c.say('👍', { reaction: true });
  assert.match(r.text, /בוטל/);
  assert.equal(pr.wrote('deletePriceListItem').length, 1);
});

test('👎 כהודעה — רק כשההוספה היא הפעולה האחרונה; 👎 על שאלת הביטול — נשאר', async (t) => {
  const { buyer, pr } = world(t);
  const c = chat(t, buyer);
  await PL.offer('test11', order());
  await c.say(PL.BTN.all);
  await c.say(PL.BTN.ok);
  let r = await c.say('👎');
  assert.match(r.text, /לבטל את ההוספה/);
  await c.say('👎');
  assert.equal(D.get('SELECT status FROM po_pricelist_offers WHERE handler_id = ?', buyer.id).status, 'done', 'לא בוטל');
  // פעולה אחרת בבוט אחרי ההוספה — 👎 כבר לא שייך למחירון
  D.run("INSERT INTO wa_log (at, channel, user_id, action, result) VALUES (?, 'private', ?, 'tasks', 'משימה')", D.nowIso(), buyer.id);
  r = await c.say('👎');
  assert.doesNotMatch(r.text, /לבטל את ההוספה/);
  assert.equal(pr.wrote('deletePriceListItem').length, 0);
});
