'use strict';
/**
 * 🏷️ הוספה למחירון ספק מהזמנת רכש — האפיון: "אפיון — הוספה למחירון ספק מהזמנת רכש.md" (הוחלט 17–22.11.26).
 *
 *   1. הזמנה סופית (הסריקה של ‎po-notify.js‎) — בודקים כל שורה מול מחירוני הספק. קריאה בלבד.
 *   2. פריטים שאינם במחירון — הודעה בבוט למי שברשימה "רכש — מחירונים" (הגדרות משימון פריוריטי, ‎pricelistHandlers‎),
 *      עם *כולם ✅* / *לבחור* / *לא ❌*, ושפה חופשית ("רק 1 ו-3", "בלי הדבק", "שורה 2 במחיר 30", "מחירון 0004").
 *   3. סיכום ← *מאשר ✅* ← כל פריט נכתב למחירון (‎SPARTPRICE_SUBFORM‎) ול"מוצרים לספק" (‎SUPPART_SUBFORM‎), אם עוד לא שם.
 *   4. ביטול — "לבטל את ההוספה למחירון" ← *כן, לבטל 🗑️* ← נמחק רק מה שנכתב בפעולה הזו.
 *
 * כללים: המחיר — אחרי הנחת השורה; פריט שכבר במחירון (גם במחיר אחר) — לא מוצע; פריט כללי 000 — לא; לספק בלי מחירון —
 * רק הודעה, פעם אחת לכל ספק. מחירון: הבחירה האחרונה לאותו ספק, אחרת מחירון הפרויקט של ההזמנה, אחרת הכללי האחרון.
 * רק בחברות שפתוחות לכתיבה. מי שאינו ברשימה (ואינו מנהל מערכת) — לא רואה כלום.
 */
const D = require('../core').Db;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Priority = require('../integrations').Priority;
const Settings = require('./priority-settings');
const { YES, NO, normalize, sameLabel } = require('../whatsapp').WaUi;
const WaActions = require('../whatsapp').WaActions;

const BTN = Object.freeze({
  all: 'כולם ✅', pick: 'לבחור', no: 'לא ❌',
  ok: 'מאשר ✅', cancel: 'ביטול 🗑️',
  undo: 'כן, לבטל 🗑️', keep: 'לא, להשאיר'
});
const KIND = 'po_pricelist';
/** שאלה שלא נענתה — נסגרת אחרי 3 ימים; הודעה שלא יצאה (מחוץ לשעות) — מנסים עד 3 ימים */
const ASK_DAYS = 3;
const UNDO_DAYS = 2;
const MAX_LINES = 20;

/** ‎push(userId, { text, buttons, draft })‎ → ‎true‎ אם יצאה. מחובר ב-‎wa-flows.js‎ */
const hooks = { push: null };
const setHooks = (h) => Object.assign(hooks, h);

const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const row = (id) => {
  const r = D.get('SELECT * FROM po_pricelist_offers WHERE id = ?', id);
  return r ? { ...r, items: parse(r.items, []), list: parse(r.list, null), lists: parse(r.lists, []), written: parse(r.written, []) } : null;
};
const money = (n) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const cur = (c) => (c === 'ש"ח' || !c ? '₪' : c);

const enabled = () => Priority.isEnabled() && Boolean(WaActions.byKey(KIND)?.enabled);

// ---------------------------------------------------------------------------
// מי מקבל
// ---------------------------------------------------------------------------

/** משתמשי משימון ברשימה "רכש — מחירונים" (פעילים) */
function handlers() {
  const ids = (Settings.defaults().pricelistHandlers ?? []).map(Number).filter(Number.isInteger);
  return ids.map((id) => D.get("SELECT id, full_name, phone FROM users WHERE id = ? AND status = 'active'", id)).filter(Boolean);
}
const isAdmin = (userId) => { const u = D.get('SELECT role FROM users WHERE id = ?', userId); return ['superadmin', 'admin'].includes(u?.role); };
/** רשאי לענות / לבקש: ברשימה, או מנהל מערכת */
const mayHandle = (userId) => handlers().some((u) => u.id === userId) || isAdmin(userId);

function alertAdmins(title, body) {
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🏷️ מחירון ספק: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על מחירון ספק:', err.message);
  }
}

// ---------------------------------------------------------------------------
// אילו שורות, ואיזה מחירון
// ---------------------------------------------------------------------------

/** שורת מילוי ("מוצר כללי" בלי מחיר) ופריט כללי — לא נכנסים למחירון */
const general = (l) => !l.PARTNAME || l.PARTNAME === '000';
/** המחיר אחרי הנחת השורה (הוחלט 22.11.26) */
const net = (l) => Math.round(Number(l.PRICE ?? 0) * (1 - Number(l.PERCENT ?? 0) / 100) * 10000) / 10000;

