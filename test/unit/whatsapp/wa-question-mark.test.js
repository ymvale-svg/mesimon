'use strict';
/**
 * סקירה לילית 12.11: "?" לבד, כשטיוטת מייל חיכתה ל"כן" — הטיוטה ירדה ("לא נשלחה — עברתי לבקשה החדשה"),
 * והעובד קיבל "לא הבנתי" ואת "היום". "?" הוא לא בקשה חדשה: מזכירים מה מחכה, והטיוטה נשארת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
async function reply(text, d) {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const state = { ...Bot._internal.chatOf(u.id), draft: d, awaiting: true };
  return Bot._internal.converse(u, actor, text, state, { dry: true });
}
const email = { kind: 'email', contact: { name: 'רחל', email: 'r@example.test' }, draft: { subject: 'ימי הולדת', body: 'שלום' } };

test('"?" כשטיוטת מייל מחכה — הטיוטה נשארת, ומוזכר מה מחכה', async () => {
  for (const t of ['?', '??', ' ? ', '.', '…']) {
    const r = await reply(t, email);
    assert.doesNotMatch(r.reply, /לא נשלחה|עברתי/, t);
    assert.match(r.reply, /מחכה לתשובה שלך/, t);
    assert.match(r.reply, /רחל/, t);
    assert.equal(r.next.draft?.kind, 'email', t);
    assert.equal(r.next.awaiting, true, t);
    assert.ok(r.buttons?.length, 'כפתורי כן / לא');
  }
});

test('"?" כשטיוטת משימה מחכה — אותו דבר', async () => {
  const r = await reply('?', { kind: 'task', title: 'להתקשר לספק' });
  assert.match(r.reply, /להתקשר לספק/);
  assert.equal(r.next.draft?.title, 'להתקשר לספק');
});
