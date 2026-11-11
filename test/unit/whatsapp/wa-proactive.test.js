'use strict';
/**
 * 🕗 הודעות יזומות (הוחלט 11.11.26):
 *   • רק בימי העבודה של העובד, 08:15–17:00; סיכום סוף היום ב-17:00 הוא האחרון.
 *   • הצעה לקבלת סחורה שלא נענתה — לא חוזרת ("אם הוא יתעלם, אז הוא יתעלם").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Bot = require('../../../server/whatsapp/wa-bot');
const MailActions = require('../../../server/mail/mail-actions');

boot();
const X = Bot._internal;
// נובמבר — ישראל ב-UTC+2. 11.11.26 — יום ד׳; 13.11.26 — יום ו׳
const il = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+02:00`);

test('workHours — 08:15 עד 17:00 בלבד', () => {
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '08:10') }), false);
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '08:15') }), true);
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '16:59') }), true);
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '17:00') }), false);
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '21:00') }), false);
});

test('workHours — סיכום סוף היום: עד חצי שעה אחרי 17:00, לא יותר', () => {
  assert.equal(Bot.workHours(null, { graceMin: 30, date: il('2026-11-11', '17:05') }), true);
  assert.equal(Bot.workHours(null, { graceMin: 30, date: il('2026-11-11', '17:30') }), false);
});

test('workHours — לא ביום שאינו יום עבודה של העובד', () => {
  const u = user();
  assert.equal(Bot.workHours(u.id, { date: il('2026-11-11', '10:00') }), true);
  assert.equal(Bot.workHours(u.id, { date: il('2026-11-13', '10:00') }), false, 'שישי');
});

test('workHours — השעות ניתנות לשינוי בהגדרה', (t) => {
  D.setSetting('wa_proactive_hours', '09:00-16:00');
  t.after(() => D.setSetting('wa_proactive_hours', '08:15-17:00'));
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '08:30') }), false);
  assert.equal(Bot.workHours(null, { date: il('2026-11-11', '15:59') }), true);
});

test('הצעה לקבלת סחורה שלא נענתה — נסגרת ולא נשאלת שוב', () => {
  const u = user();
  const info = D.run(
    `INSERT INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, created_at)
     VALUES (?, 'g1', 0, 'invoice', 'inv.pdf', 'application/pdf', 'ספק', 'ספק', 's@x.co', 'חשבונית', 'asked', ?)`,
    u.id, D.nowIso()
  );
  const goodsId = Number(info.lastInsertRowid);
  const askedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  X.saveChat(u.id, { ...X.chatOf(u.id), draft: { kind: 'goods_offer', goodsId, filename: 'inv.pdf', askedAt }, awaiting: true });
  assert.equal(X.busyFor(u.id), false, 'שאלה בת 3 שעות בלי תשובה כבר לא חוסמת');
  assert.equal(D.get('SELECT status FROM mail_goods_docs WHERE id = ?', goodsId).status, 'ignored');
  assert.equal(MailActions._internal.nextGoods(u.id), null, 'לא נשאלת שוב');
});


test('🚨 חשבוניות במייל — לא יותר מ-2 הצעות ביום לעובד, ורק מהיממה האחרונה', () => {
  const u = user();
  const add = (g, hoursAgo = 1) => D.run(
    `INSERT INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, created_at)
     VALUES (?, ?, 0, 'invoice', 'inv.pdf', 'application/pdf', 'ספק', 'ספק', 's@x.co', 'חשבונית', 'pending', ?)`,
    u.id, g, new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
  );
  add('old', 30);
  for (const g of ['a', 'b', 'c', 'd']) add(g);
  const asked = [];
  for (let i = 0; i < 10; i++) {
    const row = MailActions._internal.nextGoods(u.id);
    if (!row) break;
    asked.push(row.gmail_id);
    D.run("UPDATE mail_goods_docs SET status = 'asked', asked_at = ? WHERE id = ?", D.nowIso(), row.id);
  }
  assert.equal(asked.length, MailActions._internal.GOODS_PER_DAY);
  assert.ok(!asked.includes('old'), 'חשבונית בת יותר מיממה — לא מציעים');
});

test('📦 הצעה על חשבונית — רק למי שפתח אי פעם קבלת סחורה בפריוריטי', () => {
  const GR = require('../../../server/priority').GoodsReceipt;
  const never = user();
  const old = user();
  const fresh = user();
  assert.equal(GR.everOpened(never.id), false);
  // מלפני הרישום — מיומן הבוט
  D.run(`INSERT INTO wa_log (at, channel, user_id, action, result, status) VALUES (?, 'private', ?, 'goods_receipt', 'GR סופי GR2600123', 'ok')`, D.nowIso(), old.id);
  D.run(`INSERT INTO wa_log (at, channel, user_id, action, result, status) VALUES (?, 'private', ?, 'goods_receipt', 'קבלת סחורה — לא מורשה', 'ok')`, D.nowIso(), never.id);
  assert.equal(GR.everOpened(old.id), true);
  assert.equal(GR.everOpened(never.id), false, 'ניסה ולא פתח — לא נחשב');
  GR.markOpened(fresh.id);
  assert.equal(GR.everOpened(fresh.id), true);
});

test('🔕 אחרי 5 הצעות לקבלת סחורה בלי תשובה — שאלה אחת: להפסיק?', async () => {
  const u = user();
  const at = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const add = (g, status, askedH) => D.run(
    `INSERT INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, asked_at, created_at)
     VALUES (?, ?, 0, 'invoice', 'inv.pdf', 'application/pdf', 'ספק', 'ספק', 's@x.co', 'חשבונית', ?, ?, ?)`,
    u.id, g, status, askedH == null ? null : at(askedH), at(askedH ?? 1)
  );
  add('answered', 'started', 200);
  for (let i = 0; i < 4; i++) add(`i${i}`, 'ignored', 100 - i);
  assert.equal(MailActions._internal.goodsIgnoredStreak(u.id), 4);
  add('new', 'pending', null);
  let q = await MailActions.nextQuestion(u.id, { goods: true });
  assert.equal(q.draft.kind, 'goods_offer', '4 התעלמויות — עוד מציעים');
  D.run("UPDATE mail_goods_docs SET status = 'ignored' WHERE user_id = ? AND gmail_id = 'new'", u.id);
  add('next', 'pending', null);
  q = await MailActions.nextQuestion(u.id, { goods: true });
  assert.equal(q.draft.kind, 'goods_stop', 'החמישית — במקום ההצעה הבאה');
  assert.deepEqual(q.buttons, [MailActions.GOODS_STOP_BTN.stop, MailActions.GOODS_STOP_BTN.keep]);
  // לא נשאלים שוב מיד — הספירה מתחילה מחדש
  assert.equal(MailActions._internal.goodsIgnoredStreak(u.id), 0);

  const r = MailActions.answerGoodsStop(u.id, MailActions.GOODS_STOP_BTN.stop);
  assert.match(r.text, /לא אציע יותר/);
  assert.equal(D.userPrefs(u.id).botPrefs.goodsOffer, false);
  assert.equal(MailActions.answerGoodsStop(u.id, 'מה עם הפגישה מחר?'), null, 'נושא אחר — לא תשובה');
});

test('🔕 תשובה של ממש להצעה מאפסת את הספירה', () => {
  const u = user();
  const at = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const add = (g, status, h) => D.run(
    `INSERT INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, status, asked_at, created_at) VALUES (?, ?, 0, 'invoice', 'f.pdf', ?, ?, ?)`,
    u.id, g, status, at(h), at(h));
  for (let i = 0; i < 4; i++) add(`a${i}`, 'ignored', 50 - i);
  add('yes', 'declined', 10);
  add('b', 'ignored', 5);
  assert.equal(MailActions._internal.goodsIgnoredStreak(u.id), 1);
});
