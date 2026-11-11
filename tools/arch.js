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
 *   6. missing    — require לקובץ שלא קיים.
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

/** קובץ כניסה של תחום (‎<תחום>/index.js‎): ‎get Name() { return require('./x'); }‎ → { Name: קובץ } */
function facadeOf(file, src) {
  if (path.basename(file) !== 'index.js' || path.dirname(file) === SERVER) return null;
  const map = {};
  for (const m of src.matchAll(/get\s+(\w+)\s*\(\)\s*\{\s*return\s+require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
    const target = resolve(file, m[2]);
    if (target) map[m[1]] = target;
  }
  return map;
}

/** אילו שמות נלקחים מה-require: ‎require(x).A‎ או ‎const { A, B } = require(x)‎. ‎null‎ — כל המודול */
function membersAt(src, at, end) {
  const after = /^\s*\.\s*(\w+)/.exec(src.slice(end));
  if (after) return [after[1]];
  const before = /const\s*\{([^}]*)\}\s*=\s*$/.exec(src.slice(Math.max(0, at - 2000), at));
  if (before) return before[1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
  return null;
}

/** ניתוח קובץ: ייבואים (עם סימון אם בראש הקובץ) ופניות רשת */
function analyzeFile(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const lines = src.split('\n');
  const network = [];
  // העומק (סוגריים מסולסלים) בתחילת כל שורה — 0 = רמת הקובץ
  const depthAt = [];
  let depth = 0;
  lines.forEach((line, i) => {
    depthAt[i] = depth;
    if (/(^|[^.\w])fetch\(|\bhttps?\.(request|get)\(/.test(line)) network.push(i + 1);
    for (const ch of line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  });
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => { let lo = 0; let hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };

  const facade = facadeOf(file, src);
  const facadeTargets = new Set(Object.values(facade ?? {}));
  const imports = [];
  const unresolved = [];
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = resolve(file, m[1]);
    if (!target) { unresolved.push({ spec: m[1], line: lineOf(m.index) + 1 }); continue; }
    if (rel(target).startsWith('vendor/')) continue; // ספריות צד שלישי — טעינה עצלה מותרת
    const li = lineOf(m.index);
    const line = lines[li];
    // שורה שנפתחת ב-} (סוף של ‎const { a, b } = require(…)‎ על כמה שורות) — העומק שלה הוא של תחילת ההצהרה
    const lineDepth = /^\s*\}/.test(line) ? Math.max(0, depthAt[li] - 1) : depthAt[li];
    // ‎() => require(…)‎ — טעינה עצלה, גם כשהיא בראש הקובץ
    const lazy = /=>\s*$/.test(src.slice(lineStarts[li], m.index));
    // הגטרים של קובץ כניסה הם ה-require של התחום — לא טעינה עצלה
    const top = facadeTargets.has(target) || (lineDepth === 0 && !lazy);
    imports.push({ target, line: li + 1, top, members: membersAt(src, m.index, m.index + m[0].length) });
  }
  return { imports, network, facade, unresolved };
}

function graph() {
  const files = listFiles();
  const nodes = {};
  for (const f of files) nodes[rel(f)] = analyzeFile(f);
  // ייבוא דרך קובץ כניסה של תחום — הקשת היא לקבצים שבאמת נלקחים ממנו (‎require('../mail').MailScan‎)
  for (const info of Object.values(nodes)) {
    info.edges = [];
    for (const imp of info.imports) {
      const t = rel(imp.target);
      const fac = nodes[t]?.facade;
      if (fac && imp.members) {
        for (const name of imp.members) info.edges.push(fac[name] ? rel(fac[name]) : t);
      } else info.edges.push(t);
    }
    info.edges = [...new Set(info.edges)];
  }
  return nodes;
}

/** רכיבים קשירים חזק (טרג'אן) — כל רכיב בגודל 2 ומעלה הוא מעגל */
function cycles(nodes) {
  let index = 0;
  const idx = {}; const low = {}; const on = new Set(); const stack = []; const out = [];
  const edges = (n) => nodes[n].edges.filter((t) => nodes[t]);
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
    // require לנתיב שלא קיים — ייפול רק כשהשורה תרוץ (קורה אחרי העברת קבצים)
    for (const u of info.unresolved) out.push(`missing: ${file} -> ${u.spec}`);
    if (info.network.length && !NETWORK_LAYERS.some((l) => file.startsWith(l))) out.push(`fetch: ${file}`);
  }
  return [...new Set(out)].sort();
}


/** תלויות בין תחומים (‎{ priority: ['core', 'integrations', …] }‎) — לדוח */
function domainGraph(nodes = graph()) {
  const doms = domains();
  const out = {};
  for (const [file, info] of Object.entries(nodes)) {
    const from = domainOf(file, doms)?.slice(0, -1) ?? '(שורש)';
    for (const t of info.edges) {
      const to = domainOf(t, doms)?.slice(0, -1) ?? '(שורש)';
      if (to !== from) (out[from] ??= new Set()).add(to);
    }
  }
  return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, [...v].sort()]));
}

module.exports = { graph, cycles, violations, domains, analyzeFile, listFiles, rel, SERVER, domainGraph };

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
    if (process.argv.includes('--domains')) {
      console.log('\nתלויות בין תחומים:');
      for (const [k, list] of Object.entries(domainGraph())) console.log(`  ${k} → ${list.join(', ')}`);
    }
  }
}
