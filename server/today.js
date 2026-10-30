'use strict';
/**
 * Today — "מה אני צריך לעשות היום?" במקום אחד.
 *
 * שלושה מקורות, ופונקציה אחת שבונה אותם (‎build‎) — היא משמשת גם את המסך
 * וגם את מייל הבוקר, כדי ששניהם יציגו תמיד אותו דבר:
 *   1. משימות — שלי (אחראי או אחראי נוסף), פתוחות, שהיעד שלהן היום או שעבר,
 *      ומשימות מתוזמנות שנפתחות היום.
 *   2. מהמייל — הצעות משימה שעוד לא הוחלט עליהן. כולן "להיום" כברירת מחדל,
 *      עד שהמשתמש מחליט אחרת; מה שלא טופל נשאר גם מחר, תחת "מאתמול".
 *   3. היומן — האירועים של היום מ-Google Calendar.
 *
 * מייל הבוקר: מי שהפעיל אותו מקבל כל בוקר, בימי העבודה שלו, את אותו Today
 * בתיבה — בלי ללחוץ על כלום.
 */
const D = require('./db');
const W = require('./workdays');
const Auth = require('./auth');
const Gmail = require('./gmail');
const Calendar = require('./calendar');
const Recordings = require('./recordings');
const Mailer = require('./mailer');
const MailScan = require('./ai/mail-scan');
const { BRAND, escape, shell, button } = require('./mail-templates');

// מוזרק מ-api.js — אותה צורת משימה שכל המסכים מקבלים
const hooks = { shapeTask: null };
const init = (h) => Object.assign(hooks, h);

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// ---------------------------------------------------------------------------
// בניית ה-Today
// ---------------------------------------------------------------------------

function myOpenTasks(actor) {
  return D.all(
    `SELECT t.* FROM tasks t
      WHERE t.archived = 0
        AND ((t.assignee_type = 'user' AND t.assignee_id = ?)
          OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.assignee_type = 'user' AND ta.assignee_id = ?))`,
    actor.id, actor.id
  ).map((t) => hooks.shapeTask(t, actor)).filter((t) => !t.isFinal);
}

/**
 * @param {object} actor   שחקן מסוג משתמש
 * @param {{fresh?: boolean}} opts   ‎fresh‎ — לעקוף את מטמון היומן
 */
async function build(actor, { fresh = false } = {}) {
  const date = W.todayIL();
  const overdue = [];
  const today = [];

  for (const t of myOpenTasks(actor)) {
    const activates = W.ilDateOf(t.activateAt);
    // משימה מתוזמנת לעתיד — עוד לא קיימת מבחינת היום
    if (activates && activates > date) continue;
    const due = W.ilDateOf(t.dueDate);
    if (due && due < date) overdue.push(t);
    else if (due === date || activates === date) today.push({ ...t, opensToday: activates === date && due !== date });
  }
  overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  today.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || a.title.localeCompare(b.title, 'he'));

  const mailConnected = Gmail.has(actor.id, 'mail');
  const mail = mailConnected
    ? MailScan.listFor(actor.id).pending
      .filter((s) => s.kind === 'task')
      .map((s) => ({ ...s, older: W.ilDateOf(s.createdAt) < date }))
    : [];

  // פגישות שמחכות להחלטה — בוטלה ביומן, או בקשה להזיז. לא תלוי בחיבור המייל
  const meetingDecisions = MailScan.listFor(actor.id).pending.filter((s) => String(s.kind).startsWith('meeting_'));

  let calendar;
  try {
    calendar = await Calendar.eventsForDay(actor.id, date, { fresh });
  } catch (err) {
    calendar = { connected: true, events: [], error: 'היומן אינו זמין כרגע' };
    console.error('[משימון] קריאת היומן נכשלה:', err.message);
  }

  // פגישה שהוקלטה — "📝 סיכום" על השורה. אחרי המטמון של היומן: ההקלטה מתעדכנת מהר ממנו
  const recs = Recordings.forEvents(actor.id, calendar.events.map((e) => e.id));
  if (recs.size) calendar = { ...calendar, events: calendar.events.map((e) => (recs.has(e.id) ? { ...e, recording: recs.get(e.id) } : e)) };

  const now = new Date();
  const upcoming = calendar.events.filter((e) => e.allDay || new Date(e.end) > now);
  const conn = Gmail.publicStatus(actor.id);
  const doneToday = D.get(
    `SELECT COUNT(*) c FROM tasks t
      WHERE t.completed_at >= ? AND ((t.assignee_type = 'user' AND t.assignee_id = ?)
        OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.assignee_type = 'user' AND ta.assignee_id = ?))`,
    W.ilWallToUtc(date, 0, 0).toISOString(), actor.id, actor.id
  ).c;

  return {
    date,
    dateLabel: W.hebrewDate(date),
    isWorkDay: W.isWorkDay(actor.id, date),
    tomorrow: W.nextWorkDay(actor.id, date),
    workDays: W.workDaysOf(actor.id),
    tasks: { overdue, today },
    mail: { connected: mailConnected, items: mail },
    meetings: meetingDecisions,
    calendar,
    google: {
      enabled: Gmail.isEnabled(),
      connected: conn?.state === 'ok',
      state: conn?.state ?? null,
      missing: conn?.missing ?? []
    },
    counts: {
      overdue: overdue.length,
      today: today.length,
      mail: mail.length,
      meetings: meetingDecisions.length,
      events: calendar.events.length,
      upcomingEvents: upcoming.length,
      doneToday,
      total: overdue.length + today.length + mail.length + meetingDecisions.length + upcoming.length
    }
  };
}

