'use strict';
/**
 * 👍 / 👎 (Reaction) על הודעה מסוימת — תשובה לשאלה *שבהודעה ההיא*, לא למה שפתוח עכשיו.
 * באג 17.11.26: טיוטת תשובה לשזר הייתה פתוחה; "✉️ מייל מוכן לאישור — לנעמה" הגיע אחריה (בלי כפתורים, כי השיחה
 * הייתה תפוסה); 👍 על ההודעה של נעמה — שלח את המייל לשזר.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Gmail = require('../../../server/integrations/gmail');
const Bot = require('../../../server/whatsapp/wa-bot');
const Proactive = require('../../../server/whatsapp/wa-proactive');
const Q = require('../../../server/whatsapp/wa-questions');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
function fake(t) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return { idMessage: `BOT${++seq}` }; });
  const mails = [];
  t.mock.method(Gmail, 'handle', () => 'h');
  t.mock.method(Gmail, 'connectionOf', () => ({ email: 'me@test.local' }));
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(Gmail, 'signed', async (_w, b) => b);
  t.mock.method(Gmail, 'send', async (_w, raw) => { mails.push(String(raw)); return {}; });
  t.mock.method(console, 'error', () => {});
  return { calls, mails, texts: (phone) => calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${phone}@c.us`).map((c) => c.body.message ?? c.body.body) };
}
const react = (phone, emoji, on) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text: emoji, kind: 'reactionMessage', id: `r${++seq}`, replyTo: { id: on, button: false } });
const lastId = () => `BOT${seq}`;

function setup(t, phone) {
  const f = fake(t);
  const u = user({ phone, role: 'admin', full_name: `מאשר ${phone}` });
  const naama = user({ full_name: `נעמה ${phone}`, email: `naama${phone}@test.local` });
  // השאלה הפתוחה: לסמן משימה כבוצעה (אם 👍 יגיע אליה בטעות — המשימה תיסגר)
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: { kind: 'complete', taskId: 999001, title: 'לשזר', askedAt: D.nowIso() }, awaiting: true });
  return { ...f, u, naama };
}
const plain = (naama) => ({ kind: 'plain_mail', to: { name: naama.full_name, email: naama.email }, subject: 'Re: איחוד משימות', body: 'היי נעמה', replyThread: null });

test('👍 על "מייל מוכן לאישור" שנשלח כשהיה פתוח משהו אחר — נשלח המייל ההוא, והשאלה הפתוחה לא נגעה', async (t) => {
  const { u, naama, mails, texts } = setup(t, '972509300001');
  await Proactive.pushToUser(u.id, { text: '✉️ מייל מוכן לאישור — לנעמה\n\nלשלוח?', buttons: ['כן ✅', 'לא ❌'], draft: plain(naama) }, 'send_email', { requested: true });
  const naamaMsg = lastId();
  assert.equal(Bot._internal.chatOf(u.id).draft.kind, 'complete', 'השיחה הייתה תפוסה — השאלה הפתוחה נשארה');
  await react('972509300001', '👍', naamaMsg);
  assert.equal(mails.length, 1);
  assert.match(mails[0], new RegExp(naama.email));
  const st = Bot._internal.chatOf(u.id);
  assert.equal(st.draft?.taskId, 999001, 'מה שהיה פתוח — חוזר להיות פתוח');
  assert.equal(st.awaiting, true);
  assert.match(texts('972509300001').at(-1), /נשלח ל/);
  // 👍 שני על אותה הודעה — לא נשלח שוב
  await react('972509300001', '👍', naamaMsg);
  assert.equal(mails.length, 1);
});

test('👍 על הודעה ישנה שאינה שאלה — לא מאשר את השאלה הפתוחה', async (t) => {
  const { u, texts } = setup(t, '972509300002');
  await Bot.sendText('972509300002@c.us', 'הודעה ישנה');
  const old = lastId();
  await Bot.sendText('972509300002@c.us', 'לסמן כבוצעה? *כן* 👍');
  await react('972509300002', '👍', old);
  // אחרי #216 — תגובה שאינה על השאלה מקבלת את ההסבר שלו ("התגובה הייתה על הודעה אחרת"); העיקר — לא אושר כלום
  assert.match(texts('972509300002').at(-1), /לא עשיתי כלום/);
  const st = Bot._internal.chatOf(u.id);
  assert.equal(st.draft?.taskId, 999001);
  assert.equal(st.awaiting, true);
});

test('"מייל מוכן לאישור" שנענה בטקסט ("כן") — 👍 מאוחר על ההודעה שלו לא שולח שוב', async (t) => {
  const { u, naama, mails } = setup(t, '972509300003');
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: null, awaiting: false });
  await Proactive.pushToUser(u.id, { text: '✉️ מייל מוכן לאישור\n\nלשלוח?', buttons: ['כן ✅', 'לא ❌'], draft: plain(naama) }, 'send_email', { requested: true });
  const msg = lastId();
  await Bot._internal.handleDirect({ phone: '972509300003', chatId: '972509300003@c.us', text: 'כן', id: `t${++seq}` });
  assert.equal(mails.length, 1);
  await react('972509300003', '👍', msg);
  assert.equal(mails.length, 1, 'לא נשלח פעמיים');
});

test('"מייל מוכן לאישור" שאושר בכפתור "כן ✅" — 👍 אחר כך על אותה הודעה לא שולח שוב, ו-👎 לא אומר "לא נשלח"', async (t) => {
  const { u, naama, mails, texts } = setup(t, '972509300004');
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: null, awaiting: false });
  await Proactive.pushToUser(u.id, { text: '✉️ מייל מוכן לאישור\n\nלשלוח?', buttons: ['כן ✅', 'לא ❌'], draft: plain(naama) }, 'send_email', { requested: true });
  const msg = lastId();
  await Bot._internal.handleDirect({ phone: '972509300004', chatId: '972509300004@c.us', text: 'כן ✅', id: `t${++seq}`, button: true, replyTo: { id: msg, button: true } });
  assert.equal(mails.length, 1);
  await react('972509300004', '👍', msg);
  assert.equal(mails.length, 1, 'לא נשלח פעמיים');
  await react('972509300004', '👎', msg);
  assert.doesNotMatch(texts('972509300004').at(-1), /לא נשלח/);
});
