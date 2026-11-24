'use strict';
/**
 * 🧾 חוזה ← חשבון חלקי ← חשבונית ספק (24.11.26).
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md", "חשבונית ספק מחשבון חלקי (חוזה)".
 *
 * אצל קבלן משנה עם חוזה (‎CO…‎) אין הזמנה ואין קבלת סחורה: הקבלן מגיש חשבון, הוא נקלט בפריוריטי כ*חשבון חלקי* (‎PC…‎)
 * מתוך כתב הכמויות של החוזה ועובר אישורים, והספק שולח *חשבונית מס*. כאן הבוט ממיר את החשבון לחשבונית ספק:
 *   1. העובד שולח את חשבונית המס (וברוב המקרים גם את תדפיס החשבון החלקי ואת דף החישוב של הקבלן) — הקריאה והחברה
 *      והספק — כמו בקבלת הסחורה (‎goods-receipt.js‎, אותו מנוע ואותה שיחה). כשלספק יש חשבון חלקי שלא חויב,
 *      הקליטה עוברת לכאן במקום לשאלת ההזמנה.
 *   2. החשבון: לפי המספר שבמסמכים (‎PC…‎ / ‎CO…‎), אחרת לפי הסכום, אחרת שואלים (כפתורים).
 *   3. השוואה: הסכום לפני מע"מ בחשבונית מול "לתשלום" בחשבון (אחרי עכבון). עיגול (עד 1 ₪) — ✅.
 *      **הספק לא קיזז עכבון** (החשבונית = החשבון לפני עכבון): מתריעים, ומציעים לגבות את העכבון בחשבון הבא — שורת
 *      העכבון בחשבונית מתאפסת, והעכבון נרשם לקיזוז בחשבון הבא של אותו חוזה (‎pc_retention_deferred‎). כשהחשבון הבא
 *      מגיע — הבוט מזכיר אותו (הוחלט 24.11.26).
 *   4. **רק חשבון סופי** (הוחלט 24.11.26): חשבון שעוד מחכה לאישור — הבוט אומר אצל מי, שומר את החשבונית
 *      (‎pc_invoice_waiting‎), ובסבב בודק. כשהחשבון סופי — מציע לעובד להמיר. כך לא נפתחת חשבונית זמנית שאי אפשר
 *      למחוק ב-API.
 *   5. אחרי "כן": חשבונית ספק זמנית (‎T…‎) במסך החשבוניות המרכזות, משיכת החשבון (‎PIVDOC_SUBFORM‎), נספחים
 *      ודו-שיח פנימי. החשבונית **נשארת זמנית** — הנהלת החשבונות בודקת וסוגרת.
 *
 * הרשאה: סוג המסמך "חשבונית ספק" (‎invoice‎) במטריצה. מי שלא מורשה — ממשיך בקבלת הסחורה כרגיל.
 * המודול אינו מייבא את ‎goods-receipt.js‎ (בלי מעגל): העזרים של השיחה מגיעים ב-‎h‎.
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const { BTN } = require('../whatsapp').WaUi;
const Access = require('./priority-access');

const WAIT_KEY = 'pc_invoice_waiting';
const DEFER_KEY = 'pc_retention_deferred';
const FILES_DIR = () => path.join(D.UPLOADS_DIR, 'pc-invoice');
const WAIT_DAYS = 30;
const CHECK_EVERY = 20 * 60 * 1000;
const RENOTIFY = 24 * 60 * 60 * 1000;
const MAX_NOTIFY = 3;
/*
 * מספר הקצאה חובה מעל סף (חוק ההסדרים — חשבוניות ישראל): 10,000 ₪ לפני מע"מ מ-01.01.26, 5,000 ₪ מ-01.06.26.
 * בלי מספר הקצאה אי אפשר לקזז את המע"מ שבחשבונית — מתריעים, לא עוצרים (הנה"ח מחליטה).
 */
const ALLOCATION_FROM = 5000;

const BTN_DEFER = 'עכבון בחשבון הבא';
const BTN_NOW = 'לקזז עכשיו';
const YES = /^(כן|נכון|מאשר|מאשרת|אשר|אישור|תקין|יאללה|אוקי|אוקיי|סבבה|להמיר|המר|ok|yes|👍|👌|✅|✔)([\s,.!]|$)/i;
const NO = /^(לא|אל|ממש לא|no|👎)([\s,.!]|$)/i;
const DEFER = /בחשבון\s*הבא|לגבות\s*(?:אחר\s*כך|בהמשך)|לדחות|נדחה|בלי\s*עכבון|ללא\s*עכבון/;
const NOW = /לקזז\s*(?:עכשיו|כבר)|עכשיו|כמו\s*שהוא|לפי\s*החשבון/;

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const isPcStep = (s) => String(s?.step ?? '').startsWith('pc_');

