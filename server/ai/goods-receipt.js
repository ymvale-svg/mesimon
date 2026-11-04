'use strict';
/**
 * קבלת סחורה מהבוט — תעודת משלוח או חשבונית ← GR בפריוריטי.
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md" (פיילוט: קבלת סחורה).
 *
 * העובד כותב או מקליט "קבלת סחורה" ושולח צילום. הבוט:
 *   1. קורא את המסמך (AI, ‎skills/goods-receipt.md‎).
 *   2. חברה לפי הח.פ. של הנמען — רק חברה שפתוחה ב-‎PRIORITY_COMPANIES‎.
 *   3. ספק — לפי ח.פ., אחרת לפי שם.            ← אישור חברה + ספק
 *   4. הזמנה — מספר PO מהמסמך, אחרת הזמנות פתוחות של הספק (ההתאמה המיטבית),
 *      אחרת "יש מספר הזמנה?" / קליטה לפי המסמך בלבד.
 *   5. השוואה שורה-שורה, וכתב יד לא ברור         ← "זה מה שהתקבל בפועל?"
 *   6. שורות בלי הזמנה: פריט בתיאור זהה, אחרת ‎000‎ + תת פרק      ← אישור
 *   7. פרויקט — מההזמנה; בלי הזמנה — הצעה מהמסמך       ← בחירה
 *   8. נספחים — תמונות נוספות, עד "סיום"
 *   9. קליטה כטיוטא, קריאה חזרה מפריוריטי, סיכום       ← "מאשר" / תיקון / ביטול
 *  10. "מאשר" ← GR סופי, ומספר ה-GR.
 *
 * הבוט אינו עושה דבר לבד: כל הכרעה מוצגת ומאושרת, והמעבר לסופי — רק ב"מאשר".
 * יתרה בהזמנה אינה נסגרת לעולם (הרכש סוגר ידנית). טיוטא שלא אושרה מתבטלת,
 * כי שורה מהזמנה מורידה את היתרה כבר בטיוטא.
 *
 * מצב השיחה נשמר בהגדרה ‎goods_receipt:<userId>‎, והקבצים — בתיקיית ההעלאות
 * עד סוף הקליטה.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const Claude = require('./claude');
const Priority = require('../priority');
const WhatsApp = require('../whatsapp');
const { receiptPdf } = require('./gr-pdf');

const SKILL = path.join(__dirname, 'skills', 'goods-receipt.md');
const TTL = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Jerusalem';
const FILES_DIR = () => path.join(D.UPLOADS_DIR, 'goods-receipt');

const TRIGGER = /קבלת\s*סחורה/;
const YES = /^(כן|נכון|מאשר|מאשרת|אשר|אישור|תקין|יאללה|אוקי|אוקיי|סבבה|ok|yes|👍|✅)([\s,.!]|$)/i;
const CANCEL = /^(ביטול|בטל|לבטל|עזוב|יציאה|stop)([\s,.!]|$)/i;
const DONE_FILES = /^(סיום|סיימתי|זהו|אין|אין נספחים|בלי נספחים|המשך)([\s,.!]|$)/;
const NO_ORDER = /^(בלי הזמנה|אין הזמנה|ללא הזמנה|לפי המסמך|אין|בלי|לא)([\s,.!]|$)/;

// ---------------------------------------------------------------------------
// מצב
// ---------------------------------------------------------------------------

const key = (userId) => `goods_receipt:${userId}`;
function load(userId) {
  const s = D.getSetting(key(userId), null);
  if (!s || typeof s !== 'object' || !s.step) return null;
  return s;
}
function save(userId, s) { D.setSetting(key(userId), { ...s, at: Date.now() }); }
function clear(userId, s) {
  for (const f of s?.files ?? []) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } }
  D.run('DELETE FROM settings WHERE key = ?', key(userId));
}
const fresh = (s) => s && Date.now() - (s.at ?? 0) < TTL;

/** יש קבלת סחורה פתוחה — כל הודעה של העובד הולכת אליה */
const active = (userId) => fresh(load(userId));
const isTrigger = (text) => TRIGGER.test(String(text ?? ''));

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------

const money = (n) => Number(n ?? 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (n) => Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 3 });
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const numberIn = (t) => { const m = String(t).match(/\d+/); return m ? Number(m[0]) : null; };
const companyLine = (s) => {
  const c = Priority.companyOf(s.company);
  return Priority.isTest(s.company)
    ? `🧪 *${s.company}* — סביבת בדיקה (${c.name.replace(/ — .*/, '')}). לא נרשם בהנהלת החשבונות`
    : `🏢 *${c.name}* (${s.company}) — *סביבת אמת*`;
};

