'use strict';
/**
 * שכבת הנתונים של משימון.
 * משתמשת ב-node:sqlite המובנה ב-Node — ללא תלויות חיצוניות.
 * מימוש ישויות הנתונים של המערכת.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/**
 * האם הנתיב הוא נקודת עיגון של דיסק — כלומר דיסק שחובר לשרת.
 * מזהים לפי מזהה ההתקן: לתיקייה על דיסק אחר יש מזהה שונה מזה של תיקיית האב.
 */
function isMountPoint(dir) {
  try {
    const self = fs.statSync(dir);
    if (!self.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return self.dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return false;
  }
}

/**
 * איתור דיסק קבוע כשלא הוגדרו משתני סביבה.
 * בלי זה, שכחה של הגדרה אחת גורמת לכתיבה לתוך תיקיית הקוד — שנמחקת
 * בכל פרסום גרסה בענן, והנתונים נעלמים בלי שום הודעה.
 */
function detectPersistentDisk() {
  for (const candidate of ['/var/mesimon', '/var/data', '/data', '/mnt/data', '/mnt/disk']) {
    if (isMountPoint(candidate)) return candidate;
  }
  return null;
}

const detectedDisk = process.env.DATA_DIR ? null : detectPersistentDisk();

const DATA_DIR = process.env.DATA_DIR
  ?? (detectedDisk ? path.join(detectedDisk, 'data') : path.join(ROOT, 'data'));
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ?? (detectedDisk ? path.join(detectedDisk, 'uploads') : path.join(ROOT, 'uploads'));

// האם הנתונים יושבים במקום שנמחק בכל פרסום גרסה
const STORAGE = {
  dataDir: DATA_DIR,
  uploadsDir: UPLOADS_DIR,
  source: process.env.DATA_DIR ? 'env' : detectedDisk ? 'detected' : 'local',
  disk: detectedDisk,
  ephemeralInCloud: !process.env.DATA_DIR && !detectedDisk && !!process.env.RENDER
};

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'mesimon.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------------------
// סכמה
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  -- רשימת התפקידים נאכפת בקוד (permissions.js) ולא כאן, כדי שהוספת תפקיד
  -- לא תדרוש שינוי סכמה על מסד נתונים חי
  role          TEXT    NOT NULL,
  department    TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  contact_name  TEXT    NOT NULL DEFAULT '',
  email         TEXT    NOT NULL UNIQUE,
  phone         TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  read_only     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

-- בורד פנימי ובורדי ספקים הם ישויות נפרדות לחלוטין
CREATE TABLE IF NOT EXISTS boards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('internal','vendor')),
  vendor_id  INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);

-- עמודות מותאמות אישית לכל בורד (הרחבה מעבר לשלוש ברירות המחדל)
CREATE TABLE IF NOT EXISTS board_columns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id  INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key       TEXT    NOT NULL,
  label     TEXT    NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  is_final  INTEGER NOT NULL DEFAULT 0,
  color     TEXT    NOT NULL DEFAULT '#94a3b8',
  UNIQUE (board_id, key)
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  manager_id  INTEGER REFERENCES users(id),
  start_date  TEXT,
  due_date    TEXT,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','done')),
  created_at  TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  color       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  title              TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  project_id         INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  board_id           INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  assignee_type      TEXT    CHECK (assignee_type IN ('user','vendor')),
  assignee_id        INTEGER,
  status             TEXT    NOT NULL DEFAULT 'new',
  priority           TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date           TEXT,
  created_at         TEXT    NOT NULL,
  created_by         INTEGER REFERENCES users(id),
  status_changed_at  TEXT    NOT NULL,
  completed_at       TEXT,
  activate_at        TEXT,               -- משימות עתידיות מתוזמנות
  depends_on_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  is_recurring       INTEGER NOT NULL DEFAULT 0,
  recurrence_freq    TEXT    CHECK (recurrence_freq IN ('daily','weekly','monthly')),
  recurrence_policy  TEXT    NOT NULL DEFAULT 'inherit',  -- inherit | skip_if_open | always
  recurrence_parent  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  last_spawned_at    TEXT,
  archived           INTEGER NOT NULL DEFAULT 0,
  escalated          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text     TEXT    NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  -- לפעמים לסעיף יש תהליך משל עצמו: הערה חופשית, ולצדה שרשור תגובות
  -- (טבלת comments, דרך checklist_item_id)
  note     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- תגובה על סעיף בצ'קליסט ולא על המשימה כולה. השרשור יושב באותה טבלה
  -- כדי שכל מה שכבר עובד בתגובות — תיוגים, קבצים והערות פנימיות — יעבוד גם שם.
  checklist_item_id INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
  author_type TEXT    NOT NULL CHECK (author_type IN ('user','vendor','system')),
  author_id   INTEGER,
  body        TEXT    NOT NULL,
  internal    INTEGER NOT NULL DEFAULT 0,   -- הערות פנימיות מוסתרות מהספק
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);

