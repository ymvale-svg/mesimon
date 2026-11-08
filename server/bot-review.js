'use strict';
/**
 * סקירה לילית של יומן הבוט — החיבור לסוקר שרץ מחוץ למשימון.
 *
 * כל ערב סוקר (Claude Code, כמשימה מתוזמנת) מושך את השיחות הפרטיות עם הבוט
 * מאז הסקירה הקודמת, מחפש איפה אנשים ביקשו ולא קיבלו, ומכין תיקונים כ-Pull
 * Request. הדו"ח, עם הקישור למיזוג, נשלח מכאן במייל למנהלי המערכת.
 *
 *   GET  /api/integrations/bot-review/export?since=ISO   — השיחות, מוסוות
 *   POST /api/integrations/bot-review/report              — הדו"ח ← נשמר, ומייל לאדמינים
 *
 * הדו"חות מוצגים במסך הניהול ← בוט וואטסאפ ← "סקירה לילית". שם המנהל מסמן כל
 * הצעה כ"טופל" או "לא רלוונטי" (עם הערה), והייצוא של הלילה הבא מחזיר את
 * ההחלטות לסוקר — כדי שלא יציע שוב מה שנדחה, וילמד מההערות.
 *
 * שתיהן מוגנות במפתח ‎BOT_REVIEW_KEY‎ (Bearer). בלעדיו החיבור כבוי.
 *
 * פרטיות: התוכן נשאר — בלעדיו אי אפשר להבין מה האדם ביקש — אבל מספרי טלפון,
 * כתובות מייל וסכומים מוחלפים לפני שהם יוצאים מהשרת. שמות נשארים: הם חלק
 * ממה שהבוט צריך ללמוד ("שושנה" = מי).
 */
const crypto = require('node:crypto');
const D = require('./db');
const Auth = require('./auth');
const Mailer = require('./mailer');
const { escape, shell, button } = require('./mail-templates');
const { badRequest, unauthorized, readJson, sendJson } = require('./http-kit');

/** שיחה = רצף הודעות של אותו אדם בלי הפסקה ארוכה מזו */
const GAP_MS = 15 * 60 * 1000;
const MAX_DAYS = 7;

function authenticate(req) {
  const expected = String(process.env.BOT_REVIEW_KEY ?? '').trim();
  if (!expected) throw unauthorized('הסקירה הלילית אינה מוגדרת (BOT_REVIEW_KEY)');
  Auth.checkLoginRate(req);
  const header = String(req.headers.authorization ?? '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) {
    Auth.noteFailedLogin(req);
    throw unauthorized('מפתח שגוי');
  }
}

/**
 * הסתרת טלפונים, מיילים וסכומים. הסדר חשוב: מייל לפני טלפון (ספרות בכתובת),
 * סכום לפני טלפון (מספר ארוך עם ₪ הוא סכום, לא טלפון).
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const CUR = '(?:₪|\\$|€|ש["״׳\']?ח|שקל(?:ים)?|ש״ח|NIS|ILS|דולר|יורו|אלף|אלפים|מיליון|K\\b)';
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
const MONEY = new RegExp(`(?:${CUR}\\s?${NUM}|${NUM}\\s?${CUR})`, 'gi');
const PHONE = /(?:\+?972[-\s]?|0)(?:[2-9]\d?)[-\s]?\d{3}[-\s]?\d{3,4}\b|\b\d{9,15}\b/g;

function mask(text) {
  return String(text ?? '')
    .replace(EMAIL, '[מייל]')
    .replace(MONEY, '[סכום]')
    .replace(PHONE, '[טלפון]');
}

/** השיחות הפרטיות (וואטסאפ והעוזר באפליקציה) מאז ‎since‎, מקובצות לשיחות */
function exportSince(since) {
  const floor = new Date(Date.now() - MAX_DAYS * 86400000);
  const from = since && !Number.isNaN(Date.parse(since)) && new Date(since) > floor ? new Date(since) : floor;
  const rows = D.all(
    `SELECT id, at, channel, user_id, who, text, action, result, status, task_id, reply, forwarded
       FROM wa_log
      WHERE at >= ? AND channel IN ('private', 'app') AND user_id IS NOT NULL
      ORDER BY user_id, id`,
    from.toISOString()
  );
  const conversations = [];
  let cur = null;
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!cur || cur.userId !== r.user_id || t - cur.lastAt > GAP_MS) {
      cur = { userId: r.user_id, who: r.who, channel: r.channel, startedAt: r.at, lastAt: t, turns: [] };
      conversations.push(cur);
    }
    cur.lastAt = t;
    cur.turns.push({
      id: r.id,
      at: r.at,
      channel: r.channel,
      text: mask(r.text),
      reply: mask(r.reply),
      action: r.action,
      status: r.status,
      result: mask(r.result),
      taskId: r.task_id,
      forwarded: Boolean(r.forwarded)
    });
  }
  conversations.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return {
    since: from.toISOString(),
    until: D.nowIso(),
    feedback: feedback(),
    conversations: conversations.map(({ lastAt, ...c }) => ({ ...c, endedAt: new Date(lastAt).toISOString() }))
  };
}

