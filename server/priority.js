'use strict';
/**
 * חיבור לפריוריטי (REST / OData) — לקליטת מסמכי רכש מהבוט.
 *
 * הזדהות: Basic עם PAT — שם המשתמש הוא האסימון והסיסמה היא המילה ‎PAT‎
 * (‎PRIORITY_USER‎, ‎PRIORITY_PASSWORD‎). בלעדיהם היכולת כבויה.
 *
 * **לאן מותר לכתוב:** ‎PRIORITY_COMPANIES‎ — רשימת קודי החברות, מופרדת בפסיקים.
 * ברירת המחדל: ‎test11‎ בלבד. כל קריאה עוברת דרך ‎companyUrl()‎, שבודקת שהחברה
 * ברשימה — כך גם טעות בבוט או ב-AI אינה יכולה לכתוב לחברה אחרת.
 *
 * כל ה-PAT רואה את כל החברות ואת כל המסכים, ולכן ההגבלה לפי עובד נעשית
 * במשימון (‎server/ai/wa-actions.js‎ — מי רשאי להשתמש בפעולה), לא בפריוריטי.
 *
 * כל הקליטות נרשמות בפריוריטי על משתמש ה-API. מי באמת קלט — בדו-שיח הפנימי
 * של המסמך ובלוג הבוט.
 */

const HOST = 'https://p.priority-connect.online/odata/Priority/tabb2121.ini';
const TIMEOUT = 120000;

/**
 * החברות שהבוט מכיר. ‎vat‎ — הח.פ. של החברה, כפי שמופיע כנמען על מסמך ספק.
 * ‎sandbox‎ — עותק לבדיקות: כשהחברה עצמה אינה פתוחה לכתיבה והעותק כן, הבוט
 * קולט לעותק ואומר זאת במפורש.
 */
const COMPANIES = [
  // קוד ושם — מהמייל של Medatech; ח.פ. — מרשימת אגרת החברות 2026. שם זהה בשתי הרשימות, או
  // שאושר (a040626, esah1, hatali1, isdat1 = הטלי ניהול פרויקטים — 04.11.26)
  { code: 'a160226', name: 'אשל הירדן יזום ובנין', vat: '512061185', sandbox: 'test11' },
  { code: 'a040626', name: 'אשל הירדן 1994 בניה ופיתוח', vat: '512061193' },
  { code: 'mordot', name: 'מורדות הכרמל נכסים', vat: '513537613' },
  { code: 'raba', name: 'רבץ רכסים', vat: '516941705' },
  { code: 'kanyan1', name: 'קנין ובנין', vat: '516094893' },
  { code: 'pono1', name: 'פונוניקס', vat: '515807394' },
  { code: 'ghyar1', name: 'גשם הירדן נהריה', vat: '515869469' },
  { code: 'denia1', name: 'דניה הירוקה', vat: '514772532' },
  { code: 'mahala1', name: 'מעלה יפה נוף', vat: '511310807' },
  { code: 'elad1', name: 'אלעד סנטר', vat: '516888187' },
  { code: 'rivie1', name: 'ריביירה אשל הירדן', vat: '517038824' },
  { code: 'greha1', name: 'גשם הירדן רכסים', vat: '516477973' },
  { code: 'mydot1', name: 'מורדות ידות', vat: '516886629' },
  { code: 'kedma1', name: 'קדמה נתניה מגורים', vat: '516962909' },
  { code: 'esah1', name: 'אשל הירדן אחזקות 2000 - פארק המדע הקוונטי', vat: '512961756' },
  { code: 'hatali1', name: 'הטלי אחזקות ובניה', vat: '515026136' },
  { code: 'rhos1', name: 'ראש כרמל', vat: '516516184' },
  // ‎gilad1‎, ‎north1‎ — אינן ברשימת האגרה
  { code: 'isdat1', name: 'הטלי ניהול פרויקטים', vat: '514911403' },
  { code: 'gilad1', name: 'גילעד-פרטי', vat: '' },
  { code: 'north1', name: 'אשל הירדן פארק צפון', vat: '' },
  { code: 'test11', name: 'אשל הירדן יזום ובנין — סביבת בדיקה', vat: '', test: true }
];

