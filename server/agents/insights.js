'use strict';
/**
 * תובנות — מהמייל ומהוואטסאפ, ביחד. מקור אחד ל"תובנות" בבוט ובעוזר באפליקציה,
 * לחלק התובנות ב-Today (במסך, בבוט ובמייל הבוקר).
 *
 *   📧 מייל — ‎mail-insights.js‎: נקרא מ-Gmail ומנותח כשמבקשים (עם מטמון לשבוע).
 *   👥 קבוצות — נוצרות בניתוח הקבוצה בבוט (‎wa-bot.js‎), פעם אחת לקבוצה. עובד
 *      רואה רק קבוצות שהטלפון שלו ברשימת המשתתפים שלהן; קבוצה שהרשימה שלה לא
 *      ידועה — לא מוצגת לאיש.
 *   💬 פרטי — נוצרות כשהודעה מגיעה לוואטסאפ האישי (‎whatsapp-scan.js‎), רק
 *      מאנשי קשר עסקיים. נשמרת רק התובנה, בלי גוף ההודעה.
 *
 * המילה "וואטסאפ" מופיעה בכותרות רק כשזה רלוונטי לעובד (‎sourcesOf‎): הוא חבר
 * בקבוצה פעילה של הבוט, או שחיבר את הוואטסאפ האישי והפעיל סריקה.
 *
 * הכותרות, הסימונים והטקסט לבוט — פונקציות טהורות (‎headings‎, ‎format‎,
 * ‎todaySection‎), שאפשר לבדוק בלי שרת.
 */
const D = require('../core').Db;
const Gmail = require('../integrations').Gmail;
const WhatsApp = require('../integrations').Whatsapp;
const MailInsights = require('../mail').MailInsights;
const Range = require('../mail').InsightWindow;

const KEEP_DAYS = 7;
const KINDS = ['action', 'approval', 'document', 'money', 'deadline', 'meeting', 'info'];
const GROUPS = MailInsights.GROUPS;
const ICON = { mail: '📧', group: '👥', personal: '💬' };
const TODAY_ACTIONS = 5;

const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

// ---------------------------------------------------------------------------
// למי זה רלוונטי
// ---------------------------------------------------------------------------

/** קבוצות פעילות של הבוט שהטלפון של העובד ברשימת המשתתפים שלהן */
function groupsOf(userId) {
  const phone = D.get('SELECT phone FROM users WHERE id = ?', userId)?.phone;
  if (!phone) return [];
  return D.all("SELECT chat_id, name, participants FROM wa_groups WHERE status = 'active' AND participants_at IS NOT NULL")
    .filter((g) => (parseJson(g.participants, []) ?? []).includes(phone))
    .map((g) => ({ chatId: g.chat_id, name: g.name }));
}

/** חיבר את הוואטסאפ האישי והפעיל "להציע משימות מהוואטסאפ שלי" */
function personalScanning(userId) {
  const p = D.userPrefs(userId).waScan;
  return Boolean(p && typeof p === 'object' && p.enabled) && WhatsApp.connectedUsers().includes(userId);
}

/** מאילו מקורות יש לעובד הצעות ותובנות */
function sourcesOf(userId) {
  return { mail: Gmail.isConnected(userId), whatsapp: groupsOf(userId).length > 0 || personalScanning(userId) };
}

/**
 * הכותרות לפי המקורות (פרק 6 באפיון): מייל בלבד, וואטסאפ בלבד, או שניהם.
 * בלי אף אחד — ‎null‎, והחלקים האלה אינם מוצגים.
 */
function headings({ mail, whatsapp }) {
  if (mail && whatsapp) {
    return { suggestions: '📧💬 הצעות למשימות מהמייל ומהוואטסאפ', insights: '📬💬 תובנות מהמייל ומהוואטסאפ', what: 'במייל ובוואטסאפ' };
  }
  if (whatsapp) return { suggestions: '💬 הצעות למשימות מהוואטסאפ', insights: '💬 תובנות מהוואטסאפ', what: 'בוואטסאפ' };
  if (mail) return { suggestions: '📧 הצעות למשימות מהמייל', insights: '📬 תובנות מהמייל', what: 'במייל' };
  return null;
}

/** מאיפה הגיעה הצעה — לסימון ליד השורה: 📧 השולח · 👥 הקבוצה · 💬 השולח */
function suggestionSource(s) {
  const d = s.data ?? {};
  // משימות כפולות במחלקה — לא מהמייל ולא מהוואטסאפ
  if (d.merge) return { source: 'merge', icon: '🗂', label: d.projectName ? `כפילות · ${d.projectName}` : 'כפילות במחלקה' };
  if (d.source === 'whatsapp' && d.personal) return { source: 'personal', icon: ICON.personal, label: s.from?.name || d.chatPhone || '' };
  if (d.source === 'whatsapp') return { source: 'group', icon: ICON.group, label: d.groupName || '' };
  return { source: 'mail', icon: ICON.mail, label: s.from?.name || s.from?.email || '' };
}

