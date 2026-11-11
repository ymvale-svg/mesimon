'use strict';
/**
 * 🎨 מנוע העיצוב של המודעות — לפי הסקיל ui-ux-pro-max (‎server/ai/design‎, MIT; הוחלט 10.11.26, ישראל).
 *
 * מה לוקחים מהסקיל:
 *   • פלטות צבע לפי סוג העסק / האירוע (‎palettes.json‎ — 192, מ-‎colors.csv‎): ראשי, משני, הדגשה, רקע, טקסט, מושתק, גבול.
 *   • סגנונות שמתאימים לדפוס (‎styles.json‎): Swiss, Minimal & Direct, Exaggerated Minimalism, Editorial, Bold Typography…
 *   • צימודי גופנים — מותאמים לגופנים העבריים שבמערכת (Heebo, Frank Ruhl Libre, Rubik; ‎server/fonts‎, OFL).
 *   • הכללים: היררכיה בגודל, משקל וריווח — לא בצבע לבד; ניגודיות 4.5:1 לטקסט; ריווח בכפולות של 8; שורה 1.5–1.75
 *     לגוף; לכל היותר שני גופנים; הדגשה אחת; רווח לבן מכוון שמקבץ ומפריד.
 *
 * ה-AI (ב-‎notice.js‎) בוחר פלטה, פריסה וצימוד גופנים; כאן — הציור, בפריסות קבועות ומדויקות:
 *   swiss     — מינימלי: כותרת ענקית לימין, פס הדגשה קצר, פרטים בטבלה עם קווים דקים.
 *   editorial — מינימלי אלגנטי: הכול במרכז, כותרת סריפית, קישוטי קו.
 *   hero      — מעוצב: חצי עליון בצבע הראשי עם הכותרת, כרטיסי פרטים, כפתור קריאה לפעולה.
 *   card      — מעוצב / חגיגי: רקע בגוון, כרטיס לבן מעוגל במרכז, תאריך ושעה בולטים.
 * הדף תמיד מלא ומאוזן: התוכן נמדד, מוגדל עד שהוא ממלא את הדף, וממורכז אנכית.
 */
const fs = require('node:fs');
const path = require('node:path');
const K = require('../core').PdfKit;
const Paths = require('../core').Paths;
const PALETTES = JSON.parse(fs.readFileSync(path.join(Paths.DESIGN, 'palettes.json'), 'utf8'));
const STYLES = JSON.parse(fs.readFileSync(path.join(Paths.DESIGN, 'styles.json'), 'utf8'));

const A4 = [595.28, 841.89];
const LAYOUTS = ['swiss', 'editorial', 'hero', 'card'];
const TYPE_PAIRS = {
  modern: { head: 'Heebo-Black', sub: 'Heebo-Bold', body: 'Heebo-Regular', bold: 'Heebo-Bold', note: 'Heebo — סנס מודרני ונקי (Minimal Swiss / Corporate Trust)' },
  elegant: { head: 'FrankRuhlLibre-Bold', sub: 'FrankRuhlLibre-Regular', body: 'Heebo-Regular', bold: 'Heebo-Bold', note: 'Frank Ruhl Libre לכותרות + Heebo לגוף (Editorial Classic / Luxury Serif)' },
  friendly: { head: 'Rubik-ExtraBold', sub: 'Rubik-Medium', body: 'Heebo-Regular', bold: 'Heebo-Bold', note: 'Rubik מעוגל + Heebo (Friendly / Playful — אירועים, גיבוש)' }
};

/** פלטות שרלוונטיות לחברת בנייה ונדל"ן ולאירועים — לבחירה של ה-AI (לא כל 192) */
const RELEVANT = /real estate|construction|architect|interior|government|public|event|wedding|corporate|consult|legal|finance|bank|insurance|nonprofit|charity|community|education|hospitality|hotel|restaurant|food|sport|fitness|luxury|holiday|celebrat|conference|museum|church|religious|kids|family|health/i;
function paletteOptions() {
  return PALETTES.filter((p) => RELEVANT.test(p.name)).map((p) => ({ name: p.name, notes: p.notes }));
}

