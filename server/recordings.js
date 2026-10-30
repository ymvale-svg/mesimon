'use strict';
/**
 * 🎥 הקלטת פגישות Zoom — מהיומן, דרך המקליט, לדרייב ולמשימות.
 *
 * הזרימה:
 *   1. סריקה (כל 5 דקות): היומנים של כל העובדים, 26 שעות קדימה. כל אירוע עם
 *      קישור Zoom הופך לשורה ב-‎recordings‎ — אחת לפגישה, גם אם היא ביומנים של
 *      כמה עובדים. מי שהפגישה ביומן שלו, ומשתתף מהארגון לפי המייל — רשאי לראות.
 *   2. תזמון: לכל פגישה — מקליט וירטואלי (‎recall.js‎) שנכנס דקה לפני ההתחלה.
 *      פגישה שבוטלה או הוזזה ביומן — המקליט מבוטל (המועד החדש = פגישה חדשה).
 *   3. אחרי הפגישה: התמלול, והווידאו לדרייב הייעודי של החברה (‎gdrive.js‎) —
 *      תיקייה לכל פגישה: הווידאו והתמלול.
 *   4. ה-AI (‎skills/meeting-summary.md‎): סיכום אופרטיבי, החלטות, ומה כל אחד
 *      צריך לעשות. כל משימה שזוהה לה אחראי מהארגון — הצעה ב"ממתין לאישורך"
 *      שלו. שום משימה לא נוצרת בלי אישור.
 *   5. כל המשתתפים מהחברה מקבלים התראה: הסיכום מוכן. בממשק — "🎥 הפגישות שלי",
 *      וכפתור "📝 סיכום" על הפגישה ב-Today.
 *
 * מה לא מוקלט: עובד שביטל את ההקלטה לעצמו (ברירת המחדל — בהגדרות), פגישה
 * שאחד המשתתפים מהחברה לחץ עליה "לא להקליט", פגישה שבכותרת או בתיאור שלה
 * ‎#ללא-הקלטה‎ או ‎#norecord‎, ופגישה חיצונית כשההגדרה כבויה.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const D = require('./db');
const W = require('./workdays');
const Gmail = require('./gmail');
const Recall = require('./recall');
const Drive = require('./gdrive');
const Claude = require('./ai/claude');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TZ = 'Asia/Jerusalem';
const LOOKAHEAD = 26 * HOUR;
const SKILL = path.join(__dirname, 'ai', 'skills', 'meeting-summary.md');
const LOCAL_DIR = path.join(D.UPLOADS_DIR, 'recordings');
const MAX_ATTEMPTS = 6;
const MAX_TRANSCRIPT = 400000;

const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const setting = (key) => D.getSetting(key, D.DEFAULT_SETTINGS[key]);

const isConfigured = () => Recall.isEnabled();
const isActive = () => isConfigured() && Boolean(setting('recorder_enabled'));

// ---------------------------------------------------------------------------
// קישורי Zoom מתוך אירוע ביומן
// ---------------------------------------------------------------------------

const ZOOM_RE = /https:\/\/(?:[\w-]+\.)*zoom\.(?:us|com)\/(?:j|my|w|s|wc\/join)\/[^\s"'<>)\]\\]+/i;
const NO_RECORD_RE = /#(?:ללא[-_ ]?הקלטה|no-?record)/i;

/** הקישור הראשון ל-Zoom: מהשיחה המצורפת, מהמיקום, ואחרון — מהתיאור (HTML) */
function zoomLinkOf(e) {
  const sources = [
    ...(e.conferenceData?.entryPoints ?? []).filter((p) => p.entryPointType === 'video').map((p) => p.uri),
    e.location,
    e.description
  ];
  for (const s of sources) {
    const m = String(s ?? '').replace(/&amp;/g, '&').match(ZOOM_RE);
    if (m) return m[0].replace(/[.,;:!?]+$/, '');
  }
  return null;
}

/** מספר הפגישה — אותה פגישה מופיעה ביומנים שונים עם קישורים שונים מעט (סיסמה, דומיין) */
const meetingNumber = (url) => String(url).match(/\/(?:j|w|s|wc\/join)\/(\d{9,12})/)?.[1] ?? null;
const dedupeKey = (url, startIso) => `${meetingNumber(url) ?? String(url).split('?')[0].toLowerCase()}|${new Date(startIso).toISOString()}`;