async function saveFile(userId, file, label) {
  const buf = file.buf ?? await WhatsApp.download(file.url);
  fs.mkdirSync(FILES_DIR(), { recursive: true });
  const mime = file.mime || 'image/jpeg';
  const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
  const p = path.join(FILES_DIR(), `u${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
  fs.writeFileSync(p, buf);
  return { path: p, mime, label };
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

const str = { type: 'string' };
const num = { type: 'number' };
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: { type: 'string', enum: ['delivery_note', 'invoice', 'other'] },
    recipient_name: str, recipient_vat: str,
    supplier_name: str, supplier_vat: str,
    doc_number: str, po_number: str, supplier_order_ref: str,
    date: str, delivery_place: str, project_hint: str,
    purchase_type: { type: 'string', enum: ['site', 'office', 'unknown'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: str, supplier_code: str, qty: num, unit: str,
          unit_price: num, discount_pct: num, line_total: num,
          handwritten: str, unclear: { type: 'boolean' }, options: { type: 'array', items: num }
        },
        required: ['description', 'supplier_code', 'qty', 'unit', 'unit_price', 'discount_pct', 'line_total', 'handwritten', 'unclear', 'options'],
        additionalProperties: false
      }
    },
    totals: {
      type: 'object',
      properties: { subtotal: num, doc_discount_pct: num, doc_discount: num, before_vat: num, vat: num, total: num },
      required: ['subtotal', 'doc_discount_pct', 'doc_discount', 'before_vat', 'vat', 'total'],
      additionalProperties: false
    },
    warnings: { type: 'array', items: str }
  },
  required: ['doc_type', 'recipient_name', 'recipient_vat', 'supplier_name', 'supplier_vat', 'doc_number', 'po_number', 'supplier_order_ref',
    'date', 'delivery_place', 'project_hint', 'purchase_type', 'lines', 'totals', 'warnings'],
  additionalProperties: false
};
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    best_order: str,
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { doc_line: { type: 'integer' }, order: str, line: { type: 'integer' }, confidence: { type: 'string', enum: ['high', 'low'] } },
        required: ['doc_line', 'order', 'line', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['best_order', 'matches'],
  additionalProperties: false
};
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['confirm', 'cancel', 'update', 'answer', 'unclear'] },
    updates: {
      type: 'array',
      items: { type: 'object', properties: { line: { type: 'integer' }, qty: num }, required: ['line', 'qty'], additionalProperties: false }
    },
    note: str, choice: str, question: str
  },
  required: ['action', 'updates', 'note', 'choice', 'question'],
  additionalProperties: false
};

const skill = () => fs.readFileSync(SKILL, 'utf8');

/** ניתן להחלפה בבדיקות — ‎_set({ extract, match, reply })‎ */
const ai = {
  async extract(file) {
    const data = fs.readFileSync(file.path).toString('base64');
    const block = file.mime.includes('pdf')
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.mime.includes('png') ? 'image/png' : 'image/jpeg', data } };
    return Claude.json({ system: skill(), content: [block, { type: 'text', text: 'task: extract' }], schema: EXTRACT_SCHEMA, effort: 'high', live: true });
  },
  async match(docLines, orders) {
    const text = JSON.stringify({
      task: 'match',
      doc_lines: docLines.map((l, i) => ({ doc_line: i + 1, description: l.description, supplier_code: l.supplier_code, qty: l.qty, unit: l.unit, unit_price: l.unit_price })),
      open_order_lines: orders.flatMap((o) => o.lines.map((l) => ({ order: o.ORDNAME, line: l.LINE, part: l.PARTNAME, description: l.PDES, balance: l.TBALANCE, unit: l.TUNITNAME, price: l.PRICE })))
    });
    return Claude.json({ system: skill(), content: [{ type: 'text', text }], schema: MATCH_SCHEMA, effort: 'medium', live: true });
  },
  async reply(shown, text) {
    return Claude.json({ system: skill(), content: [{ type: 'text', text: JSON.stringify({ task: 'reply', shown, text }) }], schema: REPLY_SCHEMA, effort: 'low', live: true });
  }
};

// ---------------------------------------------------------------------------
// תצוגה
// ---------------------------------------------------------------------------

function linesTable(s) {
  return s.lines.map((l) => {
    const head = `*${l.n}.* ${l.description}`;
    const got = `   התקבל: *${qtyText(l.qty)}*${l.unit ? ` ${l.unit}` : ''}`;
    const ord = l.order
      ? `   בהזמנה ${l.order.ordname}/${l.order.line}: ${l.order.des} · יתרה ${qtyText(l.order.balance)}${l.qty > l.order.balance ? ' ⚠️ יותר מהיתרה' : ''}${l.order.confidence === 'low' ? ' ❓ התאמה לא ודאית' : ''}`
      : (s.order || s.ordersChecked) ? '   ללא שורת הזמנה' : '';
    const hand = l.handwritten ? `   ✍️ ${l.handwritten}` : '';
    const unclear = l.unclear && l.options?.length > 1 ? `   ❓ לא ברור — ${l.options.map(qtyText).join(' או ')}?` : '';
    return [head, got, ord, hand, unclear].filter(Boolean).join('\n');
  }).join('\n');
}

function summaryText(s, gr) {
  const header = [
    `📦 *קבלת סחורה ${gr.DOCNO}* — טיוטא לבדיקה`,
    companyLine(s),
    `🚚 ספק: ${gr.CDES} (${gr.SUPNAME})`,
    `📄 תעודה: ${gr.BOOKNUM ?? ''} · ${ymdHe(gr.CURDATE)}`,
    `🧾 הזמנה: ${s.order ? s.order.ordname : 'ללא הזמנה'}`,
    `📁 פרויקט: ${gr.PROJDOCNO ?? ''} ${gr.PROJDES ?? ''}`.trim()
  ];
  const lines = gr.lines.map((l, i) =>
    `*${i + 1}.* ${l.PDES} (${l.PARTNAME})\n   ${qtyText(l.TQUANT)} ${l.TUNITNAME ?? ''} × ${money(l.PRICE)}${l.PERCENT ? ` −${l.PERCENT}%` : ''} = *${money(l.QPRICE)}*` +
    `${l.ORDNAME ? ` · ${l.ORDNAME}/${l.OLINE}` : ''}${l.BUD_SUBCHAPTERNAME ? ` · תת פרק ${l.BUD_SUBCHAPTERNAME}${l.BUD_SUBCHAPTERDES ? ` ${l.BUD_SUBCHAPTERDES}` : ''}` : ''}`);
  const totals = [
    gr.PERCENT ? `הנחת מסמך ${gr.PERCENT}%` : null,
    `לפני מע"מ: ${money(gr.DISPRICE)} · מע"מ: ${money(gr.VAT)}`,
    `*סה"כ: ${money(gr.TOTPRICE)}*`
  ].filter(Boolean);
  const docTotal = s.doc?.totals?.total;
  const diff = docTotal ? Math.round((gr.TOTPRICE - docTotal) * 100) / 100 : 0;
  const check = docTotal
    ? (Math.abs(diff) < 0.01 ? `✅ תואם לסה"כ במסמך (${money(docTotal)})` : `⚠️ במסמך: ${money(docTotal)} — הפרש ${money(diff)}`)
    : null;
  const files = `📎 נספחים: ${gr.files.length}`;
  return [...header, '', ...lines, '', ...totals, check, files, '',
    '*מאשר* — הופך את ה-GR לסופי.', 'תיקון — כתבו מה לשנות ("שורה 2: 5 ולא 6").', '*ביטול* — מבטל את הטיוטא.'].filter((x) => x !== null).join('\n');
}

