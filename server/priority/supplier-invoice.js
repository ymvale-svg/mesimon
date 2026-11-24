'use strict';
/**
 * 🧾 חשבונית ספק — **במשימון פריוריטי בלבד** (‎/priority/invoice‎; הוחלט 24.11.26: בבוט אין חשבונית ספק).
 * חשבונית מס של ספק ← חשבונית ספק בפריוריטי (חשבונית מרכזת, ‎PINVOICES‎) שמושכת את הבסיס שלה: **GR** (קבלת סחורה, מהזמנה
 * או בלי) או **חשבון חלקי** (PC, מחוזה).
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md" ("חשבונית ספק — פעולה אחת, שלושה בסיסים"). התבנית — כפי שהנהלת החשבונות
 * קולטת היום (‎GI26000060‎ ב-raba: חשבונית מס 10288 של הרמן, שמושכת את ‎GR26000033‎ — שנקלט על חשבונית העסקה 90016).
 *
 * העובד מעלה את החשבונית במסך חשבונית ספק ("להתחיל כאן"). המנוע:
 *   1. קורא את המסמך (אותה קריאה כמו בקבלת הסחורה — ‎GoodsReceipt.extractDoc‎).
 *   2. חברה — לפי הנמען, רק חברה שפתוחה ושהעובד משויך אליה.            ← בחירה כשלא ברור
 *   3. ספק — לפי ח.פ., אחרת לפי שם.                                        ← בחירה כשלא ברור
 *   4. כפילות: אותו ספק ואותו מספר חשבונית כבר בפריוריטי — עוצרים ("כבר נקלטה: GI…").
 *   5. **הבסיס — לפי השורות** (‎pickBasis‎): המועמדים — ה-GR הסופיים של הספק שעוד לא נמשכו, והחשבונות החלקיים שלא חויבו.
 *      מספר של מועמד שעל המסמך (GR / PC / תעודה / הזמנה / חוזה) — הוא. אחרת שורות החשבונית מול השורות של כל מועמד (סכום, כמות,
 *      מחיר, תיאור) והסכום לפני מע"מ; הטוב ביותר כשהוא ברור. כמה GR שסכומם הסכום בחשבונית — כולם. לא ברור — העובד בוחר.
 *   6. GR — סיכום לפני "כן" (ספק, חשבונית, ה-GR, סכומים, תואם / פער וממה הוא נובע).
 *      חשבון חלקי — ‎pc-invoice.js‎: השרשרת (ספק, מבוטל, חויב, **מאושר**), עכבון, מספר הקצאה, ואז "כן".
 *   7. אחרי "כן": חשבונית זמנית (‎T…‎) ← משיכת הבסיס (השורות נמשכות ממנו) ← מספר ההקצאה ← צילום החשבונית כנספח ←
 *      דו-שיח פנימי ← קריאה חזרה והשוואה.
 *
 * **החשבונית נשארת טיוטא** — הנהלת החשבונות בודקת וסוגרת בפריוריטי. חשבונית זמנית אי אפשר למחוק ב-API, ולכן שום דבר
 * לא נכתב לפני "כן", ו"ביטול" אחרי הקליטה — הנחיה למחוק בפריוריטי (והתראה למנהלי המערכת).
 *
 * מצב השיחה — בהעדפות העובד (‎user_prefs.supplierInvoice‎, לא בטבלת ההגדרות); הקובץ — בתיקיית ההעלאות עד סוף הקליטה.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../core').Db;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Claude = require('../integrations').Claude;
const Priority = require('../integrations').Priority;
const WhatsApp = require('../integrations').Whatsapp;
const { BTN, labels, sameLabel } = require('../whatsapp').WaUi;
const Access = require('./priority-access');
const Chain = require('./priority-chain');
const GoodsReceipt = require('./goods-receipt');
const PcInvoice = require('./pc-invoice');
const { notOpening } = require('./opens-guard');

const TTL = 24 * 60 * 60 * 1000;
const UNDO_MS = 15 * 60 * 1000;
const TZ = 'Asia/Jerusalem';
const FILES_DIR = () => path.join(D.UPLOADS_DIR, 'supplier-invoice');
const idleMs = () => Math.max(1, Number(D.getSetting('wa_question_ttl_min', 15)) || 15) * 60 * 1000;
/** סטייה מותרת בהשוואת סכומים (עיגול) */
const ROUND = 1;
const MAX_SUBSET = 12;
/** מספר הקצאה — חובה מעל 5,000 ₪ לפני מע"מ (חשבוניות ישראל, מ-01.06.26); כמו ב-‎pc-invoice.js‎ */
const ALLOCATION_FROM = 5000;
const allocationOf = (d) => String(d?.allocation_number ?? '').replace(/\D/g, '');

/** "חשבונית ספק", "קליטת חשבונית ספק", "חשבוניות ספקים", הכפתור "🧾 חשבונית ספק" */
const TRIGGER = /חשבוני(?:ת|ות)\s+(?:ה)?ספק(?:ים)?(?=[\s,.!?:]|$)/;
const MENU_BTN = '🧾 חשבונית ספק';
const START = '🧾 *חשבונית ספק* — שלחו צילום של החשבונית. אמצא את קבלת הסחורה (GR) שלה בפריוריטי, ואקלוט חשבונית שמושכת אותה.';
const YES = /^(כן|נכון|מאשר|מאשרת|אשר|אישור|תקין|יאללה|אוקי|אוקיי|סבבה|ok|yes|👍|👌|✅|✔)([\s,.!]|$)/i;
const CANCEL = /^(ביטול|בטל|לבטל|עזוב|יציאה|stop|🗑)([\s,.!]|$)/i;
const UNDO = (t) => /^👎+$/u.test(t) || /^(?:(?:נא|בבקשה|צריך|אפשר)\s+)?(ביטול|בטל|לבטל|תבטל|תבטלי|🗑)([\s,.!🗑]|$)/u.test(t);
const GR_RE = /GR\s*-?\s*(\d{6,})/gi;

// ---------------------------------------------------------------------------
// מצב
// ---------------------------------------------------------------------------

