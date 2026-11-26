'use strict';
/**
 * ✍️ "ממתין לאישורך" — כל מה שמחכה לחתימה של העובד בפריוריטי, בכל המסכים ובכל החברות.
 *
 * האפיון: "אפיון — מסך אישורים במשימון פריוריטי.md". משימון מראה ומפנה; האישור — בפריוריטי.
 *
 *   • **גילוי — פעם ביום** (‎discover‎): רשימת המסכים של פריוריטי (‎$metadata‎) ← כל מסך עם סטטוס ורשימת מאשרים
 *     או "החותם הבא". מסך חדש נכנס מיד (הוחלט 24.11.26) — מנהלי המערכת מקבלים התראה לתת לו שם או לכבות.
 *     מסך סגור ל-API — התראה פעם אחת: לבקש ממנהל פריוריטי לפתוח.
 *   • **סבב — כל 10 דקות** (‎sweep‎): בכל חברה ובכל מסך פעיל — המסמכים בסטטוס "…לאישור", והחותם הבא לפי כלל אחד
 *     (‎signerOf‎). נשמר בטבלה ‎priority_waiting‎; מסמך שלא חזר — נמחק. המסך קורא מהטבלה, מיד.
 *   • **העובד** (‎forUser‎): מה שהוא החותם הבא בו, המחליף של החותם, ומה שהוא שלח לאישור (‎role‎). הוותיק קודם.
 *     "ששלחתי לאישור" (26.11.26) — מי שפתח את המסמך: ‎OWNERLOGIN‎, ואם המסמך נפתח בבוט (בפריוריטי — משתמש ה-API) —
 *     העובד שפתח אותו (‎priority_docs‎). מפריוריטי, ולכן גם אחורה — כל מה שממתין עכשיו, בלי קשר למתי נשלח.
 *   • **חזרה מפריוריטי** (‎check‎): בדיקה של מסמך אחד — אושר / עבר הלאה ← יוצא מהרשימה.
 *
 * קריאה בלבד מפריוריטי — שום כתיבה, ולכן בכל החברות האמיתיות.
 */
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const Settings = require('./priority-settings');
const Approvals = require('./priority-approvals');

const ORG = 1;
const TYPES_KEY = 'priority_waiting_types';
const FOUND_KEY = 'priority_waiting_found';
const STATE_KEY = 'priority_waiting_state';
const EVERY = 10 * 60 * 1000;
const DISCOVER_EVERY = 24 * 60 * 60 * 1000;
const REFRESH_GAP = 60 * 1000;
const NEW_DAYS = 7;
const WARN_DAYS = 3;
const LATE_DAYS = 7;
const DAY = 86400000;
const PARALLEL = 4;

/** הסוגים המוכרים — שם בעברית ואייקון. כל מסך אחר עם מאשרים נכנס לבד, והמנהל נותן לו שם */
const KNOWN = Object.freeze({
  PURDEMANDS: { name: 'דרישת רכש', icon: 'demand' },
  PORDERS: { name: 'הזמנת רכש', icon: 'order' },
  MED_PORDERS: { name: 'חוזה', icon: 'contract' },
  MED_DOCUMENTS_P: { name: 'חשבון חלקי', icon: 'partial' },
  DINVOICES: { name: 'חשבון עסקה', icon: 'deal' },
  YINVOICES: { name: 'חשבונית ספק', icon: 'invoice' },
  PINVOICES: { name: 'חשבונית ספק מרכזת', icon: 'invoice' }
});
const FALLBACK_NAME = 'מסמך לאישור';

const parse = (v, d) => (v && typeof v === 'object' ? v : d);
const found = () => parse(D.getSetting(FOUND_KEY, null), null);
const state = () => parse(D.getSetting(STATE_KEY, null), {});
const typeSettings = () => parse(D.getSetting(TYPES_KEY, {}), {});
const companies = () => Settings.companies().filter((c) => !c.test);

/** הסוג של מסך: שם (מהמנהל / מוכר / ריק), אייקון, דלוק */
function typeOf(screen) {
  const t = typeSettings()[screen] ?? {};
  return { name: String(t.name ?? '').trim() || KNOWN[screen]?.name || '', icon: KNOWN[screen]?.icon ?? 'doc', on: t.on !== false };
}

