'use strict';
/** כל נקודות הקצה של המערכת. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const D = require('./db');
const P = require('./permissions');
const Auth = require('./auth');
const Rules = require('./rules-engine');
const Google = require('./google-auth');
const Invites = require('./invites');
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

/** המחלקה של האחראי על המשימה — נדרש להכרעה על משימות ארגוניות */
function assigneeDepartmentId(task) {
  if (task.assignee_type !== 'user' || !task.assignee_id) return null;
  return D.get('SELECT department_id FROM users WHERE id = ?', task.assignee_id)?.department_id ?? null;
}

/** מה כל שחקן רשאי לראות — הבורדים נפרדים, וההיקף נקבע לפי התפקיד */
function canSeeTask(actor, task) {
  const board = boardOf(task);
  if (!board) return false;

  if (isVendor(actor)) {
    // ספק רואה אך ורק את הבורד שלו ואת המשימות שהוקצו לו
    return board.type === 'vendor' && board.vendor_id === actor.id && task.assignee_id === actor.id;
  }

  // הנהלה ומעלה רואים את כל הארגון
  if (P.isOrgWide(actor)) return true;

  if (actor.role === 'manager') {
    // מנהל מחלקה: משימות המחלקה שלו, ומשימות ארגוניות של אנשיה
    if (board.type === 'vendor') return P.may(actor, 'view_vendor_boards');
    return P.isInActorDepartment(actor, task, assigneeDepartmentId(task))
      || P.isTaskParticipant(actor, task, projectOf(task));
  }

  // עובד פנימי: רק בבורד הפנימי, ורק משימות שהוא חלק מהן
  if (board.type !== 'internal') return false;
  return P.isTaskParticipant(actor, task, projectOf(task));
}

/**
 * בדיקת הרשאה על משימה, עם המחלקה של האחראי — הכרחית להכרעה על משימות
 * ארגוניות. עוטף את P.canOnTask כדי שאף קורא לא ישכח את הפרמטר הזה.
 */
function mayOnTask(actor, action, task, project = null) {
  return P.canOnTask(actor, action, task, project, assigneeDepartmentId(task));
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
    level: task.level ?? 'department',
    levelLabel: (task.level ?? 'department') === 'organization' ? 'ארגונית' : 'מחלקתית',
    departmentId: task.department_id ?? null,
    departmentName: task.department_id
      ? D.get('SELECT name FROM departments WHERE id = ?', task.department_id)?.name ?? null
      : null,
    // רמזי הרשאה ברמת המשימה — מאפשרים לטבלה להציג עריכה במקום רק למי שרשאי
    canEdit: mayOnTask(actor, 'edit_delete_task', task, project),
    canChangeStatus: mayOnTask(actor, 'change_task_status', task, project)
      && !(isVendor(actor) && actor.readOnly),
    attachmentsCount: D.get('SELECT COUNT(*) c FROM attachments WHERE task_id = ?', task.id).c,
    // מספר הקבצים השונים (ולא הגרסאות) — לחישוב "+N" מדויק בשורת המשימה
    filesCount: D.get('SELECT COUNT(DISTINCT filename) c FROM attachments WHERE task_id = ?', task.id).c,
    // הגרסה האחרונה של כל קובץ — כדי שהקובץ יוצג בשורת המשימה עצמה ולא רק במקום נפרד
    attachments: D.all(
      `SELECT id, filename, mime, size, version FROM attachments a
        WHERE task_id = ? AND version = (SELECT MAX(version) FROM attachments WHERE task_id = a.task_id AND filename = a.filename)
        ORDER BY created_at DESC LIMIT 4`, task.id
    ).map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, version: a.version })),
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
          : 'המערכת',
    // הקבצים שצורפו להודעה הזו — מוצגים בתוכה ולא רק ברשימת הקבצים הכללית
    attachments: D.all(
      'SELECT id, filename, size, mime, version FROM attachments WHERE comment_id = ? ORDER BY id', c.id
    )
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
      edit: mayOnTask(actor, 'edit_delete_task', task, project),
      changeStatus: mayOnTask(actor, 'change_task_status', task, project) && !(isVendor(actor) && actor.readOnly),
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

// זמין גם לפני התחברות — מסך הכניסה מציג את הלוגו ואת אמצעי הכניסה
router.get('/api/branding', async (req, res) => {
  sendJson(res, 200, { companyLogo: findCompanyLogo(), googleLogin: Google.isEnabled() });
});

// ---------------------------------------------------------------------------
// כניסה עם Google
// ---------------------------------------------------------------------------

const redirectTo = (res, location) => {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
};

router.get('/api/auth/google/start', async (req, res) => {
  if (!Google.isEnabled()) throw badRequest('כניסה עם Google אינה מוגדרת במערכת');
  redirectTo(res, Google.authorizeUrl(req));
});

