'use strict';
/**
 * 💸 שולם — שלב 2 של רשימת התשלומים (‎payments.js‎). האפיון: "אפיון — מעקב אישורים ותשלומים.md" סעיף 5.
 *
 * **איך מזהים ששולם (הוחלט ונבדק 24.11.26):** המסמך (קבלת סחורה / חשבון חלקי) עבר לחשבונית ספק (GI); חשבון עסקה הוא
 * עצמו החשבונית. החשבונית נסגרת בתשלום לספק — העברה בנקאית (BT) או המחאה:
 *   1. ‎reconciled‎ — שורת הספק של החשבונית הותאמה בכרטיס הספק לשורת התשלום (אותו ‎FRECONNUM‎);
 *   2. ‎amount‎ — אין עוד התאמה: תשלום לאותו ספק באותו סכום (עד שקל וחצי, עיגול), מחודש לפני החשבונית ואילך,
 *      שלא נתפס כבר בחשבונית אחרת. זיהוי לא סופי — מסומן כך במסך;
 *   3. ‎status‎ — חשבון חלקי שהסטטוס שלו בפריוריטי "שולם".
 * מסמך עם כמה חשבוניות — שולם כשכולן שולמו; התאריך — התשלום האחרון.
 *
 * **מי מקבל מייל כששולם:** מי שיזם, מנהל המחלקה שלו, ומי שבהגדרה "מי עוד מקבל ששולם — לפי מחלקה" (‎paidNotify‎ במסך
 * ההגדרות של משימון פריוריטי; למשל המזכירה — על כל מה שמגיע למנהלת התכנון). רק על תשלום מהשבוע האחרון — כשמזהים
 * לראשונה תשלומים ישנים, לא שולחים עליהם.
 * **לא שולם ב-15:** מייל רק למי שיזם, ביום שאחרי, פעם אחת. לא על חשבון חלקי שהוסב (‎MEDR_ENDORSED‎) — מיותר, ולא כשהספק
 * קיבל סביב ה-15 תשלומים שמכסים את הסכום (‎probablyPaid‎ — ניכוי במקור, המחאה אחת לכמה חשבוניות).
 *
 * קריאה בלבד מפריוריטי.
 */
const D = require('../core').Db;
const { escape, shell } = require('../core').MailTemplates;
const Priority = require('../integrations').Priority;
const Mailer = require('../integrations').Mailer;
const Settings = require('./priority-settings');
const Approvals = require('./priority-approvals');

const ORG = 1;
const CHECK_MAX = 40;          // מסמכים שנבדקים בכל רענון (הוותיקים בבדיקה קודם)
const TOLERANCE = 1.5;         // ש"ח — הפרש עיגול בין החשבונית לתשלום
const BEFORE_DAYS = 30;        // תשלום שקדם לחשבונית בעד חודש (קורה: BT26000233 קדם ל-GI26000328 ביומיים)
const NOTIFY_DAYS = 7;         // מייל "שולם" — רק על תשלום מהשבוע האחרון
const LATE_DAYS = 20;          // "לא שולם ב-15" — רק על המועד האחרון, לא על חובות ישנים
const KEEP_DAYS = 180;         // מסמך שעבר לחשבונית לפני יותר מזה — כבר לא בודקים

const day = (iso) => String(iso ?? '').slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dmy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const shekel = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TYPE_LABEL = { receipt: 'קבלת סחורה', partial: 'חשבון חלקי', deal: 'חשבון עסקה' };
const PAY_KIND = { 'העב': 'העברה בנקאית', 'תשצ': 'המחאה' };

// ---------------------------------------------------------------------------
// ההתאמה — טהורה
// ---------------------------------------------------------------------------

/**
 * התשלום שסוגר חשבונית אחת. ‎inv‎: ‎{ IVNUM, IVDATE, TOTPRICE, recon }‎ · ‎payments‎: מ-‎supplierPayments‎ · ‎used‎: ‎Set‎ של תשלומים
 * שכבר נתפסו. ‎{ payment, how }‎ או ‎null‎.
 */
function matchPayment(inv, payments, used = new Set()) {
  if (inv.recon) {
    const p = payments.find((x) => x.recon === inv.recon);
    if (p) return { payment: p, how: 'reconciled' };
  }
  const from = addDays(day(inv.IVDATE), -BEFORE_DAYS);
  const p = payments
    .filter((x) => !x.recon && !used.has(x.ref) && x.date >= from && Math.abs(x.sum - Number(inv.TOTPRICE)) <= TOLERANCE)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  return p ? { payment: p, how: 'amount' } : null;
}