/** השורות שאפשר להכניס למחירון — פריט אחד לכל מק"ט, במחיר הנמוך (ו‎prices‎ — כמה מחירים שונים היו) */
function candidates(po) {
  const by = new Map();
  for (const l of po.lines ?? []) {
    if (general(l)) continue;
    const price = net(l);
    if (!(price > 0)) continue;
    const e = by.get(l.PARTNAME) ?? { part: l.PARTNAME, des: String(l.PDES ?? '').trim(), unit: l.TUNITNAME ?? '', price, all: new Set() };
    e.price = Math.min(e.price, price);
    e.all.add(price);
    by.set(l.PARTNAME, e);
  }
  return [...by.values()].map(({ all, ...e }) => ({ ...e, prices: all.size }));
}

/** המחירונים שחלים על ההזמנה: של הפרויקט שלה, ואחריהם הכלליים (בלי פרויקט) — החדש קודם */
function applicable(lists, projdocno) {
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  const proj = projdocno ? lists.filter((l) => l.projects.includes(projdocno)).sort(byDate) : [];
  const gen = lists.filter((l) => !l.projects.length).sort(byDate);
  return [...proj, ...gen];
}

const slim = (l) => (l ? { name: l.name, des: l.des ?? '', date: l.date, projects: l.projectNames ?? [], general: !(l.projects ?? []).length } : null);
const listLabel = (l) => (l ? `${l.name}${l.des ? ` ${l.des}` : ''}${l.general ? ' (כללי)' : l.projects?.length ? ` (${l.projects.join(', ')})` : ''}` : '');

/** הבחירה האחרונה לאותו ספק (מהצעה שנכתבה), אם היא עדיין חלה */
function lastChoice(company, supname, app) {
  const r = D.get("SELECT list FROM po_pricelist_offers WHERE company = ? AND supname = ? AND status IN ('done','undone') AND list IS NOT NULL ORDER BY done_at DESC LIMIT 1", company, supname);
  const l = parse(r?.list, null);
  return l ? app.find((x) => x.name === l.name && x.date === l.date) ?? null : null;
}

// ---------------------------------------------------------------------------
// ההודעות
// ---------------------------------------------------------------------------

function offerText(r, pre = []) {
  const items = r.items.slice(0, MAX_LINES);
  return [...pre,
    `🏷️ *פריטים שלא במחירון של ${r.supdes || r.supname}*`,
    `${r.ordname}${r.projdes ? ` · 📁 ${r.projdes}` : ''} · 🏢 ${Priority.companyOf(r.company).name}`,
    '',
    ...items.map((it) => `${it.n}. ${it.des} (${it.part}) — ${money(it.price)} ${cur(r.currency)}${it.unit ? ` ל${it.unit}` : ''}${it.prices > 1 ? ` _(בהזמנה ב-${it.prices} מחירים)_` : ''}`),
    r.items.length > MAX_LINES ? `…ועוד ${r.items.length - MAX_LINES}` : null,
    '',
    `📒 מחירון: ${listLabel(r.list)}${r.lists.length > 1 ? ' — לשנות: "מחירון <מספר>"' : ''}`,
    'להוסיף למחירון הספק (וגם ל"מוצרים לספק")? אפשר גם "רק 1 ו-3", "בלי 2", "שורה 2 במחיר 30".'
  ].filter((x) => x !== null).join('\n');
}

const picked = (r) => r.items.filter((it) => it.pick !== false);

function summaryText(r) {
  const list = picked(r);
  return [
    `📋 *לכתוב למחירון של ${r.supdes || r.supname}*`,
    `📒 מחירון: ${listLabel(r.list)}`,
    ...list.map((it) => `• ${it.des} (${it.part}) — ${money(it.price)} ${cur(r.currency)}${it.unit ? ` / ${it.unit}` : ''}`),
    `🏢 ${Priority.companyOf(r.company).name}`,
    '',
    'הפריטים ייכנסו גם ל"מוצרים לספק". *מאשר* ✅?'
  ].join('\n');
}

const draftOf = (r, step) => ({ kind: KIND, offerId: r.id, step });

