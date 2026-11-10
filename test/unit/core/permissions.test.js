'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../../server/permissions');

const u = (role, extra = {}) => ({ type: 'user', id: 10, role, departmentId: 1, ...extra });
const vendor = (extra = {}) => ({ type: 'vendor', id: 50, role: 'vendor', ...extra });
const task = (extra = {}) => ({ id: 1, assignee_type: 'user', assignee_id: 99, created_by: 98, department_id: null, ...extra });

test('ROLES ודירוג — סדר יורד', () => {
  assert.deepEqual(P.ROLES, ['superadmin', 'admin', 'executive', 'manager', 'employee', 'vendor']);
  for (let i = 1; i < P.ROLES.length; i++) assert.ok(P.ROLE_RANK[P.ROLES[i - 1]] > P.ROLE_RANK[P.ROLES[i]]);
  assert.ok(!P.INTERNAL_ROLES.includes('vendor'));
  assert.equal(P.INTERNAL_ROLES.length, 5);
});

test('המטריצה — כל פעולה מגדירה ערך לכל תפקיד ותווית', () => {
  const allowed = new Set([true, false, 'department', 'own', 'assigned', 'self_board']);
  for (const [action, row] of Object.entries(P.MATRIX)) {
    assert.ok(P.MATRIX_LABELS[action], action);
    for (const role of P.ROLES) assert.ok(allowed.has(row[role]), `${action}.${role}`);
  }
});

test('הערות המטריצה מתייחסות לפעולות ולתפקידים קיימים', () => {
  for (const key of Object.keys(P.MATRIX_NOTES)) {
    const [action, role] = key.split('.');
    assert.ok(P.MATRIX[action], key);
    assert.ok(P.ROLES.includes(role), key);
  }
});

test('level — ערכים מהמטריצה', () => {
  assert.equal(P.level(u('superadmin'), 'manage_organizations'), true);
  assert.equal(P.level(u('admin'), 'manage_organizations'), false);
  assert.equal(P.level(u('manager'), 'view_internal_board'), 'department');
  assert.equal(P.level(u('employee'), 'edit_delete_task'), 'own');
  assert.equal(P.level(vendor(), 'change_task_status'), 'assigned');
  assert.equal(P.level(vendor(), 'view_vendor_boards'), 'self_board');
});

test('level — פעולה או תפקיד לא מוכרים: false', () => {
  assert.equal(P.level(u('admin'), 'fly_to_moon'), false);
  assert.equal(P.level(u('intern'), 'create_task'), false);
});

test('level — ספק לפי type גם אם role אחר', () => {
  assert.equal(P.level({ type: 'vendor', id: 1, role: 'superadmin' }, 'manage_users'), false);
  assert.equal(P.level({ type: 'vendor', id: 1 }, 'vendor_upload_deliverable'), true);
});

test('level — הרשאה אישית מרחיבה עובד למחלקה', () => {
  const plain = u('employee');
  const granted = u('employee', { grants: ['view_department_tasks', 'assign_department_tasks'] });
  assert.equal(P.level(plain, 'view_internal_board'), 'own');
  assert.equal(P.level(granted, 'view_internal_board'), 'department');
  assert.equal(P.level(plain, 'assign_department_task'), false);
  assert.equal(P.level(granted, 'assign_department_task'), 'department');
  // ההרשאה לא נוגעת לפעולות אחרות
  assert.equal(P.level(granted, 'edit_delete_task'), 'own');
});

test('level — הרשאה אישית לא משנה למנהל או לספק', () => {
  assert.equal(P.level(u('manager', { grants: ['view_department_tasks'] }), 'view_internal_board'), 'department');
  assert.equal(P.level(vendor({ grants: ['view_department_tasks'] }), 'view_internal_board'), false);
});

test('hasGrant — רק למשתמש עם מערך', () => {
  assert.ok(P.hasGrant(u('employee', { grants: ['x'] }), 'x'));
  assert.ok(!P.hasGrant(u('employee'), 'x'));
  assert.ok(!P.hasGrant(vendor({ grants: ['x'] }), 'x'));
  assert.ok(!P.hasGrant(u('employee', { grants: 'x' }), 'x'));
  assert.deepEqual(P.GRANT_KEYS, ['view_department_tasks', 'assign_department_tasks']);
});

test('may ו-can — הבדל בין מוגבל למלא', () => {
  const m = u('manager');
  assert.equal(P.may(m, 'manage_users'), true);
  assert.equal(P.can(m, 'manage_users'), false);
  assert.equal(P.can(u('admin'), 'manage_users'), true);
  assert.equal(P.may(u('employee'), 'manage_users'), false);
});