/** כל החשבוניות שולמו ← ‎{ paidAt, ref, how }‎ (התאריך — התשלום האחרון; ‎amount‎ אם אחת מהן לפי סכום). אחרת ‎null‎ */
function combine(matches) {
  if (!matches.length || matches.some((m) => !m)) return null;
  return {
    paidAt: matches.map((m) => m.payment.date).sort().pop(),
    ref: [...new Set(matches.map((m) => m.payment.ref))].join(', '),
    how: matches.some((m) => m.how === 'amount') ? 'amount' : 'reconciled',
    kind: matches[0].payment.kind
  };
}

// ---------------------------------------------------------------------------
// הבדיקה מול פריוריטי
// ---------------------------------------------------------------------------

/** החשבוניות של המסמך, כל אחת עם מספר ההתאמה שלה */
async function invoicesOf(row, it) {
  let list;
  if (row.type === 'deal') {
    const iv = await Priority.dealInvoice(row.company, row.docno);
    list = iv && iv.STATDES === 'סופית' ? [iv] : [];
  } else {
    list = await Priority.invoicesForDoc(row.company, it.supplier.code, row.docno, it.date || day(row.first_seen));
  }
  for (const iv of list) iv.recon = await Priority.invoiceRecon(row.company, iv.FNCNUM, it.supplier.code);
  return list;
}

/** התשלומים שכבר נתפסו בחברה (לא לייחס תשלום אחד לשתי חשבוניות) */
function usedRefs(company) {
  const s = new Set();
  for (const r of D.all("SELECT payment_ref FROM payment_items WHERE org_id = ? AND company = ? AND stage = 'paid' AND payment_ref <> ''", ORG, company)) {
    for (const x of r.payment_ref.split(',')) s.add(x.trim());
  }
  return s;
}

/**
 * בדיקה: מסמכים שעברו לחשבונית ועוד לא שולמו — הוותיקים בבדיקה קודם. מסמך ששולם ← ‎stage = paid‎ ומייל (‎onPaid‎).
 * ‎{ checked, paid }‎
 */
async function checkPaid(now = D.nowIso(), { max = CHECK_MAX, notify = onPaid } = {}) {
  const since = addDays(day(now), -KEEP_DAYS);
  const rows = D.all(`SELECT ref, company, type, docno, data, first_seen FROM payment_items
    WHERE org_id = ? AND stage = 'invoiced' AND stage_at >= ? ORDER BY paid_checked_at, stage_at LIMIT ?`, ORG, since, max);
  const paysCache = new Map();
  const used = new Map();
  let paid = 0;
  for (const row of rows) {
    D.run('UPDATE payment_items SET paid_checked_at = ? WHERE ref = ?', now, row.ref);
    let it;
    try { it = JSON.parse(row.data); } catch { continue; }
    if (!it?.supplier?.code) continue;
    try {
      const invs = await invoicesOf(row, it);
      if (!invs.length) continue;
      const k = `${row.company}:${it.supplier.code}`;
      const from = addDays(invs.map((i) => day(i.IVDATE)).sort()[0], -BEFORE_DAYS);
      if (!paysCache.has(k)) paysCache.set(k, await Priority.supplierPayments(row.company, it.supplier.code, from));
      if (!used.has(row.company)) used.set(row.company, usedRefs(row.company));
      const u = used.get(row.company);
      const matches = invs.map((iv) => {
        const m = matchPayment(iv, paysCache.get(k), u);
        if (m) u.add(m.payment.ref);
        return m;
      });
      const r = combine(matches);
      if (!r) { for (const m of matches) if (m) u.delete(m.payment.ref); continue; }
      markPaid(row.ref, r, now);
      paid += 1;
      await notify(row.ref, now);
    } catch (err) {
      console.error(`[משימון] תשלומים — בדיקת "שולם" ל-${row.ref}:`, err.message);
    }
  }
  return { checked: rows.length, paid };
}

function markPaid(ref, { paidAt, ref: payRef = '', how, kind = '' }, now = D.nowIso()) {
  D.run(`UPDATE payment_items SET stage = 'paid', stage_at = ?, paid_at = ?, payment_ref = ?, paid_how = ? WHERE ref = ?`,
    now, paidAt || day(now), payRef, how + (kind ? `:${kind}` : ''), ref);
}

