'use strict';
/**
 * 🔐 הרשאות משימון פריוריטי — מי מהמשתמשים במשימון יכול לעבוד על איזה מסמך, ובאילו חברות.
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md". הוחלט 11.11.26:
 *   • **בלי רמות.** לכל משתמש ולכל סוג מסמך — כן או לא. מי שמורשה למסמך מורשה לכל מה שבו: לראות, לקלוט,
 *     להפוך לסופי ולבטל (עם שאלת אישור), בבוט ובמסך.
 *   • **חברות לכל משתמש:** ‎null‎ = כל החברות (כולל חברה שתתווסף בעתיד), או רשימת קודים.
 *   • **מי מנהל:** מנהלי מערכת (‎superadmin‎, ‎admin‎) — וגם תמיד מורשים לכל דבר.
 *
 * נשמר בהגדרה ‎priority_access:<orgId>‎: ‎{ users: { [userId]: { docs: [...], companies: null | [...] } } }‎.
 * משתמש שאין לו שורה — מקבל את מה שהיה מותר לו עד היום בבוט (‎wa_actions‎: קבלת סחורה, דרישת רכש),
 * כך שהמעבר לא משנה דבר עד שמנהל משנה במסך.
 */
const D = require('../core').Db;

const DEFAULT_ORG = 1;
const ADMIN_ROLES = ['superadmin', 'admin'];

/** סוגי המסמכים — לפי סדר השרשרת. ‎ready‎ — עובד היום (בבוט, ובהמשך במסך) */
const DOCS = Object.freeze([
  { key: 'demand', label: 'דרישת רכש', ready: true, waAction: 'purchase_demand' },
  { key: 'order', label: 'הזמנת רכש', ready: false },
  { key: 'receipt', label: 'קבלת סחורה', ready: true, waAction: 'goods_receipt' },
  { key: 'partial', label: 'חשבון חלקי', ready: false },
  { key: 'invoice', label: 'חשבונית ספק', ready: false },
  { key: 'income', label: 'קבלה מהכנסות', ready: false }
]);
const DOC_KEYS = DOCS.map((d) => d.key);

const key = (org) => `priority_access:${org}`;
const isAdmin = (actor) => Boolean(actor && actor.type === 'user' && ADMIN_ROLES.includes(actor.role));
const stored = (org) => { const v = D.getSetting(key(org), null); return v && typeof v === 'object' ? v : { users: {} }; };

/** מה שהיה מותר עד היום בבוט — ‎wa_actions‎: קהל "כולם" או "מנהלים" (הדלקה וכיבוי — נשארים בבוט) */
function legacyDocs(user) {
  const wa = D.getSetting('wa_actions', {}) ?? {};
  const manager = user.role !== 'employee';
  return DOCS.filter((d) => d.waAction).filter((d) => {
    const audience = wa[d.waAction]?.audience ?? 'all';
    return audience === 'all' || manager;
  }).map((d) => d.key);
}

const userRow = (id) => D.get("SELECT id, full_name, email, role, status FROM users WHERE id = ?", id);

/** ההרשאות של משתמש: ‎{ docs: [...], companies: null | [...] }‎ */
function of(user, org = DEFAULT_ORG) {
  if (!user) return { docs: [], companies: [] };
  const u = typeof user === 'object' ? user : userRow(user);
  if (!u) return { docs: [], companies: [] };
  if (isAdmin({ type: 'user', role: u.role })) return { docs: [...DOC_KEYS], companies: null, admin: true };
  if (u.role === 'vendor') return { docs: [], companies: [] };
  const row = stored(org).users?.[u.id];
  if (!row) return { docs: legacyDocs(u), companies: null };
  return {
    docs: (Array.isArray(row.docs) ? row.docs : []).filter((d) => DOC_KEYS.includes(d)),
    companies: Array.isArray(row.companies) ? [...row.companies] : null
  };
}

/**
 * האם השחקן רשאי לעבוד על המסמך — ואם צוינה חברה, גם בה.
 * ‎actor‎ — שחקן מההתחברות (‎{type, id, role}‎).
 */
