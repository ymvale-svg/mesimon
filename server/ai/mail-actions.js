'use strict';
/**
 * 📬 הבוט יוזם פעולות לפי המיילים שהעובד קיבל (הוחלט 09.11.26):
 *
 *   1. ⏰ דדליין ממייל — מייל שיש בו מועד ("לאסוף את הדואר עד רביעי", "דרישת
 *      תשלום עד ה-15") ולא נפתחה ממנו משימה: ביום המועד הבוט שואל "זכרת?"
 *        [בוצע ✅] [תזכיר מחר ⏰] [לא רלוונטי ❌]
 *      המקור — ההצעות מסריקת המייל (‎ai_suggestions‎, עם ‎dueDate‎). הצעה שהעובד
 *      דחה ("לא" — לא משימה), או שהפכה למשימה (שם יש לה יעד משלה) — לא נשאלת.
 *
 *   2. 📄 חשבונית / תעודת משלוח במייל ← קבלת סחורה. סריקת המייל מזהה מסמך כזה
 *      בקובץ המצורף (‎goodsDocFrom‎, שדה בניתוח הקיים — בלי קריאה נוספת ל-AI),
 *      והבוט מציע: "לבצע קבלת סחורה בפריוריטי?". "כן" — הבוט מוריד את הקובץ
 *      מ-Gmail ומתחיל את קבלת הסחורה הרגילה, כאילו העובד שלח אותו בעצמו.
 *      רק למי שמותרת לו קבלת סחורה בבוט. מייל עם דדליין ועם חשבונית —
 *      אחרי "בוצע" על הדדליין, ההצעה לקבלת סחורה באה מיד.
 *
 * לא קוטעים שיחה פתוחה מול הבוט; שאלה אחת בכל פעם, בשעות הפעילות.
 */
const D = require('../db');
const W = require('../workdays');
const Gmail = require('../gmail');
const Mime = require('../mime');
const WaUi = require('./wa-ui');

const DAY = 24 * 60 * 60 * 1000;
const LATE_DAYS = 2;           // מועד שעבר (סוף שבוע, חופש) — עדיין שואלים עד יומיים אחרי
const DAILY_MAX = 5;           // לא יותר מ-5 שאלות דדליין לעובד ביום
const GOODS_DAYS = 3;          // חשבונית שלא נשאלה תוך 3 ימים — כבר לא מציעים
const DOC_MIME = /^(application\/pdf|image\/)/i;
const DOC_NAME = /\.(pdf|jpe?g|png|heic|tiff?)$/i;

const BTN = Object.freeze({
  done: 'בוצע ✅',
  tomorrow: 'תזכיר מחר ⏰',
  irrelevant: 'לא רלוונטי ❌',
  receive: 'קבלת סחורה 📦',
  later: 'אחר כך ⏰'
});

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const ddmm = (ymd) => String(ymd ?? '').split('-').reverse().slice(0, 2).join('.');
const oneLine = (x, n) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

// ---------------------------------------------------------------------------
// סריקת המייל: חשבונית / תעודת משלוח בקובץ המצורף
// ---------------------------------------------------------------------------

/** השדה שנוסף לניתוח של סריקת המייל (‎mail-scan.js‎, ‎ANALYSIS_SCHEMA‎) */
const GOODS_SCHEMA = {
  type: 'object',
  description: 'חשבונית ספק או תעודת משלוח — על סחורה או שירות שהארגון הזמין — בקובץ מצורף למייל. לא קבלה על תשלום, לא הצעת מחיר, ולא חשבונית שהארגון עצמו שולח ללקוח',
  properties: {
    kind: { type: 'string', enum: ['none', 'invoice', 'delivery_note'] },
    filename: { type: 'string', description: 'שם הקובץ המצורף, בדיוק כמו ברשימת הקבצים. אין — ריק' },
    supplier: { type: 'string', description: 'שם הספק כפי שמופיע במייל או במסמך. לא ידוע — ריק' }
  },
  required: ['kind', 'filename', 'supplier'],
  additionalProperties: false
};

