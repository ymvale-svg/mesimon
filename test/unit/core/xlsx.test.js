'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const X = require('../../../server/core/xlsx-write');
const S = require('../../../server/core/spreadsheet');

const sheetXml = (buf) => S.readZip(buf, (n) => n === 'xl/worksheets/sheet1.xml').get('xl/worksheets/sheet1.xml').toString('utf8');

test('crc32 — ערכים ידועים', () => {
  assert.equal(X.crc32(Buffer.from('')), 0);
  assert.equal(X.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(X.crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('colLetter ו-columnIndex — הפוכים', () => {
  assert.equal(X.colLetter(0), 'A');
  assert.equal(X.colLetter(25), 'Z');
  assert.equal(X.colLetter(26), 'AA');
  assert.equal(X.colLetter(51), 'AZ');
  assert.equal(X.colLetter(52), 'BA');
  assert.equal(X.colLetter(701), 'ZZ');
  assert.equal(X.colLetter(702), 'AAA');
  for (let i = 0; i < 800; i += 7) assert.equal(S.columnIndex(`${X.colLetter(i)}12`), i);
  assert.equal(S.columnIndex('12'), 0);
});

test('stripControl — תווי בקרה מוסרים, טאב ושורה נשמרים', () => {
  assert.equal(X.stripControl('a\u0000b\u0007c\td\ne\rf\u001f'), 'abc\td\ne\rf');
  assert.equal(X.stripControl('עברית 😀'), 'עברית 😀');
});

test('zip — ארכיון store שנקרא בחזרה', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('שלום') }, { name: 'תיקייה/b.bin', data: Buffer.from([0, 1, 2]) }];
  const buf = X.zip(entries);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const out = S.readZip(buf, () => true);
  assert.equal(out.get('a.txt').toString('utf8'), 'שלום');
  assert.deepEqual([...out.get('תיקייה/b.bin')], [0, 1, 2]);
});

test('zip — דטרמיניסטי', () => {
  const e = [{ name: 'x', data: Buffer.from('y') }];
  assert.ok(X.zip(e).equals(X.zip(e)));
});

test('build ← parse — הלוך ושוב עם עברית ותווים מיוחדים', () => {
  const rows = [
    ['שם', 'אימייל', 'הערה'],
    ['דנה שמש', 'dana@x.com', 'A & B <c> "d" \'e\''],
    ['007', '2026-11-10', 'שורה\nשנייה']
  ];
  const buf = X.build(rows);
  assert.deepEqual(S.parse(buf, 'report.xlsx'), rows);
});

test('build — תא ריק לא נכתב, והעמודות לא זזות', () => {
  const buf = X.build([['א', 'ב', 'ג'], ['1', '', '3'], [null, undefined, 'x']]);
  assert.deepEqual(S.parseXlsx(buf), [['א', 'ב', 'ג'], ['1', '', '3'], ['', '', 'x']]);
  assert.doesNotMatch(sheetXml(buf), /r="B2"/);
});

test('build — מעבר ל-26 עמודות', () => {
  const header = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const parsed = S.parseXlsx(X.build([header]));
  assert.deepEqual(parsed[0], header);
  assert.match(sheetXml(X.build([header])), /r="AD1"/);
});

test('build — כותרת מודגשת, מוקפאת, מימין לשמאל ורוחבים', () => {
  const xml = sheetXml(X.build([['h'], ['v']], { widths: [12, 30] }));
  assert.match(xml, /<c r="A1" t="inlineStr" s="1">/);
  assert.match(xml, /<c r="A2" t="inlineStr">/);
  assert.match(xml, /rightToLeft="1"/);
  assert.match(xml, /state="frozen"/);
  assert.match(xml, /<col min="2" max="2" width="30" customWidth="1"\/>/);
});

test('build — שורה אחת: בלי הקפאה ובלי cols', () => {
  const xml = sheetXml(X.build([['רק כותרת']]));
  assert.doesNotMatch(xml, /pane/);
  assert.doesNotMatch(xml, /<cols>/);
});

test('build — שם גיליון נחתך ל-31 תווים ומוברח', () => {
  const nameOf = (buf) => /<sheet name="([^"]*)"/.exec(
    S.readZip(buf, (n) => n === 'xl/workbook.xml').get('xl/workbook.xml').toString('utf8'))[1];
  assert.equal(nameOf(X.build([['x']], { sheetName: 'א'.repeat(40) })), 'א'.repeat(31));
  assert.equal(nameOf(X.build([['x']], { sheetName: 'דוח <בקרה>' })), 'דוח &lt;בקרה&gt;');
  assert.equal(nameOf(X.build([['x']])), 'גיליון1');
});

