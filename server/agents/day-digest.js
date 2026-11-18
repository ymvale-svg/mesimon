'use strict';
/**
 * ☀️ סיכום בוקר ו-🌙 סיכום סוף יום (רעיונות 1+2, הוחלט 09.11.26).
 *
 * בוקר (‎digest_morning‎, ברירת מחדל 08:15), בימי א׳–ה׳ — סיכום הבוקר היחיד (מ-15.11.26 גם במקום "סיכום בוקר" הישן,
 *   ‎summary‎): קצר — ראו ‎morning‎ למטה.
 * סוף יום (‎digest_evening‎, ברירת מחדל 17:00 — ההודעה היזומה האחרונה של היום):
 *   ✅ מה נסגר היום · ➡️ מה עוד פתוח להיום — [להעביר למחר ✅] מעביר את תאריך היעד ליום העבודה הבא.
 *
 * הודעה אחת בבוקר ואחת בערב. יום בלי כלום — בלי הודעה.
 */
const D = require('../core').Db;
const W = require('../core').Workdays;
const WaUi = require('../whatsapp').WaUi;
const MailPush = require('../mail').MailPush;

const TZ = 'Asia/Jerusalem';
const BTN = Object.freeze({ move: 'להעביר למחר ✅', keep: 'להשאיר 👍' });
const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const oneLine = (x, n) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const hm = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const time = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** משימה פתוחה = הסטטוס שלה אינו עמודה סופית בבורד */
const OPEN = `NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = t.board_id AND c.key = t.status AND c.is_final = 1)`;
const endOfToday = () => W.ilWallToUtc(W.addDays(W.todayIL(), 1), 0, 0).toISOString();
const startOfToday = () => W.ilWallToUtc(W.todayIL(), 0, 0).toISOString();

function myOpenDue(userId) {
  return D.all(
    `SELECT t.id, t.title, t.due_date FROM tasks t
      WHERE t.assignee_type = 'user' AND t.assignee_id = ? AND t.due_date IS NOT NULL AND t.due_date < ? AND ${OPEN}
      ORDER BY t.due_date LIMIT 30`,
    userId, endOfToday()
  );
}

/** משימות שהטלתי על אחרים ועבר תאריך היעד שלהן */
function waitingTasks(userId) {
  return D.all(
    `SELECT t.id, t.title, u.full_name AS who FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.created_by = ? AND t.assignee_type = 'user' AND t.assignee_id <> ? AND t.due_date IS NOT NULL AND t.due_date < ? AND ${OPEN}
      ORDER BY t.due_date LIMIT 10`,
    userId, userId, startOfToday()
  );
}

/*
 * ☀️ סיכום הבוקר — אחד, ולא עמוס (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 5.4):
 *   • עד 10 שורות; כל חלק — שורה אחת, עד 3 פריטים, והשאר "ועוד N".
 *   • חלק ריק — לא מופיע. אין כלום — שורה אחת.
 *   • רק מה שקורה היום או מחכה לך: 📅 פגישות · 🔥 באיחור / להיום · 📬 מיילים לענות · ⏳ מחכה לך מאחרים · ⏰ תזכורות
 *     · 💡 הצעות משימה (רק מספר — הן במשימון). בלי תיאורים, בלי תובנות, בלי טיפים (הטיפ — ב-9, בנפרד).
 *   • כפתורים — רק מה שיש בו משהו: [📬 N מיילים לענות] [☀️ מה יש לי היום].
 * ‎events(userId)‎ — הפגישות של היום (מהסבב בבוט, שמחזיק את היומן); בלי — בלי שורת פגישות.
 */
const MORNING_MAX_LINES = 10;
const PER_LINE = 3;
const TODAY_BTN = '☀️ מה יש לי היום';

/** "א · ב · ג ועוד 4" */
function joinSome(items, n = PER_LINE) {
  const shown = items.slice(0, n).join(' · ');
  return items.length > n ? `${shown} ועוד ${items.length - n}` : shown;
}

