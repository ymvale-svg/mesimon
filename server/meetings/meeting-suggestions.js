'use strict';
/**
 * 🎥 משימות מפגישה מוקלטת ← "ממתין לאישורך" במשימון (הוחלט 16.11.26).
 *
 * הבוט הוא המזכירה, משימון הוא לוח העבודה ("תוכנית — חלוקת תפקידים בוט ומשימון", שורת "פגישה"):
 * הבוט שולח את הסיכום ואת המשימות לקריאה, ולא מציע לפתוח משימות. המשימות עצמן נכנסות כהצעות
 * (‎ai_suggestions‎, ‎kind = 'task'‎, ‎data.source = 'meeting'‎) — כל אחת אצל האחראי שלה, שמאשר, משנה או דוחה
 * במשימון. משימה בלי אחראי — אצל מי ששלח את ההקלטה.
 *
 * מזהה ההצעה (‎header_id‎): ‎meeting:<source>:<ref>:<n>‎ — משימה אחת מהפגישה ← הצעה אחת, אצל אדם אחד.
 */
const D = require('../core').Db;

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const headerOf = (source, ref, n) => `meeting:${source}:${ref}:${n}`;
const userRow = (id) => D.get("SELECT id, full_name FROM users WHERE id = ? AND status = 'active'", id);

/**
 * הצעה לכל משימה מהפגישה, אצל האחראי (‎ownerOf(it)‎ ← מזהה עובד; אין — ‎fallbackId‎). מה שכבר הוצע — לא שוב.
 * @param {{source: string, ref: string|number, title: string, items: object[], fromId: number, ownerOf?: Function, fallbackId?: number|null, only?: number[]|null}} p
 * @returns {number} כמה הצעות נוספו
 */
function suggest({ source, ref, title, items, fromId, ownerOf = (it) => it._ownerId ?? null, fallbackId = fromId, only = null }) {
  const from = userRow(fromId);
  let added = 0;
  items.forEach((it, i) => {
    const n = i + 1;
    if (only && !only.includes(n)) return;
    const target = ownerOf(it) ?? fallbackId;
    if (!target || !userRow(target)) return;
    const header = headerOf(source, ref, n);
    if (D.get('SELECT id FROM ai_suggestions WHERE header_id = ?', header)) return;
    const data = {
      source: 'meeting',
      title: String(it.task ?? '').slice(0, 120),
      summary: `🎥 מהפגישה "${title}"${it._ownerName || it.owner_name ? `\nאחראי לפי הפגישה: ${it._ownerName || it.owner_name}` : ''}`,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(it.due ?? '') ? it.due : '',
      priority: 'normal',
      checklist: [],
      // מי ששלח את ההקלטה — מתויג/ת לידיעה כשהמשימה אצל מישהו אחר
      people: target !== fromId && from ? [{ userId: from.id, name: from.full_name, role: 'watcher', checklistIndex: 0 }] : [],
      ambiguous: [],
      meetingTitle: title,
      meetingSource: source,
      meetingRef: String(ref),
      unowned: !ownerOf(it)
    };
    D.run(
      `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
       VALUES (?, 'task', 'pending', '', ?, ?, '', ?, ?, ?, ?)`,
      target, header, from?.full_name ?? '', title, D.nowIso(), JSON.stringify(data), D.nowIso()
    );
    added++;
    if (target !== fromId) {
      D.notify({ targetType: 'user', targetId: target, kind: 'ai', title: `🎥 משימה בשבילך מהפגישה "${title}"`, body: `${data.title} — ממתין לאישורך` });
    }
  });
  return added;
}

/** "תפתח את המשימות" במילים — המשימה נפתחה בבוט, וההצעה במשימון יורדת */
function markOpened(source, ref, n, taskId) {
  D.run("UPDATE ai_suggestions SET status = 'approved', task_id = ?, decided_at = ? WHERE header_id = ? AND status = 'pending'",
    taskId, D.nowIso(), headerOf(source, ref, n));
}

/** כמה הצעות מהפגישה עוד ממתינות — ואצל מי */
function pending(source, ref) {
  return D.all(
    `SELECT s.user_id, u.full_name, COUNT(*) AS n FROM ai_suggestions s JOIN users u ON u.id = s.user_id
      WHERE s.header_id LIKE ? AND s.status = 'pending' GROUP BY s.user_id ORDER BY n DESC`,
    `meeting:${source}:${ref}:%`
  );
}

/** 📋 המרת המשימות של העובד מהפגישה (הוחלט 26.11.26) — הכפתורים, משותפים לפגישה מוקלטת ולהקלטה מוואטסאפ */
const CONVERT_BTN = Object.freeze({ checklist: "☑️ משימה + צ'קליסט", separate: '📌 משימות נפרדות', openOne: 'לפתוח משימה ✅' });

/** הכפתורים להמרה: כמה פריטים — צ'קליסט / נפרדות; אחד — "לפתוח משימה" */
const convertButtons = (n) => (n > 1 ? [CONVERT_BTN.checklist, CONVERT_BTN.separate] : n === 1 ? [CONVERT_BTN.openOne] : []);

/** שורת השאלה להמרה */
const convertLine = (n) => (n > 1 ? `📋 *להמיר את ${n} המשימות שלך?* ☑️ משימה אחת עם צ'קליסט, או 📌 משימה לכל פריט.` : n === 1 ? '📋 *להמיר את המשימה שלך?* — *לפתוח משימה* ✅' : '');

module.exports = { suggest, markOpened, pending, headerOf, CONVERT_BTN, convertButtons, convertLine };
