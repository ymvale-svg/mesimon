'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../../server/ai/task-match');
const { boot, D, mkTask } = require('./fixtures');
const Dupes = require('../../../server/ai/task-dupes');

const sim = (a, b) => M.similarity(typeof a === 'string' ? { title: a } : a, typeof b === 'string' ? { title: b } : b);

// ---------------------------------------------------------------------------
// stem / tokens
// ---------------------------------------------------------------------------

test('stem — אותיות שימוש בתחילת מילה', () => {
  assert.equal(M.stem('הבטון'), M.stem('בטון'));
  assert.equal(M.stem('והטופס'), M.stem('טופס'));
  assert.equal(M.stem('לפרויקט'), M.stem('פרויקט'));
});

test('stem — רבים, כתיב מלא וחסר ואותיות סופיות', () => {
  assert.equal(M.stem('תוכניות'), M.stem('תכנית'));
  assert.equal(M.stem('הזמנת'), M.stem('הזמין'));
  assert.equal(M.stem('ספרים'), M.stem('ספרימ'));
});

test('stem — ניקוד וגרשיים יורדים', () => {
  assert.equal(M.stem('שָׁלוֹם'), M.stem('שלום'));
  assert.equal(M.stem('מע"מ'), M.stem('מעמ'));
});

test('stem — מילה לועזית ומספר לא משתנים', () => {
  assert.equal(M.stem('zoom'), 'zoom');
  assert.equal(M.stem('2026'), '2026');
});

test('tokens — מילות עצירה יורדות, מספרים נשמרים', () => {
  const t = M.tokens('בבקשה לבדוק את הטופס של שלב 2 היום');
  assert.ok(t.has(M.stem('טופס')));
  assert.ok(t.has('2'));
  for (const w of ['בבקשה', 'לבדוק', 'את', 'של', 'היום']) assert.ok(!t.has(w), w);
});

test('tokens — אנגלית באותיות קטנות, Re/Fwd יורדים', () => {
  assert.deepEqual([...M.tokens('Re: Fwd: Invoice')], ['invoice']);
});

test('tokens — קלט ריק', () => {
  assert.equal(M.tokens('').size, 0);
  assert.equal(M.tokens(null).size, 0);
  assert.equal(M.tokens(undefined).size, 0);
});

test('tokens — אות בודדת לא נספרת, ספרה בודדת כן', () => {
  const t = M.tokens('x 7');
  assert.ok(!t.has('x'));
  assert.ok(t.has('7'));
});

