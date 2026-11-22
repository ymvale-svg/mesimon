'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D, mkUser, mkDept, mkTask, mkVendor } = require('./fixtures');

boot();

// ---------------------------------------------------------------------------
// הגדרות
// ---------------------------------------------------------------------------

test('getSetting — ברירת המחדל כשאין', () => {
  assert.equal(D.getSetting('no_such_key'), null);
  assert.equal(D.getSetting('no_such_key', 7), 7);
});

test('setSetting/getSetting — הלוך ושוב ב-JSON', () => {
  for (const v of [5, 'טקסט', true, false, ['a', 'b'], { x: 1, y: [2] }, 0]) {
    D.setSetting('t_roundtrip', v);
    assert.deepEqual(D.getSetting('t_roundtrip'), v);
  }
});

test('setSetting — דריסה ולא שורה נוספת', () => {
  D.setSetting('t_over', 1);
  D.setSetting('t_over', 2);
  assert.equal(D.all("SELECT * FROM settings WHERE key = 't_over'").length, 1);
  assert.equal(D.getSetting('t_over'), 2);
});

test('getSetting — ערך שאינו JSON חוזר כמחרוזת', () => {
  D.run("INSERT INTO settings (key, value) VALUES ('t_raw', 'not json')");
  assert.equal(D.getSetting('t_raw'), 'not json');
  assert.equal(D.allSettings().t_raw, 'not json');
});

test('bootstrap — כל הגדרות ברירת המחדל קיימות', () => {
  const all = D.allSettings();
  for (const [k, v] of Object.entries(D.DEFAULT_SETTINGS)) assert.deepEqual(all[k], v, k);
});

test('bootstrap — לא דורס הגדרה שנשמרה, ומונה עליות', () => {
  D.setSetting('archive_done_after_days', 9);
  const before = D.getSetting('boot_count');
  D.bootstrap();
  assert.equal(D.getSetting('archive_done_after_days'), 9);
  assert.equal(D.getSetting('boot_count'), before + 1);
  assert.equal(D.all('SELECT * FROM automation_rules WHERE built_in = 1').length, 8);
  D.setSetting('archive_done_after_days', 3);
});

test('bootstrap — נוצר מנהל מערכת ראשון אחד', () => {
  const admins = D.all("SELECT * FROM users WHERE role = 'superadmin'");
  assert.equal(admins.length, 1);
  assert.equal(admins[0].email, 'admin@eshel.co.il');
});

// ---------------------------------------------------------------------------
// העדפות משתמש
// ---------------------------------------------------------------------------

test('userPrefs — שמירה, דריסה ומחיקה ב-null', () => {
  const u = mkUser();
  assert.deepEqual(D.userPrefs(u.id), {});
  D.setUserPref(u.id, 'theme', 'dark');
  D.setUserPref(u.id, 'cols', [1, 2]);
  D.setUserPref(u.id, 'theme', 'light');
  assert.deepEqual(D.userPrefs(u.id), { theme: 'light', cols: [1, 2] });
  D.setUserPref(u.id, 'theme', null);
  assert.deepEqual(D.userPrefs(u.id), { cols: [1, 2] });
});

test('userPrefs — בלי משתמש (ספק): אובייקט ריק ולא נשמר דבר', () => {
  assert.deepEqual(D.userPrefs(null), {});
  assert.doesNotThrow(() => D.setUserPref(null, 'x', 1));
});

// ---------------------------------------------------------------------------
// סיסמאות
// ---------------------------------------------------------------------------

test('hashPassword/verifyPassword', () => {
  const h = D.hashPassword('סוד123');
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(D.verifyPassword('סוד123', h), true);
  assert.equal(D.verifyPassword('סוד124', h), false);
  assert.notEqual(D.hashPassword('סוד123'), h); // מלח אקראי
});

test('verifyPassword — ערך שמור לא תקין', () => {
  assert.equal(D.verifyPassword('x', ''), false);
  assert.equal(D.verifyPassword('x', null), false);
  assert.equal(D.verifyPassword('x', 'nocolon'), false);
});

// ---------------------------------------------------------------------------
// יומן והתראות
// ---------------------------------------------------------------------------

test('audit — ברירת מחדל: המערכת', () => {
  const t = mkTask();
  D.audit(t.id, null, 'test_action', 'פרטים');
  const row = D.get("SELECT * FROM audit_log WHERE task_id = ? AND action = 'test_action'", t.id);
  assert.equal(row.actor_type, 'system');
  assert.equal(row.actor_name, 'המערכת');
  assert.equal(row.details, 'פרטים');
});

test('audit — עם משתמש', () => {
  const u = mkUser();
  D.audit(null, { type: 'user', id: u.id, name: 'דנה' }, 'login');
  const row = D.get("SELECT * FROM audit_log WHERE action = 'login' AND actor_id = ?", u.id);
  assert.equal(row.actor_name, 'דנה');
  assert.equal(row.task_id, null);
  assert.equal(row.details, '');
});

test('notify — נשמרת ומאזינים מקבלים את המזהה', () => {
  const u = mkUser();
  const got = [];
  D.onNotify((n) => got.push(n));
  D.onNotify(() => { throw new Error('מאזין שבור'); });
  D.onNotify('not a function');
  D.notify({ targetType: 'user', targetId: u.id, kind: 'mention', title: 'כותרת', body: 'גוף' });
  const row = D.get('SELECT * FROM notifications WHERE target_id = ? AND kind = ?', u.id, 'mention');
  assert.equal(row.title, 'כותרת');
  assert.equal(row.is_read, 0);
  const mine = got.find((n) => n.targetId === u.id);
  assert.equal(mine.id, row.id);
  assert.equal(mine.push, null);
});

