'use strict';
/**
 * בוט הוואטסאפ — התפריט, "היום" בפריטים, פקודות על הצעות, והקלטות Zoom.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups ← wa-private ← wa-tasks ← wa-proactive ← wa-mail.
 */
const Agents = require('../agents').Agents;
const Today = require('../today').Today;
const WaActions = require('./wa-actions');
const MailInsights = require('../mail').MailInsights;
const MailPush = require('../mail').MailPush;
const Insights = require('../agents').Insights;
const Calendar = require('../meetings').Calendar;
const Range = require('../mail').InsightWindow;
const Zoom = require('../integrations').Zoom;
const WaUi = require('./wa-ui');
const { DAY, LETTERS, TZ, WALK, appRoot, localDate, usableClosure } = require('./wa-base');
const { dueLabel, localDay } = require('./wa-private');


// ---------------------------------------------------------------------------
// היום שלי ותפריט
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 🎥 הקלטות Zoom
// ---------------------------------------------------------------------------

const RECORDINGS_SHOWN = 3;

const RECORDINGS_DAYS = 30;   // בלי תאריך — מחפשים בחודש האחרון


const ilDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));


/**
 * ההקלטות שמתאימות לבקשה, כטקסט לוואטסאפ: נושא, מועד וקישור צפייה. ‎query‎
 * — מילים מהנושא, מהמשתתפים או מהמארח; בלי — האחרונות. ‎date‎ — יום אחד.
 */
async function recordingReply(actor, query, date) {
  const day = 24 * 60 * 60 * 1000;
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Zoom מסנן לפי תאריך UTC — יום לפני ואחרי, והסינון לפי שעון ישראל כאן
  const from = date ? ymd(Date.parse(date) - day) : ymd(Date.now() - RECORDINGS_DAYS * day);
  const to = date ? ymd(Date.parse(date) + day) : ymd(Date.now());
  const { recordings, errors } = await Zoom.recordingsFor(actor, from, to);
  let list = recordings.filter((r) => r.files.some((f) => f.ready) && (!date || ilDate(r.start) === date));

  const words = query.toLowerCase().split(/[\s,.־-]+/).filter((w) => w.length > 1);
  if (words.length) {
    const scored = list.map((r) => {
      const hay = [r.topic, r.meeting?.title, ...(r.meeting?.attendees ?? []), r.host.name, r.host.email].filter(Boolean).join(' ').toLowerCase();
      return { r, score: words.filter((w) => hay.includes(w)).length };
    }).filter((x) => x.score > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    list = scored.filter((x) => x.score === best).map((x) => x.r);
  }

  const what = [query ? `של "${query}"` : null, date ? `מ-${date.split('-').reverse().join('.')}` : `מ-${RECORDINGS_DAYS} הימים האחרונים`].filter(Boolean).join(' ');
  if (!list.length) {
    const why = errors.length ? `\n⚠️ ${errors[0]}` : '';
    return { found: false, text: `לא מצאתי הקלטה ${what}. אפשר לנסות לפי נושא הפגישה, שם משתתף או יום.${why}`, log: `לא נמצאה הקלטה ${what}` };
  }

  const root = appRoot();
  const shown = list.slice(0, RECORDINGS_SHOWN);
  const blocks = shown.map((r) => {
    const when = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(r.start));
    const video = r.files.find((f) => f.kind === 'video' && f.ready) ?? r.files.find((f) => f.ready);
    const inApp = root && video ? `${root}/api/zoom/recordings/file?uuid=${encodeURIComponent(r.uuid)}&file=${encodeURIComponent(video.id)}` : '';
    return [
      `🎥 *${r.meeting?.title || r.topic || 'פגישת Zoom'}*`,
      `${when}${r.minutes ? ` · ${r.minutes} דק׳` : ''}`,
      // רק הקישור הפנימי, שבודק הרשאה בכל צפייה — לא קישור השיתוף של Zoom עם הקוד (issue #65)
      inApp ? `▶ ${inApp}` : null,
      r.files.some((f) => f.kind === 'transcript' && f.ready) ? '📝 יש גם תמליל — במסך "🎥 הקלטות Zoom" במשימון' : null
    ].filter(Boolean).join('\n');
  });
  const more = list.length > shown.length ? `\nועוד ${list.length - shown.length} — כתבו נושא, משתתף או יום כדי לצמצם.` : '';
  return {
    found: true,
    text: [list.length > 1 ? `מצאתי ${list.length} הקלטות ${what}:` : null, ...blocks].filter(Boolean).join('\n\n') + more,
    log: `${list.length} הקלטות ${what}: ${shown.map((r) => r.topic).join(' · ')}`.slice(0, 300)
  };
}


