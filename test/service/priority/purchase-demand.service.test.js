'use strict';
/**
 * דרישת רכש מקצה לקצה: העובד מדבר עם הבוט (‎handleDirect‎), ה-AI ופריוריטי מזויפים.
 * בודק את כללי השיחה של CLAUDE.md: כפתורים (עד 3, הכיתוב הוא התשובה), ברירות מחדל של המשתמש שלא עוצרות,
 * 👍 = כן, 👎 כהודעה = שלב אחורה, 👎 כתגובה = לא — ושאין כתיבה לחברה שאינה ב-PRIORITY_COMPANIES.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const Prefs = require('../../../server/priority/priority-prefs');
const { BTN } = require('../../../server/whatsapp/wa-ui');

H.setup();

const PROJECTS = [{ code: 'PR1', des: 'אלעד 49 צפון' }, { code: 'PR2', des: 'נהריה מגרש 12' }];
const WAREHOUSES = [{ code: 'W1', name: 'מחסן אלעד' }, { code: 'W2', name: 'מחסן נהריה' }, { code: 'Main', name: 'ראשי' }];
const CODES = [{ code: '01', des: 'דרישות רכש אתרי' }, { code: '02', des: 'דרישות רכש בדק' }];
const part = (code, des) => ({ PARTNAME: code, PARTDES: des, STATDES: 'פעיל', BUD_SUBCHAPTERNAME: '20', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '20-10', BUD_SUBTOPICDES: 'בטון' });
const CEMENT = part('M-1', 'שק מלט');
const B30 = part('C-30', 'בטון ב-30');
const B40 = part('C-40', 'בטון ב-40');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function priority(t, reads = {}) {
  return H.Fakes.priority(t, {
    projects: async () => PROJECTS,
    recentDemandProjects: async () => [],
    demandCodes: async () => CODES,
    warehouses: async () => WAREHOUSES,
    projectWarehouses: async (c, code) => (code === 'PR1' ? [WAREHOUSES[0]] : [WAREHOUSES[1]]),
    warehouseOf: async () => 'Main',
    findPartExact: async (c, des) => (des === 'שק מלט' ? CEMENT : null),
    searchParts: async (c, des) => (/בטון/.test(des) ? [B30, B40].map((p) => ({ p, score: 1 })) : []),
    budgetPairs: async () => [{ chapter: '20', chapterDes: 'שלד', topic: '20-10', topicDes: 'בטון' }],
    generalCoding: async () => ({ chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי' }),
    partByCode: async () => null,
    priorityUsers: async () => [],
    readDemand: async (c, prdno) => ({ PRDNO: prdno }),
    ...reads
  }, { writes: { createDemand: async () => 'PRD26000007' } });
}

/** ה-AI: "10 שקי מלט, 5 קוב בטון" ← שני פריטים; מלט — זהה בקטלוג, בטון — שני קרובים */
function ai(t) {
  return H.claude(t, {
    edit: () => ({ action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }, { description: 'בטון', qty: 5, unit: 'קוב', note: 'לתקרה' }], updates: [], removes: [], question: '' }),
    match: (input) => ({
      results: input.items.map((it) => (it.description === 'בטון'
        ? { line: it.line, kind: 'close', codes: ['C-30', 'C-40'], chapter: '20', topic: '20-10', why: 'כמה סוגי בטון' }
        : { line: it.line, kind: 'exact', codes: [it.candidates[0]?.code ?? ''], chapter: '20', topic: '20-10', why: '' }))
    })
  });
}

/** מההתחלה (בלי ברירות מחדל) עד רשימת הפריטים — כל כפתור נלחץ בכיתוב שלו */
async function toItems(say) {
  let r = await say('דרישת רכש');
  assert.match(r.text, /לאיזה פרויקט/);
  H.assertButtons(r.buttons, ['אלעד 49 צפון', 'נהריה מגרש 12', BTN.cancel]);

  r = await say('אלעד 49 צפון');
  assert.match(r.text, /איזו דרישה\?/);
  H.assertButtons(r.buttons, ['אתרי', 'בדק']);

  r = await say('אתרי');
  assert.match(r.text, /מה צריך\?/);
  assert.match(r.text, /פרויקט: \*אלעד 49 צפון\* \(PR1\)/);
  assert.match(r.text, /מחסן: \*מחסן אלעד\* \(W1\)/);
  H.assertButtons(r.buttons, [BTN.cancel]);
  return r;
}

