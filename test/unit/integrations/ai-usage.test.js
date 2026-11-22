'use strict';
/**
 * 💰 צריכת ה-AI ("תוכנית — חיסכון בקרדיטי AI.md", שלב 0): כל קריאה ל-Claude נרשמת לעובד ולתכונה, עם הערכת עלות,
 * וכל קריאה בקוד מעבירה תכונה מוכרת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../../server/core').Db;
const Claude = require('../../../server/integrations/claude');
const AiUsage = require('../../../server/integrations/ai-usage');

function withKey(t) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}
const answer = (usage, model = 'claude-opus-5-5', content = [{ type: 'text', text: '{"a":1}' }]) => async () =>
  new Response(JSON.stringify({ model, content, stop_reason: 'end_turn', usage }), { status: 200 });
const ask = (opts = {}) => Claude.json({ system: 's', content: [{ type: 'text', text: 'x' }], schema: { type: 'object', properties: {} }, ...opts });
const rows = () => D.all('SELECT * FROM ai_usage ORDER BY feature, user_id');

test.beforeEach(() => D.run('DELETE FROM ai_usage'));

test('קריאה נרשמת לתכונה ולעובד, עם טוקנים ועלות לפי המחירון', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 500 }));
  await ask({ feature: 'mail.scan', userId: 7 });
  const [r] = rows();
  assert.equal(r.feature, 'mail.scan');
  assert.equal(r.user_id, 7);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual([r.calls, r.input, r.cache_write, r.cache_read, r.output], [1, 1000, 2000, 10000, 500]);
  // 1000×4 + 2000×5 + 10000×0.2 + 500×20 = 26000 למיליון = 0.026$
  assert.equal(r.cost_micro, 26000);
});

test('אותו יום, עובד ותכונה — שורה אחת שמצטברת', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 100, output_tokens: 10 }));
  await ask({ feature: 'bot.chat', userId: 3 });
  await ask({ feature: 'bot.chat', userId: 3 });
  const all = rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].calls, 2);
  assert.equal(all[0].input, 200);
});

test('בלי userId — העובד מההקשר (‎forUser‎); בלי הקשר — 0 (הארגון)', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 10, output_tokens: 1 }));
  await Claude.forUser(42, async () => { await Promise.resolve(); await ask({ feature: 'mail.reply' }); });
  await ask({ feature: 'agents.knowledge' });
  assert.deepEqual(rows().map((r) => [r.feature, r.user_id]), [['agents.knowledge', 0], ['mail.reply', 42]]);
});

test('userId מפורש גובר על ההקשר', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 10, output_tokens: 1 }));
  await Claude.forUser(42, () => ask({ feature: 'meetings.briefing', userId: 5 }));
  assert.equal(rows()[0].user_id, 5);
});

test('מצב מהיר — פי 2, ונרשם בנפרד', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 1e6, output_tokens: 0, speed: 'fast' }));
  await ask({ feature: 'bot.chat', live: true });
  const [r] = rows();
  assert.equal(r.fast, 1);
  assert.equal(r.cost_micro, 8e6);
});

test('תכונה לא מוכרת — "other", ומודל שאינו במחירון — טוקנים בלי עלות', async (t) => {
  withKey(t);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 10, output_tokens: 1 }, 'claude-something-new'));
  await ask({ feature: 'no.such.feature' });
  const [r] = rows();
  assert.equal(r.feature, 'other');
  assert.equal(r.input, 10);
  assert.equal(r.cost_micro, 0);
});

test('שיחה עם כלים — כל סבב נרשם', async (t) => {
  withKey(t);
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n++;
    const body = n === 1
      ? { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'calc', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } }
      : { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'תשובה' }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 20 } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const r = await Claude.withTools({ feature: 'agents.ask', userId: 9, system: 's', content: [{ type: 'text', text: 'x' }], tools: [{ name: 'calc', description: 'c', input_schema: { type: 'object', properties: {} } }], onTool: async () => 'ok' });
  assert.equal(r.text, 'תשובה');
  const [row] = rows();
  assert.deepEqual([row.feature, row.user_id, row.calls, row.input, row.output], ['agents.ask', 9, 2, 300, 30]);
});

test('חיפוש ברשת נספר ומתומחר', () => {
  assert.equal(AiUsage.costOf('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }), 0.03);
});

test('הדוח — סך הכול, לפי תכונה ולפי עובד (עם השם), מהיקר לזול', async (t) => {
  withKey(t);
  const id = Number(D.run("INSERT INTO users (full_name, email, password_hash, role, status, created_at) VALUES ('דנה', 'dana@example.com', 'x', 'employee', 'active', ?)", D.nowIso()).lastInsertRowid);
  t.mock.method(globalThis, 'fetch', answer({ input_tokens: 1e6, output_tokens: 0 }));
  await ask({ feature: 'mail.scan', userId: id });
  await ask({ feature: 'mail.scan', userId: id });
  await ask({ feature: 'meetings.briefing', userId: id });
  await ask({ feature: 'agents.knowledge' });
  const r = AiUsage.report({ days: 7 });
  assert.equal(r.total.calls, 4);
  assert.equal(r.total.usd, 16);
  assert.equal(r.byFeature[0].feature, 'mail.scan');
  assert.equal(r.byFeature[0].usd, 8);
  assert.equal(r.byFeature[0].label, AiUsage.FEATURES['mail.scan']);
  assert.equal(r.byUser[0].name, 'דנה');
  assert.equal(r.byUser[0].usd, 12);
  assert.deepEqual(r.byUser[0].features.map((f) => f.feature), ['mail.scan', 'meetings.briefing']);
  assert.equal(r.byUser[1].userId, 0);
  assert.equal(r.byDay.length, 1);
});

/*
 * כל קריאה ל-Claude בקוד מעבירה ‎feature‎ מוכר — אחרת היא נרשמת כ"לא מסווג", ומסך העלות לא אומר על מה הכסף הלך.
 */
test('כל קריאה ל-Claude.json / Claude.withTools בקוד מעבירה feature מוכר', () => {
  const root = path.join(__dirname, '../../../server');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(root);
  const bad = [];
  let count = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/Claude\.(json|withTools)\(\{/g)) {
      count++;
      // מאפייני הקריאה — עד 6 שורות אחרי הפתיחה
      const head = src.slice(m.index, m.index + 600).split('\n').slice(0, 6).join('\n');
      const fm = /feature:\s*'([^']+)'/.exec(head);
      const line = src.slice(0, m.index).split('\n').length;
      if (!fm || !AiUsage.FEATURES[fm[1]] || fm[1] === 'other') bad.push(`${path.relative(root, f)}:${line} ${fm ? fm[1] : '(בלי feature)'}`);
    }
  }
  assert.ok(count > 50, `נמצאו רק ${count} קריאות — החיפוש שבור?`);
  assert.deepEqual(bad, []);
});
