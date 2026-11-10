'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../../server/mime');

const raw = (lines) => Buffer.from(lines.join('\r\n'), 'utf8');
const SHALOM_1255 = Buffer.from([0xf9, 0xec, 0xe5, 0xed]); // "שלום" ב-windows-1255

test('decodeBytes — utf-8, windows-1255, iso-8859-8-i', () => {
  assert.equal(M.decodeBytes(Buffer.from('שלום', 'utf8'), 'UTF-8'), 'שלום');
  assert.equal(M.decodeBytes(SHALOM_1255, 'windows-1255'), 'שלום');
  assert.equal(M.decodeBytes(SHALOM_1255, '"iso-8859-8-i"'), 'שלום');
});

test('decodeBytes — קידוד לא מוכר נופל ל-utf-8', () => {
  assert.equal(M.decodeBytes(Buffer.from('abc ש', 'utf8'), 'x-unknown'), 'abc ש');
  assert.equal(M.decodeBytes(Buffer.from('abc', 'utf8'), null), 'abc');
});

test('decodeWords — B בעברית windows-1255', () => {
  assert.equal(M.decodeWords('=?windows-1255?B?+ezl7Q==?='), 'שלום');
});

test('decodeWords — Q ב-utf-8 עם קו תחתון כרווח', () => {
  assert.equal(M.decodeWords('=?utf-8?Q?=D7=A9=D7=9C=D7=95=D7=9D_=D7=A2?='), 'שלום ע');
});

test('decodeWords — רווח בין מילים מקודדות נבלע', () => {
  const b = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  assert.equal(M.decodeWords(`${b('הזמנת')} ${b(' רכש')}`), 'הזמנת רכש');
  assert.equal(M.decodeWords(`${b('הזמנה')}\r\n ${b('123')}`), 'הזמנה123');
});

test('decodeWords — טקסט רגיל נשמר, מעורב מפוענח', () => {
  assert.equal(M.decodeWords('Re: hello'), 'Re: hello');
  assert.equal(M.decodeWords('Re: =?utf-8?B?16nXnNeV150=?= now'), 'Re: שלום now');
  assert.equal(M.decodeWords(null), '');
});

test('decodeWords — שפה ב-charset (RFC 2231) מתעלמת ממנה', () => {
  assert.equal(M.decodeWords('=?utf-8*he?B?16nXnNeV150=?='), 'שלום');
});

test('parseAddress — שם ומרכאות, אותיות קטנות', () => {
  assert.deepEqual(M.parseAddress('"Dana Cohen" <DANA@Example.COM>'), { address: 'dana@example.com', name: 'Dana Cohen' });
});

test('parseAddress — כתובת בלבד', () => {
  assert.deepEqual(M.parseAddress(' Bob@X.co '), { address: 'bob@x.co', name: '' });
  assert.deepEqual(M.parseAddress(undefined), { address: '', name: '' });
});

test('parseAddress — שם מקודד בעברית', () => {
  const r = M.parseAddress('=?windows-1255?B?+ezl7Q==?= <a@b.c>');
  assert.equal(r.name, 'שלום');
  assert.equal(r.address, 'a@b.c');
});

test('htmlToText — שורות, ישויות, סגנונות', () => {
  const html = '<html><head><title>x</title></head><style>p{}</style><p>שלום&nbsp;&amp; ברכה</p><div>a&lt;b&gt;c</div>שורה<br/>חדשה<script>alert(1)</script>';
  assert.equal(M.htmlToText(html), 'שלום & ברכה\na<b>c\nשורה\nחדשה');
});

