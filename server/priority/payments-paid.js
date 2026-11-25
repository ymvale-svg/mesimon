'use strict';
/**
 * 💰 תשלומים, שלב 2 — "שולם": לכל מסמך שהועבר לתשלום (קבלת סחורה, חשבון חלקי, חשבון עסקה), האם שולם, מתי ובאיזו העברה.
 *
 * האפיונים: "אפיון — רשימת תשלומים ל-15.md" (החלטות לשלב 2) ו"אפיון — מעקב אישורים ותשלומים.md" (סעיף 5). הוחלט 24.11.26:
 *   • השרשרת: מסמך ← GI (חשבונית ספק מרכזת) ← תשלום. GI **לא** נכנס ללוח כשורה — רק החוליה שדרכה עוקבים.
 *   • אין תשלום חלקי. העברה אחת יכולה לסגור כמה חשבוניות — כל אחת מהן "שולם".
 *
 * המקור: כרטיס הספק (‎Priority.payLedger‎ — קריאה אחת לחברה). חשבונית = שורת זכות; תשלום = שורת חובה (העברה, פקודה…).
 *   1. **התאמה בכרטיס** — אותו ‎FRECONNUM‎ (חיובי) לחשבונית ולתשלום: שולם (‎how = recon‎).
 *   2. **בלי התאמה — לפי סכום:** תשלום לאותו ספק באותו סכום, או בסכום של כמה חשבוניות שלו (עד 4) (‎how = amount‎).
 *      תשלום יכול להקדים את החשבונית (חשבון חלקי משולם, ואחר כך מגיעה החשבונית) — עד 60 יום.
 *   3. מסמך שעוד ברשימה (לא הפך לחשבונית) ויש תשלום באותו סכום — **"נראה ששולם"** (‎how = guess‎): מסומן, לא יוצא מהרשימה,
 *      כדי שזיהוי שגוי לא יסתיר חוב.
 *
 * מסמך יוצא מהרשימה של פריוריטי ← "בחשבונית" ← "שולם" כשכל החשבוניות שלו שולמו. קריאה בלבד.
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;

const ORG = 1;
const TOL = 0.05;
const LOOKBACK_DAYS = 400;
const EARLY_DAYS = 60;
const MAX_SUBSET = 4;
const SUBSET_POOL = 12;

const near = (a, b) => Math.abs(a - b) <= TOL;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const maxDate = (xs) => xs.reduce((m, x) => (x > m ? x : m), '');
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** כמה חשבוניות (עד ‎MAX_SUBSET‎) שסכומן ‎amount‎ — הראשונות בתאריך קודם. ‎null‎ — אין */
function subsetFor(cands, amount) {
  const pool = cands.slice(0, SUBSET_POOL);
  const pick = [];
  const walk = (start, sum) => {
    if (pick.length >= 2 && near(sum, amount)) return true;
    if (pick.length === MAX_SUBSET || sum > amount + TOL) return false;
    for (let i = start; i < pool.length; i++) {
      pick.push(pool[i]);
      if (walk(i + 1, sum + pool[i].credit)) return true;
      pick.pop();
    }
    return false;
  };
  return walk(0, 0) ? [...pick] : null;
}

/** כמה תשלומים (עד 3) שסכומם ‎amount‎ — למשל המחאה + זיכוי (חשבונית פחות חשבונית זיכוי) */
function debitsFor(debits, amount) {
  const pool = debits.slice(0, SUBSET_POOL);
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (near(pool[i].debit + pool[j].debit, amount)) return [pool[i], pool[j]];
      for (let k = j + 1; k < pool.length; k++) if (near(pool[i].debit + pool[j].debit + pool[k].debit, amount)) return [pool[i], pool[j], pool[k]];
    }
  }
  return null;
}

/**
 * סוג שורת חובה בכרטיס הספק (הוחלט 25.11.26): **תשלום — רק העברה (BT) או המחאה (CH)**, וגם פקודת יומן שהפרטים שלה
 * אומרים העברה או המחאה ("העב' ל…", "שיק …" — כך נרשמו תשלומים לפני BT / CH; ‎Priority.payLedger‎ נותן להן ‎ref‎
 * "העברה …" / "המחאה …"). זיכוי (CV) נספר רק יחד עם תשלום (חשבונית פחות זיכוי). שאר הפקודות (הוראת קבע וכו') — לא תשלום.
 */
const kindOf = (l) => { const r = String(l.ivnum || l.ref || ''); return /^(BT|העברה)/i.test(r) ? 'transfer' : /^(CH|המחאה)/i.test(r) ? 'cheque' : /^CV/i.test(r) ? 'credit' : 'other'; };
const isPayment = (l) => ['transfer', 'cheque'].includes(kindOf(l));

