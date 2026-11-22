'use strict';
/**
 * 📉 מינון המייל בבוט ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 3) — מקצה לקצה, בלי רשת:
 * ההצעות לפי המדרגה (והתשובה נכתבת רק למייל שמוצע), הודעת ההשהיה, "כן" שמחזיר, ושימוש שמחזיר ל-100%.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Gmail = require('../../../server/integrations').Gmail;
const MailInsights = require('../../../server/mail/mail-insights');
const MailDose = require('../../../server/mail/mail-dose');
const MailActions = require('../../../server/mail/mail-actions');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaMail = require('../../../server/whatsapp/wa-mail');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});
D.setSetting('remind_hours', '');
D.setSetting('wa_mail_alert_since', '2020-01-01T00:00:00.000Z');

let seq = 0;
let phoneSeq = 0;
const worker = () => rawUser({ full_name: 'ישראל ישראלי', role: 'employee', phone: `97250900${String(++phoneSeq).padStart(4, '0')}` });
/** הצעה ממייל שהשולח מחכה בו לתשובה, בלי תשובה מוכנה (כמו בסריקה מתחת ל-100%) */
function mail(u, { priority = 'normal' } = {}) {
  const at = new Date(Date.now() - 3600 * 1000).toISOString();
  return Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, 'דני כהן', ?, 'הצעת מחיר', ?, ?, ?)`,
    u.id, `dg${++seq}`, `<dh${seq}@x>`, `${seq}@client.test`,
    JSON.stringify({ title: 'לאשר הצעת מחיר', summary: 'דני מבקש תשובה.', toMe: true, priority, replyWanted: true, replyBox: 0 }), at, at
  ).lastInsertRowid);
}
function fakes(t) {
  const calls = [];
  let drafted = 0;
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  t.mock.method(Gmail, 'canSend', () => true);
  // הקצב (חצי שעה בין פניות יזומות) נבדק במקום אחר — כאן כל סבב מותר
  t.mock.method(MailActions, 'mayAlertNow', async () => true);
  t.mock.method(MailInsights, 'suggestReply', async (uid, gmailId) => { drafted++; return { body: `שלום, תשובה למייל ${gmailId}. בברכה`, to: 'client@x.test', toName: 'דני', subject: 'Re' }; });
  t.mock.method(MailInsights, 'completeReply', async (uid, r) => r);
  t.mock.method(MailInsights, 'sendReply', async () => ({}));
  return { calls, drafted: () => drafted };
}
const say = (u, text) => Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text, id: `d${++seq}` });
const msgs = (calls) => calls.filter((c) => c.method !== 'sendReaction').map((c) => ({ text: c.body.message ?? c.body.body ?? '', buttons: (c.body.buttons ?? []).map((b) => b.buttonText) }));
const dose = (u, drops) => D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops, rejects: 0 });

test('100% — מוצע, והתשובה שלא הוכנה בסריקה נכתבת עכשיו ונשמרת', async (t) => {
  const u = worker();
  dose(u, 0);
  const id = mail(u);
  const { calls, drafted } = fakes(t);
  await WaMail.mailAlertFor(u.id);
  const out = msgs(calls);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /תשובה למייל dg/);
  assert.equal(drafted(), 1);
  assert.ok(JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', id).data).reply.body, 'נשמרה בהצעה');
});

test('50% — מייל רגיל אחד כן ואחד לא (בלי לכתוב תשובה למה שלא מוצע); דחוף — תמיד', async (t) => {
  const u = worker();
  dose(u, 1);
  mail(u);
  mail(u);
  mail(u, { priority: 'urgent' });
  const { calls, drafted } = fakes(t);
  // בין סבב לסבב העובד עונה — כשמחכה שאלה, הבוט לא שולח עוד אחת
  for (let i = 0; i < 3; i++) { await WaMail.mailAlertFor(u.id); await say(u, 'לא ❌'); }
  const offers = msgs(calls).filter((m) => m.text.includes('תשובה למייל'));
  assert.equal(offers.length, 2, 'הראשון והדחוף');
  assert.equal(drafted(), 2, 'לשני — לא נכתבה תשובה');
});

test('20% — רק דחוף, אחד ביום', async (t) => {
  const u = worker();
  dose(u, 2);
  mail(u);
  mail(u, { priority: 'urgent' });
  mail(u, { priority: 'urgent' });
  const { calls } = fakes(t);
  for (let i = 0; i < 3; i++) await WaMail.mailAlertFor(u.id);
  assert.equal(msgs(calls).length, 1);
});

test('מושהה — הודעה אחת עם כפתורים, לא פעמיים; "כן, תחזור" — חוזרים ל-100%', async (t) => {
  const u = worker();
  dose(u, 3);
  mail(u, { priority: 'urgent' });
  const { calls, drafted } = fakes(t);
  await WaMail.mailAlerts();
  await WaMail.pauseNoticeFor(u.id);
  await WaMail.mailAlertFor(u.id);
  const out = msgs(calls).filter((m) => m.text.includes('📭') || m.text.includes('תשובה למייל'));
  assert.equal(out.length, 1, 'רק הודעת ההשהיה — בלי הצעה ובלי הודעה שנייה');
  assert.match(out[0].text, /הפסקתי להציע/);
  assert.deepEqual(out[0].buttons, [MailDose.PAUSE_BTN.resume, MailDose.PAUSE_BTN.stay]);
  assert.equal(drafted(), 0);
  calls.length = 0;
  await say(u, MailDose.PAUSE_BTN.resume);
  assert.match(msgs(calls).map((m) => m.text).join('\n'), /חזרתי/);
  assert.equal(MailDose.level(u.id), 0);
});

test('מושהה — "לא" על הודעת ההשהיה: נשאר מושהה', async (t) => {
  const u = worker();
  dose(u, 3);
  const { calls } = fakes(t);
  await WaMail.pauseNoticeFor(u.id);
  calls.length = 0;
  await say(u, MailDose.PAUSE_BTN.stay);
  assert.match(msgs(calls).map((m) => m.text).join('\n'), /מיילים לענות/);
  assert.equal(MailDose.paused(u.id), true);
});

test('"מיילים לענות" — שימוש: מושהה חוזר ל-100%', async (t) => {
  const u = worker();
  dose(u, 3);
  mail(u);
  fakes(t);
  await say(u, 'מיילים לענות');
  assert.equal(MailDose.level(u.id), 0);
});

test('"לא" על הצעת תשובה יזומה — שלוש ברצף מורידות מדרגה', async (t) => {
  const u = worker();
  dose(u, 0);
  fakes(t);
  for (let i = 0; i < 3; i++) {
    mail(u, { priority: 'urgent' });
    await WaMail.mailAlertFor(u.id);
    await say(u, 'לא ❌');
  }
  assert.equal(MailDose.level(u.id), 1);
});