// ---------------------------------------------------------------------------
// למי — ומה כתוב
// ---------------------------------------------------------------------------

const userById = (id) => D.get("SELECT id, full_name, email, department_id FROM users WHERE id = ? AND status = 'active'", id) ?? null;

/** היוזם כמשתמש משימון: מי שפתח בבוט, או לפי שם המשתמש בפריוריטי */
async function initiatorUser(it) {
  const bot = D.get("SELECT user_id FROM priority_docs WHERE org_id = ? AND company = ? AND docno = ? AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1", ORG, it.company, it.docno);
  if (bot?.user_id) { const u = userById(bot.user_id); if (u) return u; }
  for (const login of [it.initiator, ...(it.people ?? [])].filter(Boolean)) {
    const m = await Approvals.mesimonUserFor(login).catch(() => ({ user: null }));
    if (m.user) return userById(m.user.id);
  }
  return null;
}

/** מי מקבל "שולם": היוזם, מנהל המחלקה שלו, ומי שבהגדרה לאותה מחלקה. ‎[{ user, why }]‎ */
function paidRecipients(initiator) {
  if (!initiator) return [];
  const out = new Map([[initiator.id, { user: initiator, why: 'יזמת' }]]);
  const dept = initiator.department_id ? D.get('SELECT id, name, manager_user_id FROM departments WHERE id = ?', initiator.department_id) : null;
  if (dept?.manager_user_id && !out.has(dept.manager_user_id)) {
    const m = userById(dept.manager_user_id);
    if (m) out.set(m.id, { user: m, why: `מנהל/ת ${dept.name}` });
  }
  const extra = (Settings.defaults().paidNotify ?? {})[String(initiator.department_id ?? '')] ?? [];
  for (const id of extra) {
    if (out.has(Number(id))) continue;
    const u = userById(Number(id));
    if (u) out.set(u.id, { user: u, why: dept ? `מקבל/ת את התשלומים של ${dept.name}` : 'בהגדרה' });
  }
  return [...out.values()];
}

const htmlOf = (title, lines) => shell({ title, bodyHtml: lines.map((l) => (l ? `<p style="margin:0 0 6px">${escape(l)}</p>` : '<br>')).join('') });
const companyName = (c) => Settings.companies().find((x) => x.code === c)?.name ?? c;
const docLine = (it) => `${TYPE_LABEL[it.type] ?? it.type} ${it.docno} · ${it.supplier.name || it.supplier.code} · ${it.currency === 'ש"ח' || !it.currency ? `₪${shekel(it.amount)}` : `${shekel(it.amount)} ${it.currency}`}`;

function paidMail(it, row, who) {
  const [how, kind] = String(row.paid_how ?? '').split(':');
  const via = [PAY_KIND[kind] ?? (how === 'status' ? '' : 'תשלום'), row.payment_ref].filter(Boolean).join(' ');
  const subject = `✅ שולם: ${it.supplier.name || it.supplier.code} — ${TYPE_LABEL[it.type] ?? ''} ${it.docno}`;
  const lines = [
    `${docLine(it)}`,
    `🏢 ${companyName(it.company)}${it.project?.name ? ` · 📁 ${it.project.name}` : ''}`,
    `שולם ב-${dmy(row.paid_at)}${via ? ` (${via})` : ''}${it.payDay && row.paid_at < it.payDay ? ' — לפני המועד (ה-15 היה ' + dmy(it.payDay) + ')' : ''}.`,
    how === 'amount' ? 'זוהה לפי הסכום — ההתאמה בכרטיס הספק עוד לא נעשתה בהנהלת החשבונות.' : null,
    '',
    `קיבלת את ההודעה כי ${who}.`
  ].filter((x) => x !== null);
  return { subject, text: lines.join('\n'), html: htmlOf(subject, lines) };
}

function lateMail(it) {
  const subject = `⏳ עוד לא שולם: ${it.supplier.name || it.supplier.code} — ${TYPE_LABEL[it.type] ?? ''} ${it.docno}`;
  const lines = [
    docLine(it),
    `🏢 ${companyName(it.company)}${it.project?.name ? ` · 📁 ${it.project.name}` : ''}`,
    `המועד היה ה-15 (${dmy(it.payDay)}), ועדיין לא רואים בפריוריטי תשלום לספק.`,
    'אם הספק פונה — כדאי לבדוק מול הנהלת החשבונות לפני שעונים.',
    '',
    'קיבלת את ההודעה כי את/ה יזמת את המסמך.'
  ];
  return { subject, text: lines.join('\n'), html: htmlOf(subject, lines) };
}

