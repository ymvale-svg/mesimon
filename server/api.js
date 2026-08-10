'use strict';
/** כל נקודות הקצה של המערכת. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const D = require('./db');
const P = require('./permissions');
const Auth = require('./auth');
const Rules = require('./rules-engine');
const {
  Router, badRequest, forbidden, notFound,
  readJson, sendJson, sendText, parseUrl
} = require('./http-kit');

const router = new Router();

const PRIORITIES = [
  { key: 'low', label: 'נמוכה', color: '#94a3b8' },
  { key: 'normal', label: 'רגילה', color: '#3b82f6' },
  { key: 'high', label: 'גבוהה', color: '#f59e0b' },
  { key: 'urgent', label: 'דחוף', color: '#dc2626' }
];

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------

const isVendor = (actor) => actor.type === 'vendor';
const isManagerial = (actor) => actor.type === 'user' && (actor.role === 'admin' || actor.role === 'manager');

function requirePerm(actor, action) {
  if (!P.may(actor, action)) throw forbidden();
}

function requireFullPerm(actor, action) {
  if (!P.can(actor, action)) throw forbidden();
}

function getTaskOr404(id) {
  const task = D.get('SELECT * FROM tasks WHERE id = ?', Number(id));
  if (!task) throw notFound('המשימה לא נמצאה');
  return task;
}

const projectOf = (task) => (task.project_id ? D.get('SELECT * FROM projects WHERE id = ?', task.project_id) : null);
const boardOf = (task) => D.get('SELECT * FROM boards WHERE id = ?', task.board_id);

/** פרק 3 — מה כל שחקן רשאי לראות */
function canSeeTask(actor, task) {
  const board = boardOf(task);
  if (!board) return false;

  if (isVendor(actor)) {
    // ספק רואה אך ורק את הבורד שלו ואת המשימות שהוקצו לו
    return board.type === 'vendor' && board.vendor_id === actor.id && task.assignee_id === actor.id;
  }
  if (actor.role === 'admin' || actor.role === 'manager') return true;

  // עובד פנימי: רק בבורד הפנימי, ורק משימות שהוא חלק מהן
  if (board.type !== 'internal') return false;
  return P.isTaskParticipant(actor, task, projectOf(task));
}

function assertVisible(actor, task) {
  if (!canSeeTask(actor, task)) throw forbidden('אין לך הרשאה לצפות במשימה זו');
}

const columnsOf = (boardId) => D.boardColumns(boardId);
const columnMeta = (boardId, key) => D.get('SELECT * FROM board_columns WHERE board_id = ? AND key = ?', boardId, key);

function assigneeName(task) {
  if (!task.assignee_id) return null;
  if (task.assignee_type === 'vendor') {
    const v = D.get('SELECT name FROM vendors WHERE id = ?', task.assignee_id);
    return v ? v.name : null;
  }
  const u = D.get('SELECT full_name FROM users WHERE id = ?', task.assignee_id);
  return u ? u.full_name : null;
}

const isOverdue = (task, final) =>
  !!task.due_date && !final && !task.archived && new Date(task.due_date).getTime() < Date.now();

/** ייצוג משימה לממשק, כולל שדות נגזרים */
function shapeTask(task, actor, { withDetails = false } = {}) {
  const board = boardOf(task);
  const col = columnMeta(task.board_id, task.status);
  const final = col ? !!col.is_final : false;
  const project = projectOf(task);

  const checklist = D.all('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position, id', task.id);
  const checklistDone = checklist.filter((c) => c.done).length;

  const dependency = task.depends_on_task_id
    ? D.get('SELECT id, title, status, board_id FROM tasks WHERE id = ?', task.depends_on_task_id)
    : null;
  let dependencyBlocking = false;
  if (dependency) {
    const depCol = columnMeta(dependency.board_id, dependency.status);
    dependencyBlocking = !(depCol && depCol.is_final);
  }

  const base = {
    id: task.id,
    title: task.title,
    description: task.description,
    projectId: task.project_id,
    projectName: project ? project.name : null,
    boardId: task.board_id,
    boardType: board ? board.type : null,
    boardName: board ? board.name : null,
    assigneeType: task.assignee_type,
    assigneeId: task.assignee_id,
    assigneeName: assigneeName(task),
    status: task.status,
    statusLabel: col ? col.label : task.status,
    statusColor: col ? col.color : '#94a3b8',
    isFinal: final,
    priority: task.priority,
    priorityLabel: PRIORITIES.find((p) => p.key === task.priority)?.label ?? task.priority,
    dueDate: task.due_date,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    activateAt: task.activate_at,
    scheduled: !!task.activate_at && new Date(task.activate_at).getTime() > Date.now(),
    isRecurring: !!task.is_recurring,
    recurrenceFreq: task.recurrence_freq,
    recurrencePolicy: task.recurrence_policy,
    archived: !!task.archived,
    escalated: !!task.escalated,
    overdue: isOverdue(task, final),
    checklistTotal: checklist.length,
    checklistDone,
    dependsOnTaskId: task.depends_on_task_id,
    dependency: dependency ? { id: dependency.id, title: dependency.title, blocking: dependencyBlocking } : null,
    // רמזי הרשאה ברמת המשימה — מאפשרים לטבלה להציג עריכה במקום רק למי שרשאי
    canEdit: P.canOnTask(actor, 'edit_delete_task', task, project),
    canChangeStatus: P.canOnTask(actor, 'change_task_status', task, project) && !(isVendor(actor) && actor.readOnly),
    attachmentsCount: D.get('SELECT COUNT(*) c FROM attachments WHERE task_id = ?', task.id).c,
    commentsCount: D.get(
      `SELECT COUNT(*) c FROM comments WHERE task_id = ?${isVendor(actor) ? ' AND internal = 0' : ''}`,
      task.id
    ).c
  };

  if (!withDetails) return base;

  const hideInternal = isVendor(actor);
  const comments = D.all(
    `SELECT * FROM comments WHERE task_id = ?${hideInternal ? ' AND internal = 0' : ''} ORDER BY created_at`,
    task.id
  ).map((c) => ({
    id: c.id,
    body: c.body,
    internal: !!c.internal,
    createdAt: c.created_at,
    authorType: c.author_type,
    authorName:
      c.author_type === 'vendor'
        ? D.get('SELECT name FROM vendors WHERE id = ?', c.author_id)?.name ?? 'ספק'
        : c.author_type === 'user'
          ? D.get('SELECT full_name FROM users WHERE id = ?', c.author_id)?.full_name ?? 'משתמש'
          : 'המערכת'
  }));

  const attachments = D.all('SELECT * FROM attachments WHERE task_id = ? ORDER BY filename, version DESC', task.id).map((a) => ({
    id: a.id,
    filename: a.filename,
    version: a.version,
    size: a.size,
    mime: a.mime,
    createdAt: a.created_at,
    uploaderType: a.uploader_type,
    uploaderName:
      a.uploader_type === 'vendor'
        ? D.get('SELECT name FROM vendors WHERE id = ?', a.uploader_id)?.name ?? 'ספק'
        : D.get('SELECT full_name FROM users WHERE id = ?', a.uploader_id)?.full_name ?? 'משתמש'
  }));

  // הספק אינו רואה את לוג הבקרה הפנימי
  const history = hideInternal
    ? []
    : D.all('SELECT * FROM audit_log WHERE task_id = ? ORDER BY created_at DESC, id DESC', task.id);

  return {
    ...base,
    checklist: checklist.map((c) => ({ id: c.id, text: c.text, done: !!c.done })),
    comments,
    attachments,
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      details: h.details,
      actorName: h.actor_name || 'המערכת',
      actorType: h.actor_type,
      createdAt: h.created_at
    })),
    columns: columnsOf(task.board_id).map((c) => ({ key: c.key, label: c.label, color: c.color, isFinal: !!c.is_final })),
    permissions: {
      edit: P.canOnTask(actor, 'edit_delete_task', task, project),
      changeStatus: P.canOnTask(actor, 'change_task_status', task, project) && !(isVendor(actor) && actor.readOnly),
      approve: P.may(actor, 'approve_vendor_output'),
      comment: !(isVendor(actor) && actor.readOnly),
      upload: !(isVendor(actor) && actor.readOnly),
      seeInternal: !hideInternal
    }
  };
}

