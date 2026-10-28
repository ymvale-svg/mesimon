'use strict';
/**
 * משימה מהקלטה — טקסט שהדפדפן תמלל הופך למשימה.
 *
 * הזרימה:
 *   1. הדפדפן מזהה את הדיבור (Web Speech API) — לשרת מגיע טקסט בלבד, לא קול.
 *   2. כאן: מזהים אם ההקלטה נפתחת ב"פתח משימה" (מילות ההפעלה), ומסירים אותן.
 *      הזיהוי בקוד ולא ב-AI, כדי שיהיה צפוי: מי שאמר "פתח משימה" יודע מה יקרה.
 *   3. Claude מפרק את השאר לשדות (הסקיל ‎ai/skills/voice-to-task.md‎).
 *   4. ברירות המחדל מוחלות כאן, בקוד ולא ב-AI — כדי שיהיו תמיד אותן ברירות:
 *      נושא — חובה · אחראי — אני · יעד — יום העבודה הבא · עדיפות — רגילה.
 *   5. יצירה ישירה רק כשהמשתמש בחר בה בהעדפות, ההקלטה נפתחה במילות ההפעלה,
 *      יש נושא, והמשימה רגילה. אחרת — טיוטה לתצוגה מקדימה. משימת AI תמיד
 *      עוברת דרך האשף, כי היא שולחת הודעה לאדם אחר.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('./db');
const P = require('./permissions');
const W = require('./workdays');
const Claude = require('./ai/claude');

const SKILL_PATH = path.join(__dirname, 'ai', 'skills', 'voice-to-task.md');
const MAX_TEXT = 4000;

// ---------------------------------------------------------------------------
// מילות ההפעלה
// ---------------------------------------------------------------------------

// מילים שנאמרות לפני הפקודה עצמה, וגם מילת ההשכמה "משימון"
const FILLERS = /^(?:\s*(?:אוקיי|אוקי|אוקיי?\s*משימון|טוב|היי|הי|הלו|שלום|בבקשה|תקשיב|תקשיבי|יאללה|נו|אז|משימון)[\s,.!?:;-]*)+/;
const OPEN_VERB = '(?:ת?פתח(?:י|ו)?|ת?פתחי)';
const AI_WORDS = '(?:AI|A\\.I\\.?|איי\\s*איי|אי\\s*איי|בינה(?:\\s+מלאכותית)?)';
const TRIGGER = new RegExp(
  `^${OPEN_VERB}\\s+(?:לי\\s+)?(?:` +
    `(?<ai>משימת\\s*${AI_WORDS})` +
    `|במשימון(?:\\s+(?:(?<ai2>משימת\\s*${AI_WORDS})|משימה(?:\\s+רגילה)?))?` +
    `|משימה(?:\\s+רגילה)?` +
  `)(?=$|[\\s,.:;!?-])[\\s,.:;!?-]*`,
  'i'
);

/**
 * @returns {{trigger: boolean, aiRequested: boolean, rest: string}}
 *   ‎rest‎ — הטקסט בלי מילות הפתיחה וההפעלה: תוכן המשימה
 */
function detectTrigger(text) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim().replace(FILLERS, '').trim();
  const m = TRIGGER.exec(cleaned);
  if (!m) return { trigger: false, aiRequested: false, rest: cleaned };
  return { trigger: true, aiRequested: Boolean(m.groups?.ai || m.groups?.ai2), rest: cleaned.slice(m[0].length).trim() };
}

// ---------------------------------------------------------------------------
// העדפות
// ---------------------------------------------------------------------------

const VOICE_DEFAULTS = { mode: 'preview', wake: false, wakeMinutes: 30 };

