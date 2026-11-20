'use strict';
/**
 * 👁 אישורי קריאה — האם העובד פתח את ההצעות היזומות על מיילים ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 4).
 *
 * Green API מדווח על כל הודעה שהבוט שלח: נשלחה / נמסרה / **נקראה** (‎outgoingMessageStatus‎, נפתח ב-‎checkState‎
 * עם ‎outgoingWebhook: 'yes'‎). כאן נרשמות רק ההודעות שחשובות למינון — הצעה יזומה על מייל (‎track‎) — והסטטוס שלהן
 * מתעדכן כשהדיווח מגיע (‎onStatus‎, מ-‎receiveOne‎ ב-‎wa-bot.js‎).
 *
 * הכלל (‎unreadStreak‎): ‎STREAK‎ הצעות אחרונות ברצף שנמסרו, עברו 24 שעות ולא נקראו — העובד לא פותח אותן, והמינון
 * יורד מדרגה מיד (‎MailDose.noteUnread‎), בלי לחכות לסוף השבוע. ההצעות שנספרו מסומנות, כדי שלא ייספרו שוב.
 *
 * ⚠️ עובד שכיבה "אישורי קריאה" בוואטסאפ — אצלו לעולם לא מגיע "נקרא". לכן מסיקים רק אצל מי שמהטלפון שלו הגיע
 * "נקרא" לפחות פעם אחת ב-30 הימים האחרונים (על הודעה כלשהי של הבוט שנרשמה). אצל השאר — רק שימוש בפועל.
 *
 * שכבה: כמו ‎wa-base‎ — מייבא רק את הליבה.
 */
const D = require('../core').Db;

const STREAK = 5;
const READ_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const ORDER = { sent: 1, delivered: 2, read: 3 };

/** הודעה יזומה שנשלחה לעובד — לעקוב אם נקראה. ‎idMessage‎ — מה שוואטסאפ החזיר בשליחה */
function track(userId, idMessage, kind = 'mail_alert') {
  if (!userId || !idMessage) return;
  D.run(
    `INSERT INTO wa_reads (id_message, user_id, kind, sent_at, status) VALUES (?, ?, ?, ?, 'sent')
     ON CONFLICT(id_message) DO NOTHING`,
    String(idMessage), Number(userId), String(kind), D.nowIso()
  );
}

/**
 * דיווח סטטוס מ-Green API. הסטטוס רק מתקדם (נשלחה ← נמסרה ← נקראה). "נקרא" על הודעה שלא נרשמה — לא נשמר,
 * אבל כן מסמן שהטלפון של העובד מדווח קריאה (‎reports‎).
 */
function onStatus({ idMessage, status, at = new Date(), userId = null }) {
  const s = String(status ?? '').toLowerCase();
  if (!ORDER[s] || !idMessage) return false;
  const iso = (at instanceof Date ? at : new Date(at)).toISOString();
  const row = D.get('SELECT * FROM wa_reads WHERE id_message = ?', String(idMessage));
  if (!row) {
    if (s === 'read' && userId) D.run('INSERT INTO wa_read_reporters (user_id, last_read_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_read_at = excluded.last_read_at', Number(userId), iso);
    return false;
  }
  if (ORDER[s] <= ORDER[row.status]) return false;
  D.run(`UPDATE wa_reads SET status = ?, ${s === 'read' ? 'read_at' : 'delivered_at'} = ? WHERE id_message = ?`, s, iso, row.id_message);
  if (s === 'read') D.run('INSERT INTO wa_read_reporters (user_id, last_read_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_read_at = excluded.last_read_at', row.user_id, iso);
  return true;
}

/** הטלפון של העובד מדווח "נקרא" (קיבלנו ממנו "נקרא" ב-30 הימים האחרונים) */
function reports(userId) {
  const r = D.get('SELECT last_read_at FROM wa_read_reporters WHERE user_id = ?', Number(userId));
  return Boolean(r && Date.now() - new Date(r.last_read_at).getTime() < KEEP_DAYS * 86400000);
}

/**
 * ‎STREAK‎ ההצעות האחרונות (שעברו עליהן 24 שעות) — כולן נמסרו ואף אחת לא נקראה? מסמן אותן כנספרו ומחזיר ‎true‎.
 * רק אצל מי שמדווח קריאה. הצעה שנקראה באמצע — שוברת את הרצף.
 */
function unreadStreak(userId, { now = Date.now() } = {}) {
  if (!userId || !reports(userId)) return false;
  const before = new Date(now - READ_WINDOW_MS).toISOString();
  const last = D.all(
    `SELECT * FROM wa_reads WHERE user_id = ? AND kind = 'mail_alert' AND sent_at <= ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
    Number(userId), before, STREAK
  );
  if (last.length < STREAK) return false;
  if (last.some((r) => r.status !== 'delivered' || r.counted)) return false;
  for (const r of last) D.run('UPDATE wa_reads SET counted = 1 WHERE id_message = ?', r.id_message);
  return true;
}

/** כמה מההצעות של 30 הימים האחרונים נקראו — למסך העלות */
function stats(userId) {
  const since = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  const r = D.get(
    `SELECT COUNT(*) sent, SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) read FROM wa_reads WHERE user_id = ? AND kind = 'mail_alert' AND sent_at >= ?`,
    Number(userId), since
  );
  return { sent: r?.sent ?? 0, read: r?.read ?? 0, reports: reports(userId) };
}

function prune() {
  D.run('DELETE FROM wa_reads WHERE sent_at < ?', new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
}

module.exports = { track, onStatus, reports, unreadStreak, stats, prune, STREAK };
