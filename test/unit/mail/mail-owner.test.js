'use strict';
/**
 * 👤 בעל המייל (‎server/mail/mail-owner.js‎) — מייל לכמה נמענים: רק אחד מקבל תזכורת והצעת תשובה.
 * "תוכנית — חלוקת תפקידים בוט ומשימון.md", סעיף 1 (הוחלט 15.11.26).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Owner = require('../../../server/mail/mail-owner');
const MailPush = require('../../../server/mail/mail-push');

boot();

let n = 0;
const uniq = () => `${Date.now()}-${++n}`;
function dept(name, managerId = null) {
  return Number(D.run("INSERT INTO departments (name, manager_user_id, status, created_at) VALUES (?, ?, 'active', ?)", `${name}-${uniq()}`, managerId, D.nowIso()).lastInsertRowid);
}
const person = (over = {}) => user({ role: 'employee', email: `p${uniq()}@org.test`, ...over });
const to = (...us) => us.map((u) => `${u.full_name} <${u.email}>`).join(', ');

test('נמען יחיד ב-"אל" — הוא הבעלים', () => {
  const a = person();
  assert.deepEqual(Owner.decide({ to: to(a) }), { userId: a.id, reason: 'only', bulk: false });
});

test('אין משתמש משימון ב-"אל" (רק בהעתק) — אין בעלים', () => {
  assert.equal(Owner.decide({ to: 'stranger@x.test' }).userId, null);
});

test('10 נמענים, נושא של תפעול — רק מנהל התפעול, גם כשאינו ראשון', () => {
  const crew = Array.from({ length: 9 }, () => person());
  const boss = person();
  const ops = dept('תפעול', boss.id);
  D.run('UPDATE users SET department_id = ? WHERE id = ?', ops, boss.id);
  const r = Owner.decide({ to: to(...crew, boss), departmentId: ops });
  assert.equal(r.userId, boss.id);
  assert.equal(r.reason, 'dept_manager');
  assert.equal(r.bulk, true, 'יותר מ-6 ב-"אל" — תפוצה');
});

test('המייל פונה לאחד בשמו — הוא, גם כשמנהל המחלקה בין הנמענים', () => {
  const boss = person();
  const dani = person();
  const plan = dept('תכנון', boss.id);
  assert.equal(Owner.decide({ to: to(boss, dani), addressedTo: dani.email, departmentId: plan }).userId, dani.id);
});

test('מנהל המחלקה אינו בין הנמענים — הנמען מאותה מחלקה', () => {
  const boss = person();
  const plan = dept('תכנון', boss.id);
  const other = person();
  const planner = person({ department_id: plan });
  assert.equal(Owner.decide({ to: to(other, planner), departmentId: plan }).userId, planner.id);
});

test('נושא לא ברור — מי שכבר טיפל במיילים מהשולח; אחרת הראשון ב-"אל"', () => {
  const a = person();
  const b = person();
  assert.equal(Owner.decide({ to: to(a, b), fromEmail: 'client@x.test' }).userId, a.id);
  D.run("INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_email, data, created_at) VALUES (?, 'task', 'approved', 'g', 'h', 'client@x.test', '{}', ?)", b.id, D.nowIso());
  const r = Owner.decide({ to: to(a, b), fromEmail: 'client@x.test' });
  assert.equal(r.userId, b.id);
  assert.equal(r.reason, 'correspondent');
});

test('mayPush — רק לבעלים; ההכרעה הראשונה נשמרת לכל התיבות', () => {
  const a = person();
  const b = person();
  const h = `<m-${uniq()}@x>`;
  Owner.assign(h, { userId: a.id, reason: 'first', bulk: false });
  Owner.assign(h, { userId: b.id, reason: 'first', bulk: false });
  assert.equal(Owner.mayPush(a.id, h), true);
  assert.equal(Owner.mayPush(b.id, h), false);
  assert.equal(Owner.mayPush(b.id, '<old-mail@x>'), true, 'מייל מלפני השינוי — כמו קודם');
});

test('עובד מהארגון ענה בשרשור — לא מזכירים לאף אחד, גם לא לבעלים', () => {
  const a = person();
  const b = person();
  const h = `<m-${uniq()}@x>`;
  Owner.assign(h, { userId: a.id, reason: 'first', bulk: false });
  assert.equal(Owner.noteOrgReply('outsider@x.test', [h]), 0, 'תשובה מבחוץ — לא נחשבת');
  assert.equal(Owner.mayPush(a.id, h), true);
  Owner.noteOrgReply(b.email, [h]);
  assert.equal(Owner.mayPush(a.id, h), false);
});

test('תפוצה — יש בעלים (לקבלת סחורה / טופס), אבל בלי תזכורות', () => {
  const a = person();
  const h = `<m-${uniq()}@x>`;
  Owner.assign(h, { userId: a.id, reason: 'first', bulk: true });
  assert.equal(Owner.isOwner(a.id, h), true);
  assert.equal(Owner.mayPush(a.id, h), false);
});

test('"זה שלי" — עובד לוקח את המייל, ומקבל עליו תזכורות', () => {
  const a = person();
  const b = person();
  const h = `<m-${uniq()}@x>`;
  Owner.assign(h, { userId: a.id, reason: 'first', bulk: true });
  Owner.take(b.id, h);
  assert.equal(Owner.mayPush(b.id, h), true);
  assert.equal(Owner.mayPush(a.id, h), false);
});

test('MailPush.direct — הצעה על מייל שאינו שלי לא קופצת בוואטסאפ, גם כשאני ב-"אל"', () => {
  const a = person();
  const b = person();
  const h = `<m-${uniq()}@x>`;
  Owner.assign(h, { userId: a.id, reason: 'first', bulk: false });
  const row = (u) => ({ user_id: u.id, header_id: h, from_email: 'client@x.test', data: { toMe: true } });
  assert.equal(MailPush.direct(row(a)), true);
  assert.equal(MailPush.direct(row(b)), false);
});
