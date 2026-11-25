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
  H.assertButtons(r.buttons, ['בטון ב-30', 'בטון ב-40', 'שלח לבנייה לרכש 🆕']);

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
  // מי פתח — בשביל "הדרישה שלך אושרה והועברה לספק" (בפריוריטי הדרישה רשומה על משתמש ה-API)
  assert.equal(Prefs.openerOf('test11', 'PRD26000007'), u.id);
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

test('"דרישת מלט 10 שקים" / "בוקר טוב, אני רוצה לעשות דרישה" — דרישת רכש (הוחלט 20.11: "דרישה" לפני = רכש)', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  Prefs.set(u.id, 'test11', 'demandCode', '01');
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  let r = await say('דרישת מלט 10 שקים');
  assert.match(r.text, /נוספו 2 פריטים|נוספו/, 'הפריטים מההודעה עצמה');
  await say(BTN.cancel);
  r = await say('בוקר טוב, אני רוצה לעשות דרישה');
  assert.match(r.text, /מה צריך\?/);
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

test('👎 כתגובה (Reaction) על "התכוונת ל…" = לא: הפריט לא בקטלוג — ולא נשלח על מק"ט כללי', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await say('10 שקי מלט, 5 קוב בטון לתקרה');

  let r = await say('👎', { reaction: true });
  assert.match(r.text, /בטון ← לא בקטלוג, יישלח לרכש לבניית מק"ט/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  // בלי מנהלת רכש מוגדרת — רק המזוהים (החסרים למנהל המערכת), לעולם לא 000
  r = await say(BTN.done);
  assert.match(r.text, /דרישה לא יוצאת עם מק"ט כללי, ועוד לא הוגדרה מנהלת רכש/);
  H.assertButtons(r.buttons, ['רק המזוהים ✅', BTN.cancel]);
  assert.deepEqual(pr.writes, []);
  r = await say('רק המזוהים ✅');
  assert.match(r.text, /נפתחה ועברה/);
  assert.match(r.text, /פריט אחד לא נשלח.*מנהל המערכת קיבל את הרשימה/);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args[2].part), ['M-1']);
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

test('בטיחות: ערך ב-PRIORITY_COMPANIES שאינו קוד חברה מוכר (שגיאת הקלדה) אינו מוצע כסביבה — רק החברה המוכרת', async (t) => {
  H.companies(t, 'test11,tset11');
  const u = H.worker();
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  const r = await say('דרישת רכש');
  assert.match(r.text, /לאיזה פרויקט/, 'סביבה אחת מוכרת — נבחרת לבד, בלי לשאול על סביבה');
  assert.doesNotMatch(r.text, /tset11/);
});

test('"לא" בשאלת סוג הדרישה — הפרויקט שהוצג לא נכון: חוזרים לבחירת פרויקט, ואחריו שוב שאלת הדרישה', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);

  let r = await say('דרישת רכש');
  r = await say('אלעד 49 צפון');
  assert.match(r.text, /איזו דרישה\?/);

  r = await say('לא');
  assert.match(r.text, /לאיזה פרויקט, אם כך\?/);
  assert.doesNotMatch(r.text, /איזו דרישה\?/);

  r = await say('נהריה מגרש 12');
  assert.match(r.text, /איזו דרישה\?/, 'הפרויקט החדש — ואחריו שוב סוג הדרישה');
  r = await say('אתרי');
  assert.match(r.text, /פרויקט: \*נהריה מגרש 12\* \(PR2\)/);
  assert.deepEqual(pr.writes, []);
});

test('יומן הבוט: מה שהזרימה ענתה נשמר (הטקסט והכפתורים) — לסקירה הלילית', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await say('דרישת רכש');
  const Bot = require('../../../server/whatsapp/wa-bot');
  const row = Bot.readLog({}).find((x) => x.userId === u.id && x.action === 'purchase_demand');
  assert.ok(row, 'נרשם ביומן');
  assert.match(row.reply, /לאיזה פרויקט/);
  assert.match(row.reply, /\[אלעד 49 צפון · נהריה מגרש 12 · /);
});

test('עריכה ישירה בטבלה: "שורה 1 כמות 4" ו"שורה 2 הסרה" — הרשימה מתעדכנת בלי AI', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  let edits = 0;
  H.claude(t, {
    edit: () => { edits += 1; return { action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }, { description: 'בטון', qty: 5, unit: 'קוב', note: 'לתקרה' }], updates: [], removes: [], question: '' }; },
    match: (input) => ({ results: input.items.map((it) => (it.description === 'בטון'
      ? { line: it.line, kind: 'close', codes: ['C-30', 'C-40'], chapter: '20', topic: '20-10', why: '' }
      : { line: it.line, kind: 'exact', codes: [it.candidates[0]?.code ?? ''], chapter: '20', topic: '20-10', why: '' })) })
  });
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  const before = edits;

  let r = await say('שורה 1 כמות 4');
  assert.match(r.text, /שק מלט — 4 שק/);
  r = await say('שורה 2 הסרה');
  assert.match(r.text, /הוסרו: שורה 2/);
  assert.doesNotMatch(r.text, /בטון — 5 קוב/);
  assert.equal(edits, before, 'לא נקרא AI לעריכה');
});

// ---------------------------------------------------------------------------
// 🔒 תשובה מאוחרת או על הודעה אחרת לא שולחת דרישת רכש (#171)
// ---------------------------------------------------------------------------

const Q = require('../../../server/whatsapp/wa-questions');

/** הדרישה "התיישנה": ‎min‎ דקות בלי תנועה */
function age(u, min) {
  const k = `purchase_demand:${u.id}`;
  H.D.setSetting(k, { ...H.D.getSetting(k), at: Date.now() - min * 60 * 1000 });
}

test('⏳ דרישה שנשארה 20 דקות בסיכום — 👍 לא שולח: הסיכום מוצג שוב, ו"סיום" אחריו שולח', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  age(u, 20);

  let r = await say('👍', { reaction: true });
  assert.match(r.text, /עבר זמן/);
  assert.match(r.text, /דרישת רכש — 2 פריטים/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  assert.equal(pr.writes.length, 0, 'תשובה מאוחרת לא שולחת');

  r = await say(BTN.done);
  assert.match(r.text, /נפתחה ועברה \*לאישור\*/);
});

test('⏳ כפתור "סיום 🏁" שנלחץ אחרי 20 דקות — לא שולח, הסיכום מוצג שוב', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  const shown = await toReview(say);
  age(u, 20);

  const r = await say(BTN.done, { press: shown.questionId });
  assert.match(r.text, /עבר זמן/);
  assert.equal(pr.writes.length, 0);
});

test('🔒 👍 כתגובה על הודעה אחרת בסיכום — לא שולח', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);

  const r = await say('👍', { reaction: true, on: 'some-other-message' });
  assert.match(r.text, /על הודעה אחרת/);
  assert.equal(pr.writes.length, 0);
});

test('🔒 הכפתורים נרשמים עם מזהה הדרישה — "סיום 🏁" של דרישה אחרת: "השאלה כבר לא פתוחה", ולא נשלח', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  const shown = await toReview(say);
  assert.ok(Q.find(u.id, shown.questionId).draft?.doc, 'הכפתור נרשם עם מזהה הדרישה');

  Q.record(u.id, 'OLD-PD-BTN', { owner: 'purchase_demand', draft: { doc: 'PRD25000001' } });
  const r = await say(BTN.done, { press: 'OLD-PD-BTN' });
  assert.deepEqual(r.texts, [Q.CLOSED_TEXT]);
  assert.equal(pr.writes.length, 0);
});

// ---------------------------------------------------------------------------
// 🆕 מק"טים לבנייה (‎pd-parts.js‎): פריט בלי מק"ט ← מייל למנהלת הרכש ← "רק המזוהים" / "לחכות" ← נבנה ← בנייה מחדש
// ---------------------------------------------------------------------------

