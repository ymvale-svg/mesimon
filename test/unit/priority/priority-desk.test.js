'use strict';
/**
 * 🖥️ עבודה מתוך המסך (‎server/priority/priority-desk.js‎) — ערוץ שני לאותו מנוע: ההודעות עוברות למנוע כמו מהבוט,
 * התשובות חוזרות למסך, התמליל נשמר, קליטה פתוחה אחרת לא נדרסת בלי אישור, וה-PDF לבדיקה מוגש רק לבעליו.
 * והתצוגה של המנוע (‎view‎) — מהמצב השמור של קבלת הסחורה ודרישת הרכש.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Desk = require('../../../server/priority/priority-desk');
const Docs = require('../../../server/priority/priority-docs');
const Access = require('../../../server/priority/priority-access');
const GoodsReceipt = require('../../../server/priority/goods-receipt');
const PurchaseDemand = require('../../../server/priority/purchase-demand');

boot();
const PDF = Buffer.from('%PDF-1.4\n%desk\n');
const actorOf = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
function worker(docs = ['receipt', 'demand']) { const u = user({ role: 'employee' }); Access.save([{ id: u.id, docs, companies: null }]); return actorOf(u); }
const upload = (a, doc = 'receipt') => Docs.upload(a, { doc, filename: 'תעודה.pdf', mime: 'application/pdf', data: PDF.toString('base64') });

/** מנוע מזויף: זוכר מה קיבל, ומחזיר תשובה + תצוגה */
function fakeEngine(t, engine, { open = () => null } = {}) {
  const calls = [];
  let active = false;
  t.mock.method(engine, 'handle', async (input) => {
    calls.push(input);
    if (/^ביטול/.test(input.text)) { active = false; return { replies: ['בוטל.'], status: 'ok' }; }
    active = true;
    if (input.text === 'משהו אחר') return { pass: true };
    if (input.text === 'מאשר ✅') return { replies: ['✅ *GR26000200* נקלט כסופי.'], status: 'ok', files: [{ buf: PDF, fileName: 'GR26000200-טיוטא.pdf', caption: 'טיוטא' }] };
    return { replies: ['*טמבור* · הזמנה PO26000412', 'זה מה שהתקבל בפועל?'], buttons: ['כן ✅', 'לא ❌', 'ביטול 🗑️', 'עוד'], status: 'ok' };
  });
  t.mock.method(engine, 'view', (uid) => open(uid) ?? (active ? { step: 'lines', stepLabel: 'השוואת שורות', lines: [] } : null));
  return calls;
}

test('התחלה ממסמך: המנוע מקבל "קבלת סחורה" + הקובץ, כמו מהבוט; עד 3 כפתורים; המסמך "בעבודה"', async (t) => {
  const a = worker();
  const calls = fakeEngine(t, GoodsReceipt);
  const d = upload(a);
  const s = await Desk.start(a, d.id);
  assert.equal(calls[0].text, 'קבלת סחורה');
  assert.deepEqual(calls[0].file.buf, PDF);
  assert.deepEqual(calls[0].allow, { gr: true, pd: false });
  assert.equal(calls[0].user.id, a.id);
  assert.equal(s.active, true);
  assert.equal(s.docId, d.id);
  const bot = s.messages.at(-1);
  assert.equal(bot.from, 'bot');
  assert.equal(bot.texts.length, 2);
  assert.equal(bot.buttons.length, 3);
  assert.equal(Docs.get(a, d.id).stage, 'bot');
});

test('תשובה מהמסך — עוברת למנוע ונשמרת בתמליל; "לא קשור" — הסבר במקום שקט', async (t) => {
  const a = worker();
  const calls = fakeEngine(t, GoodsReceipt);
  const d = upload(a);
  await Desk.start(a, d.id);
  const s = await Desk.say(a, 'receipt', 'כן ✅');
  assert.equal(calls.at(-1).text, 'כן ✅');
  assert.equal(calls.at(-1).file, undefined);
  assert.equal(s.messages.at(-2).texts[0], 'כן ✅');
  const p = await Desk.say(a, 'receipt', 'משהו אחר');
  assert.match(p.messages.at(-1).texts[0], /לא הבנתי/);
  assert.equal(Desk.state(a, 'receipt').messages.length, p.messages.length, 'נשמר — רענון לא מאבד');
  await assert.rejects(Desk.say(a, 'receipt', '   '), /ריק/);
});

