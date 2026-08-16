'use strict';
/**
 * מטריצת ההרשאות — מקור האמת היחיד של המערכת.
 * השרת אוכף לפיה, והממשק מקבל ממנה את התצוגה. אין הרשאה שנקבעת בקוד הממשק.
 *
 * היררכיית התפקידים, מלמעלה למטה:
 *   אדמין על      — שליטה מלאה, ובעתיד יוכל להקים חברות נוספות
 *   מנהל מערכת    — ניהול המערכת ברמת הארגון: משתמשים, מחלקות, אוטומציות
 *   הנהלה         — ניהול עסקי: רואה ומנהל את כל הארגון
 *   מנהל מחלקה    — ניהול המחלקה שלו: משימות, עובדים וספקים של המחלקה
 *   עובד פנימי    — המשימות שהוא חלק מהן
 *   ספק חיצוני    — רק המשימות שהוקצו לו, בבורד הייעודי שלו
 *
 * ערכים אפשריים בכל תא:
 *   true         — מותר במלואו
 *   false        — אסור
 *   'department' — מוגבל למחלקה של המשתמש
 *   'own'        — מוגבל למשימות שהוא חלק מהן
 *   'assigned'   — רק משימות שהוקצו לו (ספק)
 *   'self_board' — רק בבורד הייעודי שלו (ספק)
 */

const ROLES = ['superadmin', 'admin', 'executive', 'manager', 'employee', 'vendor'];

const ROLE_LABELS = {
  superadmin: 'אדמין על',
  admin: 'מנהל מערכת',
  executive: 'הנהלה',
  manager: 'מנהל מחלקה',
  employee: 'עובד פנימי',
  vendor: 'ספק חיצוני'
};

/** דירוג לצורך "מי רשאי לנהל את מי" — אין הענקת רמה שווה או גבוהה משלך */
const ROLE_RANK = { superadmin: 5, admin: 4, executive: 3, manager: 2, employee: 1, vendor: 0 };

/** התפקידים שאינם ספק, לשימוש בטפסים */
const INTERNAL_ROLES = ROLES.filter((r) => r !== 'vendor');

const MATRIX = {
  view_internal_board:      { superadmin: true, admin: true,  executive: true,  manager: 'department', employee: 'own', vendor: false },
  view_vendor_boards:       { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: 'self_board' },
  create_project:           { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: false },
  create_task:              { superadmin: true, admin: true,  executive: true,  manager: true,        employee: true,  vendor: false },
  assign_department_task:   { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: false },
  edit_delete_task:         { superadmin: true, admin: true,  executive: true,  manager: 'department', employee: 'own', vendor: false },
  change_task_status:       { superadmin: true, admin: true,  executive: true,  manager: 'department', employee: 'own', vendor: 'assigned' },
  assign_task_to_vendor:    { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: false },
  approve_vendor_output:    { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: false },
  manage_users:             { superadmin: true, admin: true,  executive: true,  manager: 'department', employee: false, vendor: false },
  manage_departments:       { superadmin: true, admin: true,  executive: true,  manager: false,       employee: false, vendor: false },
  manage_organizations:     { superadmin: true, admin: false, executive: false, manager: false,       employee: false, vendor: false },
  manage_automations:       { superadmin: true, admin: true,  executive: false, manager: false,       employee: false, vendor: false },
  view_reports:             { superadmin: true, admin: true,  executive: true,  manager: 'department', employee: false, vendor: false },
  export_data:              { superadmin: true, admin: true,  executive: true,  manager: true,        employee: false, vendor: false },
  vendor_upload_deliverable:{ superadmin: false, admin: false, executive: false, manager: false,      employee: false, vendor: true },
  view_internal_comments:   { superadmin: true, admin: true,  executive: true,  manager: true,        employee: true,  vendor: false }
};

const MATRIX_LABELS = {
  view_internal_board:      'צפייה במשימות בבורד הפנימי',
  view_vendor_boards:       'צפייה בבורדי הספקים (תצוגת-על)',
  create_project:           'יצירת פרויקט',
  create_task:              'יצירת משימה',
  assign_department_task:   'הקצאת משימה לעובד אחר',
  edit_delete_task:         'עריכה / מחיקה של משימה',
  change_task_status:       'שינוי סטטוס משימה',
  assign_task_to_vendor:    'הקצאת משימה לספק',
  approve_vendor_output:    'אישור תוצרי ספק (סגירת משימה סופית)',
  manage_users:             'ניהול משתמשים והרשאות',
  manage_departments:       'ניהול מחלקות',
  manage_organizations:     'ניהול חברות בארגון',
  manage_automations:       'הגדרת אוטומציות וכללים',
  view_reports:             'צפייה בדוחות',
  export_data:              'ייצוא נתונים',
  vendor_upload_deliverable:'העלאת תוצרים / הערות (בפורטל הספק)',
  view_internal_comments:   'צפייה בהערות ובשדות פנימיים'
};

const MATRIX_NOTES = {
  'view_internal_board.manager': 'המחלקה שלו',
  'view_vendor_boards.vendor': 'רואה רק את הבורד שלו',
  'edit_delete_task.manager': 'משימות המחלקה שלו',
  'edit_delete_task.employee': 'רק משימות בבעלותו',
  'change_task_status.manager': 'משימות המחלקה שלו',
  'change_task_status.employee': 'למשימות שלו',
  'change_task_status.vendor': 'למשימות שהוקצו לו בלבד',
  'manage_users.manager': 'עובדים פנימיים במחלקה שלו',
  'assign_department_task.employee': 'רק אם הוענקה לו הרשאה אישית',
  'view_internal_board.employee': 'רק משימות שהוא חלק מהן, או כל המחלקה אם הוענקה לו הרשאה',
  'view_reports.manager': 'חתך המחלקה שלו',
  'manage_organizations.superadmin': 'הקמת חברות — יופעל בהמשך'
};