// ---------------------------------------------------------------------------
// השלבים
// ---------------------------------------------------------------------------

const reply = (s, text, extra = {}) => ({ s, replies: [text], ...extra });

async function onMainDoc(user, s, file) {
  s.files = [await saveFile(user.id, file, 'מסמך ראשי')];
  let doc;
  try {
    doc = await ai.extract(s.files[0]);
  } catch (err) {
    return reply(s, `לא הצלחתי לקרוא את המסמך (${err.message}). נסו לצלם שוב, ישר ובאור טוב.`, { status: 'error', result: err.message });
  }
  s.doc = doc;
  if (doc.doc_type === 'other') {
    return { s: null, replies: ['זה לא נראה כמו תעודת משלוח או חשבונית ספק' + (doc.warnings?.length ? ` (${doc.warnings.join('; ')})` : '') + '. קבלת הסחורה בוטלה. אפשר להתחיל שוב עם צילום אחר.'], status: 'unclear', result: 'מסמך שאינו תעודה/חשבונית' };
  }
  if (!doc.lines?.length) return reply(s, 'לא מצאתי שורות פריטים במסמך. נסו לצלם שוב, כך שכל הטבלה תיראה.', { status: 'unclear', result: 'אין שורות' });
  s.lines = doc.lines.map((l, i) => ({ n: i + 1, description: l.description, supplierCode: l.supplier_code, qty: l.qty, unit: l.unit,
    price: l.unit_price, discount: l.discount_pct, handwritten: l.handwritten, unclear: l.unclear, options: l.options ?? [] }));
  return resolveCompany(s);
}

async function resolveCompany(s) {
  const r = Priority.resolveCompany(s.doc.recipient_vat);
  if (r.company) {
    s.company = r.company;
    s.via = r.via;
    return resolveSupplier(s);
  }
  if (r.matched) {
    return { s: null, replies: [`המסמך מופנה ל*${r.matched.name}* (${r.matched.code}), שעדיין לא פתוחה לקליטה מהבוט. קבלת הסחורה בוטלה.`], status: 'denied', result: `חברה סגורה: ${r.matched.code}` };
  }
  const open = Priority.allowed();
  s.step = 'company';
  s.companyOptions = open;
  return reply(s, [`לא זיהיתי לאיזו חברה המסמך מופנה (נמען: ${s.doc.recipient_name || '—'}${s.doc.recipient_vat ? `, ח.פ. ${s.doc.recipient_vat}` : ''}).`,
    'לאיזו חברה לקלוט?', ...open.map((c, i) => `*${i + 1}.* ${Priority.companyOf(c).name} (${c})`), '', 'או *ביטול*.'].join('\n'));
}

async function resolveSupplier(s) {
  const found = await Priority.findSuppliers(s.company, { vat: s.doc.supplier_vat, name: s.doc.supplier_name });
  s.supplierBy = found.by;
  if (found.list.length === 1) {
    s.supplier = { code: found.list[0].SUPNAME, name: found.list[0].SUPDES };
    return askHeader(s);
  }
  s.step = 'supplier';
  s.supplierOptions = found.list.map((x) => ({ code: x.SUPNAME, name: x.SUPDES }));
  if (!found.list.length) {
    return reply(s, [companyLine(s), '', `לא מצאתי בפריוריטי את הספק *${s.doc.supplier_name}*${s.doc.supplier_vat ? ` (ח.פ. ${s.doc.supplier_vat})` : ''}.`,
      'כתבו את מספר הספק בפריוריטי, או *ביטול*.'].join('\n'));
  }
  return reply(s, [companyLine(s), '', `איזה ספק זה? (במסמך: ${s.doc.supplier_name})`,
    ...s.supplierOptions.map((x, i) => `*${i + 1}.* ${x.name} (${x.code})`), '', 'כתבו מספר, או *ביטול*.'].join('\n'));
}