function save(r, fields) {
  const cols = Object.keys(fields);
  const val = (k) => (['items', 'list', 'lists', 'written'].includes(k) ? JSON.stringify(fields[k]) : fields[k]);
  D.run(`UPDATE po_pricelist_offers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map(val), r.id);
  Object.assign(r, fields);
}

// ---------------------------------------------------------------------------
// ההצעה: מההזמנה לשורה בטבלה ולהודעה
// ---------------------------------------------------------------------------

/**
 * בונה את ההצעה להזמנה (בלי לשלוח). ‎{ id, status }‎ — ‎none‎ (אין מה להציע), ‎no_list‎, ‎pending‎.
 * ‎fresh‎ — לפי בקשה: מחליף הצעה קודמת שלא נכתבה.
 */
async function build(company, po, { version = Number(po.CURVERSION) || 1, fresh = false } = {}) {
  const old = D.get('SELECT id, status FROM po_pricelist_offers WHERE company = ? AND ordname = ? AND version = ?', company, po.ORDNAME, version);
  if (old && !fresh) return { id: old.id, status: old.status, existed: true };
  if (old && old.status === 'done') return { id: old.id, status: 'done', existed: true };
  if (old) D.run('DELETE FROM po_pricelist_offers WHERE id = ?', old.id);
  const cands = candidates(po);
  const lists = cands.length ? await Priority.supplierPriceLists(company, po.SUPNAME) : [];
  const app = applicable(lists, po.PROJDOCNO);
  const inList = new Set(app.flatMap((l) => [...l.parts]));
  const currency = po.CODE ?? '';
  const items = cands.filter((c) => !inList.has(c.part)).map((c, i) => ({ ...c, n: i + 1, pick: true, currency }));
  const status = !cands.length ? 'none' : !app.length ? 'no_list' : items.length ? 'pending' : 'none';
  const list = app.length ? slim(lastChoice(company, po.SUPNAME, app) ?? app[0]) : null;
  const info = D.run(`INSERT INTO po_pricelist_offers (company, ordname, version, supname, supdes, projdocno, projdes, items, list, lists, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, company, po.ORDNAME, version, po.SUPNAME, po.CDES ?? po.SUPDES ?? '', po.PROJDOCNO ?? null, po.PROJDES ?? '',
  JSON.stringify(status === 'no_list' ? cands.map((c, i) => ({ ...c, n: i + 1, currency })) : items), JSON.stringify(list), JSON.stringify(app.map(slim)), status, D.nowIso());
  return { id: Number(info.lastInsertRowid), status };
}

const withCurrency = (r) => ({ ...r, currency: r.items[0]?.currency ?? '' });

/** לספק אין מחירון — הודעה בלי כפתורים, פעם אחת לכל ספק */
function noListText(r) {
  return [`🏷️ *לספק ${r.supdes || r.supname} אין מחירון בפריוריטי*`,
    `בהזמנה ${r.ordname} יש ${r.items.length === 1 ? 'פריט אחד' : `${r.items.length} פריטים`}${r.projdes ? ` (📁 ${r.projdes})` : ''}. כדי להוסיף אותם, צריך לפתוח לו מחירון.`,
    `🏢 ${Priority.companyOf(r.company).name}`].join('\n');
}

/** שולח הצעה שמחכה — לכל מי שברשימה. ‎true‎ — יצאה לפחות לאחד */
async function send(id) {
  const r = row(id);
  if (!r || !['pending', 'no_list'].includes(r.status)) return false;
  const hs = handlers();
  if (!hs.length) {
    if (!D.getSetting('po_pricelist_no_handler', false)) {
      alertAdmins('אין מי שמקבל הצעות למחירון', 'הגדירו את "רכש — מחירונים" במשימון פריוריטי ← הגדרות. ההצעות מחכות עד אז.');
      D.setSetting('po_pricelist_no_handler', true);
    }
    return false;
  }
  if (r.status === 'no_list') {
    const already = D.get("SELECT 1 AS x FROM po_pricelist_offers WHERE company = ? AND supname = ? AND status = 'no_list_sent' LIMIT 1", r.company, r.supname);
    if (already) { save(r, { status: 'none' }); return false; }
    let ok = false;
    for (const h of hs) if (hooks.push && await hooks.push(h.id, { text: noListText(r) }).catch(() => false)) ok = true;
    if (ok) {
      save(r, { status: 'no_list_sent', asked_at: D.nowIso() });
      for (const h of hs) D.notify({ targetType: 'user', targetId: h.id, kind: 'ai', title: `🏷️ לספק ${r.supdes || r.supname} אין מחירון`, body: noListText(r).replace(/\*/g, '') });
    }
    return ok;
  }
  const v = withCurrency(r);
  let ok = false;
  for (const h of hs) {
    if (hooks.push && await hooks.push(h.id, { text: offerText(v), buttons: [BTN.all, BTN.pick, BTN.no], draft: draftOf(r, 'pick') }).catch(() => false)) ok = true;
  }
  if (ok) {
    save(r, { status: 'asked', asked_at: D.nowIso() });
    for (const h of hs) D.notify({ targetType: 'user', targetId: h.id, kind: 'ai', title: `🏷️ ${r.items.length} פריטים מ-${r.ordname} לא במחירון של ${r.supdes || r.supname}`, body: r.items.map((it) => `• ${it.des} — ${money(it.price)}`).join('\n') });
  }
  return ok;
}

/**
 * הזמנה סופית (מ-‎po-notify.js‎): בונה את ההצעה ושולחת. בלי לזרוק — תקלה ליומן ולמנהלי המערכת.
 */
async function offer(company, po, opts = {}) {
  if (!enabled() || !Settings.writable().includes(company)) return null;
  try {
    const b = await build(company, po, opts);
    if (b.existed || !['pending', 'no_list'].includes(b.status)) return b;
    await send(b.id);
    return b;
  } catch (err) {
    console.error(`[משימון] מחירון ספק (${company} ${po?.ORDNAME}):`, err.message);
    alertAdmins(`לא נבדק מחירון להזמנה ${po?.ORDNAME}`, `חברה: ${company}\n${err.message}`);
    return null;
  }
}

/** ממשיך את מה שלא יצא (מחוץ לשעות / אין רשימה), וסוגר שאלות ישנות. בסבב של ‎po-notify.js‎ */
async function flush() {
  if (!enabled()) return;
  const old = new Date(Date.now() - ASK_DAYS * 86400000).toISOString();
  D.run("UPDATE po_pricelist_offers SET status = 'expired' WHERE status IN ('pending','asked') AND created_at < ?", old);
  for (const { id } of D.all("SELECT id FROM po_pricelist_offers WHERE status IN ('pending','no_list') ORDER BY id LIMIT 10")) await send(id).catch(() => false);
}

// ---------------------------------------------------------------------------
// התשובה: בחירה, סיכום, כתיבה
// ---------------------------------------------------------------------------

const NUMS = /\d+/g;
const strip = (s) => normalize(s).replace(/["'״׳]/g, '');

/**
 * תיקון בשפה חופשית. מחזיר ‎true‎ כשהבין משהו (ומעדכן את ‎r‎), ‎false‎ — לא.
 *   "רק 1 ו-3" / "1, 3" · "בלי 2" / "חוץ מ-2" · "בלי הדבק" · "שורה 2 במחיר 30" · "מחירון 0004" / "כללי"
 */
function edit(r, text) {
  const t = strip(text);
  let done = false;
  // מחיר
  for (const m of t.matchAll(/(?:שורה\s*)?(\d+)\s*(?:במחיר|מחיר|ב-?)\s*([\d.,]+)/g)) {
    const it = r.items.find((x) => x.n === Number(m[1]));
    const price = Number(m[2].replace(/,/g, ''));
    if (it && price > 0) { it.price = price; it.pick = true; done = true; }
  }
  if (done) return true;
  // מחירון
  const ml = t.match(/^מחירון\s+(.+)$/);
  if (ml || /^כללי$/.test(t)) {
    const want = ml ? ml[1].trim() : '';
    const l = ml ? r.lists.find((x) => x.name === want || (x.des && x.des.includes(want))) : r.lists.find((x) => x.general);
    if (l) { r.list = l; return true; }
    return false;
  }
  const except = /^(?:בלי|חוץ מ|חוץ מה|לא|הכל חוץ מ|הכל בלי|כולם חוץ מ|כולם בלי)[\s-]*(.+)$/.exec(t);
  const only = /^(?:רק|אך ורק)[\s-]*(.+)$/.exec(t);
  const rest = (except ?? only)?.[1] ?? t;
  const nums = (rest.match(NUMS) ?? []).map(Number).filter((n) => r.items.some((x) => x.n === n));
  const words = rest.replace(NUMS, ' ').split(/[\s,]+|\sו-?/).map((w) => w.replace(/^ו-?/, '').replace(/^ה(?=\S{2,})/, '')).filter((w) => w.length >= 2);
  const byWord = (it) => words.some((w) => strip(it.des).includes(w));
  const hit = (it) => nums.includes(it.n) || (!nums.length && words.length && byWord(it));
  const any = r.items.some(hit);
  if (!any) return false;
  if (except) for (const it of r.items) it.pick = it.pick !== false && !hit(it);
  else for (const it of r.items) it.pick = hit(it);
  return true;
}

/** כתיבה לפריוריטי: למחירון ול"מוצרים לספק". ‎{ added, skipped, failed }‎ */
async function write(r) {
  const lists = await Priority.supplierPriceLists(r.company, r.supname);
  const target = lists.find((l) => l.name === r.list?.name && l.date === r.list?.date);
  if (!target) throw new Error(`המחירון ${r.list?.name} לא נמצא (אולי בוטל)`);
  const sup = async () => new Map((await Priority.supplierParts(r.company, r.supname).catch(() => [])).map((x) => [x.PARTNAME, x.KLINE]));
  const before = await sup();
  const added = [];
  const skipped = [];
  const failed = [];
  for (const it of picked(r)) {
    if (target.parts.has(it.part)) { skipped.push(it); continue; }
    try {
      const key = await Priority.addPriceListItem(r.company, target, { part: it.part, price: it.price });
      added.push({ part: it.part, des: it.des, price: it.price, PART: key.PART, QUANT: key.QUANT, kline: null });
    } catch (err) {
      failed.push({ it, err: err.message });
    }
  }
  // "מוצרים לספק": פריוריטי מוסיף לבד כשנכתבת שורת מחירון (נבדק ב-test11, 22.11.26) — ואז רק רושמים את השורה שנוצרה
  // (בשביל הביטול). מה שלא נוסף לבד — מוסיפים. פריוריטי מקבל אותו פריט פעמיים, ולכן בודקים קודם
  const after = added.length ? await sup() : before;
  for (const w of added) {
    if (before.has(w.part)) continue;
    if (after.has(w.part)) { w.kline = after.get(w.part); continue; }
    try { w.kline = (await Priority.addSupplierPart(r.company, r.supname, w.part)).KLINE; } catch (err) { failed.push({ it: w, err: `מוצרים לספק: ${err.message}`, partial: true }); }
  }
  return { added, skipped, failed };
}

async function undo(r) {
  const errs = [];
  for (const w of r.written) {
    try { if (w.PART) await Priority.deletePriceListItem(r.company, r.list, { PART: w.PART, QUANT: w.QUANT }); } catch (err) { errs.push(`${w.part}: ${err.message}`); }
    try { if (w.kline) await Priority.deleteSupplierPart(r.company, r.supname, w.kline); } catch (err) { errs.push(`${w.part} (מוצרים לספק): ${err.message}`); }
  }
  return errs;
}

const closed = (r, userId) => {
  if (r.status === 'done') return r.handler_id === userId ? '✅ הפריטים כבר נוספו למחירון.' : `✅ ${nameOf(r.handler_id)} כבר הוסיף את הפריטים למחירון.`;
  if (r.status === 'declined') return 'ההצעה הזו כבר נסגרה, בלי הוספה למחירון.';
  if (r.status === 'expired') return 'ההצעה הזו כבר פגה. כדי להציע שוב: *מחירון ' + r.ordname + '*.';
  if (r.status === 'undone') return 'ההוספה הזו כבר בוטלה.';
  return null;
};
const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? 'מישהו אחר';

/** הכתיבה אחרי "מאשר" — משותף לבוט ולמסך. ‎{ text, result, ok }‎ */
async function commit(r, userId) {
  if (!Settings.writable().includes(r.company)) return { text: 'החברה הזו לא פתוחה לכתיבה מהבוט. פנו למנהל המערכת.', result: 'חברה סגורה לכתיבה', ok: false };
  if (!picked(r).length) return { text: 'לא נבחר אף פריט.', result: 'לא נבחר', ok: false };
  let res;
  try {
    res = await write(r);
  } catch (err) {
    alertAdmins(`הכתיבה למחירון מ-${r.ordname} נכשלה`, `חברה: ${r.company}\n${err.message}`);
    return { text: 'לא הצלחתי לכתוב למחירון. מנהל המערכת עודכן.', result: `שגיאה: ${err.message}`, ok: false };
  }
  save(r, { status: 'done', handler_id: userId, done_at: D.nowIso(), written: res.added });
  if (res.failed.length) alertAdmins(`חלק מהפריטים מ-${r.ordname} לא נכתבו`, [`חברה: ${r.company}`, ...res.failed.map((f) => `${f.it.part}: ${f.err}`)].join('\n'));
  for (const h of handlers()) if (h.id !== userId) D.notify({ targetType: 'user', targetId: h.id, kind: 'ai', title: `🏷️ ${nameOf(userId)} הוסיף ${res.added.length} פריטים מ-${r.ordname} למחירון`, body: res.added.map((w) => `• ${w.des}`).join('\n') });
  const lines = [
    res.added.length ? `✅ ${res.added.length === 1 ? 'נוסף פריט אחד' : `נוספו ${res.added.length} פריטים`} למחירון של ${r.supdes || r.supname} (${r.list?.name}).` : 'לא נוסף אף פריט.',
    res.skipped.length ? `ℹ️ כבר היו במחירון: ${res.skipped.map((it) => it.des).join(', ')}` : null,
    res.failed.filter((f) => !f.partial).length ? `⚠️ לא נוספו: ${res.failed.filter((f) => !f.partial).map((f) => f.it.des).join(', ')}. מנהל המערכת עודכן.` : null,
    res.added.length ? '_לבטל: "לבטל את ההוספה למחירון"._' : null
  ].filter(Boolean);
  return { text: lines.join('\n'), result: `מחירון ${r.ordname}: נוספו ${res.added.length}${res.failed.length ? `, נכשלו ${res.failed.length}` : ''}`, ok: true };
}

/**
 * תשובה לשאלה של ההצעה (‎draft.kind === 'po_pricelist'‎). ‎null‎ — לא שלי (נושא אחר).
 * מחזיר ‎{ text, buttons?, draft?, result }‎ — ‎draft‎ ריק סוגר את השאלה.
 */
const THUMB_DOWN = /^👎$/;
/** 👎 כהודעה נפרדת — "שלב אחורה" רק דקות ספורות אחרי ההוספה, וכשההוספה היא הפעולה האחרונה של העובד בבוט */
const THUMB_UNDO_MIN = 30;

/**
 * ‎opts.reaction‎ — התשובה היא תגובה (Reaction) על הודעת השאלה (‎CLAUDE.md‎): 👍 = כן, 👎 = לא.
 * 👎 כהודעה נפרדת = שלב אחורה: בסיכום — חזרה לבחירה; בשאלת הביטול — לא מבטלים.
 */
async function answer(userId, d, text, { reaction = false } = {}) {
  const r = row(d?.offerId);
  if (!r) return null;
  const t = String(text ?? '').trim();
  const n = normalize(t);
  const yes = YES.test(n);
  // "לא 2" — תיקון (בלי שורה 2), לא סירוב
  const no = NO.test(n) && !/\d/.test(n) && n.split(/\s+/).length <= 2;
  const back = !reaction && THUMB_DOWN.test(n);
  if (d.step === 'undo') {
    if (sameLabel(t, BTN.undo) || yes) {
      if (r.status !== 'done') return { text: closed(r, userId) ?? 'אין מה לבטל.', result: `מחירון ${r.ordname}: אין מה לבטל` };
      const errs = await undo(r);
      save(r, { status: 'undone' });
      if (errs.length) alertAdmins(`ביטול ההוספה מ-${r.ordname} נכשל חלקית`, errs.join('\n'));
      return { text: errs.length ? '⚠️ חלק מהפריטים לא נמחקו מהמחירון. מנהל המערכת עודכן.' : `🗑️ בוטל: ${r.written.length} פריטים הוסרו מהמחירון של ${r.supdes || r.supname}.`, result: `מחירון ${r.ordname}: בוטל` };
    }
    if (sameLabel(t, BTN.keep) || no) return { text: 'בסדר, נשאר במחירון.', result: `מחירון ${r.ordname}: לא בוטל` };
    return null;
  }
  const done = closed(r, userId);
  if (done) return { text: done, result: `מחירון ${r.ordname}: כבר טופל (${r.status})` };
  if (r.handler_id && r.handler_id !== userId) return { text: `${nameOf(r.handler_id)} כבר מטפל בהצעה הזו.`, result: `מחירון ${r.ordname}: אצל אחר` };
  if (!mayHandle(userId)) return { text: 'ההוספה למחירון שמורה לרכש.', result: 'אין הרשאה' };
  const v = () => withCurrency(r);
  const toSummary = () => {
    if (!picked(r).length) return { text: 'לא נבחר אף פריט. כתבו אילו פריטים ("רק 1 ו-3"), או *לא* ❌.', buttons: [BTN.all, BTN.no], draft: draftOf(r, 'pick'), result: 'לא נבחר' };
    return { text: summaryText(v()), buttons: [BTN.ok, BTN.cancel], draft: draftOf(r, 'confirm'), result: `סיכום: ${picked(r).length} פריטים` };
  };
  if (d.step === 'pick') {
    if (sameLabel(t, BTN.all) || yes) { for (const it of r.items) it.pick = true; save(r, { items: r.items, handler_id: userId }); return toSummary(); }
    if (sameLabel(t, BTN.no) || no) { save(r, { status: 'declined', handler_id: userId, done_at: D.nowIso() }); return { text: 'בסדר, לא נוסף למחירון.', result: `מחירון ${r.ordname}: לא` }; }
    if (sameLabel(t, BTN.pick)) return { text: 'אילו? למשל *"רק 1 ו-3"*, *"בלי 2"*, *"בלי הדבק"*, או *"שורה 2 במחיר 30"*.', buttons: [BTN.all, BTN.no], draft: draftOf(r, 'pick'), result: 'לבחור' };
    if (edit(r, t)) { save(r, { items: r.items, list: r.list, handler_id: userId }); return toSummary(); }
    return t.split(/\s+/).length <= 4 ? { text: 'לא הבנתי. *כולם* ✅, *לא* ❌, או אילו פריטים ("רק 1 ו-3").', buttons: [BTN.all, BTN.pick, BTN.no], draft: draftOf(r, 'pick'), result: 'לא הובן' } : null;
  }
  if (d.step === 'confirm') {
    if (sameLabel(t, BTN.ok) || yes) return commit(r, userId);
    // 👎 כהודעה — שלב אחורה: חזרה לבחירת הפריטים (כתגובה על הסיכום — "לא", כמו ביטול)
    if (back) return { text: offerText(v(), ['↩️ חזרה לבחירה:', '']), buttons: [BTN.all, BTN.pick, BTN.no], draft: draftOf(r, 'pick'), result: `מחירון ${r.ordname}: 👎 שלב אחורה` };
    if (sameLabel(t, BTN.cancel) || no) { save(r, { status: 'declined', handler_id: userId, done_at: D.nowIso() }); return { text: 'בוטל — לא נוסף למחירון.', result: `מחירון ${r.ordname}: בוטל` }; }
    if (edit(r, t)) { save(r, { items: r.items, list: r.list }); return toSummary(); }
    return t.split(/\s+/).length <= 4 ? { text: '*מאשר* ✅, *ביטול* 🗑️, או תיקון ("בלי 2").', buttons: [BTN.ok, BTN.cancel], draft: draftOf(r, 'confirm'), result: 'לא הובן' } : null;
  }
  return null;
}

/** ההוספה למחירון היא הפעולה האחרונה של העובד בבוט (יומן הבוט) — אחרת 👎 שייך למשהו אחר */
function lastActionWasWrite(userId) {
  const last = D.get("SELECT action, result FROM wa_log WHERE user_id = ? AND channel = 'private' ORDER BY id DESC LIMIT 1", userId);
  return last?.action === KIND && /: נוספו [1-9]/.test(last.result ?? '');
}

// ---------------------------------------------------------------------------
// לפי בקשה: "מחירון PO26000123", "לבטל את ההוספה למחירון"
// ---------------------------------------------------------------------------

const REQUEST = /^(?:מחירון|למחירון|הוספה\s+למחירון|להוסיף\s+למחירון)\s*(?:מ?ה?הזמנה\s*)?(PO\d+)\s*$/i;
const UNDO = /^(?:ביטול|לבטל|בטל|תבטל)\s+(?:את\s+)?(?:ה)?הוספה\s+(?:ל|מה?)מחירון/;
const isRequest = (text) => REQUEST.test(String(text ?? '').trim()) || UNDO.test(normalize(text));

/** בקשה מהעובד. ‎null‎ — לא בקשה כזו */
async function request(userId, text) {
  const t = String(text ?? '').trim();
  if (!enabled()) return null;
  if (!mayHandle(userId)) return isRequest(t) ? { text: 'ההוספה למחירון שמורה לרכש. אם צריך — פנו למנהל המערכת.', result: 'אין הרשאה' } : null;
  const thumb = THUMB_DOWN.test(normalize(t));
  if (thumb && !lastActionWasWrite(userId)) return null;
  if (UNDO.test(normalize(t)) || thumb) {
    const since = new Date(Date.now() - (thumb ? THUMB_UNDO_MIN * 60000 : UNDO_DAYS * 86400000)).toISOString();
    const last = D.get("SELECT id FROM po_pricelist_offers WHERE handler_id = ? AND status = 'done' AND done_at >= ? ORDER BY done_at DESC LIMIT 1", userId, since);
    const r = last ? row(last.id) : null;
    if (!r || !r.written.length) return { text: 'אין הוספה למחירון מהיומיים האחרונים לבטל.', result: 'אין מה לבטל' };
    return { text: [`🗑️ לבטל את ההוספה למחירון של ${r.supdes || r.supname} (${r.ordname})?`, ...r.written.map((w) => `• ${w.des} (${w.part})`)].join('\n'),
      buttons: [BTN.undo, BTN.keep], draft: draftOf(r, 'undo'), result: `ביטול? ${r.ordname}` };
  }
  const m = REQUEST.exec(t);
  if (!m) return null;
  const ordname = m[1].toUpperCase();
  for (const c of Settings.writable()) {
    let po;
    try { po = await Priority.orderForNotice(c, ordname); } catch { continue; }
    if (!po?.ORDNAME) continue;
    const b = await build(c, po, { fresh: true });
    const r = row(b.id);
    if (b.status === 'done') return { text: `✅ הפריטים מ-${ordname} כבר נוספו למחירון.`, result: 'כבר נוסף' };
    if (b.status === 'no_list') { save(r, { status: 'no_list_sent' }); return { text: noListText(r), result: 'אין מחירון' }; }
    if (b.status === 'none') return { text: `👍 כל הפריטים בהזמנה ${ordname} כבר במחירון של ${po.CDES ?? po.SUPNAME} (או שאין בה פריט עם מק"ט ומחיר).`, result: 'אין מה להוסיף' };
    save(r, { status: 'asked', asked_at: D.nowIso(), handler_id: userId });
    return { text: offerText(withCurrency(r)), buttons: [BTN.all, BTN.pick, BTN.no], draft: draftOf(r, 'pick'), result: `הצעה: ${r.items.length} פריטים` };
  }
  return { text: `לא מצאתי את ההזמנה ${ordname} בחברות שפתוחות לכתיבה.`, result: 'הזמנה לא נמצאה' };
}

// ---------------------------------------------------------------------------
// 🗂 המסך: "פריטים למחירון" במשימון פריוריטי (‎/priority/pricelist‎) — אותו מנוע כמו הבוט
// ---------------------------------------------------------------------------

const err = (status, message) => Object.assign(new Error(message), { status });
const SCREEN_DAYS = 7;

const view = (r, userId) => ({
  id: r.id, company: r.company, companyName: Priority.companyOf(r.company).name, ordname: r.ordname, version: r.version,
  supplier: r.supdes || r.supname, supname: r.supname, project: r.projdes, status: r.status, createdAt: r.created_at, doneAt: r.done_at,
  handler: r.handler_id ? nameOf(r.handler_id) : '', mine: r.handler_id === userId,
  busy: Boolean(r.handler_id && r.handler_id !== userId && ['pending', 'asked'].includes(r.status)),
  list: r.list, lists: r.lists, currency: cur(r.items[0]?.currency),
  items: r.items.map(({ n, part, des, unit, price, prices, pick }) => ({ n, part, des, unit, price, prices: prices ?? 1, pick: pick !== false })),
  written: r.written.map(({ part, des, price }) => ({ part, des, price })),
  canUndo: r.status === 'done' && r.written.length > 0 && Date.parse(r.done_at) >= Date.now() - UNDO_DAYS * 86400000
});

/** ‎{ open, recent, noList }‎ — מה שמחכה, מה שטופל בשבוע האחרון, וספקים בלי מחירון. רק מי שברשימה ומנהלי מערכת */
function forScreen(userId) {
  if (!mayHandle(userId)) throw err(403, 'הוספה למחירון שמורה למי שברשימה "רכש — מחירונים"');
  const since = new Date(Date.now() - SCREEN_DAYS * 86400000).toISOString();
  const pick = (sql, ...a) => D.all(sql, ...a).map((x) => view(row(x.id), userId));
  return {
    enabled: enabled(),
    open: pick("SELECT id FROM po_pricelist_offers WHERE status IN ('pending','asked') ORDER BY created_at DESC LIMIT 100"),
    recent: pick("SELECT id FROM po_pricelist_offers WHERE status IN ('done','declined','undone') AND COALESCE(done_at, created_at) >= ? ORDER BY COALESCE(done_at, created_at) DESC LIMIT 50", since),
    noList: pick("SELECT id FROM po_pricelist_offers WHERE status IN ('no_list','no_list_sent') AND created_at >= ? ORDER BY created_at DESC LIMIT 50", since)
  };
}

/** כמה הצעות מחכות — לכרטיס בבית. ‎null‎ — לא רלוונטי לעובד */
function openCount(userId) {
  if (!mayHandle(userId)) return null;
  return D.get("SELECT COUNT(*) AS n FROM po_pricelist_offers WHERE status IN ('pending','asked')").n;
}

/**
 * פעולה מהמסך על הצעה: ‎{ action: 'write' | 'decline' | 'undo', items: [{ n, pick, price }], list: { name, date } }‎.
 * ‎write‎ — הבחירה, המחירים והמחירון מהמסך, ואז הכתיבה. מחזיר ‎{ text, offer }‎.
 */
async function act(userId, id, body = {}) {
  if (!mayHandle(userId)) throw err(403, 'הוספה למחירון שמורה למי שברשימה "רכש — מחירונים"');
  const r = row(Number(id));
  if (!r) throw err(404, 'ההצעה לא נמצאה');
  const action = String(body.action ?? '');
  if (action === 'undo') {
    const v = view(r, userId);
    if (!v.canUndo) throw err(409, 'אין מה לבטל (או שעברו יותר מיומיים)');
    const errs = await undo(r);
    save(r, { status: 'undone' });
    if (errs.length) alertAdmins(`ביטול ההוספה מ-${r.ordname} נכשל חלקית`, errs.join('\n'));
    return { text: errs.length ? 'חלק מהפריטים לא נמחקו מהמחירון. מנהל המערכת עודכן.' : `בוטל: ${r.written.length} פריטים הוסרו מהמחירון.`, offer: view(r, userId) };
  }
  if (!['pending', 'asked'].includes(r.status)) throw err(409, closed(r, userId) ?? 'ההצעה כבר טופלה');
  if (r.handler_id && r.handler_id !== userId) throw err(409, `${nameOf(r.handler_id)} כבר מטפל בהצעה הזו`);
  if (action === 'decline') {
    save(r, { status: 'declined', handler_id: userId, done_at: D.nowIso() });
    return { text: 'נסגר — לא נוסף למחירון.', offer: view(r, userId) };
  }
  if (action !== 'write') throw err(400, 'פעולה לא מוכרת');
  const want = new Map((Array.isArray(body.items) ? body.items : []).map((x) => [Number(x?.n), x]));
  for (const it of r.items) {
    const w = want.get(it.n);
    if (!w) continue;
    it.pick = Boolean(w.pick);
    const price = Number(w.price);
    if (w.price !== undefined && !(price > 0)) throw err(400, `מחיר לא תקין בשורה ${it.n}`);
    if (w.price !== undefined) it.price = Math.round(price * 10000) / 10000;
  }
  if (body.list) {
    const l = r.lists.find((x) => x.name === body.list.name && x.date === body.list.date);
    if (!l) throw err(400, 'המחירון לא נמצא');
    r.list = l;
  }
  save(r, { items: r.items, list: r.list, handler_id: userId });
  const out = await commit(r, userId);
  if (!out.ok) {
    save(r, { handler_id: null });
    throw err(400, out.text.replace(/\*/g, ''));
  }
  return { text: out.text.replace(/[*_]/g, ''), offer: view(row(r.id), userId) };
}

module.exports = { BTN, KIND, enabled, handlers, mayHandle, offer, flush, send, build, answer, request, isRequest, setHooks, forScreen, openCount, act,
  _internal: { candidates, applicable, net, edit, offerText, summaryText, write, undo, row } };
