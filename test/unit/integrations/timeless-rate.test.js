'use strict';
/**
 * Timeless — ההגנה על מגבלת הקצב (429). כל העובדים חולקים את האסימון הארגוני, ול-Timeless
 * יש 60 בקשות בדקה. בלי רשת: ‎fetch‎ מוחלף ב-‎t.mock.method(globalThis, 'fetch')‎.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { user } = require('../../helpers/db');
const Timeless = require('../../../server/integrations/timeless');

function fakeFetch(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(String(url)));
    const r = await reply(new URL(String(url)), calls.length);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  });
  return calls;
}
const page = (items) => ({ data: items, has_more: false, next_cursor: null });
const mtg = (id, email) => ({ id, title: `פגישה ${id}`, start_time: '2026-11-10T08:00:00Z', host: { name: 'מארח', email }, participants: [] });

test('בקשות זהות במקביל — פנייה אחת ל-Timeless, ושוב מהמטמון', async (t) => {
  process.env.TIMELESS_ACCESS_TOKEN = 'org-1';
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  const boss = user({ role: 'admin' });
  const calls = fakeFetch(t, () => page([mtg('mtg_a', 'x@y.co')]));
  const [a, b] = await Promise.all([
    Timeless.listMeetings(boss.id, { from: '2026-11-01', to: '2026-11-30', limit: 30 }),
    Timeless.listMeetings(boss.id, { from: '2026-11-01', to: '2026-11-30', limit: 200 })
  ]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  await Timeless.listMeetings(boss.id, { from: '2026-11-01', to: '2026-11-30', limit: 50 });
  assert.equal(calls.length, 1, 'גודל דף קבוע — אותה כתובת לכל הזרימות');
});

test('עובד באסימון הארגוני — Timeless מסנן לפי המייל שלו, ופגישה של אחרים לא חוזרת', async (t) => {
  process.env.TIMELESS_ACCESS_TOKEN = 'org-2';
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  const emp = user({ role: 'member', email: 'dana@eshel.test' });
  const calls = fakeFetch(t, () => page([mtg('mtg_mine', 'dana@eshel.test'), mtg('mtg_other', 'other@eshel.test')]));
  const list = await Timeless.listMeetings(emp.id, { from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(list.map((m) => m.id), ['mtg_mine']);
  assert.equal(calls[0].searchParams.get('participant'), 'dana@eshel.test');
});

test('429 כשיש תשובה שמורה — מוגשת מהמטמון במקום שגיאה', async (t) => {
  process.env.TIMELESS_ACCESS_TOKEN = 'org-3';
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  const boss = user({ role: 'admin' });
  let limited = false;
  fakeFetch(t, () => (limited
    ? new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429, headers: { 'retry-after': '30' } })
    : page([mtg('mtg_s', 'x@y.co')])));
  const first = await Timeless.listMeetings(boss.id, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(first.length, 1);
  // המטמון "פג" — מקדמים את השעון מעבר ל-3 דקות
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 4 * 60000);
  limited = true;
  const again = await Timeless.listMeetings(boss.id, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(again.map((m) => m.id), ['mtg_s']);
});

test('429 בלי תשובה שמורה — הודעה ברורה', async (t) => {
  process.env.TIMELESS_ACCESS_TOKEN = 'org-4';
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  const boss = user({ role: 'admin' });
  fakeFetch(t, () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
  await assert.rejects(Timeless.listMeetings(boss.id, { from: '2026-09-01', to: '2026-09-30' }), (err) => err.status === 429 && /Timeless/.test(err.message));
});