async function askHeader(s) {
  const d = s.doc;
  // אותו מסמך כבר נקלט — פריוריטי ממילא דוחה מספר תעודה כפול לאותו ספק
  const dup = await Priority.findReceiptByBooknum(s.company, s.supplier.code, d.doc_number);
  if (dup && dup.STATDES !== 'מבוטלת') {
    return { s: null, replies: [`המסמך ${d.doc_number} של ${s.supplier.name} כבר נקלט: *${dup.DOCNO}* (${dup.STATDES}, ${ymdHe(dup.CURDATE)}). לא נקלט שוב.`], status: 'denied', result: `כפול: ${dup.DOCNO}` };
  }
  if (dup) {
    return { s: null, replies: [`מספר התעודה ${d.doc_number} כבר תפוס בפריוריטי ב-*${dup.DOCNO}*, שבוטל. פריוריטי לא מקבל את אותו מספר פעמיים, ואי אפשר לעדכן תעודה מבוטלת. פנו לרכש או להנהלת החשבונות.`], status: 'denied', result: `מספר תפוס ב-${dup.DOCNO} (מבוטל)` };
  }
  s.step = 'header';
  const lines = [
    `📦 *קבלת סחורה* — ${d.doc_type === 'invoice' ? 'חשבונית' : 'תעודת משלוח'} ${d.doc_number}`,
    companyLine(s),
    s.via === 'sandbox' ? `   (המסמך מופנה ל${Priority.resolveCompany(d.recipient_vat).matched?.name ?? 'חברה אחרת'} — נקלט לעותק הבדיקה)` : null,
    `🚚 ספק: *${s.supplier.name}* (${s.supplier.code})${s.supplierBy === 'name' ? ' — נמצא לפי שם, אין ח.פ. בכרטיס' : ''}`,
    d.date ? `📅 ${ymdHe(d.date)}${d.delivery_place ? ` · ${d.delivery_place}` : ''}` : null,
    d.warnings?.length ? `⚠️ ${d.warnings.join('\n⚠️ ')}` : null,
    '', 'נכון? *כן* להמשך, או *ביטול*.'
  ];
  return reply(s, lines.filter((x) => x !== null).join('\n'));
}

async function resolveOrder(s) {
  if (s.doc.po_number) {
    const o = await Priority.getOrder(s.company, s.doc.po_number);
    if (o && o.SUPNAME === s.supplier.code && o.STATDES === 'אושרה') return useOrders(s, [{ ...o, lines: o.lines.filter((l) => (l.TBALANCE ?? 0) > 0) }], o.ORDNAME);
    s.orderNote = o ? `ההזמנה ${s.doc.po_number} ${o.SUPNAME !== s.supplier.code ? 'שייכת לספק אחר' : `בסטטוס ${o.STATDES}`}` : `ההזמנה ${s.doc.po_number} לא נמצאה`;
  }
  const open = await Priority.openOrders(s.company, s.supplier.code);
  if (open.length) return useOrders(s, open, '');
  s.step = 'order';
  return reply(s, [s.orderNote ? `⚠️ ${s.orderNote}.` : null, `לספק ${s.supplier.name} אין הזמנות פתוחות.`,
    'יש מספר הזמנה? כתבו אותו (PO…), או *בלי הזמנה* — קליטה לפי המסמך בלבד.'].filter(Boolean).join('\n'));
}

async function useOrders(s, orders, forced) {
  s.ordersChecked = true;
  const m = await ai.match(s.doc.lines, orders);
  const chosen = forced || m.best_order || '';
  const order = orders.find((o) => o.ORDNAME === chosen) ?? null;
  for (const l of s.lines) {
    const hit = m.matches.find((x) => x.doc_line === l.n && x.order === chosen && x.line);
    const ol = hit && order?.lines.find((x) => Number(x.LINE) === Number(hit.line));
    l.order = ol ? { ordname: order.ORDNAME, line: ol.LINE, des: ol.PDES, part: ol.PARTNAME, balance: ol.TBALANCE, confidence: hit.confidence } : null;
  }
  if (order && s.lines.some((l) => l.order)) {
    s.order = { ordname: order.ORDNAME, project: order.PROJDOCNO, projectDes: order.PROJDES };
    s.project = order.PROJDOCNO ? { code: order.PROJDOCNO, des: order.PROJDES } : null;
  }
  return askLines(s);
}

function askLines(s) {
  s.step = 'lines';
  const others = s.order ? '' : (s.ordersChecked ? 'לא מצאתי התאמה בהזמנות הפתוחות של הספק — נקלט לפי המסמך.\n' : '');
  return reply(s, [s.order ? `🧾 לפי הזמנה *${s.order.ordname}*` : '🧾 ללא הזמנה', others, linesTable(s), '',
    '*זה מה שהתקבל בפועל?*', '*כן* — להמשך. משהו חסר, נשבר או הוחזר — כתבו מה ("מלט קיבלתי רק 100, 100 שבורים הוחזרו").'].filter(Boolean).join('\n'));
}

/** מה שהעובד כתב על השורות או על הטיוטא */
async function understandReply(s, text) {
  const shown = s.lines.map((l) => ({ line: l.n, description: l.description, qty: l.qty, options: l.unclear ? l.options : [] }));
  return ai.reply(shown, text);
}

