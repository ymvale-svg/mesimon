'use strict';
/**
 * 🔁 "אפשר לנסות שוב" (הוחלט 20.11.26): עובד ניסה ולא הצליח, ותיקנו — הבוט כותב לו לנסות שוב את אותה בקשה.
 * הסקירה שומרת בתיקון מי נכשל ומה ביקש; כשהתיקון נכנס (מוזג / "טופל") — הודעה אחת לכל עובד, בשעות העבודה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const Review = require('../../../server/whatsapp/bot-review');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
const workday = (t) => t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T08:00:00Z') }); // יום ג׳ 10:00

async function review(gilad) {
  const r = await Review.sendReport({ subject: 'סקירה', summary: 'x', fixes: [
    { title: 'קובץ מהמייל לוואטסאפ', problem: 'קיבל רק שמות קבצים', kind: 'feature', url: 'https://github.com/x/y/pull/256',
      retry: [{ userId: gilad.id, ask: 'תמצא לי מצגת מלונאות רכסים', note: 'עכשיו הקובץ עצמו נשלח אליך כאן' }, { userId: 999999, ask: 'משתמש שלא קיים' }] },
    { title: 'תיקון בלי עובד', problem: 'x', kind: 'code' }
  ] });
  return D.get('SELECT id FROM bot_reviews ORDER BY id DESC LIMIT 1').id ?? r;
}

test('הדו"ח שומר מי ניסה ולא הצליח (רק משתמש פעיל), והייצוא מחזיר אותו בלי שנשלח עדיין', async () => {
  const gilad = user({ full_name: 'גלעד בדיקה', phone: '972507900001', role: 'employee' });
  const id = await review(gilad);
  const fb = Review.feedback().find((f) => f.reviewId === id && f.n === 1);
  assert.deepEqual(fb.retry, [{ userId: gilad.id, who: 'גלעד בדיקה', ask: 'תמצא לי מצגת מלונאות רכסים', invitedAt: null }]);
  assert.deepEqual(Review.feedback().find((f) => f.reviewId === id && f.n === 2).retry, []);
});

test('retry-invite — העובד מקבל "ביקשת … תיקנו … אפשר לנסות שוב", פעם אחת בלבד', async (t) => {
  workday(t);
  const wa = Fakes.whatsapp(t);
  const gilad = user({ full_name: 'גלעד שני', phone: '972507900002', role: 'employee' });
  const id = await review(gilad);
  const r = Review.retryInvite([{ reviewId: id, n: 1 }]);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.sent.map((x) => x.who), ['גלעד שני']);
  const text = wa.texts().join('\n');
  assert.match(text, /🔧 גלעד, ביקשת ממני "תמצא לי מצגת מלונאות רכסים" — וזה לא הסתדר\./);
  assert.match(text, /תיקנו: עכשיו הקובץ עצמו נשלח אליך כאן/);
  assert.match(text, /אפשר לנסות שוב עכשיו/);
  assert.ok(Review.feedback().find((f) => f.reviewId === id && f.n === 1).retry[0].invitedAt);
  // פעם שנייה — לא שוב
  wa.clear();
  assert.deepEqual(Review.retryInvite([{ reviewId: id, n: 1 }]).sent, []);
  assert.equal(wa.texts().length, 0);
});

test('מנהל מסמן "טופל" — ההזמנה לנסות שוב יוצאת לבד', async (t) => {
  workday(t);
  const wa = Fakes.whatsapp(t);
  const gilad = user({ full_name: 'גלעד שלישי', phone: '972507900003', role: 'employee' });
  const id = await review(gilad);
  Review.setFixStatus(id, 1, { status: 'done' }, { name: 'מנהל' });
  await new Promise((res) => setImmediate(res));
  assert.match(wa.texts().join('\n'), /🔧 גלעד, ביקשת ממני/);
});

test('מחוץ לשעות העבודה — ההודעה נשמרת בתור לבוקר, ומסומנת כנשלחה', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T19:45:00Z') }); // 21:45
  const wa = Fakes.whatsapp(t);
  const gilad = user({ full_name: 'גלעד רביעי', phone: '972507900004', role: 'employee' });
  const id = await review(gilad);
  Review.retryInvite([{ reviewId: id, n: 1 }]);
  assert.equal(wa.texts().length, 0);
  assert.match(D.get('SELECT text FROM wa_outbox WHERE user_id = ?', gilad.id).text, /אפשר לנסות שוב/);
});
