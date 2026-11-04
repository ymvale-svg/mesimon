'use strict';
/**
 * מזכירות — מי משרת/ת את מי.
 *
 * שני סוגים:
 *   • מזכירות כלליות — הסימון "📅 מזכירות" בכרטיס העובד (‎users.is_secretary‎).
 *     משרתות את כל המחלקות.
 *   • מזכירות של מחלקה — נבחרות בעריכת המחלקה (‎department_secretaries‎). למשל
 *     שושנה, שעובדת עם מחלקת התכנון. משרתות את המחלקה ואת תתי-המחלקות שלה.
 *
 * מה זה נותן:
 *   • מנהלי מחלקות (ומעלה) פותחים משימות למזכירות שמשרתות את המחלקה שלהם — גם
 *     כשהמזכירה יושבת במחלקה אחרת (‎assertMayAssignTo‎ ב-api.js).
 *   • המזכירה קובעת פגישות ביומנים של העובדים שהיא משרתת — לפי מה שכל עובד
 *     שיתף איתה ב-Google (‎meetings.js‎).
 *   • משימה כזו מסומנת ‎secretary_request‎, וכשנקבעה מתוכה פגישה ביומן — היא
 *     נסגרת לבד.
 */
const D = require('./db');
const P = require('./permissions');

/** מזכירה כללית — הסימון בכרטיס העובד */
const isGeneral = (userId) => Boolean(D.get("SELECT is_secretary FROM users WHERE id = ? AND status = 'active'", userId)?.is_secretary);

/** המחלקות שנבחרה להן במפורש (בלי תתי-המחלקות) */
const directDepartments = (userId) =>
  D.all(`SELECT ds.department_id AS id FROM department_secretaries ds
           JOIN departments d ON d.id = ds.department_id AND d.status = 'active'
          WHERE ds.user_id = ?`, userId).map((r) => r.id);

/**
 * המחלקות שהמזכירה משרתת: ‎null‎ — כולן (מזכירה כללית); מערך — המחלקות
 * שנבחרה להן ותתי-המחלקות שלהן; מערך ריק — אינה מזכירה.
 */
function servedDepartments(userId) {
  if (!userId) return [];
  if (isGeneral(userId)) return null;
  const out = new Set();
  for (const id of directDepartments(userId)) for (const sub of D.departmentSubtree(id)) out.add(sub);
  return [...out];
}

/** האם המשתמש מזכירה — כללית או של מחלקה כלשהי */
function isSecretary(userId) {
  const served = servedDepartments(userId);
  return served === null || served.length > 0;
}

/**
 * העובדים שהמזכירה מנהלת את היומנים שלהם: ‎null‎ — כולם; ‎Set‎ — עובדי
 * המחלקות שהיא משרתת (וגם היא עצמה).
 */
function calendarScope(userId) {
  const served = servedDepartments(userId);
  if (served === null) return null;
  const ids = new Set([userId]);
  if (served.length) {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND department_id IN (SELECT value FROM json_each(?))", JSON.stringify(served))) {
      ids.add(u.id);
    }
  }
  return ids;
}

/** האם המזכירה רשאית לפעול ביומן של העובד (לפני מה שהעובד שיתף ב-Google) */
function coversUser(secretaryId, userId) {
  const scope = calendarScope(secretaryId);
  return scope === null || scope.has(userId);
}

/** מנהל מחלקה ומעלה — מי שפותח משימות למזכירות */
const REQUESTER_RANK = P.ROLE_RANK.manager;
const isRequester = (actor) => actor?.type === 'user'
  && ((P.ROLE_RANK[actor.role] ?? 0) >= REQUESTER_RANK
    || Boolean(D.get('SELECT 1 FROM departments WHERE manager_user_id = ?', actor.id)));

/**
 * האם ‎actor‎ רשאי לפתוח משימה למזכירה ‎targetId‎ דרך המזכירות: הוא מנהל
 * מחלקה (ומעלה), והיא משרתת את המחלקה שלו. מזכירה כללית — לכל מנהל.
 */
function mayRequest(actor, targetId) {
  if (!isRequester(actor) || !targetId || targetId === actor.id) return false;
  const served = servedDepartments(targetId);
  if (served === null) return true;
  if (!served.length) return false;
  // מנהל בלי מחלקה (הנהלה, מנהל מערכת) — רואה את כל הארגון, ולכן כל מזכירה
  const mine = P.actorDepartmentIds(actor);
  if (!mine.length) return P.isOrgWide(actor);
  return mine.some((id) => served.includes(id));
}

/** המזכירות שהמשתמש רשאי לפתוח להן משימות — לסימון בבוררים */
function secretariesFor(actor) {
  if (!isRequester(actor)) return new Set();
  const ids = new Set(D.all("SELECT id FROM users WHERE status = 'active' AND is_secretary = 1").map((u) => u.id));
  for (const r of D.all("SELECT DISTINCT ds.user_id AS id FROM department_secretaries ds JOIN users u ON u.id = ds.user_id AND u.status = 'active'")) ids.add(r.id);
  ids.delete(actor.id);
  return new Set([...ids].filter((id) => mayRequest(actor, id)));
}

/** מזכירות המחלקה — לעריכת המחלקה ולתצוגה */
const ofDepartment = (departmentId) =>
  D.all(`SELECT u.id, u.full_name AS name FROM department_secretaries ds
           JOIN users u ON u.id = ds.user_id AND u.status = 'active'
          WHERE ds.department_id = ? ORDER BY u.full_name`, departmentId);

/** החלפה מלאה של מזכירות המחלקה */
function setForDepartment(departmentId, userIds) {
  const ids = [...new Set((userIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of ids) {
    if (!D.get("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role <> 'vendor'", id)) {
      const err = new Error('אחת המזכירות שנבחרו אינה עובדת פעילה');
      err.status = 400;
      throw err;
    }
  }
  D.run('DELETE FROM department_secretaries WHERE department_id = ?', departmentId);
  for (const id of ids) {
    D.run('INSERT INTO department_secretaries (department_id, user_id, created_at) VALUES (?,?,?)', departmentId, id, D.nowIso());
  }
}

module.exports = {
  isGeneral, servedDepartments, isSecretary, calendarScope, coversUser,
  isRequester, mayRequest, secretariesFor, ofDepartment, setForDepartment
};