const STATE = 'supplierInvoice';
const DONE = 'supplierInvoiceDone';
const pref = (userId, k) => D.userPrefs(userId)[k] ?? null;
function load(userId) {
  const s = pref(userId, STATE);
  return s && typeof s === 'object' && s.step ? s : null;
}
const fresh = (s) => Boolean(s && Date.now() - (s.at ?? 0) < TTL);
function save(userId, s) { D.setUserPref(userId, STATE, { ...s, at: Date.now() }); }
function clear(userId, s) {
  for (const f of s?.files ?? []) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } }
  D.setUserPref(userId, STATE, null);
}
/** העובד באמצע שיחה עם החשבונית (15 דקות מההודעה האחרונה; לחיצה על כפתור — עד שהקליטה נשכחת) */
const active = (userId, late = false) => {
  const s = load(userId);
  return Boolean(fresh(s) && (Date.now() - (s.at ?? 0) < idleMs() || late));
};
const pending = (userId) => fresh(load(userId));
/** 🔒 המסמך שהשאלה עליו (‎WaQuestions‎) — כפתור של חשבונית אחרת אינו תשובה */
const docId = (userId) => { const s = load(userId); return fresh(s) ? String(s.startedAt || '') || null : null; };
const isTrigger = (text) => TRIGGER.test(String(text ?? ''));
/** פותח רק במפורש: "חשבונית ספק" (כתוב, בכיתוב לתמונה, או הכפתור) — ולא כשזו בקשה אחרת שמזכירה חשבונית */
const opens = (text) => isTrigger(text) && !notOpening(text);
/** חשבונית שנקלטה ב-15 הדקות האחרונות — ל-👎 / "ביטול" מיד אחריה */
function lastDone(userId) {
  const v = pref(userId, DONE);
  return v && Date.now() - (v.at ?? 0) < UNDO_MS ? v : null;
}
const wantsUndo = (userId, text) => UNDO(String(text ?? '').trim()) && Boolean(lastDone(userId));

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------

const money = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const bullet = (x) => `• ${x}`;
const round2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const beforeVat = (d) => round2(d?.totals?.before_vat || d?.totals?.subtotal || 0);
const totalOf = (d) => round2(d?.totals?.total || 0);
/** "10288", "ח-ן 10288", "‎10,288‎" — רק ספרות ואותיות, לטיני קטן */
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^0-9a-z֐-׿]/g, '');
const docTitle = (d) => `${d?.doc_label && d.doc_label.length <= 24 ? d.doc_label : 'חשבונית'}${d?.doc_number ? ` ${d.doc_number}` : ''}`;
const grLine = (g) => `*${g.DOCNO}*${g.BOOKNUM ? ` (מסמך ${g.BOOKNUM})` : ''}${g.CURDATE ? ` · ${ymdHe(g.CURDATE)}` : ''}${g.PROJDES ? ` · ${g.PROJDES}` : ''} · ${money(g.DISPRICE)} ₪ לפני מע"מ`;
const sumOf = (grs, f = 'DISPRICE') => round2(grs.reduce((a, g) => a + Number(g[f] ?? 0), 0));

function alertAdmins(user, s, title, details) {
  const body = [`עובד: ${user?.full_name ?? ''}`, s?.company ? `חברה: ${s.company}` : null, s?.ivnum ? `חשבונית: ${s.ivnum}` : null,
    s?.doc?.doc_number ? `מסמך: ${s.doc.doc_number}${s.supplier ? ` של ${s.supplier.name}` : ''}` : null, ...details].filter(Boolean).join('\n');
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🧾 חשבונית ספק: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על חשבונית ספק:', err.message);
  }
}

