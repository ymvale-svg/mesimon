'use strict';
/**
 * בוט הוואטסאפ — מייל — מייל לאיש קשר, החלטות על הצעות, ומייל חדש שהבוט מקפיץ.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups ← wa-private ← wa-tasks ← wa-proactive.
 */
const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const Auth = require('../core').Auth;
const MailScan = require('../mail').MailScan;
const P = require('../core').Permissions;
const Gmail = require('../integrations').Gmail;
const AiTasks = require('../tasks').AiTasks;
const GContacts = require('../phonebook').GoogleContacts;
const WaActions = require('./wa-actions');
const MailInsights = require('../mail').MailInsights;
const MailThread = require('../mail').MailThread;
const MailPush = require('../mail').MailPush;
const WaScan = require('./whatsapp-scan');
const Business = require('./wa-business');
const GoodsReceipt = require('../priority').GoodsReceipt;
const PurchaseDemand = require('../priority').PurchaseDemand;
const WaUi = require('./wa-ui');
const MailActions = require('../mail').MailActions;
const FormFill = require('../mail').FormFill;
const MeetCoord = require('../meetings').MeetingCoord;
const SentFollowup = require('../mail').SentFollowup;
const { DAY, LETTERS, WALK, appRoot, emailText, hooks, log, mailAlertUsers, needsLook, orgUsers, parseJson, sendButtons, signatureFields, taskLink, usableClosure, workHours } = require('./wa-base');
const { chatOf, checkDraft, localDay, mergedChecklist, saveChat, shortDate } = require('./wa-private');
const { rememberBot } = require('./wa-tasks');
const { busyFor, freeToAsk } = require('./wa-proactive');

// מילים שאינן מזהות חברה — "משרד עורכי הדין כהן" מזוהה לפי "כהן"
const ORG_NOISE = new Set(['משרד', 'עורכי', 'עורך', 'דין', 'עוד', 'עו״ד', 'חברת', 'חברה', 'קבוצת', 'בעמ', 'של', 'מהמשרד', 'ממשרד', 'מחברת', 'מהחברה', 'יועץ', 'היועץ']);


/**
 * הנמען לפי שם, ואם נאמרה חברה — רק מי שהחברה מופיעה אצלו (בארגון, בתפקיד
 * או בכתובת). רק מי שיש לו מייל, או עובד בארגון.
 */
function findRecipients(actor, name, org = '', { only = null } = {}) {
  const results = (hooks.mail?.searchContacts(actor, name || org, { only }) ?? []).filter((c) => c.email || c.type === 'user');
  const tokens = GContacts.fold(org).split(/\s+/).map((w) => w.replace(/^(מה|מ|ה|ב|ל)(?=\S{3})/, '')).filter((w) => w.length >= 2 && !ORG_NOISE.has(w));
  if (!name || !tokens.length) return onlyColleague(results, name, { org, only });
  const narrowed = results.filter((c) => {
    const hay = GContacts.fold([c.name, c.organization, c.title, ...(c.emails ?? []).map((e) => e.value)].join(' '));
    return tokens.some((tk) => hay.includes(tk));
  });
  return narrowed.length ? narrowed : results;
}


/**
 * שם שמתאים לעובד אחד בלבד במשימון — הכוונה אליו, גם כשיש באנשי הקשר עוד
 * אנשים באותו שם ("שושנה" = שושנה מהחברה). שני עובדים או יותר באותו שם —
 * נשארת השאלה "למי מהם?". לא חל כשנאמרה חברה, או כשביקשו מגוגל / מהאלפון.
 */
function onlyColleague(results, name, { org = '', only = null } = {}) {
  if (results.length < 2 || !name || org || only) return results;
  const words = GContacts.fold(name).split(/\s+/).filter(Boolean);
  if (!words.length) return results;
  const colleagues = results.filter((c) => {
    if (c.type !== 'user') return false;
    const own = GContacts.fold(c.name).split(/\s+/);
    return words.every((w) => own.includes(w));
  });
  return colleagues.length === 1 ? colleagues : results;
}


const contactOf = (c) => ({ name: c.name, email: c.email ?? '', phone: c.phone ?? '', type: c.type, refId: c.refId ?? null, organization: c.organization ?? '' });


/*
 * עובד בארגון — בבוט שתי דרכים: מייל מהתיבה שלי (ברירת המחדל, "כן"), או
 * משימה במשימון ("במשימון"), שמשויכת אליו עם ההתראות הרגילות. באפליקציה
 * שליחה לעובד היא תמיד משימה במשימון — שם אין מייל לעובד.
 */
const VIA_MESIMON = /^(?:(?:ת?שלח|תעביר|תפתח)\s+(?:ל[והם]\s+)?(?:את\s+זה\s+)?)?(?:ב|דרך\s+(?:ה)?)משימון[\s.!]*$/;

const VIA_EMAIL = /^(?:(?:כן\s*,?\s*)?(?:ת?שלח\s+(?:ל[והם]\s+)?)?(?:ב|דרך\s+(?:ה)?)מייל)[\s.!]*$/;


/** הפתרון — מעל הטיוטה הראשונה */
function solveText(r) {
  const lines = [
    r.understood ? `💡 *הבנתי:* ${r.understood}` : '💡',
    '',
    `*מה עושים*${r.fromExperience ? ' _(לפי הניסיון בחברה)_' : ''}:`,
    r.solution
  ];
  if (r.options.length) {
    lines.push('', '📒 *למי לפנות:*', ...r.options.map((o, i) => {
      const c = o.contact;
      const how = [c.mobile || c.phone ? `📞 ${c.mobile || c.phone}` : null, c.email ? `✉️ ${c.email}` : null].filter(Boolean).join(' · ');
      return `${i + 1}. *${c.name}*${c.tag ? ` · ${c.tag}` : ''}${o.why ? ` — ${o.why}` : ''}${how ? `\n   ${how}` : ''}`;
    }));
  } else if (r.noContact) {
    lines.push('', `📒 ${r.noContact}`);
  }
  if (r.sources.length) lines.push('', `_מקורות: ${r.sources.join(' · ')}_`);
  return lines.join('\n');
}