/** הפריטים, והבחירה ב"התכוונת ל…" — עד הסיכום */
async function toReview(say) {
  let r = await say('10 שקי מלט, 5 קוב בטון לתקרה');
  assert.match(r.text, /בטון\* — 5 קוב/);
  assert.match(r.text, /התכוונת ל/);
  H.assertButtons(r.buttons, ['בטון ב-30', 'בטון ב-40', 'אף אחד ❌']);

  r = await say('בטון ב-30');
  assert.match(r.text, /דרישת רכש — 2 פריטים/);
  assert.match(r.text, /שק מלט — 10 שק\n {3}✅ M-1/);
  assert.match(r.text, /בטון — 5 קוב _\(לתקרה\)_\n {3}✅ C-30/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  return r;
}

test('דרישת רכש מלאה בכפתורים: פרויקט, רשימת מאשרים, פריטים, "התכוונת ל…" ← 👍 ← נפתחה ועברה לאישור', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  await toItems(say);
  await toReview(say);
  assert.equal(pr.writes.length, 0, 'עד "סיום" שום דבר לא נכתב בפריוריטי');

  const r = await say('👍');                    // 👍 = סיום / כן
  assert.match(r.text, /דרישת רכש PRD26000007\* נפתחה ועברה \*לאישור\*/);
  assert.deepEqual(r.buttons, []);

  assert.ok(pr.writes.every((w) => w.args[0] === 'test11'), 'כל הכתיבות ל-test11');
  const [head] = pr.wrote('createDemand');
  assert.deepEqual(head.args[1], { date: today(), project: 'PR1', warehouse: 'W1', details: `בוט: ${u.full_name}`.slice(0, 24), owner: null, approvalCode: '01' });
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args.slice(1)), [
    ['PRD26000007', { part: 'M-1', qty: 10, chapter: '20', topic: '20-10' }],
    ['PRD26000007', { part: 'C-30', qty: 5, chapter: '20', topic: '20-10' }]
  ]);
  assert.equal(pr.wrote('setDemandDialog').length, 1);
  assert.deepEqual(pr.wrote('submitDemand').map((w) => w.args), [['test11', 'PRD26000007']]);
  assert.equal(pr.wrote('cancelDemand').length, 0);

  // הבחירה נשמרה — ברירת המחדל לפעם הבאה
  assert.equal(Prefs.lastCompany(u.id), 'test11');
  assert.equal(Prefs.of(u.id, 'test11').project.code, 'PR1');
  assert.equal(Prefs.of(u.id, 'test11').demandCode, '01');
});

test('ברירות מחדל: דרישה שנייה — פרויקט, מחסן ורשימת מאשרים מהפעם הקודמת, בלי לעצור', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  await say(BTN.done);
  assert.equal(pr.wrote('createDemand').length, 1);

  const r = await say('דרישת רכש');
  assert.match(r.text, /פרויקט: \*אלעד 49 צפון\* \(PR1\) — הבחירה האחרונה שלך/);
  assert.match(r.text, /מחסן: \*מחסן אלעד\* \(W1\) — הבחירה האחרונה שלך/);
  assert.match(r.text, /דרישות רכש אתרי — הבחירה האחרונה שלך/);
  assert.match(r.text, /מה צריך\?/, 'ישר לפריטים');
  assert.match(r.text, /לשנות — כתבו/);
  H.assertButtons(r.buttons, [BTN.cancel]);
  assert.equal(pr.wrote('createDemand').length, 1, 'הדרישה השנייה עוד לא נכתבה');
});

test('ברירת המחדל ניתנת לשינוי בשפה חופשית: "פרויקט נהריה" ← הפרויקט והמחסן שלו, בלי שאלה נוספת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  Prefs.set(u.id, 'test11', 'demandCode', '01');
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  let r = await say('דרישת רכש');
  assert.match(r.text, /הבחירה האחרונה שלך/);
  r = await say('פרויקט נהריה');               // שם הפרויקט מלא במילים — בלי שאלה נוספת
  assert.match(r.text, /פרויקט: \*נהריה מגרש 12\* \(PR2\) · 🏬 מחסן: \*מחסן נהריה\* \(W2\)/);
  assert.match(r.text, /מה צריך\?/);
  H.assertButtons(r.buttons, [BTN.cancel]);
  await toReview(say);
  await say(BTN.done);
  assert.equal(pr.wrote('createDemand')[0].args[1].project, 'PR2');
  assert.equal(pr.wrote('createDemand')[0].args[1].warehouse, 'W2');
});

test('ברירת המחדל של הסביבה — רק אם היא עדיין פתוחה: חברה שנסגרה אינה נבחרת לבד', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'a160226', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  await toItems(say);                            // test11, ושואלים פרויקט — לא הבחירה מ-a160226
  await toReview(say);
  await say(BTN.done);
  assert.ok(pr.writes.length > 0);
  assert.ok(pr.writes.every((w) => w.args[0] === 'test11'), 'אין כתיבה ל-a160226');
});