router.get('/api/auth/google/callback', async (req, res) => {
  const params = parseUrl(req).searchParams;
  const fail = (message) => redirectTo(res, `/?googleError=${encodeURIComponent(message)}`);

  if (!Google.isEnabled()) return fail('כניסה עם Google אינה מוגדרת במערכת');
  if (params.get('error')) return fail('הכניסה בוטלה');

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return fail('חסרים פרטים בחזרה מ-Google');
  // מונע זיוף בקשה: המצב חייב להיות כזה שהמערכת עצמה יצרה ולא נוצל עדיין
  if (!Google.consumeState(state)) return fail('הבקשה פגה או אינה תקינה. נסה להתחבר שוב.');

  try {
    const profile = await Google.exchangeCodeForProfile(code, req);
    const match = Google.matchAccount(profile);
    const actor = Auth.loadActor(match.actorType, match.id);
    if (!actor) return fail('החשבון אינו פעיל במערכת');

    const { token, expires } = Auth.createSession(match.actorType, match.id);
    res.writeHead(302, {
      location: '/',
      'set-cookie': Auth.cookieHeader(token, expires, req),
      'cache-control': 'no-store'
    });
    res.end();
  } catch (err) {
    console.error('[משימון] כניסה עם Google נכשלה:', err.message);
    fail(err.message);
  }
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
    departmentId: actor.departmentId ?? null,
    boardId: actor.boardId ?? null,
    readOnly: !!actor.readOnly
  };
}

// ---------------------------------------------------------------------------
// מימוש הזמנה — פתוח ללא התחברות, מוגן באמצעות האסימון שבקישור
// ---------------------------------------------------------------------------

router.get('/api/invite/:token', async (req, res, ctx) => {
  const found = Invites.find(ctx.params.token);
  if (found.error) return sendJson(res, 200, { valid: false, error: found.error });

  sendJson(res, 200, {
    valid: true,
    name: found.account.name,
    email: found.account.email,
    isVendor: found.invite.target_type === 'vendor',
    inviter: found.inviter,
    orgName: D.getSetting('org_name', ''),
    expiresAt: found.invite.expires_at
  });
});

router.post('/api/invite/:token', async (req, res, ctx) => {
  const { password } = await readJson(req);
  const clean = String(password ?? '');
  if (clean.length < 8) throw badRequest('הסיסמה חייבת להכיל לפחות 8 תווים');

  const result = Invites.redeem(ctx.params.token, clean);
  if (result.error) throw badRequest(result.error);

  const actor = Auth.loadActor(result.actorType, result.id);
  if (!actor) throw badRequest('החשבון אינו פעיל');

  const { token, expires } = Auth.createSession(result.actorType, result.id);
  res.setHeader('set-cookie', Auth.cookieHeader(token, expires, req));
  sendJson(res, 200, { actor: publicActor(actor), permissions: P.permissionsFor(actor) });
});

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
      orgName: D.getSetting('org_name', 'MESIMON'),
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
  const pinned = new Set(
    actor.type === 'user'
      ? D.all('SELECT project_id FROM project_pins WHERE user_id = ?', actor.id).map((r) => r.project_id)
      : []
  );
  const rows = D.all('SELECT * FROM projects ORDER BY status, name');
  const shaped = rows.map((p) => {
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
      tasksDone: stats.done ?? 0,
      pinned: pinned.has(p.id)
    };
  });

  // נעוצים ראשונים, ובתוך כל קבוצה הסדר המקורי נשמר
  return [...shaped.filter((p) => p.pinned), ...shaped.filter((p) => !p.pinned)];
}

router.post('/api/projects/:id/pin', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  const project = D.get('SELECT id FROM projects WHERE id = ?', Number(ctx.params.id));
  if (!project) throw notFound('הפרויקט לא נמצא');
  D.run('INSERT OR IGNORE INTO project_pins (user_id, project_id, created_at) VALUES (?,?,?)',
    actor.id, project.id, D.nowIso());
  sendJson(res, 200, { pinned: true });
});

router.delete('/api/projects/:id/pin', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  D.run('DELETE FROM project_pins WHERE user_id = ? AND project_id = ?', actor.id, Number(ctx.params.id));
  sendJson(res, 200, { pinned: false });
});

// ---------------------------------------------------------------------------
// משימות
// ---------------------------------------------------------------------------

