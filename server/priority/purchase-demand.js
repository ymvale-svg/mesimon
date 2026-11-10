'use strict';
/**
 * דרישת רכש מהבוט — רשימת פריטים (צילום, הקלטה או הקלדה) ← דרישת רכש בפריוריטי ← "מחכה לאישור".
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md", "דרישת רכש".
 *
 *   1. כותרת: סביבה (חברה), תאריך (ברירת המחדל — היום), פרויקט ומחסן. הסביבה, הפרויקט והמחסן — הבחירה האחרונה
 *      של המשתמש (‎priority-prefs.js‎), ובפעם הראשונה — שואלים. לא עוצרים כשיש ברירת מחדל.
 *   2. הפריטים: צילום של רשימה (מודפסת עדיף, או בכתב יד), הקלטה (מתומללת) או הקלדה. ה-AI מחלץ פריט, כמות ויחידה.
 *   3. לכל פריט — התאמה לקטלוג: זהה ← משויך; קרובים ← "התכוונת ל…" בכפתורים; אין ← מק"ט כללי ‎000‎ עם התיאור,
 *      על תת הפרק והמשאב שהכי מתאימים (יש לפתוח לו מק"ט בעתיד).
 *   4. "סיום 🏁" ← הדרישה נפתחת בפריוריטי ועוברת ל"מחכה לאישור". החותם הבא מקבל הודעה בוואטסאפ
 *      (‎priority-approvals.js‎). אישור — רק בפריוריטי.
 *
 * הבוט כותב רק לחברות שב-‎PRIORITY_COMPANIES‎. עד "סיום" שום דבר לא נכתב בפריוריטי.
 * מצב השיחה — בהגדרה ‎purchase_demand:<userId>‎, וצילומי הרשימה — בתיקיית ההעלאות עד הסוף.
 */
const fs = require('node:fs');
const Paths = require('../core').Paths;
const path = require('node:path');

const D = require('../core').Db;
const Claude = require('../integrations').Claude;
const Priority = require('../integrations').Priority;
const WhatsApp = require('../integrations').Whatsapp;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Prefs = require('./priority-prefs');
const Approvals = require('./priority-approvals');
const { BTN, YES, NO, CANCEL, normalize, label, labels, sameLabel } = require('../whatsapp').WaUi;

const SKILL = Paths.skill('purchase-demand.md');
const TZ = 'Asia/Jerusalem';
const TTL = 24 * 60 * 60 * 1000;
// שיחה פעילה — רק כל עוד העובד באמת עונה: 15 דקות מההודעה האחרונה (הוחלט 10.11.26; אותה הגדרה של שאר
// הבוט — ‎wa_question_ttl_min‎). אחרי זה הודעה חדשה מתחילה מההתחלה; רק לחיצה על כפתור (‎late‎) עוד עונה לשאלה
const idleMs = () => Math.max(1, Number(D.getSetting('wa_question_ttl_min', 15)) || 15) * 60 * 1000;
const FILES_DIR = () => path.join(D.UPLOADS_DIR, 'purchase-demand');

const TRIGGER = /דרישת\s*רכש|דרישות\s*רכש/;
const GR_TRIGGER = /קבלת\s*סחורה/;
// רק כשזו כל ההודעה — "שלח גם 3 שקי מלט" הוא פריט, לא סיום
const DONE = /^(סיום|סיימתי|זהו|זה הכל|זה הכול|תשלח|שלח|לשלוח|שלח לאישור|תשלח לאישור|לאישור)\s*[!.🏁]*$/u;
const NONE = /^(אף אחד|אף אחת|אף אחד מהם|לא אלה|אחר|כללי|מק"?ט כללי)([\s,.!❌]|$)/;
const BTN_NONE = 'אף אחד ❌';

/** הודעות טכניות — רק למנהלי המערכת; לעובד — רק מה שהוא יכול לפתור */
function alertAdmins(user, s, title, details) {
  const body = [`עובד: ${user?.full_name ?? ''}`, s?.company ? `חברה: ${s.company}` : null, s?.prdno ? `דרישה: ${s.prdno}` : null, ...details].filter(Boolean).join('\n');
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🛒 דרישת רכש: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על דרישת רכש:', err.message);
  }
}

/** שליחת הודעה יזומה לעובד (החותם הבא) — נקבע ב-wa-bot (‎setHooks‎) */
const hooks = { send: null };
const setHooks = (h) => Object.assign(hooks, h);

// ---------------------------------------------------------------------------
// מצב
// ---------------------------------------------------------------------------

const key = (userId) => `purchase_demand:${userId}`;
function load(userId) {
  const s = D.getSetting(key(userId), null);
  return s && typeof s === 'object' && s.step ? s : null;
}
function save(userId, s) { D.setSetting(key(userId), { ...s, at: Date.now() }); }
function clear(userId, s) {
  for (const f of s?.files ?? []) { try { fs.unlinkSync(f.path); } catch { /* כבר נמחק */ } }
  D.run('DELETE FROM settings WHERE key = ?', key(userId));
}
const fresh = (s) => s && Date.now() - (s.at ?? 0) < TTL;
/** באמצע שיחה — ההודעה הבאה הולכת לדרישה (רק כשהשיחה טרייה ולא הושהתה) */
const active = (userId, late = false) => { const s = load(userId); return Boolean(fresh(s) && !s.paused && (late || Date.now() - (s.at ?? 0) < idleMs())); };
const pending = (userId) => Boolean(fresh(load(userId)));
const isTrigger = (text) => TRIGGER.test(String(text ?? ''));
const opens = (text) => isTrigger(text);

/** הודעה בנושא אחר כשיש דרישה פתוחה — הדרישה יורדת (עוד לא נכתב כלום בפריוריטי). מחזיר שורת הודעה */
function abandon(user) {
  const s = load(user.id);
  if (!fresh(s)) return '';
  // פגה אחרי 15 דקות בלי תשובה — יורדת בשקט (עוד לא נכתב כלום בפריוריטי)
  const expired = !s.paused && Date.now() - (s.at ?? 0) >= idleMs();
  clear(user.id, s);
  return (s.items ?? []).length && !expired ? 'ℹ️ דרישת הרכש שהתחלת לא נשלחה — עברתי לבקשה החדשה.' : '';
}

// ---------------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------------

const qtyText = (n) => Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 3 });
const ymdHe = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const plusDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
function companyLine(company) {
  const c = Priority.companyOf(company);
  return Priority.isTest(company)
    ? `🧪 סביבה: *${company}* — סביבת בדיקה (${c.name.replace(/ — .*/, '')})`
    : `🏢 סביבה: *${c.name}* (${company}) — *סביבת אמת*`;
}
const codeText = (p) => `${p.code} ${p.des}${p.chapter ? ` · ${p.chapterDes || p.chapter} / ${p.topicDes || p.topic || '—'}` : ''}`;
const partOf = (p, why = '') => ({ code: p.PARTNAME, des: p.PARTDES ?? '', chapter: p.BUD_SUBCHAPTERNAME ?? null, chapterDes: p.BUD_SUBCHAPTERDES ?? '',
  topic: p.BUD_SUBTOPICNAME ?? null, topicDes: p.BUD_SUBTOPICDES ?? '', why });

