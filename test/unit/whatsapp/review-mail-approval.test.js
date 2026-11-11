'use strict';
/**
 * ✉️ "לענות לה במייל דרך משימון": הסקירה מכינה תשובה לעובדת, הבוט שולח אותה למנהל בוואטסאפ לאישור,
 * ו"כן" שולח מה-Gmail של המנהל בהמשך לשרשור. נמען — רק משתמש פעיל; מאשר — רק מנהל. בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Gmail = require('../../../server/integrations/gmail');
const MailThread = require('../../../server/mail/mail-thread');
const Bot = require('../../../server/whatsapp/wa-bot');
const Review = require('../../../server/whatsapp/bot-review');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});
let seq = 0;

function setup(t) {
  const admin = user({ role: 'superadmin', full_name: `מנהל ${++seq}`, phone: `97250880000${seq}` });
  const naama = user({ role: 'employee', full_name: `נעמה בדיקה ${seq}`, email: `naama${seq}@corp.test` });
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return { idMessage: `M${seq}` }; });
  t.mock.method(MailThread, 'recentThreads', async () => [
    { box: 0, threadId: 'T-other', subject: 'משהו אחר', inReplyTo: '<o@x>', references: ['<o@x>'] },
    { box: 0, threadId: 'T-sync', subject: 'משימון - סנכרון מיילים', inReplyTo: '<s@x>', references: ['<s@x>'] }
  ]);
  const sent = [];
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(Gmail, 'connectionOf', () => ({ email: 'admin@corp.test', state: 'ok' }));
  t.mock.method(Gmail, 'signed', async (who, b) => b);
  t.mock.method(Gmail, 'send', async (who, raw, opts) => { sent.push({ raw, opts }); return {}; });
  return { admin, naama, calls, sent };
}

test('הכנה: נשלח למנהל בוואטסאפ לאישור, בהמשך לשרשור לפי הרמז, והטיוטה ממתינה', async (t) => {
  const { admin, naama, calls } = setup(t);
  const r = await Review.mailForApproval({ userId: admin.id, toName: naama.full_name, body: 'היי נעמה,\nטיפלנו בשלושתן.', threadHint: 'סנכרון' });
  assert.deepEqual(r, { sent: true, to: naama.full_name, subject: 'Re: משימון - סנכרון מיילים', inThread: true });
  const msg = calls.find((c) => c.method === 'sendInteractiveButtonsReply');
  assert.match(msg.body.body, /מייל מוכן לאישור — ל/);
  assert.match(msg.body.body, /טיפלנו בשלושתן/);
  assert.equal(msg.body.chatId, `${admin.phone}@c.us`);
  const st = Bot._internal.chatOf(admin.id);
  assert.equal(st.draft.kind, 'plain_mail');
  assert.equal(st.awaiting, true);
});

test('"כן ✅" — נשלח מה-Gmail של המנהל לנעמה, בהמשך לשרשור; "לא" — לא נשלח', async (t) => {
  const { admin, naama, sent } = setup(t);
  await Review.mailForApproval({ userId: admin.id, toName: naama.full_name, body: 'תודה!', threadHint: 'סנכרון' });
  const actor = Auth.loadActor('user', admin.id);
  const state = Bot._internal.chatOf(admin.id);
  const no = await Bot._internal.converse(admin, actor, 'לא ❌', state);
  assert.match(no.reply, /המייל לא נשלח/);
  assert.equal(sent.length, 0);
  const yes = await Bot._internal.converse(admin, actor, 'כן ✅', state);
  assert.match(yes.reply, /נשלח ל.*בהמשך לשרשור/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.threadId, 'T-sync');
  assert.match(sent[0].raw, new RegExp(`^To: .*${naama.email.replace('.', '\\.')}`, 'm'));
  assert.match(sent[0].raw, /^In-Reply-To: <s@x>$/m);
});

test('בטיחות: נמען שאינו משתמש פעיל, או מאשר שאינו מנהל — 400, ושום דבר לא נשלח', async (t) => {
  const { admin, naama, calls } = setup(t);
  await assert.rejects(() => Review.mailForApproval({ userId: admin.id, toName: 'מישהו מבחוץ', body: 'x' }), /הנמען לא נמצא/);
  const emp = user({ role: 'employee', phone: '972508899999' });
  await assert.rejects(() => Review.mailForApproval({ userId: emp.id, toName: naama.full_name, body: 'x' }), /מנהל מערכת/);
  assert.equal(calls.length, 0);
});
