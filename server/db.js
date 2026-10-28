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
  created_at    TEXT    NOT NULL,
  -- מתי נרשם דרך לינק ההרשמה. מי שיש לו תאריך כאן ואינו פעיל — ממתין
  -- לאישור, ולא עובד שהושבת. אותו סטטוס, שתי משמעויות שונות לגמרי.
  signup_at     TEXT
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
  color       TEXT    NOT NULL DEFAULT '',
  /*
   * איזו רשימת סטטוסי בקרה חלה על הפרויקט — המשתמש שבנה אותה. ‎NULL‎ פירושו
   * שלא נבחרה רשימה, ואז שורות הפרויקט אינן נצבעות כלל.
   */
  status_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  /*
   * תת-פרויקט. ‎SET NULL‎ ולא ‎CASCADE‎ בכוונה, להבדיל מתת-משימה: מחיקת
   * פרויקט אב אינה אמורה למחוק את הפרויקטים שתחתיו ואת כל המשימות שבהם —
   * הם עולים לרמה הראשית ונשארים.
   */
  parent_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
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
  escalated          INTEGER NOT NULL DEFAULT 0,
  /*
   * תת-משימה. שדה על ‎tasks‎ ולא טבלה נפרדת, מפני שתת-משימה *היא* משימה:
   * אצל מי שקיבל אותה היא מופיעה בלוח ובדף הבית כמו כל משימה, עם סטטוס,
   * יעד, שרשור, קבצים והתראות. טבלה נפרדת הייתה מחייבת לשכפל את כל אלה,
   * ולבנות כל תכונה עתידית פעמיים.
   */
  parent_task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  /*
   * סטטוס בטקסט חופשי, שורה אחת: "ממתין לטופס 360", "אושר מחיר". זה מה
   * שמופיע בטבלת הבקרה, ולכן הוא שדה ולא תגובה. העדכון המפורט נשאר בשרשור
   * התגובות — שם יש לו היסטוריה, מחבר, זמן וקבצים, ושדה שנדרס בכל עדכון
   * היה מוחק בדיוק את מה שמעניין בבקרה.
   */
  status_short       TEXT    NOT NULL DEFAULT '',
  /*
   * הופקד ואינו בשימוש: בגרסה הראשונה סטטוס הבקרה היה מפתח מרשימה סגורה
   * בקוד. הרשימה עברה לטבלה ‎task_statuses‎ שהמשתמש בונה, והשיוך עובר דרך
   * ‎track_status_id‎. העמודה נשארת כי הסרת עמודה ב-SQLite מחייבת בניית
   * הטבלה מחדש, וזה מחיר גבוה מדי עבור שדה ריק.
   */
  track_status       TEXT    NOT NULL DEFAULT '',
  /*
   * סטטוס הבקרה שנבחר למשימה. ‎SET NULL‎ — מחיקת סטטוס מהרשימה אינה מוחקת
   * את המשימות שסומנו בו, הן חוזרות ללא סטטוס.
   */
  track_status_id    INTEGER REFERENCES task_statuses(id) ON DELETE SET NULL
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

-- אחראים נוספים על משימה, מעבר לאחראי הראשי שיושב על tasks.assignee_id.
--
-- טבלה נפרדת ולא עמודה שנייה: לא כל משימה מתחלקת בין שניים בדיוק, ועמודה
-- שנייה הייתה מחייבת שלישית ורביעית בכל פעם שמישהו מבקש עוד אחד.
--
-- האחראי הראשי נשאר על tasks ואינו עובר לכאן, וזו החלטה מכוונת: הוא לא רק
-- שיוך אלא גם ניתוב — סוג האחראי קובע באיזה בורד המשימה יושבת, לאיזו מחלקה
-- היא נספרת ואיזו זרימת סטטוסים חלה עליה. אחראי נוסף אינו מזיז דבר מאלה,
-- ובדיוק לכן הוא יכול להיות ספק בזמן שהאחראי הראשי הוא עובד פנימי — שני
-- בורדים לאותה משימה אינם אפשריים, ושתי אחריויות כן.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_type TEXT    NOT NULL CHECK (assignee_type IN ('user','vendor')),
  assignee_id   INTEGER NOT NULL,
  added_at      TEXT    NOT NULL,
  added_by      INTEGER REFERENCES users(id),
  PRIMARY KEY (task_id, assignee_type, assignee_id)
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