/** טיוטה (או תיקון שלה) — עם ההתכתבות האחרונה עם הנמען, להצעות מה להוסיף */
async function draftEmail(actor, contact, instruction, { feedback = '', previous = null, dry = false, channel = null, solve = null } = {}) {
  const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
  // וואטסאפ — רק מ"💡 פתרון לבעיה", לנייד, למי שחיבר וואטסאפ. עובד בארגון — תמיד מייל או משימון
  const via = contact.type === 'user' ? 'email' : channel ?? previous?.channel ?? 'email';
  // בבדיקה ממסך הניהול (‎dry‎) לא קוראים את התיבה של העובד
  const context = previous || dry || via !== 'email' || !contact.email ? '' : await AiTasks.mailContext(actor.id, contact.email);
  // ↩️ בהמשך לשרשור (10.11.26): השרשורים האחרונים עם הנמען — ה-AI בוחר אם זה אותו עניין. "מייל חדש" — בלי שרשור
  const wantNew = /מייל\s+חדש|שרשור\s+חדש|לא\s+בשרשור|בלי\s+(?:ה)?שרשור|לא\s+כתשובה/.test(feedback);
  const wantThread = !wantNew && /בשרשור|בהמשך\s+ל|על\s+(?:ה)?מייל|כתשובה/.test(feedback);
  const threads = !dry && via === 'email' && contact.email && (!previous || (wantThread && !previous.replyThread))
    ? await MailThread.recentThreads(actor.id, contact.email) : [];
  const d = await AiTasks.draftInitial({
    owner, instruction, contact: via === 'whatsapp' ? { ...contact, phone: contact.mobile || contact.phone } : contact, channel: via, context,
    threads: MailThread.threadsText(threads),
    cc: previous?.cc ?? [],
    feedback, previous: previous ? previous.draft : null
  });
  const picked = threads.length ? (threads[Number(d.reply_thread) - 1] ?? (wantThread ? threads[0] : null)) : null;
  const replyThread = picked
    ? { box: picked.box, threadId: picked.threadId, subject: picked.subject, inReplyTo: picked.inReplyTo, references: picked.references, lastAt: picked.lastAt }
    : wantNew ? null : previous?.replyThread ?? null;
  if (replyThread) d.subject = `Re: ${replyThread.subject}`;
  const resolved = resolveCc(actor, d.cc_names, { previous: previous?.cc ?? [], contact });
  const { ccAsk } = resolved;
  // תשובה בשרשור — מי שכבר היה בו נשאר בהעתק (כמו "השב לכולם")
  const cc = picked ? [...resolved.cc, ...MailThread.threadCc(actor.id, picked, contact.email).filter((p) => !resolved.cc.some((c) => c.email === p.email))] : resolved.cc;
  const suggestions = (Array.isArray(d.suggestions) ? d.suggestions : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
  return {
    kind: 'email',
    channel: via,
    // מ"💡 פתרון לבעיה": הבעיה, הפתרון והחלופות — לבחירה באחר ("2") ולהחלפת ערוץ
    solve: solve ?? previous?.solve ?? null,
    // נוסח למשימה קיימת ("לבקש הצעת מחיר מ…") — "כן" שולח עליה, ולא פותח משימה חדשה
    taskId: previous?.taskId ?? null,
    instruction,
    contact,
    draft: {
      title: String(d.title ?? '').trim().slice(0, 120),
      goal: String(d.goal ?? '').trim(),
      success_criteria: String(d.success_criteria ?? '').trim(),
      subject: String(d.subject ?? '').trim().slice(0, 200),
      body: String(d.body ?? '').trim()
    },
    // בתיקון ההתכתבות אינה נקראת שוב — ההצעות שעוד לא נוספו נשארות
    suggestions: previous ? (suggestions.length ? suggestions : previous.suggestions.filter((x) => !feedback.includes(x))) : suggestions,
    notes: String(d.notes ?? '').trim().slice(0, 300),
    cc: via === 'email' ? cc : [],
    ccAsk: via === 'email' ? ccAsk : [],
    replyThread: via === 'email' ? replyThread : null,
    ...(via === 'email' ? await signatureFields(actor.id) : { signature: false, noSignature: null })
  };
}


/**
 * מי בהעתק — מהשמות שה-AI הוציא מהבקשה ("תשים בכתב את דני"). כתובת שנכתבה
 * נלקחת כמו שהיא; שם — מחפשים באנשי הקשר. התאמה אחת עם מייל נכנסת; כמה
 * התאמות, או אף אחת — שואלים (‎ccAsk‎), ולא מנחשים על מי לשלוח העתק.
 */
function resolveCc(actor, names, { previous = [], contact = {} } = {}) {
  const cc = [];
  const ccAsk = [];
  const known = new Map(previous.map((c) => [c.email, c]));
  for (const raw of (Array.isArray(names) ? names : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 10)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) { cc.push(known.get(raw.toLowerCase()) ?? { name: '', email: raw.toLowerCase() }); continue; }
    // מי שכבר היה בהעתק בטיוטה הקודמת — נשאר בלי לחפש שוב
    const kept = previous.find((c) => c.name && GContacts.fold(c.name) === GContacts.fold(raw));
    if (kept) { cc.push(kept); continue; }
    const found = findRecipients(actor, raw).filter((c) => c.email);
    if (found.length === 1) cc.push({ name: found[0].name, email: found[0].email });
    else ccAsk.push({ name: raw, options: found.slice(0, 5).map((c) => ({ name: c.name, email: c.email, org: c.organization || '' })) });
  }
  return { cc: AiTasks.cleanCc(cc, { contactEmail: contact.email }), ccAsk };
}


// ➕ להוסיף אנשים לשרשור של מייל שכבר יצא (10.11.26, ישראל: "אפשר לעשות פלוס שרי הרשקוביץ — ולכתב אותה לשרשור,
// שיענו בסופו של דבר לשניים"): "+שרי הרשקוביץ", "פלוס שרי", "תוסיף להתכתבות גם את שרי", "תכתב את דני למייל"
const THREAD_PLUS = /^(?:\+|פלוס\s+)\s*(\S.*)$/;

const THREAD_ADD_VERB = /^ו?(?:תוסיף|תוסיפי|הוסף|להוסיף|תכתב|תכתבי|לכתב|תצרף|תצרפי|צרף|לצרף|תשים|תשימי)(?:\s|$)/;

const THREAD_WORD = /(?:^|\s)(?:ל|ב|ה)?(?:התכתבות|שרשור|מייל|העתק|כתב|cc)(?=\s|$|[,.!])/i;


