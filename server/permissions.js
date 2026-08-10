'use strict';
/**
 * מטריצת ההרשאות המפורטת — פרק 6 באפיון.
 * זהו מקור האמת היחיד: גם השרת אוכף לפיה, וגם הממשק מקבל ממנה את התצוגה.
 *
 * ערכים אפשריים:
 *   true   — מותר במלואו
 *   false  — אסור
 *   'own'  — מותר חלקית, רק על משימות/פרויקטים שהמשתמש חלק מהם
 *   'assigned' — רק על משימות שהוקצו לו (ספק)
 *   'self_board' — רק בבורד הייעודי שלו (ספק)
 */

const ROLES = ['admin', 'manager', 'employee', 'vendor'];

const ROLE_LABELS = {
  admin: 'מנהל מערכת',
  manager: 'מנהל מחלקה',
  employee: 'עובד פנימי',
  vendor: 'ספק חיצוני'
};

const MATRIX = {
  view_internal_board:      { admin: true,  manager: true,  employee: 'own',      vendor: false },
  view_vendor_boards:       { admin: true,  manager: true,  employee: false,      vendor: 'self_board' },
  create_project:           { admin: true,  manager: true,  employee: false,      vendor: false },
  create_task:              { admin: true,  manager: true,  employee: true,       vendor: false },
  edit_delete_task:         { admin: true,  manager: true,  employee: 'own',      vendor: false },
  change_task_status:       { admin: true,  manager: true,  employee: 'own',      vendor: 'assigned' },
  assign_task_to_vendor:    { admin: true,  manager: true,  employee: false,      vendor: false },
  approve_vendor_output:    { admin: true,  manager: true,  employee: false,      vendor: false },
  // מנהל מחלקה רשאי לנהל עובדים פנימיים במחלקה שלו בלבד (הרחבה מעבר לאפיון המקורי)
  manage_users:             { admin: true,  manager: 'own', employee: false,      vendor: false },
  manage_automations:       { admin: true,  manager: false, employee: false,      vendor: false },
  view_reports:             { admin: true,  manager: true,  employee: false,      vendor: false },
  export_data:              { admin: true,  manager: true,  employee: false,      vendor: false },
  vendor_upload_deliverable:{ admin: false, manager: false, employee: false,      vendor: true },
  view_internal_comments:   { admin: true,  manager: true,  employee: true,       vendor: false }
};

// תיאורי השורות, לתצוגה במסך ההרשאות
const MATRIX_LABELS = {
  view_internal_board:      'צפייה בכל משימות המחלקה (בורד פנימי)',
  view_vendor_boards:       'צפייה בבורדי הספקים (תצוגת-על)',
  create_project:           'יצירת פרויקט',
  create_task:              'יצירת משימה',
  edit_delete_task:         'עריכה / מחיקה של משימה',
  change_task_status:       'שינוי סטטוס משימה',
  assign_task_to_vendor:    'הקצאת משימה לספק',
  approve_vendor_output:    'אישור תוצרי ספק (סגירת משימה סופית)',
  manage_users:             'ניהול משתמשים והרשאות',
  manage_automations:       'הגדרת אוטומציות וכללים',
  view_reports:             'צפייה בדוחות מחלקתיים',
  export_data:              'ייצוא נתונים',
  vendor_upload_deliverable:'העלאת תוצרים / הערות (בפורטל הספק)',
  view_internal_comments:   'צפייה בהערות ובשדות פנימיים'
};

const MATRIX_NOTES = {
  'manage_users.manager': 'רק עובדים פנימיים במחלקה שלו',
  'view_internal_board.employee': 'רק משימות שהוא חלק מהן',
  'view_vendor_boards.vendor': 'רואה רק את הבורד שלו',
  'change_task_status.employee': 'למשימות שלו',
  'change_task_status.vendor': 'למשימות שהוקצו לו בלבד',
  'edit_delete_task.employee': 'רק משימות בבעלותו'
};

/** רמת ההרשאה הגולמית של השחקן לפעולה */
function level(actor, action) {
  const role = actor.type === 'vendor' ? 'vendor' : actor.role;
  const row = MATRIX[action];
  if (!row) return false;
  return row[role] ?? false;
}

/** האם מותר בכלל (גם אם חלקית) */
function may(actor, action) {
  return level(actor, action) !== false;
}

/** האם מותר במלואו, ללא סייגים */
function can(actor, action) {
  return level(actor, action) === true;
}

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

/**
 * בדיקת הרשאה על משימה ספציפית.
 * מחזירה true/false לאחר יישום הסייגים ('own' / 'assigned').
 */
function canOnTask(actor, action, task, project = null) {
  const lvl = level(actor, action);
  if (lvl === true) return true;
  if (lvl === false) return false;
  if (lvl === 'own' || lvl === 'assigned' || lvl === 'self_board') {
    return isTaskParticipant(actor, task, project);
  }
  return false;
}

/** מבנה ההרשאות שנשלח לממשק */
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
  ROLES, ROLE_LABELS, MATRIX, MATRIX_LABELS, MATRIX_NOTES,
  level, may, can, canOnTask, isTaskParticipant, permissionsFor, matrixForDisplay
};
