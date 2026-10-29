'use strict';
/**
 * 🎙 שיחת השלמה אחרי הקלטה — "מי אחראי?", "עד מתי?", "לאיזה פרויקט?".
 *
 * אחרי שה-AI פירק את ההקלטה (‎voice.js‎), כאן נקבע מה לא נאמר או לא זוהה
 * בוודאות, ונשאלים רק עליו. התשובות קצרות ("דני", "עד יום חמישי", "הגפן"),
 * ולכן הן מפוענחות כאן, בקוד ולא ב-AI: מהיר, בלי עלות, וצפוי — "מחר" הוא
 * תמיד יום העבודה הבא, בדיוק כמו בברירת המחדל.
 *
 * כל פענוח מחזיר אחד משלושה:
 *   ‎{ value, label }‎     — הבנו
 *   ‎{ candidates: [] }‎   — כמה התאמות; המשתמש בוחר
 *   ‎{ none: true }‎       — לא הבנו; שואלים שוב או מדלגים
 */
const D = require('./db');
const P = require('./permissions');
const W = require('./workdays');

const ORDER = ['assignee', 'dueDate', 'projectId'];

const QUESTIONS = {
  assignee: 'מי אחראי על זה?',
  dueDate: 'עד איזה תאריך?',
  projectId: 'לאיזה פרויקט לשייך?'
};

/**
 * מה לשאול: מה שלא נאמר בהקלטה, או שנאמר ולא זוהה בוודאות. מה שנאמר
 * וזוהה — לא נשאל שוב.
 */
function missingFields(out, draft) {
  const ask = [];
  const heardAssignee = String(out.assignee?.heard ?? '').trim();
  if (!heardAssignee || !out.assignee?.confident || draft.assignee !== (draft.assigneeGuess ?? draft.assignee)) ask.push('assignee');
  if (!W.isDate(out.due_date)) ask.push('dueDate');
  if (!draft.projectId) ask.push('projectId');
  return ORDER.filter((f) => ask.includes(f));
}

// ---------------------------------------------------------------------------
// עזרי טקסט
// ---------------------------------------------------------------------------

