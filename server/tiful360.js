'use strict';
/**
 * חיבור לתפעול 360: קריאת שירות שנפתחה שם הופכת כאן למשימה, וכשהמשימה
 * מסתיימת — הקריאה נסגרת שם, ומי שפתח אותה מקבל דואר מתפעול 360.
 *
 * זהו חיבור שרת-לשרת, בלי עוגיית התחברות: תפעול 360 מזדהה במפתח משותף
 * (‎TIFUL360_INBOUND_KEY‎), והמשימה נוצרת דרך ‎createTask‎ הרגיל — בשם משתמש
 * מערכת מוגדר — כדי שלא תעקוף אף בדיקה שחלה על משימה רגילה.
 *
 * משתני סביבה:
 *   TIFUL360_INBOUND_KEY      — המפתח שתפעול 360 שולח. בלעדיו החיבור כבוי
 *   TIFUL360_API_URL          — כתובת פונקציית ‎it-api‎ של תפעול 360 (לסגירת הקריאה)
 *   TIFUL360_API_KEY          — מפתח API שהונפק בתפעול 360 עבור משימון
 *   TIFUL360_ACTOR_EMAIL      — בשם מי נוצרות המשימות. ברירת מחדל: מנהל המחלקה
 *   TIFUL360_DEPARTMENT       — שם המחלקה. ברירת מחדל: תפעול
 *   TIFUL360_PROJECT          — פרויקט לקריאה שאין לה נושא. ברירת מחדל: משרד שוטף
 */
const crypto = require('node:crypto');
const path = require('node:path');
const P = require('./permissions');
const D = require('./db');
const Auth = require('./auth');
const { badRequest, unauthorized, readJson, sendJson } = require('./http-kit');

const SOURCE = 'tiful360';

const env = (key, fallback = '') => String(process.env[key] ?? '').trim() || fallback;
const departmentName = () => env('TIFUL360_DEPARTMENT', 'תפעול');
// לכל נושא קריאה פרויקט משלו, בשם הנושא: "מיחשוב", "פריוריטי", "ריהוט משרדי"...
const projectName = (subjectLabel) => clean(subjectLabel, 100) || env('TIFUL360_PROJECT', 'משרד שוטף');

// דחוף בתפעול 360 הוא דחוף כאן; כל השאר — רגיל
const PRIORITY_MAP = { critical: 'urgent', high: 'high', medium: 'normal', low: 'low' };

/**
 * אימות המפתח. השוואה בזמן קבוע, ומגבלת ניסיונות כמו במסך הכניסה — המפתח
 * הוא בפועל סיסמה של שרת, וניחוש שלו פותח יצירת משימות בשם המערכת.
 */
function authenticate(req) {
  const expected = env('TIFUL360_INBOUND_KEY');
  if (!expected) throw unauthorized('החיבור לתפעול 360 אינו מוגדר');
  Auth.checkLoginRate(req);
  const header = String(req.headers.authorization ?? '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) {
    Auth.noteFailedLogin(req);
    throw unauthorized('מפתח חיבור שגוי');
  }
}

function department() {
  const name = departmentName();
  const dept = D.get("SELECT * FROM departments WHERE name = ? AND status = 'active'", name);
  if (!dept) throw badRequest(`לא נמצאה במשימון מחלקה פעילה בשם "${name}"`);
  return dept;
}

/**
 * בשם מי נוצרת המשימה: המשתמש שהוגדר, אחרת מנהל המחלקה, אחרת מנהל המערכת
 * הראשון. מי שפתח את הקריאה בתפעול 360 נרשם בתיאור המשימה.
 */
function systemActor(dept) {
  const email = env('TIFUL360_ACTOR_EMAIL').toLowerCase();
  const candidates = [
    email && D.get("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", email),
    dept.manager_user_id && { id: dept.manager_user_id },
    D.get("SELECT id FROM users WHERE role IN ('superadmin','admin') AND status = 'active' ORDER BY id LIMIT 1")
  ];
  for (const c of candidates) {
    const actor = c && Auth.loadActor('user', c.id);
    if (actor) return actor;
  }
  throw badRequest('לא נמצא במשימון משתמש פעיל שבשמו תיווצר המשימה');
}

/**
 * הפרויקט לפי נושא הקריאה. נושא שעוד אין לו פרויקט — הפרויקט נוצר עם
 * הקריאה הראשונה שלו, והקריאות הבאות באותו נושא נכנסות אליו.
 */
function projectFor(subjectLabel, actor) {
  const name = projectName(subjectLabel);
  const existing = D.get(
    "SELECT id FROM projects WHERE name = ? AND status != 'done' ORDER BY status = 'active' DESC, id LIMIT 1", name);
  if (existing) return existing.id;
  const res = D.run('INSERT INTO projects (name, created_at, created_by, manager_id) VALUES (?,?,?,?)',
    name, D.nowIso(), actor.id, actor.id);
  return Number(res.lastInsertRowid);
}

