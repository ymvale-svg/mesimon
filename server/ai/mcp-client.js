'use strict';
/**
 * לקוח MCP מינימלי — בלי תלויות, בלי ה-SDK.
 *
 * כל שרת מוגדר ב-‎server/agents-mcp.json‎ (פקודה + ארגומנטים) ומופעל כתהליך בן
 * רק בשימוש הראשון. התקשורת: JSON-RPC 2.0 על stdin/stdout, הודעה בכל שורה.
 *
 *   listTools(key)                  → [{name, description, inputSchema}] (נשמר במטמון)
 *   callTool(key, tool, args, opts) → {text, isError}
 *   anthropicTools(keys)            → הגדרות כלים ל-Messages API ‏(‎<key>__<tool>‎)
 *   callNamespaced(name, args)      → קריאה לפי השם המלא שה-AI החזיר
 *   status()                        → מצב כל שרת
 *   shutdown()                      → סוגר את כל התהליכים
 *
 * בטיחות: התהליך מקבל סביבה מצומצמת (PATH, HOME, LANG, מטמונים, פרוקסי ותעודות
 * CA) — שום מפתח API או סוד של השרת לא עובר אליו. אין shell.
 *
 * עמידות: תהליך שנפל מסומן מת ומופעל מחדש בשימוש הבא, עם השהיה הולכת וגדלה
 * ולכל היותר 3 הפעלות מחדש ב-10 דקות. אחרי 10 דקות בלי קריאות התהליך נסגר.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'agents-mcp.json');
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mesimon', version: '1.0' };
// עשר דקות בלי שימוש — ואז נסגר. הפעלה מחדש עולה כשתיים-שלוש שניות לשאלה הבאה.
// כל שרת הוא תהליך נפרד (npx + node, או uv + python) של עשרות MB, וכולם נספרים
// במגבלת הזיכרון של השרת בענן — לכן גם קצר, וגם תקרה על כמה רצים יחד.
const IDLE_MS = 10 * 60 * 1000;
const MAX_LIVE = Math.max(1, Number(process.env.MCP_MAX_LIVE) || 2);
// תקרת זיכרון לתהליך Node של שרת נתונים — כלי קטן, לא צריך יותר
const CHILD_NODE_OPTIONS = '--max-old-space-size=128';
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;
const MAX_TEXT = 20000;
const STDERR_RING = 40;            // שורות stderr שנשמרות לאבחון
const MAX_LINE = 16 * 1024 * 1024; // שורה ארוכה מזה בלי ‎\n‎ — כנראה זבל

// ---------- הגדרות ----------

let config = null;
function servers() {
  if (!config) config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).servers ?? {};
  return config;
}
function cfgOf(key) {
  const c = servers()[key];
  if (!c) throw new Error(`MCP: unknown server "${key}"`);
  return c;
}

// ---------- סביבה מצומצמת ----------

const ENV_EXACT = new Set([
  'PATH', 'Path', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  // מטמונים
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR',
  'UV_TOOL_DIR', 'UV_NATIVE_TLS', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'PIP_CACHE_DIR',
  // רשת: פרוקסי ותעודות CA (בלעדיהם npx/uv לא יגיעו לרשת מאחורי פרוקסי ארגוני)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile',
  'npm_config_registry', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'NODE_USE_ENV_PROXY',
  // Windows — בלעדיהם node/npm/python לא עולים
  'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_EXACT.has(k) && v != null) env[k] = v;
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.NO_COLOR = '1';
  env.NODE_OPTIONS = CHILD_NODE_OPTIONS;
  return env;
}

/**
 * חבילה שכבר הותקנה במטמון של npx — מריצים את הקובץ שלה ישירות ב-node.
 * ‎npx‎ משאיר תהליך ‎npm exec‎ פתוח כאבא של השרת כל זמן שהוא רץ, וזה כ-100MB
 * בזיכרון לכל מקור נתונים בלי שום תועלת. בפעם הראשונה (החבילה עוד לא במטמון)
 * — דרך npx כרגיל, והוא מתקין; מהפעם הבאה ישירות.
 */
