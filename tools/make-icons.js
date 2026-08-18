'use strict';
/**
 * מייצר את סמלי האפליקציה מהסמל של המערכת — בלי שום תלות חיצונית.
 *
 *   node tools/make-icons.js
 *
 * למה לא לקחת קובץ PNG מוכן: הסמל של משימון מוגדר בקוד (‎UI.logoMark‎) ולא
 * בקובץ תמונה, וסמל אפליקציה נדרש בחצי תריסר גדלים. עדיף לגזור את כולם
 * מאותה הגדרה גאומטרית מדויקת, כדי שהסמל בטלפון יהיה אותו סמל שבמערכת —
 * ושהוא יישאר חד בכל גודל.
 *
 * שיטת הציור: לכל צורה יש פונקציית מרחק (המרחק מהנקודה אל גבול הצורה),
 * ומדגמים 4×4 בכל פיקסל. כך מתקבלת החלקה נכונה של הקצוות המעוגלים בלי
 * מנוע גרפי, וכל הקוד הוא חשבון על מספרים.
 *
 * הקבצים נכתבים ל-public/icons ונשמרים בגיט. אין להריץ בזמן הפעלת השרת.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// כתיבת PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** ‎rgba‎ הוא Uint8Array באורך width*height*4 */
function writePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 8 ביט לערוץ
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0;   // דחיסה — deflate
  ihdr[11] = 0;   // סינון — בסיסי
  ihdr[12] = 0;   // בלי שזירה

  // כל שורה נפתחת בבית סוג הסינון. 0 = בלי סינון, והדחיסה מטפלת בשאר.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// פונקציות מרחק — הגאומטריה של הסמל
// ---------------------------------------------------------------------------

/** מרחק מלבן מעוגל שמרכזו ‎(cx,cy)‎, חצי-מידותיו ‎(hw,hh)‎ ורדיוס פינה ‎r‎ */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** מרחק לקטע בין ‎a‎ ל-‎b‎. עיגול הקצוות מתקבל מעצמו מהחיסור של חצי העובי. */
function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const len2 = bax * bax + bay * bay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (len2 || 1)));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

const BRAND = [0x0f, 0x76, 0x6e];
const INK = [0xff, 0xff, 0xff];

/**
 * הסמל בתוך ריבוע 64×64, בדיוק כמו ‎UI.logoMark‎: אריח בצבע המותג, שתי שורות
 * רשימה חיוורות, ומעליהן סימן וי במשיכה אחת.
 *
 * ‎squared‎ — אריח בלי פינות מעוגלות. נדרש לסמל של iOS, שמעגל את הפינות בעצמו,
 * וסמל שכבר מעוגל היה מותיר אצלו רצועות שקופות בפינות.
 */
function iconAt(size, { squared = false } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const S = 4;                  // 4×4 דגימות בכל פיקסל
  const scale = size / 64;
  const tileRadius = squared ? 0 : 17;
  // עובי הווי נשמר יחסי לגודל, אחרת הוא נעלם בסמלים קטנים
  const strokeHalf = 3.5;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let lines = 0;
      let check = 0;

      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // נקודת הדגימה, מומרת חזרה למערכת הצירים של 64×64
          const x = (px + (sx + 0.5) / S) / scale;
          const y = (py + (sy + 0.5) / S) / scale;

          if (sdRoundRect(x, y, 32, 32, 32, 32, tileRadius) < 0) tile++;
          if (sdRoundRect(x, y, 27, 19.5, 12, 2.5, 2.5) < 0) lines++;
          if (sdRoundRect(x, y, 23, 30.5, 8, 2.5, 2.5) < 0) lines++;

          // הווי הוא שני קטעים; המינימום ביניהם נותן חיבור מעוגל ביניהם
          const d = Math.min(
            sdSegment(x, y, 16, 44.5, 25, 53),
            sdSegment(x, y, 25, 53, 48, 26)
          );
          if (d - strokeHalf < 0) check++;
        }
      }

      const total = S * S;
      const tileA = tile / total;
      if (tileA <= 0) continue;   // מחוץ לאריח — נשאר שקוף

      // הרכבה: אריח, מעליו השורות בשקיפות, ומעליהן הווי
      let r = BRAND[0];
      let g = BRAND[1];
      let b = BRAND[2];

      const lineA = Math.min(1, lines / total) * 0.45;
      if (lineA > 0) {
        r = r + (INK[0] - r) * lineA;
        g = g + (INK[1] - g) * lineA;
        b = b + (INK[2] - b) * lineA;
      }

      const checkA = check / total;
      if (checkA > 0) {
        r = r + (INK[0] - r) * checkA;
        g = g + (INK[1] - g) * checkA;
        b = b + (INK[2] - b) * checkA;
      }

      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r);
      rgba[at + 1] = Math.round(g);
      rgba[at + 2] = Math.round(b);
      rgba[at + 3] = Math.round(tileA * 255);
    }
  }

  return writePng(size, size, rgba);
}

// ---------------------------------------------------------------------------

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const FILES = [
  // סמלי המניפסט. אותה תמונה משמשת גם כ-maskable: תוכן הסמל יושב בין 25%
  // ל-75% מהרוחב, בתוך אזור הבטיחות שאנדרואיד חותך אליו.
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  // iOS אינו קורא את המניפסט למסך הבית, ואינו מכבד שקיפות — ולכן ריבוע מלא
  { name: 'apple-touch-icon.png', size: 180, squared: true },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-16.png', size: 16 }
];

for (const f of FILES) {
  const buf = iconAt(f.size, { squared: f.squared });
  fs.writeFileSync(path.join(OUT, f.name), buf);
  console.log(`  ${f.name}  ${f.size}×${f.size}  ${(buf.length / 1024).toFixed(1)}KB`);
}

console.log('\nהסמלים נוצרו ב-public/icons.');
