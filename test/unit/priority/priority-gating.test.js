'use strict';
/**
 * 🔐 פריוריטי — רק למי שמורשה, בכל ערוץ ("תוכנית — חלוקת תפקידים בוט ומשימון.md", סעיף 2; הוחלט 13.11.26).
 * המקור היחיד: מטריצת ההרשאות (‎priority-access.js‎).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Bot = require('../../../server/whatsapp/wa-bot');
const Access = require('../../../server/priority/priority-access');
const GR = require('../../../server/priority/goods-receipt');
const Docs = require('../../../server/priority/priority-docs');
const RFQ = require('../../../server/priority/rfq');
const Fakes = require('../../fakes');
const Claude = require('../../../server/integrations/claude');
/** פריוריטי ו-AI "מוגדרים" (זיוף) — כדי להגיע לתפריט */
const connected = (t) => { Fakes.priority(t); t.mock.method(Claude, 'isEnabled', () => true); };

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
const ON = { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'all' } };
test.beforeEach(() => D.setSetting('wa_actions', ON));
test.afterEach(() => D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_access%'));

let phoneSeq = 0;
/** עובד עם הרשאות במטריצה: ‎docs‎ — ‎['receipt']‎ / ‎['demand']‎ / ‎[]‎ */
function worker(docs) {
  const phone = `97250700${String(++phoneSeq).padStart(4, '0')}`;
  const u = rawUser({ full_name: 'עובד', role: 'employee', phone });
  Access.save([{ id: u.id, docs }]);
  return u;
}
const actor = (u) => ({ type: 'user', id: u.id, role: u.role });

let seq = 0;
function fakeWhatsApp(t) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  return calls;
}
const say = (u, text) => Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text, id: `g${++seq}` });
const sent = (calls) => calls.filter((c) => c.method !== 'sendReaction');
const textOf = (c) => c.body.message ?? c.body.body ?? '';

test('בלי הרשאה — "פריוריטי" (גם כפתור מהודעה ישנה): תשובה אחת ברורה, בלי תפריט', async (t) => {
  const u = worker([]);
  for (const text of ['פריוריטי', '🗂 פריוריטי', 'קבלת סחורה', 'דרישת רכש: 10 שקי מלט']) {
    const calls = fakeWhatsApp(t);
    await say(u, text);
    const out = sent(calls).filter((c) => c.body?.chatId === `${u.phone}@c.us`);
    assert.equal(out.length, 1, text);
    // דרישת רכש — "אין לך הרשאה ליצור דרישת רכש", והבקשה עוברת למנהל המערכת (הוחלט 20.11.26)
    if (/דרישת רכש/.test(text)) assert.match(textOf(out[0]), /אין לך הרשאה ליצור דרישת רכש/, text);
    else assert.equal(textOf(out[0]), Access.NO_ACCESS, text);
    assert.equal(out[0].method, 'sendMessage', `${text} — בלי כפתורים`);
    t.mock.restoreAll();
  }
  assert.equal(GR.inMenu(u.id), false);
});

test('בלי הרשאה — משפט ארוך שמזכיר פריוריטי אינו נחסם (הולך לבוט הרגיל)', async (t) => {
  const u = worker([]);
  const calls = fakeWhatsApp(t);
  await say(u, 'תזכיר לי מחר לשאול את דני על פריוריטי');
  assert.ok(sent(calls).every((c) => textOf(c) !== Access.NO_ACCESS));
});

test('קבלת סחורה בלבד — "פריוריטי" נכנס ישר לקבלת הסחורה, בלי תפריט', async (t) => {
  connected(t);
  const u = worker(['receipt']);
  GR._clear(u.id);
  const r = await GR.handle({ user: u, text: 'פריוריטי', allow: { gr: true, pd: false } });
  assert.match(r.replies[0], /שלחו צילום של תעודת המשלוח/);
  assert.doesNotMatch(r.replies[0], /דרישת רכש/);
  assert.equal(GR.inMenu(u.id), false);
  GR._clear(u.id);
});

test('דרישת רכש בלבד — בתפריט רק "🛒 דרישת רכש"', async (t) => {
  connected(t);
  const u = worker(['demand']);
  const calls = fakeWhatsApp(t);
  await say(u, 'פריוריטי');
  const out = sent(calls);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].body.buttons.map((b) => b.buttonText), ['🛒 דרישת רכש']);
  assert.doesNotMatch(textOf(out[0]), /קבלת סחורה/);
  GR._clear(u.id);
});

test('שתי ההרשאות — שני הכפתורים, כמו קודם', async (t) => {
  connected(t);
  const u = worker(['receipt', 'demand']);
  GR._clear(u.id);
  const r = await GR.handle({ user: u, text: 'פריוריטי', allow: { gr: true, pd: true } });
  assert.deepEqual(r.buttons, ['📦 קבלת סחורה', '🛒 דרישת רכש']);
  GR._clear(u.id);
});

test('טור המיילים במסך פריוריטי — ריק למי שאין לו הרשאה, גם כשנשמרה לו חשבונית', () => {
  const none = worker([]);
  const ok = worker(['receipt']);
  for (const u of [none, ok]) {
    D.run(`INSERT INTO mail_goods_docs (user_id, gmail_id, filename, status, created_at) VALUES (?, ?, 'inv.pdf', 'pending', ?)`, u.id, `m${u.id}`, D.nowIso());
  }
  assert.deepEqual(Docs.inbox(actor(none)), []);
  assert.equal(Docs.inbox(actor(ok)).length, 1);
});

test('סיכום הצעות המחיר — [לדרישת רכש 🛒] רק למורשה לדרישה; לחיצה בלי הרשאה נענית בלי לפתוח', async () => {
  const seed = (u) => {
    const id = Number(D.run("INSERT INTO rfq (user_id, status, request, item, created_at) VALUES (?, 'collecting', 'x', ?, ?)",
      u.id, JSON.stringify({ item: 'פטישון', quantity: 2 }), D.nowIso()).lastInsertRowid);
    D.run("INSERT INTO rfq_vendors (rfq_id, name, email, status, offer) VALUES (?, 'ספק א', 'a@x.test', 'replied', ?)", id, JSON.stringify({ total_price: '100', total_number: 100, vat: 'כולל' }));
    return id;
  };
  const no = worker(['receipt']);
  const yes = worker(['demand']);
  assert.ok(!RFQ.summaryOf(seed(no)).buttons.includes(RFQ.BTN.demand));
  assert.ok(RFQ.summaryOf(seed(yes)).buttons.includes(RFQ.BTN.demand));
  const r = await RFQ.answerDone(no.id, { kind: 'rfq_done', rfqId: seed(no) }, RFQ.BTN.demand);
  assert.equal(r.demand, undefined);
  assert.match(r.text, /לא פתוחה לך/);
});