/*
 * התפריט — 5 אפשרויות בלבד (הוחלט 08.11.26). השאר — בשפה חופשית, בלי כפתור: "משימה ל…", "מייל ל…",
 * "מה פתוח בפרויקט…", "יש לי בעיה…", "מה באיחור", "הסוכנים", "שלח לי את Today במייל" (‎MENU_FREE_HINT‎).
 * "✨ לשאול את אשל" — גם שאלה וגם בעיה: ה-AI מזהה ומעביר (‎mail_ask‎ / ‎solve‎).
 */
const MENU = [
  ['today', 'today', '☀️ מה יש לי היום'],
  ['priority', 'goods_receipt', '🗂 פריוריטי — קבלת סחורה ודרישת רכש'],
  ['insights', 'mail_insights', '📬 תובנות — מה חדש (ו-💡 הצעת תשובה)'],
  ['my_tasks', 'my_tasks', '📋 כל המשימות הפתוחות שלי'],
  ['ask', 'mail_ask', '✨ לשאול את אשל — שאלה או בעיה']
];

const MENU_FREE_HINT = '_אפשר גם לכתוב או להקליט חופשי: "משימה ל…", "מייל ל…", "מה פתוח בפרויקט…", "יש לי בעיה…"_';


/**
 * 🤖 הסוכנים שמותרים לכותב, לפי מחלקה — שורה לכל סוכן. לא צריך לבחור סוכן:
 * שואלים את אשל, והוא מעביר לסוכן המתאים.
 */
function agentsText(actor) {
  const list = Agents.allowedFor(actor);
  if (!list.length) return 'כרגע אין סוכנים זמינים לך.';
  const byDept = new Map();
  for (const a of list) {
    const k = `${a.deptIcon ?? ''} ${a.deptLabel ?? ''}`.trim();
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k).push(a);
  }
  return [
    `🤖 *${list.length} הסוכנים של אשל*`,
    'לא צריך לבחור — פשוט שואלים, ואשל מעביר לסוכן המתאים.',
    ...[...byDept.entries()].flatMap(([dept, agents]) => ['', `*${dept}*`, ...agents.map((a) => `${a.icon} ${a.title}`)]),
    '',
    '✨ ובנוסף אשל עצמו: "איך עושים אצלנו" מהידע הארגוני, והמיילים שלך.',
    'למשל: "כמה מס רכישה על דירה שנייה ב-2.4 מיליון?"'
  ].join('\n');
}

const PLAIN_AGENTS = /^(סוכנים|הסוכנים|מה הסוכנים( יודעים)?|אילו סוכנים( יש)?|רשימת (ה)?סוכנים)[?.!\s]*$/;


/**
 * מה אפשר לבחור בתפריט — רק פעולות שמופעלות לכותב. התובנות — למי שיש לו מייל
 * או וואטסאפ רלוונטי, ובכותרת המקורות והטווח של היום.
 */
function menuOptions(actor) {
  const sources = Insights.sourcesOf(actor.id);
  const insightLabel = () => {
    const h = Insights.headings({ mail: sources.mail && MailInsights.available(actor.id), whatsapp: sources.whatsapp });
    return `${h.insights} (${Range.forUser(actor.id).span})`;
  };
  return MENU.filter(([key, action]) => (key === 'priority' ? WaActions.allowed(actor, 'goods_receipt') || WaActions.allowed(actor, 'purchase_demand')
    : key === 'ask' ? WaActions.allowed(actor, 'mail_ask') || WaActions.allowed(actor, 'solve') : WaActions.allowed(actor, action))
    && (key !== 'insights' || MailInsights.available(actor.id) || sources.whatsapp))
    .map(([key, , label]) => ({ key, label: key === 'insights' ? insightLabel() : label }));
}


/*
 * התפריט בוואטסאפ — כפתורים בלבד (עד 3 להודעה, ‎wa-ui.js‎): השניים הראשונים ו"עוד אפשרויות", וכך הלאה.
 * הכיתוב של כפתור הוא מה שהבוט מבין (‎menuPick‎). "🗂 פריוריטי" — מעביר לתפריט פריוריטי (קבלת סחורה / דרישת רכש).
 */
