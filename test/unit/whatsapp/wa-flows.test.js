'use strict';
/**
 * הניתוב של השיחה הפרטית (‎wa-flows.js‎): זרימה שעונה על שאלה שממתינה (‎flowOn…‎) לא תופסת הודעה
 * כשאין שאלה כזו — מחזירה ‎NEXT‎, והניתוב ממשיך לזרימה הבאה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Flows = require('../../../server/whatsapp/wa-flows');

boot();
const u = user({ full_name: 'עובד', role: 'employee', phone: '972509990001' });
const actor = { type: 'user', id: u.id, role: 'employee' };
const out = (reply, next, meta) => ({ reply, next, ...meta });

const pending = Object.keys(Flows).filter((k) => /^flowOn[A-Z]/.test(k));

test('יש זרימות לשאלות שממתינות', () => {
  assert.ok(pending.length >= 12, pending.join(', '));
  assert.equal(typeof Flows.NEXT, 'symbol');
});

for (const name of pending) {
  test(`${name} — בלי שאלה שממתינה: NEXT`, async () => {
    const ctx = { user: u, actor, t: 'שלום, מה שלומך היום', text: 'שלום, מה שלומך היום', state: { draft: null, awaiting: false, suggestions: [] }, dry: true, out, keep: {}, startReply: async () => null, kind: undefined };
    const r = await Flows[name](ctx);
    assert.equal(r, Flows.NEXT);
  });
}

test('flowCancel — "ביטול" עונה, הודעה אחרת: NEXT', async () => {
  const base = { out };
  assert.equal((await Flows.flowCancel({ ...base, t: 'ביטול' })).action, 'cancel');
  assert.equal(await Flows.flowCancel({ ...base, t: 'מה המשימות שלי' }), Flows.NEXT);
});

test('flowIntentDenied — פעולה שאינה מותרת לעובד: "אינה זמינה לך"', async () => {
  const r = await Flows.flowIntentDenied({ actor, u: { intent: 'no_such_intent' }, out });
  assert.ok(r === Flows.NEXT || /אינה זמינה לך/.test(r.reply));
});