// ---------------------------------------------------------------------------
// מספרים מהמסמכים, סכומים והשוואה
// ---------------------------------------------------------------------------

/** ‎PC…‎ / ‎CO…‎ שמופיעים במסמך (שדה ‎contract_refs‎, וכל טקסט אחר שנקרא) */
function refsOf(doc) {
  const text = [...(doc?.contract_refs ?? []), doc?.doc_number, doc?.po_number, doc?.supplier_order_ref, ...(doc?.other_ids ?? []),
    ...(doc?.lines ?? []).map((l) => `${l.description} ${l.supplier_code}`)].join(' ').toUpperCase();
  const all = (re) => [...new Set([...text.matchAll(re)].map((m) => m[0].replace(/\s/g, '')))];
  return { pc: all(/PC\s?\d{6,}/g), co: all(/CO\s?\d{6,}/g) };
}

const docBeforeVat = (d) => r2(d?.totals?.before_vat || d?.totals?.subtotal || 0);

/** הסכומים של החשבון החלקי: לתשלום (אחרי עכבון), העכבון בחשבון הזה, ולפני עכבון */
function amountsOf(pc) {
  const net = r2(pc.MED_QPRICE ?? pc.DISPRICE);
  const retention = r2((pc.retention ?? []).reduce((a, x) => a + Number(x.QPRICE || 0), 0));
  const pct = (pc.retention ?? []).find((x) => x.PERCENT)?.PERCENT ?? null;
  return { net, retention, pct, gross: r2(net + retention), vat: r2(pc.VAT), total: r2(pc.TOTPRICE) };
}

/**
 * החשבונית מול החשבון. ‎match‎ — עד 1 ₪ · ‎retention‎ — החשבונית היא החשבון *לפני* עכבון (הספק לא קיזז) ·
 * ‎gap‎ — פער אחר · ‎unknown‎ — אין סכום בחשבונית.
 */
function compare(before, a) {
  if (!(before > 0)) return { kind: 'unknown', diff: 0 };
  const diff = r2(before - a.net);
  if (Math.abs(diff) <= 1) return { kind: 'match', diff };
  if (a.retention > 0 && Math.abs(before - a.gross) <= 1) return { kind: 'retention', diff };
  return { kind: 'gap', diff };
}

/** המאשרים שעוד לא אישרו: "גילעד קוגלמן (או AlexO)" */
function pendingApprovers(pc) {
  return (pc.approvers ?? []).filter((x) => x.UFLAG !== 'Y')
    .map((x) => `${x.USERNAME || x.USERLOGIN}${x.ALTUSERLOGIN ? ` (או ${x.ALTUSERLOGIN})` : ''}`);
}

/** עכבון שנדחה מחשבון קודם של אותו חוזה ועוד לא קוזז */
function deferredFor(company, ordname, exceptPc = '') {
  const all = D.getSetting(DEFER_KEY, []) ?? [];
  return all.filter((x) => x.company === company && x.ordname === ordname && !x.settledBy && x.pc !== exceptPc);
}

// ---------------------------------------------------------------------------
// כניסה: האם החשבונית שייכת לחשבון חלקי
// ---------------------------------------------------------------------------

/** העובד מורשה לחשבוניות ספק (מטריצת ההרשאות) */
const allowed = (uid) => Boolean(uid) && Access.of(uid).docs.includes('invoice');

/**
 * נקרא מקבלת הסחורה אחרי שהחברה והספק נקבעו. ‎null‎ — לא חשבון חלקי, וקבלת הסחורה ממשיכה כרגיל.
 * אחרת — התשובה של השלב הבא (הקליטה עוברת למצב ‎pc‎).
 */
