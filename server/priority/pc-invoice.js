'use strict';
/**
 * 🧾 חוזה ← חשבון חלקי ← חשבונית ספק (24.11.26) — הבסיס "חשבון חלקי" של חשבונית ספק (‎supplier-invoice.js‎).
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md" ("חשבונית ספק — פעולה אחת, שלושה בסיסים").
 *
 * אצל קבלן משנה עם חוזה (‎CO…‎) אין הזמנה ואין קבלת סחורה: החשבון נקלט בפריוריטי כ*חשבון חלקי* (‎PC…‎) מכתב הכמויות של
 * החוזה ועובר אישורים, והספק שולח *חשבונית מס*. חשבונית ספק — **רק במשימון פריוריטי** (הוחלט 24.11.26: בבוט אין חשבונית ספק; חשבון חלקי בבוט — יאופיין בהמשך).
 * ‎supplier-invoice.js‎ מוצא את החשבון (לפי השורות, המספרים והסכום) וקורא ל-‎choose‎. כאן:
 *   1. השרשרת: החשבון של אותו ספק, לא מבוטל, לא חויב, ו**מאושר (סופי)** — אחרת אומרים אצל מי הוא, ולא נכתב דבר.
 *   2. השוואה: הסכום לפני מע"מ בחשבונית מול "לתשלום" בחשבון (אחרי עכבון). עיגול (עד 1 ₪) — ✅.
 *      **הספק לא קיזז עכבון**: מתריעים, ומציעים לגבות את העכבון בחשבון הבא — שורת העכבון בחשבונית מתאפסת, והעכבון נרשם
 *      לקיזוז בחשבון הבא של אותו חוזה (‎pc_retention_deferred‎), שמזכיר אותו.
 *   3. אחרי "כן": חשבונית ספק זמנית (‎T…‎), משיכת החשבון (‎PIVDOC_SUBFORM‎ — השורות נמשכות ממנו), מספר ההקצאה, נספחים
 *      ודו-שיח פנימי. החשבונית **נשארת טיוטא** — הנהלת החשבונות בודקת וסוגרת.
 *
 * המודול אינו מייבא את ‎supplier-invoice.js‎ (בלי מעגל): העזרים של השיחה מגיעים ב-‎h‎.
 */
const fs = require('node:fs');
const D = require('../core').Db;
const Priority = require('../integrations').Priority;
const { BTN } = require('../whatsapp').WaUi;
const Access = require('./priority-access');

const DEFER_KEY = 'pc_retention_deferred';
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

/** 🧾 הודעה למי שמטפל בחשבוניות ספק בחברה (מטריצת ההרשאות; מנהלי מערכת תמיד) — עכבון שנדחה וכדומה */
function notifyAccounting(s, title, lines) {
  try {
    for (const u of D.all("SELECT id, role FROM users WHERE status = 'active' AND role != 'vendor'")) {
      if (!Access.of(u.id).docs.includes('invoice') || !Access.filterForUser(u.id, [s.company]).length) continue;
      D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🧾 ${title}`, body: [`חברה: ${s.company}`, ...lines].join('\n') });
    }
  } catch (err) {
    console.error('[משימון] התראה על חשבונית ספק:', err.message);
  }
}

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const isPcStep = (s) => String(s?.step ?? '').startsWith('pc_');

// ---------------------------------------------------------------------------
// מספרים מהמסמכים, סכומים והשוואה
// ---------------------------------------------------------------------------

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

/**
 * החשבון עוד לא סופי (לא מאושר): אי אפשר להמיר. אומרים אצל מי הוא, ולא נכתב דבר. המסמך נשאר בתור במשימון פריוריטי —
 * כשהחשבון יאושר, מתחילים אותו שוב (הוחלט 24.11.26: חשבונית ספק — רק מהמסך; בלי הודעה בבוט).
 */
function wait(s, h) {
  const p = s.pc;
  const who = p.pending.length ? ` ממתין לאישור של: *${p.pending.join(', ')}*.` : '';
  return {
    s: null,
    replies: [[summary(s, h).split('\n\n').slice(0, -1).join('\n\n').replace(/\n$/, ''), '',
      `⏳ החשבון החלקי *${p.docno}* עוד *${p.status}* בפריוריטי, ואפשר להמיר רק חשבון מאושר (סופי).${who}`,
      'לא נכתב דבר. המסמך נשאר בתור — כשהחשבון יאושר, "להתחיל כאן" שוב.'].join('\n')],
    status: 'ok',
    result: `חשבון חלקי לא סופי: ${p.docno} (${p.status})`
  };
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
  if (s.pcDefer) notifyAccounting(s, `עכבון נדחה: ${p.docno}`, [`חשבונית ${ivnum} של ${s.supplier.name} נקלטה בלי עכבון (${money(p.retention)}).`, `לקזז בחשבון הבא של החוזה ${p.ordname}.`]);
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

/** עכבונות שנדחו ועוד לא קוזזו */
const deferred = () => (D.getSetting(DEFER_KEY, []) ?? []).filter((x) => !x.settledBy);

module.exports = { choose, step, buttons, isPcStep, deferred, _compare: compare, _amountsOf: amountsOf, BTN_DEFER, BTN_NOW };