function parseThreadAdd(text) {
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '');
  let names = null;
  const plus = THREAD_PLUS.exec(t);
  if (plus) names = plus[1];
  else if (THREAD_ADD_VERB.test(t) && THREAD_WORD.test(t)) {
    const m = /(?:^|\s)(?:גם\s+)?את\s+(.+)$/.exec(t);
    if (!m) return { names: [] };
    names = m[1];
  } else return null;
  // מה שאחרי השם ("בהעתק", "למייל ללייסנטק") — לא חלק מהשם
  const cut = names.search(THREAD_WORD);
  if (cut > 0) names = names.slice(0, cut);
  const list = names.split(/\s*,\s*|\s+ו?את\s+|\s+\+\s*/).map((x) => x.replace(/^גם\s+/, '').trim()).filter((x) => x.length > 1);
  return { names: list.slice(0, 5) };
}


/** השורה לאישור: את מי, לאיזה שרשור, ולמי התשובה */
function threadAddText(d) {
  const who = d.people.map((c) => `${c.name || c.email}${c.name ? ` <${c.email}>` : ''}`).join(', ');
  const to = d.to ? `${d.to.name || d.to.email}` : '';
  return [
    `➕ *להוסיף את ${who}* לשרשור *"${d.thread.subject}"*?`,
    `אשלח בשרשור תשובה לכולם${to ? ` (ל${/^[א-ת]/.test(to) ? '' : '-'}${to})` : ''} עם "+${d.people.map((c) => c.name || c.email).join(', +')}" ובהעתק — כך שהתשובה תגיע לכולם.`
  ].join('\n');
}


/** הבקשה להוסיף הצעה לפי מספר: "תוסיף את 1", "1 ו-3", "2" */
function suggestionFeedback(text, suggestions) {
  const m = /^(?:כן[\s,]*)?(?:תוסיף|תוסיפי|הוסף|להוסיף|גם)?\s*(?:את)?\s*((?:\d\s*(?:,|ו-?|\s)?\s*)+)$/.exec(text.trim());
  if (!m || !suggestions.length) return null;
  const picked = [...new Set((m[1].match(/\d/g) ?? []).map(Number))].map((n) => suggestions[n - 1]).filter(Boolean);
  return picked.length ? `הוסף למייל: ${picked.join('; ')}` : null;
}


function createFromDraft(actor, original) {
  // בדיקה אחרונה לפני הפתיחה — הרשאות יכולות להשתנות בין הטיוטה ל"כן"
  const draft = checkDraft(actor, original);
  const assignee = draft.assigneeId || actor.id;
  const { tpl, items } = mergedChecklist(actor, draft);
  const tplDesc = String(tpl?.payload?.description ?? '').trim();
  return hooks.createTask(actor, {
    title: draft.title,
    description: [draft.summary, tplDesc && tplDesc !== draft.summary ? tplDesc : null, '', '💬 נפתחה מוואטסאפ'].filter((x) => x !== null).join('\n').trim(),
    projectId: draft.projectId || null,
    assigneeType: 'user',
    assigneeId: assignee,
    // מי שפתח למישהו אחר נשאר שותף — אחרת המשימה נעלמת לו מהעיניים
    extraAssignees: assignee !== actor.id ? [{ type: 'user', id: actor.id }] : [],
    // עדיפות שלא נאמרה (רגילה) נלקחת מהתבנית
    priority: draft.priority === 'normal' && ['high', 'urgent'].includes(tpl?.payload?.priority) ? tpl.payload.priority : draft.priority,
    dueDate: draft.dueDate ? new Date(`${draft.dueDate}T17:00:00+03:00`).toISOString() : null,
    checklist: items,
    source: 'whatsapp',
    sourceUserId: actor.id,
    auditNote: tpl ? `המשימה נפתחה מוואטסאפ מהתבנית "${tpl.name}"` : 'המשימה נפתחה מוואטסאפ'
  });
}


