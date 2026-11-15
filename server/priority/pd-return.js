'use strict';
/**
 * 🔁 החזרת דרישת רכש לבדיקה חוזרת — הוחלט 15.11.26.
 *
 * מי שמוסמך להוציא הזמנות רכש (לפי פריוריטי — ‎Priority.purchaseOrderOwners‎: מסכי ההרשאות סגורים ל-API, ולכן מי שפתח
 * הזמנת רכש בשנה האחרונה) כותב לבוט, למשל "החזר לבדיקה PD26000053 — שורה 1: PRE-B או יריעה ביטומנית 3 מ"מ?".
 *   1. הבוט מוצא את הדרישה (בחברות הפתוחות לכתיבה), מציג אותה ומבקש אישור ("כן, להחזיר ✅").
 *   2. "פתיחה חוזרת" בפריוריטי (כך עושה הרכש גם ידנית), והשאלה — בדו-שיח הפנימי.
 *   3. פותח הדרישה מקבל בוואטסאפ את השאלה ואת השורות, עם *✏️ לתקן* / *✅ הכל נכון*:
 *      • לתקן — הדרישה נטענת לבוט כרשימה לעריכה (‎purchase-demand.js‎, ‎startEdit‎), ו"סיום" מעדכן את השורות בפריוריטי
 *        ומחזיר אותה *לאישור* ("מחכה לאישור") — המאשר מאשר מחדש.
 *      • הכל נכון — הסבר קצר, שנשלח לרכש ונרשם בדו-שיח, והדרישה חוזרת לאישור כמו שהיא.
 *   4. מי שהחזיר מקבל הודעה כשהדרישה תוקנה (או הוסברה).
 *
 * מצב השיחה — ‎pd_return:<userId>‎ (למחזיר ולמסביר); החזרות פתוחות — ‎pd_returned‎ (‎company:prdno‎ ← פותח, מחזיר, שאלה).
 */
const D = require('../core').Db;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Priority = require('../integrations').Priority;
const Approvals = require('./priority-approvals');
const Prefs = require('./priority-prefs');
const { BTN, YES, CANCEL, normalize, sameLabel } = require('../whatsapp').WaUi;

const BTN_RETURN = 'כן, להחזיר ✅';
const BTN_FIX = '✏️ לתקן';
const BTN_OK = '✅ הכל נכון';
const STATE_TTL = 30 * 60 * 1000;
const OPEN_DAYS = 14;
const TZ = 'Asia/Jerusalem';

/** ‎send(userId, text)‎ — הודעה יזומה; ‎ask(userId, text, buttons)‎ — עם כפתורים (חוזרים לדרישת הרכש). נקבע ב-wa-tasks */
const hooks = { send: null, ask: null };
const setHooks = (h) => Object.assign(hooks, h);

const qty = (n) => Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 3 });
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

function alertAdmins(title, body) {
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🔁 דרישת רכש: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על החזרת דרישה:', err.message);
  }
}

// ---------------------------------------------------------------------------
// מצב
// ---------------------------------------------------------------------------

const key = (userId) => `pd_return:${userId}`;
function load(userId) {
  const s = D.getSetting(key(userId), null);
  return s && typeof s === 'object' && s.step && Date.now() - (s.at ?? 0) < STATE_TTL ? s : null;
}
const save = (userId, s) => D.setSetting(key(userId), { ...s, at: Date.now() });
const clear = (userId) => D.run('DELETE FROM settings WHERE key = ?', key(userId));

const RETURNED = 'pd_returned';
const recKey = (company, prdno) => `${company}:${prdno}`;
const records = () => D.getSetting(RETURNED, {}) ?? {};
function setRecord(company, prdno, v) {
  const all = records();
  if (v) all[recKey(company, prdno)] = { ...v, company, prdno, at: Date.now() };
  else delete all[recKey(company, prdno)];
  for (const [k, r] of Object.entries(all)) if (Date.now() - (r?.at ?? 0) > 60 * 86400000) delete all[k];
  D.setSetting(RETURNED, all);
}
/** ההחזרה הפתוחה האחרונה שמחכה לפותח הדרישה הזה */
function openFor(userId) {
  return Object.values(records()).filter((r) => r.openerId === userId && Date.now() - (r.at ?? 0) < OPEN_DAYS * 86400000)
    .sort((a, b) => b.at - a.at)[0] ?? null;
}