async function saveFile(userId, file) {
  if (file.path) return { path: file.path, mime: file.mime || 'image/jpeg' };
  const buf = file.buf ?? await WhatsApp.download(file.url);
  fs.mkdirSync(FILES_DIR(), { recursive: true });
  const mime = file.mime || 'image/jpeg';
  const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
  const p = path.join(FILES_DIR(), `u${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
  fs.writeFileSync(p, buf);
  return { path: p, mime };
}

const reply = (s, text, extra = {}) => { if (s) s.lastPrompt = text; return { s, replies: [text], ...extra }; };
/** בחירה בכפתורים: עד 3 האפשרויות הראשונות; כפתור שנלחץ מתורגם למספר האפשרות */
function offer(s, names) {
  const list = labels(names.slice(0, 3));
  s.choices = { step: s.step, list };
  return list;
}
/** העזרים של השיחה ל-‎pc-invoice.js‎ (אותו חוזה כמו בקבלת הסחורה) */
function pcHelpers(user) {
  return {
    reply, offer, companyLine,
    // בחשבונית ספק אין "בוט רגיל" מאחור — תשובה לא ברורה חוזרת לשאלה
    pass: (s) => reply(s, `לא הבנתי. ${s.lastPrompt ?? ''}`.trim(), { status: 'unclear', result: 'תשובה לא ברורה (חשבון חלקי)' }),
    looksUnrelated: () => false,
    alertAdmins: (s, title, details) => alertAdmins(user, s, title, details)
  };
}

function buttonsFor(s) {
  if (!s) return [];
  if (PcInvoice.isPcStep(s)) return PcInvoice.buttons(s);
  if (s.choices?.step === s.step && s.choices.list?.length) return s.choices.list;
  if (s.step === 'confirm') return [BTN.yes, BTN.cancel];
  if (s.step === 'doc') return [BTN.cancel];
  return [];
}

// ---------------------------------------------------------------------------
// ההתאמה ל-GR — טהורה (נבדקת לבד)
// ---------------------------------------------------------------------------

/** כל המספרים שעל המסמך שיכולים להיות ה-‎BOOKNUM‎ של ה-GR או ההזמנה: מספר החשבונית, הזמנה, תעודות בשורות */
function refsOf(doc) {
  const texts = [doc?.doc_number, doc?.po_number, doc?.supplier_order_ref, ...(doc?.other_ids ?? []), ...(doc?.contract_refs ?? []),
    ...(doc?.lines ?? []).flatMap((l) => [l.description, l.supplier_code])].filter(Boolean).map(String);
  const out = new Set();
  for (const t of texts) {
    out.add(norm(t));
    for (const m of t.matchAll(/[A-Za-z]{0,3}\d[\d\-/]{2,}/g)) out.add(norm(m[0]));
  }
  out.delete('');
  return out;
}

/**
 * אילו GR החשבונית מושכת. ‎grs‎ — ה-GR הסופיים של הספק שעוד לא נמשכו (מהחדש לישן).
 * מחזיר ‎{ picked: [GR], how: 'ref' | 'amount' | 'sum' | null, options: [GR] }‎ — ‎picked‎ ריק כשלא ברור (‎options‎ — להצעה).
 */
function matchReceipts(doc, grs) {
  const list = grs ?? [];
  if (!list.length) return { picked: [], how: null, options: [] };
  const refs = refsOf(doc);
  const byRef = list.filter((g) => (g.BOOKNUM && refs.has(norm(g.BOOKNUM))) || (g.ORDNAME && refs.has(norm(g.ORDNAME))));
  if (byRef.length) return { picked: byRef, how: 'ref', options: byRef };
  const want = beforeVat(doc);
  if (!(want > 0)) return { picked: [], how: null, options: list.slice(0, 3) };
  const close = (x) => Math.abs(x - want) <= ROUND;
  const single = list.filter((g) => close(Number(g.DISPRICE ?? 0)));
  if (single.length === 1) return { picked: single, how: 'amount', options: single };
  if (single.length > 1) return { picked: [], how: null, options: single.slice(0, 3) };
  // צירוף של כמה GR שסכומם הסכום שבחשבונית (חשבונית מרכזת על כמה תעודות) — רק כשיש צירוף אחד בדיוק
  const pool = list.slice(0, MAX_SUBSET);
  const found = [];
  for (let mask = 1; mask < (1 << pool.length) && found.length < 2; mask++) {
    if ((mask & (mask - 1)) === 0) continue;   // GR אחד — כבר נבדק
    let sum = 0;
    for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) sum += Number(pool[i].DISPRICE ?? 0);
    if (close(sum)) found.push(pool.filter((_, i) => mask & (1 << i)));
  }
  if (found.length === 1) return { picked: found[0], how: 'sum', options: found[0] };
  // הקרובים ביותר בסכום — להצעה
  const near = [...list].sort((a, b) => Math.abs(Number(a.DISPRICE) - want) - Math.abs(Number(b.DISPRICE) - want)).slice(0, 3);
  return { picked: [], how: null, options: near };
}

/**
 * 🧮 הבסיס של החשבונית — לפי השורות (הוחלט 24.11.26): לכל מועמד (GR סופי שלא נמשך, או חשבון חלקי שלא חויב) משווים את שורות
 * החשבונית לשורות שלו — סכום, כמות, מחיר, תיאור — ואת הסכום לפני מע"מ. מספר של המועמד שמופיע במסמך גובר על הכל.
 * ‎cand‎: ‎{ kind: 'gr' | 'pc', id, booknum, ordname, amount, gross, lines: [{ des, qty, price, total }] | null }‎.
 * מחזיר את המועמדים עם ‎score‎ (0–1) ו-‎ref‎, מהטוב לפחות טוב.
 */
const lineTotal = (l) => round2(l.line_total || Number(l.qty ?? 0) * Number(l.unit_price ?? 0) * (1 - Number(l.discount_pct ?? 0) / 100));
const WORD = (t) => new Set(String(t ?? '').replace(/["'״׳]/g, '').split(/[\s,.\-–/()]+/).filter((w) => w.length >= 3 && !/^\d+([.,]\d+)?$/.test(w)));
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(1, Math.abs(Number(b)) * 0.005);
function lineScore(inv, base) {
  const mine = (inv ?? []).filter((l) => lineTotal(l) !== 0);
  // שורות שליליות (עכבון, הנחה) — לא חלק מההשוואה
  const theirs = (base ?? []).filter((l) => Number(l.total) > 0).map((l) => ({ ...l, used: false }));
  if (!mine.length || !theirs.length) return 0;
  let sum = 0;
  for (const l of mine) {
    const t = lineTotal(l);
    const words = WORD(l.description);
    let best = null;
    let bestPts = 0;
    for (const b of theirs.filter((x) => !x.used)) {
      let pts = 0;
      // סכום שווה לבד אינו מספיק (שני GR באותו סכום) — התיאור, הכמות והמחיר מכריעים
      if (near(t, b.total)) pts += 2;
      if (Number(l.qty) && near(l.qty, b.qty)) pts += 1;
      if (Number(l.unit_price) && near(l.unit_price, b.price)) pts += 1;
      if ([...WORD(b.des)].some((w) => words.has(w))) pts += 2;
      if (pts > bestPts) { bestPts = pts; best = b; }
    }
    if (best && bestPts >= 2) { best.used = true; sum += bestPts / 6; }
  }
  const covered = theirs.filter((x) => x.used).length / theirs.length;
  return round2(0.7 * (sum / mine.length) + 0.3 * covered);
}
function rankBases(doc, cands) {
  const refs = refsOf(doc);
  const want = beforeVat(doc);
  return (cands ?? []).map((c) => {
    const ref = [c.id, c.booknum, c.ordname].some((x) => x && refs.has(norm(x)));
    const amount = want > 0 && [c.amount, c.gross].some((x) => Number(x) && Math.abs(Number(x) - want) <= ROUND) ? 1 : 0;
    const lines = c.lines ? lineScore(doc?.lines, c.lines) : null;
    const score = round2(lines === null ? amount : 0.6 * lines + 0.4 * amount);
    return { ...c, ref, score };
  }).sort((a, b) => Number(b.ref) - Number(a.ref) || b.score - a.score);
}
/**
 * הבחירה: מספר במסמך (מועמד אחד) ← הוא; אחרת הטוב ביותר כשהוא ברור (‎≥ 0.6‎, ופער ‎0.15‎ מהבא); אחרת כמה GR שסכומם הסכום
 * בחשבונית (צירוף אחד בלבד); אחרת — שאלה. ‎{ picked: [cand], how, options: [cand] }‎
 */
function pickBasis(doc, cands) {
  const ranked = rankBases(doc, cands);
  if (!ranked.length) return { picked: [], how: null, options: [] };
  const byRef = ranked.filter((c) => c.ref);
  if (byRef.length === 1 || (byRef.length > 1 && byRef.every((c) => c.kind === 'gr'))) return { picked: byRef, how: 'ref', options: byRef };
  const pool = byRef.length ? byRef : ranked;
  const [a, b] = pool;
  if (a.score >= 0.6 && (!b || a.score - b.score >= 0.15)) return { picked: [a], how: a.lines ? 'lines' : 'amount', options: [a] };
  const grs = pool.filter((c) => c.kind === 'gr').map((c) => ({ ...c, DOCNO: c.id, DISPRICE: c.amount }));
  const m = matchReceipts({ ...doc, doc_number: '', po_number: '', supplier_order_ref: '', other_ids: [], lines: [] }, grs);
  if (m.how === 'sum') return { picked: m.picked, how: 'sum', options: m.picked };
  return { picked: [], how: null, options: pool.slice(0, 3) };
}

/**
 * ההשוואה: סכום החשבונית לפני מע"מ מול ה-GR. ‎{ ok, diff, rounding, lines: [טקסט] }‎ — ממה נובע הפער (לפי שורות, כשיש).
 * ‎grLines‎ — השורות של ה-GR (‎readReceipt‎), אם נקראו.
 */
function compare(doc, grs, grLines = []) {
  const inv = beforeVat(doc);
  const got = sumOf(grs);
  const diff = round2(inv - got);
  const out = { ok: Math.abs(diff) <= ROUND, rounding: diff !== 0 && Math.abs(diff) <= ROUND, diff, invoice: inv, receipts: got, lines: [] };
  if (out.ok || !grLines.length) return out;
  // שורה-שורה: שורה בחשבונית שאין לה שורה באותו סכום ב-GR, ולהפך
  const lineTotal = (l) => round2(l.line_total || Number(l.qty ?? 0) * Number(l.unit_price ?? 0) * (1 - Number(l.discount_pct ?? 0) / 100));
  const left = grLines.map((l) => ({ des: l.PDES || l.PARTNAME || '', total: round2(l.QPRICE ?? Number(l.TQUANT ?? 0) * Number(l.PRICE ?? 0)), qty: l.TQUANT, price: l.PRICE, used: false }));
  for (const l of doc?.lines ?? []) {
    const t = lineTotal(l);
    const hit = left.find((g) => !g.used && Math.abs(g.total - t) <= 0.05);
    if (hit) { hit.used = true; continue; }
    const same = left.find((g) => !g.used && g.des && l.description && (norm(g.des).includes(norm(l.description).slice(0, 6)) || norm(l.description).includes(norm(g.des).slice(0, 6))));
    if (same) {
      same.used = true;
      const why = Number(same.qty) !== Number(l.qty) ? `כמות: בחשבונית ${l.qty}, ב-GR ${same.qty}` : `מחיר: בחשבונית ${money(l.unit_price)}, ב-GR ${money(same.price)}`;
      out.lines.push(`${l.description}: ${money(t)} בחשבונית, ${money(same.total)} ב-GR (${why})`);
    } else {
      out.lines.push(`בחשבונית ולא ב-GR: ${l.description} — ${money(t)}`);
    }
  }
  for (const g of left.filter((x) => !x.used)) out.lines.push(`ב-GR ולא בחשבונית: ${g.des} — ${money(g.total)}`);
  out.lines = out.lines.slice(0, 8);
  return out;
}

// ---------------------------------------------------------------------------
// השלבים
// ---------------------------------------------------------------------------

const companyLine = (s) => `🏢 ${Priority.companyOf(s.company).name}${Priority.isTest(s.company) ? ' (סביבת בדיקה)' : ''}`;

async function onDoc(user, s, file) {
  s.files = [await saveFile(user.id, file)];
  let doc;
  try {
    doc = await GoodsReceipt.extractDoc(s.files[0]);
  } catch (err) {
    alertAdmins(user, s, 'קריאת מסמך נכשלה', [err.message]);
    return reply(s, 'לא הצלחתי לקרוא את החשבונית. נסו לצלם שוב, ישר ובאור טוב, כך שכל הדף ייראה — או *ביטול*.', { status: 'error', result: `קריאת מסמך נכשלה: ${err.message}` });
  }
  s.doc = doc;
  if (!(beforeVat(doc) > 0) && !(totalOf(doc) > 0)) {
    return reply(s, 'לא מצאתי סכום בחשבונית. נסו לצלם שוב, כך שכל הדף ייראה — או *ביטול*.', { status: 'unclear', result: 'אין סכום במסמך' });
  }
  return resolveCompany(user, s);
}

async function resolveCompany(user, s) {
  const r = Priority.resolveCompany(s.doc?.recipient_vat, { ids: s.doc?.other_ids ?? [], name: s.doc?.recipient_name ?? '' });
  const mine = (codes) => Access.filterForUser(user.id, codes);
  if (r.company && !mine([r.company]).length) {
    return { s: null, replies: [`החשבונית מופנית ל*${Priority.companyOf(r.company).name}*, ואינך משויך לחברה הזו בפריוריטי. פנו למנהל המערכת.`], status: 'denied', result: `חברה לא משויכת לעובד: ${r.company}` };
  }
  if (r.company) { s.company = r.company; return resolveSupplier(user, s); }
  if (r.matched) {
    return { s: null, replies: [`החשבונית מופנית ל*${r.matched.name}*, שעדיין לא פתוחה לקליטה מהבוט.`], status: 'denied', result: `חברה סגורה: ${r.matched.code}` };
  }
  const all = mine(Priority.allowed());
  if (!all.length) return { s: null, replies: ['אינך משויך לאף חברה בפריוריטי. פנו למנהל המערכת.'], status: 'denied', result: 'אין חברות למשתמש' };
  const real = all.filter((c) => !Priority.isTest(c));
  s.step = 'company';
  s.companyOptions = real.length ? real : all;
  offer(s, s.companyOptions.map((c) => Priority.companyOf(c).name));
  return reply(s, [`לא זיהיתי לאיזו חברה החשבונית מופנית (נמען: ${s.doc.recipient_name || '—'}).`, 'לאיזו חברה לקלוט?',
    ...s.companyOptions.map((c) => bullet(Priority.companyOf(c).name)), '', 'בחרו בכפתור, או כתבו את שם החברה. *ביטול* — לבטל.'].join('\n'));
}

async function resolveSupplier(user, s) {
  const found = await Priority.findSuppliers(s.company, { vat: s.doc.supplier_vat, name: s.doc.supplier_name });
  if (found.list.length === 1 && !found.weak) {
    s.supplier = { code: found.list[0].SUPNAME, name: found.list[0].SUPDES };
    return findReceipts(user, s);
  }
  s.step = 'supplier';
  s.supplierOptions = found.list.map((x) => ({ code: x.SUPNAME, name: x.SUPDES }));
  if (!s.supplierOptions.length) {
    return reply(s, [companyLine(s), '', `לא מצאתי בפריוריטי את הספק *${s.doc.supplier_name || '—'}*${s.doc.supplier_vat ? ` (ח.פ. ${s.doc.supplier_vat})` : ''}.`,
      'כתבו את מספר הספק בפריוריטי, או *ביטול*.'].join('\n'), { status: 'unclear', result: 'ספק לא נמצא' });
  }
  offer(s, s.supplierOptions.map((x) => x.name));
  return reply(s, [companyLine(s), '', `איזה ספק זה? (בחשבונית: ${s.doc.supplier_name || '—'})`, ...s.supplierOptions.map((x) => bullet(`${x.name} (${x.code})`)),
    '', 'בחרו בכפתור, או כתבו מספר ספק בפריוריטי. *ביטול* — לבטל.'].join('\n'));
}

async function findReceipts(user, s) {
  const dup = await Priority.findInvoiceByBooknum(s.company, s.supplier.code, s.doc.doc_number);
  if (dup) {
    clear(user.id, s);
    return { s: null, replies: [`ℹ️ ${docTitle(s.doc)} של *${s.supplier.name}* כבר נקלטה בפריוריטי: *${dup.IVNUM}* (${dup.STATDES}${dup.TOTPRICE ? `, ${money(dup.TOTPRICE)} ₪` : ''}). לא קלטתי שוב.`],
      status: 'ok', result: `כבר נקלטה: ${dup.IVNUM}` };
  }
  s.available = (await Priority.receiptsToInvoice(s.company, s.supplier.code)).map((g) => ({
    DOCNO: g.DOCNO, BOOKNUM: g.BOOKNUM ?? '', CURDATE: g.CURDATE ?? '', ORDNAME: g.ORDNAME ?? '', PROJDES: g.PROJDES ?? '',
    DISPRICE: Number(g.DISPRICE ?? 0), VAT: Number(g.VAT ?? 0), TOTPRICE: Number(g.TOTPRICE ?? 0)
  }));
  let pcs = [];
  try { pcs = await Priority.partialBills(s.company, s.supplier.code); } catch (err) { alertAdmins(user, s, 'חשבונות חלקיים לא נקראו', [err.message]); }
  s.pcs = pcs.map((x) => ({ DOCNO: x.DOCNO, ORDNAME: x.ORDNAME ?? '', BOOKNUM: x.BOOKNUM ?? '', STATDES: x.STATDES ?? '', PROJDES: x.PROJDES ?? '',
    MONTH: x.MED_EXEMONTH || ymdHe(x.CURDATE), NET: Number(x.MED_QPRICE ?? x.DISPRICE ?? 0) }));
  if (!s.available.length && !s.pcs.length) return noBasis(user, s);
  const cands = [
    ...s.available.map((g) => ({ kind: 'gr', id: g.DOCNO, booknum: g.BOOKNUM, ordname: g.ORDNAME, amount: g.DISPRICE, gross: null, lines: null })),
    ...s.pcs.map((p) => ({ kind: 'pc', id: p.DOCNO, booknum: p.BOOKNUM, ordname: p.ORDNAME, amount: p.NET, gross: null, lines: null }))
  ];
  // השורות — של המועמדים הקרובים (מספר במסמך, ואז הקרובים בסכום): עד 8 קריאות
  const want = beforeVat(s.doc);
  const order = rankBases(s.doc, cands).sort((a, b) => Number(b.ref) - Number(a.ref) || Math.abs(a.amount - want) - Math.abs(b.amount - want));
  for (const c of order.slice(0, 8)) {
    const at = cands.find((x) => x.kind === c.kind && x.id === c.id);
    try {
      if (c.kind === 'gr') at.lines = (await Priority.receiptLines(s.company, c.id)).map((l) => ({ des: l.PDES || l.PARTNAME, qty: l.TQUANT, price: l.PRICE, total: l.QPRICE }));
      else {
        at.lines = (await Priority.partialBillLines(s.company, c.id)).map((l) => ({ des: l.MED_SECDES || l.PDES, qty: l.TQUANT, price: l.MED_PRICE, total: l.MED_CQPRICE_BD }));
        at.gross = round2(at.lines.filter((l) => Number(l.total) > 0).reduce((a, l) => a + Number(l.total), 0));   // לפני עכבון
      }
    } catch { /* בלי שורות — לפי הסכום */ }
  }
  const m = pickBasis(s.doc, cands);
  s.how = m.how;
  if (m.picked[0]?.kind === 'pc') return choosePc(user, s, m.picked[0].id);
  if (m.picked.length) { s.picked = m.picked.map((c) => c.id); return summary(s); }
  return askReceipts(s, m.options);
}

/** החשבון החלקי נבחר — השרשרת, ההשוואה והעכבון ב-‎pc-invoice.js‎ */
function choosePc(user, s, docno) {
  return PcInvoice.choose({ ...s, uid: user.id }, pcHelpers(user), docno);
}

function noBasis(user, s) {
  clear(user.id, s);
  return { s: null, replies: [[companyLine(s), `🏭 ${s.supplier.name}`, '',
    `לא מצאתי אצל הספק קבלת סחורה *סופית* שעוד לא נמשכה לחשבונית, וגם לא חשבון חלקי שלא חויב — ולכן אין מה למשוך ל${docTitle(s.doc)}.`,
    'אם הסחורה עוד לא נקלטה — קודם *קבלת סחורה*, ואחר כך חשבונית ספק. אם יש GR או חשבון חלקי שעוד לא סופי — לאשר אותו קודם.'].join('\n')],
  status: 'unclear', result: 'אין GR סופי או PC פתוח לספק' };
}

const pcLine = (p) => `*${p.DOCNO}* — חשבון חלקי, חוזה ${p.ORDNAME}${p.MONTH ? `, ${p.MONTH}` : ''}${p.PROJDES ? ` · ${p.PROJDES}` : ''} · לתשלום ${money(p.NET)} ₪${p.STATDES && p.STATDES !== 'סופית' ? ` (${p.STATDES})` : ''}`;
const baseLine = (s, id) => { const g = s.available?.find((x) => x.DOCNO === id); if (g) return grLine(g); const p = s.pcs?.find((x) => x.DOCNO === id); return p ? pcLine(p) : id; };

function askReceipts(s, options) {
  s.step = 'receipts';
  s.receiptOptions = options.map((c) => c.id ?? c.DOCNO);
  const extra = [...(s.available ?? []).map((g) => g.DOCNO), ...(s.pcs ?? []).map((p) => p.DOCNO)].filter((id) => !s.receiptOptions.includes(id)).slice(0, 5);
  offer(s, s.receiptOptions);
  return reply(s, [companyLine(s), `🏭 ${s.supplier.name} · ${docTitle(s.doc)} · ${money(beforeVat(s.doc))} ₪ לפני מע"מ`, '',
    'לא מצאתי בוודאות לאיזו קבלת סחורה או לאיזה חשבון חלקי החשבונית שייכת. מה למשוך?', ...s.receiptOptions.map((id) => bullet(baseLine(s, id))),
    ...(extra.length ? ['', 'עוד פתוחים של הספק:', ...extra.map((id) => bullet(baseLine(s, id)))] : []),
    '', 'בחרו בכפתור, או כתבו את המספר (GR… / PC…; כמה GR — עם רווח). *ביטול* — לבטל.'].join('\n'), { status: 'unclear', result: 'בסיס לא ברור' });
}

