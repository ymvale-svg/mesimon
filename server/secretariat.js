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

module.exports = { isSecretary, isRequester, mayRequest, secretariesFor };
