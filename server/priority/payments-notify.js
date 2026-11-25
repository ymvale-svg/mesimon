'use strict';
/**
 * 💰 תשלומים, שלב 2 — ההודעות (הוחלט 24.11.26, "אפיון — מעקב אישורים ותשלומים.md" סעיף 5):
 *   • **שולם** — למי שהעביר לתשלום, למנהל המחלקה שלו, ולמי שבהגדרה "מי עוד מקבל 'שולם' ממחלקה" (‎paidCc‎ בהגדרות
 *     משימון פריוריטי — למשל המזכירות מקבלת את כל ה"שולם" של מחלקת התכנון). מייל והתראה במשימון.
 *   • **לא שולם ב-15** — רק למי שהעביר לתשלום: מה שעוד ממתין, או כבר בחשבונית ועוד לא שולם. בימים 16–20 בחודש, פעם אחת
 *     לכל מסמך ולכל מועד. לא על חשבונות הסבה.
 *   • "שולם" = העברה או המחאה (הוחלט 25.11.26). המחאה שמועד הפירעון שלה עוד לא הגיע — "הופקה המחאה, לפירעון …".
 * רק על מה שקרה מהיום שבו ההודעות הופעלו (‎payments_notify_from‎) — לא מציפים על תשלומים ישנים.
 * "נראה ששולם" (זיהוי לפי סכום, עוד ברשימה) — לא נשלח, כי עוד לא ודאי.
 */
const D = require('../core').Db;
const T = require('../core').MailTemplates;
const Mailer = require('../integrations').Mailer;
const Settings = require('./priority-settings');
const Paid = require('./payments-paid');