/** "12.11", "12/11/26", "12.11.2026", "היום", "מחר", "מחרתיים" ← ‎YYYY-MM-DD‎ */
function parseDate(text) {
  const t = String(text ?? '').trim();
  if (/היום/.test(t)) return today();
  if (/מחרתיים/.test(t)) return plusDays(today(), 2);
  if (/מחר/.test(t)) return plusDays(today(), 1);
  const m = t.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
  if (!m) return null;
  const now = today();
  let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(now.slice(0, 4));
  const mo = Number(m[2]), d = Number(m[1]);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  let ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // בלי שנה, ותאריך שעבר לפני יותר מחודש — כנראה השנה הבאה
  if (!m[3] && ymd < plusDays(now, -30)) { y += 1; ymd = `${y}-${ymd.slice(5)}`; }
  return Number.isNaN(Date.parse(ymd)) ? null : ymd;
}

async function saveFile(userId, file) {
  const buf = file.buf ?? await WhatsApp.download(file.url);
  fs.mkdirSync(FILES_DIR(), { recursive: true });
  const mime = file.mime || 'image/jpeg';
  const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
  const p = path.join(FILES_DIR(), `u${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
  fs.writeFileSync(p, buf);
  return { path: p, mime };
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

const str = { type: 'string' };
const num = { type: 'number' };
const ITEM = { type: 'object', properties: { description: str, qty: num, unit: str, note: str }, required: ['description', 'qty', 'unit', 'note'], additionalProperties: false };
const ITEMS_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: ITEM }, unrelated: { type: 'boolean' }, question: str },
  required: ['items', 'unrelated', 'question'], additionalProperties: false
};
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { line: { type: 'integer' }, kind: { type: 'string', enum: ['exact', 'close', 'none'] }, codes: { type: 'array', items: str }, chapter: str, topic: str, why: str },
        required: ['line', 'kind', 'codes', 'chapter', 'topic', 'why'], additionalProperties: false
      }
    }
  },
  required: ['results'], additionalProperties: false
};
const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'remove', 'done', 'cancel', 'unrelated', 'unclear'] },
    adds: { type: 'array', items: ITEM },
    updates: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, qty: num, description: str }, required: ['line', 'qty', 'description'], additionalProperties: false } },
    removes: { type: 'array', items: { type: 'integer' } },
    question: str
  },
  required: ['action', 'adds', 'updates', 'removes', 'question'], additionalProperties: false
};

const skill = () => fs.readFileSync(SKILL, 'utf8');

/** ניתן להחלפה בבדיקות — ‎_ai‎ */
const ai = {
  async itemsFromFile(file) {
    const data = fs.readFileSync(file.path).toString('base64');
    const block = file.mime.includes('pdf')
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.mime.includes('png') ? 'image/png' : 'image/jpeg', data } };
    return Claude.json({ system: skill(), content: [block, { type: 'text', text: 'task: items' }], schema: ITEMS_SCHEMA, effort: 'high', live: true });
  },
  async match(items, pairs) {
    const text = JSON.stringify({
      task: 'match',
      items: items.map((it) => ({ line: it.n, description: it.description, qty: it.qty, unit: it.unit,
        candidates: (it.candidates ?? []).map((c) => ({ code: c.PARTNAME, description: c.PARTDES, chapter: c.BUD_SUBCHAPTERDES ?? '', resource: c.BUD_SUBTOPICDES ?? '' })) })),
      pairs: pairs.slice(0, 150).map((p) => ({ chapter: p.chapter, chapter_name: p.chapterDes, topic: p.topic, topic_name: p.topicDes }))
    });
    return Claude.json({ system: skill(), content: [{ type: 'text', text }], schema: MATCH_SCHEMA, effort: 'medium', live: true });
  },
  async edit(lines, text) {
    const content = JSON.stringify({ task: 'edit', lines: lines.map((l) => ({ line: l.n, description: l.description, qty: l.qty, unit: l.unit })), text });
    return Claude.json({ system: skill(), content: [{ type: 'text', text: content }], schema: EDIT_SCHEMA, effort: 'low', live: true });
  }
};

// ---------------------------------------------------------------------------
// התאמה לקטלוג
// ---------------------------------------------------------------------------

/** עד ‎n‎ משימות במקביל */
async function inBatches(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...await Promise.all(list.slice(i, i + n).map(fn)));
  return out;
}

async function generalPair(s) {
  const g = await Priority.generalCoding(s.company).catch(() => null);
  return g ?? Priority.GENERAL;
}

/**
 * לכל פריט חדש: מועמדים מהקטלוג (תיאור זהה + חיפוש בשפה חופשית), וה-AI מכריע — זהה / קרובים / אין, ותת פרק
 * ומשאב לכל מקרה. בלי AI: התאמה מלאה אחת — משויך; אחרת קרובים מהדירוג.
 */
async function resolveItems(s, items) {
  if (!items.length) return;
  await inBatches(items, 4, async (it) => {
    const exact = await Priority.findPartExact(s.company, it.description).catch(() => null);
    const found = await Priority.searchParts(s.company, it.description).catch(() => []);
    const seen = new Set();
    it.candidates = [exact, ...found.slice(0, 12).map((c) => c.p)].filter((p) => p && (p.STATDES ?? 'פעיל') === 'פעיל' && !seen.has(p.PARTNAME) && seen.add(p.PARTNAME));
    it.exactHit = exact?.PARTNAME ?? null;
  });
  const pairs = await Priority.budgetPairs(s.company).catch(() => []);
  const gen = await generalPair(s);
  let res = [];
  if (Claude.isEnabled()) {
    try { res = (await ai.match(items, pairs)).results ?? []; } catch (err) { console.error('[משימון] התאמת פריטים לדרישת רכש:', err.message); }
  }
  for (const it of items) {
    const r = res.find((x) => x.line === it.n);
    const byCode = (c) => it.candidates.find((p) => p.PARTNAME === c);
    const pair = (r?.chapter && r?.topic && pairs.find((p) => p.chapter === r.chapter && p.topic === r.topic)) || null;
    it.general = pair ? { chapter: pair.chapter, chapterDes: pair.chapterDes, topic: pair.topic, topicDes: pair.topicDes } : { ...gen };
    if (it.exactHit) { it.part = partOf(byCode(it.exactHit), 'תיאור זהה בקטלוג'); it.status = 'ok'; continue; }
    if (r?.kind === 'exact' && byCode(r.codes?.[0])) { it.part = partOf(byCode(r.codes[0]), r.why || 'אותו פריט בקטלוג'); it.status = 'ok'; continue; }
    const close = (r ? (r.codes ?? []).map(byCode) : it.candidates.slice(0, 3)).filter(Boolean).slice(0, 3);
    if (close.length && r?.kind !== 'none') { it.options = close.map((p) => partOf(p, 'נבחר ע"י העובד')); it.status = 'ask'; it.why = r?.why ?? ''; continue; }
    setGeneral(it, r?.why || 'לא נמצא בקטלוג');
  }
  for (const it of items) { delete it.candidates; delete it.exactHit; }
}

function setGeneral(it, why) {
  it.part = { code: '000', des: 'מוצר כללי', ...it.general, why };
  it.status = 'general';
  it.options = null;
}

// ---------------------------------------------------------------------------
// תצוגה
// ---------------------------------------------------------------------------

const reply = (s, text, buttons = [], extra = {}) => { if (s) { s.lastPrompt = text; s.lastButtons = buttons; } return { s, replies: [text], buttons, ...extra }; };

function headerLines(s, { notes = [] } = {}) {
  return [
    companyLine(s.company),
    `📅 תאריך: *${ymdHe(s.date)}*${s.date === today() ? ' (היום)' : ''}`,
    s.project ? `📁 פרויקט: *${s.project.des}* (${s.project.code})${s.projectFrom === 'pref' ? ' — הבחירה האחרונה שלך' : s.projectFrom === 'only' ? ' — הפרויקט היחיד בחברה' : ''}` : null,
    s.warehouse ? `🏬 מחסן: *${s.warehouseName || s.warehouse}* (${s.warehouse})${s.warehouseFrom === 'pref' ? ' — הבחירה האחרונה שלך' : ''}` : null,
    s.demandCode ? `📋 ${s.demandCode.des}${s.codeFrom === 'pref' ? ' — הבחירה האחרונה שלך' : ''}` : null,
    ...notes
  ].filter(Boolean);
}
const CHANGE_HINT = '_לשנות — כתבו "תאריך 12.11", "פרויקט …", "מחסן …", "בדק" / "אתרי" או "סביבה"._';

function itemLine(it) {
  const head = `*${it.n}.* ${it.description} — ${qtyText(it.qty)} ${it.unit || "יח'"}${it.note ? ` _(${it.note})_` : ''}`;
  if (it.status === 'ok') return `${head}\n   ✅ ${codeText(it.part)}`;
  if (it.status === 'general') return `${head}\n   🆕 לא בקטלוג — מק"ט כללי 000 · ${it.part.chapterDes || it.part.chapter} / ${it.part.topicDes || it.part.topic} _(צריך לפתוח לו מק"ט)_`;
  return `${head}\n   ❓ ממתין לבחירה`;
}

function askItems(s, pre = []) {
  s.step = 'items';
  return reply(s, [...pre, '🛒 *דרישת רכש*', ...headerLines(s), CHANGE_HINT, '',
    '📝 *מה צריך?* שלחו את רשימת הפריטים — צילום של רשימה (מודפסת עדיף, או בכתב יד), הקלטה, או הקלדה: פריט וכמות.'].join('\n'), [BTN.cancel]);
}

/** הפריט הבא שמחכה לבחירה — "התכוונת ל…" בכפתורים; אין — הסיכום */
function nextQuestion(s, pre = []) {
  const it = (s.items ?? []).find((x) => x.status === 'ask');
  if (!it) return showList(s, pre);
  s.step = 'pick';
  s.pickLine = it.n;
  const opts = it.options.slice(0, 2);
  const btns = labels(opts.map((p) => p.des));
  opts.forEach((p, i) => { p.btn = btns[i]; });
  const left = s.items.filter((x) => x.status === 'ask').length;
  return reply(s, [...pre,
    `🔎 *${it.description}* — ${qtyText(it.qty)} ${it.unit || "יח'"}${left > 1 ? ` _(עוד ${left - 1} לבחירה אחרי זה)_` : ''}`,
    'לא מצאתי בדיוק את זה בקטלוג. התכוונת ל:',
    ...it.options.map((p) => `• *${p.des}* (${p.code})${p.chapterDes ? ` · ${p.chapterDes}` : ''}`),
    '',
    `אף אחד — נקלט כמק"ט כללי עם התיאור שלכם, על ${it.general.chapterDes || it.general.chapter} / ${it.general.topicDes || it.general.topic}. או כתבו תיאור אחר.`].join('\n'),
  [...opts.map((p) => p.btn), BTN_NONE]);
}