-- קבצים מצורפים עם שמירת גרסאות היסטוריות (לא דריסה)
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename      TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  size          INTEGER NOT NULL DEFAULT 0,
  mime          TEXT    NOT NULL DEFAULT 'application/octet-stream',
  uploader_type TEXT    NOT NULL CHECK (uploader_type IN ('user','vendor')),
  uploader_id   INTEGER NOT NULL,
  created_at    TEXT    NOT NULL
);

/*
 * תמונות של פרויקט: לוגו אחד, ולצדו גלריה להדמיות ולחומרים חזותיים.
 * טבלה נפרדת ולא attachments, כי שם task_id הוא NOT NULL — תמונה של פרויקט
 * אינה תלויה בשום משימה, ואמורה לשרוד גם כשכל משימותיו נמחקות.
 */
CREATE TABLE IF NOT EXISTS project_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('logo','gallery')),
  filename    TEXT    NOT NULL,
  stored_name TEXT    NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT    NOT NULL,
  caption     TEXT    NOT NULL DEFAULT '',
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type  TEXT    NOT NULL CHECK (target_type IN ('user','vendor')),
  target_id    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,   -- vendor_reminder | manager_alert | overdue | escalation | mention | status_change | assignment
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL DEFAULT '',
  task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

-- לוג בלתי ניתן לשינוי — נאכף גם ברמת ה-DB
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type TEXT    NOT NULL CHECK (actor_type IN ('user','vendor','system')),
  actor_id   INTEGER,
  actor_name TEXT    NOT NULL DEFAULT '',
  action     TEXT    NOT NULL,
  details    TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'לוג ההיסטוריה אינו ניתן לעריכה');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN (SELECT 1 FROM tasks WHERE id = OLD.task_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'לוג ההיסטוריה אינו ניתן למחיקה');
END;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- מנוע כללים ניתן להרחבה
CREATE TABLE IF NOT EXISTS automation_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  trigger_key TEXT    NOT NULL,
  params      TEXT    NOT NULL DEFAULT '{}',
  action_key  TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  built_in    INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT    NOT NULL
);

-- מונע שליחת אותה התראה אוטומטית פעמיים
CREATE TABLE IF NOT EXISTS rule_fires (
  rule_id    INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  marker     TEXT    NOT NULL DEFAULT '',
  fired_at   TEXT    NOT NULL,
  PRIMARY KEY (rule_id, task_id, marker)
);

-- נעיצת פרויקטים לראש תפריט הצד. אישית לכל משתמש.
CREATE TABLE IF NOT EXISTS project_pins (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL CHECK (kind IN ('task','project')),
  name       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

-- הרשאות אישיות מעל התפקיד. מנהל מחלקה מעניק אותן לעובד שלו — למשל מזכירה
-- שצריכה לראות את כל משימות המחלקה ולהקצות משימות לחברי הצוות.
CREATE TABLE IF NOT EXISTS user_grants (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_key  TEXT    NOT NULL,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, grant_key)
);

-- מחלקות הארגון. לכל מחלקה מנהל אחד, וכל עובד משויך למחלקה אחת.
CREATE TABLE IF NOT EXISTS departments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      TEXT NOT NULL
);

