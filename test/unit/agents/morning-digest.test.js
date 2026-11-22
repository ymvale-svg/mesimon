'use strict';
/**
 * ☀️ סיכום הבוקר — אחד, ולא עמוס (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 5.4).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const DayDigest = require('../../../server/agents/day-digest');
const WaUi = require('../../../server/whatsapp/wa-ui');

boot();

const board = () => D.get('SELECT id FROM boards ORDER BY id LIMIT 1')?.id;
const openStatus = (b) => D.get('SELECT key FROM board_columns WHERE board_id = ? AND is_final = 0 ORDER BY position LIMIT 1', b)?.key;
function task(u, title, daysAgo) {
  const b = board();
  const cols = D.all('PRAGMA table_info(tasks)').map((c) => c.name);
  const row = { title, board_id: b, status: openStatus(b), assignee_type: 'user', assignee_id: u.id, created_by: u.id,
    due_date: new Date(Date.now() - daysAgo * 86400000).toISOString(), created_at: D.nowIso(), updated_at: D.nowIso(), status_changed_at: D.nowIso() };
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  D.run(`INSERT INTO tasks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}
function mail(u, from) {
  const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  D.run(`INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
         VALUES (?, 'task', 'pending', ?, ?, ?, 'x@client.test', 'נושא', ?, ?, ?)`, u.id, `g${Math.random()}`, `<h${Math.random()}@x>`, from, JSON.stringify({ title: 'נושא', toMe: true }), at, at);
}

test('יום ריק — שורה אחת', async () => {
  const u = user({ full_name: 'ישראל ישראלי' });
  const m = await DayDigest.morning(u.id);
  assert.equal(m.text.split('\n').length, 1);
  assert.match(m.text, /בוקר טוב ישראל.*אין היום שום דבר דחוף/);
  assert.equal(m.buttons, undefined);
});

test('יום עמוס — עד 10 שורות, כל חלק בשורה אחת עם עד 3 פריטים ו"ועוד"', async () => {
  const u = user({ full_name: 'ישראל ישראלי' });
  for (let i = 0; i < 12; i++) task(u, `משימה ${i}`, i % 2 ? 2 : 0);
  for (let i = 0; i < 9; i++) mail(u, `שולח ${i}`);
  const events = async () => Array.from({ length: 6 }, (_, i) => ({ title: `פגישה ${i}`, start: new Date(Date.now() + (i + 1) * 3600000).toISOString(), end: new Date(Date.now() + (i + 2) * 3600000).toISOString() }));
  const m = await DayDigest.morning(u.id, { events });
  const lines = m.text.split('\n');
  assert.ok(lines.length <= 10, `${lines.length} שורות`);
  const tasksLine = lines.find((l) => l.startsWith('🔥'));
  assert.equal((tasksLine.match(/ · /g) ?? []).length, 2, 'עד 3 משימות בשורה');
  assert.match(tasksLine, /ועוד 9/);
  assert.match(lines.find((l) => l.startsWith('📅')), /ועוד 3/);
  assert.match(m.text, /📬 9 מיילים מחכים לתשובה ממך/);
  assert.match(m.text, /💡 \d+ הצעות משימה במשימון/);
  assert.deepEqual(m.buttons, [WaUi.mailWalkLabel(9), '☀️ מה יש לי היום']);
});

test('חלק ריק לא מופיע; בלי מיילים — בלי כפתור המיילים', async () => {
  const u = user({ full_name: 'דנה' });
  task(u, 'דוח לעירייה', 0);
  const m = await DayDigest.morning(u.id);
  assert.match(m.text, /🔥 דוח לעירייה/);
  assert.doesNotMatch(m.text, /📅|📬|⏳|⏰|💡/);
  assert.deepEqual(m.buttons, ['☀️ מה יש לי היום']);
});
