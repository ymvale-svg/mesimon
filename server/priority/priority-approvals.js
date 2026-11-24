'use strict';
/**
 * אישורים בפריוריטי — "החותם הבא" מקבל הודעה בוואטסאפ.
 *
 * אי אפשר לאשר דרך הבוט (האישור — בפריוריטי). מה שהבוט עושה: לכל מסמך בסטטוס "מחכה לאישור" — **בכל סבבי
 * האישורים** (הוחלט 24.11.26): דרישת רכש, הזמנת רכש, חוזה, חשבון חלקי, חשבון עסקה (‎Priority.APPROVAL_KINDS‎) —
 * הוא מוצא את החותם הבא (‎Priority.approvalSigner‎), מתרגם את שם המשתמש בפריוריטי ("Eladh", "MatanR") למשתמש
 * משימון, ושולח לו פעם אחת: "ממתין לך בפריוריטי … לאישורך". עבר לחותם הבא — גם הוא מקבל.
 * כמה מסמכים חדשים לאותו חותם באותו סבב — הודעה אחת מרוכזת (‎digestFor‎). האפיון: "אפיון — מעקב אישורים ותשלומים.md".
 *
 * התרגום (‎mesimonUserFor‎): מסך משתמשי פריוריטי (‎USERSB‎) נותן לכל שם משתמש מייל ושם בעברית.
 *   1. מיפוי ידני — ההגדרה ‎priority_user_map‎: ‎{ "Eladh": 12 }‎ (קודם לכל השאר);
 *   2. המייל — זהה למייל של משתמש משימון;
 *   3. השם — שם פרטי ומשפחה (בכל סדר) זהים לשם המלא במשימון.
 * לא נמצא, או שאין לו טלפון — מנהלי המערכת מקבלים התראה (פעם אחת לכל משתמש).
 * "קיבל" נרשם רק כשההודעה יצאה בפועל; מחוץ לשעות הפעילות — הסבב שולח כשהחלון נפתח.
 *
 * באילו חברות (הוחלט 08.11.26): כל החברות המוכרות — האמיתיות (קריאה בלבד; אין צורך בהגדרה) ועותק הבדיקה כשהוא פתוח.
 * ההגדרה ‎pd_notify_companies‎ (מערך קודים) — רק אם רוצים לצמצם.
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Settings = require('./priority-settings');

const NOTIFIED = 'pd_approval_notified';
const UNMAPPED = 'pd_approval_unmapped';
const NO_PHONE = 'pd_approval_nophone';
const FAILED = 'pd_approval_failed';
const MAX_FAILS = 3;
const EVERY = 10 * 60 * 1000;
const KEEP = 60 * 24 * 60 * 60 * 1000;

const words = (t) => String(t ?? '').replace(/["'״׳()\-]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

function alertAdmins(title, body) {
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🛒 ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על אישורים בפריוריטי:', err.message);
  }
}

/** משתמש משימון לפי שם משתמש בפריוריטי. ‎{ user, how, pr }‎ — ‎user‎ ‎null‎ כשלא נמצא */
async function mesimonUserFor(login) {
  const l = String(login ?? '').trim();
  if (!l) return { user: null, how: null, pr: null };
  const manual = (D.getSetting('priority_user_map', {}) ?? {})[l];
  if (manual) {
    const u = D.get("SELECT id, full_name, email, phone FROM users WHERE id = ? AND status = 'active'", Number(manual));
    if (u) return { user: u, how: 'manual', pr: null };
  }
  const list = await Priority.priorityUsers();
  const pr = list.find((x) => x.USERLOGIN.toLowerCase() === l.toLowerCase()) ?? null;
  if (!pr) return { user: null, how: null, pr: null };
  const users = D.all("SELECT id, full_name, email, phone FROM users WHERE status = 'active' AND role <> 'vendor'");
  const mail = String(pr.EMAIL ?? '').trim().toLowerCase();
  let u = mail ? users.find((x) => String(x.email ?? '').trim().toLowerCase() === mail) : null;
  if (u) return { user: u, how: 'email', pr };
  const names = [words(`${pr.FIRSTNAME ?? ''} ${pr.FAMILYNAME ?? ''}`), words(pr.SNAME)].filter((x) => x.includes(' '));
  const hits = users.filter((x) => names.includes(words(x.full_name)));
  if (hits.length === 1) return { user: hits[0], how: 'name', pr };
  return { user: null, how: null, pr };
}