const Settings = require('../../../server/priority/priority-settings');
const Mailer = require('../../../server/integrations/mailer');
const Parts = require('../../../server/priority/pd-parts');
const Priority = require('../../../server/integrations/priority');
const { D } = require('../../helpers/db');

/** עובד עם טלפון משלו — שלא יתנגש בעובדים של בדיקות אחרות (הבוט מזהה לפי הטלפון) */
let phoneSeq = 0;
const buyerWorker = () => { phoneSeq += 1; return H.worker({ phone: `97258${String(3000000 + phoneSeq)}` }); };

/** מנהלת הרכש מוגדרת, והמייל "יוצא" (נרשם) */
function buyer(t) {
  t.mock.method(Settings, 'defaults', () => ({ ...Settings.DEFAULTS, buyerName: 'רותי רכש', buyerEmail: 'ruti@example.com' }));
  t.mock.method(Mailer, 'isEnabled', () => true);
  const sent = [];
  t.mock.method(Mailer, 'send', async (m) => { sent.push(m); return {}; });
  return sent;
}

/** עד הסיכום, כשה"בטון" לא בקטלוג ("אף אחד") */
async function toMissing(say) {
  await toItems(say);
  await say('10 שקי מלט, 5 קוב בטון לתקרה');
  return say('שלח לבנייה לרכש 🆕');
}

