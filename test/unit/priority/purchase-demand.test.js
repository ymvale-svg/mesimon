'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Priority = require('../../../server/integrations/priority');
const UI = require('../../../server/whatsapp/wa-ui');
const PD = require('../../../server/priority/purchase-demand');

boot();
let next = 8000;
const uid = () => { next += 1; return next; };
const put = (userId, s) => D.setSetting(`purchase_demand:${userId}`, s);

/** "היום" = 10.11.2026 */
const fixNow = (t) => t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T10:00:00Z') });

test('isTrigger / opens', () => {
  for (const t of ['דרישת רכש', 'צריך דרישת  רכש לאתר', 'דרישות רכש']) assert.ok(PD.isTrigger(t) && PD.opens(t), t);
  for (const t of ['קבלת סחורה', 'רכש', '', null]) assert.ok(!PD.isTrigger(t), String(t));
});

test('parseDate — היום, מחר, מחרתיים', (t) => {
  fixNow(t);
  assert.equal(PD._parseDate('היום'), '2026-11-10');
  assert.equal(PD._parseDate('מחר'), '2026-11-11');
  assert.equal(PD._parseDate('תאריך מחרתיים'), '2026-11-12');
});

test('parseDate — יום וחודש, השנה הנוכחית', (t) => {
  fixNow(t);
  assert.equal(PD._parseDate('12.11'), '2026-11-12');
  assert.equal(PD._parseDate('תאריך 1/12'), '2026-12-01');
  assert.equal(PD._parseDate('20-10'), '2026-10-20');
});

test('parseDate — עם שנה', (t) => {
  fixNow(t);
  assert.equal(PD._parseDate('12/11/26'), '2026-11-12');
  assert.equal(PD._parseDate('1.1.2027'), '2027-01-01');
  assert.equal(PD._parseDate('5.9.2026'), '2026-09-05');
});

test('parseDate — בלי שנה ועבר לפני יותר מחודש: השנה הבאה', (t) => {
  fixNow(t);
  assert.equal(PD._parseDate('5.9'), '2027-09-05');
  assert.equal(PD._parseDate('2.1'), '2027-01-02');
});

test('parseDate — לא תאריך: null', (t) => {
  fixNow(t);
  for (const x of ['13.13', '0.5', '32.1', 'בלי תאריך', '', null]) assert.equal(PD._parseDate(x), null, String(x));
});

// באג ידוע: ‎Date.parse('2027-02-31')‎ אינו NaN ב-V8, ולכן תאריך שאינו קיים עובר (purchase-demand.js, parseDate)
test('parseDate — יום שאינו קיים בחודש: null', { todo: 'באג: 31.02 מחזיר 2027-02-31' }, (t) => {
  fixNow(t);
  assert.equal(PD._parseDate('31.02'), null);
  assert.equal(PD._parseDate('31.4.2027'), null);
});

test('labels / sameLabel — אותם עזרים כמו ב-wa-ui', () => {
  assert.equal(PD._label, UI.label);
  assert.equal(PD._labels, UI.labels);
  assert.equal(PD._sameLabel, UI.sameLabel);
});

test('active / pending', () => {
  const u = uid();
  assert.equal(PD.active(u), false);
  put(u, { step: 'items', at: Date.now() });
  assert.equal(PD.active(u), true);
  assert.equal(PD.pending(u), true);
  put(u, { step: 'items', at: Date.now(), paused: true });
  assert.equal(PD.active(u), false);
  assert.equal(PD.pending(u), true);
  put(u, { step: 'items', at: Date.now() - 25 * 60 * 60 * 1000 });
  assert.equal(PD.pending(u), false);
});

test('abandon — עם פריטים: הודעה, והדרישה יורדת', () => {
  const u = uid();
  put(u, { step: 'list', at: Date.now(), items: [{ n: 1 }] });
  assert.match(PD.abandon({ id: u }), /דרישת הרכש שהתחלת לא נשלחה/);
  assert.equal(PD._load(u), null);
});

test('abandon — בלי פריטים או בלי דרישה: בלי הודעה', () => {
  const u = uid();
  put(u, { step: 'items', at: Date.now(), items: [] });
  assert.equal(PD.abandon({ id: u }), '');
  assert.equal(PD._load(u), null);
  assert.equal(PD.abandon({ id: uid() }), '');
});

// ---------------------------------------------------------------------------
// התאמת פריטים לקטלוג (בלי AI)
// ---------------------------------------------------------------------------