function npxDirect(args) {
  const spec = args.find((a) => !a.startsWith('-'));
  if (!spec) return null;
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : null;
  const rest = args.slice(args.indexOf(spec) + 1);
  const cacheDir = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || path.join(require('os').homedir(), '.npm');
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(cacheDir, '_npx')); } catch { return null; }
  for (const d of dirs) {
    const pkgDir = path.join(cacheDir, '_npx', d, 'node_modules', name);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { continue; }
    if (version && pkg.version !== version) continue;
    const bin = typeof pkg.bin === 'string' ? pkg.bin
      : pkg.bin?.[name.split('/').pop()] ?? Object.values(pkg.bin ?? {})[0];
    if (!bin) continue;
    const file = path.join(pkgDir, bin);
    if (fs.existsSync(file)) return { command: process.execPath, args: [file, ...rest] };
  }
  return null;
}

/** ב-Windows ‏npx הוא ‎npx.cmd‎, ו-Node 22 לא מריץ ‎.cmd‎ בלי shell — מריצים את npx-cli.js ישירות. */
function resolveCommand(command, args) {
  if (command === 'npx') {
    const direct = npxDirect(args);
    if (direct) return direct;
  }
  if (process.platform === 'win32' && (command === 'npx' || command === 'npm')) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);
    if (fs.existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
  }
  return { command, args };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- חיבור לשרת אחד ----------

class Conn {
  constructor(key) {
    this.key = key;
    this.child = null;
    this.alive = false;
    this.ready = null;        // Promise של לחיצת היד
    this.initialized = false;
    this.pending = new Map(); // id → {resolve, reject, timer, method}
    this.nextId = 1;
    this.buf = '';
    this.stderr = [];
    this.stderrPartial = '';
    this.lastError = null;
    this.serverInfo = null;
    this.crashed = false;     // הפעם האחרונה הסתיימה שלא בכוונה
    this.restarts = [];       // זמני הפעלה מחדש אחרי נפילה
    this.idleTimer = null;
    this.stopping = false;
    this.starting = null;
    this.booting = false;     // תופס מקום בתקרה: עולה, או ממתין להפעלה מחדש אחרי נפילה
    this.users = 0;           // קריאות שמשתמשות בשרת עכשיו (מ-ensure ועד התשובה) — לא "פנוי" לסגירה
  }

  ensure() {
    this.usedAt = Date.now();
    if (this.alive && this.ready) return this.ready;
    if (!this.starting) {
      // קודם מקום פנוי בתקרה (‎MAX_LIVE‎), ורק אז הפעלה — כמה סוכנים במקביל לא
      // יפעילו יחד יותר שרתים ממה שהזיכרון והמעבד של השרת בענן מחזיקים
      this.starting = acquireSlot(this)
        .then(() => this.boot())
        // ההתעוררות בסבב הבא: קודם מי שחיכה לשרת הזה שולח את הקריאה שלו, כדי שלא ייסגר כ"פנוי"
        .finally(() => { this.starting = null; this.booting = false; setImmediate(wakeSlots); });
    }
    return this.starting;
  }

