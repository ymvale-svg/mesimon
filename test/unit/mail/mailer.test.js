'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Mailer = require('../../../server/integrations/mailer');

const b64decode = (s) => Buffer.from(s.replace(/\r\n/g, ''), 'base64').toString('utf8');
/** החלקים בבסיס 64 שבהודעה, לפי הסדר */
const parts = (raw) => [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:Content-Disposition:[^\r]*\r\n)?\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) => m[1]);
const header = (raw, name) => raw.split('\r\n\r\n')[0].split('\r\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);

const base = { from: 'noreply@org.test', to: 'dana@x.test', subject: 'Hello', text: 'שלום', html: '<p>שלום</p>' };

test('בלי SMTP — כבוי, והסטטוס אומר את זה', () => {
  assert.equal(Mailer.isEnabled(), false);
  const s = Mailer.status();
  assert.equal(s.enabled, false);
  assert.equal(s.host, null);
  assert.equal(s.port, 587);
});

test('send בלי הגדרה — נדחה בלי לפנות לרשת', async () => {
  await assert.rejects(Mailer.send(base), /אינה מוגדרת/);
});

test('buildMessage — כותרות בסיס ו-Message-ID לפי הדומיין של השולח', () => {
  const { messageId, raw } = Mailer.buildMessage(base);
  assert.match(messageId, /^<[a-z0-9]+\.[0-9a-f]{16}@org\.test>$/);
  assert.equal(header(raw, 'From'), 'noreply@org.test');
  assert.equal(header(raw, 'To'), 'dana@x.test');
  assert.equal(header(raw, 'Subject'), 'Hello');
  assert.equal(header(raw, 'Message-ID'), messageId);
  assert.equal(header(raw, 'MIME-Version'), '1.0');
  assert.match(header(raw, 'Content-Type'), /^multipart\/alternative/);
  assert.equal(header(raw, 'Reply-To'), undefined);
  assert.equal(header(raw, 'Cc'), undefined);
});

test('buildMessage — נושא ושם בעברית בקידוד RFC 2047', () => {
  const { raw } = Mailer.buildMessage({ ...base, subject: 'משימה חדשה', fromName: 'משימון', toName: 'דנה' });
  const subj = header(raw, 'Subject');
  assert.match(subj, /^=\?UTF-8\?B\?.+\?=$/);
  assert.equal(Buffer.from(subj.slice(10, -2), 'base64').toString('utf8'), 'משימה חדשה');
  assert.match(header(raw, 'From'), /^=\?UTF-8\?B\?.+\?= <noreply@org\.test>$/);
  assert.match(header(raw, 'To'), /<dana@x\.test>$/);
});

test('buildMessage — שורה חדשה בנושא לא מזריקה כותרת', () => {
  const { raw } = Mailer.buildMessage({ ...base, subject: 'Hi\r\nBcc: evil@x.test', to: 'dana@x.test\nBcc: evil@x.test' });
  const head = raw.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/m.test(head));
  assert.equal(header(raw, 'Subject'), 'Hi Bcc: evil@x.test');
});

test('buildMessage — העתק בלי הנמען הראשי, ו-Reply-To עם שם', () => {
  const { raw } = Mailer.buildMessage({ ...base, cc: ['DANA@x.test', 'boss@x.test', ''], replyTo: 'me@org.test', replyToName: 'Me' });
  assert.equal(header(raw, 'Cc'), 'boss@x.test');
  assert.equal(header(raw, 'Reply-To'), 'Me <me@org.test>');
});

test('buildMessage — שרשור: In-Reply-To ו-References', () => {
  const { raw } = Mailer.buildMessage({ ...base, inReplyTo: '<a@x>', references: ['<z@x>', '<a@x>'] });
  assert.equal(header(raw, 'In-Reply-To'), '<a@x>');
  assert.equal(header(raw, 'References'), '<z@x> <a@x>');
});

test('buildMessage — הגוף בטקסט וב-HTML חוזר בדיוק אחרי פענוח', () => {
  const text = 'שורה ארוכה '.repeat(30);
  const { raw } = Mailer.buildMessage({ ...base, text, html: '<b>שלום</b>' });
  const [plain, html] = parts(raw);
  assert.equal(b64decode(plain), text);
  assert.equal(b64decode(html), '<b>שלום</b>');
  for (const line of plain.split('\r\n')) assert.ok(line.length <= 76);
});

test('buildMessage — קובץ מצורף הופך את ההודעה ל-multipart/mixed', () => {
  const { raw } = Mailer.buildMessage({ ...base, attachments: [{ buf: Buffer.from('PDFDATA'), fileName: 'הצעה.pdf', mime: 'application/pdf' }, { fileName: 'בלי תוכן' }] });
  assert.match(header(raw, 'Content-Type'), /^multipart\/mixed/);
  assert.equal((raw.match(/Content-Disposition: attachment/g) ?? []).length, 1, 'קובץ בלי תוכן מדולג');
  assert.match(raw, /Content-Type: application\/pdf; name="=\?UTF-8\?B\?/);
  assert.ok(raw.includes(Buffer.from('PDFDATA').toString('base64')));
});