/*
 * העדפות תצוגה אישיות — חתך הלוח, מצב התצוגה וכדומה.
 *
 * נשמרות בשרת ולא רק ב-‎localStorage‎ מפני ש-‎localStorage‎ הוא לכל דפדפן
 * בנפרד: מי שעובד במשרד ובנייד, או שהתחבר מדפדפן אחר, חזר בכל פעם לחתך
 * ריק והרגיש שההעדפה לא נשמרה. כאן היא הולכת אחרי המשתמש.
 *
 * ‎value‎ הוא JSON חופשי — אין כאן סכימה לכל מפתח, כי אלה העדפות ממשק
 * שמשתנות עם המסכים ולא נתונים שמישהו שואל עליהם שאילתות.
 */
/*
 * הרשמות להתראות דחיפה. שורה לכל מכשיר ולא לכל משתמש — לאדם אחד יש מחשב
 * וטלפון, ולכל אחד מהם endpoint משלו אצל שירות הדחיפה.
 *
 * ‎endpoint‎ ייחודי: אותו מכשיר שנרשם מחדש מעדכן את שורתו ואינו מוסיף שורה.
 */
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

/*
 * סטטוסי בקרה — רשימה שכל משתמש בונה לעצמו, ומוחלת על פרויקט.
 *
 * טבלה ולא רשימה בקוד, כי המשתמש מוסיף, עורך, מוחק ובוחר צבעים. ‎user_id‎
 * הוא מי שבנה את הרשימה: הבנייה אישית, אבל השימוש הוא ברמת הפרויקט — פרויקט
 * מצביע על רשימה אחת, וכל מי שרואה את הפרויקט רואה את אותם צבעים. אחרת אותה
 * טבלת בקרה הייתה נראית שונה לכל אדם, ובקרה משותפת דורשת שפה משותפת.
 *
 * ‎position‎ קובע את הסדר בבורר; אין משמעות סמנטית לסדר.
 */
CREATE TABLE IF NOT EXISTS task_statuses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  color      TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

/*
 * תבניות משימה ופרויקט.
 *
 * ‎department_id‎ הוא היקף הראייה: תבנית שייכת למחלקה שיצרה אותה, ועובדי
 * מחלקה אחת אינם רואים את התבניות של השנייה — "רישום רכב גישור" של התפעול
 * אינו רלוונטי לשיווק, ורשימה מעורבת הופכת את הבורר לבלתי שמיש.
 * ‎NULL‎ פירושו תבנית ארגונית שרואים כולם, וזה גם המצב של תבניות שנוצרו
 * לפני ההפרדה.
 */
CREATE TABLE IF NOT EXISTS templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('task','project')),
  name          TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  updated_at    TEXT,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL
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
-- האינדקס ההופכי: המפתח הראשי נפתח ב-task_id, אבל השאילתה השכיחה היא
-- ההפוכה — "אילו משימות אני אחראי עליהן" — והיא זו שרצה בכל רשימת משימות
CREATE INDEX IF NOT EXISTS idx_task_assignees_who ON task_assignees(assignee_type, assignee_id);
CREATE INDEX IF NOT EXISTS idx_notif_target   ON notifications(target_type, target_id, is_read);
CREATE INDEX IF NOT EXISTS idx_audit_task     ON audit_log(task_id);

/*
 * משימת AI — בקשה מאדם מסוים, שה-AI מנסח, שולח ועוקב אחריה עד שהיא מתקבלת.
 *
 * טבלה נלווית ולא עמודות על ‎tasks‎: משימת AI *היא* משימה — היא מופיעה בלוח,
 * בדף הבית ובבקרה כמו כל משימה — וכאן נשמר רק מה שייחודי למעקב. כך כל מה
 * שכבר עובד על משימות (פרויקט, יעד, קבצים, שרשור, היסטוריה) עובד גם עליה.
 */
