'use strict';
/**
 * העברת קבצי קוד בין תיקיות, עם תיקון כל ה-require שמצביעים עליהם ושל ה-require שבתוכם.
 *   node tools/move.js server/priority.js server/integrations/priority.js [עוד זוגות…]
 * סורק את server/, test/ ו-tools/. ‎git mv‎ — ההיסטוריה נשמרת.
 * מדפיס אזהרה לכל ‎__dirname‎ / ‎__filename‎ בקובץ שהועבר: נתיבים לקבצי נתונים צריך לבדוק ידנית.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCAN = ['server', 'test', 'tools'].map((d) => path.join(ROOT, d));
const SKIP = new Set(['vendor', 'node_modules', 'fonts', 'whats-new']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) { if (!SKIP.has(n)) walk(p, out); }
    else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}

function resolveFrom(file, spec) {
  const base = path.resolve(path.dirname(file), spec);
  for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function specFor(fromFile, target, keepExt) {
  let r = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
  if (!keepExt) r = r.replace(/\.js$/, '');
  if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
  return r.startsWith('.') ? r : `./${r}`;
}

const REQ = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

function move(pairs) {
  const moves = new Map(pairs.map(([a, b]) => [path.resolve(ROOT, a), path.resolve(ROOT, b)]));
  const files = [...new Set(SCAN.flatMap((d) => walk(d)))];
  // שלב 1: לכל קובץ — אילו require מצביעים על מה (לפני ההעברה)
  const plan = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = [];
    for (const m of src.matchAll(REQ)) {
      const target = resolveFrom(f, m[2]);
      if (target) hits.push({ full: m[0], quote: m[1], spec: m[2], target });
    }
    plan.set(f, { src, hits });
  }
  // שלב 2: העברה
  for (const [from, to] of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    execFileSync('git', ['mv', from, to], { cwd: ROOT });
  }
  // שלב 3: כתיבה מחדש
  let changed = 0;
  for (const [f, { src, hits }] of plan) {
    const newFile = moves.get(f) ?? f;
    let out = src;
    for (const h of hits) {
      const newTarget = moves.get(h.target) ?? h.target;
      if (newFile === f && newTarget === h.target) continue;
      const spec = specFor(newFile, newTarget, h.spec.endsWith('.js'));
      if (spec !== h.spec) out = out.split(h.full).join(`require(${h.quote}${spec}${h.quote})`);
    }
    if (out !== src) { fs.writeFileSync(newFile, out); changed++; }
    if (moves.has(f) && /__dirname|__filename/.test(src)) {
      const lines = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /__dirname|__filename/.test(l));
      console.warn(`⚠ ${path.relative(ROOT, newFile)} — נתיבים יחסיים לבדיקה:`);
      for (const [n, l] of lines) console.warn(`   ${n}: ${l.trim().slice(0, 140)}`);
    }
  }
  console.log(`הועברו ${moves.size} קבצים, עודכנו ${changed} קבצים`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length || args.length % 2) {
    console.error('שימוש: node tools/move.js <מ> <אל> [<מ> <אל> …]');
    process.exit(1);
  }
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  move(pairs);
}

module.exports = { move };