const MENU_BUTTON = {
  today: '☀️ מה יש לי היום', priority: '🗂 פריוריטי', ask: '✨ לשאול את אשל', insights: '📬 תובנות', solve: '💡 יש לי בעיה',
  send_email: '✉️ לשלוח מייל', create_task: '📝 לפתוח משימה', my_tasks: '📋 המשימות שלי', overdue: '⚠️ מה באיחור',
  project_tasks: '📁 מה פתוח בפרויקט', agents: '🤖 הסוכנים', today_email: '📧 Today במייל'
};

const MENU_MORE = 'עוד אפשרויות ⬇️';

const menuButtonOf = (key) => MENU_BUTTON[key] ?? key;

function menuButtons(keys, page = 0) {
  const start = page * 2;
  const rest = keys.slice(start);
  if (!rest.length) return keys.slice(0, 2).map(menuButtonOf).concat(keys.length > 2 ? [MENU_MORE] : []);
  return rest.length <= 3 ? rest.map(menuButtonOf) : [...rest.slice(0, 2).map(menuButtonOf), MENU_MORE];
}

/**
 * "עוד אפשרויות" — כל שאר האפשרויות בבת אחת, 3 כפתורים להודעה (וואטסאפ מגביל ל-3):
 * הקבוצה הראשונה על התשובה, והשאר בהודעות המשך. כל כפתור מכל הודעה מזוהה (‎menuPick‎).
 */
function moreMenuGroups(keys) {
  const rest = keys.slice(2).map(menuButtonOf);
  const groups = [];
  for (let i = 0; i < rest.length; i += 3) groups.push(rest.slice(i, i + 3));
  return groups;
}

const normBtn = (x) => String(x ?? '').replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();

/** הכיתוב של כפתור מהתפריט הראשי — מזוהה גם כשהתפריט כבר לא "פתוח" (כפתור מהודעה ישנה) */
function isMenuButton(text) {
  const t = normBtn(text);
  // רק הכפתורים שבתפריט היום — כפתור שירד מהתפריט (מהודעה ישנה) עובר ל-AI כבקשה רגילה
  return t === normBtn(MENU_MORE) || t === 'עוד אפשרויות' || MENU.some(([key]) => normBtn(MENU_BUTTON[key]) === t);
}

/** כפתור שנלחץ (או הכיתוב שלו) ← מספר האפשרות בתפריט; ‎'more'‎ — כל שאר האפשרויות; ‎null‎ — לא כפתור */
function menuPick(draft, text) {
  const n = normBtn;
  const t = n(text);
  if (t === n(MENU_MORE) || /^עוד( אפשרויות)?$/.test(t)) return 'more';
  const i = (draft?.options ?? []).findIndex((k) => n(menuButtonOf(k)) === t || n(MENU.find((m) => m[0] === k)?.[2]) === t);
  return i >= 0 ? i + 1 : null;
}


/** כותרת התפריט; כשכל האפשרויות נכנסות בהודעה אחת (אין "עוד אפשרויות") — גם שורת השפה החופשית */
const menuText = (options = []) => `*במה אפשר לעזור היום?* 👇${options.length && options.length <= 3 ? `\n\n${MENU_FREE_HINT}` : ''}`;


const timeOf = (iso) => new Date(iso).toLocaleTimeString('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const SUGGESTIONS_SHOWN = LETTERS.length;

// "אשר א" / "דחה ב ו-ג" — אותיות ולא מספרים, כדי שלא יתבלבלו עם מספרי המשימות
const SUGGESTION_CMD = /^(אשר|אשרי|תאשר|תאשרי|דחה|דחי|תדחה|תדחי)\s+(?:את\s+)?([א-ה](?:['׳]|(?=[\s,.!]|$))(?:\s*(?:,|ו-?)?\s*[א-ה](?:['׳]|(?=[\s,.!]|$)))*)\s*[.!]*$/;


