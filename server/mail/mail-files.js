'use strict';
/**
 * 📎 קובץ מהמייל לוואטסאפ (הוחלט 20.11.26, ישראל: "מי שמבקש קובץ מהמייל — תוריד לו אותו").
 *
 * עד עכשיו "תמצא לי מצגת מלונאות רכסים" החזיר את שמות הקבצים ותיאור, ו"כדי לפתוח קובץ, חפש את שמו במייל" — והעובד
 * לא קיבל את הקובץ (סקירה 18.11). עכשיו: מחפשים בתיבות של העובד בלבד מיילים עם קובץ מצורף, מדרגים לפי שם הקובץ
 * והסוג, ושולחים את המתאים ביותר. השאר — לבחירה.
 *
 * רק התיבות של מי שביקש (‎Gmail.boxesOf‎); הפנייה לרשת — דרך ‎integrations‎.
 */
const { Gmail } = require('../integrations');

// בקשה לקובץ: פועל ("תמצא", "תשלח", "תביא", "תוריד"…) ← "לי" ← סוג הקובץ. "תשלח לדני את החוזה" — לא (זה מייל לדני)
const VERB = '(?:ת?מצא|תמצאי|ת?שלח|תשלחי|שלחי|תביא|תביאי|הבא|תוריד|תורידי|הורד|תעביר|תעבירי|העבר|תן|תני|אפשר\\s+לקבל|אני\\s+צריך|אני\\s+צריכה|צריך|צריכה|תחפש|תחפשי|חפש)';
const KINDS = [
  { re: /מצגת|מצגות/, ext: /\.(pdf|pptx?|key)$/i },
  { re: /אקסל|גיליון|טבלה|טבלת|כתב\s+כמויות/, ext: /\.(xlsx?|csv)$/i },
  { re: /שרטוט|תוכנית|תכנית|סקיצה|תשריט|dwg/, ext: /\.(pdf|dwg|dxf|png|jpe?g)$/i },
  { re: /תמונה|תמונות|צילום/, ext: /\.(png|jpe?g|heic|webp)$/i },
  { re: /וורד|word/i, ext: /\.docx?$/i },
  { re: /pdf/i, ext: /\.pdf$/i },
  { re: /קובץ|קבצים|מסמך|מסמכים|חוזה|הסכם|נספח|חשבונית|הצעת\s+מחיר|הצעה|דוח|דו"ח|מפרט|היתר|מכתב|צרופה|קובץ\s+מצורף|אישור/, ext: null }
];
const KIND_WORD = '(?:מצגת|מצגות|אקסל|גיליון|טבלה|טבלת|כתב\\s+כמויות|שרטוט|תוכנית|תכנית|סקיצה|תשריט|תמונה|תמונות|צילום|וורד|word|pdf|קובץ|קבצים|מסמך|מסמכים|חוזה|הסכם|נספח|חשבונית|הצעת\\s+מחיר|דוח|דו"ח|מפרט|היתר|מכתב|צרופה)';
const ASK = new RegExp(`^\\P{L}*(?:\\S+\\s*[,.]\\s*)?${VERB}\\s+(?:לי\\s+)?(?:בבקשה\\s+)?(?:את\\s+)?(?:כל\\s+)?(?:ה)?${KIND_WORD}(?=[\\s,.!?:]|$)`, 'iu');
const FROM_MAIL = /(?:מה|ב|מתוך\s+ה)מייל(?:ים)?(?:\s+שלי)?/;
// מילים שאינן חלק משם הקובץ
const STOP = new Set(['לי', 'את', 'של', 'על', 'עם', 'בבקשה', 'שלי', 'האחרון', 'האחרונה', 'העדכני', 'העדכנית', 'החדש', 'החדשה', 'כל', 'מה', 'זה', 'הזה', 'הזאת', 'אותו', 'אותה', 'שקיבלתי', 'ששלחתי', 'שנשלח', 'שנשלחה', 'גרסה', 'גרסת', 'אחרונה']);

/** ‎true‎ — "תמצא לי מצגת מלונאות רכסים", "תשלח לי את החוזה של רכסים מהמייל" */
function isRequest(text) {
  const t = String(text ?? '').replace(/^🎙\s*/, '').trim();
  if (/\?\s*$/.test(t) && !FROM_MAIL.test(t) && !/^(?:אפשר|תוכל|תוכלי)/.test(t)) return false;
  return ASK.test(t);
}

/** הסוג שביקשו (סיומות מתאימות), ומילות החיפוש: "מצגת מלונאות רכסים" ← { ext: pdf/ppt, terms: ['מלונאות', 'רכסים'] } */
function parse(text) {
  const t = String(text ?? '').replace(/^🎙\s*/, '').replace(FROM_MAIL, ' ').trim();
  const kind = KINDS.find((k) => k.re.test(t)) ?? null;
  const rest = t.replace(ASK, ' ').replace(/[^\p{L}\p{N}\s.\-]/gu, ' ');
  // בלי להוריד אותיות שימוש ("מלונאות" מתחילה ב-מ) — החיפוש של Gmail והשוואת השם עובדים על המילה כמו שהיא
  const terms = rest.split(/\s+/)
    .map((w) => w.replace(/^ה(?=\p{L}{4,})/u, '').trim())
    .filter((w) => w.length >= 2 && !STOP.has(w) && !new RegExp(`^${KIND_WORD}$`, 'u').test(w));
  return { ext: kind?.ext ?? null, terms: [...new Set(terms)].slice(0, 6) };
}

/** הקבצים המצורפים בהודעה (‎format=full‎), בלי תמונות קטנות שבחתימה */
function attachmentsOf(msg) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      const small = /^image\//.test(p.mimeType ?? '') && (p.body.size ?? 0) < 30 * 1024;
      if (!small && !/^(?:image\d{3}|outlook-|~WRL)/i.test(p.filename)) out.push({ filename: p.filename, mime: p.mimeType || 'application/octet-stream', size: p.body.size ?? 0, partId: p.partId ?? '' });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg?.payload);
  return out;
}