// ---------------------------------------------------------------------------
// מי רואה, ומי רוצה הקלטה
// ---------------------------------------------------------------------------

const activeUsers = () => D.all("SELECT id, full_name, email FROM users WHERE status = 'active' AND role <> 'vendor' AND email IS NOT NULL AND trim(email) <> ''");
const userByEmail = (email) => D.get("SELECT id, full_name, email FROM users WHERE lower(email) = ? AND status = 'active' AND role <> 'vendor'", String(email ?? '').toLowerCase());

function wantsRecording(userId) {
  const pref = D.userPrefs(userId).recordMeetings;
  return typeof pref === 'boolean' ? pref : Boolean(setting('recorder_default_on'));
}

const recordingById = (id) => D.get('SELECT * FROM recordings WHERE id = ?', id);
const canSee = (userId, recId) => Boolean(D.get('SELECT 1 FROM recording_access WHERE recording_id = ? AND user_id = ?', recId, userId));
const participants = (recId) => D.all(
  `SELECT u.id, u.full_name, u.email, u.phone FROM recording_access a JOIN users u ON u.id = a.user_id
    WHERE a.recording_id = ? AND u.status = 'active'`, recId
);

function grantAccess(recId, userId, eventId = null) {
  D.run(
    `INSERT INTO recording_access (recording_id, user_id, event_id) VALUES (?,?,?)
     ON CONFLICT(recording_id, user_id) DO UPDATE SET event_id = COALESCE(excluded.event_id, recording_access.event_id)`,
    recId, userId, eventId
  );
}

// ---------------------------------------------------------------------------
// 1. סריקת היומנים
// ---------------------------------------------------------------------------

