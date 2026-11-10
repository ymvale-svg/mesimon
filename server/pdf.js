'use strict';
/**
 * מחולל PDF קטן, בלי תלויות — טקסט (גם עברית), קווים ומלבנים.
 *
 * למשימון אין חבילות חיצוניות, ובשרת אין דפדפן. לכן ה-PDF נכתב כאן ישירות:
 * גופן TrueType מוטמע (‎server/fonts‎, Liberation Sans, רישיון OFL) כ-CIDFont
 * עם קידוד ‎Identity-H‎, כך שכל תו נכתב לפי מספר הגליף שלו. ‎ToUnicode‎ — כדי
 * שהעתקה וחיפוש בקובץ יחזירו עברית תקינה.
 *
 * כיוון: עברית נכתבת מימין לשמאל. ‎visual()‎ הופכת שורה לסדר התצוגה: קטעים
 * עבריים הפוכים, ומספרים ומילים לועזיות ("1,900.00", "PR26000003", "ICON-H")
 * נשארים משמאל לימין במקומם. זה פשוט יותר מאלגוריתם ה-Bidi המלא, ומספיק לטקסט
 * של מסמכים: שורה בעברית עם מספרים וקודים.
 *
 * הקואורדינטות — בנקודות (A4: ‎595×842‎), מהפינה **השמאלית העליונה**.
 */
const fs = require('node:fs');
const Paths = require('./paths');
const path = require('node:path');
const zlib = require('node:zlib');

const FONTS_DIR = Paths.FONTS;
const A4 = { w: 595.28, h: 841.89 };

// ---------------------------------------------------------------------------
// TrueType — רק מה שצריך: מפת תווים, רוחבים ומדדים
// ---------------------------------------------------------------------------

function parseTTF(buf) {
  const tables = {};
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  const head = tables.head.off;
  const upm = buf.readUInt16BE(head + 18);
  const bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
  const hhea = tables.hhea.off;
  const ascent = buf.readInt16BE(hhea + 4);
  const descent = buf.readInt16BE(hhea + 6);
  const nHM = buf.readUInt16BE(hhea + 34);
  const hmtx = tables.hmtx.off;
  const advances = [];
  for (let i = 0; i < nHM; i++) advances.push(buf.readUInt16BE(hmtx + i * 4));

  // cmap: עדיף פורמט 12 (כל יוניקוד), אחרת 4
  const cmap = tables.cmap.off;
  const subs = [];
  for (let i = 0; i < buf.readUInt16BE(cmap + 2); i++) {
    const o = cmap + 4 + i * 8;
    subs.push({ pid: buf.readUInt16BE(o), eid: buf.readUInt16BE(o + 2), off: cmap + buf.readUInt32BE(o + 4) });
  }
  const pick = subs.find((s) => s.pid === 3 && s.eid === 10 && buf.readUInt16BE(s.off) === 12)
    ?? subs.find((s) => s.pid === 3 && s.eid === 1 && buf.readUInt16BE(s.off) === 4);
  const map = new Map();
  if (pick && buf.readUInt16BE(pick.off) === 12) {
    const groups = buf.readUInt32BE(pick.off + 12);
    for (let g = 0; g < groups; g++) {
      const o = pick.off + 16 + g * 12;
      const start = buf.readUInt32BE(o), end = buf.readUInt32BE(o + 4), gid = buf.readUInt32BE(o + 8);
      for (let c = start; c <= end && c - start < 65536; c++) map.set(c, gid + (c - start));
    }
  } else if (pick) {
    const o = pick.off;
    const segX2 = buf.readUInt16BE(o + 6);
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = buf.readUInt16BE(ends + i * 2), start = buf.readUInt16BE(starts + i * 2);
      const delta = buf.readInt16BE(deltas + i * 2), ro = buf.readUInt16BE(ranges + i * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const at = ranges + i * 2 + ro + (c - start) * 2;
          gid = buf.readUInt16BE(at);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(c, gid);
      }
    }
  }
  const adv = (gid) => advances[Math.min(gid, advances.length - 1)] ?? 0;
  return { upm, bbox, ascent, descent, map, adv };
}