test('מק"טים לבנייה: "אף אחד" — בלי שאלה בטיוטא; ב"סיום" — רק המזוהים / לחכות (בלי מק"ט כללי)', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  ai(t);
  const sent = buyer(t);
  const { say } = H.chat(t, u);

  let r = await toMissing(say);
  assert.match(r.text, /בטון — 5 קוב _\(לתקרה\)_\n {3}🆕 לא בקטלוג — יישלח לרכש לבניית מק"ט/);
  assert.match(r.text, /דרישה לא יוצאת עם מק"ט כללי/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);

  r = await say('👍');
  assert.match(r.text, /\*פריט אחד לא נמצא בקטלוג:\*\n• בטון — 5 קוב/);
  assert.match(r.text, /הרשימה תישלח לרותי רכש \(רכש\) לבניית מק"טים בהקדם/);
  H.assertButtons(r.buttons, ['רק המזוהים ✅', 'לחכות לרכש ⏳', BTN.cancel]);
  assert.equal(sent.length, 0, 'המייל — רק אחרי הבחירה');

  r = await say('עם מק"ט כללי');
  assert.match(r.text, /דרישת רכש לא יוצאת עם מק"ט כללי/);
  H.assertButtons(r.buttons, ['רק המזוהים ✅', 'לחכות לרכש ⏳', BTN.cancel]);
  assert.deepEqual(pr.writes, []);
});

test('מק"טים לבנייה: "רק המזוהים" — מייל לרכש (בלי שאלה), והדרישה יוצאת בלי החסרים', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  ai(t);
  const sent = buyer(t);
  const { say } = H.chat(t, u);

  await toMissing(say);
  await say(BTN.done);
  const r = await say('רק המזוהים ✅');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ruti@example.com');
  assert.equal(sent[0].subject, `❗ מק"טים נדרשים לבנייה בהקדם — לבקשת ${u.full_name}`);
  assert.equal(sent[0].urgent, true, 'סימן קריאה אדום: חשיבות גבוהה');
  assert.match(sent[0].html, /color:#dc2626[^>]*>❗ דחוף/);
  assert.match(sent[0].text, /להלן מק"טים נדרשים לבנייה בהקדם/);
  assert.match(sent[0].text, /1\. בטון — 5 קוב \(לתקרה\)/);
  assert.doesNotMatch(sent[0].text, /שק מלט/, 'רק מה שלא זוהה');
  assert.match(sent[0].text, /הדרישה יוצאת בינתיים עם הפריטים שזוהו/);

  assert.match(r.text, /PRD26000007\* נפתחה ועברה \*לאישור\*/);
  assert.match(r.text, /פריט אחד נשלח ל\*רותי רכש\* לבניית מק"ט/);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args[2].part), ['M-1'], 'אין שורת 000');
  const rec = D.get('SELECT * FROM pd_part_requests WHERE user_id = ?', u.id);
  assert.equal(rec.mode, 'partial');
  assert.equal(rec.prdno, 'PRD26000007');
  assert.equal(rec.status, 'open');
});

test('מק"טים לבנייה: "לחכות לרכש" ← נבנה ← בבוט ובמייל "המק"טים החסרים נבנו… להמשיך?" ← כן ← כל הדרישה עם הכמויות והמק"ט ← "סיום"', async (t) => {
  H.at(t);                                      // שעות העבודה — ההודעות לעובד יוצאות מיד
  H.companies(t, 'test11');
  const u = buyerWorker();
  const B77 = part('C-77', 'בטון מובא ב-30 לתקרות');
  let built = false;
  const pr = priority(t, {
    searchParts: async (c, des) => (/בטון/.test(des) ? [B30, B40, ...(built ? [B77] : [])].map((p) => ({ p, score: 1 })) : []),
    partByCode: async (c, code) => (code === 'C-77' ? B77 : null)
  });
  ai(t);
  const sent = buyer(t);
  const { say, wa } = H.chat(t, u);

  await toMissing(say);
  await say(BTN.done);
  let r = await say('לחכות לרכש ⏳');
  assert.match(r.text, /נשלח ל\*רותי רכש\* במייל: מק"ט אחד לבנייה בהקדם/);
  assert.match(r.text, /הדרישה נשמרה ומחכה לרכש/);
  assert.match(r.text, /עוד לא נכתב דבר בפריוריטי/);
  assert.deepEqual(r.buttons, []);
  assert.deepEqual(pr.writes, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /הדרישה ממתינה לבניית המק"טים/);

  // סבב — עוד לא נבנה: שקט (רק הבקשה של הבדיקה הזו פתוחה)
  D.run("UPDATE pd_part_requests SET status = 'expired' WHERE user_id != ?", u.id);
  wa.clear();
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 0 });
  assert.equal(wa.texts().length, 0);

  // הרכש בנה כרטיס פריט בשם דומה — הודעה בבוט ובמייל
  built = true;
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 1 });
  const note = wa.texts().join('\n');
  assert.match(note, /המק"טים החסרים נבנו בפריוריטי — להלן הרשימה/);
  assert.match(note, /בטון — 5 קוב ← \*בטון מובא ב-30 לתקרות\* \(C-77\)/);
  assert.match(note, /להמשיך בדרישת הרכש\? \(כל הדרישה, עם הכמויות שביקשת והמק"טים שנבנו\)/);
  const mail = sent.at(-1);
  assert.equal(mail.to, u.email);
  assert.match(mail.subject, /המק"טים החסרים נבנו/);
  assert.match(mail.text, /בטון — 5 קוב ← בטון מובא ב-30 לתקרות \(C-77\)/);
  assert.deepEqual(await Parts.tick(), { checked: 0, told: 0 }, 'שואלים פעם אחת');

  r = await say('כן, להמשיך ✅');
  assert.match(r.text, /ממשיכים בדרישת הרכש/);
  assert.match(r.text, /שק מלט — 10 שק\n {3}✅ M-1/);
  assert.match(r.text, /בטון — 5 קוב _\(לתקרה\)_\n {3}✅ C-77/);
  assert.match(r.text, /פרויקט: \*אלעד 49 צפון\* \(PR1\)/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);

  r = await say(BTN.done);
  assert.match(r.text, /נפתחה ועברה \*לאישור\*/);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => [w.args[2].part, w.args[2].qty]), [['M-1', 10], ['C-77', 5]]);
  assert.equal(pr.wrote('createDemand')[0].args[1].approvalCode, '01');
});

test('מק"טים לבנייה: "לא, תודה" על "להמשיך?" — שום דבר לא נפתח, והשאלה נסגרת', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  ai(t);
  buyer(t);
  const { say } = H.chat(t, u);
  const id = Number(D.run("INSERT INTO pd_part_requests (user_id, company, header, items, missing, mode, status, asked_at, created_at) VALUES (?, 'test11', '{}', '[]', ?, 'wait', 'asked', ?, ?)",
    u.id, JSON.stringify([{ n: 1, description: 'בטון', qty: 5, unit: 'קוב', known: [], built: { code: 'C-88', des: 'בטון חדש' } }]), D.nowIso(), D.nowIso()).lastInsertRowid);

  const r = await say('לא, תודה ❌');
  assert.match(r.text, /לא נפתחה דרישה/);
  assert.equal(D.get('SELECT status FROM pd_part_requests WHERE id = ?', id).status, 'done');
  assert.deepEqual(pr.writes, []);
  assert.equal(Parts.owns(u.id, 'כן'), false);
});

test('מק"טים לבנייה: המייל לרכש לא יצא — העובד יודע, נשארים בשאלה, ושום דבר לא נכתב', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  ai(t);
  t.mock.method(Settings, 'defaults', () => ({ ...Settings.DEFAULTS, buyerName: 'רותי רכש', buyerEmail: 'ruti@example.com' }));
  t.mock.method(Mailer, 'isEnabled', () => false);
  const { say } = H.chat(t, u);

  await toMissing(say);
  await say(BTN.done);
  const r = await say('רק המזוהים ✅');
  assert.match(r.text, /לא הצלחתי לשלוח את הרשימה לרכש — מנהל המערכת קיבל פירוט/);
  assert.doesNotMatch(r.text, /Gmail|SMTP/, 'בלי פרטים טכניים לעובד');
  H.assertButtons(r.buttons, ['רק המזוהים ✅', 'לחכות לרכש ⏳', BTN.cancel]);
  assert.deepEqual(pr.writes, []);
  assert.equal(D.get('SELECT COUNT(*) n FROM pd_part_requests WHERE user_id = ?', u.id).n, 0);
});

test('מק"טים לבנייה: כל הפריטים לא בקטלוג — רק "לחכות לרכש" (אין מה לשלוח עכשיו)', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  priority(t);
  H.claude(t, {
    edit: () => ({ action: 'add', adds: [{ description: 'בטון', qty: 5, unit: 'קוב', note: '' }], updates: [], removes: [], question: '' }),
    match: (input) => ({ results: input.items.map((it) => ({ line: it.line, kind: 'close', codes: ['C-30'], chapter: '20', topic: '20-10', why: '' })) })
  });
  buyer(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await say('5 קוב בטון');
  await say('אף אחד ❌');
  const r = await say(BTN.done);
  H.assertButtons(r.buttons, ['לחכות לרכש ⏳', BTN.cancel]);
});

test('מק"טים לבנייה — זיהוי: רק מק"ט חדש (שלא היה בבקשה), פעיל ובשם דומה', async (t) => {
  t.mock.method(Priority, 'findPartExact', async () => null);
  t.mock.method(Priority, 'searchParts', async () => [{ p: part('OLD', 'בורג פח 8'), score: 2, full: true }, { p: part('NEW', 'בורג עץ 6'), score: 1 }]);
  assert.equal(await Parts._findBuilt('test11', { description: 'בורג פח', known: ['OLD'] }), null, 'מילה אחת מתוך שתיים — לא מספיק');
  t.mock.method(Priority, 'searchParts', async () => [{ p: part('OLD', 'בורג פח 8'), score: 2, full: true }, { p: part('NEW', 'בורג פח 10'), score: 2, full: true }]);
  assert.equal((await Parts._findBuilt('test11', { description: 'בורג פח', known: ['OLD'] })).PARTNAME, 'NEW');
  t.mock.method(Priority, 'findPartExact', async () => part('EX', 'בורג פח'));
  assert.equal((await Parts._findBuilt('test11', { description: 'בורג פח', known: ['OLD'] })).PARTNAME, 'EX', 'תיאור זהה — קודם');
});

test('מק"טים לבנייה: "רק המזוהים" ← נבנה ← "לבנות דרישה חדשה נוספת מהמק"טים שנבנו?" ← כן ← רק החסרים', async (t) => {
  H.at(t);                                      // שעות העבודה — ההודעות לעובד יוצאות מיד
  H.companies(t, 'test11');
  const u = buyerWorker();
  const B77 = part('C-77', 'בטון מובא ב-30 לתקרות');
  let built = false;
  const pr = priority(t, { searchParts: async (c, des) => (/בטון/.test(des) ? [B30, B40, ...(built ? [B77] : [])].map((p) => ({ p, score: 1 })) : []) });
  ai(t);
  buyer(t);
  const { say, wa } = H.chat(t, u);

  await toMissing(say);
  await say(BTN.done);
  let r = await say('רק המזוהים ✅');
  assert.match(r.text, /אשאל אם לבנות מהם דרישה חדשה נוספת/);
  D.run("UPDATE pd_part_requests SET status = 'expired' WHERE user_id != ?", u.id);
  built = true;
  wa.clear();
  await Parts.tick();
  const note = wa.texts().join('\n');
  assert.match(note, /לבנות דרישה חדשה נוספת מהמק"טים שנבנו, עם הכמויות שביקשת\?/);
  assert.match(note, /PRD26000007 כבר נשלחה עם הפריטים שזוהו/);
  assert.doesNotMatch(note, /להמשיך בדרישת הרכש/);

  r = await say('כן, דרישה נוספת ✅');
  assert.match(r.text, /דרישה חדשה נוספת\* מהמק"טים שנבנו \(PRD26000007 כבר נשלחה עם השאר\)/);
  assert.match(r.text, /דרישת רכש — 1 פריט/);
  assert.match(r.text, /בטון — 5 קוב _\(לתקרה\)_\n {3}✅ C-77/);
  assert.doesNotMatch(r.text, /שק מלט/);
  const before = pr.wrote('addDemandLine').length;
  await say(BTN.done);
  assert.deepEqual(pr.wrote('addDemandLine').slice(before).map((w) => [w.args[2].part, w.args[2].qty]), [['C-77', 5]]);
});

test('💬 מנהלת הרכש עונה "המק"ט כבר קיים" — העובד מקבל בבוט, ואם זה הפריט האחרון — "להמשיך בדרישה?"', async (t) => {
  H.at(t);                                      // שעות העבודה — ההודעות לעובד יוצאות מיד
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t, { partByCode: async (c, code) => (code === 'C-30' ? B30 : null) });
  ai(t);
  const sent = buyer(t);
  D.setSetting('public_url', 'https://mesimon.example');
  t.after(() => D.setSetting('public_url', ''));
  const { say, wa } = H.chat(t, u);

  await toMissing(say);
  await say(BTN.done);
  await say('לחכות לרכש ⏳');
  const link = sent[0].text.match(/https:\/\/mesimon\.example\/parts\.html\?t=([0-9a-f]{36})/);
  assert.ok(link, 'בקישור במייל — דף התשובה');
  const token = link[1];

  const v = Parts.forBuyer(token);
  const line = v.items[0].n;
  assert.equal(line, 2, 'מספר השורה בדרישה');
  assert.equal(v.worker, u.full_name);
  assert.equal(v.open, true);
  assert.deepEqual(v.items.map((x) => [x.description, x.built]), [['בטון', null]]);

  await assert.rejects(Parts.buyerAnswer(token, { n: line, code: 'NOPE-1' }), /אין מק"ט פעיל NOPE-1/);
  await assert.rejects(Parts.buyerAnswer(token, { n: line }), /כתבו מק"ט או הערה/);
  await assert.rejects(Parts.buyerAnswer('f'.repeat(36), { n: line, code: 'C-30' }), /הקישור אינו תקין/);

  wa.clear();
  const after = await Parts.buyerAnswer(token, { n: line, code: 'c-30', note: 'זה הבטון שאנחנו מזמינים תמיד' });
  assert.deepEqual(after.items[0].built, { code: 'C-30', des: 'בטון ב-30' });
  assert.equal(after.open, false);
  const note = wa.texts().join('\n');
  assert.match(note, /רותי רכש \(רכש\)\* על "בטון":\n✅ המק"ט כבר קיים: \*בטון ב-30\* \(C-30\)\n"זה הבטון שאנחנו מזמינים תמיד"/);
  assert.match(note, /להמשיך בדרישת הרכש\?/);
  await assert.rejects(Parts.buyerAnswer(token, { n: line, note: 'עוד' }), /הבקשה כבר טופלה/);

  const r = await say('כן, להמשיך ✅');
  assert.match(r.text, /בטון — 5 קוב _\(לתקרה\)_\n {3}✅ C-30/);
  await say(BTN.done);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args[2].part), ['M-1', 'C-30']);
});

test('💬 מנהלת הרכש — הערה בלבד: העובד מקבל אותה, והבקשה נשארת פתוחה', async (t) => {
  H.at(t);                                      // שעות העבודה — ההודעות לעובד יוצאות מיד
  H.companies(t, 'test11');
  const u = buyerWorker();
  priority(t);
  ai(t);
  buyer(t);
  const { say, wa } = H.chat(t, u);
  await toMissing(say);
  await say(BTN.done);
  await say('לחכות לרכש ⏳');
  const { token } = D.get('SELECT token FROM pd_part_requests WHERE user_id = ?', u.id);
  const line = Parts.forBuyer(token).items[0].n;
  wa.clear();
  const v = await Parts.buyerAnswer(token, { n: line, note: 'איזה סוג בטון? ב-30 או ב-40?' });
  assert.equal(v.open, true);
  assert.equal(v.items[0].built, null);
  assert.match(wa.texts().join('\n'), /"איזה סוג בטון\? ב-30 או ב-40\?"/);
  assert.doesNotMatch(wa.texts().join('\n'), /להמשיך/);
});

// ---------------------------------------------------------------------------
// 🆕 לרכש — רק בתיאור מדויק: "פטיש" לא יוצא לבנייה, "פטיש 5 ק"ג" כן
// ---------------------------------------------------------------------------

/** ה-AI: "פטיש" — לא בקטלוג; בדיקת התיאור: בלי משקל — לא מדויק */
function hammerAi(t, seen = []) {
  return H.claude(t, {
    edit: () => ({ action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }, { description: 'פטיש', qty: 2, unit: "יח'", note: '' }], updates: [], removes: [], question: '' }),
    match: (input) => ({ results: input.items.map((it) => (it.description === 'שק מלט'
      ? { line: it.line, kind: 'exact', codes: ['M-1'], chapter: '20', topic: '20-10', why: '' }
      : { line: it.line, kind: 'none', codes: [], chapter: '20', topic: '20-10', why: 'אין פטישים בקטלוג' })) }),
    detail: (input) => { seen.push(...input.items.map((x) => x.description)); return { results: input.items.map((x) => ({ line: x.line, specific: /\d/.test(x.description), question: 'איזה פטיש? משקל וסוג — למשל "פטיש 5 ק"ג ידית עץ"' })) }; }
  });
}

test('לרכש רק בתיאור מדויק: "פטיש" ← הבוט מבקש תיאור ← "5 ק"ג" ← "פטיש 5 ק"ג" יוצא לרכש', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  const seen = [];
  hammerAi(t, seen);
  const sent = buyer(t);
  const { say } = H.chat(t, u);

  await toItems(say);
  let r = await say('10 שקי מלט, 2 פטישים');
  assert.match(r.text, /🆕 \*פטיש\* — 2 יח'/);
  assert.match(r.text, /כדי שיוכלו לבנות אותו צריך תיאור מדויק/);
  assert.match(r.text, /איזה פטיש\? משקל וסוג/);
  H.assertButtons(r.buttons, ['להסיר את הפריט', BTN.cancel]);

  r = await say(BTN.done);                       // "סיום" לא עוקף
  assert.match(r.text, /קודם — תיאור מדויק ל\*פטיש\*/);

  r = await say('5 ק"ג');                        // תוספת לתיאור
  assert.match(r.text, /✏️ פטיש 5 ק"ג/);
  assert.match(r.text, /פטיש 5 ק"ג — 2 יח'\n {3}🆕 לא בקטלוג — יישלח לרכש לבניית מק"ט/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  assert.deepEqual(seen, ['פטיש', 'פטיש 5 ק"ג']);

  await say(BTN.done);
  await say('לחכות לרכש ⏳');
  assert.match(sent[0].text, /1\. פטיש 5 ק"ג — 2 יח'/);
  assert.doesNotMatch(sent[0].text, /1\. פטיש — /);
  assert.deepEqual(pr.writes, []);
});

test('לרכש רק בתיאור מדויק: "להסיר את הפריט" — הפריט יורד, והדרישה יוצאת עם השאר', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  hammerAi(t);
  buyer(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await say('10 שקי מלט, 2 פטישים');
  let r = await say('להסיר את הפריט');
  assert.match(r.text, /הוסר: פטיש/);
  assert.match(r.text, /דרישת רכש — 1 פריט/);
  r = await say(BTN.done);
  assert.match(r.text, /נפתחה ועברה \*לאישור\*/);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args[2].part), ['M-1']);
});

test('💬 מנהלת הרכש עונה בערב — ההודעה לעובד נשמרת לשעות העבודה, לא נשלחת ולא הולכת לאיבוד', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  priority(t);
  ai(t);
  buyer(t);
  const { say, wa } = H.chat(t, u);
  await toMissing(say);
  await say(BTN.done);
  await say('לחכות לרכש ⏳');
  const { token } = D.get('SELECT token FROM pd_part_requests WHERE user_id = ?', u.id);
  const line = Parts.forBuyer(token).items[0].n;
  wa.clear();
  t.mock.timers.setTime(new Date('2026-11-10T19:45:00Z').getTime()); // 21:45 בישראל
  await Parts.buyerAnswer(token, { n: line, note: 'איזה סוג בטון? ב-30 או ב-40?' });
  assert.doesNotMatch(wa.texts().join('\n'), /איזה סוג בטון/, 'בערב — לא נשלח');
  const queued = D.all('SELECT text FROM wa_outbox WHERE user_id = ?', u.id).map((r) => r.text).join('\n');
  assert.match(queued, /איזה סוג בטון\? ב-30 או ב-40\?/, 'נשמר בתור לבוקר');
});

/** פרויקט בבקרת תקציב: תת הפרק שבכרטיס הפריט (20 / 20-10) אינו במהדורת הביצוע של הפרויקט — כמו PD26000062 */
const CODING_ERR = 'קוד תת פרק 20: יש לבחור תת פרק מרשימת הבחירה. כאשר הפרויקט לבקרה, תת הפרק צריך להופיע במהדורת הביצוע העדכנית';

/** פריוריטי שדוחה את ‎rejected‎ (מק"ט ← הודעת השגיאה) ומקבל כל שורה אחרת */
function rejecting(t, rejected, reads = {}) {
  return H.Fakes.priority(t, {
    projects: async () => PROJECTS, recentDemandProjects: async () => [], demandCodes: async () => CODES, warehouses: async () => WAREHOUSES,
    projectWarehouses: async () => [WAREHOUSES[0]], warehouseOf: async () => 'Main',
    findPartExact: async (c, des) => (des === 'שק מלט' ? CEMENT : null),
    searchParts: async (c, des) => (/בטון/.test(des) ? [B30, B40].map((p) => ({ p, score: 1 })) : []),
    budgetPairs: async () => [{ chapter: '20', chapterDes: 'שלד', topic: '20-10', topicDes: 'בטון' }],
    generalCoding: async () => ({ chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי' }),
    partByCode: async () => null, priorityUsers: async () => [], readDemand: async (c, prdno) => ({ PRDNO: prdno }), ...reads
  }, { writes: { createDemand: async () => 'PRD26000007', addDemandLine: async (c, prdno, line) => { if (rejected[line.part]) throw new Error(rejected[line.part]); return 1; } } });
}

test('אין תקציב בפרויקט לתת הפרק של המק"ט — לא על קידוד אחר ולא על 000: טיוטא; העובד ומנהל הפרויקט בלבד (PD26000062)', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = H.worker();
  const pm = H.worker({ full_name: 'מנהל פרויקט', email: 'pm@example.com' });
  const pr = rejecting(t, { 'M-1': CODING_ERR }, {
    projectManager: async (c, proj) => (proj === 'PR1' ? 'PmLogin' : null),
    priorityUser: async (c, login) => (login === 'PmLogin' ? { login, name: 'מנהל פרויקט', email: 'PM@example.com', active: true } : null)
  });
  ai(t);
  const mails = buyer(t);
  const { say, wa } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  const before = H.D.get('SELECT COALESCE(MAX(id), 0) AS m FROM notifications').m;
  const r = await say(BTN.done);

  assert.deepEqual(pr.wrote('addDemandLine').map((w) => w.args[2]), [
    { part: 'M-1', qty: 10, chapter: '20', topic: '20-10' },
    { part: 'C-30', qty: 5, chapter: '20', topic: '20-10' }
  ], 'כל שורה פעם אחת, עם הקידוד מהכרטיס — בלי ניסיון על קידוד אחר ובלי 000');
  assert.equal(pr.wrote('submitDemand').length, 0, 'לא נשלחה לאישור');
  assert.match(r.text, /דרישת רכש PRD26000007\* נשארה \*טיוטא\* ולא נשלחה לאישור/);
  assert.match(r.text, /"שק מלט" \(M-1\): \*אין תקציב בפרויקט\* לתת פרק 20 שלד \/ 20-10 בטון/);
  assert.match(r.text, /מנהל הפרויקט \*מנהל פרויקט\* קיבל הודעה שאין תקציב/);
  assert.doesNotMatch(r.text, /רכש\) קיבלה|מנהל המערכת/);

  const toPm = wa.calls.filter((c) => String(c.body?.chatId ?? '').startsWith(pm.phone)).map((c) => c.body?.message ?? '').join('\n');
  assert.match(toPm, /אין תקציב\* — דרישת רכש של \*עובד שטח \d+\* לא נשלחה לאישור/);
  assert.match(toPm, /שק מלט — 10 שק \(M-1\): תת פרק 20 שלד \/ 20-10 בטון אינו בתקציב הפרויקט/);
  const notes = H.D.all('SELECT target_id, title FROM notifications WHERE id > ?', before);
  assert.deepEqual(notes.map((n) => n.target_id), [pm.id], 'התראה במשימון — רק למנהל הפרויקט');
  assert.equal(mails.length, 0, 'לא למנהלת הרכש');
});

test('אין תקציב, ולפרויקט אין מנהל פרויקט בפריוריטי — העובד יודע, ומנהל המערכת מקבל (הגדרה חסרה)', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  rejecting(t, { 'M-1': CODING_ERR }, { projectManager: async () => null });
  ai(t);
  const mails = buyer(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  const r = await say(BTN.done);
  assert.match(r.text, /לא מצאתי בפריוריטי את מנהל הפרויקט — מנהל המערכת קיבל פירוט/);
  assert.equal(mails.length, 0);
});

test('שורה שנדחתה מסיבה אחרת — גם כן טיוטא בלי 000; מנהלת הרכש לא הוגדרה — מנהל המערכת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  const pr = rejecting(t, { 'C-30': 'הפריט אינו פעיל' });
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await toReview(say);
  const r = await say(BTN.done);
  assert.equal(pr.wrote('addDemandLine').filter((w) => w.args[2].part === '000').length, 0);
  assert.equal(pr.wrote('submitDemand').length, 0);
  assert.match(r.text, /"בטון" \(C-30\): פריוריטי לא קיבל את השורה/);
  assert.match(r.text, /מנהל המערכת קיבל פירוט/);
});

// ---------------------------------------------------------------------------
// 🆕 מק"ט שנפתח בפריוריטי — הודעה לעובד לבד, בלי שמנהלת הרכש תעדכן (22.11.26)
// ---------------------------------------------------------------------------

const CABLE = { n: 1, description: 'כבל נחושת ירוק N2XY 5X10 (בתוך) - Synergy', qty: 500, unit: "יח'", known: [], built: null };
const HOSE = { n: 2, description: 'צינור קוברה 50 (חבילה=50 מטר) - אומיגה', qty: 5, unit: "יח'", known: [], built: null };
const newPart = (code, des) => ({ PARTNAME: code, PARTDES: des, STATDES: 'פעיל', BUD_SUBCHAPTERNAME: '30', BUD_SUBCHAPTERDES: 'חשמל', BUD_SUBTOPICNAME: '30-10', BUD_SUBTOPICDES: 'כבלים' });
function openRequest(u, missing) {
  D.run("UPDATE pd_part_requests SET status = 'expired' WHERE status = 'open'");
  return Number(D.run("INSERT INTO pd_part_requests (user_id, company, header, items, missing, mode, status, created_at) VALUES (?, 'test11', ?, ?, ?, 'wait', 'open', ?)",
    u.id, JSON.stringify({ project: { code: 'PR1', des: 'אלעד 49 צפון' } }), JSON.stringify(missing.map((m) => ({ ...m, status: 'general' }))), JSON.stringify(missing), D.nowIso()).lastInsertRowid);
}

test('נפתח מק"ט אחד מתוך שניים — העובד מקבל מיד "נפתחו המק"טים שלא מצאת" והרשימה; כשנפתח גם השני — "להמשיך בדרישה?"', async (t) => {
  H.at(t);                                       // בשעות העבודה — אחרת ההודעה נשמרת לבוקר
  const u = buyerWorker();
  let built = [];
  priority(t, { findPartExact: async () => null, searchParts: async (c, des) => built.filter((x) => des.includes(x.key)).map((x) => ({ p: x.p, score: 3, full: true })) });
  const { wa } = H.chat(t, u);
  const id = openRequest(u, [CABLE, HOSE]);

  built = [{ key: 'N2XY', p: newPart('90-10-0051', 'כבל נחושת ירוק N2XY 5X10 Synergy') }];
  wa.clear();
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 1 });
  let note = wa.texts().join('\n');
  assert.match(note, /נפתחו בפריוריטי המק"טים שלא מצאת/);
  assert.match(note, /כבל נחושת ירוק N2XY 5X10 \(בתוך\) - Synergy — 500 יח' ← \*כבל נחושת ירוק N2XY 5X10 Synergy\* \(90-10-0051\)/);
  assert.match(note, /עוד פריט אחד בבנייה ברכש: צינור קוברה 50/);
  assert.doesNotMatch(note, /להמשיך בדרישת הרכש\?/, 'עוד לא כולם — בלי שאלה');
  assert.equal(D.get('SELECT status FROM pd_part_requests WHERE id = ?', id).status, 'open');

  wa.clear();
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 0 }, 'אותו מק"ט — לא מודיעים שוב');

  built.push({ key: 'קוברה', p: newPart('70-20-0007', 'צינור קוברה 50 חבילה 50 מ\' אומיגה') });
  await Parts.tick();
  note = wa.texts().join('\n');
  assert.match(note, /המק"טים החסרים נבנו בפריוריטי — להלן הרשימה/);
  assert.match(note, /להמשיך בדרישת הרכש\?/);
  assert.equal(D.get('SELECT status FROM pd_part_requests WHERE id = ?', id).status, 'asked');
});

test('זיהוי ב-AI: הרכש ניסחה אחרת ("5*10", בלי היצרן) — ה-AI מזהה שזה אותו פריט; לא בטוח — לא מודיעים', async (t) => {
  H.at(t);                                       // בשעות העבודה — אחרת ההודעה נשמרת לבוקר
  const u = buyerWorker();
  const other = newPart('90-10-0099', 'כבל N2XY 5*16');
  const same = newPart('90-10-0052', 'כבל N2XY 5*10 ממ"ר');
  priority(t, { findPartExact: async () => null, searchParts: async () => [{ p: other, score: 2 }, { p: same, score: 2 }] });
  const asked = [];
  let answer = '90-10-0052';
  H.claude(t, { built: (input) => { asked.push(input); return { code: answer, why: 'אותו כבל, 5X10' }; } });
  const { wa } = H.chat(t, u);

  answer = '';                                    // לא בטוח
  const id1 = openRequest(u, [CABLE]);
  wa.clear();
  assert.deepEqual(await Parts.tick(), { checked: 1, told: 0 });
  assert.equal(wa.texts().length, 0);
  assert.equal(Parts._row(id1).missing[0].built, null, 'ה-AI לא בטוח — גם התאמת המילים לא קובעת');

  answer = '90-10-0052';
  await Parts.tick();
  assert.equal(Parts._row(id1).missing[0].built.code, '90-10-0052');
  assert.match(wa.texts().join('\n'), /\(90-10-0052\)/);
  assert.equal(asked.at(-1).item.description, CABLE.description);
  assert.deepEqual(asked.at(-1).candidates.map((c) => c.code), ['90-10-0099', '90-10-0052']);
});

test('המייל לרכש: פותחים מק"ט חדש — אין צורך לעדכן; הדף רק למק"ט שכבר קיים', () => {
  const u = buyerWorker();
  D.setSetting('public_url', 'https://mesimon.example');
  try {
    const m = Parts._mailOf(u, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' } }, [{ n: 1, description: 'בטון', qty: 5, unit: 'קוב' }], { name: 'שקמה', email: 'x@example.com' }, { token: 'a'.repeat(36) });
    assert.match(m.text, /פותחים מק"ט חדש בפריוריטי — אין צורך לעדכן אף אחד/);
    assert.match(m.text, /רק כשהמק"ט כבר קיים, או כדי לכתוב לו הערה: https:\/\/mesimon\.example\/parts\.html\?t=a{36}/);
    assert.match(m.html, /אין צורך לעדכן אף אחד/);
  } finally { D.setSetting('public_url', ''); }
});

// ---------------------------------------------------------------------------
// 📎 מפרט כקובץ בשאלה "תיאור מדויק" (18.11.26)
// ---------------------------------------------------------------------------

test('📎 מפרט כקובץ: צילום בשאלה "תיאור מדויק" — מספיק, לא נקרא כרשימה; יוצא במייל לרכש ולדרישה כנספח', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t, { searchParts: async () => [], readDemand: async (c, prdno) => ({ PRDNO: prdno }) });
  const extractCalls = [];
  hammerAi(t);
  t.mock.method(require('../../../server/priority/purchase-demand')._ai, 'itemsFromFile', async () => { extractCalls.push(1); return { items: [], unrelated: false, question: '' }; });
  const sent = buyer(t);
  const { say } = H.chat(t, u);

  await toItems(say);
  let r = await say('10 שקי מלט, 2 פטישים');
  assert.match(r.text, /צריך תיאור מדויק/);

  r = await say('', { file: H.photo('spec.jpg') });
  assert.match(r.text, /המפרט נקלט ל\*פטיש\*/);
  assert.match(r.text, /פטיש — 2 יח'\n {3}🆕 לא בקטלוג — יישלח לרכש לבניית מק"ט · 📎 מפרט מצורף/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);
  assert.equal(extractCalls.length, 0, 'לא נקרא כרשימת פריטים');

  await say(BTN.done);
  r = await say('רק המזוהים ✅');
  assert.match(r.text, /נפתחה ועברה \*לאישור\*/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1\. פטיש — 2 יח' · .* · 📎 מפרט מצורף/);
  assert.equal(sent[0].attachments.length, 1);
  assert.match(sent[0].attachments[0].fileName, /^מפרט 1 — פטיש\.jpg$/);
  assert.equal(sent[0].attachments[0].buf.toString(), 'fake image spec.jpg');
  // הדרישה יצאה רק עם המזוהים — המפרט שייך לפריט שמחכה לרכש, ולכן לא נספח שלה
  assert.equal(pr.wrote('attachDemand').filter((w) => /מפרט/.test(w.args[2].description)).length, 0);
  const rec = D.get('SELECT missing FROM pd_part_requests WHERE user_id = ?', u.id);
  const spec = JSON.parse(rec.missing)[0].spec;
  assert.ok(spec?.path && require('node:fs').existsSync(spec.path), 'המפרט נשמר עם הבקשה לרכש (לבנייה מחדש)');
  const v = Parts.forBuyer(D.get('SELECT token FROM pd_part_requests WHERE user_id = ?', u.id).token);
  assert.equal(v.items[0].spec, true);
});

test('📎 מפרט כקובץ: דרישה שיוצאת עם הפריט (אחרי שנבנה) — המפרט נספח בפריוריטי בשם "מפרט — …"', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t, { searchParts: async () => [] });
  hammerAi(t);
  buyer(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  await say('10 שקי מלט, 2 פטישים');
  await say('', { file: H.photo('spec.pdf') });
  await say(BTN.done);
  await say('לחכות לרכש ⏳');
  const rec = D.get('SELECT id FROM pd_part_requests WHERE user_id = ?', u.id);
  // הרכש סימנה שהפריט קיים — "להמשיך" — "סיום"
  D.run("UPDATE pd_part_requests SET missing = json_set(missing, '$[0].built', json(?)), status = 'asked', asked_at = ? WHERE id = ?",
    JSON.stringify({ code: 'H-5', des: 'פטיש 5 ק"ג', chapter: '20', topic: '20-10' }), D.nowIso(), rec.id);
  let r = await say('כן, להמשיך ✅');
  assert.match(r.text, /פטיש — 2 יח'\n {3}✅ H-5/);
  r = await say(BTN.done);
  assert.match(r.text, /נפתחה ועברה/);
  const spec = pr.wrote('attachDemand').find((w) => /מפרט/.test(w.args[2].description));
  assert.ok(spec, 'המפרט צורף לדרישה');
  assert.equal(spec.args[2].description, 'מפרט — פטיש');
});

// סקירה לילית 23.11: בשאלה "איך להמשיך?" (שלב ‎parts_mode‎) העובד הוסיף פריט ("עצר מים מתכתי … K160"),
// שינה כמות ("תשנה את הכמות ל 20 יחידה") או שלח צילום — והדרישה הושהתה ("לא נשלחה — עברתי לבקשה החדשה").
// עכשיו: תיקון / תוספת / קובץ חוזרים לרשימה ומעדכנים אותה; התשובות לשאלה עצמה — כמו קודם.
test('מק"טים לבנייה: תיקון או פריט נוסף בשאלה "איך להמשיך?" — הרשימה מתעדכנת, והדרישה לא נזנחת', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t);
  let calls = 0;
  H.claude(t, {
    edit: () => {
      calls += 1;
      if (calls === 1) return { action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }, { description: 'בטון', qty: 5, unit: 'קוב', note: 'לתקרה' }], updates: [], removes: [], question: '' };
      if (calls === 2) return { action: 'edit', adds: [], updates: [{ line: 1, qty: 20 }], removes: [], question: '' };
      return { action: 'add', adds: [{ description: 'שק מלט', qty: 3, unit: 'שק', note: '' }], updates: [], removes: [], question: '' };
    },
    match: (input) => ({
      results: input.items.map((it) => (it.description === 'בטון'
        ? { line: it.line, kind: 'close', codes: ['C-30', 'C-40'], chapter: '20', topic: '20-10', why: '' }
        : { line: it.line, kind: 'exact', codes: [it.candidates[0]?.code ?? ''], chapter: '20', topic: '20-10', why: '' }))
    })
  });
  buyer(t);
  const { say } = H.chat(t, u);
  await toMissing(say);
  let r = await say(BTN.done);
  H.assertButtons(r.buttons, ['רק המזוהים ✅', 'לחכות לרכש ⏳', BTN.cancel]);

  r = await say('תשנה את הכמות של המלט ל 20 יחידה');
  assert.doesNotMatch(r.text, /לא נשלחה/);
  assert.match(r.text, /✏️ שורה 1: שק מלט — 20 שק/);
  H.assertButtons(r.buttons, [BTN.done, BTN.cancel]);

  r = await say('עוד 3 שקי מלט');
  assert.match(r.text, /➕ נוסף פריט אחד/);
  r = await say(BTN.done);
  H.assertButtons(r.buttons, ['רק המזוהים ✅', 'לחכות לרכש ⏳', BTN.cancel]);

  // "שורה 2 — 7" — עריכה ישירה, גם מהשאלה
  r = await say('שורה 2 כמות 7');
  assert.match(r.text, /בטון — 7 קוב/);
  assert.deepEqual(pr.writes, []);
});