function actorRef(actor) {
  return { type: actor.type === 'vendor' ? 'vendor' : 'user', id: actor.id, name: actor.name };
}

/** ניקוי תיוגים @שם והפקת רשימת משתמשים מתויגים */
function extractMentions(body) {
  const users = D.all("SELECT id, full_name FROM users WHERE status = 'active'");
  const found = new Set();
  for (const u of users) {
    if (body.includes(`@${u.full_name}`)) found.add(u.id);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// מיתוג — איתור לוגו החברה
// ---------------------------------------------------------------------------

const IMG_DIR = path.join(D.ROOT, 'public', 'img');
const LOGO_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * מאתר את קובץ הלוגו בתיקיית התמונות, בלי תלות בשם שניתן לו.
 * כך אפשר פשוט לשמור לשם קובץ תמונה והוא ייקלט מעצמו.
 */
function findCompanyLogo() {
  if (!fs.existsSync(IMG_DIR)) return null;
  const files = fs.readdirSync(IMG_DIR).filter((f) => LOGO_EXT.has(path.extname(f).toLowerCase()));
  if (!files.length) return null;
  const preferred = files.find((f) => /eshel|logo|אשל|לוגו/i.test(f)) ?? files.sort()[0];
  return `/img/${encodeURIComponent(preferred)}`;
}

// זמין גם לפני התחברות — מסך הכניסה מציג את הלוגו
router.get('/api/branding', async (req, res) => {
  sendJson(res, 200, { companyLogo: findCompanyLogo() });
});

// ---------------------------------------------------------------------------
// אימות
// ---------------------------------------------------------------------------

router.post('/api/auth/login', async (req, res) => {
  Auth.checkLoginRate(req);
  const { email, password } = await readJson(req);

  let result;
  try {
    result = Auth.login(email, password);
  } catch (err) {
    Auth.noteFailedLogin(req);
    throw err;
  }

  Auth.clearLoginRate(req);
  const { actorType, actor } = result;
  const { token, expires } = Auth.createSession(actorType, actor.id);
  res.setHeader('set-cookie', Auth.cookieHeader(token, expires, req));
  sendJson(res, 200, { actor: publicActor(actor), permissions: P.permissionsFor(actor) });
});

router.post('/api/auth/logout', async (req, res, ctx) => {
  Auth.destroySession(ctx.actor?.token);
  res.setHeader('set-cookie', Auth.clearCookieHeader());
  sendJson(res, 200, { ok: true });
});

function publicActor(actor) {
  return {
    type: actor.type,
    id: actor.id,
    name: actor.name,
    email: actor.email,
    role: actor.role,
    roleLabel: P.ROLE_LABELS[actor.role],
    department: actor.department ?? null,
    boardId: actor.boardId ?? null,
    readOnly: !!actor.readOnly
  };
}

// ---------------------------------------------------------------------------
// טעינה ראשונית
// ---------------------------------------------------------------------------

router.get('/api/bootstrap', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const boards = isVendor(actor)
    ? D.all("SELECT * FROM boards WHERE type='vendor' AND vendor_id = ?", actor.id)
    : P.may(actor, 'view_vendor_boards')
      ? D.all('SELECT * FROM boards ORDER BY type DESC, id')
      : D.all("SELECT * FROM boards WHERE type='internal'");

  const payload = {
    actor: publicActor(actor),
    permissions: P.permissionsFor(actor),
    priorities: PRIORITIES,
    roleLabels: P.ROLE_LABELS,
    settings: {
      orgName: D.getSetting('org_name', 'אשל הירדן'),
      departmentName: D.getSetting('department_name', 'מחלקת שיווק ומכירות'),
      maxUploadMb: D.getSetting('max_upload_mb', 25),
      allowedExtensions: D.getSetting('allowed_extensions', [])
    },
    boards: boards.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      vendorId: b.vendor_id,
      columns: columnsOf(b.id).map((c) => ({ key: c.key, label: c.label, color: c.color, isFinal: !!c.is_final }))
    })),
    projects: isVendor(actor) ? [] : listProjectsFor(actor),
    users: isVendor(actor)
      ? []
      : D.all("SELECT id, full_name, email, role, department, status FROM users WHERE status='active' ORDER BY full_name")
          .map((u) => ({ id: u.id, name: u.full_name, email: u.email, role: u.role, roleLabel: P.ROLE_LABELS[u.role] })),
    vendors: P.may(actor, 'view_vendor_boards') && !isVendor(actor)
      ? D.all('SELECT id, name, contact_name, email, phone, status, read_only FROM vendors ORDER BY name')
          .map((v) => ({
            id: v.id, name: v.name, contactName: v.contact_name, email: v.email,
            phone: v.phone, status: v.status, readOnly: !!v.read_only,
            boardId: D.get("SELECT id FROM boards WHERE type='vendor' AND vendor_id = ?", v.id)?.id ?? null
          }))
      : [],
    savedFilters: isVendor(actor)
      ? []
      : D.all('SELECT id, name, payload FROM saved_filters WHERE user_id = ? ORDER BY name', actor.id)
          .map((f) => ({ id: f.id, name: f.name, payload: JSON.parse(f.payload) }))
  };
  sendJson(res, 200, payload);
});

