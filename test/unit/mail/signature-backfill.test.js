'use strict';
/**
 * ✍️ קריאה מחדש של החתימות מהמיילים הקיימים — בלי רשת: Gmail ו-Claude מזויפים.
 * התואר נשמר רק ממה שהאדם עצמו שלח; כל מי שנבדק מסומן ולא נבדק שוב; תקלה ב-AI — נשאר לסבב הבא.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { user, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations').Gmail;
const Memory = require('../../../server/mail/mail-memory');
const SB = require('../../../server/mail/signature-backfill');
const Fakes = require('../../fakes');

const person = (userId, email, mailsIn = 3) => D.run(
  'INSERT INTO mail_people (user_id, email, name, mails_in, last_at, updated_at) VALUES (?,?,?,?,?,?)', userId, email, email, mailsIn, D.nowIso(), D.nowIso());
const titleOf = (userId, email) => D.get('SELECT title, title_checked_at FROM mail_people WHERE user_id = ? AND email = ?', userId, email);

function fakeGmail(t, mails) {
  t.mock.method(Memory, 'boxesFor', () => ['box0']);
  t.mock.method(Gmail, 'has', () => true);
  t.mock.method(Gmail, 'search', async (who, q) => {
    const email = /from:(\S+)/.exec(q)[1];
    return mails.filter((m) => m.from === email).map((m) => m.id);
  });
  t.mock.method(Memory._internal, 'fetchMail', async (who, id) => {
    const m = mails.find((x) => x.id === id);
    return { from: { address: m.from }, newText: m.text, text: m.text };
  });
}

test('תואר מהחתימה נשמר; בלי חתימה — ריק; כולם מסומנים כנבדקו ולא נבדקים שוב', async (t) => {
  const u = user();
  person(u.id, 'amit@x.test');
  person(u.id, 'nosig@x.test');
  person(u.id, 'never@x.test', 0);          // לא שלח אף פעם — לא נבדק
  fakeGmail(t, [
    { id: 'm1', from: 'amit@x.test', text: 'מצורף.\n\nבברכה,\nעמית לנג\nחשב | אשל' },
    { id: 'm2', from: 'nosig@x.test', text: 'תודה' }
  ]);
  const ai = Fakes.claude(t, (opts) => {
    assert.match(opts.content[0].text, /חשב \| אשל/);
    return { people: [{ email: 'amit@x.test', title: 'חשב' }, { email: 'nosig@x.test', title: '' }] };
  });
  assert.equal(SB.remaining(u.id), 2);
  assert.equal(await SB.stepUser(u.id), 2);
  assert.equal(titleOf(u.id, 'amit@x.test').title, 'חשב');
  assert.equal(titleOf(u.id, 'nosig@x.test').title, '');
  assert.ok(titleOf(u.id, 'nosig@x.test').title_checked_at);
  assert.equal(titleOf(u.id, 'never@x.test').title_checked_at, null);
  assert.equal(SB.remaining(u.id), 0);
  assert.equal(await SB.stepUser(u.id), 0, 'לא נבדק פעמיים');
  assert.equal(ai.calls.length, 1);
});

test('תקלה ב-AI — לא מסומן, נשאר לסבב הבא', async (t) => {
  const u = user();
  person(u.id, 'dana@x.test');
  fakeGmail(t, [{ id: 'm3', from: 'dana@x.test', text: 'דנה\nמנהלת פרויקטים' }]);
  Fakes.claude(t, () => { const e = new Error('עומס'); e.retryable = true; throw e; });
  await SB.stepUser(u.id);
  assert.equal(titleOf(u.id, 'dana@x.test').title_checked_at, null);
  assert.equal(SB.remaining(u.id), 1);
});

test('הודעה שנמצאה בחיפוש אבל נשלחה ממישהו אחר — לא נחשבת חתימה שלו', async (t) => {
  const u = user();
  person(u.id, 'yossi@x.test');
  fakeGmail(t, [{ id: 'm4', from: 'yossi@x.test', text: 'x' }]);
  t.mock.method(Memory._internal, 'fetchMail', async () => ({ from: { address: 'other@x.test' }, newText: 'אחר\nמנכ"ל' }));
  const ai = Fakes.claude(t, () => ({ people: [] }));
  await SB.stepUser(u.id);
  assert.equal(ai.calls.length, 0);
  assert.equal(titleOf(u.id, 'yossi@x.test').title, '');
  assert.ok(titleOf(u.id, 'yossi@x.test').title_checked_at);
});
