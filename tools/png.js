'use strict';
/**
 * קריאה וכתיבה של PNG, ללא תלויות. משמש את כלי הבנייה שבתיקייה הזו בלבד —
 * לא נטען על ידי השרת.
 *
 * נתמכים: עומק 8 ביט, וסוגי הצבע 0 (אפור), 2 (RGB), 4 (אפור+אלפא) ו-6 (RGBA).
 * אלה הסוגים שכל כלי עריכה מפיק בפועל; פלטה (סוג 3) ושזירה אינם נתמכים,
 * ואם יגיע קובץ כזה תיזרק שגיאה מפורשת ולא ייקרא זבל.
 */
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// כתיבה
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** ‎pixels‎ הוא Uint8Array בסדר השורות, עם ‎CHANNELS[colorType]‎ בתים לפיקסל */
function encode(width, height, pixels, colorType = 6) {
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`סוג צבע ${colorType} אינו נתמך בכתיבה`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  // כל שורה נפתחת בבית סוג הסינון; 0 = בלי סינון, והדחיסה מטפלת בשאר
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, at + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// קריאה
// ---------------------------------------------------------------------------

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * מחזיר ‎{ width, height, rgba }‎ כאשר ‎rgba‎ הוא ארבעה בתים לפיקסל.
 * כל סוגי הקלט מומרים ל-RGBA, כדי שהקורא לא יצטרך לדעת מה היה בקובץ.
 */
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('אינו קובץ PNG');

  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];

  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`עומק ${data[8]} ביט אינו נתמך — נדרש 8`);
      colorType = data[9];
      if (!CHANNELS[colorType]) throw new Error(`סוג צבע ${colorType} אינו נתמך בקריאה`);
      if (data[12] !== 0) throw new Error('קובץ שזור (interlaced) אינו נתמך');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }

  const ch = CHANNELS[colorType];
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // ביטול הסינון. כל שורה מסתמכת על השורה שמעליה, ולכן חייבים לעבור בסדר.
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;

    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= ch ? out[dst + i - ch] : 0;          // הפיקסל שמשמאל
      const b = y > 0 ? out[up + i] : 0;                   // הפיקסל שמעל
      const c = y > 0 && i >= ch ? out[up + i - ch] : 0;    // באלכסון
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paeth(a, b, c);
      else throw new Error(`סוג סינון ${filter} אינו מוכר`);
      out[dst + i] = v & 0xff;
    }
  }

  // המרה ל-RGBA אחיד
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * ch;
    const d = p * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = out[s + 1];
    } else if (colorType === 2) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2];
      rgba[d + 3] = 255;
    } else {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2];
      rgba[d + 3] = out[s + 3];
    }
  }

  return { width, height, rgba };
}

module.exports = { encode, decode, crc32 };
