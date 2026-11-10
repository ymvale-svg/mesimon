'use strict';
/**
 * 🔊 הקראה (‎Speech.speak‎) — הבקשה ל-OpenAI, בלי רשת: ‎fetch‎ מזויף.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Speech = require('../../../server/integrations/speech');

function withKey(t, key = 'sk-test') {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = key;
  t.after(() => { if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; });
}

test('canSpeak — רק כשיש מפתח OpenAI', (t) => {
  assert.equal(Speech.canSpeak(), false);
  withKey(t);
  assert.equal(Speech.canSpeak(), true);
});

test('speak — בקשה ל-audio/speech בפורמט opus, והקובץ חוזר כ-Buffer', async (t) => {
  withKey(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(Buffer.from('OggS-fake'), { status: 200 });
  });
  const buf = await Speech.speak('  שלום   ישראל ');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'OggS-fake');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input, 'שלום ישראל');
  assert.equal(body.response_format, 'opus');
  assert.equal(body.model, 'gpt-4o-mini-tts');
  assert.match(body.instructions, /עברית/);
});

test('speak — בלי מפתח, טקסט ריק או שגיאה מ-OpenAI: זורק', async (t) => {
  await assert.rejects(() => Speech.speak('שלום'), /OPENAI_API_KEY/);
  withKey(t);
  await assert.rejects(() => Speech.speak('   '), /אין מה להקריא/);
  t.mock.method(globalThis, 'fetch', async () => new Response('quota', { status: 429 }));
  await assert.rejects(() => Speech.speak('שלום'), /429/);
});