CREATE TABLE IF NOT EXISTS ai_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id            INTEGER NOT NULL REFERENCES users(id),
  instruction         TEXT    NOT NULL,             -- מה שהמשתמש כתב, כלשונו
  goal                TEXT    NOT NULL DEFAULT '',  -- הבקשה בניסוח של ה-AI
  success_criteria    TEXT    NOT NULL DEFAULT '',  -- מתי נחשב שהתקבל
  contact_name        TEXT    NOT NULL DEFAULT '',
  contact_email       TEXT    NOT NULL DEFAULT '',
  contact_phone       TEXT    NOT NULL DEFAULT '',
  contact_type        TEXT    NOT NULL DEFAULT 'external' CHECK (contact_type IN ('external','vendor','user')),
  contact_ref_id      INTEGER,
  -- draft | waiting | needs_user | paused | stalled | completed | stopped
  state               TEXT    NOT NULL DEFAULT 'draft',
  policy              TEXT    NOT NULL DEFAULT '{}',
  -- ניסיונות רצופים שלא נענו — מתאפס בכל תשובה של הנמען
  unanswered_email    INTEGER NOT NULL DEFAULT 0,
  unanswered_whatsapp INTEGER NOT NULL DEFAULT 0,
  next_action_at      TEXT,
  last_outbound_at    TEXT,
  last_inbound_at     TEXT,
  owner_question      TEXT    NOT NULL DEFAULT '',  -- שאלה פתוחה שה-AI מחכה שהמשתמש יענה עליה
  -- למה המעקב מחכה למשתמש: approve_reminder | contact_detected | handled_elsewhere. ריק = אין עצירה מיוחדת
  attention           TEXT    NOT NULL DEFAULT '',
  contact_checked_at  TEXT,                         -- הבדיקה האחרונה בתיבת ה-Gmail: כתבתי לנמען / הוא ענה ישירות אליי
  last_summary        TEXT    NOT NULL DEFAULT '',
  error               TEXT    NOT NULL DEFAULT '',
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  closed_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_requests_due ON ai_requests(state, next_action_at);

/* כל הודעה שיצאה או נכנסה במסגרת המעקב, בכל ערוץ */
CREATE TABLE IF NOT EXISTS ai_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE,
  direction    TEXT    NOT NULL CHECK (direction IN ('out','in')),
  -- ‎note‎ — עדכון שהמשתמש רשם ("דיברתי איתו") או קשר שזוהה בערוץ אחר. אינו נשלח לאיש
  channel      TEXT    NOT NULL CHECK (channel IN ('email','whatsapp','note')),
  -- initial | reminder | reply | thanks | inbound | manual (עדכון ידני) | owner_contact (המשתמש כתב לנמען בעצמו)
  kind         TEXT    NOT NULL,
  -- pending_approval | sent | failed | received | discarded
  status       TEXT    NOT NULL,
  subject      TEXT    NOT NULL DEFAULT '',
  body         TEXT    NOT NULL DEFAULT '',
  message_id   TEXT,                    -- Message-ID של המייל, לשרשור ולזיהוי תשובה
  external_id  TEXT,                    -- וואטסאפ: מזהה ההודעה אצל הספק. מייל: השרשור ב-Gmail של השולח
  gmail_id     TEXT,                    -- מייל שיצא מתיבת המשתמש: המזהה שלו ב-Gmail, כדי לא לזהות אותו כ"כתבת בעצמך"
  from_address TEXT    NOT NULL DEFAULT '',
  verdict      TEXT,                    -- הכרעת ה-AI על הודעה נכנסת
  analysis     TEXT    NOT NULL DEFAULT '',
  attachment_ids TEXT  NOT NULL DEFAULT '[]',
  error        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  sent_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_req ON ai_messages(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_mid ON ai_messages(message_id);

/*
 * ערוצי שליחה אישיים — כרגע וואטסאפ מהמספר של המשתמש. האסימון יושב כאן
 * ולא בהעדפות המשתמש, כי ההעדפות נשלחות ללקוח ב-bootstrap.
 */
CREATE TABLE IF NOT EXISTS user_channels (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT    NOT NULL,
  api_url     TEXT    NOT NULL DEFAULT '',
  instance_id TEXT    NOT NULL DEFAULT '',
  api_token   TEXT    NOT NULL DEFAULT '',
  phone       TEXT    NOT NULL DEFAULT '',
  state       TEXT    NOT NULL DEFAULT 'unknown',
  checked_at  TEXT,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, provider)
);

/*
 * חיבור Gmail אישי — קריאה בלבד. אסימון הרענון מוצפן (‎server/secrets.js‎),
 * כדי שהסריקה של הבוקר תעבוד גם כשהמשתמש אינו מחובר למערכת.
 */
CREATE TABLE IF NOT EXISTS mail_connections (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT    NOT NULL DEFAULT '',
  refresh_token  TEXT    NOT NULL DEFAULT '',   -- מוצפן
  scope          TEXT    NOT NULL DEFAULT '',
  state          TEXT    NOT NULL DEFAULT 'ok', -- ok | revoked | error
  error          TEXT    NOT NULL DEFAULT '',
  scan_running   INTEGER NOT NULL DEFAULT 0,
  scan_progress  TEXT    NOT NULL DEFAULT '{}',
  last_scan_at   TEXT,
  created_at     TEXT    NOT NULL
);

