'use strict';
/**
 * קורא גיליונות — xlsx ו-CSV, ללא שום תלות חיצונית.
 *
 * xlsx הוא ארכיון ZIP שבתוכו XML. הקריאה כאן היא בדיוק זה ולא יותר: פתיחת
 * הארכיון (‎node:zlib‎), שליפת הגיליון הראשון ומחרוזות השיתוף, וחילוץ הערכים.
 * אין כאן תמיכה בנוסחאות, בעיצוב או בגיליונות מרובים — לייבוא רשימת אנשים
 * צריך טבלה, ולא חוברת עבודה.
 *
 * המוצר הוא מטריצה של מחרוזות: ‎[['שם','אימייל'], ['דנה שמש','dana@…']]‎.
 */
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * רשומת סוף הארכיון יושבת בסופו, ואחריה עשוי לבוא תגובה חופשית באורך
 * משתנה — ולכן סורקים אחורה ולא קוראים ממקום קבוע.
 */
function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** מפה משם קובץ בארכיון לתוכנו, למי שנחוץ לנו בלבד */
function readZip(buf, wanted) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('הקובץ אינו קובץ xlsx תקין');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (wanted(name)) {
      if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error('הקובץ אינו קובץ xlsx תקין');
      // אורכי השם וה-extra בכותרת המקומית עשויים להיות שונים מאלה שבמדריך
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decodeXml = (text) =>
  String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);

/**
 * מחרוזות השיתוף. ‎<si>‎ אחד עשוי להתפרק לכמה ‎<t>‎ כשהתא מעוצב באמצע
 * המילה, ולכן כל ה-‎<t>‎ שבתוכו מחוברים ולא נלקח הראשון.
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(([, inner]) =>
    [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => decodeXml(t)).join('')
  );
}

/** A→0, B→1 … AA→26. שם העמודה הוא בסיס 26 באותיות */
function columnIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * גיליון לשורות. תא ריק אינו נכתב ב-XML כלל, ולכן העמודה נקבעת לפי ‎r‎
 * ולא לפי סדר ההופעה — אחרת שורה עם תא ריק באמצע הייתה נדחסת שמאלה
 * וכל העמודות שאחריו היו זזות.
 */
function parseSheet(xml, shared) {
  const rows = [];
  for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const inner = cell[2] ?? '';
      const at = columnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1');
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        // מפתח למחרוזת שיתופית
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1);
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => decodeXml(t)).join('');
      } else if (type === 'str') {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }

      while (cells.length < at) cells.push('');
      cells[at] = String(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** הגיליון הראשון לפי סדר ה-workbook, ולא לפי סדר הקבצים בארכיון */
function firstSheetPath(zip) {
  const names = [...zip.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!names.length) throw new Error('לא נמצא גיליון בקובץ');
  return names.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
}

function parseXlsx(buffer) {
  const zip = readZip(buffer, (name) =>
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const shared = parseSharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheet = zip.get(firstSheetPath(zip)).toString('utf8');
  return parseSheet(sheet, shared);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * פענוח טקסט. אקסל בעברית שומר CSV בקידוד windows-1255 ולא ב-UTF-8, וקובץ
 * כזה שנקרא כ-UTF-8 מגיע כג'יבריש. לכן: BOM מכריע; ואם אין BOM והפענוח
 * כ-UTF-8 מייצר תווי החלפה — מנסים 1255.
 */
function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3);
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1255').decode(buffer);
  } catch {
    return utf8;  // אין תמיכה בקידוד — עדיף טקסט פגום מכשל מלא
  }
}

/** מפריד השדות נגזר מהשורה הראשונה: אקסל בעברית מפיק לעיתים נקודה-פסיק */
function guessDelimiter(line) {
  const counts = [[',', 0], [';', 0], ['\t', 0]];
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    const found = counts.find(([d]) => d === ch);
    if (found) found[1]++;
  }
  return counts.sort((a, b) => b[1] - a[1])[0][1] ? counts[0][0] : ',';
}

/** מפענח CSV מלא: מרכאות, מרכאות כפולות בתוך שדה, ושורות חדשות בתוך שדה */
function parseCsv(buffer) {
  const text = decodeText(buffer).replace(/\r\n?/g, '\n');
  const delimiter = guessDelimiter(text.split('\n')[0] ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field.trim()); field = ''; }
    else if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }

  // שורות ריקות לגמרי אינן נתונים — אקסל מוסיף אותן בסוף הקובץ
  return rows.filter((r) => r.some((c) => c !== ''));
}

// ---------------------------------------------------------------------------

/**
 * פענוח לפי סוג הקובץ. ‎xls‎ הישן (בינארי, לפני 2007) אינו נתמך — הוא פורמט
 * אחר לגמרי, ואפשר לשמור אותו מחדש כ-xlsx.
 */
function parse(buffer, filename = '') {
  const ext = String(filename).split('.').pop().toLowerCase();
  // חתימת ZIP — קובץ xlsx גם אם השם משקר
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === SIG_LOCAL;
  if (isZip || ext === 'xlsx') return parseXlsx(buffer);
  if (ext === 'xls') throw new Error('פורמט xls הישן אינו נתמך. יש לשמור את הקובץ כ-xlsx או כ-CSV');
  return parseCsv(buffer);
}

module.exports = { parse, parseCsv, parseXlsx, decodeText, columnIndex };
