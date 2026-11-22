'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../../server/mail/insight-window');

const WEEK = [0, 1, 2, 3, 4]; // ראשון–חמישי
// 08.11.2026 — יום ראשון, 09:00 בישראל (שעון חורף, ‎+02:00‎)
const SUNDAY = new Date('2026-11-08T07:00:00Z');
// 10.11.2026 — יום שלישי
const TUESDAY = new Date('2026-11-10T07:00:00Z');

test('normalize — ברירת מחדל 24 שעות בלי הערה', () => {
  assert.deepEqual(R.normalize(null), { unit: 'hours', n: 24, note: '', auto: false });
  assert.deepEqual(R.normalize({ unit: 'hours', n: 24 }), { unit: 'hours', n: 24, note: '', auto: false });
});

test('normalize — שעות מעוגלות למעלה לכפולה של 24, עם הערה', () => {
  const s = R.normalize({ unit: 'hours', n: 30 });
  assert.equal(s.n, 48);
  assert.match(s.note, /עיגלתי ל-48/);
});

test('normalize — עד 168 שעות ועד 7 ימי עבודה', () => {
  assert.equal(R.normalize({ unit: 'hours', n: 500 }).n, 168);
  assert.match(R.normalize({ unit: 'hours', n: 500 }).note, /עד 168/);
  const w = R.normalize({ unit: 'workdays', n: 10 });
  assert.equal(w.n, 7);
  assert.match(w.note, /עד 7 ימי עבודה/);
});

test('normalize — ימי עבודה: אפס או שלילי הופכים ליום אחד', () => {
  assert.equal(R.normalize({ unit: 'workdays', n: 0 }).n, 1);
  assert.equal(R.normalize({ unit: 'workdays', n: -3 }).n, 1);
  assert.equal(R.normalize({ unit: 'workdays', n: 2, auto: 1 }).auto, true);
});

test('workdaysBack — מדלג על שישי ושבת', () => {
  assert.equal(R.workdaysBack(WEEK, '2026-11-08', 1), '2026-11-05');
  assert.equal(R.workdaysBack(WEEK, '2026-11-08', 2), '2026-11-04');
  assert.equal(R.workdaysBack(WEEK, '2026-11-10', 1), '2026-11-09');
});

test('workdaysBack — עובד של יום אחד בשבוע', () => {
  assert.equal(R.workdaysBack([2], '2026-11-10', 1), '2026-11-03');
  assert.equal(R.workdaysBack([2], '2026-11-10', 2), '2026-10-27');
});

test('defaultSpec — ביום הראשון אחרי סוף שבוע: מאז יום העבודה הקודם', () => {
  assert.deepEqual(R.defaultSpec(WEEK, SUNDAY), { unit: 'workdays', n: 1, auto: true });
  assert.deepEqual(R.defaultSpec(WEEK, TUESDAY), { unit: 'hours', n: 24, auto: true });
  assert.deepEqual(R.defaultSpec([], SUNDAY), { unit: 'workdays', n: 1, auto: true }, 'רשימה ריקה — ימי ברירת המחדל');
});

test('windowOf — בשעות: אחורה מעכשיו', () => {
  const w = R.windowOf(WEEK, { unit: 'hours', n: 48 }, TUESDAY);
  assert.equal(w.sinceIso, '2026-11-08T07:00:00.000Z');
  assert.equal(w.hours, 48);
  assert.equal(w.startDay, null);
  assert.equal(w.label, '48 שעות');
});

test('windowOf — ביום ראשון: מחצות של חמישי, שעון ישראל', () => {
  const w = R.windowOf(WEEK, R.defaultSpec(WEEK, SUNDAY), SUNDAY);
  assert.equal(w.startDay, '2026-11-05');
  assert.equal(w.sinceIso, '2026-11-04T22:00:00.000Z');
  assert.equal(w.hours, 81);
  assert.equal(w.label, 'מיום חמישי 5.11 עד עכשיו');
  assert.equal(w.span, 'מאז יום העבודה הקודם');
});

test('windowOf — ימי עבודה שנבקשו במפורש: הכיתוב לפי המספר', () => {
  assert.equal(R.windowOf(WEEK, { unit: 'workdays', n: 2 }, TUESDAY).span, '2 ימי עבודה');
  assert.equal(R.windowOf(WEEK, { unit: 'workdays', n: 1 }, TUESDAY).span, 'יום עבודה אחד');
});

test('parseRange — שעות', () => {
  assert.deepEqual(R.parseRange('תובנות מ-48 שעות'), { unit: 'hours', n: 48 });
  assert.deepEqual(R.parseRange('72h'), { unit: 'hours', n: 72 });
  assert.deepEqual(R.parseRange('מהיממה האחרונה'), { unit: 'hours', n: 24 });
  assert.deepEqual(R.parseRange('ביממתיים'), { unit: 'hours', n: 48 });
  assert.deepEqual(R.parseRange('מה היה השבוע'), { unit: 'hours', n: 168 });
});

test('parseRange — ימי עבודה, במספרים ובמילים', () => {
  assert.deepEqual(R.parseRange('מאתמול'), { unit: 'workdays', n: 1 });
  assert.deepEqual(R.parseRange('מהיומיים האחרונים'), { unit: 'workdays', n: 2 });
  assert.deepEqual(R.parseRange('משלשום'), { unit: 'workdays', n: 2 });
  assert.deepEqual(R.parseRange('3 ימים'), { unit: 'workdays', n: 3 });
  assert.deepEqual(R.parseRange('משלושת הימים האחרונים'), { unit: 'workdays', n: 3 });
  assert.deepEqual(R.parseRange('חמישה ימים'), { unit: 'workdays', n: 5 });
});

test('parseRange — בלי טווח: null', () => {
  assert.equal(R.parseRange(''), null);
  assert.equal(R.parseRange(null), null);
  assert.equal(R.parseRange('מה חדש במייל?'), null);
});

test('specFrom — מה שה-AI החזיר גובר, ואם לא — מהטקסט', () => {
  assert.deepEqual(R.specFrom({ unit: 'hours', n: '72' }, 'מאתמול'), { unit: 'hours', n: 72 });
  assert.deepEqual(R.specFrom({ unit: 'default', n: 0 }, 'מאתמול'), { unit: 'workdays', n: 1 });
  assert.equal(R.specFrom(undefined, ''), null);
});

test('dayLabel ו-workdaysLabel', () => {
  assert.equal(R.dayLabel('2026-11-04'), 'יום רביעי 4.11');
  assert.equal(R.workdaysLabel(1), 'יום עבודה אחד');
  assert.equal(R.workdaysLabel(3), '3 ימי עבודה');
});
