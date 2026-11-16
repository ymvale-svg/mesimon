'use strict';
/**
 * 📍 "תזכיר לי כשאני מגיע למשרד לדבר עם ישראל" (15.11.26): התזכורת מחכה למקום; כשהעובד מגיע — הבוט שולח וואטסאפ
 * עם בוצע ✅ · בפעם הבאה 📍 · בעוד שעה ⏰. גם מיקום 📍 ששולחים לבוט.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');
const Reminders = require('../../../server/whatsapp/reminders');
const Places = require('../../../server/whatsapp/places');
const Fakes = require('../../fakes');

boot();
D.setSetting('bot_pilot', false);
D.setSetting('wa_actions', {});

const OFFICE = { lat: 32.0853, lng: 34.7818 };
const setup = () => {
  D.run('DELETE FROM reminders');
  D.run('DELETE FROM user_locations');
  D.run('DELETE FROM places');
  return Places.create({}, { name: 'המשרד', kind: 'office', ...OFFICE, aliases: ['העבודה'] });
};
const ask = async (t, text, parsed) => {
  let system = '';
  Fakes.claude(t, (opts) => { system = opts.system; return { date: '', time: '', ...parsed }; });
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const r = await Bot._internal.converse(u, actor, text, Bot._internal.chatOf(u.id));
  return { u, r, system };
};

test('"תזכיר לי כשאני מגיע לעבודה לדבר עם ישראל" — תזכורת שמחכה למשרד, וה-AI יודע אילו מקומות יש', async (t) => {
  const office = setup();
  const { u, r, system } = await ask(t, 'תזכיר לי כשאני מגיע לעבודה לדבר עם ישראל', { text: 'לדבר עם ישראל', place: 'העבודה', on: 'arrive' });
  assert.equal(r.action, 'reminders_place');
  assert.match(r.reply, /📍 אזכיר לך \*כשתגיע למשרד\*: לדבר עם ישראל/);
  assert.match(r.reply, /שתף איתי מיקום בזמן אמת/, 'מבקשים לשתף מיקום בזמן אמת');
  assert.match(system, /"המשרד" \(משרד; גם: העבודה\)/);
  const rem = D.get('SELECT * FROM reminders WHERE user_id = ?', u.id);
  assert.equal(rem.status, 'place');
  assert.equal(rem.place_id, office.id);
  assert.equal(rem.place_on, 'arrive');
});

test('מקום שלא מוגדר — לא נרשם, ומקבלים את רשימת המקומות', async (t) => {
  setup();
  const { u, r } = await ask(t, 'תזכיר לי כשאגיע לחיפה לקנות מתנה', { text: 'לקנות מתנה', place: 'חיפה', on: 'arrive' });
  assert.match(r.reply, /לא מצאתי מקום בשם "חיפה"/);
  assert.match(r.reply, /\*המשרד\*/);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?', u.id).n, 0);
});

test('הגעה למשרד ← הבוט שולח "📍 הגעת ל…" עם הכפתורים; "בפעם הבאה" — חוזרת לחכות', async (t) => {
  setup();
  const { u } = await ask(t, 'תזכיר לי כשאני מגיע למשרד לדבר עם ישראל', { text: 'לדבר עם ישראל', place: 'המשרד', on: 'arrive' });
  Places.report(u.id, { lat: 32.2, lng: 34.9, source: 'whatsapp_live' });
  const pushed = [];
  await Reminders.tick(async (userId, m) => { pushed.push({ userId, ...m }); });
  assert.equal(pushed.length, 0, 'עוד לא הגיע');
  Places.report(u.id, { ...OFFICE, source: 'whatsapp_live' });
  await Reminders.tick(async (userId, m) => { pushed.push({ userId, ...m }); });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].userId, u.id);
  assert.match(pushed[0].text, /📍 \*הגעת למשרד\*/);
  assert.match(pushed[0].text, /לדבר עם ישראל/);
  assert.deepEqual(pushed[0].buttons, [Reminders.BTN.done, Reminders.BTN.nextVisit, Reminders.BTN.hour]);
  assert.match(pushed[0].text, /אפשר להפסיק את שיתוף המיקום/, 'אין עוד תזכורות שמחכות');
  const back = Reminders.answer(u.id, pushed[0].draft, Reminders.BTN.nextVisit);
  assert.match(back.text, /אזכיר שוב בפעם הבאה שתגיע למשרד/);
  assert.doesNotMatch(back.text, /שתף איתי/, 'כבר משתף — לא מבקשים שוב');
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'place');
});