-- הזמנות למערכת: קישור חד-פעמי לקביעת סיסמה, במקום להעביר סיסמאות בדואר
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','vendor')),
  target_id   INTEGER NOT NULL,
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_target ON invites(target_type, target_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','vendor')),
  actor_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_board    ON tasks(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_type, assignee_id);
CREATE INDEX IF NOT EXISTS idx_notif_target   ON notifications(target_type, target_id, is_read);
CREATE INDEX IF NOT EXISTS idx_audit_task     ON audit_log(task_id);
`);

// ---------------------------------------------------------------------------
// עזרי גישה
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  );
}

function allSettings() {
  const out = {};
  for (const row of all('SELECT key, value FROM settings')) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

function audit(taskId, actor, action, details = '') {
  run(
    'INSERT INTO audit_log (task_id, actor_type, actor_id, actor_name, action, details, created_at) VALUES (?,?,?,?,?,?,?)',
    taskId ?? null,
    actor?.type ?? 'system',
    actor?.id ?? null,
    actor?.name ?? 'המערכת',
    action,
    details,
    nowIso()
  );
}

function notify({ targetType, targetId, kind, title, body = '', taskId = null }) {
  run(
    'INSERT INTO notifications (target_type, target_id, kind, title, body, task_id, is_read, created_at) VALUES (?,?,?,?,?,?,0,?)',
    targetType,
    targetId,
    kind,
    title,
    body,
    taskId,
    nowIso()
  );
}

// ---------------------------------------------------------------------------
// ברירות מחדל ונתוני התחלה
// ---------------------------------------------------------------------------

// כל הפרמטרים המספריים הם הגדרות קונפיגורביליות, לא ערכים קבועים בקוד
const DEFAULT_SETTINGS = {
  vendor_reminder_days_before: 3,          // X — תזכורת ראשונה לספק
  manager_alert_hours_before: 24,          // Y — התראה מקדימה למנהל
  escalation_hours_urgent: 24,             // הקפצה למשימת 'דחוף' שלא זזה
  archive_done_after_days: 3,              // כמה ימים משימה שהושלמה נשארת בתצוגה השוטפת
  scheduler_interval_minutes: 5,           // תדירות הרצת מנוע הכללים
  max_upload_mb: 25,
  allowed_extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'ai', 'psd', 'mp4', 'txt', 'csv'],
  recurring_default_policy: 'skip_if_open', // לא נוצר מופע כפול עד לסגירת הקודם
  org_name: 'MESIMON',
  // כתובת המערכת כפי שמשתמשים מגיעים אליה — קישורי ההזמנות נבנים ממנה
  public_url: '',
  org_logo_note: ''
};

const INTERNAL_COLUMNS = [
  { key: 'new', label: 'חדש', position: 0, is_final: 0, color: '#64748b' },
  { key: 'in_progress', label: 'בטיפול', position: 1, is_final: 0, color: '#2563eb' },
  // משימה שהכדור בה אצל מישהו אחר — היא אינה "בטיפול" ואינה תקועה סתם
  { key: 'waiting_reply', label: 'ממתין לתשובה', position: 2, is_final: 0, color: '#d97706' },
  { key: 'done', label: 'הושלם', position: 3, is_final: 1, color: '#16a34a' }
];

// מצבי המשימה בזרימת העבודה מול ספק
const VENDOR_COLUMNS = [
  { key: 'awaiting_upload', label: 'ממתין להעלאת תוצרים', position: 0, is_final: 0, color: '#64748b' },
  { key: 'uploaded', label: 'הועלה — ממתין לבדיקה', position: 1, is_final: 0, color: '#0891b2' },
  { key: 'pending_team_review', label: 'ממתין לבדיקת הצוות', position: 2, is_final: 0, color: '#7c3aed' },
  { key: 'in_team_review', label: 'בבדיקת הצוות', position: 3, is_final: 0, color: '#d97706' },
  { key: 'needs_fix', label: 'נדרש תיקון', position: 4, is_final: 0, color: '#dc2626' },
  { key: 'approved', label: 'הושלם ואושר', position: 5, is_final: 1, color: '#16a34a' }
];

const BUILT_IN_RULES = [
  {
    name: 'תזכורת ראשונה לספק לפני תאריך היעד',
    trigger_key: 'vendor_due_soon',
    action_key: 'notify_vendor',
    params: { days_before_setting: 'vendor_reminder_days_before' }
  },
  {
    // משימה שהושלמה נשארת בתצוגה השוטפת כמה ימים, כדי שאפשר יהיה לראות
    // מה נסגר ולחזור אם צריך, ורק אחר כך יורדת לארכיון
    name: 'העברה לארכיון של משימה שהושלמה',
    trigger_key: 'completed_stale',
    action_key: 'archive_task',
    params: { days_setting: 'archive_done_after_days' }
  },
  {
    name: 'התראה מקדימה למנהל המחלקה',
    trigger_key: 'manager_pre_due',
    action_key: 'notify_managers',
    params: { hours_before_setting: 'manager_alert_hours_before' }
  },
  {
    name: 'התראת חריגה בפועל מתאריך היעד',
    trigger_key: 'task_overdue',
    action_key: 'notify_managers',
    params: {}
  },
  {
    name: 'הקפצה אוטומטית של משימה דחופה שלא זזה',
    trigger_key: 'urgent_stale',
    action_key: 'escalate_to_managers',
    params: { hours_setting: 'escalation_hours_urgent' }
  },
  {
    name: 'יצירת מופע הבא של משימה חוזרת',
    trigger_key: 'recurring_due',
    action_key: 'spawn_recurring',
    params: {}
  },
  {
    name: 'הפעלת משימות עתידיות שהגיע מועדן',
    trigger_key: 'scheduled_activation',
    action_key: 'activate_task',
    params: {}
  }
];

function ensureBoardColumns(boardId, columns) {
  for (const col of columns) {
    run(
      'INSERT OR IGNORE INTO board_columns (board_id, key, label, position, is_final, color) VALUES (?,?,?,?,?,?)',
      boardId,
      col.key,
      col.label,
      col.position,
      col.is_final,
      col.color
    );
  }
}

function createVendorBoard(vendorId, vendorName) {
  const res = run(
    'INSERT INTO boards (name, type, vendor_id, created_at) VALUES (?, ?, ?, ?)',
    `בורד ספק — ${vendorName}`,
    'vendor',
    vendorId,
    nowIso()
  );
  const boardId = Number(res.lastInsertRowid);
  ensureBoardColumns(boardId, VENDOR_COLUMNS);
  return boardId;
}

function internalBoard() {
  let board = get("SELECT * FROM boards WHERE type = 'internal' LIMIT 1");
  if (!board) {
    const res = run(
      'INSERT INTO boards (name, type, vendor_id, created_at) VALUES (?, ?, NULL, ?)',
      'הבורד הפנימי של הצוות',
      'internal',
      nowIso()
    );
    board = get('SELECT * FROM boards WHERE id = ?', Number(res.lastInsertRowid));
  }
  ensureBoardColumns(board.id, INTERNAL_COLUMNS);
  return board;
}

function boardColumns(boardId) {
  return all('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position', boardId);
}

function bootstrap({ demo = false } = {}) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (get('SELECT 1 FROM settings WHERE key = ?', key) === undefined) setSetting(key, value);
  }

  internalBoard();

  for (const rule of BUILT_IN_RULES) {
    const exists = get('SELECT 1 FROM automation_rules WHERE trigger_key = ? AND built_in = 1', rule.trigger_key);
    if (exists === undefined) {
      run(
        'INSERT INTO automation_rules (name, trigger_key, params, action_key, enabled, built_in, created_at) VALUES (?,?,?,?,1,1,?)',
        rule.name,
        rule.trigger_key,
        JSON.stringify(rule.params),
        rule.action_key,
        nowIso()
      );
    }
  }

  migrate();

  // סימני חיים של מסד הנתונים — אם התאריך הזה מתאפס אחרי פרסום גרסה,
  // סימן שהנתונים אינם יושבים על דיסק קבוע
  if (getSetting('installed_at') === null) setSetting('installed_at', nowIso());
  setSetting('boot_count', Number(getSetting('boot_count', 0)) + 1);

  // מערכת חדשה מתחילה ריקה, עם חשבון מנהל אחד בלבד.
  // נתוני הדגמה נוצרים רק במפורש: node server/seed-demo.js
  if (demo && get('SELECT COUNT(*) AS c FROM users').c === 0) seedDemoData();
  else ensureFirstAdmin();
}

/**
 * מסדי נתונים שנוצרו בגרסה קודמת מגבילים את עמוד role לשלושה תפקידים בלבד.
 * SQLite אינו מאפשר לשנות CHECK, ולכן בונים את הטבלה מחדש ומעבירים את הנתונים.
 * רץ פעם אחת בלבד — אחרי הבנייה התנאי כבר אינו קיים.
 */
function relaxUserRoleConstraint() {
  const schema = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")?.sql ?? '';
  if (!schema.includes('CHECK (role IN')) return;

  const existing = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const carried = ['id', 'full_name', 'email', 'password_hash', 'role', 'department',
    'department_id', 'status', 'created_at'].filter((c) => existing.includes(c));

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE users_migrated (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name     TEXT    NOT NULL,
        email         TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL,
        department    TEXT    NOT NULL DEFAULT '',
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at    TEXT    NOT NULL
      )`);
    db.exec(`INSERT INTO users_migrated (${carried.join(', ')}) SELECT ${carried.join(', ')} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_migrated RENAME TO users');
    db.exec('COMMIT');
    console.log('[משימון] טבלת המשתמשים הורחבה לתמיכה בתפקידים נוספים.');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * הרחבות סכמה על מסד נתונים קיים.
 * חייב להיות בטוח להרצה חוזרת, ובלי לאבד נתונים — הוא רץ על המערכת החיה.
 */
function migrate() {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const addColumn = (table, column, definition) => {
    if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  relaxUserRoleConstraint();

  addColumn('users', 'department_id', 'INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  // קובץ שצורף לתגובה בשיחה — כדי שיוצג בתוך ההודעה שבה נשלח, ולא רק ברשימה
  addColumn('attachments', 'comment_id', 'INTEGER REFERENCES comments(id) ON DELETE SET NULL');
  // הערה: מסדי נתונים שנוצרו בגרסה קודמת מכילים עמודת tasks.level מהרמה
  // הארגונית שבוטלה. היא נותרת ריקה ואינה נקראת; מחיקת עמודה ב-SQLite
  // דורשת בניית טבלה מחדש, וזה סיכון מיותר עבור עמודה שאינה מפריעה.
  addColumn('tasks', 'department_id', 'INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  // מי פתח את הפרויקט — הפרויקט נשאר ברשימה שלו גם אם מונה לו מנהל אחר
  addColumn('projects', 'created_by', 'INTEGER REFERENCES users(id)');
  // צבע הפרויקט — צובע את שורות המשימות שלו, לזיהוי במבט ולא בקריאה
  addColumn('projects', 'color', "TEXT NOT NULL DEFAULT ''");
  // סעיף צ'קליסט שיש בו תהליך: הערה חופשית ושרשור תגובות משלו
  addColumn('checklist_items', 'note', "TEXT NOT NULL DEFAULT ''");
  addColumn('comments', 'checklist_item_id', 'INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE');

  /**
   * סדר העמודות הוא סדר הזרימה, ולכן העמודה הסופית חייבת להיות אחרונה.
   * ‎ensureBoardColumns‎ מוסיף עמודה חדשה במיקום הקבוע שהוגדר לה בקוד, ובמסד
   * קיים המיקום הזה כבר תפוס — כך "ממתין לתשובה", שנוסף לבורד הפנימי, נחת
   * על אותו מספר כמו "הושלם". הסדר נבנה כאן מחדש בכל עלייה: הלא-סופיות לפי
   * סדרן הקיים, והסופית אחריהן.
   */
  for (const board of all('SELECT id FROM boards')) {
    const cols = all(
      'SELECT id, position FROM board_columns WHERE board_id = ? ORDER BY is_final, position, id', board.id
    );
    cols.forEach((c, i) => { if (c.position !== i) run('UPDATE board_columns SET position = ? WHERE id = ?', i, c.id); });
  }

  // המחלקות היו עד כה טקסט חופשי בכל משתמש. הופכים אותן לישויות ומקשרים.
  const legacy = all(
    "SELECT DISTINCT department AS name FROM users WHERE department IS NOT NULL AND trim(department) <> ''"
  );
  for (const { name } of legacy) {
    if (!get('SELECT 1 FROM departments WHERE name = ?', name)) {
      run('INSERT INTO departments (name, created_at) VALUES (?,?)', name, nowIso());
    }
  }
  run(`UPDATE users SET department_id = (SELECT id FROM departments d WHERE d.name = users.department)
       WHERE department_id IS NULL AND department IS NOT NULL AND trim(department) <> ''`);

  // מנהל מחלקה שאין לה מנהל מוגדר — נרשם כמנהל שלה
  run(`UPDATE departments SET manager_user_id = (
         SELECT u.id FROM users u
         WHERE u.department_id = departments.id AND u.role = 'manager' AND u.status = 'active'
         ORDER BY u.id LIMIT 1
       ) WHERE manager_user_id IS NULL`);

  // שיוך מחלקתי למשימות קיימות, לפי המחלקה של האחראי
  run(`UPDATE tasks SET department_id = (
         SELECT u.department_id FROM users u WHERE u.id = tasks.assignee_id
       ) WHERE department_id IS NULL AND assignee_type = 'user'`);

  // הגדרת "שם המחלקה" הפכה מיותרת מרגע שיש טבלת מחלקות
  run("DELETE FROM settings WHERE key = 'department_name'");

  // אף אחד אינו רשאי להעניק רמה שווה או גבוהה משלו, ולכן ללא הקידום הזה
  // הרמה העליונה הייתה בלתי-נגישה במערכת קיימת. מקודם המנהל הוותיק ביותר.
  if (!get("SELECT 1 FROM users WHERE role = 'superadmin'")) {
    const first = get("SELECT id, full_name FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");
    if (first) {
      run("UPDATE users SET role = 'superadmin' WHERE id = ?", first.id);
      console.log(`[משימון] ${first.full_name} קודם לרמת אדמין על — הרמה העליונה במערכת.`);
    }
  }
}

/** יוצר חשבון מנהל מערכת יחיד כשמסד הנתונים ריק ממשתמשים */
function ensureFirstAdmin() {
  if (get('SELECT COUNT(*) AS c FROM users').c > 0) return;

  const email = (process.env.ADMIN_EMAIL ?? 'admin@eshel.co.il').toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(9).toString('base64url');

  run(
    'INSERT INTO users (full_name, email, password_hash, role, department, status, created_at) VALUES (?,?,?,?,?,?,?)',
    process.env.ADMIN_NAME ?? 'מנהל מערכת',
    email,
    hashPassword(password),
    'superadmin',
    'שיווק ומכירות',
    'active',
    nowIso()
  );

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('  נוצר חשבון מנהל המערכת הראשון:');
  console.log(`     אימייל:  ${email}`);
  console.log(`     סיסמה:   ${password}`);
  if (generated) console.log('  יש לשמור אותה עכשיו — היא לא תוצג שוב.');
  console.log('  ' + '='.repeat(58));
  console.log('');
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(17, 0, 0, 0);
  return d.toISOString();
}

function seedDemoData() {
  const ts = nowIso();
  // אידמפוטנטי: אם חשבון המנהל הראשוני כבר נוצר, מעדכנים אותו במקום להיכשל
  const mkUser = (name, email, role) => {
    const existing = get('SELECT id FROM users WHERE lower(email) = ?', email.toLowerCase());
    if (existing) {
      run('UPDATE users SET full_name = ?, password_hash = ?, role = ?, status = ? WHERE id = ?',
        name, hashPassword('1234'), role, 'active', existing.id);
      return existing.id;
    }
    return Number(
      run(
        'INSERT INTO users (full_name, email, password_hash, role, department, status, created_at) VALUES (?,?,?,?,?,?,?)',
        name,
        email,
        hashPassword('1234'),
        role,
        'שיווק ומכירות',
        'active',
        ts
      ).lastInsertRowid
    );
  };

  const admin = mkUser('אבי כהן', 'admin@eshel.co.il', 'admin');
  const manager = mkUser('רונית לוי', 'manager@eshel.co.il', 'manager');
  const emp1 = mkUser('דנה שמש', 'dana@eshel.co.il', 'employee');
  const emp2 = mkUser('יוסי ברק', 'yossi@eshel.co.il', 'employee');

  const mkVendor = (name, contact, email, phone) => {
    const id = Number(
      run(
        'INSERT INTO vendors (name, contact_name, email, phone, password_hash, status, read_only, created_at) VALUES (?,?,?,?,?,?,?,?)',
        name,
        contact,
        email,
        phone,
        hashPassword('1234'),
        'active',
        0,
        ts
      ).lastInsertRowid
    );
    return { id, boardId: createVendorBoard(id, name) };
  };

  const design = mkVendor('סטודיו גרפי "פיקסל"', 'מיכל אורן', 'pixel@vendor.co.il', '052-1234567');
  const print = mkVendor('דפוס הצפון', 'עומר גל', 'print@vendor.co.il', '04-9876543');

  const board = internalBoard();

  const mkProject = (name, description, managerId, startDays, dueDays) =>
    Number(
      run(
        'INSERT INTO projects (name, description, manager_id, start_date, due_date, status, created_at) VALUES (?,?,?,?,?,?,?)',
        name,
        description,
        managerId,
        daysFromNow(startDays),
        daysFromNow(dueDays),
        'active',
        ts
      ).lastInsertRowid
    );

  const pExpo = mkProject('תערוכת אגרו 2026', 'ביתן התערוכה, חומרי שיווק והדרכת צוות', manager, -20, 45);
  const pCatalog = mkProject('קטלוג מוצרים חדש', 'עיצוב, צילום והפקת קטלוג 2026', manager, -10, 30);
  const pDigital = mkProject('קמפיין דיגיטל רבעון ג׳', 'ניהול קמפיין ממומן ורשתות חברתיות', manager, -5, 60);

  const mkTask = (t) => {
    const res = run(
      `INSERT INTO tasks
        (title, description, project_id, board_id, assignee_type, assignee_id, status, priority,
         due_date, created_at, created_by, status_changed_at, completed_at, activate_at,
         depends_on_task_id, is_recurring, recurrence_freq, recurrence_policy, archived)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.title,
      t.description ?? '',
      t.project_id ?? null,
      t.board_id,
      t.assignee_type ?? null,
      t.assignee_id ?? null,
      t.status,
      t.priority ?? 'normal',
      t.due_date ?? null,
      ts,
      t.created_by ?? manager,
      t.status_changed_at ?? ts,
      t.completed_at ?? null,
      t.activate_at ?? null,
      t.depends_on_task_id ?? null,
      t.is_recurring ? 1 : 0,
      t.recurrence_freq ?? null,
      t.recurrence_policy ?? 'inherit',
      t.archived ? 1 : 0
    );
    const id = Number(res.lastInsertRowid);
    audit(id, { type: 'user', id: manager, name: 'רונית לוי' }, 'created', 'המשימה נוצרה');
    for (const [i, text] of (t.checklist ?? []).entries()) {
      run('INSERT INTO checklist_items (task_id, text, done, position) VALUES (?,?,?,?)', id, text.replace(/^\+/, ''), text.startsWith('+') ? 1 : 0, i);
    }
    return id;
  };

  // --- משימות פנימיות ---
  const brief = mkTask({
    title: 'אישור בריף עיצובי לביתן התערוכה',
    description: 'לגבש בריף מסודר מול ההנהלה לפני העברה לסטודיו.',
    project_id: pExpo, board_id: board.id, assignee_type: 'user', assignee_id: emp1,
    status: 'done', priority: 'high', due_date: daysFromNow(-4), completed_at: daysFromNow(-4),
    checklist: ['+איסוף דרישות מהמנהלים', '+ניסוח בריף', '+אישור תקציב']
  });

  mkTask({
    title: 'הכנת מצגת הדרכה לצוות המכירות',
    description: 'מצגת קצרה עם מסרי המפתח לתערוכה.',
    project_id: pExpo, board_id: board.id, assignee_type: 'user', assignee_id: emp2,
    status: 'in_progress', priority: 'normal', due_date: daysFromNow(6),
    checklist: ['+שלד המצגת', 'עיצוב שקפים', 'חזרה גנרלית']
  });

  mkTask({
    title: 'תיאום לוגיסטי מול מארגני התערוכה',
    description: 'חשמל, ריהוט, שילוט וכניסות.',
    project_id: pExpo, board_id: board.id, assignee_type: 'user', assignee_id: emp1,
    status: 'new', priority: 'urgent', due_date: daysFromNow(-2),
    status_changed_at: daysFromNow(-3)
  });

  mkTask({
    title: 'ריכוז תכני הקטלוג מכל קווי המוצר',
    project_id: pCatalog, board_id: board.id, assignee_type: 'user', assignee_id: emp2,
    status: 'in_progress', priority: 'high', due_date: daysFromNow(3),
    checklist: ['+קו מוצר א׳', 'קו מוצר ב׳', 'קו מוצר ג׳']
  });

  const proof = mkTask({
    title: 'הגהה סופית של הקטלוג לפני דפוס',
    description: 'לא ניתן להתחיל לפני קבלת העימוד מהסטודיו.',
    project_id: pCatalog, board_id: board.id, assignee_type: 'user', assignee_id: emp1,
    status: 'new', priority: 'high', due_date: daysFromNow(14)
  });

  mkTask({
    title: 'דוח ביצועי קמפיין שבועי',
    description: 'משימה חוזרת — ריכוז נתוני הקמפיין והפצה למנהלים.',
    project_id: pDigital, board_id: board.id, assignee_type: 'user', assignee_id: emp2,
    status: 'new', priority: 'normal', due_date: daysFromNow(2),
    is_recurring: 1, recurrence_freq: 'weekly'
  });

  mkTask({
    title: 'הכנת חומרי שיווק לכנס הסתיו',
    description: 'משימה עתידית — תופיע ברשימות רק מתאריך ההפעלה.',
    project_id: pDigital, board_id: board.id, assignee_type: 'user', assignee_id: emp1,
    status: 'new', priority: 'normal', due_date: daysFromNow(75), activate_at: daysFromNow(30)
  });

  mkTask({
    title: 'עדכון רשימת תפוצה ללקוחות',
    project_id: pDigital, board_id: board.id, assignee_type: 'user', assignee_id: emp2,
    status: 'done', priority: 'low', due_date: daysFromNow(-12), completed_at: daysFromNow(-11), archived: 1
  });

  // --- משימות ספקים (בבורדים הנפרדים שלהם) ---
  const layout = mkTask({
    title: 'עימוד גרפי של הקטלוג — 48 עמודים',
    description: 'לפי הבריף המאושר. נדרש PDF להגהה.',
    project_id: pCatalog, board_id: design.boardId, assignee_type: 'vendor', assignee_id: design.id,
    status: 'uploaded', priority: 'high', due_date: daysFromNow(5)
  });
  run('UPDATE tasks SET depends_on_task_id = ? WHERE id = ?', layout, proof);

  mkTask({
    title: 'עיצוב באנרים לביתן התערוכה',
    project_id: pExpo, board_id: design.boardId, assignee_type: 'vendor', assignee_id: design.id,
    status: 'awaiting_upload', priority: 'urgent', due_date: daysFromNow(1)
  });

  mkTask({
    title: 'עיצוב פוסטים לרשתות — סבב ספטמבר',
    project_id: pDigital, board_id: design.boardId, assignee_type: 'vendor', assignee_id: design.id,
    status: 'needs_fix', priority: 'normal', due_date: daysFromNow(4)
  });

  mkTask({
    title: 'הדפסת 5,000 עותקי קטלוג',
    project_id: pCatalog, board_id: print.boardId, assignee_type: 'vendor', assignee_id: print.id,
    status: 'awaiting_upload', priority: 'normal', due_date: daysFromNow(25)
  });

  mkTask({
    title: 'הדפסת רולאפים ושילוט לתערוכה',
    project_id: pExpo, board_id: print.boardId, assignee_type: 'vendor', assignee_id: print.id,
    status: 'pending_team_review', priority: 'high', due_date: daysFromNow(-1)
  });

  run(
    'INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,?,?)',
    layout, 'vendor', design.id, 'העליתי גרסה ראשונה לעימוד, מחכה להערותיכם.', 0, ts
  );
  run(
    'INSERT INTO comments (task_id, author_type, author_id, body, internal, created_at) VALUES (?,?,?,?,?,?)',
    layout, 'user', manager, 'דיון פנימי: לבדוק אם התקציב מאפשר נייר כרומו.', 1, ts
  );

  run(
    'INSERT INTO templates (kind, name, payload, created_at) VALUES (?,?,?,?)',
    'task', 'בריף עיצובי לספק',
    JSON.stringify({ title: 'בריף עיצובי — ', priority: 'high', checklist: ['איסוף דרישות', 'ניסוח בריף', 'אישור תקציב', 'העברה לספק'] }),
    ts
  );
  run(
    'INSERT INTO templates (kind, name, payload, created_at) VALUES (?,?,?,?)',
    'project', 'פרויקט תערוכה',
    JSON.stringify({ name: 'תערוכה — ', tasks: ['אישור בריף עיצובי', 'תיאום לוגיסטי', 'הכנת חומרי שיווק', 'הדרכת צוות המכירות', 'סיכום והפקת לקחים'] }),
    ts
  );

  console.log('[משימון] נוצרו נתוני דמו התחלתיים.');
}

module.exports = {
  db, DB_PATH, UPLOADS_DIR, ROOT, STORAGE,
  all, get, run,
  nowIso, hashPassword, verifyPassword,
  getSetting, setSetting, allSettings,
  audit, notify,
  internalBoard, createVendorBoard, boardColumns, ensureBoardColumns,
  INTERNAL_COLUMNS, VENDOR_COLUMNS, DEFAULT_SETTINGS,
  bootstrap, seedDemoData, ensureFirstAdmin
};
