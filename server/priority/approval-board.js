'use strict';
/**
 * ✍️ לוח האישורים — "ממתין לאישורי" ו"שלחתי לאישור" (משימון פריוריטי), ומיילי הבוקר.
 * האפיון: "אפיון — מעקב אישורים ותשלומים.md" סעיפים 3–4.
 *
 * כל המסמכים שמחכים לאישור בפריוריטי, בכל הסבבים (‎Priority.APPROVAL_KINDS‎ ודרישת רכש), במבנה אחד: מי שלח, אצל מי זה
 * תקוע עכשיו (החותם הבא), ממתי, כמה ימים, וצבע. עובד שגם שולח וגם מאשר — רואה שתי רשימות נפרדות.
 *
 * **ממתי:** החתימה האחרונה ברשימת המאשרים (‎UDATE‎) — מאז המסמך אצל החותם הנוכחי; עוד אף אחד לא חתם — תאריך המסמך.
 * **צבע (הוחלט 24.11.26):** ירוק (0–2 ימים) ← צהוב (3–4) ← כתום (5–6) ← אדום (7 ומעלה). מסמך שמוביל לתשלום (חשבון חלקי,
 * חשבון עסקה) כשה-15 בעוד 3 ימים או פחות — לפחות כתום.
 *
 * **מיילי הבוקר** (פעם ביום, מ-08:00, בימי העבודה של העובד):
 *   • למאשר — מה שממתין לאישורו, בצבעים, ולכל מסמך קישור לפריוריטי (תבנית הקישור — במסך ההגדרות, ‎docLink‎);
 *   • למי ששלח — מה שלו ממתין אצל אחרים. מה שתקוע 3 ימים ומעלה — בראש, עם דגל אדום, ובנושא המייל (הוחלט 26.11.26:
 *     אחרי 3 ימים — ליוזם, לא להנהלת החשבונות ולא לכספים).
 * בוואטסאפ — בלי קישורים (‎priority-approvals.js‎ מפנה לכאן).
 *
 * קריאה בלבד מפריוריטי. נשמר בזיכרון ל-10 דקות.
 */
const D = require('../core').Db;
const Workdays = require('../core').Workdays;
const { escape, shell } = require('../core').MailTemplates;
const Priority = require('../integrations').Priority;
const Mailer = require('../integrations').Mailer;
const Settings = require('./priority-settings');
const Approvals = require('./priority-approvals');

const TTL_MS = 10 * 60 * 1000;
const DIGEST_HOUR = 8;
const DIGEST_UNTIL = 12;       // מי שהשרת לא הגיע אליו עד אז (שרת כבוי) — לא מקבל באותו יום
const STUCK_DAYS = 3;
const SENT_KEY = 'approval_digest_sent';   // { date, users: [id] } — מצב פנימי (בקטלוג)

/** המסך בפריוריטי לכל סוג — לקישור */
const FORMS = Object.freeze({ demand: 'PURDEMANDS', order: 'PORDERS', contract: 'MED_PORDERS', partial: 'MED_DOCUMENTS_P', deal: 'DINVOICES' });
const PAY_KINDS = new Set(['partial', 'deal']);
const COLORS = Object.freeze([
  { key: 'green', label: 'ירוק', from: 0, hex: '#16a34a' },
  { key: 'yellow', label: 'צהוב', from: 3, hex: '#ca8a04' },
  { key: 'orange', label: 'כתום', from: 5, hex: '#ea580c' },
  { key: 'red', label: 'אדום', from: 7, hex: '#dc2626' }
]);

const day = (v) => String(v ?? '').slice(0, 10);
const dmy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const daysBetween = (from, to) => Math.max(0, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));
const shekel = (n) => Math.round(Number(n) || 0).toLocaleString('he-IL');

/** ה-15 הקרוב (היום, אם היום ה-15) */
function next15(today) {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, d <= 15 ? m - 1 : m, 15)).toISOString().slice(0, 10);
}

/** הצבע לפי הימים, ולמסמך תשלום — לפחות כתום כשה-15 קרוב */
function colorOf(days, { kind = '', today = '' } = {}) {
  let i = COLORS.reduce((acc, c, k) => (days >= c.from ? k : acc), 0);
  if (today && PAY_KINDS.has(kind) && daysBetween(today, next15(today)) <= 3) i = Math.max(i, 2);
  return COLORS[i].key;
}

