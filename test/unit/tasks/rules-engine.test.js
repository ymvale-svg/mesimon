'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D, mkUser, mkDept, mkProject, mkVendor, mkTask, HOUR, DAY, ago, ahead } = require('./fixtures');
const R = require('../../../server/rules-engine');

boot();
const internal = D.internalBoard();

const notes = (taskId, kind) => D.all('SELECT * FROM notifications WHERE task_id = ? AND kind = ?', taskId, kind);
const taskRow = (id) => D.get('SELECT * FROM tasks WHERE id = ?', id);
const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// קטלוג ועזרים
// ---------------------------------------------------------------------------

test('catalog — כל הטריגרים והפעולות עם תווית', () => {
  const c = R.catalog();
  assert.deepEqual(c.triggers.map((t) => t.key).sort(), Object.keys(R.TRIGGERS).sort());
  assert.deepEqual(c.actions.map((a) => a.key).sort(), Object.keys(R.ACTIONS).sort());
  for (const x of [...c.triggers, ...c.actions]) assert.ok(x.label, x.key);
  for (const t of c.triggers) assert.ok(Array.isArray(t.paramsSchema), t.key);
});

test('הכללים המובנים — נוצרו ומפנים לטריגר ולפעולה קיימים', () => {
  const rules = D.all('SELECT * FROM automation_rules WHERE built_in = 1');
  assert.equal(rules.length, 8);
  for (const r of rules) {
    assert.ok(R.TRIGGERS[r.trigger_key], r.trigger_key);
    assert.ok(R.ACTIONS[r.action_key], r.action_key);
    assert.equal(r.enabled, 1);
  }
});

test('firstColumnKey — העמודה הראשונה בבורד', () => {
  assert.equal(R.firstColumnKey(internal.id), 'new');
  const vb = D.createVendorBoard(mkVendor().id, 'ספק');
  assert.equal(R.firstColumnKey(vb), 'awaiting_upload');
  assert.equal(R.firstColumnKey(999999), 'new');
});

test('isFinalStatus — לפי is_final של העמודה', () => {
  assert.equal(R.isFinalStatus({ board_id: internal.id, status: 'done' }), true);
  assert.equal(R.isFinalStatus({ board_id: internal.id, status: 'in_progress' }), false);
  assert.equal(R.isFinalStatus({ board_id: internal.id, status: 'ghost' }), false);
});

test('statusLabel — התווית, ובלי עמודה המפתח עצמו', () => {
  assert.equal(R.statusLabel({ board_id: internal.id, status: 'in_progress' }), 'בטיפול');
  assert.equal(R.statusLabel({ board_id: internal.id, status: 'ghost' }), 'ghost');
});

test('formatDate — DD.MM.YYYY, וקו כשאין', () => {
  assert.equal(R.formatDate('2026-03-05T10:00:00Z'), '05.03.2026');
  assert.equal(R.formatDate(null), '—');
  assert.equal(R.formatDate(''), '—');
});

// ---------------------------------------------------------------------------
// alertTargets
// ---------------------------------------------------------------------------

test('alertTargets — אחראי, מנהל הפרויקט ומנהל המחלקה', () => {
  const head = mkUser({ role: 'manager' });
  const dept = mkDept({ manager_user_id: head.id });
  const worker = mkUser({ department_id: dept.id });
  const pm = mkUser();
  const project = mkProject({ manager_id: pm.id });
  const t = mkTask({ assignee_type: 'user', assignee_id: worker.id, project_id: project.id });
  assert.deepEqual(ids(R.alertTargets(t)), [head.id, worker.id, pm.id].sort((a, b) => a - b));
});

test('alertTargets — מנהל שמשויך למחלקה בלי להיות המנהל הרשמי', () => {
  const dept = mkDept();
  const mgr = mkUser({ role: 'manager', department_id: dept.id });
  const t = mkTask({ department_id: dept.id });
  assert.deepEqual(ids(R.alertTargets(t)), [mgr.id]);
});

test('alertTargets — אחראי נוסף, בלי כפילות', () => {
  const a = mkUser();
  const b = mkUser();
  const t = mkTask({ assignee_type: 'user', assignee_id: a.id });
  for (const u of [a, b]) {
    D.run("INSERT INTO task_assignees (task_id, assignee_type, assignee_id, added_at) VALUES (?, 'user', ?, ?)", t.id, u.id, D.nowIso());
  }
  assert.deepEqual(ids(R.alertTargets(t)), [a.id, b.id]);
});