const fold = (s) => String(s ?? '')
  .replace(/[֑-ׇ]/g, '')       // ניקוד וטעמים
  .replace(/[״"׳'`.,!?;:()\-–—]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** מילים בלי אותיות שימוש בתחילתן ("לדני", "ודני", "שדני" → "דני") */
const variantsOf = (word) => {
  const out = new Set([word]);
  if (word.length > 2 && /^[לבהוש]/.test(word)) out.add(word.slice(1));
  if (word.length > 3 && /^(של|וה|לה|וב|ול|מה)/.test(word)) out.add(word.slice(2));
  return [...out];
};

const SKIP = /^(דלג|תדלג|דילוג|לא משנה|אין|בלי|ללא|לא|תמשיך|הלאה)$/;
const isSkip = (text) => SKIP.test(fold(text));

// ---------------------------------------------------------------------------
// אחראי
// ---------------------------------------------------------------------------

const ME = /^(אני|עצמי|לעצמי|לי|אצלי|אני אחראי|אני אחראית|אני בעצמי|שלי)$/;
const FILLER = new Set(['אחראי', 'אחראית', 'האחראי', 'האחראית', 'זה', 'את', 'של', 'הוא', 'היא', 'יהיה', 'תהיה', 'תן', 'תני', 'על', 'עם', 'בבקשה', 'אז', 'כן']);

/**
 * @param {string} text   מה שנאמר
 * @param {Array<{value:string,label:string}>} people  מי שמותר לשבץ
 * @param {string} me     ‎user:<id>‎
 */
function matchPerson(text, people, me) {
  const t = fold(text);
  if (!t) return { none: true };
  if (ME.test(t)) {
    const self = people.find((p) => p.value === me);
    return { value: me, label: self?.label ?? 'אני' };
  }
  const words = t.split(' ').filter((w) => !FILLER.has(w));
  if (!words.length) return { none: true };
  const said = new Set(words.flatMap(variantsOf));

  const scored = people.map((p) => {
    const parts = fold(p.label).split(' ').filter(Boolean);
    let score = 0;
    parts.forEach((part, i) => { if (said.has(part)) score += i === 0 ? 3 : 2; });
    // שם מלא שנאמר ברצף — ודאות גבוהה
    if (parts.length > 1 && t.includes(parts.join(' '))) score += 3;
    return { p, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return { none: true };
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length === 1) return { value: top[0].p.value, label: top[0].p.label };
  return { candidates: top.slice(0, 5).map((x) => ({ value: x.p.value, label: x.p.label })) };
}

/** מי מותר לשבץ — עובדים פעילים וספקים, לפי אותה בדיקת הרשאה של יצירת משימה */
function assignablePeople(actor, assertMayAssignTo) {
  const out = [];
  const users = D.all("SELECT id, full_name FROM users WHERE status = 'active' ORDER BY full_name");
  for (const u of users) {
    try { if (u.id !== actor.id) assertMayAssignTo(actor, 'user', u.id); out.push({ value: `user:${u.id}`, label: u.full_name }); } catch { /* אין הרשאה */ }
  }
  if (P.may(actor, 'assign_task_to_vendor')) {
    for (const v of D.all("SELECT id, name FROM vendors WHERE status = 'active' ORDER BY name")) {
      try { assertMayAssignTo(actor, 'vendor', v.id); out.push({ value: `vendor:${v.id}`, label: v.name }); } catch { /* אין הרשאה */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// תאריך
// ---------------------------------------------------------------------------

const NUMBERS = {
  אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4,
  חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10
};
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const pad = (n) => String(n).padStart(2, '0');

/** תאריך עתידי ליום וחודש — השנה הזו, או הבאה אם כבר עבר */
function nextDayMonth(day, month, today) {
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    const d = `${year}-${pad(month)}-${pad(day)}`;
    if (W.isDate(d) && Number(d.slice(8)) === day && d >= today) return d;
  }
  return null;
}

/**
 * "מחר", "מחרתיים", "יום חמישי", "שבוע הבא", "בעוד שלושה ימים", "סוף השבוע",
 * "סוף החודש", "5.11", "5 בנובמבר". "מחר" — יום העבודה הבא של האחראי.
 */
function parseDate(text, { ownerId, today = W.todayIL() } = {}) {
  const t = fold(text).replace(/^(עד|ב|ל|עד ל|עד יום|יום)\s+/, '').replace(/\s+הקרוב$/, '');
  if (!t) return null;
  if (/^(היום|עוד היום)$/.test(t)) return today;
  if (/מחרתיים/.test(t)) return W.addDays(today, 2);
  if (/^(מחר|למחר)(\s|$)/.test(t)) return W.nextWorkDay(ownerId, today);

  // לפני ‎fold‎, שמוחק נקודות: "5.11", "5/11/27"
  const dm = /(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*[./]\s*(\d{2,4}))?/.exec(String(text));
  if (dm) {
    const [day, month] = [Number(dm[1]), Number(dm[2])];
    if (dm[3]) {
      const year = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
      const d = `${year}-${pad(month)}-${pad(day)}`;
      return W.isDate(d) ? d : null;
    }
    return nextDayMonth(day, month, today);
  }

  const monthAt = MONTHS.findIndex((m) => t.includes(m));
  if (monthAt >= 0) {
    const num = /(\d{1,2})/.exec(t)?.[1] ?? Object.entries(NUMBERS).find(([w]) => t.split(' ').includes(w))?.[1];
    if (num) return nextDayMonth(Number(num), monthAt + 1, today);
  }

  const dayAt = W.DAY_NAMES.findIndex((n) => new RegExp(`(^|\\s|ב|ל)${n}(\\s|$)`).test(t));
  if (dayAt >= 0) {
    let diff = (dayAt - W.weekdayOf(today) + 7) % 7 || 7;
    if (/הבא/.test(t) && /שבוע/.test(t)) diff += 7;
    return W.addDays(today, diff);
  }

  if (/סוף (ה)?שבוע/.test(t)) {
    const diff = (4 - W.weekdayOf(today) + 7) % 7;   // חמישי — סוף שבוע העבודה; ביום חמישי עצמו — היום
    return W.addDays(today, diff);
  }
  if (/סוף (ה)?חודש/.test(t)) {
    const [y, m] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  if (/שבוע הבא/.test(t)) return W.addDays(today, 7);
  const rel = /(?:בעוד|תוך)\s+(?:(\S+)\s+)?(יומיים|ימים|יום|שבועיים|שבועות|שבוע|חודשיים|חודשים|חודש)/.exec(t)
    ?? /^()(יומיים|שבועיים|שבוע|חודש)$/.exec(t);
  if (rel) {
    const unit = rel[2];
    let n = rel[1] ? (Number(rel[1]) || NUMBERS[rel[1]] || 1) : 1;
    if (/יומיים|שבועיים|חודשיים/.test(unit)) n = 2;
    if (/יום|ימים|יומיים/.test(unit)) return W.addDays(today, n);
    if (/שבוע/.test(unit)) return W.addDays(today, 7 * n);
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// פרויקט
// ---------------------------------------------------------------------------

const NO_PROJECT = /^(בלי|ללא|אין|בלי פרויקט|ללא פרויקט|אין פרויקט|לא לשייך|שום פרויקט)$/;
const PROJECT_FILLER = new Set(['פרויקט', 'הפרויקט', 'לפרויקט', 'של', 'את', 'ל', 'זה', 'שייך', 'תשייך', 'לשייך']);

/** @param {Array<{id:number,name:string}>} projects  הפרויקטים שמותר לשייך אליהם */
function matchProject(text, projects) {
  const t = fold(text);
  if (!t) return { none: true };
  if (NO_PROJECT.test(t)) return { value: null, label: 'ללא פרויקט' };
  const words = t.split(' ').filter((w) => !PROJECT_FILLER.has(w));
  const said = new Set(words.flatMap(variantsOf));
  const phrase = words.join(' ');

  const scored = projects.map((p) => {
    const name = fold(p.name);
    const parts = name.split(' ').filter((w) => !PROJECT_FILLER.has(w));
    let score = 0;
    if (phrase && name === phrase) score += 10;
    else if (phrase.length >= 3 && name.includes(phrase)) score += 5;
    parts.forEach((part) => { if (part.length >= 2 && said.has(part)) score += 2; });
    return { p, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return { none: true };
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length === 1) return { value: top[0].p.id, label: top[0].p.name };
  return { candidates: top.slice(0, 5).map((x) => ({ value: x.p.id, label: x.p.name })) };
}

module.exports = {
  ORDER, QUESTIONS, missingFields, matchPerson, assignablePeople, parseDate, matchProject, isSkip, fold
};
