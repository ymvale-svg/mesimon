'use strict';
/**
 * ❓ בבוט: לחיצה על כפתור של שאלה ישנה לא מאשרת בטעות את מה שפתוח עכשיו, ושאלה יזומה שנדחקה חוזרת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Bot = require('../../../server/whatsapp/wa-bot');
const Q = require('../../../server/whatsapp/wa-questions');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
function fake(t) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return method === 'sendInteractiveButtonsReply' ? { idMessage: `BOT${++seq}` } : {}; });
  return { calls, texts: (phone) => calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${phone}@c.us`).map((c) => c.body.message ?? c.body.body) };
}
const press = (phone, text, replyTo) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `bq${++seq}`, button: true, replyTo: { id: replyTo, button: true } });

test('sendButtons עם ‎q‎ — ההודעה נרשמת לפי המזהה שוואטסאפ החזיר', async (t) => {
  fake(t);
  const u = user({ phone: '972509100001', role: 'employee' });
  await Bot.sendButtons('972509100001@c.us', 'לפתוח משימה?', ['כן ✅', 'לא ❌'], { owner: 'chat', draft: { kind: 'mail_task', suggestionIds: [1] }, awaiting: true });
  const q = Q.find(u.id, `BOT${seq}`);
  assert.equal(q.owner, 'chat');
  assert.equal(q.draft.kind, 'mail_task');
});

test('"כן ✅" על שאלה שכבר לא פתוחה — "השאלה כבר לא פתוחה", והטיוטה הנוכחית לא נגעה', async (t) => {
  const { texts } = fake(t);
  const u = user({ phone: '972509100002', role: 'employee' });
  const current = { kind: 'complete', taskId: 77, title: 'תור לספר' };
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: current, awaiting: true });
  Q.record(u.id, 'OLD1', { owner: 'chat', draft: { kind: 'mail_task', suggestionIds: [9] }, awaiting: true });
  await press('972509100002', 'כן ✅', 'OLD1');
  assert.deepEqual(texts('972509100002'), [Q.CLOSED_TEXT]);
  const st = Bot._internal.chatOf(u.id);
  assert.equal(st.draft.taskId, 77, 'המשימה לא נסגרה בטעות');
  assert.equal(st.awaiting, true);
});

test('שאלה יזומה שנדחקה (חשבונית מהמייל) — חוזרת, נענית, ומה שהיה פתוח קודם חוזר', async (t) => {
  const { texts } = fake(t);
  const u = user({ phone: '972509100003', role: 'employee' });
  const current = { kind: 'complete', taskId: 78, title: 'לשלם לספק' };
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: current, awaiting: true });
  Q.record(u.id, 'OFFER1', { owner: 'chat', draft: { kind: 'goods_offer', goodsId: 123456, filename: 'invoice.pdf' }, awaiting: true });
  await press('972509100003', 'אחר כך ⏰', 'OFFER1');
  assert.match(texts('972509100003')[0], /אשאל שוב מחר/);
  const st = Bot._internal.chatOf(u.id);
  assert.equal(st.draft.taskId, 78, 'השאלה על המשימה חזרה להיות הפתוחה');
  assert.equal(st.awaiting, true);
  assert.equal(Q.find(u.id, 'OFFER1').answered, true);
  await press('972509100003', 'אחר כך ⏰', 'OFFER1');
  assert.equal(texts('972509100003').at(-1), Q.CLOSED_TEXT, 'לחיצה שנייה על אותה שאלה — כבר נענתה');
});

test('לחיצה על השאלה הפתוחה עכשיו — כרגיל', async (t) => {
  const { calls } = fake(t);
  const u = user({ phone: '972509100004', role: 'employee' });
  const offer = { kind: 'goods_offer', goodsId: 123457, filename: 'b.pdf' };
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: offer, awaiting: true });
  Q.record(u.id, 'OFFER2', { owner: 'chat', draft: offer, awaiting: true });
  await press('972509100004', 'לא ❌', 'OFFER2');
  // "בסדר, לא נקלט" — נענה ב-👌 על ההודעה, בלי טקסט
  assert.equal(calls.filter((c) => c.method === 'sendReaction').at(-1).body.reaction, '👌');
  assert.equal(Bot.readLog({}).find((r) => r.userId === u.id).action, 'goods_offer');
  assert.equal(Bot._internal.chatOf(u.id).draft, null);
});

test('"לא" ואז "קבלת סחורה" על אותה הצעה — שינוי דעה: הקליטה מתחילה', async (t) => {
  const { texts } = fake(t);
  const u = user({ phone: '972509100005', role: 'employee' });
  const offer = { kind: 'goods_offer', goodsId: 123458, filename: 'c.pdf' };
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: offer, awaiting: true });
  Q.record(u.id, 'OFFER3', { owner: 'chat', draft: offer, awaiting: true });
  await press('972509100005', 'לא ❌', 'OFFER3');
  await press('972509100005', 'קבלת סחורה 📦', 'OFFER3');
  assert.ok(!texts('972509100005').includes(Q.CLOSED_TEXT), 'לא "השאלה כבר לא פתוחה"');
  const newest = Bot.readLog({}).find((r) => r.userId === u.id); // היומן — החדשה ראשונה
  assert.match(newest.result, /קבלת סחורה מהמייל: c\.pdf/);
});

test('התראה על מייל שנדחקה על ידי התראה חדשה — "לא ❌" עליה עונה לה, והחדשה נשארת פתוחה', async (t) => {
  fake(t);
  const u = user({ phone: '972509100006', role: 'employee' });
  const sug = (subject) => Number(D.run(
    "INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, from_name, from_email, subject, data, created_at) VALUES (?, 'task', 'pending', ?, 'x', 'x@test.local', ?, '{}', ?)",
    u.id, `g-${subject}`, subject, D.nowIso()).lastInsertRowid);
  const older = { kind: 'mail_task', alert: true, suggestionIds: [sug('ישן')], title: 'ישן', subject: 'ישן' };
  const newer = { kind: 'mail_task', alert: true, suggestionIds: [sug('חדש')], title: 'חדש', subject: 'חדש' };
  Q.record(u.id, 'ALERT_OLD', { owner: 'chat', draft: older, awaiting: true });
  Q.record(u.id, 'ALERT_NEW', { owner: 'chat', draft: newer, awaiting: true });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), draft: newer, awaiting: true });
  await press('972509100006', 'לא ❌', 'ALERT_OLD');
  assert.notEqual(D.get('SELECT status FROM ai_suggestions WHERE id = ?', older.suggestionIds[0]).status, 'pending', 'הישנה טופלה');
  assert.equal(D.get('SELECT status FROM ai_suggestions WHERE id = ?', newer.suggestionIds[0]).status, 'pending', 'החדשה לא נגעה');
  assert.equal(Bot._internal.chatOf(u.id).draft.subject, 'חדש', 'החדשה חזרה להיות הפתוחה');
  await press('972509100006', 'לא ❌', 'ALERT_OLD');
  assert.match(Bot.readLog({}).find((r) => r.userId === u.id).result, /כבר לא פתוחה/);
});