/** פלטת המותג — מהצבע של החברה (‎notice_color‎), בתבנית של פלטה מהסקיל */
function brandPalette(hex) {
  const base = PALETTES.find((p) => /Construction\/Architecture/.test(p.name)) ?? PALETTES[0];
  return { ...base, name: 'מותג', primary: hex, onPrimary: '#FFFFFF', secondary: hex, background: '#F6F8FB', foreground: '#14213D', mutedForeground: '#4B5563', border: '#E2E8F0', card: '#FFFFFF', muted: '#EEF2F7' };
}

function paletteOf(name, brandHex) {
  if (!name || name === 'brand') return brandPalette(brandHex);
  return PALETTES.find((p) => p.name === name) ?? PALETTES.find((p) => p.name.toLowerCase().includes(String(name).toLowerCase())) ?? brandPalette(brandHex);
}

// ---------------------------------------------------------------------------
// כלים
// ---------------------------------------------------------------------------

const lines = (font, s, size, maxW) => K.wrap(font, s, size, maxW).filter((l, i, a) => l || (i > 0 && i < a.length - 1));

/** גודל כותרת שנכנס בשלוש שורות לכל היותר */
function fitSize(font, text, start, min, maxW, maxLines = 3) {
  let size = start;
  while (size > min && lines(font, text, size, maxW).length > maxLines) size -= 2;
  return size;
}

/** פסקה ממורכזת / לימין. מחזיר את הגובה. ‎draw=false‎ — רק מדידה */
function para(page, f, s, { x, y, size, maxW, align = 'right', c, lh = 1.6, draw = true }) {
  const ls = lines(f, s, size, maxW);
  if (draw) ls.forEach((l, i) => l && K.text(page, l, { x, y: y - size - i * size * lh, size, font: f, color: c, align }));
  return ls.length ? (ls.length - 1) * size * lh + size : 0;
}

// ---------------------------------------------------------------------------
// הפריסות. כל פריסה מקבלת ‎scale‎ ו-‎draw‎: ‎draw=false‎ מחזיר את גובה התוכן — כך מגדילים ומאזנים
// ---------------------------------------------------------------------------

function swiss(page, F, P, c, logo, { scale, draw, top, bottom }) {
  const [W] = A4;
  const M = 64;
  const R = W - M;
  const maxW = W - 2 * M;
  let y = top;
  const s = (n) => n * scale;
  // פס הדגשה קצר מעל הכותרת
  if (draw) page.drawRectangle({ x: R - 56, y: y - 8, width: 56, height: 8, color: K.color(P.primary) });
  y -= 8 + s(28);
  const tSize = fitSize(F.head, c.title, s(56) * c.title_scale, 30, maxW);
  y -= para(page, F.head, c.title, { x: R, y, size: tSize, maxW, c: P.foreground, lh: 1.12, draw }) + s(16);
  if (c.subtitle) y -= para(page, F.sub, c.subtitle, { x: R, y, size: s(20), maxW, c: P.mutedForeground, lh: 1.3, draw }) + s(32);
  for (const b of c.body ?? []) y -= para(page, F.body, b, { x: R, y, size: s(15), maxW, c: P.foreground, lh: 1.65, draw }) + s(16);
  if ((c.details ?? []).length) {
    y -= s(16);
    for (const d of c.details.slice(0, 6)) {
      if (draw) page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.8, color: K.color(P.border) });
      y -= s(14);
      if (draw) K.text(page, d.label, { x: R, y: y - s(12), size: s(12), font: F.bold, color: P.primary });
      y -= s(12) + s(6);
      y -= para(page, F.sub, d.value, { x: R, y, size: s(19), maxW, c: P.foreground, lh: 1.3, draw }) + s(14);
    }
    if (draw) page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.8, color: K.color(P.border) });
    y -= s(24);
  }
  if (c.highlight) {
    const h = para(page, F.sub, c.highlight, { x: R - 16, y: y - 4, size: s(18), maxW: maxW - 16, c: P.primary, lh: 1.3, draw: false }) + 8;
    if (draw) { page.drawRectangle({ x: R - 4, y: y - h, width: 4, height: h, color: K.color(P.accent) }); para(page, F.sub, c.highlight, { x: R - 16, y: y - 4, size: s(18), maxW: maxW - 16, c: P.primary, lh: 1.3 }); }
    y -= h + s(8);
  }
  // כותרת תחתונה: קו, לוגו קטן משמאל, טקסט מימין
  if (draw) {
    page.drawLine({ start: { x: M, y: bottom + 40 }, end: { x: R, y: bottom + 40 }, thickness: 0.8, color: K.color(P.border) });
    if (logo) { const k = Math.min(110 / logo.width, 30 / logo.height); page.drawImage(logo, { x: M, y: bottom, width: logo.width * k, height: logo.height * k }); }
    if (c.footer) K.text(page, c.footer, { x: R, y: bottom + 10, size: 10, font: F.body, color: P.mutedForeground });
  }
  return top - y;
}

