'use strict';
/**
 * 🔎 מאיפה נפתחה משימה ממייל (20.11.26 — משימה ממייל של Google נפתחה לאיציק, ולא היה אפשר לדעת איך):
 *   • ביומן הפעולות של המשימה — איך: שולח מהימן / יצירה בלי אישור / ידנית באתר / "אשר הכול" / בבוט.
 *   • בהצעה (‎data.how‎) — ובייצוא של הסקירה הלילית (‎mailTasks‎), מוסווה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const MailScan = require('../../../server/mail/mail-scan');
const Review = require('../../../server/whatsapp/bot-review');

boot();
const created = [];
MailScan.init({
  createTask: (actor, body) => {
    const id = Number(D.run(
      "INSERT INTO tasks (title, board_id, assignee_type, assignee_id, status, priority, created_at, created_by, status_changed_at) VALUES (?, 1, 'user', ?, 'new', 'normal', ?, ?, ?)",
      body.title, actor.id, D.nowIso(), actor.id, D.nowIso()
    ).lastInsertRowid);
    created.push({ id, body });
    return id;
  }
});

function suggestion(u, title = 'לאשר בקשת איש קשר') {
  return Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, 'Google', 'no-reply@accounts.google.com', 'בקשה', ?, ?, ?)`,
    u.id, `g${Math.random()}`, `h${Math.random()}`, JSON.stringify({ title, people: [], checklist: [] }), D.nowIso(), D.nowIso()
  ).lastInsertRowid);
}
const howOf = (id) => JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', id).data).how;
const noteOf = () => created[created.length - 1].body.auditNote;

test('autoHow — שולח מהימן קודם למתג; בלי שניהם — אין יצירה לבד', () => {
  const { autoHow } = MailScan._internal;
  assert.equal(autoHow({ trusted: true, autoAll: true }), 'trusted');
  assert.equal(autoHow({ trusted: false, autoAll: true }), 'auto_all');
  assert.equal(autoHow({ trusted: false, autoAll: false }), null);
});

test('יצירה לבד — היומן אומר למה, וההצעה זוכרת', () => {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  for (const [how, re] of [['trusted', /השולח מסומן ⭐ "נוצר ישר"/], ['auto_all', /"ליצור משימות מהמייל בלי אישור" דולק/]]) {
    const id = suggestion(u);
    MailScan._internal.createFromSuggestion(MailScan.suggestionById(id), actor, { how });
    assert.match(noteOf(), /נוצרה ממייל של Google/);
    assert.match(noteOf(), re);
    assert.equal(howOf(id), how);
  }
});

test('אישור באתר — "אושרה ידנית"; "אשר הכול" — נרשם כך; בבוט — "אושרה בבוט"', async () => {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const a = suggestion(u);
  await MailScan.approve(a, actor, {});
  assert.match(noteOf(), /אושרה ידנית באתר/);
  assert.equal(howOf(a), 'manual');

  const b = suggestion(u);
  await MailScan.approve(b, actor, { how: 'bot' });
  assert.match(noteOf(), /אושרה בבוט/);
  assert.equal(howOf(b), 'bot');

  const c = suggestion(u);
  MailScan.approveAll(actor);
  assert.match(noteOf(), /אושרה ב"אשר הכול"/);
  assert.equal(howOf(c), 'approve_all');
});

test('how לא מוכר (למשל מהלקוח) — נרשם "ידנית", לא מתחזה ליצירה לבד', async () => {
  const u = user({ role: 'employee' });
  const id = suggestion(u);
  await MailScan.approve(id, Auth.loadActor('user', u.id), { how: 'trusted' });
  assert.equal(howOf(id), 'manual');
});

test('ייצוא הסקירה הלילית — mailTasks: מי, איך, מאיזה דומיין; בלי כתובת מלאה', async () => {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const id = suggestion(u, 'לאשר או לדחות בקשת איש קשר לשחזור חשבון Google');
  MailScan._internal.createFromSuggestion(MailScan.suggestionById(id), actor, { how: 'trusted' });
  D.run("UPDATE ai_suggestions SET status = 'auto', task_id = ?, decided_at = ? WHERE id = ?", created[created.length - 1].id, D.nowIso(), id);
  const out = Review.exportSince(new Date(Date.now() - 3600000).toISOString());
  const row = out.mailTasks.find((x) => x.suggestionId === id);
  assert.ok(row);
  assert.equal(row.userId, u.id);
  assert.equal(row.how, 'trusted');
  assert.equal(row.status, 'auto');
  assert.equal(row.fromDomain, 'accounts.google.com');
  assert.equal(row.taskId, created[created.length - 1].id);
  assert.ok(!JSON.stringify(row).includes('no-reply@'), 'בלי כתובת מלאה');
});