/** "אשר א ו-ג" ← ‎{approve: true, letters: ['א', 'ג']}‎ */
function parseSuggestionCommand(text) {
  const m = SUGGESTION_CMD.exec(String(text ?? '').trim());
  if (!m) return null;
  const letters = [...new Set(m[2].replace(/['׳]/g, '').replace(/ו-?(?=[א-ה])/g, ' ').match(/[א-ה]/g) ?? [])];
  return letters.length ? { approve: m[1].startsWith('א') || m[1].startsWith('תא'), letters } : null;
}


// "סגור א" / "פנה ב" — לפי ההצעה "💡 איך לסגור" של ההצעה. אות אחת בכל פעם
const CLOSURE_CMD = /^(סגור|תסגור|סגרי|תסגרי|פנה|תפנה|פני|תפני)\s+(?:את\s+)?([א-ה])['׳]?\s*[.!]*$/;


function parseClosureCommand(text) {
  const m = CLOSURE_CMD.exec(String(text ?? '').trim());
  return m ? { letter: m[2] } : null;
}


/** שורת 💡 קצרה מתחת להצעה ב-Today — מה עושים, למי */
function closureHint(c) {
  if (!usableClosure(c)) return null;
  const cut = (x, n = 90) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);
  if (c.kind === 'self') return `   💡 לבד: ${cut(c.steps.join(' · '))}`;
  if (c.kind === 'assign') return `   💡 בדרך כלל של ${c.primary.name}`;
  return `   💡 ${c.primary.channel === 'whatsapp' ? '💬' : '📧'} ${c.primary.name} — ${cut(c.primary.instruction)}`;
}


/** ההיסטוריה של השיחה (‎{role, text}‎) כזוגות שאלה-תשובה — להמשך שאלה ב"✨ שאל" */
function pairsOf(history = []) {
  const out = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].role === 'user' && history[i + 1].role === 'bot') out.push({ q: history[i].text, a: history[i + 1].text });
  }
  return out.slice(-3);
}

const DAY_SHOWN = 3;

const WALK_MAX = 12;

const cut = (x, n = 90) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };


/** הפריטים של "דורש ממך היום", מהדחוף לפחות. ‎insights‎ — התובנות "דורש ממך" (אם נאספו בזמן) */
function dayItems(t, insights = []) {
  const items = [];
  const today = localDay(0);
  for (const x of t.tasks.overdue) {
    const days = x.dueDate ? Math.max(1, Math.round((Date.parse(today) - Date.parse(localDate(new Date(x.dueDate)).date)) / DAY)) : 1;
    items.push({ t: 'task', id: x.id, title: x.title, sub: `באיחור מ-${dueLabel(x)}${x.projectName ? ` · 📁 ${x.projectName}` : ''}`, score: 3 + Math.min(days, 10) / 100 });
  }
  for (const x of t.tasks.today) {
    items.push({ t: 'task', id: x.id, title: x.title, sub: `להיום${x.projectName ? ` · 📁 ${x.projectName}` : ''}`, score: { urgent: 2.6, high: 2.2 }[x.priority] ?? 1.2 });
  }
  for (const x of t.suggestions?.items ?? []) {
    const d = x.data ?? {};
    // 📧 מהמייל — "מייל שמחכה לך", אותו פריט כמו תובנה "דורש ממך" (‎mail-push.js‎, 10.11.26)
    if (x.kind === 'task' && x.origin?.source === 'mail') {
      const m = MailPush.mailItem({ sug: x });
      items.push({ ...m, sub: `📧 ${m.fromName || m.fromEmail}`, hint: closureHint(d.closure)?.trim() ?? null, score: x.older ? 0.5 : 2 });
      continue;
    }
    const closure = usableClosure(d.closure) ? d.closure : null;
    items.push({
      t: 'sug', id: x.id, kind: x.kind, title: d.title ?? x.subject, sub: `${x.origin?.icon ?? ''} ${x.origin?.label ?? ''}`.trim(),
      hint: closureHint(closure)?.trim() ?? null, closure: Boolean(closure),
      score: x.older ? 0.5 : x.kind === 'task' ? 2 : 1.6
    });
  }
  for (const x of insights) {
    if (x.source === 'mail') {
      const m = MailPush.mailItem({ ins: x });
      items.push({ ...m, sub: `📧 ${x.label}`, score: x.importance >= 3 ? 2.8 : 2.1 });
    } else {
      items.push({ t: 'ins', ref: x.ref, title: x.insight, sub: `${Insights.ICON[x.source] ?? '💬'} ${x.label}`, source: x.source, score: x.importance >= 3 ? 2.8 : 2.1 });
    }
  }
  // שרשור אחד — פריט אחד (ההצעה גוברת על התובנה)
  return MailPush.onePerThread(items.sort((a, b) => b.score - a.score));
}


