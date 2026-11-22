'use strict';
/**
 * עזרים ל-pdf-lib (‎server/vendor‎) בעברית: גופן Liberation (‎server/fonts‎), כתיבה מימין
 * לשמאל בסדר תצוגה (‎pdf.visual‎), שבירת שורות לפי רוחב, ותמונות (לוגו).
 *
 * למה גם pdf-lib ולא רק ‎pdf.js‎ שלנו: ‎pdf.js‎ יוצר PDF חדש בלבד ובלי תמונות. כאן — מילוי
 * טופס PDF קיים (שדות AcroForm, או כתיבה מעל דף שטוח) ומודעות ומכתבים עם לוגו.
 */
const fs = require('node:fs');
const Paths = require('./paths');
const path = require('node:path');
const { visual } = require('./pdf');

let lib = null;
/** הספרייה נטענת רק כשצריך — 1.3MB שאין טעם לטעון בכל הפעלה */
function L() {
  if (!lib) lib = { ...require('../vendor/pdf-lib.min.js'), fontkit: require('../vendor/fontkit.umd.min.js') };
  return lib;
}

const FONT_DIR = Paths.FONTS;
const fontCache = {};
const fontBytes = (name) => (fontCache[name] ??= fs.readFileSync(path.join(FONT_DIR, name)));

/** הגופנים (רגיל ומודגש) בתוך המסמך */
async function fonts(doc) {
  doc.registerFontkit(L().fontkit);
  return {
    regular: await doc.embedFont(fontBytes('LiberationSans-Regular.ttf'), { subset: true }),
    bold: await doc.embedFont(fontBytes('LiberationSans-Bold.ttf'), { subset: true })
  };
}

/** גופן אחד מ-‎server/fonts‎ לפי שם הקובץ בלי הסיומת ("Heebo-Black") — לעיצוב המודעות */
async function embed(doc, name) {
  doc.registerFontkit(L().fontkit);
  return doc.embedFont(fontBytes(`${name}.ttf`), { subset: true });
}

/** מלבן עם פינות מעוגלות. ‎x, y‎ — הפינה השמאלית התחתונה (כמו ‎drawRectangle‎) */
function roundRect(page, { x, y, width: w, height: h, radius = 10, color: fill = null, borderColor = null, borderWidth = 0 }) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const path = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  page.drawSvgPath(path, { x, y: y + h, ...(fill ? { color: color(fill) } : {}), ...(borderColor ? { borderColor: color(borderColor), borderWidth } : {}) });
}

/** '#1f4e79' ← צבע של pdf-lib */
function color(hex) {
  const h = String(hex ?? '#000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return L().rgb(r, g, b);
}

/** תווים שאין להם צורה בגופן (אימוג'י וכו') — נשמטים, כדי שהכתיבה לא תיכשל */
function clean(font, text) {
  const s = String(text ?? '').replace(/[‎‏‪-‮]/g, '');
  const cps = font.getCharacterSet?.();
  if (!cps) return s;
  const set = new Set(cps);
  return [...s].filter((c) => c === ' ' || set.has(c.codePointAt(0))).join('').replace(/\s{2,}/g, ' ');
}

const width = (font, text, size) => font.widthOfTextAtSize(text, size);

/** שבירה לשורות (בסדר לוגי) לפי רוחב, ואחר כך כל שורה לסדר תצוגה */
function wrap(font, text, size, maxWidth) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = clean(font, para).split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && width(font, visual(next), size) > maxWidth) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/*
 * fontkit (בתוך pdf-lib) הופך בעצמו קטע שהוא מזהה כעברית — אבל את כל המחרוזת, כולל
 * מספרים ולועזית שבתוכה ("15.12" ← "21.51"). לכן: הסדר לתצוגה נקבע אצלנו (‎visual‎),
 * השורה מתחלקת לקטעים עבריים ולועזיים, וכל קטע עברי נשלח הפוך — fontkit מחזיר אותו.
 */
const HEB = /[\u0590-\u05FF]/;
const segments = (v) => v.split(/([^\u0590-\u05FF]*[A-Za-z0-9\u00C0-\u024F][^\u0590-\u05FF]*)/).filter(Boolean);

/** שורה בסדר תצוגה — קטע אחר קטע משמאל לימין */
function drawVisual(page, v, { x, y, size, font, color: c }) {
  let left = x;
  for (const seg of segments(v)) {
    const out = HEB.test(seg) ? [...seg].reverse().join('') : seg;
    page.drawText(out, { x: left, y, size, font, color: color(c) });
    left += width(font, seg, size);
  }
}

/**
 * טקסט בשורה אחת. ‎align‎: right (ברירת מחדל בעברית) / center / left. ‎x‎ — הקצה לפי היישור.
 * ‎y‎ — קו הבסיס, ממטה (כמו ב-pdf-lib).
 */
function text(page, str, { x, y, size = 12, font, color: c = '#1a1a1a', align = 'right' }) {
  const v = visual(clean(font, str));
  const w = width(font, v, size);
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  drawVisual(page, v, { x: left, y, size, font, color: c });
  return w;
}

/** הטקסט כפי שצריך לתת אותו לשדה טופס (AcroForm) — אותו היפוך לפי קטעים, בשורה אחת */
function fieldText(font, str) {
  const v = visual(clean(font, str));
  return segments(v).map((seg) => (HEB.test(seg) ? [...seg].reverse().join('') : seg)).join('');
}

/** פסקה עם שבירת שורות. מחזיר את ה-y שאחרי השורה האחרונה */
function paragraph(page, str, { x, y, size = 12, font, color: c, align = 'right', maxWidth, lineHeight = 1.45 }) {
  let yy = y;
  for (const line of wrap(font, str, size, maxWidth)) {
    if (line) text(page, line, { x, y: yy, size, font, color: c, align });
    yy -= size * lineHeight;
  }
  return yy;
}

/** תמונה (PNG / JPEG) לפי הבתים הראשונים. לא נתמך — ‎null‎ */
async function image(doc, buf) {
  if (!buf?.length) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return await doc.embedPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return await doc.embedJpg(buf);
  } catch { /* קובץ פגום */ }
  return null;
}

module.exports = { L, fonts, embed, roundRect, color, clean, wrap, width, text, paragraph, image, visual, fieldText, drawVisual };
