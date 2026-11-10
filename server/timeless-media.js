'use strict';
/**
 * 🎥 Timeless במשימון — מעבר לרשימת ההקלטות (‎timeless.js‎):
 *
 *   • digest   — הסיכום המובנה של פגישה: החלטות, משימות (מי, עד מתי, איפה בהקלטה),
 *                נקודות פתוחות ומשפט אחד. AI על הסיכום והתמליל, פעם אחת לפגישה.
 *   • ask      — "שאל על הפגישה": תשובה מהתמליל, עם הרגע בהקלטה.
 *   • tasks    — משימות שנפתחו מפגישה (‎timeless_tasks‎), לנגן ולכרטיס המשימה.
 *   • forMeeting — פגישת משימון ↔ הפגישה ב-Timeless (שעה ומשתתפים).
 *   • התראה למזכירות — פגישה מקוונת ביומן של עובד (גם כזו שלא נקבעה במשימון) שהתחילה
 *                ולא מוקלטת ב-Timeless: וואטסאפ והתראה, פעם אחת לפגישה.
 *
 * הרשאות: כל פעולה בשם משתמש עוברת דרך ‎timeless.js‎ (אסימון אישי, או הארגוני — הנהלה
 * הכול, עובד רק פגישות שהשתתף בהן). הבדיקה ברקע משתמשת באסימון הארגוני (או באישי של
 * בעל היומן), ומה שהיא רואה לא חוזר לאף משתמש — רק "מוקלטת / לא".
 */
const fs = require('node:fs');
const Paths = require('./paths');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./db');
const W = require('./workdays');
const Gmail = require('./gmail');
const Timeless = require('./timeless');
const Claude = require('./ai/claude');

const MIN = 60000;
const TZ = 'Asia/Jerusalem';
const CAL = 'https://www.googleapis.com/calendar/v3';
const SKILLS = Paths.SKILLS;

const hooks = { sendWhatsApp: null, botReady: () => false, botAllowed: () => false };
const init = (h) => Object.assign(hooks, h);

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const emailsIn = (text) => (String(text ?? '').match(/[^\s<>"'(),;]+@[^\s<>"'(),;]+/g) ?? []).map((e) => e.toLowerCase());
const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
// תוכן מבחוץ (תמליל, סיכום) — בתוך גבולות עם מזהה אקראי, כנתונים ולא כהוראות
const fence = (label, text) => {
  const n = crypto.randomBytes(6).toString('hex');
  return `<<<${label}-${n}\n${text}\n${label}-${n}>>>`;
};

// ---------------------------------------------------------------------------
// עובדים לפי שם — "מורן" ← מורן אדי
// ---------------------------------------------------------------------------

function matchUser(name) {
  const q = String(name ?? '').trim();
  if (!q) return null;
  const users = D.all("SELECT id, full_name, email FROM users WHERE status = 'active'");
  const exact = users.filter((u) => u.full_name === q);
  if (exact.length === 1) return exact[0];
  const first = q.split(/\s+/)[0];
  const byStart = users.filter((u) => u.full_name.startsWith(q) || u.full_name.split(/\s+/)[0] === first);
  return byStart.length === 1 ? byStart[0] : null;
}

// ---------------------------------------------------------------------------
// הסיכום המובנה
// ---------------------------------------------------------------------------

const DIGEST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['brief', 'decisions', 'tasks', 'open'],
  properties: {
    brief: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    open: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'assignee', 'due', 'quote', 'at'],
        properties: { title: { type: 'string' }, assignee: { type: 'string' }, due: { type: 'string' }, quote: { type: 'string' }, at: { type: 'number' } }
      }
    }
  }
};

