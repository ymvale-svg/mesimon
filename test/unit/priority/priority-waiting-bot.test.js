'use strict';
/**
 * ✍️ הבוט: "מה מחכה לחתימה שלי" / "ששלחתי לאישור" / "🔁 כמחליף" — מה שממתין בפריוריטי (‎priority-waiting.js‎ + ‎flowPriorityWaiting‎).
 * האפיון: "אפיון — מסך אישורים במשימון פריוריטי.md" (שלב הבוט). פריוריטי — זיוף; הנתונים — ישר בטבלה ‎priority_waiting‎.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaActions = require('../../../server/whatsapp/wa-actions');
const Access = require('../../../server/priority/priority-access');
const GR = require('../../../server/priority/goods-receipt');
const W = require('../../../server/priority/priority-waiting');
const Fakes = require('../../fakes');
const Claude = require('../../../server/integrations/claude');
/** פריוריטי ו-AI "מוגדרים" (זיוף) — כדי להגיע לתפריט */
const connected = (t) => { Fakes.priority(t, { priorityUsers: async () => [] }); t.mock.method(Claude, 'isEnabled', () => true); };

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
const ON = { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'all' } };
test.beforeEach(() => { D.setSetting('wa_actions', ON); D.run('DELETE FROM priority_waiting'); });
test.afterEach(() => D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_access%'));

let phoneSeq = 0;
function worker(docs, name = 'עובד') {
  const phone = `97250800${String(++phoneSeq).padStart(4, '0')}`;
  const u = rawUser({ full_name: name, role: 'employee', phone, status: 'active' });
  Access.save([{ id: u.id, docs }]);
  return u;
}
const actor = (u) => ({ type: 'user', id: u.id, role: u.role });
let rowSeq = 0;
/** מסמך ממתין: ‎signer‎ / ‎owner‎ — משתמשי משימון */
function waiting({ signer = null, alt = null, owner = null, docno = `PO${++rowSeq}`, screen = 'PORDERS', days = 2 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  D.run(`INSERT INTO priority_waiting (org_id, company, screen, docno, status, signer, signer_user_id, alt, alt_user_id, party, project, amount, owner,
    owner_login, owner_user_id, since, first_seen, seen_at) VALUES (1, 'a160226', ?, ?, 'מחכה לאישור', ?, ?, ?, ?, 'ספק בע"מ', 'רכסים', 1500, 'רונית', ?, ?, ?, ?, ?)`,
  screen, docno, signer ? `S${signer.id}` : 'Other', signer?.id ?? null, alt ? `A${alt.id}` : null, alt?.id ?? null,
  owner ? `O${owner.id}` : 'Someone', owner?.id ?? null, since, since, since);
  return docno;
}

let seq = 0;
function fakeWhatsApp(t) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  return calls;
}
const say = (u, text) => Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text, id: `w${++seq}` });
const out = (calls, u) => calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${u.phone}@c.us`);
const textOf = (c) => c.body.message ?? c.body.body ?? '';
const buttonsOf = (c) => (c.body.buttons ?? []).map((b) => b.buttonText);

test('botAsk — ניסוחים ברורים, ו"מה מחכה לי" כ"רך"; שאר הבקשות — לא', () => {
  for (const t of ['מה מחכה לחתימה שלי?', 'מה ממתין לחתימתי', 'מה מחכה לי בפריוריטי', 'מה מחכה לאישור שלי בפריוריטי', W.BOT_BTN.sign]) {
    assert.deepEqual(W.botAsk(t), { kind: 'sign', soft: false }, t);
  }
  for (const t of ['מה מחכה לי', 'מה ממתין לאישורי?']) assert.deepEqual(W.botAsk(t), { kind: 'sign', soft: true }, t);
  for (const t of ['ששלחתי לאישור', 'מה שלחתי לאישור', W.BOT_BTN.sent]) assert.equal(W.botAsk(t)?.kind, 'sent', t);
  assert.equal(W.botAsk(W.BOT_BTN.alt)?.kind, 'alt');
  for (const t of ['מה יש לי היום', 'מה מחכה לי היום בפרויקט', 'תשלח לדני את החוזה לאישור', 'פריוריטי', 'אישור']) assert.equal(W.botAsk(t), null, t);
});

test('רק מי שמשתתף בסבב אישורים — הפעולה מותרת לו (גם הטיפ); אחר — לא', () => {
  const a = worker([]);
  const b = worker([]);
  waiting({ signer: a });
  assert.equal(WaActions.allowed(actor(a), 'priority_waiting'), true);
  assert.equal(WaActions.allowed(actor(b), 'priority_waiting'), false);
});

test('"מה מחכה לחתימה שלי": הרשימה, הוותיק קודם, עם קישור; כפתור לששלחתי כשיש', async (t) => {
  Fakes.priority(t, { priorityUsers: async () => [] });
  const u = worker([]);
  waiting({ signer: u, docno: 'PO-NEW', days: 1 });
  waiting({ signer: u, docno: 'PO-OLD', days: 9 });
  waiting({ owner: u, docno: 'PD-SENT' });
  const calls = fakeWhatsApp(t);
  await say(u, 'מה מחכה לחתימה שלי?');
  const o = out(calls, u);
  assert.equal(o.length, 1);
  const txt = textOf(o[0]);
  assert.match(txt, /ממתין לחתימה שלך בפריוריטי\* — 2/);
  assert.ok(txt.indexOf('PO-OLD') < txt.indexOf('PO-NEW'), 'הוותיק קודם');
  assert.match(txt, /9 ימים 🔴/);
  assert.match(txt, /🔗 https:\/\/[^\s]+openmail\.htm\?tenant=B2121&priority:priform@PORDERS:PO-OLD:a160226:/);
  assert.doesNotMatch(txt, /PD-SENT/, 'ששלחתי — לא ברשימה של החתימה');
  assert.match(txt, /📤 ששלחת לאישור: 1/);
  assert.deepEqual(buttonsOf(o[0]), [W.BOT_BTN.sent]);
});

test('"📤 ששלחתי לאישור" (הכפתור): מה ששלחתי, ואצל מי', async (t) => {
  Fakes.priority(t, { priorityUsers: async () => [{ USERLOGIN: 'Other', SNAME: 'גלעד קוגלמן' }] });
  const u = worker([]);
  waiting({ owner: u, docno: 'CO-1', screen: 'MED_PORDERS' });
  const calls = fakeWhatsApp(t);
  await say(u, W.BOT_BTN.sent);
  const txt = textOf(out(calls, u)[0]);
  assert.match(txt, /ששלחת לאישור — ממתין לאחרים\* — 1/);
  assert.match(txt, /\*חוזה CO-1\*/);
  assert.match(txt, /ממתין לגלעד קוגלמן/);
});

test('"פריוריטי" למי שאין לו קבלת סחורה ודרישת רכש אבל משתתף באישורים — מה שממתין לו, לא "לא פתוח לך"', async (t) => {
  Fakes.priority(t, { priorityUsers: async () => [] });
  const u = worker([]);
  waiting({ signer: u, docno: 'PO-MINE' });
  const calls = fakeWhatsApp(t);
  await say(u, 'פריוריטי');
  const o = out(calls, u);
  assert.equal(o.length, 1);
  assert.notEqual(textOf(o[0]), Access.NO_ACCESS);
  assert.match(textOf(o[0]), /PO-MINE/);
});

test('תפריט פריוריטי: "✍️ מה מחכה לי" ככפתור למי שמשתתף; הלחיצה — הרשימה', async (t) => {
  connected(t);
  const u = worker(['receipt']);
  waiting({ signer: u, docno: 'PO-MENU' });
  let calls = fakeWhatsApp(t);
  await say(u, 'פריוריטי');
  const menu = out(calls, u).at(-1);
  assert.deepEqual(buttonsOf(menu), ['📦 קבלת סחורה', W.BOT_BTN.sign], 'קבלת סחורה + מה מחכה לי (לא ישר לקבלת סחורה)');
  assert.equal(GR.inMenu(u.id), true);
  t.mock.restoreAll();
  connected(t);
  calls = fakeWhatsApp(t);
  await say(u, W.BOT_BTN.sign);
  assert.match(textOf(out(calls, u).at(-1)), /PO-MENU/);
  assert.equal(GR.inMenu(u.id), false);
});

test('מי שלא משתתף: התפריט כמו קודם (קבלת סחורה בלבד — ישר אליה), ו"מה מחכה לי" לא נענה מפריוריטי', async (t) => {
  connected(t);
  const u = worker(['receipt']);
  let calls = fakeWhatsApp(t);
  await say(u, 'פריוריטי');
  assert.match(textOf(out(calls, u).at(-1)), /קבלת סחורה/);
  assert.equal(GR.inMenu(u.id), false);
  GR._clear(u.id);
  t.mock.restoreAll();
  connected(t);
  calls = fakeWhatsApp(t);
  await say(u, 'מה מחכה לי');
  assert.ok(out(calls, u).every((c) => !/בפריוריטי/.test(textOf(c))));
});

test('לא מקושר לפריוריטי ושאל במפורש — הסבר קצר מה לעשות, בלי פרטים טכניים', async (t) => {
  Fakes.priority(t, { priorityUsers: async () => [] });
  const u = worker([]);
  const calls = fakeWhatsApp(t);
  await say(u, 'מה מחכה לחתימה שלי');
  assert.match(textOf(out(calls, u)[0]), /לא מצאתי אותך כמשתמש בפריוריטי/);
});
