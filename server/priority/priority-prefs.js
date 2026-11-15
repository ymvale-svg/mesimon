'use strict';
/**
 * ברירות מחדל לפי משתמש משימון, לכל הזרימות של פריוריטי (קבלת סחורה, דרישת רכש):
 * הסביבה (החברה) האחרונה, ולכל חברה — הפרויקט והמחסן האחרונים. הבחירה האחרונה היא ברירת המחדל
 * בפעם הבאה; מציגים אותה ("הבחירה האחרונה שלך") וממשיכים בלי לעצור.
 *
 * נשמר בהגדרה ‎goods_receipt_prefs:<userId>‎ (השם ההיסטורי — כך נשמרות גם ההעדפות שכבר נאספו בקבלת הסחורה):
 * ‎{ _company, [company]: { project: {code, des}, warehouse, byProject: {[code]: warehouse}, at } }‎
 */
const D = require('../core').Db;

const key = (userId) => `goods_receipt_prefs:${userId}`;

function all(userId) {
  try {
    const row = D.get('SELECT value FROM settings WHERE key = ?', key(userId));
    return row ? JSON.parse(row.value) ?? {} : {};
  } catch { return {}; }
}

/** הפרויקט והמחסן האחרונים של המשתמש בחברה (‎null‎ — אין) */
function of(userId, company) {
  if (!userId || !company) return null;
  return all(userId)[company] ?? null;
}

/** הסביבה (קוד החברה) האחרונה שהמשתמש עבד בה */
function lastCompany(userId) {
  return userId ? all(userId)._company ?? null : null;
}

/** שומר את הבחירה: חברה, ואם יש — פרויקט ומחסן */
function remember(userId, { company, project = null, warehouse = null }) {
  if (!userId || !company) return;
  try {
    const a = all(userId);
    a._company = company;
    if (project?.code) {
      const c = a[company] ?? {};
      c.project = { code: project.code, des: project.des ?? '' };
      if (warehouse) { c.warehouse = warehouse; c.byProject = { ...(c.byProject ?? {}), [project.code]: warehouse }; }
      c.at = Date.now();
      a[company] = c;
    }
    D.setSetting(key(userId), a);
  } catch (err) {
    console.error('[משימון] העדפות פריוריטי:', err.message);
  }
}

/** המחסן האחרון של המשתמש לפרויקט (או בכלל, בחברה) */
function warehouseFor(userId, company, projectCode) {
  const p = of(userId, company);
  return p?.byProject?.[projectCode] ?? null;
}

/** ערך נוסף לחברה (למשל ‎demandCode‎ — רשימת המאשרים של דרישת הרכש) */
function set(userId, company, field, value) {
  if (!userId || !company) return;
  try {
    const a = all(userId);
    a[company] = { ...(a[company] ?? {}), [field]: value, at: Date.now() };
    D.setSetting(key(userId), a);
  } catch (err) {
    console.error('[משימון] העדפות פריוריטי:', err.message);
  }
}

/*
 * מי פתח דרישת רכש מהבוט — משתמש משימון, לפי חברה ומספר הדרישה (נרשם כשהדרישה נפתחת, ‎purchase-demand.js‎). כך פותח
 * הדרישה מקבל "הדרישה אושרה והועברה לספק" (‎po-notify.js‎) גם כשבפריוריטי היא רשומה על משתמש ה-API. נשמר לשנה.
 */
const OPENERS = 'pd_openers';
function rememberOpener(company, prdno, userId) {
  if (!company || !prdno || !userId) return;
  try {
    const m = D.getSetting(OPENERS, {}) ?? {};
    m[`${company}:${prdno}`] = { userId, at: Date.now() };
    for (const [k, v] of Object.entries(m)) if (Date.now() - (v?.at ?? 0) > 365 * 86400000) delete m[k];
    D.setSetting(OPENERS, m);
  } catch (err) {
    console.error('[משימון] פותח דרישת רכש:', err.message);
  }
}
const openerOf = (company, prdno) => (D.getSetting(OPENERS, {}) ?? {})[`${company}:${prdno}`]?.userId ?? null;

module.exports = { of, lastCompany, remember, warehouseFor, set, rememberOpener, openerOf };