/** ממתי המסמך אצל החותם הנוכחי: החתימה האחרונה, או תאריך המסמך */
function sinceOf(kind, d) {
  const k = kind === 'demand' ? { users: 'PDUSER_SUBFORM', date: 'CURDATE' } : Priority.APPROVAL_KINDS[kind];
  const signed = (d[k.users] ?? []).filter((u) => u.UFLAG === 'Y' && u.UDATE).map((u) => day(u.UDATE)).sort();
  return signed.pop() || day(d[k.date]) || '';
}

const labelOf = (kind, d) => (kind === 'demand' ? 'דרישת רכש' : kind === 'contract' && d.MED_TYPE === 'CH' ? 'שינוי בחוזה' : Priority.APPROVAL_KINDS[kind].label);
const numOf = (kind, d) => (kind === 'demand' ? d.PRDNO : d[Priority.APPROVAL_KINDS[kind].key]);

/** קישור למסמך בפריוריטי לפי התבנית שבהגדרות (‎{form} {doc} {company}‎). ריק — אין תבנית */
function linkOf(row, template = Settings.defaults().docLink) {
  const t = String(template ?? '').trim();
  if (!t) return '';
  return t.replace(/\{form\}/g, encodeURIComponent(FORMS[row.kind] ?? '')).replace(/\{doc\}/g, encodeURIComponent(row.no))
    .replace(/\{company\}/g, encodeURIComponent(row.company));
}

/** מסמך מפריוריטי ← שורה בלוח */
function rowOf(company, kind, d, today) {
  const k = kind === 'demand' ? { supplier: null } : Priority.APPROVAL_KINDS[kind];
  const since = sinceOf(kind, d);
  const days = since ? daysBetween(since, today) : 0;
  const users = kind === 'demand' ? d.PDUSER_SUBFORM : d[k.users];
  return {
    key: `${company}:${kind}:${numOf(kind, d)}`, company, kind, label: labelOf(kind, d), no: numOf(kind, d),
    supplier: k.supplier ? d[k.supplier] ?? '' : '', project: d.PROJDES ?? '', amount: Number(d.TOTPRICE) || 0, currency: d.CODE || 'ש"ח',
    owner: d.OWNERLOGIN || d.INITUSERLOGIN || '', signer: Priority.approvalSigner(kind, d) ?? '',
    approvers: (users ?? []).map((u) => ({ login: u.USERLOGIN, signed: u.UFLAG === 'Y', by: u.CUSERLOGIN || '', at: day(u.UDATE) })),
    since, days, color: colorOf(days, { kind, today })
  };
}

// ---------------------------------------------------------------------------
// טעינה
// ---------------------------------------------------------------------------

let cache = null;
let loading = null;
const KINDS = () => ['demand', ...Object.keys(Priority.APPROVAL_KINDS)];

async function readAll(today) {
  const rows = [];
  const errors = [];
  for (const c of Settings.pdNotifyCompanies()) {
    for (const kind of KINDS()) {
      try {
        const list = kind === 'demand' ? await Priority.waitingDemands(c) : await Priority.waitingForApproval(c, kind);
        for (const d of list) rows.push(rowOf(c, kind, d, today));
      } catch (err) {
        errors.push({ company: c, kind, message: err.message });
      }
    }
  }
  return { at: Date.now(), today, rows, errors };
}

async function load({ force = false, today = Workdays.todayIL() } = {}) {
  if (!Priority.isEnabled()) return { at: Date.now(), today, rows: [], errors: [] };
  if (loading) return loading;
  if (!force && cache && cache.today === today && Date.now() - cache.at < TTL_MS) return cache;
  loading = readAll(today).then((r) => { cache = r; return r; }).finally(() => { loading = null; });
  return loading;
}
const _reset = () => { cache = null; loading = null; };

// ---------------------------------------------------------------------------
// מי הוא מי
// ---------------------------------------------------------------------------

/** יוזם: לרוב שם משתמש בפריוריטי; בחוזים לפעמים שם מלא ("חנה (חני) גנוט") — אז לפי השם */
async function userOfOwner(owner) {
  const o = String(owner ?? '').trim();
  if (!o) return null;
  const m = await Approvals.mesimonUserFor(o).catch(() => ({ user: null }));
  if (m.user) return m.user;
  const w = Approvals._words(o);
  if (!w.includes(' ')) return null;
  const hits = D.all("SELECT id, full_name, email, phone FROM users WHERE status = 'active' AND role <> 'vendor'")
    .filter((u) => { const x = Approvals._words(u.full_name); return x === w || (x.includes(' ') && w.includes(x)); });
  return hits.length === 1 ? hits[0] : null;
}