/** הטקסט של מסמכי ה-AI ושל התמליל — בשם המשתמש (בדיקת ההרשאה שם) */
async function sources(userId, meetingId, { transcriptChars = 60000 } = {}) {
  const m = await Timeless.meeting(userId, meetingId);
  if (!m) throw Object.assign(new Error('הפגישה לא נמצאה ב-Timeless, או שאין לך גישה אליה.'), { status: 404 });
  let summary = '';
  for (const ref of (m.documents ?? []).slice(0, 4)) {
    try { summary += `${ref.title ? `# ${ref.title}\n` : ''}${await Timeless.document(userId, ref.id, { verified: true })}\n\n`; } catch { /* מסמך שלא נקרא — בלעדיו */ }
  }
  let transcript = '';
  try { transcript = (await Timeless.transcript(userId, meetingId, { maxChars: transcriptChars })).text; } catch { /* בלי תמליל */ }
  return { m, summary: summary.trim(), transcript };
}

/** בצורה שהלקוח מציג: לכל משימה — העובד שזוהה במשימון, אם זוהה */
function shapeDigest(d) {
  return {
    ...d,
    tasks: (d.tasks ?? []).map((t, i) => {
      const u = matchUser(t.assignee);
      return { ...t, key: `t${i}`, at: Math.max(0, Number(t.at) || 0), due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '', assigneeId: u?.id ?? null, assigneeName: u?.full_name ?? t.assignee ?? '' };
    })
  };
}

async function digest(userId, meetingId, { fresh = false } = {}) {
  const id = String(meetingId ?? '').trim();
  // בדיקת הרשאה תמיד — גם כשהסיכום כבר שמור
  const src = await sources(userId, id);
  const cached = !fresh && D.get('SELECT data FROM timeless_digests WHERE meeting_id = ?', id);
  if (cached) return { ...shapeDigest(parseJson(cached.data, {})), cached: true };
  if (!src.summary && !src.transcript) return { brief: '', decisions: [], tasks: [], open: [], empty: true };
  if (!Claude.isEnabled()) return { brief: '', decisions: [], tasks: [], open: [], markdown: src.summary, noAi: true };
  const date = src.m.start ? W.ilDateOf(src.m.start) : '';
  const out = await Claude.json({
    system: fs.readFileSync(path.join(SKILLS, 'timeless-digest.md'), 'utf8'),
    content: [{ type: 'text', text: [
      `הפגישה: ${src.m.title || ''}${date ? ` · תאריך: ${date}` : ''} · משתתפים: ${src.m.participants.join(', ')}`,
      src.summary ? `סיכום ה-AI של Timeless:\n${fence('SUMMARY', src.summary.slice(0, 20000))}` : '',
      src.transcript ? `התמליל:\n${fence('TRANSCRIPT', src.transcript)}` : ''
    ].filter(Boolean).join('\n\n') }],
    schema: DIGEST_SCHEMA,
    effort: 'low'
  });
  const data = {
    brief: String(out.brief ?? '').slice(0, 200),
    decisions: (out.decisions ?? []).slice(0, 8).map((x) => String(x).slice(0, 300)),
    open: (out.open ?? []).slice(0, 8).map((x) => String(x).slice(0, 300)),
    tasks: (out.tasks ?? []).slice(0, 12).map((t) => ({
      title: String(t.title ?? '').slice(0, 200), assignee: String(t.assignee ?? '').slice(0, 80),
      due: String(t.due ?? ''), quote: String(t.quote ?? '').slice(0, 200), at: Number(t.at) || 0
    })).filter((t) => t.title)
  };
  D.run('INSERT OR REPLACE INTO timeless_digests (meeting_id, data, created_at) VALUES (?,?,?)', id, JSON.stringify(data), D.nowIso());
  return shapeDigest(data);
}

const ASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'at'],
  properties: { answer: { type: 'string' }, at: { type: 'number' } }
};

async function ask(userId, meetingId, question) {
  const q = String(question ?? '').trim().slice(0, 500);
  if (!q) throw Object.assign(new Error('מה לשאול?'), { status: 400 });
  if (!Claude.isEnabled()) throw Object.assign(new Error('חיבור ה-AI אינו מוגדר בשרת'), { status: 400 });
  const src = await sources(userId, meetingId, { transcriptChars: 120000 });
  if (!src.transcript && !src.summary) throw Object.assign(new Error('אין לפגישה הזו תמליל או סיכום ב-Timeless'), { status: 404 });
  const out = await Claude.json({
    system: fs.readFileSync(path.join(SKILLS, 'timeless-ask.md'), 'utf8'),
    content: [{ type: 'text', text: [
      `הפגישה: ${src.m.title || ''}`,
      src.summary ? `הסיכום:\n${fence('SUMMARY', src.summary.slice(0, 15000))}` : '',
      src.transcript ? `התמליל:\n${fence('TRANSCRIPT', src.transcript)}` : '',
      `השאלה: ${q}`
    ].filter(Boolean).join('\n\n') }],
    schema: ASK_SCHEMA,
    effort: 'low',
    live: true
  });
  return { answer: String(out.answer ?? '').slice(0, 2000), at: Math.max(0, Number(out.at) || 0) };
}

