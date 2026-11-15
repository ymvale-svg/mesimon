'use strict';
/**
 * 🔁 החזרת דרישת רכש לבדיקה חוזרת (15.11.26) — מקצה לקצה דרך הבוט (‎handleDirect‎), מול פריוריטי ו-AI מזויפים.
 * מי שמוציא הזמנות רכש בפריוריטי מחזיר ← "פתיחה חוזרת" ← פותח הדרישה מתקן (או מסביר) ← חוזרת לאישור.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Prefs = require('../../../server/priority/priority-prefs');
const PurchaseDemand = require('../../../server/priority/purchase-demand');
const Return = require('../../../server/priority/pd-return');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

const PD = 'PD26000053';
const demand = (over = {}) => ({
  PRDNO: PD, STATDES: 'אושרה', CURDATE: '2026-11-11T00:00:00Z', PROJDOCNO: 'PR50', PROJDES: 'אלעד סנטר מגרש 50', WARHSNAME: '102',
  CODENAME: '13', CODEDES: 'דרישות רכש אתרי', OWNERLOGIN: 'Opener', INITUSERLOGIN: 'API VPLANS', USERLOGIN: null, PDUSER_SUBFORM: [],
  PRDITEMS_SUBFORM: [
    { KLINE: 1, PARTNAME: '000', PDES: 'יריעות איטום PRE-B · משטח', TQUANT: 4, TUNITNAME: "יח'", BUD_SUBCHAPTERNAME: '05', BUD_SUBCHAPTERDES: 'איטום', BUD_SUBTOPICNAME: '05-12', BUD_SUBTOPICDES: 'חומרי איטום' },
    { KLINE: 2, PARTNAME: 'M-1', PDES: 'שק מלט', TQUANT: 10, TUNITNAME: 'שק', BUD_SUBCHAPTERNAME: '20', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '20-10', BUD_SUBTOPICDES: 'בטון' }
  ],
  ...over
});
const BITUMEN = { PARTNAME: '10-61-0069', PARTDES: 'יריעה ביטומנית 3 מ"מ', STATDES: 'פעיל', BUD_SUBCHAPTERNAME: '05', BUD_SUBCHAPTERDES: 'איטום', BUD_SUBTOPICNAME: '05-12', BUD_SUBTOPICDES: 'חומרי איטום' };

function world(t, { buyer, opener, status = 'אושרה' } = {}) {
  H.companies(t, 'test11');
  const pr = H.Fakes.priority(t, {
    priorityUsers: async () => [
      { USERLOGIN: 'Buyer', SNAME: buyer.full_name, EMAIL: buyer.email, STATDES: 'עובד פעיל' },
      { USERLOGIN: 'Opener', SNAME: opener.full_name, EMAIL: opener.email, STATDES: 'עובד פעיל' }
    ],
    purchaseOrderOwners: async () => new Set(['Buyer']),
    readDemand: async (c, prdno) => (prdno === PD ? demand({ STATDES: status }) : (() => { throw new Error('404'); })()),
    demandForNotice: async () => ({ PRDNO: PD, INITUSERLOGIN: 'API VPLANS', OWNERLOGIN: 'Opener', approvers: [], dialogLogin: '', lines: [] }),
    findPartExact: async (c, des) => (/ביטומנית/.test(des) ? BITUMEN : null),
    searchParts: async () => [],
    budgetPairs: async () => [{ chapter: '05', chapterDes: 'איטום', topic: '05-12', topicDes: 'חומרי איטום' }],
    generalCoding: async () => ({ chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי' })
  });
  // ההודעות היזומות (לפותח הדרישה ולמחזיר) — נאספות כאן במקום וואטסאפ
  const pushed = [];
  PurchaseDemand.setHooks({
    send: async (userId, text) => { pushed.push({ userId, text, buttons: [] }); return true; },
    ask: async (userId, text, buttons) => { pushed.push({ userId, text, buttons }); return true; }
  });
  return { pr, pushed };
}

let n = 0;
const people = () => { n += 1; return { buyer: H.worker({ full_name: 'שקמה רכש', email: `buyer${n}@corp.test` }), opener: H.worker({ full_name: 'שזר פותח', email: `opener${n}@corp.test` }) }; };

test('מי שאינו מוציא הזמנות רכש בפריוריטי — לא יכול להחזיר דרישה', async (t) => {
  const { buyer, opener } = people();
  const { pr } = world(t, { buyer, opener });
  const { say } = H.chat(t, opener);
  const r = await say(`החזר לבדיקה ${PD} — שורה 1 לא ברורה`);
  assert.match(r.text, /רק מי שמוציא\/ה הזמנות רכש בפריוריטי/);
  assert.equal(pr.writes.length, 0);
});

test('רכש מחזיר לבדיקה ← "פתיחה חוזרת" ← פותח הדרישה מתקן ← חוזרת לאישור, והמחזיר מקבל מה השתנה', async (t) => {
  const { buyer, opener } = people();
  const { pr, pushed } = world(t, { buyer, opener });
  Prefs.rememberOpener('test11', PD, opener.id);
  H.claude(t, {
    edit: () => ({ action: 'update', adds: [], updates: [{ line: 1, qty: -1, description: 'יריעה ביטומנית 3 מ"מ' }], removes: [], question: '' }),
    match: (input) => ({ results: input.items.map((it) => ({ line: it.line, kind: 'exact', codes: [it.candidates[0]?.code ?? ''], chapter: '05', topic: '05-12', why: '' })) })
  });

  // המחזיר
  const b = H.chat(t, buyer);
  let r = await b.say(`החזר לבדיקה ${PD} — שורה 1: PRE-B או יריעה ביטומנית 3 מ"מ?`);
  assert.match(r.text, /להחזיר לבדיקה את דרישת הרכש PD26000053\?/);
  assert.match(r.text, /מה לא ברור:\* שורה 1: PRE-B או יריעה ביטומנית 3 מ"מ\?/);
  assert.match(r.text, /נפתחה ע"י שזר פותח/);
  H.assertButtons(r.buttons, [Return.BTN_RETURN, BTN.cancel]);
  assert.equal(pr.writes.length, 0, 'עד האישור — שום כתיבה');

  r = await b.say(Return.BTN_RETURN);
  assert.deepEqual(pr.wrote('reopenDemand').map((w) => w.args), [['test11', PD]]);
  assert.match(pr.wrote('appendDemandDialog')[0].args[2].join('\n'), /הוחזרה לבדיקה חוזרת ע"י שקמה רכש \(Buyer\)[\s\S]*מה לא ברור: שורה 1/);
  assert.match(r.text, /הוחזרה לבדיקה \("פתיחה חוזרת"\)/);
  assert.match(r.text, /שזר פותח קיבל\/ה את השאלה/);
  const ask = pushed.find((p) => p.userId === opener.id);
  assert.match(ask.text, /דרישת הרכש שלך PD26000053 הוחזרה לבדיקה/);
  assert.match(ask.text, /\*1\.\* יריעות איטום PRE-B · משטח — 4/);
  assert.deepEqual(ask.buttons, [Return.BTN_FIX, Return.BTN_OK]);

  // פותח הדרישה — "לתקן": הדרישה נטענת לעריכה
  const o = H.chat(t, opener);
  r = await o.say(Return.BTN_FIX);
  assert.match(r.text, /תיקון דרישת רכש PD26000053 — 2 פריטים/);
  assert.match(r.text, /❓ שורה 1: PRE-B/);
  assert.match(r.text, /התיקון נשמר בפריוריטי, והדרישה חוזרת \*לאישור\*/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);

  r = await o.say('שורה 1 — יריעה ביטומנית 3 מ"מ');
  assert.match(r.text, /יריעה ביטומנית 3 מ"מ — 4/);

  r = await o.say(BTN.done);
  assert.deepEqual(pr.wrote('deleteDemandLine').map((w) => w.args), [['test11', PD, 1]]);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args.slice(1)), [[PD, { part: '10-61-0069', qty: 4, chapter: '05', topic: '05-12' }]]);
  assert.equal(pr.wrote('setDemandLine').length, 0, 'שורת המלט לא השתנתה');
  assert.deepEqual(pr.wrote('submitDemand').map((w) => w.args), [['test11', PD]]);
  assert.match(r.text, /PD26000053\* תוקנה וחזרה \*לאישור\*/);
  assert.match(r.text, /יריעות איטום PRE-B · משטח — 4 יח' ← יריעה ביטומנית 3 מ"מ — 4/);

  const told = pushed.filter((p) => p.userId === buyer.id).at(-1);
  assert.match(told.text, /שזר פותח תיקן\/ה את PD26000053/);
  assert.match(told.text, /הדרישה חזרה לאישור/);
  assert.equal(Return.openFor(opener.id), null, 'ההחזרה נסגרה');
});

