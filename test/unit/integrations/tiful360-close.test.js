'use strict';
/**
 * 🎫 משימה מקריאת שירות הסתיימה — הקריאה מסומנת "טופלה" בתפעול 360, חוץ מקריאה שנשלחה לאיש IT (באחריותו).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Tiful360 = require('../../../server/integrations/tiful360');
const D = require('../../../server/core').Db;

const task = { id: 7, source: 'tiful360', source_ref: 'IT-0042' };

function setup(t, reply) {
  process.env.TIFUL360_API_URL = 'https://tiful.example/functions/v1/it-api';
  process.env.TIFUL360_API_KEY = 'k';
  t.after(() => { delete process.env.TIFUL360_API_URL; delete process.env.TIFUL360_API_KEY; });
  const sent = [];
  const notes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  t.mock.method(D, 'audit', (id, ref, type, note) => notes.push(note));
  return { sent, notes };
}

test('הקריאה מסומנת "טופלה", ומשימון מבקש להשאיר פתוחה קריאה שנשלחה לאיש IT', async (t) => {
  const { sent, notes } = setup(t, { ok: true, status: 'done', emailed: true });
  await Tiful360.onTaskCompleted(task, { name: 'נווה' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'close_ticket');
  assert.equal(sent[0].ticket_code, 'IT-0042');
  assert.equal(sent[0].keep_if_forwarded_to_it, true);
  assert.deepEqual(notes, ['הקריאה סומנה "טופלה" בתפעול 360 ונשלח דואר לפותח']);
});

test('קריאה שנשלחה לאיש IT — נשארת פתוחה, ונרשם שהיא באחריותו', async (t) => {
  const { notes } = setup(t, { ok: true, forwarded_to_it: true, it_person: 'אבי' });
  await Tiful360.onTaskCompleted(task, { name: 'נווה' });
  assert.deepEqual(notes, ['הקריאה נשלחה לאיש IT (אבי) ונשארת פתוחה בתפעול 360 — באחריותו']);
});

test('משימה שלא הגיעה מתפעול 360 — אין פנייה', async (t) => {
  const { sent } = setup(t, {});
  assert.equal(Tiful360.onTaskCompleted({ id: 1, source: 'manual' }, null), null);
  assert.equal(sent.length, 0);
});
