'use strict';
/**
 * 📒 אלפון ארגוני — שם מלא, טל' 1, טל' 2, פקס, מייל והערות (ההקשר לפרויקט),
 * משותף לכל העובדים.
 *
 * כל עובד רואה, מוסיף, משנה ומוחק. ספקים לא רואים: זה ספר הטלפונים של
 * הארגון, ולא רשימה שנחשפת החוצה.
 *
 * שלושה סוגי רשומות (‎kind‎):
 *   manual — מה שהוזן ידנית או יובא מאקסל (טבלת ‎phonebook‎)
 *   user   — כל עובד פעיל, נקרא ישירות מטבלת המשתמשים: הנייד, הטלפון
 *            במשרד / שלוחה, המייל והמחלקה
 *   vendor — כל ספק פעיל, מטבלת הספקים: איש הקשר, החברה, הטלפון והמייל
 * העובדים והספקים אינם מועתקים לאלפון — כך מה שעודכן בניהול המשתמשים או
 * בספקים מתעדכן כאן מיד, ומי שהושבת יוצא. מכאן הם לקריאה בלבד; העריכה
 * נעשית במקום שבו הם מנוהלים.
 *
 * החיפוש כאן, בקוד, ולא ב-SQL ‎LIKE‎: הדירוג הוא העיקר. מי שמקליד "דני"
 * מחפש אדם בשם דני, ולכן קודם שמות שמתחילים ב"דני", אחר כך שמות שאחת
 * המילים בהם מתחילה ב"דני", אחר כך שמות שמכילים, ורק אחר כך התאמה באחד
 * המספרים, במייל או בהערה. באותה דרגה — עובד קודם, אחריו ספק ואחריו רשומה
 * ידנית. האלפון של ארגון הוא אלפים בודדים של שורות — סריקה בזיכרון מיידית.
 */
const D = require('./db');

const MAX = { name: 120, phone: 40, email: 160, note: 300 };
const NUMBERS = ['phone', 'phone2', 'fax'];

/** טלפון בספרות בלבד, בקידומת מקומית: ‎+972-50-123‎ ו-‎050123‎ הם אותו מספר */
function phoneDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return d;
}

/** נייד ישראלי — ‎05X‎ ועשר ספרות. רק אליו אפשר לשלוח וואטסאפ */
const isMobile = (phone) => /^05\d{8}$/.test(phoneDigits(phone));

/** הנייד של איש הקשר — טל' 1 אם הוא נייד, אחרת טל' 2. אין נייד — ריק */
const mobileOf = (entry) => [entry?.phone, entry?.phone2].find((p) => p && isMobile(p)) ?? '';

const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function shape(row) {
  return {
    id: row.id,
    kind: 'manual',
    name: row.name,
    phone: row.phone,
    phone2: row.phone2 ?? '',
    fax: row.fax ?? '',
    email: row.email,
    note: row.note,
    mobile: mobileOf(row),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name ?? null,
    createdBy: row.created_by_name ?? null
  };
}

const SELECT = `SELECT p.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
  FROM phonebook p
  LEFT JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users uu ON uu.id = p.updated_by`;

// ---------------------------------------------------------------------------
// עובדים וספקים — נקראים חיים, בלי העתקה
// ---------------------------------------------------------------------------

/** הטלפון של עובד נשמר מנורמל (‎972541234567‎) — בתצוגה ישראלית: ‎054-1234567‎ */
function localPhone(stored) {
  const s = String(stored ?? '').trim();
  if (/^972\d{8,9}$/.test(s)) {
    const local = `0${s.slice(3)}`;
    return `${local.slice(0, 3)}-${local.slice(3)}`;
  }
  return /^\d{9,15}$/.test(s) ? `+${s}` : s;
}

/**
 * טלפון במשרד: מספר מלא, שלוחה בלבד, או שניהם ("03-1234567 שלוחה 12").
 * מספר עם שלוחה הוא המרכזייה — של כל המשרד ולא של העובד, ולכן אינו מזהה
 * אותו: רשומה ידנית של המרכזייה אינה "כפולה של עובד". רק קו ישיר מזהה.
 */
