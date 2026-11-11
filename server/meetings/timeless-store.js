'use strict';
/**
 * 🎥 Timeless — הצינור היחיד (הוחלט 11.11.26).
 *
 * משימון מושך מ-Timeless פעם אחת לכל פגישה — פרטים, תמליל ומסמכי ה-AI — ושומר בטבלה
 * ‎timeless_meetings‎. מסך ההקלטות, התגים ביומן, הנגן, כרטיס המשימה והבוט ("איך היה הפגישה?",
 * שליחת סיכום) קוראים רק מכאן, ולא פונים ל-Timeless בעצמם.
 *
 * מתי פונים ל-Timeless:
 *   • סבב — רשימה ארגונית אחת (שלושת הימים האחרונים ומחר), ותמליל וסיכום רק לפגישה שהסתיימה ועוד
 *     לא נשמרה (עד 6 בסבב). סיכום שעוד לא מוכן — נבדק שוב בסבבים הבאים, עד 12 שעות.
 *     כל כמה זמן: ‎timeless_sweep_minutes‎ (30) בשעות העבודה, כל 3 שעות בלילה, וכל שעתיים כשה-webhook
 *     מחובר (רק רשת ביטחון). לחשבון יש מכסה של 250 בקשות לכמה שעות (נמדד 11.11.26) — כשנשארו פחות
 *     מ-‎Timeless.BG_RESERVE‎, הסבב מדלג, והשאר שמור ל"▶ צפייה".
 *   • webhook — Timeless מודיע כשתמליל או סיכום מוכן (‎meeting.transcript_ready‎,
 *     ‎meeting.initial_summary_ready‎), והפגישה נמשכת מיד.
 *   • חודש ישן שנפתח במסך — הרשימה שלו נמשכת פעם אחת (‎timeless_months‎); תמליל וסיכום של פגישה
 *     ישנה — בפעם הראשונה שפותחים אותה.
 *   • "▶ צפייה" — קישור הסרטון חתום לזמן קצר, ולכן נמשך בכל לחיצה (‎Timeless.recordingUrl‎).
 *
 * מי רואה מה — ‎Timeless.scopeOf‎: הנהלה הכול, עובד רק פגישות שהוא המארח או משתתף בהן.
 */
const crypto = require('node:crypto');
const D = require('../core').Db;
const W = require('../core').Workdays;
const Secrets = require('../core').Secrets;
const Timeless = require('../integrations').Timeless;

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK_MS = 5 * MIN;
const DETAILS_PER_SWEEP = 6;
const DOCS_RECHECK_MS = 15 * MIN;
const DOCS_GIVE_UP_MS = 12 * HOUR;
const EVENTS = ['meeting.transcript_ready', 'meeting.initial_summary_ready'];

