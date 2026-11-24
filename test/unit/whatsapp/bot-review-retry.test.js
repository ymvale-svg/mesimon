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

test('retry-invite — העובד מקבל "ניסית … תיקנו … לידיעתך, כרגע אפשר לנסות שוב", פעם אחת בלבד', async (t) => {
  workday(t);
  const wa = Fakes.whatsapp(t);
  const gilad = user({ full_name: 'גלעד שני', phone: '972507900002', role: 'employee' });
  const id = await review(gilad);
  const r = Review.retryInvite([{ reviewId: id, n: 1 }]);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.sent.map((x) => x.who), ['גלעד שני']);
  const text = wa.texts().join('\n');
  assert.match(text, /🔧 גלעד, ניסית "תמצא לי מצגת מלונאות רכסים" — וזה לא הסתדר\./);
  assert.match(text, /תיקנו: עכשיו הקובץ עצמו נשלח אליך כאן/);
  assert.match(text, /לידיעתך, כרגע אפשר לנסות שוב/);
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
  assert.match(wa.texts().join('\n'), /🔧 גלעד, ניסית /);
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

// הוחלט 24.11.26: "ניסית 1, 2, 3 — לידיעתך, כרגע אפשר" — כמה תיקונים לאותו עובד: הודעה אחת ממוספרת, לא כמה הודעות
test('כמה תיקונים לאותו עובד — הודעה אחת: "ניסית כמה דברים … 1. … 2. … לידיעתך, כרגע אפשר"', async (t) => {
  workday(t);
  const wa = Fakes.whatsapp(t);
  const hasan = user({ full_name: 'חסן חמישי', phone: '972507900005', role: 'employee' });
  const other = user({ full_name: 'מלכה חמישית', phone: '972507900006', role: 'employee' });
  await Review.sendReport({ subject: 'סקירה', summary: 'x', fixes: [
    { title: 'א', problem: 'x', kind: 'bug', retry: [{ userId: hasan.id, ask: 'לשנות כמות בדרישה ל-20', note: 'עכשיו אפשר לתקן גם בשאלה "איך להמשיך?"' }] },
    { title: 'ב', problem: 'x', kind: 'bug', retry: [{ userId: hasan.id, ask: 'הזמנת רכש חדשה', note: 'מזוהה כדרישת רכש' }, { userId: other.id, ask: 'סטטוס התחדשות עירונית' }] },
    { title: 'ג', problem: 'x', kind: 'bug', retry: [{ userId: hasan.id, ask: 'הזמנת רכש חדשה', note: 'אותה תקלה' }] }
  ] });
  const id = D.get('SELECT id FROM bot_reviews ORDER BY id DESC LIMIT 1').id;
  const r = Review.retryInvite([{ reviewId: id, n: 1 }, { reviewId: id, n: 2 }, { reviewId: id, n: 3 }]);
  await new Promise((res) => setImmediate(res));
  const texts = wa.texts();
  assert.equal(texts.length, 2, 'הודעה אחת לכל עובד');
  const toHasan = texts.find((x) => /חסן/.test(x));
  assert.match(toHasan, /🔧 חסן, ניסית כמה דברים בבוט שלא הסתדרו — תיקנו אותם:\n1\. "לשנות כמות בדרישה ל-20" — עכשיו אפשר לתקן/);
  assert.match(toHasan, /\n2\. "הזמנת רכש חדשה" — מזוהה כדרישת רכש\n/);
  assert.doesNotMatch(toHasan, /\n3\./, 'אותה בקשה — פעם אחת');
  assert.match(toHasan, /לידיעתך, כרגע אפשר לנסות שוב/);
  assert.match(texts.find((x) => /מלכה/.test(x)), /🔧 מלכה, ניסית "סטטוס התחדשות עירונית" — וזה לא הסתדר\.\nתיקנו את זה\./);
  assert.equal(r.sent.length, 4);
  const fb = Review.feedback().filter((f) => f.reviewId === id);
  assert.ok(fb.every((f) => f.retry.every((x) => x.invitedAt)), 'כולם מסומנים כנשלחו');
  wa.clear();
  assert.deepEqual(Review.retryInvite([{ reviewId: id, n: 1 }, { reviewId: id, n: 2 }]).sent, []);
});