function pickedOf(s) { return (s.picked ?? []).map((n) => s.available.find((g) => g.DOCNO === n)).filter(Boolean); }

async function summary(s) {
  s.step = 'confirm';
  const grs = pickedOf(s);
  const c = compare(s.doc, grs);
  s.compare = { ok: c.ok, diff: c.diff };
  const HOW = { ref: 'לפי המספר שעל המסמך', lines: 'לפי השורות', amount: 'לפי הסכום', sum: 'לפי הסכום — כמה תעודות', manual: 'בחרת' };
  const vat = s.doc.totals?.vat;
  return reply(s, [
    `🧾 *חשבונית ספק* — לבדיקה לפני קליטה`,
    companyLine(s),
    `🏭 ${s.supplier.name} (${s.supplier.code})`,
    `📄 ${docTitle(s.doc)}${s.doc.doc_date || s.doc.date ? ` מ-${ymdHe(s.doc.doc_date || s.doc.date)}` : ''}`,
    `💰 לפני מע"מ ${money(beforeVat(s.doc))}${vat ? ` · מע"מ ${money(vat)}` : ''}${totalOf(s.doc) ? ` · *סה"כ ${money(totalOf(s.doc))} ₪*` : ''}`,
    allocationOf(s.doc) ? `🔢 מספר הקצאה ${allocationOf(s.doc)} — לאמת`
      : beforeVat(s.doc) >= ALLOCATION_FROM ? `⚠️ אין מספר הקצאה בחשבונית (חובה מעל ${money(ALLOCATION_FROM)} ₪ לפני מע"מ) — בלעדיו אי אפשר לקזז את המע"מ.` : null,
    '',
    `📦 ימשכו לחשבונית (${HOW[s.how] ?? ''}):`,
    ...grs.map((g) => bullet(grLine(g))),
    '',
    c.ok ? `✅ תואם: ${money(c.invoice)} בחשבונית, ${money(c.receipts)} ב-GR${c.rounding ? ` (עיגול ${money(Math.abs(c.diff))})` : ''}.`
      : `⚠️ פער של *${money(Math.abs(c.diff))} ₪*: ${money(c.invoice)} בחשבונית, ${money(c.receipts)} ב-GR. החשבונית תיקלט בכל זאת — אבדוק שורה-שורה אחרי הקליטה, והנהלת החשבונות תבדוק לפני הסגירה.`,
    '',
    'החשבונית תיקלט *זמנית* — הסגירה בפריוריטי, אצל הנהלת החשבונות.',
    'לקלוט? *כן* 👍 · לשנות GR — כתבו את המספרים · *ביטול* 🗑️'
  ].filter((x) => x !== null).join('\n'), { status: 'ok', result: `סיכום: ${grs.map((g) => g.DOCNO).join(', ')}${c.ok ? '' : ` (פער ${c.diff})`}` });
}