/**
 * הרשאות אישיות שמנהל מחלקה יכול להעניק לעובד פנימי, מעל התפקיד.
 * נועדו לתפקידי סיוע — מזכירה או רכזת — שצריכים ראייה או הקצאה בכל המחלקה
 * בלי לקבל את שאר סמכויות מנהל המחלקה.
 */
const GRANTS = {
  view_department_tasks: {
    label: 'צפייה בכל משימות המחלקה',
    hint: 'רואה את כל משימות המחלקה ולא רק את שלו — לצורך מעקב ובקרה'
  },
  assign_department_tasks: {
    label: 'הקצאת משימות לחברי המחלקה',
    hint: 'יכול ליצור משימה ולהקצות אותה לעובד אחר במחלקה'
  }
};

const GRANT_KEYS = Object.keys(GRANTS);

/** האם לשחקן הוענקה הרשאה אישית מסוימת */
const hasGrant = (actor, key) =>
  actor.type === 'user' && Array.isArray(actor.grants) && actor.grants.includes(key);

/** רמת ההרשאה הגולמית של השחקן לפעולה */
function level(actor, action) {
  const role = actor.type === 'vendor' ? 'vendor' : actor.role;
  const row = MATRIX[action];
  if (!row) return false;

  // הרשאה אישית מרחיבה עובד פנימי מ'own' ל'department' — בלי לשנות את התפקיד עצמו
  if (role === 'employee') {
    if (action === 'view_internal_board' && hasGrant(actor, 'view_department_tasks')) return 'department';
    if (action === 'assign_department_task' && hasGrant(actor, 'assign_department_tasks')) return 'department';
  }
  return row[role] ?? false;
}

const may = (actor, action) => level(actor, action) !== false;
const can = (actor, action) => level(actor, action) === true;

/**
 * מי רשאי לראות את רמות ההרשאה של אחרים. זהו מידע ניהולי שאין סיבה
 * שכל עובד יראה — מי מנהל את מי הוא עניין של הנהלת המערכת.
 */
const seesRoles = (actor) =>
  actor.type === 'user' && ['superadmin', 'admin'].includes(actor.role);

/** האם התפקיד רואה את כל הארגון ולא רק מחלקה אחת */
const isOrgWide = (actor) =>
  actor.type === 'user' && ['superadmin', 'admin', 'executive'].includes(actor.role);

/** האם השחקן משויך למשימה (אחראי / יוצר / מנהל הפרויקט) */
function isTaskParticipant(actor, task, project) {
  if (actor.type === 'vendor') {
    return task.assignee_type === 'vendor' && task.assignee_id === actor.id;
  }
  if (task.assignee_type === 'user' && task.assignee_id === actor.id) return true;
  if (task.created_by === actor.id) return true;
  if (project && project.manager_id === actor.id) return true;
  return false;
}

/** האם המשימה בתחום המחלקה של השחקן */
function isInActorDepartment(actor, task, assigneeDepartmentId = undefined) {
  if (!actor.departmentId) return false;
  if (task.department_id && task.department_id === actor.departmentId) return true;
  // משימה ללא שיוך מחלקתי — נקבעת לפי המחלקה של האחראי עליה
  if (!task.department_id && assigneeDepartmentId === actor.departmentId) return true;
  return false;
}

/**
 * בדיקת הרשאה על משימה ספציפית, לאחר יישום הסייגים.
 * assigneeDepartmentId נדרש כדי להכריע על משימות ארגוניות.
 */
function canOnTask(actor, action, task, project = null, assigneeDepartmentId = undefined) {
  const lvl = level(actor, action);
  if (lvl === true) return true;
  if (lvl === false) return false;
  if (lvl === 'department') {
    return isInActorDepartment(actor, task, assigneeDepartmentId) || isTaskParticipant(actor, task, project);
  }
  if (lvl === 'own' || lvl === 'assigned' || lvl === 'self_board') {
    return isTaskParticipant(actor, task, project);
  }
  return false;
}

/**
 * האם actor רשאי לנהל חשבון של תפקיד מסוים.
 * אין הענקה או עריכה של תפקיד בדירוג שווה או גבוה משל המנהל עצמו.
 */
function mayManageRole(actor, targetRole) {
  if (!may(actor, 'manage_users')) return false;
  if (actor.role === 'superadmin') return true;
  return (ROLE_RANK[targetRole] ?? 99) < ROLE_RANK[actor.role];
}

/** התפקידים שהשחקן רשאי להעניק בטופס משתמש */
const assignableRoles = (actor) => INTERNAL_ROLES.filter((role) => mayManageRole(actor, role));

function permissionsFor(actor) {
  const out = {};
  for (const action of Object.keys(MATRIX)) out[action] = level(actor, action);
  return out;
}

function matrixForDisplay() {
  return Object.keys(MATRIX).map((action) => ({
    action,
    label: MATRIX_LABELS[action],
    values: ROLES.map((role) => ({
      role,
      value: MATRIX[action][role],
      note: MATRIX_NOTES[`${action}.${role}`] ?? null
    }))
  }));
}

module.exports = {
  ROLES, INTERNAL_ROLES, ROLE_LABELS, ROLE_RANK, MATRIX, MATRIX_LABELS, MATRIX_NOTES,
  GRANTS, GRANT_KEYS, hasGrant,
  level, may, can, canOnTask, isTaskParticipant, isInActorDepartment, isOrgWide, seesRoles,
  mayManageRole, assignableRoles, permissionsFor, matrixForDisplay
};
