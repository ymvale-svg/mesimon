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
  return say('אף אחד ❌');
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