/** ההחלטות של המנהל על הצעות מ-30 הימים האחרונים — לסוקר של הלילה הבא */
function feedback() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const out = [];
  for (const r of D.all('SELECT id, created_at, fixes FROM bot_reviews WHERE created_at >= ? ORDER BY id', since)) {
    for (const f of parse(r.fixes)) {
      out.push({ reviewId: r.id, date: r.created_at.slice(0, 10), title: f.title, url: f.url, status: f.status ?? 'new', note: f.note ?? '' });
    }
  }
  return out;
}

function parse(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const appUrl = () => String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const isHttps = (u) => /^https:\/\/\S+$/.test(u);

/**
 * הדו"ח במייל לכל מנהלי המערכת הפעילים. ‎fixes‎ — ההצעות, כל אחת עם קישור
 * למיזוג (Pull Request). שום דבר לא נכנס למערכת בלי שמנהל מיזג.
 */
async function sendReport(body) {
  const subject = clean(body.subject, 200) || 'סקירת הבוט';
  const summary = clean(body.summary, 4000);
  const fixes = (Array.isArray(body.fixes) ? body.fixes : []).slice(0, 20).map((f, i) => ({
    n: i + 1,
    title: clean(f.title, 200),
    problem: clean(f.problem, 1500),
    example: clean(f.example, 1500),
    url: isHttps(clean(f.url, 500)) ? clean(f.url, 500) : '',
    kind: clean(f.kind, 30)
  })).filter((f) => f.title).map((f, i) => ({ ...f, n: i + 1 }));
  const reportUrl = isHttps(clean(body.reportUrl, 500)) ? clean(body.reportUrl, 500) : '';
  if (!summary && !fixes.length) throw badRequest('הדו"ח ריק');
  const patterns = (Array.isArray(body.patterns) ? body.patterns : []).slice(0, 30)
    .map((p) => ({ who: clean(mask(p.who), 120), pattern: clean(mask(p.pattern), 600) })).filter((p) => p.pattern);
  const n = (v) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  const conversations = n(body.conversations);
  const succeeded = Math.min(conversations, n(body.succeeded));

  // נשמר קודם — מייל שנכשל לא מאבד את הדו"ח, הוא עדיין במסך הבוט
  const id = D.run(
    `INSERT INTO bot_reviews (created_at, period_from, period_to, subject, summary, conversations, succeeded, patterns, fixes)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    D.nowIso(), clean(body.since, 40), clean(body.until, 40), subject, mask(summary), conversations, succeeded,
    JSON.stringify(patterns),
    JSON.stringify(fixes.map((f) => ({ title: mask(f.title), problem: mask(f.problem), example: mask(f.example), kind: f.kind, url: f.url, status: 'new', note: '' })))
  ).lastInsertRowid;

  const para = (t) => escape(t).replace(/\n/g, '<br>');
  const bodyHtml = [
    `          <h2 style="margin:0 0 12px;font-size:20px;">${escape(subject)}</h2>`,
    summary ? `          <p style="margin:0 0 18px;">${para(summary)}</p>` : '',
    fixes.length ? '          <h3 style="margin:22px 0 8px;font-size:17px;">הצעות לתיקון</h3>' : '',
    ...fixes.map((f) => [
      '          <div style="margin:0 0 18px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:10px;">',
      `            <div style="font-weight:700;">${f.n}. ${escape(f.title)}</div>`,
      f.problem ? `            <div style="margin-top:6px;">${para(f.problem)}</div>` : '',
      f.example ? `            <div style="margin-top:8px;color:#475569;font-size:13px;">דוגמה מהיומן: ${para(f.example)}</div>` : '',
      f.url ? button(f.url, 'לבדיקה ולמיזוג') : '',
      '          </div>'
    ].filter(Boolean).join('\n')),
    reportUrl ? `          <p style="margin-top:18px;"><a href="${escape(reportUrl)}">הדו"ח המלא</a></p>` : '',
    `          <p style="margin-top:18px;color:#475569;font-size:13px;">הדו"ח וכל הסקירות הקודמות — במשימון: מסך הניהול ← בוט וואטסאפ ← סקירה לילית. שם אפשר לסמן כל הצעה "טופל" או "לא רלוונטי", והסקירה הבאה לומדת מזה.${appUrl() ? ` <a href="${escape(appUrl())}">לפתיחת משימון</a>` : ''}</p>`
  ].filter(Boolean).join('\n');
  const html = shell({ title: subject, bodyHtml, footerHtml: 'הסקירה הלילית של בוט משימון. תיקון נכנס רק אחרי מיזוג.' });
  const text = [subject, '', summary, '', ...fixes.map((f) => `${f.n}. ${f.title}\n${f.problem}${f.url ? `\nלמיזוג: ${f.url}` : ''}`), reportUrl ? `\nהדו"ח המלא: ${reportUrl}` : '']
    .join('\n').trim();

  const admins = D.all("SELECT full_name, email FROM users WHERE status = 'active' AND role IN ('superadmin','admin') AND email <> ''");
  if (!admins.length || !Mailer.isEnabled()) {
    return { id: Number(id), sent: 0, failed: [], mail: !Mailer.isEnabled() ? 'שליחת דואר אינה מוגדרת (SMTP) — הדו"ח שמור במסך הבוט' : 'אין מנהל מערכת עם מייל' };
  }
  const sent = [];
  const failed = [];
  for (const a of admins) {
    try {
      await Mailer.send({ to: a.email, toName: a.full_name, subject, html, text });
      sent.push(a.email);
    } catch (err) {
      failed.push({ email: a.email, error: err.message });
    }
  }
  D.run('UPDATE bot_reviews SET emailed = ? WHERE id = ?', sent.length, id);
  return { id: Number(id), sent: sent.length, failed };
}

// ---------------------------------------------------------------------------
// מסך הבוט
// ---------------------------------------------------------------------------

const FIX_STATUS = ['new', 'done', 'dismissed'];

function listReviews(limit = 30) {
  return D.all('SELECT * FROM bot_reviews ORDER BY id DESC LIMIT ?', Math.min(90, Number(limit) || 30)).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    from: r.period_from,
    to: r.period_to,
    subject: r.subject,
    summary: r.summary,
    conversations: r.conversations,
    succeeded: r.succeeded,
    patterns: parse(r.patterns),
    fixes: parse(r.fixes).map((f, i) => ({ n: i + 1, ...f, status: f.status ?? 'new' })),
    emailed: r.emailed
  }));
}