// ---------------------------------------------------------------------------
// 📍 לאיזה חלק בפרויקט? — תתי הפרקים של הפרויקט (בניינים, חניון משותף…), המשאב מתחתיו (24.11.26)
// ---------------------------------------------------------------------------

const PARTS = [
  { chapter: '210', chapterDes: 'מבנה A', topics: [{ topic: '210-10', topicDes: 'בטון' }, { topic: '210-20', topicDes: 'שלד' }] },
  { chapter: '220', chapterDes: 'מבנה B', topics: [{ topic: '220-10', topicDes: 'בטון' }, { topic: '220-20', topicDes: 'שלד' }] },
  { chapter: '230', chapterDes: 'חניון משותף', topics: [{ topic: '230-10', topicDes: 'בטון' }, { topic: '230-20', topicDes: 'שלד' }] }
];
/** ה-AI: "שק מלט" — זהה בקטלוג (M-1, משאב "שלד" של החלק שנבחר) */
function partsAi(t, { adds = [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }], chapter = null } = {}) {
  return H.claude(t, {
    edit: () => ({ action: 'add', adds, updates: [], removes: [], question: '' }),
    match: (input) => ({ results: input.items.map((it) => {
      const ch = chapter ?? input.pairs[0]?.chapter ?? '';
      return { line: it.line, kind: 'exact', codes: ['M-1'], chapter: ch, topic: ch ? `${ch}-20` : '', why: '' };
    }) })
  });
}

