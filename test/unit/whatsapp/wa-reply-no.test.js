'use strict';
/**
 * 17.11: "💡 הצעת תשובה" על מייל, ואז "לא ❌" שלוש פעמים — בכל פעם הבוט ניסח את התשובה מחדש, במקום לוותר.
 * "לא" על טיוטת תשובה למייל = לא עונים: הטיוטה יורדת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');
const Fakes = require('../../fakes');
const MailInsights = require('../../../server/mail/mail-insights');

boot();
const draft = { kind: 'mail_reply', reply: { gmailId: 'g1', to: 'x@example.test', toName: 'שזר', subject: 'דרישות מהרכש', body: 'שלום' } };

test('"לא ❌" / "לא" / "👎" על טיוטת תשובה למייל — לא עונים, והטיוטה לא מנוסחת מחדש', async (t) => {
  Fakes.claude(t, () => ({}));
  for (const answer of ['לא ❌', 'לא', 'לא תודה', '👎']) {
    const u = user({ role: 'employee' });
    const actor = Auth.loadActor('user', u.id);
    const r = await Bot._internal.converse(u, actor, answer, { ...Bot._internal.chatOf(u.id), draft, awaiting: true });
    assert.equal(r.reply, 'בסדר, לא עונים 👍', answer);
    assert.equal(r.next.draft, null, answer);
  }
});

test('תיקון ("לא, תכתוב שזה יטופל מחר") — עדיין תיקון של הטיוטה', async (t) => {
  Fakes.claude(t, () => ({}));
  t.mock.method(MailInsights, 'draftReply', async () => ({ gmailId: 'g1', to: 'x@example.test', toName: 'שזר', subject: 'Re: דרישות', body: 'יטופל מחר' }));
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const r = await Bot._internal.converse(u, actor, 'לא, תכתוב שזה יטופל מחר', { ...Bot._internal.chatOf(u.id), draft, awaiting: true });
  assert.notEqual(r.reply, 'בסדר, לא עונים 👍');
});
