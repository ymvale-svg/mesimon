'use strict';
/**
 * 🖥️ עבודה מתוך המסך — ערוץ שני לאותו מנוע (‎/priority/receipt‎, ‎/priority/demand‎).
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md" (הפרדת המנוע מהשיחה בוואטסאפ, 11.11.26).
 *
 * קבלת סחורה (‎goods-receipt.js‎) ודרישת רכש (‎purchase-demand.js‎) הן מנוע: הודעה נכנסת (טקסט / קובץ) ← החלטות
 * (קריאה, התאמה, טיוטא, סופי) ← תשובה (טקסט + כפתורים). עד היום היה לו ערוץ אחד — הבוט. כאן הערוץ השני:
 *   • אותו מנוע, אותן החלטות, ברירות מחדל ובדיקות — שום לוגיקה לא שוכפלה. שיפור במנוע עובד בשני הערוצים.
 *   • התשובות מגיעות למסך ולא לוואטסאפ; לצידן — התצוגה המובנית של המנוע (‎view‎): חברה, ספק, הזמנה, שורות, GR.
 *   • המצב של הקליטה הוא אחד לעובד: מה שהתחיל בוואטסאפ ממשיך כאן, ולהפך.
 *
 * נספחים ועמודים (11.11.26): קובץ שמצורף מהמסך נשלח למנוע כמו תמונה נוספת בוואטסאפ — עם הכיתוב "נספח" (בלי ניחוש),
 * או בלי כיתוב (עמוד נוסף של אותו מסמך — המנוע מסווג, ורשימת פריטים בעמוד הבא מעדכנת את השורות). כשהקליטה
 * נגמרת — המסמך הבא בתור מוצע בכפתור (לא מתחיל לבד).
 *
 * כאן נשמר רק התמליל של המסך (‎priority_desk:<userId>:<flow>‎) — כדי שרענון הדף לא יאבד את השיחה.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../core').Db;
const Access = require('./priority-access');
const Docs = require('./priority-docs');
const GoodsReceipt = require('./goods-receipt');
const PurchaseDemand = require('./purchase-demand');

const FLOWS = {
  receipt: { engine: () => GoodsReceipt, trigger: 'קבלת סחורה', args: { allow: { gr: true, pd: false } } },
  demand: { engine: () => PurchaseDemand, trigger: 'דרישת רכש', args: {} }
};
const MAX_MESSAGES = 80;
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const key = (userId, flow) => `priority_desk:${userId}:${flow}`;
const filesDir = () => path.join(D.UPLOADS_DIR, 'priority-desk');
const actorOf = (user) => ({ type: 'user', id: user.id, role: user.role });

function flowOf(user, flow) {
  const f = FLOWS[flow];
  if (!f) throw fail(400, 'הפעולה הזו עוד לא עובדת מהמסך');
  if (!Access.can(actorOf(user), flow)) throw fail(403, 'אין לך הרשאה לפעולה הזו');
  return f;
}

const transcript = (userId, flow) => {
  const v = D.getSetting(key(userId, flow), null);
  return v && Array.isArray(v.messages) ? v : { docId: null, messages: [] };
};
function saveTranscript(userId, flow, t) {
  D.setSetting(key(userId, flow), { docId: t.docId ?? null, messages: t.messages.slice(-MAX_MESSAGES) });
}

/** קובץ שהמנוע מחזיר (ה-PDF לבדיקה) — נשמר, ומוגש רק לבעליו */
function keepFile(userId, f) {
  if (!f?.buf) return null;
  fs.mkdirSync(filesDir(), { recursive: true });
  const id = `${userId}-${crypto.randomUUID()}${path.extname(f.fileName || '') || '.pdf'}`;
  fs.writeFileSync(path.join(filesDir(), id), f.buf);
  return { id, name: f.fileName || 'מסמך.pdf', caption: f.caption ?? '' };
}