test('פותח הדרישה: "הכל נכון" + הסבר ← לרכש, לדו-שיח, והדרישה חוזרת לאישור כמו שהיא', async (t) => {
  const { buyer, opener } = people();
  const { pr, pushed } = world(t, { buyer, opener });
  Prefs.rememberOpener('test11', PD, opener.id);
  const b = H.chat(t, buyer);
  await b.say(`להחזיר לבדיקה את דרישה 53, לא ברור איזה יריעות`);
  await b.say(Return.BTN_RETURN);

  const o = H.chat(t, opener);
  let r = await o.say(Return.BTN_OK);
  assert.match(r.text, /מה להסביר לשקמה רכש/);
  r = await o.say('PRE-B — זה מה שהמתכנן ביקש');
  assert.deepEqual(pr.wrote('submitDemand').map((w) => w.args), [['test11', PD]]);
  assert.match(pr.wrote('appendDemandDialog').at(-1).args[2][0], /הסבר של שזר פותח .*PRE-B — זה מה שהמתכנן ביקש/);
  assert.match(r.text, /ההסבר נשלח לשקמה רכש/);
  assert.match(r.text, /חזרה \*לאישור\*/);
  const told = pushed.filter((p) => p.userId === buyer.id).at(-1);
  assert.match(told.text, /שזר פותח על PD26000053/);
  assert.match(told.text, /PRE-B — זה מה שהמתכנן ביקש/);
  assert.equal(pr.wrote('deleteDemandLine').length + pr.wrote('addDemandLine').length, 0, 'השורות לא נגעו');
});

