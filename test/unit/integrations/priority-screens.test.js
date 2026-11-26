'use strict';
/**
 * 🔐 מפת המסכים של פריוריטי ("תוכנית — אבטחת הגישה לפריוריטי.md", שלב 2):
 *   • ‎call()‎ חוסם מסך שאינו במפה, וכתיבה לחלק שלא כתוב בה — לפני שהפנייה יוצאת.
 *   • כל מסך שמופיע בקוד נמצא במפה.
 *   • ‎WRITES‎ — בדיוק הפונקציות שכותבות (לפי הקוד), ותחומים שרק מציגים מידע לא משתמשים בהן.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Priority = require('../../../server/integrations/priority');

const ROOT = path.resolve(__dirname, '../../..');
const SRC = fs.readFileSync(path.join(ROOT, 'server/integrations/priority.js'), 'utf8');

function withCreds(t, companies = 'test11') {
  const prev = process.env.PRIORITY_COMPANIES;
  process.env.PRIORITY_USER = 'TOKEN123';
  process.env.PRIORITY_PASSWORD = 'PAT';
  process.env.PRIORITY_COMPANIES = companies;
  t.after(() => {
    delete process.env.PRIORITY_USER;
    delete process.env.PRIORITY_PASSWORD;
    process.env.PRIORITY_COMPANIES = prev;
  });
}

function fakeFetch(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  });
  t.mock.method(console, 'error', () => {});
  return calls;
}

// ---------------------------------------------------------------- הפירוק של הנתיב

test('screenOf: המסך והחלק — גם עם מפתח בסוגריים, תת-מסך ושאילתה', () => {
  assert.deepEqual(Priority.screenOf('SUPPLIERS?$top=1'), { screen: 'SUPPLIERS', part: '' });
  assert.deepEqual(Priority.screenOf("DOCUMENTS_P(DOCNO='GR1',TYPE='P')"), { screen: 'DOCUMENTS_P', part: '' });
  assert.deepEqual(Priority.screenOf("DOCUMENTS_P(DOCNO='GR1',TYPE='P')/TRANSORDER_P_SUBFORM(KLINE=3,TYPE='P')"),
    { screen: 'DOCUMENTS_P', part: 'TRANSORDER_P_SUBFORM' });
  assert.deepEqual(Priority.screenOf("PURDEMANDS('PD1')/EXTFILES_SUBFORM?$top=5"), { screen: 'PURDEMANDS', part: 'EXTFILES_SUBFORM' });
  // סוגר ולוכסן בתוך המפתח — לא נחשבים
  assert.deepEqual(Priority.screenOf("DOCUMENTS_P(DOCNO='A)/B',TYPE='P')/EXTFILES_SUBFORM"), { screen: 'DOCUMENTS_P', part: 'EXTFILES_SUBFORM' });
  assert.deepEqual(Priority.screenOf('$metadata'), { screen: '$metadata', part: '' });
});

// ---------------------------------------------------------------- החסימה

test('קריאה ממסך שאינו במפה — נחסמת לפני הפנייה', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t);
  await assert.rejects(Priority._call('test11', 'GET', 'CUSTOMERS?$top=1'), (err) => err instanceof Priority.PriorityError && /SCREENS/.test(err.message));
  await assert.rejects(Priority._call('test11', 'GET', 'FNCTRANS'), /אין גישה/);
  assert.equal(calls.length, 0);
});

test('קריאה ממסך שבמפה ומתת-מסך שלו — יוצאת', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t);
  await Priority._call('test11', 'GET', 'SUPPLIERS?$top=1');
  await Priority._call('test11', 'GET', "DOCUMENTS_p('P1')/ANY_SUBFORM?$top=1");
  await Priority._call('test11', 'GET', 'DINVOICES?$top=1');
  assert.equal(calls.length, 3);
});

test('כתיבה למסך שמותר בו רק לקרוא — נחסמת, גם בחברה שפתוחה לכתיבה', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t);
  await assert.rejects(Priority._call('test11', 'POST', 'PINVOICES', { SUPNAME: '1' }), /הכתיבה נחסמה/);
  await assert.rejects(Priority._call('test11', 'PATCH', "PORDERS('PO1')", { STATDES: 'מבוטלת' }), /הכתיבה נחסמה/);
  await assert.rejects(Priority._call('test11', 'DELETE', "ACCOUNTS_PAYABLE('1')"), /הכתיבה נחסמה/);
  assert.equal(calls.length, 0);
});

test('כתיבה לחלק או לפעולה שאינם במפה — נחסמת', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t);
  // מחיקת מסמך שלם — אף פעם לא (מבטלים בסטטוס)
  await assert.rejects(Priority._call('test11', 'DELETE', "DOCUMENTS_P(DOCNO='GR1',TYPE='P')"), /הכתיבה נחסמה/);
  // שינוי כרטיס הספק עצמו — רק "מוצרים לספק" מותר
  await assert.rejects(Priority._call('test11', 'PATCH', "SUPPLIERS('100')", { SUPDES: 'x' }), /הכתיבה נחסמה/);
  // תת-מסך שלא ברשימה
  await assert.rejects(Priority._call('test11', 'POST', "PURDEMANDS('PD1')/OTHER_SUBFORM", {}), /PURDEMANDS\/OTHER_SUBFORM/);
  // מסך שלא במפה בכלל
  await assert.rejects(Priority._call('test11', 'POST', 'FNCTRANS', {}), /הכתיבה נחסמה/);
  assert.equal(calls.length, 0);
});

test('כתיבה מותרת (חלק שבמפה, חברה פתוחה) — יוצאת', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t);
  await Priority.setHeader('test11', 'GR1', { DETAILS: 'x' });
  await Priority.setDemandLine('test11', 'PD1', 2, { TQUANT: 1 });
  await Priority.deleteSupplierPart('test11', '100', 5);
  assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'PATCH', 'DELETE']);
});

test('המפה לא פותחת חברה: כתיבה מותרת במפה לחברה שאינה פתוחה — עדיין נחסמת', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t);
  await assert.rejects(Priority.setHeader('a160226', 'GR1', { DETAILS: 'x' }), /אינה פתוחה לכתיבה/);
  assert.equal(calls.length, 0);
});

test('"ממתין לאישורך" קורא ממסך עם מאשרים שאינו במפה — רק קריאה, ורק דרכו', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t);
  const s = { screen: 'CPROF', key: 'CPROFNUM', approvers: null, approverFields: [], fields: ['STATDES'] };
  await Priority.waitingDocs('test11', s);
  await Priority.waitingDoc('test11', s, 'X1');
  assert.equal(calls.length, 2);
  // אותו מסך בקריאה רגילה — נחסם
  await assert.rejects(Priority._call('test11', 'GET', 'CPROF?$top=1'), /אין גישה/);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------- התאמה לקוד

test('כל מסך שמופיע בקוד של החיבור — נמצא במפה', () => {
  const used = new Set([...SRC.matchAll(/[`'](\$metadata|[A-Z][A-Za-z0-9_]+)(?=[?(/])/g)].map((m) => m[1]).filter((x) => !x.endsWith('_SUBFORM')));
  assert.ok(used.has('DOCUMENTS_P') && used.has('DINVOICES'), 'החיפוש בקוד לא מצא את המסכים הידועים');
  const missing = [...used].filter((x) => !Object.hasOwn(Priority.SCREENS, x));
  assert.deepEqual(missing, [], `מסכים בקוד שאינם ב-SCREENS: ${missing.join(', ')}`);
});

test('אין במפה מסך שהקוד כבר לא משתמש בו', () => {
  const unused = Object.keys(Priority.SCREENS).filter((x) => !SRC.replace(/const SCREENS = [\s\S]*?\n\}\);/, '').includes(x));
  assert.deepEqual(unused, []);
});

/** הפונקציות ברמה העליונה של הקובץ: ‎{ name → body }‎ */
function topLevel(src) {
  const out = new Map();
  const re = /^(?:async function|function|const) (\w+)/gm;
  const hits = [...src.matchAll(re)];
  hits.forEach((m, i) => out.set(m[1], src.slice(m.index, hits[i + 1]?.index ?? src.length)));
  return out;
}