test('קליטה אחרת פתוחה — 409 עם מה שפתוח; force — מבטל ומתחיל את זו', async (t) => {
  const a = worker();
  const calls = fakeEngine(t, GoodsReceipt, { open: () => (calls.length ? null : { step: 'supplier', stepLabel: 'ספק', supplier: { name: 'פז' } }) });
  const d = upload(a);
  await assert.rejects(Desk.start(a, d.id), (e) => e.status === 409 && e.open.stepLabel === 'ספק');
  assert.equal(calls.length, 0, 'לא נגע בקליטה הפתוחה');
  await Desk.start(a, d.id, { force: true });
  assert.deepEqual(calls.map((c) => c.text), ['ביטול', 'קבלת סחורה']);
});

test('ה-PDF לבדיקה — נשמר ומוגש רק לבעליו', async (t) => {
  const a = worker();
  const b = worker();
  fakeEngine(t, GoodsReceipt);
  await Desk.start(a, upload(a).id);
  const s = await Desk.say(a, 'receipt', 'מאשר ✅');
  const f = s.messages.at(-1).files[0];
  assert.match(f.name, /GR26000200/);
  assert.deepEqual(Desk.fileOf(a, f.id).buf, PDF);
  assert.throws(() => Desk.fileOf(b, f.id), (e) => e.status === 404);
  assert.throws(() => Desk.fileOf(a, '../../etc/passwd'), (e) => e.status === 404);
});

test('דרישת רכש — אותו ערוץ, המנוע של דרישת הרכש', async (t) => {
  const a = worker();
  const calls = fakeEngine(t, PurchaseDemand);
  await Desk.start(a, upload(a, 'demand').id);
  assert.equal(calls[0].text, 'דרישת רכש');
  assert.equal(calls[0].allow, undefined);
});

test('בלי הרשאה, או פעולה שעוד לא עובדת מהמסך — נדחה', async () => {
  const a = worker(['demand']);
  assert.throws(() => Desk.state(a, 'receipt'), (e) => e.status === 403);
  assert.throws(() => Desk.state(a, 'invoice'), (e) => e.status === 400);
});

test('התצוגה של קבלת הסחורה — מהמצב השמור, בלי לשנות אותו', () => {
  const u = user({ role: 'employee' });
  assert.equal(GoodsReceipt.view(u.id), null);
  const st = {
    step: 'review', at: Date.now(), company: 'test11', supplier: { code: '30412', name: 'דאר אלביאן' }, order: { ordname: 'PO26000412', projectDes: 'אלעד סנטר' },
    doc: { doc_type: 'invoice', doc_number: '40217', date: '2026-11-09', totals: { before_vat: 6400, vat: 1152, total: 7552 } },
    lines: [{ n: 1, description: 'מלט', qty: 200, unit: 'שק', price: 28 }], reviewLines: [{ n: 1, kline: 1, description: 'מלט', qty: 100 }], docno: 'GR26000187', payCode: '04'
  };
  D.setSetting(`goods_receipt:${u.id}`, st);
  const v = GoodsReceipt.view(u.id);
  assert.equal(v.stepLabel, 'טיוטא בפריוריטי — מחכה ל"מאשר"');
  assert.equal(v.docType, 'חשבונית');
  assert.equal(v.company.test, true);
  assert.equal(v.supplier.name, 'דאר אלביאן');
  assert.equal(v.order, 'PO26000412');
  assert.equal(v.project, 'אלעד סנטר');
  assert.equal(v.docno, 'GR26000187');
  assert.equal(v.pay, 'שוטף + 45');
  assert.deepEqual(v.lines, [{ n: 1, description: 'מלט', qty: 100 }], 'בטיוטא — השורות כפי שנשמרו בפריוריטי');
  assert.equal(v.totals.total, 7552);
  assert.deepEqual(D.getSetting(`goods_receipt:${u.id}`), st, 'לא שינה את המצב');
  D.setSetting(`goods_receipt:${u.id}`, { ...st, at: Date.now() - 2 * 86400000 });
  assert.equal(GoodsReceipt.view(u.id), null, 'קליטה שנשכחה');
});

test('התצוגה של דרישת הרכש', () => {
  const u = user({ role: 'employee' });
  D.setSetting(`purchase_demand:${u.id}`, { step: 'items', at: Date.now(), company: 'a160226', project: { code: 'P1', des: 'אלעד סנטר' }, date: '2026-11-11',
    items: [{ n: 1, description: 'מלט', qty: 10, unit: 'שק', part: { code: '000' }, status: 'general' }, { n: 2, description: 'בטון', qty: 5, unit: 'קוב', status: 'ask' }] });
  const v = PurchaseDemand.view(u.id);
  assert.equal(v.project, 'אלעד סנטר');
  assert.deepEqual(v.lines.map((l) => [l.part, l.open]), [['000', false], ['', true]]);
});