function showList(s, pre = []) {
  s.step = 'review';
  const items = s.items ?? [];
  if (!items.length) return askItems(s, pre);
  const fresh = items.filter((x) => x.status === 'general').length;
  return reply(s, [...pre,
    `🛒 *דרישת רכש — ${items.length} ${items.length === 1 ? 'פריט' : 'פריטים'}*`, ...headerLines(s), '',
    ...items.map(itemLine), '',
    fresh ? `🆕 ${fresh === 1 ? 'פריט אחד לא נמצא' : `${fresh} פריטים לא נמצאו`} בקטלוג — נקלטים כמק"ט כללי, ובעתיד צריך לפתוח להם מק"ט.` : null,
    'אפשר להוסיף עוד (צילום, הקלטה או הקלדה), או לתקן ("שורה 2 — 20", "בלי שורה 3").',
    `*סיום* 🏁 — הדרישה נפתחת בפריוריטי ועוברת *לאישור*.`].filter((x) => x !== null).join('\n'),
  [BTN.done, BTN.cancel]);
}

// ---------------------------------------------------------------------------
// כותרת: סביבה, פרויקט, מחסן
// ---------------------------------------------------------------------------

const writable = () => Priority.allowed();

/**
 * באיזו סביבה (חברה)? כשפתוחות הרבה חברות — כפתורים לשלוש: החברות שבהן העובד פתח דרישות לאחרונה (לפי שם המשתמש שלו
 * בפריוריטי), ואם אין — הראשונות ברשימה; ושם החברה בשפה חופשית ("אלעד", "דניה"). כמה חברות מתאימות לשם — כפתורים.
 */
const companyName = (c) => (Priority.isTest(c) ? `🧪 ${c}` : Priority.companyOf(c).name.replace(/ — .*/, ''));
async function suggestCompanies(s) {
  const list = writable();
  if (list.length <= 3) return list;
  const login = await Approvals.priorityLoginFor({ id: s.uid }).catch(() => null);
  if (login) {
    const hits = await Promise.all(list.map(async (c) => {
      try {
        const r = await Priority._call(c, 'GET', `PURDEMANDS?$filter=${encodeURIComponent(`OWNERLOGIN eq '${login.replace(/'/g, "''")}'`)}&$select=CURDATE&$orderby=CURDATE%20desc&$top=1`);
        return { c, at: r?.value?.[0]?.CURDATE ?? '' };
      } catch { return { c, at: '' }; }
    }));
    const mine = hits.filter((x) => x.at).sort((a, b) => b.at.localeCompare(a.at)).map((x) => x.c);
    if (mine.length) return [...mine, ...list.filter((c) => !mine.includes(c))].slice(0, 3);
  }
  return list.slice(0, 3);
}
async function askCompany(s, pre = [], options = null, head = '🏢 *באיזו חברה לפתוח את הדרישה?*') {
  s.step = 'company';
  const opts = (options ?? await suggestCompanies(s)).slice(0, 3);
  const btns = labels(opts.map(companyName));
  s.companyOptions = opts.map((c, i) => ({ code: c, btn: btns[i] }));
  const many = !options && writable().length > 3;
  return reply(s, [...pre, head, ...opts.map((c) => `• ${companyName(c)} (${c})`), many ? 'או כתבו את שם החברה ("אלעד", "דניה", "מורדות").' : null].filter(Boolean).join('\n'), btns);
}

