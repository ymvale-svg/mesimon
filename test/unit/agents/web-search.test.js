'use strict';
/**
 * באג 22.11.26: "תבדוק ברשת" — "✨ העוזר" ענה "אין לי גישה לרשת". לסוכנים יש חיפוש ברשת (‎web_search‎, כלי שרץ אצל
 * Anthropic), וההנחיה אומרת להשתמש בו ולא לכתוב שאין גישה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Agents = require('../../../server/agents/agents');
const McpClient = require('../../../server/integrations/mcp-client');

boot();
const { runAgent, WEB_RULE } = Agents._internal;

test('runAgent — העוזר הכללי מקבל חיפוש ברשת, וההנחיה לא לומר "אין גישה"', async (t) => {
  t.mock.method(McpClient, 'anthropicTools', async () => []); // בלי שרתי MCP בבדיקה
  const ai = Fakes.claude(t, () => ({ text: 'מצאתי 3 ספקים', calls: [] }));
  const u = user({ role: 'admin' });
  const r = await runAgent(null, u, { type: 'user', id: u.id, role: 'admin' }, 'תבדוק ברשת ספקים להשכרת גנרטור');
  assert.equal(r.text, 'מצאתי 3 ספקים');
  const opts = ai.calls[0].opts;
  assert.equal(opts.serverTools?.[0]?.name, 'web_search');
  assert.match(opts.system, /לעולם אל תכתוב שאין לך גישה לרשת/);
  assert.match(WEB_RULE, /web_search/);
});