/** מספרי GR שהעובד כתב — רק מה שפתוח אצל הספק */
function grsIn(s, text) {
  const want = [...String(text ?? '').matchAll(GR_RE)].map((m) => `GR${m[1]}`);
  const bare = String(text ?? '').match(/^\s*(\d{6,}(?:\s+\d{6,})*)\s*$/);
  if (!want.length && bare) want.push(...bare[1].split(/\s+/).map((n) => `GR${n}`));
  const known = want.filter((n) => s.available.some((g) => g.DOCNO === n));
  return { want, known, unknown: want.filter((n) => !known.includes(n)) };
}

async function create(user, s) {
  const grs = pickedOf(s);
  const c = s.company;
  let ivnum = null;
  try {
    ivnum = await Priority.createSupplierInvoice(c, { supname: s.supplier.code, booknum: s.doc.doc_number, date: s.doc.doc_date || s.doc.date, details: `ח-ן ${s.supplier.name}`, allocation: allocationOf(s.doc) });
    s.ivnum = ivnum;
    for (const g of grs) await Priority.addInvoiceReceipt(c, ivnum, g.DOCNO);
  } catch (err) {
    alertAdmins(user, s, 'קליטה נכשלה', [ivnum ? `החשבונית הזמנית ${ivnum} נוצרה, אבל משיכת ה-GR נכשלה — למחוק אותה בפריוריטי ("מחיקת חשבונית זמנית").` : 'החשבונית לא נוצרה.', err.message]);
    clear(user.id, s);
    return { s: null, replies: [ivnum
      ? `⚠️ החשבונית *${ivnum}* נפתחה בפריוריטי, אבל לא הצלחתי למשוך אליה את ה-GR. מנהל המערכת קיבל הודעה ויטפל.`
      : '⚠️ לא הצלחתי לקלוט את החשבונית בפריוריטי. מנהל המערכת קיבל הודעה.'], status: 'error', result: `קליטה נכשלה: ${err.message}` };
  }
  // צילום החשבונית — נספח; דו-שיח פנימי — מי קלט וממה. תקלה כאן לא עוצרת את הקליטה
  const notes = [];
  try {
    const f = s.files?.[0];
    if (f) await Priority.attachInvoice(c, ivnum, { buf: fs.readFileSync(f.path), mime: f.mime, description: docTitle(s.doc) });
  } catch (err) { notes.push('⚠️ צילום החשבונית לא צורף — לצרף ידנית.'); alertAdmins(user, s, 'נספח לא צורף', [err.message]); }
  let saved = null;
  try { saved = await Priority.readSupplierInvoice(c, ivnum); } catch { /* ההשוואה — מה-GR */ }
  let grLines = [];
  const before = saved ? round2(saved.DISPRICE ?? saved.QPRICE) : sumOf(grs);
  const cmp = compare(s.doc, [{ DISPRICE: before }]);
  if (!cmp.ok) {
    for (const g of grs) {
      try { grLines.push(...((await Priority.readReceipt(c, g.DOCNO)).lines ?? [])); } catch { grLines = []; break; }
    }
  }
  const full = compare(s.doc, [{ DISPRICE: before }], grLines);
  try {
    await Priority.setInvoiceDialog(c, ivnum, [
      `נקלט ע"י: ${user.full_name ?? ''} (משימון), ${nowHe()}`,
      `מסמך: ${docTitle(s.doc)}${s.doc.doc_date || s.doc.date ? ` מ-${ymdHe(s.doc.doc_date || s.doc.date)}` : ''} — מצורף בנספחים`,
      allocationOf(s.doc) ? `מספר הקצאה (מהחשבונית): ${allocationOf(s.doc)} — לאמת` : null,
      `קבלות סחורה: ${grs.map((g) => `${g.DOCNO}${g.BOOKNUM ? ` (${g.BOOKNUM})` : ''}`).join(', ')}`,
      full.ok ? `השוואה: תואם (${money(full.invoice)} לפני מע"מ)${full.rounding ? `, עיגול ${money(Math.abs(full.diff))}` : ''}`
        : `השוואה: פער ${money(full.diff)} — בחשבונית ${money(full.invoice)}, ב-GR ${money(full.receipts)}`,
      ...full.lines
    ]);
  } catch { /* הדו-שיח — לא קריטי */ }
  Chain.progress(user.id, 'invoice', { stage: 'waiting', docno: ivnum, company: c, supplier: s.supplier.name });
  D.setUserPref(user.id, DONE, { at: Date.now(), company: c, ivnum, supplier: s.supplier.name });
  clear(user.id, s);
  const total = saved ? ` · סה"כ ${money(saved.TOTPRICE)} ₪` : '';
  return { s: null, replies: [[
    `✅ חשבונית ספק *${ivnum}* נקלטה בפריוריטי (זמנית) — ${s.supplier.name}, ${docTitle(s.doc)}${total}.`,
    `📦 נמשכו: ${grs.map((g) => g.DOCNO).join(', ')}`,
    full.ok ? `✅ הסכום תואם ל-GR${full.rounding ? ` (עיגול ${money(Math.abs(full.diff))})` : ''}.`
      : [`⚠️ פער של *${money(Math.abs(full.diff))} ₪* (בחשבונית ${money(full.invoice)}, ב-GR ${money(full.receipts)}):`, ...(full.lines.length ? full.lines.map(bullet) : [bullet('לא מצאתי שורה מסוימת — לבדוק מול ה-GR')])].join('\n'),
    ...notes,
    '',
    'הסגירה — בפריוריטי, אצל הנהלת החשבונות. נרשם בדו-שיח הפנימי של החשבונית.'
  ].join('\n')], status: 'ok', result: `נקלטה ${ivnum}: ${grs.map((g) => g.DOCNO).join(', ')}${full.ok ? '' : ` (פער ${full.diff})`}`, docno: ivnum };
}

