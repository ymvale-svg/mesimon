'use strict';
/**
 * 🔊 הסקירה הלילית סופרת הקראות: בייצוא (‎usage.readAloud‎) ובסיכום של הדו"ח (שורה שנוספת לבד).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Review = require('../../../server/whatsapp/bot-review');

boot();
const logRow = (at, userId, result) => D.run(
  "INSERT INTO wa_log (at, channel, chat_id, chat_name, user_id, who, text, action, result, status, task_id, reply, forwarded) VALUES (?, 'private', '', '', ?, 'x', 'תקריא לי', 'my_tasks', ?, 'ok', NULL, '', 0)",
  at, userId, result
);

test('readAloudUsage — הצליחו, נכשלו, וכמה עובדים; רק בתקופה', () => {
  const a = user({ role: 'employee' });
  const b = user({ role: 'employee' });
  logRow('2030-01-01T08:00:00.000Z', a.id, 'נשלחה רשימה להיום: 3 משימות · 🔊 הוקרא');
  logRow('2030-01-01T09:00:00.000Z', a.id, 'נשלחה רשימה הפתוחות: 9 משימות · 🔊 הוקרא');
  logRow('2030-01-01T10:00:00.000Z', b.id, 'נשלחה רשימה להיום: 1 משימות · 🔊 הוקרא');
  logRow('2030-01-01T11:00:00.000Z', b.id, 'נשלחה רשימה להיום: 1 משימות · 🔇 הקראה נכשלה: 429');
  logRow('2030-01-03T08:00:00.000Z', a.id, 'נשלחה רשימה להיום: 3 משימות · 🔊 הוקרא');
  logRow('2030-01-01T12:00:00.000Z', a.id, 'נשלחה רשימה להיום: 3 משימות');
  assert.deepEqual(Review.readAloudUsage('2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'), { ok: 3, failed: 1, users: 2 });
  assert.deepEqual(Review.readAloudUsage('2031-01-01T00:00:00.000Z', '2031-01-02T00:00:00.000Z'), { ok: 0, failed: 0, users: 0 });
});

test('exportSince — usage.readAloud בייצוא', () => {
  const u = user({ role: 'employee' });
  logRow(new Date(Date.now() - 60000).toISOString(), u.id, 'נשלחה רשימה להיום: 2 משימות · 🔊 הוקרא');
  const out = Review.exportSince(new Date(Date.now() - 3600000).toISOString());
  assert.ok(out.usage.readAloud.ok >= 1);
  assert.ok(out.usage.readAloud.users >= 1);
});

test('sendReport — שורת ההקראות נוספת לסיכום לבד; בלי הקראות — בלי שורה', async () => {
  const u = user({ role: 'employee' });
  logRow('2030-02-01T08:00:00.000Z', u.id, 'נשלחה רשימה להיום: 2 משימות · 🔊 הוקרא');
  const r = await Review.sendReport({ subject: 'סקירה', summary: 'יום רגיל.', since: '2030-02-01T00:00:00Z', until: '2030-02-02T00:00:00Z', conversations: 1, succeeded: 1 });
  assert.equal(D.get('SELECT summary FROM bot_reviews WHERE id = ?', r.id).summary, 'יום רגיל.\n\n🔊 הקראות: 1 (עובד אחד)');
  const r2 = await Review.sendReport({ subject: 'סקירה', summary: 'שקט.', since: '2030-03-01T00:00:00Z', until: '2030-03-02T00:00:00Z' });
  assert.equal(D.get('SELECT summary FROM bot_reviews WHERE id = ?', r2.id).summary, 'שקט.');
});
