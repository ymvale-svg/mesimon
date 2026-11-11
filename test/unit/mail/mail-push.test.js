'use strict';
/**
 * 📬 מה מהמייל מגיע לוואטסאפ (הוחלט 11.11.26):
 *   • מייל חדש — רק כשיש הצעת תשובה קונקרטית: "קיבלת מייל מדני: <במשפט>. לענות כך?"
 *   • תזכורות — עד 5 ביום; מייל שענית עליו — לא מזכירים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Ports = require('../../../server/core/ports');
const Gmail = require('../../../server/integrations').Gmail;
const MailActions = require('../../../server/mail/mail-actions');
const MailPush = require('../../../server/mail/mail-push');

boot();
Ports.provide('mailPush', MailPush);
D.setSetting('remind_hours', '00:00-24:00');

const HOUR = 3600 * 1000;

function suggestion(u, { gmailId, hoursAgo = 30, data = {} }) {
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  D.setSetting('mail_remind_since', new Date(Date.now() - 100 * HOUR).toISOString());
  const info = D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, 'דני כהן', 'dani@x.co', 'הצעת מחיר', ?, ?, ?)`,
    u.id, gmailId, `h-${gmailId}`, JSON.stringify({ title: 'לאשר הצעת מחיר', priority: 'urgent', dueDate: '2000-01-01', toMe: true, ...data }), at, at
  );
  return Number(info.lastInsertRowid);
}

test('קצב רגיל — עד 5 תזכורות ביום; "מעט" — אחת', () => {
  assert.equal(MailActions.PACE.normal.max, 5);
  assert.equal(MailActions.PACE.light.max, 1);
});

test('אחרי 5 תזכורות היום — אין עוד תזכורת, אבל הצעת תשובה עדיין מותרת (לא נספרת בתקרה)', async () => {
  const u = user();
  for (let i = 0; i < 4; i++) MailActions.paceTick(u.id);
  D.run('UPDATE reminder_pace SET last_at = ? WHERE user_id = ?', new Date(Date.now() - 2 * HOUR).toISOString(), u.id);
  assert.equal(await MailActions.mayRemindNow(u.id), true, 'הרביעית — עוד מותר');
  MailActions.paceTick(u.id);
  D.run('UPDATE reminder_pace SET last_at = ? WHERE user_id = ?', new Date(Date.now() - 2 * HOUR).toISOString(), u.id);
  assert.equal(await MailActions.mayRemindNow(u.id), false, 'החמישית נשלחה — די להיום');
  assert.equal(await MailActions.mayAlertNow(u.id), true);
});

test('הצעת תשובה — לא באמצע שיחה, ולא למי שבחר "רק בבוקר"', async () => {
  const u = user();
  MailActions.noteUser(u.id);
  assert.equal(await MailActions.mayAlertNow(u.id), false);
  const v = user();
  D.setUserPref(v.id, 'botPrefs', { remindPace: 'morning' });
  assert.equal(await MailActions.mayAlertNow(v.id), false);
});

test('concreteReply — רק נוסח של ממש, שלא נשלח ושלא נאמר עליו שהמייל לא מצפה לתשובה', () => {
  assert.equal(MailPush.concreteReply({ body: 'שלום דני, ההצעה מאושרת. נשלח הזמנה עד יום ה׳.' }), true);
  assert.equal(MailPush.concreteReply({ body: 'תודה', missing: 'נראה שהמייל לא מצפה לתשובה' }), false);
  assert.equal(MailPush.concreteReply({ body: '[תשובה]' }), false);
  assert.equal(MailPush.concreteReply({ body: 'שלום דני, ההצעה מאושרת.', sent: '2026-11-11' }), false);
  assert.equal(MailPush.concreteReply(null), false);
});

test('replyAlert — במשפט מי כתב ומה ביקש, והתשובה המוצעת; בלי "שלום" ובלי נושא', () => {
  const text = MailPush.replyAlert(
    { from_name: 'דני כהן', subject: 'הצעת מחיר', d: { summary: 'מבקש לאשר את הצעת המחיר לפרויקט עד יום ה׳. מצורף קובץ. ועוד פרטים.' } },
    { body: 'שלום דני, ההצעה מאושרת. נשלח הזמנה מסודרת עד יום ה׳.', missing: '' }
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '📧 קיבלת מייל מ*דני כהן*: מבקש לאשר את הצעת המחיר לפרויקט עד יום ה׳.');
  assert.ok(text.includes('*לענות כך?*'));
  assert.ok(text.includes('_שלום דני, ההצעה מאושרת. נשלח הזמנה מסודרת עד יום ה׳._'));
  assert.ok(!/שלום .*👋/.test(text));
  assert.ok(!text.includes('מצורף קובץ'), 'רק המשפט הראשון');
});

test('תזכורת — לא על מייל שענית עליו ב-Gmail', async (t) => {
  const u = user();
  const answered = suggestion(u, { gmailId: 'g-answered' });
  const open = suggestion(u, { gmailId: 'g-open' });
  t.mock.method(Gmail, 'handle', (userId, box) => `${userId}:${box}`);
  t.mock.method(Gmail, 'threadOf', async (who, gmailId) => {
    const got = new Date(Date.now() - 30 * HOUR);
    const src = { id: gmailId, labels: ['INBOX'], at: got };
    return gmailId === 'g-answered' ? [src, { id: 'mine', labels: ['SENT'], at: new Date() }] : [src];
  });
  const due = await MailActions.dueReminders(u.id);
  assert.deepEqual(due.map((r) => r.id), [open]);
  const d = JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', answered).data);
  assert.equal(d.remind.closed, 'answered');
});