router.get('/api/tasks', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const q = parseUrl(req).searchParams;

  const where = ['1=1'];
  const params = [];

  // הפרדת הבורדים — הבורד הפנימי ובורדי הספקים אינם נחשפים זה לזה
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
    } else if (actor.role === 'manager' && scope !== 'vendors') {
      // מנהל מחלקה: המחלקה שלו, משימות ארגוניות של אנשיה, ומה שהוא עצמו חלק ממנו
      where.push(`(
        t.department_id = ?
        OR (t.level = 'organization' AND t.assignee_type = 'user'
            AND t.assignee_id IN (SELECT id FROM users WHERE department_id = ?))
        OR (t.assignee_type = 'user' AND t.assignee_id = ?)
        OR t.created_by = ?
        OR p.manager_id = ?
      )`);
      params.push(actor.departmentId, actor.departmentId, actor.id, actor.id, actor.id);
    }

    // סינון לפי רמת המשימה — הדשבורד מפריד בין מחלקתי לארגוני
    const taskLevel = q.get('level');
    if (taskLevel === 'department' || taskLevel === 'organization') {
      where.push('t.level = ?');
      params.push(taskLevel);
    }

    // חתך מחלקתי — למי שרואה יותר ממחלקה אחת
    const deptFilter = q.get('departmentId');
    if (deptFilter && P.isOrgWide(actor)) {
      where.push(`(t.department_id = ? OR (t.assignee_type = 'user'
        AND t.assignee_id IN (SELECT id FROM users WHERE department_id = ?)))`);
      params.push(Number(deptFilter), Number(deptFilter));
    }
  }

  const archived = q.get('archived') === '1';
  where.push(archived ? 't.archived = 1' : 't.archived = 0');

  // משימות עתידיות מתוזמנות אינן מופיעות ברשימות הפעילות
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

  // הקצאה לספק מחייבת הרשאה, ומעבירה את המשימה לבורד של אותו ספק
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

  // רמת המשימה: ארגונית מוטלת בידי הנהלה ומעלה, אחרת מחלקתית.
  // משימה מחלקתית משויכת למחלקת האחראי, ואם אין אחראי — למחלקת היוצר.
  const wantsOrgLevel = body.level === 'organization';
  if (wantsOrgLevel) requirePerm(actor, 'assign_org_wide_task');
  const taskLevel = wantsOrgLevel ? 'organization' : 'department';

  let taskDepartmentId = null;
  if (!wantsOrgLevel) {
    if (assigneeType === 'user' && assigneeId) {
      taskDepartmentId = D.get('SELECT department_id FROM users WHERE id = ?', assigneeId)?.department_id ?? null;
    }
    if (!taskDepartmentId && body.departmentId) taskDepartmentId = Number(body.departmentId);
    if (!taskDepartmentId && actor.type === 'user') taskDepartmentId = actor.departmentId ?? null;
    // מנהל מחלקה אינו יוצר משימות למחלקה אחרת
    if (isDeptManager(actor) && taskDepartmentId !== actor.departmentId) {
      taskDepartmentId = actor.departmentId ?? null;
    }
  }

  const res1 = D.run(
    `INSERT INTO tasks
      (title, description, project_id, board_id, assignee_type, assignee_id, status, priority,
       due_date, created_at, created_by, status_changed_at, activate_at, depends_on_task_id,
       is_recurring, recurrence_freq, recurrence_policy, level, department_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    body.recurrencePolicy ?? 'inherit',
    taskLevel,
    taskDepartmentId
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

  // שינוי סטטוס — מסלול נפרד עם כללי הזרימה בין הסטטוסים
  if (body.status !== undefined && body.status !== task.status) {
    if (!mayOnTask(actor, 'change_task_status', task, project)) throw forbidden('אין לך הרשאה לשנות את סטטוס המשימה');
    changeStatus(task, body.status, actor);
  }

  const editableByAll = new Set(['status']);
  const wantsMore = Object.keys(body).some((k) => !editableByAll.has(k));
  if (wantsMore) {
    if (isVendor(actor)) throw forbidden('ספק אינו רשאי לערוך את שדות המשימה');
    if (!mayOnTask(actor, 'edit_delete_task', task, project)) throw forbidden('אין לך הרשאה לערוך משימה זו');

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

    // רמת המשימה — מחלקתית או ארגונית
    if (body.level !== undefined && body.level !== (task.level ?? 'department')) {
      if (body.level !== 'department' && body.level !== 'organization') throw badRequest('רמת משימה לא תקינה');
      if (body.level === 'organization') requirePerm(actor, 'assign_org_wide_task');
      const nextDept = body.level === 'organization'
        ? null
        : (assigneeDepartmentId(task) ?? (actor.type === 'user' ? actor.departmentId : null));
      D.run('UPDATE tasks SET level = ?, department_id = ? WHERE id = ?', body.level, nextDept, task.id);
      changes.push(`רמת המשימה: ${body.level === 'organization' ? 'ארגונית' : 'מחלקתית'}`);
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
        // משימה מחלקתית עוברת עם האחראי למחלקה שלו
        if ((task.level ?? 'department') === 'department' && newType === 'user' && newId) {
          const dept = D.get('SELECT department_id FROM users WHERE id = ?', newId)?.department_id ?? null;
          D.run('UPDATE tasks SET department_id = ? WHERE id = ?', dept, task.id);
        }
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

/** מימוש חוקי המעבר בין הסטטוסים + בדיקת תלות */
function changeStatus(task, newStatus, actor, note = '') {
  const target = columnMeta(task.board_id, newStatus);
  if (!target) throw badRequest('סטטוס לא קיים בבורד זה');
  const current = columnMeta(task.board_id, task.status);

  // אזהרת תלות — לא ניתן לסגור משימה שתלויה במשימה שטרם הושלמה
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

/** פעולות אצווה */
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
        if (!mayOnTask(actor, 'change_task_status', task, project)) throw forbidden();
        changeStatus(task, value, actor);
      } else if (action === 'assignee') {
        if (!mayOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
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
        if (!mayOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
        D.run('UPDATE tasks SET priority = ? WHERE id = ?', value, task.id);
        D.audit(task.id, actorRef(actor), 'updated', `עדיפות שונתה ל-${PRIORITIES.find((p) => p.key === value)?.label}`);
      } else if (action === 'archive') {
        if (!mayOnTask(actor, 'edit_delete_task', task, project)) throw forbidden();
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
  if (!mayOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden('אין לך הרשאה למחוק משימה זו');
  D.run('DELETE FROM tasks WHERE id = ?', task.id);
  sendJson(res, 200, { ok: true });
});

// --- צ'קליסט ---

router.post('/api/tasks/:id/checklist', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor)) throw forbidden();
  if (!mayOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden();
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
  if (!mayOnTask(actor, 'change_task_status', task, projectOf(task))) throw forbidden();
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
  if (isVendor(actor) || !mayOnTask(actor, 'edit_delete_task', task, projectOf(task))) throw forbidden();
  D.run('DELETE FROM checklist_items WHERE id = ?', item.id);
  sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
});

// --- תגובות ---

router.post('/api/tasks/:id/comments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor) && actor.readOnly) throw forbidden('לחשבון שלך הוגדרה הרשאת צפייה בלבד');
  const { body, internal, files } = await readJson(req);
  const text = String(body ?? '').trim();
  const attached = Array.isArray(files) ? files.filter((f) => f && f.filename && f.data) : [];
  // הודעה עם קובץ בלבד היא שימוש לגיטימי — לא מחייבים טקסט כשיש מה לצרף
  if (!text && !attached.length) throw badRequest('נדרש תוכן לתגובה או קובץ מצורף');

  // הערה פנימית זמינה רק לצוות הפנימי
  const isInternal = !isVendor(actor) && !!internal;
  const result = D.run(
    'INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,?,?)',
    task.id, isVendor(actor) ? 'vendor' : 'user', actor.id, text, isInternal ? 1 : 0, D.nowIso()
  );
  const commentId = Number(result.lastInsertRowid);

  // הקבצים נשמרים אחרי התגובה כדי שיהיה להם מזהה להיקשר אליו.
  // כישלון באחד מהם לא משאיר תגובה בלי הסבר — השגיאה עולה למשתמש.
  const savedFiles = attached.map((f) => saveAttachment(task, actor, f, commentId));
  for (const f of savedFiles) {
    D.audit(task.id, actorRef(actor), 'attachment', `צורף קובץ "${f.name}" לתגובה (גרסה ${f.version})`);
  }

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

/**
 * שומר קובץ מצורף למשימה ומחזיר את מזהה הרשומה.
 * משותף להעלאה מלשונית הקבצים ולצירוף קובץ לתגובה בשיחה — כך המגבלות
 * (סוגי קבצים, גודל, ניהול גרסאות) נאכפות במקום אחד בלבד.
 */
function saveAttachment(task, actor, { filename, mime, data }, commentId = null) {
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

  // גרסאות היסטוריות — הקובץ הקודם נשמר ואינו נדרס
  const prev = D.get('SELECT MAX(version) v FROM attachments WHERE task_id = ? AND filename = ?', task.id, name);
  const version = (prev?.v ?? 0) + 1;

  const stored = `${task.id}_${crypto.randomBytes(8).toString('hex')}${path.extname(name)}`;
  fs.writeFileSync(path.join(D.UPLOADS_DIR, stored), buffer);

  const inserted = D.run(
    `INSERT INTO attachments (task_id, comment_id, filename, stored_name, version, size, mime, uploader_type, uploader_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    task.id, commentId, name, stored, version, buffer.length, mime || 'application/octet-stream',
    isVendor(actor) ? 'vendor' : 'user', actor.id, D.nowIso()
  );
  return { id: Number(inserted.lastInsertRowid), name, version };
}

