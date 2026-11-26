'use strict';
/**
 * 🔎 "מה קרה עם המסמך שלי?" — עובד שואל בבוט על מסמך ששלח לפריוריטי, והבוט עונה קודם *כן* / *לא*, ואז הפרטים.
 *
 * התוכנית: "תוכנית — סטטוס אישור ותשלום בבוט.md" (26.11.26). הוחלט עם ישראל: גם חוזה (אושר? כמה שולם ממנו),
 * גם חשבון עסקה, ומנהל מחלקה שואל גם על מסמכים של העובדים שלו ("שולמה הקבלה של יוסי?").
 *
 *   "שולמה קבלת הסחורה שעשיתי לברזל הצפון?"   → ✅ כן, שולם 15.11.26 (העברה BT…)
 *   "אושרה דרישת הרכש על הפטישים?"           → ⏳ עוד לא אושרה — מחכה לאלעד מ-24.11
 *   "כמה שולם מהחוזה בהגפן?"                  → 💰 שולמו ₪… (3 חשבונות חלקיים)
 *
 * **כמעט בלי פריוריטי** — מה שכבר נאסף במשימון:
 *   • ‎priority_docs‎ — מה שהעובד קלט / פתח בבוט (קבלת סחורה, דרישת רכש), השלב, ותקציר הפריטים (‎note‎).
 *   • ‎payment_items‎ — רשימת התשלומים ל-15 (‎payments.js‎, ‎payments-paid.js‎): מועד, בחשבונית, שולם (תאריך, העברה), "נראה ששולם".
 *   • ‎priority_waiting‎ — כל מה שמחכה לאישור, והחותם הבא (‎priority-waiting.js‎).
 * ופנייה לפריוריטי (קריאה בלבד) רק כשחסר: דרישה שלא נפתחה בבוט, האם דרישה אושרה והפכה להזמנה, סטטוס וסכום של חוזה.
 *
 * **מי רואה מה** — כמו במסך התשלומים: כל עובד — את שלו; מנהל מחלקה — גם של העובדים שלו (‎Access.teamOf‎);
 * הנהלה ומחלקת כספים (‎Access.can(actor, 'payments')‎) — הכל. "שלי" / "שעשיתי" — רק של השואל.
 *
 * אין כאן וואטסאפ: ‎request‎ / ‎answer‎ מחזירים ‎{ text, buttons, draft, result }‎ — הבוט שולח (‎wa-flows.js‎).
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const Settings = require('./priority-settings');
const Access = require('./priority-access');
const Approvals = require('./priority-approvals');
const Waiting = require('./priority-waiting');
const Payments = require('./payments');

const ORG = 1;
const KIND = 'my_docs';
const LOOK_DAYS = 365;
const DEMAND_DAYS = 180;
const PARALLEL = 4;
const MAX_OPTIONS = 3;
const MAX_LOGINS = 40;      // עובדי המחלקה שבודקים בפריוריטי (דרישות, חוזים)
const LOGIN_CHUNK = 8;     // שמות משתמש בקריאה אחת
const ILS = 'ש"ח';
const DAY = 86400000;

/** סוגי המסמכים. ‎f‎ — נקבה ("אושרה") / זכר ("אושר"). ‎short‎ — לכפתור */
const KINDS = Object.freeze({
  receipt: { label: 'קבלת סחורה', short: 'קבלה', icon: '📦', f: true },
  demand: { label: 'דרישת רכש', short: 'דרישה', icon: '🛒', f: true },
  partial: { label: 'חשבון חלקי', short: 'חלקי', icon: '🧾', f: false },
  contract: { label: 'חוזה', short: 'חוזה', icon: '📑', f: false },
  deal: { label: 'חשבון עסקה', short: 'עסקה', icon: '💼', f: false },
  order: { label: 'הזמנת רכש', short: 'הזמנה', icon: '🧾', f: true }
});
/** המסך בפריוריטי ← הסוג */
const SCREEN_KIND = { PURDEMANDS: 'demand', MED_PORDERS: 'contract', MED_DOCUMENTS_P: 'partial', DINVOICES: 'deal' };

// ---------------------------------------------------------------------------
// הבנת השאלה
// ---------------------------------------------------------------------------

const HE = '\\u0590-\\u05FF';
/** מילה שלמה בעברית, עם אות שימוש לפניה (ה, ו, ש, כש) */
const heWord = (alts) => new RegExp(`(?<![${HE}])(?:[הוש]|כש)?(?:${alts})(?![${HE}])`);
const PAID = heWord('שולם|שולמה|שולמו|ישולם|ישולמו|תשולם|משולם|משולמת|תשלום|שילמו|שילמנו|ישלמו');
const APPROVED = heWord('אושר|אושרה|אושרו|מאושר|מאושרת|נחתם|נחתמה|אישרו');
const WHERE = /הפכ(?:ה|ו)\s+להזמנ|נפתח(?:ה|ו)?\s+(?:ממנה\s+|ממנו\s+)?הזמנ|יש\s+(?:כבר\s+)?הזמנ|איפה\s+(?:עומד|עומדת|זה|נמצא|נמצאת)|מה\s+(?:המצב|קורה|קרה)\s+(?:עם|של)|מה\s+עם\s+ה|סטטוס|התקדמ/;
const HOW_MUCH = /כמה\s+(?:כבר\s+)?(?:שולם|שולמו|שילמו|שילמנו|נשאר|יצא)/;
/** בקשה אחרת שמזכירה תשלום ("שלח מייל לספק שהתשלום…") — לא כאן */
const COMMAND = /^\P{L}*(?:שלח|תשלח|תשלחי|שלחי|כתוב|תכתוב|תכתבי|נסח|תנסח|תזכיר|תזכירי|תפתח|תפתחי|פתח|צור|תיצור|תעביר|העבר)(?:\s|$)/u;
/** "התשלומים שלי" — סיכום (גם הכפתור) */
const MINE_LIST = /^\P{L}*(?:מה\s+(?:עם\s+)?)?(?:ה)?תשלומים\s+שלי/u;
/** "שלי" / "שעשיתי" — רק של השואל */
const MINE_ONLY = new RegExp(`(?<![${HE}])(?:ש)?(?:עשיתי|שלחתי|פתחתי|העברתי|קלטתי|הגשתי)(?![${HE}])|(?<![${HE}])שלי(?![${HE}])`);

