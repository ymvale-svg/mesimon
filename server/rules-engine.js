'use strict';
/**
 * מנוע הכללים — האוטומציות, התזכורות וההקפצות של המערכת.
 *
 * עקרון המימוש: הוספת כלל חדש אינה דורשת שינוי מבני במערכת.
 * כל טריגר הוא פונקציה ברישום TRIGGERS, כל פעולה היא פונקציה ברישום ACTIONS,
 * והחיבור ביניהם נשמר בטבלת automation_rules וניתן לעריכה ממסך הניהול.
 *
 * להוספת כלל חדש: מוסיפים ערך ל-TRIGGERS או ל-ACTIONS, ומגדירים רשומה בטבלה.
 * כל הפרמטרים המספריים נקראים מטבלת ההגדרות ולא מקודדים בקוד.
 */
const D = require('./db');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const parseJson = (text, fallback = {}) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

/** ערך פרמטר: אם הכלל מפנה להגדרה מערכתית — נקרא משם; אחרת ערך ישיר */
function paramValue(params, directKey, settingKey, fallback) {
  if (params[directKey] !== undefined && params[directKey] !== null && params[directKey] !== '') {
    return Number(params[directKey]);
  }
  const settingName = params[settingKey];
  if (settingName) return Number(D.getSetting(settingName, fallback));
  return Number(fallback);
}

/**
 * מי מקבל התראה על משימה.
 *
 * עד כה נשלחה ההתראה לכל מנהל וכל אדמין בארגון, בלי קשר למשימה — ולכן
 * מנהלת השיווק קיבלה התראות על משימות של מחלקה אחרת, ורשימת ההתראות שלה
 * התמלאה ברעש שאינו שלה. ההתראה נשלחת עכשיו רק למי שהמשימה בתחומו:
 * האחראי עליה, מנהל הפרויקט, ומנהל המחלקה שאליה היא משויכת. מי שרואה את
 * כל הארגון (הנהלה ומנהלי מערכת) מקבל את התמונה מהדוחות ומהלוח, ואינו
 * צריך התראה על כל משימה של כל מחלקה.
 */
function alertTargets(task) {
  const ids = new Set();
  const add = (id) => { if (id) ids.add(id); };

  if (task.assignee_type === 'user') add(task.assignee_id);
  if (task.project_id) add(D.get('SELECT manager_id FROM projects WHERE id = ?', task.project_id)?.manager_id);

  // המחלקה של המשימה, ואם אין לה שיוך — המחלקה של האחראי עליה
  const departmentId = task.department_id
    ?? (task.assignee_type === 'user' && task.assignee_id
      ? D.get('SELECT department_id FROM users WHERE id = ?', task.assignee_id)?.department_id
      : null);

  if (departmentId) {
    add(D.get('SELECT manager_user_id FROM departments WHERE id = ?', departmentId)?.manager_user_id);
    // גם מנהל שמשויך למחלקה בלי שהוגדר כמנהל הרשמי שלה
    for (const m of D.all(
      "SELECT id FROM users WHERE role = 'manager' AND status = 'active' AND department_id = ?", departmentId
    )) add(m.id);
  }

  return D.all(
    `SELECT id, full_name FROM users WHERE status = 'active' AND id IN (${[...ids].map(() => '?').join(',') || 'NULL'})`,
    ...ids
  );
}

const isFinalStatus = (task) => {
  const col = D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status);
  return col ? !!col.is_final : false;
};

