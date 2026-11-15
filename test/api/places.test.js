'use strict';
/**
 * 📍 מיקום ונקודות ציון דרך השרת האמיתי: מנהל מוסיף את המשרד, עובד משתף מיקום מהאפליקציה,
 * ואפליקציית מעקב ברקע מדווחת בקישור האישי (בפורמט של OwnTracks) — בלי התחברות.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
let cookie;

before(async () => {
  srv = await Server.start();
  cookie = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
});
after(async () => { await srv?.stop(); });

test('נקודת ציון: הוספה מקישור של גוגל מפות, עריכה, ורשימה', async () => {
  const add = await srv.api('POST', '/api/places', { cookie, body: { name: 'המשרד', kind: 'office', coords: 'https://www.google.com/maps/@32.0853,34.7818,17z', aliases: 'העבודה' } });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.json.place.lat, 32.0853);
  assert.deepEqual(add.json.place.aliases, ['העבודה']);
  const bad = await srv.api('POST', '/api/places', { cookie, body: { name: 'בלי נ"צ' } });
  assert.equal(bad.status, 400);
  const edit = await srv.api('PUT', `/api/places/${add.json.place.id}`, { cookie, body: { radius: 200 } });
  assert.equal(edit.json.place.radius, 200);
  const list = await srv.api('GET', '/api/places', { cookie });
  assert.equal(list.json.canEdit, true);
  assert.ok(list.json.places.some((p) => p.name === 'המשרד'));
});

test('בלי התחברות — אין גישה לנקודות הציון ולמיקום', async () => {
  assert.equal((await srv.api('GET', '/api/places')).status, 401);
  assert.equal((await srv.api('POST', '/api/me/location', { body: { lat: 32, lng: 34 } })).status, 401);
});

test('מיקום מהאפליקציה — רק אחרי שהעובד הפעיל שיתוף; כיבוי מוחק', async () => {
  const off = await srv.api('POST', '/api/me/location', { cookie, body: { lat: 32.0853, lng: 34.7818 } });
  assert.equal(off.json.ok, false);
  assert.equal(off.json.reason, 'off');
  await srv.api('PUT', '/api/me/location/share', { cookie, body: { share: true } });
  const on = await srv.api('POST', '/api/me/location', { cookie, body: { lat: 32.0854, lng: 34.7818, accuracy: 15 } });
  assert.equal(on.json.ok, true);
  assert.equal(on.json.place.name, 'המשרד');
  const me = await srv.api('GET', '/api/me/location', { cookie });
  assert.equal(me.json.place.name, 'המשרד');
  assert.equal(me.json.lat, undefined, 'הנקודה עצמה לא חוזרת');
  await srv.api('PUT', '/api/me/location/share', { cookie, body: { share: false } });
  assert.equal((await srv.api('GET', '/api/me/location', { cookie })).json.lastAt, null);
});

test('קישור אישי לאפליקציית מעקב — מדווח בלי התחברות; אסימון לא מוכר — 404', async () => {
  await srv.api('PUT', '/api/me/location/share', { cookie, body: { share: true } });
  const { token } = (await srv.api('POST', '/api/me/location/token', { cookie })).json;
  const ping = await srv.api('POST', `/api/location/ping/${token}`, { body: { _type: 'location', lat: 32.0853, lon: 34.7818, acc: 20, tst: Math.floor(Date.now() / 1000) } });
  assert.equal(ping.status, 200, ping.text);
  assert.deepEqual(ping.json, []);
  const me = await srv.api('GET', '/api/me/location', { cookie });
  assert.equal(me.json.source, 'tracker');
  assert.equal(me.json.place.name, 'המשרד');
  assert.equal((await srv.api('POST', '/api/location/ping/not-a-real-token-123456789', { body: { lat: 32, lng: 34 } })).status, 404);
});
