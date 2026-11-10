'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const TaskMail = require('../../../server/mail/task-mail');
const Mailer = require('../../../server/integrations/mailer');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד בדיקה', ...o });

const task = { id: 7, title: 'בדיקת <לוח> חשמל', priority: 'urgent', due_date: '2026-11-12T15:00:00Z', description: 'שורה 1\nשורה 2' };

test('buildEmail — נושא, שורות פרטים ועדיפות בעברית', () => {
  const m = TaskMail.buildEmail({ recipientName: 'דנה', assignerName: 'יוסי', orgName: 'אשל', task, projectName: 'מגדל', statusLabel: 'לביצוע', link: 'https://m.test/?task=7', replyTo: 'yossi@x.test' });
  assert.equal(m.subject, 'הוקצתה לך משימה: בדיקת <לוח> חשמל');
  assert.ok(m.text.includes('עדיפות: דחוף'));
  assert.ok(m.text.includes('פרויקט: מגדל'));
  assert.ok(m.text.includes('סטטוס: לביצוע'));
  assert.ok(m.text.includes(`תאריך יעד: ${new Date(task.due_date).toLocaleDateString('he-IL')}`));
  assert.ok(m.text.includes('https://m.test/?task=7'));
  assert.ok(m.text.includes('התשובה תגיע ליוסי'));
});

test('buildEmail — ה-HTML בורח מקלט המשתמש', () => {
  const m = TaskMail.buildEmail({ recipientName: '<script>', assignerName: 'יוסי', orgName: 'אשל', task, link: null });
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(m.html.includes('בדיקת &lt;לוח&gt; חשמל'));
});

test('buildEmail — בלי קישור: הפניה ל"המשימות שלי", ובלי replyTo: הודעה אוטומטית', () => {
  const m = TaskMail.buildEmail({ recipientName: 'דנה', assignerName: 'יוסי', orgName: 'אשל', task: { title: 'x', priority: 'normal' }, link: null, replyTo: null });
  assert.ok(m.text.includes('המשימות שלי'));
  assert.ok(!m.html.includes('פתיחת המשימה'));
  assert.ok(m.text.includes('אין להשיב'));
});

test('buildEmail — שורות בלי ערך לא מוצגות', () => {
  const m = TaskMail.buildEmail({ recipientName: 'דנה', assignerName: '', orgName: 'אשל', task: { title: 'x', priority: 'normal', due_date: 'לא תאריך' } });
  assert.ok(!m.text.includes('פרויקט:'));
  assert.ok(!m.text.includes('תאריך יעד:'));
  assert.ok(!m.text.includes('הוקצתה על ידי:'));
  assert.ok(m.text.includes('עדיפות: רגיל'));
});

test('sendAssignment — בלי SMTP לא שולח', async () => {
  const u = user();
  assert.equal(await TaskMail.sendAssignment({ task: { id: 1, title: 'x' }, assigneeType: 'user', assigneeId: u.id, assigner: null }), false);
});

test('sendAssignment — עם דואר (מזויף): נשלח לאחראי עם Reply-To של המקצה', async (t) => {
  const sent = [];
  t.mock.method(Mailer, 'isEnabled', () => true);
  t.mock.method(Mailer, 'send', async (m) => { sent.push(m); return '<id@x>'; });
  D.setSetting('public_url', 'https://mesimon.test///');
  const assignee = user({ full_name: 'דנה לוי' });
  const assigner = { id: user().id, name: 'יוסי', email: 'yossi@x.test' };
  const ok = await TaskMail.sendAssignment({ task: { id: 55, title: 'לבדוק', priority: 'high', board_id: 1, status: 'todo', project_id: null }, assigneeType: 'user', assigneeId: assignee.id, assigner });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, assignee.email);
  assert.equal(sent[0].replyTo, 'yossi@x.test');
  assert.ok(sent[0].text.includes('https://mesimon.test/?task=55'));
});

test('sendAssignment — מי שהקצה לעצמו, או כיבה מייל, לא מקבל', async (t) => {
  const send = t.mock.method(Mailer, 'send', async () => '<id@x>');
  t.mock.method(Mailer, 'isEnabled', () => true);
  const me = user();
  assert.equal(await TaskMail.sendAssignment({ task: { id: 1, title: 'x' }, assigneeType: 'user', assigneeId: me.id, assigner: { id: me.id, name: 'אני' } }), false);
  const quiet = user();
  D.setUserPref(quiet.id, 'assignChannels', { email: false });
  assert.equal(await TaskMail.sendAssignment({ task: { id: 1, title: 'x' }, assigneeType: 'user', assigneeId: quiet.id, assigner: null }), false);
  assert.equal(send.mock.callCount(), 0);
});

test('sendAssignment — תקלת שליחה אינה זורקת', async (t) => {
  t.mock.method(Mailer, 'isEnabled', () => true);
  t.mock.method(Mailer, 'send', async () => { throw new Error('SMTP נפל'); });
  t.mock.method(console, 'error', () => {});
  const u = user();
  assert.equal(await TaskMail.sendAssignment({ task: { id: 1, title: 'x' }, assigneeType: 'user', assigneeId: u.id, assigner: null }), false);
});
