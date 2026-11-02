'use strict';
/**
 * ניטור עומס: התראה למנהלי המערכת כשתקרת המעבד מאטה את הסוכנים.
 *
 * כל 30 שניות נמדדים:
 *   • המעבד של כל השרת (כולל שרתי הנתונים של הסוכנים, שהם תהליכים נפרדים) —
 *     מתוך ה-cgroup של הקונטיינר: כמה מהתקרה נוצלה, ובכמה מהזמן התהליכים
 *     נחסמו כי הגיעו לתקרה (throttling). זה המדד הישיר ל"התקרה עוצרת אותנו".
 *   • השהיית לולאת האירועים של Node — כשהיא גבוהה, כל בקשה מחכה בתור.
 *   • כמה שאלות לסוכנים רצות עכשיו במקביל, וכמה זמן לקחה כל אחת.
 *
 * התראה נשלחת רק כשיש גם עומס וגם שאלות לסוכנים באותו חלון של 5 דקות —
 * עומס של סריקת לילה בלי אף שואל אינו מפריע לאיש. אחרי התראה — שקט לשעה
 * (ההגדרה ‎load_alert_cooldown_min‎), כדי לא להציף.
 *
 * מחוץ לקונטיינר (מחשב מקומי) אין cgroup — נמדדת רק לולאת האירועים.
 */
const fs = require('node:fs');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const D = require('./db');

const SAMPLE_MS = 30 * 1000;
const WINDOW = 10;                 // 10 דגימות = 5 דקות
const THROTTLED_SHARE = 0.25;      // רבע מהזמן חסום בתקרה
const CPU_SHARE = 0.9;             // 90% מהתקרה, בממוצע על החלון
const LOOP_LAG_MS = 1000;          // השהיה של שנייה ומעלה ב-p99
const SLOW_QUESTION_MS = 60 * 1000;

// ---------- מדידת המעבד (cgroup v2, ואם אין — v1) ----------

const readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const statOf = (text) => Object.fromEntries(String(text ?? '').trim().split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2).map(([k, v]) => [k, Number(v)]));

function readCpu() {
  // v2
  const v2 = readFile('/sys/fs/cgroup/cpu.stat');
  if (v2) {
    const s = statOf(v2);
    const [quota, period] = String(readFile('/sys/fs/cgroup/cpu.max') ?? 'max').trim().split(/\s+/);
    return {
      usageUs: s.usage_usec ?? null,
      periods: s.nr_periods ?? 0,
      throttled: s.nr_throttled ?? 0,
      cpus: quota && quota !== 'max' ? Number(quota) / Number(period || 100000) : null
    };
  }
  // v1
  const v1 = readFile('/sys/fs/cgroup/cpu/cpu.stat') ?? readFile('/sys/fs/cgroup/cpu,cpuacct/cpu.stat');
  if (v1) {
    const s = statOf(v1);
    const base = fs.existsSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') ? '/sys/fs/cgroup/cpu' : '/sys/fs/cgroup/cpu,cpuacct';
    const quota = Number(readFile(`${base}/cpu.cfs_quota_us`));
    const period = Number(readFile(`${base}/cpu.cfs_period_us`)) || 100000;
    const usageNs = Number(readFile('/sys/fs/cgroup/cpuacct/cpuacct.usage') ?? readFile(`${base}/cpuacct.usage`));
    return {
      usageUs: Number.isFinite(usageNs) && usageNs > 0 ? usageNs / 1000 : null,
      periods: s.nr_periods ?? 0,
      throttled: s.nr_throttled ?? 0,
      cpus: quota > 0 ? quota / period : null
    };
  }
  return null;
}

// ---------- שאלות לסוכנים ----------

let inflight = 0;
let peakInflight = 0;
let questions = 0;      // שאלות שהתחילו בדגימה הנוכחית
let slowest = 0;        // השאלה הארוכה ביותר שהסתיימה בדגימה הנוכחית (ms)

/** בתחילת שאלה לסוכן. מחזיר פונקציה לקריאה בסופה. */
function begin() {
  inflight++;
  questions++;
  peakInflight = Math.max(peakInflight, inflight);
  const started = Date.now();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight--;
    slowest = Math.max(slowest, Date.now() - started);
  };
}

/** עוטף פעולה אסינכרונית כשאלה לסוכן */
async function track(fn) {
  const end = begin();
  try { return await fn(); } finally { end(); }
}

// ---------- הדגימה ----------

const loop = monitorEventLoopDelay({ resolution: 20 });
const samples = [];
let prev = null;
let prevAt = 0;
let lastAlertAt = 0;
let timer = null;

