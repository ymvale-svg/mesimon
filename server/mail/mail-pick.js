'use strict';
/**
 * 📧 משימה ממייל שהעובד בוחר בעצמו (הוחלט 16.11.26, מבקשה של עובדת: "מייל שאין משימה על שמו — אני רוצה
 * למשוך אותו כדי ליצור משימה").
 *
 * הסריקה מציעה משימות רק ממה שה-AI החליט שהוא משימה. כאן העובד בוחר מייל מהתיבה שלו ("ממתין לאישורך" ←
 * "📧 משימה ממייל שאני בוחר/ת…"), והמייל עובר את אותו ניתוח של הסריקה (‎analyze‎ ב-‎mail-scan.js‎). התוצאה —
 * הצעה ממתינה רגילה, שנפתחת מיד בחלון "📧 משימה מהמייל" לעריכה ואישור.
 *
 *   • רק התיבות של העובד עצמו (‎Gmail.boxesOf‎) — לא של עמית.
 *   • למייל כבר יש הצעה ממתינה — היא חוזרת (בלי כפילות). כבר יש עליו משימה — מוחזרת המשימה.
 *   • ה-AI החליט "אין כאן משימה", או שאינו זמין — בכל זאת נוצרת הצעה: הכותרת = הנושא, התקציר = תחילת המייל.
 *     העובד בחר את המייל במפורש, ולכן הבחירה הידנית תמיד עובדת.
 *   • ההצעה אינה קופצת בבוט (‎toMe: false‎) — העובד מטפל בה עכשיו, באתר.
 */
const D = require('../core').Db;
const Mime = require('../core').Mime;
const { HttpError } = require('../core').HttpKit;
const Claude = require('../integrations').Claude;
const Gmail = require('../integrations').Gmail;
const Scan = require('./mail-scan');

const DEFAULT_QUERY = 'in:inbox newer_than:7d';
const MAX_ROWS = 20;
const NOT_CONNECTED = 'תיבת ה-Gmail שלך לא מחוברת. כדי לבחור מייל — חברו אותה ב"החשבון שלי" ← Gmail.';
const GMAIL_DOWN = 'לא הצלחנו לקרוא את המייל מ-Gmail כרגע. נסו שוב בעוד רגע.';

const userError = (message, status = 400) => new HttpError(status, message);

/** תקלה מול Gmail — לעובד הודעה שהוא יכול לפעול לפיה, הפרטים ליומן */
async function gmailCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('[משימון] משימה ממייל שנבחר — Gmail:', err.message);
    throw userError(GMAIL_DOWN, 502);
  }
}

/** התיבות של העובד שאפשר לקרוא מהן. אין — הודעה ברורה לאן ללכת */
function boxesFor(userId) {
  const boxes = Gmail.boxesOf(userId, 'mail');
  if (!boxes.length) throw userError(NOT_CONNECTED);
  return boxes;
}

/** מה כבר קרה עם המייל אצל העובד: הצעה ממתינה / משימה */
function stateOf(userId, gmailId) {
  const rows = D.all("SELECT status, task_id FROM ai_suggestions WHERE user_id = ? AND gmail_id = ? AND kind = 'task'", userId, gmailId);
  if (rows.some((r) => r.task_id && ['approved', 'auto'].includes(r.status))) return 'task';
  if (rows.some((r) => r.status === 'pending')) return 'pending';
  return null;
}

/**
 * המיילים לבחירה — מכל התיבות של העובד, החדשים קודם.
 * ‎q‎ — חיפוש חופשי בתחביר של Gmail (שם, נושא, מילה); ריק — הדואר הנכנס של השבוע האחרון.
 */
async function list(userId, { q = '', max = MAX_ROWS } = {}) {
  const boxes = boxesFor(userId);
  const query = String(q ?? '').trim().slice(0, 300) || DEFAULT_QUERY;
  const many = boxes.length > 1;
  const rows = [];
  await gmailCall(async () => {
    for (const who of boxes) {
      const ids = await Gmail.search(who, query, { max });
      const metas = await Promise.all(ids.map((id) => Gmail.messageMeta(who, id)));
      const email = many ? Gmail.connectionOf(who)?.email ?? '' : '';
      for (const m of metas) {
        const from = Mime.parseAddress(m.headers.from ?? '');
        rows.push({
          gmailId: m.id,
          box: Gmail.boxOf(who),
          mailbox: email || null,
          from: { name: from.name || from.address, email: from.address },
          subject: String(m.headers.subject ?? '').trim(),
          date: (m.at ?? (m.headers.date ? new Date(m.headers.date) : null))?.toISOString?.() ?? null,
          unread: (m.labels ?? []).includes('UNREAD'),
          state: stateOf(userId, m.id)
        });
      }
    }
  });
  rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return { query, mails: rows.slice(0, max) };
}