/** אירועי היומן של עובד — בחיבור שלו, ואם לא חיבר — דרך חשבון השירות של הארגון */
async function upcomingEvents(user, timeMin, timeMax) {
  const params = { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 250, timeZone: TZ };
  if (Gmail.has(user.id, 'calendar')) {
    return (await Gmail.googleCall(user.id, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', params)).items ?? [];
  }
  if (Drive.delegationEnabled()) return (await Drive.calendarEvents(user.email, params)).items ?? [];
  return null; // אין דרך לקרוא את היומן שלו
}

/**
 * @returns {{scanned: number, unreachable: number, found: number}}
 */
async function discover() {
  const now = Date.now();
  const timeMin = new Date(now - 15 * MIN).toISOString();
  const timeMax = new Date(now + LOOKAHEAD).toISOString();
  const external = Boolean(setting('recorder_external_meetings'));
  const seen = new Set();
  const failedUsers = new Set();
  const out = { scanned: 0, unreachable: 0, found: 0 };

  for (const user of activeUsers()) {
    let items;
    try {
      items = await upcomingEvents(user, timeMin, timeMax);
    } catch (err) {
      failedUsers.add(user.id);
      console.error(`[משימון] קריאת היומן של ${user.full_name} להקלטות נכשלה:`, err.message);
      continue;
    }
    if (items === null) { out.unreachable++; continue; }
    out.scanned++;

    for (const e of items) {
      if (e.status === 'cancelled' || !e.start?.dateTime) continue;
      const self = (e.attendees ?? []).find((a) => a.self || String(a.email).toLowerCase() === user.email.toLowerCase());
      if (self?.responseStatus === 'declined') continue;
      const url = zoomLinkOf(e);
      if (!url) continue;

      const organizer = String(e.organizer?.email ?? '').toLowerCase();
      if (!external && !userByEmail(organizer)) continue;
      const key = dedupeKey(url, e.start.dateTime);
      seen.add(key);

      const hidden = e.visibility === 'private' || e.visibility === 'confidential';
      const attendees = (e.attendees ?? []).filter((a) => !a.resource).map((a) => ({ email: String(a.email ?? '').toLowerCase(), name: a.displayName ?? '' }));
      let rec = D.get('SELECT * FROM recordings WHERE dedupe_key = ?', key);
      if (!rec) {
        const ts = D.nowIso();
        const r = D.run(
          `INSERT INTO recordings (dedupe_key, title, join_url, start_at, end_at, organizer_email, attendees, status, seen_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?, 'scheduled', ?,?,?)`,
          key, hidden ? 'פגישה פרטית' : String(e.summary ?? '').trim() || 'פגישת Zoom', url,
          new Date(e.start.dateTime).toISOString(), new Date(e.end?.dateTime ?? e.start.dateTime).toISOString(),
          organizer, JSON.stringify(attendees), ts, ts, ts
        );
        rec = recordingById(Number(r.lastInsertRowid));
        out.found++;
      } else {
        D.run('UPDATE recordings SET seen_at = ?, end_at = ? WHERE id = ?', D.nowIso(), new Date(e.end?.dateTime ?? e.start.dateTime).toISOString(), rec.id);
      }
      grantAccess(rec.id, user.id, e.id);
      // משתתפים מהארגון — גם אם היומן שלהם לא נקרא
      for (const a of attendees) {
        const u = userByEmail(a.email);
        if (u) grantAccess(rec.id, u.id);
      }
      // ‎#ללא-הקלטה‎ בפגישה, או עובד שביטל לעצמו — לא מקליטים, גם אם המקליט כבר תוזמן
      if (rec.status === 'scheduled') {
        const optedOut = participants(rec.id).find((p) => !wantsRecording(p.id));
        const reason = NO_RECORD_RE.test(`${e.summary ?? ''} ${e.description ?? ''}`) ? 'הפגישה סומנה ‎#ללא-הקלטה‎'
          : optedOut ? `${optedOut.full_name} ביטל/ה הקלטה של הפגישות שלו/ה` : '';
        if (reason) {
          await cancelBot(recordingById(rec.id));
          markSkipped(rec.id, optedOut && !NO_RECORD_RE.test(`${e.summary ?? ''} ${e.description ?? ''}`) ? optedOut.id : null, reason);
        }
      }
    }
  }

  // פגישה מתוזמנת שנעלמה מכל היומנים שנקראו — בוטלה או הוזזה
  for (const rec of D.all("SELECT * FROM recordings WHERE status = 'scheduled' AND start_at > ? AND start_at < ?", new Date(now).toISOString(), timeMax)) {
    if (seen.has(rec.dedupe_key)) continue;
    const owners = D.all('SELECT user_id FROM recording_access WHERE recording_id = ? AND event_id IS NOT NULL', rec.id).map((r) => r.user_id);
    if (owners.some((id) => failedUsers.has(id))) continue; // לא בטוח — היומן לא נקרא הפעם
    await cancelBot(rec);
    D.run("UPDATE recordings SET status = 'cancelled', error = 'הפגישה בוטלה או הוזזה ביומן', updated_at = ? WHERE id = ?", D.nowIso(), rec.id);
  }
  return out;
}

function markSkipped(recId, byUserId, reason) {
  D.run("UPDATE recordings SET status = 'skipped', skipped_by = ?, error = ?, updated_at = ? WHERE id = ?", byUserId, reason, D.nowIso(), recId);
}

async function cancelBot(rec) {
  if (!rec.bot_id) return;
  try { await Recall.cancel(rec.bot_id); } catch (err) { console.error('[משימון] ביטול המקליט נכשל:', err.message); }
  D.run('UPDATE recordings SET bot_id = NULL WHERE id = ?', rec.id);
}

// ---------------------------------------------------------------------------
// 2. תזמון המקליטים
// ---------------------------------------------------------------------------

async function scheduleBots() {
  const now = Date.now();
  const due = D.all(
    "SELECT * FROM recordings WHERE status = 'scheduled' AND bot_id IS NULL AND start_at < ? AND end_at > ?",
    new Date(now + 24 * HOUR).toISOString(), new Date(now).toISOString()
  );
  for (const rec of due) {
    try {
      const bot = await Recall.createBot({
        meetingUrl: rec.join_url,
        joinAt: new Date(new Date(rec.start_at).getTime() - MIN).toISOString(),
        botName: setting('recorder_bot_name'),
        message: setting('recorder_join_message'),
        language: setting('recorder_language'),
        metadata: { mesimon_recording: rec.id }
      });
      D.run("UPDATE recordings SET bot_id = ?, bot_status = 'scheduled', error = '', updated_at = ? WHERE id = ?", bot.id, D.nowIso(), rec.id);
    } catch (err) {
      const attempts = rec.attempts + 1;
      D.run('UPDATE recordings SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?',
        attempts, err.message, attempts >= MAX_ATTEMPTS ? 'failed' : 'scheduled', D.nowIso(), rec.id);
      console.error(`[משימון] תזמון המקליט לפגישה "${rec.title}" נכשל:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. מעקב, והתוצרים
// ---------------------------------------------------------------------------

async function poll() {
  const live = D.all(
    "SELECT * FROM recordings WHERE bot_id IS NOT NULL AND status IN ('scheduled','joining','recording','processing') AND start_at < ?",
    new Date(Date.now() + 2 * MIN).toISOString()
  );
  for (const rec of live) {
    let bot;
    try {
      bot = await Recall.getBot(rec.bot_id);
    } catch (err) {
      console.error(`[משימון] מצב המקליט בפגישה "${rec.title}" אינו זמין:`, err.message);
      continue;
    }
    if (bot.state === 'failed') {
      D.run("UPDATE recordings SET status = 'failed', bot_status = ?, error = ?, updated_at = ? WHERE id = ?", bot.code, bot.reason, D.nowIso(), rec.id);
      notifyParticipants(recordingById(rec.id), { title: `⚠️ הפגישה "${rec.title}" לא הוקלטה`, body: bot.reason });
      continue;
    }
    const status = bot.state === 'joining' || bot.state === 'recording' ? bot.state : bot.state === 'scheduled' ? 'scheduled' : 'processing';
    D.run('UPDATE recordings SET status = ?, bot_status = ?, updated_at = ? WHERE id = ?', status, bot.code, D.nowIso(), rec.id);
    if (bot.state === 'done') await processRecording(recordingById(rec.id), bot);
  }
}

const inFlight = new Set();

/**
 * כל שלב נשמר מיד, וריצה חוזרת מדלגת על מה שכבר נעשה — תקלה באמצע (הדרייב,
 * ה-AI) אינה מאבדת את מה שהצליח, והסבב הבא ממשיך מאותה נקודה.
 */
async function processRecording(rec, bot = null) {
  if (inFlight.has(rec.id)) return;
  inFlight.add(rec.id);
  try {
    bot = bot ?? (rec.bot_id ? await Recall.getBot(rec.bot_id) : null);
    if (bot && bot.state !== 'done') return; // השיחה עוד לא נגמרה, או שהתוצרים בעיבוד אצל Recall

    // התמלול
    if (!rec.transcript && bot?.transcriptUrl) {
      const text = (await Recall.transcriptText(bot.transcriptUrl)).slice(0, MAX_TRANSCRIPT);
      D.run('UPDATE recordings SET transcript = ? WHERE id = ?', text, rec.id);
    } else if (!rec.transcript && bot?.transcriptState === 'processing') {
      return; // עוד לא מוכן — בסבב הבא
    }

    // הווידאו — קודם לדיסק, ומשם לדרייב (העלאה לדרייב דורשת גודל ידוע)
    rec = recordingById(rec.id);
    if (!rec.drive_video_id && !rec.local_video && bot?.videoUrl) await saveVideo(rec, bot.videoUrl);
    rec = recordingById(rec.id);
    if (!rec.drive_video_id && rec.local_video && driveFolder()) await toDrive(rec);

    // הסיכום וההצעות
    rec = recordingById(rec.id);
    if (!rec.summary && rec.transcript && Claude.isEnabled()) await summarize(rec);

    rec = recordingById(rec.id);
    D.run("UPDATE recordings SET status = 'done', error = ?, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?",
      rec.transcript ? '' : 'לא התקבל תמלול — אין סיכום', D.nowIso(), D.nowIso(), rec.id);
    announce(recordingById(rec.id));
  } catch (err) {
    const attempts = rec.attempts + 1;
    D.run('UPDATE recordings SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?',
      attempts, err.message, attempts >= MAX_ATTEMPTS ? 'failed' : 'processing', D.nowIso(), rec.id);
    console.error(`[משימון] עיבוד ההקלטה "${rec.title}" נכשל:`, err.message);
  } finally {
    inFlight.delete(rec.id);
  }
}

const driveFolder = () => Drive.isEnabled() ? Drive.folderIdOf(setting('recorder_drive_folder')) : '';
const localPath = (name) => path.join(LOCAL_DIR, path.basename(name));

async function saveVideo(rec, url) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const name = `recording-${rec.id}.mp4`;
  const video = await Recall.openVideo(url);
  await pipeline(Readable.fromWeb(video.body), fs.createWriteStream(localPath(name)));
  D.run('UPDATE recordings SET local_video = ?, video_size = ? WHERE id = ?', name, fs.statSync(localPath(name)).size, rec.id);
}

/** שם התיקייה בדרייב: "2026-10-30 14:00 — ישיבת שיווק" — ממוין לפי הזמן */
function folderName(rec) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(rec.start_at)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}.${p.minute} — ${rec.title}`.replace(/[\\/]/g, '-');
}

async function toDrive(rec) {
  const folder = rec.drive_folder_id ?? (await Drive.createFolder(folderName(rec), driveFolder())).id;
  D.run('UPDATE recordings SET drive_folder_id = ? WHERE id = ?', folder, rec.id);
  const file = localPath(rec.local_video);
  const up = await Drive.upload({ name: 'הקלטה.mp4', mimeType: 'video/mp4', parentId: folder, filePath: file });
  if (rec.transcript && !rec.drive_transcript_id) {
    const t = await Drive.upload({ name: 'תמלול.txt', mimeType: 'text/plain', parentId: folder, body: Buffer.from(rec.transcript, 'utf8') }).catch(() => null);
    if (t) D.run('UPDATE recordings SET drive_transcript_id = ? WHERE id = ?', t.id, rec.id);
  }
  D.run('UPDATE recordings SET drive_video_id = ?, drive_video_link = ?, local_video = NULL WHERE id = ?', up.id, up.link, rec.id);
  // הדרייב הוא מקור האמת — העותק המקומי תופס מקום בדיסק של השרת
  fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------------------
// 4. הסיכום וההצעות
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'decisions', 'action_items', 'open_questions'],
  properties: {
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'details', 'owner_name', 'owner_email', 'due_date', 'priority', 'quote'],
        properties: {
          title: { type: 'string' },
          details: { type: 'string' },
          owner_name: { type: 'string' },
          owner_email: { type: 'string' },
          due_date: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
          quote: { type: 'string' }
        }
      }
    }
  }
};

/** האחראי: לפי המייל שה-AI בחר מהרשימה, ואם אין — שם מלא, ואחריו שם פרטי יחיד בין המשתתפים */
function resolveOwner(item, people, everyone) {
  const byEmail = item.owner_email && everyone.find((u) => u.email.toLowerCase() === String(item.owner_email).toLowerCase());
  if (byEmail) return byEmail;
  const name = String(item.owner_name ?? '').trim();
  if (!name) return null;
  const full = everyone.filter((u) => u.full_name === name);
  if (full.length === 1) return full[0];
  const first = name.split(/\s+/)[0];
  const among = (list) => list.filter((u) => u.full_name.split(/\s+/)[0] === first);
  const inMeeting = among(people);
  if (inMeeting.length === 1) return inMeeting[0];
  const inOrg = among(everyone);
  return inOrg.length === 1 ? inOrg[0] : null;
}

async function summarize(rec) {
  const people = participants(rec.id);
  const everyone = activeUsers();
  const attendees = parseJson(rec.attendees, []);
  const ymd = W.ilDateOf(rec.start_at);
  const text = [
    `הפגישה: ${rec.title}`,
    `מתי: ${ymd} (${W.hebrewDate(ymd)})`,
    `המארגן: ${rec.organizer_email || 'לא ידוע'}`,
    '',
    'משתתפים מהחברה (שם · מייל):',
    ...people.map((p) => `- ${p.full_name} · ${p.email}`),
    attendees.length ? '\nמוזמנים לפי היומן:' : '',
    ...attendees.filter((a) => !people.some((p) => p.email.toLowerCase() === a.email)).map((a) => `- ${a.name || a.email}${a.name ? ` · ${a.email}` : ''}`),
    '',
    'כל העובדים בחברה (לזיהוי מי שהוזכר בשמו):',
    everyone.map((u) => `${u.full_name} · ${u.email}`).join('\n'),
    '',
    'התמלול:',
    '<<<',
    rec.transcript,
    '>>>'
  ].join('\n');

  const out = await Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text }], schema: SCHEMA, effort: 'medium' });
  const organizer = userByEmail(rec.organizer_email) ?? people[0] ?? null;

  const items = (out.action_items ?? []).slice(0, 30).map((it, i) => {
    const owner = resolveOwner(it, people, everyone);
    return {
      index: i + 1,
      title: String(it.title ?? '').trim().slice(0, 120),
      details: String(it.details ?? '').trim().slice(0, 1500),
      ownerName: owner?.full_name ?? String(it.owner_name ?? '').trim(),
      ownerId: owner?.id ?? null,
      external: !owner && Boolean(String(it.owner_name ?? '').trim()),
      dueDate: W.isDate(it.due_date) ? it.due_date : '',
      priority: ['normal', 'high', 'urgent'].includes(it.priority) ? it.priority : 'normal',
      quote: String(it.quote ?? '').trim().slice(0, 400),
      suggestionId: null
    };
  }).filter((it) => it.title);

  // הצעה לכל משימה: לאחראי מהארגון; משימה בלי אחראי ברור — למארגן, עם אזהרה
  for (const it of items) {
    const target = it.ownerId ?? organizer?.id;
    if (!target) continue;
    const warning = it.ownerId ? ''
      : it.external ? `בפגישה נאמר שזה על ${it.ownerName} — לא עובד/ת בחברה. אולי מעקב מולו/ה?`
        : 'לא נאמר בפגישה מי אחראי — הוצע למארגן/ת';
    const data = {
      source: 'meeting',
      recordingId: rec.id,
      meetingTitle: rec.title,
      title: it.title,
      summary: [it.details, it.quote ? `\nמהפגישה: "${it.quote}"` : ''].join('').trim(),
      checklist: [],
      dueDate: it.dueDate,
      priority: it.priority,
      meeting: false,
      people: [],
      ambiguous: [],
      aiRequest: null,
      warning,
      receivedAt: rec.end_at
    };
    const r = D.run(
      `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
       VALUES (?, 'task', 'pending', '', ?, ?, '', ?, ?, ?, ?)`,
      target, `rec:${rec.id}:${it.index}`, rec.title, it.title, rec.end_at, JSON.stringify(data), D.nowIso()
    );
    it.suggestionId = Number(r.lastInsertRowid);
    it.suggestedTo = target;
  }

  const summary = {
    summary: String(out.summary ?? '').trim(),
    decisions: (out.decisions ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
    openQuestions: (out.open_questions ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
    actionItems: items,
    model: Claude.model(),
    at: D.nowIso()
  };
  D.run('UPDATE recordings SET summary = ? WHERE id = ?', JSON.stringify(summary), rec.id);
}

// ---------------------------------------------------------------------------
// 5. התראות
// ---------------------------------------------------------------------------

function notifyParticipants(rec, { title, body }) {
  for (const p of participants(rec.id)) D.notify({ targetType: 'user', targetId: p.id, kind: 'meeting', title, body });
}

const announced = new Set();
function announce(rec) {
  if (announced.has(rec.id)) return;
  announced.add(rec.id);
  const summary = parseJson(rec.summary, null);
  for (const p of participants(rec.id)) {
    const mine = (summary?.actionItems ?? []).filter((it) => it.suggestedTo === p.id).length;
    D.notify({
      targetType: 'user', targetId: p.id, kind: 'meeting',
      title: `🎥 ${summary ? 'הסיכום של' : 'ההקלטה של'} "${rec.title}" מוכן${summary ? '' : 'ה'}`,
      body: [
        summary?.summary ? summary.summary.slice(0, 140) : null,
        mine ? `${mine === 1 ? 'משימה אחת מחכה' : `${mine} משימות מחכות`} לאישורך ב"ממתין לאישורך"` : null
      ].filter(Boolean).join(' · ') || 'ב"🎥 הפגישות שלי"'
    });
  }
}

// ---------------------------------------------------------------------------
// תצוגה ופעולות משתמש
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  scheduled: 'תוקלט', joining: 'המקליט נכנס', recording: '🔴 מקליט עכשיו', processing: 'בעיבוד',
  done: 'מוכן', failed: 'לא הוקלטה', cancelled: 'בוטלה', skipped: 'לא תוקלט'
};