function prefs(userId) {
  const saved = D.userPrefs(userId).voice;
  return { ...VOICE_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

function cleanPrefs(input = {}, current = VOICE_DEFAULTS) {
  const out = { ...current };
  if (['preview', 'direct'].includes(input.mode)) out.mode = input.mode;
  if (typeof input.wake === 'boolean') out.wake = input.wake;
  if (input.wakeMinutes !== undefined) {
    const n = Math.round(Number(input.wakeMinutes));
    if (!Number.isFinite(n) || n < 5 || n > 240) throw new Error('משך ההאזנה חייב להיות בין 5 ל-240 דקות');
    out.wakeMinutes = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ההבנה
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'description', 'ai_instruction', 'assignee', 'due_date', 'due_heard', 'checklist',
    'priority', 'project', 'status_short', 'recurrence', 'activate_date', 'meeting', 'unclear'],
  properties: {
    kind: { type: 'string', enum: ['task', 'ai_task'] },
    title: { type: 'string' },
    description: { type: 'string' },
    ai_instruction: { type: 'string' },
    assignee: {
      type: 'object', additionalProperties: false, required: ['heard', 'match', 'confident'],
      properties: { heard: { type: 'string' }, match: { type: 'string' }, confident: { type: 'boolean' } }
    },
    due_date: { type: 'string' },
    due_heard: { type: 'string' },
    checklist: { type: 'array', items: { type: 'string' } },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    project: {
      type: 'object', additionalProperties: false, required: ['heard', 'match', 'confident'],
      properties: { heard: { type: 'string' }, match: { type: 'integer' }, confident: { type: 'boolean' } }
    },
    status_short: { type: 'string' },
    recurrence: { type: 'string', enum: ['', 'daily', 'weekly', 'monthly'] },
    activate_date: { type: 'string' },
    meeting: {
      type: 'object', additionalProperties: false, required: ['is', 'with', 'date', 'time', 'minutes'],
      properties: {
        is: { type: 'boolean' },
        with: { type: 'array', items: { type: 'string' } },
        date: { type: 'string' },
        time: { type: 'string' },
        minutes: { type: 'integer' }
      }
    },
    unclear: { type: 'array', items: { type: 'string' } }
  }
};

/** מי ומה אפשר לבחור — רק מה שהמשתמש רשאי לראות ולשייך */
function contextFor(actor, projects) {
  const users = D.all("SELECT id, full_name, department FROM users WHERE status = 'active' ORDER BY full_name");
  const vendors = P.may(actor, 'assign_task_to_vendor')
    ? D.all("SELECT id, name, contact_name FROM vendors WHERE status = 'active' ORDER BY name")
    : [];
  return { users, vendors, projects };
}

function contextText(actor, ctx, { aiRequested }) {
  const today = W.todayIL();
  const lines = [
    `היום: ${today} (${W.hebrewDate(today)}).`,
    `יום העבודה הבא ("מחר") של הדובר: ${W.nextWorkDay(actor.id, today)}.`,
    `ימי העבודה של הדובר: ${W.daysLabel(W.workDaysOf(actor.id))}. שבת — יום מנוחה.`,
    `הדובר: ${actor.name} (user:${actor.id}).`,
    aiRequested ? 'הדובר אמר במפורש "משימת AI".' : null,
    '',
    'עובדים בארגון:',
    ...ctx.users.map((u) => `user:${u.id} — ${u.full_name}${u.department ? ` · ${u.department}` : ''}`),
    ...(ctx.vendors.length ? ['', 'ספקים חיצוניים:', ...ctx.vendors.map((v) => `vendor:${v.id} — ${v.name}${v.contact_name ? ` (${v.contact_name})` : ''}`)] : []),
    '',
    'פרויקטים (מזהה — שם):',
    ...(ctx.projects.length ? ctx.projects.map((p) => `${p.id} — ${p.name}`) : ['(אין)'])
  ].filter((l) => l !== null);
  return lines.join('\n');
}

async function understand(actor, text, ctx, { aiRequested }) {
  return Claude.json({
    system: fs.readFileSync(SKILL_PATH, 'utf8'),
    content: [{
      type: 'text',
      text: `${contextText(actor, ctx, { aiRequested })}\n\nמה שנאמר (אחרי התמלול):\n"""\n${text}\n"""`
    }],
    schema: SCHEMA,
    effort: 'low'
  });
}

// ---------------------------------------------------------------------------
// ברירות מחדל והחלטה
// ---------------------------------------------------------------------------

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/**
 * ההבנה של ה-AI → טיוטה עם ברירות המחדל, ואזהרות על מה שלא ודאי.
 *
 * שני ערכים לאחראי: ‎assignee‎ — מה שייקבע ביצירה ישירה (אני, אם לא ודאי),
 * ו-‎assigneeGuess‎ — ההתאמה של ה-AI, שמוצעת בתצוגה המקדימה ומסומנת לבדיקה.
 */
function resolve(actor, out, ctx) {
  const warnings = [];
  const today = W.todayIL();
  const userIds = new Set(ctx.users.map((u) => u.id));
  const vendorIds = new Set(ctx.vendors.map((v) => v.id));
  const nameOf = (ref) => {
    const [type, id] = String(ref).split(':');
    if (type === 'user') return ctx.users.find((u) => u.id === Number(id))?.full_name ?? '';
    return ctx.vendors.find((v) => v.id === Number(id))?.name ?? '';
  };
  const validRef = (ref) => {
    const [type, id] = String(ref ?? '').split(':');
    return (type === 'user' && userIds.has(Number(id))) || (type === 'vendor' && vendorIds.has(Number(id)));
  };

  const me = `user:${actor.id}`;
  const heardAssignee = clip(out.assignee?.heard, 80);
  const rawMatch = out.assignee?.match === 'me' ? me : String(out.assignee?.match ?? '');
  const guess = validRef(rawMatch) ? rawMatch : null;
  let assignee = me;
  if (guess && out.assignee?.confident) assignee = guess;
  else if (heardAssignee) {
    warnings.push({ field: 'assignee', text: `"${heardAssignee}" לא זוהה בוודאות — המשימה שויכה אליך` });
  }

  const [aType, aId] = assignee.split(':');
  // "מחר" במובן של מי שאחראי — לספק אין ימי עבודה במערכת, אז לפי הדובר
  const dueOwner = aType === 'user' ? Number(aId) : actor.id;
  let dueDate = W.isDate(out.due_date) ? out.due_date : null;
  const dueHeard = clip(out.due_heard, 80);
  if (!dueDate) {
    dueDate = W.nextWorkDay(dueOwner, today);
    if (dueHeard) warnings.push({ field: 'dueDate', text: `התאריך "${dueHeard}" לא הובן — נקבע ליום העבודה הבא` });
  } else if (W.weekdayOf(dueDate) === W.SATURDAY) {
    warnings.push({ field: 'dueDate', text: 'היעד נופל בשבת' });
  } else if (!W.isWorkDay(dueOwner, dueDate)) {
    warnings.push({ field: 'dueDate', text: 'היעד נופל ביום שאינו יום עבודה' });
  }
  if (dueDate < today) warnings.push({ field: 'dueDate', text: 'תאריך היעד כבר עבר' });

  const projectIds = new Set(ctx.projects.map((p) => p.id));
  const heardProject = clip(out.project?.heard, 120);
  let projectId = null;
  if (out.project?.match && projectIds.has(Number(out.project.match)) && out.project.confident) projectId = Number(out.project.match);
  else if (heardProject) warnings.push({ field: 'projectId', text: `הפרויקט "${heardProject}" לא זוהה — המשימה בלי פרויקט` });
  const projectGuess = out.project?.match && projectIds.has(Number(out.project.match)) ? Number(out.project.match) : null;

  const activate = W.isDate(out.activate_date) && out.activate_date > today ? out.activate_date : null;

  for (const u of out.unclear ?? []) if (String(u).trim()) warnings.push({ field: null, text: clip(u, 200) });

  return {
    draft: {
      kind: out.kind === 'ai_task' ? 'ai_task' : 'task',
      title: clip(out.title, 120),
      description: clip(out.description, 4000),
      aiInstruction: clip(out.ai_instruction, 2000),
      assignee,
      assigneeName: nameOf(assignee),
      assigneeGuess: guess,
      assigneeGuessName: guess ? nameOf(guess) : '',
      dueDate,
      priority: ['low', 'normal', 'high', 'urgent'].includes(out.priority) ? out.priority : 'normal',
      projectId,
      projectGuess,
      checklist: (out.checklist ?? []).map((c) => clip(c, 200)).filter(Boolean).slice(0, 15),
      statusShort: clip(out.status_short, 200),
      recurrence: ['daily', 'weekly', 'monthly'].includes(out.recurrence) ? out.recurrence : '',
      activateDate: activate,
      // "קבע פגישה עם…" — מה שנשמע על הפגישה, לדיאלוג קביעת הפגישה
      meeting: out.meeting?.is
        ? {
            with: (out.meeting.with ?? []).map((x) => clip(x, 80)).filter(Boolean).slice(0, 10),
            date: W.isDate(out.meeting.date) ? out.meeting.date : null,
            time: /^\d{1,2}:\d{2}$/.test(String(out.meeting.time ?? '')) ? out.meeting.time.padStart(5, '0') : null,
            minutes: Number(out.meeting.minutes) > 0 ? Math.min(600, Number(out.meeting.minutes)) : null
          }
        : null
    },
    warnings
  };
}

/** גוף הבקשה ל-‎createTask‎ מהטיוטה */
function taskBody(draft, transcript) {
  const [aType, aId] = draft.assignee.split(':');
  return {
    title: draft.title,
    description: draft.description,
    projectId: draft.projectId,
    assigneeType: aType,
    assigneeId: Number(aId),
    priority: draft.priority,
    dueDate: W.dueIso(draft.dueDate),
    activateAt: draft.activateDate ? W.dueIso(draft.activateDate) : null,
    checklist: draft.checklist,
    statusShort: draft.statusShort,
    isRecurring: Boolean(draft.recurrence),
    recurrenceFreq: draft.recurrence || null,
    source: 'voice',
    meetingPending: draft.meeting ? true : undefined,
    auditNote: `המשימה נוצרה מהקלטה: "${clip(transcript, 300)}"`
  };
}

/**
 * @param {object} actor
 * @param {{text: string, forcePreview?: boolean}} input
 * @param {{projects: Array, createTask: Function}} deps
 */
async function handle(actor, { text, forcePreview = false }, { projects, createTask, assertMayAssignTo }) {
  const transcript = clip(text, MAX_TEXT);
  if (!transcript) throw new Error('לא נקלט טקסט. נסו שוב, או הקלידו.');
  if (!Claude.isEnabled()) throw new Error('חיבור ה-AI אינו מוגדר בשרת (ANTHROPIC_API_KEY)');

  const { trigger, aiRequested, rest } = detectTrigger(transcript);
  if (!rest) throw new Error('נשמעו רק מילות הפתיחה — מה המשימה?');

  const ctx = contextFor(actor, projects);
  const out = await understand(actor, rest, ctx, { aiRequested });
  if (aiRequested) out.kind = 'ai_task';
  const { draft, warnings } = resolve(actor, out, ctx);
  if (draft.kind === 'ai_task' && !draft.aiInstruction) draft.aiInstruction = rest;

  /*
   * מי שאינו רשאי לשייך לאחרים (עובד בלי הרשאה, או מחוץ למחלקה) — המשימה
   * אצלו, עם הסבר. אחרת יצירה ישירה הייתה נכשלת בשקט על הרשאה.
   */
  const me = `user:${actor.id}`;
  for (const key of ['assignee', 'assigneeGuess']) {
    const ref = draft[key];
    if (!ref || ref === me) continue;
    const [type, id] = ref.split(':');
    try {
      assertMayAssignTo(actor, type, Number(id));
    } catch {
      const name = key === 'assignee' ? draft.assigneeName : draft.assigneeGuessName;
      if (!warnings.some((w) => w.field === 'assignee' && w.text.includes('הרשאה'))) {
        warnings.push({ field: 'assignee', text: `אין לך הרשאה לשייך משימה ל${name || 'אדם אחר'} — המשימה שויכה אליך` });
      }
      draft[key] = key === 'assignee' ? me : null;
      if (key === 'assignee') draft.assigneeName = actor.name;
      else draft.assigneeGuessName = '';
    }
  }

  const mode = prefs(actor.id).mode;
  /*
   * קביעת פגישה בקול: המשימה "פגישה לקביעה" נוצרת מיד, ודיאלוג הפגישה נפתח
   * ממולא — הוא עצמו התצוגה המקדימה, כי הוא שולח הזמנות רק אחרי לחיצה.
   */
  const meeting = draft.kind === 'task' && Boolean(draft.meeting) && Boolean(draft.title) && !forcePreview;
  const direct = meeting || (!forcePreview && mode === 'direct' && trigger && draft.kind === 'task' && Boolean(draft.title));

  if (!draft.title && draft.kind === 'task') warnings.unshift({ field: 'title', text: 'לא זוהה נושא למשימה' });

  if (!direct) return { transcript, trigger, mode, draft, warnings };

  const taskId = createTask(actor, taskBody(draft, transcript));
  return { transcript, trigger, mode, draft, warnings, taskId };
}

module.exports = { handle, detectTrigger, prefs, cleanPrefs, resolve, taskBody, VOICE_DEFAULTS, _internal: { TRIGGER, FILLERS } };