const KIND_RE = {
  receipt: new RegExp(`קבל(?:ת|ות)\\s*(?:ה)?סחור|(?<![${HE}])(?:[הלבמשו]{0,2})קבל(?:ה|ות)(?![${HE}])|תעוד(?:ה|ת|ות)\\s*(?:ה)?משלוח|GR\\s*\\d`, 'i'),
  demand: /דריש(?:ה|ת|ות)/,
  partial: /חלקי|PC\s*\d/i,
  contract: new RegExp(`(?<![${HE}])(?:[הלבמשו]{0,2})חוז(?:ה|ים|י)(?![${HE}])|CO\\s*\\d`, 'i'),
  deal: new RegExp(`עסק(?:ה|ת)(?![${HE}])`),
  order: new RegExp(`(?<![${HE}])(?:[הלבמשו]{0,2})הזמנ(?:ה|ת|ות)(?![${HE}])|PO\\s*\\d`, 'i')
};
/** "הוזמן?" — שאלה על הזמנה בשפה חופשית: "הוזמנה מכולה למגרש 50?" (26.11.26) */
const ORDERED = heWord('הוזמן|הוזמנה|הוזמנו|הזמינו|הזמנו|הזמנתם');
/** מילים שאינן הפריט ("6 מטר") */
const UNITS = new Set(['מטר', 'מטרים', 'מר', 'יח', 'יחידות', 'קוב', 'טון', 'ליטר', 'סמ', 'ממ', 'קג', 'למגרש', 'מגרש', 'בפרויקט', 'לפרויקט', 'פרויקט', 'לאתר', 'באתר']);
const ANY_DOC = new RegExp(`חשבוני(?:ת|ות)|(?<![${HE}])(?:ה)?תשלומ`);
const DOCNO = /(?:^|[^A-Za-z])([A-Za-z]{1,3})?\s*(\d{4,})/;