test('"התזכורות שלי" — גם אלה שמחכות למקום, ו"בטל תזכורת" לפי אותו סדר', async () => {
  const office = setup();
  const u = user({ role: 'employee' });
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at) VALUES (?, 'להתקשר לאבי', ?, 'active', 'bot', ?)", u.id, new Date(Date.now() + 3600000).toISOString(), D.nowIso());
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?, 'לדבר עם ישראל', ?, 'place', 'bot', ?, ?, 'arrive')", u.id, D.nowIso(), D.nowIso(), office.id);
  const list = await Reminders.command(u.id, 'התזכורות שלי');
  assert.match(list.text, /1\. .* — להתקשר לאבי/);
  assert.match(list.text, /2\. 📍 כשתגיע למשרד — לדבר עם ישראל/);
  const c = await Reminders.command(u.id, 'בטל תזכורת 2');
  assert.match(c.text, /ביטלתי: לדבר עם ישראל/);
});

test('מיקום 📍 ששלחו לבוט — "קיבלתי, המיקום שלך: המשרד", והתזכורת יוצאת', () => {
  const office = setup();
  const u = user({ role: 'employee' });
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?, 'לדבר עם ישראל', ?, 'place', 'bot', ?, ?, 'arrive')", u.id, D.nowIso(), D.nowIso(), office.id);
  const r = Reminders.onLocation(u.id, OFFICE);
  assert.match(r.text, /המיקום שלך: \*המשרד\*/);
  assert.match(r.text, /תזכורת אחת מחכה/);
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'active');
  const far = Reminders.onLocation(u.id, { lat: 31.5, lng: 34.6 });
  assert.match(far.text, /לא באף אחת מנקודות הציון/);
});

test('תזכורת לפי זמן — כמו קודם (בלי מקום)', async (t) => {
  setup();
  const { u, r } = await ask(t, 'תזכיר לי מחר ב-8 להתקשר לאבי', { text: 'להתקשר לאבי', date: '2099-01-01', time: '08:00', place: '', on: '' });
  assert.equal(r.action, 'reminders');
  assert.match(r.reply, /⏰ אזכיר לך/);
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'active');
});

test('הודעת מיקום מ-Green API — נקודה ומיקום חי; הודעה רגילה — לא מיקום', () => {
  const { locationOf } = Bot._internal;
  const pin = locationOf({ typeMessage: 'locationMessage', locationMessageData: { latitude: 32.0853, longitude: 34.7818, nameLocation: 'משרד' } });
  assert.deepEqual({ lat: pin.lat, lng: pin.lng, live: pin.live }, { lat: 32.0853, lng: 34.7818, live: false });
  assert.match(pin.shape, /locationMessageData\{latitude,longitude,nameLocation\}/, 'ביומן — השדות בלבד');
  assert.equal(locationOf({ typeMessage: 'liveLocationMessage', liveLocationMessageData: { latitude: 32.1, longitude: 34.8 } }).live, true);
  assert.equal(locationOf({ typeMessage: 'textMessage', textMessageData: { textMessage: '32.1, 34.8' } }), null);
});

test('שיתוף בזמן אמת: על ההודעה הראשונה — "תודה, אזכיר לך כשתגיע למשרד"; על העדכונים — שקט, עד שמגיעים', async () => {
  const office = setup();
  const u = user({ role: 'employee' });
  D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?, 'לדבר עם ישראל', ?, 'place', 'bot', ?, ?, 'arrive')", u.id, D.nowIso(), D.nowIso(), office.id);
  const start = Reminders.onLocation(u.id, { lat: 32.2, lng: 34.9, live: true });
  assert.match(start.text, /קיבלתי את שיתוף המיקום/);
  assert.match(start.text, /אזכיר לך כשתגיע למשרד/);
  const update = Reminders.onLocation(u.id, { lat: 32.15, lng: 34.85, live: true });
  assert.equal(update.text, null);
  assert.equal(update.quiet, true);
  const arrive = Reminders.onLocation(u.id, { ...OFFICE, live: true });
  assert.equal(arrive.text, null, 'התזכורת עצמה יוצאת מהסבב');
  assert.equal(arrive.quiet, false);
  assert.equal(D.get('SELECT status FROM reminders WHERE user_id = ?', u.id).status, 'active');
});

test('עדכון מיקום בזמן אמת שמגיע בצורה אחרת (הודעה ערוכה) — עדיין מיקום, מסומן כשיתוף בזמן אמת', () => {
  const { locationOf } = Bot._internal;
  const r = locationOf({ typeMessage: 'editedMessage', editedMessageData: { liveLocationMessageData: { latitude: 32.1, longitude: 34.8 } } }, 'editedMessage');
  assert.equal(r.lat, 32.1);
  assert.equal(r.live, true);
  assert.match(r.shape, /editedMessage/);
});