const clean = (v, max = 4000) => String(v ?? '').trim().slice(0, max);

function buildDescription(b) {
  const lines = [
    `קריאת שירות ${clean(b.ticketCode, 50)} מתפעול 360`,
    b.subjectLabel && `סוג פנייה: ${clean(b.subjectLabel, 100)}`,
    b.employeeName && `נפתחה ע"י: ${clean(b.employeeName, 200)}`,
    b.location && `מיקום: ${clean(b.location, 200)}`,
    b.contactPhone && `טלפון: ${clean(b.contactPhone, 50)}`,
    b.openedBy && `הועברה למשימון ע"י: ${clean(b.openedBy, 200)}`,
    b.ticketUrl && `קישור לקריאה: ${clean(b.ticketUrl, 500)}`
  ].filter(Boolean);
  const description = clean(b.description);
  const note = clean(b.note, 2000);
  if (description) lines.push('', description);
  if (note) lines.push('', `הערה: ${note}`);
  return lines.join('\n');
}

const taskLink = (id) => {
  const root = String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return root ? `${root}/?task=${id}` : null;
};

const MAX_FILES = 5;

/**
 * בדיקת הקבצים לפני יצירת המשימה, באותם כללים של העלאה רגילה (סוג וגודל) —
 * כדי שקובץ פסול לא ישאיר משימה חצי-שמורה בלי הקבצים שלה.
 */
function checkFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw badRequest('רשימת הקבצים אינה תקינה');
  if (files.length > MAX_FILES) throw badRequest(`ניתן לצרף עד ${MAX_FILES} קבצים`);
  const allowed = D.getSetting('allowed_extensions', []);
  const maxMb = Number(D.getSetting('max_upload_mb', 25));
  return files.map((f) => {
    const filename = clean(f?.name, 200);
    const data = String(f?.data ?? '');
    if (!filename || !data) throw badRequest('אחד הקבצים ריק');
    const ext = path.extname(filename).replace('.', '').toLowerCase();
    if (allowed.length && !allowed.includes(ext)) {
      throw badRequest(`סוג הקובץ .${ext} אינו מורשה במשימון. מותרים: ${allowed.join(', ')}`);
    }
    const bytes = Math.floor(data.split(',').pop().length * 3 / 4);
    if (bytes > maxMb * 1024 * 1024) throw badRequest(`הקובץ "${filename}" חורג מהמגבלה (${maxMb}MB)`);
    return { filename, mime: clean(f?.mime, 100), data };
  });
}

/**
 * מי שבשמו נוצרת המשימה. מנהל מחלקה רשאי להקצות רק בתוך המחלקה שלו, ולכן
 * כשנבחר אחראי ממחלקה אחרת — המשימה נוצרת בשם מנהל המערכת.
 */
function actorFor(dept, assigneeId) {
  const actor = systemActor(dept);
  if (!assigneeId || P.level(actor, 'assign_department_task') !== 'department') return actor;
  const target = D.get('SELECT department_id FROM users WHERE id = ?', assigneeId);
  if ((target?.department_id ?? null) === (actor.departmentId ?? null)) return actor;
  const admin = D.get("SELECT id FROM users WHERE role IN ('superadmin','admin') AND status = 'active' ORDER BY id LIMIT 1");
  return (admin && Auth.loadActor('user', admin.id)) || actor;
}

