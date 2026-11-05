'use strict';
/**
 * סקירה לילית של יומן הבוט — החיבור לסוקר שרץ מחוץ למשימון.
 *
 * כל ערב סוקר (Claude Code, כמשימה מתוזמנת) מושך את השיחות הפרטיות עם הבוט
 * מאז הסקירה הקודמת, מחפש איפה אנשים ביקשו ולא קיבלו, ומכין תיקונים כ-Pull
 * Request. הדו"ח, עם הקישור למיזוג, נשלח מכאן במייל למנהלי המערכת.
 *
 *   GET  /api/integrations/bot-review/export?since=ISO   — השיחות, מוסוות
 *   POST /api/integrations/bot-review/report              — הדו"ח ← מייל לאדמינים
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
    conversations: conversations.map(({ lastAt, ...c }) => ({ ...c, endedAt: new Date(lastAt).toISOString() }))
  };
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
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
    url: isHttps(clean(f.url, 500)) ? clean(f.url, 500) : ''
  })).filter((f) => f.title);
  const reportUrl = isHttps(clean(body.reportUrl, 500)) ? clean(body.reportUrl, 500) : '';
  if (!summary && !fixes.length) throw badRequest('הדו"ח ריק');

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
    reportUrl ? `          <p style="margin-top:18px;"><a href="${escape(reportUrl)}">הדו"ח המלא</a></p>` : ''
  ].filter(Boolean).join('\n');
  const html = shell({ title: subject, bodyHtml, footerHtml: 'הסקירה הלילית של בוט משימון. תיקון נכנס רק אחרי מיזוג.' });
  const text = [subject, '', summary, '', ...fixes.map((f) => `${f.n}. ${f.title}\n${f.problem}${f.url ? `\nלמיזוג: ${f.url}` : ''}`), reportUrl ? `\nהדו"ח המלא: ${reportUrl}` : '']
    .join('\n').trim();

  const admins = D.all("SELECT full_name, email FROM users WHERE status = 'active' AND role IN ('superadmin','admin') AND email <> ''");
  if (!admins.length) throw badRequest('אין מנהל מערכת פעיל עם כתובת מייל');
  if (!Mailer.isEnabled()) throw badRequest('שליחת דואר אינה מוגדרת במערכת (SMTP)');
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
  return { sent: sent.length, failed };
}

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

module.exports = { register, mask, exportSince, sendReport };