test('📍 לאיזה חלק בפרויקט? — תתי הפרקים כפי שהם (גם חניון); השורות על תת הפרק והמשאב שמתחתיו; הבחירה נשמרת', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  const pr = priority(t, { projectChapters: async (c, proj) => (proj === 'PR1' ? PARTS : []) });
  partsAi(t);
  const { say } = H.chat(t, u);

  let r = await say('דרישת רכש');
  r = await say('אלעד 49 צפון');
  assert.match(r.text, /לאיזה חלק בפרויקט\?/);
  assert.doesNotMatch(r.text, /לאיזה בניין/);
  assert.match(r.text, /• מבנה A \(210\)\n• מבנה B \(220\)\n• חניון משותף \(230\)/);
  assert.match(r.text, /שורה לחלק אחר — "שורה 3 — חניון"/);
  H.assertButtons(r.buttons, ['מבנה A', 'מבנה B', 'חניון משותף']);
  r = await say('חניון משותף');
  assert.match(r.text, /איזו דרישה\?/);
  r = await say('אתרי');
  assert.match(r.text, /📍 חלק בפרויקט: \*חניון משותף\* \(230\)/);
  r = await say('10 שקי מלט');
  assert.match(r.text, /✅ M-1 שק מלט · חניון משותף \/ שלד/);
  await say(BTN.done);
  assert.deepEqual(pr.wrote('addDemandLine')[0].args[2], { part: 'M-1', qty: 10, chapter: '230', topic: '230-20' });

  // הפעם הבאה — בלי שאלה; ושינוי בשם לבד
  r = await say('דרישת רכש');
  assert.match(r.text, /📍 חלק בפרויקט: \*חניון משותף\* \(230\) — הבחירה האחרונה שלך/);
  r = await say('מבנה A');
  assert.match(r.text, /📍 חלק בפרויקט: \*מבנה A\* \(210\)/);
});