// ---------------------------------------------------------------------------
// השיחה
// ---------------------------------------------------------------------------

async function step(user, s, t, file) {
  if (PcInvoice.isPcStep(s)) {
    const r = await PcInvoice.step(user, { ...s, uid: user.id }, t, file, pcHelpers(user));
    const ivnum = r?.ivnum;
    if (ivnum) {
      Chain.progress(user.id, 'invoice', { stage: 'waiting', docno: ivnum, company: s.company, supplier: s.supplier?.name ?? '' });
      D.setUserPref(user.id, DONE, { at: Date.now(), company: s.company, ivnum, supplier: s.supplier?.name ?? '' });
    }
    if (!r.s) clear(user.id, s);
    return { ...r, docno: ivnum ?? null };
  }
  switch (s.step) {
    case 'doc':
      if (!file) return reply(s, START, { status: 'ok', result: 'מחכה לצילום' });
      return onDoc(user, s, file);
    case 'company': {
      const opts = s.companyOptions ?? [];
      const n = Number(t);
      const byNum = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1] : null;
      const byName = byNum ?? opts.find((c) => Priority.companyOf(c).name.includes(t) || c === t);
      if (!byName) return reply(s, `לא זיהיתי את החברה. בחרו בכפתור, או *ביטול*.\n\n${s.lastPrompt ?? ''}`, { status: 'unclear', result: 'חברה לא מזוהה' });
      s.company = byName;
      return resolveSupplier(user, s);
    }
    case 'supplier': {
      const opts = s.supplierOptions ?? [];
      const n = Number(t);
      let pick = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1] : opts.find((x) => x.code === t || (t.length >= 3 && x.name.includes(t)));
      if (!pick && /^\d{3,}$/.test(t)) {
        const x = await Priority.supplierByCode(s.company, t);
        if (x) pick = { code: x.SUPNAME, name: x.SUPDES };
      }
      if (!pick && t.length >= 3) {
        const found = await Priority.findSuppliers(s.company, { name: t });
        if (found.list.length === 1) pick = { code: found.list[0].SUPNAME, name: found.list[0].SUPDES };
      }
      if (!pick) return reply(s, `לא מצאתי ספק כזה. כתבו את מספר הספק בפריוריטי, או *ביטול*.`, { status: 'unclear', result: 'ספק לא נמצא' });
      s.supplier = pick;
      return findReceipts(user, s);
    }
    case 'receipts': {
      const n = Number(t);
      const opts = s.receiptOptions ?? [];
      const one = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1] : null;
      const pc = (one && /^PC/.test(one) ? one : null) ?? String(t).toUpperCase().match(/PC\s?\d{6,}/)?.[0]?.replace(/\s/g, '');
      if (pc) {
        if (!(s.pcs ?? []).some((x) => x.DOCNO === pc)) return reply(s, `${pc} — לא חשבון חלקי פתוח של ${s.supplier.name}.\n\n${s.lastPrompt ?? ''}`, { status: 'unclear', result: 'PC לא מזוהה' });
        s.how = 'manual';
        return choosePc(user, s, pc);
      }
      if (one) { s.picked = [one]; s.how = 'manual'; return summary(s); }
      const g = grsIn(s, t);
      if (g.known.length) { s.picked = g.known; s.how = 'manual'; return summary(s); }
      const why = g.unknown.length ? `${g.unknown.join(', ')} — לא GR סופי פתוח של ${s.supplier.name}.` : 'לא הבנתי איזה GR.';
      return reply(s, `${why}\n\n${s.lastPrompt ?? ''}`, { status: 'unclear', result: 'GR לא מזוהה' });
    }
    case 'confirm': {
      if (YES.test(t)) return create(user, s);
      const g = grsIn(s, t);
      if (g.known.length) {
        const remove = /^(בלי|הסר|להסיר|תסיר|תוריד|להוריד|לא)\b/.test(t);
        const add = /^(גם|הוסף|להוסיף|תוסיף|ועוד|\+)/.test(t);
        s.picked = remove ? s.picked.filter((x) => !g.known.includes(x)) : add ? [...new Set([...s.picked, ...g.known])] : g.known;
        if (!s.picked.length) return askReceipts(s, s.available.slice(0, 3));
        s.how = 'manual';
        return summary(s);
      }
      if (g.unknown.length) return reply(s, `${g.unknown.join(', ')} — לא GR סופי פתוח של ${s.supplier.name}.\n\n${s.lastPrompt ?? ''}`, { status: 'unclear', result: 'GR לא מזוהה' });
      return reply(s, `*כן* 👍 לקליטה, מספרי GR לשינוי ("גם GR26000041", "בלי GR26000040"), או *ביטול* 🗑️.\n\n${s.lastPrompt ?? ''}`, { status: 'unclear', result: 'תשובה לא ברורה בסיכום' });
    }
    default:
      clear(user.id, s);
      return { s: null, replies: ['החשבונית הסתיימה. לחשבונית חדשה — *חשבונית ספק* וצילום.'], status: 'ok', result: 'שלב לא מוכר' };
  }
}

