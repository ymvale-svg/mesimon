'use strict';
/**
 * בדיקת הארכיטקטורה — "רשימת חריגים שרק מצטמצמת".
 * ‎test/architecture-baseline.json‎ הוא רשימת ההפרות שעוד לא תוקנו.
 *   • הפרה חדשה שלא ברשימה → הבדיקה נכשלת. מתקנים את הקוד, לא מוסיפים לרשימה.
 *   • הפרה שתוקנה ועדיין ברשימה → הבדיקה נכשלת, כדי שתוסר ממנה (והרשימה לא תתנפח שוב).
 * לעדכון אחרי תיקון: ‎node tools/arch.js --json > test/architecture-baseline.json‎
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Arch = require('../tools/arch');
const baseline = require('./architecture-baseline.json');

const current = Arch.violations();

test('אין הפרות ארכיטקטורה חדשות', () => {
  const added = current.filter((v) => !baseline.includes(v));
  assert.deepEqual(added, [], `הפרות חדשות:\n${added.join('\n')}`);
});

test('רשימת החריגים מעודכנת — מה שתוקן הוסר ממנה', () => {
  const fixed = baseline.filter((v) => !current.includes(v));
  assert.deepEqual(fixed, [], `תוקנו — להסיר מ-architecture-baseline.json:\n${fixed.join('\n')}`);
});

test('אין תלויות מעגליות', { todo: baseline.some((v) => v.startsWith('cycle:')) }, () => {
  assert.deepEqual(current.filter((v) => v.startsWith('cycle:')), []);
});

/*
 * 🗂 משימון פריוריטי — תוכנה נפרדת בתוך משימון ("אפיון — משימון פריוריטי (דשבורד).md", 11.11.26).
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('משימון פריוריטי: המסך טוען רק את הקבצים שלו (‎/priority/‎) — לא את הקוד של האתר הראשי', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/priority/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
  const foreign = refs.filter((u) => !/^\/priority(\/|$)/.test(u) && !u.startsWith('/icons/'));
  assert.deepEqual(foreign, []);
  for (const f of fs.readdirSync(path.join(ROOT, 'public/priority')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'public/priority', f), 'utf8');
    assert.doesNotMatch(src, /\/js\/(?:api|app|ui)\.js|\bAPI\.\w+\(/, `${f} משתמש בקוד של האתר הראשי`);
  }
});

test('משימון פריוריטי: רק מודול ההגדרות (ובשכבת החיבור — כגיבוי) קורא את משתני הסביבה של פריוריטי', () => {
  const allowed = new Set(['server/priority/priority-settings.js', 'server/integrations/priority.js']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (!allowed.has(rel) && /process\.env\.(?:PRIORITY_|PO_NOTIFY_COMPANIES|PO_FINAL_STATUSES)/.test(fs.readFileSync(p, 'utf8'))) hits.push(rel);
    }
  };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(hits, []);
});

test('משימון פריוריטי: העבודה מהמסך (‎priority-desk.js‎) — אותו מנוע, בלי תלות בוואטסאפ', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/priority/priority-desk.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\.\/whatsapp['"]\)|require\(['"]\.\.\/integrations['"]\)\.Whatsapp/);
  assert.match(src, /require\('\.\/goods-receipt'\)/);
  assert.match(src, /require\('\.\/purchase-demand'\)/);
});
