'use strict';
/**
 * 🧾 הזמנת רכש הועברה לספק — כשהזמנת רכש בפריוריטי הופכת לסופית, מנהל הפרויקט ויוזם הדרישה מקבלים אותה:
 * הספק, הפריטים, הכמויות והמחירים, ו-PDF של ההזמנה. בוואטסאפ מהבוט ובמייל.
 *
 * • **מתי:** סריקה כל 10 דקות (פריוריטי לא מודיע בעצמו). הזמנה בסטטוס סופי (‎PO_FINAL_STATUSES‎, ברירת המחדל
 *   "אושרה", "נשלחה לספק") שעוד לא נשלחה עליה התראה. מעבר בין שני הסטטוסים — התראה אחת. גרסה חדשה של הזמנה
 *   (‎CURVERSION‎ — "פתיחה חוזרת" ואישור מחדש) — התראה נוספת, "עודכנה".
 * • **הסריקה הראשונה** (וכל הפעלה מחדש של הפעולה בהגדרות הבוט) רושמת את ההזמנות הסופיות הקיימות בלי לשלוח.
 * • **למי:** מנהל הפרויקט — ‎MUSERLOGIN‎ במסך הפרויקטים; יוזם הדרישה — ‎INITUSERLOGIN‎ בדרישת הרכש (מהכותרת
 *   ומהשורות). המשתמש בפריוריטי ← שם ומייל (‎USERSB‎). מייל — לכתובת הזו; וואטסאפ — למשתמש משימון עם אותו מייל
 *   וטלפון בפרופיל, בשעות הפעילות של הבוט (מחוץ להן — ממתין). משתמשי מערכת (‎master‎ וכו') — לא.
 * • **סביבת בדיקה** (‎test11‎): רק למנהלי המערכת, עם "במקום: …".
 * • **קריאה בלבד** מפריוריטי. כשל — ליומן הבוט ולמנהלי המערכת, לא לעובד.
 *
 * החברות: ‎PO_NOTIFY_COMPANIES‎ (מופרד בפסיקים), ואם אין — כל החברות שהבוט מכיר. חברה שה-API שלה סגור
 * להזמנות — נדחית ל-6 שעות.
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const Mailer = require('../integrations').Mailer;
const WaActions = require('../whatsapp').WaActions;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const { orderPdf } = require('./po-pdf');
const { escape, shell } = require('../core').MailTemplates;

const TICK = 10 * 60 * 1000;
const PER_TICK = 10;
const MAX_ATTEMPTS = 5;
const PENDING_DAYS = 3;
const BACKOFF = 6 * 60 * 60 * 1000;

const WaBot = require('../whatsapp').WaBot;

const finalStatuses = () => String(process.env.PO_FINAL_STATUSES || 'אושרה,נשלחה לספק').split(',').map((s) => s.trim()).filter(Boolean);
const companies = () => {
  const env = String(process.env.PO_NOTIFY_COMPANIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return env.length ? env : Priority.COMPANIES.map((c) => c.code);
};
/** משתמשי מערכת / ספק התוכנה — אינם מנהלי פרויקט אמיתיים */
const SYSTEM_LOGIN = /^(master|medatech|tabula|api\b|api\s)/i;
const SYSTEM_MAIL = /@medatech\.com$/i;

const enabled = () => Priority.isEnabled() && Boolean(WaActions.byKey('po_notify')?.enabled);

const money = (n) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const ymd = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const cur = (c) => (c === 'ש"ח' || !c ? '₪' : c);

// ---------------------------------------------------------------------------
// מנהלי המערכת — התראה על תקלה
// ---------------------------------------------------------------------------

const admins = () => D.all("SELECT id, full_name, email, phone FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")
  .filter((u) => { const a = Auth.loadActor('user', u.id); return a && P.can(a, 'manage_automations'); });

