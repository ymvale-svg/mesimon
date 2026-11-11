'use strict';
/**
 * 🩺 ‎Claude.onHealth‎ — המאזינים שומעים על תקלה (שגיאה מהשירות / אין חיבור) ועל תשובה תקינה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Claude = require('../../../server/integrations/claude');

const events = [];
Claude.onHealth((e) => events.push(e));

function withKey(t) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}
const ask = () => Claude.json({ system: 's', content: [{ type: 'text', text: 'x' }], schema: { type: 'object', properties: {} } });

test('קרדיט שנגמר (400) — ok:false עם השגיאה', async (t) => {
  withKey(t);
  events.length = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Your credit balance is too low' } }), { status: 400 }));
  await assert.rejects(ask, /credit balance/);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.match(events[0].err.message, /שגיאה 400: Your credit balance/);
});

test('אין חיבור — ok:false', async (t) => {
  withKey(t);
  events.length = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch failed'); });
  await assert.rejects(ask, /אין חיבור לשירות ה-AI/);
  assert.deepEqual(events.map((e) => e.ok), [false]);
});

test('תשובה תקינה — ok:true', async (t) => {
  withKey(t);
  events.length = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'respond', input: { a: 1 } }], stop_reason: 'tool_use', usage: {} }), { status: 200 }));
  await ask().catch(() => {});
  assert.equal(events[0]?.ok, true);
});

test('חצי אימוג\'י בטקסט (היסטוריה שנחתכה באמצע תו) — הבקשה יוצאת תקינה, והאימוג\'י השלם נשמר', async (t) => {
  withKey(t);
  let sent = '';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = init.body;
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'respond', input: {} }], stop_reason: 'tool_use', usage: {} }), { status: 200 });
  });
  const cut = `1. כונן F עמוס · ${'📅'.slice(0, 1)}`; // כמו ‎reply.slice(0, 500)‎ שנפל באמצע 📅
  await Claude.json({ system: 's', content: [{ type: 'text', text: `${cut}\n2. משימה · 📅 מחר` }], schema: { type: 'object', properties: {} } }).catch(() => {});
  assert.doesNotMatch(sent, /\\ud[89a-f][0-9a-f]{2}/i, 'אין surrogate בודד בגוף הבקשה');
  const text = JSON.parse(sent).messages[0].content[0].text;
  assert.match(text, /כונן F עמוס · �/);
  assert.match(text, /📅 מחר/);
});