/** תחילת המייל — לתקציר כשה-AI לא הציע משימה: עד 6 שורות לא ריקות, עד 600 תווים */
function opening(mail) {
  const lines = String(mail.newText || mail.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 6).join('\n').slice(0, 600);
}

/** הצעה בלי ה-AI — אותו מבנה כמו משימה שחזרה מ-‎sanitize‎ */
const manualTask = (mail) => ({
  title: (String(mail.subject ?? '').trim() || 'משימה מהמייל').slice(0, 120),
  summary: opening(mail),
  meeting: false,
  need: '',
  keywords: [],
  checklist: [],
  dueDate: '',
  priority: 'normal',
  people: [],
  ambiguous: [],
  aiRequest: null
});

/**
 * יצירת ההצעה למייל שנבחר (או החזרת מה שכבר קיים).
 * @returns {{ suggestion?: object, existing?: boolean, created?: number, task?: object }}
 *   ‎suggestion‎ — ההצעה לפתיחה בחלון העריכה; ‎task‎ — כבר יש משימה על המייל.
 */
async function pick(userId, gmailId, { box = 0 } = {}) {
  const user = D.get("SELECT id, full_name, email, department_id FROM users WHERE id = ? AND status = 'active'", userId);
  if (!user) throw userError('המשתמש לא נמצא', 404);
  gmailId = String(gmailId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(gmailId)) throw userError('מזהה המייל אינו תקין');
  // 🔒 רק תיבה של העובד עצמו
  const who = Gmail.handle(userId, Number(box) || 0);
  if (!boxesFor(userId).some((b) => String(b) === String(who))) throw userError('התיבה לא נמצאה', 404);
  const conn = Gmail.connectionOf(who);

  const pendingBy = (col, value) => D.get(
    `SELECT * FROM ai_suggestions WHERE user_id = ? AND ${col} = ? AND kind = 'task' AND status = 'pending' ORDER BY id LIMIT 1`, userId, value
  );
  const already = pendingBy('gmail_id', gmailId);
  if (already) return { suggestion: Scan.shape(already, conn), existing: true };

  const msg = await gmailCall(() => Gmail.raw(who, gmailId));
  const mail = Mime.parse(msg.raw);
  const headerId = mail.messageId || `gmail:${gmailId}`;
  // אותו מייל בתיבה אחרת שלי
  const sameMail = pendingBy('header_id', headerId);
  if (sameMail) return { suggestion: Scan.shape(sameMail, conn), existing: true };

  const task = Scan.existingTaskFor(headerId);
  if (task) {
    const mine = Scan.involvedIn(userId, task);
    return { task: { id: task.id, title: mine ? task.title : null, ownerName: task.owner_name ?? '', mine } };
  }

  const meta = {
    gmailId,
    headerId,
    fromName: mail.from.name || mail.from.address,
    fromEmail: mail.from.address,
    subject: mail.subject.slice(0, 300),
    receivedAt: (mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : msg.internalDate ?? new Date()).toISOString(),
    box: Gmail.boxOf(who)
  };

  // אותו ניתוח של הסריקה. ה-AI לא זמין או נכשל — הצעה ידנית, לא שגיאה
  let result = null;
  if (Claude.isEnabled()) {
    try {
      result = await Scan.analyze(user, mail, conn);
    } catch (err) {
      console.error('[משימון] משימה ממייל שנבחר — ניתוח ה-AI נכשל:', err.message);
    }
  }
  const tasks = result?.tasks?.length ? result.tasks : [manualTask(mail)];
  const ids = tasks.map((t) => Scan.insertSuggestion(user, meta, 'task', {
    ...t,
    warning: result?.warning ?? '',
    alsoSuggestedTo: [],
    receivedAt: meta.receivedAt,
    // העובד מטפל בזה עכשיו באתר — לא להקפיץ בבוט
    toMe: false,
    auto: false,
    picked: true,
    ...(result?.tasks?.length ? {} : { manual: true })
  }));
  // הסריקה לא תציע את המייל שוב
  Scan.recordScanned(userId, gmailId, headerId, 'suggested', meta.box);
  return { suggestion: Scan.shape(Scan.suggestionById(ids[0]), conn), existing: false, created: ids.length };
}

module.exports = { list, pick, DEFAULT_QUERY, NOT_CONNECTED, _internal: { manualTask, opening, stateOf } };
