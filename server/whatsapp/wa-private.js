'use strict';
/**
 * בוט הוואטסאפ — שיחה פרטית — הבנת הבקשה, מצב השיחה, רשימות, טיוטת משימה, הקראה בקול, הודעות מועברות.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups.
 */
const fs = require('node:fs');
const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const GContacts = require('../phonebook').GoogleContacts;
const Speech = require('../integrations').Speech;
const WaActions = require('./wa-actions');
const Phonebook = require('../phonebook').Phonebook;
const ProjectHints = require('../tasks').ProjectHints;
const Insights = require('../agents').Insights;
const Range = require('../mail').InsightWindow;
const { CHAT_SKILL, DAY, HISTORY_TURNS, TZ, hooks, localDate, orgUsers, parseJson } = require('./wa-base');
const { nameOf } = require('./wa-groups');


// ---------------------------------------------------------------------------
// שיחה פרטית — הפעולות
// ---------------------------------------------------------------------------

const INTENTS = ['create_task', 'my_tasks', 'complete', 'comment', 'project_tasks', 'send_email', 'mail_insights', 'mail_ask', 'solve', 'contact', 'recording', 'today', 'today_email', 'menu', 'help', 'cancel', 'other'];

const INSIGHT_ACTIONS = ['list', 'detail', 'reply', 'task', 'follow'];


/** הכוונה ← הפעולה במסך הניהול שמפעילה אותה */
const ACTION_OF = { menu: 'today', today_email: 'today', contact: 'phonebook', recording: 'recordings' };

const actionOf = (intent) => ACTION_OF[intent] ?? intent;


const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    ready: { type: 'boolean' },
    reply: { type: 'string' },
    range: { type: 'string', enum: ['today', 'overdue', 'week', 'all'] },
    task_id: { type: 'integer', description: 'למשימה קיימת (סימון כבוצע, הערה): מזהה מהרשימות שסופקו, או 0' },
    comment: { type: 'string' },
    project_id: { type: 'integer', description: 'למשימות פרויקט: מזהה מרשימת הפרויקטים, או 0' },
    recipient_name: { type: 'string', description: 'במייל: שם הנמען כפי שנכתב ("אורן", "שושנה חן"). אחרת ריק' },
    recipient_org: { type: 'string', description: 'במייל: רק השם המזהה של החברה או המשרד ("כהן" מתוך "משרד עורכי הדין כהן"). אחרת ריק' },
    recipient_email: { type: 'string', description: 'במייל: כתובת אם נכתבה במפורש. אחרת ריק' },
    request: { type: 'string', description: 'במייל: מה לבקש או לכתוב לנמען, במילים של הכותב. בתשובה למייל: מה לענות. בשאלה על המיילים: השאלה המלאה. בבעיה (solve): תיאור הבעיה המלא, כולל מה שנאמר עליה קודם בשיחה. אחרת ריק' },
    insight_action: { type: 'string', enum: INSIGHT_ACTIONS, description: 'בתובנות מהמיילים: מה לעשות. אחרת list' },
    insight_n: { type: 'integer', description: 'בתובנות: מספר המייל ברשימת התובנות האחרונה, או 0' },
    insight_from: { type: 'string', description: 'בתובנות: רק משולח מסוים ("בנק לאומי"), אחרת ריק' },
    insight_range_unit: { type: 'string', enum: ['default', 'hours', 'workdays'], description: 'בתובנות: הטווח שנאמר — בשעות ("48 שעות") או בימים ("מאתמול", "מהיומיים האחרונים"). לא נאמר — default' },
    insight_range_n: { type: 'integer', description: 'בתובנות: מספר השעות או הימים שנאמר, אחרת 0' },
    contact_query: { type: 'string', description: 'באיש קשר: את מי לחפש — שם, טלפון או מילה מההערה ("דני כהן", "היועץ הסניטרי"), בלי אותיות שימוש. אחרת ריק' },
    recording_query: { type: 'string', description: 'בהקלטה: לפי מה לחפש — נושא הפגישה, שם משתתף או חברה ("רזבר", "ישיבת צוות"), בלי מילים כמו "ההקלטה של הפגישה עם". לא נאמר — ריק' },
    recording_date: { type: 'string', description: 'בהקלטה: YYYY-MM-DD כשנאמר יום ("מאתמול", "של יום שלישי"), לפי תאריך היום. לא נאמר — ריק' },
    contact_source: { type: 'string', enum: ['any', 'google', 'phonebook'], description: 'באיש קשר ובמייל: מאיפה לחפש — phonebook רק כשנאמר במפורש "מהאלפון"/"באלפון", google רק כשנאמר "מגוגל"/"מאנשי הקשר בגוגל". אחרת any' },
    draft: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        assignee_user_id: { type: 'integer' },
        due_date: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
        project_id: { type: 'integer' },
        project_suggested: { type: 'boolean', description: 'true כשהפרויקט לא נאמר, וה-AI בחר אותו לפי התוכן' },
        checklist: { type: 'array', items: { type: 'string' } },
        template_id: { type: 'integer', description: 'תבנית משימה מהרשימה, כשביקש לפתוח לפי תבנית או כשהמשימה היא בדיוק מה שהתבנית מתארת. אחרת 0' }
      },
      required: ['title', 'summary', 'assignee_user_id', 'due_date', 'priority', 'project_id', 'project_suggested', 'checklist', 'template_id'],
      additionalProperties: false
    }
  },
  required: ['intent', 'ready', 'reply', 'range', 'task_id', 'comment', 'project_id', 'recipient_name', 'recipient_org', 'recipient_email', 'request', 'insight_action', 'insight_n', 'insight_from', 'insight_range_unit', 'insight_range_n', 'contact_query', 'contact_source', 'recording_query', 'recording_date', 'draft'],
  additionalProperties: false
};