/**
 * אחרי הניתוח של מייל — חשבונית או תעודת משלוח שמצורפת אליו נרשמת להצעה בבוט.
 * רק כשהקובץ באמת מצורף (שם זהה) והוא PDF או תמונה.
 */
function goodsDocFrom(user, meta, mail, goods) {
  if (!goods || !['invoice', 'delivery_note'].includes(goods.kind)) return false;
  const name = String(goods.filename ?? '').trim();
  const att = (mail.attachments ?? []).find((a) => a.filename === name)
    ?? ((mail.attachments ?? []).filter((a) => DOC_MIME.test(a.mime ?? '') || DOC_NAME.test(a.filename ?? '')).length === 1
      ? mail.attachments.find((a) => DOC_MIME.test(a.mime ?? '') || DOC_NAME.test(a.filename ?? ''))
      : null);
  if (!att || !(DOC_MIME.test(att.mime ?? '') || DOC_NAME.test(att.filename ?? ''))) return false;
  D.run(
    `INSERT OR IGNORE INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
    user.id, meta.gmailId, meta.box ?? 0, goods.kind, att.filename, att.mime ?? '', String(goods.supplier ?? '').slice(0, 120),
    meta.fromName ?? '', meta.fromEmail ?? '', String(meta.subject ?? '').slice(0, 300), D.nowIso()
  );
  return true;
}

/** הקובץ עצמו — מ-Gmail, ברגע שהעובד אמר "כן" */
async function goodsFile(row) {
  const msg = await Gmail.raw(Gmail.handle(row.user_id, row.box ?? 0), row.gmail_id);
  const mail = Mime.parse(msg.raw);
  const att = mail.attachments.find((a) => a.filename === row.filename);
  if (!att?.data) throw new Error(`הקובץ "${row.filename}" לא נמצא במייל`);
  return { buf: Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data), mime: att.mime || row.mime, name: row.filename };
}

// ---------------------------------------------------------------------------
// מה לשאול עכשיו
// ---------------------------------------------------------------------------

/** הדדליין הבא לשאול עליו — של היום (או שעבר בימים האחרונים), שלא נשאל היום */
function nextDeadline(userId) {
  const today = W.todayIL();
  const asked = D.get(
    "SELECT COUNT(*) n FROM ai_suggestions WHERE user_id = ? AND json_extract(data, '$.deadline.askedOn') = ?", userId, today
  ).n;
  if (asked >= DAILY_MAX) return null;
  return D.get(
    `SELECT * FROM ai_suggestions
      WHERE user_id = ? AND kind = 'task' AND status IN ('pending', 'skipped', 'replied')
        AND header_id NOT LIKE 'doc:%'
        AND json_extract(data, '$.dueDate') BETWEEN ? AND ?
        AND json_extract(data, '$.deadline.closed') IS NULL
        AND COALESCE(json_extract(data, '$.deadline.askedOn'), '') <> ?
        AND COALESCE(json_extract(data, '$.deadline.snoozeUntil'), '') <= ?
      ORDER BY json_extract(data, '$.dueDate'), id LIMIT 1`,
    userId, W.addDays(today, -LATE_DAYS), today, today, today
  ) ?? null;
}

function nextGoods(userId) {
  const today = W.todayIL();
  return D.get(
    `SELECT * FROM mail_goods_docs WHERE user_id = ? AND (status = 'pending' OR (status = 'later' AND COALESCE(snooze_until, '') <= ?))
       AND created_at >= ? ORDER BY created_at, id LIMIT 1`,
    userId, today, new Date(Date.now() - GOODS_DAYS * DAY).toISOString()
  ) ?? null;
}

function setDeadline(id, patch) {
  const row = D.get('SELECT data FROM ai_suggestions WHERE id = ?', id);
  if (!row) return;
  const d = parseJson(row.data, {});
  d.deadline = { ...(d.deadline ?? {}), ...patch };
  D.run('UPDATE ai_suggestions SET data = ? WHERE id = ?', JSON.stringify(d), id);
}

function deadlineQuestion(row) {
  const d = parseJson(row.data, {});
  const today = W.todayIL();
  const when = d.dueDate === today ? '*היום* הדדליין' : `הדדליין עבר (${ddmm(d.dueDate)})`;
  return {
    text: [
      `⏰ ${when}: *${oneLine(d.title, 120)}*`,
      `📧 מהמייל של ${row.from_name || row.from_email}${row.subject ? ` — ${oneLine(row.subject, 80)}` : ''}`,
      d.summary ? `_${oneLine(d.summary, 200)}_` : null,
      '',
      '*זכרת?*'
    ].filter((l) => l !== null).join('\n'),
    buttons: [BTN.done, BTN.tomorrow, BTN.irrelevant],
    draft: { kind: 'deadline_check', suggestionId: row.id, title: d.title, gmailId: row.gmail_id }
  };
}

function goodsQuestion(row, { after = false } = {}) {
  const what = row.kind === 'delivery_note' ? 'תעודת משלוח' : 'חשבונית';
  const from = row.supplier || row.from_name || row.from_email;
  return {
    text: [
      after ? `📄 במייל הזה יש גם ${what}.` : `📄 הגיעה ${what} מ*${from}*`,
      `📎 ${row.filename}${row.subject && !after ? ` · ${oneLine(row.subject, 80)}` : ''}`,
      '',
      '*לבצע עכשיו קבלת סחורה בפריוריטי?* אוריד את הקובץ מהמייל ונתחיל.'
    ].join('\n'),
    buttons: [BTN.receive, BTN.later, WaUi.BTN.no],
    draft: { kind: 'goods_offer', goodsId: row.id, filename: row.filename }
  };
}

/**
 * השאלה הבאה לעובד — דדליין קודם (מועד), אחר כך חשבונית.
 * @param {{deadline: boolean, goods: boolean, form: boolean}} allow
 */
function nextQuestion(userId, allow) {
  if (allow.deadline) {
    const row = nextDeadline(userId);
    if (row) { setDeadline(row.id, { askedOn: W.todayIL() }); return { ...deadlineQuestion(row), action: 'mail_deadline', log: `⏰ ${parseJson(row.data, {}).title}` }; }
  }
  if (allow.form) {
    const row = require('./form-fill').nextForm(userId);
    if (row) return require('./form-fill').question(row);
  }
  if (allow.goods) {
    const row = nextGoods(userId);
    if (row) { D.run("UPDATE mail_goods_docs SET status = 'asked', asked_at = ? WHERE id = ?", D.nowIso(), row.id); return { ...goodsQuestion(row), action: 'goods_offer', log: `📄 ${row.supplier || row.from_name}: ${row.filename}` }; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// התשובות
// ---------------------------------------------------------------------------

const is = (t, btn, re) => WaUi.sameLabel(t, btn) || re.test(WaUi.normalize(t));
const DONE = /^(בוצע|ביצעתי|עשיתי|טופל|כן|סגור|זכרתי|👍)([\s,.!]|$)/;
const TOMORROW = /^(תזכיר(\s+לי)?\s+מחר|מחר|אחר\s+כך|אח"כ|לא\s+עכשיו|תזכיר)([\s,.!]|$)/;
const IRRELEVANT = /^(לא\s+רלוונטי|לא\s+צריך|לא|👎)([\s,.!]|$)/;
const RECEIVE = /^(קבלת\s+סחורה|כן|לבצע|יאללה|קדימה|👍)([\s,.!]|$)/;

/**
 * תשובה לשאלת דדליין. ‎null‎ — ההודעה אינה תשובה (נושא חדש).
 * @returns {{text: string, buttons?: string[], draft?: object, awaiting?: boolean, result: string}|null}
 */
function answerDeadline(userId, draft, text, { goodsAllowed = false, closeAlerted } = {}) {
  const t = String(text ?? '').trim();
  if (is(t, BTN.done, DONE)) {
    setDeadline(draft.suggestionId, { closed: 'done', at: D.nowIso() });
    closeAlerted?.(userId, [draft.suggestionId], 'skipped');
    // אותו מייל עם חשבונית — ההצעה לקבלת סחורה מיד
    const goods = goodsAllowed && draft.gmailId
      ? D.get("SELECT * FROM mail_goods_docs WHERE user_id = ? AND gmail_id = ? AND status IN ('pending', 'later', 'asked')", userId, draft.gmailId)
      : null;
    if (goods) {
      D.run("UPDATE mail_goods_docs SET status = 'asked', asked_at = ? WHERE id = ?", D.nowIso(), goods.id);
      const q = goodsQuestion(goods, { after: true });
      return { text: `👍 מעולה, סימנתי.\n\n${q.text}`, buttons: q.buttons, draft: q.draft, awaiting: true, result: `בוצע: ${draft.title} · הוצעה קבלת סחורה` };
    }
    return { text: '👍 מעולה, סימנתי.', result: `בוצע: ${draft.title}` };
  }
  if (is(t, BTN.tomorrow, TOMORROW)) {
    const next = W.addDays(W.todayIL(), 1);
    setDeadline(draft.suggestionId, { snoozeUntil: next });
    return { text: `⏰ בסדר, אזכיר מחר (${ddmm(next)}).`, result: `תזכורת מחר: ${draft.title}` };
  }
  if (is(t, BTN.irrelevant, IRRELEVANT)) {
    setDeadline(draft.suggestionId, { closed: 'irrelevant', at: D.nowIso() });
    closeAlerted?.(userId, [draft.suggestionId], 'skipped');
    return { text: 'בסדר, ירד מהרשימה 👍', result: `לא רלוונטי: ${draft.title}` };
  }
  return null;
}

/**
 * תשובה להצעת קבלת סחורה. ‎start: true‎ — להוריד את הקובץ ולהתחיל.
 * @returns {{text?: string, start?: boolean, result: string}|null}
 */
function answerGoods(draft, text) {
  const t = String(text ?? '').trim();
  if (is(t, BTN.receive, RECEIVE) || WaUi.YES.test(WaUi.normalize(t))) {
    D.run("UPDATE mail_goods_docs SET status = 'started', decided_at = ? WHERE id = ?", D.nowIso(), draft.goodsId);
    return { start: true, text: `📥 מוריד את ${draft.filename} מהמייל ומתחיל קבלת סחורה…`, result: `קבלת סחורה מהמייל: ${draft.filename}` };
  }
  if (is(t, BTN.later, TOMORROW)) {
    const next = W.addDays(W.todayIL(), 1);
    D.run("UPDATE mail_goods_docs SET status = 'later', snooze_until = ? WHERE id = ?", next, draft.goodsId);
    return { text: `⏰ בסדר, אשאל שוב מחר (${ddmm(next)}). אפשר גם לשלוח לי את הקובץ מתי שנוח.`, result: `אחר כך: ${draft.filename}` };
  }
  if (WaUi.NO.test(WaUi.normalize(t)) || WaUi.CANCEL.test(WaUi.normalize(t))) {
    D.run("UPDATE mail_goods_docs SET status = 'declined', decided_at = ? WHERE id = ?", D.nowIso(), draft.goodsId);
    return { text: 'בסדר, לא נקלט 👍', result: `לא: ${draft.filename}` };
  }
  return null;
}

/** ניקוי — רשומות חשבוניות בנות יותר מחודש */
function prune() {
  D.run('DELETE FROM mail_goods_docs WHERE created_at < ?', new Date(Date.now() - 30 * DAY).toISOString());
}

module.exports = {
  GOODS_SCHEMA, BTN, goodsDocFrom, goodsFile, nextQuestion, answerDeadline, answerGoods, prune,
  _internal: { nextDeadline, nextGoods, deadlineQuestion, goodsQuestion, setDeadline }
};
