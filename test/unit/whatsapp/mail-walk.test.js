'use strict';
/**
 * 📬 "מיילים לענות" — מייל אחרי מייל, תמיד עם הצעת תשובה (הוחלט 15.11.26,
 * "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 3.1). מקצה לקצה דרך ‎handleDirect‎, בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Gmail = require('../../../server/integrations').Gmail;
const MailInsights = require('../../../server/mail/mail-insights');
const MailOwner = require('../../../server/mail/mail-owner');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaMail = require('../../../server/whatsapp/wa-mail');
const { menuOptions } = require('../../../server/whatsapp/wa-menu');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
let phoneSeq = 0;
function worker() {
  return rawUser({ full_name: 'ישראל ישראלי', role: 'employee', phone: `97250800${String(++phoneSeq).padStart(4, '0')}` });
}
function mail(u, { from = 'דני כהן', subject = 'הצעת מחיר', hoursAgo = 3, header = null } = {}) {
  const at = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  return Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    u.id, `g${++seq}`, header ?? `<h${seq}@x>`, from, `${seq}@client.test`, subject, JSON.stringify({ title: subject, summary: `${from} מבקש תשובה.`, toMe: true }), at, at
  ).lastInsertRowid);
}
/** Gmail ו-AI מזויפים: כל מייל מקבל הצעה; שליחה נרשמת */
function fakes(t) {
  const calls = [];
  const sentMail = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(MailInsights, 'suggestReply', async (uid, gmailId) => ({ body: `שלום, תשובה מוכנה למייל ${gmailId}. בברכה`, to: 'client@x.test', toName: 'הלקוח', subject: 'Re', gmailId }));
  t.mock.method(MailInsights, 'completeReply', async (uid, r) => r);
  t.mock.method(MailInsights, 'sendReply', async (uid, r) => { sentMail.push(r.gmailId); return {}; });
  return { calls, sentMail };
}
const say = (u, text) => Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text, id: `w${++seq}` });
const msgs = (calls) => calls.filter((c) => c.method !== 'sendReaction').map((c) => ({ text: c.body.message ?? c.body.body ?? '', buttons: (c.body.buttons ?? []).map((b) => b.buttonText) }));
const status = (id) => D.get('SELECT status FROM ai_suggestions WHERE id = ?', id).status;

test('התפריט — כשיש מיילים שמחכים, הכפתור הראשון הוא "📬 N מיילים לענות"', () => {
  const u = worker();
  const actor = { type: 'user', id: u.id, role: u.role };
  assert.notEqual(menuOptions(actor)[0].key.startsWith('📬'), true, 'אין מיילים — אין כפתור');
  mail(u);
  mail(u);
  assert.equal(menuOptions(actor)[0].label, '📬 2 מיילים לענות');
  assert.ok(menuOptions(actor)[0].label.length <= 20);
});

test('לחיצה — הודעת פתיחה, ואחריה המייל הראשון עם הצעת תשובה וכפתורים', async (t) => {
  const u = worker();
  mail(u, { subject: 'ישן', hoursAgo: 20 });
  mail(u, { subject: 'חדש', hoursAgo: 1 });
  const { calls } = fakes(t);
  await say(u, '📬 2 מיילים לענות');
  const out = msgs(calls);
  assert.equal(out.length, 2, 'פתיחה + מייל ראשון — שתי הודעות');
  assert.match(out[0].text, /יש לך 2 מיילים שמחכים לתשובה ממך/);
  assert.match(out[1].text, /1 מתוך 2/);
  assert.match(out[1].text, /לענות כך\?/);
  assert.match(out[1].text, /תשובה מוכנה/);
  assert.deepEqual(out[1].buttons, [WaMail.MAIL_WALK_BTN.send, WaMail.MAIL_WALK_BTN.no, WaMail.MAIL_WALK_BTN.stop]);
});

test('כן ← נשלח והבא · לא ← לא נשלח, יורד והבא · בסוף סיכום', async (t) => {
  const u = worker();
  const a = mail(u, { hoursAgo: 3 });
  const b = mail(u, { hoursAgo: 2 });
  const { calls, sentMail } = fakes(t);
  await say(u, 'מיילים לענות');
  calls.length = 0;
  await say(u, WaMail.MAIL_WALK_BTN.send);
  let out = msgs(calls);
  assert.equal(sentMail.length, 1);
  assert.match(out[0].text, /התשובה נשלחה/);
  assert.match(out[1].text, /2 מתוך 2/);
  calls.length = 0;
  await say(u, '👎');
  out = msgs(calls);
  assert.equal(sentMail.length, 1, '"לא" — לא שולח');
  assert.match(out[0].text, /לא עונים/);
  assert.match(out.at(-1).text, /עברנו על כולם.*נשלחו 1.*ירדו 1/s);
  assert.notEqual(status(a), 'pending');
  assert.notEqual(status(b), 'pending');
  // החדש קודם: ‎b‎ נשלח, ‎a‎ ירד — ולא תגיע עליו תזכורת
  assert.equal(sentMail[0], D.get('SELECT gmail_id FROM ai_suggestions WHERE id = ?', b).gmail_id);
  assert.equal(JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', a).data).remind?.closed, 'no_reply');
});

test('🏁 סיום — עוצר; "מיילים לענות" ממשיך ממה שנשאר', async (t) => {
  const u = worker();
  mail(u, { hoursAgo: 3 });
  mail(u, { hoursAgo: 2 });
  const { calls } = fakes(t);
  await say(u, 'תעבור איתי על המיילים');
  calls.length = 0;
  await say(u, WaMail.MAIL_WALK_BTN.stop);
  assert.match(msgs(calls)[0].text, /עצרנו.*נשארו 2/s);
  assert.equal(Bot._internal.chatOf(u.id).mailWalk ?? null, null);
  calls.length = 0;
  await say(u, 'מיילים לענות');
  assert.match(msgs(calls)[0].text, /2 מיילים/);
});

test('מייל שאינו שלי (בעל המייל אחר) — לא במעבר', async (t) => {
  const u = worker();
  const other = worker();
  mail(u, { header: '<shared@x>' });
  MailOwner.assign('<shared@x>', { userId: other.id, reason: 'dept_manager', bulk: false });
  const { calls } = fakes(t);
  await say(u, 'מיילים לענות');
  assert.match(msgs(calls)[0].text, /אין מיילים שמחכים לתשובה ממך/);
});

test('אין מיילים — תשובה קצרה', async (t) => {
  const u = worker();
  const { calls } = fakes(t);
  await say(u, 'מיילים לענות');
  assert.match(msgs(calls)[0].text, /אין מיילים שמחכים/);
});