const fontCache = new Map();
function loadFont(file) {
  if (!fontCache.has(file)) {
    const buf = fs.readFileSync(path.join(FONTS_DIR, file));
    fontCache.set(file, { buf, ...parseTTF(buf) });
  }
  return fontCache.get(file);
}

// ---------------------------------------------------------------------------
// כיוון — מסדר לוגי לסדר תצוגה
// ---------------------------------------------------------------------------

const isR = (c) => /[֐-׿יִ-ﭏ]/.test(c);
const isL = (c) => /[A-Za-z0-9À-ɏ]/.test(c);
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

/**
 * שורה בסדר תצוגה (משמאל לימין), בהנחה שכיוון הבסיס מימין לשמאל כשיש בה עברית.
 * קטע לועזי/מספרי ממשיך דרך סימנים שבין שני תווים לועזיים ("1,900.00", "160/70",
 * "S-101", "API VPLANS"), וגם "%" או "₪" שמיד אחריו ו-"−" שמיד לפניו.
 */
function visual(str) {
  const s = String(str ?? '');
  if (![...s].some(isR)) return s;
  const ch = [...s];
  const cls = ch.map((c) => (isR(c) ? 'R' : isL(c) ? 'L' : 'N'));
  // סימן בין שני לועזיים — לועזי
  for (let i = 1; i < ch.length - 1; i++) {
    if (cls[i] !== 'N') continue;
    let j = i;
    while (j < ch.length && cls[j] === 'N' && j - i < 3) j++;
    if (cls[i - 1] === 'L' && cls[j] === 'L' && !/[־]/.test(ch[i])) for (let k = i; k < j; k++) cls[k] = 'L';
  }
  for (let i = 0; i < ch.length; i++) {
    if (cls[i] === 'N' && /[%₪]/.test(ch[i]) && cls[i - 1] === 'L') cls[i] = 'L';
    // סימן מינוס/פלוס לפני מספר — רק בתחילת מילה ("−10%"), לא מקף אחרי אות ("ב-15")
    if (cls[i] === 'N' && /[\-−+]/.test(ch[i]) && cls[i + 1] === 'L' && /[0-9]/.test(ch[i + 1]) && (i === 0 || /\s/.test(ch[i - 1]))) cls[i] = 'L';
  }
  // קטעים: לועזי, ושאר (עברית וסימנים — בכיוון הבסיס)
  const runs = [];
  for (let i = 0; i < ch.length; i++) {
    const type = cls[i] === 'L' ? 'L' : 'R';
    if (runs.length && runs.at(-1).type === type) runs.at(-1).chars.push(ch[i]);
    else runs.push({ type, chars: [ch[i]] });
  }
  return runs.reverse().map((r) => (r.type === 'L' ? r.chars.join('') : r.chars.reverse().map((c) => MIRROR[c] ?? c).join(''))).join('');
}

// ---------------------------------------------------------------------------
// המסמך
// ---------------------------------------------------------------------------