test('WRITES — בדיוק הפונקציות המיוצאות שכותבות לפריוריטי (גם דרך פונקציה אחרת)', () => {
  const defs = topLevel(SRC.slice(0, SRC.indexOf('module.exports')));
  const writers = new Set([...defs].filter(([, body]) => /\bcall\(/.test(body) && /'(?:POST|PATCH|DELETE)'/.test(body)).map(([n]) => n));
  writers.delete('call');
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of defs) {
      if (writers.has(name) || name === 'WRITES') continue;
      if ([...writers].some((w) => new RegExp(`\\b${w}\\(`).test(body))) { writers.add(name); grew = true; }
    }
  }
  const exported = Object.keys(Priority).filter((k) => typeof Priority[k] === 'function');
  const actual = exported.filter((n) => writers.has(n)).sort();
  assert.deepEqual(actual, [...Priority.WRITES].sort(), 'עדכנו את WRITES ב-server/integrations/priority.js');
});

test('תחומים שרק מציגים מידע — לא משתמשים בפונקציות כתיבה של פריוריטי', () => {
  const files = [
    'server/priority/payments.js', 'server/priority/payments-paid.js', 'server/priority/payments-notify.js',
    'server/priority/priority-waiting.js',
    ...fs.readdirSync(path.join(ROOT, 'server/agents')).map((f) => `server/agents/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'server/today')).map((f) => `server/today/${f}`)
  ].filter((f) => f.endsWith('.js'));
  const re = new RegExp(`\\b(?:Priority|P|Integrations\\.Priority)\\.(${Priority.WRITES.join('|')}|_call)\\b`, 'g');
  const hits = [];
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(re)) hits.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(hits, []);
});
