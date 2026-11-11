'use strict';
/**
 * 🎥 הצינור היחיד מ-Timeless: פעם אחת לכל פגישה, ומשם הכול מהשמירה המקומית. בלי רשת — ‎fetch‎
 * מזויף, ועונה לפי הנתיב.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { user, D } = require('../../helpers/db');
const Store = require('../../../server/meetings').TimelessStore;
const Followup = require('../../../server/meetings/meeting-followup');

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MTG = (id, over = {}) => ({
  id, title: `פגישה ${id}`, status: 'completed', start_time: iso(NOW - 3 * 3600000), end_time: iso(NOW - 2 * 3600000), duration: 3600,
  host: { name: 'מארח', email: 'boss@eshel.test' }, participants: [{ name: 'דנה', email: 'dana@eshel.test' }],
  documents: [{ id: `doc_${id}`, title: 'סיכום' }], ...over
});

/** ‎fetch‎ מזויף אחד לבדיקה; ‎api.meetings‎ ניתן להחלפה, ‎api.calls‎ — הפניות */
function timeless(t, initial) {
  const api = { meetings: initial, calls: [] };
  const calls = api.calls;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const meetings = api.meetings;
    const u = new URL(String(url));
    calls.push(u);
    let body;
    if (u.pathname === '/v1/meetings') {
      const id = u.searchParams.get('id');
      body = { data: id ? meetings.filter((m) => m.id === id) : meetings, has_more: false, next_cursor: null };
    } else if (/\/transcript$/.test(u.pathname)) {
      body = { language: 'he', speakers: [{ id: 's1', name: 'דנה' }], segments: [{ speaker_id: 's1', start_time: 71, end_time: 80, text: 'אני מכינה הצעת מחיר' }] };
    } else if (u.pathname.startsWith('/v1/documents/')) {
      body = { content: '## החלטות\n- ממשיכים' };
    } else body = {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return api;
}

function setup(t) {
  process.env.TIMELESS_ACCESS_TOKEN = `org-store-${Math.random()}`;
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  D.run('DELETE FROM timeless_meetings');
  D.run('DELETE FROM timeless_months');
}

test('סבב: רשימה אחת, תמליל וסיכום פעם אחת לפגישה שהסתיימה; בסבב הבא — רק הרשימה', async (t) => {
  setup(t);
  const { calls } = timeless(t, [MTG('mtg_1'), MTG('mtg_2', { status: 'scheduled', start_time: iso(NOW + 3600000), end_time: iso(NOW + 7200000), documents: [] })]);
  const r = await Store.sweep(NOW);
  assert.equal(r.meetings, 2);
  assert.equal(r.details, 1, 'רק הפגישה שהסתיימה');
  const row = D.get("SELECT * FROM timeless_meetings WHERE id = 'mtg_1'");
  assert.ok(row.transcript && row.documents);
  const before = calls.length;
  await Store.sweep(NOW + 6 * 60000);
  const second = calls.slice(before);
  assert.ok(second.every((u) => u.pathname === '/v1/meetings'), 'בלי למשוך שוב תמליל או סיכום');
});

test('מסכים ובוט קוראים מהשמירה בלבד — בלי פנייה ל-Timeless; עובד רואה רק פגישות שלו', async (t) => {
  setup(t);
  const api = timeless(t, [MTG('mtg_a'), MTG('mtg_b', { host: { email: 'x@eshel.test' }, participants: [] })]);
  await Store.sweep(NOW);
  api.calls.length = 0;
  const calls = api.calls;
  const dana = user({ role: 'member', email: 'dana@eshel.test' });
  const boss = user({ role: 'admin', email: 'boss2@eshel.test' });
  const today = iso(NOW).slice(0, 10);
  D.run('INSERT OR REPLACE INTO timeless_months (month, at) VALUES (?,?)', today.slice(0, 7), iso(NOW));
  const from = iso(NOW - 2 * 86400000).slice(0, 10);
  assert.deepEqual((await Store.list(dana.id, from, today)).map((m) => m.id), ['mtg_a']);
  assert.equal((await Store.list(boss.id, from, today)).length, 2);
  const d = await Store.details(dana.id, 'mtg_a');
  assert.match(Store.transcriptText(d.transcript), /הצעת מחיר/);
  assert.equal(await Store.get(dana.id, 'mtg_b'), null);
  assert.equal(calls.length, 0, 'אף פנייה ל-Timeless');
});

test('הבוט ("איך היה?") — מהשמירה: פגישה עם סיכום, לעובד שהשתתף', async (t) => {
  setup(t);
  const api = timeless(t, [MTG('mtg_f', { participants: [{ name: 'רון', email: 'ron@eshel.test' }] })]);
  await Store.sweep(NOW);
  api.calls.length = 0;
  const calls = api.calls;
  const dana = user({ role: 'member', email: 'ron@eshel.test', phone: '972500000001' });
  const c = Followup._internal.timelessCandidates(NOW);
  const mine = c.find((x) => x.ref === 'mtg_f');
  assert.ok(mine && mine.users.includes(dana.id));
  assert.equal(calls.length, 0);
});

test('webhook: חתימה נכונה — הפגישה נמשכת מיד; חתימה שגויה — 401 בלי פנייה', async (t) => {
  setup(t);
  process.env.TIMELESS_WEBHOOK_SECRET = 'whsec-test';
  t.after(() => { delete process.env.TIMELESS_WEBHOOK_SECRET; });
  const { calls } = timeless(t, [MTG('mtg_w')]);
  const raw = Buffer.from(JSON.stringify({ event: 'meeting.initial_summary_ready', data: { meeting_id: 'mtg_w' } }));
  const bad = await Store.handleWebhook(raw, 'sha256=00');
  assert.equal(bad.status, 401);
  assert.equal(calls.length, 0);
  const sig = `sha256=${crypto.createHmac('sha256', 'whsec-test').update(raw).digest('hex')}`;
  const ok = await Store.handleWebhook(raw, sig);
  assert.equal(ok.status, 200);
  const row = D.get("SELECT * FROM timeless_meetings WHERE id = 'mtg_w'");
  assert.ok(row && row.transcript && row.documents);
});

test('סיכום שהגיע אחרי התמליל — מסמך חדש נמשך בסבב הבא', async (t) => {
  setup(t);
  const api = timeless(t, [MTG('mtg_s', { documents: [] })]);
  await Store.sweep(NOW);
  assert.equal(D.get("SELECT doc_refs FROM timeless_meetings WHERE id = 'mtg_s'").doc_refs, '[]');
  api.meetings = [MTG('mtg_s')];
  await Store.sweep(NOW + 20 * 60000);
  const docs = JSON.parse(D.get("SELECT documents FROM timeless_meetings WHERE id = 'mtg_s'").documents);
  assert.equal(docs[0].id, 'doc_mtg_s');
});
