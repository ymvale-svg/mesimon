'use strict';
/**
 * 📍 אבטחה ופרטיות של תזכורות לפי מיקום (סריקת אבטחה 17.11.26):
 *   • יומן הבוט לא שומר את שם המקום שבו העובד נמצא (היומן נשמר 90 יום ומנהלים רואים אותו).
 *   • מיקום מצוטט או מועבר — לא המיקום של העובד.
 *   • מי שהתזכורות כבויות אצלו — המיקום לא נשמר.
 *   • מיקום ישן נמחק בניקוי. כינוי של מקום — עד 40 תווים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Bot = require('../../../server/whatsapp/wa-bot');
const Places = require('../../../server/whatsapp/places');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('bot_pilot', false);
D.setSetting('wa_actions', {});

const OFFICE = { lat: 32.0853, lng: 34.7818 };
let seq = 0;
let phoneSeq = 0;
const worker = () => user({ role: 'employee', phone: `97250777${String(++phoneSeq).padStart(4, '0')}` });
const setup = () => {
  D.run('DELETE FROM reminders');
  D.run('DELETE FROM user_locations');
  D.run('DELETE FROM places');
  return Places.create({}, { name: 'המשרד הסודי', kind: 'office', ...OFFICE });
};
const sendLocation = (u, location) => Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text: '', id: `lp${++seq}`, location });

test('יומן הבוט — בלי שם המקום ובלי התשובה שבה הוא מופיע', async (t) => {
  const office = setup();
  t.mock.method(WhatsApp, 'call', async () => ({}));
  const u = worker();
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?, 'לדבר עם ישראל', ?, 'place', 'bot', ?, ?, 'arrive')", u.id, D.nowIso(), D.nowIso(), office.id);
  await sendLocation(u, { ...OFFICE, live: false, shape: 'x' });
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'active', 'התזכורת יצאה');
  const rows = D.all("SELECT * FROM wa_log WHERE user_id = ? AND action = 'reminders_place'", u.id);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /הסודי/);
});

test('מיקום מצוטט או מועבר — לא נחשב מיקום של העובד', () => {
  const { locationOf } = Bot._internal;
  assert.equal(locationOf({ typeMessage: 'quotedMessage', extendedTextMessageData: { text: 'מה זה?' }, quotedMessage: { typeMessage: 'locationMessage', latitude: 32.1, longitude: 34.8 } }), null);
  assert.equal(locationOf({ typeMessage: 'locationMessage', locationMessageData: { latitude: 32.1, longitude: 34.8, isForwarded: true } }), null);
  assert.ok(locationOf({ typeMessage: 'locationMessage', locationMessageData: { latitude: 32.1, longitude: 34.8 } }), 'מיקום רגיל — עדיין מיקום');
});

test('תזכורות כבויות לעובד — המיקום לא נשמר', async (t) => {
  setup();
  t.mock.method(WhatsApp, 'call', async () => ({}));
  D.setSetting('wa_actions', { reminders: { enabled: false } });
  t.after(() => D.setSetting('wa_actions', {}));
  const u = worker();
  await sendLocation(u, { ...OFFICE, live: true, shape: 'x' });
  assert.equal(D.get('SELECT COUNT(*) AS n FROM user_locations WHERE user_id = ?', u.id).n, 0);
});

test('ניקוי — מיקום ישן יותר מ-STALE_MS נמחק, עדכני נשאר', () => {
  setup();
  const old = user({ role: 'employee' });
  const fresh = user({ role: 'employee' });
  D.run("INSERT INTO user_locations (user_id, source, at) VALUES (?, 'whatsapp', ?)", old.id, new Date(Date.now() - Places.STALE_MS - 60000).toISOString());
  D.run("INSERT INTO user_locations (user_id, source, at) VALUES (?, 'whatsapp', ?)", fresh.id, D.nowIso());
  Places.prune();
  assert.equal(D.get('SELECT COUNT(*) AS n FROM user_locations WHERE user_id = ?', old.id).n, 0);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM user_locations WHERE user_id = ?', fresh.id).n, 1);
});

test('כינוי של מקום — עד 40 תווים', () => {
  setup();
  const p = Places.create({}, { name: 'אתר', kind: 'site', lat: 32.1, lng: 34.9, aliases: ['א'.repeat(500)] });
  assert.equal(p.aliases[0].length, 40);
});

// #227 — שיתוף בזמן אמת בלי תזכורת שמחכה למקום: לא מחשבים ולא שומרים איפה העובד, לא רושמים ביומן, ועונים פעם אחת
test('שיתוף בזמן אמת בלי תזכורות — המקום לא נשמר, אין שורה ביומן, תשובה אחת בלבד', async (t) => {
  setup();
  const sent = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { if (method === 'sendMessage') sent.push(opts.body.message); return {}; });
  const u = worker();
  await sendLocation(u, { ...OFFICE, live: true, shape: 'x' });
  await sendLocation(u, { ...OFFICE, live: true, shape: 'x' });
  await sendLocation(u, { ...OFFICE, live: true, shape: 'x' });
  const loc = D.get('SELECT * FROM user_locations WHERE user_id = ?', u.id);
  assert.ok(loc, 'נשמר שהשיתוף פעיל (כדי לזהות את ההודעה הראשונה)');
  assert.equal(loc.place_id, null, 'המקום לא נשמר');
  assert.equal(loc.source, 'whatsapp_live');
  assert.equal(D.get("SELECT COUNT(*) AS n FROM wa_log WHERE user_id = ? AND action = 'reminders_place'", u.id).n, 0, 'אין שורה ביומן');
  assert.equal(sent.length, 1, 'תשובה אחת בלבד');
  assert.match(sent[0], /אין כרגע תזכורות שמחכות למקום/);
  assert.equal(Places.liveActive(u.id), true);
});

test('שיתוף בזמן אמת עם תזכורת שמחכה — המקום עדיין נבדק והתזכורת יוצאת', async (t) => {
  const office = setup();
  t.mock.method(WhatsApp, 'call', async () => ({}));
  const u = worker();
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?, 'לדבר עם ישראל', ?, 'place', 'bot', ?, ?, 'arrive')", u.id, D.nowIso(), D.nowIso(), office.id);
  await sendLocation(u, { lat: 31.5, lng: 34.9, live: true, shape: 'x' });
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'place');
  await sendLocation(u, { ...OFFICE, live: true, shape: 'x' });
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'active', 'התזכורת יצאה בהגעה');
  assert.equal(D.get('SELECT place_id FROM user_locations WHERE user_id = ?', u.id).place_id, office.id);
});