test('shared — ספירת החיתוך', () => {
  assert.equal(M.shared(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd'])), 2);
  assert.equal(M.shared(new Set(), new Set(['a'])), 0);
});

test('STOP — מכיל מילות מילוי נפוצות', () => {
  for (const w of ['של', 'משימה', 'דחוף', 'the']) assert.ok(M.STOP.has(w), w);
});

// ---------------------------------------------------------------------------
// similarity
// ---------------------------------------------------------------------------

test('similarity — אותה כותרת: 1', () => {
  assert.equal(sim('הזמנת בטון לאתר אלעד', 'הזמנת בטון לאתר אלעד'), 1);
});

test('similarity — כותרת ריקה או רק מילות עצירה: 0', () => {
  assert.equal(sim('', 'הזמנת בטון'), 0);
  assert.equal(sim('של את עם', 'הזמנת בטון'), 0);
});

test('similarity — סימטרית', () => {
  const a = { title: 'חידוש ביטוח רכב', description: 'פוליסה של הרכב הצמוד' };
  const b = { title: 'ביטוח לרכב החברה', description: 'לחדש עד סוף החודש' };
  assert.equal(sim(a, b), sim(b, a));
});

test('similarity — מספרים שונים מורידים את הציון', () => {
  assert.ok(sim('הזמנת בטון לשלב 2', 'הזמנת בטון לשלב 3') < sim('הזמנת בטון לשלב 2', 'הזמנת בטון לשלב 2'));
  assert.ok(sim('הזמנת בטון לשלב 2', 'הזמנת בטון לשלב 3') < Dupes.HEURISTIC_MIN);
});

test('similarity — אותו פרויקט מעלה, פרויקט אחר מוריד', () => {
  const base = sim({ title: 'בטון לשלב ב' }, { title: 'בטון יציקה' });
  const same = sim({ title: 'בטון לשלב ב', projectId: 1 }, { title: 'בטון יציקה', projectId: 1 });
  const diff = sim({ title: 'בטון לשלב ב', projectId: 1 }, { title: 'בטון יציקה', projectId: 2 });
  assert.ok(same > base);
  assert.ok(diff < base);
});

test('similarity — תמיד בין 0 ל-1', () => {
  const pairs = [['א ב ג', 'ד ה ו'], ['בטון 1', 'בטון 2'], ['מס הכנסה', 'מס הכנסה']];
  for (const [a, b] of pairs) {
    for (const p of [undefined, 1, 2]) {
      const s = sim({ title: a, projectId: p }, { title: b, projectId: p === 2 ? 1 : p });
      assert.ok(s >= 0 && s <= 1, `${a}/${b}: ${s}`);
    }
  }
});

test('similarity — שונות לגמרי: 0', () => {
  assert.equal(sim('חידוש ביטוח רכב', 'הזמנת בטון לאלעד'), 0);
});

// ---------------------------------------------------------------------------
// task-dupes — החלקים הטהורים
// ---------------------------------------------------------------------------

test('pairKey — סדר קבוע', () => {
  assert.equal(Dupes.pairKey(7, 3), 'merge:3:7');
  assert.equal(Dupes.pairKey(3, 7), 'merge:3:7');
});

test('ספים — סינון מוקדם נמוך מהסף בלי AI', () => {
  assert.ok(Dupes.PREFILTER < Dupes.HEURISTIC_MIN);
  assert.ok(Dupes.HEURISTIC_MIN <= 1);
});

test('sanitizeJudgement — רק זוגות קיימים ורק same=true', () => {
  const { sanitizeJudgement } = Dupes._internal;
  const out = sanitizeJudgement({
    pairs: [
      { pair: 1, same: true }, { pair: 2, same: false }, { pair: 3, same: 'true' },
      { pair: 0, same: true }, { pair: 5, same: true }, { pair: 1.5, same: true }, { pair: '4', same: true }
    ]
  }, 4);
  assert.deepEqual([...out].sort(), [1, 4]);
  assert.equal(sanitizeJudgement(null, 3).size, 0);
  assert.equal(sanitizeJudgement({ pairs: 'x' }, 3).size, 0);
});

test('related — אב ובן, תלות ומופעים חוזרים', () => {
  const { related } = Dupes._internal;
  assert.ok(related({ id: 1 }, { id: 2, parent_task_id: 1 }));
  assert.ok(related({ id: 1, depends_on_task_id: 2 }, { id: 2 }));
  assert.ok(related({ id: 1, recurrence_parent: 9 }, { id: 2, recurrence_parent: 9 }));
  assert.ok(related({ id: 1 }, { id: 2, recurrence_parent: 1 }));
  assert.ok(!related({ id: 1 }, { id: 2 }));
  assert.ok(!related({ id: 1, recurrence_parent: null }, { id: 2, recurrence_parent: null }));
});

test('order — הוותיקה קודם, ובשוויון המזהה הקטן', () => {
  const { order } = Dupes._internal;
  const a = { id: 5, created_at: '2026-01-01' };
  const b = { id: 3, created_at: '2026-02-01' };
  assert.deepEqual(order(a, b), [a, b]);
  assert.deepEqual(order(b, a), [a, b]);
  const c = { id: 9, created_at: '2026-01-01' };
  assert.deepEqual(order(c, a), [a, c]);
});

test('candidates — מסנן את עצמה, קשורות ונמוכות, וממיין', () => {
  const { candidates } = Dupes._internal;
  const target = { id: 1, title: 'הזמנת בטון לאתר אלעד' };
  const pool = [
    target,
    { id: 2, title: 'הזמנת בטון לאתר אלעד' },
    { id: 3, title: 'הזמנת בטון לאתר אלעד', parent_task_id: 1 },
    { id: 4, title: 'חידוש ביטוח רכב' },
    { id: 5, title: 'בטון לאלעד' }
  ];
  const out = candidates(target, pool);
  assert.equal(out[0].task.id, 2);
  assert.equal(out[0].score, 1);
  assert.ok(!out.some((x) => [1, 3, 4].includes(x.task.id)));
  assert.ok(out.every((x, i) => i === 0 || out[i - 1].score >= x.score));
  assert.equal(candidates(target, pool, { limit: 1 }).length, 1);
});

test('departmentPairs — זוגות מעל הסף, עם דילוג', () => {
  const { departmentPairs } = Dupes._internal;
  const tasks = [
    { id: 1, title: 'הזמנת בטון לאתר אלעד' },
    { id: 2, title: 'הזמנת בטון לאתר אלעד' },
    { id: 3, title: 'חידוש ביטוח רכב' }
  ];
  const out = departmentPairs(tasks);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].a.id, out[0].b.id], [1, 2]);
  assert.equal(departmentPairs(tasks, { skip: () => true }).length, 0);
  assert.equal(departmentPairs([]).length, 0);
});

test('judge — בלי AI: לפי הסף הגבוה', async () => {
  const { judge } = Dupes._internal;
  assert.deepEqual(await judge([]), []);
  const hi = { a: { id: 1, title: 'x' }, b: { id: 2, title: 'x' }, score: 0.9 };
  const lo = { a: { id: 1, title: 'x' }, b: { id: 3, title: 'y' }, score: 0.5 };
  assert.deepEqual(await judge([hi, lo]), [hi]);
});

test('decision — אין החלטה לזוג חדש', () => {
  boot();
  const a = mkTask();
  const b = mkTask();
  assert.equal(Dupes.decision(a.id, b.id), null);
  D.run("INSERT INTO task_pair_decisions (task_a, task_b, decision, decided_at) VALUES (?,?,'not_duplicate',?)", a.id, b.id, D.nowIso());
  assert.equal(Dupes.decision(b.id, a.id), 'not_duplicate');
});
