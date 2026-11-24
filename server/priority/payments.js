'use strict';
/**
 * 💰 רשימת התשלומים ל-15 — כל מה שמחכה לתשלום, משלושת המסמכים, ברשימה אחת (‎/priority/payments‎).
 *
 * האפיון: "אפיון — רשימת תשלומים ל-15.md" (הוחלט 24.11.26). כל החברות משלמות ב-15 בחודש. שלושה מסמכים מובילים לתשלום:
 *   קבלת סחורה (סופית, ורק השורות שעוד לא בחשבונית) · חשבון חלקי (אושרה) · חשבון עסקה (מאושרת).
 * מועד התשלום = ה-15 הראשון שבו או אחרי המועד לפי התנאים (סוף החודש של תאריך המסמך + ימי התנאי).
 *
 * **מבנה אחד לשני השלבים** (שלב 2 — סטטוס תשלום: מי שהעביר לתשלום רואה אם שולם ומתי):
 *   קוראים (‎SOURCES‎, אחד לכל סוג) ← מבנה אחיד ("חוב", ‎ref = חברה:סוג:מספר‎) ← שמירה (‎payment_items‎)
 *   ← משלימי שלב (‎RESOLVERS‎: שלב 1 — לאן הלך מסמך שיצא מהרשימה) ← תצוגות (‎report‎ — ממתין לתשלום, "שלי").
 *   שלב 2 מוסיף משלים ("שולם") ותצוגה; הקוראים, החישוב והמסך לא משתנים. לא זורקים — מסננים בתצוגה.
 *
 * קריאה בלבד מפריוריטי. הנתונים נשמרים בזיכרון ל-10 דקות; "רענון" קורא מחדש (לא יותר מפעם ב-30 שניות).
 */
const D = require('../core').Db;
const Xlsx = require('../core').XlsxWrite;
const Priority = require('../integrations').Priority;
const Settings = require('./priority-settings');
const Access = require('./priority-access');
const Approvals = require('./priority-approvals');

const ORG = 1;
const TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const PARALLEL = 4;
const RESOLVE_MAX = 40;
const ILS = 'ש"ח';

const TYPES = Object.freeze([
  { key: 'receipt', label: 'קבלת סחורה' },
  { key: 'partial', label: 'חשבון חלקי' },
  { key: 'deal', label: 'חשבון עסקה' }
]);
const TYPE_KEYS = TYPES.map((t) => t.key);
/** שלבי החוב. ‎paid‎ — שלב 2 */
const STAGES = Object.freeze(['open', 'gone', 'invoiced', 'cancelled', 'paid']);

// ---------------------------------------------------------------------------
// חישוב ה-15
// ---------------------------------------------------------------------------

const isoDay = (v) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const ymd = (y, m) => { const d = new Date(Date.UTC(y, m, 15)); return d.toISOString().slice(0, 10); };

/** ה-15 שבו התשלום יוצא: ה-15 הראשון שבו או אחרי ‎due‎. ‎''‎ — אין מועד */
function payDay(due) {
  const d = isoDay(due);
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return day <= 15 ? ymd(y, m - 1) : ymd(y, m);
}

/** ה-15 שאחרי ‎n‎ חודשים */
function addRuns(run, n) {
  const [y, m] = run.split('-').map(Number);
  return ymd(y, m - 1 + n);
}

/** היום בישראל — ‎YYYY-MM-DD‎ */
const todayIL = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);

/** ה-15 הקרוב (היום, אם היום ה-15) */
const nextRun = (today = todayIL()) => payDay(today);

/**
 * לאיזה מועד שייך החוב, ביחס ל-15 הקרוב: ‎late‎ (היה צריך לצאת כבר) · ‎none‎ (אין תנאי תשלום) · או ה-15 עצמו (‎YYYY-MM-15‎) —
 * כל חודש שיש בו תשלום, בלי גבול (הוחלט 24.11.26: "כל מה שנמצא במערכת").
 */
function bucketOf(day, run) {
  if (!day) return 'none';
  if (day < run) return 'late';
  return day;
}

// ---------------------------------------------------------------------------
// קוראים — מסמך מפריוריטי ← חוב במבנה אחיד
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(v * 100) / 100;
const logins = (...xs) => [...new Set(xs.map((x) => String(x ?? '').trim()).filter(Boolean))];

function base(company, type, docno, r) {
  return {
    ref: `${company}:${type}:${docno}`, company, type, docno,
    supplier: { code: r.SUPNAME ?? '', name: r.CDES ?? r.SUPDES ?? '' },
    booknum: r.BOOKNUM ?? '',
    project: { code: r.PROJDOCNO ?? '', name: r.PROJDES ?? '' },
    currency: r.CODE || ILS,
    invoices: [], partialInvoiced: false
  };
}

