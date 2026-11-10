'use strict';
/**
 * 📬 מה מהמייל מגיע לוואטסאפ, ואיך מייל הוא פריט אחד (הוחלט 10.11.26, ישראל: "לא להקפיץ כל מייל לוואטסאפ —
 * אחרת מה עשינו? זה ישגע את הבן אדם ויפסיק להסתכל". "3 ביום, רק ראשי"):
 *
 *   • קופץ בוואטסאפ רק מייל שאני **הנמען הראשי** בו (לא בהעתק), לא דיוור / אוטומטי, לא משולח שהשתקתי,
 *     ומעל סף חשיבות (‎scoreOf‎ ב-‎mail-actions.js‎: דדליין קרוב, עדיפות, שולח שעונים לו, ותק).
 *     הודעה מיידית (מייל שזה עתה הגיע) — רק מעל סף גבוה יותר.
 *   • עד 3 הודעות יזומות על מיילים ביום (‎PACE‎ ב-‎mail-actions.js‎; "מעט" — אחת), כולל ההודעה המרוכזת.
 *   • כל השאר — ב"היום" ([לעבור עליהם 👉]), ופעם אחת בצהריים: "📬 4 מיילים מחכים לך" (‎digestFor‎).
 *   • "להתעלם" — המייל יורד מכל המקומות (הצעה, תובנה, תזכורת). פעמיים מאותו שולח — שאלה אחת: "לא להקפיץ
 *     יותר מיילים של X?" — ואז הם רק ב"היום".
 */
const D = require('../db');
const W = require('../workdays');

const PUSH_MIN = 4;   // תזכורת "זכרת?" / הודעה מרוכזת
const NOW_MIN = 6;    // הודעה מיידית על מייל שזה עתה הגיע
const DIGEST_AT = '13:00';
const DIGEST_MIN = 2; // פחות משני מיילים — אין טעם בהודעה מרוכזת

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const prefsOf = (userId) => D.userPrefs(userId)?.botPrefs ?? {};
const savePrefs = (userId, patch) => D.setUserPref(userId, 'botPrefs', { ...prefsOf(userId), ...patch });

/** השולחים שהעובד ביקש לא להקפיץ */
const mutedSenders = (userId) => new Set((prefsOf(userId).mailMutedSenders ?? []).map((e) => String(e).toLowerCase()));

/**
 * מותר להקפיץ את המייל הזה בוואטסאפ? ‎now‎ — הודעה מיידית (סף גבוה יותר).
 * הצעה ישנה, מלפני שנרשם ‎toMe‎ — כמו ראשי (הן יורדות ממילא אחרי שבוע).
 */
function pushable(row, { now = false } = {}) {
  const d = parseJson(row.data, {});
  if (d.toMe === false || d.auto) return false;
  if (mutedSenders(row.user_id).has(String(row.from_email ?? '').toLowerCase())) return false;
  return require('./mail-actions')._internal.scoreOf(row) >= (now ? NOW_MIN : PUSH_MIN);
}

/** פריט מייל ל"היום" ולמעבר אחד-אחד — מהצעה (‎ai_suggestions‎) או מתובנה "דורש ממך" */
function mailItem({ sug = null, ins = null }) {
  if (sug) {
    const d = sug.data ?? parseJson(sug.data, {});
    return {
      t: 'mail', id: sug.id, gmailId: sug.gmailId ?? sug.gmail_id ?? null, title: d.title ?? sug.subject,
      fromEmail: String(sug.from?.email ?? sug.from_email ?? '').toLowerCase(), fromName: sug.from?.name ?? sug.from_name ?? '',
      subject: sug.subject ?? '', closure: Boolean(d.closure && !d.closure.dismissed && ['contact', 'assign', 'self'].includes(d.closure.kind)),
      look: Boolean(d.people?.length || d.ambiguous?.length || d.warning || d.aiRequest)
    };
  }
  return {
    t: 'mail', id: null, ref: ins.ref, gmailId: ins.gmailId ?? ins.ref, title: ins.insight,
    fromEmail: String(ins.fromEmail ?? '').toLowerCase(), fromName: ins.label ?? '', subject: ins.subject ?? '', closure: false, look: false,
    important: ins.importance >= 3
  };
}

/** אותו שרשור — אותו נושא (בלי Re:) מאותו שולח */
const threadKey = (x) => `${String(x.fromEmail)}|${String(x.subject ?? '').replace(/^\s*((re|fw|fwd|תשובה|השב|העבר)\s*:\s*)+/i, '').trim().toLowerCase()}`;