/**
 * החותם הבא — כלל אחד לכל המסכים (נבדק 24.11.26 על כל המסמכים הממתינים בחמשת הסוגים):
 * שדה "החותם הבא" אם יש; אחרת — הראשון ברשימת המאשרים שעוד לא אישר; ובמסך בלי רשימת מאשרים — ‎USERLOGIN‎.
 * (בחשבון חלקי ‎USERLOGIN‎ בכותרת אינו החותם — לכן הוא רק למסך בלי רשימה.)
 * ‎alt‎ — המחליף של החותם (מהרשימה). ‎since‎ — האישור האחרון, ואם אין — תאריך המסמך.
 */
function signerOf(doc, s) {
  const list = s.approvers ? (Array.isArray(doc?.[s.approvers]) ? doc[s.approvers] : []) : [];
  const open = list.find((u) => u.UFLAG !== 'Y' && u.USERLOGIN);
  const signer = doc?.NEXTSIGNUSERLOGIN || open?.USERLOGIN || (!s.approvers ? doc?.USERLOGIN : null) || null;
  const row = signer ? list.find((u) => u.USERLOGIN === signer && u.UFLAG !== 'Y') : null;
  const alt = row?.ALTUSERLOGIN && row.ALTUSERLOGIN !== signer ? row.ALTUSERLOGIN : null;
  const approved = list.filter((u) => u.UFLAG === 'Y' && u.UDATE).map((u) => String(u.UDATE)).sort().at(-1);
  return { signer, alt, since: approved || doc?.CURDATE || doc?.IVDATE || null };
}

// ---------------------------------------------------------------- גילוי

async function discover({ force = false } = {}) {
  const prev = found();
  if (!force && prev?.at && Date.now() - Date.parse(prev.at) < DISCOVER_EVERY) return prev;
  const cos = companies();
  if (!cos.length || !Priority.isEnabled()) return prev;
  let list;
  try {
    list = await Priority.approvalScreens(cos[0].code);
  } catch (err) {
    console.error('[משימון] ממתין לאישורך — רשימת המסכים:', err.message);
    return prev;
  }
  const now = D.nowIso();
  const before = new Map((prev?.screens ?? []).map((x) => [x.screen, x]));
  const screens = [];
  for (const s of list) {
    let status = 'ok', error = '';
    try {
      await Priority.waitingDoc(cos[0].code, s, '__probe__');
    } catch (err) {
      status = Priority.isBlockedScreen(err) ? 'blocked' : 'error';
      error = String(err.message ?? '').slice(0, 200);
    }
    // הגילוי הראשון — נקודת ההתחלה, לא "חדש"
    const firstSeen = before.get(s.screen)?.firstSeen ?? (prev ? now : null);
    screens.push({ ...s, status, error, firstSeen });
  }
  const next = { at: now, screens };
  D.setSetting(FOUND_KEY, next);
  if (prev) {
    const fresh = screens.filter((s) => s.status === 'ok' && !before.has(s.screen) && !KNOWN[s.screen]);
    if (fresh.length) {
      Approvals.alertAdmins(`נמצא בפריוריטי סוג חדש עם מאשרים: ${fresh.map((s) => s.screen).join(', ')}`, [
        'מסמכים שממתינים לאישור במסך הזה מופיעים מעכשיו לחותמים ב"ממתין לאישורך", בשם "מסמך לאישור".',
        'לתת לו שם בעברית, או לכבות: משימון פריוריטי ← הגדרות ← סוגי אישורים.'
      ].join('\n'));
    }
  }
  const blocked = screens.filter((s) => s.status === 'blocked' && before.get(s.screen)?.status !== 'blocked');
  if (blocked.length) {
    Approvals.alertAdmins(`מסכים עם מאשרים בפריוריטי שסגורים למשימון: ${blocked.map((s) => s.screen).join(', ')}`, [
      'במסכים האלה יש סבב מאשרים, אבל פריוריטי לא נותן למשימון לקרוא אותם ("לא ניתן להפעיל API למסך זה").',
      'אם צריך אחד מהם ב"ממתין לאישורך" — לבקש ממנהל פריוריטי לפתוח אותו ל-API. אחרי שייפתח הוא ייכנס לבד, למחרת.'
    ].join('\n'));
  }
  return next;
}

