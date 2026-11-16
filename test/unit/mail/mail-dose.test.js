'use strict';
/**
 * 📉 מינון המייל לפי שימוש ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 3): שבוע עבודה בלי שימוש — מדרגה למטה
 * (100 → 50 → 20 → 0), שימוש — חזרה ל-100%, 3 "לא" ברצף — מדרגה, ומה כל מדרגה מקבלת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { user, D } = require('../../helpers/db');
const MailDose = require('../../../server/mail/mail-dose');

// 1.11.26 יום ראשון. ימי עבודה (א׳–ה׳) אחריו: 2–5.11, 8.11 (5), 9–12.11, 15.11 (10), 16–19.11, 22.11 (15)
const SUNDAY = '2026-11-01T08:00:00.000Z';
const usedAt = (u, iso = SUNDAY, extra = {}) => D.setUserPref(u.id, 'mailDose', { lastUse: iso, drops: 0, rejects: 0, ...extra });
const levelOn = (u, today) => MailDose.level(u.id, { today });

test('עובד חדש — 100%, והשעון מתחיל עכשיו (לא יורדים לכולם ביום ההפעלה)', () => {
  const u = user();
  assert.equal(MailDose.level(u.id), 0);
  assert.equal(MailDose.percent(u.id), 100);
  assert.ok(D.userPrefs(u.id).mailDose.lastUse);
});

test('כל 5 ימי עבודה בלי שימוש — מדרגה: 100 → 50 → 20 → 0, ולא מתחת', () => {
  const u = user();
  usedAt(u);
  assert.equal(levelOn(u, '2026-11-05'), 0); // 4 ימי עבודה
  assert.equal(levelOn(u, '2026-11-08'), 1); // 5 — שבוע
  assert.equal(levelOn(u, '2026-11-15'), 2);
  assert.equal(levelOn(u, '2026-11-22'), 3);
  assert.equal(levelOn(u, '2026-12-31'), 3);
  assert.deepEqual(MailDose.STEPS, [100, 50, 20, 0]);
});

test('שישי ושבת לא נספרים', () => {
  const u = user();
  usedAt(u, '2026-11-05T08:00:00.000Z'); // חמישי
  // שישי, שבת, ראשון–רביעי = 4 ימי עבודה
  assert.equal(levelOn(u, '2026-11-11'), 0);
  assert.equal(levelOn(u, '2026-11-12'), 1);
});

test('ימי שבוע לפי ההגדרה ‎ai_dose_week_days‎', (t) => {
  const u = user();
  usedAt(u);
  D.setSetting('ai_dose_week_days', 2);
  t.after(() => D.setSetting('ai_dose_week_days', 5));
  assert.equal(levelOn(u, '2026-11-05'), 2); // 4 ימים = 2 מדרגות
});

test('שימוש מחזיר ל-100%, ומדווח אם העובד היה מושהה', () => {
  const u = user();
  usedAt(u, '2026-01-01T08:00:00.000Z');
  assert.equal(MailDose.paused(u.id), true);
  assert.equal(MailDose.noteUse(u.id, 'walk'), true);
  assert.equal(MailDose.level(u.id), 0);
  assert.equal(MailDose.noteUse(u.id, 'walk'), false);
});

test('3 "לא" ברצף על הצעת תשובה — מדרגה למטה; שימוש מאפס', () => {
  const u = user();
  MailDose.noteUse(u.id);
  MailDose.noteReject(u.id);
  MailDose.noteReject(u.id);
  assert.equal(MailDose.level(u.id), 0);
  MailDose.noteReject(u.id);
  assert.equal(MailDose.level(u.id), 1);
  for (let i = 0; i < 6; i++) MailDose.noteReject(u.id);
  assert.equal(MailDose.level(u.id), 3);
  MailDose.noteUse(u.id);
  assert.equal(MailDose.level(u.id), 0);
});

test('הצעות בבוט: 100% — הכול; 50% — דחוף תמיד והשאר לסירוגין; 20% — אחת ביום, רק דחוף; 0% — כלום', () => {
  const full = user();
  MailDose.noteUse(full.id);
  assert.deepEqual([1, 2, 3].map(() => MailDose.mayOffer(full.id, 'normal')), [true, true, true]);

  const half = user();
  usedAt(half);
  const day = '2026-11-09'; // 5 ימי עבודה — 50%
  assert.equal(levelOn(half, day), 1);
  const normal = [1, 2, 3, 4].map(() => MailDose.mayOffer(half.id, 'normal', { today: day }));
  assert.deepEqual(normal, [true, false, true, false]);
  assert.equal(MailDose.mayOffer(half.id, 'urgent', { today: day }), true);
  assert.equal(MailDose.mayOffer(half.id, 'high', { today: day }), true);

  const fifth = user();
  usedAt(fifth);
  const day2 = '2026-11-16'; // 20%
  assert.equal(levelOn(fifth, day2), 2);
  assert.equal(MailDose.mayOffer(fifth.id, 'normal', { today: day2 }), false);
  assert.equal(MailDose.mayOffer(fifth.id, 'urgent', { today: day2 }), true);
  assert.equal(MailDose.mayOffer(fifth.id, 'urgent', { today: day2 }), false, 'רק אחת ביום');
  assert.equal(MailDose.mayOffer(fifth.id, 'urgent', { today: '2026-11-17' }), true, 'למחרת — שוב אחת');

  const off = user();
  usedAt(off, '2026-01-01T08:00:00.000Z');
  assert.equal(MailDose.mayOffer(off.id, 'urgent'), false);
});

test('הסריקה: 100% — כל סבב ותשובה מוכנה מראש; 50% — כל 30 דק\'; 20% — רק בבוקר; מושהה — בכלל לא', () => {
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const full = user();
  MailDose.noteUse(full.id);
  assert.equal(MailDose.liveDue(full.id, ago(1), { now }), true);
  assert.equal(MailDose.prepareReplies(full.id), true);
  assert.equal(MailDose.morningScan(full.id), true);

  const half = user();
  D.setUserPref(half.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 1 });
  assert.equal(MailDose.level(half.id), 1);
  assert.equal(MailDose.liveDue(half.id, ago(10), { now }), false);
  assert.equal(MailDose.liveDue(half.id, ago(30), { now }), true);
  assert.equal(MailDose.prepareReplies(half.id), false);

  const fifth = user();
  D.setUserPref(fifth.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 2 });
  assert.equal(MailDose.liveDue(fifth.id, ago(600), { now }), false);
  assert.equal(MailDose.morningScan(fifth.id), true);

  const off = user();
  D.setUserPref(off.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 3 });
  assert.equal(MailDose.liveDue(off.id, ago(600), { now }), false);
  assert.equal(MailDose.morningScan(off.id), false);
});

test('הודעת ההשהיה — פעם אחת להשהיה; אחרי חזרה והשהיה נוספת — שוב', () => {
  const u = user();
  D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 3 });
  assert.equal(MailDose.takePauseNotice(u.id), true);
  assert.equal(MailDose.takePauseNotice(u.id), false);
  MailDose.noteUse(u.id, 'resume');
  assert.equal(MailDose.takePauseNotice(u.id), false, 'לא מושהה — אין הודעה');
  D.setUserPref(u.id, 'mailDose', { ...D.userPrefs(u.id).mailDose, drops: 3 });
  assert.equal(MailDose.takePauseNotice(u.id), true);
});

test('מינון כבוי (‎ai_dose_enabled = false‎) — כולם 100%', (t) => {
  const u = user();
  usedAt(u, '2026-01-01T08:00:00.000Z');
  D.setSetting('ai_dose_enabled', false);
  t.after(() => D.setSetting('ai_dose_enabled', true));
  assert.equal(MailDose.level(u.id), 0);
  assert.equal(MailDose.mayOffer(u.id, 'normal'), true);
});
