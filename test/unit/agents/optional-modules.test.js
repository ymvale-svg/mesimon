'use strict';
/**
 * באג: אחרי החלוקה לתחומים (10.11.26) הסוכנים חיפשו את Timeless ואת MCP בנתיבים הישנים
 * (‎optional('../timeless')‎), קיבלו null בשקט ועבדו בלי הכלים שלהם. כל ‎optional('…')‎ בשרת
 * חייב להצביע על קובץ קיים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', '..', 'server');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

test('כל optional(...) בשרת מצביע על מודול קיים', () => {
  const missing = [];
  for (const f of files(SERVER)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/optional\('([^']+)'\)/g)) {
      if (!m[1].startsWith('.')) continue;
      try { require.resolve(path.resolve(path.dirname(f), m[1])); } catch { missing.push(`${path.relative(SERVER, f)} → ${m[1]}`); }
    }
  }
  assert.deepEqual(missing, []);
});

test('הסוכנים מקבלים את Timeless ואת MCP מ-integrations', () => {
  const src = fs.readFileSync(path.join(SERVER, 'agents', 'agents.js'), 'utf8');
  assert.match(src, /const Timeless = \(\) => Integrations\.Timeless/);
  assert.match(src, /const Mcp = \(\) => Integrations\.McpClient/);
});