function register(router, { createTask, saveAttachment, getTaskOr404 }) {
  /**
   * מה שתפעול 360 מציג בחלון השליחה: המשתמשים הפעילים לבחירת אחראי, הפרויקטים
   * הפעילים, הפרויקט שיוצע לנושא הקריאה, ומגבלות הקבצים.
   */
  router.get('/api/integrations/tiful360/options', async (req, res) => {
    authenticate(req);
    const dept = department();
    const url = new URL(req.url, 'http://local');
    const users = D.all(
      `SELECT u.id, u.full_name AS name, u.email, COALESCE(d.name, '') AS department
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.status = 'active' ORDER BY u.full_name`);
    const projects = D.all("SELECT id, name FROM projects WHERE status = 'active' ORDER BY name");
    sendJson(res, 200, {
      department: dept.name,
      users,
      projects,
      defaultProject: projectName(url.searchParams.get('subjectLabel')),
      maxFiles: MAX_FILES,
      maxUploadMb: Number(D.getSetting('max_upload_mb', 25)),
      allowedExtensions: D.getSetting('allowed_extensions', [])
    });
  });

  router.post('/api/integrations/tiful360/tasks', async (req, res) => {
    authenticate(req);
    const body = await readJson(req);
    const ticketCode = clean(body.ticketCode, 50);
    if (!ticketCode) throw badRequest('נדרש מספר קריאה');

    // אותה קריאה אינה הופכת לשתי משימות, גם בלחיצה כפולה או בניסיון חוזר
    const existing = D.get('SELECT id FROM tasks WHERE source = ? AND source_ref = ? ORDER BY id LIMIT 1', SOURCE, ticketCode);
    if (existing) return sendJson(res, 200, { taskId: existing.id, url: taskLink(existing.id), existing: true });

    const files = checkFiles(body.files);
    const dept = department();

    /*
     * אחראי: מי שנבחר בחלון (‎assigneeId‎), ואם לא נבחר — מי ששלח את הקריאה,
     * לפי כתובת הדואר. מי שאינו משתמש פעיל כאן — המשימה נוצרת בלי אחראי,
     * ותפעול 360 מציג על כך הודעה.
     */
    let assigneeId = null;
    if (body.assigneeId) {
      const u = D.get("SELECT id FROM users WHERE id = ? AND status = 'active'", Number(body.assigneeId));
      if (!u) throw badRequest('האחראי שנבחר אינו משתמש פעיל במשימון');
      assigneeId = u.id;
    } else {
      const email = clean(body.assigneeEmail, 200).toLowerCase();
      if (email) assigneeId = D.get("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", email)?.id ?? null;
    }
    const actor = actorFor(dept, assigneeId);

    // פרויקט: מה שנבחר בחלון, ואם לא נבחר — הפרויקט של נושא הקריאה
    let projectId;
    if (body.projectId) {
      const p = D.get("SELECT id FROM projects WHERE id = ? AND status != 'done'", Number(body.projectId));
      if (!p) throw badRequest('הפרויקט שנבחר אינו קיים או שהסתיים');
      projectId = p.id;
    } else {
      projectId = projectFor(body.subjectLabel, actor);
    }

    const dueDate = /^\d{4}-\d{2}-\d{2}/.test(String(body.dueDate ?? '')) ? String(body.dueDate).slice(0, 10) : null;
    const id = createTask(actor, {
      title: clean(body.title, 200) || `קריאת שירות ${ticketCode}`,
      description: buildDescription({ ...body, ticketCode }),
      projectId,
      departmentId: dept.id,
      assigneeType: assigneeId ? 'user' : null,
      assigneeId,
      priority: PRIORITY_MAP[body.priority] ?? 'normal',
      dueDate,
      source: SOURCE,
      sourceRef: ticketCode,
      auditNote: `נוצרה מקריאת שירות ${ticketCode} בתפעול 360`
    });

    const task = getTaskOr404(id);
    for (const f of files) {
      const { name, version } = saveAttachment(task, actor, f);
      D.audit(id, { type: 'user', id: actor.id, name: actor.name }, 'attachment', `הועלה קובץ "${name}" (גרסה ${version}) מתפעול 360`);
    }
    sendJson(res, 201, { taskId: id, url: taskLink(id), existing: false, assigned: !!assigneeId, files: files.length });
  });
}

/**
 * משימה שהגיעה מתפעול 360 הסתיימה — סגירת הקריאה שם. תפעול 360 שולח את
 * הדואר למי שפתח את הקריאה.
 *
 * לא ממתינים ולא זורקים: סגירת משימה לא תיכשל ולא תתעכב בגלל מערכת אחרת.
 * התוצאה נרשמת ביומן המשימה, כדי שכשל ייראה ולא ייבלע.
 */
function onTaskCompleted(task, actor) {
  if (task.source !== SOURCE || !task.source_ref) return;
  const url = env('TIFUL360_API_URL');
  const key = env('TIFUL360_API_KEY');
  if (!url || !key) return;
  const ref = { type: 'system', id: null, name: 'תפעול 360' };
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      action: 'close_ticket',
      ticket_code: task.source_ref,
      message: `הקריאה טופלה${actor?.name ? ` ע"י ${actor.name}` : ''}.`
    }),
    signal: AbortSignal.timeout(15000)
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      D.audit(task.id, ref, 'tiful360', data.already_closed
        ? 'הקריאה בתפעול 360 כבר הייתה סגורה'
        : `הקריאה נסגרה בתפעול 360${data.emailed ? ' ונשלח דואר לפותח' : ''}`);
    })
    .catch((err) => {
      console.error('[משימון] סגירת קריאה בתפעול 360 נכשלה:', err.message);
      try { D.audit(task.id, ref, 'tiful360', `סגירת הקריאה בתפעול 360 נכשלה: ${err.message}`); } catch {}
    });
}

module.exports = { register, onTaskCompleted, SOURCE };