function editorial(page, F, P, c, logo, { scale, draw, top, bottom }) {
  const [W] = A4;
  const mid = W / 2;
  const maxW = W - 2 * 84;
  let y = top;
  const s = (n) => n * scale;
  const rule = (yy, w = 60) => draw && page.drawLine({ start: { x: mid - w, y: yy }, end: { x: mid + w, y: yy }, thickness: 1, color: K.color(P.primary) });
  if (logo) {
    const k = Math.min(170 / logo.width, s(64) / logo.height);
    if (draw) page.drawImage(logo, { x: mid - (logo.width * k) / 2, y: y - logo.height * k, width: logo.width * k, height: logo.height * k });
    y -= logo.height * k + s(36);
  }
  rule(y); rule(y - 4, 30); y -= s(36);
  const tSize = fitSize(F.head, c.title, s(50) * c.title_scale, 28, maxW);
  y -= para(page, F.head, c.title, { x: mid, y, size: tSize, maxW, align: 'center', c: P.foreground, lh: 1.15, draw }) + s(14);
  if (c.subtitle) y -= para(page, F.sub, c.subtitle, { x: mid, y, size: s(19), maxW, align: 'center', c: P.mutedForeground, lh: 1.35, draw }) + s(28);
  rule(y, 30); y -= s(32);
  for (const b of c.body ?? []) y -= para(page, F.body, b, { x: mid, y, size: s(15), maxW, align: 'center', c: P.foreground, lh: 1.7, draw }) + s(14);
  if ((c.details ?? []).length) {
    y -= s(12);
    for (const d of c.details.slice(0, 6)) {
      if (draw) K.text(page, d.label, { x: mid, y: y - s(11), size: s(11), font: F.bold, color: P.primary, align: 'center' });
      y -= s(11) + s(6);
      y -= para(page, F.sub, d.value, { x: mid, y, size: s(18), maxW, align: 'center', c: P.foreground, lh: 1.3, draw }) + s(18);
    }
  }
  if (c.highlight) { y -= s(8); y -= para(page, F.head, c.highlight, { x: mid, y, size: s(18), maxW, align: 'center', c: P.primary, lh: 1.3, draw }) + s(18); }
  rule(y); rule(y - 4, 30);
  y -= s(12);
  if (draw && c.footer) K.text(page, c.footer, { x: mid, y: bottom + 6, size: 10, font: F.body, color: P.mutedForeground, align: 'center' });
  return top - y;
}

