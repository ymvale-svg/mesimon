'use strict';
/**
 * 📍 נקודות ציון דרך השרת האמיתי: מנהל מוסיף את המשרד; המיקום עצמו מגיע רק מוואטסאפ (‎whatsapp/places.js‎).
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
  assert.equal((await srv.api('GET', '/api/me/location')).status, 401);
});

test('המצב שלי — בלי שיתוף בזמן אמת; שיתוף מהאפליקציה כבר לא קיים', async () => {
  const me = await srv.api('GET', '/api/me/location', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.live, false);
  assert.equal(me.json.waiting, 0);
  assert.equal((await srv.api('PUT', '/api/me/location/share', { cookie, body: { share: true } })).status, 404);
});