/** ביצוע מה שהעובד אישר ב"כן". בבדיקה ממסך הניהול (‎dry‎) — רק מתארים */
async function confirmPending(actor, pending, dry) {
  const kind = pending.kind ?? 'task';
  // פנייה יזומה על מייל חדש (‎mailAlerts‎) — לפי הפעולה "מייל חדש — הבוט פונה"
  const action = pending.solve ? 'solve' : pending.alert ? 'mail_alert' : { task: 'create_task', email: 'send_email', mail_reply: 'mail_insights' }[kind] ?? kind;
  if (!WaActions.allowed(actor, action)) {
    return { reply: 'הפעולה הזו כבר אינה זמינה לך בוואטסאפ.', action, status: 'denied', result: 'הפעולה כובתה' };
  }
  const test = dry ? ' (בדיקה — לא בוצע באמת)' : '';
  try {
    if (kind === 'task') {
      const id = dry ? null : createFromDraft(actor, pending);
      const link = id ? taskLink(id) : null;
      return { reply: `✅ נפתחה משימה: ${pending.title}${test}${link ? `\n${link}` : ''}`, action, status: 'ok', result: `נפתחה משימה: ${pending.title}`, taskId: id };
    }
    if (kind === 'complete') {
      if (!dry) hooks.tasks.complete(actor, pending.taskId);
      return { reply: `✅ ${pending.cancel ? 'בוטלה (נסגרה)' : 'סומן כבוצע'}: ${pending.title}${test}`, action, status: 'ok', result: `נסגרה: ${pending.title}`, taskId: pending.taskId };
    }
    if (kind === 'comment') {
      if (!dry) hooks.tasks.comment(actor, pending.taskId, pending.text);
      return { reply: `💬 ההערה נוספה ל: ${pending.title}${test}`, action, status: 'ok', result: `הערה ל"${pending.title}": ${pending.text}`, taskId: pending.taskId };
    }
    if (kind === 'mail_reply') {
      const r = pending.reply;
      if (!dry) await MailInsights.sendReply(actor.id, r);
      // מהפנייה היזומה: ההצעה מהמייל נענתה — יורדת מ"ממתין לאישורך"
      if (!dry && pending.suggestionIds?.length) closeAlerted(actor.id, pending.suggestionIds, 'replied');
      return { reply: `📧 התשובה נשלחה ל${r.toName || r.to}.${test}`, action, status: 'ok', result: `תשובה ל${r.toName || r.to}: ${r.subject}` };
    }
    if (kind === 'mail_task') {
      const lines = [];
      let taskId = null;
      for (const id of pending.suggestionIds ?? []) {
        const sug = D.get("SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ? AND status = 'pending'", id, actor.id);
        if (!sug) continue;
        const d = parseJson(sug.data, {});
        if (needsLook(d)) {
          const root = appRoot();
          lines.push(`"${d.title}" — יש בה אנשים נוספים או פנייה החוצה; כדאי לבדוק ולאשר באפליקציה.${root ? `\n${root}/?view=today` : ''}`);
          continue;
        }
        taskId = dry ? null : await MailScan.approve(id, actor, { dueDate: d.dueDate || localDay(0) });
        lines.push(`✅ נפתחה משימה: ${d.title}${d.dueDate && d.dueDate !== localDay(0) ? ` · 📅 ${shortDate(d.dueDate)}` : ''}${test}${taskId ? `\n${taskLink(taskId) ?? ''}` : ''}`.trim());
      }
      if (!lines.length) return { reply: 'ההצעה כבר טופלה 👍', action, status: 'ok', result: 'כבר טופלה' };
      return { reply: lines.join('\n'), action, status: 'ok', result: lines.join(' · ').slice(0, 300), taskId };
    }
    if (kind === 'email' && pending.taskId) {
      const who = pending.contact.name || pending.contact.email;
      if (pending.ccAsk?.length) {
        return { reply: `לפני השליחה — עוד לא ברור מי בהעתק: ${pending.ccAsk.map((x) => `"${x.name}"`).join(', ')}. כתבו *בהעתק* עם השם המלא או המייל, או *בלי* והשם.`, action, status: 'unclear', result: 'העתק לא ברור', keep: true };
      }
      if (!dry) {
        await hooks.mail.sendOutreach(actor, pending.taskId, {
          draft: pending.draft, cc: pending.cc ?? [],
          contact: { name: pending.contact.name, email: pending.contact.email, type: pending.contact.type, refId: pending.contact.refId ?? null }
        });
      }
      const link = taskLink(pending.taskId);
      return {
        reply: `📧 נשלח ל${who}. המשימה במעקב — אעדכן כשתגיע תשובה.${test}${link ? `\n${link}` : ''}`,
        action, status: 'ok', result: `נשלח מייל למשימה #${pending.taskId} ל${who}: ${pending.draft.subject}`, taskId: pending.taskId
      };
    }
    if (kind === 'email') {
      const who = pending.contact.name || pending.contact.email;
      // עובד בארגון: "במשימון" — משימה משויכת אליו; אחרת — מייל, כמו לכל נמען
      const internal = pending.contact.type === 'user' && pending.via === 'mesimon';
      if (!P.may(actor, 'create_task')) throw new Error('אין לך הרשאה לפתוח משימות');
      const wa = pending.channel === 'whatsapp' && pending.contact.type !== 'user';
      const contact = pending.contact.type === 'user' && !internal
        ? { name: pending.contact.name, email: pending.contact.email, phone: '', type: 'external', refId: null }
        : wa ? { ...pending.contact, phone: pending.contact.mobile || pending.contact.phone } : pending.contact;
      // אותה פתיחה של האשף באפליקציה: משימת AI שעוקבת אחרי התשובה
      // שם בהעתק שעוד לא הובהר — לא שולחים עד שיהיה ברור למי
      if (!internal && pending.ccAsk?.length) {
        return { reply: `לפני השליחה — עוד לא ברור מי בהעתק: ${pending.ccAsk.map((x) => `"${x.name}"`).join(', ')}. כתבו *בהעתק* עם השם המלא או המייל, או *בלי* והשם.`, action, status: 'unclear', result: 'העתק לא ברור', keep: true };
      }
      const r = dry ? { taskId: null, sendError: null } : await hooks.mail.createAiTask(actor, {
        instruction: pending.instruction, draft: pending.draft, contact, channel: wa ? 'whatsapp' : 'email',
        cc: internal || wa ? [] : pending.cc ?? [],
        // ↩️ בהמשך לשרשור עם הנמען — תשובה בו, לא מייל חדש
        ...(!internal && !wa && pending.replyThread ? { replyThread: pending.replyThread } : {}),
        // מ"סגור א": המשימה נפתחת מההצעה (ונעלמת מ"ממתין לאישורך")
        ...(pending.suggestionId ? { suggestionId: pending.suggestionId } : {})
      });
      const link = r.taskId ? taskLink(r.taskId) : null;
      if (r.sendError) {
        return { reply: `⚠️ המשימה נפתחה, אבל ${wa ? 'ההודעה בוואטסאפ' : 'המייל'} לא יצא${wa ? 'ה' : ''}: ${r.sendError}\nאפשר לשלוח שוב מכרטיס המשימה.${link ? `\n${link}` : ''}`, action, status: 'error', result: `המייל ל${who} לא יצא: ${r.sendError}`, taskId: r.taskId };
      }
      return {
        reply: `${internal ? `👤 הועבר ל${who} — המשימה אצלו/ה במשימון.` : `${wa ? '💬 נשלח בוואטסאפ' : '📧 נשלח'} ל${who}. אעקוב אחרי התשובה ואעדכן אותך.`}${test}${link ? `\n${link}` : ''}`,
        action, status: 'ok', result: `${internal ? 'הועבר' : wa ? 'נשלח וואטסאפ' : 'נשלח מייל'} ל${who}: ${pending.draft.subject || pending.draft.title}`, taskId: r.taskId
      };
    }
  } catch (err) {
    // הרשאה, תלות שלא הושלמה, משימה שנסגרה בינתיים — העובד שומע למה
    // עובד שאין הרשאה לשייך אליו במשימון — מייל עדיין אפשרי
    const viaEmail = kind === 'email' && pending.contact?.type === 'user' && pending.via === 'mesimon' ? '\nאפשר לשלוח לו במייל במקום: השיבו *כן*.' : '';
    return { reply: `❌ לא הצלחתי: ${err.message}${viaEmail}`, action, status: 'error', result: err.message, keep: ['task', 'email', 'mail_reply'].includes(kind) };
  }
  return { reply: 'לא ברור מה לאשר.', action, status: 'unclear', result: '' };
}


/**
 * "אשר א" / "דחה ב" — החלטה על הצעות מה-Today האחרון, ישר מהוואטסאפ. כמו
 * הכפתורים במסך Today: אישור פותח משימה (עם היעד שבהצעה, או היום), דחייה —
 * "לא משימה". הצעה שדורשת מבט (אנשים נוספים, ספק, פנייה החוצה) — באפליקציה.
 * מהדחייה השנייה מאותו שולח בוואטסאפ האישי — מציעים "לא לסרוק אותו".
 */