function officeKey(office) {
  const parts = String(office ?? '').split(/שלוחה|שלו['׳]|ext\.?|,|;|#/i);
  return parts.length > 1 && parts[1].replace(/\D/g, '') ? '' : phoneDigits(parts[0]);
}

/**
 * כל העובדים הפעילים. לא נכללים: מי שהושבת, בקשת הרשמה שממתינה לאישור
 * (‎signup_at‎ ואינה פעילה — ממילא לא ‎active‎) ומשתמש ברמת ספק — הספקים
 * מגיעים מטבלת הספקים. הנייד גלוי לכל העובדים, בלי אפשרות הסתרה (החלטה 9.1).
 */
function employees() {
  return D.all(
    `SELECT u.id, u.full_name, u.email, u.phone, u.office_phone, u.department, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.status = 'active' AND u.role <> 'vendor'`
  ).map((u) => {
    const phone = localPhone(u.phone);
    return {
      id: `u${u.id}`,
      kind: 'user',
      refId: u.id,
      name: u.full_name,
      phone,
      phone2: String(u.office_phone ?? '').trim(),
      fax: '',
      email: String(u.email ?? '').toLowerCase(),
      note: '',
      department: u.department_name || u.department || '',
      org: '',
      mobile: isMobile(phone) ? phone : ''
    };
  });
}

/** הספקים הפעילים: איש הקשר הוא השם, והחברה בתגית לידו */
function vendors() {
  return D.all("SELECT id, name, contact_name, email, phone FROM vendors WHERE status = 'active'").map((v) => {
    const phone = String(v.phone ?? '').trim();
    return {
      id: `v${v.id}`,
      kind: 'vendor',
      refId: v.id,
      name: v.contact_name || v.name,
      phone,
      phone2: '',
      fax: '',
      email: String(v.email ?? '').toLowerCase(),
      note: '',
      department: '',
      org: v.contact_name ? v.name : '',
      mobile: isMobile(phone) ? phone : ''
    };
  });
}

/** המספרים והמייל של רשומה — המפתחות שלפיהם מזהים שזה אותו אדם */
function keysOf(e) {
  const digits = [phoneDigits(e.phone), e.kind === 'user' ? officeKey(e.phone2) : phoneDigits(e.phone2), phoneDigits(e.fax)];
  return [
    ...digits.filter((d) => d.length >= 7).map((d) => `p:${d}`),
    ...(e.email ? [`e:${String(e.email).toLowerCase()}`] : [])
  ];
}

/**
 * מפתח → העובד או הספק שלו. מספר שמשותף לכמה אנשים (המרכזייה של המשרד)
 * אינו מזהה אף אחד מהם, ולכן אינו נכנס: רשומה ידנית של "המשרד הראשי" עם
 * אותו מספר אינה כפולה של אף עובד.
 */
function identityIndex(people) {
  const map = new Map();
  for (const p of people) {
    for (const k of new Set(keysOf(p))) map.set(k, map.has(k) ? null : p);
  }
  return map;
}

/**
 * כולם יחד: עובדים, ספקים ורשומות ידניות. רשומה ידנית עם מייל או טלפון של
 * עובד או ספק מסומנת ‎duplicateOf‎ — בחיפוש מוצגת רק רשומת העובד, ובמסך
 * האלפון הידנית מוצגת עם "כפולה של עובד — אפשר למחוק".
 */
function everyone() {
  const people = [...employees(), ...vendors()];
  const index = identityIndex(people);
  const manual = D.all(SELECT).map((row) => {
    const e = shape(row);
    const twin = keysOf(e).map((k) => index.get(k)).find(Boolean);
    return twin ? { ...e, duplicateOf: { id: twin.id, kind: twin.kind, name: twin.name } } : e;
  });
  return [...people, ...manual];
}

const KIND_ORDER = { user: 0, vendor: 1, manual: 2 };
const byName = (a, b) => a.name.localeCompare(b.name, 'he') || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

/**
 * דירוג התאמה לשורה. קטן = טוב יותר; ‎null‎ — לא מתאים.
 *   0 שם מתחיל · 1 מילה בשם (או בשם החברה של ספק) מתחילה · 2 שם מכיל
 *   3 אחד המספרים · 4 מייל · 5 הערה או מחלקה
 */
function rank(row, q, qDigits) {
  const name = norm(row.name);
  const org = norm(row.org);
  const words = (s) => s.split(/[\s\-–—'"׳״.,()]+/);
  if (name.startsWith(q)) return 0;
  if (words(name).some((w) => w && w.startsWith(q))) return 1;
  if (org && words(org).some((w) => w && w.startsWith(q))) return 1;
  if (name.includes(q) || (org && org.includes(q))) return 2;
  if (qDigits.length >= 2 && NUMBERS.some((k) => phoneDigits(row[k]).includes(qDigits))) return 3;
  if (row.email && row.email.toLowerCase().includes(q)) return 4;
  if (row.note && norm(row.note).includes(q)) return 5;
  if (row.department && norm(row.department).includes(q)) return 5;
  return null;
}

const MATCH = ['name', 'name', 'name', 'phone', 'email', 'note'];

/**
 * חיפוש: שמות קודם, אחר כך מספרים ומייל, ואחר כך הערות. בלי ‎q‎ — לפי א"ב.
 * רשומה ידנית שהיא כפולה של עובד או ספק אינה מוצגת — העובד עצמו מוצג.
 */
function search(q = '', { limit = 20 } = {}) {
  const rows = everyone().filter((e) => !e.duplicateOf);
  const query = norm(q);
  if (!query) return rows.sort(byName).slice(0, limit);
  const qDigits = phoneDigits(query);
  return rows
    .map((row) => ({ row, r: rank(row, query, qDigits) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => a.r - b.r || KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.row.name.localeCompare(b.row.name, 'he'))
    .slice(0, limit)
    .map((x) => ({ ...x.row, match: MATCH[x.r] }));
}

/** כל הרשומות, כולל הכפולות המסומנות — למסך האלפון */
const all = () => everyone().sort(byName);
/** כמה אנשי קשר באלפון — בלי הכפולות, כמו שהם נראים בחיפוש */
const count = () => everyone().filter((e) => !e.duplicateOf).length;
const byId = (id) => {
  const row = D.get(`${SELECT} WHERE p.id = ?`, id);
  return row ? shape(row) : null;
};

/** ניקוי ובדיקה של שורה. זורק שגיאה בעברית שהמשתמש יכול לתקן */
function clean(input) {
  const line = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = {
    name: line(input?.name, MAX.name),
    phone: line(input?.phone, MAX.phone),
    phone2: line(input?.phone2, MAX.phone),
    fax: line(input?.fax, MAX.phone),
    email: line(input?.email, MAX.email).toLowerCase(),
    note: line(input?.note, MAX.note)
  };
  // טל' 2 בלי טל' 1 — עולה למקום הראשון, כדי שהכרטיס לא יתחיל ב"טל' 2"
  if (!out.phone && out.phone2) [out.phone, out.phone2] = [out.phone2, ''];
  if (!out.name) throw new Error('נדרש שם');
  if (!out.phone && !out.phone2 && !out.fax && !out.email) throw new Error('נדרש טלפון, פקס או מייל');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error('כתובת המייל אינה תקינה');
  const label = { phone: "טל' 1", phone2: "טל' 2", fax: 'הפקס' };
  for (const k of NUMBERS) {
    if (out[k] && phoneDigits(out[k]).length < 7) throw new Error(`המספר ב${label[k]} אינו תקין`);
  }
  return out;
}

/**
 * שורות אחרות עם אותו מספר (באחד משלושת השדות) או אותו מייל — לאזהרה, לא
 * לחסימה. גם מול העובדים והספקים: "כבר באלפון: דני כהן (עובד)" — כך גם
 * הייבוא מאקסל מזהה מי כבר באלפון כעובד.
 */
function duplicatesOf(entry, exceptId = null) {
  const digits = new Set(NUMBERS.map((k) => phoneDigits(entry?.[k])).filter((d) => d.length >= 7));
  const email = String(entry?.email ?? '').trim().toLowerCase();
  if (!digits.size && !email) return [];
  const rows = D.all('SELECT id, name, phone, phone2, fax, email FROM phonebook WHERE id IS NOT ?', exceptId);
  const manual = rows
    .filter((r) => (email && r.email === email) || NUMBERS.some((k) => digits.has(phoneDigits(r[k]))))
    .map((r) => ({ id: r.id, kind: 'manual', name: r.name }));
  const wanted = new Set([...[...digits].map((d) => `p:${d}`), ...(email ? [`e:${email}`] : [])]);
  const people = [...employees(), ...vendors()]
    .filter((p) => keysOf(p).some((k) => wanted.has(k)))
    .map((p) => ({ id: p.id, kind: p.kind, name: `${p.name} (${p.kind === 'user' ? 'עובד' : 'ספק'})` }));
  return [...people, ...manual];
}

function create(actor, input) {
  const c = clean(input);
  const now = D.nowIso();
  const r = D.run(
    `INSERT INTO phonebook (name, phone, phone_digits, phone2, fax, email, note, created_at, created_by, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    c.name, c.phone, phoneDigits(c.phone), c.phone2, c.fax, c.email, c.note, now, actor.id, now, actor.id
  );
  return byId(Number(r.lastInsertRowid));
}

function update(actor, id, input) {
  if (!D.get('SELECT 1 FROM phonebook WHERE id = ?', id)) return null;
  const c = clean(input);
  D.run(
    `UPDATE phonebook SET name = ?, phone = ?, phone_digits = ?, phone2 = ?, fax = ?, email = ?, note = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
    c.name, c.phone, phoneDigits(c.phone), c.phone2, c.fax, c.email, c.note, D.nowIso(), actor.id, id
  );
  return byId(id);
}

function remove(id) {
  return D.run('DELETE FROM phonebook WHERE id = ?', id).changes > 0;
}

/** התגית של עובד או ספק — "👤 עובד · הנדסה וביצוע", "🏢 ספק · אלומיניום בע״מ" */
function tagOf(e) {
  if (e.kind === 'user') return ['👤 עובד', e.department].filter(Boolean).join(' · ');
  if (e.kind === 'vendor') return ['🏢 ספק', e.org].filter(Boolean).join(' · ');
  return '';
}

/**
 * הכרטיס כטקסט — לבוט הוואטסאפ ולעוזר. רק השדות שהוזנו: איש קשר עם שם
 * וטלפון בלבד מקבל שתי שורות, בלי "פקס: —". לעובד — "נייד" ו"משרד / שלוחה".
 */
function cardText(e) {
  const two = e.phone && e.phone2;
  const user = e.kind === 'user';
  const tag = tagOf(e);
  return [
    `📒 *${e.name}*${tag ? ` · ${tag}` : ''}`,
    e.phone ? `📞 ${user ? 'נייד' : two ? "טל' 1" : 'טלפון'}: ${e.phone}` : null,
    e.phone2 ? `📞 ${user ? 'משרד / שלוחה' : "טל' 2"}: ${e.phone2}` : null,
    e.fax ? `📠 פקס: ${e.fax}` : null,
    e.email ? `✉️ ${e.email}` : null,
    e.note ? `📝 ${e.note}` : null
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// ייבוא מאקסל / CSV
// ---------------------------------------------------------------------------

const FIELDS = ['name', 'phone', 'phone2', 'fax', 'email', 'note'];
const HEADERS = {
  name: /^(שם|שם מלא|name|full ?name|איש קשר)$/i,
  phone: /^(טלפון|טלפון 1|טל['׳]? ?1|טל['׳]?|נייד|מספר|מספר טלפון|phone|phone ?1|mobile|tel)$/i,
  phone2: /^(טלפון 2|טל['׳]? ?2|נייד 2|טלפון נוסף|טלפון משרד|משרד|phone ?2|office)$/i,
  fax: /^(פקס|fax)$/i,
  email: /^(מייל|אימייל|דוא["״]?ל|דואר אלקטרוני|e-?mail)$/i,
  note: /^(הערה|הערות|תפקיד|חברה|פרויקט|note|notes|comment)$/i
};

/**
 * ניתוח טבלה שהועלתה. השורה הראשונה היא כותרות אם אחת מהן מזוהה; אחרת
 * הסדר הוא שם · טל' 1 · טל' 2 · פקס · מייל · הערות. לכל שורה: הערכים, שגיאה
 * אם יש, ואם היא כפולה — מול האלפון הקיים או מול שורה קודמת בקובץ.
 */
function analyseImport(matrix) {
  const rows = (matrix ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!rows.length) return { rows: [], header: false };
  const head = rows[0].map((c) => String(c ?? '').trim());
  const map = {};
  head.forEach((h, i) => {
    for (const [key, re] of Object.entries(HEADERS)) if (map[key] === undefined && re.test(h)) { map[key] = i; break; }
  });
  const header = Object.keys(map).length > 0;
  const col = header ? map : Object.fromEntries(FIELDS.map((k, i) => [k, i]));
  const body = header ? rows.slice(1) : rows;

  const seen = new Set();
  return {
    header,
    rows: body.map((r, i) => {
      const raw = Object.fromEntries(FIELDS.map((k) => [k, col[k] === undefined ? '' : String(r[col[k]] ?? '').trim()]));
      let value = null;
      let error = '';
      try { value = clean(raw); } catch (err) { error = err.message; }
      const keys = value ? [...NUMBERS.map((k) => phoneDigits(value[k])).filter((d) => d.length >= 7), value.email].filter(Boolean) : [];
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
  search, all, count, byId, create, update, remove, duplicatesOf, phoneDigits, isMobile, mobileOf, cardText, tagOf,
  localPhone, analyseImport, commitImport
};
