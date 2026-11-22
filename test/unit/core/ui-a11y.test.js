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

test('תווית של שדה מקושרת לשדה (for/id) — סקירת הממשק 15.11.26', () => {
  const src = pub('js/ui.js');
  assert.match(src, /if \(!control\.id\) control\.id = `fld-\$\{\+\+fieldSeq\}`;/);
  assert.match(src, /el\('label', \{ text: label, for: forId \}\)/);
});

test('גם בחלון UI.prompt ובעורך נקודות הציון התווית מקושרת לשדה — סקירת הממשק 22.11.26', () => {
  assert.match(pub('js/ui.js'), /body: field\(label, input, hint\),/);
  const loc = pub('js/views/location.js');
  assert.match(loc, /const field = \(label, input, hint\) => UI\.field\(label, input, hint\);/);
  assert.doesNotMatch(loc, /el\('label', \{ text: label \}\)/);
});