test('כמה סביבות פתוחות: שאלת החברה בכפתורים — עד 3, והכיתוב נבחר', async (t) => {
  H.companies(t, 'test11,elad1,denia1,mordot');
  const u = H.worker();
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  let r = await say('דרישת רכש');
  assert.match(r.text, /באיזו חברה לפתוח את הדרישה/);
  assert.match(r.text, /או כתבו את שם החברה/);
  H.assertButtons(r.buttons);
  assert.match(r.text, /• אלעד סנטר \(elad1\)/);
  r = await say(r.buttons[1]);
  assert.match(r.text, /לאיזה פרויקט/);
  await say('אלעד 49 צפון');
  r = await say('אתרי');
  assert.match(r.text, /סביבה: \*אלעד סנטר\* \(elad1\) — \*סביבת אמת\*/);
  assert.equal(Prefs.lastCompany(u.id), null, 'הסביבה נשמרת רק כשהדרישה נשלחת');
});

test('👎 כהודעה נפרדת — שלב אחד אחורה, לשאלה הקודמת עם הכפתורים שלה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  await say('דרישת רכש');
  await say('אלעד 49 צפון');                      // ← "איזו דרישה?"
  const r = await say('👎');
  assert.match(r.text, /חזרתי שלב אחד אחורה/);
  assert.match(r.text, /לאיזה פרויקט/);
  H.assertButtons(r.buttons, ['אלעד 49 צפון', 'נהריה מגרש 12', BTN.cancel]);
});

test('👎 כתגובה (Reaction) על "התכוונת ל…" = לא: הפריט נקלט כמק"ט כללי', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await say('10 שקי מלט, 5 קוב בטון לתקרה');

  let r = await say('👎', { reaction: true });
  assert.match(r.text, /בטון ← מק"ט כללי 000/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  r = await say(BTN.done);
  assert.match(r.text, /נפתחה ועברה/);
  const lines = pr.wrote('addDemandLine').map((w) => w.args[2]);
  assert.deepEqual(lines[1], { part: '000', description: 'בטון · קוב (לתקרה)', qty: 5, chapter: '20', topic: '20-10' });
});

test('ביטול — לפני "סיום" אין מה לבטל בפריוריטי: נסגר בלי שום כתיבה (וגם בלי cancelDemand)', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);

  const r = await say(BTN.cancel);
  assert.match(r.text, /דרישת הרכש בוטלה\. לא נכתב דבר בפריוריטי/);
  assert.deepEqual(r.buttons, []);
  assert.deepEqual(pr.writes, []);
});

// ---------------------------------------------------------------------------
// בטיחות: אין כתיבה לחברה שאינה ב-PRIORITY_COMPANIES
// ---------------------------------------------------------------------------

test('בטיחות: הסביבה נסגרה באמצע הדרישה — "סיום" לא כותב כלום, והעובד מקבל הסבר', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);

  process.env.PRIORITY_COMPANIES = 'elad1';      // (מוחזר בסוף הבדיקה)
  const r = await say(BTN.done);
  assert.match(r.text, /הסביבה הזו אינה פתוחה לכתיבה מהבוט/);
  assert.doesNotMatch(r.text, /PRIORITY_COMPANIES/, 'בלי פרטים טכניים לעובד');
  H.assertButtons(r.buttons, [BTN.cancel]);
  assert.deepEqual(pr.writes, []);

  // 👍 שוב — עדיין לא נכתב
  await say('👍');
  assert.deepEqual(pr.writes, []);
});

test('בטיחות: בלי חיבור לפריוריטי — הודעה לעובד, בלי כתיבה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = H.Fakes.priority(t, {}, { enabled: false });
  ai(t);
  const { say } = H.chat(t, u);
  const r = await say('דרישת רכש');
  assert.match(r.text, /החיבור לפריוריטי עוד לא הוגדר בשרת/);
  assert.deepEqual(pr.writes, []);
});

test('בטיחות: PRIORITY_COMPANIES בלי אף חברה מוכרת (ברירת המחדל של הבדיקות, ‎__none__‎) — אין סביבה לדרישה, ואין כתיבה', async (t) => {
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  const r = await say('דרישת רכש');
  assert.match(r.text, /אין סביבה שפתוחה לכתיבה/);
  await say('10 שקי מלט, 5 קוב בטון לתקרה');
  await say('אף אחד ❌');
  await say(BTN.done);
  assert.deepEqual(pr.writes, []);
});
