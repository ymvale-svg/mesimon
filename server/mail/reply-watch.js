'use strict';
/**
 * 📬 "קיבלת תשובה" — מעקב על תשובות למייל שיצא ממשימון (הוחלט 10.11.26).
 *
 * העובד ענה למייל דרך הבוט ("תענה לו ש…") או מהאפליקציה, והצד השני חזר אליו — עד עכשיו הבוט שתק, אלא
 * אם הסריקה מצאה במייל החדש משימה. עכשיו: כל תשובה שיוצאת ב-‎mail-insights.sendReply‎ נרשמת כאן, השרשור
 * נבדק כל 5 דקות (שבוע), וכשמגיעה תשובה — הודעה אחת:
 *
 *   📬 *Licentek* ענה למייל ששלחת: _חשבונית 30549_
 *   _שלחתי שוב את החשבונית עם מספר הקצאה…_
 *   📎 קובץ מצורף אחד
 *
 * מידע בלבד — בלי שאלה ובלי כפתורים, ולכן אינה מחכה לשאלה אחרת שפתוחה. אם יש במייל גם משימה או צורך
 * בתשובה — הפנייה הרגילה על מייל חדש (‎mailAlerts‎) תבוא בנפרד.
 */
const D = require('../core').Db;
const Gmail = require('../integrations').Gmail;
const Mime = require('../core').Mime;

const DAY = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 7;
const POLL_MS = 5 * 60 * 1000;
const AUTO = /no-?reply|noreply|mailer-daemon|postmaster|donotreply/i;
const oneLine = (x, n) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

/** מייל שיצא — מתחילים לחכות לתשובה בשרשור שלו */
function track(userId, reply, sent) {
  const threadId = sent?.threadId || reply?.threadId;
  if (!threadId) return;
  const box = Number(reply.box ?? 0);
  const now = D.nowIso();
  // תשובה נוספת באותו שרשור — אותה שורה, והשעון מתחיל מחדש
  const row = D.get('SELECT id FROM mail_reply_watch WHERE user_id = ? AND box = ? AND thread_id = ?', userId, box, threadId);
  if (row) {
    D.run("UPDATE mail_reply_watch SET status = 'waiting', sent_at = ?, polled_at = NULL, to_name = ?, to_email = ?, subject = ? WHERE id = ?",
      now, reply.toName ?? '', reply.to ?? '', String(reply.subject ?? '').slice(0, 300), row.id);
    return;
  }
  D.run('INSERT INTO mail_reply_watch (user_id, box, thread_id, to_name, to_email, subject, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    userId, box, threadId, reply.toName ?? '', reply.to ?? '', String(reply.subject ?? '').slice(0, 300), now, now);
}

/** התשובה הראשונה שהגיעה אחרי המייל שיצא — או ‎null‎ */
function firstReply(msgs, sentAt) {
  const after = new Date(sentAt).getTime();
  return msgs.find((m) => !m.labels.includes('SENT') && !m.labels.includes('DRAFT') && m.at && m.at.getTime() > after
    && !AUTO.test(m.headers.from ?? '') && !/auto-(?:replied|generated)/i.test(m.headers['auto-submitted'] ?? '')) ?? null;
}

function message(row, mail) {
  const who = mail.from?.name || row.to_name || mail.from?.address || row.to_email;
  const text = oneLine(mail.newText || mail.text, 300);
  const files = (mail.attachments ?? []).filter((a) => a.filename).length;
  return [
    `📬 *${who}* ענה למייל ששלחת${row.subject ? `: _${oneLine(row.subject.replace(/^(?:\s*(?:re|fwd?|תשובה|השב)\s*:\s*)+/i, ''), 90)}_` : ''}`,
    text ? `_${text}_` : null,
    files ? `📎 ${files === 1 ? 'קובץ מצורף אחד' : `${files} קבצים מצורפים`}` : null
  ].filter(Boolean).join('\n');
}

/**
 * סבב: תשובות חדשות. ‎io‎ — ‎{ may(userId), push(userId, {text}) }‎; ‎push‎ מחזיר ‎false‎ כשלא נשלח — ואז ננסה שוב.
 */
async function tick(io) {
  const now = Date.now();
  D.run("UPDATE mail_reply_watch SET status = 'expired' WHERE status = 'waiting' AND sent_at < ?", new Date(now - KEEP_DAYS * DAY).toISOString());
  for (const row of D.all("SELECT * FROM mail_reply_watch WHERE status = 'waiting' ORDER BY id")) {
    if (row.polled_at && now - new Date(row.polled_at).getTime() < POLL_MS) continue;
    if (!io.may(row.user_id)) continue;
    D.run('UPDATE mail_reply_watch SET polled_at = ? WHERE id = ?', D.nowIso(), row.id);
    try {
      const who = Gmail.handle(row.user_id, row.box ?? 0);
      const hit = firstReply(await Gmail.threadMeta(who, row.thread_id), row.sent_at);
      if (!hit) continue;
      const mail = Mime.parse((await Gmail.raw(who, hit.id)).raw);
      if (await io.push(row.user_id, { text: message(row, mail) }) === false) continue;
      D.run("UPDATE mail_reply_watch SET status = 'answered' WHERE id = ?", row.id);
    } catch (err) {
      console.error('[משימון] מעקב תשובה למייל נכשל:', err.message);
    }
  }
}

module.exports = { track, tick, _internal: { firstReply, message } };
