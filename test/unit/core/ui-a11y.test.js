'use strict';
/**
 * נגישות בסיסית של הודעות (סקירת הממשק השבועית, 11.11.26): קורא מסך מקריא הודעות טוסט ושגיאות כניסה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', f), 'utf8');

test('אזור הטוסטים מוכרז לקורא מסך', () => {
  assert.match(pub('index.html'), /id="toast-root"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('טוסט שגיאה מקבל role=alert', () => {
  assert.match(pub('js/ui.js'), /kind === 'error' \? 'alert'/);
});

test('תיבת השגיאה במסכי הכניסה, ההרשמה וההזמנה מוכרזת', () => {
  for (const f of ['js/views/login.js', 'js/views/signup.js', 'js/views/invite.js']) {
    assert.match(pub(f), /const errorBox = el\('div\.alert\.alert-danger', \{ role: 'alert',/, f);
  }
});