async function deliver(user, m) {
  D.notify({ targetType: 'user', targetId: user.id, kind: 'ai', title: m.subject, body: m.text.slice(0, 1500) });
  if (!Mailer.isEnabled() || !user.email) return;
  try { await Mailer.send({ to: user.email, toName: user.full_name, subject: m.subject, html: m.html, text: m.text }); }
  catch (err) { console.error(`[משימון] תשלומים — מייל ל${user.full_name}:`, err.message); }
}

/** מסמך ששולם — מייל לנמענים (פעם אחת; רק על תשלום מהשבוע האחרון). ‎[{ user, why }]‎ — מי קיבל */
async function onPaid(ref, now = D.nowIso()) {
  const row = D.get("SELECT * FROM payment_items WHERE ref = ? AND stage = 'paid'", ref);
  if (!row || row.paid_notified_at) return [];
  D.run('UPDATE payment_items SET paid_notified_at = ? WHERE ref = ?', now, ref);
  if (!row.paid_at || row.paid_at < addDays(day(now), -NOTIFY_DAYS)) return [];
  let it;
  try { it = JSON.parse(row.data); } catch { return []; }
  const to = paidRecipients(await initiatorUser(it));
  for (const r of to) await deliver(r.user, paidMail(it, row, r.why));
  return to;
}

/**
 * זהירות לפני "לא שולם": יש ספקים שמקבלים תשלום שלא מתאים אחד-לאחד לחשבונית — ניכוי במקור, או המחאה אחת לכמה חשבוניות
 * (נבדק 24.11.26: קידוחי מאג'ד, המחאות ב-15 בסכומים אחרים). אם הספק קיבל סביב ה-15 תשלומים שמכסים לפחות ‎COVER‎ מהסכום —
 * כנראה שולם, ולא מבהילים את היוזם. ‎null‎ — פריוריטי לא זמין (לא שולחים עכשיו; הסבב הבא ינסה שוב).
 */
const COVER = 0.9;
async function probablyPaid(it, payDay) {
  if (!it?.supplier?.code) return false;
  try {
    const pays = await Priority.supplierPayments(it.company, it.supplier.code, addDays(payDay, -BEFORE_DAYS));
    const total = pays.filter((p) => p.date >= addDays(payDay, -5)).reduce((s, p) => s + p.sum, 0);
    return total >= COVER * Number(it.amount || 0);
  } catch {
    return null;
  }
}

/**
 * "לא שולם ב-15": מועד שעבר (מאתמול ועד ‎LATE_DAYS‎ אחורה), המסמך לא שולם — מייל ליוזם בלבד, פעם אחת.
 * לא על חשבון חלקי שהוסב. ‎[{ ref, user }]‎
 */
async function sweepLate(today, now = D.nowIso()) {
  const rows = D.all(`SELECT ref, data, pay_day FROM payment_items WHERE org_id = ? AND stage IN ('open','gone','invoiced')
    AND pay_day <> '' AND pay_day < ? AND pay_day >= ? AND late_notified_at = ''`, ORG, today, addDays(today, -LATE_DAYS));
  const out = [];
  for (const row of rows) {
    let it;
    try { it = JSON.parse(row.data); } catch { it = null; }
    const paid = it && !it.endorsed ? await probablyPaid(it, row.pay_day) : true;
    if (paid === null) continue;   // פריוריטי לא זמין — ננסה בסבב הבא
    D.run('UPDATE payment_items SET late_notified_at = ? WHERE ref = ?', now, row.ref);
    if (paid) continue;
    const u = await initiatorUser(it);
    if (!u) continue;
    await deliver(u, lateMail({ ...it, payDay: row.pay_day }));
    out.push({ ref: row.ref, user: u });
  }
  return out;
}

module.exports = { matchPayment, combine, checkPaid, markPaid, onPaid, sweepLate, paidRecipients, initiatorUser, paidMail, lateMail, TOLERANCE, BEFORE_DAYS, NOTIFY_DAYS };
