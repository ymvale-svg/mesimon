'use strict';
/**
 * ✏️ פקודות שורה מדויקות — "שורה 2 כמות 100", "שורה 3 תיאור: כבל HDMI", "שורה 4 הסרה".
 *
 * העריכה הישירה בטבלה במסך (‎/priority/receipt‎, ‎/priority/demand‎) שולחת למנוע פקודה כזו — אותו מסלול כמו
 * תיקון שהעובד מקליד, אבל בלי AI: הניסוח קבוע, ולכן התוצאה ודאית. אפשר להקליד אותן גם בוואטסאפ.
 * כמה פקודות בהודעה אחת — מופרדות ב-";" או בשורה חדשה.
 *
 * ‎parse(text)‎ ← ‎{ updates: [{ line, qty }], renames: [{ line, description }], removes: [line] }‎,
 * או ‎null‎ כשהטקסט אינו כולו פקודות (אז המנוע ממשיך כרגיל — שפה חופשית).
 */
const QTY = /^שורה\s*(\d{1,3})\s*[:\-–]?\s*כמות\s*[:\-–]?\s*(\d+(?:\.\d+)?)$/;
const DES = /^שורה\s*(\d{1,3})\s*[:\-–]?\s*תיאור\s*[:\-–]\s*(.+)$/;
const DEL = /^(?:שורה\s*(\d{1,3})\s*[:\-–]?\s*(?:הסרה|למחוק|מחיקה)|(?:הסר|מחק|למחוק)\s+שורה\s*(\d{1,3}))$/;

function parse(text) {
  const parts = String(text ?? '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = { updates: [], renames: [], removes: [] };
  for (const p of parts) {
    let m = QTY.exec(p);
    if (m) { out.updates.push({ line: Number(m[1]), qty: Number(m[2]) }); continue; }
    m = DES.exec(p);
    if (m && m[2].trim()) { out.renames.push({ line: Number(m[1]), description: m[2].trim().slice(0, 120) }); continue; }
    m = DEL.exec(p);
    if (m) { out.removes.push(Number(m[1] ?? m[2])); continue; }
    return null;
  }
  return out;
}

/** לתשובת המנוע של קבלת הסחורה (‎REPLY_SCHEMA‎): פעולה אחת בכל פעם — כמויות קודם, אחר כך תיאורים */
function asReceiptReply(cmd) {
  const base = { updates: [], renames: [], adds: [], note: 'עריכה ישירה', choice: '', question: '' };
  if (cmd.updates.length) return { ...base, action: 'update', updates: cmd.updates };
  if (cmd.renames.length) return { ...base, action: 'rename', renames: cmd.renames };
  // הסרת שורה בקבלת סחורה = לא התקבלה (כמות 0)
  if (cmd.removes.length) return { ...base, action: 'update', updates: cmd.removes.map((line) => ({ line, qty: 0 })) };
  return null;
}

/** לתשובת המנוע של דרישת הרכש (‎ai.edit‎): עדכון כמות או תיאור, והסרה */
function asDemandEdit(cmd) {
  return {
    action: 'edit', adds: [], question: '', removes: cmd.removes,
    updates: [...cmd.updates.map((u) => ({ line: u.line, qty: u.qty, description: '' })), ...cmd.renames.map((r) => ({ line: r.line, qty: 0, description: r.description }))]
  };
}

module.exports = { parse, asReceiptReply, asDemandEdit };
