'use strict';
/**
 * 18.11: "תענה למרק פלדמן…" ← 👍 — כל מייל שיצא מהבוט פתח משימת AI (משימות 587, 588 בלוח של ישראל).
 * "משימה ומייל — שני דברים נפרדים" (ישראל, 20.11.26): מייל יוצא ישר מ-Gmail ולעולם לא פותח משימה — גם
 * כשכתבו "ותעקוב" (המעקב הוא "📬 ענה למייל ששלחת", ‎ReplyWatch‎), מהצעה ומ"💡 פתרון לבעיה".
 * משימה — רק כשמבקשים משימה. מייל על משימה קיימת — נשמר בה (לא נפתחת חדשה); "במשימון" לעובד — זו משימה, לא מייל.
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

test('גם "ותעקוב" / "תפתח משימה" / "💡 פתרון לבעיה" — המייל יוצא, ולא נפתחת משימה', async (t) => {
  for (const extra of [
    { instruction: 'שלח לספק בקשה להצעת מחיר ותעקוב אחרי התשובה' },
    { instruction: 'תפתח משימה ותשלח למרק מייל' },
    { solve: { problem: 'מזגן', solution: 'טכנאי' } }
  ]) {
    const { sent, tasks } = mocks(t);
    const u = user({ role: 'employee' });
    const r = await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor(extra), false);
    assert.equal(tasks.length, 0, JSON.stringify(extra));
    assert.equal(sent.length, 1, JSON.stringify(extra));
    assert.equal(r.taskId ?? null, null);
  }
});

test('מהצעה ("סגור א") — המייל יוצא, בלי משימה; ההצעה יורדת כ"נענתה"', async (t) => {
  const { D } = require('../../helpers/db');
  const { sent, tasks } = mocks(t);
  const u = user({ role: 'employee' });
  const id = Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', 'g-s1', 'h-s1', 'דני', 'dani@example.test', 'נושא', '{"title":"x"}', ?, ?)`, u.id, D.nowIso(), D.nowIso()
  ).lastInsertRowid);
  await WaMail.confirmPending(Auth.loadActor('user', u.id), pendingFor({ suggestionId: id }), false);
  assert.equal(tasks.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(D.get('SELECT status, task_id FROM ai_suggestions WHERE id = ?', id).status, 'replied');
  assert.equal(D.get('SELECT task_id FROM ai_suggestions WHERE id = ?', id).task_id, null);
});

/*
 * גם בוואטסאפ (ישראל, 20.11.26: "תפריד גם בוואטסאפ"): הודעה לגורם חיצוני יוצאת מהוואטסאפ של העובד — בלי משימה.
 * התשובה מגיעה אליו לוואטסאפ ממילא.
 */
const Whatsapp = require('../../../server/integrations').Whatsapp;
const waPending = (extra = {}) => pendingFor({
  channel: 'whatsapp', via: 'whatsapp', cc: [], replyThread: null,
  contact: { name: 'יוסי הספק', email: '', phone: '050-1234567', mobile: '0501234567', type: 'vendor' },
  draft: { title: 'הצעת מחיר', subject: '', body: 'שלום יוסי, אפשר הצעת מחיר?' },
  ...extra
});

test('וואטסאפ לגורם חיצוני — יוצא מהוואטסאפ של העובד, בלי משימה', async (t) => {
  const { sent, tasks } = mocks(t);
  const wa = [];
  t.mock.method(Whatsapp, 'isReady', () => true);
  t.mock.method(Whatsapp, 'send', async (uid, phone, body) => { wa.push({ uid, phone, body }); return { externalId: 'x1' }; });
  const u = user({ role: 'employee' });
  const r = await WaMail.confirmPending(Auth.loadActor('user', u.id), waPending(), false);
  assert.equal(tasks.length, 0, 'לא נפתחה משימה');
  assert.equal(sent.length, 0, 'לא נשלח מייל');
  assert.deepEqual(wa, [{ uid: u.id, phone: '0501234567', body: 'שלום יוסי, אפשר הצעת מחיר?' }]);
  assert.equal(r.taskId ?? null, null);
  assert.match(r.reply, /נשלח בוואטסאפ ליוסי הספק/);
});

test('וואטסאפ לא מחובר — הסבר ברור, בלי משימה ובלי שליחה', async (t) => {
  const { sent, tasks } = mocks(t);
  t.mock.method(Whatsapp, 'isReady', () => false);
  const send = t.mock.method(Whatsapp, 'send', async () => ({}));
  const u = user({ role: 'employee' });
  const r = await WaMail.confirmPending(Auth.loadActor('user', u.id), waPending(), false);
  assert.equal(tasks.length + sent.length + send.mock.callCount(), 0);
  assert.equal(r.status, 'error');
  assert.match(r.reply, /הוואטסאפ שלך אינו מחובר/);
});
