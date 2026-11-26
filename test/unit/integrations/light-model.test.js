'use strict';
/**
 * 🪶 "מודל קל" למיון וסיווג ברקע ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 9, שלב ג'): ‎light: true‎ ← ‎ai_light_model‎
 * (Haiku). נדחה (4xx שאינו 429) — אותה בקשה במודל הראשי. ותכונות שכותבות למישהו — לעולם לא במודל הקל.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../../server/core').Db;
const Claude = require('../../../server/integrations/claude');

function withKey(t) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}
/** ‎fetch‎ מזויף: רושם את המודל של כל בקשה. ‎failFor‎ — מודל שנדחה בסטטוס ‎status‎ */
function fakeApi(t, { failFor = null, status = 400 } = {}) {
  const models = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { model } = JSON.parse(init.body);
    models.push(model);
    if (model === failFor) return new Response(JSON.stringify({ error: { message: 'model not supported' } }), { status });
    return new Response(JSON.stringify({ model, content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  return models;
}
const ask = (opts = {}) => Claude.json({ feature: 'tasks.sync', system: 's', content: [{ type: 'text', text: 'x' }], schema: { type: 'object', properties: {} }, effort: 'low', ...opts });

test.afterEach(() => D.setSetting('ai_light_model', 'claude-haiku-5-5'));

test('‎light‎ — במודל הקל', async (t) => {
  withKey(t);
  const models = fakeApi(t);
  assert.deepEqual(await ask({ light: true }), { ok: true });
  assert.deepEqual(models, ['claude-haiku-5-5']);
});

test('בלי ‎light‎ — המודל הראשי, כמו קודם', async (t) => {
  withKey(t);
  const models = fakeApi(t);
  await ask();
  assert.deepEqual(models, [Claude.model()]);
});

test('המודל הקל נדחה (400) — אותה בקשה במודל הראשי', async (t) => {
  withKey(t);
  t.mock.method(console, 'error', () => {});
  const models = fakeApi(t, { failFor: 'claude-haiku-5-5' });
  assert.deepEqual(await ask({ light: true }), { ok: true });
  assert.deepEqual(models, ['claude-haiku-5-5', Claude.model()]);
});

test('תקלה זמנית (429) — לא עוברים למודל היקר, השגיאה עולה כמו תמיד', async (t) => {
  withKey(t);
  t.mock.method(console, 'error', () => {});
  const models = fakeApi(t, { failFor: 'claude-haiku-5-5', status: 429 });
  await assert.rejects(() => ask({ light: true }), /429/);
  assert.deepEqual(models, ['claude-haiku-5-5']);
});

test('‎ai_light_model‎ ריק — המודל הראשי; מודל מפורש גובר על ‎light‎', async (t) => {
  withKey(t);
  const models = fakeApi(t);
  D.setSetting('ai_light_model', '');
  await ask({ light: true });
  D.setSetting('ai_light_model', 'claude-haiku-5-5');
  await ask({ light: true, model: 'claude-sonnet-5-5' });
  assert.deepEqual(models, [Claude.model(), 'claude-sonnet-5-5']);
});

/*
 * מה רץ במודל הקל — נבדק בקוד עצמו: כל קריאה של התכונות האלה מסומנת ‎light: true‎, ואף קריאה של תכונה
 * שכותבת למישהו (תשובה למייל, פנייה, חילוץ מסמך לפריוריטי, סיכום פגישה, הבנת בקשה בבוט) — לא.
 */
const SERVER = path.join(__dirname, '../../../server');
const sources = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push({ file: path.relative(SERVER, full), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(SERVER);
  return out;
};
/** כל הקריאות ל-‎Claude.json‎ של תכונה — הטקסט מ-‎feature‎ עד סוף הקריאה (בקירוב: עד ‎});‎ הראשון) */
function callsOf(feature) {
  const calls = [];
  for (const { file, text } of sources()) {
    let i = -1;
    while ((i = text.indexOf(`feature: '${feature}'`, i + 1)) !== -1) {
      const end = text.indexOf('});', i);
      calls.push({ file, body: text.slice(i, end === -1 ? i + 600 : end) });
    }
  }
  return calls;
}

const LIGHT = ['tasks.sync', 'tasks.dupes', 'tasks.closure', 'mail.insights', 'mail.reply_learn', 'priority.po', 'bot.instinct', 'bot.groups', 'bot.wa_scan'];
const NEVER = ['mail.reply', 'tasks.ai', 'tasks.outreach', 'priority.goods', 'priority.demand', 'priority.rfq', 'meetings.summary', 'meetings.briefing', 'mail.forms'];

test('תכונות המיון והסיווג — כל הקריאות שלהן במודל הקל', () => {
  for (const f of LIGHT) {
    const calls = callsOf(f);
    assert.ok(calls.length, `${f}: לא נמצאה קריאה`);
    for (const c of calls) assert.match(c.body, /light: true/, `${f} ב-${c.file}`);
  }
});

test('תכונות שכותבות למישהו — לעולם לא במודל הקל', () => {
  for (const f of NEVER) {
    for (const c of callsOf(f)) assert.doesNotMatch(c.body, /light: true/, `${f} ב-${c.file}`);
  }
});
