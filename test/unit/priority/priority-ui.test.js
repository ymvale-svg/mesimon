'use strict';
/**
 * 🎨 משימון פריוריטי — כללי הנגישות והעיצוב שנקבעו בבדיקת ui-ux-pro-max / ui-styling (11.11.26), שלא יישברו:
 * מתגים ותיבות סימון עם תפקיד ושם בעברית, אזור הגרירה נגיש מהמקלדת, הודעות סטטוס שמוקראות,
 * בלי אימוג'י כאייקונים, ואישור לפני מחיקה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', '..', 'public', 'priority');
const js = fs.readFileSync(path.join(DIR, 'priority.js'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'priority.css'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

test('מתגים: role="switch" + aria-checked, ושם בעברית לכל מתג', () => {
  assert.match(js, /class="tg" role="switch" aria-checked=/);
  assert.match(js, /write: 'כתיבה'/);
  assert.doesNotMatch(js, /class="tg"[^>]*aria-pressed/);
});

test('מטריצת ההרשאות: role="checkbox" + aria-checked, והמקלדת נשארת במקום אחרי ציור מחדש', () => {
  assert.match(js, /class="ck" role="checkbox" aria-checked=/);
  assert.match(js, /querySelector\(keep\)\?\.focus\(\)/);
});

test('אזור הגרירה הוא כפתור (נגיש מהמקלדת) ופותח בחירת קובץ, עם מצב "מעלה…"', () => {
  assert.match(js, /<button type="button" class="drop" id="drop"/);
  assert.match(js, /\$\('#file-in'\)\.click\(\)/);
  assert.match(js, /aria-busy/);
});

test('הודעת סטטוס נשארת ב-DOM עם role="status"; התוכן הראשי אינו אזור חי', () => {
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /<main[^>]*aria-live/);
  assert.doesNotMatch(js, /\.hidden = (true|false)/, 'הודעה מוסתרת לא תמיד מוקראת');
});

test('בלי אימוג׳י כאייקונים בממשק — SVG בלבד', () => {
  const ui = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(ui, /[\u{1F300}-\u{1FAFF}✉⤓✕]/u);
});

test('מחיקה מהתור — לחיצה שנייה לאישור', () => {
  assert.match(js, /confirmDel/);
  assert.match(js, /'למחוק\?'/);
});

test('ניגודיות: אדום במצב בהיר #b91c1c (4.5:1 מול הרקע שלו), וכרטיס כבוי בלי שקיפות', () => {
  assert.match(css, /--bad: #b91c1c/);
  assert.doesNotMatch(css, /\.tile\.off\s*\{[^}]*opacity/);
});
