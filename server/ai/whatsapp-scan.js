'use strict';
/**
 * הוואטסאפ האישי → הצעות למשימות ולפגישות, ותובנות.
 *
 * מי שחיבר את הוואטסאפ שלו (Green API) ובחר "להציע משימות מהוואטסאפ שלי":
 * הודעות נכנסות בשיחות **פרטיות** — לא קבוצות; קבוצות נסרקות רק דרך הבוט
 * הארגוני, כדי שאותה הודעה לא תיסרק פעמיים — הופכות להצעות ב"ממתין לאישורך",
 * כמו הצעות מהמייל. בקשה להיפגש — "📅 פגישה לקביעה". מה שכדאי לדעת — תובנה
 * של שורה אחת (‎insights.js‎), בלי גוף ההודעה.
 *
 * רק אנשי קשר עסקיים (‎wa-business.js‎). כל שיחה אחרת אינה נשלחת ל-AI:
 *   • "לא לסרוק" — מדולג, וגובר על הכול.
 *   • מספר לא מוכר — נספר בלי לקרוא. אחרי 3 הודעות הבוט שואל פעם אחת
 *     "עסקי או אישי?". עסקי — נכנס לרשימה ומההודעה הבאה נסרק (הקודמות לא);
 *     אישי, או בלי תשובה תוך ‎ANSWER_DAYS‎ — נכנס ל"לא לסרוק" ולא נשאל שוב.
 *
 * פרטיות: מופעל רק בבחירה. גוף ההודעות אינו נשמר — רק ההצעה, התובנה, השולח
 * והזמן.
 *
 * הקריאה עצמה — ב-‎ai-tasks.js‎ (‎pollWhatsApp‎): שם נקרא התור של Green API,
 * מה ששייך למשימת AI הולך למעקב, והשאר מגיע לכאן.
 */
const fs = require('node:fs');
const Paths = require('../paths');
const path = require('node:path');

const D = require('../db');
const W = require('../workdays');
const Claude = require('./claude');
const WhatsApp = require('../whatsapp');
const Business = require('./wa-business');
const Insights = require('./insights');
const TaskSync = require('./task-sync');

const SKILL = Paths.skill('whatsapp-personal-to-tasks.md');
const ANSWER_DAYS = 3;
const MAX_LIST = 300;

// מוזרק מהבוט: שאלת "עסקי או אישי?" והודעת המעבר. בלי בוט — התראה במערכת
const hooks = { ask: null, notice: null };
const setHooks = (h) => Object.assign(hooks, h);

/*
 * ‎waScan‎ בהעדפות:
 *   enabled · ignore[] (לא לסרוק) · business[] (עסקיים נוספים)
 *   unknown{phone: {n, name, at}} — מספרים לא מוכרים: רק כמה הודעות ומתי
 *   asked{phone: iso} — נשאל "עסקי או אישי?" ועוד לא ענה
 *   businessNotice — קיבל את ההודעה על המעבר לאנשי קשר עסקיים
 */
const prefs = (userId) => {
  const p = D.userPrefs(userId).waScan;
  return { enabled: false, ignore: [], business: [], unknown: {}, asked: {}, businessNotice: false, ...(p && typeof p === 'object' ? p : {}) };
};

const phones = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => WhatsApp.normalizePhone(x)).filter(Boolean))].slice(0, MAX_LIST);

function setPrefs(userId, { enabled, ignore, business }) {
  const cur = prefs(userId);
  const next = {
    ...cur,
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    ignore: Array.isArray(ignore) ? phones(ignore) : cur.ignore,
    business: Array.isArray(business) ? phones(business) : cur.business
  };
  // מי שמפעיל עכשיו — רואה את הכלל בהגדרות עצמן, ואין צורך בהודעת מעבר
  if (enabled === true && !cur.enabled) next.businessNotice = true;
  D.setUserPref(userId, 'waScan', next);
  return next;
}

/** מה שמוצג בהגדרות — בלי המונים הפנימיים */
const publicPrefs = (userId) => {
  const p = prefs(userId);
  return { enabled: p.enabled, ignore: p.ignore, business: p.business, asked: Object.keys(p.asked ?? {}) };
};

/**
 * סימון שולח: ‎business‎ — לרשימה העסקית (ויוצא מ"לא לסרוק"); ‎personal‎ — ל"לא
 * לסרוק" (ויוצא מהעסקית). בשני המקרים — לא נשאל עליו שוב.
 */
