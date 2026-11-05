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
const Auth = require('../auth');
const P = require('../permissions');

/*
 * הודעות לעובד — רק מה שהוא יכול לעשות. פרטים טכניים (שגיאת פריוריטי, הגדרות שרת)
 * אינם מוצגים לו: הם נרשמים ביומן הבוט (‎result‎) ונשלחים כהתראה למנהלי המערכת.
 */
function alertAdmins(user, s, title, details) {
  const body = [`עובד: ${user?.full_name ?? ''}`, s?.company ? `חברה: ${s.company}` : null, s?.docno ? `GR: ${s.docno}` : null,
    s?.doc?.doc_number ? `מסמך: ${s.doc.doc_number}${s.supplier ? ` של ${s.supplier.name}` : ''}` : null, ...details].filter(Boolean).join('\n');
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `📦 קבלת סחורה: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על קבלת סחורה:', err.message);
  }
}

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
/** הודעה שפותחת קבלת סחורה: המילים, או קובץ בלי טקסט (ואז הבוט שואל קודם) */
const opens = (text, file) => isTrigger(text) || Boolean(file && !String(text ?? '').trim());
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
    : `🏢 *${c.name}* (${s.company}) — *סביבת אמת*${s.companyHow === 'name' ? ' · זוהתה לפי שם הנמען' : s.companyHow === 'id' ? ' · זוהתה לפי מספר במסמך' : ''}`;
};

/** החברה של המסמך: ח.פ. הנמען, כל מספר אחר שבמסמך, או שם הנמען (‎Priority.resolveCompany‎) */
const companyMatch = (d) => Priority.resolveCompany(d?.recipient_vat, { ids: d?.other_ids ?? [], name: d?.recipient_name ?? '' });

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
    doc_type: { type: 'string', enum: ['delivery_note', 'invoice', 'payment', 'other'] },
    doc_label: str,
    recipient_name: str, recipient_vat: str, other_ids: { type: 'array', items: str },
    supplier_name: str, supplier_vat: str,
    doc_number: str, po_number: str, supplier_order_ref: str,
    date: str, doc_date: str, delivery_place: str, project_hint: str,
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
  required: ['doc_type', 'doc_label', 'recipient_name', 'recipient_vat', 'other_ids', 'supplier_name', 'supplier_vat', 'doc_number', 'po_number', 'supplier_order_ref',
    'date', 'doc_date', 'delivery_place', 'project_hint', 'purchase_type', 'lines', 'totals', 'warnings'],
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
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['attachment', 'new_document'] },
    doc_type: { type: 'string', enum: ['delivery_note', 'invoice', 'payment', 'other'] },
    doc_number: str, supplier_name: str
  },
  required: ['kind', 'doc_type', 'doc_number', 'supplier_name'],
  additionalProperties: false
};
const PROJECT_SCHEMA = {
  type: 'object',
  properties: { codes: { type: 'array', items: str }, question: str },
  required: ['codes', 'question'],
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
  async classify(current, file) {
    const data = fs.readFileSync(file.path).toString('base64');
    const block = file.mime.includes('pdf')
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.mime.includes('png') ? 'image/png' : 'image/jpeg', data } };
    return Claude.json({ system: skill(), content: [block, { type: 'text', text: JSON.stringify({ task: 'classify', current }) }], schema: CLASSIFY_SCHEMA, effort: 'low', live: true });
  },
  async project(projects, text) {
    const content = JSON.stringify({ task: 'project', text, projects: projects.map((p) => ({ code: p.code, name: p.des, aliases: p.alias ?? '' })) });
    return Claude.json({ system: skill(), content: [{ type: 'text', text: content }], schema: PROJECT_SCHEMA, effort: 'low', live: true });
  },
  async reply(shown, text) {
    return Claude.json({ system: skill(), content: [{ type: 'text', text: JSON.stringify({ task: 'reply', shown, text }) }], schema: REPLY_SCHEMA, effort: 'low', live: true });
  }
};

// ---------------------------------------------------------------------------
// פרויקטים — כינויים (מהסקיל) וחיפוש בשפה חופשית
// ---------------------------------------------------------------------------

/** "## כינויים לפרויקטים" בסקיל: ‎- מילים מהשם = כינויים‎ */
function projectAliases() {
  const text = skill();
  const at = text.indexOf('### כינויים לפרויקטים');
  if (at < 0) return [];
  const block = text.slice(at).split(/\n(?=---|## )/)[0];
  return block.split('\n').map((l) => l.match(/^-\s*(.+?)\s*=\s*(.+)$/)).filter(Boolean).map((m) => ({ key: m[1], add: m[2].replace(/,/g, ' ') }));
}

async function projectsOf(company) {
  const list = (await Priority.projects(company)).map((p) => ({ ...p }));
  for (const a of projectAliases()) {
    for (const p of Priority.matchProjects(list, a.key, { all: true })) {
      const orig = list.find((x) => x.code === p.code);
      orig.alias = `${orig.alias ?? ''} ${a.add}`.trim();
    }
  }
  return list;
}

/** פרויקטים לפי טקסט חופשי: קודם הקוד (כל המילים), ואם לא — ה-AI מול הרשימה */
async function findProjects(all, text, { strict = true } = {}) {
  let list = Priority.matchProjects(all, text, { all: true });
  if (!strict && !list.length) {
    const any = Priority.matchProjects(all, text);
    const top = any.length ? any.filter((p) => p.score === any[0].score) : [];
    list = top;
  }
  if (list.length) return { list, by: 'code' };
  if (!Claude.isEnabled() || !String(text ?? '').trim()) return { list: [], by: null };
  try {
    const out = await ai.project(all, text);
    const codes = (out.codes ?? []).filter((c, i, arr) => arr.indexOf(c) === i);
    return { list: codes.map((c) => all.find((p) => p.code === c)).filter(Boolean).slice(0, 6), by: 'ai', question: out.question };
  } catch (err) {
    console.error('[משימון] התאמת פרויקט ב-AI:', err.message);
    return { list: [], by: null };
  }
}

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
    `📁 פרויקט: ${gr.PROJDOCNO ?? ''} ${gr.PROJDES ?? ''}`.trim(),
    `🏬 מחסן: ${gr.TOWARHSDES ? `${gr.TOWARHSDES} (${gr.TOWARHSNAME})` : gr.TOWARHSNAME ?? ''}`,
    `💳 תנאי תשלום: ${Priority.payLabel(gr.MED_MXPAYCODE) || gr.MED_MXPAYDES || '—'}${dueText(s, gr.MED_MXPAYCODE)}${s.order?.payCode && s.order.payCode !== gr.MED_MXPAYCODE ? ` ⚠️ בהזמנה: ${Priority.payLabel(s.order.payCode)}` : ''}`
  ];
  const lines = gr.lines.map((l, i) =>
    `*${i + 1}.* ${l.PDES} (${l.PARTNAME})\n   ${qtyText(l.TQUANT)} ${l.TUNITNAME ?? ''} × ${money(l.PRICE)}${l.PERCENT ? ` −${l.PERCENT}%` : ''} = *${money(l.QPRICE)}*` +
    `${l.ORDNAME ? ` · ${l.ORDNAME}/${l.OLINE}` : ''}${l.BUD_SUBCHAPTERNAME ? ` · תת פרק ${l.BUD_SUBCHAPTERNAME}${l.BUD_SUBCHAPTERDES ? ` ${l.BUD_SUBCHAPTERDES}` : ''}` : ''}`);
  const totals = [
    gr.PERCENT ? `הנחת מסמך ${gr.PERCENT}%` : null,
    `לפני מע"מ: ${money(gr.DISPRICE)} · מע"מ: ${money(gr.VAT)}`,
    `*סה"כ: ${money(gr.TOTPRICE)}*`
  ].filter(Boolean);
  // בקרה מול המסמך: לפני מע"מ (כשידוע), אחרת הסה"כ. הפרש עיגול (פחות מ-1 ₪) אינו בעיה
  const before = s.doc?.totals?.before_vat;
  const docTotal = before || s.doc?.totals?.total;
  const grTotal = before ? gr.DISPRICE : gr.TOTPRICE;
  const what = before ? 'לפני מע"מ' : 'סה"כ';
  const src = s.doc?.detail ? `בחשבונית ${s.doc.doc_number}` : 'במסמך';
  const toSrc = s.doc?.detail ? `לחשבונית ${s.doc.doc_number}` : 'למסמך';
  const diff = docTotal ? Math.round((grTotal - docTotal) * 100) / 100 : 0;
  const check = docTotal
    ? (Math.abs(diff) < 0.01 ? `✅ ${what} תואם ${toSrc} (${money(docTotal)})`
      : Math.abs(diff) < 1 ? `✅ ${what} תואם ${toSrc} (${money(docTotal)}; עיגול ${money(diff)})`
        : `⚠️ ${what} ${src}: ${money(docTotal)} — הפרש ${money(diff)}`)
    : null;
  const detailLine = s.doc?.detail ? `📋 הפירוט מ${s.doc.detail.doc_type === 'invoice' ? 'חשבונית' : 'חשבון לתשלום'} ${s.doc.detail.doc_number}` : null;
  const files = [detailLine, `📎 נספחים: ${gr.files.length}`].filter(Boolean).join('\n');
  return [...header, '', ...lines, '', ...totals, check, files, '',
    '*מאשר* — הופך את ה-GR לסופי.', 'תיקון — כתבו מה לשנות ("שורה 2: 5 ולא 6").', '*ביטול* — מבטל את הטיוטא.'].filter((x) => x !== null).join('\n');
}

// ---------------------------------------------------------------------------
// השלבים
// ---------------------------------------------------------------------------