/**
 * הודעה של העובד — טקסט, קובץ, או שניהם. ‎{ replies, buttons, status, result }‎; ‎pass‎ — לא לחשבונית (הבוט הרגיל).
 */
async function handle({ user, text = '', file = null, reaction = false }) {
  let t = String(text ?? '').replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '').replace(/(👍|👌|✅|✔|👎)\1+/gu, '$1').trim();
  let s = load(user.id);
  if (s && !fresh(s)) { clear(user.id, s); s = null; }

  // 👎 / "ביטול" מיד אחרי הקליטה — חשבונית זמנית אי אפשר למחוק מהבוט: הנחיה, והתראה למנהלי המערכת
  if (!s && !file && !isTrigger(t) && wantsUndo(user.id, t)) {
    const f = lastDone(user.id);
    D.setUserPref(user.id, DONE, null);
    alertAdmins(user, { company: f.company, ivnum: f.ivnum }, 'ביקש לבטל חשבונית', [`העובד ביקש לבטל את ${f.ivnum} (${f.supplier}) מיד אחרי הקליטה.`]);
    return { replies: [[`⚠️ את החשבונית הזמנית *${f.ivnum}* אי אפשר למחוק מהבוט.`,
      'בפריוריטי: *חשבוניות מרכזות לספק* ← *פעולות* ← *מחיקת חשבונית זמנית*. מנהל המערכת קיבל הודעה.'].join('\n')], status: 'ok', result: `ביטול אחרי קליטה: ${f.ivnum}` };
  }
  if (!Priority.isEnabled()) return { replies: ['החיבור לפריוריטי עוד לא הוגדר. פנו למנהל המערכת.'], status: 'error', result: 'פריוריטי לא מוגדר' };
  if (!Claude.isEnabled()) return { replies: ['קריאת מסמכים דורשת חיבור AI, שעוד לא הוגדר בשרת.'], status: 'error', result: 'AI לא מוגדר' };
  if (!Access.can({ type: 'user', id: user.id, role: user.role ?? D.get('SELECT role FROM users WHERE id = ?', user.id)?.role }, 'invoice')) {
    if (s) clear(user.id, s);
    return { replies: [Access.NO_ACCESS], status: 'denied', result: 'חשבונית ספק — לא מורשה' };
  }

  // "ביטול" — לפני הקליטה אין מה לבטל בפריוריטי
  if (s && !file && (CANCEL.test(t) || (isTrigger(t) && CANCEL.test(t.replace(TRIGGER, '').trim())))) {
    clear(user.id, s);
    Chain.progress(user.id, 'invoice', { stage: 'cancelled', company: s.company ?? '' });
    return { replies: ['🗑️ החשבונית בוטלה. לא נכתב דבר בפריוריטי.'], status: 'ok', result: 'ביטול' };
  }
  if (!s && CANCEL.test(t) && !file) return { replies: ['אין חשבונית ספק פתוחה.'], status: 'ok', result: 'אין מה לבטל' };

  // התחלה: "חשבונית ספק" (עם קובץ — מיד; בלי — מחכים לצילום). "חשבונית ספק" עם קובץ באמצע — מתחילים מחדש
  let restarted = '';
  if (!s || (file && isTrigger(t) && s.step !== 'doc')) {
    if (s) { clear(user.id, s); restarted = '↩️ החשבונית הקודמת בוטלה (לא נכתב דבר בפריוריטי). מתחיל עם המסמך החדש.'; }
    s = { step: 'doc', startedAt: Date.now() };
    if (!file) { save(user.id, s); return { replies: [START], buttons: [BTN.cancel], status: 'ok', result: 'התחלה' }; }
  }
  if (file && s.step !== 'doc') {
    save(user.id, s);
    return { replies: [`📎 יש חשבונית פתוחה. למסמך חדש — שלחו אותו עם הכיתוב *חשבונית ספק*.\n\n${s.lastPrompt ?? ''}`], buttons: buttonsFor(s), status: 'ok', result: 'קובץ באמצע — לא נקלט' };
  }
  // 👍 = כן; 👎 = לא — בסיכום: מה לשנות
  if (t === '👍' || t === '👌') t = 'כן';
  if (t === '👎' && s.step === 'confirm') {
    save(user.id, s);
    return { replies: [`👎 מה לשנות? כתבו מספרי GR ("גם GR…", "בלי GR…"), או *ביטול* 🗑️.\n\n${s.lastPrompt ?? ''}`], buttons: buttonsFor(s), status: 'ok', result: '👎 בסיכום' };
  }
  // כפתור מרשימה ← מספר האפשרות
  if (!file && s.choices?.step === s.step) {
    const i = (s.choices.list ?? []).findIndex((b) => sameLabel(t, b));
    if (i >= 0) t = String(i + 1);
  }
  s.choices = null;
  // תגובה (Reaction) שאינה 👍 / 👎 — לא תשובה
  if (reaction && !['כן', '👎'].includes(t)) { save(user.id, s); return { replies: [], status: 'ok', result: 'תגובה — לא תשובה' }; }

  let out;
  try {
    out = await step(user, s, t, file);
  } catch (err) {
    console.error('[משימון] חשבונית ספק נכשלה:', err.message);
    alertAdmins(user, s, 'תקלה', [err.message]);
    out = { s, replies: ['משהו השתבש מול פריוריטי. נסו שוב, או *ביטול*.'], status: 'error', result: err.message };
  }
  if (out.s) save(user.id, out.s);
  const replies = restarted ? [`${restarted}\n\n${out.replies[0] ?? ''}`, ...out.replies.slice(1)] : out.replies;
  return { replies, buttons: out.buttons ?? buttonsFor(out.s), status: out.status ?? 'ok', result: out.result ?? '', docno: out.docno ?? null };
}