test('build — תווי בקרה מסוננים מהתאים', () => {
  assert.deepEqual(S.parseXlsx(X.build([['a\u0001b']])), [['ab']]);
});

test('readZip — קובץ שאינו zip', () => {
  assert.throws(() => S.readZip(Buffer.alloc(100), () => true), /אינו קובץ xlsx/);
});

test('readZip — רשומה דחוסה (deflate)', () => {
  const data = Buffer.from('דחוס '.repeat(50));
  const stored = X.zip([{ name: 'd.txt', data }]);
  // בונים מחדש עם שיטה 8 ונתונים דחוסים
  const deflated = zlib.deflateRawSync(data);
  const name = Buffer.from('d.txt');
  const local = Buffer.alloc(30);
  stored.copy(local, 0, 0, 30);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  const central = Buffer.alloc(46);
  const cOff = 30 + name.length + data.length;
  stored.copy(central, 0, cOff, cOff + 46);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  const end = Buffer.alloc(22);
  stored.copy(end, 0, stored.length - 22);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + deflated.length, 16);
  const buf = Buffer.concat([local, name, deflated, central, name, end]);
  assert.equal(S.readZip(buf, () => true).get('d.txt').toString('utf8'), data.toString('utf8'));
});

test('parseXlsx — מחרוזות שיתוף, מספרים, str והגיליון הראשון', () => {
  const shared = '<sst><si><t>שם</t></si><si><r><t>דנה</t></r><r><t xml:space="preserve"> שמש</t></r></si></sst>';
  const sheet = (v) => `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>${v}</v></c></row>`
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="str"><v>&#1488;&#x5D1;</v></c><c r="C2"/></row></sheetData></worksheet>';
  const buf = X.zip([
    { name: 'xl/sharedStrings.xml', data: Buffer.from(shared) },
    { name: 'xl/worksheets/sheet10.xml', data: Buffer.from(sheet('999')) },
    { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(sheet('42')) }
  ]);
  assert.deepEqual(S.parseXlsx(buf), [['שם', '', '42'], ['דנה שמש', 'אב', '']]);
});

test('parseXlsx — בלי גיליון', () => {
  const buf = X.zip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]);
  assert.throws(() => S.parseXlsx(buf), /לא נמצא גיליון/);
});

test('decodeXml — ישויות', () => {
  assert.equal(S.decodeXml('&lt;a&gt; &amp;amp; &quot;&apos; &#65;&#x42;'), '<a> &amp; "\' AB');
});

test('decodeText — BOM, utf-8, windows-1255', () => {
  assert.equal(S.decodeText(Buffer.from('﻿שם', 'utf8')), 'שם');
  assert.equal(S.decodeText(Buffer.from('שם', 'utf8')), 'שם');
  assert.equal(S.decodeText(Buffer.from([0xf9, 0xed])), 'שם');
});

test('parseCsv — מרכאות, מרכאות כפולות ושורה חדשה בשדה', () => {
  const csv = 'שם,הערה\r\n"כהן, דנה","אמרה ""שלום""\nושלום"\r\n';
  assert.deepEqual(S.parseCsv(Buffer.from(csv)), [['שם', 'הערה'], ['כהן, דנה', 'אמרה "שלום"\nושלום']]);
});

test('parseCsv — נקודה-פסיק וטאב לפי השורה הראשונה', () => {
  assert.deepEqual(S.parseCsv(Buffer.from('a;b;c\n1;2,5;3')), [['a', 'b', 'c'], ['1', '2,5', '3']]);
  assert.deepEqual(S.parseCsv(Buffer.from('a\tb\n1\t2')), [['a', 'b'], ['1', '2']]);
});

test('parseCsv — שורות ריקות מסוננות ורווחים נחתכים', () => {
  assert.deepEqual(S.parseCsv(Buffer.from(' a , b \n\n,\n1,2\n\n')), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(S.parseCsv(Buffer.from('')), []);
});

test('parseCsv — קובץ windows-1255', () => {
  const buf = Buffer.concat([Buffer.from([0xf9, 0xed]), Buffer.from(',x\n1,2')]);
  assert.deepEqual(S.parseCsv(buf), [['שם', 'x'], ['1', '2']]);
});

test('parse — לפי חתימה ולא לפי שם, xls נדחה', () => {
  const buf = X.build([['a']]);
  assert.deepEqual(S.parse(buf, 'misnamed.csv'), [['a']]);
  assert.throws(() => S.parse(Buffer.from('x'), 'old.XLS'), /xls הישן/);
  assert.deepEqual(S.parse(Buffer.from('a,b'), 'list.csv'), [['a', 'b']]);
  assert.deepEqual(S.parse(Buffer.from('a,b')), [['a', 'b']]);
});