// ---------------------------------------------------------------------------
// שמירה — בלי גוף ההודעה
// ---------------------------------------------------------------------------

/** תובנה אחת כפי שהגיעה מה-AI — נבדקת ומקוצרת לפני שנשמרת */
function clean(x) {
  const insight = MailInsights.mask(String(x?.insight ?? '').trim().slice(0, 300));
  if (!insight) return null;
  return {
    kind: KINDS.includes(x.kind) ? x.kind : 'info',
    importance: Math.min(3, Math.max(1, Number(x.importance) || 1)),
    who: String(x.who ?? '').trim().slice(0, 80),
    insight,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due_date ?? x.dueDate ?? '')) ? String(x.due_date ?? x.dueDate) : ''
  };
}

function insert(scope, ownerId, chatId, messageId, senderName, at, x) {
  const c = clean(x);
  if (!c) return false;
  return D.run(
    `INSERT OR IGNORE INTO wa_insights (scope, owner_id, chat_id, message_id, sender_name, kind, importance, insight, due_date, at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    scope, ownerId, chatId, String(messageId), String(c.who || senderName || '').slice(0, 120),
    c.kind, c.importance, c.insight, c.dueDate, at, D.nowIso()
  ).changes > 0;
}

/** תובנה מקבוצה — אחת לקבוצה, לא לכל עובד */
const storeGroup = (chatId, message, x) => insert('group', 0, chatId, message.message_id, message.sender_name, message.at, x);

/** תובנה מהוואטסאפ האישי של עובד — רק מה שה-AI כתב, לא ההודעה */
const storePersonal = (userId, { phone, name, messageId, at }, x) => insert('personal', userId, phone, messageId, name, at, x);

function prune() {
  D.run('DELETE FROM wa_insights WHERE at < ?', new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  // קבוצה שסומנה "להתעלם" — לא נכנסת, גם ממה שכבר נשמר
  D.run("DELETE FROM wa_insights WHERE scope = 'group' AND chat_id IN (SELECT chat_id FROM wa_groups WHERE status = 'ignored')");
}

// ---------------------------------------------------------------------------
// קריאה
// ---------------------------------------------------------------------------

function shapeWa(r, groupName = '') {
  const group = r.scope === 'group';
  return {
    ref: `wa:${r.id}`,
    source: group ? 'group' : 'personal',
    label: group ? groupName || 'קבוצה' : r.sender_name || r.chat_id,
    who: r.sender_name,
    kind: r.kind,
    importance: r.importance,
    insight: r.insight,
    dueDate: r.due_date,
    at: r.at,
    unread: false,
    messageId: r.message_id,
    chatId: r.chat_id,
    // "פתיחה במקור": שיחה פרטית — ישר לשיחה; קבוצה — וואטסאפ ווב
    link: group ? 'https://web.whatsapp.com/' : `https://wa.me/${r.chat_id}`
  };
}

function shapeMail(x, conn) {
  // מתיבה נוספת — הקישור לאותה תיבה
  if (x.box && conn) conn = Gmail.connectionOf(Gmail.handle(conn.user_id, x.box)) ?? conn;
  return {
    ref: x.gmailId,
    source: 'mail',
    label: MailInsights.label(x),
    who: x.fromName,
    kind: x.kind,
    importance: x.importance,
    insight: x.insight,
    dueDate: x.dueDate,
    at: x.receivedAt,
    unread: Boolean(x.unread),
    gmailId: x.gmailId,
    subject: x.subject,
    fromEmail: x.fromEmail,
    link: conn?.email ? Gmail.webLink(conn.email, x.gmailId) : null,
    mailbox: x.box && conn?.email ? conn.email : null
  };
}

/** התובנות מהוואטסאפ שהעובד רשאי לראות, מ-‎since‎ */
function waItems(userId, since, { from = '' } = {}) {
  const groups = groupsOf(userId);
  const names = new Map(groups.map((g) => [g.chatId, g.name]));
  const rows = [
    ...D.all("SELECT * FROM wa_insights WHERE scope = 'personal' AND owner_id = ? AND at >= ? ORDER BY at DESC LIMIT 200", userId, since),
    ...(groups.length
      ? D.all(`SELECT * FROM wa_insights WHERE scope = 'group' AND at >= ? AND chat_id IN (${groups.map(() => '?').join(',')}) ORDER BY at DESC LIMIT 200`,
        since, ...groups.map((g) => g.chatId))
      : [])
  ];
  const q = String(from ?? '').trim();
  return rows.map((r) => shapeWa(r, names.get(r.chat_id)))
    .filter((x) => !q || `${x.label} ${x.who}`.includes(q));
}