function hero(page, F, P, c, logo, { scale, draw, top, bottom, bandH }) {
  const [W, H] = A4;
  const M = 56;
  const R = W - M;
  const maxW = W - 2 * M;
  const s = (n) => n * scale;
  // החלק העליון — צבע ראשי, הכותרת בלבן
  const band = bandH ?? H * 0.42;
  if (draw) {
    page.drawRectangle({ x: 0, y: H - band, width: W, height: band, color: K.color(P.primary) });
    page.drawRectangle({ x: R - 64, y: H - band + 36, width: 64, height: 6, color: K.color(P.accent) });
  }
  let ty = H - band + 56;
  // מלמטה למעלה בתוך הפס: כותרת משנה, ומעליה הכותרת
  const tSize = fitSize(F.head, c.title, 54 * c.title_scale, 30, maxW);
  const tH = para(page, F.head, c.title, { x: R, y: 0, size: tSize, maxW, c: P.onPrimary, lh: 1.1, draw: false });
  const sH = c.subtitle ? para(page, F.sub, c.subtitle, { x: R, y: 0, size: 18, maxW, c: P.onPrimary, lh: 1.3, draw: false }) : 0;
  if (draw) {
    if (c.subtitle) para(page, F.sub, c.subtitle, { x: R, y: ty + sH, size: 18, maxW, c: P.onPrimary, lh: 1.3 });
    para(page, F.head, c.title, { x: R, y: ty + sH + (sH ? 14 : 0) + tH, size: tSize, maxW, c: P.onPrimary, lh: 1.1 });
  }
  ty += sH + tH;
  // מתחת לפס
  let y = top;
  for (const b of c.body ?? []) y -= para(page, F.body, b, { x: R, y, size: s(15), maxW, c: P.foreground, lh: 1.65, draw }) + s(14);
  const det = (c.details ?? []).slice(0, 6);
  if (det.length) {
    y -= s(10);
    // ערכים קצרים — כרטיסים זה לצד זה; ארוכים — כרטיס ברוחב מלא לכל פרט (לא דוחסים)
    const short = det.every((d) => String(d.value).length <= 22);
    const cols = !short ? 1 : det.length <= 3 ? det.length : 2;
    const gap = 12;
    const cw = (maxW - gap * (cols - 1)) / cols;
    const rows = Math.ceil(det.length / cols);
    for (let r = 0; r < rows; r++) {
      const row = det.slice(r * cols, r * cols + cols);
      const ch = Math.max(...row.map((d) => s(12) + 8 + para(page, F.sub, d.value, { x: 0, y: 0, size: s(17), maxW: cw - 28, draw: false }))) + 32;
      row.forEach((d, i) => {
        const x = R - (i + 1) * cw - i * gap;
        if (draw) {
          K.roundRect(page, { x, y: y - ch, width: cw, height: ch, radius: 12, color: P.card ?? '#FFFFFF', borderColor: P.border, borderWidth: 1 });
          page.drawRectangle({ x: x + cw - 4, y: y - ch + 14, width: 4, height: ch - 28, color: K.color(P.primary) });
          K.text(page, d.label, { x: x + cw - 18, y: y - 16 - s(12), size: s(12), font: F.bold, color: P.mutedForeground });
          para(page, F.sub, d.value, { x: x + cw - 18, y: y - 16 - s(12) - 8, size: s(17), maxW: cw - 28, c: P.foreground, lh: 1.3 });
        }
      });
      y -= ch + gap;
    }
    y -= s(12);
  }
  if (c.highlight) {
    const hs = s(17);
    const ls2 = lines(F.sub, c.highlight, hs, maxW - 60);
    const ph = ls2.length * hs * 1.3 + 26;
    const pw = Math.min(maxW, Math.max(...ls2.map((l) => K.width(F.sub, K.visual(l), hs))) + 56);
    if (draw) {
      K.roundRect(page, { x: W / 2 - pw / 2, y: y - ph, width: pw, height: ph, radius: ph / 2, color: P.accent });
      ls2.forEach((l, i) => K.text(page, l, { x: W / 2, y: y - 13 - hs - i * hs * 1.3 + 3, size: hs, font: F.sub, color: P.onAccent, align: 'center' }));
    }
    y -= ph + s(16);
  }
  if (draw) {
    page.drawLine({ start: { x: M, y: bottom + 40 }, end: { x: R, y: bottom + 40 }, thickness: 0.8, color: K.color(P.border) });
    if (logo) { const k = Math.min(110 / logo.width, 30 / logo.height); page.drawImage(logo, { x: M, y: bottom, width: logo.width * k, height: logo.height * k }); }
    if (c.footer) K.text(page, c.footer, { x: R, y: bottom + 10, size: 10, font: F.body, color: P.mutedForeground });
  }
  return top - y;
}