function shape(rec, viewerId, { full = false } = {}) {
  const summary = parseJson(rec.summary, null);
  const base = {
    id: rec.id,
    title: rec.title,
    start: rec.start_at,
    end: rec.end_at,
    status: rec.status,
    statusLabel: STATUS_LABEL[rec.status] ?? rec.status,
    error: rec.error,
    joinUrl: ['scheduled', 'joining', 'recording'].includes(rec.status) ? rec.join_url : null,
    hasVideo: Boolean(rec.drive_video_id || rec.local_video),
    driveLink: rec.drive_video_link ?? null,
    hasTranscript: Boolean(rec.transcript),
    hasSummary: Boolean(summary),
    headline: summary?.summary ? summary.summary.slice(0, 220) : '',
    myTasks: (summary?.actionItems ?? []).filter((it) => it.suggestedTo === viewerId).length,
    canSkip: rec.status === 'scheduled' && new Date(rec.start_at).getTime() > Date.now() - 5 * MIN,
    canRestore: rec.status === 'skipped' && rec.skipped_by === viewerId && new Date(rec.end_at).getTime() > Date.now()
  };
  if (!full) return base;
  const states = new Map((summary?.actionItems ?? []).filter((it) => it.suggestionId)
    .map((it) => [it.suggestionId, D.get('SELECT status, task_id FROM ai_suggestions WHERE id = ?', it.suggestionId)]));
  return {
    ...base,
    participants: participants(rec.id).map((p) => ({ id: p.id, name: p.full_name })),
    attendees: parseJson(rec.attendees, []),
    summary: summary ? {
      text: summary.summary,
      decisions: summary.decisions,
      openQuestions: summary.openQuestions,
      at: summary.at,
      actionItems: summary.actionItems.map((it) => {
        const s = states.get(it.suggestionId);
        return {
          title: it.title, details: it.details, owner: it.ownerName, ownerId: it.ownerId, dueDate: it.dueDate, quote: it.quote,
          mine: it.suggestedTo === viewerId,
          // מה שהעובד החליט על ההצעה — נראה רק לו ולכולם: "נוצרה משימה"
          state: s?.status ?? null,
          taskId: s?.task_id ?? null,
          suggestionId: it.suggestedTo === viewerId ? it.suggestionId : null
        };
      })
    } : null
  };
}