const isEnabled = () => Boolean(process.env.PRIORITY_USER && process.env.PRIORITY_PASSWORD);
const allowed = () => String(process.env.PRIORITY_COMPANIES || 'test11').split(',').map((s) => s.trim()).filter(Boolean);
const companyOf = (code) => COMPANIES.find((c) => c.code === code) ?? { code, name: code, vat: '' };
const isTest = (code) => Boolean(companyOf(code).test);

/**
 * לאיזו חברה לקלוט מסמך שהנמען בו הוא ‎vat‎. מחזיר ‎{company, via}‎:
 * ‎via='direct'‎ — החברה עצמה פתוחה; ‎'sandbox'‎ — העותק לבדיקה; ‎null‎ — לא נמצאה
 * חברה מותרת.
 */
function resolveCompany(vat) {
  const digits = String(vat ?? '').replace(/\D/g, '');
  const c = digits ? COMPANIES.find((x) => x.vat && x.vat === digits) : null;
  const open = allowed();
  if (c && open.includes(c.code)) return { company: c.code, via: 'direct', matched: c };
  if (c && c.sandbox && open.includes(c.sandbox)) return { company: c.sandbox, via: 'sandbox', matched: c };
  return { company: null, via: null, matched: c ?? null };
}

function companyUrl(company) {
  if (!allowed().includes(company)) throw new Error(`החברה ${company} אינה פתוחה לכתיבה מהבוט (PRIORITY_COMPANIES)`);
  return `${HOST}/${encodeURIComponent(company)}/`;
}

class PriorityError extends Error {}

/** הודעת השגיאה של פריוריטי — מגיעה ב-JSON רגיל או כ-XML עטוף */
function errorText(data, raw) {
  return data?.FORM?.InterfaceErrors?.text ?? data?.error?.message ?? String(raw ?? '').slice(0, 300);
}

async function call(company, method, path, body = null) {
  if (!isEnabled()) throw new PriorityError('החיבור לפריוריטי אינו מוגדר בשרת (PRIORITY_USER, PRIORITY_PASSWORD)');
  const auth = Buffer.from(`${process.env.PRIORITY_USER}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const url = companyUrl(company) + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Basic ${auth}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT)
    });
  } catch (err) {
    throw new PriorityError(`אין חיבור לפריוריטי: ${err.message}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* טקסט */ }
  if (!res.ok) {
    const err = new PriorityError(errorText(data, raw).replace(/^שורה \d+\s*-\s*/, ''));
    err.status = res.status;
    throw err;
  }
  return data;
}

const q = (s) => String(s ?? '').replace(/'/g, "''");
const enc = encodeURIComponent;
const rows = (data) => data?.value ?? [];
const strip = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith('@')));
const grKey = (docno) => `DOCUMENTS_P(DOCNO='${q(docno)}',TYPE='P')`;

// ---------------------------------------------------------------------------
// קריאה
// ---------------------------------------------------------------------------