/** ‎lastPrompt‎ — השאלה האחרונה, כדי לחזור עליה אחרי נספח שהגיע באמצעה */
/** "לתשלום עד 15.05.2026 (מתאריך החשבונית 15.03.2026)" — מתאריך המסמך הראשי (החשבונית) */
function dueText(s, code) {
  const from = s.doc?.doc_date || s.doc?.date;
  const due = Priority.dueDate(code, from);
  if (!due) return '';
  return ` — לתשלום עד ${ymdHe(due)} (מתאריך ${s.doc?.doc_type === 'invoice' ? 'החשבונית' : 'המסמך'} ${ymdHe(from)})`;
}

const reply = (s, text, extra = {}) => { if (s && s.step) s.lastPrompt = text; return { s, replies: [text], ...extra }; };

const linesOf = (doc) => (doc.lines ?? []).map((l, i) => ({ n: i + 1, description: l.description, supplierCode: l.supplier_code, qty: l.qty, unit: l.unit,
  price: l.unit_price, discount: l.discount_pct, handwritten: l.handwritten, unclear: l.unclear, options: l.options ?? [] }));

/** שם סוג המסמך לתצוגה: "חשבונית", "תעודת משלוח", או כפי שכתוב עליו ("אגרת שלטים", "שובר תשלום") */
function docName(d, short = false) {
  if (!d) return 'מסמך';
  if (d.doc_type === 'invoice') return 'חשבונית';
  if (d.doc_type === 'delivery_note') return short ? 'תעודה' : 'תעודת משלוח';
  const label = String(d.doc_label ?? '').trim();
  return label && label.length <= 24 ? label : d.doc_type === 'payment' ? 'שובר תשלום' : 'מסמך';
}

/*
 * מסמך בלי שורות פריטים אבל עם סכום (אגרה, שובר תשלום) — שורה אחת: תיאור המסמך, כמות 1, הסכום לפני מע"מ.
 */
function oneLineOf(doc) {
  const t = doc.totals ?? {};
  const amount = Number(t.before_vat || t.subtotal || t.total || 0);
  if (!(amount > 0)) return null;
  return { description: [doc.doc_label || docName(doc), doc.doc_number].filter(Boolean).join(' ').slice(0, 48), supplier_code: '', qty: 1, unit: "יח'",
    unit_price: amount, discount_pct: 0, line_total: amount, handwritten: '', unclear: false, options: [] };
}

/*
 * חשבונית מס עם שורה אחת שמפנה לחשבון לתשלום ("ח-ן לתשלום 2011796") — הפירוט בחשבון.
 * השורות של ה-GR נלקחות מהחשבון; מספר התעודה, הסכום לפני מע"מ והבקרה — מהחשבונית.
 */
const refsOf = (doc) => [doc.supplier_order_ref, ...(doc.lines ?? []).map((l) => `${l.description} ${l.supplier_code}`)].join(' ');
function isDetailOf(main, d) {
  if (!main || !d || !(d.lines ?? []).length || !d.doc_number || d.doc_number === main.doc_number) return false;
  if ((main.lines ?? []).length > 2) return false;           // לחשבונית יש פירוט משלה
  return refsOf(main).replace(/\s/g, '').includes(String(d.doc_number).replace(/\s/g, ''));
}
function withDetail(main, d) {
  const n = String(d.doc_number);
  return {
    ...main,
    lines: d.lines,
    detail: { doc_number: n, doc_type: d.doc_type, totals: d.totals },
    // "אין פירוט פריטים" — כבר לא נכון
    warnings: (main.warnings ?? []).filter((w) => !w.includes(n) && !/פירוט/.test(w))
  };
}

async function onMainDoc(user, s, file, pre = null) {
  s.files = [file.path ? { ...file, label: 'מסמך ראשי' } : await saveFile(user.id, file, 'מסמך ראשי')];
  let doc;
  try {
    doc = pre ?? await ai.extract(s.files[0]);
  } catch (err) {
    return reply(s, 'לא הצלחתי לקרוא את המסמך. נסו לצלם שוב, ישר ובאור טוב, כך שכל הדף ייראה.', { status: 'error', result: `קריאת מסמך נכשלה: ${err.message}` });
  }
  // אזהרות — בעברית בלבד; אזהרה שהגיעה באנגלית למרות ההנחיה אינה מוצגת
  doc.warnings = (doc.warnings ?? []).filter((w) => /[\u0590-\u05FF]/.test(w) && !/^[\x00-\x7F]{12}/.test(String(w).trim())).slice(0, 3);
  s.doc = doc;
  // כמעט מכל מסמך ספק אפשר לקלוט קבלת סחורה (גם אגרה או שובר תשלום). רק כשלא ברור שזה מסמך ספק — שואלים
  if (doc.doc_type === 'other') {
    s.step = 'doctype';
    return reply(s, [`🤔 זה נראה כמו *${docName(doc)}*${doc.doc_number ? ` ${doc.doc_number}` : ''}${doc.supplier_name ? ` של ${doc.supplier_name}` : ''}, לא תעודת משלוח או חשבונית.`,
      'לקלוט אותו בכל זאת כ*קבלת סחורה*? *כן* / *לא*'].join('\n'), { status: 'unclear', result: `סוג מסמך לא ברור: ${doc.doc_label || 'other'}` });
  }
  return afterDocType(s);
}

async function afterDocType(s) {
  const doc = s.doc;
  if (!doc.lines?.length) {
    const one = oneLineOf(doc);
    if (!one) return reply(s, 'לא מצאתי במסמך שורות פריטים או סכום. נסו לצלם שוב, כך שכל הדף ייראה.', { status: 'unclear', result: 'אין שורות' });
    doc.lines = [one];
  }
  s.lines = linesOf(doc);
  return resolveCompany(s);
}