/** המסכים שהסבב קורא: נמצאו, פתוחים ל-API, ולא כובו */
const activeScreens = () => (found()?.screens ?? []).filter((s) => s.status === 'ok' && typeOf(s.screen).on);

// ---------------------------------------------------------------- סבב

/** הסכום לפני מע"מ, אם יש במסך */
function amountOf(d) {
  for (const k of ['DISPRICE', 'QPRICE', 'TOTPRICE']) if (d?.[k] !== null && d?.[k] !== undefined && Number.isFinite(Number(d[k]))) return Number(d[k]);
  return null;
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const UPSERT = `INSERT INTO priority_waiting (org_id, company, screen, docno, status, signer, signer_user_id, alt, alt_user_id, subtype, party, project, amount, owner,
  owner_login, owner_user_id, since, first_seen, seen_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(org_id, company, screen, docno) DO UPDATE SET status = excluded.status, signer = excluded.signer, signer_user_id = excluded.signer_user_id,
    alt = excluded.alt, alt_user_id = excluded.alt_user_id, subtype = excluded.subtype, party = excluded.party, project = excluded.project,
    amount = excluded.amount, owner = excluded.owner, owner_login = excluded.owner_login, owner_user_id = excluded.owner_user_id,
    since = excluded.since, seen_at = excluded.seen_at`;

async function runSweep() {
  await discover();
  const screens = activeScreens();
  const cos = companies();
  const ids = new Map();
  const userId = async (login) => {
    if (!login) return null;
    if (!ids.has(login)) ids.set(login, (await Approvals.mesimonUserFor(login).catch(() => ({ user: null }))).user?.id ?? null);
    return ids.get(login);
  };
  const prUsers = await Priority.priorityUsers().catch(() => []);
  const nameOf = (login) => prUsers.find((u) => u.USERLOGIN === login)?.SNAME || login || '';
  // מסמך שנפתח בבוט — בפריוריטי הבעלים הוא משתמש ה-API; מי באמת פתח — בשרשרת (‎priority_docs‎)
  const bot = new Map(D.all("SELECT company, docno, user_id, full_name FROM priority_docs pd JOIN users u ON u.id = pd.user_id WHERE pd.org_id = ? AND pd.docno <> '' ORDER BY pd.id", ORG)
    .map((r) => [`${r.company}:${r.docno}`, r]));
  const isApi = (login) => /^api\b/i.test(String(login ?? '').trim());
  const now = D.nowIso();
  const errors = [];
  const jobs = cos.flatMap((c) => screens.map((s) => ({ c, s })));
  await pool(jobs, PARALLEL, async ({ c, s }) => {
    let docs;
    try {
      docs = await Priority.waitingDocs(c.code, s);
    } catch (err) {
      if (!Priority.isBlockedScreen(err)) errors.push(`${c.code}/${s.screen}: ${String(err.message).slice(0, 160)}`);
      return;
    }
    const keep = [];
    for (const d of docs) {
      const docno = String(d[s.key] ?? '').trim();
      if (!docno) continue;
      const g = signerOf(d, s);
      const b = bot.get(`${c.code}:${docno}`);
      // בחלק מהמסכים (חוזים) ‎OWNERLOGIN‎ הוא השם בעברית ("חנה (חני) גנוט") ולא שם המשתמש — מתרגמים לפי השם
      const rawOwner = String(d.OWNERLOGIN ?? '').trim();
      const ownerLogin = (rawOwner && !prUsers.some((u) => u.USERLOGIN === rawOwner) ? prUsers.find((u) => u.SNAME === rawOwner)?.USERLOGIN : null) || rawOwner || null;
      const ownerId = b?.user_id ?? (ownerLogin && !isApi(ownerLogin) ? await userId(ownerLogin) : null);
      D.run(UPSERT, ORG, c.code, s.screen, docno, String(d.STATDES ?? ''), g.signer, await userId(g.signer), g.alt, await userId(g.alt),
        String(d.CODEDES || d.TYPEDES || '').slice(0, 80), String(d.CDES || d.SUPDES || d.CUSTDES || '').slice(0, 120), String(d.PROJDES ?? '').slice(0, 120),
        amountOf(d),
        b?.full_name ?? nameOf(ownerLogin), ownerLogin, ownerId, g.since, now, now);
      keep.push(docno);
    }
    const marks = keep.map(() => '?').join(',');
    D.run(`DELETE FROM priority_waiting WHERE org_id = ? AND company = ? AND screen = ?${keep.length ? ` AND docno NOT IN (${marks})` : ''}`, ORG, c.code, s.screen, ...keep);
  });
  // מסך שכובה, או שכבר אינו ברשימה — השורות שלו יוצאות
  const live = screens.map((s) => s.screen);
  D.run(`DELETE FROM priority_waiting WHERE org_id = ?${live.length ? ` AND screen NOT IN (${live.map(() => '?').join(',')})` : ''}`, ORG, ...live);
  const next = { at: now, errors: errors.slice(0, 20) };
  D.setSetting(STATE_KEY, next);
  if (errors.length) console.error(`[משימון] ממתין לאישורך — ${errors.length} קריאות נכשלו:`, errors.slice(0, 3).join(' | '));
  return next;
}

let running = null;
/** סבב: פעם ב-10 דקות לכל היותר (‎force‎ — עכשיו). סבב שכבר רץ — מחכים לו */
async function sweep({ force = false } = {}) {
  if (!Priority.isEnabled()) return null;
  if (running) return running;
  const at = state().at;
  if (!force && at && Date.now() - Date.parse(at) < EVERY) return null;
  running = runSweep().finally(() => { running = null; });
  return running;
}

// ---------------------------------------------------------------- העובד

const daysSince = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / DAY)) : 0;
};