const hex4 = (n) => n.toString(16).padStart(4, '0');
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => {
  const h = String(c ?? '#000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => num(parseInt(v.slice(i, i + 2), 16) / 255)).join(' ');
};

class Pdf {
  constructor({ fonts = { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' } } = {}) {
    this.fonts = Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, { key: k, ...loadFont(f), used: new Map() }]));
    this.pages = [];
    this.addPage();
  }

  addPage() { this.page = []; this.pages.push(this.page); return this; }
  get width() { return A4.w; }
  get height() { return A4.h; }

  /** רוחב הטקסט בנקודות */
  measure(text, { size = 10, font = 'regular' } = {}) {
    const f = this.fonts[font];
    let w = 0;
    for (const c of visual(text)) w += f.adv(f.map.get(c.codePointAt(0)) ?? 0);
    return (w / f.upm) * size;
  }

  /**
   * טקסט בשורה אחת. ‎x‎ — לפי ‎align‎: ‎right‎ (ברירת מחדל) — הקצה הימני;
   * ‎left‎ — השמאלי; ‎center‎ — האמצע. ‎y‎ — קו הבסיס, מלמעלה.
   */
  text(str, x, y, { size = 10, font = 'regular', align = 'right', color = '#1a1a1a' } = {}) {
    const f = this.fonts[font];
    const vis = visual(str);
    let hex = '';
    for (const c of vis) {
      const cp = c.codePointAt(0);
      const gid = f.map.get(cp) ?? 0;
      if (gid) f.used.set(gid, cp);
      hex += hex4(gid);
    }
    const w = this.measure(str, { size, font });
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.push(`BT ${rgb(color)} rg /F${f.key} ${num(size)} Tf ${num(left)} ${num(A4.h - y)} Td <${hex}> Tj ET`);
    return w;
  }

  /** מפרק לשורות לפי רוחב (מילים שלמות) */
  wrap(str, maxWidth, opts = {}) {
    const words = String(str ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && this.measure(next, opts) > maxWidth) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  line(x1, y1, x2, y2, { width = 0.5, color = '#cccccc' } = {}) {
    this.page.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(A4.h - y1)} m ${num(x2)} ${num(A4.h - y2)} l S`);
  }

  rect(x, y, w, h, { fill = null, stroke = null, width = 0.8 } = {}) {
    const box = `${num(x)} ${num(A4.h - y - h)} ${num(w)} ${num(h)} re`;
    if (fill && stroke) this.page.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${num(width)} w ${box} B`);
    else if (fill) this.page.push(`${rgb(fill)} rg ${box} f`);
    else if (stroke) this.page.push(`${rgb(stroke)} RG ${num(width)} w ${box} S`);
  }

  /** הקובץ */
  toBuffer({ title = '' } = {}) {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const stream = (dict, data, compress = true) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
      const body = compress ? zlib.deflateSync(raw) : raw;
      return { dict: `${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length}`, data: body };
    };

    const fontRefs = {};
    for (const f of Object.values(this.fonts)) {
      if (!f.used.size && f.key !== 'regular') continue;
      const scale = 1000 / f.upm;
      const name = `MSM${f.key === 'bold' ? 'B' : 'R'}+LiberationSans${f.key === 'bold' ? '-Bold' : ''}`;
      const file = add(stream(`<< /Length1 ${f.buf.length}`, f.buf));
      objs[file - 1].dict += ' >>';
      const desc = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${f.bbox.map((v) => Math.round(v * scale)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * scale)} /Descent ${Math.round(f.descent * scale)} /CapHeight ${Math.round(f.ascent * scale)} /StemV 80 /FontFile2 ${file} 0 R >>`);
      const gids = [...f.used.keys()].sort((a, b) => a - b);
      const widths = gids.map((g) => `${g} [${Math.round(f.adv(g) * scale)}]`).join(' ');
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${widths}] /CIDToGIDMap /Identity >>`);
      const bf = gids.map((g) => `<${hex4(g)}> <${hex4(f.used.get(g))}>`);
      const chunks = [];
      for (let i = 0; i < bf.length; i += 100) chunks.push(`${Math.min(100, bf.length - i)} beginbfchar\n${bf.slice(i, i + 100).join('\n')}\nendbfchar`);
      const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chunks.join('\n')}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
      const toUni = add(stream('<<', cmap));
      objs[toUni - 1].dict += ' >>';
      fontRefs[f.key] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`);
    }
    const fontDict = Object.entries(fontRefs).map(([k, r]) => `/F${k} ${r} 0 R`).join(' ');

    const pagesId = objs.length + 1;
    add(null); // מקום ל-Pages
    const kids = [];
    for (const ops of this.pages) {
      const content = add(stream('<<', ops.join('\n')));
      objs[content - 1].dict += ' >>';
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << ${fontDict} >> >> /Contents ${content} 0 R >>`));
    }
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const utf16 = (t) => `<FEFF${[...t].map((c) => { const cp = c.codePointAt(0); return cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp); }).join('')}>`;
    const info = add(`<< /Title ${utf16(title)} /Producer (Mesimon) >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (he) >>`);

    const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets = [];
    let len = parts[0].length;
    objs.forEach((o, i) => {
      offsets.push(len);
      const chunk = typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      parts.push(chunk);
      len += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

module.exports = { Pdf, visual, parseTTF, A4 };