/** פריט אחד לכל שרשור — ההצעה גוברת על התובנה (יש בה "איך לסגור" ותזכורת) */
function onePerThread(items) {
  const keysOf = (x) => [x.gmailId && `g:${x.gmailId}`, x.subject && threadKey(x)].filter(Boolean);
  // קודם ההצעות (‎id‎), אחר כך התובנות — מה שנשאר מכל שרשור
  const seen = new Map();
  for (const x of [...items.filter((i) => i.t === 'mail' && i.id), ...items.filter((i) => i.t === 'mail' && !i.id)]) {
    const keys = keysOf(x);
    const prev = keys.map((k) => seen.get(k)).find(Boolean);
    if (prev) { prev.score = Math.max(prev.score ?? 0, x.score ?? 0); continue; }
    keys.forEach((k) => seen.set(k, x));
  }
  const kept = new Set(seen.values());
  return items.filter((x) => x.t !== 'mail' || kept.has(x)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * "להתעלם" על מייל — מכל המקומות: ההצעות מאותו מייל נדחות (‎MailScan.reject‎), התובנה מוסתרת, התזכורת נסגרת.
 * מחזיר שאלה ("לא להקפיץ יותר מיילים של X?") כשזו הפעם השנייה מאותו שולח, ‎null‎ — בלי שאלה
 */
function ignoreMail(actor, item) {
  const MailScan = require('./mail-scan');
  const MailActions = require('./mail-actions');
  const userId = actor.id;
  const rows = item.gmailId
    ? D.all("SELECT id, status FROM ai_suggestions WHERE user_id = ? AND gmail_id = ? AND kind = 'task'", userId, item.gmailId)
    : item.id ? D.all('SELECT id, status FROM ai_suggestions WHERE user_id = ? AND id = ?', userId, item.id) : [];
  for (const r of rows) {
    MailActions._internal.setRemind(r.id, { closed: 'ignored', at: D.nowIso() });
    if (['pending', 'read'].includes(r.status)) { try { MailScan.reject(r.id, actor); } catch { /* כבר הוחלט */ } }
  }
  if (item.gmailId) require('./mail-insights').dismiss(userId, item.gmailId);
  return countIgnore(userId, item.fromEmail, item.fromName);
}

/** ספירת "להתעלם" לשולח — בפעם השנייה: הצעה להשתיק אותו (פעם אחת לשולח) */
function countIgnore(userId, email, name = '') {
  const e = String(email ?? '').toLowerCase();
  if (!e || mutedSenders(userId).has(e)) return null;
  const p = prefsOf(userId);
  const counts = { ...(p.mailIgnores ?? {}) };
  counts[e] = (counts[e] ?? 0) + 1;
  const asked = new Set(p.mailMuteAsked ?? []);
  savePrefs(userId, { mailIgnores: counts });
  if (counts[e] < 2 || asked.has(e)) return null;
  savePrefs(userId, { mailMuteAsked: [...asked, e].slice(-200) });
  const who = name || e;
  return {
    text: `🔕 זו הפעם השנייה שמייל מ*${who}* לא רלוונטי. לא להקפיץ יותר מיילים שלו/ה בוואטסאפ? (הם יישארו ב"היום")`,
    draft: { kind: 'mail_mute_sender', email: e, name: who }
  };
}

/** תשובה ל"לא להקפיץ יותר מיילים של X?" */
function answerMute(userId, d, text) {
  const WaUi = require('./wa-ui');
  const n = WaUi.normalize(text);
  if (WaUi.sameLabel(text, WaUi.BTN.yes) || WaUi.YES.test(n)) {
    savePrefs(userId, { mailMutedSenders: [...mutedSenders(userId), d.email].slice(-300) });
    const from = `מ${/^[א-ת]/.test(d.name) ? '' : '-'}${d.name}`;
    return { text: `🔕 בסדר — מיילים ${from} רק ב"היום", לא בוואטסאפ. להחזיר: "תקפיץ מיילים ${from}".`, result: `הושתק: ${d.email}` };
  }
  if (WaUi.sameLabel(text, WaUi.BTN.no) || WaUi.NO.test(n)) return { text: 'בסדר, ממשיכים כרגיל 👍', result: 'לא הושתק' };
  return null;
}

/** "תקפיץ מיילים מ…" — מחזיר שולח שהושתק. ‎null‎ — לא פקודה כזו */
function unmuteCommand(userId, text) {
  const m = /^(?:תקפיץ|תחזיר)\s+(?:(?:לי|את)\s+)?(?:ה)?מיילים\s+(?:מ|של\s+)(.{2,60}?)[.!]*$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const want = m[1].replace(/^-/, '').trim().toLowerCase();
  const list = [...mutedSenders(userId)];
  const hit = list.find((e) => e === want || e.includes(want));
  if (!hit) return { text: `לא מצאתי שולח מושתק בשם "${m[1]}".${list.length ? `\nהמושתקים: ${list.join(', ')}` : ''}`, result: 'לא נמצא מושתק' };
  savePrefs(userId, { mailMutedSenders: list.filter((e) => e !== hit) });
  return { text: `🔔 מיילים מ-${hit} יקפצו שוב כשהם חשובים.`, result: `הוחזר: ${hit}` };
}

/** ההצעות מהמייל שמחכות לעובד (7 ימים, לא טופלו / לא הוחלט עליהן) — לסיכום ולהודעה המרוכזת */
function waitingMail(userId) {
  return D.all(
    `SELECT * FROM ai_suggestions
      WHERE user_id = ? AND kind = 'task' AND status IN ('pending', 'read') AND gmail_id <> ''
        AND header_id NOT LIKE 'doc:%' AND COALESCE(json_extract(data, '$.source'), 'email') = 'email'
        AND COALESCE(json_extract(data, '$.auto'), 0) = 0
        AND json_extract(data, '$.remind.closed') IS NULL AND COALESCE(received_at, created_at) >= ?
      ORDER BY received_at DESC, id DESC LIMIT 60`,
    userId, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  );
}

/**
 * ☀️ שורה לסיכום הבוקר: כמה מחכים וכמה מהם חשובים — שהעובד יראה שלא מפספסים, בלי הצפה.
 */
function morningLine(userId) {
  const rows = waitingMail(userId);
  const seen = new Set();
  const uniq = rows.filter((r) => !seen.has(r.gmail_id) && seen.add(r.gmail_id));
  if (!uniq.length) return null;
  const important = uniq.filter((r) => pushable(r)).length;
  return `📬 ${uniq.length === 1 ? 'מייל אחד מחכה' : `${uniq.length} מיילים מחכים`} לך${important ? ` (${important} חשובים — עליהם אזכיר)` : ''}. השאר — ב"היום" ← *לעבור עליהם*.`;
}

/**
 * 📬 ההודעה המרוכזת של הצהריים — פעם ביום, מ-‎DIGEST_AT‎, כשמחכים לפחות ‎DIGEST_MIN‎ מיילים.
 * ‎null‎ — לא עכשיו. נספרת בתקרה היומית (המתקשר בודק ‎mayRemindNow‎ ורושם ‎paceTick‎).
 */
function digestFor(userId) {
  const p = prefsOf(userId);
  const today = W.todayIL();
  if (p.mailDigestOn === today || p.remindPace === 'off' || p.remindPace === 'morning') return null;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (hm < String(D.getSetting('mail_digest_time', DIGEST_AT) || DIGEST_AT)) return null;
  // גם ההודעה המרוכזת קופצת בוואטסאפ — רק ראשי, ולא משולח מושתק
  const seen = new Set();
  const muted = mutedSenders(userId);
  const rows = waitingMail(userId).filter((r) => parseJson(r.data, {}).toMe !== false && !muted.has(String(r.from_email ?? '').toLowerCase())
    && !seen.has(r.gmail_id) && seen.add(r.gmail_id));
  if (rows.length < DIGEST_MIN) return null;
  savePrefs(userId, { mailDigestOn: today });
  const scoreOf = require('./mail-actions')._internal.scoreOf;
  rows.sort((a, b) => scoreOf(b) - scoreOf(a));
  const items = rows.slice(0, 12).map((r) => {
    const m = mailItem({ sug: { ...r, data: parseJson(r.data, {}) } });
    return { ...m, sub: `📧 ${m.fromName || m.fromEmail}` };
  });
  const top = items[0];
  return {
    text: `📬 *${rows.length} מיילים מחכים לך*\nהכי חשוב: *${top.title}* — ${top.fromName || top.fromEmail}`,
    items
  };
}

module.exports = { pushable, mailItem, onePerThread, ignoreMail, answerMute, unmuteCommand, morningLine, digestFor, waitingMail, mutedSenders, PUSH_MIN, NOW_MIN };