/**
 * "סגור א" — מה שהוצע ב-💡 של ההצעה:
 *   • פנייה — טיוטת מייל לנמען שהוצע, לאישור ב"כן" (אותה זרימה של "שלח מייל"):
 *     משימת AI נפתחת מההצעה ועוקבת אחרי התשובה. בלי כתובת — שואלים מה המייל.
 *   • להעביר לעובד — המשימה נפתחת אצלו (ואני נשאר שותף), כמו באפליקציה.
 *   • לבד — המשימה נפתחת אצלי, והצעדים כצ'קליסט.
 * כמו כל פנייה החוצה: שום דבר לא נשלח בלי "כן".
 */
async function closureDecision(actor, { letter }, state, { dry, out }) {
  const test = dry ? ' (בדיקה — לא בוצע באמת)' : '';
  const id = (state.suggestions ?? [])[LETTERS.indexOf(letter)];
  const sug = id ? D.get('SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ?', id, actor.id) : null;
  if (!sug) return out(`${letter}. לא מצאתי — כתבו "היום" לרשימה מעודכנת.`, {}, { action: 'today', status: 'unclear', result: `אין הצעה ${letter}` });
  const d = parseJson(sug.data, {});
  const c = d.closure;
  const title = d.title ?? sug.subject;
  if (sug.status !== 'pending' || sug.kind !== 'task') return out(`${letter}. "${title}" — כבר טופלה.`, {}, { action: 'today', status: 'ok', result: 'כבר טופלה' });
  if (!usableClosure(c)) return out(`ל"${title}" אין הצעה איך לסגור. אפשר "אשר ${letter}" — והמשימה תיפתח אצלך.`, {}, { action: 'today', status: 'unclear', result: 'אין הצעת סגירה' });

  if (c.kind === 'self' || c.kind === 'assign') {
    if (c.kind === 'assign' && !WaActions.allowed(actor, 'create_task')) return out('פתיחת משימה לעמית אינה זמינה לך בוואטסאפ.', {}, { action: 'today', status: 'denied', result: 'פתיחת משימה כבויה' });
    try {
      const edits = c.kind === 'self'
        ? { dueDate: d.dueDate || localDay(0), checklist: [...(d.checklist ?? []), ...c.steps.filter((x) => !(d.checklist ?? []).includes(x))] }
        : { dueDate: d.dueDate || localDay(0), people: [{ userId: c.primary.refId, role: 'assignee', checklistIndex: 0 }] };
      const taskId = dry ? null : await MailScan.approve(id, actor, edits);
      const link = taskId ? taskLink(taskId) : null;
      return out(c.kind === 'self'
        ? `✅ נפתחה משימה: ${title}
הצעדים בצ'קליסט: ${c.steps.join(' · ')}${test}${link ? `
${link}` : ''}`
        : `👤 הועבר ל${c.primary.name}: ${title} — את/ה נשאר/ת שותף/ה.${test}${link ? `
${link}` : ''}`,
      {}, { action: 'today', status: 'ok', result: `${c.kind === 'self' ? 'נפתחה לבד' : `הועבר ל${c.primary.name}`}: ${title}`, taskId });
    } catch (err) {
      return out(`❌ לא הצלחתי: ${err.message}`, {}, { action: 'today', status: 'error', result: err.message });
    }
  }

  // פנייה החוצה
  if (!WaActions.allowed(actor, 'send_email')) return out('שליחת מייל אינה זמינה לך בוואטסאפ. אפשר לפנות מהאפליקציה.', {}, { action: 'send_email', status: 'denied', result: 'שליחת מייל כבויה' });
  if (!Claude.isEnabled()) return out('העוזר אינו זמין כרגע.', {}, { action: 'send_email', status: 'error', result: 'אין AI' });
  const p = c.primary;
  let contact = { name: p.name, email: p.email, phone: p.phone, type: p.type || 'external', refId: p.refId ?? null };
  if (!contact.email) {
    // אין כתובת בהצעה — אולי היא באנשי הקשר; התאמה אחת בלבד, לא מנחשים
    const found = findRecipients(actor, p.name).filter((x) => x.email);
    if (found.length === 1) contact = { ...contact, name: found[0].name || contact.name, email: found[0].email, type: found[0].type ?? contact.type, refId: found[0].refId ?? contact.refId };
  }
  if (!contact.email) {
    return out(`אין לי כתובת מייל של ${p.name}. מה המייל? (אפשר גם להוסיף אותה לטבלת "אנשי המקצוע שלי")`,
      { draft: { kind: 'closure_address', suggestionId: id, contact, instruction: p.instruction } },
      { action: 'send_email', status: 'unclear', result: `חסרה כתובת ל${p.name}` });
  }
  const pending = await draftEmail(actor, contact, p.instruction, { dry });
  pending.suggestionId = id;
  return out(emailText(pending), { draft: pending, awaiting: true },
    { action: 'send_email', status: 'ok', result: `💡 טיוטה לפי ההצעה ל${contact.name || contact.email}: ${pending.draft.subject}` });
}