const YES = /^(כן|יאללה|אשר|מאשר|מאשרת|פתח|תפתח|פתחי|תפתחי|סגור|תסגור|אוקי|אוקיי|סבבה|ok|okay|yes|👍|✅)([\s,.!]|$)/i;

const CANCEL = /^(ביטול|בטל|עזוב|לא צריך)([\s,.!]|$)/;

// בלי AI עדיין אפשר לבקש את הרשימה ועזרה
const PLAIN_LIST = /^(המשימות שלי|משימות|מה יש לי)/;

const PLAIN_HELP = /^(עזרה|help|\?|מה אתה יודע)/i;

const PLAIN_TODAY = /^(היום|היי|הי|שלום|בוקר טוב|מה יש לי היום|today)[\s?!.]*$/i;

const PLAIN_GREETING = /^(היי|הי|שלום|בוקר טוב)[\s?!.]*$/;

const PLAIN_INSIGHTS = /^(תובנות|מה חדש)/;


/*
 * ‎greetedOn‎ — היום שבו כבר הוצגו לו ה-Today והתפריט, כדי שהודעה ראשונה ביום תפתח בהם.
 * ‎insights‎ — הפריטים ברשימת התובנות האחרונה ("פרט על 2"): מזהה מייל, או ‎wa:<id>‎.
 * ‎suggestions‎ — ההצעות למשימות שהוצגו ב-Today לפי האותיות ("אשר א").
 * ‎queue‎ — בקשות שנאמרו באותה הקלטה ועוד לא טופלו.
 */
const emptyChat = { draft: null, awaiting: false, history: [], lastList: [], greetedOn: '', insights: [], suggestions: [], queue: [], walk: null };


function chatOf(userId) {
  const row = D.get('SELECT * FROM wa_chats WHERE user_id = ?', userId);
  if (!row) return { ...emptyChat };
  const extra = parseJson(row.extra, {});
  return {
    draft: parseJson(row.draft, null), awaiting: Boolean(row.awaiting), history: parseJson(row.history, []),
    lastList: parseJson(row.last_list, []), greetedOn: row.greeted_on ?? '',
    insights: Array.isArray(extra.insights) ? extra.insights : [], queue: Array.isArray(extra.queue) ? extra.queue : [],
    suggestions: Array.isArray(extra.suggestions) ? extra.suggestions : [],
    // ☀️ "לעבור עליהם" — הפריטים של "דורש ממך היום" והמקום ברשימה
    walk: extra.walk && Array.isArray(extra.walk.items) ? extra.walk : null
  };
}


function saveChat(userId, { draft, awaiting, history, lastList, greetedOn = '', insights = [], queue = [], suggestions = [], walk = null }) {
  D.run(
    `INSERT INTO wa_chats (user_id, draft, awaiting, history, last_list, greeted_on, extra, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET draft = excluded.draft, awaiting = excluded.awaiting, history = excluded.history,
       last_list = excluded.last_list, greeted_on = excluded.greeted_on, extra = excluded.extra, updated_at = excluded.updated_at`,
    userId, draft ? JSON.stringify(draft) : '', awaiting ? 1 : 0, JSON.stringify(history.slice(-HISTORY_TURNS)),
    JSON.stringify(lastList ?? []), greetedOn ?? '', JSON.stringify({ insights, queue, suggestions, ...(walk ? { walk } : {}) }), D.nowIso()
  );
}