function card(page, F, P, c, logo, { scale, draw, top, bottom }) {
  const [W, H] = A4;
  const CX = 48;
  const CW = W - 2 * CX;
  const mid = W / 2;
  const maxW = CW - 72;
  const s = (n) => n * scale;
  let y = top - 28;
  if (logo) {
    const k = Math.min(160 / logo.width, s(58) / logo.height);
    if (draw) page.drawImage(logo, { x: mid - (logo.width * k) / 2, y: y - logo.height * k, width: logo.width * k, height: logo.height * k });
    y -= logo.height * k + s(28);
  }
  const tSize = fitSize(F.head, c.title, s(50) * c.title_scale, 28, maxW);
  y -= para(page, F.head, c.title, { x: mid, y, size: tSize, maxW, align: 'center', c: P.primary, lh: 1.12, draw }) + s(12);
  if (c.subtitle) y -= para(page, F.sub, c.subtitle, { x: mid, y, size: s(19), maxW, align: 'center', c: P.mutedForeground, lh: 1.3, draw }) + s(26);
  for (const b of c.body ?? []) y -= para(page, F.body, b, { x: mid, y, size: s(15), maxW, align: 'center', c: P.foreground, lh: 1.65, draw }) + s(14);
  const det = (c.details ?? []).slice(0, 5);
  if (det.length) {
    y -= s(10);
    // הפרט הראשון (בדרך כלל "מתי") — בולט
    const [first, ...rest] = det;
    if (draw) K.text(page, first.label, { x: mid, y: y - s(12), size: s(12), font: F.bold, color: P.accent, align: 'center' });
    y -= s(12) + 8;
    y -= para(page, F.head, first.value, { x: mid, y, size: s(26), maxW, align: 'center', c: P.foreground, lh: 1.2, draw }) + s(18);
    for (const d of rest) {
      const line = `${d.label}: ${d.value}`;
      y -= para(page, F.body, line, { x: mid, y, size: s(15), maxW, align: 'center', c: P.foreground, lh: 1.5, draw }) + s(8);
    }
    y -= s(10);
  }
  if (c.highlight) {
    const hs = s(16);
    const ls2 = lines(F.sub, c.highlight, hs, maxW - 40);
    const ph = ls2.length * hs * 1.3 + 24;
    const pw = Math.min(maxW, Math.max(...ls2.map((l) => K.width(F.sub, K.visual(l), hs))) + 52);
    if (draw) {
      K.roundRect(page, { x: mid - pw / 2, y: y - ph, width: pw, height: ph, radius: ph / 2, color: P.primary });
      ls2.forEach((l, i) => K.text(page, l, { x: mid, y: y - 12 - hs - i * hs * 1.3 + 3, size: hs, font: F.sub, color: P.onPrimary, align: 'center' }));
    }
    y -= ph + s(14);
  }
  y -= 24;
  const used = top - y;
  if (draw) {
    if (c.footer) K.text(page, c.footer, { x: mid, y: bottom + 6, size: 10, font: F.body, color: P.mutedForeground, align: 'center' });
  }
  return used;
}

const DRAW = { swiss, editorial, hero, card };

/**
 * המודעה. ‎design‎ — מה שה-AI בחר: ‎{ layout, palette, type }‎. ‎logoBuf‎ — הלוגו (או ‎null‎)
 */
