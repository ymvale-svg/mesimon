'use strict';
/**
 * השוואת טקסט זולה, בלי AI — הסינון המוקדם של פרק 11.
 *
 * ה-AI הוא המכריע ("האם המייל עונה על המשימה", "האם אלה אותה עבודה"), אבל
 * הוא יקר ואיטי: אי אפשר לשלוח לו כל מייל מול כל משימה, או כל זוג משימות
 * במחלקה. כאן נבחרים המועמדים — מעטים, לפי מילים משותפות — ורק הם עוברים
 * אליו. כשה-AI אינו מוגדר, הציון כאן הוא גם ההכרעה (בסף גבוה יותר).
 *
 * טהור: אינו ניגש למסד ואינו תלוי בדבר — כדי שאפשר יהיה לבדוק אותו לבד.
 */

// מילים שמופיעות בכל משימה ואינן אומרות דבר על הנושא
const STOP = new Set([
  'של', 'את', 'עם', 'על', 'אל', 'זה', 'זו', 'זאת', 'גם', 'או', 'אם', 'כי', 'לא', 'כן', 'יש', 'אין', 'הוא', 'היא',
  'הם', 'הן', 'אני', 'אנחנו', 'אתה', 'את', 'אתם', 'מה', 'מי', 'איך', 'למה', 'כל', 'עוד', 'רק', 'כבר', 'אבל',
  'שלום', 'תודה', 'בבקשה', 'היי', 'בוקר', 'טוב', 'ערב', 'רב', 'אפשר', 'צריך', 'צריכה', 'לגבי', 'בנושא', 'נושא',
  'משימה', 'משימת', 'לבדוק', 'לטפל', 'טיפול', 'עד', 'אחרי', 'לפני', 'היום', 'מחר', 'אתמול', 'השבוע', 'דחוף',
  're', 'fw', 'fwd', 'the', 'and', 'for', 'to', 'of', 'a', 'in', 'is', 'on', 're:', 'hi', 'thanks'
]);

// אותיות שימוש בתחילת מילה: "והטופס", "לפרויקט", "בבטון"
const PREFIX = /^(?:ו|ה|ב|ל|מ|ש|כ|וה|וב|ול|ומ|וש|שה|שב|של|לה|בה|מה|כש)(?=[א-ת]{3,})/;
// אותיות סופיות — "תוכנית"/"תוכניות" אינן אותה מחרוזת; כאן לפחות הסופיות מתאחדות
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/** מילה אחת → הצורה שמשווים: בלי ניקוד, בלי אותיות שימוש, בלי סיומת רבים */
function stem(word) {
  let w = word.replace(/[֑-ׇ]/g, '').replace(/[״"׳']/g, '');
  w = w.replace(/[ךםןףץ]/g, (c) => FINALS[c]);
  if (/^[א-ת]+$/.test(w)) {
    // פעמיים: "הבטון" ← "בטון" ← "טונ", כמו "בטון" עצמה — שני הצדדים לאותה צורה
    for (let i = 0; i < 2; i++) w = w.replace(PREFIX, '');
    // רבים — "תוכניות" ← "תוכנית"
    if (w.length > 4) w = w.replace(/(?:ות|ימ)$/, '');
    // כתיב מלא וחסר, ונטייה: "הזמין"/"הזמנת", "תוכנית"/"תכנית" — בלי ו/י באמצע ובלי ת/ה בסוף
    if (w.length > 3) w = w[0] + w.slice(1).replace(/[וי]/g, '');
    if (w.length > 3) w = w.replace(/[תה]$/, '');
  }
  return w;
}

/**
 * הטקסט → קבוצת המילים המשמעותיות. מספרים נשמרים ("טופס 4", "שלב 2") — הם
 * לעיתים ההבדל היחיד בין שתי משימות.
 */
function tokens(text) {
  const out = new Set();
  for (const raw of String(text ?? '').toLowerCase().split(/[^0-9a-z֐-׿]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const w = stem(raw);
    if (!w || STOP.has(w)) continue;
    if (/^\d+$/.test(w) || w.length >= 2) out.add(w);
  }
  return out;
}

const shared = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

/**
 * עד כמה שתי משימות נראות אותה עבודה: 0–1. הכותרת היא העיקר (חפיפה ביחס
 * לכותרת הקצרה מבין השתיים), התיאור מוסיף מעט, ופרויקט משותף — עוד קצת.
 * פרויקטים שונים — הורדה: "בטון לשלב ב'" באלעד ובגפן אינן אותה עבודה.
 */
function similarity(a, b) {
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  if (!ta.size || !tb.size) return 0;
  const titleScore = shared(ta, tb) / Math.min(ta.size, tb.size);
  // מספר שמופיע רק באחת ("שלב 2" מול "שלב 3") — כנראה עבודות נפרדות
  const numsA = [...ta].filter((x) => /^\d+$/.test(x));
  const numsB = [...tb].filter((x) => /^\d+$/.test(x));
  const numClash = numsA.length && numsB.length && !numsA.some((x) => numsB.includes(x));
  const da = tokens(`${a.title} ${a.description ?? ''}`);
  const db = tokens(`${b.title} ${b.description ?? ''}`);
  const descScore = da.size && db.size ? shared(da, db) / Math.max(da.size, db.size) : 0;
  let score = titleScore * 0.8 + descScore * 0.2;
  if (a.projectId && b.projectId) score += a.projectId === b.projectId ? 0.1 : -0.25;
  if (numClash) score -= 0.3;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

module.exports = { tokens, stem, shared, similarity, STOP };