const byImportance = (a, b) => b.importance - a.importance || String(b.at).localeCompare(String(a.at));

/**
 * התובנות של הטווח, מכל המקורות. ‎exclude‎ — מה שכבר מוצג כהצעה למשימה
 * (מזהה מייל, או ‎wamsg:<id>‎ של הודעת וואטסאפ): מוצג פעם אחת, כהצעה.
 *
 * @returns {Promise<{items, window, from, sources, mail: object|null, mailError: string}>}
 */
async function collect(userId, { window = null, from = '', mail = true, exclude = new Set() } = {}) {
  const win = window ?? Range.forUser(userId);
  const sources = sourcesOf(userId);
  let mailRes = null;
  let mailError = '';
  if (mail && MailInsights.available(userId)) {
    try {
      mailRes = await MailInsights.collect(userId, { window: win, from });
    } catch (err) {
      mailError = err.message;
      console.error('[משימון] תובנות המייל נכשלו:', err.message);
    }
  }
  const conn = mailRes ? Gmail.connectionOf(userId) : null;
  const items = [
    ...(mailRes?.items ?? []).map((x) => shapeMail(x, conn)),
    ...waItems(userId, win.sinceIso, { from })
  ].filter((x) => !exclude.has(x.gmailId) && !exclude.has(`wamsg:${x.messageId}`));
  items.sort(byImportance);
  return {
    items,
    window: win,
    from,
    sources: { ...sources, whatsapp: sources.whatsapp || items.some((x) => x.source !== 'mail') },
    mail: mailRes ? { newsletters: mailRes.newsletters, unread: mailRes.unread, total: mailRes.total, analyzed: mailRes.analyzed } : null,
    mailError
  };
}

/** פריט לפי המספר ברשימה האחרונה — מייל או וואטסאפ, ורק מה שהעובד רשאי לראות */
function itemOf(userId, ref) {
  const m = /^wa:(\d+)$/.exec(String(ref ?? ''));
  if (!m) {
    const x = MailInsights.itemOf(userId, ref);
    return x && !x.skip ? shapeMail(x, Gmail.connectionOf(userId)) : null;
  }
  const r = D.get('SELECT * FROM wa_insights WHERE id = ?', Number(m[1]));
  if (!r) return null;
  if (r.scope === 'personal') return r.owner_id === userId ? shapeWa(r) : null;
  const group = groupsOf(userId).find((g) => g.chatId === r.chat_id);
  return group ? shapeWa(r, group.name) : null;
}

// ---------------------------------------------------------------------------
// תצוגה — טהורה
// ---------------------------------------------------------------------------

const dueText = (x) => (x.dueDate ? ` · 📅 ${Number(x.dueDate.slice(8))}.${Number(x.dueDate.slice(5, 7))}` : '');
/** הסימון ליד שורה — רק כשיש יותר ממקור אחד, אחרת הוא רעש */
const marker = (x, mixed) => (mixed ? `${ICON[x.source]} ` : '');
const line = (x, n, mixed) => `${n}. ${marker(x, mixed)}${x.unread ? '🔵 ' : ''}${x.label}: ${x.insight}${dueText(x)}`;

/** "(2 ימי עבודה · 14 מיילים, 3 לא נקראו · 4 מהוואטסאפ)" */
function countsText(result) {
  const mailCount = result.items.filter((x) => x.source === 'mail').length;
  const waCount = result.items.length - mailCount;
  const parts = [result.window.span];
  if (result.mail) parts.push(`${mailCount} מיילים${result.mail.unread ? `, ${result.mail.unread} לא נקראו` : ''}`);
  if (result.sources.whatsapp) parts.push(`${waCount} מהוואטסאפ`);
  return parts.join(' · ');
}

/** הכותרת: מה נבדק, ובאיזה טווח בדיוק */
function headline(result) {
  const h = headings(result.sources) ?? headings({ mail: true });
  const scope = result.from ? ` מ${result.from}` : '';
  const when = result.window.unit === 'workdays' ? ` — ${result.window.label}` : '';
  return `${h.insights.split(' ')[0]} *מה חדש ${h.what}${scope}${when} (${countsText(result)}):*`;
}