function card(r, userId, names) {
  const t = typeOf(r.screen);
  const f = (found()?.screens ?? []).find((s) => s.screen === r.screen);
  const days = daysSince(r.since);
  const me = Number(userId);
  const role = Number(r.signer_user_id) === me ? 'sign' : Number(r.alt_user_id) === me ? 'alt' : 'sent';
  return {
    id: r.id,
    screen: r.screen,
    type: t.name || r.subtype || FALLBACK_NAME,
    icon: t.icon,
    isNew: Boolean(!KNOWN[r.screen] && f?.firstSeen && Date.now() - Date.parse(f.firstSeen) < NEW_DAYS * DAY),
    docno: r.docno,
    company: r.company,
    companyName: names.get(r.company) ?? r.company,
    project: r.project,
    party: r.party,
    amount: r.amount,
    owner: r.owner,
    since: r.since,
    days,
    level: days >= LATE_DAYS ? 'late' : days >= WARN_DAYS ? 'warn' : '',
    role,
    altFor: role === 'alt' ? (r.signer ?? '') : null,
    // "ששלחתי לאישור" — אצל מי זה עכשיו
    waitingFor: role === 'sent' ? (r.signer ?? '') : null,
    link: Priority.docLink(r.company, r.screen, r.docno)
  };
}

/** מה שממתין לעובד — כחותם הבא, כמחליף, ומה ששלח לאישור (‎role‎: sign / alt / sent). הוותיק קודם. ‎{ items, at }‎ */
async function forUser(userId) {
  const rows = D.all('SELECT * FROM priority_waiting WHERE org_id = ? AND (signer_user_id = ? OR alt_user_id = ? OR owner_user_id = ?)', ORG, userId, userId, userId);
  const names = new Map(Settings.companies().map((c) => [c.code, c.name]));
  const cards = rows.map((r) => card(r, userId, names));
  const prUsers = cards.some((c) => c.role !== 'sign') ? await Priority.priorityUsers().catch(() => []) : [];
  const nameOf = (login) => prUsers.find((u) => u.USERLOGIN === login)?.SNAME || login;
  const items = cards.map((c) => (c.role === 'alt' ? { ...c, altFor: nameOf(c.altFor) }
    : c.role === 'sent' ? { ...c, waitingFor: c.waitingFor ? nameOf(c.waitingFor) : '' } : c));
  items.sort((a, b) => (b.days - a.days) || String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.docno.localeCompare(b.docno));
  return { items, at: state().at ?? null };
}

const lastRefresh = new Map();
/** "רענון" — סבב עכשיו (פעם בדקה לכל עובד), ואז הרשימה */
async function refresh(userId) {
  const last = lastRefresh.get(userId) ?? 0;
  if (Date.now() - last >= REFRESH_GAP) {
    lastRefresh.set(userId, Date.now());
    await sweep({ force: true });
  }
  return forUser(userId);
}