/** קבלת סחורה: רק השורות שעוד לא בחשבונית. כולן בחשבונית (ופריוריטי עוד לא סימן) — ‎null‎ */
function fromReceipt(r, company) {
  const lines = Array.isArray(r.TRANSORDER_P_SUBFORM) ? r.TRANSORDER_P_SUBFORM : [];
  const billed = lines.filter((l) => l.IVNUM);
  const open = lines.filter((l) => !l.IVNUM);
  if (lines.length && !open.length) return null;
  let amount = num(r.TOTPRICE);
  if (billed.length) {
    const net = open.reduce((s, l) => s + num(l.QPRICE), 0) * (1 - num(r.PERCENT) / 100);
    const vatRate = num(r.DISPRICE) ? num(r.VAT) / num(r.DISPRICE) : 0;
    amount = round2(net * (1 + vatRate));
  }
  const date = isoDay(r.CURDATE);
  const due = Priority.dueDate(r.MED_MXPAYCODE, date);
  return {
    ...base(company, 'receipt', r.DOCNO, r), date, payCode: r.MED_MXPAYCODE ?? '', terms: r.MED_MXPAYCODE ? Priority.payLabel(r.MED_MXPAYCODE) : '',
    due, payDay: payDay(due), amount, total: num(r.TOTPRICE),
    invoices: [...new Set(billed.map((l) => l.IVNUM))], partialInvoiced: billed.length > 0,
    initiator: r.USERLOGIN ?? '', people: logins(r.USERLOGIN, r.OWNERLOGIN)
  };
}

/** חשבון חלקי (PC): נספר מתאריך החשבון (24.11.26) */
function fromPartial(r, company) {
  const date = isoDay(r.CURDATE);
  const due = Priority.dueDate(r.MED_PAYCODE, date);
  return {
    ...base(company, 'partial', r.DOCNO, r), contract: r.ORDNAME ?? '', date, payCode: r.MED_PAYCODE ?? '',
    terms: r.MED_PAYCODE ? Priority.payLabel(r.MED_PAYCODE) : '', due, payDay: payDay(due),
    amount: num(r.TOTPRICE), total: num(r.TOTPRICE), initiator: r.USERLOGIN ?? r.OWNERLOGIN ?? '', people: logins(r.USERLOGIN, r.OWNERLOGIN)
  };
}

/** חשבון עסקה: אין קוד תנאי תשלום ב-API — מועד התשלום של פריוריטי (‎PAYDATE‎) */
function fromDeal(r, company) {
  const due = isoDay(r.PAYDATE);
  return {
    ...base(company, 'deal', r.IVNUM, r), date: isoDay(r.IVDATE), payCode: '', terms: '', due, payDay: payDay(due),
    amount: num(r.TOTPRICE), total: num(r.TOTPRICE), initiator: r.OWNERLOGIN ?? '', people: logins(r.OWNERLOGIN)
  };
}

const SOURCES = {
  receipt: { read: (c) => Priority.payReceipts(c), toItem: fromReceipt },
  partial: { read: (c) => Priority.payPartials(c), toItem: fromPartial },
  deal: { read: (c) => Priority.payDeals(c), toItem: fromDeal }
};