test('alertTargets — משתמש לא פעיל לא מקבל', () => {
  const off = mkUser({ status: 'inactive' });
  const t = mkTask({ assignee_type: 'user', assignee_id: off.id });
  assert.deepEqual(R.alertTargets(t), []);
});

test('alertTargets — משימת ספק: הפותח מקבל, אבל לא מנהל מערכת', () => {
  const v = mkVendor();
  const opener = mkUser();
  const admin = mkUser({ role: 'admin' });
  const t1 = mkTask({ assignee_type: 'vendor', assignee_id: v.id, created_by: opener.id });
  const t2 = mkTask({ assignee_type: 'vendor', assignee_id: v.id, created_by: admin.id });
  assert.deepEqual(ids(R.alertTargets(t1)), [opener.id]);
  assert.deepEqual(R.alertTargets(t2), []);
});

test('alertTargets — משימה פנימית: הפותח לא מקבל', () => {
  const opener = mkUser();
  assert.deepEqual(R.alertTargets(mkTask({ created_by: opener.id })), []);
});

test('alertTargets — מחלקת האחראי כשלמשימה אין מחלקה', () => {
  const head = mkUser({ role: 'manager' });
  const dept = mkDept({ manager_user_id: head.id });
  const worker = mkUser({ department_id: dept.id });
  const t = mkTask({ assignee_type: 'user', assignee_id: worker.id });
  assert.ok(ids(R.alertTargets(t)).includes(head.id));
});

// ---------------------------------------------------------------------------
// runOnce מול הכללים המובנים
// ---------------------------------------------------------------------------

test('runOnce — סיכום לכל כלל פעיל', () => {
  const s = R.runOnce();
  assert.match(s.ranAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.rules.length, D.get('SELECT COUNT(*) c FROM automation_rules WHERE enabled = 1').c);
  for (const r of s.rules) assert.equal(r.error, undefined, r.rule);
  assert.ok(D.get('SELECT last_run_at FROM automation_rules WHERE built_in = 1 LIMIT 1').last_run_at);
});

test('חדש ← בטיפול — משימה מיום קודם עוברת, משימה מהיום נשארת', () => {
  const old = mkTask({ status: 'new', created_at: ago(3 * DAY), status_changed_at: ago(3 * DAY) });
  const fresh = mkTask({ status: 'new' });
  R.runOnce();
  assert.equal(taskRow(old.id).status, 'in_progress');
  // status_changed_at לא מתעדכן במכוון
  assert.equal(taskRow(old.id).status_changed_at, old.status_changed_at);
  assert.equal(taskRow(fresh.id).status, 'new');
  assert.ok(D.get("SELECT 1 FROM audit_log WHERE task_id = ? AND action = 'automation'", old.id));
});

test('חדש ← בטיפול — לא בבורד ספק', () => {
  const v = mkVendor();
  const vb = D.createVendorBoard(v.id, v.name);
  const t = mkTask({ board_id: vb, status: 'new', assignee_type: 'vendor', assignee_id: v.id, created_at: ago(3 * DAY) });
  R.runOnce();
  assert.equal(taskRow(t.id).status, 'new');
});

test('ארכיון — הושלמה לפני יותר מ-3 ימים', () => {
  const old = mkTask({ status: 'done', completed_at: ago(5 * DAY) });
  const recent = mkTask({ status: 'done', completed_at: ago(1 * DAY) });
  const notFinal = mkTask({ status: 'in_progress', completed_at: ago(9 * DAY) });
  R.runOnce();
  assert.equal(taskRow(old.id).archived, 1);
  assert.equal(taskRow(recent.id).archived, 0);
  assert.equal(taskRow(notFinal.id).archived, 0);
});

test('ארכיון — לפי ההגדרה archive_done_after_days', () => {
  D.setSetting('archive_done_after_days', 1);
  try {
    const t = mkTask({ status: 'done', completed_at: ago(2 * DAY) });
    R.runOnce();
    assert.equal(taskRow(t.id).archived, 1);
  } finally {
    D.setSetting('archive_done_after_days', 3);
  }
});