const STOP = new Set(('של על את עם אם מה מתי איפה האם כבר עוד לא כן זה זו הוא היא שלי שלו שלה לי לו אני אנחנו הזה הזאת '
  + 'ששלחתי שלחתי שעשיתי עשיתי שפתחתי פתחתי שהעברתי העברתי שקלטתי קלטתי שהגשתי הגשתי רכש סחורה הסחורה משלוח '
  + 'חשבון החשבון חשבונית החשבונית חשבוניות המצב קורה קרה עומד עומדת נמצא נמצאת סטטוס ומתי מתי וכמה כמה נשאר יצא בכלל יש אין '
  + 'הפכה הפכו נפתחה נפתח ממנה ממנו האם '
  + 'קבלת תעודת תשלומים חוזים דרישות חשבונות '
  + 'תגיד תגידי תבדוק תבדקי בדוק תראה תראי רוצה לדעת בבקשה היום אתמול בפריוריטי פריוריטי לתשלום ישולם כבר ואם או גם').split(' '));

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const norm = (s) => String(s ?? '').replace(/["'`״׳\-]/g, '').replace(/[ךםןףץ]/g, (c) => FINALS[c]).toLowerCase();
const STOP_N = new Set([...STOP].map(norm));
/** המילה, ובלי אותיות שימוש בתחילתה ("לברזל" ← "ברזל", "שבהגפן" ← "הגפן") */
function variants(w) {
  const out = [w];
  let x = w;
  for (let i = 0; i < 2 && x.length > 3 && 'הלבשומכ'.includes(x[0]); i++) { x = x.slice(1); out.push(x); }
  return out;
}
const isStop = (w) => variants(w).some((v) => STOP.has(v) || STOP_N.has(norm(v))) || PAID.test(w) || ORDERED.test(w) || APPROVED.test(w)
  || Object.values(KIND_RE).some((re) => re.test(w));

/**
 * ‎{ kinds, number, words, personWord, wants: { paid, approved }, howMuch, mineOnly }‎ — טהור, לבדיקות.
 * ‎kinds‎ ריק — כל הסוגים ("חשבונית", מספר מסמך).
 */
function parse(text) {
  const t = String(text ?? '');
  let kinds = Object.keys(KIND_RE).filter((k) => KIND_RE[k].test(t));
  if (kinds.includes('partial')) kinds = kinds.filter((k) => k !== 'contract');   // "החשבון החלקי של החוזה" — החשבון
  if (ORDERED.test(t) && !kinds.includes('order')) kinds.push('order');
  if (kinds.includes('order') && kinds.length > 1) kinds = kinds.filter((k) => k !== 'order');   // "הדרישה הפכה להזמנה?" — הדרישה
  const m = t.match(DOCNO);
  const number = m ? m[2] : '';
  const personWord = (t.match(new RegExp(`(?<![${HE}])של\\s+([${HE}]{2,})`, 'g')) ?? [])
    .map((x) => x.replace(/^של\s+/, '')).find((w) => !STOP.has(w) && !isStop(w)) ?? '';
  const words = t.replace(/[^֐-׿a-zA-Z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !/^[A-Za-z]{1,3}$/.test(w) && !isStop(w)).map(norm);
  const wantsPaid = PAID.test(t) || HOW_MUCH.test(t);
  return {
    kinds, number, words, personWord: norm(personWord),
    wants: { paid: wantsPaid, approved: APPROVED.test(t) || (!wantsPaid && WHERE.test(t)) },
    howMuch: HOW_MUCH.test(t), mineOnly: MINE_ONLY.test(t), text: t
  };
}

/** האם זו שאלה על מצב מסמך — אישור / תשלום / "איפה עומד" + סוג מסמך או מספר. "התשלומים שלי" — גם */
function isRequest(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 300) return false;
  if (MINE_LIST.test(t)) return true;
  if (COMMAND.test(t)) return false;
  if (ORDERED.test(t)) return true;
  const status = PAID.test(t) || APPROVED.test(t) || WHERE.test(t) || HOW_MUCH.test(t);
  const doc = Object.values(KIND_RE).some((re) => re.test(t)) || ANY_DOC.test(t) || /[A-Za-z]{2,3}\s*\d{4,}/.test(t);
  return status && doc;
}

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------

const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const isoDay = (v) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ''; };
const dmy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}` : '');
const money = (n, cur = ILS) => {
  const v = Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 2 });
  return !cur || cur === ILS ? `₪${v}` : `${v} ${cur}`;
};
const realCompanies = () => Settings.companies().filter((c) => !c.test).map((c) => c.code);
const companyName = (code) => Settings.companies().find((c) => c.code === code)?.name ?? code;
const userName = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';
const appRoot = () => String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

/** תקציר הפריטים לשמירה במסמך (‎priority_docs.note‎) — "פטישים, מסמרים 5 ס"מ ועוד 2" */
function itemsNote(items) {
  const names = (Array.isArray(items) ? items : []).map((x) => String(x?.description ?? x?.des ?? x?.PDES ?? '').trim()).filter(Boolean);
  if (!names.length) return '';
  const head = names.slice(0, 3).join(', ');
  return (names.length > 3 ? `${head} ועוד ${names.length - 3}` : head).slice(0, 300);
}

/** סטטוס בפריוריטי ← מצב האישור */
function approvalOf(status) {
  const st = String(status ?? '');
  if (!st) return 'unknown';
  if (/מבוטל|דחי|נדח/.test(st)) return 'cancelled';
  if (/לאישור/.test(st)) return 'waiting';
  if (/טיוט|פתיחה חוזרת/.test(st)) return 'draft';
  return 'approved';
}

async function pool(items, fn, n = PARALLEL) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) out.push(await fn(queue.shift()));
  }));
  return out;
}

let prUsers = null;
async function priorityUsers() {
  if (!prUsers || Date.now() - prUsers.at > 3600000) prUsers = { at: Date.now(), list: await Priority.priorityUsers().catch(() => []) };
  return prUsers.list;
}
async function nameOfLogin(login) {
  if (!login) return '';
  const u = (await Approvals.mesimonUserFor(login).catch(() => null))?.user;
  if (u?.full_name) return u.full_name;
  return (await priorityUsers()).find((x) => String(x.USERLOGIN).toLowerCase() === String(login).toLowerCase())?.SNAME || login;
}

// ---------------------------------------------------------------------------
// מי — של מי המסמכים שמחפשים בהם
// ---------------------------------------------------------------------------

/**
 * ‎{ all, ids, person }‎: ‎all‎ — הכל (הנהלה / כספים, בלי "שלי" ובלי שם); ‎ids‎ — העובדים שהמסמכים שלהם; ‎person‎ — מי שנשאל עליו בשמו.
 */
function scopeOf(actor, q) {
  const me = Number(actor.id);
  const finance = Access.can(actor, 'payments');
  const team = Access.teamOf(me);
  if (q.mineOnly && !q.personWord) return { all: false, ids: new Set([me]), person: null };
  if (q.noAll) return { all: false, ids: new Set([me, ...team]), person: null };
  if (q.personWord) {
    const pool = finance ? D.all("SELECT id, full_name FROM users WHERE status = 'active' AND role <> 'vendor' AND id <> ?", me)
      : [...team].map((id) => ({ id, full_name: userName(id) }));
    const hit = pool.filter((u) => {
      const parts = norm(u.full_name).split(/\s+/);
      return parts[0] === q.personWord || parts.includes(q.personWord);
    });
    if (hit.length === 1) return { all: false, ids: new Set([hit[0].id]), person: hit[0] };
  }
  // הנהלה וכספים — הכל, בחברות שלהם לפי המטריצה של משימון פריוריטי (כמו במסך התשלומים)
  return { all: finance, companies: finance ? new Set(Access.paymentCompanies(actor, realCompanies())) : null, ids: new Set([me, ...team]), person: null };
}

/** שמות המשתמש בפריוריטי של העובדים — ‎[{ id, login }]‎ — לדרישות שנפתחו ישר בפריוריטי, לחוזים ול"ממתין לאישור" */
async function loginPairs(ids) {
  const out = [];
  for (const id of [...ids].slice(0, MAX_LOGINS)) {
    const login = await Approvals.priorityLoginFor({ id }).catch(() => null);
    if (login) out.push({ id: Number(id), login });
  }
  return out;
}
const loginsOf = async (ids) => (await loginPairs(ids)).map((p) => p.login);

// ---------------------------------------------------------------------------
// איסוף — כל המסמכים של העובדים, מכל המקורות, למבנה אחד
// ---------------------------------------------------------------------------

/**
 * מסמך: ‎{ key, kind, company, docno, about, project, note, date, owners, approval: { state, status, signer, since, orders },
 *   pay: { state, payDay, paidAt, paymentRef, invoices, amount, currency, terms } | null, contract }‎
 */
function blank(kind, company, docno) {
  return { key: `${company}:${docno}`, kind, company, docno: String(docno), about: '', project: '', note: '', date: '', owners: [],
    approval: { state: 'unknown', status: '', signer: '', since: '', orders: [] }, pay: null, contract: '' };
}

function payOf(row, d, run) {
  const base = { payDay: row.pay_day || d.payDay || '', paidAt: row.paid_at || '', paymentRef: row.payment_ref || '',
    invoices: json(row.invoices, []), amount: Number(row.amount ?? d.amount ?? 0), currency: d.currency || ILS, terms: d.terms || '' };
  if (row.stage === 'paid') return { ...base, state: 'paid', how: row.paid_how || '' };
  if (row.stage === 'open' && row.paid_how === 'guess') return { ...base, state: 'guess' };
  if (row.stage === 'invoiced') return { ...base, state: 'invoiced' };
  if (row.stage === 'cancelled') return { ...base, state: 'cancelled' };
  if (row.stage === 'gone') return { ...base, state: 'gone' };
  const b = Payments.bucketOf(base.payDay, run);
  return { ...base, state: b === 'late' ? 'late' : b === 'none' ? 'none' : 'scheduled' };
}

async function gather(actor, q, { today } = {}) {
  const scope = scopeOf(actor, q);
  const docs = new Map();
  const put = (it) => {
    const old = docs.get(it.key);
    if (!old) { docs.set(it.key, it); return it; }
    // אותו מסמך משני מקורות — משלימים
    old.about ||= it.about; old.project ||= it.project; old.note ||= it.note; old.date ||= it.date; old.contract ||= it.contract;
    old.projectCode ||= it.projectCode; old.since ||= it.since; old.score ??= it.score;
    old.owners = [...new Set([...old.owners, ...it.owners])];
    if (it.pay && !old.pay) old.pay = it.pay;
    if (old.approval.state === 'unknown' || it.approval.state === 'waiting') old.approval = { ...old.approval, ...it.approval };
    return old;
  };
  const inCompany = (c) => !scope.companies || scope.companies.has(c);
  const mine = (owners, company) => (scope.all ? inCompany(company) : owners.some((o) => scope.ids.has(Number(o))));
  const since = new Date(Date.now() - LOOK_DAYS * DAY).toISOString();

  // 1. מה שנקלט / נפתח בבוט
  const botRows = D.all(`SELECT * FROM priority_docs WHERE org_id = ? AND docno <> '' AND company <> '' AND doc IN ('receipt','demand') AND created_at >= ?`, ORG, since)
    .filter((r) => mine([r.user_id], r.company));
  const botKeys = new Set(botRows.map((r) => `${r.company}:${r.docno}`));
  for (const r of botRows) {
    const it = blank(r.doc, r.company, r.docno);
    it.about = r.supplier; it.note = r.note; it.date = isoDay(r.created_at); it.owners = [r.user_id];
    const st = { draft: 'draft', waiting: 'waiting', cancelled: 'cancelled', rejected: 'cancelled', done: r.doc === 'receipt' ? 'final' : 'unknown' }[r.stage] ?? 'unknown';
    it.approval.state = st;
    put(it);
  }

  // 2. רשימת התשלומים — קבלת סחורה, חשבון חלקי, חשבון עסקה
  const run = Payments.nextRun(today);
  for (const row of D.all('SELECT * FROM payment_items WHERE org_id = ?', ORG)) {
    const d = json(row.data, null);
    if (!d?.ref) continue;
    const owners = d.owners ?? [];
    if (!mine(owners, row.company) && !botKeys.has(`${row.company}:${row.docno}`)) continue;
    const it = blank(row.type, row.company, row.docno);
    it.about = d.supplier?.name || d.supplier?.code || ''; it.project = d.project?.name || ''; it.date = d.date || '';
    it.owners = owners; it.contract = d.contract || '';
    it.pay = payOf(row, d, run);
    // ברשימת התשלומים = כבר אושר / סופי (קבלה סופית, חלקי "אושרה", עסקה "מאושרת")
    it.approval.state = row.stage === 'cancelled' ? 'cancelled' : row.type === 'receipt' ? 'final' : 'approved';
    put(it);
  }

  // 3. חוזים — מהחשבונות החלקיים שלהם (‎contract‎); וכשנשאלים על חוזה — גם מפריוריטי (למטה)
  for (const it of [...docs.values()].filter((x) => x.kind === 'partial' && x.contract)) {
    const c = blank('contract', it.company, it.contract);
    c.about = it.about; c.project = it.project; c.owners = it.owners;
    put(c);
  }

  const live = { errors: [] };
  // 3א. "הוזמן?" — הזמנות הפרויקט מפריוריטי, לפי הפריט (לפני "ממתין לאישור" — כדי לקבל ממנו את החותם)
  if (q.kinds.includes('order')) await liveOrders(actor, q, put, live);

  // 4. מה שמחכה לאישור — החותם הבא. מסמך של העובד (לפי מה שכבר נאסף, או הבעלים בפריוריטי)
  const ownerNames = new Set();
  if (!scope.all) {
    const logins = await loginsOf(scope.ids);
    const users = await priorityUsers();
    for (const l of logins) {
      const u = users.find((x) => String(x.USERLOGIN).toLowerCase() === l.toLowerCase());
      if (u?.SNAME) ownerNames.add(u.SNAME);
      ownerNames.add(l);
    }
  }
  for (const w of D.all('SELECT * FROM priority_waiting WHERE org_id = ?', ORG)) {
    const kind = SCREEN_KIND[w.screen];
    const key = `${w.company}:${w.docno}`;
    if (!kind && !docs.has(key)) continue;
    if (!docs.has(key) && !(scope.all ? inCompany(w.company) : ownerNames.has(w.owner))) continue;
    const it = blank(docs.get(key)?.kind ?? kind, w.company, w.docno);
    it.about = w.party || ''; it.project = w.project || ''; it.date = isoDay(w.since);
    it.approval = { state: 'waiting', status: w.status, signer: w.signer_user_id ? userName(w.signer_user_id) : '', signerLogin: w.signer || '', since: isoDay(w.since), orders: [] };
    if (w.amount != null && !docs.get(key)?.pay) it.amountHint = Number(w.amount);
    put(it);
  }

  if (q.kinds.includes('contract')) await liveContracts(scope, q, put, live);
  // 5. דרישות שנפתחו ישר בפריוריטי (לא בבוט)
  if (q.kinds.includes('demand')) await liveDemands(scope, put, live);

  return { scope, docs: [...docs.values()], errors: live.errors, live };
}

const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** דרישות של העובד מפריוריטי (‎INITUSERLOGIN‎ / ‎OWNERLOGIN‎), בכל החברות */
async function liveDemands(scope, put, live) {
  if (scope.all || !Priority.isEnabled()) return;
  const pairs = await loginPairs(scope.ids);
  if (!pairs.length) return;
  const idOf = (login) => pairs.find((p) => p.login.toLowerCase() === String(login ?? '').toLowerCase())?.id;
  const since = new Date(Date.now() - DEMAND_DAYS * DAY).toISOString().slice(0, 10);
  const jobs = realCompanies().flatMap((c) => chunks(pairs.map((p) => p.login), LOGIN_CHUNK).map((logins) => ({ c, logins })));
  await pool(jobs, async ({ c, logins }) => {
    let list = [];
    try { list = await Priority.myDemands(c, logins, since); } catch (err) { live.errors.push(`${c}: ${err.message}`); return; }
    for (const d of list) {
      const it = blank('demand', c, d.PRDNO);
      it.project = d.PROJDES || ''; it.about = d.PROJDES || ''; it.date = isoDay(d.CURDATE);
      it.note = itemsNote(d.PRDITEMS_SUBFORM);
      it.projectCode = d.PROJDOCNO || ''; it.since = isoDay(d.CURDATE);
      const state = approvalOf(d.STATDES);
      it.approval = { state, status: d.STATDES || '', signerLogin: state === 'waiting' ? (Priority.nextSigner(d) || '') : '', signer: '', since: '', orders: [] };
      it.owners = [idOf(d.INITUSERLOGIN)].filter(Boolean);
      put(it);
    }
  });
}

/**
 * חוזים מפריוריטי (מסך החוזים, קריאה בלבד) — מה שהעובד או המחלקה שלו פתחו (הבעלים / המשתמש בחוזה).
 * הנהלה וכספים — רק לפי מספר ("החוזה CO…"); החוזים מהחשבונות החלקיים ו"ממתין לאישורך" — כבר נאספו.
 */
async function liveContracts(scope, q, put, live) {
  const s = Waiting.screenSpec('MED_PORDERS');
  if (!s || !Priority.isEnabled()) return;
  const lc = (x) => String(x ?? '').toLowerCase();
  const esc = (v) => String(v).replace(/'/g, "''");
  const fields = ['OWNERLOGIN', 'USERLOGIN'].filter((f) => s.fields.includes(f));
  const logins = scope.all ? [] : await loginsOf(scope.ids);
  const mineDoc = (d) => scope.all || fields.some((f) => logins.some((l) => lc(l) === lc(d[f])));
  let filters = [];
  if (q.number) filters = [`contains(${s.key},'${esc(q.number)}')`];
  else if (logins.length && fields.length) filters = chunks(logins, LOGIN_CHUNK).map((ls) => ls.flatMap((l) => fields.map((f) => `${f} eq '${esc(l)}'`)).join(' or '));
  if (!filters.length) return;
  const companies = realCompanies().filter((c) => !scope.companies || scope.companies.has(c));
  await pool(companies.flatMap((c) => filters.map((filter) => ({ c, filter }))), async ({ c, filter }) => {
    let list = [];
    try { list = await Priority.screenDocs(c, s, filter, 50); } catch (err) { if (!Priority.isBlockedScreen(err)) live.errors.push(`${c}: ${err.message}`); return; }
    for (const d of list.filter(mineDoc)) {
      const it = blank('contract', c, d[s.key]);
      it.about = d.CDES || d.SUPDES || ''; it.project = d.PROJDES || ''; it.date = isoDay(d.CURDATE);
      it.total = Number(d.TOTPRICE ?? d.QPRICE ?? 0) || null;
      const state = approvalOf(d.STATDES);
      const g = state === 'waiting' ? Waiting.signerOf(d, s) : {};
      it.approval = { state, status: d.STATDES || '', signerLogin: g.signer || '', signer: '', since: isoDay(g.since), orders: [] };
      it.owners = [];
      put(it);
    }
  });
}

/** מי מחפש בהזמנות: מי שיש לו פריוריטי בבוט (מסמך כלשהו במטריצה), הנהלה וכספים, מנהלי מערכת */
const mayOrders = (actor) => Access.of(actor).docs.length > 0;
const stems = (w) => [...new Set(variants(w).flatMap((v) => (v.length >= 4 ? [v, v.slice(0, -1)] : [v])))];
const ORDER_DAYS = 365;

/**
 * "הוזמנה מכולה 6 מטר למגרש 50?" — הפרויקט מהשאלה (בכל החברות, ההתאמה הטובה ביותר), ובהזמנות שלו בשנה האחרונה —
 * השורות שמתאימות לפריט. בלי פריט — ההזמנות האחרונות של הפרויקט. מבוטלת / נדחתה — לא.
 */
async function liveOrders(actor, q, put, live) {
  if (!mayOrders(actor)) { live.ordersDenied = true; return; }
  if (!Priority.isEnabled()) return;
  // הפרויקט — רק מהמילים של השאלה (בלי "האם", "הוזמן", "מטר") ומהמספרים ("50"); מספר שמופיע בשם — קודם (‎כרמיאל ≠ מגרש 50‎)
  const nums = String(q.text).match(/\d{2,}/g) ?? [];
  const ptext = [...q.words.filter((w) => !UNITS.has(w)), ...nums].join(' ');
  const found = [];
  await pool(realCompanies(), async (c) => {
    const list = await Priority.projects(c).catch(() => []);
    for (const p of Priority.matchProjects(list, ptext)) {
      const numHits = nums.filter((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(p.des)).length;
      found.push({ c, p, rank: numHits * 100 + p.score });
    }
  });
  const best = Math.max(0, ...found.map((x) => x.rank));
  const projects = found.filter((x) => x.rank === best).slice(0, 4);
  if (!projects.length) { live.needProject = true; return; }
  live.projects = [...new Set(projects.map((x) => x.p.des))];
  const inProject = (w) => projects.some((x) => stems(w).some((v) => norm(x.p.des).includes(v)));
  const itemWords = q.words.filter((w) => !UNITS.has(w) && !inProject(w));
  live.itemWords = itemWords;
  const since = new Date(Date.now() - ORDER_DAYS * DAY).toISOString().slice(0, 10);
  await pool(projects, async ({ c, p }) => {
    let orders = [];
    try { orders = await Priority.projectOrders(c, p.code, since); } catch (err) { live.errors.push(`${c}: ${err.message}`); return; }
    for (const o of orders.filter((x) => approvalOf(x.STATDES) !== 'cancelled')) {
      const lines = o.PORDERITEMS_SUBFORM ?? [];
      const scored = lines.map((l) => ({ l, n: itemWords.filter((w) => stems(w).some((v) => norm(l.PDES).includes(v))).length }));
      const score = itemWords.length ? Math.max(0, ...scored.map((x) => x.n)) : 0;
      if (itemWords.length && !score) continue;
      // "משאבת בטון" — רק ההזמנות עם הכי הרבה מילים מהפריט (לא כל הזמנת בטון)
      const shown = (itemWords.length ? scored.filter((x) => x.n === score).map((x) => x.l) : lines).slice(0, 2);
      const it = blank('order', c, o.ORDNAME);
      it.about = o.CDES || ''; it.project = o.PROJDES || p.des; it.date = isoDay(o.CURDATE); it.score = score;
      it.note = shown.map((l) => `${l.PDES} ${Number(l.TQUANT ?? 0).toLocaleString('he-IL')} ${l.TUNITNAME ?? ''}`.trim()
        + (isoDay(l.DUEDATE) ? ` · אספקה ${dmy(isoDay(l.DUEDATE))}` : '')).join(' | ');
      it.approval = { state: approvalOf(o.STATDES), status: o.STATDES || '', signer: '', signerLogin: '', since: '', orders: [] };
      put(it);
    }
  });
}

/** השלמה מפריוריטי למסמכים שנבחרו (עד 3): דרישה — אושרה? הפכה להזמנה? · שם החותם */
async function enrich(list) {
  await pool(list, async (it) => {
    try {
      if (it.kind === 'demand' && Priority.isEnabled() && (!it.projectCode || (['unknown', 'draft', 'waiting'].includes(it.approval.state) && !it.approval.signer))) {
        const d = await Priority.readDemand(it.company, it.docno);
        if (d) {
          const state = approvalOf(d.STATDES);
          if (!(it.approval.state === 'waiting' && it.approval.signer)) {
            it.approval = { ...it.approval, state, status: d.STATDES || '', signerLogin: state === 'waiting' ? (Priority.nextSigner(d) || '') : '' };
          }
          if (!it.note) it.note = itemsNote(d.PRDITEMS_SUBFORM);
          if (!it.project) it.project = d.PROJDES || '';
          it.projectCode = d.PROJDOCNO || ''; it.since = isoDay(d.CURDATE);
        }
      }
      // מדרישה אחת — כמה הזמנות; מספר הדרישה לפעמים רק בשורות ההזמנה (‎ordersOfDemand‎)
      if (it.kind === 'demand' && it.approval.state === 'approved' && Priority.isEnabled()) {
        it.approval.orders = (await Priority.ordersOfDemand(it.company, it.docno, { project: it.projectCode, since: it.since }))
          .filter((o) => approvalOf(o.STATDES) !== 'cancelled');
      }
    } catch (err) { it.liveError = err.message; }
    if (!it.approval.signer && it.approval.signerLogin) it.approval.signer = await nameOfLogin(it.approval.signerLogin);
  });
  return list;
}

// ---------------------------------------------------------------------------
// התאמה לשאלה
// ---------------------------------------------------------------------------

const hay = (it) => norm([it.about, it.project, it.note, it.docno, it.contract, companyName(it.company)].join(' '));

/** המסמכים שמתאימים לשאלה, הכי מתאים והחדש קודם */
function match(docs, q) {
  let list = q.kinds.length ? docs.filter((d) => q.kinds.includes(d.kind)) : docs.filter((d) => d.kind !== 'contract');
  if (q.number) return list.filter((d) => d.docno.replace(/\D/g, '').includes(q.number) || d.docno.replace(/\D/g, '').endsWith(q.number.slice(-6)));
  if (q.words.length) {
    list = list.map((d) => {
      const h = hay(d);
      return { d, score: q.words.filter((w) => variants(w).some((v) => v.length >= 2 && h.includes(v))).length };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || String(b.d.date).localeCompare(String(a.d.date))).map((x) => x.d);
    return list;
  }
  return list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ---------------------------------------------------------------------------
// התשובה
// ---------------------------------------------------------------------------

const gender = (it, m, f) => (KINDS[it.kind]?.f ? f : m);

/** סכומי החוזה: מה שולם ומה ממתין, מהחשבונות החלקיים שלו */
function contractMoney(it) {
  // מי שרואה את החוזה רואה כמה שולם ממנו — כל החשבונות החלקיים שלו, גם של עובדים אחרים
  const run = Payments.nextRun();
  const parts = D.all("SELECT * FROM payment_items WHERE org_id = ? AND company = ? AND type = 'partial'", ORG, it.company)
    .map((row) => ({ row, d: json(row.data, null) })).filter((x) => x.d?.contract === it.docno).map((x) => payOf(x.row, x.d, run));
  const sum = (xs) => xs.reduce((s, p) => s + (p.amount || 0), 0);
  const paid = parts.filter((p) => p.state === 'paid');
  const open = parts.filter((p) => !['paid', 'cancelled'].includes(p.state));
  const next = open.map((p) => p.payDay).filter(Boolean).sort()[0] ?? '';
  return { count: parts.length, paidCount: paid.length, paid: sum(paid), open: sum(open), next };
}

function headline(it, q, docs) {
  const a = it.approval.state;
  if (it.kind === 'contract' && (q.wants.paid || q.howMuch)) {
    const m = contractMoney(it);
    return m.paidCount ? `💰 *שולמו ${money(m.paid)}* מהחוזה (${m.paidCount} ${m.paidCount === 1 ? 'חשבון חלקי' : 'חשבונות חלקיים'})`
      : '❌ *עוד לא שולם* מהחוזה';
  }
  if (q.wants.paid) {
    const p = it.pay;
    if (!p) {
      if (a === 'waiting') return `❌ *עוד לא* — ${gender(it, 'הוא', 'היא')} עוד מחכה לאישור`;
      if (a === 'draft') return '❌ *עוד לא* — עדיין טיוטא בפריוריטי';
      if (a === 'cancelled') return `🗑️ ${gender(it, 'בוטל', 'בוטלה')}`;
      return '❌ *עוד לא שולם* — ועוד לא ברשימת התשלומים';
    }
    return {
      paid: '✅ *כן, שולם*', guess: '🤔 *נראה שכן* — זוהה לפי הסכום, עוד לא ודאי', late: '⚠️ *עוד לא שולם* — וזה באיחור',
      cancelled: `🗑️ ${gender(it, 'בוטל', 'בוטלה')}`
    }[p.state] ?? '❌ *עוד לא שולם*';
  }
  if (a === 'waiting') return `⏳ *עוד לא ${gender(it, 'אושר', 'אושרה')}*`;
  if (a === 'approved') return `✅ *כן, ${gender(it, 'אושר', 'אושרה')}*`;
  if (a === 'final') return '✅ *כן* — הקבלה סופית בפריוריטי';
  if (a === 'draft') return '📝 *עוד לא* — עדיין טיוטא בפריוריטי';
  if (a === 'cancelled') return `🗑️ *${gender(it, 'בוטל', 'בוטלה')}*`;
  return '';
}

function payLine(p) {
  if (!p) return '';
  const amt = p.amount ? ` · ${money(p.amount, p.currency)}` : '';
  switch (p.state) {
    case 'paid': return `💰 שולם ב-*${dmy(p.paidAt) || '—'}*${p.paymentRef ? ` (${p.paymentRef})` : ''}${amt}${p.how === 'amount' ? ' — זוהה לפי סכום' : ''}`;
    case 'guess': return `💰 נראה ששולם ב-${dmy(p.paidAt)}${p.paymentRef ? ` (${p.paymentRef})` : ''}${amt} — זוהה לפי סכום, עוד לא ודאי`;
    case 'invoiced': return `🧾 בחשבונית ${p.invoices.join(', ') || 'ספק'}${p.payDay ? ` · ישולם ב-*${dmy(p.payDay)}*` : ''}${amt}`;
    case 'scheduled': return `📅 ישולם ב-*${dmy(p.payDay)}*${amt}${p.terms ? ` (${p.terms})` : ''}`;
    case 'late': return `⚠️ היה אמור להיות משולם ב-${dmy(p.payDay)}${amt}. כדאי לבדוק עם הנהלת החשבונות`;
    case 'none': return `ℹ️ אין לו תנאי תשלום בפריוריטי, אז מועד התשלום לא ידוע${amt}. כדאי לבדוק עם הנהלת החשבונות`;
    case 'gone': return `ℹ️ יצא מרשימת התשלומים — עוד לא ברור אם עבר לחשבונית או בוטל${amt}`;
    case 'cancelled': return '🗑️ בוטל בפריוריטי';
    default: return '';
  }
}

/** תשובה מלאה על מסמך אחד */
function render(it, q, docs, actorId) {
  const k = KINDS[it.kind];
  const about = [it.about, it.project && it.project !== it.about ? it.project : ''].filter(Boolean).join(' · ');
  const lines = [headline(it, q, docs).trim(), `${k.icon} *${k.label} ${it.docno}*${about ? ` — ${about}` : ''}`];
  if (it.note) lines.push(`📝 ${it.note}`);
  const owner = it.owners.length && !it.owners.map(Number).includes(Number(actorId)) ? userName(it.owners[0]) : '';
  lines.push(`🏢 ${companyName(it.company)}${owner ? ` · של ${owner}` : ''}`);
  const a = it.approval;
  if (a.state === 'waiting') lines.push(`⏳ מחכה לאישור${a.signer ? ` של *${a.signer}*` : ''}${a.since ? ` מ-${dmy(a.since)}` : ''}`);
  else if (a.state === 'draft') lines.push('📝 עדיין טיוטא — עוד לא עבר לאישור');
  if (a.orders?.length) {
    // מדרישה אחת יכולות להיפתח כמה הזמנות (לספקים שונים)
    if (a.orders.length > 1) lines.push(`🧾 נפתחו ממנה ${a.orders.length} הזמנות:`);
    for (const o of a.orders.slice(0, 5)) lines.push(`${a.orders.length > 1 ? '• ' : '🧾 הפכה להזמנה '}*${o.ORDNAME}*${o.CDES ? ` לספק ${o.CDES}` : ''}${o.STATDES ? ` (${o.STATDES})` : ''}`);
  }
  else if (it.kind === 'demand' && a.state === 'approved') lines.push('🧾 עוד לא נפתחה ממנה הזמנה לספק');
  if (it.kind === 'contract') {
    const m = contractMoney(it);
    if (a.status && a.state !== 'waiting') lines.push(`📑 סטטוס בפריוריטי: ${a.status}`);
    if (m.count) {
      lines.push(m.paidCount ? `💰 שולם מהחוזה עד היום: *${money(m.paid)}*${it.total ? ` מתוך ${money(it.total)}` : ''} (${m.paidCount}/${m.count} חשבונות חלקיים)`
        : `💰 עוד לא שולם מהחוזה${it.total ? ` (סכום החוזה ${money(it.total)})` : ''}`);
      if (m.open) lines.push(`📅 ממתין לתשלום: ${money(m.open)}${m.next ? ` · הקרוב ב-*${dmy(m.next)}*` : ''}`);
    } else lines.push('💰 עוד אין חשבונות חלקיים מהחוזה ברשימת התשלומים');
  } else {
    const pl = payLine(it.pay);
    if (pl) lines.push(pl);
    else if (q.wants.paid && ['final', 'approved'].includes(a.state)) lines.push('ℹ️ עוד לא נכנס לרשימת התשלומים ל-15. אם עבר זמן — כדאי לבדוק עם הנהלת החשבונות');
  }
  if (it.liveError) lines.push('ℹ️ לא הצלחתי לבדוק בפריוריטי את המצב העדכני — זה המצב האחרון שידוע לי');
  return lines.filter(Boolean).join('\n');
}

const optionLabel = (it) => `${KINDS[it.kind].short} ${it.docno}`.slice(0, 20);
const brief = (it) => {
  const about = [it.about, it.note].filter(Boolean).join(' · ');
  return `• ${KINDS[it.kind].icon} ${KINDS[it.kind].label} ${it.docno}${about ? ` — ${about}` : ''}${it.date ? ` (${dmy(it.date)})` : ''}`;
};
const kindWords = (q) => (q.kinds.length === 1 ? KINDS[q.kinds[0]].label : 'מסמך');
const MINE_BTN = 'התשלומים שלי 💰';

/** כמה מסמכים מתאימים — שואלים על איזה, בכפתורים (עד 3). ‎draft‎ שומר אותם */
function choose(list, q, { intro } = {}) {
  const top = list.slice(0, MAX_OPTIONS);
  const lines = [intro ?? `מצאתי ${list.length} — על ${q.kinds.length === 1 && KINDS[q.kinds[0]].f ? 'איזו' : 'איזה'}?`, ...top.map(brief)];
  if (list.length > MAX_OPTIONS) lines.push(`יש עוד ${list.length - MAX_OPTIONS}. אפשר לכתוב ספק, פרויקט או מספר.`);
  return {
    text: lines.join('\n'),
    buttons: top.map(optionLabel),
    draft: { kind: KIND, q, options: top },
    result: `${list.length} מסמכים — בחירה`
  };
}

/** "התשלומים שלי" — מה שעוד ממתין, לפי המועד, ומה ששולם בחודש האחרון */
async function mineSummary(actor, { today } = {}) {
  const q = { ...parse(''), noAll: true, wants: { paid: true, approved: false } };
  const { docs } = await gather(actor, q, { today });
  const withPay = docs.filter((d) => d.pay && d.kind !== 'contract');
  const open = withPay.filter((d) => ['scheduled', 'late', 'none', 'invoiced', 'guess'].includes(d.pay.state))
    .sort((a, b) => (a.pay.payDay || '9999').localeCompare(b.pay.payDay || '9999'));
  const monthAgo = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const paid = withPay.filter((d) => d.pay.state === 'paid' && d.pay.paidAt >= monthAgo);
  if (!open.length && !paid.length) return { text: 'אין כרגע מסמכים שלך שמחכים לתשלום, ולא שולם לך כלום בחודש האחרון.', buttons: [], result: 'התשלומים שלי — ריק' };
  const state = (d) => ({ late: '⚠️ באיחור', none: 'בלי מועד', invoiced: `בחשבונית · ${dmy(d.pay.payDay)}`, guess: '🤔 נראה ששולם' }[d.pay.state] ?? dmy(d.pay.payDay));
  const lines = [`💰 *התשלומים שלך*${open.length ? ` — ${open.length} ממתינים` : ''}`];
  for (const d of open.slice(0, 8)) lines.push(`• ${KINDS[d.kind].label} ${d.docno} · ${d.about} · ${money(d.pay.amount, d.pay.currency)} — ${state(d)}`);
  if (open.length > 8) lines.push(`ועוד ${open.length - 8}…`);
  if (paid.length) lines.push(`✅ שולמו בחודש האחרון: ${paid.length} (${money(paid.reduce((s, d) => s + d.pay.amount, 0))})`);
  if (appRoot()) lines.push(`כל הרשימה: ${appRoot()}/priority/payments`);
  return { text: lines.join('\n'), buttons: [], result: `התשלומים שלי: ${open.length} ממתינים, ${paid.length} שולמו` };
}

/**
 * שאלה מהעובד. ‎null‎ — לא שאלה כזו. אחרת ‎{ text, buttons, draft?, result, errors? }‎.
 * ‎actor‎ — ‎{ type: 'user', id, role }‎.
 */
async function request(actor, text, opts = {}) {
  const r = await requestInner(actor, text, opts);
  alertErrors(r?.errors);
  return r;
}

async function requestInner(actor, text, { today } = {}) {
  const t = String(text ?? '').trim();
  if (actor?.type !== 'user' || !isRequest(t)) return null;
  if (MINE_LIST.test(t)) return mineSummary(actor, { today });
  let q = parse(t);
  const { docs, scope, errors, live } = await gather(actor, q, { today });
  if (q.kinds.includes('order')) return { ...(await ordersAnswer(docs, live)), errors };
  // "של יוסי" — השם אינו מילת חיפוש
  if (scope.person) q = { ...q, words: q.words.filter((w) => w !== q.personWord) };
  const list = match(docs, q);
  const who = scope.person ? ` של ${scope.person.full_name}` : q.mineOnly || scope.ids.size === 1 ? ' שלך' : '';
  if (!list.length) {
    const recent = match(docs, { ...q, words: [], number: '' }).slice(0, MAX_OPTIONS);
    const what = `${kindWords(q)}${who}${q.number ? ` מספר ${q.number}` : q.words.length ? ` שמתאים ל"${q.words.join(' ')}"` : ''}`;
    if (recent.length && (q.words.length || q.number)) {
      return { ...choose(recent, q, { intro: `לא מצאתי ${what}. אלה האחרונים:` }), result: `לא נמצא — ${recent.length} אחרונים`, errors };
    }
    return {
      text: `לא מצאתי ${what}.\nאם הוא נפתח בפריוריטי בשם של מישהו אחר — הוא לא משויך אליך.`,
      buttons: [], result: `לא נמצא: ${q.kinds.join(',') || 'כל הסוגים'} ${q.number || q.words.join(' ')}`.trim(), errors
    };
  }
  if (list.length > 1) return { ...choose(list, q), errors };
  const [it] = await enrich(list.slice(0, 1));
  return { text: render(it, q, docs, actor.id), buttons: it.pay ? [MINE_BTN] : [], result: `${it.kind} ${it.docno}: ${it.approval.state}/${it.pay?.state ?? '-'}`, errors };
}

const ORDER_SHOWN = 5;
/** "הוזמן?" — כן / לא, ואז ההזמנות שנמצאו (עד 5): ספק, השורות, הסטטוס, ואצל מי מחכה */
async function ordersAnswer(docs, live) {
  if (live.ordersDenied) return { text: 'חיפוש בהזמנות הרכש פתוח רק למי שעובד עם פריוריטי בבוט. אם צריך — פנו למנהל המערכת.', buttons: [], result: 'הזמנות — אין הרשאה' };
  if (live.needProject) return { text: 'לאיזה פרויקט? כתבו את שם הפרויקט או המגרש, למשל "הוזמנה מכולה למגרש 50?"', buttons: [], result: 'הזמנות — בלי פרויקט' };
  const fin = (w) => w.replace(/[כמנפצ]$/, (c) => ({ 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' })[c]);
  const what = live.itemWords?.length ? `"${live.itemWords.map(fin).join(' ')}"` : 'הזמנות';
  const where = (live.projects ?? []).join(', ');
  const top = Math.max(0, ...docs.filter((d) => d.kind === 'order').map((d) => d.score ?? 0));
  const orders = docs.filter((d) => d.kind === 'order' && (d.score ?? 0) === top)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!orders.length) {
    return { text: `❌ *לא מצאתי הזמנה* של ${what} ב${where} בשנה האחרונה.`, buttons: [], result: `הזמנות — לא נמצא: ${what} / ${where}` };
  }
  await enrich(orders.slice(0, ORDER_SHOWN));
  const st = orders.map((o) => o.approval.state);
  const head = st.includes('approved') ? '✅ *כן, הוזמן*'
    : st.includes('waiting') ? '⏳ *יש הזמנה — עוד לא אושרה*' : '📝 *יש טיוטת הזמנה — עוד לא אושרה*';
  const lines = [`${head} — ${what} ב${where}`];
  for (const o of orders.slice(0, ORDER_SHOWN)) {
    const a = o.approval;
    const status = a.state === 'waiting' ? `מחכה לאישור${a.signer ? ` של ${a.signer}` : ''}` : a.status;
    lines.push(`🧾 *${o.docno}* · ${o.about} · ${status}${o.date ? ` · ${dmy(o.date)}` : ''}`);
    if (o.note) lines.push(`   ${o.note}`);
  }
  if (orders.length > ORDER_SHOWN) lines.push(`ועוד ${orders.length - ORDER_SHOWN} הזמנות.`);
  return { text: lines.join('\n'), buttons: [], result: `הזמנות: ${orders.length} (${what} / ${where})` };
}

/**
 * תשובה לשאלה "על איזה?" — כפתור, מספר המסמך, או מילה שמצמצמת ("של ברזל"). ‎null‎ — לא תשובה לשאלה הזו.
 */
async function answer(actor, draft, text, { today } = {}) {
  if (draft?.kind !== KIND || !Array.isArray(draft.options)) return null;
  const t = String(text ?? '').trim();
  const n = norm(t);
  const digits = n.replace(/\D/g, '');
  const sameNo = (o) => { const d = o.docno.replace(/\D/g, ''); return digits.length >= 2 && (d === digits || (digits.length >= 4 && d.includes(digits))); };
  let pick = draft.options.find((o) => norm(optionLabel(o)) === n || norm(o.docno) === n || sameNo(o));
  if (!pick && !isRequest(t)) {
    const words = n.split(/\s+/).filter((w) => w.length >= 2 && !isStop(w));
    const hits = words.length ? draft.options.filter((o) => words.some((w) => variants(w).some((v) => hay(o).includes(v)))) : [];
    if (hits.length === 1) [pick] = hits;
  }
  if (!pick) return null;
  // המצב העדכני — לא מה שנשמר בשאלה
  const { docs } = await gather(actor, { ...draft.q, number: '', words: [] }, { today });
  const it = docs.find((d) => d.key === pick.key && d.kind === pick.kind) ?? pick;
  await enrich([it]);
  return { text: render(it, draft.q, docs, actor.id), buttons: it.pay ? [MINE_BTN] : [], result: `${it.kind} ${it.docno}: ${it.approval.state}/${it.pay?.state ?? '-'}` };
}

const ALERT_KEY = 'my_docs_alert_at';
const ALERT_GAP = 6 * 3600000;
/** קריאה מפריוריטי נכשלה — לעובד לא (הוא מקבל את מה שידוע), למנהלי המערכת — פעם ב-6 שעות */
function alertErrors(errors) {
  if (!errors?.length) return;
  const last = Number(D.getSetting(ALERT_KEY, 0)) || 0;
  if (Date.now() - last < ALERT_GAP) return;
  D.setSetting(ALERT_KEY, Date.now());
  Approvals.alertAdmins('"מה קרה עם המסמך שלי" — קריאה מפריוריטי נכשלה', `העובד קיבל את המצב האחרון שידוע במשימון. הפרטים: ${errors.slice(0, 3).join(' | ')}`.slice(0, 600));
}

const _reset = () => { prUsers = null; };

module.exports = { KIND, KINDS, MINE_BTN, isRequest, parse, request, answer, itemsNote, approvalOf, match, gather, render, _reset };