/*
 * כל מייל שנסרק, פעם אחת לכל תיבה. ‎header_id‎ הוא ה-Message-ID של המייל —
 * זהה בכל התיבות שקיבלו אותו — ועליו נשענת מניעת הכפילויות בין עובדים.
 */
CREATE TABLE IF NOT EXISTS mail_scanned (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gmail_id    TEXT    NOT NULL,
  header_id   TEXT,
  outcome     TEXT    NOT NULL,   -- suggested | skipped | reply | duplicate | not_mine | error
  scanned_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_scanned_header ON mail_scanned(header_id);

/*
 * הצעות שה-AI הכין מהמייל וממתינות להחלטה. ‎data‎ — ההצעה עצמה: כותרת,
 * תיאור, צ'קליסט, יעד, אנשים ובקשת AI אם יש.
 */
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- task | duplicate (המייל כבר הפך למשימה אצל מישהו אחר)
  kind          TEXT    NOT NULL DEFAULT 'task',
  -- pending | approved | rejected | auto (נוצרה בלי אישור) | undone | joined | skipped
  status        TEXT    NOT NULL DEFAULT 'pending',
  gmail_id      TEXT    NOT NULL DEFAULT '',
  header_id     TEXT,
  from_name     TEXT    NOT NULL DEFAULT '',
  from_email    TEXT    NOT NULL DEFAULT '',
  subject       TEXT    NOT NULL DEFAULT '',
  received_at   TEXT,
  data          TEXT    NOT NULL DEFAULT '{}',
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_user ON ai_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_header ON ai_suggestions(header_id);

/*
 * אנשי הקשר של Google — עותק מקומי לכל משתמש, כדי שהחיפוש באשף משימת AI
 * יהיה מיידי ובעברית, בלי שאילתה ל-Google בכל הקלדה. ‎source‎:
 * ‎contacts‎ (שמורים) · ‎other‎ (התכתבתי ולא שמרתי) · ‎directory‎ (ספריית הארגון).
 * נראים רק לבעליהם, ונמחקים בניתוק החיבור.
 */
CREATE TABLE IF NOT EXISTS google_contacts (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_name  TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  name           TEXT    NOT NULL DEFAULT '',
  emails         TEXT    NOT NULL DEFAULT '[]',
  phones         TEXT    NOT NULL DEFAULT '[]',
  organization   TEXT    NOT NULL DEFAULT '',
  title          TEXT    NOT NULL DEFAULT '',
  photo_url      TEXT    NOT NULL DEFAULT '',
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (user_id, resource_name)
);

CREATE TABLE IF NOT EXISTS google_contact_sync (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  running      INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  counts       TEXT    NOT NULL DEFAULT '{}',
  error        TEXT    NOT NULL DEFAULT ''
);

/* כתובות שעליהן המשתמש אמר "לא, תודה" להצעה לשמור באנשי הקשר — לא שואלים שוב */
CREATE TABLE IF NOT EXISTS contact_save_dismissed (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, address)
);

/* שולחים מיוחדים לכל משתמש: ‎trust‎ — משימות נוצרות ישר, בלי אישור; ‎ignore‎ — לא מציעים מהם משימות */
CREATE TABLE IF NOT EXISTS mail_trusted_senders (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  mode        TEXT    NOT NULL DEFAULT 'trust' CHECK (mode IN ('trust','ignore')),
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, email)
);
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

/**
 * העדפות אישיות. ספקים אינם משתמשים ואין להם שורה בטבלה, ולכן הם מקבלים
 * אובייקט ריק ונשארים עם ההעדפות שנשמרות במכשיר — אין להם מסכים שמצדיקים
 * יותר מזה.
 */
function userPrefs(userId) {
  const out = {};
  if (!userId) return out;
  for (const row of all('SELECT key, value FROM user_prefs WHERE user_id = ?', userId)) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}