async function start(s, h) {
  const d = s.doc ?? {};
  if (!allowed(s.uid)) return null;
  const refs = refsOf({ ...d, contract_refs: [...(d.contract_refs ?? []), ...(s.pcRefs ?? [])] });
  if (d.doc_type !== 'invoice' && !refs.pc.length && !refs.co.length) return null;
  let open;
  try {
    open = await Priority.partialBills(s.company, s.supplier.code);
  } catch (err) {
    // המסך סגור או תקלה — לא חוסמים את קבלת הסחורה; למנהלים
    h.alertAdmins(s, 'חשבונות חלקיים לא נקראו', [err.message]);
    return null;
  }
  // מספר חשבון שבמסמך — גם כשאינו ברשימה (חויב כבר / בוטל / של ספק אחר): אומרים מה מצאנו
  for (const no of refs.pc) {
    if (open.some((x) => x.DOCNO === no)) continue;
    const pc = await Priority.readPartialBill(s.company, no).catch(() => null);
    if (!pc) continue;
    if (pc.SUPNAME !== s.supplier.code) return stop(s, `החשבון החלקי *${no}* שבמסמך שייך לספק אחר (${pc.CDES}). בדקו את המסמכים.`, `PC של ספק אחר: ${no}`);
    if (pc.STATDES === 'מבוטלת') return stop(s, `החשבון החלקי *${no}* מבוטל בפריוריטי. אי אפשר להמיר אותו לחשבונית.`, `PC מבוטל: ${no}`);
    if (pc.IVALL === 'Y') return stop(s, `החשבון החלקי *${no}* כבר חויב בחשבונית ספק. לא נקלט שוב.`, `PC כבר חויב: ${no}`);
  }
  if (!open.length) return null;
  let list = open;
  const byPc = open.filter((x) => refs.pc.includes(x.DOCNO));
  const byCo = open.filter((x) => refs.co.includes(x.ORDNAME));
  if (byPc.length) list = byPc;
  else if (byCo.length) list = byCo;
  const before = docBeforeVat(d);
  // לפי הסכום: לתשלום, או לפני עכבון (העכבון נקרא רק לחשבון שנבחר — כאן מספיק "לתשלום" והמצטבר)
  if (list.length > 1 && before > 0) {
    const near = list.filter((x) => Math.abs(r2(x.MED_QPRICE) - before) <= 1 || Math.abs(r2(x.MED_DOCTOTPRICE) - before) <= 1);
    if (near.length) list = near;
  }
  s.mode = 'pc';
  if (list.length === 1) return choose(s, h, list[0].DOCNO);
  const opts = list.slice(0, 3);
  s.step = 'pc_pick';
  s.pcOptions = opts.map((x) => x.DOCNO);
  h.offer(s, opts.map((x) => x.DOCNO));
  return h.reply(s, [`🧾 *חשבונית ספק מחשבון חלקי* — חשבונית ${d.doc_number || ''}`.trim(), h.companyLine(s),
    `🚚 ספק: *${s.supplier.name}* (${s.supplier.code})`, '',
    `לספק יש ${list.length} חשבונות חלקיים שעוד לא חויבו. לאיזה מהם החשבונית?`,
    ...opts.map((x) => `• *${x.DOCNO}* — חוזה ${x.ORDNAME}, ${x.MED_EXEMONTH || ymdHe(x.CURDATE)}, לתשלום ${money(x.MED_QPRICE)} (${x.STATDES})`),
    '', 'בחרו בכפתור, או כתבו את מספר החשבון (PC…). *ביטול* — לבטל.'].join('\n'));
}

function stop(s, text, result) {
  return { s: null, replies: [text], status: 'denied', result };
}

/** החשבון נבחר: קוראים אותו (עכבון, מאשרים), משווים, ומציגים */
async function choose(s, h, docno) {
  const pc = await Priority.readPartialBill(s.company, docno);
  if (!pc) return h.reply(s, `לא מצאתי בפריוריטי את החשבון החלקי ${docno}. כתבו מספר אחר (PC…), או *ביטול*.`);
  if (pc.SUPNAME !== s.supplier.code) return h.reply(s, `החשבון ${docno} שייך לספק אחר (${pc.CDES}). כתבו מספר אחר, או *ביטול*.`);
  const dup = await Priority.findInvoiceByBooknum(s.company, s.supplier.code, s.doc.doc_number).catch(() => null);
  if (dup) return stop(s, `החשבונית ${s.doc.doc_number} של ${s.supplier.name} כבר נקלטה בפריוריטי: *${dup.IVNUM}* (${dup.STATDES}). לא נקלטה שוב.`, `חשבונית כפולה: ${dup.IVNUM}`);
  s.pc = {
    docno: pc.DOCNO, ordname: pc.ORDNAME, project: pc.PROJDOCNO, projdes: pc.PROJDES, month: pc.MED_EXEMONTH, status: pc.STATDES,
    pay: pc.MED_PAYDES, ...amountsOf(pc), pending: pendingApprovers(pc)
  };
  s.pcCmp = compare(docBeforeVat(s.doc), s.pc);
  s.pcDefer = false;
  if (!Priority.PC_READY.includes(pc.STATDES)) return wait(s, h);
  s.step = 'pc_confirm';
  return h.reply(s, summary(s, h));
}