test('countsAsOpener — עובדים כן, מנהלי מערכת לא', () => {
  assert.equal(D.countsAsOpener(mkUser({ role: 'member' }).id), true);
  assert.equal(D.countsAsOpener(mkUser({ role: 'manager' }).id), true);
  assert.equal(D.countsAsOpener(mkUser({ role: 'admin' }).id), false);
  assert.equal(D.countsAsOpener(mkUser({ role: 'superadmin' }).id), false);
  assert.equal(D.countsAsOpener(null), false);
  assert.equal(D.countsAsOpener(999999), false);
});

// ---------------------------------------------------------------------------
// בורדים
// ---------------------------------------------------------------------------

test('internalBoard — אחד בלבד, עם שלוש עמודות', () => {
  const a = D.internalBoard();
  const b = D.internalBoard();
  assert.equal(a.id, b.id);
  assert.equal(D.all("SELECT * FROM boards WHERE type = 'internal'").length, 1);
  assert.deepEqual(D.boardColumns(a.id).map((c) => c.key), ['new', 'in_progress', 'done']);
});

test('createVendorBoard — בורד ספק עם עמודות הספק', () => {
  const v = mkVendor({ name: 'דפוס בע"מ' });
  const id = D.createVendorBoard(v.id, v.name);
  const board = D.get('SELECT * FROM boards WHERE id = ?', id);
  assert.equal(board.type, 'vendor');
  assert.equal(board.name, 'בורד ספק — דפוס בע"מ');
  const cols = D.boardColumns(id);
  assert.deepEqual(cols.map((c) => c.key), D.VENDOR_COLUMNS.map((c) => c.key));
  assert.deepEqual(cols.filter((c) => c.is_final).map((c) => c.key), ['approved']);
});

test('ensureBoardColumns — אידמפוטנטי', () => {
  const id = D.internalBoard().id;
  D.ensureBoardColumns(id, D.INTERNAL_COLUMNS);
  assert.equal(D.boardColumns(id).length, 3);
});

// ---------------------------------------------------------------------------
// מחלקות ובקרת משימות
// ---------------------------------------------------------------------------

test('departmentSubtree — המחלקה וכל מה שמתחתיה', () => {
  const top = mkDept();
  const mid = mkDept({ parent_id: top.id });
  const leaf = mkDept({ parent_id: mid.id });
  mkDept();
  assert.deepEqual(D.departmentSubtree(top.id).sort((a, b) => a - b), [top.id, mid.id, leaf.id]);
  assert.deepEqual(D.departmentSubtree(leaf.id), [leaf.id]);
  assert.deepEqual(D.departmentSubtree(null), []);
});

test('departmentSubtree — מעגל נעצר', () => {
  const a = mkDept();
  const b = mkDept({ parent_id: a.id });
  D.run('UPDATE departments SET parent_id = ? WHERE id = ?', b.id, a.id);
  assert.deepEqual(D.departmentSubtree(a.id).sort((x, y) => x - y), [a.id, b.id]);
  assert.equal(D.departmentPath(a.id).split(' › ').length, 2);
});

test('departmentPath — שרשרת ההורים', () => {
  const top = mkDept({ name: 'הנדסה וביצוע' });
  const site = mkDept({ name: 'אתר אלעד', parent_id: top.id });
  assert.equal(D.departmentPath(site.id), 'הנדסה וביצוע › אתר אלעד');
  assert.equal(D.departmentPath(999999), '');
});

test('trackerDefault — מחלקת תכנון ותתי-מחלקות שלה', () => {
  const plan = mkDept({ name: 'תכנון ורישוי' });
  const sub = mkDept({ name: 'צוות צפון', parent_id: plan.id });
  const other = mkDept({ name: 'כספים' });
  assert.equal(D.trackerDefault(plan.id), true);
  assert.equal(D.trackerDefault(sub.id), true);
  assert.equal(D.trackerDefault(other.id), false);
});

test('trackerAccess — בחירה מפורשת גוברת על המחלקה', () => {
  const plan = mkDept({ name: 'תכנון אדריכלי' });
  assert.equal(D.trackerAccess(mkUser({ department_id: plan.id }).id), true);
  assert.equal(D.trackerAccess(mkUser({ department_id: plan.id, tracker_access: 0 }).id), false);
  assert.equal(D.trackerAccess(mkUser({ tracker_access: 1 }).id), true);
  assert.equal(D.trackerAccess(mkUser().id), false);
  assert.equal(D.trackerAccess(999999), false);
});

// ---------------------------------------------------------------------------
// משימות במסד
// ---------------------------------------------------------------------------

test('משימה — ברירות המחדל של הסכמה', () => {
  const t = mkTask();
  assert.equal(t.priority, 'normal');
  assert.equal(t.archived, 0);
  assert.equal(t.escalated, 0);
  assert.equal(t.recurrence_policy, 'inherit');
  assert.equal(t.sens, 0);
  assert.equal(t.status_short, '');
});

test('משימה — עדיפות לא חוקית נדחית', () => {
  assert.throws(() => mkTask({ priority: 'asap' }), /CHECK/);
});

test('משימה — מחיקת אב מוחקת תתי-משימות', () => {
  const parent = mkTask();
  const child = mkTask({ parent_task_id: parent.id });
  D.run('DELETE FROM tasks WHERE id = ?', parent.id);
  assert.equal(D.get('SELECT 1 FROM tasks WHERE id = ?', child.id), undefined);
});

test('nowIso — ISO ב-UTC', () => {
  assert.match(D.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