async function suggestionDecision(actor, { approve, letters }, state, { dry, out }) {
  if (!WaActions.allowed(actor, 'today')) {
    return out('החלטה על הצעות אינה זמינה לך בוואטסאפ.', {}, { action: 'today', status: 'denied', result: 'פעולת Today כבויה' });
  }
  const test = dry ? ' (בדיקה — לא בוצע באמת)' : '';
  const lines = [];
  const done = [];
  let taskId = null;
  for (const letter of letters) {
    const id = (state.suggestions ?? [])[LETTERS.indexOf(letter)];
    const sug = id ? D.get('SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ?', id, actor.id) : null;
    if (!sug) {
      lines.push(`${letter}. לא מצאתי — כתבו "היום" לרשימה מעודכנת.`);
      continue;
    }
    const d = parseJson(sug.data, {});
    const title = d.title ?? sug.subject;
    if (sug.status !== 'pending' || !['task', 'task_close', 'task_update', 'task_merge'].includes(sug.kind)) {
      lines.push(`${letter}. "${title}" — כבר טופלה.`);
      continue;
    }
    /*
     * "לסגור?" / "לעדכן?" על משימה שפתחתי, ומיזוג משימות כפולות. בעדכון — "אשר"
     * מאשר בדיוק את מה שהוצג בשורה (הערה, ואם הוצעו — יעד וסטטוס).
     */
    if (sug.kind !== 'task') {
      const name = sug.kind === 'task_merge' ? `"${d.dropTitle}" ו"${d.keepTitle}"` : `"${d.taskTitle}"`;
      if (approve) {
        try {
          taskId = dry ? null : await MailScan.approve(id, actor, { applyDue: true, applyStatus: true });
          lines.push(sug.kind === 'task_close' ? `✅ ${letter}. נסגרה: ${name} — ההודעה נשמרה בה כהערה${test}`
            : sug.kind === 'task_update' ? `✅ ${letter}. עודכנה: ${name}${d.proposed?.dueDate ? ` · 📅 ${shortDate(d.proposed.dueDate)}` : ''}${d.proposed?.status ? ` · ${d.proposed.statusLabel}` : ''}${test}`
              : `✅ ${letter}. מוזגו: ${name} — נשארה "${d.keepTitle}"${test}`);
          done.push(`אושרה: ${title}`);
        } catch (err) {
          lines.push(`❌ ${letter}. לא הצלחתי: ${err.message}`);
        }
        continue;
      }
      if (!dry) MailScan.reject(id, actor);
      lines.push(sug.kind === 'task_merge' ? `✕ ${letter}. לא כפולות — לא אציע אותן שוב: ${name}${test}` : `✕ ${letter}. לא קשור: ${name}${test}`);
      done.push(`נדחתה: ${title}`);
      continue;
    }
    if (approve) {
      if (needsLook(d)) {
        const root = String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
        lines.push(`${letter}. "${title}" — יש בה אנשים נוספים, פנייה החוצה או שאלה פתוחה. כדאי לבדוק ולאשר באפליקציה.${root ? `\n${root}/?view=today` : ''}`);
        continue;
      }
      try {
        taskId = dry ? null : await MailScan.approve(id, actor, { dueDate: d.dueDate || localDay(0) });
        lines.push(`✅ ${letter}. נפתחה משימה: ${title}${d.dueDate && d.dueDate !== localDay(0) ? ` · 📅 ${shortDate(d.dueDate)}` : ''}${test}`);
        done.push(`אושרה: ${title}`);
      } catch (err) {
        lines.push(`❌ ${letter}. לא הצלחתי: ${err.message}`);
      }
      continue;
    }
    if (!dry) MailScan.reject(id, actor);
    lines.push(`✕ ${letter}. נדחתה: ${title}${test}`);
    done.push(`נדחתה: ${title}`);
    if (d.personal && d.chatPhone) {
      const n = WaScan.rejectionsFrom(actor.id, d.chatPhone) + (dry ? 1 : 0);
      if (n >= 2) lines.push(`   דחית כבר ${n} הצעות מ${sug.from_name}. לא לסרוק את השיחה איתו/ה מעכשיו? כתבו: "אל תסרוק את ${sug.from_name}"`);
    }
  }
  return out(lines.join('\n'), {}, { action: 'today', status: done.length ? 'ok' : 'unclear', result: done.join(' · ') || lines.join(' · ').slice(0, 300), taskId });
}


const NO_SCAN = /^(?:אל|לא)\s+(?:ת|ל)סרוק\s+(?:יותר\s+)?(?:את\s+)?(.{2,60}?)(?:\s+(?:מעכשיו|יותר))?[.!]*$/;

const MARK_AS = /^(.{2,60}?)\s+(?:הוא\s+|היא\s+|זה\s+)?(עסקי|עסקית|אישי|אישית)[.!]*$/;

const BARE_MARK = /^(?:זה\s+)?(עסקי|עסקית|אישי|אישית)[.!]*$/;


/**
 * הוואטסאפ האישי — מהבוט: "אל תסרוק את דני", "יוסי עסקי", "050-1234567 אישי",
 * ו"עסקי" / "אישי" לבד — תשובה לשאלה האחרונה ששאלנו. רק למי שהפעיל סריקה או
 * שנשאל. ‎null‎ — לא בקשה כזו; ממשיכים כרגיל.
 */
function businessCommand(actor, t, { dry, out }) {
  const p = WaScan.prefs(actor.id);
  const pending = WaScan.lastAsked(actor.id);
  if (!p.enabled && !pending) return null;
  const meta = (result) => ({ action: 'wa_scan', status: 'ok', result });
  const test = dry ? ' (בדיקה — לא נשמר)' : '';
  const apply = (phone, name, mode) => {
    if (!dry) WaScan.mark(actor.id, phone, mode);
    const who = `${name && name !== phone ? `${name} (${Business.display(phone)})` : Business.display(phone)}`;
    return out(mode === 'business'
      ? `💼 ${who} — עסקי. מההודעה הבאה אציע ממנו משימות ותובנות (ההודעות הקודמות לא נקראות).${test}`
      : `🔒 ${who} — אישי. לא אקרא את השיחה הזו.${test}`, {}, meta(`${mode === 'business' ? 'עסקי' : 'לא לסרוק'}: ${who}`));
  };
  const modeOf = (word) => (word.startsWith('עסק') ? 'business' : 'personal');

  const bare = BARE_MARK.exec(t);
  if (bare) {
    if (!pending) return null;
    return apply(pending.phone, pending.name, modeOf(bare[1]));
  }
  const noScan = NO_SCAN.exec(t);
  const markAs = noScan ? null : MARK_AS.exec(t);
  if (!noScan && !markAs) return null;
  const query = (noScan ?? markAs)[1];
  const mode = noScan ? 'personal' : modeOf(markAs[2]);
  const found = Business.resolve(actor.id, query, p.unknown);
  if (!found.length) {
    // "יוסי עסקי" שלא נמצא — אולי בכלל לא בקשה כזו ("מייל עסקי"); "אל תסרוק" — כן
    if (!noScan) return null;
    return out(`לא מצאתי את "${query}" בשיחות שלך. אפשר לכתוב את המספר: "אל תסרוק את 050-1234567".`, {}, { action: 'wa_scan', status: 'unclear', result: `לא נמצא: ${query}` });
  }
  if (found.length > 1) {
    const word = mode === 'business' ? 'עסקי' : 'אישי';
    return out([`למי התכוונת?`, ...found.map((f, i) => `${i + 1}. ${f.name} (${Business.display(f.phone)})`), '', `כתבו את המספר עם המילה: "${Business.display(found[0].phone)} ${word}".`].join('\n'),
      {}, { action: 'wa_scan', status: 'unclear', result: `${found.length} התאמות ל"${query}"` });
  }
  return apply(found[0].phone, found[0].name, mode);
}