function can(actor, doc, company = null, org = DEFAULT_ORG) {
  if (!actor || actor.type !== 'user') return false;
  if (isAdmin(actor)) return true;
  const a = of({ id: actor.id, role: actor.role }, org);
  if (!a.docs.includes(doc)) return false;
  return !company || a.companies === null || a.companies.includes(company);
}

/** מסנן רשימת קודי חברות למה שהמשתמש רשאי בו */
function filterCompanies(actor, codes, org = DEFAULT_ORG) {
  if (!actor || actor.type !== 'user') return [];
  if (isAdmin(actor)) return [...codes];
  const a = of({ id: actor.id, role: actor.role }, org);
  return a.companies === null ? [...codes] : codes.filter((c) => a.companies.includes(c));
}

/** כמו ‎filterCompanies‎, לפי מזהה משתמש (בבוט, שבו יש רק ‎user.id‎). בלי משתמש — בלי סינון */
function filterForUser(userId, codes, org = DEFAULT_ORG) {
  if (!userId) return [...codes];
  const u = userRow(userId);
  if (!u) return [];
  return filterCompanies({ type: 'user', id: u.id, role: u.role }, codes, org);
}

/** המטריצה למסך: כל המשתמשים הפעילים (בלי ספקים) */
function matrix(org = DEFAULT_ORG) {
  const users = D.all("SELECT id, full_name, email, role, department FROM users WHERE status = 'active' AND role != 'vendor' ORDER BY full_name");
  return {
    docs: DOCS.map(({ key: k, label, ready }) => ({ key: k, label, ready })),
    users: users.map((u) => {
      const a = of(u, org);
      return { id: u.id, name: u.full_name, email: u.email, role: u.role, department: u.department ?? '', admin: isAdmin({ type: 'user', role: u.role }), docs: a.docs, companies: a.companies };
    })
  };
}

/**
 * שמירת שורה (או כמה) מהמסך. ‎rows‎ — ‎[{ id, docs, companies }]‎. מנהלי מערכת — תמיד הכל, לא נשמרים.
 * מחזיר רשימת שינויים קריאה (ליומן).
 */
function save(rows, { org = DEFAULT_ORG } = {}) {
  const s = stored(org);
  s.users = s.users ?? {};
  const changes = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = Number(r?.id);
    const u = Number.isInteger(id) ? userRow(id) : null;
    if (!u) throw new Error(`משתמש ${r?.id} לא נמצא`);
    if (u.role === 'vendor') throw new Error('ספק אינו יכול לקבל הרשאות פריוריטי');
    if (isAdmin({ type: 'user', role: u.role })) continue;
    const before = of(u, org);
    const docs = [...new Set((Array.isArray(r.docs) ? r.docs : []).filter((d) => DOC_KEYS.includes(d)))];
    const companies = r.companies === null || r.companies === undefined ? null
      : [...new Set((Array.isArray(r.companies) ? r.companies : []).map((c) => String(c).trim()).filter(Boolean))];
    s.users[id] = { docs, companies };
    const added = docs.filter((d) => !before.docs.includes(d));
    const removed = before.docs.filter((d) => !docs.includes(d));
    const label = (k) => DOCS.find((d) => d.key === k)?.label ?? k;
    if (added.length) changes.push(`${u.full_name}: נוסף ${added.map(label).join(', ')}`);
    if (removed.length) changes.push(`${u.full_name}: הוסר ${removed.map(label).join(', ')}`);
    if (JSON.stringify(before.companies) !== JSON.stringify(companies)) changes.push(`${u.full_name}: חברות — ${companies === null ? 'כל החברות' : companies.join(', ') || 'אף חברה'}`);
  }
  D.setSetting(key(org), s);
  return changes;
}

module.exports = { DEFAULT_ORG, DOCS, DOC_KEYS, isAdmin, of, can, filterCompanies, filterForUser, matrix, save, _key: key };