/** הפגישות שלי: שעברו (עם הקלטה, או שניסינו) ושיבואו */
function listFor(userId, { scope = 'past', limit = 100 } = {}) {
  const now = D.nowIso();
  const rows = scope === 'upcoming'
    ? D.all(`SELECT r.* FROM recordings r JOIN recording_access a ON a.recording_id = r.id
              WHERE a.user_id = ? AND r.end_at > ? AND r.status NOT IN ('cancelled') ORDER BY r.start_at LIMIT ?`, userId, now, limit)
    : D.all(`SELECT r.* FROM recordings r JOIN recording_access a ON a.recording_id = r.id
              WHERE a.user_id = ? AND r.start_at <= ? AND r.status NOT IN ('cancelled','scheduled') ORDER BY r.start_at DESC LIMIT ?`, userId, now, limit);
  return rows.map((r) => shape(r, userId));
}

function detail(userId, recId) {
  const rec = recordingById(recId);
  if (!rec || !canSee(userId, recId)) return null;
  return shape(rec, userId, { full: true });
}

/** ההקלטה של אירוע ביומן שלי — לכפתור "📝 סיכום" ב-Today */
function forEvents(userId, eventIds) {
  if (!eventIds.length) return new Map();
  const rows = D.all(
    `SELECT a.event_id, r.id, r.status, r.summary IS NOT NULL AS has_summary FROM recording_access a JOIN recordings r ON r.id = a.recording_id
      WHERE a.user_id = ? AND a.event_id IN (${eventIds.map(() => '?').join(',')}) AND r.status <> 'cancelled'`,
    userId, ...eventIds
  );
  return new Map(rows.map((r) => [r.event_id, { id: r.id, status: r.status, statusLabel: STATUS_LABEL[r.status], hasSummary: Boolean(r.has_summary) }]));
}

class RecordingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function ownRecording(userId, recId) {
  const rec = recordingById(recId);
  if (!rec || !canSee(userId, recId)) throw new RecordingError('ההקלטה לא נמצאה', 404);
  return rec;
}

/** "לא להקליט" — כל משתתף מהחברה רשאי, עד שהמקליט נכנס */
async function skip(actor, recId) {
  const rec = ownRecording(actor.id, recId);
  if (rec.status !== 'scheduled') throw new RecordingError('המקליט כבר בפגישה — אפשר להוציא אותו מתוך ה-Zoom');
  await cancelBot(rec);
  markSkipped(rec.id, actor.id, `${actor.name} ביקש/ה לא להקליט`);
  for (const p of participants(rec.id)) {
    if (p.id === actor.id) continue;
    D.notify({ targetType: 'user', targetId: p.id, kind: 'meeting', title: `${actor.name} ביקש/ה לא להקליט את "${rec.title}"`, body: '' });
  }
}

/** ביטול ה"לא להקליט" — רק מי שביקש */
function restore(actor, recId) {
  const rec = ownRecording(actor.id, recId);
  if (rec.status !== 'skipped' || rec.skipped_by !== actor.id) throw new RecordingError('אי אפשר להחזיר את ההקלטה');
  D.run("UPDATE recordings SET status = 'scheduled', skipped_by = NULL, error = '', attempts = 0, updated_at = ? WHERE id = ?", D.nowIso(), rec.id);
}