/** עד ‎n‎ משימות במקביל */
async function pool(tasks, n = PARALLEL) {
  const out = new Array(tasks.length);
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

/** קריאה מכל החברות. ‎{ items, errors, read: Set('חברה:סוג') }‎ — ‎read‎: מה שנקרא בהצלחה (רק בו מסמך שחסר "יצא") */
async function collect(companies) {
  const jobs = companies.flatMap((c) => TYPE_KEYS.map((t) => async () => {
    try {
      const list = await SOURCES[t].read(c);
      return { c, t, items: list.map((r) => SOURCES[t].toItem(r, c)).filter((x) => x && x.docno) };
    } catch (err) {
      return { c, t, error: err.message };
    }
  }));
  const results = await pool(jobs);
  const items = [];
  const errors = [];
  const read = new Set();
  for (const r of results) {
    if (r.error) errors.push({ company: r.c, type: r.t, message: r.error });
    else { items.push(...r.items); read.add(`${r.c}:${r.t}`); }
  }
  return { items, errors, read };
}

// ---------------------------------------------------------------------------
// שמירה — ‎payment_items‎
// ---------------------------------------------------------------------------

/** שומר את מה שנקרא; חוב פתוח שלא חזר (בחברה ובסוג שנקראו בהצלחה) — יצא מהרשימה (‎gone‎) */
function persist(items, read, now = D.nowIso()) {
  const seen = new Set();
  for (const it of items) {
    seen.add(it.ref);
    const row = D.get('SELECT stage FROM payment_items WHERE ref = ?', it.ref);
    const data = JSON.stringify(it);
    const invoices = JSON.stringify(it.invoices ?? []);
    if (!row) {
      D.run(`INSERT INTO payment_items (ref, org_id, company, type, docno, stage, amount, pay_day, first_pay_day, invoices, data, first_seen, last_seen, stage_at)
             VALUES (?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?)`, it.ref, ORG, it.company, it.type, it.docno, it.amount, it.payDay, it.payDay, invoices, data, now, now, now);
    } else {
      D.run(`UPDATE payment_items SET stage = 'open', amount = ?, pay_day = ?, invoices = ?, data = ?, last_seen = ?,
             stage_at = CASE WHEN stage = 'open' THEN stage_at ELSE ? END WHERE ref = ?`, it.amount, it.payDay, invoices, data, now, now, it.ref);
    }
  }
  const open = D.all("SELECT ref, company, type FROM payment_items WHERE org_id = ? AND stage = 'open'", ORG);
  let gone = 0;
  for (const r of open) {
    if (seen.has(r.ref) || !read.has(`${r.company}:${r.type}`)) continue;
    D.run("UPDATE payment_items SET stage = 'gone', stage_at = ? WHERE ref = ?", now, r.ref);
    gone += 1;
  }
  return { gone };
}

// ---------------------------------------------------------------------------
// משלימי שלב — שלב 1: לאן הלך מסמך שיצא מהרשימה. שלב 2 יוסיף כאן "שולם".
// ---------------------------------------------------------------------------

/** השלב לפי הסטטוס בפריוריטי. ‎null‎ — עוד לא ידוע (נשאר ‎gone‎) */
function stageFromStatus(type, st) {
  if (!st) return null;
  if (/מבוטל|דחיה/.test(st.status)) return 'cancelled';
  if (type === 'receipt') return st.invoiced ? 'invoiced' : null;
  if (type === 'partial') return st.status === 'שולם' ? 'paid' : st.status === 'סופית' ? 'invoiced' : null;
  if (type === 'deal') return st.status === 'סופית' ? 'invoiced' : null;
  return null;
}

const RESOLVERS = [
  {
    name: 'left-the-list',
    from: 'gone',
    async run(rows, now) {
      for (const r of rows) {
        try {
          const stage = stageFromStatus(r.type, await Priority.payDocStatus(r.company, r.type, r.docno));
          if (stage) D.run('UPDATE payment_items SET stage = ?, stage_at = ? WHERE ref = ?', stage, now, r.ref);
        } catch { /* ננסה ברענון הבא */ }
      }
    }
  }
];

async function resolve(now = D.nowIso()) {
  for (const r of RESOLVERS) {
    const rows = D.all('SELECT ref, company, type, docno FROM payment_items WHERE org_id = ? AND stage = ? ORDER BY stage_at LIMIT ?', ORG, r.from, RESOLVE_MAX);
    if (rows.length) await r.run(rows, now);
  }
}

// ---------------------------------------------------------------------------
// טעינה ושמירה בזיכרון
// ---------------------------------------------------------------------------

let cache = null;        // { at, items, errors }
let loading = null;

const realCompanies = () => Settings.companies().filter((c) => !c.test).map((c) => c.code);

async function refreshNow() {
  if (!Priority.isEnabled()) return { at: Date.now(), items: [], errors: [{ company: '', type: '', message: 'החיבור לפריוריטי אינו מוגדר' }] };
  const { items, errors, read } = await collect(realCompanies());
  const now = D.nowIso();
  try { persist(items, read, now); await resolve(now); } catch (err) { console.error('[משימון] תשלומים — שמירה נכשלה:', err.message); }
  if (errors.length) console.error('[משימון] תשלומים — קריאה נכשלה:', errors.map((e) => `${e.company}/${e.type}: ${e.message}`).join('; '));
  return { at: Date.now(), items, errors };
}

/** הנתונים — מהזיכרון, או קריאה מחדש. ‎force‎ — רענון (לא יותר מפעם ב-30 שניות) */
async function load({ force = false } = {}) {
  if (loading) return loading;
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < (force ? MIN_REFRESH_MS : TTL_MS)) return cache;
  loading = refreshNow().then((r) => { cache = r; return r; }).finally(() => { loading = null; });
  return loading;
}

