'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Priority = require('../../../server/priority');
const GR = require('../../../server/ai/goods-receipt');

boot();
let next = 7000;
const uid = () => { next += 1; return next; };
const put = (userId, s) => D.setSetting(`goods_receipt:${userId}`, s);

// ---------------------------------------------------------------------------
// כניסה לזרימה
// ---------------------------------------------------------------------------

test('isTrigger — "קבלת סחורה"', () => {
  assert.ok(GR.isTrigger('קבלת סחורה'));
  assert.ok(GR.isTrigger('צריך לעשות קבלתסחורה'));
  assert.ok(!GR.isTrigger('קבלה'));
  assert.ok(!GR.isTrigger(null));
});

test('isPriority — גם שגיאות כתיב ואנגלית', () => {
  for (const t of ['פריוריטי', 'פריורטי', 'פרויוריטי', 'Priority', 'PRIORITY']) assert.ok(GR.isPriority(t), t);
  assert.ok(!GR.isPriority('עדיפות'));
});

test('opens — טריגר, פריוריטי, או קובץ בלי טקסט', () => {
  assert.ok(GR.opens('קבלת סחורה'));
  assert.ok(GR.opens('פריוריטי'));
  assert.ok(GR.opens('', { url: 'x' }));
  assert.ok(GR.opens('   ', { url: 'x' }));
  assert.ok(!GR.opens('תראה את זה', { url: 'x' }));
  assert.ok(!GR.opens('שלום'));
});

// ---------------------------------------------------------------------------
// מצב השיחה
// ---------------------------------------------------------------------------

test('active / pending — שיחה טרייה', () => {
  const u = uid();
  assert.equal(GR.active(u), false);
  assert.equal(GR.pending(u), false);
  put(u, { step: 'lines', at: Date.now() });
  assert.equal(GR.active(u), true);
  assert.equal(GR.pending(u), true);
});

test('active — מושהית או ישנה מ-20 דקות: לא פעילה, אבל פתוחה', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now(), paused: true });
  assert.equal(GR.active(u), false);
  assert.equal(GR.pending(u), true);
  put(u, { step: 'lines', at: Date.now() - 30 * 60 * 1000 });
  assert.equal(GR.active(u), false);
  assert.equal(GR.pending(u), true);
});

test('pending — אחרי 24 שעות: לא', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now() - 25 * 60 * 60 * 1000 });
  assert.equal(GR.pending(u), false);
});

test('load — בלי שלב: null', () => {
  const u = uid();
  put(u, { at: Date.now() });
  assert.equal(GR._load(u), null);
  put(u, 'x');
  assert.equal(GR._load(u), null);
});

test('clear — מוחק את המצב', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now(), files: [{ path: '/nonexistent/file.jpg' }] });
  GR._clear(u);
  assert.equal(GR._load(u), null);
});

test('inMenu / dropMenu', () => {
  const u = uid();
  put(u, { step: 'menu', at: Date.now() });
  assert.equal(GR.inMenu(u), true);
  GR.dropMenu(u);
  assert.equal(GR.inMenu(u), false);
  assert.equal(GR._load(u), null);
});

test('dropMenu — לא נוגע בשיחה שאינה בתפריט', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now() });
  assert.equal(GR.inMenu(u), false);
  GR.dropMenu(u);
  assert.equal(GR._load(u).step, 'lines');
});

test('pausedNote — תזכורת פעם אחת לשיחה מושהית', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now(), paused: true });
  assert.match(GR.pausedNote(u), /יש לך קבלת סחורה פתוחה/);
  assert.equal(GR.pausedNote(u), '');
});

test('pausedNote — שיחה פעילה או תפריט: בלי תזכורת', () => {
  const u = uid();
  put(u, { step: 'lines', at: Date.now() });
  assert.equal(GR.pausedNote(u), '');
  put(u, { step: 'menu', at: Date.now(), paused: true });
  assert.equal(GR.pausedNote(u), '');
  assert.equal(GR.pausedNote(uid()), '');
});

