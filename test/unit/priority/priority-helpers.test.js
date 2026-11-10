'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Priority = require('../../../server/priority');

/** ‎PRIORITY_COMPANIES‎ לבדיקה אחת, ומחזירים */
function withCompanies(t, value) {
  const prev = process.env.PRIORITY_COMPANIES;
  if (value === undefined) delete process.env.PRIORITY_COMPANIES; else process.env.PRIORITY_COMPANIES = value;
  t.after(() => { process.env.PRIORITY_COMPANIES = prev; });
}

// ---------------------------------------------------------------------------
// חברות ורשימת ההיתר
// ---------------------------------------------------------------------------

test('allowed — רשימה מופרדת בפסיקים, בלי רווחים וריקים', (t) => {
  withCompanies(t, ' a160226 , mordot,,test11 ');
  assert.deepEqual(Priority.allowed(), ['a160226', 'mordot', 'test11']);
});

test('allowed — בלי משתנה: test11 בלבד', (t) => {
  withCompanies(t, undefined);
  assert.deepEqual(Priority.allowed(), ['test11']);
});

test('isEnabled — רק עם משתמש וסיסמה', (t) => {
  assert.equal(Priority.isEnabled(), false);
  process.env.PRIORITY_USER = 'tok';
  t.after(() => { delete process.env.PRIORITY_USER; delete process.env.PRIORITY_PASSWORD; });
  assert.equal(Priority.isEnabled(), false);
  process.env.PRIORITY_PASSWORD = 'PAT';
  assert.equal(Priority.isEnabled(), true);
});

test('COMPANIES — קודים ייחודיים, ח.פ. בן 9 ספרות או ריק', () => {
  const codes = Priority.COMPANIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of Priority.COMPANIES) assert.ok(c.vat === '' || /^\d{9}$/.test(c.vat), c.code);
  const vats = Priority.COMPANIES.map((c) => c.vat).filter(Boolean);
  assert.equal(new Set(vats).size, vats.length);
});

test('COMPANIES — עותק הבדיקה הוא test11 בלבד', () => {
  assert.deepEqual(Priority.COMPANIES.filter((c) => c.test).map((c) => c.code), ['test11']);
  for (const c of Priority.COMPANIES.filter((x) => x.sandbox)) assert.ok(Priority.isTest(c.sandbox), c.code);
});

test('companyOf — חברה מוכרת ולא מוכרת', () => {
  assert.equal(Priority.companyOf('mordot').name, 'מורדות הכרמל נכסים');
  assert.deepEqual(Priority.companyOf('zzz'), { code: 'zzz', name: 'zzz', vat: '' });
});

test('isTest', () => {
  assert.equal(Priority.isTest('test11'), true);
  assert.equal(Priority.isTest('a160226'), false);
  assert.equal(Priority.isTest('zzz'), false);
});

test('resolveCompany — לפי ח.פ., ישירות כשהחברה פתוחה', (t) => {
  withCompanies(t, 'mordot');
  const r = Priority.resolveCompany('513537613');
  assert.equal(r.company, 'mordot');
  assert.equal(r.via, 'direct');
  assert.equal(r.how, 'vat');
  assert.equal(r.matched.code, 'mordot');
});

test('resolveCompany — ח.פ. עם מקפים ורווחים', (t) => {
  withCompanies(t, 'mordot');
  assert.equal(Priority.resolveCompany('51-353 761-3').company, 'mordot');
});

test('resolveCompany — חברה סגורה עם עותק בדיקה פתוח: sandbox', (t) => {
  withCompanies(t, 'test11');
  const r = Priority.resolveCompany('512061185');
  assert.equal(r.company, 'test11');
  assert.equal(r.via, 'sandbox');
  assert.equal(r.matched.code, 'a160226');
});

test('resolveCompany — חברה סגורה בלי עותק: אין לאן לקלוט', (t) => {
  withCompanies(t, 'test11');
  const r = Priority.resolveCompany('513537613');
  assert.equal(r.company, null);
  assert.equal(r.via, null);
  assert.equal(r.matched.code, 'mordot');
});

test('resolveCompany — ח.פ. לא מוכר', (t) => {
  withCompanies(t, 'mordot');
  const r = Priority.resolveCompany('999999999');
  assert.deepEqual(r, { company: null, via: null, matched: null, how: null });
});

test('resolveCompany — לפי מספר אחר במסמך (ids)', (t) => {
  withCompanies(t, 'raba');
  const r = Priority.resolveCompany('', { ids: ['12345', '516941705'] });
  assert.equal(r.company, 'raba');
  assert.equal(r.how, 'id');
});