async function morning(userId, { events = async () => [] } = {}) {
  const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  const hello = `☀️ *בוקר טוב ${firstName(u?.full_name)}*`;
  let meetings = [];
  try { meetings = (await events(userId)) ?? []; } catch { /* בלי יומן */ }
  const tasks = myOpenDue(userId);
  const start = startOfToday();
  let toAnswer = [];
  try { toAnswer = MailPush.toAnswer(userId); } catch { /* בלי מייל */ }
  const pace = D.userPrefs(userId)?.botPrefs?.remindPace ?? 'normal';
  if (pace === 'off') toAnswer = [];
  const sentWaiting = D.get("SELECT COUNT(*) AS n FROM sent_followups WHERE user_id = ? AND status IN ('pending', 'asked')", userId)?.n ?? 0;
  const assigned = waitingTasks(userId).length;
  const reminders = D.all("SELECT text, due_at FROM reminders WHERE user_id = ? AND status = 'active' AND due_at < ? ORDER BY due_at", userId, endOfToday());
  const suggestions = D.get(`SELECT COUNT(DISTINCT COALESCE(NULLIF(gmail_id, ''), id)) AS n FROM ai_suggestions
    WHERE user_id = ? AND kind = 'task' AND status = 'pending' AND created_at >= ?`, userId, new Date(Date.now() - 7 * 86400000).toISOString())?.n ?? 0;

  const lines = [];
  if (meetings.length) lines.push(`📅 ${joinSome(meetings.map((e) => `${e.allDay ? 'כל היום' : time(e.start)} ${oneLine(e.title, 40)}`))}`);
  if (tasks.length) {
    lines.push(`🔥 ${joinSome(tasks.map((t) => `${oneLine(t.title, 45)}${t.due_date < start ? ' — באיחור' : ''}`))}`);
  }
  if (toAnswer.length) {
    const top = toAnswer[0].from_name || toAnswer[0].from_email;
    lines.push(`📬 ${toAnswer.length === 1 ? 'מייל אחד מחכה' : `${toAnswer.length} מיילים מחכים`} לתשובה ממך (${top}${toAnswer.length > 1 ? ` ועוד ${toAnswer.length - 1}` : ''})`);
  }
  if (sentWaiting || assigned) {
    lines.push(`⏳ מחכה לך מאחרים: ${[sentWaiting ? `${sentWaiting === 1 ? 'מייל אחד' : `${sentWaiting} מיילים`} ששלחת` : null, assigned ? `${assigned === 1 ? 'משימה אחת' : `${assigned} משימות`} שהטלת ובאיחור` : null].filter(Boolean).join(' · ')}`);
  }
  if (reminders.length) lines.push(`⏰ ${joinSome(reminders.map((r) => `${oneLine(r.text, 45)} — ${time(r.due_at)}`))}`);
  if (suggestions) lines.push(`💡 ${suggestions === 1 ? 'הצעת משימה אחת' : `${suggestions} הצעות משימה`} במשימון`);

  if (!lines.length) return { text: `${hello}, אין היום שום דבר דחוף. יום טוב! 🌼` };
  const buttons = [toAnswer.length ? WaUi.mailWalkLabel(toAnswer.length) : null, TODAY_BTN].filter(Boolean);
  return { text: [hello, ...lines].slice(0, MORNING_MAX_LINES).join('\n'), buttons };
}

