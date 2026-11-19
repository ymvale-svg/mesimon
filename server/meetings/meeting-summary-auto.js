'use strict';
/**
 * 📝 סיכום פגישה אוטומטי (הוחלט 18.11.26, ישראל): "סיכום הפגישה נשלח אוטומטית בבוט ובמייל למשתתפים
 * ביומן כשיהיה מוכן ב-Timeless. הסיכום יהפוך לידע ארגוני וישמש להכנות לפגישות הבאות בנושא דומה."
 *
 * כשהסיכום של Timeless לפגישה שהסתיימה נשמר אצלנו (‎timeless-store.js‎) — פעם אחת לפגישה:
 *   • 📧 מייל מכתובת המערכת לכל משתתף מהארגון (משתמש משימון פעיל), כל אחד בנפרד — בלי אישור.
 *   • 🌐 משתתפים מבחוץ — לא אוטומטית: מי שקבע את הפגישה (המארח, ואם אינו מהארגון — המשתתף הראשון מהארגון)
 *     מקבל בבוט "לשלוח גם ל-N משתתפים מבחוץ?" (‎meeting-followup.js‎), והמייל יוצא מכתובת המערכת.
 *   • 📚 הסיכום נכנס לתור של הידע הארגוני (‎OrgKnowledge.queueMeeting‎) — זיקוק וסיווג כמו המיילים.
 *   • 💬 בבוט — הסיכום עצמו לכל משתתף מהארגון (‎meeting-followup.js‎, במקום "איך היה? מה לשלוח לך?").
 *
 * המשתתפים — מ-Timeless (המארח והמשתתפים, כפי ש-Timeless קיבל מהזימון), ועוד המוזמנים מהזימון ביומן של
 * מי שקבע, כשהיומן שלו מחובר. הקלטה ששלחו לבוט (‎meeting_audio‎) — לא כאן: היא נשלחת למי ששלח אותה.
 * כיבוי: ‎meeting_summary_auto‎ (לשונית "פגישות והקלטות").
 */
const D = require('../core').Db;
const Mailer = require('../integrations').Mailer;
const Org = require('../agents').OrgKnowledge;
const Store = require('./timeless-store');
const Calendar = require('./calendar');
const OnePage = require('./meeting-onepage');

const MIN = 60000;
const HOUR = 60 * MIN;
const GIVE_UP_MS = 24 * HOUR;          // סיכום שהגיע יותר מיממה אחרי סוף הפגישה — כבר לא נשלח אוטומטית
const MAX_BODY = 3000;                 // בלי AI — עד כאן מהסיכום של Timeless (רק נוסח מקוצר, הוחלט 18.11.26)
const TZ = 'Asia/Jerusalem';

D.db.exec(`
CREATE TABLE IF NOT EXISTS meeting_summary_auto (
  ref          TEXT    PRIMARY KEY,           -- המזהה ב-Timeless
  title        TEXT    NOT NULL DEFAULT '',
  start_at     TEXT,
  organizer_id INTEGER,                       -- מי מאשר שליחה למשתתפים מבחוץ
  org_ids      TEXT    NOT NULL DEFAULT '[]', -- המשתתפים מהארגון (‎users.id‎)
  external     TEXT    NOT NULL DEFAULT '[]', -- ‎[{email, name}]‎ — מחכים לאישור של מי שקבע
  mailed       TEXT    NOT NULL DEFAULT '[]', -- למי נשלח המייל
  created_at   TEXT    NOT NULL
);
`);

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const ddmm = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'numeric' }).format(new Date(iso));
const ymdIL = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const enabled = () => D.getSetting('meeting_summary_auto', true) !== false;

/** משתמש משימון פעיל לפי מייל (‎email‎ או ‎work_email‎) */
const userByEmail = (e) => D.get(
  "SELECT id, full_name, email, work_email, phone FROM users WHERE status = 'active' AND role <> 'vendor' AND (lower(email) = ? OR lower(work_email) = ?)",
  normEmail(e), normEmail(e)
);