function mark(userId, phone, mode) {
  const n = WhatsApp.normalizePhone(phone);
  if (!n) return null;
  const p = prefs(userId);
  const unknown = { ...p.unknown };
  const asked = { ...p.asked };
  delete unknown[n];
  delete asked[n];
  D.setUserPref(userId, 'waScan', {
    ...p,
    unknown,
    asked,
    business: mode === 'business' ? phones([...p.business, n]) : p.business.filter((x) => x !== n),
    ignore: mode === 'business' ? p.ignore.filter((x) => x !== n) : phones([...p.ignore, n])
  });
  return n;
}

/** "עסקי" / "אישי" בלי שם — על השאלה האחרונה שנשאלה */
function lastAsked(userId) {
  const p = prefs(userId);
  const asked = Object.entries(p.asked ?? {}).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  if (!asked.length) return null;
  const [phone] = asked[0];
  return { phone, name: p.unknown?.[phone]?.name || Business.display(phone) };
}

/** בלי תשובה תוך ‎ANSWER_DAYS‎ — אישי: ל"לא לסרוק", ולא שואלים שוב */
function expireQuestions(now = Date.now()) {
  for (const { user_id: userId } of D.all("SELECT user_id FROM user_prefs WHERE key = 'waScan'")) {
    for (const [phone, at] of Object.entries(prefs(userId).asked ?? {})) {
      if (now - new Date(at).getTime() > ANSWER_DAYS * 864e5) mark(userId, phone, 'personal');
    }
  }
}

/**
 * מספר לא מוכר: נספר, בלי לקרוא. כשמגיעים ל-‎ASK_AFTER‎ הודעות — שואלים פעם
 * אחת. מחזיר ‎true‎ כשהגיע הזמן לשאול.
 */
function countUnknown(userId, phone, name, n = 1) {
  const p = prefs(userId);
  const cur = p.unknown?.[phone] ?? { n: 0, name: '' };
  const entry = { n: cur.n + n, name: name || cur.name || '', at: D.nowIso() };
  const unknown = { ...p.unknown, [phone]: entry };
  // רשימה שלא גדלה בלי סוף — הישנים יוצאים (חוץ ממי שמחכים לתשובה עליו)
  const keys = Object.keys(unknown);
  if (keys.length > MAX_LIST) {
    keys.sort((a, b) => String(unknown[a].at).localeCompare(String(unknown[b].at)));
    for (const k of keys.slice(0, keys.length - MAX_LIST)) if (!p.asked?.[k]) delete unknown[k];
  }
  const askNow = entry.n >= Business.ASK_AFTER && !p.asked?.[phone];
  D.setUserPref(userId, 'waScan', { ...p, unknown, asked: askNow ? { ...p.asked, [phone]: D.nowIso() } : p.asked });
  return askNow;
}

/** "יוסי (050-…) שלח/ה לך כמה הודעות בוואטסאפ — עסקי או אישי?" */
const questionText = (name, phone) => `${name && name !== phone ? `${name} (${Business.display(phone)})` : Business.display(phone)} שלח/ה לך כמה הודעות בוואטסאפ — עסקי או אישי?`;

async function ask(userId, phone, name) {
  const text = questionText(name, phone);
  try {
    const full = `🔒 ${text}
השיבו *עסקי* — ואסרוק מההודעה הבאה (הקודמות לא נקראות), או *אישי* — ולא אקרא את השיחה. בלי תשובה — לא אסרוק.`;
    if (hooks.ask && await hooks.ask(userId, full)) return;
  } catch (err) {
    console.error('[משימון] שאלת "עסקי או אישי" בבוט נכשלה:', err.message);
  }
  D.notify({
    targetType: 'user', targetId: userId, kind: 'ai',
    title: `💬 ${text}`,
    body: 'אם עסקי — הוסיפו אותו ל"אנשי קשר עסקיים נוספים" בהגדרות הוואטסאפ. בלי תשובה — השיחה לא תיסרק.'
  });
}

/** מי שכבר הפעיל סריקה לפני הכלל — הודעה אחת על השינוי */
const NOTICE = [
  '🔒 *שינוי בסריקת הוואטסאפ האישי*',
  'מעכשיו נסרקות רק שיחות עם אנשי קשר עסקיים: עובדים בארגון, אנשי האלפון, ספקים, אנשי קשר בגוגל עם חברה או תפקיד, ומי שעבדת איתו במשימות ובפגישות.',
  'ממספר לא מוכר אשאל אותך פעם אחת אם הוא עסקי. רשימת "לא לסרוק" שלך נשמרה.',
  'אפשר לכתוב לי: "יוסי עסקי" או "אל תסרוק את דני".'
].join('\n');