/** כפתור, קוד, או שם החברה. ‎{ code }‎ — נמצאה; ‎{ many }‎ — כמה חברות מתאימות; ‎null‎ — לא נמצאה */
function pickCompany(s, t) {
  const n = String(t ?? '').trim();
  const byBtn = (s.companyOptions ?? []).find((x) => sameLabel(n, x.btn));
  if (byBtn) return { code: byBtn.code };
  const list = writable();
  if (list.includes(n)) return { code: n };
  if (n.length < 2) return null;
  const norm = (x) => normalize(x).replace(/["'״׳]/g, '').replace(/יי/g, 'י').replace(/וו/g, 'ו');
  const hits = list.filter((c) => norm(Priority.companyOf(c).name).includes(norm(n)));
  return hits.length === 1 ? { code: hits[0] } : hits.length ? { many: hits } : null;
}

/** הכותרת אחרי שנקבעה סביבה: פרויקט (ברירת מחדל או שאלה), מחסן, ואז הפריטים */
async function afterCompany(s, pre = []) {
  if (!s.project) {
    const all = await projectsOf(s.company);
    const last = !s.noPref && Prefs.of(s.uid, s.company)?.project;
    const lastP = last && all.find((p) => p.code === last.code);
    if (lastP) { s.project = lastP; s.projectFrom = 'pref'; }
    else if (all.length === 1) { s.project = all[0]; s.projectFrom = 'only'; }
    else return askProject(s, all, pre);
  }
  await chooseWarehouse(s);
  const ask = await chooseCode(s, pre);
  if (ask) return ask;
  return (s.items ?? []).length ? showList(s, pre) : askItems(s, pre);
}

/*
 * רשימת המאשרים (‎CODENAME‎: "דרישות רכש אתרי" / "דרישות רכש בדק") — ממנה פריוריטי ממלא את המאשרים. בפעם הראשונה
 * בחברה — שואלים, בכפתורים; מכאן — הבחירה האחרונה של המשתמש. לשנות — "אתרי" / "בדק" / "רשימת מאשרים".
 */
async function codesOf(s) { return Priority.demandCodes(s.company).catch(() => []); }
async function chooseCode(s, pre = []) {
  if (s.demandCode !== undefined) return null;
  const codes = await codesOf(s);
  const last = Prefs.of(s.uid, s.company)?.demandCode;
  const hit = last && codes.find((c) => c.code === last);
  if (hit) { s.demandCode = hit; s.codeFrom = 'pref'; return null; }
  if (codes.length <= 1) { s.demandCode = codes[0] ?? null; s.codeFrom = 'only'; return null; }
  return askCode(s, codes, pre);
}
function askCode(s, codes, pre = []) {
  s.step = 'code';
  const opts = codes.slice(0, 3);
  // בלי המילים המשותפות ("דרישות רכש") — "אתרי", "בדק"
  const ws = opts.map((c) => c.des.split(/\s+/));
  let k = 0;
  while (opts.length > 1 && ws.every((w) => w.length > k + 1 && w[k] === ws[0][k])) k++;
  const btns = labels(ws.map((w) => w.slice(k).join(' ')));
  s.codeOptions = opts.map((c, i) => ({ ...c, btn: btns[i] }));
  return reply(s, [...pre, '📋 *איזו דרישה?* (לפי זה נקבעים המאשרים)', ...s.codeOptions.map((c) => `• ${c.des}`), '', '_בפעם הבאה אזכור את הבחירה._'].join('\n'),
    s.codeOptions.map((c) => c.btn));
}
function pickCode(s, t, codes) {
  const n = normalize(t);
  return (s.codeOptions ?? codes).find((c) => sameLabel(t, c.btn ?? label(c.des)) || n === c.code || (n.length >= 3 && normalize(c.des).includes(n))) ?? null;
}

const GR = require('./goods-receipt');
const projectsOf = (company) => GR._projectsOf(company);

/**
 * "לאיזה פרויקט?" — בכפתורים: עד 3 פרויקטים בחברה — כולם; יותר — שני הפרויקטים הנפוצים בדרישות האחרונות של החברה,
 * וכתיבה חופשית ("אלעד 49"). ‎options‎ — תוצאות חיפוש להצגה.
 */
async function askProject(s, all, pre = [], options = null, head = '📁 *לאיזה פרויקט?*') {
  s.step = 'project';
  let opts = options ?? (all.length <= 3 ? all : []);
  let many = (options ?? all).length > 3;
  if (!options && all.length > 3) {
    const recent = await Priority.recentDemandProjects(s.company).catch(() => []);
    opts = recent.map((c) => all.find((p) => p.code === c)).filter(Boolean).slice(0, 2);
    many = true;
  }
  s.projectOptions = opts.slice(0, many ? 2 : 3);
  const btns = labels(s.projectOptions.map((p) => p.des));
  s.projectOptions = s.projectOptions.map((p, i) => ({ ...p, btn: btns[i] }));
  return reply(s, [...pre, head,
    ...s.projectOptions.map((p) => `• ${p.des} (${p.code})`),
    many ? `${s.projectOptions.length ? 'או ' : ''}כתבו את שם הפרויקט במילים שלכם ("אלעד 49", "207", "חיפה עין הים").` : null].filter(Boolean).join('\n'),
  [...s.projectOptions.map((p) => p.btn), BTN.cancel].slice(0, 3));
}

async function chooseWarehouse(s) {
  if (s.warehouse) return;
  const last = Prefs.warehouseFor(s.uid, s.company, s.project?.code);
  const all = (await Priority.warehouses(s.company).catch(() => null)) ?? [];
  const nameOf = (code) => all.find((w) => w.code === code)?.name || '';
  if (last && (!all.length || all.some((w) => w.code === last))) { s.warehouse = last; s.warehouseName = nameOf(last); s.warehouseFrom = 'pref'; return; }
  const opts = await Priority.projectWarehouses(s.company, s.project?.code).catch(() => []);
  const w = opts.find((x) => x.code === 'Main') ?? opts[0];
  s.warehouse = w?.code ?? await Priority.warehouseOf(s.company, s.project?.code).catch(() => 'Main');
  s.warehouseName = w?.name || nameOf(s.warehouse);
  s.warehouseFrom = 'project';
}

/** "תאריך …", "פרויקט …", "מחסן …", "סביבה" — בכל שלב */
const DATE_CMD = /^\s*(?:תאריך|לתאריך|ל-?)\s*[:\-–]?\s*(.+)$/;
const PROJECT_CMD = /^\s*(?:פרויקט|לשנות פרויקט|שנה פרויקט|פרויקט אחר)(?=[\s:\-–]|$)\s*[:\-–]?\s*([\s\S]*)$/;
const WAREHOUSE_CMD = /^\s*(?:מחסן|לשנות מחסן|שנה מחסן|מחסן אחר)(?=[\s:\-–]|$)\s*[:\-–]?\s*([\s\S]*)$/;
const COMPANY_CMD = /^\s*(?:סביבה|סביבה אחרת|חברה|חברה אחרת|לשנות סביבה|לשנות חברה)\s*$/;

async function headerCommand(s, t) {
  const dm = t.match(DATE_CMD);
  if (dm && /^\s*(תאריך|לתאריך)/.test(t)) {
    const d = parseDate(dm[1]);
    if (!d) return reply(s, 'לא הבנתי את התאריך. כתבו למשל "תאריך 12.11" או "תאריך מחר".', s.lastButtons ?? []);
    s.date = d;
    return back(s, `📅 התאריך עודכן ל-*${ymdHe(d)}*.`);
  }
  if (COMPANY_CMD.test(t)) {
    if (writable().length < 2) return back(s, `${companyLine(s.company)}\nזו הסביבה היחידה שפתוחה לדרישות מהבוט.`);
    s.company = null; s.project = null; s.warehouse = null; s.noPref = false; s.demandCode = undefined;
    return askCompany(s);
  }
  if (/^\s*(רשימת מאשרים|מאשרים|סוג דרישה|אתרי|בדק|דרישת רכש (אתרי|בדק)|רכש (אתרי|בדק))\s*$/.test(t)) {
    const codes = await codesOf(s);
    const word = t.match(/אתרי|בדק/)?.[0];
    const c = word && codes.find((x) => x.des.includes(word));
    if (c) { s.demandCode = c; s.codeFrom = 'user'; Prefs.set(s.uid, s.company, 'demandCode', c.code); return back(s, `📋 עודכן: *${c.des}*.`); }
    if (codes.length > 1) return askCode(s, codes);
    return back(s, codes.length ? `📋 ${codes[0].des} — הרשימה היחידה בחברה.` : '📋 אין בחברה רשימות מאשרים לדרישות.');
  }
  const pm = t.match(PROJECT_CMD);
  if (pm) {
    s.project = null; s.warehouse = null; s.noPref = true;
    const what = pm[1].replace(/\s+/g, ' ').trim();
    const all = await projectsOf(s.company);
    if (!what || /^אחר$/.test(what)) return askProject(s, all);
    return projectAnswer(s, what, all);
  }
  const wm = t.match(WAREHOUSE_CMD);
  if (wm) {
    const all = ((await Priority.warehouses(s.company).catch(() => null)) ?? []);
    const what = wm[1].trim();
    const w = what && all.find((x) => x.code === what || (what.length >= 2 && (x.name ?? '').includes(what)));
    if (w) { s.warehouse = w.code; s.warehouseName = w.name; s.warehouseFrom = 'user'; return back(s, `🏬 המחסן עודכן ל-*${w.name || w.code}* (${w.code}).`); }
    s.step = 'warehouse';
    s.warehouseOptions = all.slice(0, 9).map((x) => ({ code: x.code, name: x.name }));
    return reply(s, ['🏬 *לאיזה מחסן?* כתבו את שם המחסן או הקוד:', ...s.warehouseOptions.map((x) => `• ${x.name || x.code} (${x.code})${x.code === s.warehouse ? ' ← עכשיו' : ''}`)].join('\n'), [BTN.cancel]);
  }
  return null;
}

/** חזרה לשלב שבו היינו (פריטים / בחירה / סיכום), עם שורת עדכון */
function back(s, note) {
  if ((s.items ?? []).some((x) => x.status === 'ask')) return nextQuestion(s, [note, '']);
  if ((s.items ?? []).length) return showList(s, [note, '']);
  return askItems(s, [note, '']);
}

async function projectAnswer(s, t, all) {
  const byBtn = (s.projectOptions ?? []).find((p) => sameLabel(t, p.btn ?? label(p.des)));
  const code = t.match(/PR\d+/i)?.[0]?.toUpperCase();
  let p = byBtn ?? (code ? all.find((x) => x.code === code) : null);
  if (!p && s.projectPending) {
    if (YES.test(t)) p = s.projectPending;
    s.projectPending = null;
    if (!p && NO.test(t)) return askProject(s, all, [], null, '📁 לאיזה פרויקט, אם כך?');
  }
  if (!p) {
    const found = await GR._findProjects(all, t);
    if (!found.list.length && found.unrelated) return null;
    if (found.list.length === 1 && found.by === 'code') p = found.list[0];
    else if (found.list.length === 1) {
      s.step = 'project';
      s.projectPending = found.list[0];
      return reply(s, `📁 *${found.list[0].des}* (${found.list[0].code})?`, [BTN.yes, BTN.no]);
    } else if (found.list.length) {
      return askProject(s, all, [], found.list, found.list.length > 3 ? '📁 לאיזה מהם התכוונת? (או כתבו שם מדויק יותר)' : '📁 לאיזה מהם התכוונת?');
    } else {
      return askProject(s, all, [], all.length <= 3 ? all : null, found.question || '📁 לא מצאתי פרויקט כזה. כתבו במילים אחרות (למשל "אלעד 49"), או קוד (PR…).');
    }
  }
  const { btn, ...proj } = p;
  s.project = proj;
  s.projectFrom = 'user';
  s.projectOptions = null;
  s.warehouse = null;
  await chooseWarehouse(s);
  const askC = await chooseCode(s, [`📁 פרויקט: *${p.des}* (${p.code})`, '']);
  if (askC) return askC;
  return back(s, `📁 פרויקט: *${p.des}* (${p.code}) · 🏬 מחסן: *${s.warehouseName || s.warehouse}* (${s.warehouse})`);
}

// ---------------------------------------------------------------------------
// פריטים
// ---------------------------------------------------------------------------

function renumber(s) { (s.items ?? []).forEach((it, i) => { it.n = i + 1; }); }

async function addItems(s, list) {
  const clean = (list ?? []).filter((x) => String(x.description ?? '').trim()).map((x) => ({
    description: String(x.description).trim().slice(0, 120), qty: Number(x.qty) > 0 ? Number(x.qty) : 1, unit: String(x.unit ?? '').trim() || "יח'", note: String(x.note ?? '').trim()
  }));
  if (!clean.length) return [];
  s.items ??= [];
  const start = s.items.length;
  const added = clean.map((x, i) => ({ ...x, n: start + i + 1, status: 'new' }));
  s.items.push(...added);
  await resolveItems(s, added);
  return added;
}

async function onFile(user, s, file) {
  const saved = await saveFile(user.id, file);
  (s.files ??= []).push(saved);
  if (!Claude.isEnabled()) return reply(s, 'קריאת רשימות מצילום דורשת חיבור AI, שעוד לא הוגדר בשרת. הקלידו את הפריטים, או *ביטול*.', [BTN.cancel]);
  const out = await ai.itemsFromFile(saved);
  const added = await addItems(s, out.items);
  if (!added.length) return reply(s, out.question || 'לא מצאתי פריטים בצילום. נסו צילום ברור יותר (רשימה מודפסת עדיף), או הקלידו / הקליטו את הפריטים.', [BTN.cancel]);
  return nextQuestion(s, [`📷 קראתי ${added.length} ${added.length === 1 ? 'פריט' : 'פריטים'} מהצילום.`, '']);
}

async function onText(user, s, t) {
  const out = await ai.edit(s.items ?? [], t);
  if (out.action === 'unrelated') return null;
  if (out.action === 'cancel') return { s: null, replies: ['דרישת הרכש בוטלה. לא נכתב דבר בפריוריטי.'], buttons: [], result: 'ביטול' };
  if (out.action === 'done' && (s.items ?? []).length) return submit(user, s);
  const notes = [];
  const removes = [...new Set(out.removes ?? [])].filter((n) => s.items?.some((x) => x.n === n));
  if (removes.length) { s.items = s.items.filter((x) => !removes.includes(x.n)); notes.push(`🗑️ הוסרו: שורה ${removes.join(', ')}.`); renumber(s); }
  const changed = [];
  for (const u of out.updates ?? []) {
    const it = s.items?.find((x) => x.n === u.line);
    if (!it) continue;
    if (Number(u.qty) > 0) it.qty = Number(u.qty);
    if (String(u.description ?? '').trim() && u.description.trim() !== it.description) { it.description = u.description.trim(); it.status = 'new'; changed.push(it); }
    notes.push(`✏️ שורה ${it.n}: ${it.description} — ${qtyText(it.qty)} ${it.unit}`);
  }
  if (changed.length) await resolveItems(s, changed);
  const added = await addItems(s, out.adds);
  if (added.length) notes.push(added.length === 1 ? "➕ נוסף פריט אחד." : `➕ נוספו ${added.length} פריטים.`);
  if (!notes.length) {
    if (out.action === 'done') return reply(s, 'עוד אין פריטים ברשימה. שלחו צילום, הקלטה או הקלדה של מה שצריך.', [BTN.cancel]);
    return reply(s, out.question || 'לא הבנתי. שלחו פריטים (פריט וכמות), תיקון ("שורה 2 — 20"), או *סיום* 🏁.', s.lastButtons ?? [BTN.cancel]);
  }
  return nextQuestion(s, [...notes, '']);
}

/** תשובה ל"התכוונת ל…" — כפתור, "אף אחד", או תיאור אחר (חיפוש מחדש) */
async function onPick(user, s, t, { reaction = false } = {}) {
  const it = s.items.find((x) => x.n === s.pickLine && x.status === 'ask');
  if (!it) return nextQuestion(s);
  const opt = it.options.find((p) => sameLabel(t, p.btn ?? label(p.des)) || normalize(t) === normalize(p.des) || t.trim() === p.code);
  if (opt) { const { btn, ...part } = opt; it.part = part; it.status = 'ok'; it.options = null; return nextQuestion(s, [`✅ ${it.description} ← ${opt.des} (${opt.code})`, '']); }
  if (NONE.test(t) || sameLabel(t, BTN_NONE) || (reaction && NO.test(t))) {
    setGeneral(it, 'לא בקטלוג — נבחר ע"י העובד');
    return nextQuestion(s, [`🆕 ${it.description} ← מק"ט כללי 000 (${it.general.chapterDes || it.general.chapter} / ${it.general.topicDes || it.general.topic})`, '']);
  }
  if (YES.test(t)) return reply(s, 'בחרו אחד מהכפתורים, *אף אחד* ❌, או כתבו תיאור אחר.', s.lastButtons ?? []);
  if (DONE.test(t)) return reply(s, `קודם — *${it.description}*: בחרו אחד מהכפתורים, או *אף אחד* ❌.`, s.lastButtons ?? []);
  // מק"ט מפורש
  const code = t.match(/[A-Za-z]*\d[\w]*(?:-[\w]+)+/)?.[0];
  if (code) {
    const p = await Priority.partByCode(s.company, code.toUpperCase()).catch(() => null);
    if (!p) return reply(s, `אין מק"ט ${code} בחברה הזו. בחרו מהכפתורים, *אף אחד* ❌, או תיאור אחר.`, s.lastButtons ?? []);
    it.part = partOf(p, 'נבחר ע"י העובד'); it.status = 'ok'; it.options = null;
    return nextQuestion(s, [`✅ ${it.description} ← ${it.part.des} (${it.part.code})`, '']);
  }
  // תשובה ארוכה שאינה תיאור — אולי תיקון לרשימה או בקשה אחרת
  if (t.split(/\s+/).length >= 7) return onText(user, s, t);
  it.description = t.trim().slice(0, 120);
  it.status = 'new';
  await resolveItems(s, [it]);
  return nextQuestion(s);
}

// ---------------------------------------------------------------------------
// סיום: פתיחה בפריוריטי ומעבר לאישור
// ---------------------------------------------------------------------------

/** "ישראל כהן" — לשדה ‎DETAILS‎ (עד 24 תווים) */
const detailsOf = (user) => `בוט: ${String(user?.full_name ?? '').trim()}`.slice(0, 24);

async function submit(user, s) {
  const open = s.items.filter((x) => x.status === 'ask');
  if (open.length) return nextQuestion(s, ['קודם צריך לבחור לפריטים שנשארו פתוחים:', '']);
  const c = s.company;
  if (!writable().includes(c)) return reply(s, 'הסביבה הזו אינה פתוחה לכתיבה מהבוט. כתבו *סביבה* לבחירת סביבה אחרת, או *ביטול*.', [BTN.cancel]);
  let prdno;
  // הבעלים בפריוריטי — העובד עצמו (לפי המייל / השם במסך המשתמשים); לא נמצא — משתמש ה-API, והשם בדו-שיח
  const owner = await Approvals.priorityLoginFor(user).catch(() => null);
  try {
    prdno = await Priority.createDemand(c, { date: s.date, project: s.project?.code, warehouse: s.warehouse, details: detailsOf(user), owner, approvalCode: s.demandCode?.code ?? null });
  } catch (err) {
    // מחסן שנדחה — בלי מחסן (פריוריטי ממלא את מחסן הפרויקט)
    try { prdno = await Priority.createDemand(c, { date: s.date, project: s.project?.code, details: detailsOf(user), approvalCode: s.demandCode?.code ?? null }); s.notes = [...(s.notes ?? []), `הכותרת נדחתה (${err.message}) — נפתחה בלי מחסן${owner ? ' ובלי בעלים' : ''}`]; } catch (err2) {
      alertAdmins(user, s, 'הדרישה לא נפתחה בפריוריטי', [err2.message]);
      return reply(s, 'לא הצלחתי לפתוח את הדרישה בפריוריטי. מנהל המערכת קיבל פירוט. הרשימה שמורה — נסו *סיום* שוב בעוד כמה דקות, או *ביטול*.', [BTN.done, BTN.cancel], { status: 'error', result: `פתיחה נכשלה: ${err2.message}` });
    }
  }
  s.prdno = prdno;
  save(user.id, s);
  const problems = [];
  const gen = await generalPair(s);
  for (const it of s.items) {
    // המק"ט הכללי נמדד ב"יח'" ומקבל רק כמות שלמה — יחידה אחרת (קוב, מ"ר) או כמות שבורה נכתבות בתיאור
    const whole = Number.isInteger(Number(it.qty));
    const unitless = /^יח/.test(it.unit || "יח'");
    const desc = !whole ? `${qtyText(it.qty)} ${it.unit} · ${it.description}` : unitless ? it.description : `${it.description} · ${it.unit}`;
    const line = it.part.code === '000'
      ? { part: '000', description: `${desc}${it.note ? ` (${it.note})` : ''}`, qty: whole ? it.qty : 1, chapter: it.part.chapter, topic: it.part.topic }
      : { part: it.part.code, qty: it.qty, chapter: it.part.chapter, topic: it.part.topic };
    try {
      await Priority.addDemandLine(c, prdno, line);
    } catch (err) {
      // רשת ביטחון: מק"ט כללי 000 עם התיאור, על הקידוד הכללי של החברה
      try {
        await Priority.addDemandLine(c, prdno, { part: '000', description: desc, qty: whole ? it.qty : 1, chapter: gen.chapter, topic: gen.topic });
        (s.notes ??= []).push(`שורה ${it.n} (${it.description}) נקלטה על מק"ט כללי 000, ${gen.chapter}/${gen.topic}${it.part.code !== '000' ? ` — ${it.part.code} נדחה` : ''}`);
        problems.push(`שורה ${it.n}: ${line.part} נדחה (${err.message}), נקלטה על 000 ${gen.chapter}/${gen.topic}`);
      } catch (err2) {
        problems.push(`שורה ${it.n} (${it.description}) לא נקלטה: ${err.message} / 000: ${err2.message}`);
        it.failed = true;
      }
    }
  }
  for (const f of s.files ?? []) {
    try { await Priority.attachDemand(c, prdno, { buf: fs.readFileSync(f.path), mime: f.mime, description: 'רשימת הפריטים מהבוט' }); } catch (err) { problems.push(`נספח: ${err.message}`); }
  }
  await Priority.setDemandDialog(c, prdno, [
    'דרישת רכש דרך בוט משימון',
    `נפתחה ע"י: ${user.full_name}${owner ? ` (${owner})` : ''} | ${nowHe()}`,
    s.files?.length ? 'רשימת הפריטים המקורית — בנספחים' : null,
    ...s.items.filter((x) => x.status === 'general').map((x) => `לא בקטלוג (צריך לפתוח מק"ט): ${x.description} — ${qtyText(x.qty)} ${x.unit}`),
    ...s.items.filter((x) => x.note).map((x) => `הערה לשורה ${x.n}: ${x.note}`),
    ...(s.notes ?? [])
  ]).catch((err) => problems.push(`דו-שיח פנימי: ${err.message}`));
  Prefs.remember(user.id, { company: c, project: s.project, warehouse: s.warehouse });
  if (s.demandCode?.code) Prefs.set(user.id, c, 'demandCode', s.demandCode.code);

  const failed = s.items.filter((x) => x.failed);
  if (failed.length) {
    alertAdmins(user, s, 'חלק מהשורות לא נקלטו', problems);
    return reply(s, `⚠️ *דרישת רכש ${prdno}* נפתחה בפריוריטי כטיוטא, אבל ${failed.map((x) => `"${x.description}"`).join(', ')} לא ${failed.length === 1 ? 'נקלט' : 'נקלטו'}, ולכן היא עוד לא נשלחה לאישור. מנהל המערכת קיבל פירוט.`,
      [], { s: null, status: 'error', result: `${prdno} טיוטא; שורות נכשלו` });
  }
  if (problems.length) alertAdmins(user, s, 'הערות בקליטה', problems);

  // מעבר לאישור — פריוריטי ממלא את רשימת המאשרים
  try {
    await Priority.submitDemand(c, prdno);
  } catch (err) {
    alertAdmins(user, s, 'הדרישה לא עברה לאישור', [Priority.isNoApproversError(err) ? 'אין בפריוריטי רשימת מאשרים שמתאימה לדרישה (רשימות מאשרים לדרישות רכש). צריך להגדיר רשימה — או להעביר לאישור ידנית.' : '', err.message].filter(Boolean));
    return { s: null, replies: [[`📝 *דרישת רכש ${prdno}* נפתחה בפריוריטי (${s.items.length} ${s.items.length === 1 ? 'פריט' : 'פריטים'}), אבל עוד *לא עברה לאישור* — חסרה הגדרה בפריוריטי.`,
      'מנהל המערכת קיבל פירוט ויעביר אותה לאישור.', companyLine(c)].join('\n')], buttons: [], status: 'error', result: `${prdno} טיוטא: ${err.message}` };
  }
  // החותם הבא — הודעה בוואטסאפ
  let signerLine = '';
  try {
    const d = await Priority.readDemand(c, prdno);
    const r = hooks.send ? await Approvals.notifyDemand(c, d, hooks.send) : { signer: Priority.nextSigner(d), user: null, sent: false };
    const name = r.user?.full_name || r.signer;
    signerLine = !r.signer ? '' : r.sent ? `✍️ החותם הבא: *${name}* — קיבל הודעה בוואטסאפ.` : `✍️ החותם הבא: *${name}*.`;
  } catch (err) {
    console.error('[משימון] החותם הבא לדרישת רכש:', err.message);
  }
  clear(user.id, s);
  return { s: null, replies: [[`✅ *דרישת רכש ${prdno}* נפתחה ועברה *לאישור*.`, companyLine(c),
    `📁 ${s.project?.des ?? ''} · ${s.items.length} ${s.items.length === 1 ? 'פריט' : 'פריטים'} · 📅 ${ymdHe(s.date)}`, signerLine].filter(Boolean).join('\n')], buttons: [], status: 'ok', result: `${prdno} — מחכה לאישור` };
}

// ---------------------------------------------------------------------------
// כניסה
// ---------------------------------------------------------------------------

async function start(user, pre = []) {
  const s = { step: 'start', uid: user.id, startedAt: Date.now(), date: today(), items: [], files: [] };
  const list = writable();
  const last = Prefs.lastCompany(user.id);
  if (last && list.includes(last)) s.company = last;
  else if (list.length === 1) s.company = list[0];
  else return askCompany(s, pre);
  return afterCompany(s, pre);
}

/**
 * הודעה של העובד בדרישת הרכש — טקסט (גם תמלול של הקלטה), קובץ, או שניהם.
 * ‎{ replies, buttons, status, result, pass }‎ — ‎pass‎: ההודעה אינה לדרישה, והבוט הרגיל מטפל בה.
 */
async function handle({ user, text = '', file = null, reaction = false, voice = false }) {
  const t = normalize(text);
  let s = load(user.id);
  if (s && !fresh(s)) { clear(user.id, s); s = null; }
  if (!Priority.isEnabled()) return { replies: ['החיבור לפריוריטי עוד לא הוגדר בשרת. פנו למנהל המערכת.'], status: 'error', result: 'פריוריטי לא מוגדר' };
  if (!writable().length) return { replies: ['אין סביבה שפתוחה לכתיבה מהבוט. פנו למנהל המערכת.'], status: 'error', result: 'PRIORITY_COMPANIES ריק' };
  const heard = voice && t ? [`🎙 *שמעתי:* "${t}"`, ''] : [];

  // "דרישת רכש" — התחלה (או המשך של דרישה פתוחה)
  if (!s || (isTrigger(t) && !file && !s.items?.length && s.step !== 'code')) {
    if (isTrigger(t) && CANCEL.test(t.replace(TRIGGER, '').trim())) { if (s) clear(user.id, s); return { replies: [s ? 'דרישת הרכש בוטלה.' : 'אין דרישת רכש פתוחה.'], status: 'ok', result: 'ביטול' }; }
    const out = await start(user, heard);
    if (out.s) save(user.id, out.s);
    // תמונה או רשימה כבר בהודעה הראשונה ("דרישת רכש: 10 שקי מלט…")
    const rest = t.replace(TRIGGER, '').replace(/^[\s:\-–,]+/, '').trim();
    if (out.s?.step === 'items' && (file || rest.split(/\s+/).length >= 2)) {
      const r2 = await (file ? onFile(user, out.s, file) : onText(user, out.s, rest)) ?? out;
      if (heard.length && r2 !== out && r2.replies?.length) r2.replies[0] = `${heard.join('\n')}\n${r2.replies[0]}`;
      return finish(user, out.s, r2);
    }
    return finish(user, out.s, out, 'התחלה');
  }
  s.uid = user.id;
  if (s.paused) s.paused = false;
  if (isTrigger(t) && !file && s.step !== 'code') return finish(user, s, s.lastPrompt ? reply(s, `🛒 ממשיכים בדרישת הרכש:\n\n${s.lastPrompt}`, s.lastButtons ?? []) : showList(s), 'המשך');
  if (GR_TRIGGER.test(t)) { save(user.id, { ...s, paused: true }); return { pass: true, replies: [], status: 'ok', result: 'מעבר לקבלת סחורה' }; }
  if (!file && (CANCEL.test(t) || sameLabel(t, BTN.cancel))) { clear(user.id, s); return { replies: ['דרישת הרכש בוטלה. לא נכתב דבר בפריוריטי.'], status: 'ok', result: 'ביטול' }; }

  // 👎 כהודעה נפרדת — שלב אחד אחורה (לפני "סיום" — עוד לא נכתב כלום בפריוריטי)
  if (t === '👎' && !reaction && !file && s.prev) {
    const backS = JSON.parse(s.prev);
    save(user.id, backS);
    return { replies: [`↩️ חזרתי שלב אחד אחורה.${backS.lastPrompt ? `\n\n${backS.lastPrompt}` : ''}`], buttons: backS.lastButtons ?? [], status: 'ok', result: 'שלב אחורה' };
  }
  const snap = JSON.stringify({ ...s, prev: null });
  let out;
  try {
    out = await step(user, s, t, file, { reaction });
  } catch (err) {
    console.error('[משימון] דרישת רכש:', err.message);
    save(user.id, s);
    alertAdmins(user, s, 'תקלה', [`שלב: ${s.step}`, err.message]);
    return { replies: ['משהו השתבש. נסו שוב בעוד דקה, או *ביטול*.'], buttons: [BTN.cancel], status: 'error', result: `שלב ${s.step}: ${err.message}` };
  }
  if (!out) {
    // לא לדרישה — הבוט הרגיל מטפל; הדרישה מושהית
    save(user.id, { ...s, paused: true });
    return { pass: true, replies: [], status: 'ok', result: `לא לדרישת רכש (שלב ${s.step})` };
  }
  if (out.s) out.s.prev = snap;
  if (heard.length && out.replies?.length) out.replies[0] = `${heard.join('\n')}\n${out.replies[0]}`;
  return finish(user, s, out);
}

function finish(user, s, out, result = null) {
  if (out.s === null) clear(user.id, s);
  else if (out.s) save(user.id, out.s);
  return { replies: out.replies ?? [], files: out.files ?? [], buttons: out.s === null ? [] : out.buttons ?? [], status: out.status ?? 'ok', result: out.result ?? result ?? `שלב ${out.s?.step ?? 'סיום'}`, prdno: out.s?.prdno ?? s?.prdno ?? null };
}

async function step(user, s, t, file, { reaction }) {
  // שינוי כותרת — בכל שלב (חוץ מבחירת סביבה)
  if (!file && s.company && s.step !== 'company') {
    const h = await headerCommand(s, t);
    if (h) return h;
  }
  switch (s.step) {
    case 'company': {
      const hit = pickCompany(s, t);
      if (hit?.many) return askCompany(s, [], hit.many, `🏢 יש כמה חברות בשם הזה${hit.many.length > 3 ? ' (כתבו שם מדויק יותר)' : ''}:`);
      if (!hit) return t.split(/\s+/).length >= 6 ? null : askCompany(s, [], null, '🏢 לא מצאתי חברה בשם הזה. באיזו חברה?');
      s.company = hit.code;
      return afterCompany(s);
    }
    case 'project': {
      if (file) return reply(s, 'קודם הפרויקט — ואז הרשימה.', s.lastButtons ?? []);
      const all = await projectsOf(s.company);
      return projectAnswer(s, t, all);
    }
    case 'code': {
      const codes = await codesOf(s);
      const c = pickCode(s, t, codes);
      if (!c) return t.split(/\s+/).length >= 6 ? null : askCode(s, codes);
      s.demandCode = c; s.codeFrom = 'user';
      Prefs.set(s.uid, s.company, 'demandCode', c.code);
      return back(s, `📋 *${c.des}* — אזכור לפעם הבאה.`);
    }
    case 'warehouse': {
      const opts = s.warehouseOptions ?? [];
      const w = opts.find((x) => x.code === t.trim() || (t.trim().length >= 2 && (x.name ?? '').includes(t.trim())));
      if (!w) return t.split(/\s+/).length >= 6 ? null : reply(s, 'כתבו את שם המחסן או הקוד מהרשימה, או *ביטול*.', [BTN.cancel]);
      s.warehouse = w.code; s.warehouseName = w.name; s.warehouseFrom = 'user';
      return back(s, `🏬 המחסן עודכן ל-*${w.name || w.code}* (${w.code}).`);
    }
    case 'pick':
      if (file) return onFile(user, s, file);
      return onPick(user, s, t, { reaction });
    case 'items':
    case 'review': {
      if (file) return onFile(user, s, file);
      if (!t) return reply(s, s.lastPrompt ?? 'שלחו את רשימת הפריטים.', s.lastButtons ?? []);
      if (s.step === 'review' && (DONE.test(t) || sameLabel(t, BTN.done) || t === '👍')) return submit(user, s);
      if (s.step === 'items' && (DONE.test(t) || sameLabel(t, BTN.done))) return reply(s, 'עוד אין פריטים ברשימה. שלחו צילום, הקלטה או הקלדה של מה שצריך.', [BTN.cancel]);
      if (!Claude.isEnabled()) return reply(s, 'הבנת הרשימה דורשת חיבור AI, שעוד לא הוגדר בשרת.', [BTN.cancel]);
      return onText(user, s, t);
    }
    default:
      return afterCompany(s);
  }
}

module.exports = { isTrigger, opens, active, pending, abandon, handle, setHooks, _parseDate: parseDate, _resolveItems: resolveItems, _ai: ai, _load: load, _clear: (userId) => clear(userId, load(userId)), _label: label, _labels: labels, _sameLabel: sameLabel };
