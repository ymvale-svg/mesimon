'use strict';
/**
 * השרת האמיתי (‎node server/index.js‎) כתהליך-בן, לבדיקות API מקצה לקצה.
 *
 *   const srv = await Server.start();      // תיקיית נתונים חדשה, פורט פנוי, מנהל ראשון מ-ADMIN_*
 *   const r = await srv.api('POST', '/api/auth/login', { body: {...} });
 *   await srv.stop();                       // ב-after() — התהליך נסגר ותיקיית הנתונים נמחקת
 *
 * הסביבה עוברת בירושה מתהליך הבדיקה (שכבר נוקה ב-test/setup.js ממפתחות לשירותים חיצוניים),
 * ובנוסף התהליך נטען עם ‎child-guard.js‎ — חסימת רשת זהה לזו של setup.js, כדי ששום עבודת רקע
 * של השרת לא תפנה החוצה.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN = { email: 'admin@test.local', password: 'Admin-Pass-123!', name: 'מנהלת בדיקות' };

/** פורט פנוי: מאזינים על 0, לוקחים את מה שהמערכת נתנה ומשחררים */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** עוגיית הסשן מתוך ‎set-cookie‎ — "שם=ערך" בלבד, מוכן לכותרת ‎cookie‎ */
function sessionCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const m = /mesimon_sid=([^;]*)/.exec(raw);
  return m ? `mesimon_sid=${m[1]}` : null;
}

async function start({ env = {}, timeoutMs = 20000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimon-api-'));
  const port = await freePort();
  const childEnv = {
    ...process.env,
    DATA_DIR: path.join(tmp, 'data'),
    UPLOADS_DIR: path.join(tmp, 'uploads'),
    PORT: String(port),
    HOST: '127.0.0.1',
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_NAME: ADMIN.name,
    ...env
  };
  // ‎--test‎ ודגלים של רץ הבדיקות לא עוברים לבן
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;

  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'child-guard.js'), 'server/index.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const collect = (chunk) => { output += chunk.toString('utf8'); if (output.length > 200000) output = output.slice(-100000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  // רשת ביטחון: גם אם after() לא רץ, הבן לא נשאר בחיים אחרי תהליך הבדיקה
  const killOnExit = () => { try { child.kill('SIGKILL'); } catch { /* כבר נסגר */ } };
  process.on('exit', killOnExit);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`השרת נסגר בעלייה (${JSON.stringify(exited)}):\n${output}`);
    try {
      const r = await fetch(`${base}/api/branding`);
      if (r.status === 200) { await r.arrayBuffer(); break; }
    } catch { /* עוד לא מאזין */ }
    if (Date.now() > deadline) {
      killOnExit();
      throw new Error(`השרת לא עלה תוך ${timeoutMs}ms:\n${output}`);
    }
    await sleep(100);
  }

  /**
   * קריאה ל-API. ‎body‎ — אובייקט (נשלח כ-JSON) או מחרוזת (נשלחת כמו שהיא).
   * מחזיר ‎{ status, json, text, headers, cookie }‎.
   */
  async function api(method, urlPath, { body, cookie, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['content-type'] = h['content-type'] ?? 'application/json';
    }
    const res = await fetch(base + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* לא JSON */ }
    return { status: res.status, json, text, headers: res.headers, cookie: sessionCookie(res) };
  }

  /** בקשה גולמית — הנתיב נשלח כמו שהוא, בלי הנרמול של fetch (‎..‎ וכו') */
  function raw(method, rawPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** התחברות; מחזיר את העוגייה */
  async function login(email, password) {
    const r = await api('POST', '/api/auth/login', { body: { email, password } });
    if (r.status !== 200) throw new Error(`התחברות נכשלה (${r.status}): ${r.text}`);
    return r.cookie;
  }

  async function stop() {
    process.off('exit', killOnExit);
    if (!exited) {
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* נסגר */ } }, 3000);
      await done;
      clearTimeout(t);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { base, port, child, api, raw, login, stop, output: () => output, exited: () => exited };
}

module.exports = { start, ADMIN, freePort };