async function sendNotices() {
  for (const { user_id: userId } of D.all("SELECT user_id FROM user_prefs WHERE key = 'waScan'")) {
    const p = prefs(userId);
    if (!p.enabled || p.businessNotice) continue;
    // מסומן לפני השליחה — תקלה לא תשלח את ההודעה פעמיים
    D.setUserPref(userId, 'waScan', { ...p, businessNotice: true });
    let sent = false;
    try {
      sent = Boolean(hooks.notice && await hooks.notice(userId, NOTICE));
    } catch (err) {
      console.error('[משימון] הודעת המעבר בוואטסאפ נכשלה:', err.message);
    }
    if (!sent) {
      D.notify({ targetType: 'user', targetId: userId, kind: 'ai', title: '🔒 הוואטסאפ האישי נסרק עכשיו רק עם אנשי קשר עסקיים', body: 'ממספר לא מוכר — נשאל אותך פעם אחת. הרשימות — בהגדרות הוואטסאפ.' });
    }
  }
}

/** מי סורק עכשיו — מחובר, ובחר בזה */
const scanningUsers = () => D.all("SELECT user_id FROM user_prefs WHERE key = 'waScan'")
  .map((r) => r.user_id)
  .filter((id) => prefs(id).enabled && WhatsApp.connectedUsers().includes(id));

const INSIGHT_KINDS = ['none', 'action', 'approval', 'document', 'money', 'deadline', 'meeting', 'info'];

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['tasks', 'insight'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'summary', 'meeting', 'due_date', 'priority', 'checklist'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          meeting: { type: 'boolean' },
          due_date: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
          checklist: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    insight: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'importance', 'insight', 'due_date'],
      description: 'מה כדאי לבעל הטלפון לדעת מהשיחה, בשורה אחת. kind = none כשאין',
      properties: {
        kind: { type: 'string', enum: INSIGHT_KINDS },
        importance: { type: 'integer', description: '1–3' },
        insight: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD או ריק' }
      }
    }
  }
};

/**
 * ‎items‎ — הודעות נכנסות שאינן תשובה למשימת AI: ‎{ from, name, text, id, at }‎.
 * הודעות רצופות מאותו אדם נבחנות יחד — "היי" / "אפשר להיפגש?" / "ביום ג׳?".
 */