function evening(userId) {
  const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  const closed = D.all(
    `SELECT t.title FROM tasks t WHERE t.assignee_type = 'user' AND t.assignee_id = ? AND t.completed_at >= ? AND NOT (${OPEN}) ORDER BY t.completed_at`,
    userId, startOfToday()
  );
  const open = myOpenDue(userId);
  if (!closed.length && !open.length) return null;
  const tomorrow = W.nextWorkDay(userId, W.todayIL());
  const lines = [`🌙 *סיכום היום, ${firstName(u?.full_name)}*`];
  if (closed.length) lines.push('', `✅ *נסגרו היום* (${closed.length}):`, ...closed.slice(0, 8).map((t) => `• ${oneLine(t.title, 70)}`));
  if (open.length) {
    lines.push('', `➡️ *עוד פתוחות להיום* (${open.length}):`, ...open.slice(0, 8).map((t) => `• ${oneLine(t.title, 70)}`), '',
      `*להעביר את כולן ל${new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' }).format(W.ilWallToUtc(tomorrow, 12, 0))}?*`);
    return { text: lines.join('\n'), buttons: [BTN.move, BTN.keep], draft: { kind: 'day_evening', taskIds: open.map((t) => t.id), to: tomorrow } };
  }
  lines.push('', 'יום מצוין — הכול נסגר 🎉');
  return { text: lines.join('\n') };
}

/** תאריך היעד של משימות פתוחות שלי ← ‎to‎ (17:00), עם רישום ביומן המשימה. מחזיר כמה הועברו */
function moveTo(userId, ids, to, where) {
  const due = W.ilWallToUtc(to, 17, 0).toISOString();
  const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  let n = 0;
  for (const id of ids) {
    const ok = D.run(`UPDATE tasks SET due_date = ? WHERE id = ? AND assignee_type = 'user' AND assignee_id = ? AND ${OPEN.replace(/t\./g, 'tasks.')}`, due, id, userId).changes;
    if (ok) { D.audit(id, { type: 'user', id: userId, name: u?.full_name ?? '' }, 'due_date', `תאריך היעד הועבר ל-${to.split('-').reverse().join('.')} ${where}`); n++; }
  }
  return n;
}

/** "להעביר למחר" — תאריך היעד של המשימות הפתוחות ליום העבודה הבא (17:00), עם רישום ביומן המשימה */
function answer(userId, d, text) {
  const t = String(text ?? '').trim();
  const n = WaUi.normalize(t);
  if (WaUi.sameLabel(t, BTN.keep) || /^(להשאיר|לא|👎)([\s,.!]|$)/.test(n)) return { text: 'בסדר, נשארות כמו שהן 👍', result: 'להשאיר' };
  if (!(WaUi.sameLabel(t, BTN.move) || /^(להעביר|כן|העבר|👍)([\s,.!]|$)/.test(n))) return null;
  const n2 = moveTo(userId, d.taskIds ?? [], d.to, 'מסיכום סוף היום בבוט');
  return { text: `➡️ הועברו ${n2 === 1 ? 'משימה אחת' : `${n2} משימות`} למחר. ערב טוב! 🌙`, result: `הועברו ${n2} למחר` };
}

/**
 * הסבב: בוקר וערב, פעם אחת ביום לכל עובד. ‎io‎ — ‎{ users() → [{id}], push(userId, msg), events?(userId) → [פגישות היום] }‎
 */
async function tick(io) {
  const today = W.todayIL();
  const wd = W.weekdayOf(today);
  if (wd === 5 || wd === 6) return;
  const now = hm();
  for (const [key, at, build] of [['morning', String(D.getSetting('digest_morning', '08:15')), morning], ['evening', String(D.getSetting('digest_evening', '17:00')), evening]]) {
    if (now < at) continue;
    const sent = D.getSetting(`digest_sent_${key}`, {}) ?? {};
    for (const u of io.users()) {
      if (sent[u.id] === today) continue;
      sent[u.id] = today;
      D.setSetting(`digest_sent_${key}`, sent);
      try {
        const m = await build(u.id, { events: io.events });
        if (m) await io.push(u.id, m, key);
      } catch (err) {
        console.error(`[משימון] סיכום ${key === 'morning' ? 'בוקר' : 'ערב'} נכשל:`, err.message);
      }
    }
  }
}

module.exports = { tick, answer, morning, evening, moveTo, BTN };