function listProjectsFor(actor) {
  const rows = D.all('SELECT * FROM projects ORDER BY status, name');
  return rows.map((p) => {
    const stats = D.get(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN c.is_final = 1 THEN 1 ELSE 0 END) done
         FROM tasks t LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.project_id = ? AND t.archived = 0`,
      p.id
    );
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      managerId: p.manager_id,
      managerName: p.manager_id ? D.get('SELECT full_name FROM users WHERE id = ?', p.manager_id)?.full_name ?? null : null,
      startDate: p.start_date,
      dueDate: p.due_date,
      status: p.status,
      tasksTotal: stats.total ?? 0,
      tasksDone: stats.done ?? 0
    };
  });
}

// ---------------------------------------------------------------------------
// משימות
// ---------------------------------------------------------------------------

router.get('/api/tasks', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const q = parseUrl(req).searchParams;

  const where = ['1=1'];
  const params = [];

  // הפרדת הבורדים — פרק 3
  if (isVendor(actor)) {
    where.push("b.type = 'vendor'", 'b.vendor_id = ?', 't.assignee_id = ?');
    params.push(actor.id, actor.id);
  } else {
    const scope = q.get('scope') ?? 'internal'; // internal | vendors | all
    if (scope === 'internal') {
      where.push("b.type = 'internal'");
    } else if (scope === 'vendors') {
      if (!P.may(actor, 'view_vendor_boards')) throw forbidden('אין לך הרשאה לתצוגת בורדי הספקים');
      where.push("b.type = 'vendor'");
      const vendorId = q.get('vendorId');
      if (vendorId) { where.push('b.vendor_id = ?'); params.push(Number(vendorId)); }
    } else if (!P.may(actor, 'view_vendor_boards')) {
      where.push("b.type = 'internal'");
    }

    if (actor.role === 'employee') {
      where.push('(t.assignee_id = ? AND t.assignee_type = \'user\' OR t.created_by = ? OR p.manager_id = ?)');
      params.push(actor.id, actor.id, actor.id);
    }
  }

  const archived = q.get('archived') === '1';
  where.push(archived ? 't.archived = 1' : 't.archived = 0');

  // פרק 7.4 — משימות עתידיות אינן מופיעות ברשימות הפעילות
  if (q.get('includeScheduled') !== '1') {
    where.push('(t.activate_at IS NULL OR t.activate_at <= ?)');
    params.push(D.nowIso());
  }

  const simpleFilters = [
    ['projectId', 't.project_id = ?', Number],
    ['boardId', 't.board_id = ?', Number],
    ['status', 't.status = ?', String],
    ['priority', 't.priority = ?', String]
  ];
  for (const [key, clause, cast] of simpleFilters) {
    const v = q.get(key);
    if (v) { where.push(clause); params.push(cast(v)); }
  }

  const assignee = q.get('assignee'); // "user:3" / "vendor:1"
  if (assignee) {
    const [type, id] = assignee.split(':');
    where.push('t.assignee_type = ? AND t.assignee_id = ?');
    params.push(type, Number(id));
  }

  const dueBefore = q.get('dueBefore');
  if (dueBefore) { where.push('t.due_date IS NOT NULL AND t.due_date <= ?'); params.push(dueBefore); }
  const dueAfter = q.get('dueAfter');
  if (dueAfter) { where.push('t.due_date IS NOT NULL AND t.due_date >= ?'); params.push(dueAfter); }

  const search = q.get('q');
  if (search) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const rows = D.all(
    `SELECT t.* FROM tasks t
       JOIN boards b ON b.id = t.board_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.due_date IS NULL, t.due_date, t.id DESC`,
    ...params
  );

  sendJson(res, 200, { tasks: rows.map((t) => shapeTask(t, actor)) });
});

router.get('/api/tasks/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  sendJson(res, 200, { task: shapeTask(task, actor, { withDetails: true }) });
});

router.post('/api/tasks', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'create_task');
  const body = await readJson(req);

  const title = String(body.title ?? '').trim();
  if (!title) throw badRequest('נדרשת כותרת למשימה');

  let boardId = D.internalBoard().id;
  let assigneeType = body.assigneeType ?? null;
  let assigneeId = body.assigneeId ? Number(body.assigneeId) : null;

  // הקצאה לספק מחייבת הרשאה, ומעבירה את המשימה לבורד של אותו ספק (פרק 3)
  if (assigneeType === 'vendor') {
    requirePerm(actor, 'assign_task_to_vendor');
    const vendorBoard = D.get("SELECT id FROM boards WHERE type='vendor' AND vendor_id = ?", assigneeId);
    if (!vendorBoard) throw badRequest('לספק אין בורד ייעודי');
    boardId = vendorBoard.id;
  } else if (body.boardId) {
    // בורד מפורש מתקבל רק אחרי בדיקת סוגו — אחרת אפשר היה לשתול משימה
    // בבורד ספק בלי הרשאת הקצאה לספק
    const board = D.get('SELECT * FROM boards WHERE id = ?', Number(body.boardId));
    if (!board) throw badRequest('הבורד המבוקש לא קיים');
    if (board.type === 'vendor') {
      requirePerm(actor, 'assign_task_to_vendor');
      // משימה בבורד ספק תמיד משויכת לאותו ספק — אין משימות ספק ללא אחראי
      assigneeType = 'vendor';
      assigneeId = board.vendor_id;
    }
    boardId = board.id;
  }

  const status = String(body.status ?? '') || Rules.firstColumnKey(boardId);
  if (!columnMeta(boardId, status)) throw badRequest('סטטוס לא קיים בבורד זה');

  const res1 = D.run(
    `INSERT INTO tasks
      (title, description, project_id, board_id, assignee_type, assignee_id, status, priority,
       due_date, created_at, created_by, status_changed_at, activate_at, depends_on_task_id,
       is_recurring, recurrence_freq, recurrence_policy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    title,
    String(body.description ?? ''),
    body.projectId ? Number(body.projectId) : null,
    boardId,
    assigneeType,
    assigneeId,
    status,
    body.priority ?? 'normal',
    body.dueDate || null,
    D.nowIso(),
    actor.type === 'user' ? actor.id : null,
    D.nowIso(),
    body.activateAt || null,
    body.dependsOnTaskId ? Number(body.dependsOnTaskId) : null,
    body.isRecurring ? 1 : 0,
    body.isRecurring ? (body.recurrenceFreq ?? 'weekly') : null,
    body.recurrencePolicy ?? 'inherit'
  );
  const id = Number(res1.lastInsertRowid);

  for (const [i, text] of (body.checklist ?? []).entries()) {
    const t = String(text).trim();
    if (t) D.run('INSERT INTO checklist_items (task_id, text, position) VALUES (?,?,?)', id, t, i);
  }

  D.audit(id, actorRef(actor), 'created', 'המשימה נוצרה');
  if (assigneeId) notifyAssignment(id, assigneeType, assigneeId, title);

  sendJson(res, 201, { task: shapeTask(getTaskOr404(id), actor, { withDetails: true }) });
});

function notifyAssignment(taskId, assigneeType, assigneeId, title) {
  D.notify({
    targetType: assigneeType === 'vendor' ? 'vendor' : 'user',
    targetId: assigneeId,
    kind: 'assignment',
    title: 'הוקצתה לך משימה חדשה',
    body: title,
    taskId
  });
}

router.patch('/api/tasks/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  const body = await readJson(req);
  const project = projectOf(task);

  if (isVendor(actor) && actor.readOnly) throw forbidden('לחשבון שלך הוגדרה הרשאת צפייה בלבד');

  // שינוי סטטוס — מסלול נפרד עם כללי הזרימה של פרק 8
  if (body.status !== undefined && body.status !== task.status) {
    if (!P.canOnTask(actor, 'change_task_status', task, project)) throw forbidden('אין לך הרשאה לשנות את סטטוס המשימה');
    changeStatus(task, body.status, actor);
  }

  const editableByAll = new Set(['status']);
  const wantsMore = Object.keys(body).some((k) => !editableByAll.has(k));
  if (wantsMore) {
    if (isVendor(actor)) throw forbidden('ספק אינו רשאי לערוך את שדות המשימה');
    if (!P.canOnTask(actor, 'edit_delete_task', task, project)) throw forbidden('אין לך הרשאה לערוך משימה זו');

    const changes = [];
    const setField = (field, column, value, label, formatter = (v) => v) => {
      if (value === undefined) return;
      const current = task[column];
      const next = value === '' ? null : value;
      if (String(current ?? '') === String(next ?? '')) return;
      D.run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, next, task.id);
      changes.push(`${label}: ${formatter(current) || '—'} ← ${formatter(next) || '—'}`);
    };

    setField('title', 'title', body.title !== undefined ? String(body.title).trim() : undefined, 'כותרת');
    setField('description', 'description', body.description !== undefined ? String(body.description) : undefined, 'תיאור');
    setField('priority', 'priority', body.priority, 'עדיפות', (v) => PRIORITIES.find((p) => p.key === v)?.label ?? v);
    setField('dueDate', 'due_date', body.dueDate, 'תאריך יעד', Rules.formatDate);
    setField('projectId', 'project_id', body.projectId !== undefined ? (body.projectId ? Number(body.projectId) : null) : undefined, 'פרויקט',
      (v) => (v ? D.get('SELECT name FROM projects WHERE id = ?', v)?.name ?? '' : ''));
    setField('activateAt', 'activate_at', body.activateAt, 'תאריך הפעלה', Rules.formatDate);
    setField('dependsOn', 'depends_on_task_id',
      body.dependsOnTaskId !== undefined ? (body.dependsOnTaskId ? Number(body.dependsOnTaskId) : null) : undefined,
      'תלות במשימה', (v) => (v ? `#${v}` : ''));

    if (body.isRecurring !== undefined) {
      D.run('UPDATE tasks SET is_recurring = ?, recurrence_freq = ? WHERE id = ?',
        body.isRecurring ? 1 : 0, body.isRecurring ? (body.recurrenceFreq ?? 'weekly') : null, task.id);
      changes.push(body.isRecurring ? `הוגדרה חזרתיות (${body.recurrenceFreq ?? 'weekly'})` : 'בוטלה החזרתיות');
    }
    if (body.recurrencePolicy !== undefined) {
      D.run('UPDATE tasks SET recurrence_policy = ? WHERE id = ?', body.recurrencePolicy, task.id);
      changes.push('עודכנה מדיניות המופע החוזר');
    }

    // שינוי אחראי — כולל מעבר בין בורדים
    if (body.assigneeType !== undefined || body.assigneeId !== undefined) {
      const newType = body.assigneeType ?? task.assignee_type;
      const newId = body.assigneeId === null || body.assigneeId === '' ? null : Number(body.assigneeId ?? task.assignee_id);
      if (newType !== task.assignee_type || newId !== task.assignee_id) {
        let boardId = task.board_id;
        if (newType === 'vendor' && newId) {
          requirePerm(actor, 'assign_task_to_vendor');
          const vb = D.get("SELECT id FROM boards WHERE type='vendor' AND vendor_id = ?", newId);
          if (!vb) throw badRequest('לספק אין בורד ייעודי');
          boardId = vb.id;
        } else if (newType === 'user') {
          boardId = D.internalBoard().id;
        }
        const prevName = assigneeName(task) ?? '—';
        let status = task.status;
        if (boardId !== task.board_id) status = Rules.firstColumnKey(boardId);
        D.run('UPDATE tasks SET assignee_type = ?, assignee_id = ?, board_id = ?, status = ?, status_changed_at = ? WHERE id = ?',
          newType, newId, boardId, status, D.nowIso(), task.id);
        const updated = getTaskOr404(task.id);
        changes.push(`אחראי: ${prevName} ← ${assigneeName(updated) ?? '—'}`);
        if (newId) notifyAssignment(task.id, newType, newId, task.title);
      }
    }

    if (body.archived !== undefined) {
      D.run('UPDATE tasks SET archived = ? WHERE id = ?', body.archived ? 1 : 0, task.id);
      changes.push(body.archived ? 'המשימה הועברה לארכיון' : 'המשימה הוחזרה מהארכיון');
    }

    if (changes.length) D.audit(task.id, actorRef(actor), 'updated', changes.join(' | '));
  }

  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

/** מימוש חוקי המעבר של פרק 8 + בדיקת תלות */
function changeStatus(task, newStatus, actor, note = '') {
  const target = columnMeta(task.board_id, newStatus);
  if (!target) throw badRequest('סטטוס לא קיים בבורד זה');
  const current = columnMeta(task.board_id, task.status);

  // אזהרת תלות — לא ניתן לסגור משימה שתלויה במשימה שטרם הושלמה (פרק 5.3)
  if (target.is_final && task.depends_on_task_id) {
    const dep = D.get('SELECT * FROM tasks WHERE id = ?', task.depends_on_task_id);
    if (dep) {
      const depCol = columnMeta(dep.board_id, dep.status);
      if (!depCol?.is_final) {
        throw badRequest(`לא ניתן לסגור: המשימה תלויה במשימה "${dep.title}" שטרם הושלמה`);
      }
    }
  }

  const board = boardOf(task);
  if (board.type === 'vendor') {
    if (isVendor(actor)) {
      // הספק רשאי רק לדווח על תוצר ולסמן שסיים מצדו
      const allowed = ['uploaded', 'pending_team_review'];
      if (!allowed.includes(newStatus)) throw forbidden('ספק רשאי לסמן רק העלאת תוצרים או סיום מצדו');
    } else if (newStatus === 'approved') {
      // 5א — אישור סופי בלבד למי שמורשה
      requirePerm(actor, 'approve_vendor_output');
    }
  }

  D.run('UPDATE tasks SET status = ?, status_changed_at = ?, escalated = 0 WHERE id = ?', newStatus, D.nowIso(), task.id);
  if (target.is_final) {
    D.run('UPDATE tasks SET completed_at = ? WHERE id = ?', D.nowIso(), task.id);
  } else if (current?.is_final) {
    D.run('UPDATE tasks SET completed_at = NULL WHERE id = ?', task.id);
  }

  D.audit(task.id, actorRef(actor), 'status_changed',
    `סטטוס: ${current?.label ?? task.status} ← ${target.label}${note ? ` | ${note}` : ''}`);

  // התראות לצדדים הרלוונטיים
  if (board.type === 'vendor') {
    if (newStatus === 'needs_fix' && task.assignee_id) {
      D.notify({
        targetType: 'vendor', targetId: task.assignee_id, kind: 'status_change',
        title: 'נדרש תיקון בתוצר שהוגש',
        body: note || `המשימה "${task.title}" הוחזרה לטיפולך עם הערות הצוות.`,
        taskId: task.id
      });
    } else if (newStatus === 'approved' && task.assignee_id) {
      D.notify({
        targetType: 'vendor', targetId: task.assignee_id, kind: 'status_change',
        title: 'התוצר אושר סופית', body: task.title, taskId: task.id
      });
    } else if (isVendor(actor)) {
      for (const m of D.all("SELECT id FROM users WHERE role IN ('admin','manager') AND status='active'")) {
        D.notify({
          targetType: 'user', targetId: m.id, kind: 'status_change',
          title: newStatus === 'pending_team_review' ? 'ספק סיים משימה — ממתין לבדיקה' : 'ספק העלה תוצרים',
          body: `${task.title} — ${actor.name}`, taskId: task.id
        });
      }
    }
  } else if (task.assignee_type === 'user' && task.assignee_id && task.assignee_id !== actor.id) {
    D.notify({
      targetType: 'user', targetId: task.assignee_id, kind: 'status_change',
      title: 'שינוי סטטוס במשימה שלך', body: `${task.title} — ${target.label}`, taskId: task.id
    });
  }
}

/** 5ב — דחייה והחזרה לספק עם הערות */
router.post('/api/tasks/:id/review', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'approve_vendor_output');
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  const { decision, note } = await readJson(req);

  if (!['approve', 'reject', 'start_review'].includes(decision)) throw badRequest('החלטה לא מוכרת');
  const nextStatus = decision === 'approve' ? 'approved' : decision === 'reject' ? 'needs_fix' : 'in_team_review';

  if (note) {
    D.run('INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,0,?)',
      task.id, 'user', actor.id, note, D.nowIso());
  }
  changeStatus(task, nextStatus, actor, note);
  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

/** פעולות אצווה — פרק 5.2 */
router.post('/api/tasks/bulk', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  const { ids, action, value } = await readJson(req);
  if (!Array.isArray(ids) || !ids.length) throw badRequest('לא נבחרו משימות');

  let affected = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const task = getTaskOr404(id);
      assertVisible(actor, task);
      const project = projectOf(task);
      if (action === 'status') {
        if (!P.canOnTask(actor, 'change_task_status', task, project)) throw forbidden();
        changeStatus(task, value, actor);
      } else if (action === 'assignee') {
        if (!P.canOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
        const [type, rawId] = String(value).split(':');
        if (type === 'vendor') requirePerm(actor, 'assign_task_to_vendor');
        const boardId = type === 'vendor'
          ? D.get("SELECT id FROM boards WHERE type='vendor' AND vendor_id = ?", Number(rawId))?.id
          : D.internalBoard().id;
        if (!boardId) throw badRequest('לספק אין בורד ייעודי');
        const status = boardId !== task.board_id ? Rules.firstColumnKey(boardId) : task.status;
        D.run('UPDATE tasks SET assignee_type = ?, assignee_id = ?, board_id = ?, status = ?, status_changed_at = ? WHERE id = ?',
          type, Number(rawId), boardId, status, D.nowIso(), task.id);
        D.audit(task.id, actorRef(actor), 'updated', `שינוי אחראי (פעולת אצווה)`);
        notifyAssignment(task.id, type, Number(rawId), task.title);
      } else if (action === 'priority') {
        if (!P.canOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
        D.run('UPDATE tasks SET priority = ? WHERE id = ?', value, task.id);
        D.audit(task.id, actorRef(actor), 'updated', `עדיפות שונתה ל-${PRIORITIES.find((p) => p.key === value)?.label}`);
      } else if (action === 'archive') {
        if (!P.canOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
        D.run('UPDATE tasks SET archived = ? WHERE id = ?', value ? 1 : 0, task.id);
        D.audit(task.id, actorRef(actor), 'updated', value ? 'הועברה לארכיון' : 'הוחזרה מהארכיון');
      } else {
        throw badRequest('פעולת אצווה לא מוכרת');
      }
      affected++;
    } catch (err) {
      errors.push({ id, message: err.message });
    }
  }
  sendJson(res, 200, { affected, errors });
});

router.delete('/api/tasks/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (!P.canOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden('אין לך הרשאה למחוק משימה זו');
  D.run('DELETE FROM tasks WHERE id = ?', task.id);
  sendJson(res, 200, { ok: true });
});

