'use strict';
/**
 * 👤 בעל המייל — לכל מייל (‎Message-ID‎) בעלים אחד בארגון. רק לו הבוט מזכיר ("זכרת?"), מציע תשובה, מציע קבלת
 * סחורה או מילוי טופס. כך מייל שנשלח לעשרה לא מקפיץ עשר הודעות.
 * "תוכנית — חלוקת תפקידים בוט ומשימון.md", סעיף 1 (הוחלט 15.11.26).
 *
 * סדר ההכרעה (רק נמענים ב-"אל" שהם משתמשי משימון; העתק — לעולם לא בעלים):
 *   0. נמען אחד ← הוא.
 *   1. המייל פונה לאחד מהם בשמו (‎addressedTo‎ מה-AI) ← הוא.
 *   2. מנהל המחלקה שהנושא שלה (‎departments.manager_user_id‎) בין הנמענים ← הוא.
 *   3. נמענים מאותה מחלקה ← מי שכבר טיפל במיילים מהשולח; אחרת הראשון מהם ב-"אל".
 *   4. אחרת ← מי שכבר טיפל במיילים מהשולח; אחרת הראשון ב-"אל".
 * ‎bulk‎ — יותר מ-‎BULK‎ כתובות ב-"אל" (תפוצה): יש בעלים, אבל בלי תזכורות.
 * ‎handled_at‎ — מישהו מהארגון ענה בשרשור: לא מזכירים לאף אחד.
 *
 * ההכרעה נשמרת פעם אחת (‎mail_owner‎), כשהמייל נסרק לראשונה באחת התיבות, וכל השאר קוראים אותה.
 */
const D = require('../core').Db;
const Gmail = require('../integrations').Gmail;

const BULK = 6;