function fileOf(user, id) {
  if (!/^\d+-[0-9a-f-]{36}\.[a-z]{2,4}$/i.test(String(id)) || !String(id).startsWith(`${user.id}-`)) throw fail(404, 'הקובץ לא נמצא');
  const p = path.join(filesDir(), id);
  if (!fs.existsSync(p)) throw fail(404, 'הקובץ לא נמצא');
  return { buf: fs.readFileSync(p), mime: id.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', name: id };
}

/** תור לכל עובד — שתי לחיצות מהירות לא ירוצו במקביל על אותו מצב */
const chains = new Map();
function serial(userId, fn) {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(userId, next);
  next.finally(() => { if (chains.get(userId) === next) chains.delete(userId); }).catch(() => {});
  return next;
}

const engineUser = (user) => D.get('SELECT id, full_name FROM users WHERE id = ?', user.id) ?? { id: user.id, full_name: user.name ?? '' };

async function run(user, flow, input) {
  const f = flowOf(user, flow);
  let r;
  try {
    r = await f.engine().handle({ user: engineUser(user), ...f.args, ...input });
  } catch (err) {
    console.error(`[משימון] מסך פריוריטי (${flow}) נכשל:`, err.message);
    r = { replies: ['משהו השתבש. נסו שוב, או *ביטול*.'], status: 'error', result: err.message };
  }
  if (r?.pass) r = { replies: ['לא הבנתי את זה כתשובה. אפשר לענות בכפתורים, לכתוב בשפה חופשית מה לשנות, או *ביטול*.'], buttons: [], status: 'unclear' };
  return {
    from: 'bot',
    texts: (r.replies ?? []).filter(Boolean),
    buttons: (r.buttons ?? []).slice(0, 3),
    files: (r.files ?? []).map((x) => keepFile(user.id, x)).filter(Boolean),
    status: r.status ?? '',
    at: D.nowIso()
  };
}

/** המצב למסך: התמליל, התצוגה של המנוע, ואיזה מסמך מהתור בעבודה */
function state(user, flow) {
  const f = flowOf(user, flow);
  const t = transcript(user.id, flow);
  const view = f.engine().view(user.id);
  // הקליטה נגמרה (סופי / בוטל) — המסמך הבא בתור, לכפתור
  const next = view ? null : Docs.nextOf(user, flow, t.docId);
  return { flow, active: Boolean(view), view, docId: view ? t.docId : null, messages: view ? t.messages : t.messages.slice(-6), next };
}

/**
 * קובץ לקליטה הפתוחה. ‎attach: true‎ — נספח (הכיתוב "נספח": בלי ניחוש); ‎false‎ — עמוד נוסף / מסמך שהמנוע יסווג.
 */
function sendFile(user, flow, input, { attach = true } = {}) {
  return serial(user.id, async () => {
    const f = flowOf(user, flow);
    if (!f.engine().view(user.id)) throw fail(400, 'אין קליטה פתוחה — התחילו ממסמך בתור');
    const file = Docs.decode(input);
    const t = transcript(user.id, flow);
    t.messages.push({ from: 'user', texts: [`📎 ${attach && flow === 'receipt' ? 'נספח' : 'עמוד נוסף'}: ${file.name}`], at: D.nowIso() });
    t.messages.push(await run(user, flow, { text: attach && flow === 'receipt' ? 'נספח' : '', file }));
    saveTranscript(user.id, flow, t);
    return state(user, flow);
  });
}

/**
 * התחלה ממסמך שבתור. ‎force‎ — יש קליטה אחרת פתוחה (מוואטסאפ או ממסמך אחר): לבטל אותה ולהתחיל את זו.
 * בלי ‎force‎ — שגיאה 409 עם מה שפתוח, והעובד בוחר.
 */
function start(user, docId, { force = false } = {}) {
  return serial(user.id, async () => {
    const doc = Docs.get(user, docId);
    const flow = doc.doc;
    const f = flowOf(user, flow);
    const t = transcript(user.id, flow);
    const open = f.engine().view(user.id);
    if (open && t.docId === doc.id) return state(user, flow);
    const messages = [];
    if (open) {
      if (!force) throw fail(409, 'יש קליטה פתוחה', { open });
      messages.push({ from: 'user', texts: ['ביטול'], at: D.nowIso() }, await run(user, flow, { text: 'ביטול' }));
    }
    const file = await Docs.file(user, doc.id);
    messages.push({ from: 'user', texts: [`${f.trigger}: ${doc.filename || 'מסמך'}`], at: D.nowIso() });
    messages.push(await run(user, flow, { text: f.trigger, file }));
    // עמודים נוספים של אותו מסמך — בלי כיתוב: המנוע מחליט (דף המשך, רשימת פריטים)
    for (const p of Docs.pages(user, doc.id)) {
      if (!f.engine().view(user.id)) break;
      messages.push({ from: 'user', texts: [`📎 עמוד נוסף: ${p.name}`], at: D.nowIso() });
      messages.push(await run(user, flow, { text: '', file: p }));
    }
    D.run("UPDATE priority_docs SET stage = 'bot', updated_at = ? WHERE id = ? AND stage IN ('new', 'bot')", D.nowIso(), doc.id);
    saveTranscript(user.id, flow, { docId: doc.id, messages });
    return state(user, flow);
  });
}

/** תשובה מהמסך — טקסט חופשי או כיתוב של כפתור (בדיוק כמו בוואטסאפ) */
function say(user, flow, text) {
  return serial(user.id, async () => {
    const msg = String(text ?? '').trim().slice(0, 2000);
    if (!msg) throw fail(400, 'ריק');
    flowOf(user, flow);
    const t = transcript(user.id, flow);
    t.messages.push({ from: 'user', texts: [msg], at: D.nowIso() });
    t.messages.push(await run(user, flow, { text: msg }));
    saveTranscript(user.id, flow, t);
    return state(user, flow);
  });
}

module.exports = { FLOWS, state, start, say, sendFile, fileOf, _key: key };
