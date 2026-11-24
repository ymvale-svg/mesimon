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
  const toast = js.slice(js.indexOf('function toast('), js.indexOf('function toast(') + 400);
  assert.doesNotMatch(toast, /\.hidden = /, 'הודעה מוסתרת לא תמיד מוקראת');
});

test('בלי אימוג׳י כאייקונים בממשק — SVG בלבד', () => {
  const ui = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(ui, /[\u{1F100}-\u{1FAFF}\u{2600}-\u{26FF}✉⤓✕]/u);
});

test('מחיקה מהתור — לחיצה שנייה לאישור', () => {
  assert.match(js, /confirmDel/);
  assert.match(js, /'למחוק\?'/);
});

test('ניגודיות: אדום במצב בהיר #b91c1c (4.5:1 מול הרקע שלו), וכרטיס כבוי בלי שקיפות', () => {
  assert.match(css, /--bad: #b91c1c/);
  assert.doesNotMatch(css, /\.tile\.off\s*\{[^}]*opacity/);
});

test('כותרות קפואות: מטריצת ההרשאות וטבלת החברות גוללות במסגרת, ושורת הכותרות נשארת', () => {
  assert.match(js, /class="scroll sticky-wrap"[^>]*><table class="mtx"/);
  assert.match(js, /class="scroll sticky-wrap"[^>]*><table class="t" id="co"/);
  assert.match(css, /\.sticky-wrap \{[^}]*max-height[^}]*overflow: auto/);
  assert.match(css, /\.sticky-wrap th \{[^}]*position: sticky; top: 0/);
});

test('"המערכת קוראת": בועה עם נקודות, השלב, רשימת השלבים, פס התקדמות וקו סריקה — ובלי תנועה למי שביקש פחות תנועה', () => {
  assert.match(js, /BUSY = \{\s*read: \[/);
  assert.match(js, /class="msg bot busy" id="busy-bubble"/);
  assert.match(js, /classList\.toggle\('scanning'/);
  assert.match(css, /\.preview\.scanning::after \{[^}]*animation: scan/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.typing i, \.busy-bar span::after, \.preview\.scanning::after \{ animation: none; \}/);
});

test('✍️ ממתין לאישורך: אין ממתינים — האזור לא מצויר בכלל; יש — מעל האריחים, עם קישור בלשונית חדשה', () => {
  const w = js.slice(js.indexOf('const Waiting = (() => {'), js.indexOf('return { mount };'));
  assert.match(w, /if \(!items\.length\) \{ box\.innerHTML = ''; return; \}/);
  assert.match(css, /#waiting:empty \{ display: none; \}/);
  const home = js.slice(js.indexOf('async function home()'), js.indexOf('const Waiting = (() => {'));
  assert.ok(home.indexOf('<div id="waiting"></div>') < home.indexOf('<div class="tiles">'), 'האזור מעל האריחים');
  assert.match(w, /target="_blank" rel="noopener" data-open=/);
  assert.match(w, /visibilitychange/);
  assert.match(css, /@media \(max-width: 760px\) \{\n  \.appr-wide \{ display: none; \}/, 'בטלפון — כרטיסים');
});

test('הלוגו המשותף: משימון | פריוריטי בכותרת, וסמל לשונית משלו', () => {
  assert.match(html, /class="brand-mesimon" src="\/icons\/icon-192\.png"/);
  assert.match(html, /class="brand-prio"><img src="\/priority\/priority-mark\.svg"/);
  assert.match(html, /rel="icon" href="\/priority\/logo\.svg"/);
  for (const f of ['priority-mark.svg', 'logo.svg']) assert.match(fs.readFileSync(path.join(DIR, f), 'utf8'), /<svg[^>]*viewBox/);
});

test('טאבים עם אייקון, בשורה אחת שגוללת לרוחב (לא שלוש שורות בטלפון)', () => {
  assert.match(js, /\$\{ic\}<span>\$\{label\}<\/span><\/a>/);
  assert.match(css, /\.tabs \{[^}]*flex-wrap: nowrap; overflow-x: auto/);
});

test('כפתור שהוא קישור (ייצוא לאקסל) נראה ככפתור — בלי קו תחתון וכחול', () => {
  assert.match(css, /\.btn \{[^}]*color: var\(--text\); text-decoration: none/);
  assert.match(js, /\$\{ui\('download'\)\}<span>ייצוא לאקסל/);
  assert.match(js, /\$\{ui\('refresh'\)\}<span>רענון מפריוריטי/);
});

test('תשלומים בטלפון: הטבלה הופכת לכרטיסים, וכרטיסי המועד בפס שגולל', () => {
  assert.match(js, /<table class="t pay-t"><thead>/);
  for (const l of ['מועד', 'סוג', 'ספק', 'סכום', 'פרויקט', 'יוזם']) assert.match(js, new RegExp(`data-label="${l}"`));
  const mob = css.slice(css.indexOf('/* כרטיסי המועד'));
  assert.match(mob, /\.pay-buckets \{[^}]*overflow-x: auto/);
  assert.match(mob, /\.pay-t thead \{[^}]*position: absolute/);
  assert.match(mob, /table\.t\.pay-t td \{[^}]*border: 0/);
});

test('שם קובץ בעברית ואנגלית נקרא כמו שנכתב: "תעודת משלוח 881.jpg" (לא "jpg.881")', () => {
  const src = js.slice(js.indexOf('const LTR_TAIL'), js.indexOf('const fname'));
  const LTR_TAIL = eval(src.replace(/^const LTR_TAIL = /, '').replace(/;\s*$/, ''));
  const f = (n) => n.replace(LTR_TAIL, '$1<bdi dir="ltr">$2</bdi>');
  assert.equal(f('תעודת משלוח 881.jpg'), 'תעודת משלוח <bdi dir="ltr">881.jpg</bdi>');
  assert.equal(f('inv5521.pdf'), '<bdi dir="ltr">inv5521.pdf</bdi>');
  assert.equal(f('קבלת סחורה: תעודת משלוח 881.jpg'), 'קבלת סחורה: תעודת משלוח <bdi dir="ltr">881.jpg</bdi>');
  assert.equal(f('תעודה.pdf'), 'תעודה.pdf', 'שם עברי עם סיומת — בלי בידוד');
  for (const use of ['${fname(x.filename)}', '${fname(m.filename)}', '${fname(n.filename)}', 'fname(f.caption || f.name)']) assert.ok(js.includes(use), use);
  assert.match(js, /const fmtWa = \(t\) => esc\(t\)\.replace\(LTR_TAIL/);
});

test('עבודה על מסמך: כפתורי התור בשורה מתחת לשם (השם לא נחתך), ושורות המסמך — כרטיסים בטלפון', () => {
  assert.match(css, /\.qcard \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.qmain \{ flex-basis: 100%; \}/);
  assert.match(css, /table\.t\.lines tr \{ display: grid/);
});

test('הגדרות: פס שמירה עם רקע, בלי ריק מתחת לטבלה קצרה, וכפתור "חברה" עם אייקון', () => {
  assert.match(js, /class="row-actions savebar"/);
  assert.doesNotMatch(js, /style="position:sticky/);
  assert.match(css, /\.savebar \{[^}]*position: sticky; bottom: 0/);
  assert.doesNotMatch(css, /\.sticky-wrap \{[^}]*min-height/);
  assert.match(js, /id="co-add">\$\{ui\('plus'\)\}/);
});