test('חריגה — התראת overdue לאחראי, ופעם אחת בלבד', () => {
  const u = mkUser();
  const t = mkTask({ status: 'in_progress', assignee_type: 'user', assignee_id: u.id, due_date: ago(DAY) });
  R.runOnce();
  R.runOnce();
  const n = notes(t.id, 'overdue');
  assert.equal(n.length, 1);
  assert.equal(n[0].target_id, u.id);
  assert.equal(n[0].title, 'חריגה מתאריך יעד');
  assert.match(n[0].body, /סטטוס: בטיפול/);
});

test('חריגה — משימה שהושלמה לא מתריעה', () => {
  const u = mkUser();
  const t = mkTask({ status: 'done', assignee_type: 'user', assignee_id: u.id, due_date: ago(DAY) });
  R.runOnce();
  assert.equal(notes(t.id, 'overdue').length, 0);
});

test('התראה מקדימה — יעד בעוד שעתיים', () => {
  const u = mkUser();
  const t = mkTask({ status: 'in_progress', assignee_type: 'user', assignee_id: u.id, due_date: ahead(2 * HOUR) });
  const far = mkTask({ status: 'in_progress', assignee_type: 'user', assignee_id: u.id, due_date: ahead(5 * DAY) });
  R.runOnce();
  assert.equal(notes(t.id, 'manager_alert').length, 1);
  assert.equal(notes(far.id, 'manager_alert').length, 0);
});

test('תזכורת לספק — יעד בעוד יומיים', () => {
  const v = mkVendor();
  const vb = D.createVendorBoard(v.id, v.name);
  const t = mkTask({ board_id: vb, status: 'awaiting_upload', assignee_type: 'vendor', assignee_id: v.id, due_date: ahead(2 * DAY) });
  const done = mkTask({ board_id: vb, status: 'approved', assignee_type: 'vendor', assignee_id: v.id, due_date: ahead(2 * DAY) });
  R.runOnce();
  const n = notes(t.id, 'vendor_reminder');
  assert.equal(n.length, 1);
  assert.equal(n[0].target_type, 'vendor');
  assert.equal(n[0].target_id, v.id);
  assert.equal(notes(done.id, 'vendor_reminder').length, 0);
});

test('הקפצה — דחופה שלא זזה 30 שעות', () => {
  const u = mkUser();
  const t = mkTask({ status: 'in_progress', priority: 'urgent', assignee_type: 'user', assignee_id: u.id, status_changed_at: ago(30 * HOUR) });
  const calm = mkTask({ status: 'in_progress', priority: 'normal', assignee_type: 'user', assignee_id: u.id, status_changed_at: ago(30 * HOUR) });
  const recent = mkTask({ status: 'in_progress', priority: 'urgent', assignee_type: 'user', assignee_id: u.id, status_changed_at: ago(HOUR) });
  R.runOnce();
  assert.equal(taskRow(t.id).escalated, 1);
  assert.equal(notes(t.id, 'escalation').length, 1);
  assert.equal(taskRow(calm.id).escalated, 0);
  assert.equal(taskRow(recent.id).escalated, 0);
});

test('הפעלה מתוזמנת — activate_at שעבר מתאפס, והאחראי מקבל הודעה', () => {
  const u = mkUser();
  const t = mkTask({ status: 'in_progress', assignee_type: 'user', assignee_id: u.id, activate_at: ago(HOUR) });
  const future = mkTask({ status: 'in_progress', activate_at: ahead(DAY) });
  R.runOnce();
  assert.equal(taskRow(t.id).activate_at, null);
  assert.equal(notes(t.id, 'assignment').length, 1);
  assert.equal(taskRow(future.id).activate_at, future.activate_at);
});

test('משימה חוזרת — המופע הקודם סגור: נוצר מופע חדש', () => {
  const u = mkUser();
  const parent = mkTask({
    status: 'done', is_recurring: 1, recurrence_freq: 'daily', assignee_type: 'user', assignee_id: u.id,
    due_date: ago(2 * DAY), priority: 'high'
  });
  R.runOnce();
  const child = D.get('SELECT * FROM tasks WHERE recurrence_parent = ?', parent.id);
  assert.ok(child);
  assert.equal(child.title, parent.title);
  assert.equal(child.status, 'new');
  assert.equal(child.priority, 'high');
  assert.equal(child.is_recurring, 0);
  assert.ok(taskRow(parent.id).last_spawned_at);
  assert.equal(notes(child.id, 'assignment').length, 1);
});