const part = (code, des, statdes = 'פעיל') => ({ PARTNAME: code, PARTDES: des, STATDES: statdes, BUD_SUBCHAPTERNAME: '200', BUD_SUBCHAPTERDES: 'שלד', BUD_SUBTOPICNAME: '30-10', BUD_SUBTOPICDES: 'חומרים' });
function mockCatalog(t, { exact = {}, search = {}, general = { chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי' } } = {}) {
  t.mock.method(Priority, 'findPartExact', async (c, d) => exact[d] ?? null);
  t.mock.method(Priority, 'searchParts', async (c, d) => (search[d] ?? []).map((p) => ({ p, score: 1 })));
  t.mock.method(Priority, 'budgetPairs', async () => []);
  return t.mock.method(Priority, 'generalCoding', async () => general);
}

test('resolveItems — זהה בקטלוג: משויך', async (t) => {
  mockCatalog(t, { exact: { 'מלט אפור': part('M-1', 'מלט אפור') } });
  const items = [{ n: 1, description: 'מלט אפור', qty: 3 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].part.code, 'M-1');
  assert.equal(items[0].part.why, 'תיאור זהה בקטלוג');
  assert.equal(items[0].candidates, undefined);
  assert.equal(items[0].exactHit, undefined);
});

test('resolveItems — קרובים: שואלים, עד 3', async (t) => {
  mockCatalog(t, { search: { 'בלוק': [part('B-1', 'בלוק 20'), part('B-2', 'בלוק 10'), part('B-3', 'בלוק 15'), part('B-4', 'בלוק 7')] } });
  const items = [{ n: 1, description: 'בלוק', qty: 100 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'ask');
  assert.deepEqual(items[0].options.map((o) => o.code), ['B-1', 'B-2', 'B-3']);
});

// באג ידוע: ‎exactHit‎ נקבע גם כשהפריט הזהה אינו פעיל, ואז ‎partOf(undefined)‎ נופל (purchase-demand.js, resolveItems)
test('resolveItems — פריט זהה לא פעיל אינו משויך', { todo: 'באג: exactHit לפריט לא פעיל' }, async (t) => {
  mockCatalog(t, { exact: { 'ברז': part('X-1', 'ברז', 'לא פעיל') }, search: { 'ברז': [part('X-1', 'ברז', 'לא פעיל')] } });
  const items = [{ n: 1, description: 'ברז', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'general');
});

test('resolveItems — מועמד לא פעיל מהחיפוש אינו מוצע', async (t) => {
  mockCatalog(t, { search: { 'ברז': [part('X-1', 'ברז ישן', 'לא פעיל'), part('X-2', 'ברז פרח')] } });
  const items = [{ n: 1, description: 'ברז', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'ask');
  assert.deepEqual(items[0].options.map((o) => o.code), ['X-2']);
});

test('resolveItems — לא בקטלוג: מק"ט כללי בקידוד הכללי', async (t) => {
  mockCatalog(t);
  const items = [{ n: 1, description: 'משהו', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'general');
  assert.deepEqual({ ...items[0].part }, { code: '000', des: 'מוצר כללי', chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי', why: 'לא נמצא בקטלוג' });
  assert.equal(items[0].options, null);
});

test('resolveItems — אין קידוד כללי בחברה: GENERAL', async (t) => {
  mockCatalog(t, { general: null });
  const items = [{ n: 1, description: 'משהו', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].part.chapter, Priority.GENERAL.chapter);
  assert.equal(items[0].part.topic, Priority.GENERAL.topic);
});

test('resolveItems — פריוריטי לא זמין: מק"ט כללי', async (t) => {
  for (const fn of ['findPartExact', 'searchParts', 'budgetPairs', 'generalCoding']) t.mock.method(Priority, fn, async () => { throw new Error('down'); });
  const items = [{ n: 1, description: 'משהו', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'general');
  assert.equal(items[0].part.code, '000');
});

test('resolveItems — AI מוחלף: "זהה" לפי הקוד, ותת פרק מהזוגות', async (t) => {
  const Claude = require('../../../server/integrations/claude');
  mockCatalog(t, { search: { 'צבע לבן': [part('C-1', 'צבע סופרקריל לבן'), part('C-2', 'צבע שמן')] , 'שונות': [] } });
  t.mock.method(Priority, 'budgetPairs', async () => [{ chapter: '400', chapterDes: 'גמר', topic: '50-1', topicDes: 'צבע' }]);
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(PD._ai, 'match', async () => ({ results: [
    { line: 1, kind: 'exact', codes: ['C-1'], chapter: '', topic: '', why: 'אותו צבע' },
    { line: 2, kind: 'none', codes: [], chapter: '400', topic: '50-1', why: 'לא בקטלוג' }
  ] }));
  const items = [{ n: 1, description: 'צבע לבן', qty: 2 }, { n: 2, description: 'שונות', qty: 1 }];
  await PD._resolveItems({ company: 'test11' }, items);
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].part.code, 'C-1');
  assert.equal(items[0].part.why, 'אותו צבע');
  assert.equal(items[1].status, 'general');
  assert.equal(items[1].part.chapter, '400');
  assert.equal(items[1].part.topicDes, 'צבע');
});

test('resolveItems — רשימה ריקה: בלי פניות', async (t) => {
  const g = mockCatalog(t);
  await PD._resolveItems({ company: 'test11' }, []);
  assert.equal(g.mock.callCount(), 0);
});
