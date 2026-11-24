'use strict';
/**
 * 📣 הודעות לרכש מקבלת סחורה (הוחלט 18.11.26, "אפיון — יישום ישיבת הרכש (17.11.26).md", ב1 ו-ב3).
 *
 *   • ב1 — שורה בתעודה שאין לה שורה בהזמנה (למשל "המתנה" בבטון), בקבלה **מול הזמנה**: נקלטת ומסומנת. כשהקבלה הופכת
 *     לסופית — מייל למנהלת הרכש (והתראה במשימון), והרכש מחליט אם לקבל. הבוט לא שואל את העובד ולא עוצר.
 *   • ב3 — קבלה מול הזמנה, כשמספר ההזמנה לא הופיע בתעודה: נרשמת (‎gr_no_po‎). **דוח שבועי** למנהלת הרכש, ביום ראשון
 *     משעת "סיכום הבוקר" (‎digest_morning‎). אין רשומות — אין מייל. קבלה בלי הזמנה — לא נרשמת.
 *
 *   • ב2 — חוסר או פגם מול התעודה (המקבל תיקן כמות): אחרי "סופית" הבוט שואל "לשלוח לספק ולרכש?". כן ← מייל מהתיבה של
 *     העובד אל המייל בכרטיס הספק, ותמיד עותק לרכש; אין מייל לספק — לרכש כנמענת ראשית. בתוכו: הקבלה (PDF), הצילומים,
 *     ופירוט "בתעודה / התקבל" לכל שורה. אין לעובד Gmail מחובר — משרת הדואר של המערכת, ו"השב" לעובד.
 *
 * מנהלת הרכש — ‎PdParts.contact()‎ (הגדרות פריוריטי). לא הוגדרה — ב1: רק בדו-שיח הפנימי; ב3: הרשומות מחכות.
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const Mailer = require('../integrations').Mailer;
const Gmail = require('../integrations').Gmail;
const fs = require('node:fs');
const Parts = require('./pd-parts');

const TZ = 'Asia/Jerusalem';
const TICK = 60 * 60 * 1000;
const KEEP_DAYS = 180;
const LAST = 'gr_no_po_report_last';

const qty = (n) => Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 3 });
const money = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const td = 'style="border:1px solid #ccc;padding:6px 8px"';
const companyName = (c) => Priority.companyOf(c)?.name ?? c;

/** שליחה למנהלת הרכש: שרת הדואר של המערכת (ואם אין — מהתיבה של העובד, כשיש), והתראה במשימון. ‎true‎ — יצא */
async function toBuyer(user, m) {
  const to = Parts.contact();
  if (!to) return false;
  if (to.userId) D.notify({ targetType: 'user', targetId: to.userId, kind: 'ai', title: m.subject, body: m.text.slice(0, 1500) });
  try {
    await Parts._sendMail(user ?? { id: null, full_name: 'משימון' }, m, to);
    return true;
  } catch (err) {
    console.error('[משימון] הודעה לרכש מקבלת סחורה:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// ב1 — שורה שלא בהזמנה
// ---------------------------------------------------------------------------

function extraMail(user, s, lines) {
  const order = s.order?.ordname ?? '';
  const subject = `⚠️ ${lines.length === 1 ? 'שורה שלא בהזמנה' : `${lines.length} שורות שלא בהזמנה`} — ${s.docno} · ${s.supplier?.name ?? ''}`;
  const facts = [['חברה', `${companyName(s.company)} (${s.company})`], ['ספק', `${s.supplier?.name ?? ''} (${s.supplier?.code ?? ''})`],
    ['תעודה', s.doc?.doc_number ?? ''], ['קבלת סחורה', s.docno], ['הזמנה', order], ['נקלטה ע"י', user.full_name]].filter(([, v]) => v);
  const row = (l) => `${l.description} — ${qty(l.qty)} ${l.unit || "יח'"}${Number(l.price) ? ` × ${money(l.price)}` : ''}`;
  const text = [`בקבלת הסחורה ${s.docno} יש ${lines.length === 1 ? 'שורה שאינה' : 'שורות שאינן'} בהזמנה ${order}. הן נקלטו ומחכות להחלטת הרכש — לקבל או לא.`, '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '', ...lines.map((l, i) => `${i + 1}. ${row(l)}`), '', 'בברכה,', 'משימון'].join('\n');
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px">
<p>בקבלת הסחורה <b>${esc(s.docno)}</b> יש ${lines.length === 1 ? 'שורה שאינה' : 'שורות שאינן'} בהזמנה ${esc(order)}. הן נקלטו ומחכות <b>להחלטת הרכש — לקבל או לא</b>.</p>
<p>${facts.map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join('<br>')}</p>
<table style="border-collapse:collapse"><tr><th ${td}>#</th><th ${td}>תיאור</th><th ${td}>כמות</th><th ${td}>יחידה</th><th ${td}>מחיר ליחידה</th></tr>
${lines.map((l, i) => `<tr><td ${td}>${i + 1}</td><td ${td}>${esc(l.description)}</td><td ${td}>${esc(qty(l.qty))}</td><td ${td}>${esc(l.unit || "יח'")}</td><td ${td}>${Number(l.price) ? esc(money(l.price)) : ''}</td></tr>`).join('\n')}
</table><p>בברכה,<br>משימון</p></div>`;
  return { subject, text, html };
}

/**
 * אחרי שהקבלה הפכה לסופית. ‎extra‎ — שורות שלא בהזמנה (כבר בלי שורות הנחה). מחזיר שורה לעובד (או ריק).
 * גם רושם קבלה מול הזמנה שבתעודה שלה לא היה מספר הזמנה (לדוח השבועי).
 */
async function afterFinal(user, s, extra = []) {
  let note = '';
  if (s.order && extra.length) {
    const sent = await toBuyer(user, extraMail(user, s, extra));
    note = `⚠️ ${extra.length === 1 ? 'שורה אחת לא בהזמנה — סומנה' : `${extra.length} שורות לא בהזמנה — סומנו`} לרכש${sent ? ', והרכש מחליט אם לקבל' : ''}.`;
  }
  if (s.order && !String(s.doc?.po_number ?? '').trim()) {
    D.run('INSERT INTO gr_no_po (company, supname, supdes, booknum, docno, ordname, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      s.company, s.supplier?.code ?? '', s.supplier?.name ?? '', String(s.doc?.doc_number ?? ''), s.docno, s.order.ordname ?? '', user.id, D.nowIso());
  }
  return note;
}

// ---------------------------------------------------------------------------
// ב2 — חוסר או פגם: מייל לספק, ועותק לרכש
// ---------------------------------------------------------------------------

function shortageMail(user, s, lines) {
  const subject = `חוסר / פגם בקבלת סחורה — ${s.supplier?.name ?? ''} · תעודה ${s.doc?.doc_number ?? ''} · ${s.docno}`;
  const facts = [['תעודת משלוח', s.doc?.doc_number ?? ''], ['קבלת סחורה', s.docno], ['הזמנה', s.order?.ordname ?? ''],
    ['חברה', companyName(s.company)], ['נקלטה ע"י', user.full_name]].filter(([, v]) => v);
  const notes = (s.corrections ?? []).filter((c) => !/נבנו מחדש|נוספו ע"י/.test(c));
  const text = [`שלום רב,`, '', `בקבלת הסחורה לפי תעודה ${s.doc?.doc_number ?? ''} נמצאו חוסרים / פגמים מול התעודה:`, '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '',
    ...lines.map((l, i) => `${i + 1}. ${l.description} — בתעודה ${qty(l.docQty)}, התקבל בפועל ${qty(l.qty)} ${l.unit || "יח'"} (חסר ${qty(Number(l.docQty) - Number(l.qty))})`),
    notes.length ? `\nהערות המקבל: ${notes.join('; ')}` : null, '', 'מצורפים: הקבלה כפי שנקלטה, ותמונות התעודה החתומה והסחורה.', '', 'בברכה,', user.full_name].filter((x) => x !== null).join('\n');
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px">
<p>שלום רב,</p><p>בקבלת הסחורה לפי תעודה <b>${esc(s.doc?.doc_number ?? '')}</b> נמצאו <b>חוסרים / פגמים</b> מול התעודה:</p>
<p>${facts.map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join('<br>')}</p>
<table style="border-collapse:collapse"><tr><th ${td}>#</th><th ${td}>פריט</th><th ${td}>בתעודה</th><th ${td}>התקבל בפועל</th><th ${td}>חסר</th></tr>
${lines.map((l, i) => `<tr><td ${td}>${i + 1}</td><td ${td}>${esc(l.description)}</td><td ${td}>${esc(qty(l.docQty))}</td><td ${td}>${esc(qty(l.qty))} ${esc(l.unit || "יח'")}</td><td ${td}>${esc(qty(Number(l.docQty) - Number(l.qty)))}</td></tr>`).join('\n')}
</table>${notes.length ? `<p>הערות המקבל: ${esc(notes.join('; '))}</p>` : ''}
<p>מצורפים: הקבלה כפי שנקלטה, ותמונות התעודה החתומה והסחורה.</p><p>בברכה,<br>${esc(user.full_name)}</p></div>`;
  return { subject, text, html };
}

/**
 * שולח את מייל החוסר. ‎files‎ — ‎[{ buf, fileName, mime }]‎ (הקבלה כ-PDF) + ‎paths‎ — הצילומים שבקבלה.
 * ‎{ ok, to, cc, noSupplierEmail }‎ — לעובד: לאן יצא.
 */
async function sendShortage(user, s, lines, { files = [], photos = [] } = {}) {
  const buyer = Parts.contact();
  let supplier = '';
  try { supplier = (await Priority.supplierContact(s.company, s.supplier?.code))?.email ?? ''; } catch (err) { console.error('[משימון] כרטיס הספק:', err.message); }
  const to = supplier || buyer?.email;
  if (!to) return { ok: false, error: 'אין מייל לספק בכרטיס, ולא הוגדרה מנהלת רכש' };
  const cc = supplier && buyer?.email ? [buyer.email] : [];
  const attachments = [...files];
  photos.forEach((f, i) => {
    try { attachments.push({ buf: fs.readFileSync(f.path), fileName: `תמונה ${i + 1}.${String(f.mime).includes('pdf') ? 'pdf' : String(f.mime).includes('png') ? 'png' : 'jpg'}`, mime: f.mime || 'image/jpeg' }); } catch { /* נמחק */ }
  });
  const m = shortageMail(user, s, lines);
  const me = D.get('SELECT email, full_name FROM users WHERE id = ?', user.id);
  const msg = { to, toName: supplier ? s.supplier?.name : buyer?.name, cc, subject: m.subject, text: m.text, html: m.html, attachments };
  try {
    const conn = Gmail.connectionOf(user.id);
    if (conn?.email) await Gmail.send(user.id, Mailer.buildMessage({ ...msg, from: conn.email, fromName: user.full_name }).raw);
    else if (Mailer.isEnabled()) await Mailer.send({ ...msg, replyTo: me?.email || undefined, replyToName: me?.full_name });
    else throw new Error('אין לעובד תיבת Gmail מחוברת, ואין שרת דואר במערכת');
  } catch (err) {
    console.error('[משימון] מייל חוסר / פגם:', err.message);
    return { ok: false, error: err.message };
  }
  if (buyer?.userId) D.notify({ targetType: 'user', targetId: buyer.userId, kind: 'ai', title: m.subject, body: m.text.slice(0, 1500) });
  return { ok: true, to, cc, noSupplierEmail: !supplier };
}

// ---------------------------------------------------------------------------
// ב3 — דוח שבועי: תעודות בלי מספר הזמנה
// ---------------------------------------------------------------------------

const ilNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, sunday: p.weekday === 'Sun' };
};

function reportMail(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.company}|${r.supname}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const groups = [...by.values()].sort((a, b) => b.length - a.length);
  const name = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';
  const subject = `📋 תעודות משלוח בלי מספר הזמנה — ${rows.length} בשבוע האחרון`;
  const text = [`תעודות משלוח שנקלטו מול הזמנה, אבל מספר ההזמנה לא הופיע בהן (${rows.length}), לפי ספק:`, '',
    ...groups.flatMap((g) => [`${g[0].supdes} (${g[0].supname}, ${g[0].company}) — ${g.length}`,
      ...g.map((r) => `  • תעודה ${r.booknum || '—'} · ${ymdHe(r.created_at)} · ${r.docno} · הזמנה ${r.ordname} · ${name(r.user_id)}`), '']),
    'לפי הנוהל, מספר ההזמנה חייב להופיע בכל תעודה וחשבונית.', '', 'בברכה,', 'משימון'].join('\n');
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px">
<p>תעודות משלוח שנקלטו מול הזמנה, אבל <b>מספר ההזמנה לא הופיע בהן</b> (${rows.length}), לפי ספק:</p>
${groups.map((g) => `<h4 style="margin:12px 0 4px">${esc(g[0].supdes)} (${esc(g[0].supname)}, ${esc(g[0].company)}) — ${g.length}</h4>
<table style="border-collapse:collapse"><tr><th ${td}>תעודה</th><th ${td}>תאריך</th><th ${td}>קבלה</th><th ${td}>הזמנה</th><th ${td}>נקלטה ע"י</th></tr>
${g.map((r) => `<tr><td ${td}>${esc(r.booknum || '—')}</td><td ${td}>${esc(ymdHe(r.created_at))}</td><td ${td}>${esc(r.docno)}</td><td ${td}>${esc(r.ordname)}</td><td ${td}>${esc(name(r.user_id))}</td></tr>`).join('')}</table>`).join('\n')}
<p>לפי הנוהל, מספר ההזמנה חייב להופיע בכל תעודה וחשבונית.</p><p>בברכה,<br>משימון</p></div>`;
  return { subject, text, html };
}

/** ביום ראשון, משעת סיכום הבוקר — פעם אחת. ‎{ sent, rows }‎ */
async function weekly({ force = false } = {}) {
  const now = ilNow();
  const at = String(D.getSetting('digest_morning', '08:15') ?? '08:15');
  if (!force && (!now.sunday || now.hm < at || D.getSetting(LAST, '') === now.date)) return { sent: false, rows: 0 };
  D.run('DELETE FROM gr_no_po WHERE created_at < ?', new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
  const rows = D.all('SELECT * FROM gr_no_po WHERE reported_at IS NULL ORDER BY created_at');
  if (!Parts.contact()) return { sent: false, rows: rows.length };
  D.setSetting(LAST, now.date);
  if (!rows.length) return { sent: false, rows: 0 };
  if (!(await toBuyer(null, reportMail(rows)))) return { sent: false, rows: rows.length };
  const stamp = D.nowIso();
  for (const r of rows) D.run('UPDATE gr_no_po SET reported_at = ? WHERE id = ?', stamp, r.id);
  return { sent: true, rows: rows.length };
}

let timer = null;
function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { weekly().catch((err) => console.error('[משימון] דוח תעודות בלי מספר הזמנה:', err.message)); }, TICK);
  timer.unref?.();
}

module.exports = { afterFinal, sendShortage, weekly, start, _shortageMail: shortageMail, _extraMail: extraMail, _reportMail: reportMail };
