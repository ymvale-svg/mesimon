'use strict';
/**
 * 🔗 השרשרת של משימון פריוריטי — איפה עומד כל מסמך (‎/priority/chain‎).
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md". השלבים (‎priority_docs.stage‎):
 *   התקבל (new) → בטיפול בבוט (bot) → טיוטא בפריוריטי (draft) → מחכה לאישור (waiting) → סופי (done)
 *   ובצד: בוטל (cancelled), הוצא מהתור (rejected).
 *
 * הזרימות בבוט (‎goods-receipt.js‎, ‎purchase-demand.js‎) מדווחות כאן כשמשהו קורה בפריוריטי (‎progress‎): טיוטא נפתחה,
 * הפכה לסופית, בוטלה, דרישה עברה לאישור. הדיווח נקשר למסמך שנשלח לבוט מהמסך; קליטה שהתחילה ישר בוואטסאפ —
 * נרשמת כמסמך חדש (‎source='whatsapp'‎), כדי שהשרשרת תראה הכל.
 *
 * תלוי רק במסד (לא בבוט ולא בתור) — כך הזרימות יכולות לדווח בלי תלות מעגלית. דיווח לעולם לא זורק:
 * תקלה כאן לא תעצור קבלת סחורה.
 */
const D = require('../core').Db;

const ORG = 1;
const STAGES = Object.freeze([
  { key: 'new', label: 'התקבל', hint: 'מהמייל או מהמסך' },
  { key: 'bot', label: 'בטיפול בבוט', hint: 'השיחה בוואטסאפ' },
  { key: 'draft', label: 'טיוטא בפריוריטי', hint: 'מחכה ל"מאשר"' },
  { key: 'waiting', label: 'מחכה לאישור', hint: 'אצל החותם בפריוריטי' },
  { key: 'done', label: 'סופי', hint: '14 הימים האחרונים' }
]);
const LABELS = { ...Object.fromEntries(STAGES.map((s) => [s.key, s.label])), cancelled: 'בוטל', rejected: 'הוצא מהתור' };
const DONE_DAYS = 14;
const BOT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * דיווח מהבוט. ‎doc‎ — receipt / demand. ‎stage‎ — draft / waiting / done / cancelled.
 * ‎docno‎ — המספר בפריוריטי; ‎company‎, ‎supplier‎ — לתצוגה.
 */
function progress(userId, doc, { stage, docno = '', company = '', supplier = '' } = {}) {
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
        `INSERT INTO priority_docs (org_id, user_id, doc, source, filename, supplier, stage, docno, company, created_at, updated_at)
         VALUES (?,?,?, 'whatsapp', '', ?, ?, ?, ?, ?, ?)`, ORG, userId, doc, String(supplier).slice(0, 120), stage, docno, company, now, now
      );
      return Number(info.lastInsertRowid);
    }
    D.run('UPDATE priority_docs SET stage = ?, docno = ?, company = ?, supplier = ?, updated_at = ? WHERE id = ?',
      stage, docno || row.docno, company || row.company, supplier || row.supplier, now, row.id);
    return row.id;
  } catch (err) {
    console.error('[משימון] שרשרת פריוריטי — דיווח נכשל:', err.message);
    return null;
  }
}

/**
 * הלוח: עמודה לכל שלב. מנהל מערכת — כל הארגון; עובד — רק שלו. ‎doc‎ — סינון לסוג מסמך.
 * מסמך סופי — רק מהימים האחרונים.
 */
function board(actor, { doc = null, all = false } = {}) {
  const since = new Date(Date.now() - DONE_DAYS * 86400000).toISOString();
  const params = [ORG, since];
  let where = "d.org_id = ? AND d.stage IN ('new','bot','draft','waiting','done') AND (d.stage != 'done' OR d.updated_at >= ?)";
  if (!all) { where += ' AND d.user_id = ?'; params.push(actor.id); }
  if (doc) { where += ' AND d.doc = ?'; params.push(doc); }
  const rows = D.all(`SELECT d.*, u.full_name AS owner FROM priority_docs d LEFT JOIN users u ON u.id = d.user_id WHERE ${where} ORDER BY d.updated_at DESC LIMIT 500`, ...params);
  return {
    stages: STAGES,
    columns: Object.fromEntries(STAGES.map((s) => [s.key, rows.filter((r) => r.stage === s.key).map(card)]))
  };
}

const card = (r) => ({
  id: r.id, doc: r.doc, source: r.source, stage: r.stage, stageLabel: LABELS[r.stage] ?? r.stage,
  title: r.supplier || r.from_name || r.filename || (r.docno ? r.docno : 'מסמך'), filename: r.filename,
  docno: r.docno, company: r.company, owner: r.owner ?? '', userId: r.user_id, at: r.created_at, updatedAt: r.updated_at
});

module.exports = { STAGES, LABELS, progress, board };
