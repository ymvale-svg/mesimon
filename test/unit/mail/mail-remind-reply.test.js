'use strict';
/**
 * 🐣 "זכרת?" — הבוט הוא המזכירה: מציע תשובה, לא משימה (הוחלט 15.11.26,
 * "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 0).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const MailActions = require('../../../server/mail/mail-actions');
const Gmail = require('../../../server/integrations').Gmail;
const MailInsights = require('../../../server/mail/mail-insights');
const WaMail = require('../../../server/whatsapp/wa-mail');

boot();
const { BTN } = MailActions;
const { reminderQuestion } = MailActions._internal;

function suggestion(u, data = {}) {
  const at = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const id = Number(D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, data, received_at, created_at)
     VALUES (?, 'task', 'pending', ?, ?, 'דני כהן', 'dani@x.co', 'הצעת מחיר', ?, ?, ?)`,
    u.id, `g${Date.now()}${Math.random()}`, `h${Math.random()}`, JSON.stringify({ title: 'לאשר הצעת מחיר', summary: 'מבקש לאשר את ההצעה.', toMe: true, ...data }), at, at
  ).lastInsertRowid);
  return D.get('SELECT * FROM ai_suggestions WHERE id = ?', id);
}
const remindOf = (id) => JSON.parse(D.get('SELECT data FROM ai_suggestions WHERE id = ?', id).data).remind ?? {};

test('"זכרת?" — הכפתורים: הצעת תשובה, טיפלתי, התעלם. בלי "לפתוח משימה"', () => {
  const q = reminderQuestion(suggestion(user()));
  assert.deepEqual(q.buttons, [BTN.reply, BTN.done, BTN.ignore]);
  assert.ok(!q.buttons.includes(BTN.open));
  assert.ok(q.buttons.length <= 3 && q.buttons.every((b) => b.length <= 20));
});

test('"כן" / 👍 / הכפתור — הצעת תשובה (לא משימה)', () => {
  const u = user();
  const row = suggestion(u);
  for (const t of [BTN.reply, 'כן', '👍', 'תציע לי תשובה']) {
    const r = MailActions.answerReminder(u.id, { suggestionId: row.id, title: 'x' }, t);
    assert.equal(r?.reply, true, t);
    assert.equal(r.openTask, undefined, t);
  }
});

test('"טיפלתי" — נסגר, ולא מזכירים שוב', () => {
  const u = user();
  const row = suggestion(u);
  const r = MailActions.answerReminder(u.id, { suggestionId: row.id, title: 'x' }, BTN.done);
  assert.match(r.text, /לא אזכיר/);
  assert.equal(remindOf(row.id).closed, 'handled');
});

test('"תפתח משימה" במילים — עדיין עובד (מי שמבקש במפורש)', () => {
  const u = user();
  const row = suggestion(u);
  assert.equal(MailActions.answerReminder(u.id, { suggestionId: row.id, title: 'x' }, 'תפתח משימה').openTask, true);
});

test('replyOffer — אין הצעה שמורה: מכין, שומר, ומחזיר "לענות כך?" עם כן / לא', async (t) => {
  const u = user();
  const row = suggestion(u);
  t.mock.method(Gmail, 'canSend', () => true);
  let made = 0;
  t.mock.method(MailInsights, 'suggestReply', async () => { made++; return { body: 'שלום דני, ההצעה מאושרת. בברכה', to: 'dani@x.co' }; });
  t.mock.method(MailInsights, 'completeReply', async (uid, r) => r);
  const o = await WaMail.replyOffer(u.id, row);
  assert.match(o.text, /לענות כך\?/);
  assert.match(o.text, /ההצעה מאושרת/);
  assert.equal(o.draft.kind, 'mail_reply');
  assert.deepEqual(o.draft.suggestionIds, [row.id]);
  assert.equal(o.buttons.length, 2);
  await WaMail.replyOffer(u.id, D.get('SELECT * FROM ai_suggestions WHERE id = ?', row.id));
  assert.equal(made, 1, 'ההצעה נשמרה — לא מוכנה פעמיים');
});

test('replyOffer — בלי הרשאת שליחה מהתיבה: שגיאה ברורה, בלי לקרוא ל-AI', async (t) => {
  const u = user();
  t.mock.method(Gmail, 'canSend', () => false);
  const ai = t.mock.method(MailInsights, 'suggestReply', async () => ({ body: 'x' }));
  assert.deepEqual(await WaMail.replyOffer(u.id, suggestion(u)), { error: 'cannot_send' });
  assert.equal(ai.mock.callCount(), 0);
});

test('מעבר על "היום" בבוט — מייל: לענות / להתעלם / הבא, בלי "למשימה"', () => {
  const { walkButtons } = require('../../../server/whatsapp/wa-menu');
  const { WALK } = require('../../../server/whatsapp/wa-base');
  for (const x of [{ t: 'mail' }, { t: 'mail', closure: true }, { t: 'ins', source: 'mail' }]) {
    const b = walkButtons(x);
    assert.equal(b[0], WALK.reply);
    assert.ok(!b.includes(WALK.task), JSON.stringify(x));
  }
});

/*
 * "לא" על "זכרת?" = "לא זכרתי" — דווקא אז צריך את המייל. עד 20.11.26 "לא" לבד נחשב "התעלם",
 * והמייל ירד מכל הרשימות. מעכשיו — כמו "כן": הבוט מציע תשובה, והמייל לא יורד.
 */
test('"לא" / "לא זכרתי" / "שכחתי" — הצעת תשובה, לא "התעלם"', () => {
  const u = user();
  for (const t of ['לא', 'לא זכרתי', 'שכחתי']) {
    const row = suggestion(u);
    const r = MailActions.answerReminder(u.id, { suggestionId: row.id, title: 'x' }, t);
    assert.equal(r?.reply, true, t);
    assert.equal(remindOf(row.id).closed, undefined, `${t} — לא סומן "התעלם"`);
  }
});

test('"התעלם", 👎, "לא צריך", "עזוב" — עדיין מתעלמים', () => {
  const u = user();
  for (const t of [BTN.ignore, '👎', 'לא צריך', 'עזוב']) {
    const row = suggestion(u);
    MailActions.answerReminder(u.id, { suggestionId: row.id, title: 'x' }, t);
    assert.equal(remindOf(row.id).closed, 'ignored', t);
  }
});