/** מה סגר את החשבונית: ‎{ date, ref, how, kind }‎ — ‎kind‎: ‎transfer‎ (יש העברה) / ‎cheque‎ (רק המחאות); ‎date‎ — המאוחר (פירעון) */
function closedBy(ds, how) {
  const pays = ds.filter(isPayment);
  return { date: maxDate(pays.map((d) => d.date)), ref: uniq(ds.map((d) => d.ref)).join(', '), how, kind: pays.some((d) => kindOf(d) === 'transfer') ? 'transfer' : 'cheque' };
}

/**
 * התאמת חשבוניות לתשלומים בכרטיסי הספקים (טהור). ‎lines‎ — מ-‎Priority.payLedger‎; ‎today‎ — העברה בתאריך עתידי עוד לא יצאה.
 * המחאה בתאריך עתידי — **הופקה** (נספרת, ‎date‎ = מועד הפירעון; "נפרעה" כשהמועד עבר). שורת חובה שלילית מבטלת תשלום באותו
 * סכום (המחאה שבוטלה). מחזיר ‎{ paid: Map(מספר חשבונית → closedBy), left: [תשלומים שלא נקשרו לשום חשבונית] }‎.
 */
function matchLedger(lines, { today = '9999-12-31' } = {}) {
  const bySup = new Map();
  for (const l of lines) { if (!bySup.has(l.supplier)) bySup.set(l.supplier, []); bySup.get(l.supplier).push(l); }
  const paid = new Map();
  const left = [];
  for (const ls of bySup.values()) {
    const credits = ls.filter((l) => l.credit > 0 && l.ivnum);
    // תשלומים וזיכויים: בלי מה שבוטל (שורה שלילית באותו סכום), ובלי העברה עתידית
    const debits = ls.filter((l) => l.debit > 0 && (isPayment(l) || kindOf(l) === 'credit'));
    for (const neg of ls.filter((l) => l.debit < 0)) {
      const i = debits.findIndex((d) => near(d.debit, -neg.debit));
      if (i >= 0) debits.splice(i, 1);
    }
    for (let i = debits.length - 1; i >= 0; i--) if (debits[i].date > today && kindOf(debits[i]) !== 'cheque') debits.splice(i, 1);
    const used = new Set();
    // 1. התאמה בכרטיס — רק כשיש מולה העברה או המחאה
    for (const c of credits.filter((x) => x.recon > 0)) {
      const ds = debits.filter((d) => d.recon === c.recon);
      if (!ds.some(isPayment)) continue;
      for (const d of ds) used.add(d);
      paid.set(c.ivnum, closedBy(ds, 'recon'));
    }
    // 2. לפי סכום — מה שלא הותאם (מספר התאמה בלי תשלום מולו — כאילו לא הותאם)
    const open = credits.filter((c) => !paid.has(c.ivnum)).sort((a, b) => a.date.localeCompare(b.date));
    const taken = new Set();
    for (const d of debits.filter((x) => isPayment(x) && !used.has(x) && !credits.some((c) => c.recon > 0 && c.recon === x.recon)).sort((a, b) => a.date.localeCompare(b.date))) {
      const cands = open.filter((c) => !taken.has(c) && c.date <= addDays(d.date, EARLY_DAYS));
      const one = cands.find((c) => near(c.credit, d.debit));
      const hit = one ? [one] : subsetFor(cands, d.debit);
      if (!hit) continue;
      used.add(d);
      for (const c of hit) { taken.add(c); paid.set(c.ivnum, closedBy([d], 'amount')); }
    }
    // 3. חשבונית שנסגרה בכמה שורות יחד (המחאה + זיכוי) — חייב להיות בהן תשלום
    for (const c of open.filter((x) => !taken.has(x))) {
      const ds = debitsFor(debits.filter((d) => !used.has(d) && c.date <= addDays(d.date, EARLY_DAYS)).sort((a, b) => a.date.localeCompare(b.date)), c.credit);
      if (!ds || !ds.some(isPayment)) continue;
      for (const d of ds) used.add(d);
      taken.add(c);
      paid.set(c.ivnum, closedBy(ds, 'amount'));
    }
    for (const d of debits) if (!used.has(d) && isPayment(d)) left.push(d);
  }
  return { paid, left };
}

