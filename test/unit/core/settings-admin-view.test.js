'use strict';
/**
 * מסך ההגדרות (‎/api/admin/settings‎) מציג הגדרות מערכת בלבד — לא מצב אישי של עובדים.
 * באג (סריקת אבטחה 11.11.26): ‎wa_questions:<userId>‎ שומר את טיוטת התשובה למייל (גוף, נמען, נושא),
 * ו-‎allSettings()‎ החזיר אותה לכל מי שיש לו ‎manage_automations‎. כך גם טיוטות קבלת סחורה ודרישת רכש.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../tasks/fixtures');

boot();

test('systemSettings — בלי מפתחות אישיים של עובדים (‎<סוג>:<משתמש>‎)', () => {
  D.setSetting('org_name', 'ארגון בדיקה');
  D.setSetting('wa_questions:7', [{ id: 'm1', draft: { kind: 'mail_reply', to: 'x@example.com', body: 'טיוטה' } }]);
  D.setSetting('goods_receipt:7', { step: 'confirm' });
  D.setSetting('purchase_demand:7', { step: 'lines' });

  const s = D.systemSettings();
  assert.equal(s.org_name, 'ארגון בדיקה');
  for (const k of Object.keys(s)) assert.ok(!k.includes(':'), `מפתח אישי נחשף: ${k}`);
  // המצב האישי עצמו נשאר במסד — הבוט ממשיך לעבוד
  assert.equal(D.getSetting('wa_questions:7', [])[0].id, 'm1');
  assert.ok('wa_questions:7' in D.allSettings());
});

test('כל מפתחות ברירת המחדל הם הגדרות מערכת (בלי ":")', () => {
  for (const k of Object.keys(D.DEFAULT_SETTINGS)) assert.ok(!k.includes(':'), k);
});

test('ה-API של מסך ההגדרות מחזיר systemSettings ולא allSettings', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../../server/api/api.js'), 'utf8');
  const block = src.slice(src.indexOf("'/api/admin/settings'"), src.indexOf("'/api/admin/rules'"));
  assert.ok(block.length > 0);
  assert.ok(!/allSettings\(\)/.test(block), 'מסך ההגדרות לא קורא ל-allSettings');
  assert.ok(/systemSettings\(\)/.test(block));
});
