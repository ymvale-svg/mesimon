'use strict';
/**
 * ⌨️ הודעה שהוקלדה במקלדת באנגלית במקום בעברית (רעיון מסקירה 25.11, נבנה 26.11: "KHMR EUC. TEXK" = "ליצר קובץ אקסל",
 * והבוט לא הבין). ‎fix(text)‎ — הטקסט בעברית לפי מיקום המקשים, או ‎null‎ כשההודעה נראית כמו אנגלית / קוד / מספר.
 *
 * ממירים רק כשבטוחים למדי: רק אותיות לטיניות וסימני המקשים העבריים (‎; , . ' / [ ]‎), בלי ספרות, בלי @ / קישור,
 * בלי מילה מוכרת באנגלית, בלי אות סופית (‎o i l ; .‎) באמצע מילה — ויש מילה של 3+ אותיות בלי תנועה באנגלית
 * (‎khmr‎), או שהתנועות מעטות.
 */
const MAP = {
  q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ',
  a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך', ';': 'ף', "'": ',',
  z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ', '/': '.'
};
// מילים באנגלית שעובדים כותבים לבוט (ומילים קצרות שכל מקלדת מייצרת) — לא ממירים
const ENGLISH = new Set(('ok okay yes no hi hey hello thanks thank you please pdf excel word file mail email gmail whatsapp zoom '
  + 'po gr pd test the and or to of in on for is it this that send call meeting task done stop help menu bot priority '
  + 'sorry good morning night bye great nice cool lol wow').split(' '));

function fix(text) {
  const t = String(text ?? '').trim();
  if (!/^[A-Za-z ;,.'/]+$/.test(t)) return null;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return null;
  const words = t.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z]+|[^a-z;,.'/]+$/g, '')).filter(Boolean);
  if (words.some((w) => ENGLISH.has(w.replace(/[^a-z]/g, '')))) return null;
  // המקשים o i l ; . הם אותיות סופיות בעברית (ם ן ך ף ץ) — בעברית שהוקלדה בטעות הם רק בסוף מילה; באנגלית — גם באמצע
  if (words.some((w) => /[oil;.][a-z;,'/]/.test(w))) return null;
  const vowels = (letters.match(/[aeiou]/gi) ?? []).length / letters.length;
  const noVowel = words.some((w) => w.replace(/[^a-z]/g, '').length >= 3 && !/[aeiou]/.test(w));
  if (!noVowel && vowels >= 0.45) return null;
  return t.toLowerCase().split('').map((ch) => MAP[ch] ?? ch).join('');
}

module.exports = { fix };