/** הסיכום שלפני "כן" */
function summary(s, h, { head = true } = {}) {
  const d = s.doc;
  const p = s.pc;
  const t = d.totals ?? {};
  const before = docBeforeVat(d);
  const cmp = s.pcCmp;
  const prior = deferredFor(s.company, p.ordname, p.docno);
  const lines = [
    head ? `🧾 *חשבונית ספק מחשבון חלקי* — חשבונית ${d.doc_number}` : null,
    head ? h.companyLine(s) : null,
    `🚚 ספק: *${s.supplier.name}* (${s.supplier.code})`,
    `📑 חוזה ${p.ordname} · חשבון חלקי *${p.docno}*${p.month ? ` (חודש ביצוע ${p.month})` : ''}${p.projdes ? ` · ${p.projdes}` : ''}`,
    `📅 חשבונית מ-${ymdHe(d.doc_date || d.date) || '—'}${d.allocation_number ? ` · מספר הקצאה ${d.allocation_number}` : ''}`,
    `💰 בחשבונית: ${money(before)} + מע"מ ${money(t.vat)} = *${money(t.total)}*`,
    `💰 בחשבון: ${p.retention ? `${money(p.gross)} − עכבון${p.pct ? ` ${p.pct}%` : ''} ${money(p.retention)} = ` : ''}${money(p.net)} + מע"מ ${money(p.vat)} = *${money(p.total)}*`,
    cmp.kind === 'match' ? `✅ הסכומים מתאימים${cmp.diff ? ` (הפרש עיגול ${money(cmp.diff)})` : ''}` : null,
    cmp.kind === 'retention' ? `⚠️ *הספק לא קיזז עכבון* — החשבונית גבוהה מהחשבון ב-${money(cmp.diff)} (העכבון${p.pct ? ` ${p.pct}%` : ''}).` : null,
    cmp.kind === 'gap' ? `⚠️ *פער של ${money(cmp.diff)}* לפני מע"מ בין החשבונית לחשבון — לא עיגול ולא העכבון.` : null,
    cmp.kind === 'unknown' ? '⚠️ לא קראתי סכום לפני מע"מ בחשבונית — בדקו מול החשבון.' : null,
    !d.allocation_number && before >= ALLOCATION_FROM ? `⚠️ אין מספר הקצאה בחשבונית (חובה מעל ${money(ALLOCATION_FROM)} ₪ לפני מע"מ) — בלעדיו אי אפשר לקזז את המע"מ.` : null,
    ...prior.map((x) => `📌 עכבון שנדחה מ-${x.pc}${x.ivnum ? ` (חשבונית ${x.ivnum})` : ''}: *${money(x.amount)}* — לקזז בחשבון הזה.`),
    ...(d.warnings ?? []).map((w) => `⚠️ ${w}`),
    ''
  ];
  if (cmp.kind === 'retention') {
    lines.push(`*${BTN_DEFER}* — החשבונית תיקלט כמו של הספק (${money(before)}), והעכבון (${money(p.retention)}) יירשם לקיזוז בחשבון הבא של החוזה.`,
      `*${BTN_NOW}* — החשבונית תיקלט לפי החשבון (${money(p.net)}), עם פער מול הספק.`, 'או *ביטול*.');
  } else {
    lines.push(`להמיר לחשבונית ספק? *כן* 👍 — חשבונית זמנית בפריוריטי, שהנהלת החשבונות בודקת וסוגרת. או *ביטול*.`);
  }
  return lines.filter((x) => x !== null).join('\n');
}