test('📍 הבקשה גוברת: "דרישת רכש — 10 שקי מלט לחניון" — החלק נבחר לבד, בלי שאלה', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  Prefs.set(u.id, 'test11', 'demandCode', '01');
  Prefs.set(u.id, 'test11', 'buildings', { PR1: '210' });
  const pr = priority(t, { projectChapters: async () => PARTS });
  partsAi(t, { chapter: '230' });
  const { say } = H.chat(t, u);
  const r = await say('דרישת רכש — 10 שקי מלט לחניון');
  assert.doesNotMatch(r.text, /לאיזה חלק/);
  assert.match(r.text, /📍 חלק בפרויקט: \*חניון משותף\* \(230\) — לפי הבקשה/);
  await say(BTN.done);
  assert.equal(pr.wrote('addDemandLine')[0].args[2].chapter, '230');
});

test('📍 "שורה 2 — חניון": שורה אחת לחלק אחר, ושאר הדרישה נשארת על החלק שנבחר', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  Prefs.remember(u.id, { company: 'test11', project: { code: 'PR1', des: 'אלעד 49 צפון' }, warehouse: 'W1' });
  Prefs.set(u.id, 'test11', 'demandCode', '01');
  Prefs.set(u.id, 'test11', 'buildings', { PR1: '210' });
  const pr = priority(t, { projectChapters: async () => PARTS });
  partsAi(t, { adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }, { description: 'שק מלט', qty: 4, unit: 'שק', note: '' }] });
  const { say } = H.chat(t, u);
  let r = await say('דרישת רכש');
  assert.match(r.text, /📍 חלק בפרויקט: \*מבנה A\* \(210\) — הבחירה האחרונה שלך/);
  await say('10 שקי מלט, ועוד 4');
  r = await say('שורה 2 — חניון');
  assert.match(r.text, /📍 שורה 2 \(שק מלט\) ← \*חניון משותף\*/);
  assert.match(r.text, /\*1\.\* שק מלט — 10 שק\n {3}✅ M-1 שק מלט · מבנה A \/ שלד/);
  assert.match(r.text, /\*2\.\* שק מלט — 4 שק\n {3}✅ M-1 שק מלט · חניון משותף \/ שלד/);
  await say(BTN.done);
  assert.deepEqual(pr.wrote('addDemandLine').map((w) => [w.args[2].chapter, w.args[2].topic]), [['210', '210-20'], ['230', '230-20']]);
  // "שורה 1 — 20" — עדיין כמות, לא חלק
});

