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

module.exports = { of, lastCompany, remember, warehouseFor, set };
