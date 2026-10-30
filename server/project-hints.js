'use strict';
/**
 * רמזים על פרויקטים ל-AI — כדי שיוכל להציע לאיזה פרויקט משימה שייכת גם
 * כשהשם לא נאמר: מי מנהל אותו, ואילו משימות פתוחות יש בו עכשיו. שם פרויקט
 * לבדו ("אלעד", "משרד שוטף") אינו מספיק כדי לשייך "להזמין טכנאי למעליות".
 *
 * משמש את הבוט (‎ai/wa-bot.js‎) ואת ההקלטה (‎voice.js‎), ורק על הפרויקטים
 * שהמשתמש רשאי לפתוח בהם משימה — לא חושף משימות מפרויקטים אחרים.
 */
const D = require('./db');

const TITLES = 3;

/** שורה לכל פרויקט: ‎"12 · אלעד צפון — מנהל: דני · משימות: הזמנת מעליות; תסריט חשמל"‎ */
function lines(projects, { sep = ' · ', marker = () => '' } = {}) {
  return projects.map((p) => {
    const manager = p.managerName ? `מנהל: ${p.managerName}` : '';
    const titles = D.all(
      `SELECT t.title FROM tasks t LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.project_id = ? AND t.archived = 0 AND COALESCE(c.is_final, 0) = 0
        ORDER BY t.created_at DESC LIMIT ?`,
      p.id, TITLES
    ).map((t) => String(t.title).slice(0, 60));
    const extra = [manager, titles.length ? `משימות: ${titles.join('; ')}` : ''].filter(Boolean).join(' · ');
    return `${p.id}${sep}${p.name}${marker(p)}${extra ? ` — ${extra}` : ''}`;
  });
}

module.exports = { lines };