/** החשבון עוד לא סופי: שומרים את החשבונית לסבב, ואומרים אצל מי */
function wait(s, h) {
  const p = s.pc;
  const files = (s.files ?? []).map((f) => copyFile(f)).filter(Boolean);
  const list = (D.getSetting(WAIT_KEY, []) ?? []).filter((x) => !(x.uid === s.uid && x.company === s.company && x.pc === p.docno));
  list.push({ uid: s.uid, company: s.company, pc: p.docno, supplier: s.supplier, doc: s.doc, via: s.via ?? null, companyHow: s.companyHow ?? null,
    supplierBy: s.supplierBy ?? null, files, since: Date.now(), checkedAt: Date.now(), notified: 0 });
  D.setSetting(WAIT_KEY, list);
  const who = p.pending.length ? `ממתין לאישור של: *${p.pending.join(', ')}*.` : '';
  return {
    s: null,
    replies: [[summary(s, h).split('\n\n').slice(0, -1).join('\n\n').replace(/\n$/, ''), '',
      `⏳ החשבון החלקי *${p.docno}* עוד *${p.status}* בפריוריטי, ואפשר להמיר רק חשבון סופי. ${who}`.trim(),
      'שמרתי את החשבונית. כשהחשבון יהיה סופי — אשלח לך הודעה, ונמיר בלחיצה.'].join('\n')],
    status: 'ok',
    result: `ממתין לחשבון סופי: ${p.docno} (${p.status})`
  };
}