const ORG = 1;
const FROM_KEY = 'payments_notify_from';
const TYPE_LABEL = { receipt: 'קבלת סחורה', partial: 'חשבון חלקי', deal: 'חשבון עסקה' };
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const dmy = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const money = (n) => `₪${Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const appRoot = () => String(D.getSetting('public_url', '') || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

/** מאיזה יום שולחים — נקבע בפעם הראשונה */
function notifyFrom() {
  let v = D.getSetting(FROM_KEY, null);
  if (!v) { v = D.nowIso().slice(0, 10); D.setSetting(FROM_KEY, v); }
  return v;
}

/** חשבון הסבה — לא שולחים "לא שולם". לפי המילה "הסבה" בפרויקט, בספק או בחוזה (לבדוק מול פריוריטי — שאלה פתוחה באפיון) */
const isConversion = (d) => /הסבה/.test([d.project?.name, d.supplier?.name, d.contract].filter(Boolean).join(' '));

/** מי מקבל "שולם": מי שהעביר, מנהל המחלקה שלו, ומי שבהגדרה למחלקה שלו */
function paidRecipients(owners) {
  const cc = Settings.defaults().paidCc ?? {};
  const out = new Set(owners);
  for (const id of owners) {
    const dept = D.get('SELECT department_id FROM users WHERE id = ?', id)?.department_id;
    if (!dept) continue;
    const mgr = D.get('SELECT manager_user_id FROM departments WHERE id = ?', dept)?.manager_user_id;
    if (mgr) out.add(mgr);
    for (const x of cc[dept] ?? []) out.add(Number(x));
  }
  return [...out];
}

function message(kind, d, row) {
  const doc = `${TYPE_LABEL[d.type] ?? d.type} ${d.docno}`;
  const sup = d.supplier?.name || d.supplier?.code || '';
  const company = Settings.companies().find((c) => c.code === d.company)?.name ?? d.company;
  const st = Paid.payStatus({ paidAt: row.paid_at, paymentRef: row.payment_ref }, D.nowIso().slice(0, 10));
  const subject = kind === 'paid' ? `💰 ${st.kind === 'cheque-issued' ? 'הופקה המחאה' : 'שולם'}: ${sup} — ${doc}` : `⏳ לא שולם ב-${dmy(d.payDay)}: ${sup} — ${doc}`;
  const lines = [
    ['חברה', company], ['ספק', sup], ['מסמך', `${doc}${d.booknum ? ` (אסמכתא ${d.booknum})` : ''}`], ['סכום', money(d.amount)],
    ...(kind === 'paid'
      ? [['תשלום', `${st.label || '—'}${row.paid_how === 'amount' ? ' (זוהה לפי סכום)' : ''}`]]
      : [['מועד התשלום', dmy(d.payDay)]]),
    ['פרויקט', d.project?.name ?? ''], ['יוזם', d.initiatorName || d.initiator || '']
  ].filter(([, v]) => v);
  const intro = kind === 'paid' ? (st.kind === 'cheque-issued' ? 'הופקה המחאה לספק.' : 'התשלום יצא.') : 'המסמך היה אמור להיות משולם ב-15 ועדיין מחכה. כדאי לבדוק עם הנהלת החשבונות.';
  const link = appRoot() ? `${appRoot()}/priority/payments` : '';
  const html = T.shell({
    title: subject,
    bodyHtml: `<p style="margin:0 0 14px;font-weight:700;font-size:17px;">${T.escape(subject)}</p><p style="margin:0 0 12px;">${T.escape(intro)}</p>
      <table role="presentation" cellpadding="6" style="border-collapse:collapse;font-size:14px;">${lines.map(([k, v]) => `<tr><td style="color:#475569">${T.escape(k)}</td><td><b>${T.escape(v)}</b></td></tr>`).join('')}</table>
      ${link ? T.button(link, 'לתשלומים במשימון') : ''}`,
    footerHtml: 'משימון — תשלומים. ההודעה נשלחת אוטומטית לפי פריוריטי.'
  });
  const text = [subject, intro, ...lines.map(([k, v]) => `${k}: ${v}`), link].filter(Boolean).join('\n');
  return { subject, html, text };
}

async function send(userIds, m) {
  for (const id of userIds) {
    const u = D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active' AND role <> 'vendor'", id);
    if (!u) continue;
    D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: m.subject, body: m.text.slice(0, 1500) });
    if (Mailer.isEnabled() && u.email) {
      try { await Mailer.send({ to: u.email, toName: u.full_name, subject: m.subject, html: m.html, text: m.text }); } catch (err) {
        console.error(`[משימון] תשלומים — מייל ל${u.full_name}:`, err.message);
      }
    }
  }
}

const mark = (ref, n) => D.run('UPDATE payment_items SET notified = ? WHERE ref = ?', JSON.stringify(n), ref);

/** "שולם" — על מה שעבר עכשיו ל"שולם" (‎refs‎). מחזיר כמה נשלחו */
async function paid(refs) {
  const from = notifyFrom();
  let sent = 0;
  for (const ref of refs) {
    const row = D.get('SELECT * FROM payment_items WHERE ref = ? AND org_id = ?', ref, ORG);
    if (!row || row.stage !== 'paid') continue;
    const n = json(row.notified, {});
    if (n.paid) continue;
    const d = json(row.data, {});
    n.paid = !row.paid_at || row.paid_at >= from ? D.nowIso() : 'old';   // תשלום מלפני שההודעות הופעלו — בלי הודעה
    if (n.paid !== 'old') {
      const to = paidRecipients(d.owners ?? []);
      if (to.length) { await send(to, message('paid', d, row)); sent += 1; }
    }
    mark(ref, n);
  }
  return sent;
}

/** "לא שולם ב-15" — בימים 16–20, למי שהעביר, על מה שהיה אמור לצאת ב-15 של החודש ועדיין ברשימה */
async function unpaid({ today }) {
  const day = Number(String(today).slice(8, 10));
  if (day < 16 || day > 20) return 0;
  const run = `${String(today).slice(0, 8)}15`;
  if (run < notifyFrom()) return 0;
  let sent = 0;
  // עוד ממתין בפריוריטי, או כבר בחשבונית ועוד לא שולם (תוקן 25.11.26 — קודם רק הראשון)
  const rows = D.all("SELECT * FROM payment_items WHERE org_id = ? AND stage IN ('open', 'invoiced') AND pay_day = ? AND paid_how <> 'guess'", ORG, run);
  for (const row of rows) {
    const n = json(row.notified, {});
    if (n.unpaid === run) continue;
    const d = json(row.data, {});
    n.unpaid = run;
    if (!isConversion(d) && (d.owners ?? []).length) { await send(d.owners, message('unpaid', d, row)); sent += 1; }
    mark(row.ref, n);
  }
  return sent;
}

module.exports = { paid, unpaid, paidRecipients, isConversion, message, FROM_KEY };