async function render(c, design, { logoBuf = null, brandHex = '#1f4e79' } = {}) {
  const layout = LAYOUTS.includes(design?.layout) ? design.layout : 'swiss';
  const P = paletteOf(design?.palette, brandHex);
  const T = TYPE_PAIRS[design?.type] ?? TYPE_PAIRS.modern;
  const content = { ...c, title_scale: Math.min(1.4, Math.max(0.7, Number(c.title_scale) || 1)) };
  const doc = await K.L().PDFDocument.create();
  const F = { head: await K.embed(doc, T.head), sub: await K.embed(doc, T.sub), body: await K.embed(doc, T.body), bold: await K.embed(doc, T.bold) };
  const page = doc.addPage(A4);
  const [W, H] = A4;
  const logo = content.show_logo === false ? null : await K.image(doc, logoBuf);
  const bottom = 40;
  // רקע
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: K.color(layout === 'card' ? P.background : '#FFFFFF') });
  const bandH = layout === 'hero' ? Math.round(H * 0.4) : 0;
  const areaTop = layout === 'hero' ? H - bandH - 36 : layout === 'card' ? H - 60 : H - 72;
  const areaBottom = bottom + (layout === 'editorial' || layout === 'card' ? 40 : 64);
  const avail = areaTop - areaBottom;
  const fn = DRAW[layout];
  // מדידה: מגדילים עד שהתוכן ממלא את הדף (עד ‎x1.45‎), ומקטינים אם הוא גולש
  let scale = 1;
  const measure = (sc) => fn(page, F, P, content, logo, { scale: sc, draw: false, top: areaTop, bottom, bandH });
  let h = measure(scale);
  if (h > avail) { while (scale > 0.6 && measure(scale) > avail) scale -= 0.05; } else { while (scale < 1.45 && measure(scale + 0.05) <= avail * 0.92) scale += 0.05; }
  h = measure(scale);
  // מרכוז אנכי (ב-swiss וב-hero — קצת מעל המרכז, כמו בעימוד של דפוס)
  const free = Math.max(0, avail - h);
  const top = areaTop - (layout === 'swiss' || layout === 'hero' ? free * 0.35 : free / 2);
  if (layout === 'card') {
    // הכרטיס הלבן סביב התוכן
    const pad = 28;
    K.roundRect(page, { x: 48, y: top - h - pad, width: W - 96, height: h + 2 * pad, radius: 22, color: P.card ?? '#FFFFFF', borderColor: P.border, borderWidth: 1 });
    page.drawRectangle({ x: W / 2 - 40, y: top + pad - 6, width: 80, height: 6, color: K.color(P.accent) });
  }
  fn(page, F, P, content, logo, { scale, draw: true, top, bottom, bandH });
  return Buffer.from(await doc.save());
}

/** לבחירה של ה-AI: הפלטות, הסגנונות והכללים מהסקיל, בקצרה */
function designBrief() {
  return [
    'בחירת עיצוב — לפי הסקיל ui-ux-pro-max:',
    `פריסות: swiss (מינימלי, עסקי), editorial (מינימלי אלגנטי, טקסי), hero (מעוצב, הכרזה / מכירות), card (מעוצב, אירוע / חגיגה / הזמנה).`,
    `צימוד גופנים: modern — ${TYPE_PAIRS.modern.note}; elegant — ${TYPE_PAIRS.elegant.note}; friendly — ${TYPE_PAIRS.friendly.note}.`,
    `סגנונות מהסקיל שמתאימים לדפוס: ${STYLES.map((x) => `${x.name} (${x.bestFor.slice(0, 60)})`).join('; ')}.`,
    `פלטות (name — הערה): brand — הצבע של החברה (ברירת מחדל להודעה עסקית / רשמית); ${paletteOptions().map((p) => `${p.name} — ${p.notes}`).join('; ')}.`,
    'כללים: התאם את הפלטה לנושא (הודעה לעובדים / דיירים / לקוחות — brand או Real Estate; אירוע חברה / גיבוש — Event Management; חג / חגיגה — חמה ושמחה). הדגשה אחת. ניגודיות טובה.'
  ].join('\n');
}

const DESIGN_FIELDS = {
  design_layout: { type: 'string', enum: LAYOUTS, description: 'הפריסה. בסגנון "מינימלי" — swiss או editorial; "מעוצב" — hero או card' },
  design_palette: { type: 'string', description: 'שם הפלטה מהרשימה בדיוק, או brand' },
  design_type: { type: 'string', enum: Object.keys(TYPE_PAIRS), description: 'צימוד הגופנים' }
};

module.exports = { render, designBrief, DESIGN_FIELDS, LAYOUTS, paletteOf, _internal: { swiss, editorial, hero, card, fitSize } };