function setUserPref(userId, key, value) {
  if (!userId) return;
  // ‎null‎ מוחק את ההעדפה — כך "איפוס לברירת מחדל" אינו משאיר שורה מטעה
  if (value === null || value === undefined) {
    run('DELETE FROM user_prefs WHERE user_id = ? AND key = ?', userId, key);
    return;
  }
  run(
    `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    userId, key, JSON.stringify(value), nowIso()
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

/**
 * מאזינים ליצירת התראה. קיים בשביל דחיפת ההתראות (server/push.js): כל התראה
 * במערכת נוצרת דרך ‎notify‎, וזו הנקודה היחידה שמכסה את כולן — אחרת כל
 * נקודת קצה שמתווספת הייתה צריכה לזכור לדחוף בנפרד, ולשכוח.
 *
 * כאן ולא ב-push.js בגלל כיוון התלות: ‎push‎ נזקק ל-‎db‎, ואם ‎db‎ היה
 * נזקק ל-‎push‎ הייתה נוצרת תלות מעגלית.
 */
const notifyListeners = [];
const onNotify = (fn) => { if (typeof fn === 'function') notifyListeners.push(fn); };

/**
 * ‎push‎ הוא מידע נוסף שנוסע רק בהתראת הדחיפה ואינו נשמר במסד — למשל האם
 * אפשר להשיב מההתראה, ואם כן אם התשובה פנימית. שמירתו בטבלת ההתראות הייתה
 * מוסיפה עמודות שאין להן שום שימוש אחר.
 */
/**
 * האם המשתמש הזה מקבל התראות בזכות היותו *פותח* של משימה או פרויקט.
 *
 * מנהל מערכת ואדמין-על פותחים משימות ופרויקטים בשביל כל החברה — הם מקימים
 * את המערכת ולא עושים את העבודה. אם פתיחה נחשבת להם כהחזקה, תיבת ההתראות
 * שלהם מתמלאת בכל מה שקורה בארגון, ובתוכה נעלם מה שכן מיועד להם.
 *
 * הנהלה, מנהל מחלקה ועובד פנימי כן נחשבים: כשהם פותחים משימה זו העבודה שלהם.
 */
function countsAsOpener(userId) {
  if (!userId) return false;
  const role = get('SELECT role FROM users WHERE id = ?', userId)?.role;
  return !!role && !['superadmin', 'admin'].includes(role);
}

function notify({ targetType, targetId, kind, title, body = '', taskId = null, push = null }) {
  const res = run(
    'INSERT INTO notifications (target_type, target_id, kind, title, body, task_id, is_read, created_at) VALUES (?,?,?,?,?,?,0,?)',
    targetType,
    targetId,
    kind,
    title,
    body,
    taskId,
    nowIso()
  );
  /*
   * המזהה נמסר למאזינים כדי שההתראה שנדחפת למכשיר תישא את אותו ‎tag‎ שנושאת
   * ההתראה שהלקוח מציג בעצמו. תגיות שונות פירושן שתי התראות נפרדות על אותו
   * דבר, ואותה תגית פירושה שהשנייה מחליפה את הראשונה.
   */
  const id = Number(res.lastInsertRowid);
  // כשל אצל מאזין אינו מבטל את ההתראה עצמה — היא כבר נשמרה
  for (const fn of notifyListeners) {
    try { fn({ id, targetType, targetId, kind, title, body, taskId, push }); } catch { /* בשקט */ }
  }
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
  // ‎wav‎ הוא הקלטת קול — הודעה קולית בתגובה או תיעוד שיחה מצורף למשימה
  // ‎eml‎ ו-‎msg‎ הם קובצי מייל שמורים — ‎eml‎ תקן פתוח, ‎msg‎ של Outlook
  allowed_extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'ai', 'psd', 'mp4', 'wav', 'eml', 'msg', 'txt', 'csv'],
  recurring_default_policy: 'skip_if_open', // לא נוצר מופע כפול עד לסגירת הקודם
  org_name: 'MESIMON',
  // כתובת המערכת כפי שמשתמשים מגיעים אליה — קישורי ההזמנות נבנים ממנה
  public_url: '',
  org_logo_note: '',
  /*
   * אסימון לינק ההרשמה. ריק = ההרשמה סגורה, וזו ברירת המחדל: מערכת שנפתחת
   * עם לינק הרשמה פעיל היא מערכת שכל מי שינחש את הכתובת ייכנס אליה.
   */
  signup_token: '',
  /*
   * צ'קליסט מלא סוגר את המשימה. דלוק כברירת מחדל — זו ההתנהגות המבוקשת,
   * וההגדרה קיימת בשביל צוות שמשתמש בצ'קליסט כרשימת מעקב במשימה ארוכה
   * שאינה נגמרת כשהרשימה נגמרת.
   */
  auto_done_on_checklist: true,

  /*
   * משימות AI — מדיניות המעקב. אלה ברירות המחדל; כל משימה יכולה לשנות
   * אותן לעצמה בזמן הפתיחה.
   */
  ai_model: 'claude-opus-5-5',
  ai_email_attempts: 2,                    // כמה מיילים שלא נענו לפני מעבר לוואטסאפ
  ai_days_between_emails: 2,
  ai_whatsapp_enabled: true,
  ai_whatsapp_attempts: 3,                 // כמה הודעות וואטסאפ שלא נענו לפני שעוצרים ומדווחים
  ai_days_between_whatsapp: 1,
  ai_send_window: '08:30-18:00',           // שעות שליחה, שעון ישראל
  ai_work_days_only: true,                 // בלי שישי ושבת
  ai_auto_thanks: true,                    // הודעת תודה קצרה כשהבקשה התקבלה
  ai_poll_minutes: 2,                      // תדירות בדיקת תשובות ושליחת תזכורות
  ai_approve_reminders: false,             // ברירת מחדל: תזכורות יוצאות לבד. כל משתמש וכל משימה יכולים לדרוש אישור
  ai_internal_attempts: 3,                 // משימת AI לעובד: תזכורות בתוך המערכת לפני עצירה

  /*
   * סריקת מיילים → משימות. נסרקים רק מיילים שלא נקראו, ורק אצל מי שחיבר
   * את תיבת ה-Gmail שלו.
   */
  ai_mail_scan_enabled: true,
  ai_scan_time: '07:00',                   // ריצת הבוקר, שעון ישראל
  ai_scan_daily_limit: 100                 // תקרת מיילים לסריקה ביום, לכל משתמש
};

/*
 * שלושה סטטוסים בבורד הפנימי, ולא יותר.
 *
 * 'חדש' הוא יום הפתיחה בלבד, ומהיום השני המשימה עוברת אוטומטית ל'בטיפול'
 * (הכלל ‎new_ages_to_in_progress‎ ב-BUILT_IN_RULES). כלומר הסטטוס אינו
 * שאלה שהמשתמש נדרש לענות עליה אלא עובדה על גיל המשימה, ומה שנשאר להחליט
 * הוא רק מתי היא הושלמה.
 *
 * 'ממתין לתשובה' הוסר. הוא נראה מדויק — משימה שהכדור בה אצל מישהו אחר —
 * אבל בפועל הוא הפך לחניה: משימות נכנסו אליו ולא יצאו, ואי אפשר היה לדעת
 * אם מחכים לתשובה שלושה ימים או שלושה שבועות. המידע הזה קיים כיום בשדות
 * שנועדו לו — תת-משימה עם אחראי, סטטוס מקוצר, ותאריך יעד.
 */
const INTERNAL_COLUMNS = [
  { key: 'new', label: 'חדש', position: 0, is_final: 0, color: '#64748b' },
  { key: 'in_progress', label: 'בטיפול', position: 1, is_final: 0, color: '#2563eb' },
  { key: 'done', label: 'הושלם', position: 2, is_final: 1, color: '#16a34a' }
];

/* הסטטוס שאליו עוברות משימות מסטטוס שהוסר, וגם מטרת ההזדקנות של 'חדש' */
const RETIRED_INTERNAL_STATUSES = { waiting_reply: 'in_progress' };

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
  },
  {
    // 'חדש' הוא יום הפתיחה בלבד — ראה ההסבר ב-INTERNAL_COLUMNS
    name: 'מעבר מ״חדש״ ל״בטיפול״ מהיום השני',
    trigger_key: 'new_task_aged',
    action_key: 'age_to_in_progress',
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
 * ‎ai_messages‎ נוצרה בגרסה ראשונה עם שני ערוצים בלבד (מייל, וואטסאפ).
 * עדכון ידני ("דיברתי איתו") נשמר כערוץ שלישי, ו-SQLite אינו משנה CHECK —
 * לכן הטבלה נבנית מחדש. רץ פעם אחת: אחרי הבנייה התנאי כבר כולל את ‎note‎.
 */
function relaxAiMessagesChannel() {
  const schema = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_messages'")?.sql ?? '';
  if (!schema || schema.includes("'note'")) return;
  const fresh = schema
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?ai_messages"?/, 'CREATE TABLE ai_messages_migrated')
    .replace("CHECK (channel IN ('email','whatsapp'))", "CHECK (channel IN ('email','whatsapp','note'))");
  const cols = db.prepare('PRAGMA table_info(ai_messages)').all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(fresh);
    db.exec(`INSERT INTO ai_messages_migrated (${cols}) SELECT ${cols} FROM ai_messages`);
    db.exec('DROP TABLE ai_messages');
    db.exec('ALTER TABLE ai_messages_migrated RENAME TO ai_messages');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_messages_req ON ai_messages(request_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_messages_mid ON ai_messages(message_id)');
    db.exec('COMMIT');
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
  relaxAiMessagesChannel();

  addColumn('users', 'department_id', 'INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  // קובץ שצורף לתגובה בשיחה — כדי שיוצג בתוך ההודעה שבה נשלח, ולא רק ברשימה
  addColumn('attachments', 'comment_id', 'INTEGER REFERENCES comments(id) ON DELETE SET NULL');
  // הערה: מסדי נתונים שנוצרו בגרסה קודמת מכילים עמודת tasks.level מהרמה
  // הארגונית שבוטלה. היא נותרת ריקה ואינה נקראת; מחיקת עמודה ב-SQLite
  // דורשת בניית טבלה מחדש, וזה סיכון מיותר עבור עמודה שאינה מפריעה.
  addColumn('tasks', 'department_id', 'INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  // תת-משימה והסטטוס המקוצר שלה — ראה ההסבר בהגדרת הטבלה
  addColumn('tasks', 'parent_task_id', 'INTEGER REFERENCES tasks(id) ON DELETE CASCADE');
  addColumn('tasks', 'status_short', "TEXT NOT NULL DEFAULT ''");
  // משימה שנולדה ממייל: מאיזו תיבה ואיזה מייל. הקישור למייל מוצג רק לבעל התיבה
  addColumn('tasks', 'source', "TEXT NOT NULL DEFAULT ''");
  addColumn('tasks', 'source_ref', 'TEXT');
  addColumn('tasks', 'source_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref)');
  addColumn('ai_requests', 'attention', "TEXT NOT NULL DEFAULT ''");
  addColumn('ai_requests', 'contact_checked_at', 'TEXT');
  addColumn('ai_messages', 'gmail_id', 'TEXT');
  // סטטוס הבקרה, שצובע את השורה במסך הבקרה
  addColumn('tasks', 'track_status', "TEXT NOT NULL DEFAULT ''");
  addColumn('tasks', 'track_status_id', 'INTEGER REFERENCES task_statuses(id) ON DELETE SET NULL');
  // תת-פרויקט, ורשימת הסטטוסים שחלה על הפרויקט
  addColumn('projects', 'parent_project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
  addColumn('projects', 'status_owner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // מי פתח את הפרויקט — הפרויקט נשאר ברשימה שלו גם אם מונה לו מנהל אחר
  addColumn('projects', 'created_by', 'INTEGER REFERENCES users(id)');
  // צבע הפרויקט — צובע את שורות המשימות שלו, לזיהוי במבט ולא בקריאה
  addColumn('projects', 'color', "TEXT NOT NULL DEFAULT ''");
  // סעיף צ'קליסט שיש בו תהליך: הערה חופשית ושרשור תגובות משלו
  addColumn('checklist_items', 'note', "TEXT NOT NULL DEFAULT ''");
  // מי שנרשם דרך הלינק וממתין לאישור — להבדיל מעובד שהושבת
  addColumn('users', 'signup_at', 'TEXT');
  addColumn('comments', 'checklist_item_id', 'INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE');
  // תבניות פר מחלקה. תבנית קיימת נשארת ללא מחלקה, כלומר ארגונית — מי שכבר
  // הסתמך עליה לא יגלה אותה נעלמת בעלייה לגרסה
  /*
   * סוגי קבצים שנוספו לרשימת המותרים אחרי שהמערכת כבר עלתה.
   *
   * ‎DEFAULT_SETTINGS‎ נכתב רק כשההגדרה אינה קיימת, ולכן הוספה לברירת
   * המחדל אינה מגיעה למערכת שכבר רצה — שם ההגדרה שמורה מזמן. בלי השורות
   * האלה השינוי היה עובד רק במסד חדש, וזה בדיוק מה שנראה כפיצ'ר שלא עובד.
   *
   * רק מה שחסר נוסף, והסדר נשמר — משתמש שהוסיף או הסיר סוגים בעצמו
   * במסך ההגדרות לא יאבד את הבחירה שלו.
   */
  const ADDED_EXTENSIONS = ['wav', 'eml', 'msg'];
  const currentExt = getSetting('allowed_extensions', null);
  if (Array.isArray(currentExt)) {
    const missing = ADDED_EXTENSIONS.filter((e) => !currentExt.includes(e));
    if (missing.length) setSetting('allowed_extensions', [...currentExt, ...missing]);
  }

  /*
   * ימי עבודה. ‎departments.work_days‎ — ימי השבוע (0 = ראשון) מופרדים בפסיק;
   * ריק = ברירת המחדל א׳–ה׳. ‎users.field_worker‎ — עובד שטח, שעובד גם בשישי
   * בלי שכל המחלקה שלו תעבוד בשישי. שבת לעולם אינה יום עבודה (‎server/workdays.js‎).
   *
   * מחלקת הנדסה מקבלת א׳–ו׳ פעם אחת, כשהעמודה נוצרת — ולא בכל עלייה, כדי
   * ששינוי שמנהל עשה במסך המחלקות לא יידרס.
   */
  if (!columns('departments').includes('work_days')) {
    addColumn('departments', 'work_days', "TEXT NOT NULL DEFAULT ''");
    run("UPDATE departments SET work_days = '0,1,2,3,4,5' WHERE name LIKE '%הנדסה%'");
  }
  addColumn('users', 'field_worker', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('templates', 'department_id', 'INTEGER REFERENCES departments(id) ON DELETE SET NULL');
  addColumn('templates', 'updated_at', 'TEXT');
  addColumn('templates', 'updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

  /**
   * סדר העמודות הוא סדר הזרימה, ולכן העמודה הסופית חייבת להיות אחרונה.
   * ‎ensureBoardColumns‎ מוסיף עמודה חדשה במיקום הקבוע שהוגדר לה בקוד, ובמסד
   * קיים המיקום הזה כבר תפוס — כך "ממתין לתשובה", שנוסף לבורד הפנימי, נחת
   * על אותו מספר כמו "הושלם". הסדר נבנה כאן מחדש בכל עלייה: הלא-סופיות לפי
   * סדרן הקיים, והסופית אחריהן.
   */
  /*
   * הסרת סטטוס שיצא משימוש מהבורד הפנימי.
   *
   * ‎ensureBoardColumns‎ עובד ב-INSERT OR IGNORE, ולכן הוצאת עמודה מהמערך
   * אינה מוחקת אותה ממסד קיים — היא רק מפסיקה להיווצר במסד חדש. בלי המחיקה
   * הזו הבורד הפנימי היה נשאר עם ארבעה סטטוסים אצל כל מי שהמערכת שלו כבר
   * רצה, וההגדרה בקוד הייתה משקרת.
   *
   * הסדר חשוב: קודם מזיזים את המשימות ואחר כך מוחקים את העמודה. ההפוך היה
   * משאיר משימות עם ‎status‎ שאין לו עמודה — ואז אין להן לא תווית, לא צבע
   * ולא מקום בלוח, והן נעלמות מהמסך בלי להיעלם מהמסד.
   *
   * בטוח להרצה חוזרת: אחרי המעבר הראשון אין עוד משימות בסטטוס הישן ואין
   * עמודה למחוק, ושתי הפעולות אינן עושות דבר.
   */
  const internal = get("SELECT id FROM boards WHERE type = 'internal' LIMIT 1");
  if (internal) {
    for (const [from, to] of Object.entries(RETIRED_INTERNAL_STATUSES)) {
      const moved = all('SELECT id FROM tasks WHERE board_id = ? AND status = ?', internal.id, from);
      if (moved.length) {
        run('UPDATE tasks SET status = ?, status_changed_at = ? WHERE board_id = ? AND status = ?',
          to, nowIso(), internal.id, from);
        // נרשם ביומן כדי שלא ייראה כאילו מישהו הזיז אותן ביד
        const label = get('SELECT label FROM board_columns WHERE board_id = ? AND key = ?', internal.id, from)?.label ?? from;
        for (const t of moved) {
          run(
            'INSERT INTO audit_log (task_id, actor_type, actor_id, actor_name, action, details, created_at) VALUES (?,?,?,?,?,?,?)',
            t.id, 'system', null, 'המערכת', 'status_changed',
            `הסטטוס "${label}" בוטל — המשימה הועברה לטיפול`, nowIso()
          );
        }
      }
      run('DELETE FROM board_columns WHERE board_id = ? AND key = ?', internal.id, from);
    }
  }

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
  userPrefs, setUserPref,
  audit, notify, onNotify, countsAsOpener,
  internalBoard, createVendorBoard, boardColumns, ensureBoardColumns,
  INTERNAL_COLUMNS, VENDOR_COLUMNS, DEFAULT_SETTINGS,
  bootstrap, seedDemoData, ensureFirstAdmin
};