test('resolveCompany — לפי השם, "ובניין" ו-בע"מ', (t) => {
  withCompanies(t, 'kanyan1');
  const r = Priority.resolveCompany('', { name: 'קנין ובניין בע"מ' });
  assert.equal(r.company, 'kanyan1');
  assert.equal(r.how, 'name');
});

test('resolveCompany — שם שמתאים לכמה חברות: לא נבחר', (t) => {
  withCompanies(t, 'a160226,a040626');
  const r = Priority.resolveCompany('', { name: 'אשל הירדן' });
  assert.equal(r.matched, null);
  assert.equal(r.company, null);
});

test('resolveCompany — שם עותק הבדיקה אינו נמען', (t) => {
  withCompanies(t, 'test11');
  const r = Priority.resolveCompany('', { name: 'אשל הירדן יזום ובנין — סביבת בדיקה' });
  assert.notEqual(r.matched?.code, 'test11');
});

test('resolveCompany — ח.פ. גובר על השם', (t) => {
  withCompanies(t, 'mordot,raba');
  const r = Priority.resolveCompany('513537613', { name: 'רבץ רכסים' });
  assert.equal(r.company, 'mordot');
});

test('companiesByName — חלק מהשם, בלי עותק הבדיקה', () => {
  const codes = Priority.companiesByName('גשם הירדן').map((c) => c.code).sort();
  assert.deepEqual(codes, ['ghyar1', 'greha1']);
  assert.ok(!Priority.companiesByName('סביבת בדיקה').some((c) => c.test));
});

test('companiesByName — קצר מדי או לא קיים', () => {
  assert.deepEqual(Priority.companiesByName('א'), []);
  assert.deepEqual(Priority.companiesByName(''), []);
  assert.deepEqual(Priority.companiesByName('חברה שאינה קיימת'), []);
});

// ---------------------------------------------------------------------------
// תנאי תשלום
// ---------------------------------------------------------------------------

test('PAY_TERMS — קודים ייחודיים, ברירת המחדל קיימת', () => {
  const codes = Priority.PAY_TERMS.map((p) => p.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(Priority.DEFAULT_PAY, '04');
  assert.equal(Priority.payTerm(Priority.DEFAULT_PAY).days, 45);
});

test('payTerm — קוד לא קיים: null', () => {
  assert.equal(Priority.payTerm('99'), null);
  assert.equal(Priority.payTerm(undefined), null);
});

test('payLabel', () => {
  assert.equal(Priority.payLabel('01'), 'שוטף');
  assert.equal(Priority.payLabel('04'), 'שוטף + 45');
  assert.equal(Priority.payLabel('06'), 'שוטף + 90');
  assert.equal(Priority.payLabel('77'), '77');
});

test('payFromText — הצורות השונות', () => {
  assert.equal(Priority.payFromText('שוטף 60').code, '05');
  assert.equal(Priority.payFromText('שוטף+30').code, '03');
  assert.equal(Priority.payFromText('ש60').code, '05');
  assert.equal(Priority.payFromText('שוטף פלוס 90').code, '06');
  assert.equal(Priority.payFromText('תנאי תשלום: שוטף + 15').code, '02');
  assert.equal(Priority.payFromText('ש"75').code, '08');
});

test('payFromText — "שוטף" לבד', () => {
  assert.equal(Priority.payFromText('שוטף').code, '01');
  assert.equal(Priority.payFromText('תשלום שוטף.').code, '01');
});

test('payFromText — מספר ימים בלי קוד', () => {
  assert.deepEqual(Priority.payFromText('שוטף 50'), { unknown: 50 });
});

test('payFromText — אין תנאי תשלום', () => {
  assert.equal(Priority.payFromText('שלום'), null);
  assert.equal(Priority.payFromText(''), null);
  assert.equal(Priority.payFromText(null), null);
  assert.equal(Priority.payFromText('שוטפים את הרצפה'), null);
});

test('dueDate — שוטף: סוף החודש', () => {
  assert.equal(Priority.dueDate('01', '2026-02-10'), '2026-02-28');
  assert.equal(Priority.dueDate('01', '2028-02-10'), '2028-02-29');
});

test('dueDate — שוטף + N: סוף החודש ועוד N ימים', () => {
  assert.equal(Priority.dueDate('04', '2026-01-15'), '2026-03-17');
  assert.equal(Priority.dueDate('03', '2026-12-05T00:00:00Z'), '2027-01-30');
});

test('dueDate — בלי קוד או תאריך: ריק', () => {
  assert.equal(Priority.dueDate('99', '2026-01-15'), '');
  assert.equal(Priority.dueDate('04', ''), '');
  assert.equal(Priority.dueDate('04', '15.01.2026'), '');
});

test('TAX_CODES — קוד הפטור קיים', () => {
  assert.equal(Priority.NO_VAT_CODE, '000');
  assert.ok(Priority.TAX_CODES[Priority.NO_VAT_CODE]);
});

// ---------------------------------------------------------------------------
// דרישת רכש — עזרים
// ---------------------------------------------------------------------------

test('nextSigner — USERLOGIN בכותרת קודם', () => {
  assert.equal(Priority.nextSigner({ USERLOGIN: 'Eladh', PDUSER_SUBFORM: [{ USERLOGIN: 'x' }] }), 'Eladh');
});

test('nextSigner — המאשר הראשון שלא אישר', () => {
  const d = { PDUSER_SUBFORM: [{ USERLOGIN: 'a', UFLAG: 'Y' }, { USERLOGIN: 'b', UFLAG: '' }, { USERLOGIN: 'c' }] };
  assert.equal(Priority.nextSigner(d), 'b');
});

test('nextSigner — ממלא מקום (NEXTUSERLOGIN)', () => {
  assert.equal(Priority.nextSigner({ PDUSER_SUBFORM: [{ USERLOGIN: 'a', NEXTUSERLOGIN: 'z' }] }), 'z');
});

test('nextSigner — אין חותם', () => {
  assert.equal(Priority.nextSigner({ PDUSER_SUBFORM: [{ USERLOGIN: 'a', UFLAG: 'Y' }] }), null);
  assert.equal(Priority.nextSigner({}), null);
  assert.equal(Priority.nextSigner(null), null);
});

test('isNoApproversError', () => {
  assert.equal(Priority.isNoApproversError(new Error('לא הוגדרה רשימת מאשרים')), true);
  assert.equal(Priority.isNoApproversError(new Error('חסרה רשימת המאשרים')), true);
  assert.equal(Priority.isNoApproversError(new Error('ספק לא קיים')), false);
  assert.equal(Priority.isNoApproversError(null), false);
});

test('PD_TYPES ו-GENERAL', () => {
  assert.equal(Priority.PD_TYPES['02'], 'רכש אתרי');
  assert.equal(Priority.PD_TYPES['01'], 'רכש משרדי');
  assert.equal(Priority.GENERAL.chapter, '101');
});

// ---------------------------------------------------------------------------
// התאמת פרויקטים בשפה חופשית
// ---------------------------------------------------------------------------

const PROJECTS = [
  { code: 'P1', des: 'אלעד סנטר מגרש 5' },
  { code: 'P2', des: 'מבואות דרומיים מגרש 207' },
  { code: 'P3', des: 'מבואות דרומיים מגרש 208' },
  { code: 'P4', des: 'קדמה נתניה', alias: 'נתניה מגורים' }
];
const codes = (l) => l.map((p) => p.code);

test('matchProjects — מילה מהשם', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'אלעד')), ['P1']);
});

