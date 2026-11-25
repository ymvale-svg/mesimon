'use strict';
/**
 * באג (25.11.26): סימון טקסט בפאנל המשימה בגרירה שיצאה מהפאנל (כדי למחוק את הכותרת) סגר את המשימה.
 * הדפדפן שולח ‎click‎ על האב המשותף של תחילת הגרירה וסופה — "בחוץ". נבדק בדפדפן אמיתי.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'js', 'ui.js'), 'utf8');

test('חלון ופאנל צד: נסגרים רק כשהלחיצה גם התחילה בחוץ', () => {
  assert.match(ui, /const onDown = \(e\) => \{ downInside = box\.contains\(e\.target\); \};/);
  assert.match(ui, /if \(e\.target === backdrop && !downInside\)/);
  assert.match(ui, /if \(closed \|\| downInside \|\| box\.contains\(e\.target\)\) return;/);
  assert.match(ui, /document\.removeEventListener\('pointerdown', onDown, true\);/);
});

test('מגירה תחתונה: סימון שהתחיל במגירה לא סוגר אותה', () => {
  assert.match(ui, /downInPanel = panel\.contains\(e\.target\);/);
  assert.match(ui, /if \(e\.target === veil && !downInPanel\) close\(\);/);
});
