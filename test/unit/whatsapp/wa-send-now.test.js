'use strict';
/**
 * סקירה לילית 15.11: טיוטת מייל חיכתה, והעובד כתב "שלח מייל. אל תוסיף מה שהצעת" — הבוט הכין את הטיוטה שוב,
 * והמייל לא נשלח. "שלח" / "שלח את זה" / "שלח מייל, בלי ההצעות" על טיוטת מייל — אישור.
 * בדיקה ב-‎dry‎: האישור מחזיר "📧 נשלח…" בלי לשלוח באמת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');
const { SEND_NOW } = require('../../../server/whatsapp/wa-flows');

boot();

test('"שלח" על טיוטת מייל — אישור; בקשה חדשה ("שלח מייל לדני") — לא', () => {
  for (const t of ['שלח', 'תשלח', 'שלח את זה', 'שלח מייל', 'שלח מייל. אל תוסיף מה שהצעת', 'תשלח בלי ההצעות', 'שלח כמו שהוא', 'לשלוח!'])
    assert.ok(SEND_NOW.test(t), t);
  for (const t of ['שלח מייל לדני', 'שלח לו גם את הקובץ', 'שלח לי את Today', 'שלחתי כבר'])
    assert.ok(!SEND_NOW.test(t), t);
});

test('"שלח מייל. אל תוסיף מה שהצעת" — המייל נשלח, לא נוסח מחדש', async () => {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const draft = { kind: 'email', contact: { name: 'גולן', email: 'g@example.test', type: 'contact' }, draft: { subject: 'ישיבת המשך', body: 'מתי נוח לך?' } };
  const r = await Bot._internal.converse(u, actor, 'שלח מייל. אל תוסיף מה שהצעת', { ...Bot._internal.chatOf(u.id), draft, awaiting: true }, { dry: true });
  assert.equal(r.action, 'send_email');
  assert.equal(r.next.draft, null);
  assert.doesNotMatch(r.reply, /טיוטה/);
});
