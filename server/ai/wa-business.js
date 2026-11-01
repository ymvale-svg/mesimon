'use strict';
/**
 * וואטסאפ אישי — מי נחשב איש קשר עסקי (פרק 7 באפיון).
 *
 * העיקרון: הוואטסאפ האישי של עובד נסרק רק בשיחות עם אנשי קשר עסקיים. כל שיחה
 * אחרת אינה נשלחת ל-AI בכלל — לא להצעות ולא לתובנות.
 *
 * עסקי אוטומטית — המספר, אחרי נרמול, נמצא באחד מאלה:
 *   • עובד בארגון (‎users.phone‎, משתמש פעיל)
 *   • איש קשר באלפון — טלפון ראשי וטלפון 2 (הוספה לאלפון = עסקי לכולם)
 *   • ספק רשום (‎vendors.phone‎)
 *   • איש קשר בגוגל של העובד עם חברה או תפקיד
 *   • מי שהופיע אצל העובד בעבודה: נמען של משימת AI, שולח של הצעה מהוואטסאפ
 *     שהפכה למשימה, משתתף בפגישה שלו (לפי המייל, דרך אנשי הקשר בגוגל)
 * ועוד שתי רשימות אישיות (‎waScan‎ בהעדפות):
 *   • ‎business‎ — "אנשי קשר עסקיים נוספים", שסומנו ידנית
 *   • ‎ignore‎ — "לא לסרוק". גוברת על כל השאר.
 *
 * מספר לא מוכר: סופרים הודעות בלי לקרוא אותן. אחרי ‎ASK_AFTER‎ הודעות — שואלים
 * את העובד פעם אחת "עסקי או אישי?" (‎whatsapp-scan.js‎ והבוט).
 *
 * ‎classify‎ טהורה — מקבלת את הרשימות ואינה נוגעת במסד הנתונים.
 */
const D = require('../db');
const WhatsApp = require('../whatsapp');

const ASK_AFTER = 3;

const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const norm = (p) => WhatsApp.normalizePhone(p);

/**
 * ‎'ignore'‎ | ‎'business'‎ | ‎'unknown'‎. "לא לסרוק" גוברת על "עסקי".
 * @param {string} phone  מנורמל (‎972…‎)
 * @param {{ignore: Set, business: Set, auto: Set}} lists
 */
function classify(phone, { ignore, business, auto }) {
  const n = norm(phone);
  if (!n) return 'unknown';
  if (ignore?.has(n)) return 'ignore';
  if (business?.has(n) || auto?.has(n)) return 'business';
  return 'unknown';
}

/** כל המספרים שעסקיים אוטומטית לעובד. נבנה פעם אחת לכל סבב קריאה */
function autoPhones(userId) {
  const out = new Set();
  const add = (p) => {
    const n = norm(p);
    if (n) out.add(n);
  };
  for (const r of D.all("SELECT phone FROM users WHERE status = 'active' AND phone <> ''")) add(r.phone);
  for (const r of D.all("SELECT phone, phone2 FROM phonebook WHERE phone <> '' OR phone2 <> ''")) { add(r.phone); add(r.phone2); }
  for (const r of D.all("SELECT phone FROM vendors WHERE phone <> ''")) add(r.phone);

  // אנשי קשר בגוגל — רק עם חברה או תפקיד: "אמא" אינה איש קשר עסקי
  for (const r of D.all("SELECT phones FROM google_contacts WHERE user_id = ? AND (organization <> '' OR title <> '')", userId)) {
    for (const p of parseJson(r.phones, [])) add(p?.value ?? p);
  }

  // מי שהופיע אצלו בעבודה
  for (const r of D.all("SELECT DISTINCT contact_phone FROM ai_requests WHERE owner_id = ? AND contact_phone <> ''", userId)) add(r.contact_phone);
  for (const r of D.all(
    `SELECT DISTINCT json_extract(data, '$.chatPhone') AS phone FROM ai_suggestions
      WHERE user_id = ? AND status IN ('approved', 'auto') AND json_extract(data, '$.personal') = 1`, userId
  )) add(r.phone);
  const emails = new Set();
  for (const r of D.all('SELECT attendees FROM meetings WHERE owner_id = ? OR created_by = ?', userId, userId)) {
    for (const a of parseJson(r.attendees, [])) if (a?.email) emails.add(String(a.email).toLowerCase());
  }
  if (emails.size) {
    for (const r of D.all('SELECT emails, phones FROM google_contacts WHERE user_id = ?', userId)) {
      const mails = parseJson(r.emails, []).map((e) => String(e?.value ?? e).toLowerCase());
      if (mails.some((e) => emails.has(e))) for (const p of parseJson(r.phones, [])) add(p?.value ?? p);
    }
  }
  return out;
}

/** "050-1234567" — מספר מנורמל לתצוגה */
const display = (phone) => {
  const n = String(phone ?? '');
  if (/^9725\d{8}$/.test(n)) return `0${n.slice(3, 5)}-${n.slice(5)}`;
  return n.startsWith('972') ? `0${n.slice(3)}` : n;
};

/**
 * "דני" / "050-1234567" ← המספרים שהעובד אולי התכוון אליהם: מי שכתב לו
 * לאחרונה (הצעות, תובנות, מספרים לא מוכרים), אנשי הקשר שלו בגוגל והאלפון.
 * @returns {{phone: string, name: string}[]}
 */
function resolve(userId, query, unknown = {}) {
  const q = String(query ?? '').trim().replace(/^את\s+/, '').replace(/[?!.]+$/, '');
  if (!q) return [];
  const digits = q.replace(/[\s-]/g, '');
  if (/^\+?\d{9,15}$/.test(digits)) {
    const n = norm(digits);
    return n ? [{ phone: n, name: '' }] : [];
  }
  const found = new Map();
  const add = (phone, name) => {
    const n = norm(phone);
    if (n && !found.has(n)) found.set(n, { phone: n, name: String(name || display(n)) });
  };
  const like = `%${q}%`;
  for (const [phone, u] of Object.entries(unknown ?? {})) if (String(u?.name ?? '').includes(q)) add(phone, u.name);
  for (const r of D.all(
    `SELECT DISTINCT from_name, json_extract(data, '$.chatPhone') AS phone FROM ai_suggestions
      WHERE user_id = ? AND json_extract(data, '$.personal') = 1 AND from_name LIKE ? ORDER BY id DESC LIMIT 10`, userId, like
  )) add(r.phone, r.from_name);
  for (const r of D.all("SELECT DISTINCT sender_name, chat_id FROM wa_insights WHERE scope = 'personal' AND owner_id = ? AND sender_name LIKE ? LIMIT 10", userId, like)) {
    add(r.chat_id, r.sender_name);
  }
  for (const r of D.all('SELECT name, phones FROM google_contacts WHERE user_id = ? AND name LIKE ? LIMIT 10', userId, like)) {
    for (const p of parseJson(r.phones, [])) add(p?.value ?? p, r.name);
  }
  for (const r of D.all("SELECT name, phone, phone2 FROM phonebook WHERE name LIKE ? LIMIT 10", like)) { add(r.phone, r.name); add(r.phone2, r.name); }
  for (const r of D.all("SELECT full_name, phone FROM users WHERE status = 'active' AND phone <> '' AND full_name LIKE ? LIMIT 10", like)) add(r.phone, r.full_name);
  return [...found.values()].slice(0, 8);
}

module.exports = { ASK_AFTER, classify, autoPhones, resolve, display };
