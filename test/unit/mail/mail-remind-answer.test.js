'use strict';
/**
 * 🐣 תשובה ל"זכרת?" — "כן" / 👍 פירושם "זכרתי", לא "לפתוח משימה" (באג 15.11.26).
 * רק הכפתור, בקשה מפורשת, או "כן" על השאלה המפורשת "לפתוח משימה?" — פותחים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const MailActions = require('../../../server/mail/mail-actions');

boot();

function draftFor(u) {
  const info = D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', 'g-r1', 'h-r1', 'Google', 'no-reply@accounts.google.com', 'בקשה', ?, ?, ?)`,
    u.id, JSON.stringify({ title: 'לאשר בקשת איש קשר' }), D.nowIso(), D.nowIso()
  );
  return { kind: 'mail_remind', suggestionId: Number(info.lastInsertRowid), title: 'לאשר בקשת איש קשר' };
}

for (const answer of ['כן', 'כן ✅', '👍', 'זכרתי']) {
  test(`"${answer}" על "זכרת?" — לא פותח משימה, שואל "לפתוח משימה?"`, () => {
    const u = user();
    const r = MailActions.answerReminder(u.id, draftFor(u), answer);
    assert.ok(!r.openTask);
    assert.equal(r.ask, true);
    assert.equal(r.draft.confirm, true);
    assert.deepEqual(r.buttons, [MailActions.BTN.open, MailActions.BTN.ignore]);
  });
}

test('הכפתור "לפתוח משימה ✅" ובקשה מפורשת — פותחים', () => {
  const u = user();
  assert.equal(MailActions.answerReminder(u.id, draftFor(u), MailActions.BTN.open).openTask, true);
  assert.equal(MailActions.answerReminder(u.id, draftFor(u), 'פתח משימה').openTask, true);
});

test('"כן" / 👍 על השאלה המפורשת "לפתוח משימה?" — פותח', () => {
  const u = user();
  const first = MailActions.answerReminder(u.id, draftFor(u), 'כן');
  assert.equal(MailActions.answerReminder(u.id, first.draft, 'כן').openTask, true);
  assert.equal(MailActions.answerReminder(u.id, first.draft, '👍').openTask, true);
});

test('"התעלם" אחרי "כן" — לא נפתחת משימה', () => {
  const u = user();
  const first = MailActions.answerReminder(u.id, draftFor(u), 'כן');
  const r = MailActions.answerReminder(u.id, first.draft, MailActions.BTN.ignore);
  assert.ok(!r.openTask);
});

/*
 * "לא" על "זכרת?" — "לא זכרתי": דווקא אז צריך את המייל. עד 15.11.26 זה נחשב "התעלם" והמייל ירד.
 */
const remindOf = (id) => JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', id).data).remind ?? {};

for (const answer of ['לא', 'לא זכרתי', 'שכחתי']) {
  test(`"${answer}" על "זכרת?" — לא "התעלם": מציע לפתוח משימה, והמייל לא יורד`, () => {
    const u = user();
    const d = draftFor(u);
    const r = MailActions.answerReminder(u.id, d, answer);
    assert.ok(!r.openTask);
    assert.equal(r.ask, true);
    assert.equal(r.draft.confirm, true);
    assert.equal(remindOf(d.suggestionId).closed, undefined, 'לא סומן "התעלם"');
  });
}

test('"לא" על "לפתוח משימה?" — בלי משימה ובלי עוד תזכורות, אבל לא "התעלם"', () => {
  const u = user();
  const d = draftFor(u);
  const first = MailActions.answerReminder(u.id, d, 'לא');
  const r = MailActions.answerReminder(u.id, first.draft, 'לא');
  assert.ok(!r.openTask && !r.ask);
  assert.equal(remindOf(d.suggestionId).closed, 'declined');
  assert.equal(D.get('SELECT status FROM ai_suggestions WHERE id = ?', d.suggestionId).status, 'pending', 'נשאר ב"היום"');
});

test('"התעלם" ו-👎 — עדיין מתעלמים', () => {
  const u = user();
  const a = draftFor(u);
  MailActions.answerReminder(u.id, a, MailActions.BTN.ignore);
  assert.equal(remindOf(a.suggestionId).closed, 'ignored');
  const b = draftFor(u);
  MailActions.answerReminder(u.id, b, '👎');
  assert.equal(remindOf(b.suggestionId).closed, 'ignored');
});