// ---------------------------------------------------------------------------
// משימות שנפתחו מפגישה
// ---------------------------------------------------------------------------

function linkTasks(meetingId, items) {
  const now = D.nowIso();
  for (const x of items) {
    D.run('INSERT OR IGNORE INTO timeless_tasks (meeting_id, task_id, item, created_at) VALUES (?,?,?,?)', String(meetingId), Number(x.taskId), String(x.item ?? '').slice(0, 40), now);
  }
}

/** המשימות של הפגישה — רק אלה שהמשתמש רשאי לראות (‎canSee‎) */
function tasksOf(meetingId, canSee) {
  const rows = D.all(
    `SELECT t.*, tt.item, c.label AS status_label, c.is_final, u.full_name AS assignee_name
       FROM timeless_tasks tt JOIN tasks t ON t.id = tt.task_id
       LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
       LEFT JOIN users u ON t.assignee_type = 'user' AND u.id = t.assignee_id
      WHERE tt.meeting_id = ? ORDER BY tt.created_at`, String(meetingId));
  return rows.filter((t) => canSee(t)).map((t) => ({
    id: t.id, title: t.title, item: t.item, status: t.status_label ?? t.status, done: Boolean(t.is_final),
    assignee: t.assignee_name ?? '', due: t.due_date ? W.ilDateOf(t.due_date) : ''
  }));
}

// ---------------------------------------------------------------------------
// פגישה ↔ Timeless
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * האם פגישה ב-Timeless היא אותה פגישה: מתחילה עד 20 דקות מהמועד, ושם דומה או
 * משתתף משותף. ‎ev‎: ‎{ start, title, emails: Set }‎
 */
function sameMeeting(tl, ev) {
  const t = new Date(tl.start_time ?? tl.start ?? 0).getTime();
  if (!t || Math.abs(t - new Date(ev.start).getTime()) > 20 * MIN) return false;
  const a = norm(tl.title);
  const b = norm(ev.title);
  if (a && b && (a.includes(b) || b.includes(a))) return true;
  const people = [tl.host, ...(Array.isArray(tl.participants) ? tl.participants : [])]
    .flatMap((p) => (typeof p === 'string' ? emailsIn(p) : [String(p?.email ?? '').toLowerCase()])).filter(Boolean);
  return people.some((e) => ev.emails.has(e));
}

/**
 * הפגישה ב-Timeless של פגישת משימון (לכרטיס המשימה) — בשם המשתמש, רק פגישה שהוא
 * רואה. ‎null‎ — אין (לא הוקלטה, או עוד לא הסתיימה).
 */
async function forMeeting(userId, m) {
  if (!Timeless.isConnected(userId) || new Date(m.start_at).getTime() > Date.now()) return null;
  const date = W.ilDateOf(m.start_at);
  const list = await Timeless.listMeetings(userId, { from: date, to: date, limit: 100, expandDocuments: true });
  const emails = new Set(parseJson(m.attendees, []).map((a) => String(a.email ?? '').toLowerCase()));
  const owner = D.get('SELECT email FROM users WHERE id = ?', m.owner_id)?.email;
  if (owner) emails.add(owner.toLowerCase());
  const ev = { start: m.start_at, title: m.title, emails };
  // ‎listMeetings‎ מחזיר מנורמל: ‎participants‎ כמחרוזות "שם <מייל>"
  return list.find((x) => sameMeeting({ start_time: x.start, title: x.title, participants: x.participants }, ev)) ?? null;
}

// ---------------------------------------------------------------------------
// התראה למזכירות: פגישה מקוונת שהתחילה ולא מוקלטת ב-Timeless
// ---------------------------------------------------------------------------