test('📍 חלק אחד בפרויקט — בלי שאלה; בלי תתי פרקים — כמו קודם', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  priority(t, { projectChapters: async (c, proj) => (proj === 'PR1' ? [PARTS[0]] : []) });
  ai(t);
  const { say } = H.chat(t, u);
  await say('דרישת רכש');
  let r = await say('אלעד 49 צפון');
  assert.doesNotMatch(r.text, /לאיזה חלק/);
  r = await say('אתרי');
  assert.match(r.text, /📍 חלק בפרויקט: \*מבנה A\* \(210\) — היחיד בפרויקט/);
  r = await say('פרויקט נהריה');
  assert.doesNotMatch(r.text, /חלק בפרויקט/);
});

test('📍 אין משאב מתאים מתחת לתת הפרק — העובד לא נתקע (הקידוד של הפריט), ומנהל המערכת מקבל התראה', async (t) => {
  H.at(t);
  H.companies(t, 'test11');
  const u = buyerWorker();
  const admin = require('../../helpers/db').user({ role: 'admin', full_name: 'מנהל' });
  const pr = priority(t, { projectChapters: async () => [{ chapter: '210', chapterDes: 'מבנה A', topics: [{ topic: '210-90', topicDes: 'חשמל' }] }] });
  H.claude(t, {
    edit: () => ({ action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }], updates: [], removes: [], question: '' }),
    match: (input) => ({ results: input.items.map((it) => ({ line: it.line, kind: 'exact', codes: ['M-1'], chapter: '', topic: '', why: '' })) })
  });
  const { say } = H.chat(t, u);
  await say('דרישת רכש');
  await say('אלעד 49 צפון');
  await say('אתרי');
  const r = await say('10 שקי מלט');
  assert.match(r.text, /✅ M-1 שק מלט · שלד \/ בטון/);
  await say(BTN.done);
  assert.deepEqual(pr.wrote('addDemandLine')[0].args[2], { part: 'M-1', qty: 10, chapter: '20', topic: '20-10' });
  const n = D.get("SELECT title, body FROM notifications WHERE target_id = ? AND title LIKE '%אין משאב מתאים%' ORDER BY id DESC", admin.id);
  assert.ok(n, 'התראה למנהל');
  assert.match(n.title, /מתחת לתת הפרק מבנה A/);
  assert.match(n.body, /פריט: שק מלט \(M-1/);
  assert.match(n.body, /המשאבים מתחת לתת הפרק: 210-90 חשמל/);
});

