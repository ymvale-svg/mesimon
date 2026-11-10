'use strict';
/**
 * מזכירות החברה — מי מנהלי המחלקות יכולים להטיל עליו משימות.
 *
 * מזכירות החברה מסומנות בכרטיס העובד ("📅 מזכירות", ‎users.is_secretary‎) —
 * כרגע שושנה ולבנה. הן משרתות את כל המחלקות:
 *   • מנהלי מחלקות (ומעלה) פותחים להן משימות — בדרך כלל פגישות לקביעה, אבל לא
 *     רק — גם כשהן יושבות במחלקה אחרת (‎assertMayAssignTo‎ ב-api.js).
 *   • משימה כזו מסומנת ‎secretary_request‎, וכשהמזכירה קובעת מתוכה פגישה
 *     ביומן — היא נסגרת לבד (‎meetings.js‎).
 */
const D = require('./db');
const P = require('./permissions');

/** מזכירת החברה — הסימון בכרטיס העובד */
const isSecretary = (userId) =>
  Boolean(userId && D.get("SELECT is_secretary FROM users WHERE id = ? AND status = 'active'", userId)?.is_secretary);

/** מנהל מחלקה ומעלה — מי שפותח משימות למזכירות */
const isRequester = (actor) => actor?.type === 'user'
  && ((P.ROLE_RANK[actor.role] ?? 0) >= P.ROLE_RANK.manager
    || Boolean(D.get('SELECT 1 FROM departments WHERE manager_user_id = ?', actor.id)));

/** האם ‎actor‎ רשאי לפתוח משימה למזכירה ‎targetId‎ */
const mayRequest = (actor, targetId) =>
  isRequester(actor) && Boolean(targetId) && Number(targetId) !== actor.id && isSecretary(Number(targetId));

/** המזכירות שהמשתמש רשאי לפתוח להן משימות — לסימון בבוררי האחראי */
function secretariesFor(actor) {
  if (!isRequester(actor)) return new Set();
  return new Set(D.all("SELECT id FROM users WHERE status = 'active' AND is_secretary = 1 AND id <> ?", actor.id).map((u) => u.id));
}

/*
 * 📅 המזכירות אינן משתתפות בפגישות (הוחלט 10.11.26, ישראל: "במשתתפים ביומן לא אמורים להיות המזכירות — הן אף פעם
 * לא משתתפות בפגישות. וזה שהמזכירות שלחו מייל — לא רלוונטי לפגישה, אלא אם זה נוגע לתוכן שלה"). הן קובעות, מזמינות
 * ומעבירות קישורים — ולכן מופיעות ביומן. בכל מה שנבנה מרשימת המשתתפים (תדריך, "איך היה?", משימות מהקלטה, "פגישה
 * אמיתית") — הן לא נספרות. לפי כתובת: המייל, מייל העבודה והתיבות המחוברות שלהן.
 */
let cache = { at: 0, emails: new Set() };
function secretaryEmails() {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.emails;
  const ids = D.all("SELECT id, email, work_email FROM users WHERE status = 'active' AND is_secretary = 1");
  const emails = new Set();
  for (const u of ids) {
    for (const e of [u.email, u.work_email]) if (e) emails.add(String(e).toLowerCase());
    for (const r of D.all('SELECT email FROM mail_connections WHERE user_id = ? UNION SELECT email FROM mail_accounts WHERE user_id = ?', u.id, u.id)) {
      if (r.email) emails.add(String(r.email).toLowerCase());
    }
  }
  cache = { at: Date.now(), emails };
  return emails;
}
const isSecretaryEmail = (email) => Boolean(email) && secretaryEmails().has(String(email).toLowerCase().trim());
/** הכתובת שבתוך "שם <a@b>" או ‎{email}‎ */
const emailIn = (p) => String((typeof p === 'string' ? (p.match(/[^\s<>"']+@[^\s<>"']+/) ?? [''])[0] : p?.email) ?? '').toLowerCase();
/** רשימת משתתפים בלי המזכירות (אובייקטים עם ‎email‎, או מחרוזות "שם <מייל>") */
const withoutSecretaries = (list) => (list ?? []).filter((p) => !isSecretaryEmail(emailIn(p)));

module.exports = { isSecretary, isRequester, mayRequest, secretariesFor, secretaryEmails, isSecretaryEmail, withoutSecretaries };