/** הקישור לפגישה המקוונת: Meet, Zoom, Teams — מהאירוע, מהמיקום או מהתיאור */
function meetingLink(e) {
  const video = (e.conferenceData?.entryPoints ?? []).find((p) => p.entryPointType === 'video' && /^https:\/\//.test(p.uri ?? ''));
  if (video) return video.uri;
  if (/^https:\/\//.test(e.hangoutLink ?? '')) return e.hangoutLink;
  const m = `${e.location ?? ''} ${e.description ?? ''}`.match(/https:\/\/[^\s"'<>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)[^\s"'<>]*/i);
  return m ? m[0] : '';
}

const candidates = new Map(); // ‎key‎ ← ‎{ key, title, start, end, link, owners: Set(userId), emails: Set }‎
let lastScan = 0;

/** מי בודק את היומן של כל עובד: הוא עצמו (חיבור Google), אחרת מזכירה ששיתף איתה */
function readers() {
  const users = D.all("SELECT id, email, full_name, is_secretary FROM users WHERE status = 'active' AND email <> ''");
  const secretaries = users.filter((u) => u.is_secretary && Gmail.has(u.id, 'calendar'));
  return users.map((u) => ({ user: u, via: Gmail.has(u.id, 'calendar') ? [u.id] : secretaries.map((s) => s.id) }));
}

/** כל 5 דקות: הפגישות שמתחילות בחצי השעה הקרובה (או התחילו לפני רבע שעה) */
async function scanCalendars() {
  const timeMin = new Date(Date.now() - 20 * MIN).toISOString();
  const timeMax = new Date(Date.now() + 15 * MIN).toISOString();
  const found = new Map();
  for (const { user, via } of readers()) {
    for (const viaId of via) {
      let items;
      try {
        const page = await Gmail.googleCall(viaId, `${CAL}/calendars/${encodeURIComponent(viaId === user.id ? 'primary' : user.email)}/events`, {
          timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 50
        });
        items = page.items ?? [];
      } catch { continue; } // לא שיתף עם המזכירה הזו — הבאה בתור
      for (const e of items) {
        if (e.status === 'cancelled' || !e.start?.dateTime || e.transparency === 'transparent') continue;
        if ((e.attendees ?? []).find((a) => a.self)?.responseStatus === 'declined') continue;
        const link = meetingLink(e);
        if (!link) continue; // פגישה פרונטלית — Timeless לא מצטרף אליה
        const start = new Date(e.start.dateTime).toISOString();
        const key = `${e.iCalUID ?? e.id}|${start}`;
        const hit = found.get(key) ?? {
          key, title: e.visibility === 'private' ? 'פגישה פרטית' : e.summary ?? '(ללא כותרת)', start,
          end: new Date(e.end?.dateTime ?? start).toISOString(), link, owners: new Set(), emails: new Set()
        };
        hit.owners.add(user.id);
        hit.emails.add(user.email.toLowerCase());
        for (const a of e.attendees ?? []) if (a.email && !a.resource) hit.emails.add(a.email.toLowerCase());
        found.set(key, hit);
      }
      break;
    }
  }
  candidates.clear();
  for (const [k, v] of found) candidates.set(k, v);
}

const dayCache = new Map(); // ‎token|date‎ ← ‎{ at, list }‎
async function timelessDay(token, date) {
  const k = `${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}|${date}`;
  const hit = dayCache.get(k);
  if (hit && Date.now() - hit.at < MIN) return hit.list;
  const list = await Timeless.meetingsOnDay(token, date);
  dayCache.set(k, { at: Date.now(), list });
  for (const [key, v] of dayCache) if (Date.now() - v.at > 10 * MIN) dayCache.delete(key);
  return list;
}

/** ‎true‎ — מוקלטת; ‎false‎ — לא; ‎null‎ — אי אפשר לדעת (אין אסימון, Timeless לא ענה) */
async function isRecorded(c) {
  const date = W.ilDateOf(c.start);
  const tokens = [...new Set([...c.owners].map((id) => Timeless.backgroundToken(id)).filter(Boolean))];
  if (!tokens.length) return null;
  let answered = false;
  for (const token of tokens) {
    let list;
    try { list = await timelessDay(token, date); answered = true; } catch (err) {
      console.error('[משימון] Timeless — בדיקת הקלטה נכשלה:', err.message);
      continue;
    }
    if (list.some((tl) => tl.status !== 'failed' && sameMeeting(tl, c))) return true;
  }
  return answered ? false : null;
}

const hhmm = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

function alertText(c) {
  const owners = [...c.owners].map((id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name).filter(Boolean);
  return [
    `🎥 שימו לב: הפגישה "${c.title}" התחילה ולא מוקלטת ב-Timeless`,
    `${hhmm(c.start)}–${hhmm(c.end)}${owners.length ? ` · ${owners.slice(0, 4).join(', ')}${owners.length > 4 ? ` +${owners.length - 4}` : ''}` : ''}`,
    'נא להיכנס ל-Timeless ולהכניס את קישור הפגישה, כדי שתוקלט ותסוכם:',
    c.link,
    'Timeless: https://my.timeless.day'
  ].join('\n');
}

async function sendAlert(c) {
  const text = alertText(c);
  let to = D.all("SELECT id, phone FROM users WHERE status = 'active' AND is_secretary = 1");
  if (!to.length) to = D.all("SELECT id, phone FROM users WHERE status = 'active' AND role IN ('superadmin','admin')");
  const wa = hooks.botReady() && hooks.botAllowed();
  const sent = new Set();
  for (const u of to) {
    D.notify({ targetType: 'user', targetId: u.id, kind: 'meeting', title: text.split('\n')[0], body: text.split('\n').slice(1).join(' · ') });
    if (wa && u.phone && !sent.has(u.phone)) {
      sent.add(u.phone);
      try { await hooks.sendWhatsApp(`${u.phone}@c.us`, text); } catch (err) { console.error('[משימון] התראת Timeless בוואטסאפ נכשלה:', err.message); }
    }
  }
}

let warnedNoToken = '';
async function checkUnrecorded() {
  if (!D.getSetting('timeless_unrecorded_alert', true)) return;
  // אין שום חיבור ל-Timeless — אין מה לבדוק, ולא קוראים את היומנים לשווא
  if (!Timeless.hasOrgToken() && !D.get("SELECT 1 FROM user_channels WHERE provider = 'timeless' AND api_token <> '' AND state <> 'revoked' LIMIT 1")) return;
  if (Date.now() - lastScan > 5 * MIN) {
    lastScan = Date.now();
    await scanCalendars();
  }
  const delay = Math.max(0, Math.min(30, Number(D.getSetting('timeless_unrecorded_delay', 2)) || 0)) * MIN;
  const now = Date.now();
  for (const c of candidates.values()) {
    const start = new Date(c.start).getTime();
    if (now < start + delay || now > start + delay + 15 * MIN || now > new Date(c.end).getTime()) continue;
    if (D.get('SELECT 1 FROM timeless_alerts WHERE event_key = ?', c.key)) continue;
    const recorded = await isRecorded(c);
    if (recorded === null) {
      // אין דרך לבדוק — פעם ביום לוג, בלי להציף את המזכירות בהודעות שאולי שגויות
      const day = W.todayIL();
      if (warnedNoToken !== day) { warnedNoToken = day; console.warn('[משימון] Timeless: אין אסימון ארגוני (TIMELESS_ACCESS_TOKEN) — אי אפשר לבדוק אם פגישות מוקלטות'); }
      continue;
    }
    D.run('INSERT OR IGNORE INTO timeless_alerts (event_key, at) VALUES (?,?)', c.key, D.nowIso());
    if (!recorded) await sendAlert(c);
  }
  D.run('DELETE FROM timeless_alerts WHERE at < ?', new Date(Date.now() - 3 * 24 * 60 * MIN).toISOString());
}

let timer = null;
let running = false;
function start() {
  if (timer) clearInterval(timer);
  const tick = async () => {
    if (running) return;
    running = true;
    try { await checkUnrecorded(); } catch (err) { console.error('[משימון] בדיקת הקלטות Timeless נכשלה:', err.message); } finally { running = false; }
  };
  timer = setInterval(tick, MIN);
  timer.unref?.();
}

module.exports = {
  init, start, digest, ask, linkTasks, tasksOf, forMeeting, matchUser, fmtTime,
  _internal: { sameMeeting, meetingLink, alertText, checkUnrecorded, candidates }
};