/** הכתובות שבכותרת ("אל" / "עותק"), באותיות קטנות, לפי הסדר ובלי כפילויות */
const emailsIn = (header) => [...new Set((String(header ?? '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []).map((e) => e.toLowerCase()))];

/** כתובת ← משתמש פעיל במשימון (הכתובת שלו במשימון, או כל אחת מהתיבות המחוברות שלו) */
function usersByEmail() {
  const map = new Map();
  for (const u of D.all("SELECT id, email, department_id FROM users WHERE status = 'active' AND role <> 'vendor'")) {
    for (const e of [u.email, ...Gmail.emailsOf(u.id)].filter(Boolean)) {
      const k = String(e).toLowerCase();
      if (!map.has(k)) map.set(k, u);
    }
  }
  return map;
}

/** מי מהמועמדים כבר טיפל במייל מהשולח הזה (אישר הצעה, ענה) — הוא "מי שמתעסק" עם השולח */
function correspondent(candidates, fromEmail) {
  if (!fromEmail || !candidates.length) return null;
  const ids = candidates.map((u) => u.id);
  const row = D.get(
    `SELECT user_id FROM ai_suggestions
      WHERE lower(from_email) = ? AND user_id IN (${ids.map(() => '?').join(',')})
        AND (status IN ('approved', 'auto') OR json_extract(data, '$.reply.sent') IS NOT NULL)
      ORDER BY id DESC LIMIT 1`,
    String(fromEmail).toLowerCase(), ...ids
  );
  return row ? candidates.find((u) => u.id === row.user_id) ?? null : null;
}

/**
 * ההכרעה — בלי לשמור. ‎to‎ — כותרת "אל"; ‎addressedTo‎ — הכתובת שה-AI זיהה שהבקשה מופנית אליה;
 * ‎departmentId‎ — המחלקה שהנושא שלה (מה-AI); ‎fromEmail‎ — השולח.
 * מחזיר ‎{ userId, reason, bulk }‎. ‎userId‎ ‎null‎ — אין אף משתמש משימון ב-"אל".
 */
function decide({ to = '', addressedTo = '', departmentId = null, fromEmail = '' } = {}) {
  const all = emailsIn(to);
  const bulk = all.length > BULK;
  const byEmail = usersByEmail();
  const recips = [];
  for (const e of all) {
    const u = byEmail.get(e);
    if (u && !recips.some((x) => x.id === u.id)) recips.push(u);
  }
  const pick = (u, reason) => ({ userId: u.id, reason, bulk });
  if (!recips.length) return { userId: null, reason: 'none', bulk };
  if (recips.length === 1) return pick(recips[0], 'only');

  const named = addressedTo ? byEmail.get(String(addressedTo).toLowerCase()) : null;
  if (named && recips.some((u) => u.id === named.id)) return pick(named, 'named');

  if (departmentId) {
    const managerId = D.get('SELECT manager_user_id FROM departments WHERE id = ?', departmentId)?.manager_user_id;
    const manager = recips.find((u) => u.id === managerId);
    if (manager) return pick(manager, 'dept_manager');
    const inDept = recips.filter((u) => u.department_id === departmentId);
    if (inDept.length) return pick(correspondent(inDept, fromEmail) ?? inDept[0], 'dept');
  }
  const known = correspondent(recips, fromEmail);
  if (known) return pick(known, 'correspondent');
  return pick(recips[0], 'first');
}

const rowOf = (headerId) => (headerId ? D.get('SELECT * FROM mail_owner WHERE header_id = ?', headerId) ?? null : null);

/** קובע את הבעלים, אם עוד לא נקבע (הסריקה הראשונה קובעת; האחרות קוראות). מחזיר את השורה */
function assign(headerId, info) {
  if (!headerId) return null;
  D.run('INSERT OR IGNORE INTO mail_owner (header_id, user_id, reason, bulk, created_at) VALUES (?,?,?,?,?)',
    headerId, info?.userId ?? null, info?.reason ?? '', info?.bulk ? 1 : 0, D.nowIso());
  return rowOf(headerId);
}

/**
 * מותר לבוט לפנות לעובד על המייל הזה? בעלים, לא תפוצה, ואף אחד מהארגון לא ענה.
 * אין שורה (מייל מלפני השינוי) או שלא נמצא בעלים — כמו קודם (הסינון של "אל" / "עותק" נשאר ב-‎MailPush.direct‎).
 */
function mayPush(userId, headerId) {
  const r = rowOf(headerId);
  if (!r) return true;
  if (r.handled_at || r.bulk) return false;
  return r.user_id === null || r.user_id === userId;
}

/** הבעלים של המייל — ‎{ userId, name }‎, או ‎null‎ */
function ownerOf(headerId) {
  const r = rowOf(headerId);
  if (!r?.user_id) return null;
  return { userId: r.user_id, name: D.get('SELECT full_name FROM users WHERE id = ?', r.user_id)?.full_name ?? '' };
}

/** מישהו מהארגון ענה בשרשור — מסמנים את המיילים שהוא ענה עליהם כמטופלים, לכולם */
function markHandled(headerIds) {
  const ids = [...new Set((headerIds ?? []).filter(Boolean))];
  const now = D.nowIso();
  for (const id of ids) D.run('UPDATE mail_owner SET handled_at = COALESCE(handled_at, ?) WHERE header_id = ?', now, id);
  return ids.length;
}

/** העובד הוא הבעלים (או שלא נמצא בעלים / מייל מלפני השינוי) — לקבלת סחורה ולטופס, גם בתפוצה */
function isOwner(userId, headerId) {
  const r = rowOf(headerId);
  return !r || r.user_id === null || r.user_id === userId;
}

/** מייל ממשתמש בארגון שעונה בשרשור (‎In-Reply-To‎ / ‎References‎) — המיילים בשרשור טופלו, לכולם */
function noteOrgReply(fromEmail, refs) {
  if (!fromEmail || !refs?.length) return 0;
  if (!usersByEmail().has(String(fromEmail).toLowerCase())) return 0;
  return markHandled(refs);
}

/** "זה שלי" — עובד לוקח את המייל לעצמו */
function take(userId, headerId) {
  if (!headerId) return null;
  D.run(`INSERT INTO mail_owner (header_id, user_id, reason, bulk, created_at) VALUES (?,?,'taken',0,?)
         ON CONFLICT(header_id) DO UPDATE SET user_id = excluded.user_id, reason = 'taken', bulk = 0`, headerId, userId, D.nowIso());
  return rowOf(headerId);
}

module.exports = { BULK, emailsIn, decide, assign, mayPush, isOwner, ownerOf, markHandled, noteOrgReply, take };
