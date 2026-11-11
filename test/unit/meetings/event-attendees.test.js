'use strict';
/**
 * עריכת מוזמנים אחרי שהפגישה נשלחה — גם פגישה שלא נקבעה במשימון. בלי רשת: ‎Gmail.googleCall‎
 * ו-‎Gmail.has‎ מוחלפים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { user, D } = require('../../helpers/db');
const Gmail = require('../../../server/integrations').Gmail;
const Meetings = require('../../../server/meetings').Meetings;

function fakeGoogle(t, ev) {
  const calls = [];
  t.mock.method(Gmail, 'has', () => true);
  t.mock.method(Gmail, 'googleCall', async (userId, url, query, opts) => {
    calls.push({ url, query, opts });
    if (opts?.method === 'PATCH') return { ...ev, ...opts.body, etag: '"2"' };
    return ev;
  });
  return calls;
}

test('מוסיפים ומסירים מוזמנים: מי שנשאר שומר את התשובה, חדר ובעל היומן לא נוגעים, Google שולח עדכון', async (t) => {
  const me = user({ role: 'admin', email: 'owner@eshel.test' });
  const actor = { type: 'user', id: me.id, role: 'admin', email: me.email, name: me.full_name };
  const ev = {
    id: 'ev1', summary: 'פגישה עם רזבר', organizer: { email: 'owner@eshel.test', self: true },
    attendees: [
      { email: 'owner@eshel.test', self: true, organizer: true, responseStatus: 'accepted' },
      { email: 'room@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
      { email: 'keep@x.co', displayName: 'נשאר', responseStatus: 'accepted' },
      { email: 'drop@x.co', responseStatus: 'needsAction' }
    ]
  };
  const calls = fakeGoogle(t, ev);
  const r = await Meetings.setEventAttendees(actor, { ownerId: me.id, eventId: 'ev1', attendees: [{ email: 'keep@x.co' }, { email: 'New@x.co', name: 'חדש' }] });
  const patch = calls.find((c) => c.opts?.method === 'PATCH');
  assert.equal(patch.query.sendUpdates, 'all');
  const emails = patch.opts.body.attendees.map((a) => a.email);
  assert.deepEqual(emails.sort(), ['keep@x.co', 'new@x.co', 'owner@eshel.test', 'room@resource.calendar.google.com'].sort());
  assert.equal(patch.opts.body.attendees.find((a) => a.email === 'keep@x.co').responseStatus, 'accepted');
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.attendees.map((a) => a.email).sort(), ['keep@x.co', 'new@x.co']);
});

test('בלי עדכון במייל — sendUpdates=none; פגישה של משימון מתעדכנת גם אצלנו', async (t) => {
  const me = user({ role: 'admin', email: 'owner2@eshel.test' });
  const actor = { type: 'user', id: me.id, role: 'admin', email: me.email, name: me.full_name };
  const now = new Date().toISOString();
  D.run(`INSERT INTO meetings (created_by, owner_id, via_user_id, calendar_id, google_event_id, title, start_at, end_at, attendees, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?)`, me.id, me.id, me.id, 'primary', 'ev2', 'ישיבה', now, now, '[]', now, now);
  const calls = fakeGoogle(t, { id: 'ev2', organizer: { email: 'owner2@eshel.test', self: true }, attendees: [] });
  await Meetings.setEventAttendees(actor, { ownerId: me.id, eventId: 'ev2', attendees: [{ email: 'a@x.co' }], sendUpdates: false });
  assert.equal(calls.find((c) => c.opts?.method === 'PATCH').query.sendUpdates, 'none');
  const row = D.get("SELECT attendees FROM meetings WHERE google_event_id = 'ev2'");
  assert.deepEqual(JSON.parse(row.attendees).map((a) => a.email), ['a@x.co']);
});

test('פגישה שמישהו אחר ארגן — לא עורכים (רק המארגן יכול)', async (t) => {
  const me = user({ role: 'admin', email: 'owner3@eshel.test' });
  const actor = { type: 'user', id: me.id, role: 'admin', email: me.email, name: me.full_name };
  const calls = fakeGoogle(t, { id: 'ev3', organizer: { email: 'someone@else.co' }, attendees: [] });
  await assert.rejects(Meetings.setEventAttendees(actor, { ownerId: me.id, eventId: 'ev3', attendees: [] }), /המארגן/);
  assert.equal(calls.filter((c) => c.opts?.method === 'PATCH').length, 0);
});