const dm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}` : '');

/**
 * איך שולם — לתצוגה, לאקסל ולמייל (הוחלט 25.11.26): "שולם בהעברה" · "המחאה הופקה, לפירעון …" · "המחאה נפרעה".
 * ‎{ kind: transfer | cheque-issued | cheque-cleared | '', label }‎. ‎today‎ — ‎YYYY-MM-DD‎.
 */
function payStatus({ paidAt = '', paymentRef = '' } = {}, today) {
  const refs = String(paymentRef).split(/,\s*/).filter(Boolean);
  if (!refs.length && !paidAt) return { kind: '', label: '' };
  const transfer = refs.some((r) => /^(BT|העברה)/i.test(r));
  const cheque = !transfer && refs.some((r) => /^(CH|המחאה)/i.test(r));
  const pays = refs.filter((r) => /^(BT|CH|העברה|המחאה)/i.test(r)).join(', ') || refs.join(', ');
  if (cheque && paidAt > today) return { kind: 'cheque-issued', label: `המחאה הופקה ${pays} · לפירעון ${dm(paidAt)}` };
  if (cheque) return { kind: 'cheque-cleared', label: `המחאה נפרעה ${dm(paidAt)} · ${pays}` };
  return { kind: 'transfer', label: `שולם בהעברה ${dm(paidAt)}${pays ? ` · ${pays}` : ''}` };
}

const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

/**
 * מעדכן את השלב של כל מסמך שעוד לא נסגר. מחזיר את מה שעבר עכשיו ל"שולם" (להודעות).
 * ‎companies‎ — קודי החברות; ‎today‎ — ‎YYYY-MM-DD‎.
 */
async function resolvePaid(companies, { today, pool }) {
  const rows = D.all(`SELECT * FROM payment_items WHERE org_id = ? AND (stage IN ('open', 'gone', 'invoiced') OR (stage = 'paid' AND paid_at = ''))`, ORG);
  const byCo = new Map();
  for (const r of rows) if (companies.includes(r.company)) { if (!byCo.has(r.company)) byCo.set(r.company, []); byCo.get(r.company).push(r); }
  const since = addDays(today, -LOOKBACK_DAYS);
  const newlyPaid = [];
  const errors = [];
  await pool([...byCo.entries()].map(([company, list]) => async () => {
    let invoices;
    let ledger;
    try {
      [invoices, ledger] = await Promise.all([Priority.payInvoices(company, since), Priority.payLedger(company, since)]);
    } catch (err) { errors.push({ company, message: err.message }); return; }
    const gisOf = new Map();
    for (const g of invoices) for (const p of g.PIVDOC_SUBFORM ?? []) {
      if (!p.DOCNO) continue;
      if (!gisOf.has(p.DOCNO)) gisOf.set(p.DOCNO, new Set());
      gisOf.get(p.DOCNO).add(g.IVNUM);
    }
    const { paid, left } = matchLedger(ledger, { today });
    const spare = [...left];
    const now = D.nowIso();
    for (const r of list) {
      const data = parse(r.data, {});
      const gis = uniq([...(gisOf.get(r.docno) ?? []), ...parse(r.invoices, [])]).sort();
      const pays = gis.map((g) => paid.get(g));
      const allPaid = gis.length && pays.every(Boolean);
      if (r.stage !== 'open' && allPaid) {
        const how = pays.some((p) => p.how === 'amount') ? 'amount' : 'recon';
        D.run(`UPDATE payment_items SET stage = 'paid', invoices = ?, paid_at = ?, payment_ref = ?, paid_how = ?, stage_at = ? WHERE ref = ?`,
          JSON.stringify(gis), maxDate(pays.map((p) => p.date)), uniq(pays.flatMap((p) => p.ref.split(', '))).join(', '), how, now, r.ref);
        if (r.stage !== 'paid') newlyPaid.push(r.ref);
        continue;
      }
      if (gis.length && JSON.stringify(gis) !== JSON.stringify(parse(r.invoices, []).sort())) {
        D.run('UPDATE payment_items SET invoices = ? WHERE ref = ?', JSON.stringify(gis), r.ref);
      }
      if (r.stage === 'gone' && gis.length) D.run("UPDATE payment_items SET stage = 'invoiced', stage_at = ? WHERE ref = ?", now, r.ref);
      // 3. עוד ברשימה, בלי חשבונית — תשלום באותו סכום: "נראה ששולם" (לא יוצא מהרשימה)
      if (r.stage === 'open' && !gis.length && (r.type === 'partial' || r.type === 'deal')) {
        const amount = Number(data.total ?? r.amount) || 0;
        const i = spare.findIndex((d) => d.supplier === data.supplier?.code && near(d.debit, amount) && d.date >= addDays(data.date || today, -3));
        if (i >= 0) {
          const d = spare.splice(i, 1)[0];
          D.run("UPDATE payment_items SET paid_at = ?, payment_ref = ?, paid_how = 'guess' WHERE ref = ?", d.date, d.ref, r.ref);
        } else if (r.paid_how === 'guess') {
          D.run("UPDATE payment_items SET paid_at = '', payment_ref = '', paid_how = '' WHERE ref = ?", r.ref);
        }
      }
    }
  }));
  return { newlyPaid, errors };
}

module.exports = { matchLedger, subsetFor, resolvePaid, kindOf, payStatus, LOOKBACK_DAYS, EARLY_DAYS };