/**
 * העובד חזר מפריוריטי — בדיקה של המסמך שפתח. כבר לא ממתין לו ← יוצא מהטבלה.
 * ‎{ gone, docno, status, next }‎ — ‎next‎: השם של החותם הבא, אם עוד ממתין (אצל מישהו אחר).
 */
async function check(userId, id) {
  const r = D.get('SELECT * FROM priority_waiting WHERE id = ? AND org_id = ? AND (signer_user_id = ? OR alt_user_id = ? OR owner_user_id = ?)', Number(id), ORG, userId, userId, userId);
  if (!r) return { gone: true, docno: '', status: '', next: '' };
  const sentOnly = Number(r.signer_user_id) !== Number(userId) && Number(r.alt_user_id) !== Number(userId);
  const s = (found()?.screens ?? []).find((x) => x.screen === r.screen);
  if (!s) return { gone: false, docno: r.docno, status: r.status, next: '' };
  const doc = await Priority.waitingDoc(r.company, s, r.docno);
  const waiting = doc && /לאישור/.test(String(doc.STATDES ?? ''));
  const g = waiting ? signerOf(doc, s) : { signer: null, alt: null };
  // ששלחתי — יוצא רק כשכבר אינו ממתין (חותם אחר — הסבב הבא יעדכן אצל מי)
  if (waiting && (sentOnly || (g.signer === r.signer && g.alt === r.alt))) return { gone: false, docno: r.docno, status: doc.STATDES, next: '' };
  D.run('DELETE FROM priority_waiting WHERE id = ?', r.id);
  let next = '';
  if (waiting && g.signer) {
    const list = await Priority.priorityUsers().catch(() => []);
    next = list.find((u) => u.USERLOGIN === g.signer)?.SNAME || g.signer;
  }
  return { gone: true, docno: r.docno, status: String(doc?.STATDES ?? ''), next };
}

// ---------------------------------------------------------------- מנהלי המערכת

/** סוגי האישורים, חותמים שלא מקושרים, ומסמכים בלי חותם */
async function adminView() {
  const f = found();
  const counts = new Map(D.all('SELECT screen, COUNT(*) AS n FROM priority_waiting WHERE org_id = ? GROUP BY screen', ORG).map((r) => [r.screen, r.n]));
  const types = (f?.screens ?? []).map((s) => {
    const t = typeOf(s.screen);
    return {
      screen: s.screen, name: t.name, suggested: KNOWN[s.screen]?.name ?? '', on: t.on, status: s.status, error: s.error,
      known: Boolean(KNOWN[s.screen]), isNew: Boolean(!KNOWN[s.screen] && s.firstSeen && Date.now() - Date.parse(s.firstSeen) < NEW_DAYS * DAY),
      count: counts.get(s.screen) ?? 0
    };
  }).sort((a, b) => (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1) || (b.known - a.known) || b.count - a.count || a.screen.localeCompare(b.screen));
  const prUsers = await Priority.priorityUsers().catch(() => []);
  const unmapped = D.all(`SELECT signer AS login, COUNT(*) AS n FROM priority_waiting WHERE org_id = ? AND signer IS NOT NULL AND signer_user_id IS NULL
    GROUP BY signer ORDER BY n DESC`, ORG).map((r) => {
    const pr = prUsers.find((u) => u.USERLOGIN === r.login);
    return { login: r.login, name: pr?.SNAME ?? '', email: pr?.EMAIL ?? '', count: r.n };
  });
  const noSigner = D.all('SELECT company, screen, docno FROM priority_waiting WHERE org_id = ? AND signer IS NULL ORDER BY company, docno LIMIT 50', ORG);
  const users = D.all("SELECT id, full_name AS name FROM users WHERE status = 'active' AND role <> 'vendor' ORDER BY full_name");
  return { types, unmapped, noSigner, users, discoveredAt: f?.at ?? null, sweptAt: state().at ?? null, errors: state().errors ?? [] };
}

/** שם בעברית / דלוק או כבוי לסוג. מסך שכובה — השורות שלו יוצאות מיד */
function setType(screen, { name, on } = {}) {
  if (!(found()?.screens ?? []).some((s) => s.screen === screen)) throw Object.assign(new Error('אין סוג כזה'), { status: 404 });
  const all = typeSettings();
  const cur = all[screen] ?? {};
  const next = { ...cur };
  if (name !== undefined) next.name = String(name ?? '').trim().slice(0, 40);
  if (on !== undefined) next.on = Boolean(on);
  D.setSetting(TYPES_KEY, { ...all, [screen]: next });
  if (next.on === false) D.run('DELETE FROM priority_waiting WHERE org_id = ? AND screen = ?', ORG, screen);
  return typeOf(screen);
}

