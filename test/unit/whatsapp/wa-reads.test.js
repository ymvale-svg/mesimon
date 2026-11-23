'use strict';
/**
 * 👁 אישורי קריאה ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 4): הבוט עוקב אם הצעות המייל היזומות נפתחו, ו-5 ברצף
 * שנמסרו ולא נקראו מורידות את המינון — רק אצל מי שהטלפון שלו מדווח "נקרא".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Gmail = require('../../../server/integrations').Gmail;
const MailInsights = require('../../../server/mail/mail-insights');
const MailActions = require('../../../server/mail/mail-actions');
const MailDose = require('../../../server/mail/mail-dose');
const WaReads = require('../../../server/whatsapp/wa-reads');
const WaBase = require('../../../server/whatsapp/wa-base');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaMail = require('../../../server/whatsapp/wa-mail');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});
D.setSetting('remind_hours', '');
D.setSetting('wa_mail_alert_since', '2020-01-01T00:00:00.000Z');

let seq = 0;
let phoneSeq = 0;
const worker = () => rawUser({ full_name: 'ישראל ישראלי', role: 'employee', phone: `97250700${String(++phoneSeq).padStart(4, '0')}` });
const HOUR = 3600 * 1000;
/** הודעה שנשלחה לפני ‎hoursAgo‎ שעות, בסטטוס ‎status‎ */
function sent(u, status, hoursAgo = 30) {
  const id = `m${++seq}`;
  WaReads.track(u.id, id, 'mail_alert');
  D.run('UPDATE wa_reads SET sent_at = ? WHERE id_message = ?', new Date(Date.now() - hoursAgo * HOUR).toISOString(), id);
  if (status !== 'sent') WaReads.onStatus({ idMessage: id, status: 'delivered' });
  if (status === 'read') WaReads.onStatus({ idMessage: id, status: 'read' });
  return id;
}
const statusOf = (id) => D.get('SELECT status FROM wa_reads WHERE id_message = ?', id).status;
/** הטלפון של העובד מדווח קריאה */
const reporter = (u) => WaReads.onStatus({ idMessage: `other${++seq}`, status: 'read', userId: u.id });

test('סטטוס רק מתקדם: נשלחה ← נמסרה ← נקראה; "נמסרה" אחרי "נקראה" לא מחזיר אחורה', () => {
  const u = worker();
  const id = sent(u, 'sent', 1);
  assert.equal(statusOf(id), 'sent');
  WaReads.onStatus({ idMessage: id, status: 'delivered' });
  WaReads.onStatus({ idMessage: id, status: 'read' });
  WaReads.onStatus({ idMessage: id, status: 'delivered' });
  assert.equal(statusOf(id), 'read');
  assert.equal(WaReads.reports(u.id), true, '"נקרא" — הטלפון מדווח');
});

test('5 ברצף שנמסרו ולא נקראו ב-24 שעות — רצף (פעם אחת); הצעה שנקראה באמצע שוברת', () => {
  const u = worker();
  reporter(u);
  for (let i = 0; i < 4; i++) sent(u, 'delivered');
  assert.equal(WaReads.unreadStreak(u.id), false, '4 — עוד לא');
  sent(u, 'delivered');
  assert.equal(WaReads.unreadStreak(u.id), true);
  assert.equal(WaReads.unreadStreak(u.id), false, 'נספרו — לא שוב');

  const v = worker();
  reporter(v);
  for (let i = 0; i < 2; i++) sent(v, 'delivered');
  sent(v, 'read');
  for (let i = 0; i < 2; i++) sent(v, 'delivered');
  assert.equal(WaReads.unreadStreak(v.id), false);
});

test('פחות מ-24 שעות — עוד לא נחשב "לא נקרא"', () => {
  const u = worker();
  reporter(u);
  for (let i = 0; i < 5; i++) sent(u, 'delivered', 3);
  assert.equal(WaReads.unreadStreak(u.id), false);
});

test('אישורי קריאה כבויים (אף פעם לא הגיע "נקרא") — לא מסיקים כלום', () => {
  const u = worker();
  for (let i = 0; i < 8; i++) sent(u, 'delivered');
  assert.equal(WaReads.reports(u.id), false);
  assert.equal(WaReads.unreadStreak(u.id), false);
});

test('הבוט מבקש מ-Green API דיווח סטטוס על מה שנשלח (‎outgoingWebhook‎)', async (t) => {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return method === 'getStateInstance' ? { stateInstance: 'authorized' } : {}; });
  await WaBase.checkState();
  const s = calls.find((c) => c.method === 'setSettings');
  assert.equal(s.body.outgoingWebhook, 'yes');
  assert.equal(s.body.incomingWebhook, 'yes');
});

test('התראת סטטוס מהתור נקלטת ונמחקת', async (t) => {
  const u = worker();
  const id = sent(u, 'sent', 1);
  const deleted = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => {
    if (method === 'receiveNotification') return { receiptId: 77, body: { typeWebhook: 'outgoingMessageStatus', chatId: `${u.phone}@c.us`, idMessage: id, status: 'read', timestamp: Math.floor(Date.now() / 1000) } };
    if (method === 'deleteNotification') deleted.push(opts.suffix);
    return {};
  });
  const r = await Bot._internal.receiveOne(WaBase.channel(), 0);
  assert.equal(r.direct, null);
  assert.equal(statusOf(id), 'read');
  assert.deepEqual(deleted, ['/77']);
});

test('הצעת מייל יזומה נרשמת למעקב, ורצף שלא נקרא מוריד מדרגה', async (t) => {
  const u = worker();
  MailDose.noteUse(u.id);
  reporter(u);
  const at = new Date(Date.now() - HOUR).toISOString();
  D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, 'דני', 'dani@client.test', 'הצעת מחיר', ?, ?, ?)`,
    u.id, `rg${++seq}`, `<rh${seq}@x>`, JSON.stringify({ title: 'לאשר', summary: 'דני מבקש.', toMe: true, replyWanted: true }), at, at
  );
  t.mock.method(WhatsApp, 'call', async (ch, method) => (method === 'sendInteractiveButtonsReply' ? { idMessage: 'offer-1' } : {}));
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(Gmail, 'boxesOf', () => [u.id]);
  t.mock.method(MailActions, 'mayAlertNow', async () => true);
  t.mock.method(MailInsights, 'suggestReply', async () => ({ body: 'שלום דני, מאושר.', to: 'dani@client.test', toName: 'דני', subject: 'Re' }));
  t.mock.method(MailInsights, 'completeReply', async (uid, r) => r);
  await WaMail.mailAlertFor(u.id);
  assert.equal(statusOf('offer-1'), 'sent', 'ההצעה נרשמה למעקב');

  for (let i = 0; i < 5; i++) sent(u, 'delivered');
  assert.equal(MailDose.level(u.id), 0);
  assert.equal(WaMail.checkUnread(u.id), true);
  assert.equal(MailDose.level(u.id), 1, 'ירד מדרגה');
  assert.equal(WaMail.checkUnread(u.id), false, 'אותו רצף — לא שוב');
});