/** הערות על הטווח: עיגול, תקרה, ומה שלא נכנס */
function notes(result) {
  const out = [];
  if (result.window.note) out.push(`ℹ️ ${result.window.note}`);
  if (result.mail && result.mail.total > result.mail.analyzed) {
    out.push(`ℹ️ מוצגים ${result.mail.analyzed} המיילים האחרונים מתוך ${result.mail.total}${result.mail.total >= 200 ? '+' : ''}. לתמונה מלאה — טווח קצר יותר או שולח מסוים.`);
  }
  if (result.mailError) out.push('⚠️ המייל אינו זמין כרגע — מוצג רק מה שמהוואטסאפ.');
  return out;
}

/**
 * הרשימה המלאה ("תובנות"). ‎ids‎ — לפי המספור, כדי ש"פרט על 3" יידע מה זה 3.
 * @returns {{text: string, ids: string[]}}
 */
function format(result) {
  const { items } = result;
  const mixed = result.sources.mail && result.sources.whatsapp;
  const head = headline(result);
  const extra = notes(result);
  const newsletters = result.mail?.newsletters ?? 0;
  if (!items.length) {
    const none = newsletters ? `אין עניינים חדשים — רק ${newsletters} מיילי דיוור.` : 'אין חדש 🎉';
    return { text: [head, ...extra, '', none].join('\n'), ids: [] };
  }
  const lines = [head, ...extra];
  const ids = [];
  for (const g of GROUPS) {
    const group = items.filter((x) => g.kinds.includes(x.kind));
    if (!group.length) continue;
    const shown = group.slice(0, g.max ?? 15);
    lines.push('', `*${g.title} (${group.length}):*`);
    for (const x of shown) {
      ids.push(x.ref);
      lines.push(line(x, ids.length, mixed));
    }
    if (group.length > shown.length) lines.push(`ועוד ${group.length - shown.length}.`);
  }
  if (newsletters) lines.push('', `דילגתי על ${newsletters} מיילי דיוור.`);
  lines.push('', result.mail
    ? 'אפשר לכתוב: "פרט על 1", "תענה ל-2 ש…", "תפתח משימה מ-1", "תעקוב אחרי 2".'
    : 'אפשר לכתוב: "תפתח משימה מ-1".');
  lines.push('טווח אחר: "תובנות מ-48 שעות", "מהיומיים האחרונים".');
  return { text: lines.join('\n'), ids };
}

/**
 * החלק של התובנות ב-Today בבוט: רק "דורש ממך משהו" (עד 5), ושאר הקבוצות
 * כמספרים.
 * @returns {{text: string, ids: string[]}|null}  ‎null‎ — אין מקור רלוונטי
 */
function todaySection(result, { max = TODAY_ACTIONS } = {}) {
  const h = headings(result.sources);
  if (!h) return null;
  const mixed = result.sources.mail && result.sources.whatsapp;
  const head = `*${h.insights}* (${result.window.span}):`;
  const count = (kinds) => result.items.filter((x) => kinds.includes(x.kind)).length;
  const action = result.items.filter((x) => GROUPS[0].kinds.includes(x.kind));
  const updates = count(GROUPS[1].kinds);
  const info = count(GROUPS[2].kinds);
  if (!result.items.length) return { text: `${head} אין חדש.`, ids: [] };
  const lines = [head];
  const shown = action.slice(0, max);
  if (shown.length) {
    lines.push(`דורש ממך משהו (${action.length}):`, ...shown.map((x, i) => line(x, i + 1, mixed)));
    if (action.length > shown.length) lines.push(`ועוד ${action.length - shown.length}.`);
  }
  const rest = [updates ? `אישורים ועדכונים: ${updates}` : null, info ? `לידיעה: ${info}` : null].filter(Boolean);
  if (rest.length) lines.push(`${rest.join(' · ')} — לרשימה המלאה: "תובנות"`);
  return { text: lines.join('\n'), ids: shown.map((x) => x.ref) };
}

/** לתצוגה במסך ובמייל: קבוצות "דורש ממך" / "אישורים ועדכונים" / "לידיעה" */
function grouped(items) {
  return GROUPS.map((g) => ({ title: g.title, collapsed: g.kinds.includes('info'), items: items.filter((x) => g.kinds.includes(x.kind)) }))
    .filter((g) => g.items.length);
}

module.exports = {
  ICON, KEEP_DAYS,
  groupsOf, personalScanning, sourcesOf, headings, suggestionSource,
  storeGroup, storePersonal, prune, clean,
  waItems, collect, itemOf, format, todaySection, grouped, headline
};