const _reset = () => { cache = null; loading = null; };

// ---------------------------------------------------------------------------
// תצוגות
// ---------------------------------------------------------------------------

/** מה שהעובד יזם: שם המשתמש שלו בפריוריטי, ומסמכים שנפתחו בבוט בשמו (שם בפריוריטי רשום משתמש ה-API) */
async function mineOf(actor) {
  const login = await Approvals.priorityLoginFor({ id: actor.id }).catch(() => null);
  const bot = new Set(D.all("SELECT company, docno FROM priority_docs WHERE org_id = ? AND user_id = ? AND docno <> ''", ORG, actor.id)
    .map((r) => `${r.company}:${r.docno}`));
  const l = login ? login.toLowerCase() : null;
  return { login, is: (it) => bot.has(`${it.company}:${it.docno}`) || Boolean(l && it.people.some((p) => p.toLowerCase() === l)) };
}

/** מי יזם — לתצוגה: עובד משימון (בבוט), או השם בפריוריטי */
async function initiatorNames(items) {
  const byDoc = new Map(D.all(`SELECT pd.company, pd.docno, u.full_name FROM priority_docs pd JOIN users u ON u.id = pd.user_id
    WHERE pd.org_id = ? AND pd.docno <> ''`, ORG).map((r) => [`${r.company}:${r.docno}`, r.full_name]));
  const users = new Map((await Priority.priorityUsers().catch(() => [])).map((u) => [String(u.USERLOGIN).toLowerCase(), u.SNAME || u.USERLOGIN]));
  // משתמש ה-API ("API VPLANS") — הבוט: מסמך מלפני שהשרשרת רשמה מי קלט (11.11.26)
  return (it) => byDoc.get(`${it.company}:${it.docno}`) ?? users.get(String(it.initiator).toLowerCase())
    ?? (/^API\b/i.test(it.initiator) ? 'הבוט' : it.initiator);
}

const clean = (v) => String(v ?? '').trim();
/** הסינון של המסך (גם לייצוא) — כל מה שאינו מועד; המועד — בנפרד, כדי לספור לכל מועד */
function filterItems(items, f = {}) {
  const sup = clean(f.supplier).toLowerCase();
  return items.filter((it) => (!f.type || it.type === f.type)
    && (!f.company || it.company === f.company)
    && (!f.project || it.project.code === f.project)
    && (!sup || it.supplier.name.toLowerCase().includes(sup) || it.supplier.code.toLowerCase() === sup)
    && (!f.mine || it.mine));
}

/** סכומים: לכל מועד (מספר ושקלים) ולכל ספק (במועד שנבחר). מטבע זר — בנפרד, לא נכנס לסה"כ בשקלים */
function totals(items) {
  const sum = (list) => {
    const ils = round2(list.filter((i) => i.currency === ILS).reduce((s, i) => s + i.amount, 0));
    const other = {};
    for (const i of list.filter((x) => x.currency !== ILS)) other[i.currency] = round2((other[i.currency] ?? 0) + i.amount);
    return { count: list.length, ils, other };
  };
  const group = (keyOf, label) => {
    const m = new Map();
    for (const i of items) { const k = keyOf(i); if (!m.has(k)) m.set(k, { ...label(i), list: [] }); m.get(k).list.push(i); }
    return [...m.values()].map(({ list, ...x }) => ({ ...x, ...sum(list) })).sort((a, b) => b.ils - a.ils);
  };
  return {
    all: sum(items),
    suppliers: group((i) => `${i.company}:${i.supplier.code}`, (i) => ({ supplier: i.supplier.name || i.supplier.code, company: i.company })),
    companies: group((i) => i.company, (i) => ({ company: i.company }))
  };
}

/**
 * הדוח. מי שמורשה ל"תשלומים" — כל מה שבחברות שלו (מחלקת כספים — כל החברות; ואפשר "רק שלי"); כל עובד אחר — רק מה שהוא יזם.
 * ‎f‎: ‎{ bucket, type, company, project, supplier, mine, refresh }‎.
 */