async function resolveCompany(s) {
  const r = companyMatch(s.doc);
  if (r.company) {
    s.company = r.company;
    s.via = r.via;
    s.companyHow = r.how;
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

/*
 * מע"מ: מסמך עם סכום ובלי מע"מ (אגרה, ארנונה, שכר דירה, חלק משכר הטרחה) — קוד מס ‎000‎ (ללא מע"מ).
 * ברירת המחדל של פריוריטי — ‎002‎ (עם מע"מ). העובד יכול לשנות: "ללא מע"מ" / "עם מע"מ".
 */
const NO_VAT_TEXT = /(ללא|בלי|אין|פטור\s*מ)\s*מע["'״]?מ/;
const WITH_VAT_TEXT = /^(עם|כולל|יש)\s*מע["'״]?מ/;
function docWithoutVat(d) {
  const t = d?.totals ?? {};
  return Number(t.total || t.before_vat || 0) > 0 && !Number(t.vat || 0);
}

async function askHeader(s) {
  const d = s.doc;
  if (s.noVat === undefined) s.noVat = docWithoutVat(d);
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
    `📦 *קבלת סחורה* — ${docName(d)} ${d.doc_number}`,
    companyLine(s),
    s.via === 'sandbox' ? `   (המסמך מופנה ל${companyMatch(d).matched?.name ?? 'חברה אחרת'} — נקלט לעותק הבדיקה)` : null,
    `🚚 ספק: *${s.supplier.name}* (${s.supplier.code})${s.supplierBy === 'vat' ? ` — לפי ח.פ. ${String(d.supplier_vat).replace(/\D/g, '')}` : s.supplierBy === 'name' ? (d.supplier_vat ? ` — לפי שם: ח.פ. ${String(d.supplier_vat).replace(/\D/g, '')} שבמסמך לא נמצא בכרטיסי הספקים` : ' — לפי שם, אין ח.פ. במסמך') : ''}`,
    d.date ? `📅 ${ymdHe(d.date)}${d.delivery_place ? ` · ${d.delivery_place}` : ''}` : null,
    `💳 תנאי תשלום: *${Priority.payLabel(s.payCode ?? Priority.DEFAULT_PAY)}*${(s.payCode ?? Priority.DEFAULT_PAY) === Priority.DEFAULT_PAY ? ' (ברירת מחדל)' : ''}${dueText(s, s.payCode ?? Priority.DEFAULT_PAY)}`,
    s.noVat ? `🧾 מע"מ: *ללא מע"מ*${s.noVatBy === 'user' ? ' (נבחר)' : ' — במסמך אין מע"מ'}` : null,
    d.warnings?.length ? `⚠️ ${d.warnings.join('\n⚠️ ')}` : null,
    '', `נכון? *כן* להמשך, או *ביטול*. לתנאי תשלום אחר — כתבו אותו ("שוטף 60"). ${s.noVat ? 'יש מע"מ — *עם מע"מ*.' : 'אין מע"מ — *ללא מע"מ*.'}`
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
    s.order = { ordname: order.ORDNAME, project: order.PROJDOCNO, projectDes: order.PROJDES, payCode: order.PAYCODE ?? null, warehouse: order.WARHSNAME ?? null };
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

// ---------------------------------------------------------------------------
// קידוד השורות — מק"ט, תת פרק ומשאב, נלמד מקבלות הסחורה הקודמות
// ---------------------------------------------------------------------------

const partOf = (p, why) => ({ code: p.PARTNAME, des: p.PARTDES ?? p.PDES ?? '', chapter: p.BUD_SUBCHAPTERNAME ?? null, chapterDes: p.BUD_SUBCHAPTERDES ?? '',
  topic: p.BUD_SUBTOPICNAME ?? null, topicDes: p.BUD_SUBTOPICDES ?? '', why });
const generalPart = (g, why = 'מק"ט כללי') => ({ code: '000', des: 'מוצר כללי', chapter: g?.chapter ?? null, chapterDes: g?.chapterDes ?? '', topic: g?.topic ?? null, topicDes: g?.topicDes ?? '', why });

/**
 * היסטוריית הספק בכל החברות — המק"טים משותפים לכל החברות. בחברה הזו לפי קוד הספק, ובשאר
 * לפי ח.פ. (במקביל). כל שורה מסומנת בחברה שלה. מהחברות האחרות — נשמר לשעה.
 */
const historyCache = new Map();
async function historyFor(s) {
  const own = (await Priority.supplierHistory(s.company, s.supplier.code).catch(() => [])).map((l) => ({ ...l, company: s.company }));
  const vat = String(s.doc?.supplier_vat ?? '').replace(/\D/g, '');
  if (vat.length < 7) return own;
  let others = historyCache.get(vat);
  if (!others || Date.now() - others.at > 3600000) {
    const lists = await Promise.all(Priority.COMPANIES.filter((x) => x.vat && x.code !== s.company && !x.test).map(async (c) => {
      try {
        const f = await Priority.findSuppliers(c.code, { vat });
        if (f.by !== 'vat' || !f.list[0]) return [];
        return (await Priority.supplierHistory(c.code, f.list[0].SUPNAME)).map((l) => ({ ...l, company: c.code }));
      } catch { return []; }
    }));
    others = { at: Date.now(), lines: lists.flat() };
    historyCache.set(vat, others);
  }
  return [...own, ...others.lines.filter((l) => l.company !== s.company)];
}

/*
 * אינדקס שורות מכל החברות — לשורה של ספק שאין לו היסטוריה בשום מקום: שורה קודמת עם תיאור
 * דומה (מכל ספק, מכל חברה) מלמדת באיזה מק"ט קולטים אותה. נבנה ברקע (‎warmIndex‎, חברה אחת בכל
 * סבב) ומתרענן כל 12 שעות; החברה הנוכחית נבנית מיד אם חסרה.
 */
const INDEX_TTL = 12 * 60 * 60 * 1000;
const lineIndex = new Map(); // company → { at, lines }
async function indexOf(company) {
  const hit = lineIndex.get(company);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.lines;
  const lines = (await Priority.recentLines(company).catch(() => [])).map((l) => ({ ...l, company }));
  lineIndex.set(company, { at: Date.now(), lines });
  return lines;
}
async function warmIndex() {
  const stale = Priority.COMPANIES.filter((c) => c.vat && !c.test).find((c) => !lineIndex.has(c.code) || Date.now() - lineIndex.get(c.code).at > INDEX_TTL);
  if (stale) await indexOf(stale.code);
}
async function similarLines(company, description) {
  await indexOf(company);
  const words = simWords(description).length;
  if (!words) return [];
  const out = [];
  for (const { lines } of lineIndex.values()) {
    for (const l of lines) {
      const sc = similarity(description, l.PDES);
      // לפחות 2 מילים משותפות, ולפחות חצי מהמילים של השורה
      if (sc >= 2 && sc / words >= 0.5) out.push({ l, sc });
    }
  }
  return out.sort((a, b) => b.sc - a.sc);
}

const simWords = (t) => String(t ?? '').replace(/["'״׳]/g, '').split(/[\s,.\-–/()]+/).filter((w) => w.length >= 2 && !/^\d+([.,]\d+)?$/.test(w));
function similarity(a, b) {
  const B = new Set(simWords(b));
  return simWords(a).filter((w) => B.has(w)).length;
}

/** מק"ט מחברה אחרת — רק אם קיים ופעיל כאן, ובקידוד של החברה הזו */
async function partHere(s, h) {
  if (h.company === s.company) return { ...h, PARTDES: h.PDES };
  const p = await Priority.partByCode(s.company, h.PARTNAME).catch(() => null);
  return p && (p.STATDES ?? 'פעיל') === 'פעיל' ? p : null;
}
const where = (s, company) => (company && company !== s.company ? ` (ב${Priority.companyOf(company).name})` : '');

/**
 * לכל שורה בלי הזמנה — תמיד יש מק"ט, תת פרק ומשאב:
 *   1. פריט שתיאורו זהה בקטלוג;
 *   2. המק"ט שהספק נקלט בו — בכל החברות (החברה הזו קודם), הקרוב ביותר בתיאור או הנפוץ;
 *   3. שורות דומות בתיאור מכל ספק ומכל חברה (אינדקס);
 *   4. ‎000‎ בקידוד שבו הספק נקלט; 5. ‎000‎ בקידוד הכללי של החברה.
 */
async function codeLines(s) {
  const free = s.lines.filter((l) => !l.order);
  for (const l of free) {
    const p = await Priority.findPartExact(s.company, l.description).catch(() => null);
    l.part = p ? partOf(p, 'תיאור זהה בקטלוג') : null;
  }
  const todo = free.filter((l) => !l.part);
  if (!todo.length) return;
  const hist = await historyFor(s);
  // מק"טים שהספק נקלט בהם (לא הכללי) — משקל כפול לחברה הזו
  const learned = new Map();
  const gen = new Map();
  for (const h of hist) {
    const w = h.company === s.company ? 2 : 1;
    if (h.PARTNAME === '000') {
      if (h.BUD_SUBCHAPTERNAME && h.BUD_SUBTOPICNAME && h.company === s.company) {
        const k = `${h.BUD_SUBCHAPTERNAME}|${h.BUD_SUBTOPICNAME}`;
        gen.set(k, { n: (gen.get(k)?.n ?? 0) + 1, h });
      }
      continue;
    }
    const e = learned.get(h.PARTNAME) ?? { n: 0, h, des: [], own: false };
    e.n += w; e.des.push(h.PDES ?? '');
    if (h.company === s.company) { e.own = true; e.h = h; }
    learned.set(h.PARTNAME, e);
  }
  const valid = [];
  for (const e of learned.values()) {
    const p = await partHere(s, e.h);
    if (p) valid.push({ ...e, p });
  }
  valid.sort((a, b) => b.n - a.n);
  const supGen = [...gen.values()].sort((a, b) => b.n - a.n)[0]?.h;
  const general = await Priority.generalCoding(s.company).catch(() => null);
  for (const l of todo) {
    if (valid.length) {
      const best = valid.length === 1 ? valid[0]
        : valid.map((e) => ({ e, sc: Math.max(...e.des.map((d) => similarity(l.description, d)), similarity(l.description, e.p.PARTDES)) }))
          .sort((a, b) => b.sc - a.sc || b.e.n - a.e.n)[0].e;
      l.part = partOf(best.p, `כמו בקליטות קודמות של הספק${best.own ? '' : where(s, best.h.company)}`);
      continue;
    }
    // הספק בלי היסטוריה בשום חברה — שורות דומות מכל ספק ומכל חברה
    let found = null;
    for (const { l: h } of (await similarLines(s.company, l.description)).slice(0, 10)) {
      const p = await partHere(s, h);
      if (p) { found = { p, h }; break; }
    }
    if (found) l.part = partOf(found.p, `לפי שורה דומה בקליטה קודמת${where(s, found.h.company)}: "${String(found.h.PDES).slice(0, 40)}"`);
    else if (supGen) l.part = generalPart({ chapter: supGen.BUD_SUBCHAPTERNAME, chapterDes: supGen.BUD_SUBCHAPTERDES, topic: supGen.BUD_SUBTOPICNAME, topicDes: supGen.BUD_SUBTOPICDES }, 'מק"ט כללי, כמו בקליטות קודמות של הספק');
    else l.part = generalPart(general);
  }
}

const codeText = (p) => `*${p.code} ${p.des}*${p.chapter ? ` · ${p.chapterDes || p.chapter} / ${p.topicDes || p.topic || '—'}` : ''}`;

function askParts(s) {
  s.step = 'parts';
  const free = s.lines.filter((l) => !l.order && l.part);
  if (!free.length) return askProject(s);
  const same = free.every((l) => l.part.code === free[0].part.code && l.part.chapter === free[0].part.chapter && l.part.topic === free[0].part.topic);
  const body = same
    ? [`🏷 ${free.length > 1 ? `כל ${free.length} השורות` : 'השורה'} ← ${codeText(free[0].part)}`, `   (${free[0].part.why})`]
    : free.map((l) => `*${l.n}.* ${l.description}\n   ← ${codeText(l.part)} (${l.part.why})`);
  return reply(s, ['🏷 *מק"ט, תת פרק ומשאב*', ...body, '',
    '*כן* — להמשיך. לשנות: מק"ט ("A120-035-010"), "שורה 2 A120-035-010", מילה מהתיאור ("העתקות"), או *כללי*.'].join('\n'));
}

async function afterLines(s) {
  await codeLines(s);
  return askParts(s);
}

/**
 * קליטה לעותק הבדיקה, ופרויקט שלא נמצא בו — אולי הוא קיים בחברה האמיתית (test11 הוא עותק
 * מיוני, עם 5 פרויקטים בלבד). אז אומרים זאת במפורש, במקום שה-AI ינחש מתוך רשימת הבדיקה.
 */
async function sandboxNote(s, text, testList) {
  // רק טקסט עם מילה — מספר לבד ("2") אינו שם פרויקט
  if (s.via !== 'sandbox' || !/[\u0590-\u05FFA-Za-z]{2}/.test(String(text ?? ''))) return null;
  const real = companyMatch(s.doc).matched;
  if (!real?.code) return null;
  let hits = [];
  try {
    const list = await projectsOf(real.code);
    hits = Priority.matchProjects(list, text, { all: true });
    if (!hits.length) { const any = Priority.matchProjects(list, text); hits = any.length ? any.filter((p) => p.score === any[0].score) : []; }
  } catch (err) {
    console.error('[משימון] בדיקת פרויקט בחברה האמיתית:', err.message);
    return null;
  }
  if (!hits.length) return null;
  s.projectOptions = testList.slice(0, 9);
  return [`📌 ${hits.slice(0, 3).map((p) => `*${p.des}* (${p.code})`).join(', ')} — קיים ב${real.name} (${real.code}),`,
    `אבל הקליטה הזו היא ל*עותק הבדיקה ${s.company}*, שיש בו רק ${testList.length} פרויקטים. ${real.name} עוד לא פתוחה לקליטה מהבוט.`,
    '', `פרויקטים ב-${s.company}:`, ...s.projectOptions.map((p, i) => `*${i + 1}.* ${p.des} (${p.code})`), '', 'בחרו מספר, או *ביטול*.'].join('\n');
}

async function askProject(s) {
  if (s.project) return chooseWarehouse(s);
  const all = await projectsOf(s.company);
  // פרויקט אחד בחברה — הוא ברירת המחדל, בלי לשאול
  if (all.length === 1) {
    s.project = all[0];
    return chooseWarehouse(s, `📁 פרויקט: *${all[0].des}* (${all[0].code}) — הפרויקט היחיד בחברה`);
  }
  // רמז מהמסמך — עיר, אתר, מגרש: כל הפרויקטים המתאימים ביותר (גם לפי הכינויים), ואם לא — ה-AI
  const hint = [s.doc.project_hint, s.doc.delivery_place].filter(Boolean).join(' · ');
  s.step = 'project';
  if (!Priority.matchProjects(all, hint).length) {
    const note = await sandboxNote(s, hint, all);
    if (note) return reply(s, note);
  }
  s.projectOptions = (await findProjects(all, hint, { strict: false })).list.slice(0, 9);
  // אין הצעה מהמסמך, ובחברה עד 9 פרויקטים — מציגים את כולם (ומחכים לבחירה)
  if (!s.projectOptions.length && all.length <= 9) s.projectOptions = all;
  return reply(s, [`📁 לאיזה פרויקט לשייך?${hint ? ` (במסמך: ${hint})` : ''}`,
    ...s.projectOptions.map((p, i) => `*${i + 1}.* ${p.des} (${p.code})`),
    s.projectOptions.length ? '' : `לא מצאתי לפי המסמך פרויקט מתאים מתוך ${all.length} הפרויקטים של החברה.`,
    'כתבו מספר מהרשימה, או במילים שלכם ("אלעד 49", "207", "חיפה עין הים") או קוד (PR…).'].join('\n'));
}

/**
 * המחסן: מההזמנה, כשיש (ורק אם קיים במסך המחסנים); המחסנים של הפרויקט — ממסך המחסנים, ואם אין
 * שם שיוך, מהקבלות הקודמות — אחד הוא ברירת המחדל, כמה — שואלים עם השמות; אף אחד — מחסן הפרויקט
 * אם קיים, אחרת מחסן ברירת המחדל של החברה (‎warehouseOf‎).
 */
async function chooseWarehouse(s, note = '') {
  const go = async (extra) => {
    // שאר המחסנים בחברה — לשינוי במספר, בשלב הנספחים
    const others = ((await Priority.warehouses(s.company).catch(() => null)) ?? []).filter((w) => w.code !== s.warehouse).slice(0, 8);
    s.warehouseChoices = others.map((w) => ({ code: w.code, name: w.name }));
    const change = extra && others.length ? `   לשנות מחסן — כתבו מספר: ${others.map((w, i) => `*${i + 1}.* ${w.name || w.code}`).join(' · ')}` : '';
    const r = askFiles(s);
    const pre = [note, extra, change].filter(Boolean).join('\n');
    return pre ? { ...r, replies: [`${pre}\n\n${r.replies[0]}`] } : r;
  };
  if (s.warehouse) return go('');
  if (s.order?.warehouse && await Priority.warehouseExists(s.company, s.order.warehouse).catch(() => true)) {
    s.warehouse = s.order.warehouse;
    return go(`🏬 מחסן: ${s.warehouse} — מההזמנה`);
  }
  const opts = await Priority.projectWarehouses(s.company, s.project?.code).catch(() => []);
  if (opts.length === 1) { s.warehouse = opts[0].code; return go(`🏬 מחסן: *${opts[0].name || opts[0].code}* (${opts[0].code})`); }
  if (opts.length > 1) {
    s.step = 'warehouse';
    s.warehouseOptions = opts.slice(0, 9);
    return reply(s, [note || null, `🏬 לאיזה מחסן לשייך? לפרויקט ${s.project.des} יש כמה מחסנים:`,
      ...s.warehouseOptions.map((w, i) => `*${i + 1}.* ${w.name || w.code} (${w.code})${w.n ? ` — ${w.n} קבלות` : ''}`), '', 'כתבו מספר מהרשימה.'].filter((x) => x !== null).join('\n'));
  }
  s.warehouse = await Priority.warehouseOf(s.company, s.project?.code);
  const name = ((await Priority.warehouses(s.company).catch(() => null)) ?? []).find((w) => w.code === s.warehouse)?.name;
  return go(`🏬 מחסן: *${name || s.warehouse}* (${s.warehouse})`);
}

function askFiles(s) {
  s.step = 'files';
  return reply(s, ['📎 *נספחים* — יש עוד מסמכים לצרף (תעודה נוספת, תמונה של הסחורה)? שלחו אותם עכשיו, אחד אחרי השני.',
    'כשסיימתם — *סיום*. אין — *אין*.'].join('\n'));
}

async function createDraft(user, s) {
  const c = s.company;
  // המחסן — נבדק מול מסך המחסנים לפני הקליטה; פריוריטי בכל זאת דוחה אותו — Main
  if (!s.warehouse || !(await Priority.warehouseExists(c, s.warehouse).catch(() => true))) s.warehouse = await Priority.warehouseOf(c, s.project?.code);
  const head = { supname: s.supplier.code, booknum: s.doc.doc_number, date: s.doc.date || null, project: s.project?.code, warehouse: s.warehouse, payCode: s.payCode ?? Priority.DEFAULT_PAY };
  let docno;
  try {
    docno = await Priority.createReceipt(c, head);
  } catch (err) {
    // פריוריטי דחה את הכותרת — מנסים מחסנים אחרים של החברה (של הפרויקט, ברירת המחדל, השאר)
    const first = s.warehouse;
    const alt = [...new Set([
      ...(await Priority.projectWarehouses(c, s.project?.code).catch(() => [])).map((w) => w.code),
      await Priority.defaultWarehouse(c).catch(() => 'Main'),
      ...((await Priority.warehouses(c).catch(() => null)) ?? []).map((w) => w.code)
    ])].filter((w) => w && w !== first).slice(0, 3);
    for (const w of alt) {
      try {
        docno = await Priority.createReceipt(c, { ...head, warehouse: w });
        console.error(`[משימון] קבלת סחורה: מחסן ${first} נדחה (${err.message}), נקלט ל-${w}`);
        s.warehouseNote = `מחסן ${first} נדחה בפריוריטי, נקלט ל-${w}`;
        s.warehouse = w;
        break;
      } catch { /* הבא */ }
    }
    if (!docno) return { failed: err, tried: [first, ...alt] };
  }
  s.docno = docno;
  save(user.id, s);
  const problems = [];
  if (s.noVat) {
    await Priority.setHeader(c, docno, { TAXCODE: Priority.NO_VAT_CODE })
      .catch((err) => problems.push({ what: 'הקבלה נקלטה עם מע"מ — שנו בפריוריטי ל"ללא מע"מ"', err: `קוד מס ${Priority.NO_VAT_CODE}: ${err.message}` }));
  }
  for (const l of s.lines.filter((x) => x.qty > 0)) {
    try {
      if (l.order) await Priority.addOrderLine(c, docno, { ordname: l.order.ordname, line: l.order.line, qty: l.qty });
      else if (l.part && l.part.code !== '000') {
        try {
          await Priority.addFreeLine(c, docno, { part: l.part.code, qty: l.qty, price: l.price, discount: l.discount, chapter: l.part.chapter, topic: l.part.topic });
        } catch (err) {
          if (!/שלם/.test(err.message) || Number.isInteger(Number(l.qty))) throw err;
          // היחידה של הפריט מקבלת רק כמות שלמה — כמות 1 בסכום השורה
          const net = Math.round(Number(l.qty) * Number(l.price) * (1 - (Number(l.discount) || 0) / 100) * 100) / 100;
          await Priority.addFreeLine(c, docno, { part: l.part.code, qty: 1, price: net, discount: 0, chapter: l.part.chapter, topic: l.part.topic });
        }
      } else {
        const chap = l.part?.chapter ?? s.chapter?.chapter;
        const topic = l.part?.topic ?? s.chapter?.topic;
        // הפריט הכללי נמדד ב"יח'" ומקבל רק כמות שלמה. כמות שבורה (2.3 מ"א) — כמות 1 בסכום השורה
        // אחרי ההנחה, והכמות והיחידה המקוריות בתחילת התיאור (נחתך אחרי 48 תווים). כך הסכום נשאר מדויק
        const whole = Number.isInteger(Number(l.qty));
        const net = Math.round(Number(l.qty) * Number(l.price) * (1 - (Number(l.discount) || 0) / 100) * 100) / 100;
        await Priority.addFreeLine(c, docno, whole
          ? { part: '000', description: l.description, qty: l.qty, price: l.price, discount: l.discount, chapter: chap, topic }
          : { part: '000', description: `${qtyText(l.qty)} ${l.unit ?? ''} · ${l.description}`.replace(/\s+·/, ' ·'), qty: 1, price: net, discount: 0, chapter: chap, topic });
      }
    } catch (err) {
      problems.push({ what: `שורה ${l.n} (${l.description}) לא נקלטה`, err: `שורה ${l.n}: ${err.message}` });
    }
  }
  // הנחת מסמך — רק הנחה של ממש (לא עיגול של אגורות, ולא "הנחה" שלילית)
  if (!s.order && s.doc.totals?.doc_discount_pct >= 0.1) {
    await Priority.setHeader(c, docno, { PERCENT: s.doc.totals.doc_discount_pct }).catch((err) => problems.push({ what: 'הנחת המסמך לא נקלטה', err: `הנחת מסמך: ${err.message}` }));
  }
  // פרטים (‎DETAILS‎, עד 24 תווים) — שם המקבל ומספר התעודה; מוצג ברשימת התעודות בחשבונית הספק
  await Priority.setHeader(c, docno, { DETAILS: receiverDetails(user, s.doc.doc_number) }).catch(() => {});
  for (const f of s.files) {
    try {
      await Priority.attach(c, docno, { buf: fs.readFileSync(f.path), mime: f.mime, description: f.label === 'מסמך ראשי' ? `${docName(s.doc)} ${s.doc.doc_number}`.slice(0, 32) : f.label });   // התיאור בפריוריטי נחתך אחרי ~32 תווים
    } catch (err) {
      problems.push({ what: `${f.label === 'מסמך ראשי' ? 'צילום המסמך' : f.label} לא צורף לנספחים`, err: `נספח ${f.label}: ${err.message}` });
    }
  }
  // דו-שיח פנימי שנכשל — לא משהו שהעובד יכול לתקן; רק למנהל
  await writeDialog(user, s).catch((err) => problems.push({ what: null, err: `דו-שיח פנימי: ${err.message}` }));
  return problems;
}

/** "ישראל כהן 643340" — השם מתקצר כך שהמספר תמיד נכנס ב-24 התווים */
function receiverDetails(user, number) {
  const num = String(number ?? '').slice(0, 20);
  const name = String(user?.full_name || user?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return num;
  return `${name.slice(0, Math.max(0, 23 - num.length)).trim()} ${num}`.trim();
}

function writeDialog(user, s) {
  const d = s.doc;
  const short = s.lines.filter((l) => l.order && l.qty < l.order.balance).map((l) => `${l.description}: התקבלו ${qtyText(l.qty)} מתוך יתרה ${qtyText(l.order.balance)}`);
  return Priority.setDialog(s.company, s.docno, [
    'קבלת סחורה דרך בוט משימון',
    `התקבל ע"י: ${user.full_name} | ${nowHe()}`,
    `מסמך מקור: ${docName(d)} ${d.doc_number} של ${s.supplier.name}, מצורף בנספחים`,
    d.supplier_order_ref ? `הזמנה אצל הספק: ${d.supplier_order_ref}` : null,
    d.detail ? `פירוט השורות: מתוך ${d.detail.doc_type === 'invoice' ? 'חשבונית' : 'חשבון לתשלום'} ${d.detail.doc_number}` : null,
    d.date || d.delivery_place ? `אספקה: ${[ymdHe(d.date), d.delivery_place].filter(Boolean).join(', ')}` : null,
    d.purchase_type !== 'unknown' ? `סוג רכש: ${d.purchase_type === 'site' ? 'אתרי' : 'משרדי'}` : null,
    s.noVat ? `מע"מ: ללא מע"מ (קוד ${Priority.NO_VAT_CODE})${s.noVatBy === 'user' ? ' — נבחר ע"י המקבל' : ' — במסמך אין מע"מ'}` : null,
    `תנאי תשלום: ${Priority.payLabel(s.payCode ?? Priority.DEFAULT_PAY)}${(s.payCode ?? Priority.DEFAULT_PAY) === Priority.DEFAULT_PAY ? ' (ברירת מחדל)' : ' (נבחר ע"י המקבל)'}${dueText(s, s.payCode ?? Priority.DEFAULT_PAY)}`,
    ...(s.corrections ?? []).map((c) => `תיקון המקבל: ${c}`),
    ...short.map((x) => `קבלה חלקית — ${x}. היתרה נשארת פתוחה`),
    !s.order && s.project ? `פרויקט נבחר ע"י המקבל: ${s.project.code} ${s.project.des}` : null,
    s.chapter ? `תת פרק לפריט כללי: ${s.chapter.chapter} ${s.chapter.topic}` : null,
    s.warehouseNote ?? null,
    ...[...new Set(s.lines.filter((l) => !l.order && l.part).map((l) => `קידוד: ${l.part.code} ${l.part.chapter ?? ''}/${l.part.topic ?? ''} — ${l.part.why}`))]
  ]);
}

/**
 * פותח את הטיוטא ומציג אותה. פריוריטי דחה את הכותרת גם עם מחסנים אחרים — לא "משהו השתבש":
 * שואלים לאיזה מחסן לשייך (הפירוט הטכני — למנהלים). נכשל שוב — הקבלה נשמרת, ומנסים מאוחר יותר.
 */
async function draftAndShow(user, s) {
  const r = await createDraft(user, s);
  if (!r?.failed) return showDraft(s, r, user);
  alertAdmins(user, s, 'הטיוטא לא נפתחה בפריוריטי', [`מחסנים שנוסו: ${r.tried.join(', ')}`, r.failed.message]);
  if (s.warehouseRetry) {
    s.warehouseRetry = false;
    s.step = 'files';
    return reply(s, 'לא הצלחתי לפתוח את הקבלה בפריוריטי גם עם המחסן הזה. מנהל המערכת קיבל פירוט. הכל שמור — כתבו *סיום* כדי לנסות שוב מאוחר יותר, או *ביטול*.', { status: 'error', result: `טיוטא לא נפתחה: ${r.failed.message}` });
  }
  const all = (await Priority.warehouses(s.company).catch(() => null)) ?? [];
  if (!all.length) throw r.failed;
  s.step = 'warehouse';
  s.warehouseRetry = true;
  s.warehouse = null;
  s.warehouseOptions = all.slice(0, 9).map((w) => ({ code: w.code, name: w.name, n: 0 }));
  return reply(s, ['🏬 לאיזה מחסן לשייך את הקבלה? המחסנים בחברה:',
    ...s.warehouseOptions.map((w, i) => `*${i + 1}.* ${w.name || w.code} (${w.code})`), '', 'כתבו מספר מהרשימה.'].join('\n'), { result: `מחסן נדחה: ${r.failed.message}` });
}

async function showDraft(s, problems = [], user = null) {
  const gr = await Priority.readReceipt(s.company, s.docno);
  s.step = 'review';
  s.reviewLines = gr.lines.map((l, i) => ({ n: i + 1, kline: l.KLINE, description: l.PDES, qty: l.TQUANT }));
  const shown = problems.filter((p) => p.what).map((p) => p.what);
  const warn = shown.length ? `⚠️ ${shown.join('. ')}. בדקו את הטיוטא לפני "מאשר". מנהל המערכת קיבל פירוט.\n\n` : '';
  if (problems.length) alertAdmins(user, s, 'חלק מהטיוטא לא נקלט', problems.map((p) => p.err));
  // ה-PDF לבדיקה — מהשדות כפי שנשמרו, כולל הדו-שיח הפנימי
  const files = [];
  try {
    const dialog = await Priority.readDialog(s.company, s.docno).catch(() => []);
    const c = Priority.companyOf(s.company);
    const buf = receiptPdf(gr, { companyLabel: `${c.name.replace(/ — .*/, '')} (${s.company})`, test: Priority.isTest(s.company), order: s.order?.ordname ?? '', dialog, docTotal: s.doc?.totals?.total || null, due: Priority.dueDate(gr.MED_MXPAYCODE, s.doc?.doc_date || s.doc?.date) });
    files.push({ buf, fileName: `${gr.DOCNO}-טיוטא.pdf`, mime: 'application/pdf', caption: `📄 ${gr.DOCNO} — טיוטא לבדיקה` });
  } catch (err) {
    console.error('[משימון] PDF של קבלת סחורה:', err.message);
  }
  return reply(s, warn + summaryText(s, gr), { files, ...(problems.length ? { status: 'error', result: `טיוטא ${s.docno}; תקלות: ${problems.map((p) => p.err).join(' | ')}` } : {}) });
}

// ---------------------------------------------------------------------------
// קובץ נוסף בשלב הנספחים או בבדיקת הטיוטא: נספח, או מסמך חדש?
// ---------------------------------------------------------------------------

const ATTACH_WORD = /נספח|לצרף|תצרף|צרף/;
const NEW_WORD = /^\s*2\s*$|חדש|קבלת\s*סחורה|מסמך אחר|הבא/;

/**
 * "נספח" בכיתוב — נספח. "קבלת סחורה" — מסמך חדש. בלי כיתוב — ה-AI מסווג: תמונה של
 * הסחורה, דף נוסף או תעודה של אותה הזמנה — נספח, בלי שאלה; מסמך עם מספר אחר או ספק אחר —
 * שואלים. גם כשהסיווג נכשל — שואלים, לא מחליטים לבד.
 */
async function routeFile(user, s, file, t) {
  const saved = await saveFile(user.id, file, `נספח ${s.files.length}`);
  if (ATTACH_WORD.test(t)) return attachNow(user, s, saved);
  if (isTrigger(t)) return queueNew(user, s, saved, null);
  let cls = null;
  try {
    cls = await ai.classify({ doc_type: s.doc.doc_type, doc_number: s.doc.doc_number, supplier_name: s.supplier?.name ?? s.doc.supplier_name,
      po_number: s.order?.ordname ?? s.doc.po_number, supplier_order_ref: s.doc.supplier_order_ref, date: s.doc.date,
      // מספרים שהמסמך מפנה אליהם (שורה "ח-ן לתשלום 2011796") — מסמך עם מספר כזה הוא נספח
      lines: (s.doc.lines ?? []).map((l) => l.description).slice(0, 20), warnings: s.doc.warnings ?? [] }, saved);
  } catch (err) {
    console.error('[משימון] סיווג נספח:', err.message);
  }
  if (cls?.kind === 'attachment' || (cls && isDetailRef(s, cls))) {
    const r = await maybeAdoptDetail(user, s, saved, cls);
    return r ?? attachNow(user, s, saved);
  }
  s.pendingNew = { file: saved, label: cls?.doc_number ? `${docName(cls)} ${cls.doc_number}${cls.supplier_name ? ` של ${cls.supplier_name}` : ''}` : '' };
  const cur = s.docno ? `ל-${s.docno}` : 'לקבלת הסחורה הנוכחית';
  // לא ‎reply()‎: השאלה הזו אינה "השאלה של השלב", ואחרי התשובה חוזרים לזו שחיכתה
  return { s, replies: [[cls ? `📄 זה נראה כמו מסמך חדש${s.pendingNew.label ? `: ${s.pendingNew.label}` : ''}.` : '📄 קיבלתי מסמך נוסף.',
    `*1* — לצרף כנספח ${cur} · *2* — קבלת סחורה חדשה${!s.docno && s.step !== 'files' ? ' (הנוכחית תבוטל)' : ''}`].join('\n')] };
}

/** המסמך שהגיע הוא החשבון שהחשבונית מפנה אליו? (לפני שנוצרה טיוטא) */
const isDetailRef = (s, cls) => !s.docno && !s.doc?.detail && cls?.doc_number && (s.doc?.lines ?? []).length <= 2
  && refsOf(s.doc).replace(/\s/g, '').includes(String(cls.doc_number).replace(/\s/g, ''));

/**
 * החשבון לתשלום הגיע אחרי החשבונית: קוראים אותו, לוקחים ממנו את השורות, וחוזרים להשוואה
 * (או ממשיכים בכותרת, אם עוד לא הגענו לשורות). ‎null‎ — לא פירוט; יצורף כנספח רגיל.
 */
async function maybeAdoptDetail(user, s, saved, cls) {
  if (!isDetailRef(s, cls)) return null;
  let d;
  try { d = await ai.extract(saved); } catch { return null; }
  if (!isDetailOf(s.doc, d)) return null;
  s.files.push({ ...saved, label: `${d.doc_type === 'invoice' ? 'חשבונית' : 'חשבון'} ${d.doc_number}` });
  s.doc = withDetail(s.doc, d);
  s.lines = linesOf(s.doc);
  const note = `📋 הפירוט נלקח מ${d.doc_type === 'invoice' ? 'חשבונית' : 'חשבון לתשלום'} ${d.doc_number} (${s.lines.length} שורות). הסכום לפני מע"מ ייבדק מול החשבונית.`;
  if (['company', 'supplier', 'header'].includes(s.step)) return { s, replies: [`${note}${s.lastPrompt ? `\n\n${s.lastPrompt}` : ''}`] };
  // כבר עברנו את השורות — מחשבים שוב את ההתאמה להזמנה ומציגים את השורות החדשות
  s.order = null; s.ordersChecked = false; s.chapter = null; s.warehouse = null;
  const out = await resolveOrder(s);
  return { ...out, replies: [note, ...out.replies] };
}

/** תשובה לשאלה "נספח או חדש?" — ‎null‎ אם התשובה אינה אחת מהשתיים */
async function answerPendingNew(user, s, t) {
  const f = s.pendingNew.file;
  if (/^\s*1\s*$/.test(t) || ATTACH_WORD.test(t)) { s.pendingNew = null; return attachNow(user, s, f); }
  if (NEW_WORD.test(t)) { s.pendingNew = null; return queueNew(user, s, f, null); }
  return { s, replies: [`*1* — לצרף כנספח${s.docno ? ` ל-${s.docno}` : ''} · *2* — קבלת סחורה חדשה`] };
}

async function attachNow(user, s, f) {
  s.files.push(f);
  if (s.step === 'files') return reply(s, `📎 נספח ${s.files.length - 1} התקבל. עוד? או *סיום*.`);
  if (!s.docno) {
    // לפני הטיוטא — נשמר, ויצורף כשהטיוטא תיווצר. חוזרים לשאלה שחיכתה לתשובה
    return { s, replies: [`📎 נשמר כנספח (${s.files.length - 1}), ויצורף לקבלת הסחורה.${s.lastPrompt ? `\n\n${s.lastPrompt}` : ''}`] };
  }
  const problems = [];
  await Priority.attach(s.company, s.docno, { buf: fs.readFileSync(f.path), mime: f.mime, description: f.label })
    .catch((err) => problems.push({ what: 'הנספח לא צורף', err: `נספח: ${err.message}` }));
  return showDraft(s, problems, user);
}

/**
 * מסמך חדש בזמן שהנוכחית פתוחה: הוא ממתין בתור, והנוכחית נסגרת קודם — בנספחים: נקלטת
 * כטיוטא לבדיקה; בבדיקת הטיוטא: "מאשר" או "ביטול". אחר כך הבוט עובר אליו לבד.
 */
const queueOf = (s) => (Array.isArray(s?.queued) ? s.queued : s?.queued ? [s.queued] : []);

async function queueNew(user, s, f) {
  s.queued = [...queueOf(s), f];
  if (!s.docno && s.step !== 'files') {
    // עוד אין טיוטא: העובד בחר "קבלת סחורה חדשה" — הנוכחית מתבטלת, ועוברים לחדש
    const was = s.doc?.doc_number ? ` (${docName(s.doc, true)} ${s.doc.doc_number})` : '';
    const r = await cancel(user, s);
    return startQueued(user, s, [r.replies[0].replace('קבלת הסחורה בוטלה.', `קבלת הסחורה הקודמת${was} בוטלה.`)]);
  }
  const note = '📄 המסמך החדש שמור, ואעבור אליו מיד אחרי שנסיים את הנוכחית.';
  if (s.step === 'files') {
    const out = await draftAndShow(user, s);
    return { ...out, replies: [note, ...out.replies] };
  }
  return reply(s, [note, `*${s.docno}* עדיין טיוטא: *מאשר* — להפוך לסופי, או *ביטול* — לבטל אותה.`].join('\n'));
}

/** סיום הנוכחית — ומעבר למסמך שבתור, בלי לשלוח אותו שוב */
async function startQueued(user, oldS, before = []) {
  const [q, ...rest] = queueOf(oldS);
  const keep = new Set(queueOf(oldS).map((f) => f.path));
  for (const f of oldS.files ?? []) { if (!keep.has(f.path)) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } } }
  const ns = { step: 'doc', startedAt: Date.now(), ...(rest.length ? { queued: rest } : {}) };
  const out = await onMainDoc(user, ns, q);
  const left = rest.length ? ` (עוד ${rest.length} בתור)` : '';
  return { ...out, s: out.s === null ? null : (out.s ?? ns), replies: [...before, `↪️ עובר למסמך הבא…${left}`, ...out.replies] };
}

/**
 * כמה צילומים ביחד: קוראים את כולם ומחליטים —
 *   • ראשי: הראשון שהוא תעודת משלוח או חשבונית עם שורות;
 *   • נספחים: מה שאינו כזה (חשבון לתשלום, טופס הזמנה, תמונה), ומסמך שמספרו מופיע בראשי
 *     או ההפך, או אותו מספר (דף נוסף);
 *   • קבלות נפרדות: תעודה או חשבונית אחרת — בתור, אחת אחרי השנייה.
 */
async function sortBatch(user, s) {
  const files = s.files.slice(0, 6);
  const read = await Promise.all(files.map((f) => ai.extract(f).then((doc) => ({ f, doc })).catch(() => ({ f, doc: null }))));
  const isMain = (d) => d && ['invoice', 'delivery_note', 'payment'].includes(d.doc_type) && ((d.lines ?? []).length > 0 || d.doc_type === 'payment');
  // המסמך הראשי: מסמך עם מספר (חשבונית, תעודה, שובר) — לא דף תמונות או רשימה בלי מספר
  const main = read.find((x) => isMain(x.doc) && x.doc.doc_number) ?? read.find((x) => x.doc?.doc_number && x.doc.doc_type !== 'other' && x.doc.supplier_name)
    ?? read.find((x) => isMain(x.doc));
  if (!main) return onMainDoc(user, s, files[0], read[0].doc ?? undefined);
  const textOf = (d) => [d.doc_number, d.po_number, d.supplier_order_ref, ...(d.lines ?? []).map((l) => `${l.description} ${l.supplier_code}`)].join(' ');
  const mainText = textOf(main.doc);
  const related = (d) => {
    if (!d?.doc_number) return true;
    const n = String(d.doc_number).replace(/\s/g, '');
    return n === String(main.doc.doc_number).replace(/\s/g, '') || mainText.includes(n) || textOf(d).includes(String(main.doc.doc_number));
  };
  const attach = [], separate = [];
  for (const x of read) {
    if (x === main) continue;
    if (isMain(x.doc) && !related(x.doc)) separate.push(x); else attach.push(x);
  }
  const name = (d) => (d?.doc_number ? `${docName(d, true)} ${d.doc_number}` : 'תמונה');
  const detail = attach.find((x) => isDetailOf(main.doc, x.doc));
  const out = await onMainDoc(user, s, main.f, detail ? withDetail(main.doc, detail.doc) : main.doc);
  const target = out.s ?? s;
  if (out.s !== null) {
    attach.forEach((x, i) => target.files.push({ ...x.f, label: `נספח ${i + 1}` }));
    if (separate.length) target.queued = [...queueOf(target), ...separate.map((x) => x.f)];
  }
  const summary = [`📎 ${files.length} צילומים — הראשי: ${name(main.doc)}`,
    attach.length ? `נספחים: ${attach.map((x) => name(x.doc)).join(', ')}` : null,
    separate.length ? `קבלות נפרדות (אחרי זו): ${separate.map((x) => name(x.doc)).join(', ')}` : null].filter(Boolean).join(' · ');
  return { ...out, replies: [summary, ...out.replies] };
}

// ---------------------------------------------------------------------------
// טיוטות שלא אושרו — תזכורת אחרי 4 שעות, ביטול אחרי 24
// ---------------------------------------------------------------------------

const REMIND_AFTER = 4 * 60 * 60 * 1000;
let lastSweep = 0;

/**
 * נקרא מסבב הבוט. ‎send(userId, text)‎ — הודעה יזומה לעובד (בשעות הפעילות, או בתור).
 * הזמן נמדד מההודעה האחרונה של העובד בקליטה (‎at‎), ולכן שמירת "נשלחה תזכורת" לא מאפסת אותו.
 */
async function sweep(send, { force = false } = {}) {
  if (!force && Date.now() - lastSweep < 10 * 60 * 1000) return;
  lastSweep = Date.now();
  // אינדקס השורות לקידוד — חברה אחת בכל סבב, ברקע
  await warmIndex().catch((err) => console.error('[משימון] אינדקס שורות:', err.message));
  for (const row of D.all("SELECT key, value FROM settings WHERE key LIKE 'goods_receipt:%'")) {
    const userId = Number(row.key.split(':')[1]);
    let s;
    try { s = JSON.parse(row.value); } catch { continue; }
    if (!s?.step) continue;
    const age = Date.now() - (s.at ?? 0);
    const user = D.get('SELECT id, full_name FROM users WHERE id = ?', userId) ?? { id: userId, full_name: '' };
    try {
      if (age >= TTL) {
        if (s.docno) {
          let ok = true;
          await Priority.cancelReceipt(s.company, s.docno).catch((err) => { ok = false; alertAdmins(user, s, 'טיוטא נטושה לא בוטלה', [err.message]); });
          if (ok) {
            send(userId, `⏱ *${s.docno}* (${s.supplier?.name ?? ''}) חיכתה לאישור יותר מ-24 שעות, ובוטלה. אם הסחורה התקבלה — שלחו את המסמך שוב.`);
            alertAdmins(user, s, 'טיוטא נטושה בוטלה', ['חיכתה לאישור יותר מ-24 שעות.']);
          }
        }
        clear(userId, s);
      } else if (s.docno && s.step === 'review' && !s.reminded && age >= REMIND_AFTER) {
        send(userId, `⏳ *${s.docno}* (${s.supplier?.name ?? ''}) מחכה לאישור שלך. *מאשר* — להפוך לסופי, או *ביטול*. בלי תשובה — תבוטל מחר.`);
        D.setSetting(row.key, { ...s, reminded: true });   // בלי לגעת ב-at
      }
    } catch (err) {
      console.error('[משימון] ניקוי קבלות סחורה:', err.message);
    }
  }
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
      note = ` ⚠️ הטיוטא ${s.docno} לא בוטלה בפריוריטי. מנהל המערכת קיבל הודעה ויטפל.`;
      alertAdmins(user, s, 'טיוטא לא בוטלה', [`הטיוטא נשארה בפריוריטי; שורות מהזמנה תופסות יתרה עד שתבוטל.`, err.message]);
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

  // תמונה או מסמך בלי "קבלת סחורה" — כנראה מסמך לקליטה. שואלים, ושומרים את הקובץ עד התשובה
  if (!s && file && !isTrigger(t)) {
    const saved = await saveFile(user.id, file, 'מסמך ראשי');
    save(user.id, { step: 'offer', startedAt: Date.now(), files: [saved] });
    return { replies: ['📦 לקלוט את המסמך כ*קבלת סחורה* בפריוריטי?\n*כן* — להמשיך, *לא* — לא לקלוט.'], status: 'ok', result: 'הצעה: קבלת סחורה מתמונה' };
  }

  // התחלה חדשה: "קבלת סחורה" עם קובץ באמצע קליטה, או קובץ חדש באמצע קליטה שעוד אין לה טיוטא
  // (העובד שלח מסמך אחר במקום לענות) — מתחילים מחדש, ואומרים שהקודמת בוטלה.
  // בנספחים ובבדיקת הטיוטא — הבוט בודק אם זה נספח או מסמך חדש (‎routeFile‎), ולא מבטל טיוטא בשקט.
  let restarted = '';
  // מתחילים מחדש רק כשנכתב "קבלת סחורה" עם הקובץ; קובץ בלי זה באמצע קליטה — נספח או מסמך חדש? (‎routeFile‎)
  const OWN_FILE_STEPS = ['files', 'review', 'offer', 'doc'];
  if (!s || (file && isTrigger(t) && !OWN_FILE_STEPS.includes(s.step))) {
    if (s) {
      const was = s.doc?.doc_number ? `${docName(s.doc, true)} ${s.doc.doc_number}` : '';
      const r = await cancel(user, s, 'הקודמת בוטלה');
      restarted = `↩️ ${r.replies[0].replace('קבלת הסחורה הקודמת בוטלה.', `קבלת הסחורה הקודמת${was ? ` (${was})` : ''} בוטלה.`)} מתחיל עם המסמך החדש.`;
    }
    s = { step: 'doc', startedAt: Date.now() };
    if (!file) {
      save(user.id, s);
      return { replies: ['📦 *קבלת סחורה* — שלחו צילום של תעודת המשלוח או החשבונית (המסמך הראשי, שממנו נקראים הנתונים).'], status: 'ok', result: 'התחלה' };
    }
  }

  if (CANCEL.test(t) && !file) {
    if (!queueOf(s).length) return cancel(user, s);
    // ביטול של הנוכחית, ומעבר למסמך שחיכה בתור
    const r = await cancel(user, s);
    const next = await startQueued(user, s, r.replies);
    if (next.s) save(user.id, next.s);
    return { replies: next.replies, files: next.files ?? [], status: next.status ?? 'ok', result: next.result ?? 'ביטול ומעבר למסמך הבא' };
  }

  let out;
  try {
    // קובץ באמצע הקליטה, לפני שלב הנספחים: נספח (נשמר, וחוזרים לשאלה), או מסמך חדש (שואלים)
    const early = !OWN_FILE_STEPS.includes(s.step);
    if (early && s.pendingNew && !file) out = await answerPendingNew(user, s, t);
    if (!out && early && file) out = await routeFile(user, s, file, t);
    if (!out) out = await step(user, s, t, file);
  } catch (err) {
    console.error('[משימון] קבלת סחורה:', err.message);
    save(user.id, s);
    alertAdmins(user, s, 'תקלה מול פריוריטי', [`שלב: ${s.step}`, err.message]);
    return { replies: ['משהו השתבש מול פריוריטי. נסו שוב בעוד דקה, או *ביטול*.'], status: 'error', result: `שלב ${s.step}: ${err.message}` };
  }
  if (out.s === null) clear(user.id, s);
  else save(user.id, out.s ?? s);
  return { replies: restarted ? [restarted, ...out.replies] : out.replies, files: out.files ?? [], status: out.status ?? 'ok', result: out.result ?? `שלב ${(out.s ?? s)?.step ?? 'סיום'}`, docno: s.docno ?? null };
}

async function step(user, s, t, file) {
  switch (s.step) {
    case 'doc':
      if (!file) return reply(s, 'מחכה לצילום של תעודת המשלוח או החשבונית. או *ביטול*.');
      return onMainDoc(user, s, file);

    case 'doctype': {
      if (YES.test(t)) return afterDocType(s);
      if (/^(לא|אל|ממש לא|no)([\s,.!]|$)/i.test(t)) return { s: null, replies: ['בסדר, לא נקלט. 👍 אפשר להתחיל שוב עם צילום אחר.'], status: 'ok', result: 'מסמך לא נקלט' };
      return reply(s, `לקלוט את ה${docName(s.doc)} כ*קבלת סחורה*? *כן* / *לא*`);
    }

    case 'offer': {
      if (file) {
        // עוד תמונה לפני התשובה (כמה תמונות ביחד, אלבום) — נשמרות כולן, בלי לשאול שוב על כל אחת
        s.files.push(await saveFile(user.id, file, `מסמך ${s.files.length + 1}`));
        return { s, replies: [], result: `הצעה: ${s.files.length} צילומים` };
      }
      if (YES.test(t) || isTrigger(t)) {
        s.step = 'doc';
        return s.files.length > 1 ? sortBatch(user, s) : onMainDoc(user, s, s.files[0]);
      }
      if (/^(לא|אל|ממש לא|no)([\s,.!]|$)/i.test(t)) return { s: null, replies: ['בסדר, לא נקלט. 👍'], status: 'ok', result: 'הצעה נדחתה' };
      return reply(s, 'לקלוט כ*קבלת סחורה*? *כן* / *לא*');
    }

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

    case 'header': {
      const pay = Priority.payFromText(t);
      if (pay?.unknown !== undefined) return reply(s, `אין בפריוריטי תנאי תשלום שוטף + ${pay.unknown}. האפשרויות: ${Priority.PAY_TERMS.map((p) => Priority.payLabel(p.code)).join(', ')}.`);
      if (pay) { s.payCode = pay.code; return askHeader(s); }
      if (NO_VAT_TEXT.test(t)) { s.noVat = true; s.noVatBy = 'user'; return askHeader(s); }
      if (WITH_VAT_TEXT.test(t.trim())) { s.noVat = false; s.noVatBy = 'user'; return askHeader(s); }
      if (!YES.test(t)) return reply(s, '*כן* להמשך, או *ביטול*. לתנאי תשלום אחר — כתבו אותו ("שוטף 60"). מע"מ — *ללא מע"מ* / *עם מע"מ*.');
      return resolveOrder(s);
    }

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

    case 'warehouse': {
      const opts = s.warehouseOptions ?? [];
      const n = /^\d{1,2}$/.test(t) ? Number(t) : null;
      const w = (n && opts[n - 1]) || opts.find((x) => x.code === t.trim() || (x.name && t.trim().length >= 2 && x.name.includes(t.trim())));
      if (!w) return reply(s, ['לאיזה מחסן? כתבו מספר מהרשימה:', ...opts.map((x, i) => `*${i + 1}.* ${x.name || x.code} (${x.code})`)].join('\n'));
      s.warehouse = w.code;
      if (s.warehouseRetry) return draftAndShow(user, s);
      const r = askFiles(s);
      return { ...r, replies: [`🏬 מחסן: *${w.name || w.code}* (${w.code})\n\n${r.replies[0]}`] };
    }

    case 'parts': {
      if (YES.test(t)) return askProject(s);
      const free = s.lines.filter((l) => !l.order);
      // "שורה 2 ..." — רק לשורה הזו; אחרת — לכל השורות
      const lm = t.match(/שורה\s*(\d+)\s*(.*)$/);
      const target = lm ? free.filter((l) => l.n === Number(lm[1])) : free;
      const rest = (lm ? lm[2] : t).trim();
      if (lm && !target.length) return reply(s, `אין שורה ${lm[1]} בלי הזמנה.`);
      if (/^(כללי|מק"?ט כללי|000)$/.test(rest)) {
        const g = await Priority.generalCoding(s.company).catch(() => null);
        target.forEach((l) => { l.part = generalPart(g, 'נבחר ע"י המקבל'); });
        return askParts(s);
      }
      // מספר מרשימה שהוצגה
      if (/^\d{1,2}$/.test(rest) && s.partOptions?.length) {
        const p = s.partOptions[Number(rest) - 1];
        if (p) { target.forEach((l) => { l.part = partOf(p, 'נבחר ע"י המקבל'); }); s.partOptions = null; return askParts(s); }
      }
      const code = rest.match(/[A-Za-z]*\d[\w]*(?:-[\w]+)+/)?.[0];
      if (code) {
        const p = await Priority.partByCode(s.company, code.toUpperCase()).catch(() => null);
        if (!p) return reply(s, `אין מק"ט ${code} בחברה הזו. כתבו מק"ט אחר, מילה מהתיאור, או *כללי*.`);
        target.forEach((l) => { l.part = partOf(p, 'נבחר ע"י המקבל'); });
        return askParts(s);
      }
      // מילה מהתיאור ("מק"ט העתקות" ← "העתקות")
      const word = rest.replace(/מק"?ט|מקט|פריט/g, '').trim();
      if (word.length >= 2) {
        const list = await Priority.findPartsByText(s.company, word).catch(() => []);
        if (list.length === 1) { target.forEach((l) => { l.part = partOf(list[0], 'נבחר ע"י המקבל'); }); return askParts(s); }
        if (list.length) {
          s.partOptions = list;
          return { s, replies: [['איזה מהם?', ...list.map((p, i) => `*${i + 1}.* ${codeText(partOf(p, ''))}`)].join('\n')] };
        }
        return reply(s, `לא מצאתי מק"ט עם "${word}". כתבו מק"ט, מילה אחרת, או *כללי*.`);
      }
      return reply(s, '*כן* — להמשיך, או כתבו מק"ט / מילה מהתיאור / *כללי*.');
    }

    case 'chapter': {
      const sug = s.chapterSuggestion;
      if (YES.test(t) && sug) s.chapter = { chapter: sug.chapter, topic: sug.topic };
      else if (YES.test(t)) { await codeLines(s); return askParts(s); }
      else {
        const m = t.match(/(\d{2})\s+(\d{2}-\d{2})/);
        if (!m) return reply(s, 'כתבו תת פרק ותת נושא (למשל "98 90-00"), או *כן* להצעה.');
        s.chapter = { chapter: m[1], topic: m[2] };
      }
      return askProject(s);
    }

    case 'project': {
      // הצעה אחת מה-AI מחכה לאישור
      if (s.projectPending) {
        const pend = s.projectPending;
        if (YES.test(t)) { s.projectPending = null; s.project = pend; return chooseWarehouse(s); }
        s.projectPending = null;
        if (/^(לא|no)([\s,.!]|$)/i.test(t)) return reply(s, 'לאיזה פרויקט, אם כך? כתבו במילים שלכם, או קוד (PR…).');
      }
      // מספר מהרשימה — רק כשנכתב מספר קטן לבד, והרשימה הוצגה ("2"). "49" או "207" הם מספרי מגרש
      const n = /^\d{1,2}$/.test(t) ? Number(t) : null;
      let p = n && n <= (s.projectOptions?.length ?? 0) ? s.projectOptions[n - 1] : null;
      if (!p) {
        const all = await projectsOf(s.company);
        const code = t.match(/PR\d+/i)?.[0]?.toUpperCase();
        if (code) {
          p = all.find((x) => x.code === code);
          if (!p) return reply(s, `אין פרויקט ${code} בחברה הזו. כתבו את השם במילים שלכם, או קוד אחר.`);
        } else {
          if (!Priority.matchProjects(all, t, { all: true }).length) {
            const note = await sandboxNote(s, t, all);
            if (note) return reply(s, note);
          }
          const found = await findProjects(all, t);
          if (found.list.length === 1 && found.by === 'code') p = found.list[0];
          else if (found.list.length === 1) {
            // ה-AI הבין לבד — שואלים לפני ששייכים
            s.projectPending = found.list[0];
            return reply(s, `📁 *${found.list[0].des}* (${found.list[0].code})? *כן*, או כתבו אחרת.`);
          } else if (found.list.length) {
            s.projectOptions = found.list.slice(0, 9);
            return reply(s, ['לאיזה מהם התכוונת?', ...s.projectOptions.map((x, i) => `*${i + 1}.* ${x.des} (${x.code})`)].join('\n'));
          } else {
            return reply(s, found.question || 'לא מצאתי פרויקט כזה. כתבו במילים אחרות (למשל "אלעד 49" או "נהריה"), או קוד (PR…).');
          }
        }
      }
      s.project = p;
      return chooseWarehouse(s);
    }

    case 'files':
      if (s.pendingNew && !file) { const r = await answerPendingNew(user, s, t); if (r) return r; }
      if (file) return routeFile(user, s, file, t);
      if (/^\d{1,2}$/.test(t.trim()) && s.warehouseChoices?.[Number(t) - 1]) {
        const w = s.warehouseChoices[Number(t) - 1];
        s.warehouseChoices = s.warehouseChoices.filter((x) => x !== w);
        s.warehouse = w.code;
        const r = askFiles(s);
        return { ...r, replies: [`🏬 המחסן שונה ל*${w.name || w.code}* (${w.code}).\n\n${r.replies[0]}`] };
      }
      if (!DONE_FILES.test(t)) return reply(s, 'שלחו נספח, או *סיום* להמשך.');
      return draftAndShow(user, s);

    case 'review': {
      if (s.pendingNew && !file) { const r = await answerPendingNew(user, s, t); if (r) return r; }
      if (file) return routeFile(user, s, file, t);
      const pay = Priority.payFromText(t);
      if (pay?.unknown !== undefined) return reply(s, `אין בפריוריטי תנאי תשלום שוטף + ${pay.unknown}. האפשרויות: ${Priority.PAY_TERMS.map((p) => Priority.payLabel(p.code)).join(', ')}.`);
      if (pay) {
        await Priority.setHeader(s.company, s.docno, { MED_MXPAYCODE: pay.code });
        s.payCode = pay.code;
        await writeDialog(user, s).catch(() => {});
        return showDraft(s);
      }
      if (/^(מאשר|מאשרת|אישור|אשר)([\s,.!]|$)/.test(t)) {
        try {
          await Priority.finalizeReceipt(s.company, s.docno);
        } catch (err) {
          alertAdmins(user, s, 'GR לא הפך לסופי', [err.message]);
          return { s: null, replies: [`ה-GR *${s.docno}* נשמר כטיוטא, אבל לא הפך לסופי. מנהל המערכת קיבל הודעה ויטפל.`], status: 'error', result: `סופית נכשלה: ${err.message}` };
        }
        const done = `✅ *קבלת סחורה ${s.docno}* נקלטה כסופית.\n${companyLine(s)}\nספק: ${s.supplier.name}${s.order ? ` · הזמנה ${s.order.ordname}` : ''}`;
        if (queueOf(s).length) return startQueued(user, s, [done]);
        return { s: null, replies: [done], status: 'ok', result: `GR סופי ${s.docno}` };
      }
      const out = await ai.reply(s.reviewLines.map((l) => ({ line: l.n, description: l.description, qty: l.qty, options: [] })), t);
      if (out.action === 'confirm') return step(user, s, 'מאשר', null);
      if (out.action === 'cancel') {
        const r = await cancel(user, s);
        return queueOf(s).length ? startQueued(user, s, r.replies) : { s: null, ...r };
      }
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

module.exports = { isTrigger, opens, active, handle, sweep, _codeLines: codeLines, _similarLines: similarLines, _askParts: askParts, _projectsOf: projectsOf, _findProjects: findProjects, _ai: ai, _load: load, _clear: (userId) => clear(userId, load(userId)) };