const header = (msg, name) => (msg?.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name)?.value ?? '';
const fold = (s) => String(s ?? '').toLowerCase().replace(/[_\-.]+/g, ' ');

/**
 * חיפוש בתיבות של העובד. ‎[{ who, messageId, filename, mime, size, partId, date, from, score }]‎ — הטוב ביותר ראשון.
 * קובץ באותו שם בכמה מיילים — רק העדכני.
 */
async function find(userId, text, { max = 4 } = {}) {
  const { ext, terms } = parse(text);
  const found = [];
  for (const who of Gmail.boxesOf(userId, 'mail')) {
    const queries = terms.length ? [`has:attachment ${terms.join(' ')}`, `has:attachment {${terms.join(' ')}}`] : ['has:attachment newer_than:30d'];
    const seen = new Set();
    for (const q of queries) {
      let ids = [];
      try { ids = await Gmail.search(who, q, { max: 15 }); } catch (err) { console.error('[משימון] חיפוש קובץ במייל נכשל:', err.message); }
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        let msg;
        try { msg = await Gmail.messageFull(who, id); } catch { continue; }
        const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '';
        for (const a of attachmentsOf(msg)) {
          const name = fold(a.filename);
          const hits = terms.filter((w) => name.includes(fold(w))).length;
          const score = hits * 3 + (ext && ext.test(a.filename) ? 2 : 0) - (ext && !ext.test(a.filename) ? 3 : 0);
          found.push({ who, messageId: id, ...a, date, from: header(msg, 'from').replace(/\s*<[^>]+>/, '').replace(/"/g, '').trim(), subject: header(msg, 'subject'), score });
        }
      }
      if (found.some((f) => f.score > 0)) break;
    }
  }
  const best = new Map();
  for (const f of found.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))) {
    const k = f.filename.toLowerCase();
    if (!best.has(k)) best.set(k, f);
  }
  return [...best.values()].filter((f) => f.score > 0 || !terms.length).slice(0, max);
}

/** תוכן הקובץ — ‎attachmentId‎ משתנה בין קריאות, ולכן נלקח מחדש מההודעה */
async function download(f) {
  const msg = await Gmail.messageFull(f.who, f.messageId);
  const a = [];
  const walk = (p) => { if (!p) return; if (p.filename === f.filename && p.body?.attachmentId) a.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(msg?.payload);
  if (!a.length) throw new Error('הקובץ לא נמצא בהודעה');
  const buf = await Gmail.attachment(f.who, f.messageId, a[0].body.attachmentId);
  return { buf, fileName: f.filename, mime: f.mime };
}

const dmy = (iso) => (iso ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: '2-digit' }).format(new Date(iso)) : '');
/** "📎 *845-מלון רכסים_10.pdf* · מ-אורל · 12.9.26" */
const caption = (f) => `📎 *${f.filename}*${f.from ? ` · מ${/^[א-ת]/.test(f.from) ? '' : '-'}${f.from}` : ''}${f.date ? ` · ${dmy(f.date)}` : ''}`;

module.exports = { isRequest, parse, find, download, caption, attachmentsOf };