async function report(actor, f = {}) {
  const all = Access.can(actor, 'payments');
  const data = await load({ force: Boolean(f.refresh) });
  const mine = await mineOf(actor);
  const run = nextRun(f.today);
  const name = await initiatorNames(data.items);
  const allowedCos = Access.paymentCompanies(actor, realCompanies());   // מחלקת כספים — כל החברות
  let items = data.items.map((it) => ({ ...it, bucket: bucketOf(it.payDay, run), mine: mine.is(it), initiatorName: name(it) }));
  items = all ? items.filter((it) => allowedCos.includes(it.company)) : items.filter((it) => it.mine);

  const facets = {
    companies: [...new Set(items.map((i) => i.company))],
    projects: [...new Map(items.filter((i) => i.project.code).map((i) => [i.project.code, i.project])).values()].sort((a, b) => a.name.localeCompare(b.name, 'he'))
  };
  const filtered = filterItems(items, f);
  // המועדים: באיחור, כל חודש שיש בו תשלום (ולפחות שלושת הקרובים), חסר תנאי תשלום
  const runs = [...new Set([0, 1, 2].map((n) => addRuns(run, n)).concat(filtered.map((i) => i.bucket).filter((b) => /^\d{4}-/.test(b))))].sort();
  const keys = ['late', ...runs, 'none'];
  const byBucket = Object.fromEntries(keys.map((b) => [b, totals(filtered.filter((i) => i.bucket === b)).all]));
  // ‎next‎ — ה-15 הקרוב (ברירת המחדל של המסך)
  const bucket = f.bucket === 'next' ? run : f.bucket || '';
  const shown = bucket ? filtered.filter((i) => i.bucket === bucket) : filtered;
  shown.sort((a, b) => (a.payDay || '9999').localeCompare(b.payDay || '9999') || a.supplier.name.localeCompare(b.supplier.name, 'he') || a.docno.localeCompare(b.docno));
  return {
    scope: all ? 'all' : 'mine', login: mine.login, today: f.today ?? todayIL(), run, runs, bucket,
    at: new Date(data.at).toISOString(), types: TYPES, facets, byBucket, totals: totals(shown), items: shown,
    errors: all ? data.errors : []
  };
}

// ---------------------------------------------------------------------------
// ייצוא לאקסל
// ---------------------------------------------------------------------------

const dmy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const typeLabel = (k) => TYPES.find((t) => t.key === k)?.label ?? k;

const HEAD = ['מועד התשלום', 'סוג', 'חברה', 'ספק', 'מספר', 'אסמכתא', 'תאריך', 'תנאי תשלום', 'סכום', 'מטבע', 'פרויקט', 'יוזם', 'הערה'];
const WIDTHS = [13, 13, 22, 28, 14, 12, 11, 12, 13, 7, 26, 16, 34];

/**
 * אקסל: גיליון "הכל", ועוד גיליון לכל חברה (הוחלט 24.11.26 — "לפי חברה"). בסוף כל גיליון — סה"כ, ובגיליון "הכל" גם סה"כ לכל חברה.
 */
function toXlsx(r) {
  const company = (c) => Settings.companies().find((x) => x.code === c)?.name ?? c;
  const row = (i) => [dmy(i.payDay) || 'חסר תנאי תשלום', typeLabel(i.type), company(i.company), i.supplier.name || i.supplier.code, i.docno, i.booknum,
    dmy(i.date), i.terms, i.amount.toFixed(2), i.currency, i.project.name, i.initiatorName,
    i.partialInvoiced ? `רק מה שעוד לא בחשבונית (${i.invoices.join(', ')})` : i.contract ? `חוזה ${i.contract}` : ''];
  const money = (t) => [t.ils.toFixed(2), ILS, Object.entries(t.other).map(([c, v]) => `+ ${v.toFixed(2)} ${c}`).join(' ')];
  const sheet = (name, items, extra = []) => {
    const t = totals(items);
    const rows = [HEAD, ...items.map(row), [], ['סה"כ', '', '', `${t.all.count} מסמכים`, '', '', '', '', ...money(t.all)]];
    const bold = [rows.length - 1];
    for (const e of extra) { rows.push(e); bold.push(rows.length - 1); }
    return { name, rows, widths: WIDTHS, bold };
  };
  const cos = totals(r.items).companies;
  const perCompany = cos.length > 1 ? cos.map((c) => ['', '', company(c.company), `${c.count} מסמכים`, '', '', '', '', ...money(c)]) : [];
  return Xlsx.buildBook([
    sheet('הכל', r.items, perCompany.length ? [[], ['לפי חברה'], ...perCompany] : []),
    ...(cos.length > 1 ? cos.map((c) => sheet(company(c.company), r.items.filter((i) => i.company === c.company))) : [])
  ]);
}

module.exports = {
  TYPES, STAGES, SOURCES, RESOLVERS,
  payDay, addRuns, nextRun, bucketOf, todayIL,
  fromReceipt, fromPartial, fromDeal, collect, persist, resolve, stageFromStatus, load, report, filterItems, totals, toXlsx,
  _reset
};