test('seesRoles ו-isOrgWide', () => {
  assert.ok(P.seesRoles(u('superadmin')));
  assert.ok(P.seesRoles(u('admin')));
  assert.ok(!P.seesRoles(u('executive')));
  assert.ok(P.isOrgWide(u('executive')));
  assert.ok(!P.isOrgWide(u('manager')));
  assert.ok(!P.isOrgWide({ type: 'vendor', role: 'admin' }));
  assert.ok(!P.seesRoles({ type: 'vendor', role: 'admin' }));
});

test('isTaskParticipant — אחראי, יוצר, מנהל פרויקט', () => {
  const me = u('employee');
  assert.ok(P.isTaskParticipant(me, task({ assignee_id: 10 })));
  assert.ok(P.isTaskParticipant(me, task({ created_by: 10 })));
  assert.ok(P.isTaskParticipant(me, task(), { manager_id: 10 }));
  assert.ok(!P.isTaskParticipant(me, task(), { manager_id: 11 }));
  assert.ok(!P.isTaskParticipant(me, task(), null));
});

test('isTaskParticipant — ספק עם אותו מזהה אינו משתמש', () => {
  const me = u('employee', { id: 50 });
  assert.ok(!P.isTaskParticipant(me, task({ assignee_type: 'vendor', assignee_id: 50 })));
  assert.ok(P.isTaskParticipant(vendor(), task({ assignee_type: 'vendor', assignee_id: 50 })));
  assert.ok(!P.isTaskParticipant(vendor(), task({ assignee_type: 'user', assignee_id: 50 })));
});

test('isTaskParticipant — ספק לא נחשב יוצר או מנהל פרויקט', () => {
  const v = vendor();
  assert.ok(!P.isTaskParticipant(v, task({ created_by: 50 }), { manager_id: 50 }));
});

test('isTaskParticipant — אחראים נוספים לפי סוג', () => {
  const extras = [{ assignee_type: 'user', assignee_id: 10 }, { assignee_type: 'vendor', assignee_id: 50 }];
  assert.ok(P.isTaskParticipant(u('employee'), task(), null, extras));
  assert.ok(P.isTaskParticipant(vendor(), task(), null, extras));
  assert.ok(!P.isTaskParticipant(u('employee', { id: 50 }), task(), null, [{ assignee_type: 'vendor', assignee_id: 50 }]));
});

test('actorDepartmentIds ו-inActorDepartments', () => {
  assert.deepEqual(P.actorDepartmentIds({ departmentIds: [1, 2] }), [1, 2]);
  assert.deepEqual(P.actorDepartmentIds({ departmentId: 3 }), [3]);
  assert.deepEqual(P.actorDepartmentIds({}), []);
  assert.ok(P.inActorDepartments({ departmentIds: [1, 2] }, 2));
  assert.ok(!P.inActorDepartments({ departmentIds: [1, 2] }, 3));
  assert.ok(!P.inActorDepartments({ departmentIds: [1] }, null));
});

test('isInActorDepartment — מחלקת המשימה, תת-מחלקה, מחלקת האחראי', () => {
  const m = u('manager', { departmentId: 1, departmentIds: [1, 4] });
  assert.ok(P.isInActorDepartment(m, task({ department_id: 1 })));
  assert.ok(P.isInActorDepartment(m, task({ department_id: 4 })));
  assert.ok(!P.isInActorDepartment(m, task({ department_id: 2 })));
  assert.ok(P.isInActorDepartment(m, task(), 4));
  assert.ok(!P.isInActorDepartment(m, task(), 2));
  assert.ok(!P.isInActorDepartment(m, task()));
  // מחלקת המשימה גוברת על מחלקת האחראי
  assert.ok(!P.isInActorDepartment(m, task({ department_id: 2 }), 1));
});

test('isInActorDepartment — שחקן בלי מחלקה: false', () => {
  assert.ok(!P.isInActorDepartment(u('manager', { departmentId: null, departmentIds: [1] }), task({ department_id: 1 })));
});

test('canOnTask — הרשאה מלאה וחסומה', () => {
  assert.ok(P.canOnTask(u('admin'), 'edit_delete_task', task({ department_id: 77 })));
  assert.ok(!P.canOnTask(vendor(), 'edit_delete_task', task({ assignee_type: 'vendor', assignee_id: 50 })));
});

test('canOnTask — מנהל מחלקה: מחלקה או השתתפות', () => {
  const m = u('manager', { departmentIds: [1] });
  assert.ok(P.canOnTask(m, 'edit_delete_task', task({ department_id: 1 })));
  assert.ok(!P.canOnTask(m, 'edit_delete_task', task({ department_id: 2 })));
  assert.ok(P.canOnTask(m, 'edit_delete_task', task({ department_id: 2, created_by: 10 })));
  assert.ok(P.canOnTask(m, 'edit_delete_task', task(), null, 1));
});