test('htmlToText — מרכאות ומיזוג שורות ריקות', () => {
  assert.equal(M.htmlToText('&quot;x&quot; &#39;y&#39;'), '"x" \'y\'');
  assert.equal(M.htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
});

test('stripQuoted — On … wrote', () => {
  const t = 'תודה, קיבלתי\n\nOn Mon, 9 Nov 2026 at 10:00, Dana <d@x.com> wrote:\n> המקור';
  assert.equal(M.stripQuoted(t), 'תודה, קיבלתי');
});

test('stripQuoted — בתאריך … נכתב', () => {
  assert.equal(M.stripQuoted('מאושר\nבתאריך יום ב׳, 9 בנוב׳ 2026 נכתב:\nהודעה'), 'מאושר');
  assert.equal(M.stripQuoted('מאושר\nתאריך 9.11.2026 דנה כתבה:\nהודעה'), 'מאושר');
});

test('stripQuoted — Original Message, From, קו תחתון', () => {
  assert.equal(M.stripQuoted('א\n-----Original Message-----\nב'), 'א');
  assert.equal(M.stripQuoted('א\n----- הודעה מקורית -----\nב'), 'א');
  assert.equal(M.stripQuoted('א\nFrom: someone@x.com\nב'), 'א');
  assert.equal(M.stripQuoted('א\nמאת: דנה\nב'), 'א');
  assert.equal(M.stripQuoted('א\n________________\nב'), 'א');
});

test('stripQuoted — שורות > מושמטות, השאר נשאר', () => {
  assert.equal(M.stripQuoted('תשובה\n> ציטוט\n  > עוד\nסוף'), 'תשובה\nסוף');
  assert.equal(M.stripQuoted('בלי ציטוט כלל'), 'בלי ציטוט כלל');
});

test('parse — הודעה פשוטה וכותרות שרשור', () => {
  const m = M.parse(raw([
    'From: "Dana" <dana@x.com>',
    'To: a@b.c',
    'Cc: c@d.e',
    'Subject: =?utf-8?B?16nXnNeV150=?=',
    'Date: Mon, 09 Nov 2026 10:00:00 +0200',
    'Message-ID: <abc@x.com>',
    'In-Reply-To: <p1@x.com>',
    'References: <p0@x.com> <p1@x.com>',
    '',
    'גוף ההודעה'
  ]));
  assert.deepEqual(m.from, { address: 'dana@x.com', name: 'Dana' });
  assert.equal(m.to, 'a@b.c');
  assert.equal(m.cc, 'c@d.e');
  assert.equal(m.subject, 'שלום');
  assert.equal(m.date.toISOString(), '2026-11-09T08:00:00.000Z');
  assert.equal(m.messageId, '<abc@x.com>');
  assert.deepEqual(m.inReplyTo, ['<p1@x.com>']);
  assert.deepEqual(m.references, ['<p0@x.com>', '<p1@x.com>']);
  assert.equal(m.text, 'גוף ההודעה');
  assert.equal(m.autoSubmitted, false);
  assert.deepEqual(m.attachments, []);
});

test('parse — בלי כותרות שרשור ותאריך', () => {
  const m = M.parse(raw(['Subject: x', '', 'y']));
  assert.equal(m.messageId, null);
  assert.equal(m.date, null);
  assert.deepEqual(m.inReplyTo, []);
  assert.deepEqual(m.from, { address: '', name: '' });
});

test('parse — כותרת מקופלת', () => {
  const m = M.parse(raw(['Subject: חלק ראשון', '  וחלק שני', '', 'x']));
  assert.equal(m.subject, 'חלק ראשון וחלק שני');
});

test('parse — שורות חדשות LF בלבד', () => {
  const m = M.parse(Buffer.from('Subject: lf\n\nbody here\n', 'utf8'));
  assert.equal(m.subject, 'lf');
  assert.equal(m.text, 'body here');
});

test('parse — quoted-printable עם שבירת שורה רכה', () => {
  const m = M.parse(raw([
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=D7=A9=D7=9C=\r\n=D7=95=D7=9D a=3Db'
  ]));
  assert.equal(m.text, 'שלום a=b');
});

test('parse — base64 בעברית windows-1255', () => {
  const m = M.parse(raw([
    'Content-Type: text/plain; charset="windows-1255"',
    'Content-Transfer-Encoding: base64',
    '',
    SHALOM_1255.toString('base64')
  ]));
  assert.equal(m.text, 'שלום');
});

test('parse — multipart/alternative מעדיף טקסט פשוט', () => {
  const m = M.parse(raw([
    'Content-Type: multipart/alternative; boundary="BB"',
    '',
    'preamble',
    '--BB',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'פשוט',
    '--BB',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>מעוצב</p>',
    '--BB--',
    'epilogue'
  ]));
  assert.equal(m.text, 'פשוט');
  assert.deepEqual(m.attachments, []);
});

test('parse — HTML בלבד הופך לטקסט', () => {
  const m = M.parse(raw([
    'Content-Type: multipart/alternative; boundary=BB',
    '',
    '--BB',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>תשובה</p><div>On Mon, 9 Nov 2026, Dana wrote:</div><p>ציטוט</p>',
    '--BB--'
  ]));
  assert.match(m.text, /^תשובה\n/);
  assert.equal(m.newText, 'תשובה');
});

test('parse — קובץ מצורף base64 עם שם בקידוד RFC 2231', () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  const m = M.parse(raw([
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: text/plain',
    '',
    'מצורפת חשבונית',
    '--MIX',
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=utf-8''%D7%97%D7%A9%D7%91%D7%95%D7%A0%D7%99%D7%AA.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--MIX--'
  ]));
  assert.equal(m.text, 'מצורפת חשבונית');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'חשבונית.pdf');
  assert.equal(m.attachments[0].mime, 'application/pdf');
  assert.ok(m.attachments[0].data.equals(pdf));
});

