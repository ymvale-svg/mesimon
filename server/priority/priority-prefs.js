'use strict';
/**
 * ברירות מחדל לפי משתמש משימון, לכל הזרימות של פריוריטי (קבלת סחורה, דרישת רכש):
 * הסביבה (החברה) האחרונה, ולכל חברה — הפרויקט והמחסן האחרונים. הבחירה האחרונה היא ברירת המחדל
 * בפעם הבאה; מציגים אותה ("הבחירה האחרונה שלך") וממשיכים בלי לעצור.
 *
 * הגדרה אישית — נשמרת בהעדפות של העובד (‎user_prefs.priorityPrefs‎, 15.11.26; קטלוג ההגדרות: ‎PERSONAL‎):
 * ‎{ _company, [company]: { project: {code, des}, warehouse, byProject: {[code]: warehouse}, at } }‎
 * עד 15.11.26 נשמרה בטבלת ההגדרות של המערכת (‎goods_receipt_prefs:<userId>‎) — בקריאה הראשונה עוברת, והשורה הישנה נמחקת.
 */
const D = require('../core').Db;

const PREF = 'priorityPrefs';
const OLD_PREFIX = 'goods_receipt_prefs:';

function all(userId) {
  try {
    const cur = D.userPrefs(userId)?.[PREF];
    if (cur && typeof cur === 'object') return cur;
    const row = D.get('SELECT value FROM settings WHERE key = ?', OLD_PREFIX + userId);
    if (!row) return {};
    const moved = JSON.parse(row.value) ?? {};
    D.setUserPref(userId, PREF, moved);
    D.run('DELETE FROM settings WHERE key = ?', OLD_PREFIX + userId);
    return moved;
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
    D.setUserPref(userId, PREF, a);
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
    D.setUserPref(userId, PREF, a);
  } catch (err) {
    console.error('[משימון] העדפות פריוריטי:', err.message);
  }
}

module.exports = { of, lastCompany, remember, warehouseFor, set };
