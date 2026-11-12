'use strict';
/**
 * 🏷️ חותמת GR על המסמך (‎server/priority/gr-stamp.js‎): PDF קיים ותמונה ← PDF עם המספר, במקום הריק שה-AI מצא
 * (או בפינה השמאלית העליונה), וסוג שאי אפשר — בלי חותמת ובלי לקרוס.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const PdfKit = require('../../../server/core').PdfKit;
const GrStamp = require('../../../server/priority/gr-stamp');
const { png } = require('../../helpers/png');

const textOf = async (buf) => {
  const doc = await PdfKit.L().PDFDocument.load(buf);
  return { pages: doc.getPageCount(), size: doc.getPages()[0].getSize() };
};

test('PDF קיים — החותמת נכתבת על העמוד הראשון, והמסמך נשאר באותו מספר עמודים', async () => {
  const L = PdfKit.L();
  const src = await L.PDFDocument.create();
  src.addPage([595, 842]); src.addPage([595, 842]);
  const buf = Buffer.from(await src.save());
  const out = await GrStamp.stamp({ buf, mime: 'application/pdf' }, { docno: 'GR26000123', area: { x: 0.04, y: 0.05, w: 0.35, h: 0.12 }, date: '12.11.26' });
  assert.equal(out.mime, 'application/pdf');
  assert.equal(out.fileName, 'GR26000123-מסמך.pdf');
  assert.equal(out.fromArea, true);
  assert.ok(out.buf.length > buf.length);
  assert.deepEqual(await textOf(out.buf), { pages: 2, size: { width: 595, height: 842 } });
  assert.ok(out.buf.toString('latin1').includes('GR26000123') || out.buf.length > buf.length + 1000, 'נכתב תוכן');
});

test('תמונה PNG — נעטפת ב-PDF בגודל התמונה, עם החותמת', async () => {
  const out = await GrStamp.stamp({ buf: png(300, 400), mime: 'image/png' }, { docno: 'GR26000124' });
  assert.equal(out.mime, 'application/pdf');
  assert.deepEqual((await textOf(out.buf)).size, { width: 300, height: 400 });
  assert.equal(out.fromArea, false, 'בלי אזור — לפינה');
});

test('סוג שאי אפשר, קובץ פגום או בלי מספר — null, בלי לקרוס', async () => {
  assert.equal(await GrStamp.stamp({ buf: Buffer.from('x'), mime: 'image/heic' }, { docno: 'GR1' }), null);
  assert.equal(await GrStamp.stamp({ buf: Buffer.from('fake image'), mime: 'image/jpeg' }, { docno: 'GR1' }), null);
  assert.equal(await GrStamp.stamp({ buf: Buffer.from('%PDF-broken'), mime: 'application/pdf' }, { docno: 'GR1' }), null);
  assert.equal(await GrStamp.stamp({ buf: png(), mime: 'image/png' }, { docno: '' }), null);
});

test('מיקום: במרכז האזור הריק כשהוא מספיק גדול; קטן, לא תקין או חסר — הפינה השמאלית העליונה', () => {
  const big = GrStamp._place({ x: 0.05, y: 0.1, w: 0.4, h: 0.15 }, 600, 800, 130, 40);
  assert.equal(big.fromArea, true);
  assert.equal(Math.round(big.x), Math.round(0.05 * 600 + (0.4 * 600 - 130) / 2));
  const top = 800 - (0.1 + 0.15) * 800;
  assert.equal(Math.round(big.y), Math.round(top + (0.15 * 800 - 40) / 2), 'y מלמטה (PDF), מתורגם מלמעלה');
  for (const a of [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0.1, y: 0.1, w: 0.05, h: 0.02 }, { x: 0.9, y: 0.1, w: 0.4, h: 0.2 }, null]) {
    const p = GrStamp._place(a, 600, 800, 130, 40);
    assert.equal(p.fromArea, false, JSON.stringify(a));
    assert.equal(Math.round(p.x), 18);
    assert.equal(Math.round(p.y), Math.round(800 - 24 - 40));
  }
});

test('הסוג לפי התוכן: PNG שמסומן כ-JPEG (כך מגיע לפעמים מוואטסאפ) — נחתם', async () => {
  const out = await GrStamp.stamp({ buf: png(), mime: 'image/jpeg' }, { docno: 'GR26000125' });
  assert.equal(out?.mime, 'application/pdf');
});
