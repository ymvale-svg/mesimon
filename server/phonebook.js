'use strict';
/**
 * 📒 אלפון ארגוני — שם, טלפון, מייל והערה, משותף לכל העובדים.
 *
 * כל עובד רואה, מוסיף, משנה ומוחק. ספקים לא רואים: זה ספר הטלפונים של
 * הארגון, ולא רשימה שנחשפת החוצה.
 *
 * החיפוש כאן, בקוד, ולא ב-SQL ‎LIKE‎: הדירוג הוא העיקר. מי שמקליד "דני"
 * מחפש אדם בשם דני, ולכן קודם שמות שמתחילים ב"דני", אחר כך שמות שאחת
 * המילים בהם מתחילה ב"דני", אחר כך שמות שמכילים, ורק אחר כך התאמה בטלפון,
 * במייל או בהערה. האלפון של ארגון הוא אלפים בודדים של שורות — סריקה בזיכרון
 * מיידית.
 */
const D = require('./db');

const MAX = { name: 120, phone: 40, email: 160, note: 300 };

/** טלפון בספרות בלבד, בקידומת מקומית: ‎+972-50-123‎ ו-‎050123‎ הם אותו מספר */
function phoneDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return d;
}

const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    note: row.note,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name ?? null,
    createdBy: row.created_by_name ?? null
  };
}

const SELECT = `SELECT p.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
  FROM phonebook p
  LEFT JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users uu ON uu.id = p.updated_by`;

/**
 * דירוג התאמה לשורה. קטן = טוב יותר; ‎null‎ — לא מתאים.
 *   0 שם מתחיל · 1 מילה בשם מתחילה · 2 שם מכיל · 3 טלפון · 4 מייל · 5 הערה
 */