test('wantsUndoFinal — רק אחרי אישור סופי ב-15 הדקות האחרונות', () => {
  const u = uid();
  assert.equal(GR.wantsUndoFinal(u, '👎'), false);
  D.setSetting(`goods_receipt_done:${u}`, { at: Date.now(), docno: 'GR1' });
  for (const t of ['👎', '👎🏽', '👎👎', 'ביטול', 'ביטול 🗑️', 'בבקשה לבטל', '🗑']) assert.equal(GR.wantsUndoFinal(u, t), true, t);
  for (const t of ['כן', 'לא', 'ביטולים', 'מה לבטל?']) assert.equal(GR.wantsUndoFinal(u, t), false, t);
  D.setSetting(`goods_receipt_done:${u}`, { at: Date.now() - 16 * 60 * 1000 });
  assert.equal(GR.wantsUndoFinal(u, '👎'), false);
});

// ---------------------------------------------------------------------------
// חשבונית מול הזמנה
// ---------------------------------------------------------------------------

const line = (over = {}) => ({ n: 1, description: 'מלט', qty: 100, price: 10, discount: 0, order: { ordname: 'PO1', line: 1, balance: 100, price: 10, pct: 0 }, ...over });

test('orderDiffs — בלי הזמנה: אין הפרשים', () => {
  assert.deepEqual(GR._orderDiffs({ order: null, lines: [line({ qty: 999 })] }), []);
});

test('orderDiffs — תואם: אין הפרשים', () => {
  assert.deepEqual(GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line()] }), []);
});

test('orderDiffs — כמות מעל היתרה', () => {
  const d = GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line({ qty: 120 })] });
  assert.equal(d.length, 1);
  assert.match(d[0], /^\*1\.\* מלט: כמות 120 — ביתרת ההזמנה 100 \(\+20\)$/);
});

test('orderDiffs — מחיר ליחידה שונה ביותר מ-1%', () => {
  const d = GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line({ price: 11, qty: 10 })] });
  assert.equal(d.length, 1);
  assert.match(d[0], /מחיר ליחידה 11\.00 — בהזמנה 10\.00 \(\+1\.00 ליחידה, \+10\.00 בסה"כ\)/);
});

test('orderDiffs — מחיר זול מההזמנה: סימן מינוס', () => {
  const [d] = GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line({ price: 9, qty: 1 })] });
  assert.match(d, /\(\u200e?-1\.00 ליחידה/);
});

test('orderDiffs — עד 1%: לא הפרש', () => {
  assert.deepEqual(GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line({ price: 10.09 })] }), []);
});

test('orderDiffs — משווה מחיר נטו אחרי הנחה', () => {
  const s = { order: { ordname: 'PO1' }, lines: [line({ price: 10, discount: 10, order: { balance: 100, price: 9, pct: 0 } })] };
  assert.deepEqual(GR._orderDiffs(s), []);
  const s2 = { order: { ordname: 'PO1' }, lines: [line({ price: 10, discount: 0, order: { balance: 100, price: 10, pct: 10 } })] };
  assert.equal(GR._orderDiffs(s2).length, 1);
});

test('orderDiffs — שורת זיכוי ושורה בלי הזמנה מדולגות', () => {
  const s = { order: { ordname: 'PO1' }, lines: [line({ qty: -5, price: 10 }), line({ n: 2, order: null, qty: 999 })] };
  assert.deepEqual(GR._orderDiffs(s), []);
});

test('orderDiffs — כמות ומחיר באותה שורה: שני הפרשים', () => {
  assert.equal(GR._orderDiffs({ order: { ordname: 'PO1' }, lines: [line({ qty: 200, price: 20 })] }).length, 2);
});

// ---------------------------------------------------------------------------
// קידוד שורות (מק"ט, תת פרק, משאב) — פריוריטי מוחלף
// ---------------------------------------------------------------------------