function applyUpdates(s, out) {
  const changed = [];
  for (const u of out.updates ?? []) {
    const l = s.lines.find((x) => x.n === u.line);
    if (!l || !(u.qty >= 0)) continue;
    changed.push(`${l.description}: ${qtyText(l.qty)} ← ${qtyText(u.qty)}`);
    l.qty = u.qty;
    l.unclear = false;
  }
  if (changed.length) s.corrections = [...(s.corrections ?? []), `${changed.join('; ')}${out.note ? ` (${out.note})` : ''}`];
  return changed;
}

async function afterLines(s) {
  // שורות בלי הזמנה — פריט בתיאור זהה, אחרת ‎000‎ ותת פרק
  for (const l of s.lines.filter((x) => !x.order)) {
    const part = await Priority.findPartExact(s.company, l.description);
    l.part = part ? { code: part.PARTNAME, chapter: part.BUD_SUBCHAPTERNAME, topic: part.BUD_SUBTOPICNAME } : null;
  }
  const general = s.lines.filter((x) => !x.order && !x.part && x.qty > 0);
  if (general.length && !s.chapter) {
    s.step = 'chapter';
    s.chapterSuggestion = await Priority.lastSubchapter(s.company, s.supplier.code);
    const sug = s.chapterSuggestion;
    return reply(s, [`${general.length} שורות ייקלטו כ*פריט כללי 000* עם התיאור של הספק.`,
      sug ? `תת פרק: *${sug.chapter} ${sug.chapterDes}* (תת נושא ${sug.topic}) — כמו בקליטה הקודמת של הספק. *כן*, או כתבו תת פרק ותת נושא (למשל "01 01-20").`
        : 'לאיזה תת פרק? כתבו תת פרק ותת נושא (למשל "98 90-00").'].join('\n'));
  }
  return askProject(s);
}

async function askProject(s) {
  if (s.project) return askFiles(s);
  const all = await Priority.projects(s.company);
  const words = `${s.doc.project_hint} ${s.doc.delivery_place}`.split(/[\s,\-–/]+/).filter((w) => w.length >= 2);
  const scored = all.map((p) => ({ ...p, score: words.filter((w) => p.des.includes(w)).length })).filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)).slice(0, 6);
  s.projectOptions = scored.length ? scored : [];
  s.step = 'project';
  const hint = [s.doc.project_hint, s.doc.delivery_place].filter(Boolean).join(' · ');
  return reply(s, [`📁 לאיזה פרויקט לשייך?${hint ? ` (במסמך: ${hint})` : ''}`,
    ...s.projectOptions.map((p, i) => `*${i + 1}.* ${p.des} (${p.code})`),
    s.projectOptions.length ? '' : 'לא מצאתי פרויקט מתאים לפי המסמך.',
    'כתבו מספר מהרשימה, קוד פרויקט (PR…) או מילה מהשם.'].join('\n'));
}

function askFiles(s) {
  s.step = 'files';
  return reply(s, ['📎 *נספחים* — יש עוד מסמכים לצרף (תעודה נוספת, תמונה של הסחורה)? שלחו אותם עכשיו, אחד אחרי השני.',
    'כשסיימתם — *סיום*. אין — *אין*.'].join('\n'));
}

async function createDraft(user, s) {
  const c = s.company;
  const docno = await Priority.createReceipt(c, { supname: s.supplier.code, booknum: s.doc.doc_number, date: s.doc.date || null, project: s.project?.code });
  s.docno = docno;
  save(user.id, s);
  const problems = [];
  for (const l of s.lines.filter((x) => x.qty > 0)) {
    try {
      if (l.order) await Priority.addOrderLine(c, docno, { ordname: l.order.ordname, line: l.order.line, qty: l.qty });
      else if (l.part) await Priority.addFreeLine(c, docno, { part: l.part.code, qty: l.qty, price: l.price, discount: l.discount, chapter: l.part.chapter, topic: l.part.topic });
      else await Priority.addFreeLine(c, docno, { part: '000', description: l.description, qty: l.qty, price: l.price, discount: l.discount, chapter: s.chapter?.chapter, topic: s.chapter?.topic });
    } catch (err) {
      problems.push(`שורה ${l.n} (${l.description}): ${err.message}`);
    }
  }
  if (!s.order && s.doc.totals?.doc_discount_pct) {
    await Priority.setHeader(c, docno, { PERCENT: s.doc.totals.doc_discount_pct }).catch((err) => problems.push(`הנחת מסמך: ${err.message}`));
  }
  await Priority.setHeader(c, docno, { DETAILS: `בוט ${s.doc.doc_number}`.slice(0, 24) }).catch(() => {});
  for (const f of s.files) {
    try {
      await Priority.attach(c, docno, { buf: fs.readFileSync(f.path), mime: f.mime, description: f.label === 'מסמך ראשי' ? `${s.doc.doc_type === 'invoice' ? 'חשבונית' : 'תעודת משלוח'} ${s.doc.doc_number} — ${s.supplier.name}` : f.label });
    } catch (err) {
      problems.push(`נספח ${f.label}: ${err.message}`);
    }
  }
  await writeDialog(user, s).catch((err) => problems.push(`דו-שיח פנימי: ${err.message}`));
  return problems;
}