test('parse — שם קובץ מפוצל ב-RFC 2231 ושם מ-name', () => {
  const m = M.parse(raw([
    'Content-Type: multipart/mixed; boundary=MIX',
    '',
    '--MIX',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename*0="long-"; filename*1="name.bin"',
    '',
    'DATA',
    '--MIX',
    'Content-Type: image/png; name="=?utf-8?B?16rXnteV16DXlA==?=.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.alloc(10, 1).toString('base64'),
    '--MIX--'
  ]));
  assert.deepEqual(m.attachments.map((a) => a.filename), ['long-name.bin', 'תמונה.png']);
});

test('parse — קובץ בלי שם מקבל שם לפי הסוג', () => {
  const m = M.parse(raw([
    'Content-Type: multipart/mixed; boundary=MIX',
    '',
    '--MIX',
    'Content-Type: application/vnd.ms-excel',
    '',
    'xx',
    '--MIX--'
  ]));
  assert.equal(m.attachments[0].filename, 'attachment.vndmsexcel');
});

test('parse — תמונה מוטמעת קטנה (לוגו) מושמטת, גדולה נשמרת', () => {
  const small = Buffer.alloc(100, 7).toString('base64');
  const big = Buffer.alloc(50 * 1024, 7).toString('base64');
  const m = M.parse(raw([
    'Content-Type: multipart/related; boundary=R',
    '',
    '--R',
    'Content-Type: image/png',
    'Content-Disposition: inline; filename=logo.png',
    'Content-Transfer-Encoding: base64',
    '',
    small,
    '--R',
    'Content-Type: image/jpeg',
    'Content-Disposition: inline; filename=scan.jpg',
    'Content-Transfer-Encoding: base64',
    '',
    big,
    '--R--'
  ]));
  assert.deepEqual(m.attachments.map((a) => a.filename), ['scan.jpg']);
  assert.equal(m.attachments[0].data.length, 50 * 1024);
});

test('parse — multipart מקונן ו-message/rfc822', () => {
  const m = M.parse(raw([
    'Content-Type: multipart/mixed; boundary=OUT',
    '',
    '--OUT',
    'Content-Type: multipart/alternative; boundary=IN',
    '',
    '--IN',
    'Content-Type: text/plain',
    '',
    'פנימי',
    '--IN--',
    '--OUT',
    'Content-Type: message/rfc822',
    '',
    'Subject: forwarded',
    '',
    'מועבר',
    '--OUT--'
  ]));
  // ה-CRLF שלפני הגבול נשאר בגוף החלק — משווים בלי CR
  assert.equal(m.text.replace(/\r/g, ''), 'פנימי\n\nמועבר');
});