/** ניסיון חוזר — הקלטה שהעיבוד שלה נכשל (הדרייב, ה-AI) */
async function retry(actor, recId) {
  const rec = ownRecording(actor.id, recId);
  if (!['failed', 'done', 'processing'].includes(rec.status) || !rec.bot_id) throw new RecordingError('אין מה לנסות שוב');
  if (rec.status === 'done' && rec.summary) throw new RecordingError('הסיכום כבר מוכן');
  D.run("UPDATE recordings SET status = 'processing', attempts = 0, error = '' WHERE id = ?", rec.id);
  announced.delete(rec.id);
  await processRecording(recordingById(rec.id));
  return detail(actor.id, rec.id);
}

/** הקובץ לנגן: בדרייב, או עדיין בשרת (לפני ההעלאה, או בלי דרייב מוגדר) */
function videoSource(userId, recId) {
  const rec = ownRecording(userId, recId);
  if (rec.drive_video_id) return { drive: rec.drive_video_id };
  if (rec.local_video && fs.existsSync(localPath(rec.local_video))) return { file: localPath(rec.local_video), size: fs.statSync(localPath(rec.local_video)).size };
  throw new RecordingError('הווידאו עוד לא מוכן', 404);
}

function transcriptOf(userId, recId) {
  const rec = ownRecording(userId, recId);
  return { title: rec.title, start: rec.start_at, text: rec.transcript };
}