/** המונה שעל הכפתור — בלי היומן, כדי שלא ימתין לרשת של Google */
function quickCount(actor) {
  const date = W.todayIL();
  let n = 0;
  for (const t of myOpenTasks(actor)) {
    const activates = W.ilDateOf(t.activateAt);
    if (activates && activates > date) continue;
    const due = W.ilDateOf(t.dueDate);
    if ((due && due <= date) || activates === date) n++;
  }
  if (Gmail.has(actor.id, 'mail')) {
    n += D.get("SELECT COUNT(*) c FROM ai_suggestions WHERE user_id = ? AND status = 'pending' AND kind = 'task'", actor.id).c;
  }
  return n;
}

// ---------------------------------------------------------------------------
// העדפות מייל הבוקר
// ---------------------------------------------------------------------------

const DIGEST_DEFAULTS = { enabled: false, time: '07:00', days: null, skipEmpty: true };

function digestPrefs(userId) {
  const saved = D.userPrefs(userId).todayDigest;
  return { ...DIGEST_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

/** ערכים שהגיעו מהלקוח — כל אחד נבדק; ‎days: null‎ = ימי העבודה שלי */
function cleanDigest(input = {}, current = DIGEST_DEFAULTS) {
  const out = { ...current };
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  if (typeof input.skipEmpty === 'boolean') out.skipEmpty = input.skipEmpty;
  if (input.time !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(input.time));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('שעה לא תקינה');
    out.time = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  if (input.days !== undefined) {
    if (input.days === null) out.days = null;
    else {
      // שבת לעולם לא — גם אם נשלחה
      const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 5).sort();
      out.days = days.length ? days : null;
    }
  }
  return out;
}

const digestDays = (userId, prefs) => prefs.days ?? W.workDaysOf(userId);

// ---------------------------------------------------------------------------
// מייל הבוקר
// ---------------------------------------------------------------------------

function baseUrl() {
  const configured = String(D.getSetting('public_url', '') ?? '').trim() || String(process.env.PUBLIC_URL ?? '').trim();
  return configured.replace(/\/+$/, '');
}

const hhmm = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: W.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const shortDate = (iso) => {
  const d = W.ilDateOf(iso);
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${Number(day)}.${Number(m)}`;
};

function subjectOf(t) {
  const c = t.counts;
  const parts = [
    c.events ? `${c.events} פגישות` : null,
    c.today ? `${c.today} משימות` : null,
    c.overdue ? `${c.overdue} באיחור` : null,
    c.mail ? `${c.mail} מהמייל` : null
  ].filter(Boolean);
  return `☀ Today · ${t.dateLabel} — ${parts.length ? parts.join(', ') : 'יום נקי'}`;
}

function digestEmail(user, t) {
  const root = baseUrl();
  const link = (path) => (root ? `${root}${path}` : null);
  const a = (href, text) => (href
    ? `<a href="${escape(href)}" style="color:${BRAND.ink};text-decoration:none;">${escape(text)}</a>`
    : escape(text));
  const row = (inner, meta = '') => `
            <tr><td style="padding:7px 0;border-bottom:1px solid ${BRAND.border};font-size:14px;">${inner}${meta ? `<div style="color:${BRAND.mute};font-size:12.5px;margin-top:2px;">${meta}</div>` : ''}</td></tr>`;
  const section = (icon, title, rows) => (rows.length ? `
          <div style="margin-top:22px;font-weight:800;font-size:15px;color:${BRAND.tealDark};">${icon} ${escape(title)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}
          </table>` : '');

  const events = t.calendar.events.map((e) => row(
    `<b style="display:inline-block;min-width:52px;">${e.allDay ? 'כל היום' : escape(hhmm(e.start))}</b> ${a(e.link, e.title)}`,
    [e.location ? escape(e.location) : '', e.calendarName ? escape(e.calendarName) : ''].filter(Boolean).join(' · ')
  ));
  const taskRow = (task, late) => row(
    a(link(`/?task=${task.id}`), task.title),
    [task.projectName ? escape(task.projectName) : '',
      late ? `<span style="color:#dc2626;">יעד ${escape(shortDate(task.dueDate))}</span>` : '',
      task.priority === 'urgent' ? '<span style="color:#dc2626;">דחוף</span>' : '',
      task.checklistTotal ? `${task.checklistDone}/${task.checklistTotal} בצ׳קליסט` : ''].filter(Boolean).join(' · ')
  );
  const mail = t.mail.items.map((s) => row(
    a(link('/?view=today'), s.data?.title ?? s.subject),
    `מאת ${escape(s.from.name)}${s.older ? ' · מחכה מאתמול' : ''}`
  ));

  const empty = !t.counts.total && !t.calendar.events.length;
  const bodyHtml = `          <div style="font-size:20px;font-weight:700;margin-bottom:4px;">בוקר טוב ${escape(String(user.full_name).split(' ')[0])},</div>
          <div style="color:${BRAND.soft};">${escape(t.dateLabel)}${empty ? ' — אין כלום ביומן ואין משימות להיום. יום נקי.' : ''}</div>
${!t.calendar.connected ? `          <div style="margin-top:14px;color:${BRAND.mute};font-size:13px;">היומן אינו מחובר — אפשר לחבר אותו ב"החשבון שלי ← חיבור Google".</div>` : ''}
${section('📅', 'היומן', events)}
${section('⚠', `באיחור (${t.tasks.overdue.length})`, t.tasks.overdue.map((x) => taskRow(x, true)))}
${section('✅', `היום (${t.tasks.today.length})`, t.tasks.today.map((x) => taskRow(x, false)))}
${section('📧', `מהמייל — ממתין להחלטה (${t.mail.items.length})`, mail)}
${t.mail.items.length ? `          <div style="color:${BRAND.mute};font-size:12.5px;margin-top:6px;">ההחלטה על כל מייל — משימה להיום, תאריך אחר או "לא משימה" — נעשית במשימון.</div>` : ''}
${root ? button(link('/?view=today'), 'פתיחת Today במשימון') : ''}`;

  const text = [
    `☀ Today — ${t.dateLabel}`,
    '',
    ...(t.calendar.events.length ? ['📅 היומן', ...t.calendar.events.map((e) => `  ${e.allDay ? 'כל היום' : hhmm(e.start)}  ${e.title}`), ''] : []),
    ...(t.tasks.overdue.length ? ['⚠ באיחור', ...t.tasks.overdue.map((x) => `  • ${x.title} (יעד ${shortDate(x.dueDate)})`), ''] : []),
    ...(t.tasks.today.length ? ['✅ היום', ...t.tasks.today.map((x) => `  • ${x.title}`), ''] : []),
    ...(t.mail.items.length ? ['📧 מהמייל — ממתין להחלטה', ...t.mail.items.map((s) => `  • ${s.data?.title ?? s.subject} (מאת ${s.from.name})`), ''] : []),
    ...(root ? [`לפתיחה: ${link('/?view=today')}`] : [])
  ].join('\n');

  return {
    subject: subjectOf(t),
    html: shell({
      title: subjectOf(t),
      bodyHtml,
      footerHtml: `          נשלח כי הפעלת "Today במייל" במשימון. לביטול: החשבון שלי ← Today והקלטה.`
    }),
    text
  };
}

/**
 * שולח את מייל הבוקר למשתמש. מתיבת המערכת (SMTP) כמו כל הודעה של משימון,
 * ואם היא לא מוגדרת — מתיבת ה-Gmail של המשתמש, אליו בלבד.
 *
 * @returns {{sent: boolean, reason?: string}}
 */
async function sendDigest(userId, { force = false } = {}) {
  const user = D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active'", userId);
  if (!user?.email) return { sent: false, reason: 'למשתמש אין כתובת מייל' };
  const actor = Auth.loadActor('user', userId);
  if (!actor) return { sent: false, reason: 'המשתמש אינו פעיל' };

  const t = await build(actor);
  const prefs = digestPrefs(userId);
  if (!force && prefs.skipEmpty && !t.counts.total && !t.calendar.events.length) return { sent: false, reason: 'empty' };

  const message = digestEmail(user, t);
  const orgName = D.getSetting('org_name', 'הארגון');
  if (Mailer.isEnabled()) {
    await Mailer.send({ to: user.email, toName: user.full_name, fromName: `MESIMON · ${orgName}`, ...message });
    return { sent: true, via: 'system' };
  }
  if (Gmail.canSend(userId)) {
    const conn = Gmail.connectionOf(userId);
    const raw = Mailer.buildMessage({
      to: user.email, toName: user.full_name, from: conn.email, fromName: 'MESIMON — Today', ...message
    });
    await Gmail.send(userId, typeof raw === 'string' ? raw : raw.raw);
    return { sent: true, via: 'gmail' };
  }
  return { sent: false, reason: 'אין דרך לשלוח: שליחת מיילים אינה מוגדרת בשרת, ותיבת ה-Gmail שלך אינה מחוברת לשליחה' };
}

// ---------------------------------------------------------------------------
// מתזמן
// ---------------------------------------------------------------------------

// מי שהשרת היה למטה בשעה שלו — מקבל כשהשרת עולה, אבל לא אחרי 11:00
const CATCH_UP_UNTIL = 11 * 60;
let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = W.ilParts();
    const weekday = W.weekdayOf(now.date);
    const rows = D.all(
      `SELECT p.user_id FROM user_prefs p JOIN users u ON u.id = p.user_id
        WHERE p.key = 'todayDigest' AND u.status = 'active'`
    );
    for (const { user_id: userId } of rows) {
      const prefs = digestPrefs(userId);
      if (!prefs.enabled) continue;
      if (D.userPrefs(userId).todayDigestSentOn === now.date) continue;
      if (!digestDays(userId, prefs).includes(weekday)) continue;
      const [h, m] = prefs.time.split(':').map(Number);
      const at = h * 60 + m;
      if (now.minutes < at || now.minutes > Math.max(CATCH_UP_UNTIL, at + 60)) continue;

      // מסומן לפני השליחה: תקלה לא תגרום לנסיון חוזר בכל דקה, ולמייל כפול
      D.setUserPref(userId, 'todayDigestSentOn', now.date);
      try {
        const r = await sendDigest(userId);
        D.setUserPref(userId, 'todayDigestError', r.sent || r.reason === 'empty' ? null : r.reason);
      } catch (err) {
        D.setUserPref(userId, 'todayDigestError', err.message.slice(0, 200));
        console.error(`[משימון] מייל הבוקר למשתמש ${userId} נכשל:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => console.error('[משימון] מתזמן Today נכשל:', err.message)), 60000);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 20000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  init, build, quickCount, digestPrefs, cleanDigest, digestDays, sendDigest, digestEmail, start, stop, tick, DIGEST_DEFAULTS
};
