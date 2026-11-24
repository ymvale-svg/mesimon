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
const D = require('../core').Db;
const Auth = require('../core').Auth;
const Mailer = require('../integrations').Mailer;
const Gmail = require('../integrations').Gmail;
const Mime = require('../core').Mime;
const MailThread = require('../mail').MailThread;
const { pushToUser } = require('./wa-proactive');
const { messageUser } = require('./wa-tasks');
const WaUi = require('./wa-ui');
const { escape, shell, button } = require('../core').MailTemplates;
const { badRequest, unauthorized, readJson, sendJson } = require('../core').HttpKit;

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

/**
 * 🔊 כמה הקראות היו בתקופה — לפי היומן (‎result‎ של "המשימות שלי": "🔊 הוקרא" / "🔇 הקראה נכשלה").
 * כל הקראה עולה ב-OpenAI, ולכן היא נספרת בכל סקירה.
 */
function readAloudUsage(from, to = new Date().toISOString()) {
  const row = D.get(
    `SELECT SUM(CASE WHEN result LIKE '%🔊 הוקרא%' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN result LIKE '%🔇 הקראה נכשלה%' THEN 1 ELSE 0 END) AS failed,
            COUNT(DISTINCT CASE WHEN result LIKE '%🔊 הוקרא%' THEN user_id END) AS users
       FROM wa_log WHERE at >= ? AND at <= ?`,
    from, to
  ) ?? {};
  return { ok: Number(row.ok) || 0, failed: Number(row.failed) || 0, users: Number(row.users) || 0 };
}
const usageLine = (u) => (u.ok || u.failed
  ? `🔊 הקראות: ${u.ok}${u.ok ? ` (${u.users === 1 ? 'עובד אחד' : `${u.users} עובדים`})` : ''}${u.failed ? ` · נכשלו: ${u.failed}` : ''}`
  : '');

/*
 * 📧 הערות על משימון במייל (הוחלט 11.11.26): הסוקר עובר גם על המייל של ישראל — רק מיילים שמזכירים את משימון או הבוט ("אשל שלי"),
 * כולל צילומי המסך שמצורפים אליהם (שם יש הרבה רעיונות). איזו תיבה — רק מה שהסוקר מבקש במפורש
 * (‎?mailbox=<מזהה משתמש>‎ בייצוא), ואחרת ההגדרה ‎bot_review_mailboxes‎; בלי אחת מהן — לא קוראים מייל.
 * הטקסט מוסווה כמו היומן. לא נכללים: מה שמשימון עצמו שלח (‎SMTP_FROM‎, הדו"ח הלילי), ומענה אוטומטי.
 */
// "בוט" ו"הבוט" — Gmail מחפש מילה שלמה, והה"א צמודה
const MAIL_QUERY = '(משימון OR mesimon OR "אשל שלי" OR בוט OR הבוט)';
const MAIL_MAX = 15;
// כמה מיילים נבדקים כדי לבחור מהם (סקירה 16.11: 15 האחרונים היו רובם דוחות אוטומטיים, ומיילים של עובדת נדחקו החוצה)
const MAIL_SCAN = 60;
const MAIL_EMPLOYEES_MAX = 30;
const MAIL_TEXT = 2500;
const IMG_PER_MAIL = 4;
const IMG_MAX_BYTES = 3 * 1024 * 1024;
const IMG_TOTAL_BYTES = 12 * 1024 * 1024;

// 🔒 תיבה מבוקשת (‎?mailbox=‎) נקראת רק אם היא של מנהל מערכת (superadmin) או מופיעה בהגדרה ‎bot_review_mailboxes‎ —
// כך מי שמחזיק את ‎BOT_REVIEW_KEY‎ לא יכול לקרוא את המייל של כל עובד
function mailboxUsers(requested = []) {
  const set = D.getSetting('bot_review_mailboxes', null);
  const listed = Array.isArray(set) ? set.map(Number).filter(Boolean) : [];
  const ids = (Array.isArray(requested) ? requested : []).map(Number).filter(Boolean);
  if (!ids.length) return listed;
  return ids.filter((id) => listed.includes(id)
    || D.get("SELECT 1 FROM users WHERE id = ? AND role = 'superadmin' AND status = 'active'", id));
}