// ---------------------------------------------------------------------------
// מצב — למסך הניהול
// ---------------------------------------------------------------------------

async function adminStatus({ check = false } = {}) {
  const users = activeUsers();
  const viaOwn = users.filter((u) => Gmail.has(u.id, 'calendar')).length;
  const folderId = Drive.folderIdOf(setting('recorder_drive_folder'));
  let drive = { enabled: Drive.isEnabled(), folderId, serviceEmail: Drive.serviceEmail(), ok: null, name: '', error: '' };
  if (check && drive.enabled && folderId) {
    try {
      const f = await Drive.checkFolder(folderId);
      drive = { ...drive, ok: true, name: f.name, shared: f.shared };
    } catch (err) {
      drive = { ...drive, ok: false, error: err.message };
    }
  }
  const count = (status) => D.get('SELECT COUNT(*) c FROM recordings WHERE status = ?', status).c;
  return {
    enabled: isConfigured(),
    active: isActive(),
    missing: ['RECALL_API_KEY'].filter((k) => !process.env[k]),
    region: Recall.region(),
    ai: Claude.isEnabled(),
    drive,
    calendars: {
      users: users.length,
      own: viaOwn,
      delegation: Drive.delegationEnabled(),
      covered: Drive.delegationEnabled() ? users.length : viaOwn
    },
    counts: { scheduled: count('scheduled'), done: count('done'), failed: count('failed') },
    lastScan
  };
}

// ---------------------------------------------------------------------------
// מתזמן
// ---------------------------------------------------------------------------

let timer = null;
let running = false;
let lastDiscover = 0;
let lastScan = null;

async function tick() {
  if (running || !isActive()) return;
  running = true;
  try {
    if (Date.now() - lastDiscover > 5 * MIN) {
      lastDiscover = Date.now();
      lastScan = { at: D.nowIso(), ...(await discover()) };
    }
    await scheduleBots();
    // כולל הקלטות שהעיבוד שלהן נעצר באמצע — הפעלה מחדש של השרת, תקלה זמנית
    await poll();
  } finally {
    running = false;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => console.error('[משימון] מתזמן ההקלטות נכשל:', err.message)), MIN);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 45000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  isConfigured, isActive, wantsRecording, listFor, detail, forEvents, skip, restore, retry, videoSource, transcriptOf,
  adminStatus, discover, tick, start, stop, RecordingError, STATUS_LABEL,
  _internal: { zoomLinkOf, meetingNumber, dedupeKey, resolveOwner, folderName, processRecording, summarize }
};