function writeDialog(user, s) {
  const d = s.doc;
  const short = s.lines.filter((l) => l.order && l.qty < l.order.balance).map((l) => `${l.description}: התקבלו ${qtyText(l.qty)} מתוך יתרה ${qtyText(l.order.balance)}`);
  return Priority.setDialog(s.company, s.docno, [
    'קבלת סחורה דרך בוט משימון',
    `התקבל ע"י: ${user.full_name} | ${nowHe()}`,
    `מסמך מקור: ${d.doc_type === 'invoice' ? 'חשבונית' : 'תעודת משלוח'} ${d.doc_number} של ${s.supplier.name}, מצורף בנספחים`,
    d.supplier_order_ref ? `הזמנה אצל הספק: ${d.supplier_order_ref}` : null,
    d.date || d.delivery_place ? `אספקה: ${[ymdHe(d.date), d.delivery_place].filter(Boolean).join(', ')}` : null,
    d.purchase_type !== 'unknown' ? `סוג רכש: ${d.purchase_type === 'site' ? 'אתרי' : 'משרדי'}` : null,
    ...(s.corrections ?? []).map((c) => `תיקון המקבל: ${c}`),
    ...short.map((x) => `קבלה חלקית — ${x}. היתרה נשארת פתוחה`),
    !s.order && s.project ? `פרויקט נבחר ע"י המקבל: ${s.project.code} ${s.project.des}` : null,
    s.chapter ? `תת פרק לפריט כללי: ${s.chapter.chapter} ${s.chapter.topic}` : null
  ]);
}

async function showDraft(s, problems = []) {
  const gr = await Priority.readReceipt(s.company, s.docno);
  s.step = 'review';
  s.reviewLines = gr.lines.map((l, i) => ({ n: i + 1, kline: l.KLINE, description: l.PDES, qty: l.TQUANT }));
  const warn = problems.length ? `⚠️ חלק לא נקלט:\n${problems.map((p) => `• ${p}`).join('\n')}\n\n` : '';
  // ה-PDF לבדיקה — מהשדות כפי שנשמרו, כולל הדו-שיח הפנימי
  const files = [];
  try {
    const dialog = await Priority.readDialog(s.company, s.docno).catch(() => []);
    const c = Priority.companyOf(s.company);
    const buf = receiptPdf(gr, { companyLabel: `${c.name.replace(/ — .*/, '')} (${s.company})`, test: Priority.isTest(s.company), order: s.order?.ordname ?? '', dialog, docTotal: s.doc?.totals?.total || null });
    files.push({ buf, fileName: `${gr.DOCNO}-טיוטא.pdf`, mime: 'application/pdf', caption: `📄 ${gr.DOCNO} — טיוטא לבדיקה` });
  } catch (err) {
    console.error('[משימון] PDF של קבלת סחורה:', err.message);
  }
  return reply(s, warn + summaryText(s, gr), { files });
}

// ---------------------------------------------------------------------------
// הכניסה
// ---------------------------------------------------------------------------

async function cancel(user, s, why = 'בוטלה') {
  let note = '';
  if (s?.docno) {
    try {
      await Priority.cancelReceipt(s.company, s.docno);
      note = ` הטיוטא ${s.docno} בוטלה בפריוריטי.`;
    } catch (err) {
      note = ` ⚠️ לא הצלחתי לבטל את הטיוטא ${s.docno} בפריוריטי (${err.message}) — בטלו אותה ידנית, אחרת היתרה בהזמנה נשארת תפוסה.`;
    }
  }
  clear(user.id, s);
  return { replies: [`קבלת הסחורה ${why}.${note}`], status: 'ok', result: `ביטול${s?.docno ? ` ${s.docno}` : ''}` };
}

/**
 * הודעה של העובד — טקסט, קובץ, או שניהם.
 * @returns {Promise<{replies: string[], status: string, result: string}>}
 */
async function handle({ user, text = '', file = null }) {
  const t = String(text ?? '').trim();
  let s = load(user.id);
  if (s && !fresh(s)) {
    // נשכחה — טיוטא שלא אושרה מבוטלת, כדי לא להשאיר יתרה תפוסה בהזמנה
    if (s.docno) await Priority.cancelReceipt(s.company, s.docno).catch(() => {});
    clear(user.id, s);
    s = null;
  }
  if (!Priority.isEnabled()) return { replies: ['החיבור לפריוריטי עוד לא הוגדר בשרת. פנו למנהל המערכת.'], status: 'error', result: 'פריוריטי לא מוגדר' };
  if (!Claude.isEnabled()) return { replies: ['קריאת מסמכים דורשת חיבור AI, שעוד לא הוגדר בשרת.'], status: 'error', result: 'AI לא מוגדר' };

  // התחלה חדשה ("קבלת סחורה" באמצע קליטה — מתחילים מחדש, ומבטלים טיוטא קודמת)
  if (!s || (isTrigger(t) && file && s.step !== 'files')) {
    if (s) await cancel(user, s, 'הקודמת בוטלה');
    s = { step: 'doc', startedAt: Date.now() };
    if (!file) {
      save(user.id, s);
      return { replies: ['📦 *קבלת סחורה* — שלחו צילום של תעודת המשלוח או החשבונית (המסמך הראשי, שממנו נקראים הנתונים).'], status: 'ok', result: 'התחלה' };
    }
  }

  if (CANCEL.test(t) && !file) return cancel(user, s);

  let out;
  try {
    out = await step(user, s, t, file);
  } catch (err) {
    console.error('[משימון] קבלת סחורה:', err.message);
    save(user.id, s);
    return { replies: [`משהו השתבש מול פריוריטי: ${err.message}\nנסו שוב, או *ביטול*.`], status: 'error', result: err.message };
  }
  if (out.s === null) clear(user.id, s);
  else save(user.id, out.s ?? s);
  return { replies: out.replies, files: out.files ?? [], status: out.status ?? 'ok', result: out.result ?? `שלב ${(out.s ?? s)?.step ?? 'סיום'}`, docno: s.docno ?? null };
}

