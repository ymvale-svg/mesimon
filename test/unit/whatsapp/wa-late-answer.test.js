'use strict';
/**
 * 🔒 תשובה "מאוחרת" או על הודעה אחרת (#171): תגובה (Reaction) או ציטוט — תשובה רק על ההודעה של השאלה;
 * הצעת תשובה למייל — בתוקף שעתיים, ואחרי זה "כן" לא שולח.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const MailInsights = require('../../../server/mail/mail-insights');
const Bot = require('../../../server/whatsapp/wa-bot');
const Q = require('../../../server/whatsapp/wa-questions');
const { answerLike } = require('../../../server/whatsapp/wa-proactive');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
function fake(t) {
  const calls = [];
  const sent = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return method === 'sendInteractiveButtonsReply' ? { idMessage: `LATE${++seq}` } : {}; });
  t.mock.method(MailInsights, 'sendReply', async (uid, r) => { sent.push(r); return {}; });
  return { sent, texts: (phone) => calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${phone}@c.us`).map((c) => c.body.message ?? c.body.body) };
}
const react = (phone, emoji, on) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text: emoji, id: `lr${++seq}`, kind: 'reactionMessage', replyTo: { id: on, button: false } });
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `ls${++seq}`, kind: 'textMessage' });

/** הצעת תשובה למייל שממתינה ל"כן" (כמו ‎mailAlertFor‎), רשומה גם כשאלה עם כפתורים */
function offer(u, { hoursAgo = 0, id = 'MR-Q' } = {}) {
  const draft = { kind: 'mail_reply', reply: { to: 'client@example.test', toName: 'הלקוח', subject: 'Re: הצעה', body: 'שלום', gmailId: 'g1' }, subject: 'הצעה', offeredAt: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString() };
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft, awaiting: true });
  Q.record(u.id, id, { owner: 'chat', draft, awaiting: true });
  return draft;
}

test('answerLike: תגובה או ציטוט — תשובה רק כשהם על ההודעה של השאלה', () => {
  assert.equal(answerLike('👍', { kind: 'reactionMessage', replyTo: { id: 'X' } }), false, 'תגובה על הודעה אחרת');
  assert.equal(answerLike('👍', { kind: 'reactionMessage', replyTo: { id: 'Q' }, onQuestion: true }), true);
  assert.equal(answerLike('כן', { replyTo: { id: 'X', button: false } }), false, 'ציטוט של הודעה אחרת');
  assert.equal(answerLike('כן', { replyTo: { id: 'Q', button: false }, onQuestion: true }), true);
  assert.equal(answerLike('כן', {}), true, '"כן" בלי ציטוט — כמו קודם');
  assert.equal(answerLike('כן ✅', { button: true, replyTo: { id: 'X', button: true } }), true, 'לחיצה על כפתור — כמו קודם');
});

test('👍 כתגובה על הודעה אחרת, כשהצעת תשובה למייל ממתינה — לא נשלח כלום, והשאלה נשארת', async (t) => {
  const { sent, texts } = fake(t);
  const u = user({ phone: '972509171001', role: 'employee' });
  offer(u);
  await react('972509171001', '👍', 'SOME-OTHER-MSG');
  assert.equal(sent.length, 0, 'התשובה למייל לא נשלחה');
  assert.match(texts('972509171001')[0], /על הודעה אחרת/);
  const st = Bot._internal.chatOf(u.id);
  assert.equal(st.draft.kind, 'mail_reply');
  assert.equal(st.awaiting, true);
});

test('👍 כתגובה על שאלה שכבר לא פתוחה — "השאלה כבר לא פתוחה", ולא מאשרים את מה שפתוח עכשיו', async (t) => {
  const { sent, texts } = fake(t);
  const u = user({ phone: '972509171002', role: 'employee' });
  Q.record(u.id, 'OLD-Q', { owner: 'chat', draft: { kind: 'mail_task', suggestionIds: [999] }, awaiting: true });
  offer(u, { id: 'NEW-Q' });
  await react('972509171002', '👍', 'OLD-Q');
  assert.deepEqual(texts('972509171002'), [Q.CLOSED_TEXT]);
  assert.equal(sent.length, 0);
});

test('👍 כתגובה על ההודעה של השאלה — תשובה: התשובה למייל נשלחת', async (t) => {
  const { sent } = fake(t);
  const u = user({ phone: '972509171003', role: 'employee' });
  offer(u, { id: 'MR-OK' });
  await react('972509171003', '👍', 'MR-OK');
  assert.equal(sent.length, 1);
});

test('⏳ הצעת תשובה למייל מלפני 3 שעות — "כן" לא שולח', async (t) => {
  const { sent, texts } = fake(t);
  const u = user({ phone: '972509171004', role: 'employee' });
  offer(u, { hoursAgo: 3 });
  await say('972509171004', 'כן');
  assert.equal(sent.length, 0, 'הצעה ישנה לא נשלחת');
  assert.match(texts('972509171004').join('\n'), /ישנה מדי/);
});

test('הצעת תשובה למייל מלפני שעה — "כן" שולח', async (t) => {
  const { sent } = fake(t);
  const u = user({ phone: '972509171005', role: 'employee' });
  offer(u, { hoursAgo: 1 });
  await say('972509171005', 'כן');
  assert.equal(sent.length, 1);
});