/** הכיוון ההפוך: שם המשתמש בפריוריטי של משתמש משימון (לפי המייל, ואם אין — השם), לבעלים של המסמך. ‎null‎ — לא נמצא */
async function priorityLoginFor(user) {
  const manual = Object.entries(D.getSetting('priority_user_map', {}) ?? {}).find(([, id]) => Number(id) === Number(user?.id));
  if (manual) return manual[0];
  const list = (await Priority.priorityUsers().catch(() => [])).filter((x) => /עובד פעיל/.test(x.STATDES ?? 'עובד פעיל'));
  const u = user?.email ? user : D.get('SELECT id, full_name, email FROM users WHERE id = ?', user?.id);
  const mail = String(u?.email ?? '').trim().toLowerCase();
  const byMail = mail ? list.filter((x) => String(x.EMAIL ?? '').trim().toLowerCase() === mail) : [];
  if (byMail.length === 1) return byMail[0].USERLOGIN;
  const name = words(u?.full_name);
  const byName = name.includes(' ') ? list.filter((x) => [words(`${x.FIRSTNAME ?? ''} ${x.FAMILYNAME ?? ''}`), words(x.SNAME)].includes(name)) : [];
  return byName.length === 1 ? byName[0].USERLOGIN : null;
}

/** כל משתמשי פריוריטי והתרגום שלהם — למסך הניהול ולבדיקה */
async function mapping() {
  const out = [];
  for (const pr of await Priority.priorityUsers()) {
    if (!/עובד פעיל/.test(pr.STATDES ?? 'עובד פעיל')) continue;
    const m = await mesimonUserFor(pr.USERLOGIN);
    out.push({ login: pr.USERLOGIN, name: pr.SNAME ?? '', position: pr.POSITIONDES ?? '', mesimon: m.user ? { id: m.user.id, name: m.user.full_name, phone: Boolean(m.user.phone) } : null, how: m.how });
  }
  return out;
}

// מסך ההגדרות (‎priority-settings.js‎); עד השמירה הראשונה — ‎pd_notify_companies‎, או כל האמיתיות + הפתוחות לכתיבה
const companies = () => Settings.pdNotifyCompanies();

/** הסוגים שהסבב עובר עליהם, לפי הסדר: דרישת רכש, ואחריה כל השאר (‎Priority.APPROVAL_KINDS‎) */
const KINDS = () => ['demand', ...Object.keys(Priority.APPROVAL_KINDS)];
const kindOf = (kind) => (kind === 'demand' ? { label: 'דרישת רכש', icon: '🛒', key: 'PRDNO', date: 'CURDATE' } : Priority.APPROVAL_KINDS[kind]);
/** שם המסמך בהודעה. חוזה ‎CH‎ — שינוי בחוזה */
const labelOf = (kind, d) => (kind === 'contract' && d?.MED_TYPE === 'CH' ? 'שינוי בחוזה' : kindOf(kind).label);
const numOf = (kind, d) => d?.[kindOf(kind).key] ?? '';
const dmy = (iso) => String(iso).slice(0, 10).split('-').reverse().join('.');
const money = (d) => (Number(d?.TOTPRICE) > 0 ? `${Math.round(Number(d.TOTPRICE)).toLocaleString('he-IL')} ${d.CODE || 'ש"ח'}` : null);
const where = (company) => (Priority.isTest(company) ? `🧪 ${company} (סביבת בדיקה)` : `🏢 ${Priority.companyOf(company).name}`);
/** מפתח "כבר קיבל". בדרישת רכש — בלי הסוג (כמו לפני ההרחבה, כדי לא לשלוח שוב) */
const keyOf = (company, kind, d, signer) => (kind === 'demand' ? `${company}:${d.PRDNO}:${signer}` : `${company}:${kind}:${numOf(kind, d)}:${signer}`);