function copyFile(f) {
  try {
    fs.mkdirSync(FILES_DIR(), { recursive: true });
    const to = path.join(FILES_DIR(), `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${path.basename(f.path)}`);
    fs.copyFileSync(f.path, to);
    return { ...f, path: to };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// השיחה
// ---------------------------------------------------------------------------

function buttons(s) {
  if (s.step === 'pc_confirm') return s.pcCmp?.kind === 'retention' ? [BTN_DEFER, BTN_NOW, BTN.cancel] : [BTN.yes, BTN.cancel];
  if (s.step === 'pc_pick') return s.choices?.step === 'pc_pick' ? s.choices.list : [BTN.cancel];
  return [];
}

async function step(user, s, t, file, h) {
  if (file) return h.reply(s, 'קיבלתי. כדי לצרף עוד מסמכים — שלחו אותם יחד עם החשבונית בפעם הבאה. עכשיו: ' + (s.step === 'pc_pick' ? 'לאיזה חשבון החשבונית?' : 'להמיר? *כן* 👍 או *ביטול*.'));
  switch (s.step) {
    case 'pc_pick': {
      const m = String(t).toUpperCase().match(/PC\s?\d{6,}/);
      const n = /^\s*\d{1,2}\s*$/.test(t) ? Number(t) : null;
      const docno = m ? m[0].replace(/\s/g, '') : n && s.pcOptions?.[n - 1] ? s.pcOptions[n - 1] : (s.pcOptions ?? []).find((x) => t.includes(x));
      if (!docno) {
        if (h.looksUnrelated(t)) return h.pass(s, 'לא תשובה לבחירת חשבון');
        return h.reply(s, 'לאיזה חשבון חלקי החשבונית? בחרו בכפתור או כתבו את המספר (PC…). *ביטול* — לבטל.');
      }
      return choose(s, h, docno);
    }
    case 'pc_confirm': {
      const ret = s.pcCmp?.kind === 'retention';
      if (ret && DEFER.test(t)) { s.pcDefer = true; return convert(user, s, h); }
      if (ret && (NOW.test(t) || YES.test(t))) { s.pcDefer = false; return convert(user, s, h); }
      if (!ret && YES.test(t)) return convert(user, s, h);
      if (NO.test(t)) return { s: null, replies: ['בסדר, לא הומר. 👍 החשבון החלקי נשאר כמו שהוא.'], status: 'ok', result: 'המרה נדחתה' };
      if (h.looksUnrelated(t)) return h.pass(s, 'לא תשובה לשאלת ההמרה');
      return h.reply(s, ret ? `*${BTN_DEFER}* — לגבות את העכבון בחשבון הבא, *${BTN_NOW}* — לפי החשבון, או *ביטול*.` : 'להמיר לחשבונית ספק? *כן* 👍 או *ביטול*.');
    }
    default:
      return h.reply(s, 'להמשך — *כן* 👍, או *ביטול*.');
  }
}

/** "כן": חשבונית זמנית, משיכת החשבון, עכבון לחשבון הבא, נספחים, דו-שיח, וקריאה חזרה */
async function convert(user, s, h) {
  const p = s.pc;
  const d = s.doc;
  // ייתכן שעבר זמן מהסיכום — בודקים שוב שהחשבון סופי ולא חויב
  const st = await Priority.partialBillStatus(s.company, p.docno);
  if (!st || st.STATDES === 'מבוטלת') return stop(s, `החשבון החלקי ${p.docno} ${st ? 'בוטל' : 'כבר לא קיים'} בפריוריטי. לא הומר.`, `PC ${st ? 'בוטל' : 'נמחק'}: ${p.docno}`);
  if (st.IVALL === 'Y') return stop(s, `החשבון החלקי ${p.docno} כבר חויב בחשבונית (כנראה נקלטה במחשב). לא הומר שוב.`, `PC כבר חויב: ${p.docno}`);
  if (!Priority.PC_READY.includes(st.STATDES)) { p.status = st.STATDES; return wait(s, h); }

  let ivnum;
  try {
    ivnum = await Priority.createSupplierInvoice(s.company, { supname: s.supplier.code, booknum: d.doc_number, date: d.doc_date || d.date, allocation: d.allocation_number || '', details: `${p.docno} ${p.month || ''}`.trim() });
  } catch (err) {
    h.alertAdmins(s, 'חשבונית ספק לא נפתחה', [`חשבון ${p.docno}`, err.message]);
    return h.reply(s, '⚠️ לא הצלחתי לפתוח את החשבונית בפריוריטי. מנהל המערכת קיבל הודעה. אפשר לנסות שוב — *כן* 👍, או *ביטול*.', { status: 'error', result: `פתיחת חשבונית: ${err.message}` });
  }
  try {
    await Priority.addInvoiceReceipt(s.company, ivnum, p.docno);
  } catch (err) {
    h.alertAdmins(s, 'החשבון החלקי לא נמשך לחשבונית', [`חשבונית זמנית ${ivnum} נפתחה ריקה — למשוך את ${p.docno} ידנית או למחוק אותה ("מחיקת חשבונית זמנית").`, err.message]);
    return { s: null, replies: [`⚠️ החשבונית הזמנית *${ivnum}* נפתחה, אבל החשבון ${p.docno} לא נמשך אליה. מנהל המערכת קיבל הודעה ויטפל.`], status: 'error', result: `משיכת ${p.docno} ל-${ivnum}: ${err.message}` };
  }
  const notes = [];
  // הספק לא קיזז עכבון — שורת העכבון בחשבונית מתאפסת, והעכבון נרשם לחשבון הבא
  let deferred = false;
  if (s.pcDefer) {
    try {
      const inv = await Priority.readSupplierInvoice(s.company, ivnum);
      const ret = inv.lines.filter((l) => (l.PARTNAME === '708' || /עכבון/.test(l.MED_SECDES ?? l.PDES ?? '')) && Number(l.QPRICE || l.PRICE || 0) !== 0);
      for (const l of ret) await Priority.setInvoiceLine(s.company, ivnum, l.KLINE, { PRICE: 0 });
      deferred = ret.length > 0;
      if (!deferred) notes.push('⚠️ לא מצאתי בחשבונית שורת עכבון לאפס — הנהלת החשבונות תבדוק.');
    } catch (err) {
      notes.push('⚠️ לא הצלחתי לאפס את העכבון בחשבונית — הנהלת החשבונות תתקן ידנית.');
      h.alertAdmins(s, 'העכבון לא אופס בחשבונית', [`${ivnum} (${p.docno}): ${err.message}`]);
    }
  }
  for (const [i, f] of (s.files ?? []).entries()) {
    try {
      await Priority.attachInvoice(s.company, ivnum, { buf: fs.readFileSync(f.path), mime: f.mime, description: i === 0 ? `חשבונית ${d.doc_number}` : (f.label || `נספח ${i}`) });
    } catch (err) {
      h.alertAdmins(s, 'נספח לא צורף לחשבונית', [`${ivnum}: ${err.message}`]);
    }
  }
  // עכבון שנדחה מחשבון קודם — החשבון הזה נקלט עם עכבון: נרשם שקוזז; נדחה שוב — נשאר פתוח
  const prior = deferredFor(s.company, p.ordname, p.docno);
  const all = D.getSetting(DEFER_KEY, []) ?? [];
  if (!s.pcDefer && prior.length) for (const x of all) if (prior.some((y) => y.pc === x.pc && y.company === x.company)) x.settledBy = { pc: p.docno, ivnum, at: Date.now() };
  if (s.pcDefer) all.push({ company: s.company, ordname: p.ordname, supplier: s.supplier, pc: p.docno, ivnum, amount: p.retention, by: user.id, at: Date.now(), applied: deferred });
  D.setSetting(DEFER_KEY, all);

  const dialog = [
    `נקלט מהבוט של משימון ע"י ${user.full_name ?? ''}, ${nowHe()}`,
    `חשבון חלקי ${p.docno} · חוזה ${p.ordname}${p.month ? ` · חודש ביצוע ${p.month}` : ''}`,
    `חשבונית הספק ${d.doc_number} מ-${ymdHe(d.doc_date || d.date)}: ${money(docBeforeVat(d))} + מע"מ ${money(d.totals?.vat)} = ${money(d.totals?.total)}`,
    s.pcDefer ? `הספק לא קיזז עכבון (${money(p.retention)}). ${deferred ? 'שורת העכבון אופסה בחשבונית —' : ''} העכבון יקוזז בחשבון הבא של החוזה ${p.ordname}.` : null,
    s.pcCmp?.kind === 'retention' && !s.pcDefer ? `הספק לא קיזז עכבון (${money(p.retention)}); נקלט לפי החשבון — פער מול חשבונית הספק.` : null,
    s.pcCmp?.kind === 'gap' ? `פער של ${money(s.pcCmp.diff)} לפני מע"מ בין חשבונית הספק לחשבון — לבדיקה.` : null,
    ...prior.map((x) => `עכבון שנדחה מ-${x.pc}: ${money(x.amount)} — ${s.pcDefer ? 'עדיין לא קוזז' : 'לבדוק שקוזז בחשבון הזה'}.`),
    ...(s.userNotes ?? []).map((n) => `הערה: ${n}`)
  ];
  await Priority.setInvoiceDialog(s.company, ivnum, dialog).catch((err) => h.alertAdmins(s, 'דו-שיח לא נכתב בחשבונית', [`${ivnum}: ${err.message}`]));

  let inv = null;
  try { inv = await Priority.readSupplierInvoice(s.company, ivnum); } catch { /* הסיכום בלי הקריאה חזרה */ }
  const got = r2(inv?.DISPRICE ?? inv?.QPRICE ?? 0);
  const want = docBeforeVat(d);
  const ok = inv && want > 0 && Math.abs(got - want) <= 1;
  if (s.pcDefer) h.notifyAccounting(s, `עכבון נדחה: ${p.docno}`, [`חשבונית ${ivnum} של ${s.supplier.name} נקלטה בלי עכבון (${money(p.retention)}).`, `לקזז בחשבון הבא של החוזה ${p.ordname}.`]);
  dropWaiting(s.uid, s.company, p.docno);
  return {
    s: null,
    replies: [[
      `✅ *${ivnum}* — חשבונית ספק זמנית מהחשבון החלקי *${p.docno}*.`,
      inv ? `💰 בפריוריטי: ${money(got)} + מע"מ ${money(inv.VAT)} = *${money(inv.TOTPRICE)}*${ok ? ' ✅ כמו חשבונית הספק' : ` ⚠️ בחשבונית הספק ${money(want)} לפני מע"מ`}` : null,
      s.pcDefer ? `📌 העכבון (${money(p.retention)}) נרשם לקיזוז בחשבון הבא של החוזה ${p.ordname}. אזכיר כשהחשבון יגיע.` : null,
      ...notes,
      'החשבונית נשארת זמנית — הנהלת החשבונות בודקת וסוגרת. המסמכים צורפו, והפרטים בדו-שיח הפנימי.'
    ].filter(Boolean).join('\n')],
    status: 'ok',
    result: `חשבונית ${ivnum} מ-${p.docno}${s.pcDefer ? ' (עכבון נדחה)' : ''}`,
    ivnum
  };
}

// ---------------------------------------------------------------------------
// ממתינים לחשבון סופי — הסבב
// ---------------------------------------------------------------------------

function dropWaiting(uid, company, pc) {
  const list = D.getSetting(WAIT_KEY, []) ?? [];
  const keep = [];
  for (const x of list) {
    if (x.uid === uid && x.company === company && x.pc === pc) { for (const f of x.files ?? []) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } } } else keep.push(x);
  }
  if (keep.length !== list.length) D.setSetting(WAIT_KEY, keep);
}