/** קישור חותם בפריוריטי למשתמש משימון (‎priority_user_map‎) — והשורות שלו מתעדכנות מיד */
function mapUser(login, userId) {
  const l = String(login ?? '').trim();
  const u = D.get("SELECT id FROM users WHERE id = ? AND status = 'active'", Number(userId));
  if (!l || !u) throw Object.assign(new Error('צריך חותם ומשתמש משימון פעיל'), { status: 400 });
  D.setSetting('priority_user_map', { ...(D.getSetting('priority_user_map', {}) ?? {}), [l]: u.id });
  D.run('UPDATE priority_waiting SET signer_user_id = ? WHERE org_id = ? AND signer = ?', u.id, ORG, l);
  D.run('UPDATE priority_waiting SET alt_user_id = ? WHERE org_id = ? AND alt = ?', u.id, ORG, l);
  return { login: l, userId: u.id };
}

// ---------------------------------------------------------------- 🤖 הבוט: "מה מחכה לי?"

/** הכיתובים של הכפתורים — בדיוק מה שהבוט מבין */
const BOT_BTN = Object.freeze({ sign: '✍️ מה מחכה לי', sent: '📤 ששלחתי לאישור', alt: '🔁 כמחליף' });
const BOT_LIMIT = 8;

/** העובד משתתף בסבב אישורים בפריוריטי — חותם, מחליף, או ששלח משהו שממתין עכשיו */
const involved = (userId) => Boolean(D.get('SELECT 1 AS ok FROM priority_waiting WHERE org_id = ? AND (signer_user_id = ? OR alt_user_id = ? OR owner_user_id = ?) LIMIT 1',
  ORG, userId, userId, userId));

/**
 * בקשה לבוט: ‎{ kind: 'sign' | 'sent' | 'alt', soft }‎ או ‎null‎. ‎soft‎ — ניסוח שיכול להתכוון גם למשהו אחר
 * ("מה מחכה לי", "מה ממתין לאישורי" — גם ההצעות של משימון): רק כשבאמת יש משהו בפריוריטי, ולא באמצע שאלה פתוחה.
 */
function botAsk(text) {
  const raw = String(text ?? '').trim();
  const t = raw.replace(/^[^\p{L}\d]+/u, '').replace(/[\s?!.]+$/u, '').replace(/\s+/g, ' ');
  if (!t || t.split(' ').length > 8) return null;
  if (raw === BOT_BTN.sign) return { kind: 'sign', soft: false };
  if (raw === BOT_BTN.sent || /^(?:מה\s+)?ש?(?:שלחתי|העברתי)\s+ל?אישור(?:\s+(?:ב|של)?פריוריטי)?$/u.test(t)) return { kind: 'sent', soft: false };
  if (raw === BOT_BTN.alt || /^(?:מה\s+(?:מחכה|ממתין)\s+(?:לי\s+)?)?כמחליף$/u.test(t)) return { kind: 'alt', soft: false };
  if (/^מה\s+(?:מחכה|ממתין|ממתינים|ממתינה)\s+(?:לי\s+)?ל?(?:חתימה|חתימתי|חתימה\s+שלי)(?:\s+(?:ב)?פריוריטי)?$/u.test(t)) return { kind: 'sign', soft: false };
  if (/^מה\s+(?:מחכה|ממתין|ממתינים)\s+(?:לי\s+)?(?:ל?אישור(?:י|\s+שלי)?\s+)?ב?פריוריטי$/u.test(t)) return { kind: 'sign', soft: false };
  if (/^מה\s+(?:מחכה|ממתין|ממתינים)\s+(?:לי|ל?אישורי|ל?אישור\s+שלי)$/u.test(t)) return { kind: 'sign', soft: true };
  return null;
}

const money = (n) => (n === null || n === undefined ? '' : `₪${Math.round(n).toLocaleString('en-US')}`);
const ageText = (w) => `${w.days === 0 ? 'מהיום' : w.days === 1 ? 'יום אחד' : `${w.days} ימים`}${w.level === 'late' ? ' 🔴' : w.level === 'warn' ? ' 🟠' : ''}`;