function messageFor(company, d, owner, kind = 'demand') {
  const k = kindOf(kind);
  const label = labelOf(kind, d);
  if (kind === 'demand') {
    const items = (d.PRDITEMS_SUBFORM ?? []).length;
    return [
      `🛒 ממתינה לך בפריוריטי *דרישת רכש ${d.PRDNO}* לאישורך.`,
      `${where(company)}${d.PROJDES ? ` · 📁 ${d.PROJDES}` : ''}`,
      [owner ? `נפתחה ע"י ${owner}` : null, items ? (items === 1 ? 'פריט אחד' : `${items} פריטים`) : null, d.CURDATE ? `מ-${dmy(d.CURDATE)}` : null].filter(Boolean).join(' · '),
      '',
      'האישור — בפריוריטי (מהבוט אי אפשר לאשר).'
    ].join('\n');
  }
  return [
    `${k.icon} ממתין לך בפריוריטי *${label} ${numOf(kind, d)}* לאישורך.`,
    `${where(company)}${d.PROJDES ? ` · 📁 ${d.PROJDES}` : ''}`,
    [d[k.supplier] ? `🤝 ${d[k.supplier]}` : null, money(d)].filter(Boolean).join(' · '),
    [owner ? `נשלח ע"י ${owner}` : null, d[k.date] ? `מ-${dmy(d[k.date])}` : null].filter(Boolean).join(' · ')
  ].filter(Boolean).concat('', 'האישור — בפריוריטי (מהבוט אי אפשר לאשר).').join('\n');
}

const MAX_LINES = 10;
/** כמה מסמכים לאותו חותם באותו סבב — הודעה אחת מרוכזת */
function digestFor(items) {
  const lines = items.slice(0, MAX_LINES).map(({ company, kind, d }) =>
    `• ${kindOf(kind).icon} *${labelOf(kind, d)} ${numOf(kind, d)}*${[d[kindOf(kind).supplier], money(d), Priority.isTest(company) ? `🧪 ${company}` : Priority.companyOf(company).name].filter(Boolean).map((x) => ` · ${x}`).join('')}`);
  const more = items.length - MAX_LINES;
  return [
    `✍️ ממתינים לאישורך בפריוריטי *${items.length} מסמכים*:`,
    ...lines,
    more > 0 ? `ועוד ${more}.` : null,
    '',
    'האישור — בפריוריטי (מהבוט אי אפשר לאשר).'
  ].filter((x) => x !== null).join('\n');
}

async function ownerName(login) {
  if (!login) return '';
  const list = await Priority.priorityUsers().catch(() => []);
  const pr = list.find((x) => x.USERLOGIN === login);
  // יש מסמכים שבהם היוזם רשום בשם מלא ולא בשם משתמש — מציגים כמו שהוא
  return pr?.SNAME || login;
}

/** פעם אחת לכל מפתח — ‎true‎ כשזו הפעם הראשונה. המפתחות בקטלוג (מצב פנימי), לכן בלי שם הגדרה במשתנה */
function onceIn(seen, key, save) {
  if (seen[key]) return false;
  seen[key] = Date.now();
  save(seen);
  return true;
}
const firstTimeUnmapped = (key) => onceIn(D.getSetting(UNMAPPED, {}) ?? {}, key, (v) => D.setSetting(UNMAPPED, v));
const firstTimeNoPhone = (key) => onceIn(D.getSetting(NO_PHONE, {}) ?? {}, key, (v) => D.setSetting(NO_PHONE, v));

