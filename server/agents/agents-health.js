'use strict';
/**
 * 🩺 בדיקת סוכנים — מהשרת החי, בלחיצה במסך הניהול.
 *
 * לכל מקור נתונים (MCP): עולה? מה הכלים? וקריאה אמיתית אחת (‎probe‎ ב-
 * ‎agents-mcp.json‎) — כי "עלה" אינו "מביא נתונים": חסימת רשת, שינוי ב-API
 * או חוסר ב-‎uv‎ נראים רק בקריאה. בנוסף: ה-AI (קריאה זעירה ב-Haiku), ארבעת
 * המחשבונים (קוד מקומי), ו-Timeless של מי שלחץ.
 *
 * לכל סוכן — המצב נגזר מהתלויות שלו: ✅ כולן עובדות, ⚠️ חלק, ❌ אף אחת.
 * התוצאה האחרונה נשמרת (‎agents_health_last‎), כדי שהמסך יציג אותה גם אחר כך.
 */
const fs = require('node:fs');
const Paths = require('../core').Paths;
const path = require('node:path');
const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const Timeless = require('../integrations').Timeless;
const Agents = require('./agents');
const Calc = require('./calculators');
const Mcp = require('../integrations').McpClient;

const CFG = Paths.AGENTS_MCP;
const cfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

// סימנים של קריאה שנכשלה גם כשהשרת לא סימן ‎isError‎
const FAILED = /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|ProxyError|Max retries|request failed|Traceback|Unauthorized|Forbidden|\b40[13]\b|\b5\d\d\b error/i;
const WARMING = /loading|please wait|נטען/i;

async function checkMcp(key, server) {
  const started = Date.now();
  const r = { key, label: server.label ?? key, ok: false, state: 'error', ms: 0, tools: 0, sample: '', error: '' };
  try {
    const tools = await Mcp.listTools(key);
    r.tools = tools.length;
    const probe = server.probe;
    if (!probe) {
      r.ok = tools.length > 0;
      r.state = r.ok ? 'ok' : 'error';
      r.sample = 'עלה (אין קריאת בדיקה מוגדרת)';
    } else {
      const out = await Mcp.callTool(key, probe.tool, probe.args ?? {}, { timeoutMs: 45000 });
      const text = String(typeof out === 'string' ? out : out?.text ?? JSON.stringify(out)).replace(/\s+/g, ' ').trim();
      const isError = typeof out === 'object' && out?.isError;
      if (WARMING.test(text.slice(0, 200)) && !isError) { r.state = 'warming'; r.ok = true; r.sample = 'עולה — טוען אינדקס בפעם הראשונה'; }
      else if (isError || FAILED.test(text.slice(0, 300)) || !text) { r.state = 'error'; r.error = text.slice(0, 240) || 'תשובה ריקה'; }
      else { r.state = 'ok'; r.ok = true; r.sample = text.slice(0, 160); }
    }
  } catch (err) {
    r.error = String(err.message ?? err).slice(0, 240);
  }
  r.ms = Date.now() - started;
  return r;
}

async function checkClaude() {
  const started = Date.now();
  try {
    const out = await Claude.json({
      system: 'ענה לפי הסכמה.', content: [{ type: 'text', text: 'בדיקת חיבור: החזר ok=true.' }],
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      effort: 'low', model: 'claude-haiku-5-5'
    });
    return { ok: out.ok === true, ms: Date.now() - started, model: Claude.model(), error: out.ok === true ? '' : 'תשובה לא צפויה' };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, model: Claude.model(), error: String(err.message).slice(0, 240) };
  }
}

const CALC_PROBES = {
  calc_payroll: { gross_monthly: 15000 },
  calc_purchase_tax: { price: 2400000 },
  calc_fine_deadlines: { receipt_date: '2026-10-01', fine_type: 'parking' },
  calc_urban_renewal_majority: { track: 'pinui-binui', apartments: 40 }
};

function checkCalculators() {
  return Object.entries(CALC_PROBES).map(([name, input]) => {
    try {
      const out = Calc.run(name, input);
      return { key: name, ok: Boolean(out), error: '' };
    } catch (err) {
      return { key: name, ok: false, error: String(err.message).slice(0, 200) };
    }
  });
}

async function checkTimeless(userId) {
  const connected = D.get("SELECT COUNT(*) c FROM user_channels WHERE provider = 'timeless' AND api_token <> '' AND state <> 'revoked'")?.c ?? 0;
  const org = Timeless.hasOrgToken();
  if (!Timeless.isConnected(userId)) return { ok: null, org, connectedUsers: connected, error: 'לא מחובר אצלך — אי אפשר לבדוק מכאן. העובדים שחיברו: ' + connected };
  const started = Date.now();
  try {
    await Timeless.listMeetings(userId, { limit: 1 });
    return { ok: true, org, ms: Date.now() - started, connectedUsers: connected, error: '' };
  } catch (err) {
    return { ok: false, org, ms: Date.now() - started, connectedUsers: connected, error: String(err.message).slice(0, 240) };
  }
}

async function run(actor) {
  const servers = cfg().servers ?? {};
  const [claude, timeless] = await Promise.all([checkClaude(), checkTimeless(actor.id)]);
  // אחד-אחד: השרת מריץ לכל היותר 2 מקורות יחד (MCP_MAX_LIVE, זיכרון — #50)
  const mcp = [];
  for (const [k, s] of Object.entries(servers)) mcp.push(await checkMcp(k, s));
  const calc = checkCalculators();
  const byMcp = new Map(mcp.map((m) => [m.key, m]));
  const byCalc = new Map(calc.map((c) => [c.key, c]));
  const agents = Agents.catalog().map((a) => {
    const deps = [
      { name: 'AI', ok: claude.ok },
      ...(a.mcp ?? []).map((k) => ({ name: byMcp.get(k)?.label ?? k, ok: Boolean(byMcp.get(k)?.ok) })),
      ...(a.calc ?? []).map((k) => ({ name: `מחשבון ${k.replace('calc_', '')}`, ok: Boolean(byCalc.get(k)?.ok) })),
      ...(a.timeless ? [{ name: 'Timeless', ok: timeless.ok }] : [])
    ];
    const bad = deps.filter((d) => d.ok === false);
    const unknown = deps.filter((d) => d.ok === null);
    const state = !claude.ok ? 'error' : bad.length ? (bad.length === deps.length - 1 ? 'error' : 'partial') : unknown.length ? 'unknown' : 'ok';
    return { key: a.key, icon: a.icon, title: a.title, deptLabel: a.deptLabel, enabled: a.enabled, state, failing: bad.map((d) => d.name), unknown: unknown.map((d) => d.name) };
  });
  const result = { at: D.nowIso(), by: actor.full_name ?? '', claude, mcp, calc, timeless, agents };
  D.setSetting('agents_health_last', result);
  return result;
}

const last = () => D.getSetting('agents_health_last', null);

module.exports = { run, last, _internal: { checkMcp, FAILED, WARMING } };
