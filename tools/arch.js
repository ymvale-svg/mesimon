'use strict';
/**
 * ניתוח ארכיטקטורה של server/ — בלי תלויות. משמש את test/architecture.test.js, ואפשר גם להריץ ישירות:
 *   node tools/arch.js          — דוח
 *   node tools/arch.js --json   — ההפרות כ-JSON (לעדכון test/architecture-baseline.json)
 *
 * הכללים (ראו "תוכנית — בדיקות יחידה וארכיטקטורה.md"):
 *   1. cycle      — אין תלויות מעגליות (גם דרך require שבתוך פונקציה).
 *   2. inline     — require של קוד שלנו רק בראש הקובץ, לא בתוך פונקציה.
 *   3. fetch      — פנייה לרשת (fetch / http.request / https.request) רק בשכבת integrations.
 *   4. boundary   — תחום (תיקייה עם index.js תחת server/) נגיש מבחוץ רק דרך ה-index.js שלו.
 *   5. layer      — core/ ו-integrations/ לא מייבאים תחומים.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const SKIP_DIRS = new Set(['vendor', 'whats-new', 'fonts', 'node_modules']);

/** שכבות שמותר להן לפנות לרשת. קבצים בודדים מחוץ להן — ברשימת החריגים עד שיועברו */
const NETWORK_LAYERS = ['integrations/'];
/** שכבות בסיס שאסור להן לייבא תחומים */
const BASE_LAYERS = ['core/', 'integrations/'];

function listFiles(dir = SERVER, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) listFiles(p, out); }
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(SERVER, p).split(path.sep).join('/');

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** מסיר הערות ומחרוזות-תבנית ארוכות בצורה גסה, כדי שלא יספרו require שבתוך הערה */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** ניתוח קובץ: ייבואים (עם סימון אם בראש הקובץ) ופניות רשת */
function analyzeFile(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const lines = src.split('\n');
  const imports = [];
  const network = [];
  let depth = 0; // עומק סוגריים מסולסלים — 0 = רמת הקובץ
  lines.forEach((line, i) => {
    const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    // שורה שנפתחת ב-} (סוף של ‎const { a, b } = require(…)‎ על כמה שורות) — העומק שלה הוא של תחילת ההצהרה
    const lineDepth = /^\s*\}/.test(line) ? Math.max(0, depth - 1) : depth;
    let m;
    while ((m = re.exec(line))) {
      const target = resolve(file, m[1]);
      if (!target || rel(target).startsWith('vendor/')) continue; // ספריות צד שלישי — טעינה עצלה מותרת
      // ‎() => require(…)‎ — טעינה עצלה, גם כשהיא בראש הקובץ
      const lazy = /=>\s*$/.test(line.slice(0, m.index));
      imports.push({ target, line: i + 1, top: lineDepth === 0 && !lazy });
    }
    if (/(^|[^.\w])fetch\(|\bhttps?\.(request|get)\(/.test(line)) network.push(i + 1);
    for (const ch of line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  });
  return { imports, network };
}

function graph() {
  const files = listFiles();
  const nodes = {};
  for (const f of files) nodes[rel(f)] = analyzeFile(f);
  return nodes;
}

/** רכיבים קשירים חזק (טרג'אן) — כל רכיב בגודל 2 ומעלה הוא מעגל */
function cycles(nodes) {
  let index = 0;
  const idx = {}; const low = {}; const on = new Set(); const stack = []; const out = [];
  const edges = (n) => [...new Set(nodes[n].imports.map((x) => rel(x.target)))].filter((t) => nodes[t]);
  function strong(v) {
    idx[v] = low[v] = index++; stack.push(v); on.add(v);
    for (const w of edges(v)) {
      if (idx[w] === undefined) { strong(w); low[v] = Math.min(low[v], low[w]); }
      else if (on.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  }
  for (const n of Object.keys(nodes).sort()) if (idx[n] === undefined) strong(n);
  return out;
}

/** תחומים: תיקיות ישירות תחת server/ שיש להן index.js */
function domains() {
  return fs.readdirSync(SERVER)
    .filter((d) => !SKIP_DIRS.has(d) && fs.existsSync(path.join(SERVER, d, 'index.js')))
    .map((d) => `${d}/`);
}

const domainOf = (file, list) => list.find((d) => file.startsWith(d)) || null;

/** כל ההפרות, כמחרוזות יציבות (לא תלויות במספרי שורות) */
function violations(nodes = graph()) {
  const out = [];
  for (const comp of cycles(nodes)) out.push(`cycle: ${comp.join(' , ')}`);

  const doms = domains();
  for (const [file, info] of Object.entries(nodes)) {
    const seenInline = new Set();
    for (const imp of info.imports) {
      const t = rel(imp.target);
      if (!imp.top && !seenInline.has(t)) { seenInline.add(t); out.push(`inline: ${file} -> ${t}`); }
      const from = domainOf(file, doms);
      const to = domainOf(t, doms);
      if (to && from !== to && t !== `${to}index.js`) out.push(`boundary: ${file} -> ${t}`);
      if (to && BASE_LAYERS.some((b) => file.startsWith(b)) && !BASE_LAYERS.includes(to)) out.push(`layer: ${file} -> ${t}`);
    }
    if (info.network.length && !NETWORK_LAYERS.some((l) => file.startsWith(l))) out.push(`fetch: ${file}`);
  }
  return [...new Set(out)].sort();
}

module.exports = { graph, cycles, violations, domains, analyzeFile, listFiles, rel, SERVER };

if (require.main === module) {
  const v = violations();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  } else {
    const by = {};
    for (const x of v) (by[x.split(':')[0]] ??= []).push(x);
    for (const [k, list] of Object.entries(by)) {
      console.log(`\n${k} (${list.length})`);
      for (const x of list) console.log(`  ${x.slice(k.length + 2)}`);
    }
    console.log(`\nסה"כ ${v.length} הפרות`);
  }
}