const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const emailsIn = (p) => (typeof p === 'string' ? (p.match(/[^\s<>"'(),;]+@[^\s<>"'(),;]+/g) ?? []) : [p?.email]).map(normEmail).filter((e) => e.includes('@'));

// ---------------------------------------------------------------------------
// שמירה
// ---------------------------------------------------------------------------

/** פגישה כפי ש-Timeless מחזיר ← שורה בטבלה (בלי לגעת בתמליל ובמסמכים שכבר נשמרו) */
function upsert(raw) {
  const n = Timeless.normalizeMeeting(raw);
  const emails = [...new Set([raw.host, ...(Array.isArray(raw.participants) ? raw.participants : [])].flatMap(emailsIn))];
  const refs = Array.isArray(raw.documents) ? raw.documents.map((d) => ({ id: d.id, title: d.title || '', createdAt: d.created_at || null })) : null;
  const prev = D.get('SELECT doc_refs FROM timeless_meetings WHERE id = ?', n.id);
  D.run(
    `INSERT INTO timeless_meetings (id, title, status, start_at, end_at, duration_min, participants, emails, doc_refs, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, start_at = excluded.start_at,
       end_at = excluded.end_at, duration_min = excluded.duration_min, participants = excluded.participants,
       emails = excluded.emails, doc_refs = excluded.doc_refs, synced_at = excluded.synced_at`,
    n.id, n.title, n.status ?? '', n.start, n.end, n.durationMinutes, JSON.stringify(n.participants), JSON.stringify(emails),
    JSON.stringify(refs ?? parseJson(prev?.doc_refs, [])), D.nowIso()
  );
  // מסמך חדש (סיכום שהגיע אחרי התמליל) — המסמכים יימשכו שוב
  if (refs && prev && parseJson(prev.doc_refs, []).map((d) => d.id).join() !== refs.map((d) => d.id).join()) {
    D.run('UPDATE timeless_meetings SET documents = NULL WHERE id = ?', n.id);
  }
  return n.id;
}

/** שורה ← הצורה שהמסכים מכירים (כמו ‎Timeless.normalizeMeeting‎) */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    start: row.start_at,
    end: row.end_at,
    durationMinutes: row.duration_min,
    participants: parseJson(row.participants, []),
    status: row.status || null,
    documents: parseJson(row.doc_refs, []),
    hasTranscript: row.transcript !== null && row.transcript !== undefined,
    hasSummary: Boolean(parseJson(row.documents, []).length)
  };
}

const rowOf = (id) => D.get('SELECT * FROM timeless_meetings WHERE id = ?', String(id ?? ''));

function canSee(scope, row) {
  if (!scope || !row) return false;
  if (scope.all) return true;
  return parseJson(row.emails, []).some((e) => scope.emails.has(e));
}

// ---------------------------------------------------------------------------
// משיכה מ-Timeless
// ---------------------------------------------------------------------------

/** תמליל ומסמכים לפגישה אחת — מה שחסר בלבד */
async function fetchDetails(id) {
  const row = rowOf(id);
  if (!row) return;
  const tokens = Timeless.syncTokens();
  if (!tokens.length) return;
  const token = tokens[0];
  let transcript = row.transcript;
  if (transcript === null) {
    try { transcript = JSON.stringify(await Timeless.org.transcript(token, id)); } catch (err) { if (err.status !== 404) throw err; }
  }
  let documents = row.documents;
  const refs = parseJson(row.doc_refs, []);
  if (documents === null && refs.length) {
    const docs = [];
    for (const ref of refs.slice(0, 5)) {
      try { docs.push({ ...ref, markdown: await Timeless.org.document(token, ref.id) }); } catch (err) { if (err.status !== 404) throw err; }
    }
    documents = JSON.stringify(docs);
  }
  D.run('UPDATE timeless_meetings SET transcript = ?, documents = ?, details_at = ? WHERE id = ?', transcript ?? null, documents ?? null, D.nowIso(), id);
}

/** פגישה אחת במלואה (webhook, או פגישה שעוד לא נשמרה ונפתחה במסך) */
async function syncMeeting(id) {
  const tokens = Timeless.syncTokens();
  for (const token of tokens) {
    const raw = await Timeless.org.meeting(token, id).catch(() => null);
    if (!raw) continue;
    upsert(raw);
    if (raw.status === 'completed') await fetchDetails(id);
    return rowOf(id);
  }
  return null;
}

/** הפגישות שצריך עוד למשוך להן תמליל / סיכום */
function needDetails(now = Date.now()) {
  return D.all("SELECT * FROM timeless_meetings WHERE status = 'completed' AND end_at > ? ORDER BY end_at DESC", new Date(now - 3 * DAY).toISOString())
    .filter((r) => {
      if (r.transcript === null) return true;
      const refs = parseJson(r.doc_refs, []);
      if (refs.length && r.documents === null) return true;
      // אין עדיין סיכום — Timeless מסכם אחרי התמליל; בודקים שוב מדי פעם
      if (!refs.length && now - new Date(r.end_at).getTime() < DOCS_GIVE_UP_MS) {
        return !r.details_at || now - new Date(r.details_at).getTime() > DOCS_RECHECK_MS;
      }
      return false;
    });
}

/** סבב: רשימה ארגונית אחת, ופרטים לפגישות חדשות שהסתיימו */
async function sweep(now = Date.now()) {
  const tokens = Timeless.syncTokens();
  if (!tokens.length) return { meetings: 0, details: 0 };
  let count = 0;
  for (const token of tokens) {
    // הסבב הוא הצרכן היחיד של הרשימה הזו — תמיד טרייה (בקשות זהות במקביל עדיין מתאחדות)
    const list = await Timeless.org.meetings(token, ymd(now - 3 * DAY), ymd(now + DAY), { fresh: true });
    for (const raw of list) { upsert(raw); count++; }
  }
  let details = 0;
  for (const r of needDetails(now).slice(0, DETAILS_PER_SWEEP)) {
    try { await fetchDetails(r.id); details++; } catch (err) {
      console.error('[משימון] Timeless — משיכת תמליל / סיכום נכשלה:', err.message);
      if (err.status === 429) break;
    }
  }
  return { meetings: count, details };
}

/** חודש שנפתח במסך ועוד לא נמשך — פעם אחת (החודש הנוכחי מתעדכן בסבב) */
async function ensureRange(from, to) {
  const months = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const missing = months.filter((m) => !D.get('SELECT 1 FROM timeless_months WHERE month = ?', m));
  if (!missing.length) return;
  const tokens = Timeless.syncTokens();
  for (const month of missing) {
    const start = `${month}-01`;
    const endD = new Date(`${start}T00:00:00Z`);
    endD.setUTCMonth(endD.getUTCMonth() + 1);
    endD.setUTCDate(0);
    for (const token of tokens) for (const raw of await Timeless.org.meetings(token, start, ymd(endD.getTime()))) upsert(raw);
    // גם החודש הנוכחי: פגישות שיתווספו בהמשך נכנסות בסבב (שלושת הימים האחרונים) וב-webhook
    D.run('INSERT OR REPLACE INTO timeless_months (month, at) VALUES (?,?)', month, D.nowIso());
  }
}

// ---------------------------------------------------------------------------
// קריאה — מה שהמסכים והבוט צריכים
// ---------------------------------------------------------------------------

/** ההקלטות שהמשתמש רואה בטווח (פגישות שהושלמו) — מהשמירה המקומית */
async function list(userId, from, to) {
  const scope = Timeless.scopeOf(userId);
  if (!scope) return [];
  await ensureRange(from, to).catch((err) => console.error('[משימון] Timeless — משיכת חודש נכשלה:', err.message));
  return D.all(
    "SELECT * FROM timeless_meetings WHERE status = 'completed' AND start_at >= ? AND start_at < ? ORDER BY start_at DESC",
    W.ilWallToUtc(from, 0, 0).toISOString(), W.ilWallToUtc(W.addDays(to, 1), 0, 0).toISOString()
  ).filter((r) => canSee(scope, r)).map(shape);
}

/** פגישה אחת שהמשתמש רואה — ‎null‎ אחרת. שעוד לא נשמרה — נמשכת פעם אחת */
async function get(userId, id) {
  const scope = Timeless.scopeOf(userId);
  if (!scope) return null;
  let row = rowOf(id);
  if (!row && /^[\w-]{1,80}$/.test(String(id))) row = await syncMeeting(String(id)).catch(() => null);
  return canSee(scope, row) ? shape(row) : null;
}

/** התמליל והמסמכים של פגישה שהמשתמש רואה — נמשכים פעם אחת אם חסרים */
async function details(userId, id) {
  const m = await get(userId, id);
  if (!m) return null;
  let row = rowOf(id);
  if (row.status === 'completed' && (row.transcript === null || (parseJson(row.doc_refs, []).length && row.documents === null))) {
    await fetchDetails(row.id).catch((err) => console.error('[משימון] Timeless — פרטי פגישה:', err.message));
    row = rowOf(id);
  }
  return { meeting: m, transcript: parseJson(row.transcript, null), documents: parseJson(row.documents, []) };
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** התמליל כטקסט ("[hh:mm:ss] דובר: …"), מקוצר */
function transcriptText(t, maxChars = 60000) {
  if (!t?.segments?.length) return '';
  const names = new Map((t.speakers ?? []).map((s) => [s.id, s.name]));
  const text = t.segments.map((x) => `[${clock(x.s)}] ${names.get(x.speaker) || 'דובר'}: ${x.text}`).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[... התמליל קוצר ...]` : text;
}

/**
 * פגישות שהסתיימו בטווח, לכל המשתמשים שהשתתפו בהן — לבוט ("איך היה?"), בלי לפנות ל-Timeless
 * @returns {Array<{ meeting, emails: string[] }>}
 */
function endedBetween(fromMs, toMs, { withSummary = true } = {}) {
  return D.all("SELECT * FROM timeless_meetings WHERE status = 'completed' AND end_at >= ? AND end_at <= ?", new Date(fromMs).toISOString(), new Date(toMs).toISOString())
    .filter((r) => !withSummary || parseJson(r.doc_refs, []).length)
    .map((r) => ({ meeting: shape(r), emails: parseJson(r.emails, []) }));
}

/** הפגישה ב-Timeless שמתאימה לשעה ולמשתתפים (פגישת Zoom, פגישת משימון, אירוע ביומן) */
const normTitle = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function near(startIso, emails, { withinMs = 20 * MIN, statuses = ['completed'], title = '' } = {}) {
  const t = new Date(startIso).getTime();
  if (!Number.isFinite(t)) return null;
  const rows = D.all('SELECT * FROM timeless_meetings WHERE start_at >= ? AND start_at <= ?', new Date(t - withinMs).toISOString(), new Date(t + withinMs).toISOString())
    .filter((r) => !statuses || statuses.includes(r.status));
  const set = emails instanceof Set ? emails : new Set([...(emails ?? [])].map(normEmail));
  return rows
    // משתתף משותף, או שם דומה (Timeless לפעמים רושם רק את המארח)
    .filter((r) => {
      if (!set.size || parseJson(r.emails, []).some((e) => set.has(e))) return true;
      const a = normTitle(r.title);
      const b = normTitle(title);
      return Boolean(a && b && (a.includes(b) || b.includes(a)));
    })
    .map((r) => ({ r, diff: Math.abs(new Date(r.start_at).getTime() - t) }))
    .sort((a, b) => a.diff - b.diff)[0]?.r ?? null;
}

// ---------------------------------------------------------------------------
// כלים לסוכנים ("שאל את אשל") — אותם כלים של Timeless, מהשמירה המקומית
// ---------------------------------------------------------------------------

/** מריץ כלי Timeless של הסוכן (‎timeless_list_meetings‎ וכו׳) על השמירה המקומית, בשם המשתמש */
async function runTool(userId, name, input = {}) {
  const args = input && typeof input === 'object' ? input : {};
  try {
    const scope = Timeless.scopeOf(userId);
    if (!scope) return { error: 'Timeless אינו מחובר.', needsReconnect: true };
    if (name === 'timeless_list_meetings') {
      const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to ?? '') ? args.to : ymd(Date.now() + DAY);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from ?? '') ? args.from : ymd(Date.now() - 60 * DAY);
      const q = String(args.search ?? '').trim().toLowerCase();
      const rows = D.all('SELECT * FROM timeless_meetings WHERE start_at >= ? AND start_at < ? ORDER BY start_at DESC',
        W.ilWallToUtc(from, 0, 0).toISOString(), W.ilWallToUtc(W.addDays(to, 1), 0, 0).toISOString())
        .filter((r) => canSee(scope, r))
        .filter((r) => !args.status || r.status === args.status)
        // חיפוש בכותרת ובמשתתפים; "סמנטי" — גם בסיכום ובתמליל השמורים
        .filter((r) => !q || [r.title, r.participants, args.semantic ? `${r.documents ?? ''} ${r.transcript ?? ''}` : ''].join(' ').toLowerCase().includes(q));
      const meetings = rows.slice(0, Math.min(50, Math.max(1, Number(args.limit) || 20))).map((r) => {
        const m = shape(r);
        return { id: m.id, title: m.title, start: m.start, end: m.end, durationMinutes: m.durationMinutes, participants: m.participants, status: m.status, documents: m.documents };
      });
      return { count: meetings.length, meetings };
    }
    if (name === 'timeless_get_transcript') {
      const d = await details(userId, args.meeting_id);
      if (!d) return { error: 'הפגישה לא נמצאה ב-Timeless, או שלא השתתפת בה.' };
      return { meetingId: d.meeting.id, title: d.meeting.title, text: transcriptText(d.transcript, Math.min(120000, Number(args.max_chars) || 60000)) };
    }
    if (name === 'timeless_get_document') {
      const d = await details(userId, args.meeting_id);
      if (!d) return { error: 'כדי לקרוא מסמך יש לתת את מזהה הפגישה (meeting_id) של פגישה שהשתתפת בה.' };
      const docs = args.document_id ? d.documents.filter((x) => x.id === args.document_id) : d.documents;
      if (!docs.length) return { error: 'המסמך לא נמצא בפגישה הזו.' };
      return { meetingId: d.meeting.id, count: docs.length, documents: docs.slice(0, 5).map((x) => ({ id: x.id, title: x.title, markdown: String(x.markdown ?? '').slice(0, 60000) })) };
    }
    return { error: `כלי לא מוכר: ${name}` };
  } catch (err) {
    return { error: err.message, retryable: Boolean(err.retryable) };
  }
}

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

const WEBHOOK_KEY = 'timeless_webhook';

/** הסוד לאימות ההודעות — מה-‎webhook‎ שנרשם מכאן, או ‎TIMELESS_WEBHOOK_SECRET‎ */
function webhookSecret() {
  const saved = D.getSetting(WEBHOOK_KEY, null);
  const fromDb = saved?.secret ? Secrets.decrypt(saved.secret) : '';
  return fromDb || String(process.env.TIMELESS_WEBHOOK_SECRET ?? '').trim();
}

function webhookStatus() {
  const saved = D.getSetting(WEBHOOK_KEY, null);
  return { registered: Boolean(webhookSecret()), id: saved?.id ?? null, url: saved?.url ?? null, at: saved?.at ?? null };
}

/** רישום ה-webhook ב-Timeless (מנהל מערכת, פעם אחת) */
async function registerWebhook(publicUrl) {
  const base = String(publicUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw Object.assign(new Error('צריך כתובת מערכת ב-https (הגדרות ← כתובת המערכת)'), { status: 400 });
  const [token] = Timeless.syncTokens();
  if (!token) throw Object.assign(new Error('Timeless אינו מחובר בשרת (TIMELESS_ACCESS_TOKEN)'), { status: 400 });
  const url = `${base}/api/hooks/timeless`;
  const w = await Timeless.org.createWebhook(token, url, EVENTS);
  if (!w.secret) throw Object.assign(new Error('Timeless לא החזיר סוד ל-webhook'), { status: 502 });
  D.setSetting(WEBHOOK_KEY, { id: w.id, secret: Secrets.encrypt(w.secret), url, at: D.nowIso() });
  return webhookStatus();
}

/** אימות החתימה (‎X-Webhook-Signature: sha256=<hex>‎, HMAC-SHA256 על הגוף כפי שהגיע) */
function verifySignature(rawBody, header) {
  const secret = webhookSecret();
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(header).replace(/^sha256=/, '').trim();
  if (got.length !== expected.length || !/^[0-9a-f]+$/i.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
}

/** הודעה מ-Timeless: מזהה הפגישה, איפה שהוא בגוף — והפגישה נמשכת עכשיו */
async function handleWebhook(rawBody, signature) {
  if (!verifySignature(rawBody, signature)) return { ok: false, status: 401 };
  let body = {};
  try { body = JSON.parse(String(rawBody)); } catch { return { ok: false, status: 400 }; }
  const ids = [...new Set(JSON.stringify(body).match(/mtg_[\w-]{1,80}/g) ?? [])].slice(0, 3);
  for (const id of ids) {
    await Timeless.background(() => syncMeeting(id)).catch((err) => console.error('[משימון] Timeless webhook — משיכת פגישה נכשלה:', err.message));
  }
  return { ok: true, status: 200, meetings: ids.length };
}

// ---------------------------------------------------------------------------
// מתזמן
// ---------------------------------------------------------------------------

let timer = null;
let running = false;
let lastSweep = 0;

/** כמה זמן בין סבבים — לפי שעה ביום ולפי ה-webhook */
function sweepEveryMs(now = Date.now()) {
  if (webhookStatus().registered) return 2 * HOUR;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
  if (hour < 7 || hour >= 22) return 3 * HOUR;
  return Math.max(10, Number(D.getSetting('timeless_sweep_minutes', 30)) || 30) * MIN;
}

/** מתי היה הסבב המוצלח האחרון — לבדיקת "לא מוקלטת" (שמורה טרייה = אפשר לסמוך עליה) */
const lastSweepAt = () => lastSweep;

async function tick({ force = false } = {}) {
  if (running) return;
  const now = Date.now();
  if (!force && now - lastSweep < sweepEveryMs(now)) return;
  // המכסה נמוכה — לא מבזבזים אותה על סבב רקע
  const left = Timeless.quotaLeft();
  if (!force && left !== null && left < Timeless.BG_RESERVE) return;
  running = true;
  try {
    await Timeless.background(() => sweep());
    lastSweep = Date.now();
  } catch (err) {
    console.error('[משימון] סבב Timeless נכשל:', err.message);
  } finally { running = false; }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => tick(), 20000).unref?.();
}

module.exports = {
  start, tick, sweep, syncMeeting, lastSweepAt, sweepEveryMs, list, get, details, transcriptText, endedBetween, near, canSee,
  registerWebhook, webhookStatus, handleWebhook, verifySignature, runTool,
  _internal: { upsert, shape, needDetails, ensureRange, fetchDetails }
};
