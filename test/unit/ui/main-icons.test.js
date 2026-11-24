'use strict';
/**
 * 🎨 משימון הראשי — סבב האייקונים (24.11.26, ui-styling + 21st): בסרגל, בתפריט, בפס הפעולה בטלפון
 * ובכלי המסכים הראשיים (Today, יומן, לוח, דוחות, ניהול) — סמלי קו (‎UI.lineIcon‎), לא אימוג'י.
 * אימוג'י נראה אחרת בכל מערכת הפעלה ולא מקבל את צבע הטקסט (ולכן לא את מצב הלילה).
 * שאר האימוג'י בתוך טקסטים והודעות — "חוב עיצובי" ב-design-system/mesimon/MASTER.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const ui = read('js/ui.js');

test('כל סמל קו שבשימוש קיים ב-LINE_ICONS', () => {
  const names = new Set([...ui.slice(ui.indexOf('const LINE_ICONS'), ui.indexOf('function lineIcon')).matchAll(/^\s*'?([a-z-]+)'?: '</gm)].map((m) => m[1]));
  const files = ['js/app.js', 'js/ui.js', ...fs.readdirSync(path.join(PUB, 'js', 'views')).map((f) => `js/views/${f}`)];
  for (const f of files) {
    for (const m of code(f).matchAll(/lineIcon\('([a-z-]+)'/g)) assert.ok(names.has(m[1]), `${f}: אין סמל "${m[1]}"`);
  }
  // מתג התצוגה בלוח: שם המצב הוא שם הסמל
  for (const mode of ['table', 'kanban', 'timeline']) assert.ok(names.has(mode), mode);
});

test('הסרגל העליון, התפריט והטלפון — בלי אימוג\'י', () => {
  const app = code('js/app.js');
  for (const bad of ["['✨ שאל את אשל']", "['☀ Today'", "['🎙']", "text: '☀' }), el('span', { text: 'Today' })", "text: '🎙' }), el('span', { text: 'הקלטה' })",
    "{ emoji: '☀' }", "nav-emoji', { text: '📅' }", "nav-emoji', { text: '🗂' }", "pinned ? '⇥' : '⇤'", "}, ['☰'])", "AskView.open() }, ['✨'])"]) {
    assert.ok(!app.includes(bad), bad);
  }
  assert.match(app, /el\('img\.nav-prio', \{ src: '\/priority\/priority-mark\.svg'/, 'משימון פריוריטי בתפריט — עם הסמל של פריוריטי');
});

test('המסכים הראשיים — בלי אימוג\'י בכפתורים ובכותרות', () => {
  const checks = {
    'js/views/today.js': ["['⟳']", "['⚙']", "text: '🌤'", "section('📅", "['🎥']"],
    'js/views/calendar.js': ["'📅 יומן'", "'🎥 הקלטות'", "['⟳ רענון']", "['📅 קביעת פגישה']"],
    'js/views/board.js': ["'☰ טבלה'", "'▦ כרטיסיות'", "['⬇ ייצוא CSV']", "['💾 שמור מסנן']", "['✎ עריכת פרויקט']"],
    'js/views/grid.js': ["'⤡ קיפול הכל'", "['✎ פרויקט']"],
    'js/views/mobile.js': ["'⚙ סינון'", "['📒 אלפון']"],
    'js/views/reports.js': ["['⬇ ייצוא"],
    'js/views/admin.js': ["['✉ הזמנה']", "'📱 אין טלפון'", "['⇪ ייבוא מאקסל']"]
  };
  for (const [f, bads] of Object.entries(checks)) {
    const s = code(f);
    for (const bad of bads) assert.ok(!s.includes(bad), `${f}: ${bad}`);
  }
});

test('הרענון ביומן משנה רק את התווית — הסמל נשאר', () => {
  const cal = code('js/views/calendar.js');
  assert.match(cal, /btn\.querySelector\('\.btn-lbl'\)\.textContent = 'מרענן…'/);
  assert.doesNotMatch(cal, /btn\.textContent = '⟳/);
});

test('כפתור שהוא סמל בלבד — עם שם לקורא מסך', () => {
  const app = code('js/app.js');
  assert.match(app, /mic-btn', \{ title: 'משימה מהקלטה', 'aria-label': 'משימה מהקלטה'/);
  const today = code('js/views/today.js');
  assert.match(today, /'aria-label': 'רענון, כולל היומן'/);
  assert.match(today, /'aria-label': 'הגדרות Today'/);
});

test('לוח בטלפון: היעד — יום וחודש בלבד; דוחות: שורת העומס נשברת', () => {
  assert.match(code('js/views/grid.js'), /slim\(\) \? UI\.formatDate\(task\.dueDate\)\.slice\(0, 5\)/);
  assert.match(code('js/views/reports.js'), /el\('div\.flex\.wl-row'/);
  assert.match(read('css/styles.css'), /\.wl-row \{ flex-wrap: wrap/);
});

/*
 * סבב 2 (24.11.26) — כל המסכים: אימוג'י ציורי בתחילת הילדים של el() או בתחילת ה-text שלו הוא אייקון — סמל קו.
 * סימנים טיפוגרפיים (✕ ✓ ✗ חצים) מותרים, כמו שנקבע ב-MASTER.md. אימוג'י בתוך משפט — מותר.
 */
const PICTO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2705}\u{2709}\u{270D}\u{270E}\u{270F}\u{2728}\u{2753}\u{2795}\u{2B07}]/u;
const LEAD = new RegExp(String.raw`(\}, \[\s*'|el\('[^']+', \{ text: ')(` + PICTO.source + ')', 'u');

test('בכל המסכים: אימוג\'י בתחילת כפתור, כותרת או תגית — סמל קו', () => {
  const files = ['js/app.js', 'js/ui.js', ...fs.readdirSync(path.join(PUB, 'js', 'views')).map((f) => `js/views/${f}`)];
  const bad = [];
  for (const f of files) {
    code(f).split('\n').forEach((line, i) => { if (LEAD.test(line) && !/el\('option/.test(line)) bad.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`); });
  }
  assert.deepEqual(bad, []);
});

test('תווית מרשימה ("✨ מה חדש") — סמל וטקסט דרך UI.iconLabel; ריק עם אימוג\'י — סמל', () => {
  assert.match(ui, /function iconLabel\(text\)/);
  assert.match(ui, /el\('div\.e-icon', \{\}, \[emojiIcon\(icon\)\]\)/);
  assert.match(code('js/views/admin.js'), /\}, UI\.iconLabel\(t\.label\)\)\);/);
  assert.match(code('js/views/admin-ai.js'), /UI\.iconLabel\(label\)/);
  // כל אימוג'י במפה של iconLabel — יש לו סמל
  const names = new Set([...ui.slice(ui.indexOf('const LINE_ICONS'), ui.indexOf('function lineIcon')).matchAll(/^\s*'?([a-z-]+)'?: '</gm)].map((m) => m[1]));
  const map = ui.slice(ui.indexOf('const EMOJI_ICON'), ui.indexOf('const EMOJI_LEAD'));
  for (const m of map.matchAll(/: '([a-z-]+)'/g)) assert.ok(names.has(m[1]), m[1]);
});
