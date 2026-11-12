'use strict';
/**
 * 🏷️ חותמת GR על המסמך — כשקבלת הסחורה הופכת לסופית, מספר ה-GR נכתב על המסמך המקורי (החשבונית / התעודה),
 * במקום לבן וריק בעמוד הראשון — עדיף בצד שמאל. הוחלט 12.11.26.
 *
 * איפה: ה-AI שקורא את המסמך מחזיר גם אזור ריק (‎blank_area‎ — יחסי 0–1 מהפינה השמאלית העליונה). אין אזור כזה, או
 * שהוא קטן מהחותמת — בפינה השמאלית העליונה. החותמת אטומה (רקע לבן), כך שהיא קריאה גם אם האזור לא ריק לגמרי.
 *
 * PDF — נכתב על העמוד הראשון; JPEG / PNG — נעטף ב-PDF בגודל התמונה, והחותמת מעליו. סוג אחר (HEIC, TIFF) — ‎null‎.
 * הקובץ המקורי לא משתנה; החותמת היא קובץ חדש.
 */
const PdfKit = require('../core').PdfKit;

const BRAND = '#0f766e';
const MARGIN = 0.03;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** האזור הריק (יחסי) ← מלבן ב-PDF (נקודות, ‎y‎ מלמטה). ‎null‎ — אין אזור שימושי */
function areaRect(area, pw, ph) {
  if (!area) return null;
  const x = num(area.x), y = num(area.y), w = num(area.w), h = num(area.h);
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return null;
  return { x: x * pw, y: ph - (y + h) * ph, w: w * pw, h: h * ph };
}

/**
 * איפה החותמת: במרכז האזור הריק כשהוא מספיק גדול; אחרת — הפינה השמאלית העליונה. ‎sw/sh‎ — גודל החותמת.
 */
function place(area, pw, ph, sw, sh) {
  const r = areaRect(area, pw, ph);
  if (r && r.w >= sw && r.h >= sh) return { x: r.x + (r.w - sw) / 2, y: r.y + (r.h - sh) / 2, fromArea: true };
  return { x: pw * MARGIN, y: ph - ph * MARGIN - sh, fromArea: false };
}

async function draw(doc, page, { docno, date }, area) {
  const f = await PdfKit.fonts(doc);
  const { width: pw, height: ph } = page.getSize();
  // החותמת יחסית לעמוד: ~22% מהרוחב, בין 120 ל-220 נקודות
  const sw = Math.max(120, Math.min(220, pw * 0.22));
  const big = sw / 11.5;
  const small = big * 0.55;
  const sh = big + small + big * 1.25;
  const at = place(area, pw, ph, sw, sh);
  PdfKit.roundRect(page, { x: at.x, y: at.y, width: sw, height: sh, radius: 5, color: '#ffffff', borderColor: BRAND, borderWidth: Math.max(1, sw / 120) });
  const cx = at.x + sw / 2;
  const t1 = String(docno);
  page.drawText(t1, { x: cx - f.bold.widthOfTextAtSize(t1, big) / 2, y: at.y + sh - big * 1.25, size: big, font: f.bold, color: PdfKit.color(BRAND) });
  PdfKit.text(page, `נקלט בפריוריטי · ${date}`, { x: cx, y: at.y + small * 0.9, size: small, font: f.regular, color: '#334155', align: 'center' });
  return at;
}

/** תאריך היום בישראל: 12.11.26 */
const today = () => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date()).replace(/\//g, '.');

/**
 * ‎file‎ — ‎{buf, mime}‎ של המסמך המקורי. ‎docno‎ — מספר ה-GR. ‎area‎ — ‎blank_area‎ מהקריאה.
 * מחזיר ‎{buf, mime: 'application/pdf', fileName, fromArea}‎, או ‎null‎ כשאי אפשר (סוג קובץ, PDF מוצפן או פגום).
 */
async function stamp(file, { docno, area = null, date = today() } = {}) {
  if (!file?.buf?.length || !docno) return null;
  const L = PdfKit.L();
  // הסוג לפי התוכן ולא לפי התווית — תמונה מוואטסאפ מגיעה לפעמים כ-"image/jpeg" גם כשהיא PNG
  const b = file.buf;
  const sniff = b.slice(0, 5).toString('latin1') === '%PDF-' ? 'pdf'
    : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg'
      : b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG' ? 'png' : '';
  const mime = sniff || String(file.mime ?? '').toLowerCase();
  let doc;
  let page;
  try {
    if (mime.includes('pdf')) {
      doc = await L.PDFDocument.load(file.buf, { updateMetadata: false });
      page = doc.getPages()[0];
      if (!page) return null;
    } else if (/jpe?g|png/.test(mime)) {
      doc = await L.PDFDocument.create();
      const img = /png/.test(mime) ? await doc.embedPng(file.buf) : await doc.embedJpg(file.buf);
      const scale = Math.min(1, 1440 / Math.max(img.width, img.height));
      page = doc.addPage([img.width * scale, img.height * scale]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * scale, height: img.height * scale });
    } else {
      return null;
    }
    const at = await draw(doc, page, { docno, date }, area);
    return { buf: Buffer.from(await doc.save()), mime: 'application/pdf', fileName: `${docno}-מסמך.pdf`, fromArea: at.fromArea };
  } catch (err) {
    console.error('[משימון] חותמת GR על המסמך נכשלה:', err.message);
    return null;
  }
}

module.exports = { stamp, _place: place, _areaRect: areaRect };
