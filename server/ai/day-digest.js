'use strict';
/**
 * ☀️ סיכום בוקר ו-🌙 סיכום סוף יום (רעיונות 1+2, הוחלט 09.11.26).
 *
 * בוקר (‎digest_morning‎, ברירת מחדל 08:15), בימי א׳–ה׳:
 *   📋 משימות להיום (ובאיחור) · 📬 מיילים מאתמול שעוד מחכים לך (מה שלא טופל — ענית / ארכיון / החלטת)
 *   · ⏳ מחכה לך מאחרים (מיילים ששלחת ולא נענו, משימות שהטלת ובאיחור) · ⏰ תזכורות להיום.
 *   מי שבחר קצב "רק בסיכום הבוקר" — זו התזכורת היחידה על המיילים.
 * סוף יום (‎digest_evening‎, ברירת מחדל 17:30):
 *   ✅ מה נסגר היום · ➡️ מה עוד פתוח להיום — [להעביר למחר ✅] מעביר את תאריך היעד ליום העבודה הבא.
 *
 * הודעה אחת בבוקר ואחת בערב. יום בלי כלום — בלי הודעה.
 */
const D = require('../db');
const W = require('../workdays');

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

async function morning(userId) {
  const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  const tasks = myOpenDue(userId);
  const overdue = tasks.filter((t) => t.due_date < startOfToday());
  let mails = [];
  try { mails = await require('./mail-actions').dueReminders(userId, { limit: 8 }); } catch { /* בלי מייל */ }
  const sentWaiting = D.all("SELECT to_name, to_email, asked FROM sent_followups WHERE user_id = ? AND status IN ('pending', 'asked') ORDER BY sent_at LIMIT 5", userId);
  const assigned = waitingTasks(userId);
  const reminders = D.all("SELECT text, due_at FROM reminders WHERE user_id = ? AND status = 'active' AND due_at < ? ORDER BY due_at", userId, endOfToday());
  if (!tasks.length && !mails.length && !sentWaiting.length && !assigned.length && !reminders.length) return null;
  const pace = D.userPrefs(userId)?.botPrefs?.remindPace ?? 'normal';
  const lines = [`☀️ *בוקר טוב ${firstName(u?.full_name)}!*`];
  if (tasks.length) {
    lines.push('', `📋 *משימות להיום* (${tasks.length}${overdue.length ? `, ${overdue.length} באיחור` : ''}):`, ...tasks.slice(0, 6).map((t) => `• ${oneLine(t.title, 70)}${t.due_date < startOfToday() ? ' ⚠️' : ''}`));
    if (tasks.length > 6) lines.push(`ועוד ${tasks.length - 6} — באפליקציה.`);
  }
  // 📬 רק החשובים ברשימה; כמה מחכים בסך הכול — שורה אחת (‎mail-push.js‎, 10.11.26)
  if (mails.length) {
    lines.push('', `📬 *מיילים חשובים שמחכים לך* (${mails.length}${mails.length === 8 ? '+' : ''}):`, ...mails.slice(0, 5).map((m) => `• ${oneLine(parseJson(m.data, {}).title ?? m.subject, 60)} — ${m.from_name || m.from_email}`));
  }
  const mailLine = (() => { try { return require('./mail-push').morningLine(userId); } catch { return null; } })();
  if (mailLine && pace !== 'off') lines.push('', mailLine);
  if (sentWaiting.length || assigned.length) {
    lines.push('', '⏳ *מחכה לך מאחרים:*',
      ...sentWaiting.map((s) => `• 📤 ${s.to_name || s.to_email}: ${oneLine(s.asked, 60)}`),
      ...assigned.slice(0, 5).map((t) => `• 📋 ${t.who}: ${oneLine(t.title, 60)} (באיחור)`));
  }
  if (reminders.length) lines.push('', '⏰ *תזכורות להיום:*', ...reminders.map((r) => `• ${time(r.due_at)} ${oneLine(r.text, 70)}`));
  return { text: lines.join('\n') };
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
  const WaUi = require('./wa-ui');
  const n = WaUi.normalize(t);
  if (WaUi.sameLabel(t, BTN.keep) || /^(להשאיר|לא|👎)([\s,.!]|$)/.test(n)) return { text: 'בסדר, נשארות כמו שהן 👍', result: 'להשאיר' };
  if (!(WaUi.sameLabel(t, BTN.move) || /^(להעביר|כן|העבר|👍)([\s,.!]|$)/.test(n))) return null;
  const n2 = moveTo(userId, d.taskIds ?? [], d.to, 'מסיכום סוף היום בבוט');
  return { text: `➡️ הועברו ${n2 === 1 ? 'משימה אחת' : `${n2} משימות`} למחר. ערב טוב! 🌙`, result: `הועברו ${n2} למחר` };
}

/**
 * הסבב: בוקר וערב, פעם אחת ביום לכל עובד. ‎io‎ — ‎{ users() → [{id}], push(userId, msg) }‎
 */
async function tick(io) {
  const today = W.todayIL();
  const wd = W.weekdayOf(today);
  if (wd === 5 || wd === 6) return;
  const now = hm();
  for (const [key, at, build] of [['morning', String(D.getSetting('digest_morning', '08:15')), morning], ['evening', String(D.getSetting('digest_evening', '17:30')), evening]]) {
    if (now < at) continue;
    const sent = D.getSetting(`digest_sent_${key}`, {}) ?? {};
    for (const u of io.users()) {
      if (sent[u.id] === today) continue;
      sent[u.id] = today;
      D.setSetting(`digest_sent_${key}`, sent);
      try {
        const m = await build(u.id);
        if (m) await io.push(u.id, m, key);
      } catch (err) {
        console.error(`[משימון] סיכום ${key === 'morning' ? 'בוקר' : 'ערב'} נכשל:`, err.message);
      }
    }
  }
}

module.exports = { tick, answer, morning, evening, moveTo, BTN };