test('matchProjects — אות שימוש בתחילת המילה', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'באלעד')), ['P1']);
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'ובמבואות', { all: true })), ['P2', 'P3']);
});

test('matchProjects — מספר מגרש מדויק', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'מבואות 207', { all: true })), ['P2']);
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, '20', { all: true })), []);
});

test('matchProjects — מילות קישור מדולגות', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'זה של הפרויקט במגרש')), []);
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'הפרויקט של אלעד', { all: true })), ['P1']);
});

test('matchProjects — all: כל המילים חייבות להתאים', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'אלעד ירושלים', { all: true })), []);
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'אלעד ירושלים')), ['P1']);
});

test('matchProjects — לפי כינוי', () => {
  assert.deepEqual(codes(Priority.matchProjects(PROJECTS, 'מגורים', { all: true })), ['P4']);
});

test('matchProjects — אותיות סופיות וכפולות', () => {
  const list = [{ code: 'X', des: 'בניין מגורים' }];
  assert.deepEqual(codes(Priority.matchProjects(list, 'בנין', { all: true })), ['X']);
});

test('matchProjects — מיון לפי ציון', () => {
  const out = Priority.matchProjects(PROJECTS, 'מבואות דרומיים 208');
  assert.equal(out[0].code, 'P3');
  assert.equal(out[0].score, 3);
  assert.ok(out.every((p, i) => i === 0 || out[i - 1].score >= p.score));
});

test('matchProjects — טקסט ריק', () => {
  assert.deepEqual(Priority.matchProjects(PROJECTS, ''), []);
  assert.deepEqual(Priority.matchProjects(PROJECTS, null), []);
});

test('matchProjects — לא משנה את הרשימה המקורית', () => {
  const list = [{ code: 'A', des: 'אלעד' }];
  Priority.matchProjects(list, 'אלעד');
  assert.deepEqual(list, [{ code: 'A', des: 'אלעד' }]);
});