async function step(user, s, t, file) {
  switch (s.step) {
    case 'doc':
      if (!file) return reply(s, 'מחכה לצילום של תעודת המשלוח או החשבונית. או *ביטול*.');
      return onMainDoc(user, s, file);

    case 'company': {
      const n = numberIn(t);
      const c = n && s.companyOptions[n - 1];
      if (!c) return reply(s, 'כתבו את מספר החברה מהרשימה, או *ביטול*.');
      s.company = c;
      s.via = 'direct';
      return resolveSupplier(s);
    }

    case 'supplier': {
      const n = numberIn(t);
      let sup = s.supplierOptions?.length && n && n <= s.supplierOptions.length && /^\d{1,2}$/.test(t) ? s.supplierOptions[n - 1] : null;
      if (!sup && /^\d{3,}$/.test(t)) {
        // מספר ספק בפריוריטי
        const x = await Priority.supplierByCode(s.company, t);
        if (!x) return reply(s, `אין ספק ${t}. כתבו מספר מהרשימה, מספר ספק אחר, או *ביטול*.`);
        sup = { code: x.SUPNAME, name: x.SUPDES };
      }
      if (!sup && t && !/^\d+$/.test(t)) {
        const found = await Priority.findSuppliers(s.company, { vat: /^\d{9}$/.test(t) ? t : '', name: t });
        const exact = /^\d+$/.test(t) ? found.list.find((x) => x.SUPNAME === t) : null;
        const list = exact ? [exact] : found.list;
        if (list.length === 1) sup = { code: list[0].SUPNAME, name: list[0].SUPDES };
        else if (list.length) {
          s.supplierOptions = list.map((x) => ({ code: x.SUPNAME, name: x.SUPDES }));
          return reply(s, ['איזה מהם?', ...s.supplierOptions.map((x, i) => `*${i + 1}.* ${x.name} (${x.code})`)].join('\n'));
        }
      }
      if (!sup) return reply(s, 'לא מצאתי. כתבו את מספר הספק בפריוריטי, או *ביטול*.');
      s.supplier = sup;
      s.supplierBy = 'user';
      return askHeader(s);
    }

    case 'header':
      if (!YES.test(t)) return reply(s, '*כן* להמשך, או *ביטול*.');
      return resolveOrder(s);

    case 'order': {
      if (NO_ORDER.test(t)) { s.ordersChecked = false; return askLines(s); }
      const po = (t.match(/PO\s*\d+/i)?.[0] ?? '').replace(/\s+/g, '').toUpperCase();
      if (!po) return reply(s, 'כתבו מספר הזמנה (PO…), או *בלי הזמנה*.');
      const o = await Priority.getOrder(s.company, po);
      if (!o) return reply(s, `לא מצאתי את ${po}. כתבו מספר אחר, או *בלי הזמנה*.`);
      if (o.SUPNAME !== s.supplier.code) return reply(s, `${po} שייכת לספק אחר (${o.CDES}). כתבו מספר אחר, או *בלי הזמנה*.`);
      if (o.STATDES !== 'אושרה') return reply(s, `${po} בסטטוס "${o.STATDES}" — אפשר לקבל רק מהזמנה מאושרת. כתבו מספר אחר, או *בלי הזמנה*.`);
      return useOrders(s, [{ ...o, lines: o.lines.filter((l) => (l.TBALANCE ?? 0) > 0) }], o.ORDNAME);
    }

    case 'lines': {
      if (YES.test(t)) {
        const open = s.lines.filter((l) => l.unclear && l.options?.length > 1);
        if (open.length) return reply(s, `❓ קודם שורה ${open[0].n} (${open[0].description}): ${open[0].options.map(qtyText).join(' או ')}?`);
        const low = s.lines.filter((l) => l.order?.confidence === 'low' && !l.lowConfirmed);
        if (low.length && !s.lowAsked) { s.lowAsked = true; return reply(s, `❓ ההתאמה להזמנה בשורות ${low.map((l) => l.n).join(', ')} אינה ודאית. *כן* — להשאיר, או כתבו "שורה X בלי הזמנה".`); }
        return afterLines(s);
      }
      const noOrder = t.match(/שורה\s*(\d+)\s*בלי הזמנה/);
      if (noOrder) {
        const l = s.lines.find((x) => x.n === Number(noOrder[1]));
        if (l) l.order = null;
        return askLines(s);
      }
      const out = await understandReply(s, t);
      if (out.action === 'confirm') return step(user, s, 'כן', null);
      if (out.action === 'cancel') return cancel(user, s).then((r) => ({ s: null, ...r }));
      if (out.action === 'answer' && out.choice) {
        const l = s.lines.find((x) => x.unclear);
        const v = Number(String(out.choice).replace(/[^\d.]/g, ''));
        if (l && Number.isFinite(v) && v >= 0) {
          // "180" — הערך עצמו; "2" — האפשרות השנייה (כשאינו אחד הערכים)
          const opts = l.options ?? [];
          l.qty = opts.includes(v) || !(v >= 1 && v <= opts.length) ? v : opts[v - 1];
          l.unclear = false;
        }
        return askLines(s);
      }
      if (out.action === 'update' && applyUpdates(s, out).length) return askLines(s);
      return reply(s, out.question || 'לא הבנתי. *כן* — אם זה מה שהתקבל, או כתבו מה לתקן (מספר שורה וכמות).');
    }

    case 'chapter': {
      const sug = s.chapterSuggestion;
      if (YES.test(t) && sug) s.chapter = { chapter: sug.chapter, topic: sug.topic };
      else {
        const m = t.match(/(\d{2})\s+(\d{2}-\d{2})/);
        if (!m) return reply(s, 'כתבו תת פרק ותת נושא (למשל "98 90-00"), או *כן* להצעה.');
        s.chapter = { chapter: m[1], topic: m[2] };
      }
      return askProject(s);
    }

    case 'project': {
      const n = numberIn(t);
      let p = !/PR/i.test(t) && n && n <= (s.projectOptions?.length ?? 0) ? s.projectOptions[n - 1] : null;
      if (!p) {
        const all = await Priority.projects(s.company);
        const code = t.match(/PR\d+/i)?.[0]?.toUpperCase();
        const list = code ? all.filter((x) => x.code === code) : all.filter((x) => x.des.includes(t));
        if (code && !list.length) p = { code, des: '' };          // פרויקט בלי מסמכים — פריוריטי יאמת
        else if (list.length === 1) p = list[0];
        else if (list.length) {
          s.projectOptions = list.slice(0, 8);
          return reply(s, ['איזה מהם?', ...s.projectOptions.map((x, i) => `*${i + 1}.* ${x.des} (${x.code})`)].join('\n'));
        }
      }
      if (!p) return reply(s, 'לא מצאתי. כתבו מספר מהרשימה או קוד פרויקט (PR…).');
      s.project = p;
      return askFiles(s);
    }

    case 'files':
      if (file) {
        s.files.push(await saveFile(user.id, file, `נספח ${s.files.length}`));
        return reply(s, `📎 נספח ${s.files.length - 1} התקבל. עוד? או *סיום*.`);
      }
      if (!DONE_FILES.test(t)) return reply(s, 'שלחו נספח, או *סיום* להמשך.');
      return showDraft(s, await createDraft(user, s));

    case 'review': {
      if (/^(מאשר|מאשרת|אישור|אשר)([\s,.!]|$)/.test(t)) {
        try {
          await Priority.finalizeReceipt(s.company, s.docno);
        } catch (err) {
          return { s: null, replies: [`ה-GR *${s.docno}* נשמר כטיוטא, אבל לא הצלחתי להפוך אותו לסופי: ${err.message}\nאפשר לאשר אותו בפריוריטי.`], status: 'error', result: `סופית נכשלה: ${err.message}` };
        }
        return { s: null, replies: [`✅ *קבלת סחורה ${s.docno}* נקלטה כסופית.\n${companyLine(s)}\nספק: ${s.supplier.name}${s.order ? ` · הזמנה ${s.order.ordname}` : ''}`], status: 'ok', result: `GR סופי ${s.docno}` };
      }
      if (file) {
        const f = await saveFile(user.id, file, `נספח ${s.files.length}`);
        s.files.push(f);
        const problems = [];
        await Priority.attach(s.company, s.docno, { buf: fs.readFileSync(f.path), mime: f.mime, description: f.label }).catch((err) => problems.push(`נספח: ${err.message}`));
        return showDraft(s, problems);
      }
      const out = await ai.reply(s.reviewLines.map((l) => ({ line: l.n, description: l.description, qty: l.qty, options: [] })), t);
      if (out.action === 'confirm') return step(user, s, 'מאשר', null);
      if (out.action === 'cancel') return cancel(user, s).then((r) => ({ s: null, ...r }));
      if (out.action === 'update' && out.updates?.length) {
        const changed = [];
        for (const u of out.updates) {
          const l = s.reviewLines.find((x) => x.n === u.line);
          if (!l || !(u.qty >= 0)) continue;
          await Priority.setLineQty(s.company, s.docno, l.kline, u.qty);
          changed.push(`${l.description}: ${qtyText(l.qty)} ← ${qtyText(u.qty)}`);
        }
        if (changed.length) {
          s.corrections = [...(s.corrections ?? []), `${changed.join('; ')}${out.note ? ` (${out.note})` : ''}`];
          await writeDialog(user, s).catch(() => {});
        }
        return showDraft(s);
      }
      return reply(s, out.question || '*מאשר*, תיקון (מספר שורה וכמות), או *ביטול*.');
    }
    default:
      return { s: null, replies: ['קבלת הסחורה הסתיימה. להתחלה — "קבלת סחורה" וצילום.'] };
  }
}

module.exports = { isTrigger, active, handle, _ai: ai, _load: load, _clear: (userId) => clear(userId, load(userId)) };