/** בחירה בזרימה אחרת — חשבונית שעוד לא נכתבה יורדת בשקט (לא נכתב דבר בפריוריטי) */
function abandon(user) {
  const s = load(user.id);
  if (!s) return '';
  clear(user.id, s);
  return s.step === 'doc' ? '' : 'ℹ️ החשבונית הקודמת בוטלה (לא נכתב דבר בפריוריטי).';
}

/**
 * 🗂 תצוגה למסך (‎priority-desk.js‎). קריאה בלבד. ‎null‎ — אין חשבונית פתוחה.
 */
const VIEW_STEP = { doc: 'קריאת החשבונית', company: 'חברה', supplier: 'ספק', receipts: 'איזה GR', confirm: 'לבדיקה — מחכה ל"כן"',
  pc_pick: 'איזה חשבון חלקי', pc_confirm: 'חשבון חלקי — מחכה ל"כן"' };
function view(userId) {
  const s = load(userId);
  if (!fresh(s)) return null;
  const d = s.doc ?? {};
  const t = d.totals ?? {};
  const grs = s.available ? pickedOf(s) : [];
  return {
    flow: 'invoice', step: s.step, stepLabel: VIEW_STEP[s.step] ?? s.step,
    docType: s.doc ? (d.doc_label || 'חשבונית') : '', docNumber: d.doc_number ?? '', date: d.doc_date || d.date || '',
    company: s.company ? { code: s.company, name: Priority.companyOf(s.company).name, test: Priority.isTest(s.company) } : null,
    supplier: s.supplier ? { code: s.supplier.code, name: s.supplier.name } : (d.supplier_name ? { code: '', name: d.supplier_name, guess: true } : null),
    receipts: grs.map((g) => ({ docno: g.DOCNO, booknum: g.BOOKNUM, date: g.CURDATE, project: g.PROJDES, beforeVat: g.DISPRICE, total: g.TOTPRICE })),
    match: s.compare ?? null,
    docno: s.ivnum ?? '',
    partialBill: s.pc ? { docno: s.pc.docno, contract: s.pc.ordname, project: s.pc.projdes, net: s.pc.net, retention: s.pc.retention } : null,
    totals: { beforeVat: t.before_vat ?? null, vat: t.vat ?? null, total: t.total ?? null },
    editable: null, attachments: 0, canAttach: false,
    lines: grs.map((g, i) => ({ n: i + 1, description: `${g.DOCNO}${g.BOOKNUM ? ` · מסמך ${g.BOOKNUM}` : ''}${g.PROJDES ? ` · ${g.PROJDES}` : ''}`, qty: 1, price: g.DISPRICE }))
  };
}

module.exports = { pickBasis, rankBases, lineScore, TRIGGER, MENU_BTN, START, isTrigger, opens, active, pending, docId, wantsUndo, handle, abandon, view, matchReceipts, compare, refsOf, _load: load, _clear: (userId) => clear(userId, load(userId)) };