/**
 * נקרא מהסבב של קבלת הסחורה. לכל חשבונית שממתינה: בודקים את החשבון (כל 20 דקות). סופי ← הקליטה נפתחת אצל העובד
 * בשאלת ההמרה (‎h.open(uid, s)‎) והודעה; בוטל או חויב במחשב ← הודעה ויורדת; 30 יום ← יורדת.
 * ‎h.busy(uid)‎ — לעובד יש קליטה פעילה: מחכים לסבב הבא.
 */
async function sweep(send, h) {
  const list = D.getSetting(WAIT_KEY, []) ?? [];
  if (!list.length) return;
  const now = Date.now();
  const drop = [];
  for (const x of list) {
    try {
      if (now - x.since > WAIT_DAYS * 24 * 60 * 60 * 1000) {
        drop.push(x);
        send(x.uid, `⏱ חשבונית ${x.doc?.doc_number ?? ''} של ${x.supplier?.name ?? ''} חיכתה ${WAIT_DAYS} יום שהחשבון החלקי *${x.pc}* יהיה סופי, וירדה מהרשימה. כשהוא סופי — שלחו אותה שוב.`);
        continue;
      }
      if (now - (x.checkedAt ?? 0) < CHECK_EVERY) continue;
      if (x.notified && now - (x.notifiedAt ?? 0) < RENOTIFY) continue;
      x.checkedAt = now;
      const st = await Priority.partialBillStatus(x.company, x.pc);
      if (!st || st.STATDES === 'מבוטלת' || st.IVALL === 'Y') {
        drop.push(x);
        send(x.uid, `ℹ️ החשבון החלקי *${x.pc}* ${!st ? 'כבר לא קיים' : st.STATDES === 'מבוטלת' ? 'בוטל' : 'כבר חויב בחשבונית (במחשב)'} בפריוריטי, ולכן חשבונית ${x.doc?.doc_number ?? ''} של ${x.supplier?.name ?? ''} לא תומר מהבוט.`);
        continue;
      }
      if (!Priority.PC_READY.includes(st.STATDES)) continue;
      if (h.busy(x.uid)) continue;
      if (x.notified >= MAX_NOTIFY) { drop.push(x); continue; }
      // הקליטה נפתחת בשאלת ההמרה, עם עותק של הקבצים (הקליטה מוחקת את שלה בסוף)
      const s = { mode: 'pc', step: 'pc_pick', uid: x.uid, startedAt: now, company: x.company, supplier: x.supplier, doc: x.doc,
        via: x.via, companyHow: x.companyHow, supplierBy: x.supplierBy, files: (x.files ?? []).map(copyFile).filter(Boolean), pcOptions: [x.pc] };
      const out = await choose(s, h, x.pc);
      if (!out.s) { drop.push(x); if (out.replies?.length) send(x.uid, out.replies.join('\n')); continue; }
      out.s.lastPrompt = out.replies[0];
      h.open(x.uid, out.s);
      x.notified = (x.notified ?? 0) + 1;
      x.notifiedAt = now;
      send(x.uid, [`✅ החשבון החלקי *${x.pc}* אושר סופית. אפשר להמיר את החשבונית לחשבונית ספק:`, '', out.replies[0], '',
        '_עניתם אחרי שעה? כתבו *פריוריטי* כדי לחזור לשאלה._'].join('\n'));
    } catch (err) {
      console.error('[משימון] חשבוניות שממתינות לחשבון חלקי:', err.message);
    }
  }
  const fresh = D.getSetting(WAIT_KEY, []) ?? [];
  const gone = (y) => drop.some((x) => x.uid === y.uid && x.company === y.company && x.pc === y.pc);
  for (const x of drop) for (const f of x.files ?? []) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } }
  // שומרים את מה שהשתנה בסבב (בדיקה אחרונה, הודעות), בלי לדרוס רשומה שנוספה בינתיים
  const byKey = new Map(list.map((x) => [`${x.uid}|${x.company}|${x.pc}`, x]));
  D.setSetting(WAIT_KEY, fresh.filter((y) => !gone(y)).map((y) => byKey.get(`${y.uid}|${y.company}|${y.pc}`) ?? y));
}

/** החשבוניות שממתינות לחשבון סופי (לתצוגה ולבדיקות) */
const waiting = (uid = null) => (D.getSetting(WAIT_KEY, []) ?? []).filter((x) => uid == null || x.uid === uid);
/** עכבונות שנדחו ועוד לא קוזזו */
const deferred = () => (D.getSetting(DEFER_KEY, []) ?? []).filter((x) => !x.settledBy);

module.exports = { start, step, buttons, sweep, isPcStep, waiting, deferred, _compare: compare, _amountsOf: amountsOf, _refsOf: refsOf, BTN_DEFER, BTN_NOW };