/** ספקים לפי ח.פ., ואם אין — לפי שם (עד 5). רבים בכרטיס בלי ח.פ. */
async function findSuppliers(company, { vat = '', name = '' } = {}) {
  const sel = '$select=SUPNAME,SUPDES,VATNUM,STATDES&$top=5';
  const digits = String(vat).replace(/\D/g, '');
  if (digits) {
    const byVat = rows(await call(company, 'GET', `SUPPLIERS?$filter=${enc(`VATNUM eq '${digits}'`)}&${sel}`));
    if (byVat.length) return { by: 'vat', list: byVat };
  }
  // קודם השם המלא בלי "בע"מ", אחר כך מילה ארוכה ממנו — כך "דאר אלביאן בע"מ" נמצא גם ככתוב אחרת
  const clean = String(name).replace(/בע"?מ|בעמ|ltd\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(/[\s,.()"']+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  for (const w of [clean, ...words.slice(0, 2)].filter(Boolean)) {
    const list = rows(await call(company, 'GET', `SUPPLIERS?$filter=${enc(`contains(SUPDES,'${q(w)}')`)}&${sel}`));
    if (!list.length) continue;
    const exact = list.filter((x) => String(x.SUPDES).replace(/בע"?מ|בעמ/g, '').replace(/\s+/g, ' ').trim() === clean);
    return { by: 'name', list: exact.length === 1 ? exact : list };
  }
  return { by: null, list: [] };
}

/** ספק לפי מספר הספק בפריוריטי */
async function supplierByCode(company, code) {
  const list = rows(await call(company, 'GET', `SUPPLIERS?$filter=${enc(`SUPNAME eq '${q(code)}'`)}&$select=SUPNAME,SUPDES,VATNUM,STATDES&$top=1`));
  return list[0] ?? null;
}

/**
 * GR קיים של אותו ספק עם אותו מספר תעודה. פריוריטי לא יקלוט פעמיים — גם כשה-GR
 * הקודם בוטל (ואז מחזיר שגיאה מבלבלת על "סטטוס מבוטלת"). ‎cancelReceipt‎ משנה את
 * המספר לפני הביטול, כך שזה קורה רק בביטולים שנעשו בפריוריטי עצמו.
 */
async function findReceiptByBooknum(company, supname, booknum) {
  if (!booknum) return null;
  const list = rows(await call(company, 'GET',
    `DOCUMENTS_P?$filter=${enc(`SUPNAME eq '${q(supname)}' and BOOKNUM eq '${q(String(booknum).slice(0, 20))}'`)}&$select=DOCNO,STATDES,CURDATE&$top=5`));
  return list.find((x) => x.STATDES !== 'מבוטלת') ?? list[0] ?? null;
}

/** הזמנה אחת, עם השורות והיתרות */
async function getOrder(company, ordname) {
  try {
    const h = strip(await call(company, 'GET', `PORDERS('${q(ordname)}')?$select=ORDNAME,SUPNAME,CDES,STATDES,PROJDOCNO,PROJDES,TYPECODE,TYPEDES,CURDATE`));
    const lines = rows(await call(company, 'GET', `PORDERS('${q(ordname)}')/PORDERITEMS_SUBFORM?$select=LINE,KLINE,PARTNAME,PDES,TQUANT,TBALANCE,TUNITNAME,PRICE,PERCENT`));
    return { ...h, lines };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** הזמנות מאושרות של הספק שיש בהן יתרה */
async function openOrders(company, supname) {
  const list = rows(await call(company, 'GET',
    `PORDERS?$filter=${enc(`SUPNAME eq '${q(supname)}' and STATDES eq 'אושרה'`)}&$select=ORDNAME,CURDATE,PROJDOCNO,PROJDES,TYPECODE&$top=20&$orderby=CURDATE desc`));
  const out = [];
  for (const o of list) {
    const lines = rows(await call(company, 'GET', `PORDERS('${q(o.ORDNAME)}')/PORDERITEMS_SUBFORM?$select=LINE,KLINE,PARTNAME,PDES,TQUANT,TBALANCE,TUNITNAME,PRICE,PERCENT`))
      .filter((l) => (l.TBALANCE ?? 0) > 0);
    if (lines.length) out.push({ ...o, lines });
  }
  return out;
}

/** פריט שהתיאור שלו זהה בדיוק — עם תת הפרק שלו */
async function findPartExact(company, description) {
  const d = String(description ?? '').trim();
  if (!d) return null;
  const list = rows(await call(company, 'GET',
    `LOGPART?$filter=${enc(`PARTDES eq '${q(d)}'`)}&$select=PARTNAME,PARTDES,BUD_SUBCHAPTERNAME,BUD_SUBTOPICNAME&$top=2`));
  return list.length === 1 ? list[0] : null;
}

/** תת הפרק שבו הספק נקלט בפעם האחרונה — הצעה לשורות בפריט כללי */
async function lastSubchapter(company, supname) {
  const grs = rows(await call(company, 'GET',
    `DOCUMENTS_P?$filter=${enc(`SUPNAME eq '${q(supname)}' and STATDES ne 'מבוטלת'`)}&$select=DOCNO&$orderby=CURDATE desc&$top=3`));
  for (const g of grs) {
    const l = rows(await call(company, 'GET', `${grKey(g.DOCNO)}/TRANSORDER_P_SUBFORM?$select=BUD_SUBCHAPTERNAME,BUD_SUBCHAPTERDES,BUD_SUBTOPICNAME&$top=1`))[0];
    if (l?.BUD_SUBCHAPTERNAME) return { chapter: l.BUD_SUBCHAPTERNAME, chapterDes: l.BUD_SUBCHAPTERDES ?? '', topic: l.BUD_SUBTOPICNAME ?? '' };
  }
  return null;
}

/**
 * הפרויקטים של החברה — ממסך הפרויקטים, ‎DOCUMENTS_p‎ (p קטנה; ‎DOCPROJ‎ סגור ל-API).
 * בלי המבוטלים. נשמר לשעה. אם המסך אינו זמין — מהפרויקטים שבהזמנות ובקבלות.
 */
const projectCache = new Map();
async function projects(company) {
  const hit = projectCache.get(company);
  if (hit && Date.now() - hit.at < 3600000) return hit.list;
  let list = [];
  try {
    list = rows(await call(company, 'GET', 'DOCUMENTS_p?$select=DOCNO,PROJDES,STATDES&$top=2000'))
      .filter((r) => r.DOCNO && r.STATDES !== 'מבוטלת')
      .map((r) => ({ code: r.DOCNO, des: r.PROJDES ?? '' }));
  } catch (err) {
    console.error(`[משימון] מסך הפרויקטים בפריוריטי (${company}) לא זמין:`, err.message);
  }
  if (!list.length) {
    const seen = new Map();
    for (const ent of ['PORDERS', 'DOCUMENTS_P']) {
      for (const r of rows(await call(company, 'GET', `${ent}?$select=PROJDOCNO,PROJDES&$top=2000`))) {
        if (r.PROJDOCNO && !seen.has(r.PROJDOCNO)) seen.set(r.PROJDOCNO, r.PROJDES ?? '');
      }
    }
    list = [...seen].map(([code, des]) => ({ code, des }));
  }
  list.sort((a, b) => a.code.localeCompare(b.code));
  projectCache.set(company, { at: Date.now(), list });
  return list;
}

/*
 * חיפוש פרויקט בשפה חופשית — "חיפה", "49", "זה לאלעד, במגרש 49 הצפוני", "מבואות 207".
 *  • כתיב: בלי מקפים וגרשיים, אותיות סופיות כרגילות ("צפון" ~ "הצפוני"); "יי"/"וו" כפולים כאחד ("נהרייה" = "נהריה", "קריית" = "קרית"),
 *    ו"יוקנעם" = "יקנעם".
 *  • אותיות שימוש: "באלעד", "לחיפה", "הצפוני", "ובמגרש" — המילה גם בלעדיהן.
 *  • מילה תואמת כשהיא תחילת מילה בשם, או חלק ממנה (מ-3 אותיות), או שמילה בשם היא
 *    תחילתה ("הצפוני" ← "צפון"). מספר — רק מספר שלם ("207" לא תואם "2070").
 *  • מילות קישור ("זה", "של", "במגרש", "פרויקט") — מדולגות.
 * מה שהקוד לא מוצא כך — ה-AI מתאים מול הרשימה (‎skills/goods-receipt.md‎, ‎project‎).
 */
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const normWord = (w) => String(w).replace(/["'`״׳]/g, '').replace(/[ךםןףץ]/g, (c) => FINALS[c])
  .replace(/יי/g, 'י').replace(/וו/g, 'ו').replace(/^יוק/, 'יק').toLowerCase();
const wordsOf = (s) => String(s ?? '').split(/[\s,.\-–/()!?:;]+/).map(normWord).filter(Boolean);
const PROJECT_STOP = new Set(['פרויקט', 'הפרויקט', 'בפרויקט', 'לפרויקט', 'מגרש', 'במגרש', 'למגרש', 'המגרש', 'אתר', 'באתר', 'לאתר',
  'של', 'שלי', 'זה', 'זו', 'הוא', 'היא', 'את', 'אל', 'על', 'עם', 'עבור', 'בשביל', 'לי', 'כן', 'לא', 'בע', 'מ', 'בעמ', 'אני', 'חושב', 'נראה', 'כנראה']);
/** המילה, ובלי אותיות שימוש בתחילתה ("באלעד" ← "אלעד", "ובמגרש" ← "מגרש") */
function variants(q) {
  const out = [q];
  const two = q.match(/^(וב|ול|ומ|וה|וכ|של|מה|לה|בה|כש|שב|של)(.{2,})$/);
  if (two) out.push(two[2]);
  const one = q.match(/^[בלמהוכש](.{2,})$/);
  if (one) out.push(one[1]);
  return out;
}
function wordMatches(q, w) {
  if (/^\d+$/.test(q)) return w === q;
  return w.startsWith(q) || (q.length >= 3 && w.includes(q)) || (w.length >= 3 && !/^\d+$/.test(w) && q.startsWith(w));
}
const queryWords = (text) => wordsOf(text).filter((q) => (q.length >= 2 || /^\d+$/.test(q)) && !PROJECT_STOP.has(q));
/**
 * @param {Array<{code, des}>} list
 * @param {string} text
 * @param {{all?: boolean}} [opts]  ‎all‎ — כל המילים חייבות להתאים (העובד כתב שם); אחרת — לפי כמה התאימו (רמז מהמסמך)
 */
function matchProjects(list, text, { all = false } = {}) {
  const qs = queryWords(text);
  if (!qs.length) return [];
  return list.map((p) => {
    const ws = wordsOf(`${p.des} ${p.alias ?? ''}`);
    const hits = qs.filter((q) => variants(q).some((v) => ws.some((w) => wordMatches(v, w)))).length;
    return { ...p, score: hits };
  }).filter((p) => (all ? p.score === qs.length : p.score > 0))
    .sort((a, b) => b.score - a.score || a.des.localeCompare(b.des, 'he'));
}

/** ה-GR כפי שנשמר — כותרת, שורות, נספחים, דו-שיח פנימי */
async function readReceipt(company, docno) {
  const k = grKey(docno);
  const h = strip(await call(company, 'GET', `${k}?$select=DOCNO,CURDATE,SUPNAME,CDES,BOOKNUM,PROJDOCNO,PROJDES,TOWARHSNAME,STATDES,DETAILS,QPRICE,PERCENT,DISPRICE,VAT,TOTPRICE`));
  const lines = rows(await call(company, 'GET', `${k}/TRANSORDER_P_SUBFORM?$select=KLINE,PARTNAME,PDES,TQUANT,TUNITNAME,PRICE,PERCENT,QPRICE,ORDNAME,OLINE,BUD_SUBCHAPTERNAME,BUD_SUBCHAPTERDES,BUD_SUBTOPICNAME`))
    .sort((a, b) => a.KLINE - b.KLINE);
  const files = rows(await call(company, 'GET', `${k}/EXTFILES_SUBFORM?$select=EXTFILENUM,EXTFILEDES,SUFFIX`));
  return { ...h, lines, files };
}

// ---------------------------------------------------------------------------
// כתיבה — קבלת סחורה
// ---------------------------------------------------------------------------

/** GR טיוטא. ‎project‎ — כשיש הזמנה, הפרויקט שלה */
async function createReceipt(company, { supname, booknum, date, project, warehouse = 'Main' }) {
  const body = { SUPNAME: supname, TOWARHSNAME: warehouse };
  if (booknum) body.BOOKNUM = String(booknum).slice(0, 20);
  if (date) body.CURDATE = `${date}T00:00:00Z`;
  if (project) body.PROJDOCNO = project;
  const r = await call(company, 'POST', 'DOCUMENTS_P', body);
  return r.DOCNO;
}

/**
 * שורה מהזמנה: ‎DOCPORDI_SUBFORM‎ של ה-GR מציג את כל השורות הפתוחות של הספק;
 * סימון (‎FLAG=Y‎) יוצר שורת GR מקושרת (מחיר, תת פרק ופרויקט מההזמנה), בכמות 0.
 * אחר כך — הכמות שהתקבלה בפועל.
 */
async function addOrderLine(company, docno, { ordname, line, qty }) {
  const k = grKey(docno);
  const open = rows(await call(company, 'GET', `${k}/DOCPORDI_SUBFORM`));
  const target = open.find((x) => x.ORDNAME === ordname && Number(x.LINE) === Number(line));
  if (!target) throw new PriorityError(`שורה ${line} בהזמנה ${ordname} אינה פתוחה לקבלה`);
  const before = new Set(rows(await call(company, 'GET', `${k}/TRANSORDER_P_SUBFORM?$select=KLINE`)).map((x) => x.KLINE));
  await call(company, 'PATCH', `${k}/DOCPORDI_SUBFORM(KLINE=${target.KLINE},ORD=${target.ORD})`, { FLAG: 'Y' });
  const created = rows(await call(company, 'GET', `${k}/TRANSORDER_P_SUBFORM?$select=KLINE,ORDNAME,OLINE`))
    .find((x) => !before.has(x.KLINE) && x.ORDNAME === ordname);
  if (!created) throw new PriorityError(`שורה ${line} בהזמנה ${ordname} לא נמשכה ל-GR`);
  await call(company, 'PATCH', `${k}/TRANSORDER_P_SUBFORM(KLINE=${created.KLINE},TYPE='P')`, { TQUANT: qty });
  return created.KLINE;
}

/** שורה בלי הזמנה — פריט (או ‎000‎ כללי עם תיאור הספק) */
async function addFreeLine(company, docno, { part = '000', description, qty, price, discount = 0, chapter, topic }) {
  const body = { PARTNAME: part, TQUANT: qty, PRICE: price };
  if (part === '000' && description) body.PDES = String(description).slice(0, 48);
  if (discount) body.PERCENT = discount;
  if (chapter) body.BUD_SUBCHAPTERNAME = chapter;
  if (topic) body.BUD_SUBTOPICNAME = topic;
  const r = await call(company, 'POST', `${grKey(docno)}/TRANSORDER_P_SUBFORM`, body);
  return r.KLINE;
}

const setLineQty = (company, docno, kline, qty) =>
  call(company, 'PATCH', `${grKey(docno)}/TRANSORDER_P_SUBFORM(KLINE=${Number(kline)},TYPE='P')`, { TQUANT: qty });

const setHeader = (company, docno, fields) => call(company, 'PATCH', grKey(docno), fields);

/** נספח — תמונה או PDF, כ-data URI */
async function attach(company, docno, { buf, mime, description }) {
  const uri = `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
  await call(company, 'POST', `${grKey(docno)}/EXTFILES_SUBFORM`, { EXTFILEDES: String(description ?? '').slice(0, 80), EXTFILENAME: uri });
}

/** דו-שיח פנימי — מי קיבל, ממה, ומה תוקן. מחליף את הטקסט הקיים */
async function setDialog(company, docno, lines) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const TEXT = lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');
  const k = `${grKey(docno)}/INTERNALDIALOGTEXT_SUBFORM`;
  try {
    await call(company, 'POST', k, { TEXT });
  } catch (err) {
    await call(company, 'PATCH', k, { TEXT });
  }
}

/** הדו-שיח הפנימי כשורות טקסט */
async function readDialog(company, docno) {
  let d;
  try { d = await call(company, 'GET', `${grKey(docno)}/INTERNALDIALOGTEXT_SUBFORM`); } catch (err) { if (err.status === 404) return []; throw err; }
  const ent = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  return String(d?.TEXT ?? '').replace(/<style[\s\S]*?<\/style>/gi, '').split(/<\/p>|<br\s*\/?>/i)
    .map((x) => x.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, (e) => ent[e] ?? e).trim()).filter(Boolean);
}

/** הופך את ה-GR לסופי. אם פריוריטי דורש פעולה מהממשק — השגיאה עולה כמו שהיא */
const finalizeReceipt = (company, docno) => call(company, 'PATCH', grKey(docno), { STATDES: 'סופית' });

/**
 * ביטול טיוטא שלא אושרה. חשוב: שורה מהזמנה מורידה את היתרה בהזמנה כבר בטיוטא,
 * ולכן טיוטא נטושה חייבת להתבטל. פריוריטי אינו מוחק תעודה ואינו מבטל תעודה
 * עם שורות — קודם השורות, אחר כך הסטטוס.
 */
async function cancelReceipt(company, docno) {
  const k = grKey(docno);
  for (const l of rows(await call(company, 'GET', `${k}/TRANSORDER_P_SUBFORM?$select=KLINE`))) {
    await call(company, 'DELETE', `${k}/TRANSORDER_P_SUBFORM(KLINE=${l.KLINE},TYPE='P')`);
  }
  // מספר התעודה מתפנה — אחרת פריוריטי לא יקלוט את אותה תעודה שוב. אחרי ביטול אי אפשר לעדכן
  const h = await call(company, 'GET', `${k}?$select=BOOKNUM`);
  if (h?.BOOKNUM && !String(h.BOOKNUM).endsWith('~X')) {
    await call(company, 'PATCH', k, { BOOKNUM: `${String(h.BOOKNUM).slice(0, 18)}~X` }).catch(() => {});
  }
  await call(company, 'PATCH', k, { STATDES: 'מבוטלת' });
}

module.exports = {
  COMPANIES, isEnabled, allowed, companyOf, isTest, resolveCompany, PriorityError,
  findSuppliers, supplierByCode, findReceiptByBooknum, getOrder, openOrders, findPartExact, lastSubchapter, projects, matchProjects, readReceipt,
  readDialog, createReceipt, addOrderLine, addFreeLine, setLineQty, setHeader, attach, setDialog, finalizeReceipt, cancelReceipt,
  _call: call
};