/** שמות לתצוגה לכל שם משתמש בפריוריטי */
async function namesOf() {
  const list = await Priority.priorityUsers().catch(() => []);
  const m = new Map(list.map((u) => [String(u.USERLOGIN).toLowerCase(), u.SNAME || u.USERLOGIN]));
  return (login) => m.get(String(login ?? '').toLowerCase()) ?? login ?? '';
}

/** שתי הרשימות של עובד: ‎waiting‎ — ממתין לאישורו; ‎sent‎ — מה ששלח וממתין אצל אחרים */
async function forUser(actor, { force = false, today } = {}) {
  const data = await load({ force, today });
  const login = await Approvals.priorityLoginFor({ id: actor.id }).catch(() => null);
  const name = await namesOf();
  const l = String(login ?? '').toLowerCase();
  const waiting = [];
  const sent = [];
  for (const r of data.rows) {
    const view = { ...r, signerName: name(r.signer), ownerName: name(r.owner), link: linkOf(r) };
    if (l && r.signer.toLowerCase() === l) waiting.push(view);
    const owner = await userOfOwner(r.owner);
    if (owner?.id === actor.id && r.signer.toLowerCase() !== l) sent.push(view);
  }
  const order = (a, b) => b.days - a.days || a.no.localeCompare(b.no);
  return { login, at: new Date(data.at).toISOString(), today: data.today, colors: COLORS, waiting: waiting.sort(order), sent: sent.sort(order), errors: data.errors.length };
}

// ---------------------------------------------------------------------------
// מיילי הבוקר
// ---------------------------------------------------------------------------

const companyName = (c) => Settings.companies().find((x) => x.code === c)?.name ?? c;
const hexOf = (key) => COLORS.find((c) => c.key === key)?.hex ?? '#666';

function lineText(r, who) {
  return `${r.days >= STUCK_DAYS ? '🚩 ' : ''}${r.label} ${r.no} · ${r.supplier || companyName(r.company)}${r.amount ? ` · ₪${shekel(r.amount)}` : ''} · ${who} · ${r.days} ימים${r.link ? ` · ${r.link}` : ''}`;
}

function lineHtml(r, who) {
  const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${hexOf(r.color)};margin-inline-end:6px"></span>`;
  const doc = r.link ? `<a href="${escape(r.link)}">${escape(`${r.label} ${r.no}`)}</a>` : `<b>${escape(`${r.label} ${r.no}`)}</b>`;
  const meta = [r.supplier, companyName(r.company), r.project, r.amount ? `₪${shekel(r.amount)}` : '', who, `${r.days} ימים (מ-${dmy(r.since)})`].filter(Boolean).map(escape).join(' · ');
  return `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${dot}${r.days >= STUCK_DAYS ? '🚩 ' : ''}${doc}<div style="color:#555;font-size:13px">${meta}</div></td></tr>`;
}

/** מייל למאשר: מה שממתין לאישורו (עם קישורים לפריוריטי). ‎null‎ — אין */
function approverMail(rows) {
  if (!rows.length) return null;
  const subject = `✍️ ממתינים לאישורך בפריוריטי: ${rows.length} ${rows.length === 1 ? 'מסמך' : 'מסמכים'}${rows.some((r) => r.color === 'red') ? ' (חלקם 7 ימים ומעלה)' : ''}`;
  const head = rows.some((r) => r.link) ? 'לחיצה על מסמך פותחת אותו בפריוריטי לאישור.' : 'האישור — בפריוריטי.';
  const text = [`${rows.length} מסמכים ממתינים לאישורך:`, ...rows.map((r) => `• ${lineText(r, `שלח/ה ${r.ownerName || r.owner}`)}`), '', head].join('\n');
  const html = shell({ title: subject, bodyHtml: `<p>${escape(`${rows.length} מסמכים ממתינים לאישורך:`)}</p><table style="width:100%;border-collapse:collapse">${rows.map((r) => lineHtml(r, `שלח/ה ${r.ownerName || r.owner}`)).join('')}</table><p>${escape(head)}</p>` });
  return { subject, text, html };
}

