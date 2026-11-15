'use strict';
/**
 * 📍 נקודות ציון ומיקום (‎server/whatsapp/places.js‎) — הגעה / יציאה, מיקום ישן, שיתוף כבוי, וקישור אישי.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Places = require('../../../server/whatsapp/places');

boot();

// המשרד ואתר — כ-6 ק"מ זה מזה
const OFFICE = { lat: 32.0853, lng: 34.7818 };
const SITE = { lat: 32.1300, lng: 34.8200 };
const near = (p, meters) => ({ lat: p.lat + meters / 111320, lng: p.lng });

const fresh = () => {
  D.run('DELETE FROM reminders');
  D.run('DELETE FROM user_locations');
  D.run('DELETE FROM places');
  const office = Places.create({ id: null }, { name: 'המשרד הראשי', kind: 'office', ...OFFICE, aliases: 'העבודה, משרד' });
  const site = Places.create({ id: null }, { name: 'אתר אלעד', kind: 'site', ...SITE });
  return { office, site };
};
const sharer = () => { const u = user({ role: 'employee' }); Places.setSharing(u.id, true); return u; };
const placeReminder = (userId, placeId, on = 'arrive', text = 'לדבר עם ישראל') => Number(D.run(
  "INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_id, place_on) VALUES (?,?,?, 'place', 'bot', ?,?,?)",
  userId, text, D.nowIso(), D.nowIso(), placeId, on).lastInsertRowid);

test('נ"צ מטקסט — מספרים, וקישורים מגוגל מפות', () => {
  assert.deepEqual(Places.parseCoords('32.0853, 34.7818'), { lat: 32.0853, lng: 34.7818 });
  assert.deepEqual(Places.parseCoords('https://www.google.com/maps/place/x/@32.0853,34.7818,17z'), { lat: 32.0853, lng: 34.7818 });
  assert.deepEqual(Places.parseCoords('https://maps.google.com/?q=32.0853,34.7818'), { lat: 32.0853, lng: 34.7818 });
  assert.deepEqual(Places.parseCoords('…/data=!3d32.0853!4d34.7818'), { lat: 32.0853, lng: 34.7818 });
  assert.equal(Places.parseCoords('רחוב הרצל 5'), null);
  assert.equal(Places.parseCoords('0.000, 0.000'), null);
});

test('"ל" לפני שם מקום — ה\' הידיעה נבלעת רק בשם עצם מוכר', () => {
  assert.equal(Places.toPlace('המשרד הראשי'), 'למשרד הראשי');
  assert.equal(Places.toPlace('האתר בחולון'), 'לאתר בחולון');
  assert.equal(Places.toPlace('הרצליה'), 'להרצליה');
  assert.equal(Places.toPlace('אתר אלעד'), 'לאתר אלעד');
});

test('מרחק — כ-111 ק"מ למעלת רוחב', () => {
  assert.ok(Math.abs(Places.distance({ lat: 32, lng: 35 }, { lat: 33, lng: 35 }) - 111195) < 100);
});

test('נקודת ציון: שם ונ"צ חובה; רדיוס ברירת מחדל לפי הסוג', () => {
  fresh();
  assert.throws(() => Places.create({}, { kind: 'site', ...SITE }), /שם/);
  assert.throws(() => Places.create({}, { name: 'x', coords: 'לא נ"צ' }), /נ"צ/);
  const p = Places.create({}, { name: 'אתר חדש', coords: '31.9, 34.8' });
  assert.equal(p.kind, 'site');
  assert.equal(p.radius, Places.DEFAULT_RADIUS.site);
});

test('"משרד" / "העבודה" — המשרד; "אתר" — כל אתר; שם לא מוכר — כלום', () => {
  const { office, site } = fresh();
  assert.equal(Places.resolve('העבודה').place.id, office.id);
  assert.equal(Places.resolve('משרד').place.id, office.id);
  assert.equal(Places.resolve('המשרד').place.id, office.id);
  assert.equal(Places.resolve('אלעד').place.id, site.id);
  assert.deepEqual(Places.resolve('אתר'), { kind: 'site' });
  assert.equal(Places.resolve('חיפה'), null);
});

test('הגעה למשרד — התזכורת שחיכתה הופכת לתזכורת שמועדה עכשיו; תזכורת לאתר — נשארת', () => {
  const { office, site } = fresh();
  const u = sharer();
  const a = placeReminder(u.id, office.id);
  const b = placeReminder(u.id, site.id, 'arrive', 'להזמין בטון');
  assert.equal(Places.report(u.id, near(OFFICE, 2000)).place, null);
  const r = Places.report(u.id, near(OFFICE, 40));
  assert.equal(r.arrived.id, office.id);
  assert.deepEqual(r.fired.map((x) => x.id), [a]);
  const row = D.get('SELECT * FROM reminders WHERE id = ?', a);
  assert.equal(row.status, 'active');
  assert.ok(Date.parse(row.due_at) <= Date.now());
  assert.equal(row.ref, `place:arrive:${office.id}`);
  assert.equal(D.get('SELECT status FROM reminders WHERE id = ?', b).status, 'place');
});

test('כבר במשרד — עוד מיקום מהמשרד אינו "הגעה"; קפיצה קטנה מעבר לרדיוס אינה יציאה', () => {
  const { office } = fresh();
  const u = sharer();
  Places.report(u.id, near(OFFICE, 10));
  const a = placeReminder(u.id, office.id);
  const l = placeReminder(u.id, office.id, 'leave', 'לקנות חלב');
  assert.equal(Places.report(u.id, near(OFFICE, 60)).fired.length, 0);
  assert.equal(Places.report(u.id, near(OFFICE, office.radius + 30)).fired.length, 0, 'בתוך מרווח היציאה');
  assert.equal(D.get('SELECT status FROM reminders WHERE id = ?', a).status, 'place');
  // יציאה אמיתית — התזכורת של "כשאצא"
  const out = Places.report(u.id, near(OFFICE, 1500));
  assert.equal(out.left.id, office.id);
  assert.deepEqual(out.fired.map((x) => x.id), [l]);
  // וחזרה — "הגעה"
  assert.deepEqual(Places.report(u.id, near(OFFICE, 20)).fired.map((x) => x.id), [a]);
});

test('מיקום ישן (יותר משלוש שעות) — המיקום הבא מאותו מקום הוא שוב "הגעה"', () => {
  const { office } = fresh();
  const u = sharer();
  Places.report(u.id, near(OFFICE, 10));
  D.run('UPDATE user_locations SET at = ? WHERE user_id = ?', new Date(Date.now() - Places.STALE_MS - 60000).toISOString(), u.id);
  const a = placeReminder(u.id, office.id);
  assert.deepEqual(Places.report(u.id, near(OFFICE, 10)).fired.map((x) => x.id), [a]);
});

test('"כשאגיע לאתר" (בלי שם) — כל אתר; המשרד לא', () => {
  fresh();
  const u = sharer();
  const id = Number(D.run("INSERT INTO reminders (user_id, text, due_at, status, source, created_at, place_kind, place_on) VALUES (?, 'להזמין בטון', ?, 'place', 'bot', ?, 'site', 'arrive')", u.id, D.nowIso(), D.nowIso()).lastInsertRowid);
  assert.equal(Places.report(u.id, OFFICE).fired.length, 0);
  assert.deepEqual(Places.report(u.id, SITE).fired.map((x) => x.id), [id]);
});

test('שיתוף כבוי — מיקום מהאפליקציה לא נקלט; מיקום שהעובד שלח בעצמו — כן, בלי לשמור את הנקודה', () => {
  const { office } = fresh();
  const u = user({ role: 'employee' });
  const a = placeReminder(u.id, office.id);
  assert.equal(Places.report(u.id, OFFICE).reason, 'off');
  assert.equal(D.get('SELECT status FROM reminders WHERE id = ?', a).status, 'place');
  const r = Places.report(u.id, { ...OFFICE, source: 'whatsapp', explicit: true });
  assert.deepEqual(r.fired.map((x) => x.id), [a]);
  const loc = D.get('SELECT * FROM user_locations WHERE user_id = ?', u.id);
  assert.equal(loc.lat, null);
  assert.equal(loc.place_id, office.id);
});

test('מיקום לא מדויק (רשת סלולרית) — לא מחליטים לפיו', () => {
  const { office } = fresh();
  const u = sharer();
  placeReminder(u.id, office.id);
  assert.equal(Places.report(u.id, { ...OFFICE, accuracy: 3000 }).reason, 'inaccurate');
});

test('כיבוי השיתוף מוחק את המיקום האחרון ואת הקישור האישי', () => {
  fresh();
  const u = sharer();
  const token = Places.newToken(u.id);
  assert.equal(Places.userByToken(token), u.id);
  Places.report(u.id, OFFICE);
  Places.setSharing(u.id, false);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM user_locations WHERE user_id = ?', u.id).n, 0);
  assert.equal(Places.userByToken(token), null);
  assert.equal(Places.status(u.id).hasToken, false);
});

test('קישור חדש מבטל את הקודם; האסימון לא נשמר כמו שהוא', () => {
  fresh();
  const u = sharer();
  const first = Places.newToken(u.id);
  const second = Places.newToken(u.id);
  assert.equal(Places.userByToken(first), null);
  assert.equal(Places.userByToken(second), u.id);
  assert.ok(!JSON.stringify(D.userPrefs(u.id)).includes(second));
  assert.equal(Places.userByToken('קצר'), null);
});

test('מחיקת נקודת ציון — התזכורות שחיכו לה מתבטלות', () => {
  const { office } = fresh();
  const u = sharer();
  const a = placeReminder(u.id, office.id);
  assert.ok(Places.remove(office.id));
  assert.equal(D.get('SELECT status FROM reminders WHERE id = ?', a).status, 'cancelled');
  assert.equal(Places.list().some((p) => p.id === office.id), false);
});