// סקירה לילית 24.11: דרישה שמורה (מושהית) ירדה כשהעובד ביקש להמשיך בה במילים שלו — "תשלח את זה כדרישת רכש",
// "אתה יכול להוציא את דרישת הרכש", "איך להמשיך?" ("לא נשלחה — עברתי לבקשה החדשה"). עכשיו — ממשיכים בה.
test('דרישה שמורה: "תשלח את זה כדרישת רכש" / "להוציא את הדרישה" / "איך להמשיך?" — ממשיכים בה, לא נזרקת', async (t) => {
  H.companies(t, 'test11');
  const PD = require('../../../server/priority/purchase-demand');
  for (const ask of ['תשלח את זה כדרישת רכש', 'מבחינתי אתה יכול להוציא את דרישת הרכש', 'איך להמשיך?']) {
    const u = buyerWorker();
    priority(t);
    ai(t);
    const { say } = H.chat(t, u);
    await toItems(say);
    await toReview(say);
    // הדרישה מושהית (כמו אחרי בקשה אחרת / 15 דקות)
    const s = PD._load(u.id);
    PD._pause(u.id);
    assert.equal(PD.active(u.id), false);
    assert.ok(PD.opens(ask, u.id), 'opens: ' + ask);
    assert.equal(s.items.length, 2);
    const r = await say(ask);
    assert.match(r.text, /ממשיכים בדרישת הרכש/, ask);
    assert.match(r.text, /דרישת רכש — 2 פריטים/, ask);
    assert.doesNotMatch(r.text, /לא נשלחה/, ask);
  }
});

// סקירה לילית 24.11: בשאלה "התכוונת ל…" פקודות הפכו לתיאור של הפריט — "סיים" / "תסיים הכל" / "רכישת רכש"
// (במקום "דרישת רכש") החליפו את התיאור, ו"תבטל ותבדוק לי גלגל …" נשמר כתיאור עם "תבטל ותבדוק לי".
test('"התכוונת ל…": "סיים", "תסיים הכל", "רכישת רכש" ושאלה — לא תיאור; "תבטל ותבדוק לי X" — X בלבד', async (t) => {
  H.companies(t, 'test11');
  const u = buyerWorker();
  priority(t);
  ai(t);
  const { say } = H.chat(t, u);
  await toItems(say);
  let r = await say('10 שקי מלט, 5 קוב בטון לתקרה');
  assert.match(r.text, /התכוונת ל/);
  for (const cmd of ['סיים', 'תסיים הכל', 'רכישת רכש', 'מה לא מובן בתסיים הכל?']) {
    r = await say(cmd);
    assert.match(r.text, /קודם — \*בטון\*/, cmd);
    assert.doesNotMatch(r.text, /✏️|🆕 \*(סיים|תסיים|רכישת)/, cmd);
  }
  r = await say('תבטל ותבדוק לי בטון ב-30 מיוחד');
  assert.match(r.text, /בטון ב-30 מיוחד/);
  assert.doesNotMatch(r.text, /תבטל|תבדוק/);
});

// רעיון מסקירה 24.11 (נבנה 24.11): עובד מנה פריטים בשיחה רגילה ("3 סנני מים", "צינור 6 מ"מ 10 מטרים"), הבוט ענה
// "לפתוח דרישת רכש? כתוב 'דרישת רכש'" — ו"דרישת רכש" נפתחה ריקה. עכשיו: מה שנכתב בשעה האחרונה, שהבוט הציע עליו
// דרישת רכש (ואחרי הדרישה הקודמת), נכנס לדרישה כשהיא נפתחת, והעובד רואה מה נכנס.
test('פריטים שנמנו בשיחה רגילה לפני "דרישת רכש" — נכנסים לדרישה כשהיא נפתחת', async (t) => {
  H.companies(t, 'test11');
  const u = H.worker();
  priority(t);
  const seen = [];
  H.claude(t, {
    edit: (input) => { seen.push(JSON.stringify(input)); return { action: 'add', adds: [{ description: 'שק מלט', qty: 10, unit: 'שק', note: '' }], updates: [], removes: [], question: '' }; },
    match: (input) => ({ results: input.items.map((it) => ({ line: it.line, kind: 'exact', codes: [it.candidates[0]?.code ?? ''], chapter: '20', topic: '20-10', why: '' })) })
  });
  const { say } = H.chat(t, u);
  // דרישה קודמת שבוטלה — מקבעת פרויקט / מחסן / סוג, ומה שנכתב לפניה לא נלקח
  await toItems(say);
  await say(BTN.cancel);
  const { D: Db } = require('../../helpers/db');
  const row = (text, reply) => Db.run("INSERT INTO wa_log (at, channel, user_id, text, action, status, reply) VALUES (?, 'private', ?, ?, 'other', 'unclear', ?)",
    new Date().toISOString(), u.id, text, reply);
  row('10 שקי מלט', 'קיבלתי 👍 לפתוח דרישת רכש? כתוב "דרישת רכש".');
  row('מה השעה?', 'עכשיו 10:00');
  let r = await say('דרישת רכש');
  assert.match(r.text, /לאיזה פרויקט/, 'קודם הפרויקט');
  // סוג הדרישה כבר זכור — אחרי הפרויקט ישר לפריטים, ומה שנכתב קודם נכנס
  r = await say('אלעד 49 צפון');
  assert.match(r.text, /הכנסתי לדרישה את מה שכתבת קודם/);
  assert.match(r.text, /שק מלט — 10 שק/);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /10 שקי מלט/);
  assert.doesNotMatch(seen[0], /מה השעה/);

  // אחרי שנכנסו — "דרישת רכש" חדשה לא מכניסה אותם שוב
  await say(BTN.cancel);
  await say('דרישת רכש');
  const r2 = await say('אלעד 49 צפון');
  assert.doesNotMatch(r2.text, /הכנסתי לדרישה/);
  assert.equal(seen.length, 1);
});
