'use strict';
/** ההגנות של test/setup.js — אם אחת מהן נשברת, בדיקות עלולות לפנות לשירות אמיתי */
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const os = require('node:os');

test('מסד הנתונים בתיקייה זמנית', () => {
  assert.ok(process.env.DATA_DIR.startsWith(os.tmpdir()));
  const D = require('../../server/core/db');
  assert.ok(D.DB_PATH.startsWith(os.tmpdir()));
});

test('fetch החוצה חסום', async () => {
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages'), /לרשת/);
  await assert.rejects(fetch('https://p.priority-connect.online/odata'), /לרשת/);
});

test('https.request החוצה חסום', () => {
  assert.throws(() => https.request('https://graph.facebook.com/v1'), /לרשת/);
  assert.throws(() => https.request({ hostname: 'gmail.googleapis.com', path: '/' }), /לרשת/);
});

test('אין מפתחות לשירותים חיצוניים, ואין חברה פתוחה לכתיבה בפריוריטי', () => {
  for (const k of ['ANTHROPIC_API_KEY', 'PRIORITY_USER', 'PRIORITY_PASSWORD', 'SMTP_HOST', 'GOOGLE_CLIENT_ID']) {
    assert.equal(process.env[k], undefined, k);
  }
  const Priority = require('../../server/integrations/priority');
  assert.deepEqual(Priority.allowed(), ['__none__']);
  assert.ok(!Priority.allowed().includes('test11'));
});
