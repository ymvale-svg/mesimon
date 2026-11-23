'use strict';
/**
 * 🔓 נפתחה הרשאה בבוט לפריוריטי — העובד מקבל הודעה מיד (‎server/priority/access-notice.js‎),
 * עם כפתור ‎🗂 פריוריטי‎ שהבוט מבין. אין בוט / טלפון — התראה במשימון.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Access = require('../../../server/priority/priority-access');
const Notice = require('../../../server/priority/access-notice');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
const ON = { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'all' } };
test.beforeEach(() => { D.setSetting('wa_actions', ON); D.setSetting('wa_bot_enabled', true); });
test.afterEach(() => { D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_access%'); });

let n = 0;
const worker = (o = {}) => user({ role: 'employee', full_name: 'עובד', phone: `97250777${String(++n).padStart(4, '0')}`, ...o });
const none = (u) => Access.save([{ id: u.id, docs: [], companies: null }]);

test('saveRows — מה נפתח: מסמכים שנוספו וחברות שנוספו', () => {
  const u = worker();
  none(u);
  let r = Access.saveRows([{ id: u.id, docs: ['receipt'], companies: ['elad1'] }]);
  assert.deepEqual(r.granted.map((g) => [g.userId, g.docs, g.companies]), [[u.id, ['receipt'], []]]);
  r = Access.saveRows([{ id: u.id, docs: ['receipt'], companies: ['elad1', 'mordot'] }]);
  assert.deepEqual(r.granted[0].docs, []);
  assert.deepEqual(r.granted[0].companies, ['mordot']);
  r = Access.saveRows([{ id: u.id, docs: ['receipt'], companies: null }]);
  assert.equal(r.granted[0].companies, null, 'נפתחו כל החברות');
  assert.deepEqual(Access.saveRows([{ id: u.id, docs: [], companies: null }]).granted, [], 'הסרה — אין מה להודיע');
  assert.deepEqual(Access.save([{ id: u.id, docs: ['demand'], companies: null }]).length, 1, 'save — עדיין רשימת השינויים');
});

test('נפתחה קבלת סחורה — הודעה בבוט מיד, עם כפתור פריוריטי, ונרשם ביומן', async (t) => {
  const wa = Fakes.whatsapp(t);
  const u = worker();
  none(u);
  const { granted } = Access.saveRows([{ id: u.id, docs: ['receipt'], companies: null }]);
  const sent = await Notice.send(granted);
  assert.deepEqual(sent, [{ userId: u.id, name: u.full_name, via: 'whatsapp' }]);
  const last = wa.last();
  assert.equal(last.body.chatId, `${u.phone}@c.us`);
  assert.match(wa.texts().at(-1), /נפתחה לך הרשאה לפריוריטי בבוט/);
  assert.match(wa.texts().at(-1), /\*קבלת סחורה\*/);
  assert.match(wa.texts().at(-1), /בכל החברות/);
  assert.deepEqual(wa.buttons(), ['🗂 פריוריטי']);
  assert.ok(Bot.readLog({ userId: u.id }).some((r) => r.action === 'priority_access'));
});

test('נוספו רק חברות — הודעה על החברות', async (t) => {
  const wa = Fakes.whatsapp(t);
  const u = worker();
  Access.save([{ id: u.id, docs: ['demand'], companies: ['elad1'] }]);
  const { granted } = Access.saveRows([{ id: u.id, docs: ['demand'], companies: ['elad1', 'zzz9'] }]);
  await Notice.send(granted);
  assert.match(wa.texts().at(-1), /נוספו לך חברות/);
  assert.match(wa.texts().at(-1), /zzz9/);
});

test('מסמך שעוד לא עובד בבוט, או פעולה כבויה — אין הודעה', async (t) => {
  const wa = Fakes.whatsapp(t);
  const u = worker();
  none(u);
  assert.deepEqual(await Notice.send(Access.saveRows([{ id: u.id, docs: ['invoice'], companies: null }]).granted), []);
  D.setSetting('wa_actions', { ...ON, goods_receipt: { enabled: false, audience: 'all' } });
  assert.deepEqual(await Notice.send(Access.saveRows([{ id: u.id, docs: ['invoice', 'receipt'], companies: null }]).granted), []);
  assert.equal(wa.calls.length, 0);
});

test('בלי טלפון — התראה במשימון', async (t) => {
  const wa = Fakes.whatsapp(t);
  const u = worker({ phone: '' });
  none(u);
  const sent = await Notice.send(Access.saveRows([{ id: u.id, docs: ['demand'], companies: null }]).granted);
  assert.deepEqual(sent.map((s) => s.via), ['app']);
  assert.equal(wa.calls.length, 0);
  const row = D.get('SELECT title, body FROM notifications WHERE target_id = ? ORDER BY id DESC', u.id);
  assert.match(row.title, /נפתחה לך הרשאה/);
  assert.match(row.body, /דרישת רכש/);
});

test('הכפתור עובד: "🗂 פריוריטי" מהעובד שקיבל הרשאה — לא "לא פתוח לך"', async (t) => {
  const wa = Fakes.whatsapp(t);
  const u = worker();
  none(u);
  await Notice.send(Access.saveRows([{ id: u.id, docs: ['receipt', 'demand'], companies: null }]).granted);
  wa.clear();
  await Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text: Notice._internal.BUTTON, id: 'an1' });
  const reply = wa.texts().join('\n');
  assert.ok(reply.length > 0);
  assert.doesNotMatch(reply, /לא פתוח לך/);
});