const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' });

const PRIORITY = { urgent: 'דחוף', high: 'גבוהה', normal: 'רגילה' };


/** תאריך מקומי (YYYY-MM-DD) בעוד ‎days‎ ימים */
const localDay = (days = 0) => localDate(new Date(Date.now() + days * DAY)).date;

const dueDay = (t) => (t.dueDate ? localDate(new Date(t.dueDate)).date : null);


function draftText(draft, user) {
  const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name;
  const project = draft.projectId ? D.get('SELECT name FROM projects WHERE id = ?', draft.projectId)?.name : null;
  // סעיפי התבנית קודם, ואחריהם מה שנמנה בהודעה — כמו שייפתח
  const fromTpl = draft.templateId ? draft.templateChecklist ?? [] : [];
  const checklist = [...fromTpl, ...(draft.checklist ?? []).filter((c) => !fromTpl.includes(c))];
  return [
    `📝 *${draft.title}*`,
    draft.summary || null,
    `👤 אחראי/ת: ${draft.assigneeId && draft.assigneeId !== user.id ? nameOf(draft.assigneeId) : 'את/ה'}`,
    `📅 יעד: ${draft.dueDate ? shortDate(draft.dueDate) : 'ללא'}`,
    `📁 פרויקט: ${project ?? 'ללא'}${project && draft.projectSuggested ? ' _(לפי התוכן — "בלי פרויקט" או שם אחר לשינוי)_' : ''}`,
    draft.priority !== 'normal' ? `⚡ עדיפות: ${PRIORITY[draft.priority]}` : null,
    draft.templateId && draft.templateName ? `📋 תבנית: ${draft.templateName}` : null,
    checklist.length ? `☑ ${checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : null,
    ...(draft.warnings ?? []).map((w) => `⚠️ ${w}`),
    '',
    'לפתוח? השיבו *כן*, או כתבו מה לתקן.'
  ].filter((l) => l !== null).join('\n');
}


const LIST_SHOWN = 15;


function dueLabel(t) {
  const d = dueDay(t);
  if (!d) return '';
  if (d === localDay(0)) return 'היום';
  if (d === localDay(1)) return 'מחר';
  const [, mm, dd] = d.split('-');
  return `${Number(dd)}.${Number(mm)}`;
}


/** רשימה ממוספרת. המספרים הם מה ש"סיימתי את 2" מתייחס אליו */
function formatList(heading, tasks, { showProject = true, showAssignee = false, actor = null } = {}) {
  const shown = tasks.slice(0, LIST_SHOWN);
  const lines = shown.map((t, i) => {
    const due = dueLabel(t);
    return `${i + 1}. ${t.title}${due ? ` · 📅 ${due}` : ''}${t.overdue ? ' ⚠️' : ''}`
      + `${showProject && t.projectName ? ` · 📁 ${t.projectName}` : ''}${showAssignee && t.assignee ? ` · 👤 ${t.assignee}` : ''}`;
  });
  const more = tasks.length > shown.length ? `ועוד ${tasks.length - shown.length} — באפליקציה.` : null;
  const hint = actor && WaActions.allowed(actor, 'complete') ? 'לסגור משימה: "סיימתי את 1".' : null;
  return [heading, ...lines, more, hint ? '' : null, hint].filter((l) => l !== null).join('\n');
}


/*
 * 🔊 הקראה: "תקריא לי את המשימות", "אני בנהיגה — מה יש לי היום?" — הרשימה נשלחת כהודעה קולית.
 * לכל מי שמותר לו "המשימות שלי" (נפתח לכולם 10.11.26, אחרי פיילוט אצל מנהלי המערכת), כשיש מפתח OpenAI.
 */
// גם מה שהתמלול עושה ל"תקריאי לי" ("תכירי לי", "תקרי לי") — זה נבדק רק כשהבקשה כבר זוהתה כ"המשימות שלי"
const READ_ALOUD = /(תקריא|להקריא|הקרא|תקרא לי|תקראי לי|תכירי לי|תקרי לי|בקול|בנהיגה|אני נוהג|אני נוהגת|בזמן נסיעה)/;

const READ_ALOUD_MAX = 8;

const readAloudAllowed = (actor) => actor?.type === 'user' && WaActions.allowed(actor, 'my_tasks') && Speech.canSpeak();

const SPOKEN_NUM = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה'];


/** מה שמוקרא: כותרות ותאריכים בלבד — בלי אימוג'י, קישורים ומספרי משימה */
function readAloudText(actor, tasks, title) {
  const first = String(actor?.name ?? '').trim().split(/\s+/)[0];
  const shown = tasks.slice(0, READ_ALOUD_MAX);
  const count = tasks.length === 1 ? 'משימה אחת' : `${tasks.length} משימות`;
  const clean = (x) => String(x ?? '').replace(/https?:\/\/\S+/g, '').replace(/[\p{Extended_Pictographic}\uFE0F*_~]/gu, '').replace(/\s+/g, ' ').trim();
  const lines = shown.map((t, i) => {
    const due = dueLabel(t);
    const when = t.overdue ? 'באיחור' : due === 'היום' || due === 'מחר' ? due : due ? `עד ה-${due}` : '';
    return `${SPOKEN_NUM[i]}. ${clean(t.title)}${when ? `, ${when}` : ''}.`;
  });
  const more = tasks.length > shown.length ? `ועוד ${tasks.length - shown.length} באפליקציה.` : '';
  return [`${first ? `${first}, ` : ''}יש לך ${count} ${title}.`, ...lines, more].filter(Boolean).join('\n');
}


/** לעובד, כשביקש הקראה והיא לא יצאה — הודעה קצרה בלבד, בלי הרשימה (ביקש לשמוע, לא לקרוא) */
const READ_ALOUD_DOWN = '🔇 ההקראה לא זמינה כרגע. נסו שוב בעוד כמה דקות.';


/**
 * קובץ ההקראה לרשימה: ‎{ file }‎ · ‎{ failed: true }‎ (ביקשו ונכשל — העובד מקבל ‎READ_ALOUD_DOWN‎, התקלה ביומן)
 * · ‎null‎ (לא ביקשו / לא מורשה — הרשימה בכתב, כרגיל)
 */
async function readAloudFile(actor, text, tasks, title) {
  if (!tasks.length || !READ_ALOUD.test(String(text ?? '')) || !readAloudAllowed(actor)) return null;
  try {
    return { file: { buf: await Speech.speak(readAloudText(actor, tasks, title)), fileName: 'משימות.ogg', mime: 'audio/ogg' } };
  } catch (err) {
    console.error('[משימון] הקראה נכשלה:', err.message);
    return { failed: true, error: err.message };
  }
}


const RANGES = {
  today: { title: 'להיום', pick: (t) => dueDay(t) && dueDay(t) <= localDay(0), empty: 'אין לך משימות להיום 🎉' },
  overdue: { title: 'באיחור', pick: (t) => t.overdue, empty: 'אין לך משימות באיחור 👏' },
  week: { title: 'לשבוע הקרוב', pick: (t) => dueDay(t) && dueDay(t) <= localDay(7), empty: 'אין לך משימות לשבוע הקרוב.' },
  all: { title: 'הפתוחות', pick: () => true, empty: 'אין לך משימות פתוחות 🎉' }
};


/**
 * כרטיסי איש קשר לבוט, לפי סדר העדיפות: Google השמורים והספרייה ← האלפון ←
 * מי שהתכתבתי איתו. כפילות (אותו טלפון או מייל) — הכרטיס הראשון בלבד.
 */
function findContactCards(actor, q, only = 'any') {
  const google = only === 'phonebook' ? [] : GContacts.search(actor.id, q, 20);
  const book = only === 'google' ? [] : Phonebook.search(q, { limit: 20 });
  const seen = new Set();
  const cards = [];
  let fromGoogle = 0;
  let fromBook = 0;
  const fresh = (emails, phones) => {
    const keys = [
      ...emails.filter(Boolean).map((e) => `e:${String(e).toLowerCase()}`),
      ...phones.map((p) => GContacts.phoneKey(p)).filter((p) => p.length >= 9).map((p) => `p:${p}`)
    ];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  };
  const addG = (c) => {
    if (!fresh(c.emails.map((e) => e.value), c.phones.map((p) => p.value))) return;
    cards.push(GContacts.cardText(c));
    fromGoogle++;
  };
  for (const c of google.filter((x) => x.source !== 'other')) addG(c);
  for (const e of book) {
    if (!fresh([e.email], [e.phone, e.phone2].filter(Boolean))) continue;
    cards.push(Phonebook.cardText(e));
    fromBook++;
  }
  for (const c of google.filter((x) => x.source === 'other')) addG(c);
  return { cards, google: fromGoogle, phonebook: fromBook };
}


/*
 * 📖 "תן לי את כל התכונות שלך" — ההודעה המלאה, נבנית מקטלוג הפעולות (‎wa-actions.js‎: ‎section‎, ‎feature‎, ‎control‎),
 * כך שהיא מתעדכנת עם הבוט: פעולה חדשה נכנסת, פעולה שכובתה או לא מורשית לכותב — יורדת (הוחלט 10.11.26, ישראל).
 * ההודעה הקצרה ("עזרה") — ‎helpText‎.
 */
const PLAIN_FEATURES = /^(?:(?:תן|תני|תראה|תראי|שלח|תשלח)\s+לי\s+)?(?:את\s+)?(?:כל\s+)?(?:ה)?(?:תכונות|יכולות|אפשרויות)(?:\s+(?:שלך|של\s+הבוט|החדשות))?[?!.]*$|^מה\s+(?:אתה\s+(?:יודע|יכול)|אפשר)\s+לעשות[?!.]*$|^מה\s+חדש\s+(?:בבוט|אצלך)[?!.]*$|^(?:כל\s+)?(?:ה)?תכונות\s+(?:החדשות\s+)?(?:של\s+)?(?:ה)?בוט[?!.]*$/;


function featuresText(actor) {
  // מהקטלוג (‎wa-actions.js‎): כל פעולה מופעלת ומורשית לכותב — בפרק שלה. חדשה בלי שורה — התווית והדוגמה הראשונה
  const actions = WaActions.list().filter((a) => a.key !== 'help' && WaActions.allowed(actor, a.key) && (!a.requires || WaActions.allowed(actor, a.requires)));
  const lineOf = (a) => a.feature || `${a.icon} *${a.label}*${a.examples?.[0] ? ` — "${a.examples[0]}"` : ''}`;
  const lines = ['📖 *כל מה שאפשר לעשות איתי*'];
  const known = new Set(WaActions.SECTIONS.map(([k]) => k));
  for (const [key, title] of WaActions.SECTIONS) {
    const rows = actions.filter((a) => (known.has(a.section) ? a.section : 'other') === key).map((a) => `• ${lineOf(a)}`);
    if (rows.length) lines.push('', title, ...rows);
  }
  const control = actions.flatMap((a) => a.control ?? []);
  if (control.length) lines.push('', '🔕 *יותר מדי? אתם בשליטה*', ...control.map((x) => `• ${x}`));
  lines.push('', '👀 אני מגיב באימוג\'י במקום "רגע…": ✍️ כותב · 🔍 מחפש · 📅 ביומן · ✅ בוצע', '', 'אפשר לכתוב או להקליט בשפה חופשית 🙂 בכל שלב — "ביטול".');
  return lines.join('\n');
}


function helpText(actor) {
  const actions = WaActions.forActor(actor);
  if (!actions.length) return 'כרגע אין פעולות זמינות לך בוואטסאפ.';
  return [
    'אני הבוט של משימון. אפשר לכתוב לי:',
    ...actions.filter((a) => a.key !== 'help').map((a) => `${a.icon} *${a.label}*${a.examples[0] ? ` — "${a.examples[0]}"` : ''}`),
    '',
    'בכל שלב: "ביטול". כל התכונות, בפירוט: "תן לי את כל התכונות שלך".'
  ].join('\n');
}


/*
 * מאיפה לחפש איש קשר. ברירת המחדל — הכול, Google קודם. מה שנכתב במפורש
 * ("מהאלפון", "מגוגל") גובר גם אם ה-AI פספס.
 */
const FROM_PHONEBOOK = /(?:^|\s)(?:מה|ב|ל)?אלפון/;

const FROM_GOOGLE = /(?:מ|ב)(?:-)?(?:גוגל|google)|אנשי\s+(?:ה)?קשר\s+(?:של\s*|ב|מ)(?:-)?(?:גוגל|google)/i;

function sourceOf(aiSource, text) {
  const t = String(text ?? '');
  if (FROM_PHONEBOOK.test(t)) return 'phonebook';
  if (FROM_GOOGLE.test(t)) return 'google';
  return ['google', 'phonebook'].includes(aiSource) ? aiSource : 'any';
}


async function understand(user, actor, state, text, projects, myOpen) {
  const users = orgUsers();
  const { allowedProjects } = newTaskScope(actor);
  const allowedList = projects.filter((p) => allowedProjects.has(p.id));
  const otherList = projects.filter((p) => !allowedProjects.has(p.id));
  const actions = WaActions.forActor(actor);
  const templates = taskTemplatesOf(actor);
  const lastList = state.lastList
    .map((id, i) => ({ n: i + 1, id, title: D.get('SELECT title FROM tasks WHERE id = ?', id)?.title }))
    .filter((x) => x.title);
  const insightList = (state.insights ?? [])
    .map((ref, i) => ({ n: i + 1, item: Insights.itemOf(user.id, ref) }))
    .filter((x) => x.item)
    .map((x) => ({ n: x.n, who: `${Insights.ICON[x.item.source]} ${x.item.label}`, insight: x.item.insight }));
  const today = localDate();
  const prompt = [
    `תאריך היום: ${today.date} (${today.weekday})`,
    `הכותב: ${user.full_name} (מזהה ${user.id})`,
    '',
    'הפעולות שמופעלות לכותב (מפתח · שם · דוגמאות):',
    ...actions.map((a) => `${a.key} · ${a.label} · ${a.examples.join(' / ')}`),
    '',
    'העובדים (מזהה · שם · מחלקה):',
    ...users.map((u) => `${u.id} · ${u.full_name} · ${u.department ?? ''}`),
    '',
    'הפרויקטים שבהם אפשר לפתוח משימה (מזהה · שם — מנהל ומשימות פתוחות, לבחירת הפרויקט המתאים):',
    ...(allowedList.length ? ProjectHints.lines(allowedList.slice(0, 60)) : ['(אין)']),
    '',
    'פרויקטים נוספים שהוא רואה — לשאלות בלבד, לא לפתיחת משימה:',
    ...(otherList.length ? otherList.map((p) => `${p.id} · ${p.name}`) : ['(אין)']),
    '',
    'תבניות משימה (מזהה · שם · סעיפי הצ׳קליסט):',
    ...(templates.length ? templates.map((t) => `${t.id} · ${t.name}${templateItems(t).length ? ` · ${templateItems(t).join(' / ')}` : ''}`) : ['(אין)']),
    '\u0000',
    'המשימות הפתוחות של הכותב (מזהה · כותרת):',
    ...(myOpen.length ? myOpen.map((t) => `${t.id} · ${t.title}`) : ['(אין)']),
    '',
    'הרשימה האחרונה שנשלחה לו (מספר ברשימה → מזהה · כותרת):',
    ...(lastList.length ? lastList.map((x) => `${x.n} → ${x.id} · ${x.title}`) : ['(אין)']),
    '',
    'רשימת התובנות האחרונה שנשלחה לו — מהמייל 📧 ומהוואטסאפ 👥💬 (מספר · שולח · תובנה):',
    ...(insightList.length ? insightList.map((x) => `${x.n} · ${x.who} · ${x.insight}`) : ['(אין)']),
    '',
    `הטיוטה הנוכחית: ${state.draft && (state.draft.kind ?? 'task') === 'task' ? JSON.stringify(state.draft) : '(אין)'}`,
    '',
    'השיחה עד כה:',
    ...(state.history.length ? state.history.map((h) => `${h.role === 'bot' ? 'הבוט' : 'הכותב'}: ${h.text}`) : ['(התחלה)']),
    '',
    'ההודעה החדשה:',
    '<<<',
    text.slice(0, 3000),
    '>>>'
  ].join('\n');

  /*
   * שני חלקים: הקבוע (העובדים והפרויקטים — זהים בין הודעה להודעה של אותו
   * עובד) עם נקודת מטמון, והמשתנה (משימות, שיחה, ההודעה). כך בהודעה השנייה
   * בשיחה רוב הפרומפט נקרא מהמטמון, והתשובה מתחילה מהר יותר.
   */
  const [stable, rest] = prompt.split('\n\u0000\n');
  const out = await Claude.json({
    system: fs.readFileSync(CHAT_SKILL, 'utf8'),
    content: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }, { type: 'text', text: rest }],
    schema: CHAT_SCHEMA, effort: 'low', live: true
  });
  const ids = new Set(users.map((u) => u.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const d = out.draft ?? {};
  return {
    intent: INTENTS.includes(out.intent) ? out.intent : 'other',
    ready: Boolean(out.ready),
    reply: String(out.reply ?? '').trim().slice(0, 1000),
    range: RANGES[out.range] ? out.range : 'today',
    taskId: Number(out.task_id) || 0,
    comment: String(out.comment ?? '').trim().slice(0, 2000),
    contactQuery: String(out.contact_query ?? '').trim().slice(0, 80),
    contactSource: sourceOf(out.contact_source, text),
    recording: {
      query: String(out.recording_query ?? '').trim().slice(0, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(out.recording_date ?? '')) ? out.recording_date : ''
    },
    projectId: projectIds.has(Number(out.project_id)) ? Number(out.project_id) : 0,
    recipient: {
      name: String(out.recipient_name ?? '').trim().slice(0, 80),
      org: String(out.recipient_org ?? '').trim().slice(0, 80),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(out.recipient_email ?? '').trim()) ? String(out.recipient_email).trim().toLowerCase() : ''
    },
    request: String(out.request ?? '').trim().slice(0, 2000),
    insight: {
      action: INSIGHT_ACTIONS.includes(out.insight_action) ? out.insight_action : 'list',
      n: Number(out.insight_n) || 0,
      from: String(out.insight_from ?? '').trim().slice(0, 60),
      // הטווח — יחידה ומספר מה-AI, ואם לא חזרו — מהטקסט. התאריכים — בקוד
      range: Range.specFrom({ unit: out.insight_range_unit, n: out.insight_range_n }, text)
    },
    draft: {
      kind: 'task',
      title: String(d.title ?? '').trim().slice(0, 120),
      summary: String(d.summary ?? '').trim().slice(0, 1500),
      assigneeId: ids.has(Number(d.assignee_user_id)) ? Number(d.assignee_user_id) : 0,
      // נבדק מול ההרשאות ב-‎checkDraft‎ — כאן רק מה שה-AI הבין
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.due_date ?? '')) ? d.due_date : '',
      priority: ['normal', 'high', 'urgent'].includes(d.priority) ? d.priority : 'normal',
      projectId: projectIds.has(Number(d.project_id)) ? Number(d.project_id) : 0,
      projectSuggested: d.project_suggested === true,
      checklist: (d.checklist ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
      templateId: templates.some((t) => t.id === Number(d.template_id)) ? Number(d.template_id) : 0
    }
  };
}


/**
 * תבניות המשימה שהכותב רואה — אותן תבניות שבבורר "יצירה מתבנית" באפליקציה,
 * באותו גבול מחלקה. תקלה בשליפה אינה עוצרת פתיחת משימה.
 */
function taskTemplatesOf(actor) {
  try { return hooks.taskTemplates?.(actor) ?? []; } catch { return []; }
}


/** סעיפי הצ'קליסט של תבנית — מחרוזות (תבנית ישנה) או ‎{ text, note }‎ */
const templateItems = (tpl) => (tpl?.payload?.checklist ?? [])
  .map((c) => String(typeof c === 'string' ? c : c?.text ?? '').trim()).filter(Boolean);


/**
 * מה מותר לכותב בפתיחת משימה: למי לשייך (‎assertMayAssignTo‎ — המחלקה שלו,
 * אלא אם ההרשאה רחבה יותר) ובאיזה פרויקט (שלו או של המחלקה שלו).
 */
function newTaskScope(actor) {
  return {
    assignable: hooks.assignableUserIds?.(actor) ?? new Set([actor.id]),
    allowedProjects: new Set((hooks.newTaskProjects?.(actor) ?? []).map((p) => p.id))
  };
}


/**
 * טיוטת משימה מול ההרשאות, מיד כשהיא נבנית — ולא רק ב"כן": אחראי שאסור
 * לשייך אליו, או פרויקט שאינו של הכותב, יוצאים מהטיוטה עם הסבר גלוי. לא
 * מחליפים בשקט: המשימה נשארת אצל הכותב ובלי פרויקט, והוא רואה למה.
 */
function checkDraft(actor, draft) {
  const { assignable, allowedProjects } = newTaskScope(actor);
  const warnings = [];
  if (draft.assigneeId && draft.assigneeId !== actor.id && !assignable.has(draft.assigneeId)) {
    const reason = hooks.assignBlockReason?.(actor, draft.assigneeId) || `אין לך הרשאה לשייך משימה ל${nameOf(draft.assigneeId) || 'עובד זה'}`;
    warnings.push(`${reason} — המשימה תיפתח אצלך`);
    draft = { ...draft, assigneeId: 0 };
  }
  if (draft.projectId && !allowedProjects.has(draft.projectId)) {
    const name = D.get('SELECT name FROM projects WHERE id = ?', draft.projectId)?.name;
    warnings.push(`הפרויקט ${name ? `"${name}" ` : ''}אינו שלך או של המחלקה שלך — המשימה תיפתח בלי פרויקט`);
    draft = { ...draft, projectId: 0 };
  }
  /*
   * תבנית — רק מאלה שהכותב רואה. שמים את השם בטיוטה כדי שיופיע בתצוגה, ואת
   * הסעיפים שלה מוסיפים לפני מה שהוא מנה בעצמו (בלי כפילויות). התוכן המלא
   * (תיאור, הערות בסעיפים) נכנס בפתיחה עצמה.
   */
  if (draft.templateId) {
    const tpl = taskTemplatesOf(actor).find((t) => t.id === draft.templateId);
    if (!tpl) {
      warnings.push('התבנית שנבחרה אינה זמינה לך — המשימה תיפתח בלעדיה');
      draft = { ...draft, templateId: 0, templateName: '', templateChecklist: [] };
    } else {
      draft = { ...draft, templateName: tpl.name, templateChecklist: templateItems(tpl) };
    }
  }
  return { ...draft, warnings };
}


/** הצ'קליסט של הטיוטה עם סעיפי התבנית לפניו — לתצוגה (מחרוזות) ולפתיחה (עם הערות) */
function mergedChecklist(actor, draft) {
  const own = draft.checklist ?? [];
  const tpl = draft.templateId ? taskTemplatesOf(actor).find((t) => t.id === draft.templateId) : null;
  const fromTpl = (tpl?.payload?.checklist ?? [])
    .map((c) => (typeof c === 'string' ? { text: c.trim(), note: '' } : { text: String(c?.text ?? '').trim(), note: String(c?.note ?? '') }))
    .filter((c) => c.text);
  const seen = new Set(fromTpl.map((c) => c.text));
  return { tpl, items: [...fromTpl, ...own.filter((x) => !seen.has(x)).map((text) => ({ text, note: '' }))] };
}


// ---------------------------------------------------------------------------
// הודעות מועברות — אוספים, ומחכים להוראה
// ---------------------------------------------------------------------------

/*
 * דפוס נפוץ: מעבירים לבוט כמה הודעות (Forward), ואז כותבים או מקליטים מה לעשות
 * איתן ולמי ("לשושנה — תפתח לה משימה"). הבוט לא מנסה להבין כל הודעה מועברת
 * לבד: הוא אוסף אותן, מאשר פעם אחת, וההודעה הבאה שאינה מועברת היא ההוראה —
 * והיא מטופלת עם כל מה שנאסף. הוראה חלקית ("לשושנה") נשמרת עם ההודעות עד
 * שמשלימים אותה.
 */
const FORWARD_WINDOW_MS = 30 * 60 * 1000;

const FORWARD_MAX = 15;


function forwardsOf(userId) {
  const rows = D.all('SELECT kind, text, at FROM wa_forwards WHERE user_id = ? ORDER BY id', userId);
  const last = rows.length ? Date.parse(rows[rows.length - 1].at) : 0;
  if (rows.length && Date.now() - last > FORWARD_WINDOW_MS) {
    clearForwards(userId);
    return [];
  }
  return rows;
}


function addForward(userId, kind, text) {
  D.run('INSERT INTO wa_forwards (user_id, kind, text, at) VALUES (?,?,?,?)', userId, kind, String(text).slice(0, 1500), D.nowIso());
}


function clearForwards(userId) {
  D.run('DELETE FROM wa_forwards WHERE user_id = ?', userId);
}


/** ההוראה, ומתחתיה ההודעות שהועברו — כך ה-AI רואה את שתיהן כבקשה אחת */
function withForwards(rows, text) {
  const notes = rows.filter((r) => r.kind === 'note').map((r) => r.text);
  const fwd = rows.filter((r) => r.kind === 'forward');
  return [
    [...notes, text].join('\n'),
    '',
    `(ההודעות שהעברתי לפני כן — ${fwd.length}. הן התוכן של הבקשה שלמעלה:)`,
    ...fwd.map((r, i) => `${i + 1}. ${r.text}`)
  ].join('\n').slice(0, 6000);
}


/** למספר שאינו מוכר עונים פעם ביום — לא יותר, כדי לא לנהל שיחה עם זרים */
const unknownReplied = new Map();

module.exports = {
  CANCEL, FORWARD_MAX, LIST_SHOWN, PLAIN_FEATURES, PLAIN_GREETING, PLAIN_HELP, PLAIN_INSIGHTS, PLAIN_LIST, PLAIN_TODAY, PRIORITY, RANGES, READ_ALOUD, READ_ALOUD_DOWN, YES, actionOf, addForward, chatOf, checkDraft, clearForwards, draftText, dueLabel, emptyChat, featuresText, findContactCards, formatList, forwardsOf, helpText, localDay, mergedChecklist, readAloudAllowed, readAloudFile, readAloudText, saveChat, shortDate, sourceOf, understand, unknownReplied, withForwards
};