test('דרישה בטיוטא — אין מה להחזיר', async (t) => {
  const { buyer, opener } = people();
  world(t, { buyer, opener, status: 'טיוטא' });
  const b = H.chat(t, buyer);
  const r = await b.say(`החזר לבדיקה ${PD} שורה 2`);
  assert.match(r.text, /בסטטוס "טיוטא" — אין מה להחזיר/);
});

test('פריוריטי לא מאשר להחזיר — הודעה למחזיר, ופותח הדרישה לא מקבל כלום', async (t) => {
  const { buyer, opener } = people();
  const { pushed } = world(t, { buyer, opener });
  const Priority = require('../../../server/integrations/priority');
  t.mock.method(Priority, 'reopenDemand', async () => { throw new Error('מגבלות שהוגדרו בתהליך העבודה'); });
  Prefs.rememberOpener('test11', PD, opener.id);
  const b = H.chat(t, buyer);
  await b.say(`החזר לבדיקה ${PD} — שורה 1?`);
  const r = await b.say(Return.BTN_RETURN);
  assert.match(r.text, /פריוריטי לא אישר להחזיר/);
  assert.equal(pushed.filter((p) => p.userId === opener.id).length, 0);
});

test('מספר הדרישה ומה לא ברור — מתוך שפה חופשית', () => {
  assert.equal(Return._prdnoIn('החזר לבדיקה PD26000053').prdno, 'PD26000053');
  assert.equal(Return._prdnoIn('pd 53 לבדיקה').prdno, `PD${new Date().getFullYear() % 100}000053`);
  assert.equal(Return._prdnoIn('להחזיר את דרישה 1234 לבדיקה').prdno, `PD${new Date().getFullYear() % 100}001234`);
  assert.equal(Return._prdnoIn('החזר לבדיקה'), null);
  const t = 'החזר לבדיקה PD26000053 — שורה 1: PRE-B או ביטומנית?';
  assert.equal(Return._reasonIn(t, Return._prdnoIn(t)), 'שורה 1: PRE-B או ביטומנית?');
  const t2 = 'PD26000053 להחזיר לבדיקה כי לא ברור איזה עובי';
  assert.equal(Return._reasonIn(t2, Return._prdnoIn(t2)), 'לא ברור איזה עובי');
  assert.ok(Return.wants('תחזיר לבדיקה את PD26000053'));
  assert.ok(!Return.wants('דרישת רכש: 10 שקי מלט'));
});