const statusLabel = (task) => {
  const col = D.get('SELECT label FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status);
  return col ? col.label : task.status;
};

/** משימות "חיות": לא בארכיון, לא בסטטוס סופי, וכבר הופעלו (חלף תאריך ההפעלה) */
function activeTasks() {
  const now = D.nowIso();
  return D.all(
    `SELECT t.*, b.type AS board_type, p.name AS project_name
       FROM tasks t
       JOIN boards b ON b.id = t.board_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.archived = 0
        AND (t.activate_at IS NULL OR t.activate_at <= ?)`,
    now
  );
}

function alreadyFired(ruleId, taskId, marker) {
  return D.get('SELECT 1 FROM rule_fires WHERE rule_id = ? AND task_id = ? AND marker = ?', ruleId, taskId, marker) !== undefined;
}

function markFired(ruleId, taskId, marker) {
  D.run(
    'INSERT OR IGNORE INTO rule_fires (rule_id, task_id, marker, fired_at) VALUES (?,?,?,?)',
    ruleId, taskId, marker, D.nowIso()
  );
}

// ---------------------------------------------------------------------------
// טריגרים — כל טריגר מחזיר רשימת אירועים { task, marker, meta }
// ---------------------------------------------------------------------------

const TRIGGERS = {
  /** X ימים לפני תאריך היעד: תזכורת ראשונה לספק */
  vendor_due_soon: {
    label: 'X ימים לפני תאריך היעד (משימת ספק)',
    paramsSchema: [{ key: 'days_before', label: 'ימים לפני היעד', type: 'number', settingKey: 'vendor_reminder_days_before' }],
    evaluate(rule, params, now) {
      const days = paramValue(params, 'days_before', 'days_before_setting', 3);
      const events = [];
      for (const task of activeTasks()) {
        if (task.assignee_type !== 'vendor' || !task.due_date) continue;
        if (isFinalStatus(task)) continue;
        const due = new Date(task.due_date).getTime();
        const diff = due - now;
        if (diff > 0 && diff <= days * DAY) {
          events.push({ task, marker: `due:${task.due_date}`, meta: { days } });
        }
      }
      return events;
    }
  },

  /** Y שעות לפני תאריך היעד: התראה מקדימה למנהל */
  manager_pre_due: {
    label: 'Y שעות לפני תאריך היעד (התראה מקדימה למנהל)',
    paramsSchema: [{ key: 'hours_before', label: 'שעות לפני היעד', type: 'number', settingKey: 'manager_alert_hours_before' }],
    evaluate(rule, params, now) {
      const hours = paramValue(params, 'hours_before', 'hours_before_setting', 24);
      const events = [];
      for (const task of activeTasks()) {
        if (!task.due_date || isFinalStatus(task)) continue;
        const diff = new Date(task.due_date).getTime() - now;
        if (diff > 0 && diff <= hours * HOUR) {
          events.push({ task, marker: `pre:${task.due_date}`, meta: { hours } });
        }
      }
      return events;
    }
  },

  /** חריגה בפועל מתאריך היעד */
  task_overdue: {
    label: 'חריגה בפועל מתאריך היעד',
    paramsSchema: [],
    evaluate(rule, params, now) {
      const events = [];
      for (const task of activeTasks()) {
        if (!task.due_date || isFinalStatus(task)) continue;
        if (new Date(task.due_date).getTime() < now) {
          events.push({ task, marker: `overdue:${task.due_date}`, meta: {} });
        }
      }
      return events;
    }
  },

  /** משימה דחופה שסטטוסה לא השתנה פרק זמן קצוב */
  urgent_stale: {
    label: "משימה בעדיפות 'דחוף' שסטטוסה לא השתנה",
    paramsSchema: [{ key: 'hours', label: 'שעות ללא שינוי סטטוס', type: 'number', settingKey: 'escalation_hours_urgent' }],
    evaluate(rule, params, now) {
      const hours = paramValue(params, 'hours', 'hours_setting', 24);
      const events = [];
      for (const task of activeTasks()) {
        if (task.priority !== 'urgent' || isFinalStatus(task)) continue;
        const since = new Date(task.status_changed_at ?? task.created_at).getTime();
        if (now - since >= hours * HOUR) {
          events.push({ task, marker: `stale:${task.status_changed_at}`, meta: { hours } });
        }
      }
      return events;
    }
  },

  /** הגיע מועד יצירת המופע הבא של משימה חוזרת */
  recurring_due: {
    label: 'הגיע מועד המופע הבא של משימה חוזרת',
    paramsSchema: [],
    evaluate(rule, params, now) {
      const events = [];
      for (const task of D.all('SELECT * FROM tasks WHERE is_recurring = 1 AND archived = 0')) {
        if (!task.recurrence_freq) continue;
        const anchor = new Date(task.last_spawned_at ?? task.due_date ?? task.created_at).getTime();
        const next = nextOccurrence(anchor, task.recurrence_freq);
        if (next <= now) {
          events.push({ task, marker: `rec:${new Date(next).toISOString().slice(0, 10)}`, meta: { next } });
        }
      }
      return events;
    }
  },

  /** הגיע תאריך ההפעלה של משימה עתידית */
  scheduled_activation: {
    label: 'הגיע תאריך ההפעלה של משימה עתידית',
    paramsSchema: [],
    evaluate(rule, params, now) {
      const events = [];
      for (const task of D.all('SELECT * FROM tasks WHERE activate_at IS NOT NULL AND archived = 0')) {
        if (new Date(task.activate_at).getTime() <= now) {
          events.push({ task, marker: `act:${task.activate_at}`, meta: {} });
        }
      }
      return events;
    }
  },

  /** דוגמה לכלל שניתן להוסיף ללא שינוי מבני: משימה ללא אחראי */
  unassigned_task: {
    label: 'משימה ללא אחראי מעל N שעות',
    paramsSchema: [{ key: 'hours', label: 'שעות ללא שיוך', type: 'number' }],
    evaluate(rule, params, now) {
      const hours = paramValue(params, 'hours', '_none', 48);
      const events = [];
      for (const task of activeTasks()) {
        if (task.assignee_id || isFinalStatus(task)) continue;
        if (now - new Date(task.created_at).getTime() >= hours * HOUR) {
          events.push({ task, marker: 'unassigned', meta: { hours } });
        }
      }
      return events;
    }
  }
};

function nextOccurrence(anchorMs, freq) {
  const d = new Date(anchorMs);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// פעולות
// ---------------------------------------------------------------------------

const ACTIONS = {
  notify_vendor: {
    label: 'שליחת תזכורת לספק',
    run(rule, event) {
      const { task, meta } = event;
      if (task.assignee_type !== 'vendor') return false;
      D.notify({
        targetType: 'vendor',
        targetId: task.assignee_id,
        kind: 'vendor_reminder',
        title: 'תזכורת: מתקרב תאריך היעד',
        body: `המשימה "${task.title}" אמורה להסתיים עד ${formatDate(task.due_date)}.`,
        taskId: task.id
      });
      D.audit(task.id, null, 'automation', `${rule.name}: נשלחה תזכורת לספק (${meta.days} ימים לפני היעד)`);
      return true;
    }
  },

  notify_managers: {
    label: 'התראה לאחראי ולמנהל המחלקה',
    run(rule, event) {
      const { task } = event;
      const overdue = task.due_date && new Date(task.due_date).getTime() < Date.now();
      for (const m of alertTargets(task)) {
        D.notify({
          targetType: 'user',
          targetId: m.id,
          kind: overdue ? 'overdue' : 'manager_alert',
          title: overdue ? 'חריגה מתאריך יעד' : 'מתקרב תאריך יעד',
          body: `המשימה "${task.title}" — יעד ${formatDate(task.due_date)}, סטטוס: ${statusLabel(task)}.`,
          taskId: task.id
        });
      }
      D.audit(task.id, null, 'automation', `${rule.name}: נשלחה התראה לאחראי ולמנהל המחלקה`);
      return true;
    }
  },

  escalate_to_managers: {
    label: 'הקפצה והדגשה בתצוגת המנהל',
    run(rule, event) {
      const { task, meta } = event;
      D.run('UPDATE tasks SET escalated = 1 WHERE id = ?', task.id);
      for (const m of alertTargets(task)) {
        D.notify({
          targetType: 'user',
          targetId: m.id,
          kind: 'escalation',
          title: 'הקפצה: משימה דחופה תקועה',
          body: `המשימה "${task.title}" בעדיפות דחוף לא שינתה סטטוס מעל ${meta.hours} שעות.`,
          taskId: task.id
        });
      }
      D.audit(task.id, null, 'automation', `${rule.name}: המשימה הוקפצה לתשומת לב המנהלים`);
      return true;
    }
  },

  spawn_recurring: {
    label: 'יצירת מופע הבא של משימה חוזרת',
    run(rule, event) {
      const { task, meta } = event;

      // מדיניות ברירת מחדל: לא נוצר מופע כפול עד לסגירת הקודם.
      // המדיניות ניתנת לשינוי ברמת המשימה הבודדת (recurrence_policy).
      const policy = task.recurrence_policy === 'inherit'
        ? D.getSetting('recurring_default_policy', 'skip_if_open')
        : task.recurrence_policy;

      if (policy === 'skip_if_open') {
        const openChild = D.get(
          `SELECT t.id FROM tasks t
             JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
            WHERE t.recurrence_parent = ? AND c.is_final = 0 AND t.archived = 0`,
          task.id
        );
        const parentOpen = !isFinalStatus(task);
        if (openChild || parentOpen) {
          D.run('UPDATE tasks SET last_spawned_at = ? WHERE id = ?', new Date(meta.next).toISOString(), task.id);
          D.audit(task.id, null, 'automation', `${rule.name}: המופע הבא נדחה — המופע הקודם עדיין פתוח`);
          return true;
        }
      }

      const nextDue = new Date(meta.next).toISOString();
      const res = D.run(
        `INSERT INTO tasks
          (title, description, project_id, board_id, assignee_type, assignee_id, status, priority,
           due_date, created_at, created_by, status_changed_at, is_recurring, recurrence_freq,
           recurrence_policy, recurrence_parent)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'inherit',?)`,
        task.title, task.description, task.project_id, task.board_id,
        task.assignee_type, task.assignee_id,
        firstColumnKey(task.board_id), task.priority,
        nextDue, D.nowIso(), task.created_by, D.nowIso(), task.id
      );
      D.run('UPDATE tasks SET last_spawned_at = ? WHERE id = ?', nextDue, task.id);
      const newId = Number(res.lastInsertRowid);
      D.audit(newId, null, 'created', `נוצר אוטומטית כמופע חוזר של משימה #${task.id}`);
      D.audit(task.id, null, 'automation', `${rule.name}: נוצר מופע חדש #${newId}`);
      if (task.assignee_type === 'user' && task.assignee_id) {
        D.notify({
          targetType: 'user', targetId: task.assignee_id, kind: 'assignment',
          title: 'נוצרה משימה חוזרת חדשה', body: task.title, taskId: newId
        });
      }
      return true;
    }
  },

  activate_task: {
    label: 'הפעלת משימה עתידית',
    run(rule, event) {
      const { task } = event;
      D.run('UPDATE tasks SET activate_at = NULL WHERE id = ?', task.id);
      D.audit(task.id, null, 'automation', `${rule.name}: המשימה הופעלה והצטרפה לרשימות הפעילות`);
      if (task.assignee_type && task.assignee_id) {
        D.notify({
          targetType: task.assignee_type === 'vendor' ? 'vendor' : 'user',
          targetId: task.assignee_id,
          kind: 'assignment',
          title: 'משימה מתוזמנת הופעלה',
          body: task.title,
          taskId: task.id
        });
      }
      return true;
    }
  }
};

function firstColumnKey(boardId) {
  const col = D.get('SELECT key FROM board_columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId);
  return col ? col.key : 'new';
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// הרצה
// ---------------------------------------------------------------------------

function runOnce() {
  const now = Date.now();
  const summary = { ranAt: new Date(now).toISOString(), rules: [] };

  for (const rule of D.all('SELECT * FROM automation_rules WHERE enabled = 1 ORDER BY id')) {
    const trigger = TRIGGERS[rule.trigger_key];
    const action = ACTIONS[rule.action_key];
    if (!trigger || !action) {
      summary.rules.push({ rule: rule.name, error: 'טריגר או פעולה לא מוכרים' });
      continue;
    }
    const params = parseJson(rule.params);
    let fired = 0;
    try {
      for (const event of trigger.evaluate(rule, params, now)) {
        if (alreadyFired(rule.id, event.task.id, event.marker)) continue;
        const ok = action.run(rule, event);
        if (ok) {
          markFired(rule.id, event.task.id, event.marker);
          fired++;
        }
      }
      D.run('UPDATE automation_rules SET last_run_at = ? WHERE id = ?', new Date(now).toISOString(), rule.id);
      summary.rules.push({ rule: rule.name, fired });
    } catch (err) {
      summary.rules.push({ rule: rule.name, error: err.message });
      console.error(`[משימון] שגיאה בכלל "${rule.name}":`, err.message);
    }
  }
  return summary;
}

let timer = null;

function start() {
  const minutes = Number(D.getSetting('scheduler_interval_minutes', 5)) || 5;
  stop();
  runOnce();
  timer = setInterval(runOnce, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  console.log(`[משימון] מנוע האוטומציות פועל — הרצה כל ${minutes} דקות.`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const catalog = () => ({
  triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, paramsSchema: t.paramsSchema })),
  actions: Object.entries(ACTIONS).map(([key, a]) => ({ key, label: a.label }))
});

module.exports = { TRIGGERS, ACTIONS, runOnce, start, stop, catalog, firstColumnKey, isFinalStatus, statusLabel, formatDate, alertTargets };