test('משימה חוזרת — המופע עדיין פתוח: נדחה בלי מופע חדש', () => {
  const parent = mkTask({ status: 'in_progress', is_recurring: 1, recurrence_freq: 'weekly', due_date: ago(8 * DAY) });
  R.runOnce();
  assert.equal(D.get('SELECT COUNT(*) c FROM tasks WHERE recurrence_parent = ?', parent.id).c, 0);
  assert.ok(taskRow(parent.id).last_spawned_at);
});

test('משימה חוזרת — מדיניות always יוצרת גם כשפתוח', () => {
  const parent = mkTask({ status: 'in_progress', is_recurring: 1, recurrence_freq: 'daily', recurrence_policy: 'always', due_date: ago(2 * DAY) });
  R.runOnce();
  assert.equal(D.get('SELECT COUNT(*) c FROM tasks WHERE recurrence_parent = ?', parent.id).c, 1);
});

test('כלל מושבת לא רץ', () => {
  D.run("UPDATE automation_rules SET enabled = 0 WHERE trigger_key = 'completed_stale'");
  try {
    const t = mkTask({ status: 'done', completed_at: ago(10 * DAY) });
    const s = R.runOnce();
    assert.equal(taskRow(t.id).archived, 0);
    assert.ok(!s.rules.some((r) => r.rule === 'העברה לארכיון של משימה שהושלמה'));
  } finally {
    D.run("UPDATE automation_rules SET enabled = 1 WHERE trigger_key = 'completed_stale'");
  }
});

test('כלל עם טריגר לא מוכר — שגיאה בסיכום, השאר ממשיכים', () => {
  const info = D.run(
    "INSERT INTO automation_rules (name, trigger_key, params, action_key, enabled, built_in, created_at) VALUES ('כלל שבור', 'nope', '{}', 'archive_task', 1, 0, ?)",
    D.nowIso()
  );
  try {
    const s = R.runOnce();
    assert.deepEqual(s.rules.find((r) => r.rule === 'כלל שבור'), { rule: 'כלל שבור', error: 'טריגר או פעולה לא מוכרים' });
    assert.ok(s.rules.some((r) => typeof r.fired === 'number'));
  } finally {
    D.run('DELETE FROM automation_rules WHERE id = ?', Number(info.lastInsertRowid));
  }
});

test('כלל מותאם — משימה בלי אחראי מוקפצת לפי פרמטר ישיר', () => {
  const info = D.run(
    "INSERT INTO automation_rules (name, trigger_key, params, action_key, enabled, built_in, created_at) VALUES ('בלי אחראי', 'unassigned_task', ?, 'escalate_to_managers', 1, 0, ?)",
    JSON.stringify({ hours: 2 }), D.nowIso()
  );
  try {
    const old = mkTask({ status: 'in_progress', created_at: ago(5 * HOUR) });
    const young = mkTask({ status: 'in_progress', created_at: ago(HOUR) });
    R.runOnce();
    assert.equal(taskRow(old.id).escalated, 1);
    assert.equal(taskRow(young.id).escalated, 0);
  } finally {
    D.run('DELETE FROM rule_fires WHERE rule_id = ?', Number(info.lastInsertRowid));
    D.run('DELETE FROM automation_rules WHERE id = ?', Number(info.lastInsertRowid));
  }
});

test('ACTIONS.notify_vendor — מסרב למשימה שאינה של ספק', () => {
  const t = mkTask();
  assert.equal(R.ACTIONS.notify_vendor.run({ name: 'x' }, { task: t, meta: { days: 3 } }), false);
});

test('ACTIONS.age_to_in_progress — בורד בלי עמודת בטיפול', () => {
  const v = mkVendor();
  const vb = D.createVendorBoard(v.id, v.name);
  const t = mkTask({ board_id: vb, status: 'new' });
  assert.equal(R.ACTIONS.age_to_in_progress.run({ name: 'x' }, { task: t }), false);
  assert.equal(taskRow(t.id).status, 'new');
});

test('TRIGGERS.recurring_due — מופע חודשי עוד לא הגיע', () => {
  mkTask({ status: 'in_progress', is_recurring: 1, recurrence_freq: 'monthly', due_date: ago(DAY), title: 'חודשית ייחודית' });
  const ev = R.TRIGGERS.recurring_due.evaluate({}, {}, Date.now());
  assert.ok(!ev.some((e) => e.task.title === 'חודשית ייחודית'));
});