/** "טופל" / "לא רלוונטי" / חזרה ל"חדש" — עם הערה שהסוקר יראה בלילה הבא */
function setFixStatus(reviewId, n, { status, note = '' }, actor) {
  if (!FIX_STATUS.includes(status)) throw badRequest('מצב לא מוכר');
  const row = D.get('SELECT fixes FROM bot_reviews WHERE id = ?', Number(reviewId));
  if (!row) throw badRequest('הסקירה לא נמצאה');
  const fixes = parse(row.fixes);
  const f = fixes[Number(n) - 1];
  if (!f) throw badRequest('ההצעה לא נמצאה');
  Object.assign(f, { status, note: clean(note, 500), decidedBy: actor?.name ?? '', decidedAt: D.nowIso() });
  D.run('UPDATE bot_reviews SET fixes = ? WHERE id = ?', JSON.stringify(fixes), Number(reviewId));
}

const isConfigured = () => Boolean(String(process.env.BOT_REVIEW_KEY ?? '').trim());

function register(router) {
  router.get('/api/integrations/bot-review/export', async (req, res) => {
    authenticate(req);
    const since = new URL(req.url, 'http://local').searchParams.get('since') ?? '';
    sendJson(res, 200, exportSince(since));
  });

  router.post('/api/integrations/bot-review/report', async (req, res) => {
    authenticate(req);
    sendJson(res, 200, await sendReport(await readJson(req)));
  });
}

module.exports = { register, mask, exportSince, sendReport, listReviews, setFixStatus, isConfigured };
