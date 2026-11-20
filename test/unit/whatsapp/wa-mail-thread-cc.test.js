'use strict';
/**
 * תשובה בשרשור — העתק רק כשביקשו. סקירה 18.11: "תשלח להיתם שהישיבה מבוטלת" נבנה כתשובה לזימון הפגישה עם 6 בהעתק
 * (העובד ביטל), ו"תענה למרק" יצא עם כל השרשור בהעתק — והעובד הוריד אותו פעמיים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const { Gmail } = require('../../../server/integrations');
const AiTasks = require('../../../server/tasks/ai-tasks');
const MailThread = require('../../../server/mail/mail-thread');
const WaMail = require('../../../server/whatsapp/wa-mail');
const { emailText } = require('../../../server/whatsapp/wa-base');

boot();

const PEOPLE = [{ name: 'גלעד', email: 'g@x.test' }, { name: 'אלכס', email: 'a@x.test' }, { name: 'בני', email: 'b@x.test' }];
const THREAD = { box: 'me', threadId: 't1', subject: 'נושאים לישיבת הנהלה', inReplyTo: '<m1>', references: '<m1>', lastAt: '2026-11-18T10:00:00Z', count: 3, lastFrom: { name: 'מרק', email: 'mark@x.test' }, people: PEOPLE };
const CONTACT = { type: 'contact', name: 'מרק', email: 'mark@x.test' };

function world(t, { body = 'נושא לדיון: גיוס מנהל לוגיסטי.' } = {}) {
  t.mock.method(AiTasks, 'mailContext', async () => '');
  t.mock.method(AiTasks, 'draftInitial', async () => ({ title: 'נושא לישיבה', goal: '', success_criteria: '', subject: 'x', body, suggestions: [], notes: '', cc_names: [], reply_thread: 1 }));
  t.mock.method(MailThread, 'recentThreads', async () => [THREAD]);
  t.mock.method(MailThread, 'threadCc', () => PEOPLE);
  t.mock.method(Gmail, 'signatureInfo', async () => ({ state: 'ok' }));
  const u = user({ role: 'employee' });
  return Auth.loadActor('user', u.id);
}

test('תשובה בשרשור לאדם אחד — בלי ההעתק של השרשור, והטיוטה אומרת שאפשר "לכולם"', async (t) => {
  const actor = world(t);
  const p = await WaMail.draftEmail(actor, CONTACT, 'תענה למרק על המייל שלו בנושא ישיבת הנהלה: גיוס מנהל לוגיסטי');
  assert.equal(p.replyThread?.subject, 'נושאים לישיבת הנהלה', 'עדיין בהמשך לשרשור');
  assert.deepEqual(p.cc, []);
  const text = emailText(p);
  assert.doesNotMatch(text, /בהעתק:/);
  assert.match(text, /בשרשור יש עוד 3 \(גלעד, אלכס, בני\) — לא בהעתק\. \*לכולם\*/);
});

test('"תענה לכולם" — מי שבשרשור בהעתק', async (t) => {
  const actor = world(t);
  const p = await WaMail.draftEmail(actor, CONTACT, 'תענה לכולם בשרשור של מרק שהישיבה נדחית');
  assert.deepEqual(p.cc.map((c) => c.email), PEOPLE.map((c) => c.email));
  assert.doesNotMatch(emailText(p), /לא בהעתק/);
});

test('"לכולם" כתיקון לטיוטה — מצרף את מי שבשרשור', async (t) => {
  const actor = world(t);
  const first = await WaMail.draftEmail(actor, CONTACT, 'תענה למרק שהישיבה נדחית');
  const p = await WaMail.draftEmail(actor, CONTACT, first.instruction, { feedback: 'לכולם', previous: first });
  assert.deepEqual(p.cc.map((c) => c.email), PEOPLE.map((c) => c.email));
});

test('זימון פגישה מהיומן אינו שרשור לתשובה', () => {
  for (const s of ['ההזמנה עודכנה: סטאטוס בדק- פגישה במשרד', 'הזמנה: כ"א מחלקת התחדשות', 'Invitation: Weekly sync', 'Updated invitation: Status', 'Accepted: Weekly', 'Re: ההזמנה עודכנה: סטאטוס', 'האירוע בוטל: ישיבה'])
    assert.ok(MailThread.isCalendarNotice(s), s);
  for (const s of ['נושאים לישיבת הנהלה', 'Re: הזמנת רכש 4411', 'הזמנה לפגישה בנושא חוזה', 'Invitation to tender'])
    assert.ok(!MailThread.isCalendarNotice(s), s);
});