async function handle(userId, items) {
  const p = prefs(userId);
  if (!p.enabled) return 0;
  const lists = { ignore: new Set(p.ignore), business: new Set(p.business), auto: Business.autoPhones(userId) };
  const bySender = new Map();
  const unknown = new Map();
  for (const m of items) {
    const kind = Business.classify(m.from, lists);
    if (kind === 'ignore') continue;
    if (kind === 'unknown') {
      // נספר בלבד — התוכן לא נקרא ולא נשלח לשום מקום
      const u = unknown.get(m.from) ?? { n: 0, name: '' };
      unknown.set(m.from, { n: u.n + 1, name: m.name || u.name });
      continue;
    }
    if (!m.text) continue;
    if (!bySender.has(m.from)) bySender.set(m.from, []);
    bySender.get(m.from).push(m);
  }
  for (const [phone, u] of unknown) {
    if (countUnknown(userId, phone, u.name, u.n)) await ask(userId, phone, u.name);
  }
  if (!Claude.isEnabled()) return 0;
  const owner = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  let created = 0;
  for (const [from, msgs] of bySender) {
    const name = msgs.find((m) => m.name)?.name || from;
    const colleague = D.get("SELECT full_name FROM users WHERE phone = ? AND status = 'active'", from);
    const today = W.todayIL();
    const text = [
      `תאריך היום: ${today} (${W.hebrewDate(today)})`,
      `בעל הטלפון: ${owner?.full_name ?? ''}`,
      `השולח: ${name}${colleague ? ` (עובד בארגון: ${colleague.full_name})` : ''}`,
      '',
      'ההודעות (מהישנה לחדשה):',
      '<<<',
      ...msgs.map((m) => `${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}: ${String(m.text).slice(0, 2000)}`),
      '>>>'
    ].join('\n');
    // הודעה שעונה על משימה שפתחתי, או מעדכנת אותה — "לסגור?" / "לעדכן?" (‎task-sync.js‎)
    await TaskSync.checkQuietly(userId, {
      source: 'personal',
      fromName: name,
      fromPhone: from,
      chatPhone: from,
      messages: msgs.map((m) => ({ text: m.text, at: new Date(m.at).toISOString(), ref: `wap:${userId}:${m.id}` }))
    });
    let out;
    try {
      out = await Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text }], schema: SCHEMA, effort: 'low' });
    } catch (err) {
      console.error('[משימון] ניתוח הודעת וואטסאפ נכשל:', err.message);
      continue;
    }
    const last = msgs[msgs.length - 1];
    // תובנה — רק מה שה-AI כתב, בלי ההודעה. שיחה בלי משהו לדעת — אין
    if (out.insight && out.insight.kind !== 'none') {
      Insights.storePersonal(userId, { phone: from, name, messageId: last.id, at: new Date(last.at).toISOString() }, out.insight);
    }
    for (const t of (out.tasks ?? []).slice(0, 3)) {
      const title = String(t.title ?? '').trim().slice(0, 120);
      if (!title) continue;
      const headerId = `wap:${userId}:${last.id}`;
      if (D.get('SELECT 1 FROM ai_suggestions WHERE header_id = ? AND user_id = ? AND subject = ?', headerId, userId, title)) continue;
      const data = {
        source: 'whatsapp',
        personal: true,
        title,
        summary: String(t.summary ?? '').trim().slice(0, 1500),
        meeting: t.meeting === true,
        checklist: (t.checklist ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
        dueDate: W.isDate(t.due_date) ? t.due_date : '',
        priority: ['normal', 'high', 'urgent'].includes(t.priority) ? t.priority : 'normal',
        people: [],
        ambiguous: [],
        aiRequest: null,
        warning: '',
        // חלון "מקבוצות הוואטסאפ" מציג את שם הקבוצה — כאן: שם השולח
        groupName: `שיחה פרטית עם ${name}`,
        chatPhone: from,
        receivedAt: new Date(last.at).toISOString()
      };
      D.run(
        `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
         VALUES (?, 'task', 'pending', '', ?, ?, '', ?, ?, ?, ?)`,
        userId, headerId, name, title, data.receivedAt, JSON.stringify(data), D.nowIso()
      );
      created++;
    }
  }
  if (created) {
    D.notify({
      targetType: 'user', targetId: userId, kind: 'ai',
      title: `💬 מהוואטסאפ שלך: ${created === 1 ? 'הצעה ממתינה' : `${created} הצעות ממתינות`} לאישורך`,
      body: 'אישור, עריכה או דחייה — ב"ממתין לאישורך".'
    });
  }
  return created;
}

/** כמה הצעות מהשולח הזה כבר נדחו — מהשנייה מציעים "לא לסרוק אותו" */
const rejectionsFrom = (userId, phone) => D.get(
  `SELECT COUNT(*) AS n FROM ai_suggestions WHERE user_id = ? AND status = 'rejected'
     AND json_extract(data, '$.personal') = 1 AND json_extract(data, '$.chatPhone') = ?`, userId, phone
).n;

/**
 * עניתי בשיחה הפרטית — הצעות ממתינות מאותה שיחה יורדות מ"ממתין לאישורך"
 * (‎replied‎). הודעה חדשה שתגיע ממנו אחר כך נבחנת מחדש כרגיל, ותחזור כהצעה
 * רק אם יש בה משימה.
 */
function markAnswered(userId, outgoing) {
  for (const m of outgoing) {
    const at = m.at instanceof Date ? m.at.toISOString() : String(m.at ?? D.nowIso());
    D.run(
      `UPDATE ai_suggestions SET status = 'replied', decided_at = ?
        WHERE user_id = ? AND status = 'pending' AND json_extract(data, '$.personal') = 1
          AND json_extract(data, '$.chatPhone') = ? AND COALESCE(received_at, created_at) < ?`,
      D.nowIso(), userId, m.from, at
    );
  }
}

module.exports = {
  markAnswered,
  handle, prefs, setPrefs, publicPrefs, scanningUsers, setHooks, mark, lastAsked, expireQuestions, sendNotices,
  rejectionsFrom, questionText, NOTICE, ANSWER_DAYS,
  _internal: { countUnknown, ask }
};
