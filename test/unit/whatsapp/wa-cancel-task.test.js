'use strict';
/**
 * "תבטל את המשימה" — הבוט שואל "לבטל את …?" (ולא "לסמן כבוצע?"), ו"לבטל"/"ביטול" בתשובה הם אישור.
 * בלי AI: הטיוטה (‎draft.cancel‎) נבנית ישירות, ו-‎converse‎ רץ ב-‎dry‎ (בלי לסגור באמת).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
const draft = (cancel) => ({ kind: 'complete', taskId: 1, title: 'תור לספר', ...(cancel ? { cancel: true } : {}) });
async function reply(text, d) {
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const state = { ...Bot._internal.chatOf(u.id), draft: d, awaiting: true };
  return Bot._internal.converse(u, actor, text, state, { dry: true });
}

test('טיוטת ביטול: "לבטל" הוא אישור — "בוטלה (נסגרה)"', async () => {
  for (const t of ['לבטל', 'ביטול', 'כן']) {
    const r = await reply(t, draft(true));
    assert.match(r.reply, /✅ בוטלה \(נסגרה\): תור לספר/, t);
    assert.equal(r.next.draft, null);
  }
});

test('טיוטת "בוצע" רגילה: "כן" — "סומן כבוצע"; "ביטול" — מבטל את השאלה, לא סוגר', async () => {
  assert.match((await reply('כן', draft(false))).reply, /✅ סומן כבוצע: תור לספר/);
  const r = await reply('ביטול', draft(false));
  assert.equal(r.reply, 'בוטל 👍');
  assert.equal(r.action, 'cancel');
});