/**
 * למי ההודעה על מסמך אחד, ואם אפשר לשלוח לו. ‎{ signer, user, key, why }‎ — ‎why‎ ריק = לשלוח.
 * חותם שלא נמצא במשימון, או שאין לו טלפון — מנהלי המערכת מקבלים התראה (פעם אחת לכל משתמש).
 */
async function planFor(company, kind, d) {
  const signer = Priority.approvalSigner(kind, d);
  const doc = `${labelOf(kind, d)} ${numOf(kind, d)} (${company})`;
  if (!signer) return { signer: null, user: null, key: null, why: 'אין חותם בא (אין רשימת מאשרים)' };
  const key = keyOf(company, kind, d, signer);
  const m = await mesimonUserFor(signer);
  if ((D.getSetting(NOTIFIED, {}) ?? {})[key]) return { signer, user: m.user, key, why: 'כבר קיבל' };
  if (!m.user) {
    if (firstTimeUnmapped(signer)) {
      alertAdmins(`החותם הבא ${signer} לא נמצא במשימון`, [`${doc} מחכה לאישור של ${signer}${m.pr?.SNAME ? ` (${m.pr.SNAME})` : ''}.`,
        'לא נמצא משתמש משימון עם אותו מייל או אותו שם, ולכן לא נשלחה לו הודעה בוואטסאפ.',
        'לתיקון: מייל זהה בשני המקומות, או מיפוי ידני בהגדרה priority_user_map.'].join('\n'));
    }
    return { signer, user: null, key, why: 'לא נמצא במשימון' };
  }
  if (!m.user.phone) {
    // בלי טלפון אין לאן לשלוח — מנהלי המערכת יודעים (פעם אחת לכל משתמש), כדי להשלים את הפרופיל
    if (firstTimeNoPhone(String(m.user.id))) {
      alertAdmins(`לחותם ${m.user.full_name} אין טלפון במשימון`, [`${doc} מחכה לאישור של ${m.user.full_name} (${signer}),`,
        'אבל בפרופיל שלו במשימון אין מספר טלפון, ולכן לא נשלחה לו הודעה בוואטסאפ.',
        'לתיקון: להוסיף טלפון בפרופיל — ההודעה תצא בסבב הבא (עד 10 דקות).'].join('\n'));
    }
    return { signer, user: m.user, key, why: 'אין טלפון בפרופיל' };
  }
  return { signer, user: m.user, key, why: '' };
}

/**
 * תוצאת שליחה אחת (על מסמך אחד או כמה) — ‎res‎ מ-‎send‎: ‎true‎ יצאה · ‎'later'‎ מחוץ לשעות · ‎false‎ לא יצאה.
 * רק הודעה שיצאה נרשמת כ"קיבל". נכשלה — ניסיון בכל סבב, ואחרי ‎MAX_FAILS‎ — התראה למנהלי המערכת (פעם אחת).
 */
function record(res, user, keys, docs) {
  if (res === 'later') return { sent: false, later: true, why: 'מחוץ לשעות הפעילות' };
  const fails = D.getSetting(FAILED, {}) ?? {};
  if (res === true) {
    const done = D.getSetting(NOTIFIED, {}) ?? {};
    for (const k of keys) done[k] = Date.now();
    for (const [x, at] of Object.entries(done)) if (Date.now() - at > KEEP) delete done[x];
    D.setSetting(NOTIFIED, done);
    if (keys.some((k) => fails[k])) { for (const k of keys) delete fails[k]; D.setSetting(FAILED, fails); }
    return { sent: true, why: '' };
  }
  let alert = false;
  for (const k of keys) { fails[k] = (fails[k] ?? 0) + 1; if (fails[k] === MAX_FAILS) alert = true; }
  D.setSetting(FAILED, fails);
  if (alert) {
    alertAdmins(`ההודעה לחותם ${user.full_name} לא נשלחה`, [`${docs} מחכה לאישור של ${user.full_name}.`,
      `הבוט ניסה ${MAX_FAILS} פעמים לשלוח לו הודעה בוואטסאפ, ולא הצליח (הפירוט ביומן הבוט, פעולה purchase_demand).`,
      'הבוט ממשיך לנסות כל 10 דקות.'].join('\n'));
  }
  return { sent: false, why: 'הבוט לא שלח' };
}