test('parse — זיהוי מענה אוטומטי', () => {
  const body = ['', 'x'];
  assert.equal(M.parse(raw(['Auto-Submitted: auto-replied', ...body])).autoSubmitted, true);
  assert.equal(M.parse(raw(['Auto-Submitted: no', ...body])).autoSubmitted, false);
  assert.equal(M.parse(raw(['X-Autoreply: yes', ...body])).autoSubmitted, true);
  assert.equal(M.parse(raw(['X-Autorespond: 1', ...body])).autoSubmitted, true);
  assert.equal(M.parse(raw(['Precedence: bulk', ...body])).autoSubmitted, true);
  assert.equal(M.parse(raw(['Precedence: list', ...body])).autoSubmitted, false);
});

test('parse — כותרת כפולה מתחברת בפסיק', () => {
  const m = M.parse(raw(['To: a@x.com', 'To: b@x.com', '', 'x']));
  assert.equal(m.to, 'a@x.com, b@x.com');
});

test('slim — רק שם, סוג וגודל', () => {
  const s = M.slim({ subject: 's', attachments: [{ filename: 'a.pdf', mime: 'application/pdf', data: Buffer.alloc(5) }, { filename: 'b', mime: 'x/y', size: 9 }] });
  assert.equal(s.subject, 's');
  assert.deepEqual(s.attachments, [{ filename: 'a.pdf', mime: 'application/pdf', size: 5 }, { filename: 'b', mime: 'x/y', size: 9 }]);
});

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

test('fromGmail + finishGmail — טקסט, קובץ ולוגו', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Dana <Dana@X.com>' },
      { name: 'Subject', value: '=?utf-8?B?16nXnNeV150=?=' },
      { name: 'Message-ID', value: '<g1@x>' }
    ],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { size: 10, data: b64u('שלום\n> ישן') } },
        { mimeType: 'text/html', body: { size: 10, data: b64u('<p>שלום</p>') } }
      ] },
      { mimeType: 'application/pdf', filename: 'a.pdf', partId: '2', body: { size: 1234, attachmentId: 'ATT1' } },
      { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: { size: 500, attachmentId: 'ATT2' } },
      { mimeType: 'application/zip', filename: 'empty.zip', body: { size: 0 } }
    ]
  };
  const g = M.fromGmail(payload);
  assert.equal(g.headers.subject, '=?utf-8?B?16nXnNeV150=?=');
  assert.deepEqual(g.plain, ['שלום\n> ישן']);
  assert.deepEqual(g.html, ['<p>שלום</p>']);
  assert.equal(g.attachments.length, 1);
  assert.deepEqual({ ...g.attachments[0] }, { filename: 'a.pdf', mime: 'application/pdf', size: 1234, attachmentId: 'ATT1', partId: '2', data: null });
  const done = M.finishGmail(g);
  assert.equal(done.subject, 'שלום');
  assert.equal(done.from.address, 'dana@x.com');
  assert.equal(done.messageId, '<g1@x>');
  assert.equal(done.newText, 'שלום');
});

test('fromGmail — טקסט גדול ממתין למשיכה', () => {
  const g = M.fromGmail({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1255' }], body: { size: 900000, attachmentId: 'BIG' } });
  assert.deepEqual(g.plain, []);
  assert.deepEqual(g.pendingText, [{ type: 'text/plain', charset: 'windows-1255', attachmentId: 'BIG', size: 900000 }]);
});

test('fromGmail — קובץ עם נתונים מוטמעים מפוענח', () => {
  const g = M.fromGmail({ mimeType: 'application/pdf', body: { size: 3, data: b64u('abc') } });
  assert.equal(g.attachments[0].filename, 'attachment.pdf');
  assert.equal(g.attachments[0].data.toString(), 'abc');
});

test('fromGmail — קלט ריק', () => {
  const g = M.fromGmail(null);
  assert.deepEqual(g, { headers: {}, plain: [], html: [], attachments: [], pendingText: [] });
});

test('finishGmail — HTML בלבד וזיהוי מענה אוטומטי', () => {
  const done = M.finishGmail({ headers: { 'auto-submitted': 'auto-generated' }, plain: [], html: ['<p>היי</p>'], attachments: [] });
  assert.equal(done.text, 'היי');
  assert.equal(done.autoSubmitted, true);
  assert.equal(done.date, null);
});