function sample(now = Date.now()) {
  const cpu = readCpu();
  const s = {
    at: now,
    lagMs: Math.round(loop.percentile(99) / 1e6),
    peak: peakInflight,
    questions,
    slowest,
    cpuShare: null,
    throttledShare: null,
    cpus: cpu?.cpus ?? null
  };
  loop.reset();
  peakInflight = inflight;
  questions = 0;
  slowest = 0;

  if (cpu && prev) {
    const dPeriods = cpu.periods - prev.periods;
    if (dPeriods > 0) s.throttledShare = (cpu.throttled - prev.throttled) / dPeriods;
    if (cpu.usageUs != null && prev.usageUs != null && cpu.cpus && now - prevAt >= 1000) {
      s.cpuShare = (cpu.usageUs - prev.usageUs) / ((now - prevAt) * 1000 * cpu.cpus);
    }
  }
  prev = cpu;
  prevAt = now;

  samples.push(s);
  if (samples.length > WINDOW) samples.shift();
  check();
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x) => `${Math.round(x * 100)}%`;

/** תמונת המצב — גם למסך הניהול */
function snapshot() {
  const ws = samples;
  const throttled = avg(ws.map((s) => s.throttledShare).filter((x) => x != null));
  const cpu = avg(ws.map((s) => s.cpuShare).filter((x) => x != null));
  return {
    at: ws.at(-1)?.at ?? Date.now(),
    windowMinutes: Math.round((ws.length * SAMPLE_MS) / 60000),
    cpus: ws.at(-1)?.cpus ?? null,
    cpuShare: cpu,
    throttledShare: throttled,
    lagSpikes: ws.filter((s) => s.lagMs >= LOOP_LAG_MS).length,
    maxLagMs: Math.max(0, ...ws.map((s) => s.lagMs)),
    inflight,
    peakInflight: Math.max(inflight, ...ws.map((s) => s.peak)),
    questions: ws.reduce((n, s) => n + s.questions, 0),
    slowestMs: Math.max(0, ...ws.map((s) => s.slowest))
  };
}

function background() {
  const parts = [];
  try {
    const mem = require('./ai/mail-memory').load?.();
    if (mem?.reading) parts.push(`סריקת זיכרון המייל קוראת ${mem.reading} שרשורים${mem.waiting ? ` (${mem.waiting} ממתינים)` : ''}`);
  } catch { /* המודול לא זמין */ }
  try {
    const st = require('./ai/mcp-client').status();
    const live = Object.values(st).filter((x) => x.started).map((x) => x.label);
    if (live.length) parts.push(`מקורות נתונים פעילים: ${live.join(', ')}`);
  } catch { /* המודול לא זמין */ }
  return parts;
}

function check() {
  if (samples.length < 4) return; // לפחות שתי דקות של נתונים
  if (!D.getSetting('load_alert_enabled', true)) return;
  const snap = snapshot();
  const agentsUsed = snap.questions > 0 || snap.inflight > 0;
  if (!agentsUsed) return;

  const reasons = [];
  if (snap.throttledShare != null && snap.throttledShare >= THROTTLED_SHARE) {
    reasons.push(`השרת נחסם ע"י תקרת המעבד ב-${pct(snap.throttledShare)} מהזמן`);
  }
  if (snap.cpuShare != null && snap.cpuShare >= CPU_SHARE) {
    reasons.push(`המעבד מנוצל ב-${pct(snap.cpuShare)} מהתקרה${snap.cpus ? ` (${snap.cpus} מעבד${snap.cpus === 1 ? '' : 'ים'})` : ''}`);
  }
  if (snap.lagSpikes >= 2) {
    reasons.push(`בקשות חיכו בתור עד ${(snap.maxLagMs / 1000).toFixed(1)} שניות`);
  }
  if (!reasons.length) return;

  const cooldown = Math.max(5, Number(D.getSetting('load_alert_cooldown_min', 60)) || 60) * 60000;
  if (snap.at - lastAlertAt < cooldown) return;
  lastAlertAt = snap.at;

  const lines = [
    `ב-${snap.windowMinutes} הדקות האחרונות: ${reasons.join('; ')}.`,
    `שאלות לסוכנים: ${snap.questions}, עד ${snap.peakInflight} במקביל${snap.slowestMs >= SLOW_QUESTION_MS ? `; הארוכה נמשכה ${Math.round(snap.slowestMs / 1000)} שניות` : ''}.`,
    ...background().map((b) => `ברקע: ${b}.`),
    'אם זה חוזר בשעות העבודה — לשקול תוכנית עם יותר מעבדים ב-Render, או להגביל את סריקת המייל לשעות הלילה (שעות זיכרון העבודה בהגדרות).'
  ];
  const title = '⚠️ עומס על השרת מאט את הסוכנים';
  const body = lines.join('\n');
  console.warn(`[משימון] ${title} — ${body.replace(/\n/g, ' ')}`);

  const admins = D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')");
  for (const a of admins) {
    try { D.notify({ targetType: 'user', targetId: a.id, kind: 'ai', title, body }); } catch (err) {
      console.error('[משימון] התראת עומס נכשלה:', err.message);
    }
  }
}

function start(now = Date.now()) {
  if (timer) return;
  loop.enable();
  prev = readCpu();
  prevAt = now;
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
}

module.exports = { start, begin, track, snapshot, readCpu, _sample: sample };
