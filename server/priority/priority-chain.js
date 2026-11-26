'use strict';
/**
 * 🔗 השלב של כל מסמך במשימון פריוריטי (‎priority_docs.stage‎). מסך "השרשרת" הוסר (24.11.26) — נשאר הדיווח.
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md". השלבים (‎priority_docs.stage‎):
 *   התקבל (new) → בטיפול בבוט (bot) → טיוטא בפריוריטי (draft) → מחכה לאישור (waiting) → סופי (done)
 *   ובצד: בוטל (cancelled), הוצא מהתור (rejected).
 *
 * הזרימות בבוט (‎goods-receipt.js‎, ‎purchase-demand.js‎) מדווחות כאן כשמשהו קורה בפריוריטי (‎progress‎): טיוטא נפתחה,
 * הפכה לסופית, בוטלה, דרישה עברה לאישור. הדיווח נקשר למסמך שנשלח לבוט מהמסך; קליטה שהתחילה ישר בוואטסאפ —
 * נרשמת כמסמך חדש (‎source='whatsapp'‎).
 *
 * תלוי רק במסד (לא בבוט ולא בתור) — כך הזרימות יכולות לדווח בלי תלות מעגלית. דיווח לעולם לא זורק:
 * תקלה כאן לא תעצור קבלת סחורה.
 */
const D = require('../core').Db;

const ORG = 1;
const STAGES = Object.freeze([
  { key: 'new', label: 'התקבל', hint: 'מהמייל או מהמסך' },
  { key: 'bot', label: 'בעבודה', hint: 'במסך או בבוט' },
  { key: 'draft', label: 'טיוטא בפריוריטי', hint: 'מחכה ל"מאשר"' },
  { key: 'waiting', label: 'מחכה לאישור', hint: 'אצל החותם בפריוריטי' },
  { key: 'done', label: 'סופי', hint: '14 הימים האחרונים' }
]);
const LABELS = { ...Object.fromEntries(STAGES.map((s) => [s.key, s.label])), cancelled: 'בוטל', rejected: 'הוצא מהתור' };
const BOT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * דיווח מהבוט. ‎doc‎ — receipt / demand. ‎stage‎ — draft / waiting / done / cancelled.
 * ‎docno‎ — המספר בפריוריטי; ‎company‎, ‎supplier‎ — לתצוגה. ‎note‎ — תקציר הפריטים ("פטישים, מסמרים"), כדי שהעובד
 * יוכל לשאול עליו אחר כך ("אושרה הדרישה על הפטישים?" — ‎my-docs.js‎).
 */
function progress(userId, doc, { stage, docno = '', company = '', supplier = '', note = '' } = {}) {
  try {
    if (!userId || !doc || !LABELS[stage]) return null;
    const now = D.nowIso();
    let row = docno ? D.get('SELECT * FROM priority_docs WHERE org_id = ? AND user_id = ? AND doc = ? AND docno = ? ORDER BY id DESC LIMIT 1', ORG, userId, doc, docno) : null;
    // המסמך שנשלח לבוט מהמסך — האחרון שעדיין בטיפול
    if (!row) {
      const since = new Date(Date.now() - BOT_WINDOW_MS).toISOString();
      row = D.get("SELECT * FROM priority_docs WHERE org_id = ? AND user_id = ? AND doc = ? AND stage = 'bot' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1", ORG, userId, doc, since);
    }
    if (!row) {
      if (stage === 'cancelled') return null;   // קליטה מוואטסאפ שבוטלה לפני טיוטא — אין מה להראות
      const info = D.run(
        `INSERT INTO priority_docs (org_id, user_id, doc, source, filename, supplier, stage, docno, company, note, created_at, updated_at)
         VALUES (?,?,?, 'whatsapp', '', ?, ?, ?, ?, ?, ?, ?)`, ORG, userId, doc, String(supplier).slice(0, 120), stage, docno, company, String(note).slice(0, 300), now, now
      );
      return Number(info.lastInsertRowid);
    }
    D.run('UPDATE priority_docs SET stage = ?, docno = ?, company = ?, supplier = ?, note = ?, updated_at = ? WHERE id = ?',
      stage, docno || row.docno, company || row.company, supplier || row.supplier, note ? String(note).slice(0, 300) : row.note, now, row.id);
    return row.id;
  } catch (err) {
    console.error('[משימון] שרשרת פריוריטי — דיווח נכשל:', err.message);
    return null;
  }
}

module.exports = { STAGES, LABELS, progress };
