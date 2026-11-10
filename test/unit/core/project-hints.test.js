'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const PH = require('../../../server/tasks/project-hints');

boot();
const board = D.get("SELECT id FROM boards WHERE type = 'internal' LIMIT 1").id;
const owner = user({ full_name: 'יוצר', role: 'manager' });

let clock = Date.parse('2026-01-01T00:00:00Z');
function project(name) {
  return Number(D.run('INSERT INTO projects (name, created_at, created_by) VALUES (?,?,?)', name, new Date().toISOString(), owner.id).lastInsertRowid);
}
function task(projectId, title, extra = {}) {
  clock += 60000; // סדר יצירה קבוע
  const ts = new Date(clock).toISOString();
  const row = { status: 'new', archived: 0, sens: 0, ...extra };
  D.run('INSERT INTO tasks (title, board_id, project_id, status, archived, sens, created_at, status_changed_at) VALUES (?,?,?,?,?,?,?,?)',
    title, board, projectId, row.status, row.archived, row.sens, ts, ts);
}

test('lines — מנהל ומשימות אחרונות פתוחות', () => {
  const id = project('אלעד צפון');
  task(id, 'תסריט חשמל');
  task(id, 'הזמנת מעליות');
  const [line] = PH.lines([{ id, name: 'אלעד צפון', managerName: 'דני' }]);
  assert.equal(line, `${id} · אלעד צפון — מנהל: דני · משימות: הזמנת מעליות; תסריט חשמל`);
});

test('lines — פרויקט בלי מנהל ובלי משימות', () => {
  const id = project('משרד שוטף');
  assert.deepEqual(PH.lines([{ id, name: 'משרד שוטף' }]), [`${id} · משרד שוטף`]);
});

test('lines — עד 3 משימות, החדשות קודם', () => {
  const id = project('גדול');
  for (const t of ['א', 'ב', 'ג', 'ד']) task(id, t);
  assert.match(PH.lines([{ id, name: 'גדול' }])[0], /משימות: ד; ג; ב$/);
});

test('lines — בלי משימות שהושלמו, בארכיון או מסווגות', () => {
  const id = project('סינון');
  task(id, 'פתוחה');
  task(id, 'הושלמה', { status: 'done' });
  task(id, 'בארכיון', { archived: 1 });
  task(id, 'סודית', { sens: 2 });
  task(id, 'רגישה קלה', { sens: 1 });
  assert.match(PH.lines([{ id, name: 'סינון' }])[0], /משימות: רגישה קלה; פתוחה$/);
});

test('lines — כותרת ארוכה נחתכת ל-60 תווים', () => {
  const id = project('ארוך');
  task(id, 'א'.repeat(100));
  const line = PH.lines([{ id, name: 'ארוך' }])[0];
  assert.ok(line.endsWith(`משימות: ${'א'.repeat(60)}`));
});

test('lines — מפריד וסימון מותאמים', () => {
  const id = project('מותאם');
  const out = PH.lines([{ id, name: 'מותאם', mine: true }], { sep: '. ', marker: (p) => (p.mine ? ' ⭐' : '') });
  assert.deepEqual(out, [`${id}. מותאם ⭐`]);
});

test('lines — רשימה ריקה', () => {
  assert.deepEqual(PH.lines([]), []);
});