function todayMessage(t, now = new Date(), { insights = [] } = {}) {
  const events = t.calendar.events.filter((e) => (e.allDay || new Date(e.end) > now) && !e.declined && !Calendar.isDayStatus(e));
  const lines = [`☀️ *היום — ${t.dateLabel}*`];
  if (events.length) lines.push('', ...events.slice(0, 6).map((e) => `📅 ${e.allDay ? 'כל היום' : timeOf(e.start)} ${cut(e.title, 70)}`));
  if (t.counts.meetings) lines.push(`🗓 ${t.counts.meetings === 1 ? 'פגישה אחת מחכה' : `${t.counts.meetings} פגישות מחכות`} להחלטה.`);
  const all = dayItems(t, insights);
  const items = all.slice(0, WALK_MAX);
  const total = all.length;
  const shown = items.slice(0, DAY_SHOWN);
  if (shown.length) {
    lines.push('', `🔥 *דורש ממך היום* (${total}):`, ...shown.map((x, i) => `${i + 1}. ${cut(x.title, 80)}${x.sub ? ` — ${x.sub}` : ''}`));
    if (total > shown.length) lines.push(`ועוד ${total - shown.length}${total > WALK_MAX ? ' — באפליקציה' : ''}.`);
  } else if (!events.length && !t.counts.meetings) {
    lines.push('', 'אין לך משהו מתוכנן להיום 🎉');
  } else {
    lines.push('', 'אין משהו שדורש ממך היום 🎉');
  }
  // "סיימתי את 2" — רק כשבמקום 2 יש משימה
  return { text: lines.join('\n'), ids: shown.map((x) => (x.t === 'task' ? x.id : 0)), items, suggestions: [] };
}


/** פריט אחד במעבר: מה הוא, ולמטה — הכפתורים (‎walkButtons‎) */
function walkText(x, i, n) {
  const head = `*${i + 1}/${n}* · ${x.t === 'task' ? '📋' : x.t === 'mail' ? '📧' : x.t === 'ins' ? '📬' : '💡'} *${cut(x.title, 160)}*`;
  return [head, x.sub || null, x.hint || null].filter(Boolean).join('\n');
}


function walkButtons(x) {
  if (x.t === 'task') return [WALK.done, WALK.tomorrow, WALK.next];
  // 📧 מייל שמחכה לך — אותם כפתורים, מהצעה או מתובנה
  if (x.t === 'mail') return [WALK.reply, x.closure ? WALK.handle : WALK.task, WALK.ignore];
  if (x.t === 'ins') return x.source === 'mail' ? [WALK.reply, WALK.task, WALK.next] : [WALK.task, WALK.next];
  if (x.kind !== 'task') return [WALK.approve, WALK.ignore, WALK.next];
  return x.closure ? [WALK.handle, WALK.task, WALK.ignore] : [WALK.task, WALK.ignore, WALK.next];
}


/** כפתור (או מילה) של המעבר ← הפעולה. ‎null‎ — לא שייך למעבר */
function walkAction(text) {
  const n = WaUi.normalize(text);
  const is = (label, re) => WaUi.sameLabel(text, label) || re.test(n);
  if (is(WALK.start, /^(?:לעבור\s+עליה(?:ם|ן)|נעבור\s+עליה(?:ם|ן)|תעביר\s+אותי)$/)) return 'start';
  if (is(WALK.next, /^(?:הבא|הבאה|דלג|תדלג|אחר\s+כך|נמשיך|המשך)$/)) return 'next';
  if (is(WALK.done, /^(?:סיימתי|בוצע|עשיתי|סגור)$/)) return 'done';
  if (is(WALK.tomorrow, /^(?:למחר|מחר|להעביר\s+למחר|תעביר\s+למחר)$/)) return 'tomorrow';
  if (is(WALK.task, /^(?:למשימה|משימה|תפתח\s+משימה|לפתוח\s+משימה)$/)) return 'task';
  if (is(WALK.handle, /^(?:לטפל|תטפל|טפל|לפי\s+ההצעה)$/)) return 'handle';
  if (is(WALK.ignore, /^(?:להתעלם|התעלם|תתעלם|לא\s+רלוונטי)$/)) return 'ignore';
  if (is(WALK.reply, /^(?:לענות|תענה|תשובה)$/)) return 'reply';
  if (is(WALK.approve, /^(?:מאשר|מאשרת|אשר|תאשר)$/)) return 'approve';
  return null;
}


async function todayText(actor, { insights = [] } = {}) {
  const t = await Today.build(actor);
  return { ...todayMessage(t, new Date(), { insights }), t };
}

module.exports = {
  MENU, MENU_FREE_HINT, MENU_MORE, PLAIN_AGENTS, agentsText, cut, dayItems, isMenuButton, menuButtonOf, menuButtons, menuOptions, menuPick, menuText, moreMenuGroups, pairsOf, parseClosureCommand, parseSuggestionCommand, recordingReply, todayMessage, walkAction, walkButtons, walkText
};
