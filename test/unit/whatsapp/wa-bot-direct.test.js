'use strict';
/**
 * הבוט מקצה לקצה דרך ‎handleDirect‎ ו-‎simulate‎: וואטסאפ מזויף (‎WhatsApp.call‎), בלי AI ובלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
function fakeWhatsApp(t) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  return calls;
}
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `t${++seq}` });
const sent = (calls) => calls.filter((c) => c.method !== 'sendReaction');

test('save — הבוט מוגדר, והאסימון לא נשמר גלוי', () => {
  assert.equal(Bot.isConfigured(), true);
  assert.notEqual(D.get('SELECT api_token FROM wa_bot WHERE id = 1').api_token, 'tok');
  assert.equal(Bot.publicStatus().connection.hasToken, true);
  assert.equal(Bot.publicStatus().ai, false);
});

test('מספר לא מוכר — הסבר פעם אחת ביום, ונרשם ביומן', async (t) => {
  const calls = fakeWhatsApp(t);
  await say('972503333333', 'שלום');
  await say('972503333333', 'שלום שוב');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].body.chatId, '972503333333@c.us');
  assert.match(calls[0].body.message, /אינו מוכר/);
  const log = Bot.readLog({}).filter((r) => r.who === '972503333333');
  assert.equal(log.length, 2);
  assert.ok(log.every((r) => r.status === 'denied'));
});

test('"היי" — Today ותפריט בכפתורים, עד 3', async (t) => {
  const u = user({ phone: '972502000001', role: 'employee' });
  const calls = fakeWhatsApp(t);
  await say('972502000001', 'היי');
  const out = sent(calls);
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'sendInteractiveButtonsReply');
  assert.match(out[0].body.body, /☀️ \*היום/);
  assert.ok(out[0].body.buttons.length >= 1 && out[0].body.buttons.length <= 3);
  for (const b of out[0].body.buttons) assert.ok(b.buttonText.length <= 20);
  assert.equal(Bot._internal.chatOf(u.id).greetedOn.length, 10);
});

test('"עזרה" — רשימת היכולות המותרות', async (t) => {
  user({ phone: '972502000002', role: 'employee' });
  const calls = fakeWhatsApp(t);
  await say('972502000002', 'עזרה');
  const out = sent(calls);
  assert.equal(out.length, 1);
  assert.match(out[0].body.message, /אני הבוט של משימון/);
  assert.ok(out[0].body.message.includes('פתיחת משימה'));
});

test('"המשימות שלי" בלי AI — עובד, ונרשם ביומן', async (t) => {
  const u = user({ phone: '972502000003', role: 'employee' });
  const calls = fakeWhatsApp(t);
  await say('972502000003', 'המשימות שלי');
  assert.equal(sent(calls)[0].body.message, 'אין לך משימות פתוחות 🎉');
  const row = Bot.readLog({}).find((r) => r.userId === u.id);
  assert.equal(row.action, 'my_tasks');
  assert.equal(row.status, 'ok');
});

test('בקשה חופשית בלי AI — הסבר לעובד ו-⚠️ על ההודעה', async (t) => {
  user({ phone: '972502000004', role: 'employee' });
  const calls = fakeWhatsApp(t);
  await say('972502000004', 'תפתח משימה לבדוק את הלוח');
  assert.match(sent(calls)[0].body.message, /AI אינו מוגדר/);
  const reaction = calls.find((c) => c.method === 'sendReaction');
  assert.equal(reaction?.body.reaction, '⚠️');
});

test('כפתורים נכשלו — נשלח טקסט עם האפשרויות כשורות', async (t) => {
  user({ phone: '972502000005', role: 'employee' });
  const calls = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => {
    calls.push({ method, body: opts?.body });
    if (method === 'sendInteractiveButtonsReply') throw new Error('לא נתמך');
    return {};
  });
  await say('972502000005', 'היי');
  const text = calls.filter((c) => c.method === 'sendMessage').pop();
  assert.ok(text, 'נשלח טקסט');
  assert.match(text.body.message, /▫️ /);
});

test('simulate — "ביטול הכול" מנקה את הכול בלי לשלוח', async (t) => {
  const calls = fakeWhatsApp(t);
  const admin = user({ role: 'superadmin' });
  const u = user({ role: 'employee' });
  const r = await Bot.simulate(admin, { userId: u.id, text: 'ביטול הכול' });
  assert.deepEqual(r, { reply: 'בוטל הכול 👍', action: 'cancel', status: 'ok', result: 'בוטל הכול' });
  assert.deepEqual(await Bot.simulate(admin, { userId: u.id, text: '  ' }), { reply: '', reset: true });
  await assert.rejects(Bot.simulate(admin, { userId: 999999, text: 'היי' }), /העובד לא נמצא/);
  assert.equal(calls.length, 0);
});