function alertAdmins(title, body) {
  try {
    for (const u of admins()) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🧾 הזמנת רכש: ${title}`, body });
  } catch (err) {
    console.error('[משימון] התראה למנהלים על הזמנת רכש:', err.message);
  }
}

function log(result, status = 'ok', text = '') {
  try { WaBot.log({ channel: 'summary', action: 'po_notify', who: 'פריוריטי', text, result, status }); } catch { /* בלי יומן */ }
}

// ---------------------------------------------------------------------------
// נמענים
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{manager: ?object, initiators: object[], recipients: Array<{name, email, login, roles: string[], userId: ?number, phone: string}>}>}
 */
async function recipientsOf(company, po) {
  const people = new Map(); // login → { roles }
  const add = (login, role) => {
    if (!login || SYSTEM_LOGIN.test(login)) return;
    const e = people.get(login) ?? { login, roles: [] };
    if (!e.roles.includes(role)) e.roles.push(role);
    people.set(login, e);
  };
  if (po.PROJDOCNO) add(await Priority.projectManager(company, po.PROJDOCNO), 'manager');
  const demands = [...new Set([po.PRDNO, ...po.lines.map((l) => l.PRDNO)].filter(Boolean))];
  for (const prdno of demands) add(await Priority.demandInitiator(company, prdno), 'initiator');

  const byEmail = new Map();
  let manager = null;
  const initiators = [];
  for (const p of people.values()) {
    const u = await Priority.priorityUser(company, p.login);
    if (p.roles.includes('manager')) manager = u ?? { login: p.login, name: p.login };
    if (p.roles.includes('initiator')) initiators.push(u ?? { login: p.login, name: p.login });
    if (!u?.active || !u.email || SYSTEM_MAIL.test(u.email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) continue;
    const key = u.email.toLowerCase();
    const m = D.get("SELECT id, full_name, phone FROM users WHERE lower(email) = ? AND status = 'active'", key);
    const e = byEmail.get(key) ?? { name: m?.full_name || u.name, email: u.email, login: u.login, roles: [], userId: m?.id ?? null, phone: m?.phone ?? '' };
    for (const r of p.roles) if (!e.roles.includes(r)) e.roles.push(r);
    byEmail.set(key, e);
  }
  return { manager, initiators, recipients: [...byEmail.values()] };
}

/** בסביבת בדיקה — מנהלי המערכת במקום הנמענים האמיתיים */
function testRecipients() {
  return admins().map((u) => ({ name: u.full_name, email: u.email, login: '', roles: ['test'], userId: u.id, phone: u.phone ?? '' }));
}

// ---------------------------------------------------------------------------
// ההודעה
// ---------------------------------------------------------------------------

const roleText = (roles) => {
  if (roles.includes('test')) return 'כמנהל מערכת — סביבת בדיקה';
  const t = [];
  if (roles.includes('manager')) t.push('כמנהל הפרויקט');
  if (roles.includes('initiator')) t.push('כיוזם דרישת הרכש');
  return t.join(' ו');
};

function subjectOf(po, { updated, test }) {
  return `${test ? '[בדיקה] ' : ''}הזמנת הרכש בפרויקט שלך ${updated ? 'עודכנה והועברה' : 'הועברה'} לספק — ${po.ORDNAME}${po.PROJDES ? ` · ${po.PROJDES}` : ''}`;
}

const lineText = (l, c) => `• ${qty(l.TQUANT)} ${l.TUNITNAME ?? ''} — ${l.PDES ?? l.PARTNAME ?? ''}${l.PRICE ? ` · ${money(l.PRICE)} ${c}` : ''}${l.QPRICE ? ` = ${money(l.QPRICE)} ${c}` : ''}`.replace(/\s+—/, ' —');

const MAX_LINES_WA = 15;
function waText(po, r, ctx) {
  const c = cur(po.CODE);
  const due = [...new Set(po.lines.map((l) => ymd(l.DUEDATE || l.REQDATE)).filter(Boolean))];
  return [
    `🧾 *הזמנת הרכש בפרויקט שלך ${ctx.updated ? 'עודכנה והועברה' : 'הועברה'} לספק*${ctx.test ? ' (סביבת בדיקה)' : ''}`,
    `${po.ORDNAME}${po.PROJDES ? ` · 📁 ${po.PROJDES}` : ''}`,
    `🏪 ספק: *${po.CDES ?? po.SUPNAME ?? ''}*`,
    due.length ? `📅 אספקה: ${due.slice(0, 3).join(', ')}` : null,
    '',
    ...po.lines.slice(0, MAX_LINES_WA).map((l) => lineText(l, c)),
    po.lines.length > MAX_LINES_WA ? `…ועוד ${po.lines.length - MAX_LINES_WA} שורות — בקובץ` : null,
    '',
    `💰 לפני מע"מ: *${money(po.DISPRICE)} ${c}* · כולל מע"מ: ${money(po.TOTPRICE)} ${c}`,
    ctx.test ? `👥 במקום: ${ctx.realNames || 'אין נמענים'}` : `👤 קיבלת את ההודעה ${roleText(r.roles)}.`,
    '📄 ההזמנה המלאה — בקובץ המצורף.'
  ].filter((x) => x !== null).join('\n');
}

function mailOf(po, r, ctx) {
  const c = cur(po.CODE);
  const td = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;';
  const num = `${td}text-align:left;white-space:nowrap;`;
  const rows = po.lines.map((l, i) => `<tr><td style="${td}">${i + 1}</td><td style="${td}">${escape(l.PDES ?? '')}<div style="color:#94a3b8;font-size:12px;">${escape(l.PARTNAME ?? '')}${l.REMARK ? ` · ${escape(l.REMARK)}` : ''}</div></td>`
    + `<td style="${num}">${escape(`${qty(l.TQUANT)} ${l.TUNITNAME ?? ''}`)}</td><td style="${num}">${money(l.PRICE)}${l.PERCENT ? `<div style="color:#94a3b8;font-size:12px;">-${qty(l.PERCENT)}%</div>` : ''}</td><td style="${num}">${money(l.QPRICE)}</td></tr>`).join('');
  const field = (k, v) => (v ? `<tr><td style="padding:2px 0;color:#475569;width:110px;">${escape(k)}</td><td style="padding:2px 0;">${escape(v)}</td></tr>` : '');
  const due = [...new Set(po.lines.map((l) => ymd(l.DUEDATE || l.REQDATE)).filter(Boolean))].join(', ');
  const bodyHtml = `
          <div style="font-size:20px;font-weight:800;margin-bottom:6px;">הזמנת הרכש בפרויקט שלך ${ctx.updated ? 'עודכנה והועברה' : 'הועברה'} לספק</div>
          ${ctx.test ? '<div style="color:#a33;font-weight:700;">סביבת בדיקה — אינה הזמנה אמיתית</div>' : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0;font-size:14px;">
            ${field('הזמנה', `${po.ORDNAME} · ${po.STATDES ?? ''}`)}${field('פרויקט', po.PROJDES)}${field('ספק', po.CDES ?? po.SUPNAME)}
            ${field('אספקה', due)}${field('מנהל הפרויקט', ctx.managerName)}${field('יוזם הדרישה', ctx.initiatorNames)}${field('חברה', ctx.companyLabel)}
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
            <tr style="background:#f1f5f9;font-weight:700;"><td style="${td}">#</td><td style="${td}">פריט</td><td style="${num}">כמות</td><td style="${num}">מחיר</td><td style="${num}">סה"כ</td></tr>
            ${rows}
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:14px;">
            ${po.PERCENT ? field(`הנחת מסמך ${qty(po.PERCENT)}%`, `-${money(po.QPRICE - po.DISPRICE)} ${c}`) : ''}
            ${field('לפני מע"מ', `${money(po.DISPRICE)} ${c}`)}${field('מע"מ', `${money(po.VAT)} ${c}`)}
            <tr><td style="padding:4px 0;font-weight:800;">כולל מע"מ</td><td style="padding:4px 0;font-weight:800;">${money(po.TOTPRICE)} ${escape(c)}</td></tr>
          </table>
          <div style="margin-top:16px;color:#475569;font-size:13px;">${ctx.test ? `במקום: ${escape(ctx.realNames || 'אין נמענים')}` : `קיבלת את ההודעה ${escape(roleText(r.roles))}.`} ההזמנה המלאה — ב-PDF המצורף.</div>`;
  const text = [
    `הזמנת הרכש בפרויקט שלך ${ctx.updated ? 'עודכנה והועברה' : 'הועברה'} לספק${ctx.test ? ' (סביבת בדיקה)' : ''}`,
    `הזמנה: ${po.ORDNAME} · פרויקט: ${po.PROJDES ?? ''} · ספק: ${po.CDES ?? po.SUPNAME ?? ''}`,
    '',
    ...po.lines.map((l) => lineText(l, c)),
    '',
    `לפני מע"מ: ${money(po.DISPRICE)} ${c} · כולל מע"מ: ${money(po.TOTPRICE)} ${c}`
  ].join('\n');
  return {
    subject: subjectOf(po, ctx),
    html: shell({ title: subjectOf(po, ctx), bodyHtml, footerHtml: 'הודעה אוטומטית ממשימון, לפי הזמנת הרכש בפריוריטי. אינה טופס ההזמנה הרשמי.' }),
    text
  };
}

// ---------------------------------------------------------------------------
// שליחה
// ---------------------------------------------------------------------------

/** הכנת ההזמנה: הנתונים, הנמענים וה-PDF */
async function prepare(company, ordname, { updated = false } = {}) {
  const po = await Priority.orderForNotice(company, ordname);
  const test = Priority.isTest(company);
  const who = await recipientsOf(company, po);
  const label = (u) => (u ? u.name || u.login : '');
  const ctx = {
    updated, test,
    companyLabel: Priority.companyOf(company).name,
    managerName: label(who.manager),
    initiatorNames: who.initiators.map(label).join(', '),
    realNames: who.recipients.map((r) => `${r.name} (${roleText(r.roles).replace(/^כ/, '')})`).join(', ')
  };
  const recipients = test ? testRecipients() : who.recipients;
  const file = {
    buf: orderPdf(po, { companyLabel: ctx.companyLabel, test, manager: ctx.managerName, initiators: who.initiators.map(label), updated }),
    fileName: `${po.ORDNAME}.pdf`, mime: 'application/pdf'
  };
  return { po, ctx, recipients, file };
}

async function sendWa(r, prep) {
  const ok = await WaBot.sendFilesToUser(r.userId, {
    files: [{ ...prep.file, caption: '' }], text: waText(prep.po, r, prep.ctx),
    action: 'po_notify', result: `🧾 ${prep.po.ORDNAME} (${roleText(r.roles)})`
  });
  return ok;
}

/** הזמנה אחת: מייל לכל נמען עכשיו, וואטסאפ — בשעות הפעילות (אחרת ממתין) */
async function notifyOrder(company, ordname, { updated = false } = {}) {
  const prep = await prepare(company, ordname, { updated });
  const done = [];
  const failed = [];
  const waPending = [];
  const waNow = WaBot.inHours();
  for (const r of prep.recipients) {
    const m = mailOf(prep.po, r, prep.ctx);
    if (Mailer.isEnabled() && r.email) {
      try {
        await Mailer.send({ to: r.email, toName: r.name, subject: m.subject, html: m.html, text: m.text, attachments: [prep.file] });
        done.push(`📧 ${r.name}`);
      } catch (err) {
        failed.push(`מייל ל${r.name} (${r.email}): ${err.message}`);
      }
    }
    if (r.userId) {
      D.notify({ targetType: 'user', targetId: r.userId, kind: 'ai', title: `🧾 ${m.subject}`, body: m.text.slice(0, 1500) });
      if (r.phone) {
        if (!waNow) { waPending.push(r); continue; }
        try {
          if (await sendWa(r, prep)) done.push(`💬 ${r.name}`);
        } catch (err) {
          failed.push(`וואטסאפ ל${r.name}: ${err.message}`);
        }
      }
    }
  }
  return { prep, done, failed, waPending };
}

function record(company, ordname, version, fields) {
  const now = D.nowIso();
  D.run(
    `INSERT INTO po_notices (company, ordname, version, status, recipients, wa_pending, attempts, error, created_at, sent_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company, ordname) DO UPDATE SET version = excluded.version, status = excluded.status, recipients = excluded.recipients,
       wa_pending = excluded.wa_pending, attempts = excluded.attempts, error = excluded.error, sent_at = excluded.sent_at`,
    company, ordname, version, fields.status, JSON.stringify(fields.recipients ?? []), JSON.stringify(fields.waPending ?? []),
    fields.attempts ?? 0, String(fields.error ?? '').slice(0, 1000), now, fields.status === 'sent' ? now : null
  );
}

async function handle(company, o, row) {
  const version = Number(o.CURVERSION) || 1;
  const updated = Boolean(row && row.status !== 'error' && version > row.version);
  const attempts = row?.status === 'error' ? row.attempts + 1 : 1;
  try {
    const { prep, done, failed, waPending } = await notifyOrder(company, o.ORDNAME, { updated });
    const names = prep.recipients.map((r) => `${r.name} <${r.email}>`);
    if (!prep.recipients.length) {
      record(company, o.ORDNAME, version, { status: 'none', recipients: [] });
      log(`🧾 ${o.ORDNAME} (${company}) — אין למי לשלוח: לא נמצא מייל למנהל הפרויקט וליוזם הדרישה בפריוריטי`, 'unclear');
      return;
    }
    record(company, o.ORDNAME, version, {
      status: 'sent', recipients: names, error: failed.join('\n'),
      waPending: waPending.map((r) => ({ userId: r.userId, roles: r.roles, name: r.name }))
    });
    log(`🧾 ${o.ORDNAME} (${company}) ${updated ? 'עודכנה' : 'הועברה לספק'} — ${[...done, ...waPending.map((r) => `⏳ ${r.name}`)].join(', ') || 'לא נשלח'}${failed.length ? ` · נכשל: ${failed.join('; ')}` : ''}`, failed.length ? 'error' : 'ok');
    if (failed.length) alertAdmins(`שליחה על ${o.ORDNAME} נכשלה חלקית`, [`חברה: ${company}`, ...failed].join('\n'));
  } catch (err) {
    record(company, o.ORDNAME, row?.version ?? version, { status: 'error', attempts, error: err.message });
    log(`🧾 ${o.ORDNAME} (${company}) — ${err.message} (ניסיון ${attempts})`, 'error');
    if (attempts >= MAX_ATTEMPTS) alertAdmins(`לא נשלחה התראה על ${o.ORDNAME}`, `חברה: ${company}\n${err.message}`);
  }
}

/** וואטסאפ שחיכה לשעות הפעילות */
async function flushPending() {
  if (!WaBot.inHours()) return;
  const since = new Date(Date.now() - PENDING_DAYS * 86400000).toISOString();
  for (const row of D.all("SELECT * FROM po_notices WHERE wa_pending <> '[]' LIMIT 10")) {
    if ((row.sent_at ?? row.created_at) < since) { D.run("UPDATE po_notices SET wa_pending = '[]' WHERE company = ? AND ordname = ?", row.company, row.ordname); continue; }
    let pending = [];
    try { pending = JSON.parse(row.wa_pending); } catch { /* ריק */ }
    D.run("UPDATE po_notices SET wa_pending = '[]' WHERE company = ? AND ordname = ?", row.company, row.ordname);
    try {
      const prep = await prepare(row.company, row.ordname, { updated: row.version > 1 });
      for (const p of pending) {
        const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", p.userId);
        if (!u?.phone) continue;
        await sendWa({ ...p, name: u.full_name, userId: u.id, phone: u.phone }, prep).catch((err) => log(`🧾 ${row.ordname} — וואטסאפ ל${u.full_name}: ${err.message}`, 'error'));
      }
    } catch (err) {
      log(`🧾 ${row.ordname} (${row.company}) — וואטסאפ שהמתין: ${err.message}`, 'error');
    }
  }
}

// ---------------------------------------------------------------------------
// סריקה
// ---------------------------------------------------------------------------

const skipUntil = new Map();
let busy = false;
let timer = null;

async function scanCompany(company) {
  if ((skipUntil.get(company) ?? 0) > Date.now()) return;
  let list;
  try {
    list = await Priority.finalOrders(company, finalStatuses());
  } catch (err) {
    skipUntil.set(company, Date.now() + BACKOFF);
    console.error(`[משימון] הזמנות רכש (${company}) — לא נקרא, נדחה ל-6 שעות:`, err.message);
    return;
  }
  const baseline = D.getSetting('po_notify_baseline', {}) ?? {};
  const known = new Map(D.all('SELECT * FROM po_notices WHERE company = ?', company).map((r) => [r.ordname, r]));
  if (!baseline[company]) {
    for (const o of list) if (!known.has(o.ORDNAME)) record(company, o.ORDNAME, Number(o.CURVERSION) || 1, { status: 'baseline' });
    D.setSetting('po_notify_baseline', { ...baseline, [company]: D.nowIso() });
    return;
  }
  let n = 0;
  for (const o of list) {
    if (n >= PER_TICK) break;
    const row = known.get(o.ORDNAME);
    const version = Number(o.CURVERSION) || 1;
    const due = !row
      || (row.status === 'error' && row.attempts < MAX_ATTEMPTS)
      || (row.status !== 'error' && version > row.version);
    if (!due) continue;
    n += 1;
    await handle(company, o, row);
  }
}

async function tick() {
  if (busy) return;
  if (!enabled()) {
    // כבוי — בהפעלה הבאה הסריקה הראשונה שוב רק רושמת, כדי שלא תישלח הצפה של הזמנות ישנות
    if (Object.keys(D.getSetting('po_notify_baseline', {}) ?? {}).length) D.setSetting('po_notify_baseline', {});
    return;
  }
  busy = true;
  try {
    for (const c of companies()) await scanCompany(c);
    await flushPending();
  } catch (err) {
    console.error('[משימון] סבב התראות הזמנות רכש נכשל:', err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), TICK);
  timer.unref?.();
  setTimeout(() => void tick(), 60000).unref?.();
}

module.exports = { start, tick, notifyOrder, prepare, _internal: { waText, mailOf, recipientsOf, scanCompany, subjectOf } };
