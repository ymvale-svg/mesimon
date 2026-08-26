'use strict';
/**
 * כתיבת קובץ אקסל, בלי ספרייה חיצונית.
 *
 * למה xlsx ולא CSV: קובץ CSV בעברית נפתח באקסל מעוות אלא אם מקדימים לו BOM,
 * ואקסל בכל זאת "מתקן" בו ערכים לפי הגדרות אזור — מחרוזת שנראית כתאריך
 * הופכת לתאריך, ואפס מוביל נמחק. בדוח בקרה שנשלח הלאה זה לא מקובל. xlsx גם
 * מאפשר כותרת מודגשת, רוחב עמודות, וגיליון בכיוון ימין-לשמאל.
 *
 * המימוש: xlsx הוא ארכיון ZIP של קובצי XML. הכתיבה כאן היא ZIP ללא דחיסה
 * (שיטת store) — ZIP תקני לגמרי, ואקסל קורא אותו — וכך אין צורך בדחיסה ואין
 * מה להשתבש בה. לדוח של מאות שורות הגודל זניח.
 *
 * המחרוזות נכתבות ‎inlineStr‎ ולא דרך ‎sharedStrings.xml‎: קובץ אחד פחות,
 * ובדוח שנוצר פעם אחת ונקרא פעם אחת אין ערך לחיסכון שבשיתוף מחרוזות.
 */

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * בונה ארכיון מרשימת ‎{name, data}‎.
 *
 * חותמת הזמן קבועה ואינה זמן היצירה: אקסל אינו עושה בה שימוש, וקובץ שתלוי
 * בשעה אינו ניתן להשוואה בין הרצות — מה שהופך בדיקה לבלתי אפשרית.
 */
function zip(entries) {
  const DOS_TIME = 0;      // 00:00
  const DOS_DATE = 0x2100; // 1.1.1980, התאריך המינימלי בתקן
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // גרסה נדרשת
    local.writeUInt16LE(0x0800, 6);      // שמות קבצים ב-UTF-8
    local.writeUInt16LE(0, 8);           // ללא דחיסה
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * תווי בקרה אינם חוקיים ב-XML 1.0, ואקסל מסרב לפתוח קובץ שיש בהם.
 *
 * הסינון נעשה בהשוואת קוד ולא בביטוי רגולרי בכוונה: מחלקת תווים של בתי
 * בקרה נכתבת בקוד המקור או כתווים ממשיים — שהופכים את הקובץ לבינארי — או
 * כרצף escapes שקל לשבש בלי לשים לב. לולאה מפורשת אינה משאירה ספק.
 *
 * טאב, שורה חדשה ו-CR נשמרים: הם חוקיים ב-XML וגם נחוצים בטקסט חופשי.
 */
function stripControl(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) out += ch;
  }
  return out;
}

const esc = (v) => stripControl(String(v ?? ''))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A, B … Z, AA — נדרש כי דוח בקרה עלול לעבור 26 עמודות */
function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const buf = (s) => Buffer.from(s, 'utf8');

/*
 * גיליון סגנונות מינימלי: גופן רגיל וגופן מודגש לכותרת. שני ה-fills נדרשים
 * גם כשאינם בשימוש — אקסל מסרב לפתוח קובץ שבו פחות משניים.
 */
const STYLES = `${XML_HEAD}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

/**
 * יוצר חוברת עבודה עם גיליון אחד.
 *
 * ‎rows‎ הוא מערך של מערכי תאים. השורה הראשונה מודגשת ומוקפאת — דוח שנגלל
 * ומאבד את הכותרות אינו קריא. כל הערכים נכתבים כמחרוזות בכוונה: תאריך
 * שנכתב כמספר סידורי תלוי בהגדרות האזור, ובדוח בקרה חשוב יותר שמה שמופיע
 * במסך יופיע גם בקובץ.
 */
function build(rows, { sheetName = 'גיליון1', widths = [] } = {}) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const body = rows.map((cells, r) => {
    const style = r === 0 ? ' s="1"' : '';
    const tags = cells.map((value, c) => {
      const text = String(value ?? '');
      if (!text) return '';   // תא ריק אינו נכתב כלל — קובץ קטן וקריא יותר
      return `<c r="${colLetter(c)}${r + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${tags}</row>`;
  }).join('');

  // הקפאת שורת הכותרת
  const pane = rows.length > 1
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    : '';

  const sheet = `${XML_HEAD}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView rightToLeft="1" tabSelected="1" workbookViewId="0">${pane}</sheetView></sheetViews>
${cols}<sheetData>${body}</sheetData></worksheet>`;

  const workbook = `${XML_HEAD}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zip([
    {
      name: '[Content_Types].xml',
      data: buf(`${XML_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
    },
    {
      name: '_rels/.rels',
      data: buf(`${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
    },
    { name: 'xl/workbook.xml', data: buf(workbook) },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: buf(`${XML_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)
    },
    { name: 'xl/styles.xml', data: buf(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: buf(sheet) }
  ]);
}

module.exports = { build, colLetter, crc32, zip, stripControl };