/** מייל למי ששלח: מה שלו ממתין אצל אחרים; תקוע 3 ימים ומעלה — בראש ובנושא. ‎null‎ — אין */
function senderMail(rows) {
  if (!rows.length) return null;
  const stuck = rows.filter((r) => r.days >= STUCK_DAYS);
  const subject = stuck.length
    ? `🚩 ${stuck.length} ${stuck.length === 1 ? 'מסמך ששלחת עדיין לא אושר' : 'מסמכים ששלחת עדיין לא אושרו'} (3 ימים ומעלה)`
    : `⏳ ממתינים לאישור: ${rows.length} מסמכים ששלחת`;
  const ordered = [...stuck, ...rows.filter((r) => r.days < STUCK_DAYS)];
  const who = (r) => `תקוע אצל ${r.signerName || r.signer || 'לא ידוע'}`;
  const text = [`המסמכים ששלחת לאישור ועדיין ממתינים:`, ...ordered.map((r) => `• ${lineText({ ...r, link: '' }, who(r))}`)].join('\n');
  const html = shell({ title: subject, bodyHtml: `<p>${escape('המסמכים ששלחת לאישור ועדיין ממתינים:')}</p><table style="width:100%;border-collapse:collapse">${ordered.map((r) => lineHtml({ ...r, link: '' }, who(r))).join('')}</table>` });
  return { subject, text, html };
}

async function send(user, m) {
  if (!m || !user?.email || !Mailer.isEnabled()) return false;
  try { await Mailer.send({ to: user.email, toName: user.full_name, subject: m.subject, html: m.html, text: m.text }); return true; }
  catch (err) { console.error(`[משימון] לוח האישורים — מייל ל${user.full_name}:`, err.message); return false; }
}

/**
 * מיילי הבוקר: פעם ביום לכל עובד (מ-08:00 עד 12:00, בימי העבודה שלו) — למאשר ולשולח. ‎[{ user, approver, sender }]‎ — מה נשלח.
 */
async function morning(now = new Date(), { deliver = send } = {}) {
  const t = Workdays.ilParts(now);
  if (t.hour < DIGEST_HOUR || t.hour >= DIGEST_UNTIL || !Priority.isEnabled()) return [];
  const state = D.getSetting(SENT_KEY, {}) ?? {};
  const done = new Set(state.date === t.date ? state.users ?? [] : []);
  const data = await load({ today: t.date });
  if (data.errors.length && !data.rows.length) return [];
  const name = await namesOf();
  const byUser = new Map();
  const slot = (u) => { if (!byUser.has(u.id)) byUser.set(u.id, { user: u, approver: [], sender: [] }); return byUser.get(u.id); };
  for (const r0 of data.rows) {
    const r = { ...r0, signerName: name(r0.signer), ownerName: name(r0.owner), link: linkOf(r0) };
    const signer = r.signer ? (await Approvals.mesimonUserFor(r.signer).catch(() => ({ user: null }))).user : null;
    if (signer) slot(signer).approver.push(r);
    const owner = await userOfOwner(r.owner);
    if (owner && owner.id !== signer?.id) slot(owner).sender.push(r);
  }
  const out = [];
  for (const { user, approver, sender } of byUser.values()) {
    if (done.has(user.id)) continue;
    let work = true;
    try { work = Workdays.isWorkDay(user.id, t.date); } catch { /* ברירת מחדל — יום עבודה */ }
    if (!work) continue;
    const order = (a, b) => b.days - a.days;
    const u = D.get('SELECT id, full_name, email FROM users WHERE id = ?', user.id) ?? user;
    const a = await deliver(u, approverMail(approver.sort(order)));
    const s = await deliver(u, senderMail(sender.sort(order)));
    done.add(user.id);
    out.push({ user: u, approver: Boolean(a), sender: Boolean(s) });
  }
  D.setSetting(SENT_KEY, { date: t.date, users: [...done] });
  return out;
}

let timer = null;
function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { morning().catch((err) => console.error('[משימון] לוח האישורים — מיילי הבוקר:', err.message)); }, 10 * 60 * 1000);
  timer.unref?.();
}

module.exports = { COLORS, FORMS, colorOf, sinceOf, rowOf, linkOf, next15, load, forUser, userOfOwner, approverMail, senderMail, morning, start, _reset };