function rank(row, q, qDigits) {
  const name = norm(row.name);
  if (name.startsWith(q)) return 0;
  if (name.split(/[\s\-–—'"׳״.,()]+/).some((w) => w && w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (qDigits.length >= 2 && row.phone_digits.includes(qDigits)) return 3;
  if (row.email && row.email.toLowerCase().includes(q)) return 4;
  if (row.note && norm(row.note).includes(q)) return 5;
  return null;
}

/** חיפוש: שמות קודם, אחר כך טלפון ומייל, ואחר כך הערות. בלי ‎q‎ — לפי א"ב */
function search(q = '', { limit = 20 } = {}) {
  const rows = D.all(`${SELECT} ORDER BY p.name COLLATE NOCASE`);
  const query = norm(q);
  if (!query) return rows.slice(0, limit).map(shape);
  const qDigits = phoneDigits(query);
  return rows
    .map((row) => ({ row, r: rank(row, query, qDigits) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => a.r - b.r || a.row.name.localeCompare(b.row.name, 'he'))
    .slice(0, limit)
    .map((x) => ({ ...shape(x.row), match: ['name', 'name', 'name', 'phone', 'email', 'note'][x.r] }));
}

const all = () => D.all(`${SELECT} ORDER BY p.name COLLATE NOCASE`).map(shape);
const count = () => D.get('SELECT COUNT(*) AS n FROM phonebook').n;
const byId = (id) => {
  const row = D.get(`${SELECT} WHERE p.id = ?`, id);
  return row ? shape(row) : null;
};

/** ניקוי ובדיקה של שורה. זורק שגיאה בעברית שהמשתמש יכול לתקן */
function clean(input) {
  const out = {
    name: String(input?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX.name),
    phone: String(input?.phone ?? '').trim().slice(0, MAX.phone),
    email: String(input?.email ?? '').trim().toLowerCase().slice(0, MAX.email),
    note: String(input?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX.note)
  };
  if (!out.name) throw new Error('נדרש שם');
  if (!out.phone && !out.email) throw new Error('נדרש טלפון או מייל');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error('כתובת המייל אינה תקינה');
  if (out.phone && phoneDigits(out.phone).length < 7) throw new Error('מספר הטלפון אינו תקין');
  return out;
}

/** שורות אחרות עם אותו טלפון או מייל — לאזהרה, לא לחסימה */
function duplicatesOf({ phone, email }, exceptId = null) {
  const digits = phoneDigits(phone);
  const rows = D.all(
    `SELECT id, name FROM phonebook
      WHERE id IS NOT ? AND ((? <> '' AND phone_digits = ?) OR (? <> '' AND email = ?))`,
    exceptId, digits, digits, email ?? '', String(email ?? '').toLowerCase()
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

function create(actor, input) {
  const c = clean(input);
  const now = D.nowIso();
  const r = D.run(
    `INSERT INTO phonebook (name, phone, phone_digits, email, note, created_at, created_by, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    c.name, c.phone, phoneDigits(c.phone), c.email, c.note, now, actor.id, now, actor.id
  );
  return byId(Number(r.lastInsertRowid));
}

function update(actor, id, input) {
  if (!D.get('SELECT 1 FROM phonebook WHERE id = ?', id)) return null;
  const c = clean(input);
  D.run(
    `UPDATE phonebook SET name = ?, phone = ?, phone_digits = ?, email = ?, note = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
    c.name, c.phone, phoneDigits(c.phone), c.email, c.note, D.nowIso(), actor.id, id
  );
  return byId(id);
}

function remove(id) {
  return D.run('DELETE FROM phonebook WHERE id = ?', id).changes > 0;
}

// ---------------------------------------------------------------------------
// ייבוא מאקסל / CSV
// ---------------------------------------------------------------------------

const HEADERS = {
  name: /^(שם|שם מלא|name|full ?name|איש קשר)$/i,
  phone: /^(טלפון|נייד|טל['׳]?|מספר|מספר טלפון|phone|mobile|tel)$/i,
  email: /^(מייל|אימייל|דוא["״]?ל|דואר אלקטרוני|e-?mail)$/i,
  note: /^(הערה|הערות|תפקיד|חברה|פרויקט|note|notes|comment)$/i
};

/**
 * ניתוח טבלה שהועלתה. השורה הראשונה היא כותרות אם אחת מהן מזוהה; אחרת
 * הסדר הוא שם · טלפון · מייל · הערה. לכל שורה: הערכים, שגיאה אם יש, ואם
 * היא כפולה — מול האלפון הקיים או מול שורה קודמת בקובץ.
 */
function analyseImport(matrix) {
  const rows = (matrix ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!rows.length) return { rows: [], header: false };
  const head = rows[0].map((c) => String(c ?? '').trim());
  const map = {};
  head.forEach((h, i) => {
    for (const [key, re] of Object.entries(HEADERS)) if (map[key] === undefined && re.test(h)) map[key] = i;
  });
  const header = Object.keys(map).length > 0;
  const col = header ? map : { name: 0, phone: 1, email: 2, note: 3 };
  const body = header ? rows.slice(1) : rows;

  const seen = new Set();
  return {
    header,
    rows: body.map((r, i) => {
      const raw = Object.fromEntries(['name', 'phone', 'email', 'note'].map((k) => [k, col[k] === undefined ? '' : String(r[col[k]] ?? '').trim()]));
      let value = null;
      let error = '';
      try { value = clean(raw); } catch (err) { error = err.message; }
      const keys = value ? [phoneDigits(value.phone), value.email].filter(Boolean) : [];
      const inFile = keys.some((k) => seen.has(k));
      keys.forEach((k) => seen.add(k));
      const existing = value ? duplicatesOf(value) : [];
      return {
        line: i + (header ? 2 : 1),
        ...(value ?? raw),
        error,
        duplicate: existing.length ? `כבר באלפון: ${existing.map((d) => d.name).join(', ')}` : inFile ? 'כפול בתוך הקובץ' : ''
      };
    })
  };
}

/** שמירת השורות התקינות; כפולות מדולגות אלא אם ביקשו לכלול אותן */
function commitImport(actor, analysis, { includeDuplicates = false } = {}) {
  let created = 0;
  let skipped = 0;
  for (const row of analysis.rows) {
    if (row.error || (row.duplicate && !includeDuplicates)) { skipped += 1; continue; }
    create(actor, row);
    created += 1;
  }
  return { created, skipped };
}

module.exports = {
  search, all, count, byId, create, update, remove, duplicatesOf, phoneDigits,
  analyseImport, commitImport
};