/**
 * הודעה לחותם הבא של מסמך אחד — אם עוד לא קיבל עליו. ‎send(userId, text)‎. ‎{ signer, user, sent, later, why }‎
 */
async function notifyDoc(company, kind, d, send) {
  const p = await planFor(company, kind, d);
  if (p.why) return { signer: p.signer, user: p.user, sent: false, why: p.why };
  const res = await send(p.user.id, messageFor(company, d, await ownerName(d.OWNERLOGIN || d.INITUSERLOGIN), kind));
  return { signer: p.signer, user: p.user, ...record(res, p.user, [p.key], `${labelOf(kind, d)} ${numOf(kind, d)} (${company})`) };
}
const notifyDemand = (company, d, send) => notifyDoc(company, 'demand', d, send);

/** המסמכים שמחכים לאישור מסוג אחד בחברה */
const waiting = (c, kind) => (kind === 'demand' ? Priority.waitingDemands(c) : Priority.waitingForApproval(c, kind));

let lastRun = 0;
/**
 * סבב: כל המסמכים שמחכים לאישור, מכל הסוגים, בחברות שבהגדרה. פעם ב-10 דקות לכל היותר.
 * חותם שיש לו באותו סבב כמה מסמכים חדשים — מקבל הודעה אחת מרוכזת (למשל בפעם הראשונה, כשמצטברים מסמכים ישנים).
 */
async function sweep(send, { force = false } = {}) {
  if (!Priority.isEnabled() || (!force && Date.now() - lastRun < EVERY)) return [];
  lastRun = Date.now();
  const out = [];
  const byUser = new Map();
  for (const c of companies()) {
    for (const kind of KINDS()) {
      let list = [];
      try { list = await waiting(c, kind); } catch (err) { console.error(`[משימון] ${kindOf(kind).label} שמחכים לאישור (${c}):`, err.message); continue; }
      for (const d of list) {
        try {
          const p = await planFor(c, kind, d);
          const row = { company: c, kind, no: numOf(kind, d), ...(kind === 'demand' ? { prdno: d.PRDNO } : {}), signer: p.signer, user: p.user, sent: false, why: p.why };
          out.push(row);
          if (!p.why) {
            if (!byUser.has(p.user.id)) byUser.set(p.user.id, { user: p.user, items: [] });
            byUser.get(p.user.id).items.push({ company: c, kind, d, key: p.key, row });
          }
        } catch (err) { console.error(`[משימון] הודעה על ${numOf(kind, d)}:`, err.message); }
      }
    }
  }
  for (const { user, items } of byUser.values()) {
    try {
      const one = items.length === 1 ? items[0] : null;
      const text = one ? messageFor(one.company, one.d, await ownerName(one.d.OWNERLOGIN || one.d.INITUSERLOGIN), one.kind) : digestFor(items);
      const docs = items.map((x) => `${labelOf(x.kind, x.d)} ${numOf(x.kind, x.d)} (${x.company})`).join(', ');
      const r = record(await send(user.id, text), user, items.map((x) => x.key), docs);
      for (const x of items) Object.assign(x.row, r);
    } catch (err) { console.error(`[משימון] הודעה לחותם ${user.full_name}:`, err.message); }
  }
  return out;
}

module.exports = { mesimonUserFor, priorityLoginFor, mapping, notifyDemand, notifyDoc, sweep, messageFor, digestFor, KINDS, MAX_FAILS, _words: words };