// ---------------------------------------------------------------------------
// 📬 מייל חדש — הבוט פונה (הוחלט 09.11.26)
// ---------------------------------------------------------------------------

/*
 * על כל מייל חדש שנשלח אליי ויש לו הצעת תשובה קונקרטית — הודעה אחת, מייל אחד בכל פעם (11.11.26):
 *   "📧 קיבלת מייל מדני: <במשפט מה ביקש>. לענות כך? «…»"   [כן ✅] [לא ❌]
 * בלי הצעת תשובה — אין הודעה עכשיו (תזכורת "זכרת?" למחרת, אם לא טופל). בקשה לפגישה — "לשלוח 3 מועדים?".
 * *כן* — התשובה יוצאת וההצעה יורדת מ"ממתין לאישורך";
 * *לא* — יורדת בלי כלום; כל דבר אחר — תיקון לנוסח, כמו כל טיוטת תשובה.
 * לא דורסים שיחה פעילה: עובד שבאמצע משהו מול הבוט — המייל מחכה לסבב הבא.
 * מייל שנקרא ב-Gmail יורד מהרשימה (‎mail-scan.dropAnswered‎) ולא נשאל עליו.
 * רק הצעות שנוצרו מאז שהפעולה הופעלה — בלי גל של הצעות ישנות.
 */
const ALERT_WINDOW_MS = DAY;


/** ההצעות של המייל שנשאל עליו — נענו / נדחו / דולגו. רק מה שעוד ממתין */
function closeAlerted(userId, ids, status) {
  for (const id of ids) {
    const sug = D.get("SELECT * FROM ai_suggestions WHERE id = ? AND user_id = ? AND status = 'pending'", id, userId);
    if (!sug) continue;
    if (status === 'rejected') {
      MailScan.reject(id, { type: 'user', id: userId });
      continue;
    }
    const d = parseJson(sug.data, {});
    if (d.reply) d.reply[status === 'replied' ? 'sent' : 'dismissed'] = D.nowIso();
    D.run("UPDATE ai_suggestions SET status = ?, data = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, JSON.stringify(d), D.nowIso(), id);
  }
}


const oneLine = (x, n) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };


/** המייל הבא לשאול עליו — הוותיק ביותר שעוד לא נשאל, מהיממה האחרונה */
function nextAlert(userId, since) {
  const first = D.get(
    `SELECT * FROM ai_suggestions
      WHERE user_id = ? AND status = 'pending' AND kind = 'task' AND gmail_id <> ''
        AND COALESCE(json_extract(data, '$.source'), 'email') = 'email'
        AND header_id NOT LIKE 'doc:%' AND json_extract(data, '$.expiry') IS NULL
        AND json_extract(data, '$.waAlert') IS NULL AND created_at >= ?
      ORDER BY received_at, id LIMIT 1`,
    userId, new Date(Math.max(Date.now() - ALERT_WINDOW_MS, new Date(since).getTime())).toISOString()
  );
  if (!first) return null;
  // כל ההצעות מאותו מייל — שאלה אחת
  const rows = D.all("SELECT * FROM ai_suggestions WHERE user_id = ? AND gmail_id = ? AND status = 'pending' AND kind = 'task' ORDER BY id", userId, first.gmail_id);
  for (const r of rows) {
    const d = parseJson(r.data, {});
    d.waAlert = { at: D.nowIso() };
    D.run('UPDATE ai_suggestions SET data = ? WHERE id = ?', JSON.stringify(d), r.id);
  }
  return rows.map((r) => ({ ...r, d: parseJson(r.data, {}) }));
}


async function mailAlertFor(userId) {
  const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", userId);
  const state = chatOf(userId);
  // באמצע שיחה מול הבוט — לא קוטעים. המייל מחכה לסבב הבא
  if (!u?.phone || busyFor(userId) || GoodsReceipt.active(userId) || PurchaseDemand.active(userId)) return;
  let since = D.getSetting('wa_mail_alert_since', '');
  if (!since) { since = D.nowIso(); D.setSetting('wa_mail_alert_since', since); }
  // 🌊 בשעות, לא באמצע שיחה ולא בפגישה — לפני שמסמנים את המייל כ"נשאל". הצעת תשובה אינה נספרת בתקרת התזכורות
  if (!(await MailActions.mayAlertNow(userId))) return;
  const rows = nextAlert(userId, since);
  if (!rows?.length) return;
  const head = rows[0];
  const chatId = `${u.phone}@c.us`;
  const ids = rows.map((r) => r.id);
  // רק ראשי, לא אוטומטי, לא משולח מושתק. השאר — ב"היום" (‎mail-push.js‎)
  if (!MailPush.direct(head)) {
    log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'mail_alert', status: 'ok', result: `📧 ${head.from_name}: ${oneLine(head.subject, 100)} — לא הוקפץ (העתק / אוטומטי / מושתק); ב"היום"` });
    return;
  }
  // 📅 מייל שמבקש להיפגש — "לשלוח לו 3 מועדים?"
  const actorU = Auth.loadActor('user', userId);
  if (head.d.meeting && actorU && WaActions.allowed(actorU, 'meet_coord') && Gmail.canSend(userId) && (Gmail.has(userId, 'freebusy') || Gmail.has(userId, 'calendar'))) {
    const offer = MeetCoord.offerForMail(head, ids);
    try {
      await sendButtons(chatId, offer.text, offer.buttons);
      rememberBot(userId, offer.text);
      const now = chatOf(userId);
      if (freeToAsk(userId, now)) saveChat(userId, { ...now, draft: { ...offer.draft, askedAt: D.nowIso() }, awaiting: true });
      MailActions.noteProactive(userId);
      log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'meet_coord', status: 'ok', result: `📧 ${head.from_name}: בקשה לפגישה — ${oneLine(head.subject, 100)}` });
    } catch (err) {
      log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'meet_coord', status: 'error', result: err.message });
    }
    return;
  }
  /*
   * 💡 רק כשיש הצעת תשובה קונקרטית (הוחלט 11.11.26, ישראל: "התראה על כל מייל — מטריד"): "קיבלת מייל מדני:
   * <במשפט מה ביקש>. לענות כך? «…»". בלי הצעה — אין הודעה עכשיו; אם המייל לא יטופל, תגיע תזכורת "זכרת? 🐣"
   */
  const withReply = rows.find((r) => MailPush.concreteReply(r.d.reply));
  let reply = null;
  if (withReply && Gmail.canSend(Gmail.handle(userId, withReply.d.reply.box ?? 0))) {
    reply = await MailInsights.completeReply(userId, withReply.d.reply).catch((err) => {
      log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'mail_alert', status: 'error', result: `השלמת התשובה: ${err.message}` });
      return null;
    });
  }
  if (!reply?.body) {
    log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'mail_alert', status: 'ok', result: `📧 ${head.from_name}: ${oneLine(head.subject, 120)} — בלי הצעת תשובה; תזכורת אם לא יטופל` });
    return;
  }
  const text = MailPush.replyAlert(head, reply);
  const draft = { kind: 'mail_reply', reply, alert: true, suggestionIds: ids, subject: head.subject };
  try {
    await sendButtons(chatId, text, [WaUi.BTN.yes, WaUi.BTN.no], { owner: 'chat', draft, awaiting: true });
    rememberBot(userId, text);
    // המצב נקרא שוב רגע לפני השמירה — הודעה שהגיעה בינתיים מהעובד גוברת
    const now = chatOf(userId);
    if (freeToAsk(userId, now)) saveChat(userId, { ...now, draft: { ...draft, askedAt: D.nowIso() }, awaiting: true });
    MailActions.noteProactive(userId);
    log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'mail_alert', status: 'ok', result: `📧 ${head.from_name}: ${oneLine(head.subject, 120)} — הצעת תשובה` });
  } catch (err) {
    log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'mail_alert', status: 'error', result: err.message });
  }
}