// ---------------------------------------------------------------------------
// זיהוי
// ---------------------------------------------------------------------------

const RETURN_WORD = /(^|\s)(ת?החזיר[יו]?|להחזיר|החזר|מחזיר[הים]?|תחזיר[יו]?)(?=[\s,:–-]|$)/;
const REVIEW_WORD = /(לבדיקה|לבירור|לתיקון|לפותח|ליוזם|בדיקה חוזרת|לבדיקה חוזרת)/;
const FIX_WORD = /^(✏️?\s*)?(לתקן|תיקון|אתקן|אני אתקן|לערוך|עריכה)([\s,.!]|$)/;
const OK_WORD = /^(✅\s*)?(הכל נכון|הכול נכון|נכון|אין מה לתקן|זה נכון|תקין)([\s,.!]|$)/;

/** מספר הדרישה בטקסט: "PD26000053", "PD 53", "דרישה 53" ← ‎PD26000053‎ (בלי שנה — השנה הנוכחית) */
function prdnoIn(text) {
  const t = String(text ?? '');
  const m = t.match(/PD\s*-?\s*(\d{1,8})/i) ?? t.match(/דריש(?:ה|ת\s*רכש)\s*(?:מס(?:פר|['׳])?\s*)?(\d{1,8})\b/);
  if (!m) return null;
  const d = m[1];
  if (d.length === 8) return { prdno: `PD${d}`, at: m.index, end: m.index + m[0].length };
  const yy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: '2-digit' }).format(new Date());
  return { prdno: `PD${yy}${d.padStart(6, '0')}`, at: m.index, end: m.index + m[0].length };
}

/** "החזר לבדיקה PD… — …" — בקשה להחזיר דרישה */
const wants = (t) => RETURN_WORD.test(t) && REVIEW_WORD.test(t) && (Boolean(prdnoIn(t)) || /דריש/.test(t));

/** ההודעה שייכת להחזרה: בקשה חדשה, תשובה בשיחה פתוחה, או תשובה של פותח הדרישה (לתקן / הכל נכון) */
function owns(userId, text) {
  const t = normalize(text);
  if (wants(t)) return true;
  if (load(userId)) return true;
  return Boolean(openFor(userId) && (FIX_WORD.test(t) || OK_WORD.test(t) || sameLabel(t, BTN_FIX) || sameLabel(t, BTN_OK)));
}

/** מה לא ברור — הטקסט אחרי מספר הדרישה (ובלעדיו — אחרי מילות הבקשה) */
function reasonIn(text, hit) {
  let r = hit ? `${text.slice(hit.end)}` : text;
  if (hit && !r.trim()) r = text.slice(0, hit.at);
  return r.replace(RETURN_WORD, ' ').replace(REVIEW_WORD, ' ').replace(/(^|\s)(את|דרישה|דרישת רכש|הדרישה)(?=\s|$)/g, ' ')
    .replace(/^[\s:,\-–—.]+|[\s:,\-–—]+$/g, '').replace(/^(כי|בגלל ש|מכיוון ש)\s*/, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// מי מוסמך — לפי פריוריטי
// ---------------------------------------------------------------------------

const allCompanies = () => [...new Set([...Priority.COMPANIES.filter((c) => !c.test).map((c) => c.code), ...Priority.allowed()])];
async function buyerLogin(user) {
  const login = await Approvals.priorityLoginFor(user).catch(() => null);
  if (!login) return null;
  const set = await Priority.purchaseOrderOwners(allCompanies()).catch(() => new Set());
  return set.has(login) ? login : null;
}

/** הדרישה בחברות הפתוחות לכתיבה (ההחזרה כותבת). ‎[{ company, d }]‎ */
async function findDemand(prdno) {
  const out = [];
  for (const c of Priority.allowed()) {
    try {
      const d = await Priority.readDemand(c, prdno);
      if (d?.PRDNO) out.push({ company: c, d });
    } catch { /* לא בחברה הזו */ }
  }
  return out;
}

/** פותח הדרישה — משתמש משימון: מה שהבוט רשם, אחרת לפי שם המשתמש בפריוריטי (יוזם / בעלים / הדו-שיח) */
async function openerOf(company, prdno) {
  const recorded = Prefs.openerOf(company, prdno);
  if (recorded) {
    const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", recorded);
    if (u) return u;
  }
  const info = await Priority.demandForNotice(company, prdno).catch(() => null);
  const sys = /^(master|medatech|tabula|api\b|api\s)/i;
  const login = [info?.INITUSERLOGIN, info?.OWNERLOGIN, info?.dialogLogin].find((l) => l && !sys.test(l));
  if (!login) return null;
  return (await Approvals.mesimonUserFor(login).catch(() => ({ user: null }))).user ?? null;
}

const linesText = (d) => (d.PRDITEMS_SUBFORM ?? []).map((l, i) => `*${i + 1}.* ${l.PDES} — ${qty(l.TQUANT)} ${l.TUNITNAME ?? ''}`.trim());

// ---------------------------------------------------------------------------
// השיחה
// ---------------------------------------------------------------------------

const out = (text, buttons = [], extra = {}) => ({ replies: [text], buttons, status: 'ok', ...extra });

function confirmText(s) {
  return [`🔁 *להחזיר לבדיקה את דרישת הרכש ${s.prdno}?*`, `📁 ${s.projectDes || ''}${s.openerName ? ` · נפתחה ע"י ${s.openerName}` : ''}`.trim(), '',
    ...s.lines, '', `❓ *מה לא ברור:* ${s.reason}`, '',
    `הדרישה תעבור ל"${Priority.REOPEN_STATUS}", ו${s.openerName || 'פותח הדרישה'} יקבל את השאלה בוואטסאפ — לתקן, או להסביר.`,
    '_לשנות את השאלה — פשוט כתבו אותה מחדש._'].join('\n');
}

/**
 * הודעה ששייכת להחזרה (‎owns‎). ‎{ replies, buttons, status, result }‎, או ‎{ edit: { company, prdno, reason, buyerName } }‎ —
 * פותח הדרישה בחר לתקן: דרישת הרכש טוענת אותה לעריכה.
 */
async function handle({ user, text = '' }) {
  const t = normalize(text);
  let s = load(user.id);

  // פותח הדרישה עונה על החזרה (בלי שיחה פתוחה, או עם שיחת הסבר)
  const rec = openFor(user.id);
  if (rec && (!s || s.step === 'explain') && (FIX_WORD.test(t) || sameLabel(t, BTN_FIX))) {
    clear(user.id);
    return { edit: { company: rec.company, prdno: rec.prdno, reason: rec.reason, buyerName: rec.buyerName } };
  }
  if (rec && !s && (OK_WORD.test(t) || sameLabel(t, BTN_OK))) {
    save(user.id, { step: 'explain', company: rec.company, prdno: rec.prdno });
    return out(`💬 מה להסביר ל${rec.buyerName || 'רכש'} על ${rec.prdno}? (למשל "PRE-B — זה מה שצריך באתר")\nאחרי ההסבר הדרישה חוזרת לאישור כמו שהיא.`, [BTN.cancel], { result: `החזרה ${rec.prdno}: הכל נכון — מחכה להסבר` });
  }
  if (s?.step === 'explain') return explain(user, s, t);

  // המחזיר — בקשה חדשה (גם באמצע שיחה קודמת)
  if (wants(t) || !s) {
    const login = await buyerLogin(user);
    if (!login) return out('רק מי שמוציא/ה הזמנות רכש בפריוריטי יכול/ה להחזיר דרישת רכש לבדיקה.', [], { status: 'denied', result: 'החזרת דרישה — לא מורשה (אין הזמנות רכש בפריוריטי)' });
    const hit = prdnoIn(t);
    s = { step: 'number', buyer: login, reason: reasonIn(t, hit) };
    if (!hit) { save(user.id, s); return out('🔁 איזו דרישה להחזיר לבדיקה? כתבו את המספר (למשל PD26000053).', [BTN.cancel], { result: 'החזרת דרישה — בלי מספר' }); }
    return pickDemand(user, s, hit.prdno);
  }

  if (CANCEL.test(t) || sameLabel(t, BTN.cancel)) { clear(user.id); return out('בסדר, הדרישה לא הוחזרה.', [], { result: 'החזרת דרישה — בוטל' }); }
  if (s.step === 'number') {
    const hit = prdnoIn(t) ?? (/^\d{1,8}$/.test(t) ? prdnoIn(`PD${t}`) : null);
    if (!hit) return out('כתבו את מספר הדרישה (PD…), או *ביטול*.', [BTN.cancel]);
    if (!s.reason) s.reason = reasonIn(t, hit);
    return pickDemand(user, s, hit.prdno);
  }
  if (s.step === 'company') {
    const c = (s.found ?? []).find((x) => sameLabel(t, x.btn) || t === x.company);
    if (!c) return out('באיזו חברה? בחרו בכפתור.', s.found.map((x) => x.btn));
    return chosen(user, s, c.company);
  }
  if (s.step === 'reason') {
    if (t.length < 2) return out('מה לא ברור? כתבו את השורה ואת השאלה.', [BTN.cancel]);
    s.reason = t;
    s.step = 'confirm';
    save(user.id, s);
    return out(confirmText(s), [BTN_RETURN, BTN.cancel]);
  }
  if (s.step === 'confirm') {
    if (sameLabel(t, BTN_RETURN) || YES.test(t)) return execute(user, s);
    // כל טקסט אחר — שאלה חדשה במקום הקודמת
    s.reason = t;
    save(user.id, s);
    return out(confirmText(s), [BTN_RETURN, BTN.cancel]);
  }
  clear(user.id);
  return out('לא הבנתי. כדי להחזיר דרישה לבדיקה — "החזר לבדיקה PD… — מה לא ברור".');
}

async function pickDemand(user, s, prdno) {
  s.prdno = prdno;
  const found = await findDemand(prdno);
  if (!found.length) { save(user.id, { ...s, step: 'number' }); return out(`לא מצאתי את ${prdno}. כתבו מספר אחר, או *ביטול*.`, [BTN.cancel], { result: `החזרת דרישה — ${prdno} לא נמצאה` }); }
  if (found.length > 1) {
    s.step = 'company';
    s.found = found.slice(0, 3).map((x) => ({ company: x.company, btn: Priority.companyOf(x.company).name.slice(0, 20) }));
    save(user.id, s);
    return out(`🔁 ${prdno} קיימת בכמה חברות. באיזו?`, s.found.map((x) => x.btn));
  }
  return chosen(user, s, found[0].company, found[0].d);
}

async function chosen(user, s, company, d = null) {
  d ??= await Priority.readDemand(company, s.prdno);
  if (['טיוטא', 'מבוטלת'].includes(d.STATDES)) { clear(user.id); return out(`${s.prdno} בסטטוס "${d.STATDES}" — אין מה להחזיר לבדיקה.`, [], { result: `החזרת דרישה — ${s.prdno} ${d.STATDES}` }); }
  const opener = await openerOf(company, s.prdno);
  Object.assign(s, { company, projectDes: d.PROJDES ?? '', lines: linesText(d), openerId: opener?.id ?? null, openerName: opener?.full_name ?? '' });
  s.step = s.reason ? 'confirm' : 'reason';
  save(user.id, s);
  if (s.step === 'reason') {
    return out([`🔁 *${s.prdno}* — ${s.projectDes}${s.openerName ? ` · נפתחה ע"י ${s.openerName}` : ''}`, '', ...s.lines, '',
      '❓ מה לא ברור? כתבו את השורה ואת השאלה (למשל "שורה 1 — PRE-B או יריעה ביטומנית 3 מ"מ?").'].join('\n'), [BTN.cancel]);
  }
  return out(confirmText(s), [BTN_RETURN, BTN.cancel]);
}

async function execute(user, s) {
  clear(user.id);
  try {
    await Priority.reopenDemand(s.company, s.prdno);
  } catch (err) {
    alertAdmins(`${s.prdno} לא הוחזרה לבדיקה`, [`חברה: ${s.company}`, `מחזיר/ה: ${user.full_name} (${s.buyer})`, `פריוריטי: ${err.message}`].join('\n'));
    return out(`⚠️ פריוריטי לא אישר להחזיר את ${s.prdno} לבדיקה. מנהל המערכת קיבל פירוט.`, [], { status: 'error', result: `החזרת ${s.prdno} נכשלה: ${err.message}` });
  }
  await Priority.appendDemandDialog(s.company, s.prdno, [`הוחזרה לבדיקה חוזרת ע"י ${user.full_name} (${s.buyer}) | ${nowHe()}`, `מה לא ברור: ${s.reason}`])
    .catch((err) => console.error('[משימון] דו-שיח בהחזרת דרישה:', err.message));
  setRecord(s.company, s.prdno, { openerId: s.openerId, buyerId: user.id, buyerName: user.full_name, buyer: s.buyer, reason: s.reason });
  let told = false;
  if (s.openerId) {
    const msg = [`🔁 *דרישת הרכש שלך ${s.prdno} הוחזרה לבדיקה*`, `ע"י ${user.full_name} (רכש)${s.projectDes ? ` · 📁 ${s.projectDes}` : ''}`, '',
      `❓ *מה לא ברור:* ${s.reason}`, '', ...s.lines, '',
      '*✏️ לתקן* — הבוט פותח לך את הדרישה לעריכה, ו"סיום" מחזיר אותה לאישור.',
      '*✅ הכל נכון* — כתבו הסבר קצר, והדרישה חוזרת לאישור כמו שהיא.'].join('\n');
    told = Boolean(hooks.ask ? await hooks.ask(s.openerId, msg, [BTN_FIX, BTN_OK]) : hooks.send ? await hooks.send(s.openerId, msg) : false);
  }
  if (!told) alertAdmins(`${s.prdno} הוחזרה, אבל פותח הדרישה לא קיבל הודעה`, [`חברה: ${s.company}`, s.openerId ? 'לפותח הדרישה אין טלפון / הבוט לא שלח.' : 'פותח הדרישה לא נמצא במשימון.', `השאלה: ${s.reason}`].join('\n'));
  return out([`🔁 *${s.prdno}* הוחזרה לבדיקה ("${Priority.REOPEN_STATUS}"), והשאלה נרשמה בדו-שיח הפנימי.`,
    told ? `💬 ${s.openerName} קיבל/ה את השאלה בוואטסאפ. כשיתקן/תסביר — אעדכן אותך.` : '⚠️ לא הצלחתי להודיע לפותח הדרישה בוואטסאפ. מנהל המערכת קיבל פירוט.'].join('\n'),
  [], { result: `החזרה לבדיקה: ${s.company} ${s.prdno}${told ? ` ← ${s.openerName}` : ' (לא נשלח לפותח)'}` });
}

/** פותח הדרישה: "הכל נכון" + הסבר — לרכש, לדו-שיח, והדרישה חוזרת לאישור */
async function explain(user, s, t) {
  if (CANCEL.test(t) || sameLabel(t, BTN.cancel)) { clear(user.id); return out('בסדר. הדרישה נשארת מוחזרת לבדיקה — אפשר לחזור אליה עם *✏️ לתקן* או *✅ הכל נכון*.', [BTN_FIX, BTN_OK]); }
  if (t.length < 2) return out('כתבו הסבר קצר לרכש.', [BTN.cancel]);
  clear(user.id);
  const rec = records()[recKey(s.company, s.prdno)] ?? {};
  await Priority.appendDemandDialog(s.company, s.prdno, [`הסבר של ${user.full_name} | ${nowHe()}: ${t}`]).catch((err) => console.error('[משימון] דו-שיח בהסבר:', err.message));
  const sent = await resubmit(user, s.company, s.prdno);
  setRecord(s.company, s.prdno, null);
  if (rec.buyerId && hooks.send) await hooks.send(rec.buyerId, [`💬 *${user.full_name} על ${s.prdno}* (שהחזרת לבדיקה):`, t, '', sent.ok ? 'הדרישה חזרה לאישור כמו שהיא.' : '⚠️ הדרישה עוד לא חזרה לאישור — מנהל המערכת קיבל פירוט.'].join('\n'));
  return out([`✅ ההסבר נשלח ל${rec.buyerName || 'רכש'}.`, sent.ok ? `*${s.prdno}* חזרה *לאישור*.${sent.signerLine ? `\n${sent.signerLine}` : ''}` : '⚠️ הדרישה עוד לא חזרה לאישור — מנהל המערכת קיבל פירוט.'].join('\n'),
    [], { status: sent.ok ? 'ok' : 'error', result: `החזרה ${s.prdno}: הוסבר${sent.ok ? ', חזרה לאישור' : ` — לאישור נכשל: ${sent.error}`}` });
}

/** חזרה לאישור ("מחכה לאישור") והודעה לחותם הבא. ‎{ ok, signerLine, error }‎ */
async function resubmit(user, company, prdno) {
  try {
    await Priority.submitDemand(company, prdno);
  } catch (err) {
    alertAdmins(`${prdno} לא חזרה לאישור`, [`חברה: ${company}`, `אחרי בדיקה חוזרת של ${user.full_name}`, err.message].join('\n'));
    return { ok: false, error: err.message, signerLine: '' };
  }
  let signerLine = '';
  try {
    const d = await Priority.readDemand(company, prdno);
    const r = hooks.send ? await Approvals.notifyDemand(company, d, hooks.send) : { signer: Priority.nextSigner(d), user: null, sent: false };
    const name = r.user?.full_name || r.signer;
    signerLine = !r.signer ? '' : r.sent ? `✍️ החותם הבא: *${name}* — קיבל הודעה בוואטסאפ.` : `✍️ החותם הבא: *${name}*.`;
  } catch (err) {
    console.error('[משימון] החותם הבא אחרי בדיקה חוזרת:', err.message);
  }
  return { ok: true, signerLine };
}

/** אחרי שפותח הדרישה תיקן בבוט (‎purchase-demand.js‎): מי שהחזיר מקבל מה השתנה, וההחזרה נסגרת */
async function afterEdit(user, company, prdno, changes, ok) {
  const rec = records()[recKey(company, prdno)];
  setRecord(company, prdno, null);
  if (!rec?.buyerId || !hooks.send) return;
  await hooks.send(rec.buyerId, [`✏️ *${user.full_name} תיקן/ה את ${prdno}* (שהחזרת לבדיקה):`,
    ...(changes.length ? changes.map((c) => `• ${c}`) : ['• לא שונה דבר בשורות']), '', ok ? 'הדרישה חזרה לאישור.' : '⚠️ הדרישה עוד לא חזרה לאישור — מנהל המערכת קיבל פירוט.'].join('\n'));
}

module.exports = { owns, wants, handle, setHooks, afterEdit, resubmit, openFor, BTN_FIX, BTN_OK, BTN_RETURN, _prdnoIn: prdnoIn, _reasonIn: reasonIn, _setRecord: setRecord };