// --- צ'קליסט ---

router.post('/api/tasks/:id/checklist', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor)) throw forbidden();
  if (!P.canOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden();
  const { text } = await readJson(req);
  const clean = String(text ?? '').trim();
  if (!clean) throw badRequest('נדרש טקסט');
  const pos = D.get('SELECT COALESCE(MAX(position), -1) + 1 p FROM checklist_items WHERE task_id = ?', task.id).p;
  D.run('INSERT INTO checklist_items (task_id, text, position) VALUES (?,?,?)', task.id, clean, pos);
  D.audit(task.id, actorRef(actor), 'checklist', `נוסף סעיף: ${clean}`);
  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

router.patch('/api/checklist/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const item = D.get('SELECT * FROM checklist_items WHERE id = ?', Number(ctx.params.id));
  if (!item) throw notFound();
  const task = getTaskOr404(item.task_id);
  assertVisible(actor, task);
  if (!P.canOnTask(actor, 'change_task_status', task, projectOf(task))) throw forbidden();
  const { done } = await readJson(req);
  D.run('UPDATE checklist_items SET done = ? WHERE id = ?', done ? 1 : 0, item.id);
  D.audit(task.id, actorRef(actor), 'checklist', `${done ? 'הושלם' : 'בוטל'} סעיף: ${item.text}`);
  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

router.delete('/api/checklist/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const item = D.get('SELECT * FROM checklist_items WHERE id = ?', Number(ctx.params.id));
  if (!item) throw notFound();
  const task = getTaskOr404(item.task_id);
  assertVisible(actor, task);
  if (isVendor(actor) || !P.canOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden();
  D.run('DELETE FROM checklist_items WHERE id = ?', item.id);
  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

// --- תגובות ---

router.post('/api/tasks/:id/comments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor) && actor.readOnly) throw forbidden('לחשבון שלך הוגדרה הרשאת צפייה בלבד');
  const { body, internal } = await readJson(req);
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('נדרש תוכן לתגובה');

  // הערה פנימית זמינה רק לצוות הפנימי (פרק 5.4)
  const isInternal = !isVendor(actor) && !!internal;
  const result = D.run(
    'INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,?,?)',
    task.id, isVendor(actor) ? 'vendor' : 'user', actor.id, text, isInternal ? 1 : 0, D.nowIso()
  );
  const commentId = Number(result.lastInsertRowid);

  for (const uid of extractMentions(text)) {
    D.run('INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?,?)', commentId, uid);
    if (uid !== actor.id || isVendor(actor)) {
      D.notify({
        targetType: 'user', targetId: uid, kind: 'mention',
        title: `${actor.name} תייג/ה אותך בתגובה`, body: text.slice(0, 120), taskId: task.id
      });
    }
  }

  D.audit(task.id, actorRef(actor), 'comment', isInternal ? 'נוספה הערה פנימית' : 'נוספה תגובה');

  // עדכון הצד השני
  if (isVendor(actor)) {
    for (const m of D.all("SELECT id FROM users WHERE role IN ('admin','manager') AND status='active'")) {
      D.notify({ targetType: 'user', targetId: m.id, kind: 'status_change', title: 'תגובה חדשה מספק', body: `${task.title} — ${actor.name}`, taskId: task.id });
    }
  } else if (!isInternal && task.assignee_type === 'vendor' && task.assignee_id) {
    D.notify({ targetType: 'vendor', targetId: task.assignee_id, kind: 'status_change', title: 'תגובה חדשה מהצוות', body: task.title, taskId: task.id });
  }

  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

// --- קבצים מצורפים ---

router.post('/api/tasks/:id/attachments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor) && actor.readOnly) throw forbidden('לחשבון שלך הוגדרה הרשאת צפייה בלבד');

  const { filename, mime, data } = await readJson(req);
  const name = String(filename ?? '').trim();
  if (!name || !data) throw badRequest('חסר קובץ');

  const ext = path.extname(name).replace('.', '').toLowerCase();
  const allowed = D.getSetting('allowed_extensions', []);
  if (allowed.length && !allowed.includes(ext)) {
    throw badRequest(`סוג הקובץ .${ext} אינו מורשה. מותרים: ${allowed.join(', ')}`);
  }

  const buffer = Buffer.from(String(data).split(',').pop(), 'base64');
  const maxMb = Number(D.getSetting('max_upload_mb', 25));
  if (buffer.length > maxMb * 1024 * 1024) throw badRequest(`הקובץ חורג מהמגבלה (${maxMb}MB)`);

  // גרסאות היסטוריות — הקובץ הקודם נשמר ואינו נדרס (פרק 5.3)
  const prev = D.get('SELECT MAX(version) v FROM attachments WHERE task_id = ? AND filename = ?', task.id, name);
  const version = (prev?.v ?? 0) + 1;

  const stored = `${task.id}_${crypto.randomBytes(8).toString('hex')}${path.extname(name)}`;
  fs.writeFileSync(path.join(D.UPLOADS_DIR, stored), buffer);

  D.run(
    'INSERT INTO attachments (task_id, filename, stored_name, version, size, mime, uploader_type, uploader_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    task.id, name, stored, version, buffer.length, mime || 'application/octet-stream',
    isVendor(actor) ? 'vendor' : 'user', actor.id, D.nowIso()
  );
  D.audit(task.id, actorRef(actor), 'attachment', `הועלה קובץ "${name}" (גרסה ${version})`);

  // פרק 8, שלב 2 — העלאת תוצרים מקדמת את הסטטוס אוטומטית
  if (isVendor(actor) && task.status === 'awaiting_upload') {
    changeStatus(getTaskOr404(task.id), 'uploaded', actor, 'עודכן אוטומטית בעקבות העלאת תוצר');
  }

  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

router.get('/api/attachments/:id/download', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const att = D.get('SELECT * FROM attachments WHERE id = ?', Number(ctx.params.id));
  if (!att) throw notFound('הקובץ לא נמצא');
  assertVisible(actor, getTaskOr404(att.task_id));

  const filePath = path.join(D.UPLOADS_DIR, att.stored_name);
  if (!fs.existsSync(filePath)) throw notFound('הקובץ אינו קיים בשרת');
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': att.mime,
    'content-length': buf.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`
  });
  res.end(buf);
});

// ---------------------------------------------------------------------------
// פרויקטים
// ---------------------------------------------------------------------------

router.get('/api/projects', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  sendJson(res, 200, { projects: listProjectsFor(actor) });
});

router.post('/api/projects', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'create_project');
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  if (!name) throw badRequest('נדרש שם פרויקט');
  const r = D.run(
    'INSERT INTO projects (name, description, manager_id, start_date, due_date, status, created_at) VALUES (?,?,?,?,?,?,?)',
    name, String(b.description ?? ''), b.managerId ? Number(b.managerId) : null,
    b.startDate || null, b.dueDate || null, b.status ?? 'active', D.nowIso()
  );
  const id = Number(r.lastInsertRowid);

  // יצירה מתבנית (שלב ג׳)
  if (b.templateId) {
    const tpl = D.get("SELECT * FROM templates WHERE id = ? AND kind = 'project'", Number(b.templateId));
    if (tpl) {
      const payload = JSON.parse(tpl.payload);
      const boardId = D.internalBoard().id;
      for (const title of payload.tasks ?? []) {
        const tr = D.run(
          `INSERT INTO tasks (title, project_id, board_id, status, priority, created_at, created_by, status_changed_at)
           VALUES (?,?,?,?,'normal',?,?,?)`,
          title, id, boardId, Rules.firstColumnKey(boardId), D.nowIso(), actor.id, D.nowIso()
        );
        D.audit(Number(tr.lastInsertRowid), actorRef(actor), 'created', `נוצרה מתבנית "${tpl.name}"`);
      }
    }
  }
  sendJson(res, 201, { projects: listProjectsFor(actor) });
});

router.patch('/api/projects/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'create_project');
  const project = D.get('SELECT * FROM projects WHERE id = ?', Number(ctx.params.id));
  if (!project) throw notFound();
  const b = await readJson(req);
  D.run(
    'UPDATE projects SET name = ?, description = ?, manager_id = ?, start_date = ?, due_date = ?, status = ? WHERE id = ?',
    b.name ?? project.name, b.description ?? project.description,
    b.managerId !== undefined ? (b.managerId ? Number(b.managerId) : null) : project.manager_id,
    b.startDate !== undefined ? (b.startDate || null) : project.start_date,
    b.dueDate !== undefined ? (b.dueDate || null) : project.due_date,
    b.status ?? project.status, project.id
  );
  sendJson(res, 200, { projects: listProjectsFor(actor) });
});

router.delete('/api/projects/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'create_project');
  D.run('DELETE FROM projects WHERE id = ?', Number(ctx.params.id));
  sendJson(res, 200, { projects: listProjectsFor(actor) });
});

// ---------------------------------------------------------------------------
// התראות
// ---------------------------------------------------------------------------

router.get('/api/notifications', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const rows = D.all(
    'SELECT * FROM notifications WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 100',
    actor.type === 'vendor' ? 'vendor' : 'user', actor.id
  );
  sendJson(res, 200, {
    notifications: rows.map((n) => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body,
      taskId: n.task_id, isRead: !!n.is_read, createdAt: n.created_at
    })),
    unread: rows.filter((n) => !n.is_read).length
  });
});

router.post('/api/notifications/read', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const { id } = await readJson(req);
  const targetType = actor.type === 'vendor' ? 'vendor' : 'user';
  if (id) D.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND target_type = ? AND target_id = ?', Number(id), targetType, actor.id);
  else D.run('UPDATE notifications SET is_read = 1 WHERE target_type = ? AND target_id = ?', targetType, actor.id);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// דף הבית — פרק 5.1
// ---------------------------------------------------------------------------

router.get('/api/home', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const now = Date.now();

  const mine = D.all(
    `SELECT t.* FROM tasks t
       JOIN boards b ON b.id = t.board_id
       LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
      WHERE t.archived = 0
        AND (t.activate_at IS NULL OR t.activate_at <= ?)
        AND t.assignee_type = ? AND t.assignee_id = ?`,
    D.nowIso(), actor.type === 'vendor' ? 'vendor' : 'user', actor.id
  ).map((t) => shapeTask(t, actor));

  const openMine = mine.filter((t) => !t.isFinal);

  let awaitingApproval = [];
  if (P.may(actor, 'approve_vendor_output')) {
    awaitingApproval = D.all(
      `SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE b.type = 'vendor' AND t.archived = 0
          AND t.status IN ('pending_team_review','in_team_review','uploaded')`
    ).map((t) => shapeTask(t, actor));
  } else if (isVendor(actor)) {
    awaitingApproval = mine.filter((t) => ['pending_team_review', 'in_team_review', 'uploaded'].includes(t.status));
  }

  const feed = D.all(
    `SELECT a.*, t.title AS task_title FROM audit_log a
       JOIN tasks t ON t.id = a.task_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
  ).filter((row) => {
    const task = D.get('SELECT * FROM tasks WHERE id = ?', row.task_id);
    return task && canSeeTask(actor, task);
  }).slice(0, 15).map((row) => ({
    id: row.id, action: row.action, details: row.details,
    actorName: row.actor_name || 'המערכת', taskId: row.task_id,
    taskTitle: row.task_title, createdAt: row.created_at
  }));

  const weekAhead = openMine
    .filter((t) => t.dueDate && new Date(t.dueDate).getTime() <= now + 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  sendJson(res, 200, {
    widgets: {
      mine: openMine.length,
      overdue: openMine.filter((t) => t.overdue).length,
      urgent: openMine.filter((t) => t.priority === 'urgent').length,
      awaitingApproval: awaitingApproval.length
    },
    tasks: { mine: openMine, awaitingApproval },
    feed,
    weekAhead
  });
});

// ---------------------------------------------------------------------------
// דוחות — שלב ד׳
// ---------------------------------------------------------------------------

router.get('/api/reports', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'view_reports');

  const workload = D.all("SELECT id, full_name FROM users WHERE status='active' ORDER BY full_name").map((u) => {
    const rows = D.all(
      `SELECT t.*, c.is_final FROM tasks t
         LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.assignee_type='user' AND t.assignee_id = ? AND t.archived = 0`, u.id
    );
    const open = rows.filter((r) => !r.is_final);
    return {
      id: u.id, name: u.full_name,
      open: open.length,
      overdue: open.filter((r) => r.due_date && new Date(r.due_date).getTime() < Date.now()).length,
      urgent: open.filter((r) => r.priority === 'urgent').length,
      done: rows.filter((r) => r.is_final).length
    };
  });

  const vendors = D.all('SELECT id, name FROM vendors ORDER BY name').map((v) => {
    const rows = D.all(
      `SELECT t.*, c.is_final FROM tasks t
         LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.assignee_type='vendor' AND t.assignee_id = ?`, v.id
    );
    const done = rows.filter((r) => r.is_final && r.completed_at);
    const onTime = done.filter((r) => !r.due_date || new Date(r.completed_at) <= new Date(r.due_date));
    const durations = done
      .filter((r) => r.created_at && r.completed_at)
      .map((r) => (new Date(r.completed_at) - new Date(r.created_at)) / (24 * 60 * 60 * 1000));
    return {
      id: v.id, name: v.name,
      total: rows.length,
      open: rows.filter((r) => !r.is_final && !r.archived).length,
      done: done.length,
      overdue: rows.filter((r) => !r.is_final && r.due_date && new Date(r.due_date).getTime() < Date.now()).length,
      onTimeRate: done.length ? Math.round((onTime.length / done.length) * 100) : null,
      avgDays: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null
    };
  });

  const projects = listProjectsFor(actor).map((p) => {
    const rows = D.all(
      `SELECT t.*, c.is_final FROM tasks t
         LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.project_id = ? AND t.archived = 0`, p.id
    );
    return {
      ...p,
      overdue: rows.filter((r) => !r.is_final && r.due_date && new Date(r.due_date).getTime() < Date.now()).length
    };
  });

  const statusBreakdown = D.all(
    `SELECT b.type AS board_type, c.label AS label, c.color AS color, COUNT(t.id) AS count
       FROM tasks t
       JOIN boards b ON b.id = t.board_id
       JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
      WHERE t.archived = 0
      GROUP BY b.type, c.key ORDER BY b.type, c.position`
  );

  sendJson(res, 200, { workload, vendors, projects, statusBreakdown });
});

router.get('/api/export/tasks.csv', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'export_data');

  const rows = D.all(
    `SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id ORDER BY t.id`
  ).filter((t) => canSeeTask(actor, t)).map((t) => shapeTask(t, actor));

  const header = ['מזהה', 'כותרת', 'פרויקט', 'בורד', 'אחראי', 'סטטוס', 'עדיפות', 'תאריך יעד', 'תאריך יצירה', 'הושלם בתאריך', 'באיחור'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(',')];
  for (const t of rows) {
    lines.push([
      t.id, t.title, t.projectName ?? '', t.boardName ?? '', t.assigneeName ?? '',
      t.statusLabel, t.priorityLabel, Rules.formatDate(t.dueDate), Rules.formatDate(t.createdAt),
      t.completedAt ? Rules.formatDate(t.completedAt) : '', t.overdue ? 'כן' : 'לא'
    ].map(esc).join(','));
  }
  // BOM כדי ש-Excel יזהה עברית
  sendText(res, 200, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8', {
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('משימון-משימות.csv')}`
  });
});

// ---------------------------------------------------------------------------
// ניהול משתמשים — מנהל מערכת בלבד
// ---------------------------------------------------------------------------

router.get('/api/admin/users', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_users');
  sendJson(res, 200, {
    users: D.all('SELECT id, full_name, email, role, department, status, created_at FROM users ORDER BY full_name')
      .map((u) => ({ id: u.id, name: u.full_name, email: u.email, role: u.role, roleLabel: P.ROLE_LABELS[u.role], department: u.department, status: u.status }))
  });
});

router.post('/api/admin/users', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_users');
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!name || !email) throw badRequest('נדרשים שם ואימייל');
  if (D.get('SELECT 1 FROM users WHERE lower(email)=?', email) || D.get('SELECT 1 FROM vendors WHERE lower(email)=?', email)) {
    throw badRequest('כתובת האימייל כבר קיימת במערכת');
  }
  if (!['admin', 'manager', 'employee'].includes(b.role)) throw badRequest('רמת גישה לא תקינה');
  D.run(
    'INSERT INTO users (full_name, email, password_hash, role, department, status, created_at) VALUES (?,?,?,?,?,?,?)',
    name, email, D.hashPassword(b.password || '1234'), b.role, b.department || 'שיווק ומכירות', 'active', D.nowIso()
  );
  sendJson(res, 201, { ok: true });
});

router.patch('/api/admin/users/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_users');
  const user = D.get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
  if (!user) throw notFound();
  const b = await readJson(req);
  if (b.role && !['admin', 'manager', 'employee'].includes(b.role)) throw badRequest('רמת גישה לא תקינה');
  if (user.id === actor.id && b.status === 'inactive') throw badRequest('לא ניתן להשבית את החשבון שלך');
  D.run(
    'UPDATE users SET full_name = ?, email = ?, role = ?, department = ?, status = ? WHERE id = ?',
    b.name ?? user.full_name, (b.email ?? user.email).toLowerCase(), b.role ?? user.role,
    b.department ?? user.department, b.status ?? user.status, user.id
  );
  if (b.password) D.run('UPDATE users SET password_hash = ? WHERE id = ?', D.hashPassword(b.password), user.id);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// ניהול ספקים
// ---------------------------------------------------------------------------

router.post('/api/vendors', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'assign_task_to_vendor');
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!name || !email) throw badRequest('נדרשים שם ספק ואימייל');
  if (D.get('SELECT 1 FROM vendors WHERE lower(email)=?', email) || D.get('SELECT 1 FROM users WHERE lower(email)=?', email)) {
    throw badRequest('כתובת האימייל כבר קיימת במערכת');
  }
  const r = D.run(
    'INSERT INTO vendors (name, contact_name, email, phone, password_hash, status, read_only, created_at) VALUES (?,?,?,?,?,?,?,?)',
    name, b.contactName ?? '', email, b.phone ?? '', D.hashPassword(b.password || '1234'),
    'active', b.readOnly ? 1 : 0, D.nowIso()
  );
  // כל ספק מקבל בורד ייעודי משלו — פרק 3
  D.createVendorBoard(Number(r.lastInsertRowid), name);
  sendJson(res, 201, { ok: true });
});

router.patch('/api/vendors/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'assign_task_to_vendor');
  const vendor = D.get('SELECT * FROM vendors WHERE id = ?', Number(ctx.params.id));
  if (!vendor) throw notFound();
  const b = await readJson(req);
  D.run(
    'UPDATE vendors SET name = ?, contact_name = ?, email = ?, phone = ?, status = ?, read_only = ? WHERE id = ?',
    b.name ?? vendor.name, b.contactName ?? vendor.contact_name,
    (b.email ?? vendor.email).toLowerCase(), b.phone ?? vendor.phone,
    b.status ?? vendor.status, b.readOnly !== undefined ? (b.readOnly ? 1 : 0) : vendor.read_only, vendor.id
  );
  if (b.password) D.run('UPDATE vendors SET password_hash = ? WHERE id = ?', D.hashPassword(b.password), vendor.id);
  if (b.name && b.name !== vendor.name) {
    D.run("UPDATE boards SET name = ? WHERE type='vendor' AND vendor_id = ?", `בורד ספק — ${b.name}`, vendor.id);
  }
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// הגדרות ומנוע כללים — מנהל מערכת בלבד
// ---------------------------------------------------------------------------

router.get('/api/admin/settings', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  let dbSizeKb = null;
  try {
    dbSizeKb = Math.round(fs.statSync(D.DB_PATH).size / 1024);
  } catch { /* עדיין לא נוצר */ }

  sendJson(res, 200, {
    settings: D.allSettings(),
    defaults: D.DEFAULT_SETTINGS,
    storage: {
      ...D.STORAGE,
      dbSizeKb,
      installedAt: D.getSetting('installed_at', null),
      bootCount: Number(D.getSetting('boot_count', 0))
    },
    rules: D.all('SELECT * FROM automation_rules ORDER BY id').map((r) => ({
      id: r.id, name: r.name, triggerKey: r.trigger_key, actionKey: r.action_key,
      params: JSON.parse(r.params), enabled: !!r.enabled, builtIn: !!r.built_in, lastRunAt: r.last_run_at
    })),
    catalog: Rules.catalog(),
    matrix: P.matrixForDisplay(),
    roles: P.ROLES,
    roleLabels: P.ROLE_LABELS
  });
});

router.put('/api/admin/settings', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  const b = await readJson(req);
  for (const [key, value] of Object.entries(b.settings ?? {})) {
    if (key in D.DEFAULT_SETTINGS) D.setSetting(key, value);
  }
  if (b.settings?.scheduler_interval_minutes) Rules.start();
  sendJson(res, 200, { settings: D.allSettings() });
});

router.post('/api/admin/rules', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  const b = await readJson(req);
  const cat = Rules.catalog();
  if (!cat.triggers.some((t) => t.key === b.triggerKey)) throw badRequest('טריגר לא מוכר');
  if (!cat.actions.some((a) => a.key === b.actionKey)) throw badRequest('פעולה לא מוכרת');
  D.run(
    'INSERT INTO automation_rules (name, trigger_key, params, action_key, enabled, built_in, created_at) VALUES (?,?,?,?,?,0,?)',
    String(b.name ?? 'כלל חדש').trim(), b.triggerKey, JSON.stringify(b.params ?? {}), b.actionKey,
    b.enabled === false ? 0 : 1, D.nowIso()
  );
  sendJson(res, 201, { ok: true });
});

router.patch('/api/admin/rules/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  const rule = D.get('SELECT * FROM automation_rules WHERE id = ?', Number(ctx.params.id));
  if (!rule) throw notFound();
  const b = await readJson(req);
  D.run(
    'UPDATE automation_rules SET name = ?, params = ?, enabled = ? WHERE id = ?',
    b.name ?? rule.name, JSON.stringify(b.params ?? JSON.parse(rule.params)),
    b.enabled === undefined ? rule.enabled : (b.enabled ? 1 : 0), rule.id
  );
  sendJson(res, 200, { ok: true });
});

router.delete('/api/admin/rules/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  const rule = D.get('SELECT * FROM automation_rules WHERE id = ?', Number(ctx.params.id));
  if (!rule) throw notFound();
  if (rule.built_in) throw badRequest('לא ניתן למחוק כלל מובנה — ניתן לכבות אותו');
  D.run('DELETE FROM automation_rules WHERE id = ?', rule.id);
  sendJson(res, 200, { ok: true });
});

router.post('/api/admin/rules/run', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  sendJson(res, 200, { summary: Rules.runOnce() });
});

// --- עמודות מותאמות אישית לבורד ---

router.post('/api/boards/:id/columns', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_automations');
  const board = D.get('SELECT * FROM boards WHERE id = ?', Number(ctx.params.id));
  if (!board) throw notFound();
  const b = await readJson(req);
  const label = String(b.label ?? '').trim();
  if (!label) throw badRequest('נדרשת כותרת לעמודה');
  const key = String(b.key ?? '').trim() || `col_${crypto.randomBytes(3).toString('hex')}`;
  const maxPos = D.get('SELECT COALESCE(MAX(position), -1) p FROM board_columns WHERE board_id = ?', board.id).p;
  const finalCol = D.get('SELECT position FROM board_columns WHERE board_id = ? AND is_final = 1', board.id);
  const position = finalCol ? finalCol.position : maxPos + 1;
  if (finalCol) D.run('UPDATE board_columns SET position = position + 1 WHERE board_id = ? AND position >= ?', board.id, position);
  D.run('INSERT INTO board_columns (board_id, key, label, position, is_final, color) VALUES (?,?,?,?,0,?)',
    board.id, key, label, position, b.color ?? '#8b5cf6');
  sendJson(res, 201, { columns: columnsOf(board.id) });
});

// --- מסננים שמורים ותבניות ---

router.post('/api/saved-filters', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  if (!name) throw badRequest('נדרש שם למסנן');
  D.run('INSERT INTO saved_filters (user_id, name, payload, created_at) VALUES (?,?,?,?)',
    actor.id, name, JSON.stringify(b.payload ?? {}), D.nowIso());
  sendJson(res, 201, {
    savedFilters: D.all('SELECT id, name, payload FROM saved_filters WHERE user_id = ? ORDER BY name', actor.id)
      .map((f) => ({ id: f.id, name: f.name, payload: JSON.parse(f.payload) }))
  });
});

router.delete('/api/saved-filters/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  D.run('DELETE FROM saved_filters WHERE id = ? AND user_id = ?', Number(ctx.params.id), actor.id);
  sendJson(res, 200, {
    savedFilters: D.all('SELECT id, name, payload FROM saved_filters WHERE user_id = ? ORDER BY name', actor.id)
      .map((f) => ({ id: f.id, name: f.name, payload: JSON.parse(f.payload) }))
  });
});

router.get('/api/templates', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  sendJson(res, 200, {
    templates: D.all('SELECT * FROM templates ORDER BY kind, name')
      .map((t) => ({ id: t.id, kind: t.kind, name: t.name, payload: JSON.parse(t.payload) }))
  });
});

router.post('/api/templates', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'create_project');
  const b = await readJson(req);
  if (!['task', 'project'].includes(b.kind)) throw badRequest('סוג תבנית לא תקין');
  D.run('INSERT INTO templates (kind, name, payload, created_at) VALUES (?,?,?,?)',
    b.kind, String(b.name ?? '').trim() || 'תבנית', JSON.stringify(b.payload ?? {}), D.nowIso());
  sendJson(res, 201, { ok: true });
});

router.delete('/api/templates/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'create_project');
  D.run('DELETE FROM templates WHERE id = ?', Number(ctx.params.id));
  sendJson(res, 200, { ok: true });
});

// --- חיפוש גלובלי (כולל ארכיון) — פרק 5.1 ---

router.get('/api/search', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const q = String(parseUrl(req).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return sendJson(res, 200, { tasks: [], projects: [] });

  const tasks = D.all(
    'SELECT * FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY archived, id DESC LIMIT 60',
    `%${q}%`, `%${q}%`
  ).filter((t) => canSeeTask(actor, t)).slice(0, 25).map((t) => shapeTask(t, actor));

  const projects = isVendor(actor)
    ? []
    : D.all('SELECT id, name FROM projects WHERE name LIKE ? LIMIT 10', `%${q}%`);

  sendJson(res, 200, { tasks, projects });
});

module.exports = { router, PRIORITIES, shapeTask, canSeeTask };
