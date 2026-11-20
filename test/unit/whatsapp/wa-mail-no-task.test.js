'use strict';
/**
 * 18.11: "תענה למרק פלדמן…" ← 👍 — כל מייל שיצא מהבוט פתח משימת AI (משימות 587, 588 בלוח של ישראל).
 * הבוט הוא המזכירה: מייל רגיל יוצא ישר מ-Gmail, בלי משימה, עם מעקב "📬 ענה למייל ששלחת" (‎ReplyWatch‎).
 * משימה — רק כשביקשו במילים ("ותעקוב", "תפתח משימה"), מהצעה, על משימה קיימת, או לעובד "במשימון".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const WaMail = require('../../../server/whatsapp/wa-mail');
const { hooks } = require('../../../server/whatsapp/wa-base');
const MailInsights = require('../../../server/mail/mail-insights');

boot();

const pendingFor = (extra = {}) => ({
  kind: 'email', channel: 'email', via: 'email',
  instruction: 'תענה למרק פלדמן על המייל שלו בנושא ישיבת הנהלה',
  contact: { name: 'מרק פלדמן', email: 'mark@example.test', type: 'external' },
  draft: { title: 'נושאים לישיבת הנהלה', subject: 'Re: נושאים לישיבת הנהלה', body: 'שלום מרק, ...' },
  cc: [{ name: 'דנה', email: 'dana@example.test' }], ccAsk: [],
  replyThread: { box: 0, threadId: 't1', subject: 'נושאים לישיבת הנהלה', inReplyTo: '<m1@x>', references: ['<m1@x>'] },
  ...extra
});

function mocks(t) {
  const sent = [];
  const tasks = [];
  t.mock.method(MailInsights, 'sendReply', async (uid, r) => { sent.push(r); return { gmailId: 'g9', threadId: r.threadId || 'tNew' }; });
  const prev = hooks.mail;
  hooks.mail = { ...(prev ?? {}), createAiTask: async (actor, b) => { tasks.push(b); return { taskId: 999, sendError: null }; } };
  t.after(() => { hooks.mail = prev; });
  return { sent, tasks };
}

test('מייל רגיל מהבוט — נשלח ישר מ-Gmail, בלי משימה, בשרשור ועם ההעתק', async (t) => {
  const { sent, tasks } = mocks(t);
  const u = user({ role: 'employee' });
  const r = await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor(), false);
  assert.equal(tasks.length, 0, 'לא נפתחה משימה');
  assert.equal(r.taskId ?? null, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'mark@example.test');
  assert.equal(sent[0].threadId, 't1');
  assert.equal(sent[0].inReplyTo, '<m1@x>');
  assert.deepEqual(sent[0].cc, ['dana@example.test']);
  assert.match(r.reply, /נשלח למרק פלדמן/);
  assert.doesNotMatch(r.reply, /משימה/);
});

test('מייל חדש (בלי שרשור) — גם בלי משימה', async (t) => {
  const { sent, tasks } = mocks(t);
  const u = user({ role: 'employee' });
  await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor({ replyThread: null, instruction: 'שלח לרונן את הסיכום' }), false);
  assert.equal(tasks.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, undefined);
});

test('ביקש במילים מעקב / משימה — נפתחת משימת AI כמו קודם', async (t) => {
  for (const instruction of ['שלח לספק בקשה להצעת מחיר ותעקוב אחרי התשובה', 'תפתח משימה ותשלח למרק מייל']) {
    const { sent, tasks } = mocks(t);
    const u = user({ role: 'employee' });
    const r = await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor({ instruction }), false);
    assert.equal(tasks.length, 1, instruction);
    assert.equal(sent.length, 0, instruction);
    assert.equal(r.taskId, 999);
  }
});

test('מהצעה ("סגור א") — עדיין משימה מההצעה', async (t) => {
  const { sent, tasks } = mocks(t);
  const u = user({ role: 'employee' });
  await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor({ suggestionId: 5 }), false);
  assert.equal(tasks.length, 1);
  assert.equal(sent.length, 0);
});
