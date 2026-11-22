'use strict';
/**
 * 📭 סינון לפני AI — ניוזלטרים ומענים אוטומטיים לא נשלחים ל-Claude בכלל ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 5.3;
 * אושר 20.11.26). הסריקה בוחנת כל מייל שלא נקרא, וכל מייל הוא קריאה ל-AI — מייל שיודע להגיד על עצמו "אני דיוור"
 * לא צריך אותה.
 *
 * **מסוננים** (‎reason‎):
 *   • ‎auto_reply‎ — מענה אוטומטי ("מחוץ למשרד"): ‎Auto-Submitted: auto-replied‎, ‎X-Autoreply‎, או כותרת כזו.
 *   • ‎newsletter‎ — דיוור: ‎List-Unsubscribe‎, או ‎Precedence: bulk / list / junk‎.
 *
 * **לעולם לא מסוננים** (גוברים על כל סימן):
 *   • מייל עם קובץ מצורף — חשבונית, תעודת משלוח, טופס (‎goods_document‎ / ‎blank_form‎ בניתוח);
 *   • שולח מהארגון (כתובת של עובד, או הדומיין של הארגון — לא Gmail וכדומה) — גם קבוצת תפוצה פנימית;
 *   • שולח שהעובד סימן "מהימן";
 *   • תשובה בשרשור (‎In-Reply-To‎) — חוץ ממענה אוטומטי — אדם עונה.
 * **לא מסוננים בכוונה:** ‎noreply‎ / ‎Auto-Submitted: auto-generated‎ בלי סימן דיוור — כך נראות גם בקשות אישור ממערכות
 * (פריוריטי, ספקים), ושם יש משימה.
 */
const D = require('../core').Db;

/** דומיינים ציבוריים — כתובת של עובד בהם אינה הופכת את כל הדומיין ל"ארגון" */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com',
  'walla.co.il', 'walla.com', 'bezeqint.net', 'netvision.net.il', '012.net.il', 'zahav.net.il', 'aol.com', 'proton.me', 'protonmail.com'
]);

// בסוף — לא ‎\b‎: הוא לא עובד עם אותיות עבריות
const AUTO_REPLY_SUBJECT = /^(?:re:\s*)?(?:automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|מענה אוטומטי|תשובה אוטומטית|מחוץ למשרד)(?=$|[\s:,.\-–])/i;

const enabled = () => Boolean(D.getSetting('ai_scan_skip_bulk', true));

/** הכתובות והדומיינים של הארגון — מהעובדים הפעילים */
function org() {
  const emails = new Set();
  const domains = new Set();
  for (const r of D.all("SELECT email FROM users WHERE status = 'active' AND email <> ''")) {
    const e = String(r.email).toLowerCase().trim();
    emails.add(e);
    const d = e.split('@')[1];
    if (d && !PUBLIC_DOMAINS.has(d)) domains.add(d);
  }
  return { emails, domains };
}

/**
 * למה לא לשלוח את המייל ל-AI — ‎'auto_reply'‎ / ‎'newsletter'‎ — או ‎null‎ (לשלוח).
 * ‎mail‎ — מ-‎Mime.parse‎. ‎trusted‎ — השולח מסומן "מהימן" אצל העובד. ‎orgInfo‎ — לבדיקות (ברירת מחדל: מהמסד).
 */
function reason(mail, { trusted = false, orgInfo = null } = {}) {
  if (!enabled() || !mail) return null;
  if ((mail.attachments ?? []).length) return null;
  if (trusted) return null;
  const from = String(mail.from?.address ?? '').toLowerCase();
  const { emails, domains } = orgInfo ?? org();
  if (!from || emails.has(from) || domains.has(from.split('@')[1] ?? '')) return null;
  if (mail.autoReply || AUTO_REPLY_SUBJECT.test(String(mail.subject ?? '').trim())) return 'auto_reply';
  if ((mail.inReplyTo ?? []).length) return null;
  if (mail.listUnsubscribe || /^(bulk|list|junk)/i.test(String(mail.precedence ?? ''))) return 'newsletter';
  return null;
}

/** כמה מיילים סוננו בלי AI מאז ‎sinceIso‎ — למסך העלות */
function countSince(sinceIso) {
  const rows = D.all("SELECT outcome, COUNT(*) c FROM mail_scanned WHERE outcome LIKE 'bulk%' AND scanned_at >= ? GROUP BY outcome", sinceIso);
  return { total: rows.reduce((a, r) => a + r.c, 0), byReason: Object.fromEntries(rows.map((r) => [r.outcome.replace(/^bulk:?/, '') || 'newsletter', r.c])) };
}

module.exports = { reason, countSince, PUBLIC_DOMAINS };