router.post('/api/tasks/:id/attachments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const task = getTaskOr404(ctx.params.id);
  assertVisible(actor, task);
  if (isVendor(actor) && actor.readOnly) throw forbidden('לחשבון שלך הוגדרה הרשאת צפייה בלבד');

  const payload = await readJson(req);
  const { name, version } = saveAttachment(task, actor, payload);
  D.audit(task.id, actorRef(actor), 'attachment', `הועלה קובץ "${name}" (גרסה ${version})`);

  // העלאת תוצרים מקדמת את הסטטוס אוטומטית
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

  // יצירה מתבנית
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
// דף הבית
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
  }).slice(0, 60).map((row) => ({
    id: row.id, action: row.action, details: row.details,
    actorName: row.actor_name || 'המערכת',
    // הממשק מבדיל חזותית בין עדכון של אדם לעדכון של המערכת
    actorType: row.actor_type ?? 'system',
    taskId: row.task_id,
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
// דוחות
// ---------------------------------------------------------------------------

router.get('/api/reports', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'view_reports');

  // מנהל מחלקה מקבל את חתך המחלקה שלו בלבד. האכיפה כאן ולא בתצוגה —
  // סינון בצד הלקוח היה מסתיר נתונים שכבר נשלחו אליו.
  const scoped = !P.isOrgWide(actor);
  const scopeId = scoped ? (actor.departmentId ?? null) : null;

  const workload = D.all(
    scoped
      ? `SELECT id, full_name, department, department_id, role
         FROM users WHERE status='active' AND department_id IS ? ORDER BY full_name`
      : `SELECT id, full_name, department, department_id, role
         FROM users WHERE status='active' ORDER BY full_name`,
    ...(scoped ? [scopeId] : [])
  ).map((u) => {
    const rows = D.all(
      `SELECT t.*, c.is_final FROM tasks t
         LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.assignee_type='user' AND t.assignee_id = ? AND t.archived = 0`, u.id
    );
    const open = rows.filter((r) => !r.is_final);
    return {
      id: u.id, name: u.full_name, role: u.role, roleLabel: P.ROLE_LABELS[u.role],
      departmentId: u.department_id,
      department: String(u.department ?? '').trim() || 'ללא שיוך',
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

  // חתך מחלקתי — תמונת הארגון לפי מחלקות
  const byDept = new Map();
  const bucket = (id, name) => {
    const key = id ?? 'none';
    if (!byDept.has(key)) {
      byDept.set(key, { id: id ?? null, name, people: 0, open: 0, overdue: 0, urgent: 0, done: 0, orgTasks: 0 });
    }
    return byDept.get(key);
  };
  for (const d of D.all("SELECT id, name FROM departments WHERE status = 'active' ORDER BY name")) {
    bucket(d.id, d.name);
  }
  for (const row of workload) {
    const entry = bucket(row.departmentId, row.department);
    entry.people++;
    entry.open += row.open;
    entry.overdue += row.overdue;
    entry.urgent += row.urgent;
    entry.done += row.done;
  }
  // משימות ארגוניות נספרות לפי המחלקה של האחראי עליהן
  for (const row of D.all(`SELECT u.department_id AS did, COUNT(*) AS c
                           FROM tasks t JOIN users u ON u.id = t.assignee_id
                           WHERE t.level = 'organization' AND t.assignee_type = 'user' AND t.archived = 0
                           GROUP BY u.department_id`)) {
    const entry = byDept.get(row.did ?? 'none');
    if (entry) entry.orgTasks = row.c;
  }
  const departments = [...byDept.values()]
    .filter((d) => d.people > 0 || d.id !== null)
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, 'he'));

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
       LEFT JOIN users u ON u.id = t.assignee_id AND t.assignee_type = 'user'
      WHERE t.archived = 0
        AND (? IS NULL OR t.department_id IS ? OR u.department_id IS ?)
      GROUP BY b.type, c.key ORDER BY b.type, c.position`,
    scoped ? 1 : null, scopeId, scopeId
  );

  sendJson(res, 200, {
    workload,
    departments,
    vendors,
    projects,
    statusBreakdown,
    scope: scoped ? 'department' : 'organization',
    departmentId: scopeId,
    departmentName: scoped ? (actor.department || 'ללא שיוך') : null
  });
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

// ---------------------------------------------------------------------------
// מחלקות
// ---------------------------------------------------------------------------

const shapeDepartment = (d) => ({
  id: d.id,
  name: d.name,
  status: d.status,
  managerUserId: d.manager_user_id,
  managerName: d.manager_user_id
    ? D.get('SELECT full_name FROM users WHERE id = ?', d.manager_user_id)?.full_name ?? null
    : null,
  peopleCount: D.get('SELECT COUNT(*) c FROM users WHERE department_id = ? AND status = ?', d.id, 'active').c
});

/** רשימת המחלקות — נדרשת לכל מי שממלא טופס משתמש או מסנן לפי מחלקה */
router.get('/api/departments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  if (isVendor(actor)) throw forbidden();
  // includeInactive=1 נדרש למסך ניהול המחלקות; טפסי שיוך מקבלים פעילות בלבד
  const all = parseUrl(req).searchParams.get('includeInactive') === '1';
  const rows = all
    ? D.all('SELECT * FROM departments ORDER BY name')
    : D.all("SELECT * FROM departments WHERE status = 'active' ORDER BY name");
  sendJson(res, 200, { departments: rows.map(shapeDepartment) });
});

router.post('/api/departments', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_departments');
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  if (!name) throw badRequest('נדרש שם מחלקה');
  if (D.get('SELECT 1 FROM departments WHERE name = ?', name)) throw badRequest('מחלקה בשם זה כבר קיימת');

  const r = D.run('INSERT INTO departments (name, created_at) VALUES (?,?)', name, D.nowIso());
  const id = Number(r.lastInsertRowid);
  if (b.managerUserId) setDepartmentManager(id, Number(b.managerUserId));

  sendJson(res, 201, { department: shapeDepartment(D.get('SELECT * FROM departments WHERE id = ?', id)) });
});

router.patch('/api/departments/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_departments');
  const dept = D.get('SELECT * FROM departments WHERE id = ?', Number(ctx.params.id));
  if (!dept) throw notFound('המחלקה לא נמצאה');
  const b = await readJson(req);

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw badRequest('נדרש שם מחלקה');
    const clash = D.get('SELECT 1 FROM departments WHERE name = ? AND id <> ?', name, dept.id);
    if (clash) throw badRequest('מחלקה בשם זה כבר קיימת');
    D.run('UPDATE departments SET name = ? WHERE id = ?', name, dept.id);
    // המחלקה נשמרת גם כטקסט על המשתמש, לתצוגה ולייצוא
    D.run('UPDATE users SET department = ? WHERE department_id = ?', name, dept.id);
  }
  if (b.status !== undefined) {
    if (!['active', 'inactive'].includes(b.status)) throw badRequest('סטטוס לא תקין');
    D.run('UPDATE departments SET status = ? WHERE id = ?', b.status, dept.id);
  }
  if (b.managerUserId !== undefined) {
    setDepartmentManager(dept.id, b.managerUserId ? Number(b.managerUserId) : null);
  }

  sendJson(res, 200, { department: shapeDepartment(D.get('SELECT * FROM departments WHERE id = ?', dept.id)) });
});

router.delete('/api/departments/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_departments');
  const dept = D.get('SELECT * FROM departments WHERE id = ?', Number(ctx.params.id));
  if (!dept) throw notFound('המחלקה לא נמצאה');

  const people = D.get('SELECT COUNT(*) c FROM users WHERE department_id = ?', dept.id).c;
  if (people > 0) throw badRequest(`למחלקה משויכים ${people} משתמשים. יש להעביר אותם למחלקה אחרת קודם.`);

  D.run('DELETE FROM departments WHERE id = ?', dept.id);
  sendJson(res, 200, { ok: true });
});

/** קובע את מנהל המחלקה, ומשייך אותו אליה כמנהל מחלקה */
function setDepartmentManager(departmentId, userId) {
  if (userId === null) {
    D.run('UPDATE departments SET manager_user_id = NULL WHERE id = ?', departmentId);
    return;
  }
  const user = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw badRequest('המשתמש שנבחר כמנהל אינו קיים');

  const name = D.get('SELECT name FROM departments WHERE id = ?', departmentId).name;
  D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', userId, departmentId);
  D.run('UPDATE users SET department_id = ?, department = ? WHERE id = ?', departmentId, name, userId);
}

/**
 * מנהל מערכת מנהל את כל המשתמשים.
 * מנהל מחלקה מנהל אך ורק עובדים פנימיים במחלקה שלו — לא מנהלים אחרים,
 * לא משתמשים ממחלקה אחרת, ואינו יכול להעניק רמת גישה גבוהה משלו.
 */
const isDeptManager = (actor) => actor.type === 'user' && actor.role === 'manager';

/** האם actor רשאי לנהל את המשתמש הקיים target */
function assertMayManageUser(actor, target) {
  if (!P.mayManageRole(actor, target.role)) {
    throw forbidden(`אין לך הרשאה לנהל חשבון ברמת ${P.ROLE_LABELS[target.role] ?? target.role}`);
  }
  if (isDeptManager(actor) && (target.department_id ?? null) !== (actor.departmentId ?? null)) {
    throw forbidden('מנהל מחלקה רשאי לנהל משתמשים במחלקה שלו בלבד');
  }
}

/** מתרגם קלט מחלקה — מזהה קיים או שם חדש — למזהה מחלקה */
function resolveDepartment(actor, body) {
  if (body.newDepartmentName) {
    requirePerm(actor, 'manage_departments');
    const name = String(body.newDepartmentName).trim();
    if (!name) throw badRequest('נדרש שם למחלקה החדשה');
    const existing = D.get('SELECT id FROM departments WHERE name = ?', name);
    if (existing) return existing.id;
    return Number(D.run('INSERT INTO departments (name, created_at) VALUES (?,?)', name, D.nowIso()).lastInsertRowid);
  }
  if (body.departmentId) {
    const id = Number(body.departmentId);
    const dept = D.get('SELECT status FROM departments WHERE id = ?', id);
    if (!dept) throw badRequest('המחלקה שנבחרה אינה קיימת');
    if (dept.status !== 'active') throw badRequest('לא ניתן לשייך משתמש למחלקה מושבתת');
    return id;
  }
  return null;
}

const departmentName = (id) => (id ? D.get('SELECT name FROM departments WHERE id = ?', id)?.name ?? '' : '');

router.get('/api/admin/users', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_users');

  const rows = P.isOrgWide(actor)
    ? D.all('SELECT id, full_name, email, role, department, department_id, status FROM users ORDER BY full_name')
    : D.all(`SELECT id, full_name, email, role, department, department_id, status FROM users
             WHERE department_id IS ? AND role = 'employee' ORDER BY full_name`, actor.departmentId);

  const departments = D.all("SELECT * FROM departments WHERE status = 'active' ORDER BY name").map(shapeDepartment);

  sendJson(res, 200, {
    scope: P.isOrgWide(actor) ? 'all' : 'department',
    department: actor.department,
    departmentId: actor.departmentId,
    departments,
    assignableRoles: P.assignableRoles(actor).map((role) => ({ value: role, label: P.ROLE_LABELS[role] })),
    mayManageDepartments: P.may(actor, 'manage_departments'),
    users: rows.map((u) => ({
      id: u.id, name: u.full_name, email: u.email, role: u.role,
      roleLabel: P.ROLE_LABELS[u.role], department: u.department,
      departmentId: u.department_id, status: u.status
    }))
  });
});

router.post('/api/admin/users', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_users');
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!name || !email) throw badRequest('נדרשים שם ואימייל');
  if (D.get('SELECT 1 FROM users WHERE lower(email)=?', email) || D.get('SELECT 1 FROM vendors WHERE lower(email)=?', email)) {
    throw badRequest('כתובת האימייל כבר קיימת במערכת');
  }
  if (!P.INTERNAL_ROLES.includes(b.role)) throw badRequest('רמת גישה לא תקינה');
  if (!P.mayManageRole(actor, b.role)) {
    throw forbidden(`אין לך הרשאה להעניק רמת גישה ${P.ROLE_LABELS[b.role]}`);
  }

  // מנהל מחלקה — רק במחלקה שלו. נכפה ולא רק נבדק.
  let departmentId = isDeptManager(actor) ? actor.departmentId : resolveDepartment(actor, b);

  // מנהל מחלקה חייב מחלקה: או קיימת שנבחרה, או חדשה שהוא יהיה המנהל שלה
  if (b.role === 'manager' && !departmentId) {
    throw badRequest('משתמש ברמת מנהל מחלקה חייב להיות משויך למחלקה. יש לבחור מחלקה קיימת או להגדיר מחלקה חדשה.');
  }

  // בלי סיסמה מפורשת נקבעת סיסמה אקראית שאיש אינו יודע —
  // הכניסה נעשית דרך קישור ההזמנה, שבו המשתמש קובע סיסמה בעצמו
  const password = b.password || crypto.randomBytes(24).toString('base64url');
  const result = D.run(
    'INSERT INTO users (full_name, email, password_hash, role, department, status, created_at) VALUES (?,?,?,?,?,?,?)',
    name, email, D.hashPassword(password), b.role, departmentName(departmentId), 'active', D.nowIso()
  );
  const newUserId = Number(result.lastInsertRowid);
  D.run('UPDATE users SET department_id = ? WHERE id = ?', departmentId, newUserId);

  // מנהל מחלקה נרשם כמנהל של אותה מחלקה
  if (b.role === 'manager' && departmentId) {
    D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', newUserId, departmentId);
  }

  const invite = b.invite === false ? null : await Invites.createAndSend({
    targetType: 'user',
    targetId: newUserId,
    email,
    recipientName: name,
    inviter: { id: actor.id, name: actor.name, email: actor.email },
    baseUrl: Google.publicBase(req)
  });

  sendJson(res, 201, { ok: true, invite });
});

/** שליחה חוזרת של הזמנה למשתמש או לספק קיים */
router.post('/api/admin/invite', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  const b = await readJson(req);
  const targetType = b.targetType === 'vendor' ? 'vendor' : 'user';

  if (targetType === 'user') requireFullPerm(actor, 'manage_users');
  else requirePerm(actor, 'assign_task_to_vendor');

  const account = targetType === 'user'
    ? D.get('SELECT id, full_name AS name, email FROM users WHERE id = ?', Number(b.id))
    : D.get('SELECT id, name, email FROM vendors WHERE id = ?', Number(b.id));
  if (!account) throw notFound('החשבון לא נמצא');

  const invite = await Invites.createAndSend({
    targetType,
    targetId: account.id,
    email: account.email,
    recipientName: account.name,
    inviter: { id: actor.id, name: actor.name, email: actor.email },
    baseUrl: Google.publicBase(req)
  });

  sendJson(res, 200, { invite });
});

router.patch('/api/admin/users/:id', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requirePerm(actor, 'manage_users');
  const user = D.get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
  if (!user) throw notFound();
  const b = await readJson(req);
  if (b.role && !P.INTERNAL_ROLES.includes(b.role)) throw badRequest('רמת גישה לא תקינה');
  if (user.id === actor.id && b.status === 'inactive') throw badRequest('לא ניתן להשבית את החשבון שלך');

  assertMayManageUser(actor, user);
  if (b.role && b.role !== user.role && !P.mayManageRole(actor, b.role)) {
    throw forbidden(`אין לך הרשאה להעניק רמת גישה ${P.ROLE_LABELS[b.role]}`);
  }

  // מנהל מחלקה אינו משנה תפקיד ואינו מעביר בין מחלקות
  let targetDepartmentId = isDeptManager(actor)
    ? actor.departmentId
    : (b.departmentId !== undefined || b.newDepartmentName ? resolveDepartment(actor, b) : user.department_id);
  if (isDeptManager(actor)) b.role = 'employee';

  const nextRole = b.role ?? user.role;
  if (nextRole === 'manager' && !targetDepartmentId) {
    throw badRequest('משתמש ברמת מנהל מחלקה חייב להיות משויך למחלקה.');
  }
  D.run(
    'UPDATE users SET full_name = ?, email = ?, role = ?, department = ?, department_id = ?, status = ? WHERE id = ?',
    b.name ?? user.full_name, (b.email ?? user.email).toLowerCase(), nextRole,
    departmentName(targetDepartmentId), targetDepartmentId, b.status ?? user.status, user.id
  );

  // שינוי תפקיד לניהול מחלקה רושם אותו כמנהל שלה; ירידה מהתפקיד משחררת
  if (nextRole === 'manager' && targetDepartmentId) {
    D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', user.id, targetDepartmentId);
  } else if (user.role === 'manager' && nextRole !== 'manager') {
    D.run('UPDATE departments SET manager_user_id = NULL WHERE manager_user_id = ?', user.id);
  }
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
  const password = b.password || crypto.randomBytes(24).toString('base64url');
  const r = D.run(
    'INSERT INTO vendors (name, contact_name, email, phone, password_hash, status, read_only, created_at) VALUES (?,?,?,?,?,?,?,?)',
    name, b.contactName ?? '', email, b.phone ?? '', D.hashPassword(password),
    'active', b.readOnly ? 1 : 0, D.nowIso()
  );
  const vendorId = Number(r.lastInsertRowid);
  // כל ספק מקבל בורד ייעודי משלו
  D.createVendorBoard(vendorId, name);

  const invite = b.invite === false ? null : await Invites.createAndSend({
    targetType: 'vendor',
    targetId: vendorId,
    email,
    recipientName: b.contactName || name,
    inviter: { id: actor.id, name: actor.name, email: actor.email },
    baseUrl: Google.publicBase(req)
  });

  sendJson(res, 201, { ok: true, invite });
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
    if (!(key in D.DEFAULT_SETTINGS)) continue;
    // כתובת המערכת נכנסת לקישורי ההזמנות — סלאש עודף או כתובת בלי סכימה
    // היו מייצרים קישור שבור אצל הנמען
    if (key === 'public_url') {
      const clean = String(value ?? '').trim().replace(/\/+$/, '');
      if (clean && !/^https?:\/\/[^\s/]+/.test(clean)) {
        throw badRequest('כתובת המערכת חייבת להתחיל ב-https:// או ב-http://');
      }
      D.setSetting(key, clean);
      continue;
    }
    D.setSetting(key, value);
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

/**
 * אתחול תוכן המערכת — מוחק את כל המשימות, הפרויקטים, הספקים והמשתמשים
 * למעט המשתמש המבצע. ההגדרות וכללי האוטומציה נשמרים.
 * מיועד לניקוי נתוני ההדגמה לפני תחילת עבודה אמיתית.
 */
router.post('/api/admin/wipe', async (req, res, ctx) => {
  const actor = ctx.requireActor();
  requireFullPerm(actor, 'manage_users');
  const { confirm } = await readJson(req);
  if (String(confirm ?? '').trim() !== 'אתחול') {
    throw badRequest('נדרש אישור מפורש כדי לאתחל את המערכת');
  }

  const before = {
    tasks: D.get('SELECT COUNT(*) c FROM tasks').c,
    projects: D.get('SELECT COUNT(*) c FROM projects').c,
    vendors: D.get('SELECT COUNT(*) c FROM vendors').c,
    users: D.get('SELECT COUNT(*) c FROM users').c
  };

  // מחיקת הקבצים מהדיסק — מחיקת השורות לבדה משאירה אותם יתומים
  for (const att of D.all('SELECT stored_name FROM attachments')) {
    try {
      fs.rmSync(path.join(D.UPLOADS_DIR, att.stored_name), { force: true });
    } catch { /* הקובץ כבר אינו קיים */ }
  }

  // סדר המחיקה: המשימות תחילה, כדי שהמחיקה המדורגת תשחרר את לוג הבקרה
  D.run('DELETE FROM tasks');
  D.run('DELETE FROM audit_log');
  D.run('DELETE FROM notifications');
  D.run('DELETE FROM projects');
  D.run('DELETE FROM vendors');          // גורר גם את בורדי הספקים
  D.run('DELETE FROM templates');
  D.run('DELETE FROM saved_filters');
  D.run('DELETE FROM users WHERE id != ?', actor.id);
  D.run("DELETE FROM sessions WHERE NOT (actor_type = 'user' AND actor_id = ?)", actor.id);

  D.audit(null, actorRef(actor), 'system_wipe',
    `אותחל תוכן המערכת: ${before.tasks} משימות, ${before.projects} פרויקטים, ${before.vendors} ספקים, ${before.users - 1} משתמשים`);

  sendJson(res, 200, { ok: true, removed: { ...before, users: before.users - 1 } });
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

// --- חיפוש גלובלי (כולל ארכיון) ---

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
