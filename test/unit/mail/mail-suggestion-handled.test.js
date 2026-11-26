'use strict';
/**
 * הערה של עובדת (25.11): "לפעמים רושם לי 'ההצעה כבר טופלה' ולא נותן לי ליצור את המשימה". ההודעה לא אמרה מה קרה.
 * עכשיו: הצעה שדולגה או נדחתה — אפשר ליצור ממנה משימה (העובדת פתחה אותה שוב בכוונה); הצעה שכבר נפתחה ממנה משימה
 * (ידנית, לבד או בבוט) או שצורפה למשימה — ההודעה אומרת לאיזו משימה, ולא נפתחת משימה כפולה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const MailScan = require('../../../server/mail/mail-scan');

boot();
MailScan.init({
  createTask: (actor, body) => Number(D.run(
    "INSERT INTO tasks (title, board_id, assignee_type, assignee_id, status, priority, created_at, created_by, status_changed_at) VALUES (?, 1, 'user', ?, 'new', 'normal', ?, ?, ?)",
    body.title, actor.id, D.nowIso(), actor.id, D.nowIso()).lastInsertRowid)
});

function suggestion(u, status = 'pending', taskId = null) {
  return Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, task_id, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', ?, ?, ?, ?, 'מורן', 'm@example.test', 'פרוטוקולים', ?, ?, ?)`,
    u.id, status, taskId, `g${Math.random()}`, `h${Math.random()}`, JSON.stringify({ title: 'לטפל בפרוטוקולים', people: [], checklist: [] }), D.nowIso(), D.nowIso()
  ).lastInsertRowid);
}

test('הצעה שדולגה / נדחתה — "יצירת המשימה" יוצרת משימה', () => {
  const u = user({ role: 'employee' });
  for (const st of ['skipped', 'rejected']) {
    const id = suggestion(u, st);
    const taskId = MailScan.approve(id, u, {});
    assert.ok(taskId, st);
    assert.equal(D.get('SELECT status FROM ai_suggestions WHERE id = ?', id).status, 'approved', st);
  }
});

test('הצעה שכבר נפתחה ממנה משימה — ההודעה אומרת איזו, בלי משימה כפולה', () => {
  const u = user({ role: 'employee' });
  const t = Number(D.run("INSERT INTO tasks (title, board_id, assignee_type, assignee_id, status, priority, created_at, created_by, status_changed_at) VALUES ('לטפל בפרוטוקולים', 1, 'user', ?, 'new', 'normal', ?, ?, ?)",
    u.id, D.nowIso(), u.id, D.nowIso()).lastInsertRowid);
  const before = D.get('SELECT COUNT(*) AS n FROM tasks').n;
  for (const st of ['approved', 'auto', 'joined']) {
    const id = suggestion(u, st, t);
    assert.throws(() => MailScan.approve(id, u, {}), (err) => new RegExp(`#${t}`).test(err.message) && /לטפל בפרוטוקולים/.test(err.message), st);
  }
  assert.equal(D.get('SELECT COUNT(*) AS n FROM tasks').n, before);
});
