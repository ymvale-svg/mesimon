'use strict';
/**
 * מוסכמות ממשק לבוט הוואטסאפ — לכל זרימה של פריוריטי (ובכלל) מכאן והלאה.
 *
 * כפתורי תשובה: עד 3 לשאלה, על ההודעה האחרונה. הכיתוב של כפתור הוא בדיוק התשובה שהבוט מבין, כך שלחיצה
 * עובדת גם כשהיא חוזרת כטקסט רגיל. צבע אי אפשר לקבוע (וואטסאפ מצייר), ולכן האימוג'י הם הסימון:
 *   ✅ אישור / כן   ·   ❌ לא   ·   🗑️ ביטול   ·   🏁 סיום
 * ובטקסט של ההודעות: "*כן* 👍", "*לא* 👎" — כי 👍 / 👎 הם גם תשובה (גם כתגובה על הודעה).
 * שליחה: ‎sendButtons(chatId, text, buttons)‎ ב-‎wa-bot.js‎ (נכשל — טקסט רגיל).
 */
const BTN = Object.freeze({
  yes: 'כן ✅',
  no: 'לא ❌',
  approve: 'מאשר ✅',
  cancel: 'ביטול 🗑️',
  confirmCancel: 'כן, לבטל 🗑️',
  confirmFinal: 'כן, לסגור ✅',
  backToDraft: 'חזרה לטיוטא',
  done: 'סיום 🏁'
});

/** תשובות "כן" / "לא" / "ביטול" — כולל הכפתורים והאימוג'י (גוון עור מנוטרל לפני הבדיקה) */
const YES = /^(כן|נכון|מאשר|מאשרת|אשר|אישור|תקין|יאללה|אוקי|אוקיי|סבבה|ok|yes|👍|👌|✅|✔)([\s,.!]|$)/i;
const NO = /^(לא|אל|ממש לא|no|👎|❌)([\s,.!]|$)/i;
const CANCEL = /^(ביטול|בטל|לבטל|עזוב|יציאה|stop|🗑)([\s,.!]|$)/i;
const normalize = (text) => String(text ?? '').replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '').replace(/(👍|👌|✅|✔|👎|❌)\1+/gu, '$1').trim();

/** כיתוב כפתור — עד 20 תווים (וואטסאפ); הכיתוב הוא בדיוק התשובה שהבוט מבין */
const label = (t) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length <= 20 ? x : `${x.slice(0, 19).trim()}…`; };
/**
 * כיתובים לכמה כפתורים: כשהקיצור מתנגש ("מבואות חיפה sea&clo…" פעמיים) — בלי המילים המשותפות בתחילת השמות
 * ("מגרש 207", "מגרש 208"), וכשגם זה לא מספיק — סוף השם.
 */
function labels(names) {
  const out = names.map(label);
  if (new Set(out).size === out.length) return out;
  const ws = names.map((n) => String(n ?? '').replace(/\s+/g, ' ').trim().split(' '));
  let k = 0;
  while (ws.every((w) => w.length > k + 1 && w[k] === ws[0][k])) k++;
  const tail = ws.map((w) => label(w.slice(k).join(' ')));
  if (new Set(tail).size === tail.length) return tail;
  return names.map((n) => { const x = String(n ?? '').replace(/\s+/g, ' ').trim(); return x.length <= 20 ? x : `…${x.slice(-19).trim()}`; });
}
const sameLabel = (a, b) => normalize(a).replace(/…$/, '') === normalize(b).replace(/…$/, '') || (normalize(b).endsWith('…') && normalize(a).startsWith(normalize(b).slice(0, -1)));

/** כפתורים נפוצים */
const yesNo = () => [BTN.yes, BTN.no];
const yesCancel = () => [BTN.yes, BTN.cancel];

module.exports = { BTN, YES, NO, CANCEL, normalize, label, labels, sameLabel, yesNo, yesCancel };