/**
 * התשובה בבוט: הרשימה (עד 8, הוותיק קודם) עם קישור לכל מסמך, וכפתורים לשתי הרשימות האחרות כשיש בהן משהו.
 * ‎{ text, buttons, count, result }‎. ‎app‎ — כתובת משימון (ל"ועוד N").
 */
async function botReply(user, kind = 'sign', { app = '' } = {}) {
  const userId = typeof user === 'object' ? user.id : user;
  const { items, at } = await forUser(userId);
  const by = { sign: items.filter((w) => w.role === 'sign'), alt: items.filter((w) => w.role === 'alt'), sent: items.filter((w) => w.role === 'sent') };
  const list = by[kind] ?? [];
  if (!items.length) {
    const u = typeof user === 'object' ? user : D.get('SELECT id, full_name, email FROM users WHERE id = ?', userId);
    const login = await Approvals.priorityLoginFor(u).catch(() => null);
    if (!login) {
      return { text: 'לא מצאתי אותך כמשתמש בפריוריטי, ולכן אני לא יודע מה ממתין לך שם.\nמנהל המערכת יכול לקשר אותך (משימון פריוריטי ← סוגי אישורים).', buttons: [], count: 0, result: 'לא מקושר לפריוריטי' };
    }
  }
  const head = { sign: '✍️ *ממתין לחתימה שלך בפריוריטי*', alt: '🔁 *ממתין לחתימה שלך — כמחליף*', sent: '📤 *ששלחת לאישור — ממתין לאחרים*' }[kind];
  const empty = { sign: '✅ אין כרגע שום דבר שממתין לחתימה שלך בפריוריטי.', alt: 'אין כרגע מסמכים שממתינים לך כמחליף.', sent: 'אין כרגע מסמכים ששלחת ושממתינים לאישור.' }[kind];
  const lines = [];
  if (!list.length) lines.push(empty);
  else {
    lines.push(`${head} — ${list.length}`, '');
    list.slice(0, BOT_LIMIT).forEach((w, i) => {
      const who = w.role === 'sent' ? (w.waitingFor ? `ממתין ל${w.waitingFor}` : 'אין חותם ידוע') : w.role === 'alt' ? `כמחליף של ${w.altFor}` : '';
      lines.push(`${i + 1}. *${w.type} ${w.docno}* · ${w.companyName}`);
      lines.push(`   ${[w.party, money(w.amount), who, ageText(w)].filter(Boolean).join(' · ')}`);
      lines.push(`   🔗 ${w.link}`);
    });
    if (list.length > BOT_LIMIT) lines.push('', `ועוד ${list.length - BOT_LIMIT}${app ? ` — כולם במשימון פריוריטי: ${app}/priority` : ' — כולם במשימון פריוריטי.'}`);
    if (kind !== 'sent') lines.push('', '_האישור עצמו — בפריוריטי: הקישור פותח את המסמך._');
  }
  const others = ['sign', 'sent', 'alt'].filter((k) => k !== kind && by[k].length);
  if (others.length) lines.push('', others.map((k) => `${{ sign: '✍️ לחתימה שלך', sent: '📤 ששלחת לאישור', alt: '🔁 כמחליף' }[k]}: ${by[k].length}`).join(' · '));
  if (at && Date.now() - Date.parse(at) > 20 * 60000) lines.push(`_עודכן מפריוריטי ב-${new Date(at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}_`);
  return {
    text: lines.join('\n'),
    buttons: others.map((k) => BOT_BTN[k]),
    count: list.length,
    result: `${kind}: ${list.length}${others.length ? ` (${others.map((k) => `${k} ${by[k].length}`).join(', ')})` : ''}`
  };
}

let timer = null;
function start() {
  if (timer) clearInterval(timer);
  const tick = () => sweep().catch((err) => console.error('[משימון] ממתין לאישורך — סבב:', err.message));
  timer = setInterval(tick, 2 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 45000).unref?.();
}

module.exports = {
  KNOWN, FALLBACK_NAME, WARN_DAYS, LATE_DAYS,
  signerOf, discover, sweep, forUser, refresh, check, adminView, setType, mapUser, start, typeOf,
  BOT_BTN, involved, botAsk, botReply
};