test('canOnTask — עובד: רק משימות שלו', () => {
  const e = u('employee');
  assert.ok(!P.canOnTask(e, 'change_task_status', task({ department_id: 1 })));
  assert.ok(P.canOnTask(e, 'change_task_status', task({ assignee_id: 10 })));
  assert.ok(P.canOnTask(e, 'change_task_status', task(), null, undefined, [{ assignee_type: 'user', assignee_id: 10 }]));
});

test('canOnTask — עובד עם הרשאת צפייה רואה את המחלקה', () => {
  const e = u('employee', { departmentIds: [1], grants: ['view_department_tasks'] });
  assert.ok(P.canOnTask(e, 'view_internal_board', task({ department_id: 1 })));
  assert.ok(!P.canOnTask(e, 'edit_delete_task', task({ department_id: 1 })));
});

test('canOnTask — ספק: רק מה שהוקצה לו', () => {
  const v = vendor();
  assert.ok(P.canOnTask(v, 'change_task_status', task({ assignee_type: 'vendor', assignee_id: 50 })));
  assert.ok(!P.canOnTask(v, 'change_task_status', task({ assignee_type: 'vendor', assignee_id: 51 })));
  assert.ok(P.canOnTask(v, 'view_vendor_boards', task({ assignee_type: 'vendor', assignee_id: 50 })));
});

test('mayManageRole — רק תפקיד נמוך משלך', () => {
  const admin = u('admin');
  assert.ok(P.mayManageRole(admin, 'executive'));
  assert.ok(P.mayManageRole(admin, 'vendor'));
  assert.ok(!P.mayManageRole(admin, 'admin'));
  assert.ok(!P.mayManageRole(admin, 'superadmin'));
  const m = u('manager');
  assert.ok(P.mayManageRole(m, 'employee'));
  assert.ok(!P.mayManageRole(m, 'manager'));
});

test('mayManageRole — אדמין על מנהל הכל, עובד אף אחד', () => {
  assert.ok(P.mayManageRole(u('superadmin'), 'superadmin'));
  assert.ok(!P.mayManageRole(u('employee'), 'vendor'));
  assert.ok(!P.mayManageRole(vendor(), 'vendor'));
});

test('mayManageRole — תפקיד לא מוכר אסור', () => {
  assert.ok(!P.mayManageRole(u('admin'), 'intern'));
  assert.ok(P.mayManageRole(u('superadmin'), 'intern'));
});

test('assignableRoles — לפי התפקיד, בלי ספק', () => {
  assert.deepEqual(P.assignableRoles(u('superadmin')), P.INTERNAL_ROLES);
  assert.deepEqual(P.assignableRoles(u('admin')), ['executive', 'manager', 'employee']);
  assert.deepEqual(P.assignableRoles(u('executive')), ['manager', 'employee']);
  assert.deepEqual(P.assignableRoles(u('manager')), ['employee']);
  assert.deepEqual(P.assignableRoles(u('employee')), []);
});

test('permissionsFor — מפה מלאה לכל פעולה', () => {
  const perms = P.permissionsFor(u('manager'));
  assert.deepEqual(Object.keys(perms), Object.keys(P.MATRIX));
  assert.equal(perms.view_internal_board, 'department');
  assert.equal(perms.manage_automations, false);
  assert.equal(perms.export_data, true);
});

test('permissionsFor — ספק', () => {
  const perms = P.permissionsFor(vendor());
  assert.equal(perms.vendor_upload_deliverable, true);
  assert.equal(perms.create_task, false);
  const truthy = Object.entries(perms).filter(([, v]) => v !== false).map(([k]) => k).sort();
  assert.deepEqual(truthy, ['change_task_status', 'vendor_upload_deliverable', 'view_vendor_boards']);
});

test('permissionsFor — רק אדמין על מפרסם הודעות ומנהל חברות', () => {
  for (const role of P.INTERNAL_ROLES) {
    const perms = P.permissionsFor(u(role));
    assert.equal(perms.manage_release_notes, role === 'superadmin', role);
    assert.equal(perms.manage_organizations, role === 'superadmin', role);
  }
});

test('matrixForDisplay — שורה לכל פעולה עם הערות', () => {
  const rows = P.matrixForDisplay();
  assert.equal(rows.length, Object.keys(P.MATRIX).length);
  const row = rows.find((r) => r.action === 'view_internal_board');
  assert.equal(row.label, P.MATRIX_LABELS.view_internal_board);
  assert.deepEqual(row.values.map((v) => v.role), P.ROLES);
  assert.equal(row.values.find((v) => v.role === 'manager').note, 'המחלקה שלו');
  assert.equal(row.values.find((v) => v.role === 'admin').note, null);
});
