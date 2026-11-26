'use strict';
/**
 * 💰 דיאטת קלט במשימות AI ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 9, שלב ד'): עד 3 קבצים ועד 25 עמודי PDF בהכרעה
 * אחת (מה שלא נשלח — נמסר בשמו), ובהקשר — 8 ההודעות האחרונות במלואן והישנות בשורה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const AiTasks = require('../../../server/tasks/ai-tasks');

boot();
const { pdfPages, fileBlocks, contextText } = AiTasks._internal;

/** PDF מזויף עם ‎n‎ עמודים — מספיק למונה (לא קובץ תקין) */
const pdf = (n, name = `doc${n}.pdf`) => ({
  name, mime: 'application/pdf',
  data: Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Pages /Count ${n} >> endobj\n${Array.from({ length: n }, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`).join('\n')}`, 'latin1')
});
const img = (name) => ({ name, mime: 'image/png', data: Buffer.alloc(1000) });

test('מונה העמודים: אובייקטי ‎/Page‎, ואם אין — ‎/Count‎, ואם אין — לפי הגודל', () => {
  assert.equal(pdfPages(pdf(7).data), 7);
  assert.equal(pdfPages(Buffer.from('%PDF-1.5 << /Type /Pages /Count 40 >>', 'latin1')), 40);
  assert.equal(pdfPages(Buffer.alloc(350 * 1024)), 4);
});

test('קבצים קצרים — נשלחים כולם', () => {
  const r = fileBlocks([pdf(2), img('a.png')]);
  assert.equal(r.blocks.length, 2);
  assert.deepEqual(r.notSent, []);
});

test('PDF ארוך מהתקרה — לא נשלח, ונמסר בשמו ובמספר העמודים', () => {
  const r = fileBlocks([pdf(3, 'form.pdf'), pdf(60, 'contract.pdf')]);
  assert.deepEqual(r.blocks.map((b) => b.title), ['form.pdf']);
  assert.deepEqual(r.notSent, ['contract.pdf (60 עמודים)']);
});

test('התקרה מצטברת: 20 + 10 עמודים — השני לא נכנס', () => {
  const r = fileBlocks([pdf(20, 'a.pdf'), pdf(10, 'b.pdf'), pdf(5, 'c.pdf')]);
  assert.deepEqual(r.blocks.map((b) => b.title), ['a.pdf', 'c.pdf']);
  assert.deepEqual(r.notSent, ['b.pdf (10 עמודים)']);
});

test('עד 3 קבצים', () => {
  const r = fileBlocks([img('1.png'), img('2.png'), img('3.png'), img('4.png')]);
  assert.equal(r.blocks.length, 3);
  assert.deepEqual(r.notSent, ['4.png']);
});

test('ההקשר: 8 אחרונות במלואן (עד 1500 תווים), הישנות — שורה אחת', (t) => {
  const owner = user();
  D.run('PRAGMA foreign_keys = OFF');
  t.after(() => D.run('PRAGMA foreign_keys = ON'));
  const reqId = 900000 + owner.id;
  for (let i = 1; i <= 12; i++) {
    D.run("INSERT INTO ai_messages (request_id, direction, channel, kind, status, subject, body, created_at, sent_at) VALUES (?, 'in', 'email', 'inbound', 'received', ?, ?, ?, ?)",
      reqId, `נושא ${i}`, `גוף ${i} ${'א'.repeat(3000)}`, `2026-11-${String(i).padStart(2, '0')}T08:00:00Z`, `2026-11-${String(i).padStart(2, '0')}T08:00:00Z`);
  }
  const text = contextText({ id: reqId, owner_id: owner.id, instruction: 'לבקש טופס 4', contact_name: 'דני' });
  assert.match(text, /4 הודעות קודמות בקצרה/);
  assert.match(text, /- \[2026-11-01\] נכנסה · נושא 1: גוף 1/);
  assert.equal((text.match(/^--- \[/gm) ?? []).length, 8, '8 במלואן');
  const longest = Math.max(...text.split('\n').map((l) => l.length));
  assert.ok(longest <= 1500, `שורה ארוכה מדי: ${longest}`);
});
