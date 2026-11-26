'use strict';
/**
 * אישורים בפריוריטי — "החותם הבא" מקבל הודעה בוואטסאפ.
 *
 * אי אפשר לאשר דרך הבוט (האישור — בפריוריטי). מה שהבוט עושה: לכל דרישת רכש בסטטוס "מחכה לאישור", הוא
 * מוצא את החותם הבא (‎Priority.nextSigner‎ — ‎USERLOGIN‎ בכותרת, או המאשר הראשון שעוד לא אישר), מתרגם את
 * שם המשתמש בפריוריטי ("Eladh", "MatanR") למשתמש משימון, ושולח לו פעם אחת: "ממתינה לך בפריוריטי דרישת
 * רכש … לאישורך". עבר לחותם הבא — גם הוא מקבל.
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

/**
 * שם במשימון מול שם בפריוריטי (26.11.26 — "חנה גנות" במשימון = "חנה (חני) גנוט" בפריוריטי, וזה גם שם המשתמש שלה שם):
 *   • כתיב: אותיות סופיות כרגילות, ט = ת, "וו" / "יי" כפולים כאחד.
 *   • כל המילים של השם הקצר (לפחות שתיים) נמצאות בשם הארוך — כינוי בסוגריים ("חני") או שם שני לא מפריעים.
 */
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const nameKeys = (t) => String(t ?? '').replace(/["'״׳()\-]/g, ' ').split(/\s+/).filter(Boolean)
  .map((w) => w.toLowerCase().replace(/[ךםןףץ]/g, (c) => FINALS[c]).replace(/ט/g, 'ת').replace(/וו/g, 'ו').replace(/יי/g, 'י'));
function sameName(a, b) {
  const [x, y] = [nameKeys(a), nameKeys(b)].sort((p, q) => p.length - q.length);
  return x.length >= 2 && x.every((w) => y.includes(w));
}
/** שמות של משתמש פריוריטי — מהשם הפרטי והמשפחה, השם המלא, ושם המשתמש (לפעמים הוא שם בעברית) */
const prNames = (x) => [`${x.FIRSTNAME ?? ''} ${x.FAMILYNAME ?? ''}`, x.SNAME, x.USERLOGIN].filter((n) => String(n ?? '').trim());

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
  const hits = users.filter((x) => prNames(pr).some((n) => sameName(n, x.full_name)));
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
  const byName = u?.full_name ? list.filter((x) => prNames(x).some((n) => sameName(n, u.full_name))) : [];
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

function messageFor(company, d, owner) {
  const c = Priority.companyOf(company);
  const items = (d.PRDITEMS_SUBFORM ?? []).length;
  return [
    `🛒 ממתינה לך בפריוריטי *דרישת רכש ${d.PRDNO}* לאישורך.`,
    `${Priority.isTest(company) ? `🧪 ${company} (סביבת בדיקה)` : `🏢 ${c.name}`}${d.PROJDES ? ` · 📁 ${d.PROJDES}` : ''}`,
    [owner ? `נפתחה ע"י ${owner}` : null, items ? (items === 1 ? "פריט אחד" : `${items} פריטים`) : null, d.CURDATE ? `מ-${String(d.CURDATE).slice(0, 10).split('-').reverse().join('.')}` : null].filter(Boolean).join(' · '),
    '',
    'האישור — בפריוריטי (מהבוט אי אפשר לאשר).'
  ].filter((x) => x !== null).join('\n');
}

async function ownerName(login) {
  if (!login) return '';
  const list = await Priority.priorityUsers().catch(() => []);
  const pr = list.find((x) => x.USERLOGIN === login);
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
 * הודעה לחותם הבא של דרישה אחת — אם עוד לא קיבל עליה. ‎send(userId, text)‎ ←
 *   ‎true‎ — ההודעה יצאה; ‎'later'‎ — מחוץ לשעות הפעילות (הסבב ינסה שוב כשהחלון נפתח); ‎false‎ — לא יצאה.
 * רק הודעה שיצאה נרשמת כ"קיבל". נכשלה — ניסיון בכל סבב, ואחרי ‎MAX_FAILS‎ — התראה למנהלי המערכת (פעם אחת).
 * ‎{ signer, user, sent, later, why }‎
 */
async function notifyDemand(company, d, send) {
  const signer = Priority.nextSigner(d);
  if (!signer) return { signer: null, user: null, sent: false, why: 'אין חותם בא (אין רשימת מאשרים)' };
  const k = `${company}:${d.PRDNO}:${signer}`;
  const done = D.getSetting(NOTIFIED, {}) ?? {};
  const m = await mesimonUserFor(signer);
  if (done[k]) return { signer, user: m.user, sent: false, why: 'כבר קיבל' };
  if (!m.user) {
    if (firstTimeUnmapped(signer)) {
      alertAdmins(`החותם הבא ${signer} לא נמצא במשימון`, [`דרישת רכש ${d.PRDNO} (${company}) מחכה לאישור של ${signer}${m.pr?.SNAME ? ` (${m.pr.SNAME})` : ''}.`,
        'לא נמצא משתמש משימון עם אותו מייל או אותו שם, ולכן לא נשלחה לו הודעה בוואטסאפ.',
        'לתיקון: מייל זהה בשני המקומות, או מיפוי ידני בהגדרה priority_user_map.'].join('\n'));
    }
    return { signer, user: null, sent: false, why: 'לא נמצא במשימון' };
  }
  if (!m.user.phone) {
    // בלי טלפון אין לאן לשלוח — מנהלי המערכת יודעים (פעם אחת לכל משתמש), כדי להשלים את הפרופיל
    if (firstTimeNoPhone(String(m.user.id))) {
      alertAdmins(`לחותם ${m.user.full_name} אין טלפון במשימון`, [`דרישת רכש ${d.PRDNO} (${company}) מחכה לאישור של ${m.user.full_name} (${signer}),`,
        'אבל בפרופיל שלו במשימון אין מספר טלפון, ולכן לא נשלחה לו הודעה בוואטסאפ.',
        'לתיקון: להוסיף טלפון בפרופיל — ההודעה תצא בסבב הבא (עד 10 דקות).'].join('\n'));
    }
    return { signer, user: m.user, sent: false, why: 'אין טלפון בפרופיל' };
  }
  const res = await send(m.user.id, messageFor(company, d, await ownerName(d.OWNERLOGIN || d.INITUSERLOGIN)));
  if (res === 'later') return { signer, user: m.user, sent: false, later: true, why: 'מחוץ לשעות הפעילות' };
  const fails = D.getSetting(FAILED, {}) ?? {};
  if (res === true) {
    done[k] = Date.now();
    for (const [x, at] of Object.entries(done)) if (Date.now() - at > KEEP) delete done[x];
    D.setSetting(NOTIFIED, done);
    if (fails[k]) { delete fails[k]; D.setSetting(FAILED, fails); }
    return { signer, user: m.user, sent: true, why: '' };
  }
  fails[k] = (fails[k] ?? 0) + 1;
  D.setSetting(FAILED, fails);
  if (fails[k] === MAX_FAILS) {
    alertAdmins(`ההודעה לחותם ${m.user.full_name} לא נשלחה`, [`דרישת רכש ${d.PRDNO} (${company}) מחכה לאישור של ${m.user.full_name} (${signer}).`,
      `הבוט ניסה ${MAX_FAILS} פעמים לשלוח לו הודעה בוואטסאפ, ולא הצליח (הפירוט ביומן הבוט, פעולה purchase_demand).`,
      'הבוט ממשיך לנסות כל 10 דקות.'].join('\n'));
  }
  return { signer, user: m.user, sent: false, why: 'הבוט לא שלח' };
}

let lastRun = 0;
/** סבב: כל הדרישות שמחכות לאישור בחברות שבהגדרה. פעם ב-10 דקות לכל היותר */
async function sweep(send, { force = false } = {}) {
  if (!Priority.isEnabled() || (!force && Date.now() - lastRun < EVERY)) return [];
  lastRun = Date.now();
  const out = [];
  for (const c of companies()) {
    let list = [];
    try { list = await Priority.waitingDemands(c); } catch (err) { console.error(`[משימון] דרישות שמחכות לאישור (${c}):`, err.message); continue; }
    for (const d of list) {
      try { out.push({ company: c, prdno: d.PRDNO, ...(await notifyDemand(c, d, send)) }); } catch (err) { console.error(`[משימון] הודעה על ${d.PRDNO}:`, err.message); }
    }
  }
  return out;
}

module.exports = { sameName, alertAdmins, mesimonUserFor, priorityLoginFor, mapping, notifyDemand, sweep, messageFor, MAX_FAILS, _words: words };