async function mailAlerts() {
  for (const userId of mailAlertUsers()) {
    await mailAlertFor(userId).catch((err) => console.error('[משימון] פנייה על מייל חדש נכשלה:', err.message));
  }
}


// ---------------------------------------------------------------------------
// 📬 פעולות לפי המיילים: "זכרת?" על דדליין, וחשבונית ← קבלת סחורה (‎mail-actions.js‎)
// ---------------------------------------------------------------------------

let mailActionsAt = 0;

async function mailActionAlerts() {
  if (Date.now() - mailActionsAt < 2 * 60 * 1000) return;
  mailActionsAt = Date.now();
  const on = { deadline: WaActions.byKey('mail_deadline')?.enabled, followup: WaActions.byKey('sent_followup')?.enabled, goods: WaActions.byKey('goods_offer')?.enabled, form: WaActions.byKey('form_fill')?.enabled };
  if (!on.deadline && !on.followup && !on.goods && !on.form) return;
  for (const u of orgUsers()) {
    if (!u.phone || !workHours(u.id)) continue;
    const prefs = D.userPrefs(u.id)?.botPrefs ?? {};
    const actor = Auth.loadActor('user', u.id);
    if (!actor) continue;
    const allow = {
      deadline: Boolean(on.deadline && prefs.mailDeadline !== false && WaActions.allowed(actor, 'mail_deadline')),
      // 📦 רק מי שפתח אי פעם קבלת סחורה בפריוריטי (11.11.26)
      goods: Boolean(on.goods && prefs.goodsOffer !== false && WaActions.allowed(actor, 'goods_offer') && WaActions.allowed(actor, 'goods_receipt') && GoodsReceipt.everOpened(u.id)),
      form: Boolean(on.form && prefs.formOffer !== false && WaActions.allowed(actor, 'form_fill') && Gmail.canSend(u.id)),
      followup: Boolean(on.followup && prefs.sentFollowup !== false && WaActions.allowed(actor, 'sent_followup') && Gmail.canSend(u.id))
    };
    if (!allow.deadline && !allow.goods && !allow.form && !allow.followup) continue;
    // 📤 פעם ביום — המיילים ששלחת ולא נענו
    if (allow.followup) await SentFollowup.scan(u.id).catch((err) => console.error('[משימון] סריקת שאלות שלא נענו נכשלה:', err.message));
    // באמצע שיחה מול הבוט — לא קוטעים; השאלה מחכה לסבב הבא
    const st = chatOf(u.id);
    if (busyFor(u.id) || GoodsReceipt.active(u.id) || PurchaseDemand.active(u.id)) continue;
    // 📬 פעם ביום בצהריים — "N מיילים מחכים לך" [לעבור עליהם 👉], במקום תזכורת לכל אחד (‎mail-push.js‎)
    if (allow.deadline && await MailActions.mayRemindNow(u.id)) {
      const dg = MailPush.digestFor(u.id);
      if (dg) {
        const chatId = `${u.phone}@c.us`;
        try {
          await sendButtons(chatId, dg.text, [WALK.start]);
          rememberBot(u.id, dg.text);
          const now = chatOf(u.id);
          saveChat(u.id, { ...now, walk: { items: dg.items, i: -1, at: D.nowIso() } });
          MailActions.noteProactive(u.id);
          MailActions.paceTick(u.id);
          log({ channel: 'summary', chatId, userId: u.id, who: u.full_name, action: 'mail_deadline', status: 'ok', result: `📬 הודעה מרוכזת: ${dg.items.length} מיילים` });
        } catch (err) {
          log({ channel: 'summary', chatId, userId: u.id, who: u.full_name, action: 'mail_deadline', status: 'error', result: err.message });
        }
        continue;
      }
    }
    const q = await MailActions.nextQuestion(u.id, allow).catch(() => null);
    if (!q) continue;
    const chatId = `${u.phone}@c.us`;
    try {
      await sendButtons(chatId, q.text, q.buttons, { owner: 'chat', draft: q.draft, awaiting: true });
      rememberBot(u.id, q.text);
      const now = chatOf(u.id);
      if (freeToAsk(u.id, now)) saveChat(u.id, { ...now, draft: { ...q.draft, askedAt: D.nowIso() }, awaiting: true });
      MailActions.noteProactive(u.id);
      log({ channel: 'summary', chatId, userId: u.id, who: u.full_name, action: q.action, status: 'ok', result: q.log.slice(0, 300) });
    } catch (err) {
      log({ channel: 'summary', chatId, userId: u.id, who: u.full_name, action: q.action, status: 'error', result: err.message });
    }
  }
  MailActions.prune();
  FormFill.prune();
  SentFollowup.prune();
}

module.exports = {
  VIA_EMAIL, VIA_MESIMON, businessCommand, closeAlerted, closureDecision, confirmPending, contactOf, createFromDraft, draftEmail, findRecipients, mailActionAlerts, mailAlertFor, mailAlerts, parseThreadAdd, resolveCc, solveText, suggestionDecision, suggestionFeedback, threadAddText
};
