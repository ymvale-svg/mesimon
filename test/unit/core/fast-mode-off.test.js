'use strict';
/**
 * 💰 מצב מהיר כבוי (17.11.26, "תוכנית — חיסכון בקרדיטי AI.md" סעיף 5.2) — פעם אחת, גם אם נשמר דלוק בטופס.
 * אחר כך מנהל יכול להדליק שוב, והבחירה שלו נשמרת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../../server/core/db');
const Claude = require('../../../server/integrations/claude');

test('נשמר דלוק — אחרי העלייה כבוי; מנהל שמדליק שוב — נשאר דלוק', () => {
  D.bootstrap();
  assert.equal(D.getSetting('ai_fast_mode', true), false);
  assert.equal(Claude.status().fast, false);
  D.setSetting('ai_fast_mode', true);
  D.bootstrap();
  assert.equal(D.getSetting('ai_fast_mode', false), true, 'ההעברה רצה פעם אחת');
});

test('ברירת המחדל: מיון המיילים ב-Haiku', () => {
  assert.equal(D.DEFAULT_SETTINGS.ai_scan_model, 'claude-haiku-5-5');
  assert.equal(D.DEFAULT_SETTINGS.ai_fast_mode, false);
});
