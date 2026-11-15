'use strict';
/**
 * 🗂 קטלוג ההגדרות (‎server/core/settings-catalog.js‎) — כל הגדרה במקום אחד, וכל דבר במקום הנכון
 * (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 5).
 *
 * מפתח חדש בטבלת ההגדרות שאינו בקטלוג — הבדיקה נכשלת, עם הסבר מה לעשות:
 *   הגדרת מערכת ← ‎FORM‎ (לשונית, שם והסבר) / ‎SCREEN‎ / ‎HIDDEN‎ (עם סיבה) · מצב פנימי ← ‎INTERNAL‎ ·
 *   נתון של עובד ← ‎user_prefs‎ (ב-‎PERSONAL‎), לא בטבלת ההגדרות.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../../server/core/settings-catalog');
const D = require('../../../server/core/db');

const ROOT = path.resolve(__dirname, '../../..');
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'node_modules'].includes(e.name)) files(p, out); } else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const SERVER = files(path.join(ROOT, 'server')).filter((f) => !f.endsWith(path.join('core', 'db.js')));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const CALL = /\b(?:getSetting|setSetting)\(\s*/g;

/** כל הקריאות לטבלת ההגדרות: ‎{ file, kind: 'literal'|'template'|'computed', key }‎ */
function calls() {
  const out = [];
  for (const f of SERVER) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const lit = /^(['"])([^'"]+)\1/.exec(rest);
      const tpl = /^`([^`$]*)(\$\{)?/.exec(rest);
      if (lit) { out.push({ file: rel(f), kind: 'literal', key: lit[2] }); continue; }
      if (tpl) { out.push({ file: rel(f), kind: tpl[2] ? 'template' : 'literal', key: tpl[1] }); continue; }
      // שם של קבוע באותו קובץ: ‎const KEY = 'x'‎ / ‎const key = (id) => `x:${id}`‎ — כמו מחרוזת
      const name = /^([A-Za-z_$][\w$]*)\s*(\()?/.exec(rest);
      const def = name && new RegExp(`^const ${name[1]}\\s*=\\s*(?:\\([^)]*\\)\\s*=>\\s*)?(['"\`])([^'"\`$]*)(\\$\\{)?`, 'm').exec(src);
      if (def) out.push({ file: rel(f), kind: def[3] ? 'template' : 'literal', key: def[2] });
      else out.push({ file: rel(f), kind: 'computed', key: rest.split(/[,)]/)[0] });
    }
  }
  return out;
}

test('כל מפתח קבוע בקוד מוכר בקטלוג (הגדרת מערכת / מצב פנימי)', () => {
  const unknown = calls().filter((c) => c.kind === 'literal' && !C.kindOf(c.key)).map((c) => `${c.key} (${c.file})`);
  assert.deepEqual([...new Set(unknown)], [],
    'מפתח חדש בטבלת ההגדרות — להוסיף ל-server/core/settings-catalog.js: FORM / SCREEN / HIDDEN (הגדרה) או INTERNAL (מצב פנימי). נתון של עובד — ב-user_prefs');
});

test('מפתח מחושב (`…${x}`) — רק תחילית מוכרת; תחילית לעובד — רק מהרשימה הישנה, שלא גדלה', () => {
  const bad = calls().filter((c) => c.kind === 'template' && !C.kindOf(`${c.key}x`)).map((c) => `${c.key}… (${c.file})`);
  assert.deepEqual([...new Set(bad)], [], 'נתון של עובד — ב-user_prefs, לא בטבלת ההגדרות של המערכת');
});

test('מפתח במשתנה — רק בקבצים הידועים (רשימה שרק מצטמצמת)', () => {
  const computed = [...new Set(calls().filter((c) => c.kind === 'computed').map((c) => c.file))].sort();
  const extra = computed.filter((f) => !C.COMPUTED_KEY_FILES.includes(f));
  assert.deepEqual(extra, [], 'מפתח חדש — מחרוזת קבועה שמופיעה בקטלוג');
  const fixed = C.COMPUTED_KEY_FILES.filter((f) => !computed.includes(f));
  assert.deepEqual(fixed, [], 'הקובץ כבר לא משתמש במפתח מחושב — להסיר מ-COMPUTED_KEY_FILES');
});

test('כל ברירת מחדל (‎DEFAULT_SETTINGS‎) היא הגדרת מערכת בקטלוג', () => {
  const missing = Object.keys(D.DEFAULT_SETTINGS).filter((k) => C.kindOf(k) !== 'system');
  assert.deepEqual(missing, []);
});

test('כל שדה בטופס — עם לשונית קיימת, שם, וברירת מחדל (אחרת אי אפשר לשמור אותו)', () => {
  const tabs = new Set(C.TABS.map((t) => t.key));
  for (const [key, f] of Object.entries(C.FORM)) {
    assert.ok(tabs.has(f.tab), `${key}: לשונית ${f.tab}`);
    assert.ok(f.label, `${key}: בלי שם`);
    assert.ok(key in D.DEFAULT_SETTINGS, `${key}: אין ב-DEFAULT_SETTINGS — השמירה מהמסך תדלג עליו`);
  }
});

test('כל השעות במקום אחד — לשונית "שעות וימים"', () => {
  const hours = Object.entries(C.FORM).filter(([k]) => /_hours$|_time$|_window$|^digest_(morning|evening)$|^bot_tip_/.test(k) && !/_minutes|alert_hours_before|escalation_hours|refresh_hours/.test(k));
  const elsewhere = hours.filter(([, f]) => f.tab !== 'hours').map(([k]) => k);
  assert.deepEqual(elsewhere, []);
});

test('הגדרה אישית שנשמרת מהמסך (‎/api/prefs‎) מוכרת בקטלוג האישי', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/api/api.js'), 'utf8');
  const block = /const PREF_KEYS = \[([\s\S]*?)\];/.exec(src)[1].replace(/\/\/.*$/gm, '');
  const keys = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys.filter((k) => !(k in C.PERSONAL)), []);
  const tabs = new Set(C.PERSONAL_TABS.map((t) => t.key));
  for (const [k, p] of Object.entries(C.PERSONAL)) if (p.ui !== false) assert.ok(tabs.has(p.tab), `${k}: לשונית ${p.tab}`);
});
