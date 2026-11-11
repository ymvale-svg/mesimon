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

test('הצעה לקבלת סחורה — רק למי שמורשה לקבלת סחורה בבוט', (t) => {
  const Auth = require('../../../server/core').Auth;
  const actor = Auth.loadActor('user', user({ role: 'admin' }).id);
  const prev = D.getSetting('wa_actions', {});
  t.after(() => D.setSetting('wa_actions', prev));
  D.setSetting('wa_actions', { ...prev, goods_receipt: { enabled: false } });
  assert.equal(X.mayGoodsOffer(actor), false, 'קבלת סחורה כבויה — אין הצעה');
  D.setSetting('wa_actions', { ...prev, goods_receipt: { enabled: true, audience: 'all' }, goods_offer: { enabled: true, audience: 'all' } });
  assert.equal(X.mayGoodsOffer(actor), true);
  assert.equal(X.mayGoodsOffer(null), false);
});