/** כתובת של עובד/ת פעיל/ה בארגון (לא בעל התיבה עצמו) */
function employeeOf(address, ownerId) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return null;
  return D.get("SELECT id FROM users WHERE status = 'active' AND id != ? AND (lower(email) = ? OR lower(work_email) = ?)", ownerId, a, a) ?? null;
}

/*
 * בחירת המיילים: קודם כל מה שכתבו עובדי הארגון (עד ‎MAIL_EMPLOYEES_MAX‎) — הם ההערות שחשובות; אחר כך השאר
 * (דוחות אוטומטיים, גורמים מבחוץ) עד ‎MAIL_MAX‎ בסך הכול. מה שנחתך — נספר ב-‎omitted‎, כדי שהסוקר יידע.
 */
async function mailFeedback(from, { users = [] } = {}) {
  const after = Math.floor(new Date(from).getTime() / 1000);
  const self = String(Mailer.CONFIG?.from ?? '').trim();
  const q = `after:${after} ${MAIL_QUERY} -subject:"סקירת הבוט"${self ? ` -from:${self}` : ''}`;
  const out = [];
  const errors = [];
  let omitted = 0;
  let imgBytes = 0;
  for (const userId of mailboxUsers(users)) {
    for (const who of Gmail.boxesOf(userId, 'mail')) {
      try {
        const found = [];
        for (const id of await Gmail.search(who, q, { max: MAIL_SCAN })) {
          const msg = await Gmail.messageFull(who, id);
          const parts = Mime.fromGmail(msg.payload);
          const m = Mime.finishGmail(parts);
          if (m.autoSubmitted) continue;
          found.push({ id, parts, m, employee: Boolean(employeeOf(m.from?.address, userId)) });
        }
        const staff = found.filter((f) => f.employee).slice(0, MAIL_EMPLOYEES_MAX);
        const rest = found.filter((f) => !f.employee).slice(0, Math.max(0, MAIL_MAX - staff.length));
        omitted += found.length - staff.length - rest.length;
        for (const { id, parts, m, employee } of [...staff, ...rest]) {
          // 🖼 צילומי מסך — התמונות שמצורפות למייל (בגבולות גודל), כדי שהסוקר יראה מה הראו לו
          const images = [];
          for (const a of (parts.attachments ?? []).filter((x) => /^image\//i.test(x.mime ?? '') && (x.size ?? 0) <= IMG_MAX_BYTES).slice(0, IMG_PER_MAIL)) {
            if (imgBytes + (a.size ?? 0) > IMG_TOTAL_BYTES) break;
            try {
              const buf = a.data ?? (a.attachmentId ? await Gmail.attachment(who, id, a.attachmentId) : null);
              if (!buf?.length) continue;
              imgBytes += buf.length;
              images.push({ name: String(a.filename ?? 'image').slice(0, 120), mime: a.mime, data: Buffer.from(buf).toString('base64') });
            } catch { /* תמונה שלא נמשכה — המייל עדיין נכלל */ }
          }
          out.push({
            at: m.date && !Number.isNaN(m.date.getTime()) ? m.date.toISOString() : null,
            from: mask(m.from?.name || m.from?.address || ''),
            employee,
            subject: mask(m.subject),
            text: mask(String(m.newText || m.text || '').slice(0, MAIL_TEXT)),
            images
          });
        }
      } catch (err) {
        errors.push(`תיבה של משתמש ${userId}: ${String(err.message).slice(0, 120)}`);
      }
    }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { query: MAIL_QUERY, mails: out, ...(omitted ? { omitted } : {}), ...(errors.length ? { errors } : {}) };
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
  const until = D.nowIso();
  return {
    since: from.toISOString(),
    until,
    usage: { readAloud: readAloudUsage(from.toISOString(), until) },
    feedback: feedback(),
    mailTasks: mailTasks(from.toISOString()),
    conversations: conversations.map(({ lastAt, ...c }) => ({ ...c, endedAt: new Date(lastAt).toISOString() }))
  };
}

/**
 * 🔎 משימות שנפתחו מהצעות מייל מאז ‎since‎ — ואיך (‎how‎: ‎trusted‎ / ‎auto_all‎ = לבד; ‎manual‎ / ‎approve_all‎ / ‎bot‎).
 * כך הסוקר רואה משימה שנפתחה "בלי אישור" (20.11.26). השולח — רק הדומיין; הכותרת — מוסווית.
 * ‎how‎ ריק — הצעה מלפני הרישום.
 */
function mailTasks(since) {
  return D.all(
    `SELECT s.id, s.user_id, u.full_name, s.status, s.task_id, s.decided_at, s.from_email, s.data
       FROM ai_suggestions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('auto', 'approved') AND s.task_id IS NOT NULL AND s.decided_at >= ?
      ORDER BY s.decided_at`, since
  ).map((r) => {
    const d = parse1(r.data);
    return {
      suggestionId: r.id, at: r.decided_at, userId: r.user_id, who: r.full_name ?? '', status: r.status, how: d.how ?? '',
      taskId: r.task_id, title: mask(d.title ?? ''), fromDomain: String(r.from_email ?? '').split('@')[1] ?? ''
    };
  });
}
const parse1 = (json) => { try { return JSON.parse(json) ?? {}; } catch { return {}; } };

/** ההחלטות של המנהל על הצעות מ-30 הימים האחרונים — לסוקר של הלילה הבא */
function feedback() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const out = [];
  for (const r of D.all('SELECT id, created_at, fixes FROM bot_reviews WHERE created_at >= ? ORDER BY id', since)) {
    for (const f of parse(r.fixes)) {
      out.push({
        reviewId: r.id, n: out.filter((x) => x.reviewId === r.id).length + 1, date: r.created_at.slice(0, 10), title: f.title, url: f.url, kind: f.kind ?? '',
        status: f.status ?? 'new', note: f.note ?? '',
        // ✉️ מי העיר (משתמש במשימון) — כדי להציע לו תשובה כשזה טופל; ‎replyProposedAt‎ — כבר הוצעה, לא שוב
        requester: f.requester ?? '', threadHint: f.threadHint ?? '', replyProposedAt: f.replyProposedAt ?? null,
        // 🔁 העובדים שניסו ולא הצליחו — ומתי נשלח להם "אפשר לנסות שוב" (‎invitedAt‎; ריק — עוד לא)
        retry: (f.retry ?? []).map((r) => ({ userId: r.userId, who: nameOf(r.userId), ask: r.ask, invitedAt: r.invitedAt ?? null }))
      });
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
  let summary = clean(body.summary, 4000);
  const fixes = (Array.isArray(body.fixes) ? body.fixes : []).slice(0, 20).map((f, i) => ({
    n: i + 1,
    title: clean(f.title, 200),
    problem: clean(f.problem, 1500),
    example: clean(f.example, 1500),
    url: isHttps(clean(f.url, 500)) ? clean(f.url, 500) : '',
    kind: clean(f.kind, 30),
    // ✉️ מי העיר — השם המלא של משתמש במשימון (מהמייל שממנו עלה הרעיון), ומילה מהנושא לשרשור התשובה
    requester: clean(f.requester, 120),
    threadHint: clean(f.threadHint, 120),
    // 🔁 מי ניסה ולא הצליח — לשלוח לו "אפשר לנסות שוב" כשהתיקון נכנס (הוחלט 20.11.26)
    retry: retryOf(f.retry)
  })).filter((f) => f.title).map((f, i) => ({ ...f, n: i + 1 }));
  const reportUrl = isHttps(clean(body.reportUrl, 500)) ? clean(body.reportUrl, 500) : '';
  if (!summary && !fixes.length) throw badRequest('הדו"ח ריק');
  // 🔊 ההקראות בתקופת הסקירה — נוספות לסיכום לבד, מהיומן (לא תלוי במה שהסוקר כתב)
  const valid = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const from = valid(body.since);
  const usage = from ? usageLine(readAloudUsage(from, valid(body.until) ?? new Date().toISOString())) : '';
  if (usage && !summary.includes('🔊 הקראות:')) summary = [summary, usage].filter(Boolean).join('\n\n');
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
    JSON.stringify(fixes.map((f) => ({ title: mask(f.title), problem: mask(f.problem), example: mask(f.example), kind: f.kind, url: f.url, status: 'new', note: '',
      ...(f.requester ? { requester: f.requester, threadHint: mask(f.threadHint) } : {}),
      ...(f.retry.length ? { retry: f.retry } : {}) })))
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
    fixes: parse(r.fixes).map((f, i) => ({ n: i + 1, ...f, status: f.status ?? 'new', retry: (f.retry ?? []).map((x) => ({ who: nameOf(x.userId), invitedAt: x.invitedAt ?? null })) })),
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
  // ✅ "טופל" — מי שניסה ולא הצליח מקבל "אפשר לנסות שוב"
  if (status === 'done') retryInvite([{ reviewId: Number(reviewId), n: Number(n) }]);
}

/*
 * 🔁 "אפשר לנסות שוב" (הוחלט 20.11.26, ישראל): עובד ניסה ולא הצליח, ותיקנו — הבוט כותב לו לנסות שוב את אותה בקשה.
 * הסקירה הלילית שומרת בכל תיקון את מי שנכשל ומה ביקש (‎retry: [{ userId, ask, note }]‎). נשלח כשהתיקון מוזג
 * (הסקירה בודקת ב-GitHub וקוראת ל-‎retry-invite‎) או כשמנהל סימן "טופל". פעם אחת לכל עובד ותיקון (‎invitedAt‎),
 * ובשעות העבודה בלבד (מחוץ לשעות — לתור, ויוצא כשהחלון נפתח).
 */
function retryOf(list) {
  return (Array.isArray(list) ? list : []).slice(0, 5)
    .map((r) => ({ userId: Number(r?.userId) || 0, ask: clean(mask(r?.ask), 300), note: clean(mask(r?.note), 300) }))
    .filter((r) => r.ask && D.get("SELECT id FROM users WHERE id = ? AND status = 'active'", r.userId));
}
const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';

/*
 * ההודעה לעובד — אחת לכל עובד, עם כל מה שניסה ותוקן (הוחלט 24.11.26: "ניסית 1, 2, 3 — לידיעתך, כרגע אפשר", כמו
 * בתשובות במייל). כמה תיקונים לאותו עובד באותה הזמנה — רשימה ממוספרת בהודעה אחת, לא כמה הודעות.
 */
function retryText(userId, items) {
  const list = Array.isArray(items) ? items : [items];
  const first = nameOf(userId).split(/\s+/)[0];
  const hi = `🔧 ${first ? `${first}, ` : ''}`;
  if (list.length === 1) {
    const r = list[0];
    return [`${hi}ניסית "${r.ask}" — וזה לא הסתדר.`, r.note ? `תיקנו: ${r.note}` : 'תיקנו את זה.', 'לידיעתך, כרגע אפשר לנסות שוב 🙂'].join('\n');
  }
  return [`${hi}ניסית כמה דברים בבוט שלא הסתדרו — תיקנו אותם:`,
    ...list.map((r, i) => `${i + 1}. "${r.ask}"${r.note ? ` — ${r.note}` : ''}`),
    'לידיעתך, כרגע אפשר לנסות שוב 🙂'].join('\n');
}

/** ‎refs‎: ‎[{ reviewId, n }]‎ — התיקונים שנכנסו. הודעה אחת לכל עובד. מחזיר למי נשלח */
function retryInvite(refs) {
  const reviews = new Map(); // reviewId ← fixes
  const byUser = new Map(); // userId ← [{ reviewId, n, r }]
  for (const ref of Array.isArray(refs) ? refs.slice(0, 50) : []) {
    const reviewId = Number(ref?.reviewId);
    if (!reviews.has(reviewId)) {
      const row = D.get('SELECT fixes FROM bot_reviews WHERE id = ?', reviewId);
      reviews.set(reviewId, row ? parse(row.fixes) : null);
    }
    const f = reviews.get(reviewId)?.[Number(ref?.n) - 1];
    for (const r of f?.retry ?? []) {
      if (r.invitedAt) continue;
      const mine = byUser.get(r.userId) ?? [];
      // אותה בקשה פעמיים (שני תיקונים לאותה תקלה) — פעם אחת ברשימה
      if (!mine.some((x) => x.r.ask === r.ask)) mine.push({ reviewId, n: Number(ref.n), r });
      else mine.push({ reviewId, n: Number(ref.n), r, dup: true });
      byUser.set(r.userId, mine);
    }
  }
  const sent = [];
  const changed = new Set();
  for (const [userId, items] of byUser) {
    if (!messageUser(userId, retryText(userId, items.filter((x) => !x.dup).map((x) => x.r)), 'retry_invite')) continue;
    const at = D.nowIso();
    for (const x of items) {
      x.r.invitedAt = at;
      changed.add(x.reviewId);
      sent.push({ reviewId: x.reviewId, n: x.n, userId, who: nameOf(userId) });
    }
  }
  for (const id of changed) D.run('UPDATE bot_reviews SET fixes = ? WHERE id = ?', JSON.stringify(reviews.get(id)), id);
  return { sent };
}

const isConfigured = () => Boolean(String(process.env.BOT_REVIEW_KEY ?? '').trim());

/**
 * ✉️ "לענות לה במייל דרך משימון" (הוחלט 11.11.26): הסוקר מכין תשובה לעובד/ת בארגון על הערה שלו/ה, והבוט שולח
 * אותה למנהל בוואטסאפ לאישור — ‎plain_mail‎ — ו"כן" שולח מתיבת ה-Gmail של המנהל, בהמשך לשרשור עם הנמען.
 * בטיחות: הנמען — רק משתמש פעיל במשימון (לפי השם המלא, לא כתובת חופשית); המאשר — רק מנהל מערכת; ושום
 * דבר לא יוצא בלי "כן" שלו.
 */
/*
 * באיזה שרשור לענות (16.11.26: רמז שלא תאם הוצמד לשרשור האחרון — שהיה על נושא אחר לגמרי):
 *   ‎threadId‎ — בדיוק השרשור הזה, רק אם הנמען בו · ‎hint‎ — שרשור שהנושא שלו מכיל את הרמז: מהאחרונים,
 *   ואם לא — חיפוש לפי הנושא (חצי שנה אחורה). לא נמצא — שגיאה; לעולם לא שרשור אחר.
 *   בלי אף אחד מהם — השרשור האחרון עם הנמען (כמו קודם).
 */
async function replyThreadFor(userId, email, { threadId = '', hint = '' } = {}) {
  const mail = String(email).toLowerCase();
  if (threadId) {
    for (const who of Gmail.boxesOf(userId, 'mail')) {
      const ref = await MailThread.threadRef(who, threadId).catch(() => null);
      const people = ref ? [ref.lastFrom, ...(ref.lastTo ?? []), ...(ref.lastCc ?? [])].map((p) => String(p?.email ?? '').toLowerCase()) : [];
      if (ref && people.includes(mail)) return ref;
    }
    throw badRequest('לא נמצא שרשור כזה עם הנמען');
  }
  const threads = await MailThread.recentThreads(userId, email, { max: 5 }).catch(() => []);
  if (!hint) return threads[0] ?? null;
  const has = (x) => String(x.subject ?? '').includes(hint);
  const found = threads.find(has)
    ?? (await MailThread.recentThreads(userId, email, { max: 5, subject: hint, days: 180 }).catch(() => [])).find(has);
  if (!found) throw badRequest(`לא נמצא שרשור עם הנמען שהנושא שלו "${hint}"`);
  return found;
}

async function mailForApproval(body) {
  const approver = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active' AND role IN ('superadmin','admin')", Number(body.userId));
  if (!approver) throw badRequest('המאשר חייב להיות מנהל מערכת פעיל');
  if (!approver.phone) throw badRequest('למאשר אין טלפון — אין לאן לשלוח את האישור');
  const to = D.get("SELECT id, full_name, email FROM users WHERE status = 'active' AND full_name = ?", clean(body.toName, 120));
  if (!to?.email) throw badRequest('הנמען לא נמצא בין המשתמשים הפעילים (לפי השם המלא)');
  const text = clean(body.body, 5000);
  if (!text) throw badRequest('אין תוכן למייל');
  const rt = await replyThreadFor(approver.id, to.email, { threadId: clean(body.threadId, 80), hint: clean(body.threadHint, 120) });
  const replyThread = rt ? { box: rt.box, threadId: rt.threadId, subject: rt.subject, inReplyTo: rt.inReplyTo, references: rt.references } : null;
  const subject = replyThread ? (/^re:/i.test(replyThread.subject) ? replyThread.subject : `Re: ${replyThread.subject}`) : (clean(body.subject, 200) || 'משימון');
  const draft = { kind: 'plain_mail', to: { name: to.full_name, email: to.email }, subject, body: text, replyThread };
  const preview = [
    `✉️ *מייל מוכן לאישור — ל${to.full_name}*`,
    `*נושא:* ${subject}`,
    replyThread ? `↩️ בהמשך לשרשור "${replyThread.subject}"` : null,
    '',
    text,
    '',
    'לשלוח מהמייל שלך? *כן* 👍 · *לא* 👎'
  ].filter((l) => l !== null).join('\n');
  const sent = await pushToUser(approver.id, { text: preview, buttons: [WaUi.BTN.yes, WaUi.BTN.no], draft }, 'send_email', { requested: true });
  // ✉️ ההצעות שהתשובה מדווחת עליהן — מסומנות "הוצעה תשובה", כדי שהסקירה הבאה לא תציע שוב
  if (sent) markReplyProposed(body.fixes);
  return { sent: Boolean(sent), to: to.full_name, subject, inThread: Boolean(replyThread) };
}

/** ‎refs‎: ‎[{ reviewId, n }]‎ — ההצעות שהוצעה עליהן תשובה למי שהעיר */
function markReplyProposed(refs) {
  const now = D.nowIso();
  const byReview = new Map();
  for (const r of Array.isArray(refs) ? refs.slice(0, 50) : []) {
    const id = Number(r?.reviewId); const n = Number(r?.n);
    if (id && n) byReview.set(id, [...(byReview.get(id) ?? []), n]);
  }
  for (const [id, ns] of byReview) {
    const row = D.get('SELECT fixes FROM bot_reviews WHERE id = ?', id);
    if (!row) continue;
    const fixes = parse(row.fixes);
    for (const n of ns) if (fixes[n - 1]) fixes[n - 1].replyProposedAt = now;
    D.run('UPDATE bot_reviews SET fixes = ? WHERE id = ?', JSON.stringify(fixes), id);
  }
}

function register(router) {
  router.post('/api/integrations/bot-review/mail-for-approval', async (req, res) => {
    authenticate(req);
    sendJson(res, 200, await mailForApproval(await readJson(req)));
  });

  router.get('/api/integrations/bot-review/export', async (req, res) => {
    authenticate(req);
    const params = new URL(req.url, 'http://local').searchParams;
    const since = params.get('since') ?? '';
    const out = exportSince(since);
    // 📧 הערות על משימון מהמייל — רק מהתיבה שביקשו (‎mailbox‎). תקלה כאן לא מפילה את הייצוא
    const users = String(params.get('mailbox') ?? '').split(',').map(Number).filter(Boolean);
    out.mail = await mailFeedback(out.since, { users }).catch((err) => ({ mails: [], errors: [err.message] }));
    sendJson(res, 200, out);
  });

  router.post('/api/integrations/bot-review/retry-invite', async (req, res) => {
    authenticate(req);
    const body = await readJson(req);
    sendJson(res, 200, retryInvite(body.fixes));
  });

  router.post('/api/integrations/bot-review/report', async (req, res) => {
    authenticate(req);
    sendJson(res, 200, await sendReport(await readJson(req)));
  });
}

module.exports = { register, mask, exportSince, sendReport, listReviews, setFixStatus, retryInvite, feedback, isConfigured, readAloudUsage, mailFeedback, mailForApproval };
