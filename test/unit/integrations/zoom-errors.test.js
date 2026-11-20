'use strict';
/**
 * Zoom סירב ליצור פגישה — הסבר בעברית למנהל המערכת, בלי ניסיון חוזר מיותר כשהבעיה בהרשאות.
 * בלי רשת: ‎fetch‎ מזויף (כולל קבלת האסימון מ-zoom.us/oauth).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Zoom = require('../../../server/integrations/zoom');

function zoomEnv(t) {
  Object.assign(process.env, { ZOOM_ACCOUNT_ID: 'acc', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'sec' });
  t.after(() => { for (const k of ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']) delete process.env[k]; });
  boot();
  D.run("INSERT OR REPLACE INTO zoom_users (id, account, email, name, license, synced_at) VALUES ('zu1', '1', 'zoom1@x.co', 'Zoom 1', 'licensed', ?)", new Date().toISOString());
}

function fakeZoom(t, meetingReply, { scope = 'meeting:write:meeting:admin meeting:read:meeting:admin' } = {}) {
  const calls = [];
  let tok = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', auth: init?.headers?.authorization });
    if (u.startsWith('https://zoom.us/oauth/token')) {
      tok += 1;
      return new Response(JSON.stringify({ access_token: `tok${tok}`, expires_in: 3600, scope: typeof scope === 'function' ? scope(tok) : scope }), { status: 200 });
    }
    if (init?.method === 'DELETE') return new Response('', { status: 204 });
    return meetingReply(u, init);
  });
  return calls;
}

test('explain — הרשאות חסרות, משתמש שלא קיים, משתמש שלא יכול לארח', () => {
  assert.equal(Zoom.explain({ status: 400, code: 4711, zoomMessage: 'Invalid access token, does not contain scopes:[meeting:write:meeting:admin]' }).kind, 'scopes');
  assert.match(Zoom.explain({ code: 4711, zoomMessage: 'does not contain scopes' }).text, /meeting:write:meeting:admin/);
  assert.equal(Zoom.explain({ status: 404, code: 1001, zoomMessage: 'User does not exist: zu1.' }).kind, 'user');
  assert.equal(Zoom.explain({ status: 400, code: 3161, zoomMessage: 'Your user account is not allowed meeting hosting and scheduling capabilities.' }).kind, 'host');
});

test('הרשאות חסרות גם באסימון חדש — ניסיון אחד באסימון חדש, בלי "בלי הגדרות", והבדיקה מראה את ההרשאות שבאסימון', async (t) => {
  zoomEnv(t);
  const calls = fakeZoom(t, () => new Response(JSON.stringify({ code: 4711, message: 'Invalid access token, does not contain scopes:[meeting:write:meeting:admin, meeting:write:meeting:master].' }), { status: 400 }), { scope: 'user:read:admin' });
  const r = await Zoom.testCreate('zu1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 4711);
  assert.match(r.explain, /Scopes/);
  assert.deepEqual(r.scopes, ['user:read:admin']);
  assert.deepEqual(r.wanted, ['meeting:write:meeting:admin', 'meeting:write:meeting:master']);
  assert.deepEqual(r.missingScopes, ['meeting:write:meeting:admin', 'meeting:write:meeting:master']);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/meetings')).length, 2, 'פעם עם האסימון, ופעם עם אסימון חדש — לא יותר');
});

test('הרשאות שנוספו ב-Marketplace אחרי שהאסימון נוצר — אסימון חדש, והפגישה נוצרת', async (t) => {
  zoomEnv(t);
  fakeZoom(t, (u, init) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 200 });
    // האסימון הראשון (הישן) — בלי ההרשאות; השני — איתן
    return init.headers.authorization === 'Bearer tok1'
      ? new Response(JSON.stringify({ code: 4711, message: 'Invalid access token, does not contain scopes:[meeting:write:meeting:admin].' }), { status: 400 })
      : new Response(JSON.stringify({ id: 9, join_url: 'https://zoom.us/j/9' }), { status: 201 });
  });
  const z = await Zoom.createMeeting('zu1', { title: 'בדיקה', startIso: new Date(Date.now() + 3600000).toISOString(), minutes: 30 });
  assert.equal(z.joinUrl, 'https://zoom.us/j/9');
});

test('הגדרה שהמשתמש לא מאפשר (400 אחר) — ניסיון שני בלי הגדרות מצליח', async (t) => {
  zoomEnv(t);
  let n = 0;
  fakeZoom(t, (u, init) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 200 });
    n += 1;
    return n === 1
      ? new Response(JSON.stringify({ code: 300, message: 'Invalid field: auto_recording' }), { status: 400 })
      : new Response(JSON.stringify({ id: 123, join_url: 'https://zoom.us/j/123' }), { status: 201 });
  });
  const z = await Zoom.createMeeting('zu1', { title: 'בדיקה', startIso: new Date(Date.now() + 3600000).toISOString(), minutes: 30, record: true });
  assert.equal(z.joinUrl, 'https://zoom.us/j/123');
  assert.match(z.warning, /הקלטה/);
});
