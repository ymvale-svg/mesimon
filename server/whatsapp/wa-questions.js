'use strict';
/**
 * ❓ כפתור שזוכר על איזו שאלה הוא עונה (הוחלט 10.11.26, המלצה #1 מהסקירות הליליות).
 *
 * עד עכשיו לחיצה על כפתור פורשה לפי "מה פתוח עכשיו": "קבלת סחורה 📦" על הצעה מהמייל נבלע בקליטה ריקה,
 * ו"כן ✅" על הודעה ישנה אישר את הטיוטה הנוכחית — גם אם היא על משהו אחר לגמרי.
 *
 * עכשיו כל הודעה עם כפתורים נרשמת (לפי המזהה שוואטסאפ נותן לה), עם מי ששאל ("chat" — השיחה הרגילה,
 * "goods_receipt", "purchase_demand") והטיוטה שעליה היא שואלת. לחיצה מגיעה עם מזהה ההודעה שעליה לחצו
 * (‎stanzaId‎), ומשם:
 *   • השאלה היא הפתוחה עכשיו — ממשיכים, ובטוח לשיחה הנכונה (לא נבלעת בקבלת סחורה / דרישת רכש).
 *   • שאלה יזומה (חשבונית מהמייל, תזכורת על מייל) שנדחקה על ידי הודעה אחרת — חוזרת להיות הפתוחה, והתשובה הולכת אליה.
 *   • שאלה שכבר נענתה או שעברה — "השאלה הזו כבר לא פתוחה", ולא מאשרים בטעות משהו אחר.
 *     "לא" / "התעלם" עליה — "בסדר, לא שיניתי כלום" (זה מה שהעובד ביקש).
 * לחיצה בלי מזהה (או על הודעה מלפני השינוי) — כמו קודם.
 */
const D = require('../core').Db;

const KEEP = 15;                          // שאלות אחרונות לכל עובד
const TTL_MS = 2 * 24 * 60 * 60 * 1000;   // יומיים
/** שאלות יזומות שבטוח להחזיר: התשובה להן בודקת במסד אם כבר טופלו */
const RESTORABLE = new Set(['goods_offer', 'mail_remind', 'sent_followup']);

const keyOf = (userId) => `wa_questions:${userId}`;
const list = (userId) => { const v = D.getSetting(keyOf(userId), []); return Array.isArray(v) ? v : []; };

/** זהות הטיוטה — בלי חותמות זמן, כדי ש"השאלה" ו"הטיוטה שנשמרה" יזוהו כאותה אחת */
function draftKey(d) {
  if (!d || typeof d !== 'object') return '';
  const { askedAt, ...rest } = d;
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(rest));
}

/** הודעה עם כפתורים נשלחה: ‎id‎ — המזהה שוואטסאפ החזיר. ‎awaiting‎ — שאלת כן/לא (ולא תפריט) */
function record(userId, id, { owner = 'chat', draft = null, awaiting = false } = {}, now = Date.now()) {
  if (!userId || !id) return;
  const fresh = list(userId).filter((q) => q.id !== id && now - q.at < TTL_MS);
  D.setSetting(keyOf(userId), [...fresh, { id: String(id), at: now, owner, draft: draft ?? null, key: draftKey(draft), awaiting: Boolean(awaiting), answered: false }].slice(-KEEP));
}

const find = (userId, id) => (id ? list(userId).find((q) => q.id === String(id)) ?? null : null);

/** ‎answer‎ — הכפתור שנלחץ: לחיצה אחרת על אותה שאלה ("לא" ואז "קבלת סחורה") היא שינוי דעה, לא כפילות */
function markAnswered(userId, id, answer = '') {
  if (!userId || !id) return;
  D.setSetting(keyOf(userId), list(userId).map((q) => (q.id === String(id) ? { ...q, answered: true, answer: String(answer ?? '').trim() } : q)));
}

/**
 * מה לעשות בלחיצה על כפתור של שאלה בשיחה הרגילה:
 *   'free' — לא שאלת כן/לא (תפריט, "עוד אפשרויות") — כמו קודם
 *   'current' — זו השאלה הפתוחה עכשיו
 *   'restore' — מחזירים אותה:
 *       • שאלה יזומה (חשבונית מהמייל, תזכורת) שעוד לא נענתה — או שנענתה בכפתור אחר (שינוי דעה). התשובה בודקת במסד.
 *       • התראה על מייל ("לשלוח את התשובה?", "לפתוח משימה?") שהמייל שלה עוד לא טופל (‎alertOpen‎) —
 *         גם אם התראה אחרת הגיעה אחריה. אחרי שטופל, היא כבר לא "פתוחה" במסד — ולא נשלח פעמיים.
 *   'closed' — כבר נענתה (אותו כפתור), או שעברה ואי אפשר להחזיר
 */
function decide(q, currentDraft, { text = '', alertOpen = () => false } = {}) {
  if (!q || q.owner !== 'chat' || !q.awaiting || !q.draft) return 'free';
  if (draftKey(currentDraft) === q.key) return 'current';
  if (RESTORABLE.has(q.draft.kind) && (!q.answered || (q.answer && q.answer !== String(text ?? '').trim()))) return 'restore';
  if (q.draft.alert && q.draft.suggestionIds?.length && alertOpen(q.draft)) return 'restore';
  return 'closed';
}

/**
 * על איזו הודעה ענו: מזהה ההודעה עם הכפתורים (בכל צורה שהשירות מחזיר), או ההודעה שצוטטה ("השב").
 * ‎{ id, button }‎ · ‎{ id: '', button: false }‎ כשאין.
 */
function replyToOf(m) {
  for (const [k, v] of Object.entries(m ?? {})) {
    if (!/button|interactive/i.test(k) || !v || typeof v !== 'object') continue;
    const id = v.stanzaId ?? v.quotedMessageId ?? v.contextInfo?.stanzaId;
    if (id) return { id: String(id), button: true };
  }
  const quoted = m?.quotedMessage?.stanzaId ?? m?.extendedTextMessageData?.stanzaId ?? m?.quotedMessage?.idMessage;
  return { id: quoted ? String(quoted) : '', button: false };
}

const CLOSED_TEXT = 'ℹ️ השאלה הזו כבר לא פתוחה, אז לא עשיתי כלום. אם עדיין צריך — כתבו לי מה לעשות.';
/** "לא" / "התעלם" / "ביטול" על שאלה שכבר לא פתוחה — זה בדיוק מה שקרה (כלום), אז עונים כך ולא "לא פתוחה" (סקירה 12.11) */
const CLOSED_NO_TEXT = 'בסדר 👍 לא שלחתי ולא שיניתי כלום.';
const isNo = (text) => /^(לא|התעלם|ביטול|בטל|עזוב|👎)(?=[\s,.!❌🙈🗑️]|$)/u.test(String(text ?? '').trim());

module.exports = { record, find, markAnswered, decide, draftKey, replyToOf, isNo, RESTORABLE, CLOSED_TEXT, CLOSED_NO_TEXT };