const part = (code, des, ch = '200', tp = '30-10') => ({ PARTNAME: code, PARTDES: des, PDES: des, BUD_SUBCHAPTERNAME: ch, BUD_SUBCHAPTERDES: `פרק ${ch}`, BUD_SUBTOPICNAME: tp, BUD_SUBTOPICDES: `משאב ${tp}`, STATDES: 'פעיל' });
function mockPriority(t, { exact = () => null, history = () => [], recent = () => [], general = { chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי' }, byCode = () => null } = {}) {
  return {
    exact: t.mock.method(Priority, 'findPartExact', async (c, d) => exact(d)),
    history: t.mock.method(Priority, 'supplierHistory', async (c, s) => history(c, s)),
    recent: t.mock.method(Priority, 'recentLines', async (c) => recent(c)),
    general: t.mock.method(Priority, 'generalCoding', async () => general),
    byCode: t.mock.method(Priority, 'partByCode', async (c, code) => byCode(c, code))
  };
}
const grState = (company, lines) => ({ company, supplier: { code: 'S1' }, doc: {}, lines });

test('codeLines — תיאור זהה בקטלוג', async (t) => {
  const m = mockPriority(t, { exact: (d) => (d === 'מלט אפור' ? part('M-1', 'מלט אפור') : null) });
  const s = grState('test11', [{ n: 1, description: 'מלט אפור' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, 'M-1');
  assert.equal(s.lines[0].part.chapter, '200');
  assert.equal(s.lines[0].part.why, 'תיאור זהה בקטלוג');
  assert.equal(m.history.mock.callCount(), 0);
});

test('codeLines — שורה מהזמנה אינה מקודדת', async (t) => {
  mockPriority(t);
  const s = grState('test11', [{ n: 1, description: 'x', order: { ordname: 'PO1' } }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part, undefined);
});

test('codeLines — המק"ט שהספק נקלט בו', async (t) => {
  mockPriority(t, { history: () => [part('A-1', 'ברגים 8 מ"מ')] });
  const s = grState('test11', [{ n: 1, description: 'ברגים' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, 'A-1');
  assert.match(s.lines[0].part.why, /כמו בקליטות קודמות של הספק/);
});

test('codeLines — כמה מק"טים: הקרוב ביותר בתיאור', async (t) => {
  mockPriority(t, { history: () => [part('A-1', 'ברגים פלדה'), part('A-1', 'ברגים פלדה'), part('B-2', 'דבק אפוקסי שקוף')] });
  const s = grState('test11', [{ n: 1, description: 'דבק אפוקסי' }, { n: 2, description: 'פטיש' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, 'B-2');
  // אין דמיון — הנפוץ
  assert.equal(s.lines[1].part.code, 'A-1');
});

test('codeLines — ספק בלי היסטוריה: 000 בקידוד שהספק נקלט בו', async (t) => {
  mockPriority(t, { history: () => [part('000', 'מוצר כללי', '305', '40-20')] });
  const s = grState('test11', [{ n: 1, description: 'קורות עץ' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, '000');
  assert.equal(s.lines[0].part.chapter, '305');
  assert.equal(s.lines[0].part.topic, '40-20');
  assert.match(s.lines[0].part.why, /כמו בקליטות קודמות של הספק/);
});

test('codeLines — אין כלום: 000 בקידוד הכללי של החברה', async (t) => {
  mockPriority(t);
  const s = grState('test11', [{ n: 1, description: 'זכוכית מחוסמת' }]);
  await GR._codeLines(s);
  assert.deepEqual({ ...s.lines[0].part }, { code: '000', des: 'מוצר כללי', chapter: '101', chapterDes: 'כללי', topic: '98-10', topicDes: 'כללי', why: 'מק"ט כללי' });
});

test('codeLines — פריוריטי לא זמין: עדיין יש קידוד', async (t) => {
  t.mock.method(Priority, 'findPartExact', async () => { throw new Error('down'); });
  t.mock.method(Priority, 'supplierHistory', async () => { throw new Error('down'); });
  t.mock.method(Priority, 'recentLines', async () => { throw new Error('down'); });
  t.mock.method(Priority, 'generalCoding', async () => { throw new Error('down'); });
  const s = grState('mahala1', [{ n: 1, description: 'שלט פרסום' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, '000');
  assert.equal(s.lines[0].part.chapter, null);
});

test('codeLines — שורה דומה מקליטה קודמת בחברה (אינדקס)', async (t) => {
  mockPriority(t, { recent: (c) => (c === 'denia1' ? [part('K-7', 'כבל חשמל נחושת 2.5')] : []) });
  const s = grState('denia1', [{ n: 1, description: 'כבל חשמל נחושת' }]);
  await GR._codeLines(s);
  assert.equal(s.lines[0].part.code, 'K-7');
  assert.match(s.lines[0].part.why, /לפי שורה דומה בקליטה קודמת/);
});

test('similarLines — לפחות 2 מילים משותפות וחצי מהמילים', async (t) => {
  mockPriority(t, { recent: (c) => (c === 'kedma1' ? [part('T-1', 'צינור פלסטיק 110 מ"מ'), part('T-2', 'צינור ברזל')] : []) });
  const hits = await GR._similarLines('kedma1', 'צינור פלסטיק לביוב');
  assert.deepEqual(hits.map((h) => h.l.PARTNAME), ['T-1']);
  assert.equal(hits[0].sc, 2);
  assert.deepEqual(await GR._similarLines('kedma1', 'צינור'), []);
  assert.deepEqual(await GR._similarLines('kedma1', '110'), []);
});

// ---------------------------------------------------------------------------
// שאלת המק"טים
// ---------------------------------------------------------------------------

const P_A = { code: 'A-1', des: 'ברגים', chapter: '200', chapterDes: 'אינסטלציה', topic: '30-10', topicDes: 'חומרים', why: 'כמו בקליטות קודמות של הספק' };
const P_B = { code: '000', des: 'מוצר כללי', chapter: '101', chapterDes: '', topic: '98-10', topicDes: '', why: 'מק"ט כללי' };

test('askParts — אותו קידוד לכל השורות: שורה אחת', () => {
  const s = { lines: [{ n: 1, description: 'א', part: P_A }, { n: 2, description: 'ב', part: P_A }] };
  const r = GR._askParts(s);
  assert.equal(s.step, 'parts');
  assert.equal(r.replies.length, 1);
  assert.match(r.replies[0], /🏷 כל 2 השורות ← \*A-1 ברגים\* · אינסטלציה \/ חומרים/);
  assert.match(r.replies[0], /\*כן\* 👍/);
  assert.equal(s.lastPrompt, r.replies[0]);
});

test('askParts — קידוד שונה: לכל שורה', () => {
  const s = { lines: [{ n: 1, description: 'ברגים', part: P_A }, { n: 2, description: 'שונות', part: P_B }, { n: 3, description: 'מהזמנה', order: {}, part: P_A }] };
  const t = GR._askParts(s).replies[0];
  assert.match(t, /\*1\.\* ברגים\n   ← \*A-1 ברגים\*/);
  assert.match(t, /\*2\.\* שונות\n   ← \*000 מוצר כללי\* · 101 \/ 98-10 \(מק"ט כללי\)/);
  assert.doesNotMatch(t, /מהזמנה/);
});

test('askParts — שורה אחת', () => {
  const t = GR._askParts({ lines: [{ n: 1, description: 'א', part: P_A }] }).replies[0];
  assert.match(t, /🏷 השורה ←/);
});

// ---------------------------------------------------------------------------
// פרויקטים
// ---------------------------------------------------------------------------

const PROJ = [
  { code: 'P1', des: 'מבואות דרומיים מגרש 207' },
  { code: 'P2', des: 'אלעד סנטר' },
  { code: 'P3', des: 'קדמה נתניה' }
];

test('projectsOf — כינויים מהסקיל', async (t) => {
  t.mock.method(Priority, 'projects', async () => PROJ);
  const list = await GR._projectsOf('test11');
  const p1 = list.find((p) => p.code === 'P1');
  assert.match(p1.alias, /חיפה/);
  assert.match(p1.alias, /sea&cloud/);
  assert.equal(list.find((p) => p.code === 'P2').alias, undefined);
  assert.equal(PROJ[0].alias, undefined, 'לא משנה את הרשימה שהתקבלה');
});

test('findProjects — לפי הקוד, כולל כינוי', async (t) => {
  t.mock.method(Priority, 'projects', async () => PROJ);
  const all = await GR._projectsOf('test11');
  const r = await GR._findProjects(all, 'חיפה');
  assert.equal(r.by, 'code');
  assert.deepEqual(r.list.map((p) => p.code), ['P1']);
});

test('findProjects — לא strict: הטובים ביותר גם בלי כל המילים', async () => {
  const strict = await GR._findProjects(PROJ, 'אלעד ירושלים');
  assert.deepEqual(strict.list, []);
  const loose = await GR._findProjects(PROJ, 'אלעד ירושלים', { strict: false });
  assert.deepEqual(loose.list.map((p) => p.code), ['P2']);
});

test('findProjects — אין התאמה ואין AI: רשימה ריקה', async () => {
  assert.deepEqual(await GR._findProjects(PROJ, 'באר שבע'), { list: [], by: null });
  assert.deepEqual(await GR._findProjects(PROJ, ''), { list: [], by: null });
});

test('findProjects — AI מוחלף: קודים קיימים בלבד, בלי כפילויות', async (t) => {
  const Claude = require('../../../server/ai/claude');
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(GR._ai, 'project', async () => ({ codes: ['P3', 'P3', 'NOPE'], question: '', unrelated: false }));
  const r = await GR._findProjects(PROJ, 'הפרויקט בנתניה הדרומית');
  assert.equal(r.by, 'ai');
  assert.deepEqual(r.list.map((p) => p.code), ['P3']);
});

test('findProjects — AI נכשל: רשימה ריקה', async (t) => {
  const Claude = require('../../../server/ai/claude');
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(GR._ai, 'project', async () => { throw new Error('overloaded'); });
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(await GR._findProjects(PROJ, 'בית שמש'), { list: [], by: null });
});

// ---------------------------------------------------------------------------
// JPEG ← PDF
// ---------------------------------------------------------------------------

function jpeg(w, h, comps = 3) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, comps, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16), Buffer.from([0xff, 0xd9])]);
}

test('jpegToPdf — עמוד בגודל התמונה, התמונה כמו שהיא', () => {
  const img = jpeg(200, 100);
  const pdf = GR._jpegToPdf(img);
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.match(s, /\/MediaBox \[0 0 200 100\]/);
  assert.match(s, /\/Width 200 \/Height 100 \/ColorSpace \/DeviceRGB/);
  assert.match(s, /\/Filter \/DCTDecode/);
  assert.ok(pdf.includes(img));
});

test('jpegToPdf — xref מצביע למקום הנכון', () => {
  const pdf = GR._jpegToPdf(jpeg(50, 60));
  const s = pdf.toString('latin1');
  const at = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(at, at + 4), 'xref');
  const offsets = [...s.slice(at).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

test('jpegToPdf — תמונה גדולה: העמוד מוקטן, התמונה לא', () => {
  const s = GR._jpegToPdf(jpeg(2880, 1440)).toString('latin1');
  assert.match(s, /\/MediaBox \[0 0 1440 720\]/);
  assert.match(s, /\/Width 2880 \/Height 1440/);
});

test('jpegToPdf — אפור ו-CMYK', () => {
  assert.match(GR._jpegToPdf(jpeg(10, 10, 1)).toString('latin1'), /\/DeviceGray/);
  const cmyk = GR._jpegToPdf(jpeg(10, 10, 4)).toString('latin1');
  assert.match(cmyk, /\/DeviceCMYK/);
  assert.match(cmyk, /\/Decode \[1 0 1 0 1 0 1 0\]/);
});

test('jpegToPdf — בלי מידות: null', () => {
  assert.equal(GR._jpegToPdf(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40), Buffer.from([0xff, 0xd9])])), null);
});