/** "ישראל ישראלי <israel@x.co.il>" ← השם */
function nameFor(email, labels) {
  const hit = (labels ?? []).find((l) => normEmail(String(l).match(/[^\s<>"']+@[^\s<>"']+/)?.[0]) === email);
  return hit ? String(hit).replace(/<[^>]*>/, '').trim() : '';
}

/** המוזמנים מהזימון ביומן של מי שקבע — אותו אירוע לפי שעה (±20 דקות) או שם. ‎[]‎ — אין יומן / אין אירוע */
async function calendarPeople(userId, title, startIso) {
  if (!userId || !Calendar.isConnected(userId)) return [];
  const day = await Calendar.eventsForDay(userId, ymdIL(startIso)).catch(() => ({ events: [] }));
  const t = new Date(startIso).getTime();
  const ev = (day.events ?? []).filter((e) => !e.allDay)
    .find((e) => Math.abs(new Date(e.start).getTime() - t) <= 20 * MIN || (title && e.title === title));
  return ev ? [ev.organizer, ...(ev.people ?? [])].filter((p) => p?.email).map((p) => ({ email: normEmail(p.email), name: String(p.name ?? '').trim() })) : [];
}

/**
 * מי השתתף: ‎{ org: [user], organizer: user|null, external: [{email, name}] }‎. המארח — הראשון ברשימה של Timeless.
 * @param {{ emails: string[], meeting: object }} m
 */
async function peopleOf(m) {
  const labels = m.meeting.participants ?? [];
  const seen = new Set();
  const all = [];
  const add = (email, name) => { const e = normEmail(email); if (e.includes('@') && !seen.has(e)) { seen.add(e); all.push({ email: e, name: name || nameFor(e, labels) }); } };
  for (const e of m.emails ?? []) add(e);
  const first = all.map((p) => userByEmail(p.email)).find(Boolean) ?? null;
  for (const p of await calendarPeople(first?.id, m.meeting.title, m.meeting.start)) add(p.email, p.name);
  const org = [];
  const external = [];
  for (const p of all) {
    const u = userByEmail(p.email);
    if (u) { if (!org.some((x) => x.id === u.id)) org.push(u); } else external.push(p);
  }
  return { org, organizer: first, external };
}

/**
 * גוף המייל — 📄 רק הנוסח המקוצר, בעמוד אחד (‎meeting-onepage.js‎; הוחלט 18.11.26: "הסיכום של Timeless ארוך ולא יעיל",
 * ו"ישלח רק נוסח מקוצר בבוט ובמייל" — בלי הסיכום המלא, גם לא כקובץ מצורף). בלי AI — תחילת הסיכום של Timeless.
 */
async function mailText(title, startIso, summaryMd) {
  const page = await OnePage.forSending(summaryMd, { title, max: MAX_BODY });
  return [
    'שלום לכולם,',
    '',
    `סיכום הפגישה "${title}" מ-${ddmm(startIso)}:`,
    '',
    page.text,
    '',
    'אם משהו חסר או לא מדויק — אשמח לתיקון.'
  ].join('\n');
}
const subjectOf = (title, startIso) => `סיכום פגישה: ${title} · ${ddmm(startIso)}`;
const htmlOf = (text) => `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.5">${String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>`;

/** הקלטה ששלחו לבוט והועלתה ל-Timeless — הסיכום שלה הולך למי ששלח (‎meeting-audio.js‎), לא כאן */
const fromWa = () => new Set(D.all('SELECT timeless_id FROM meeting_audio WHERE timeless_id IS NOT NULL').map((r) => String(r.timeless_id)));

/** פגישות Timeless שהסתיימו ביממה האחרונה, הסיכום שלהן כבר נשמר אצלנו, ועוד לא טופלו */
function ready(now = Date.now()) {
  const wa = fromWa();
  return Store.endedBetween(now - GIVE_UP_MS, now)
    .filter(({ meeting }) => !wa.has(String(meeting.id)) && !D.get('SELECT 1 FROM meeting_summary_auto WHERE ref = ?', String(meeting.id)))
    .map((m) => ({ ...m, summary: Store.stored(m.meeting.id)?.summary ?? '' }))
    .filter((m) => m.summary.trim());
}

/**
 * סבב: לכל פגישה שהסיכום שלה מוכן — מייל למשתתפים מהארגון, ולתור של הידע הארגוני. פעם אחת לפגישה.
 * ‎send‎ — לבדיקות. מחזיר מה טופל.
 */
async function sweep(now = Date.now(), { send = (msg) => Mailer.send(msg) } = {}) {
  if (!enabled()) return [];
  const done = [];
  for (const m of ready(now)) {
    const { meeting } = m;
    const ppl = await peopleOf(m);
    // נרשם קודם — שגיאה באמצע לא תשלח שוב לאותם אנשים בסבב הבא
    const claimed = D.run(
      'INSERT OR IGNORE INTO meeting_summary_auto (ref, title, start_at, organizer_id, org_ids, external, created_at) VALUES (?,?,?,?,?,?,?)',
      String(meeting.id), meeting.title || 'פגישה', meeting.start, ppl.organizer?.id ?? null,
      JSON.stringify(ppl.org.map((u) => u.id)), JSON.stringify(ppl.external), D.nowIso()
    ).changes;
    if (!claimed) continue;
    const title = meeting.title || 'פגישה';
    const subject = subjectOf(title, meeting.start);
    const mailed = [];
    if (Mailer.isEnabled()) {
      const text = await mailText(title, meeting.start, m.summary);
      for (const u of ppl.org) {
        try {
          await send({ to: u.email, toName: u.full_name, subject, text, html: htmlOf(text) });
          mailed.push(u.id);
        } catch (err) {
          console.error(`[משימון] סיכום פגישה במייל ל-${u.id} נכשל:`, err.message);
        }
      }
      D.run('UPDATE meeting_summary_auto SET mailed = ? WHERE ref = ?', JSON.stringify(mailed), String(meeting.id));
    }
    // 📚 לידע הארגוני — הזיקוק, הניקוי והסיווג בסבב של הידע (‎org-knowledge.js‎)
    try {
      Org.queueMeeting({ ref: `timeless:${meeting.id}`, title, startAt: meeting.start, text: Store.plainText(m.summary), userId: ppl.organizer?.id ?? null });
    } catch (err) {
      console.error('[משימון] סיכום פגישה לידע הארגוני נכשל:', err.message);
    }
    done.push({ ref: String(meeting.id), title, org: ppl.org.map((u) => u.id), organizer: ppl.organizer?.id ?? null, external: ppl.external, mailed });
  }
  return done;
}

/** מה טופל לפגישה — לבוט: האם נשלח מייל, ומי מבחוץ מחכה לאישור. ‎null‎ — לא טופלה אוטומטית */
function stateOf(ref) {
  const r = D.get('SELECT * FROM meeting_summary_auto WHERE ref = ?', String(ref));
  if (!r) return null;
  return { ...r, orgIds: parseJson(r.org_ids, []), external: parseJson(r.external, []), mailed: parseJson(r.mailed, []) };
}

/** "לשלוח גם למשתתפים מבחוץ?" — טיוטה לאישור של מי שקבע. ‎null‎ — אין מבחוץ, או שזה לא מי שקבע */
async function externalDraft(ref, userId) {
  const s = stateOf(ref);
  if (!s || s.organizer_id !== userId || !s.external.length) return null;
  const stored = Store.stored(ref);
  if (!stored?.summary) return null;
  return {
    kind: 'meeting_summary_mail', via: 'system', title: s.title, to: s.external,
    subject: subjectOf(s.title, s.start_at), text: await mailText(s.title, s.start_at, stored.summary)
  };
}

/** שליחה מכתובת המערכת (טיוטה ‎via: 'system'‎) — לכל נמען בנפרד. מחזיר כמה נשלחו */
async function sendSystem(draft, { send = (msg) => Mailer.send(msg) } = {}) {
  if (!Mailer.isEnabled()) throw new Error('שליחת דואר אינה מוגדרת במערכת');
  let n = 0;
  for (const p of draft.to ?? []) {
    if (!String(p.email ?? '').includes('@')) continue;
    await send({ to: p.email, toName: p.name || undefined, subject: draft.subject, text: draft.text, html: htmlOf(draft.text) });
    n++;
  }
  return n;
}

/** ניקוי — אחרי חודשיים */
function prune() {
  D.run('DELETE FROM meeting_summary_auto WHERE created_at < ?', new Date(Date.now() - 60 * 24 * HOUR).toISOString());
}

module.exports = { sweep, ready, stateOf, externalDraft, sendSystem, prune, enabled, _internal: { peopleOf, mailText, subjectOf, calendarPeople } };