  async boot() {
    if (this.crashed) {
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_RESTARTS) {
        throw new Error(`MCP ${this.key}: too many restarts (${MAX_RESTARTS} in 10 min); last error: ${this.lastError ?? 'unknown'}`);
      }
      const delay = Math.min(1000 * 2 ** this.restarts.length, 8000);
      this.restarts.push(now);
      await sleep(delay);
    }
    this.ready = this.start();
    return this.ready;
  }

  start() {
    const cfg = cfgOf(this.key);
    const { command, args } = resolveCommand(cfg.command, cfg.args ?? []);
    this.buf = '';
    this.stderrPartial = '';
    this.initialized = false;
    this.stopping = false;
    let child;
    try {
      child = spawn(command, args, {
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32', // קבוצת תהליכים משלו — כדי לסגור גם את הנכדים (npx → node)
      });
    } catch (e) {
      this.crashed = true;
      this.lastError = `spawn failed: ${e.message}`;
      return Promise.reject(new Error(`MCP ${this.key}: ${this.lastError}`));
    }
    this.child = child;
    this.alive = true;
    trackChild(child);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.onStdout(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.onStderr(d));
    child.stdin.on('error', () => {}); // EPIPE אחרי שהתהליך מת — מטופל ב-exit
    child.on('error', (e) => this.onExit(child, null, null, e));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));

    const timeoutMs = cfg.startupTimeoutMs ?? 60000;
    return this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs).then((res) => {
      this.serverInfo = res?.serverInfo ?? null;
      this.notify('notifications/initialized');
      this.initialized = true;
      this.lastError = null;
      this.crashed = false;
      this.touch();
    }).catch((e) => {
      this.kill(true);
      this.lastError = e.message;
      throw e;
    });
  }

  onStdout(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) this.buf = '';
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.pushStderr(`[stdout] ${line}`); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.method) {
      if (msg.id === undefined || msg.id === null) return; // הודעת notification — מתעלמים
      if (msg.method === 'ping') this.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (!this.pending.size) setImmediate(wakeSlots); // אחרי שהתשובה עברה למי שחיכה לה
    if (msg.error) {
      const e = new Error(`MCP ${this.key} ${p.method}: ${msg.error.message ?? 'error'} (${msg.error.code ?? '?'})`);
      e.rpcError = msg.error;
      p.reject(e);
    } else p.resolve(msg.result);
  }

  onStderr(d) {
    const parts = (this.stderrPartial + d).split(/\r?\n/);
    this.stderrPartial = parts.pop() ?? '';
    if (this.stderrPartial.length > 4000) { parts.push(this.stderrPartial); this.stderrPartial = ''; }
    for (const l of parts) if (l.trim()) this.pushStderr(l);
  }

  pushStderr(l) {
    this.stderr.push(l.length > 500 ? l.slice(0, 500) + '…' : l);
    if (this.stderr.length > STDERR_RING) this.stderr.shift();
  }

  stderrTail(n = 5) { return this.stderr.slice(-n).join(' | '); }

  onExit(child, code, signal, err) {
    if (child !== this.child || !this.alive) return;
    this.alive = false;
    this.initialized = false;
    this.ready = null;
    clearTimeout(this.idleTimer);
    const why = err ? `spawn error: ${err.message}` : `exited (code ${code}${signal ? `, signal ${signal}` : ''})`;
    if (!this.stopping) {
      this.crashed = true;
      const tail = this.stderrTail();
      this.lastError = tail ? `${why}; stderr: ${tail}` : why;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      const tail = this.stopping ? '' : this.stderrTail(3);
      p.reject(new Error(`MCP ${this.key}: server ${why}${tail ? ` — ${tail}` : ''}`));
    }
    this.pending.clear();
    wakeSlots();
  }

  send(msg) {
    if (!this.alive || !this.child) return false;
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error(`MCP ${this.key}: server not running`)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (!this.pending.size) setImmediate(wakeSlots);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        const tail = method === 'initialize' ? ` — stderr: ${this.stderrTail(3)}` : '';
        reject(new Error(`MCP ${this.key} ${method}: timed out after ${timeoutMs}ms${tail}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size) { this.touch(); return; }
      this.kill();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** סגירה מכוונת (לא נחשבת נפילה, אלא אם ‎asFailure‎). */
  kill(asFailure = false) {
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child || !this.alive) return;
    if (!asFailure) this.stopping = true;
    else this.crashed = true;
    try { child.stdin.end(); } catch {}
    killTree(child, 'SIGTERM');
    const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL'); }, 2000);
    t.unref?.();
    // מסמנים מיד כמת — הקריאה הבאה תפעיל תהליך חדש
    this.onExit(child, null, 'SIGTERM');
  }
}

const live = new Set();
function trackChild(child) {
  live.add(child);
  child.on('exit', () => live.delete(child));
}
function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}
process.once('exit', () => { for (const c of live) killTree(c, 'SIGKILL'); });

const conns = new Map();

/*
 * התקרה על שרתים שרצים יחד — תור אמיתי, לא רק ניקוי.
 *
 * לפני הפעלת שרת: אם כבר רצים ‎MAX_LIVE‎ — נסגר זה שלא היה בשימוש הכי הרבה
 * זמן ואינו באמצע קריאה. כולם עסוקים (כמה סוכנים עובדים במקביל) — ממתינים
 * בתור עד שאחד מסיים, ולא מפעילים עוד תהליך מעל התקרה. כך שאלה עם שלושה
 * סוכנים לא מפעילה שישה שרתים בבת אחת על שרת עם מעבד אחד ו-2GB.
 */
const SLOT_WAIT_MS = 90 * 1000;
const slotQueue = []; // ‎{c, wake}‎ לפי סדר הגעה

const holdsSlot = (c) => c.alive || c.booting;

/** מריץ פעולה על שרת כשהוא מסומן "בשימוש" — כך התור לא סוגר אותו באמצע */
async function using(c, fn) {
  c.users++;
  try { return await fn(); } finally { c.users--; if (!c.users) setImmediate(wakeSlots); }
}

function freeSlotFor(c) {
  const running = [...conns.values()].filter((x) => x !== c && holdsSlot(x));
  if (running.length < MAX_LIVE) return true;
  const idle = running.filter((x) => x.alive && !x.pending.size && !x.users && !x.booting).sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
  if (!idle.length) return false;
  idle[0].kill(); // מסמן מת מיד — המקום מתפנה עכשיו
  return true;
}

function acquireSlot(c) {
  // אין תור — בודקים מיד. יש תור — נכנסים לסופו, כדי שלא לעקוף מי שמחכה
  if (!slotQueue.length && freeSlotFor(c)) { c.booting = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { c, wake: null };
    const timer = setTimeout(() => {
      const i = slotQueue.indexOf(entry);
      if (i >= 0) slotQueue.splice(i, 1);
      reject(new Error(`MCP ${c.key}: busy — ${MAX_LIVE} data sources already running, waited ${SLOT_WAIT_MS / 1000}s`));
      wakeSlots();
    }, SLOT_WAIT_MS);
    entry.wake = () => { clearTimeout(timer); resolve(); };
    slotQueue.push(entry);
    wakeSlots();
  });
}

/** מקום התפנה (שרת נסגר, סיים קריאה, או סיים לעלות) — מכניסים מהתור לפי הסדר */
let waking = false;
function wakeSlots() {
  // סגירת שרת פנוי בתוך הלולאה קוראת שוב לפונקציה (‎onExit‎) — בלי השמירה הזו
  // הקריאה הפנימית הייתה מכניסה מהתור, והחיצונית מכניסה עוד אחד מעל התקרה
  if (waking) return;
  waking = true;
  try {
    // המקום נתפס מיד (‎booting‎), לפני שהבא בתור נבדק — כך לא נכנסים שניים למקום אחד
    while (slotQueue.length && freeSlotFor(slotQueue[0].c)) { const e = slotQueue.shift(); e.c.booting = true; e.wake(); }
  } finally {
    waking = false;
  }
}

function conn(key) {
  cfgOf(key);
  let c = conns.get(key);
  if (!c) { c = new Conn(key); conns.set(key, c); }
  return c;
}

// ---------- API ----------

const toolsCache = new Map(); // key → [{name, description, inputSchema}]
const toolsInflight = new Map();

/** רשימת הכלים של שרת (נשמרת במטמון אחרי ההצלחה הראשונה). */
async function listTools(serverKey) {
  if (toolsCache.has(serverKey)) return toolsCache.get(serverKey);
  if (toolsInflight.has(serverKey)) return toolsInflight.get(serverKey);
  const c = conn(serverKey);
  const p = using(c, async () => {
    await c.ensure();
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const res = await c.request('tools/list', cursor ? { cursor } : {}, cfgOf(serverKey).startupTimeoutMs ?? 60000);
      for (const t of res?.tools ?? []) {
        if (!t?.name) continue;
        tools.push({
          name: t.name,
          description: t.description ?? t.title ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        });
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    c.touch();
    toolsCache.set(serverKey, tools);
    return tools;
  });
  toolsInflight.set(serverKey, p);
  try { return await p; } finally { toolsInflight.delete(serverKey); }
}

function contentToText(result) {
  const parts = [];
  for (const item of result?.content ?? []) {
    if (!item) continue;
    if (item.type === 'text') parts.push(item.text ?? '');
    else if (item.type === 'resource' && item.resource?.text != null) parts.push(item.resource.text);
    else if (item.type === 'resource_link') parts.push(`[resource: ${item.uri ?? item.name ?? ''}]`);
    else parts.push(`[${item.type ?? 'content'}]`);
  }
  let text = parts.join('\n');
  if (!text.trim() && result?.structuredContent != null) text = JSON.stringify(result.structuredContent);
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT) + `\n…[truncated: ${text.length - MAX_TEXT} more characters]`;
  }
  return text;
}

/** קריאה לכלי. ‎text‎ — כל תוכן הטקסט של התשובה, מקוצר ל-~20,000 תווים. */
async function callTool(serverKey, toolName, args, { timeoutMs = 30000 } = {}) {
  const c = conn(serverKey);
  return using(c, async () => {
    await c.ensure();
    c.touch();
    try {
      const res = await c.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs);
      return { text: contentToText(res), isError: !!res?.isError };
    } finally {
      if (c.alive) c.touch();
    }
  });
}

// שמות כלים ל-Anthropic: ‎^[a-zA-Z0-9_-]{1,64}$‎
const nameMap = new Map(); // שם ל-Anthropic → {serverKey, tool}
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

function namespacedName(serverKey, tool) {
  for (const [n, v] of nameMap) if (v.serverKey === serverKey && v.tool === tool) return n;
  let base = `${sanitize(serverKey)}__${sanitize(tool)}`.slice(0, 64);
  let name = base;
  for (let i = 2; nameMap.has(name); i++) {
    const suffix = `_${i}`;
    name = base.slice(0, 64 - suffix.length) + suffix;
  }
  nameMap.set(name, { serverKey, tool });
  return name;
}

const failLogged = new Set();

/** הגדרות כלים ל-Messages API לשרתים המבוקשים. שרת שלא עולה — מדלגים (נרשם ביומן פעם אחת). */
async function anthropicTools(serverKeys) {
  const results = await Promise.all((serverKeys ?? []).map(async (key) => {
    try {
      const tools = await listTools(key);
      failLogged.delete(key);
      return tools.map((t) => {
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : {};
        if (schema.type !== 'object') { schema.type = 'object'; }
        if (!schema.properties) schema.properties = {};
        return {
          name: namespacedName(key, t.name),
          description: (t.description || t.name).slice(0, 4000),
          input_schema: schema,
        };
      });
    } catch (e) {
      if (!failLogged.has(key)) {
        failLogged.add(key);
        console.warn(`[mcp] ${key} unavailable: ${e.message}`);
      }
      return [];
    }
  }));
  return results.flat();
}

/** קריאה לכלי לפי השם המלא (‎<serverKey>__<tool>‎). */
async function callNamespaced(name, args, opts) {
  let target = nameMap.get(name);
  if (!target) {
    const i = String(name).indexOf('__');
    if (i > 0) {
      const serverKey = name.slice(0, i);
      if (servers()[serverKey]) target = { serverKey, tool: name.slice(i + 2) };
    }
  }
  if (!target) throw new Error(`MCP: unknown tool "${name}"`);
  return callTool(target.serverKey, target.tool, args, opts);
}

/** מצב כל השרתים המוגדרים. */
function status() {
  const out = {};
  for (const [key, cfg] of Object.entries(servers())) {
    const c = conns.get(key);
    const now = Date.now();
    out[key] = {
      label: cfg.label,
      started: !!(c && c.alive && c.initialized),
      pid: c?.alive ? c.child?.pid ?? null : null,
      lastError: c?.lastError ?? null,
      toolCount: toolsCache.has(key) ? toolsCache.get(key).length : null,
      restartsInWindow: c ? c.restarts.filter((t) => now - t < RESTART_WINDOW_MS).length : 0,
      inflight: c?.pending.size ?? 0,
      queued: slotQueue.some((q) => q.c === c),
      serverInfo: c?.serverInfo ?? null,
      stderrTail: c ? c.stderr.slice(-5) : [],
    };
  }
  return out;
}

/** סוגר את כל תהליכי השרתים. */
function shutdown() {
  for (const c of conns.values()) c.kill();
}

module.exports = { listTools, callTool, anthropicTools, callNamespaced, status, shutdown };
