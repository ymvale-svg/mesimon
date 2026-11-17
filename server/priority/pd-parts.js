'use strict';
/**
 * 🆕 מק"טים לבנייה — פריטים בדרישת רכש שאין להם מק"ט בפריוריטי (הוחלט 17.11.26).
 *
 * האפיון: "אפיון — סריקת מסמכי רכש לפריוריטי.md", "דרישת רכש ← מק"טים לבנייה".
 *
 *   דרישת רכש — *לא* יוצאת עם מק"ט כללי 000 (הוחלט 17.11.26):
 *   1. "אף אחד" ל"התכוונת ל…" — הפריט בלי מק"ט. ב"סיום": *רק המזוהים* (הדרישה יוצאת בלעדיהם, ‎partial‎) או
 *      *לחכות לרכש* (שום דבר לא נכתב, ‎wait‎). בשני המקרים — מייל דרך משימון למנהלת הרכש, בלי שאלה:
 *      "מק"טים נדרשים לבנייה בהקדם — לבקשת <העובד>".
 *   2. סבב (כל 20 דקות): לכל פריט — מק"ט פעיל *חדש* בקטלוג (שלא היה כשנשלחה הבקשה) עם שם דומה.
 *   3. כשכל המק"טים נבנו — ליוזם בבוט *ובמייל*: "המק"טים החסרים נבנו", הרשימה, ו"להמשיך בדרישת הרכש עם הכמויות
 *      והמק"טים?" *כן* ← הדרישה נטענת מוכנה (‎purchase-demand.js‎, ‎startRebuild‎): ב-‎wait‎ — כל הדרישה; ב-‎partial‎ —
 *      החסרים בלבד (השאר כבר יצא). "סיום" שולח אותה.
 *   קבלת סחורה (‎goods-receipt.js‎): שאלה "לשלוח לרכש?" בשלב המק"טים; הקליטה ממשיכה על 000, וכשנבנו — רק הודעה (‎receipt‎).
 *
 * מנהלת הרכש — בהגדרות פריוריטי (‎/priority‎ ← הגדרות: ‎buyerName‎, ‎buyerEmail‎). לא הוגדרה — בדרישה: רק המזוהים, והרשימה
 * למנהלי המערכת; בקבלת סחורה — בלי שאלה.
 */
const crypto = require('node:crypto');
const D = require('../core').Db;
const Auth = require('../core').Auth;
const P = require('../core').Permissions;
const Priority = require('../integrations').Priority;
const Mailer = require('../integrations').Mailer;
const Gmail = require('../integrations').Gmail;
const Settings = require('./priority-settings');
const { YES, NO, normalize, sameLabel } = require('../whatsapp').WaUi;

const TICK = 20 * 60 * 1000;
// כיתובים משלה — כדי ש"כן" לשאלה אחרת של הבוט לא ייתפס כאן. "כן" / 👍 סתמי — רק בחצי היום שאחרי השאלה
const BTN_REBUILD = 'כן, להמשיך ✅';
const BTN_MORE = 'כן, דרישה נוספת ✅';
const BTN_SKIP = 'לא, תודה ❌';
const PLAIN_HOURS = 12;
const KEEP_DAYS = 60;
const ASK_DAYS = 7;
const TZ = 'Asia/Jerusalem';

/** ‎send(userId, text)‎ / ‎ask(userId, text, buttons)‎ — הודעה יזומה בוואטסאפ (‎wa-tasks.js‎, דרך ‎PurchaseDemand.setHooks‎) */
const hooks = { send: null, ask: null };
const setHooks = (h) => Object.assign(hooks, h);

const qty = (n) => Number(n ?? 0).toLocaleString('he-IL', { maximumFractionDigits: 3 });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nowHe = () => new Date().toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const row = (id) => { const r = D.get('SELECT * FROM pd_part_requests WHERE id = ?', id); return r ? { ...r, header: parse(r.header, {}), items: parse(r.items, []), missing: parse(r.missing, []) } : null; };

function alertAdmins(title, body) {
  try {
    for (const u of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      const actor = Auth.loadActor('user', u.id);
      if (actor && P.can(actor, 'manage_automations')) D.notify({ targetType: 'user', targetId: u.id, kind: 'ai', title: `🆕 מק"טים לבנייה: ${title}`, body });
    }
  } catch (err) {
    console.error('[משימון] התראה למנהלים על מק"טים לבנייה:', err.message);
  }
}

// ---------------------------------------------------------------------------
// מנהלת הרכש
// ---------------------------------------------------------------------------

/** ‎{ name, email, userId }‎ — מי שמוגדרת בהגדרות פריוריטי; ‎null‎ — לא הוגדרה (אין שאלות, הזרימה הישנה) */
function contact() {
  const d = Settings.defaults();
  const email = String(d.buyerEmail ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const u = D.get("SELECT id, full_name FROM users WHERE lower(email) = lower(?) AND status = 'active'", email);
  return { email, name: String(d.buyerName ?? '').trim() || u?.full_name || 'מנהלת הרכש', userId: u?.id ?? null };
}

// ---------------------------------------------------------------------------
// המייל
// ---------------------------------------------------------------------------

const unitOf = (it) => it.unit || "יח'";
const codingOf = (it) => (it.general ? `${it.general.chapterDes || it.general.chapter || ''} / ${it.general.topicDes || it.general.topic || ''}` : '');

/** ‎receipt‎ — מקבלת סחורה (‎goods-receipt.js‎): הקליטה ממשיכה על 000, ובלי בנייה מחדש בהמשך */
/** כתובת המערכת (‎public_url‎) — בלעדיה אין קישור לדף התשובה של הרכש */
const baseUrl = () => String(D.getSetting('public_url', '') ?? '').trim().replace(/\/+$/, '');
const answerLink = (token) => (baseUrl() && token ? `${baseUrl()}/parts.html?t=${token}` : '');

function mailOf(user, s, list, to, { source = 'demand', mode = 'wait', token = null } = {}) {
  const link = answerLink(token);
  const company = Priority.companyOf(s.company);
  const receipt = source === 'receipt';
  const via = receipt ? 'קבלת סחורה מבוט משימון' : 'דרישת רכש מבוט משימון';
  const after = receipt
    ? `הסחורה נקלטה בינתיים על מק"ט כללי 000. כשכרטיסי הפריט ייבנו, ${user.full_name} יקבל הודעה בבוט, ובפעם הבאה הבוט ימצא אותם לבד.`
    : `${mode === 'partial' ? 'הדרישה יוצאת בינתיים עם הפריטים שזוהו.' : 'הדרישה ממתינה לבניית המק"טים.'} כשכרטיסי הפריט ייבנו בפריוריטי (בשם דומה), ${user.full_name} יקבל הודעה בבוט ובמייל וימשיך בדרישה עם המק"טים המדויקים.`;
  const subject = `מק"טים נדרשים לבנייה בהקדם — לבקשת ${user.full_name}`;
  const facts = [
    ['חברה', `${company?.name ?? s.company} (${s.company})`],
    s.project ? ['פרויקט', `${s.project.des} (${s.project.code})`] : null,
    s.supplier ? ['ספק', `${s.supplier.name} (${s.supplier.code})`] : null,
    s.doc?.doc_number ? ['מסמך הספק', s.doc.doc_number] : null,
    ['לבקשת', user.full_name],
    ['תאריך', nowHe()]
  ].filter(Boolean);
  const text = [
    `שלום ${to.name},`, '',
    `להלן מק"טים נדרשים לבנייה בהקדם, לבקשת ${user.full_name} (${via}):`, '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '',
    ...list.map((it, i) => `${i + 1}. ${it.description} — ${qty(it.qty)} ${unitOf(it)}${it.note ? ` (${it.note})` : ''}${codingOf(it) ? ` · מוצע: ${codingOf(it)}` : ''}`), '',
    after,
    link ? `\nמק"ט כבר קיים, או נבנה? אפשר לענות ל${user.full_name} כאן — והוא יקבל את התשובה בבוט: ${link}` : null,
    '', 'בברכה,', 'משימון'
  ].filter((x) => x !== null).join('\n');
  const td = 'style="border:1px solid #ccc;padding:6px 8px"';
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px">
<p>שלום ${esc(to.name)},</p>
<p><b>להלן מק"טים נדרשים לבנייה בהקדם</b>, לבקשת ${esc(user.full_name)} (${esc(via)}):</p>
<p>${facts.map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join('<br>')}</p>
<table style="border-collapse:collapse"><tr><th ${td}>#</th><th ${td}>תיאור</th><th ${td}>כמות</th><th ${td}>יחידה</th><th ${td}>הערה</th><th ${td}>תת פרק / משאב מוצע</th></tr>
${list.map((it, i) => `<tr><td ${td}>${i + 1}</td><td ${td}>${esc(it.description)}</td><td ${td}>${esc(qty(it.qty))}</td><td ${td}>${esc(unitOf(it))}</td><td ${td}>${esc(it.note)}</td><td ${td}>${esc(codingOf(it))}</td></tr>`).join('\n')}
</table>
<p>${esc(after)}</p>
${link ? `<p><b>מק"ט כבר קיים, או נבנה?</b> <a href="${esc(link)}">לענות ל${esc(user.full_name)}</a> — הוא יקבל את התשובה בבוט.</p>` : ''}
<p>בברכה,<br>משימון</p></div>`;
  return { subject, text, html };
}

/** שליחה דרך משימון: שרת הדואר של המערכת, ואם אינו מוגדר — מתיבת ה-Gmail של העובד. ‎true‎ — יצא */
async function sendMail(user, m, to) {
  const me = D.get('SELECT email, full_name FROM users WHERE id = ?', user.id);
  if (Mailer.isEnabled()) {
    await Mailer.send({ to: to.email, toName: to.name, subject: m.subject, text: m.text, html: m.html, replyTo: me?.email || undefined, replyToName: me?.full_name });
    return true;
  }
  const conn = Gmail.connectionOf(user.id);
  if (!conn?.email) throw new Error('אין שרת דואר במערכת, ולעובד אין תיבת Gmail מחוברת');
  const built = Mailer.buildMessage({ from: conn.email, fromName: user.full_name, to: to.email, toName: to.name, subject: m.subject, text: m.text, html: m.html });
  await Gmail.send(user.id, built.raw);
  return true;
}

/** המק"טים שכבר בקטלוג לתיאור הזה — כדי לזהות בהמשך מק"ט *חדש* */
async function knownCodes(company, description) {
  const found = await Priority.searchParts(company, description).catch(() => []);
  const exact = await Priority.findPartExact(company, description).catch(() => null);
  return [...new Set([exact?.PARTNAME, ...found.map((x) => x.p?.PARTNAME)].filter(Boolean))].slice(0, 300);
}

const headerOf = (s) => ({ project: s.project ?? null, warehouse: s.warehouse ?? null, warehouseName: s.warehouseName ?? '', demandCode: s.demandCode ?? null, date: s.date ?? null,
  supplier: s.supplier?.name ?? null });
const itemsOf = (s) => (s.items ?? []).map(({ n, description, qty: q, unit, note, status, part, general, req }) => ({ n, description, qty: q, unit, note, status, part, general, req }));

/**
 * שולח למנהלת הרכש את הפריטים בלי מק"ט (‎list‎ — שורות מהדרישה), ושומר את הבקשה (‎s.partsReq‎).
 * ‎{ ok, to, error }‎.
 */
async function requestBuild(user, s, list, { source = 'demand', mode = 'wait' } = {}) {
  const to = contact();
  if (!to) return { ok: false, error: 'לא הוגדרה מנהלת רכש' };
  if (source === 'receipt') mode = 'receipt';
  const cur = s.partsReq ? row(s.partsReq) : null;
  const reuse = cur && cur.user_id === user.id && cur.status === 'open';
  const token = reuse && cur.token ? cur.token : crypto.randomBytes(18).toString('hex');
  try {
    await sendMail(user, mailOf(user, s, list, to, { source, mode, token }), to);
  } catch (err) {
    alertAdmins('המייל למנהלת הרכש לא נשלח', [`עובד: ${user.full_name}`, `אל: ${to.email}`, err.message].join('\n'));
    return { ok: false, to, error: err.message };
  }
  if (to.userId) {
    D.notify({ targetType: 'user', targetId: to.userId, kind: 'ai', title: `🆕 מק"טים נדרשים לבנייה — לבקשת ${user.full_name}`,
      body: list.map((it) => `• ${it.description} — ${qty(it.qty)} ${unitOf(it)}`).join('\n') });
  }
  const missing = [];
  for (const it of list) missing.push({ n: it.n, description: it.description, qty: it.qty, unit: unitOf(it), note: it.note ?? '', known: await knownCodes(s.company, it.description), built: null });
  if (reuse) {
    D.run('UPDATE pd_part_requests SET missing = ?, items = ?, header = ?, token = ? WHERE id = ?',
      JSON.stringify([...cur.missing, ...missing]), JSON.stringify(itemsOf(s)), JSON.stringify(headerOf(s)), token, cur.id);
  } else {
    s.partsReq = Number(D.run('INSERT INTO pd_part_requests (user_id, company, header, items, missing, mode, sent_to, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, s.company, JSON.stringify(headerOf(s)), JSON.stringify(itemsOf(s)), JSON.stringify(missing), mode, to.email, token, D.nowIso()).lastInsertRowid);
  }
  return { ok: true, to };
}

/** אחרי "רק המזוהים": מספר הדרישה שיצאה, והשורות כפי שהיו בטיוטא (כולל החסרים) */
function setMode(s, mode, prdno = null) {
  if (!s.partsReq) return;
  D.run('UPDATE pd_part_requests SET mode = ?, prdno = ?, items = ?, header = ? WHERE id = ?', mode, prdno, JSON.stringify(itemsOf(s)), JSON.stringify(headerOf(s)), s.partsReq);
}

// ---------------------------------------------------------------------------
// הסבב: האם המק"טים נבנו
// ---------------------------------------------------------------------------

const wordsOf = (t) => String(t ?? '').replace(/["'״׳(),.:;\-/]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w));

/** מק"ט פעיל חדש (שלא היה כשנשלחה הבקשה) עם שם דומה לתיאור — או ‎null‎ */
async function findBuilt(company, m) {
  const known = new Set(m.known ?? []);
  const exact = await Priority.findPartExact(company, m.description).catch(() => null);
  if (exact && !known.has(exact.PARTNAME) && (exact.STATDES ?? 'פעיל') === 'פעיל') return exact;
  const found = (await Priority.searchParts(company, m.description).catch(() => [])).filter((x) => x.p && !known.has(x.p.PARTNAME));
  if (!found.length) return null;
  const full = found.find((x) => x.full);
  if (full) return full.p;
  // לפחות שתי מילים מהתיאור (או המילה היחידה) — "שם דומה"
  const need = Math.min(2, Math.max(1, wordsOf(m.description).length));
  return found[0].score >= need ? found[0].p : null;
}

const partOf = (p) => ({ code: p.PARTNAME, des: p.PARTDES ?? '', chapter: p.BUD_SUBCHAPTERNAME ?? null, chapterDes: p.BUD_SUBCHAPTERDES ?? '',
  topic: p.BUD_SUBTOPICNAME ?? null, topicDes: p.BUD_SUBTOPICDES ?? '', why: 'נבנה ע"י הרכש' });

/*
 * השאלה — לפי מה שהעובד בחר ב"סיום":
 *   • ‎partial‎ ("רק המזוהים" — הדרישה כבר יצאה): לבנות דרישה חדשה נוספת מהמק"טים שנבנו.
 *   • ‎wait‎ ("לחכות לרכש" — שום דבר עוד לא יצא): להמשיך בדרישה.
 */
const QUESTION = {
  wait: 'להמשיך בדרישת הרכש? (כל הדרישה, עם הכמויות שביקשת והמק"טים שנבנו)',
  partial: 'לבנות דרישה חדשה נוספת מהמק"טים שנבנו, עם הכמויות שביקשת?'
};
const yesBtn = (mode) => (mode === 'partial' ? BTN_MORE : BTN_REBUILD);

/** מייל ליוזם (דרך משימון): המק"טים החסרים נבנו — התשובה בבוט או במשימון. נכשל — רק ביומן */
async function mailWorker(r, text) {
  const u = D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active'", r.user_id);
  if (!u?.email) return;
  const subject = r.mode === 'partial' ? 'המק"טים החסרים נבנו בפריוריטי — לבנות דרישה נוספת?' : 'המק"טים החסרים נבנו בפריוריטי — להמשיך בדרישת הרכש?';
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px">${esc(text).replace(/\*/g, '').replace(/\n/g, '<br>')}</div>`;
  const body = { to: u.email, toName: u.full_name, subject, text: text.replace(/\*/g, ''), html };
  try {
    if (Mailer.isEnabled()) { await Mailer.send(body); return; }
    const conn = Gmail.connectionOf(u.id);
    if (!conn?.email) return;
    await Gmail.send(u.id, Mailer.buildMessage({ ...body, from: conn.email, fromName: 'משימון' }).raw);
  } catch (err) {
    console.error('[משימון] מק"טים לבנייה — מייל ליוזם:', err.message);
  }
}

/** הודעה ליוזם, בבוט ובמייל: המק"טים החסרים נבנו, הרשימה, ו"להמשיך בדרישה?" (בקבלת סחורה — רק הודעה) */
async function tell(r) {
  const list = r.missing.map((m) => `• ${m.description} — ${qty(m.qty)} ${m.unit} ← *${m.built.des}* (${m.built.code})`);
  const head = `🆕 *המק"טים החסרים נבנו בפריוריטי — להלן הרשימה:*\n${list.join('\n')}`;
  const project = r.header?.project ? `\n📁 ${r.header.project.des}` : '';
  D.notify({ targetType: 'user', targetId: r.user_id, kind: 'ai', title: '🆕 המק"טים החסרים נבנו בפריוריטי', body: r.missing.map((m) => `• ${m.description} ← ${m.built.des} (${m.built.code})`).join('\n') });
  if (r.mode === 'receipt') {
    D.run("UPDATE pd_part_requests SET status = 'done', asked_at = ? WHERE id = ?", D.nowIso(), r.id);
    if (hooks.send) await hooks.send(r.user_id, `${head}${project}\n\nהסחורה${r.header?.supplier ? ` מ${r.header.supplier}` : ''} כבר נקלטה על מק"ט כללי 000 — בפעם הבאה הבוט ימצא אותם לבד.`);
    return;
  }
  const text = `${head}${project}${r.prdno ? `\n_(הדרישה ${r.prdno} כבר נשלחה עם הפריטים שזוהו)_` : ''}\n\n${QUESTION[r.mode] ?? QUESTION.wait}`;
  D.run("UPDATE pd_part_requests SET status = 'asked', asked_at = ? WHERE id = ?", D.nowIso(), r.id);
  if (hooks.ask) await hooks.ask(r.user_id, text, [yesBtn(r.mode), BTN_SKIP]);
  else if (hooks.send) await hooks.send(r.user_id, `${text}\n*כן* 👍 / *לא* 👎`);
  await mailWorker(r, `${text}\n\nלענות — בבוט בוואטסאפ: "${yesBtn(r.mode)}" (או "${BTN_SKIP}").`);
}

let running = false;
async function tick() {
  if (running || !Priority.isEnabled()) return { checked: 0, told: 0 };
  running = true;
  let checked = 0;
  let told = 0;
  try {
    const old = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    D.run("UPDATE pd_part_requests SET status = 'expired' WHERE status = 'open' AND created_at < ?", old);
    for (const { id } of D.all("SELECT id FROM pd_part_requests WHERE status = 'open' ORDER BY id")) {
      const r = row(id);
      checked += 1;
      let changed = false;
      for (const m of r.missing.filter((x) => !x.built)) {
        const p = await findBuilt(r.company, m);
        if (p) { m.built = partOf(p); changed = true; }
      }
      D.run('UPDATE pd_part_requests SET missing = ?, checked_at = ? WHERE id = ?', JSON.stringify(r.missing), D.nowIso(), id);
      if (changed && r.missing.every((m) => m.built)) {
        try { await tell(r); told += 1; } catch (err) { console.error('[משימון] מק"טים לבנייה — הודעה ליוזם:', err.message); }
      }
    }
  } catch (err) {
    console.error('[משימון] מק"טים לבנייה — סבב:', err.message);
  } finally {
    running = false;
  }
  return { checked, told };
}

let timer = null;
function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), TICK);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// תשובת היוזם: לבנות מחדש?
// ---------------------------------------------------------------------------

function asked(userId) {
  const since = new Date(Date.now() - ASK_DAYS * 86400000).toISOString();
  const r = D.get("SELECT id FROM pd_part_requests WHERE user_id = ? AND status = 'asked' AND asked_at >= ? ORDER BY asked_at DESC LIMIT 1", userId, since);
  return r ? row(r.id) : null;
}

/** האם ההודעה היא תשובה לשאלה "לבנות מחדש?" — הכפתורים; "כן" / "לא" / 👍 / 👎 — רק סמוך לשאלה */
function owns(userId, text) {
  const t = normalize(text);
  if (!t || t.split(/\s+/).length > 4) return false;
  const r = asked(userId);
  if (!r) return false;
  if (sameLabel(t, BTN_REBUILD) || sameLabel(t, BTN_MORE) || sameLabel(t, BTN_SKIP)) return true;
  return (YES.test(t) || NO.test(t)) && Date.now() - Date.parse(r.asked_at) < PLAIN_HOURS * 3600000;
}

/**
 * ‎{ rebuild }‎ — הדרישה לבנייה מחדש: חברה, כותרת ושורות (הפריטים החסרים — עם המק"טים שנבנו);
 * או ‎{ replies }‎ — "לא".
 */
function answer(user, text) {
  const r = asked(user.id);
  if (!r) return { replies: ['אין שאלה פתוחה על מק"טים.'], status: 'ok', result: 'מק"טים: אין שאלה' };
  const t = normalize(text);
  D.run("UPDATE pd_part_requests SET status = 'done' WHERE id = ?", r.id);
  if (NO.test(t) || sameLabel(t, BTN_SKIP)) {
    return { replies: ['בסדר — לא נפתחה דרישה. כשתצטרך, כתוב *דרישת רכש* והבוט ימצא את המק"טים החדשים לבד.'], status: 'ok', result: `מק"טים ${r.id}: לא להמשיך` };
  }
  const built = new Map(r.missing.map((m) => [m.n, m]));
  // ‎partial‎ — הדרישה כבר יצאה עם המזוהים: רק הפריטים שנבנו. אחרת — כל הדרישה, והחסרים עם המק"טים החדשים
  const base = r.mode === 'partial' ? r.items.filter((it) => built.has(it.n)) : r.items;
  const items = base.map((it, i) => {
    const m = built.get(it.n);
    const part = m?.built ?? it.part;
    return { ...it, n: i + 1, req: m ? null : it.req, part, status: part && part.code !== '000' ? 'ok' : 'general' };
  });
  return { rebuild: { company: r.company, header: r.header, items, from: r.id, partial: r.mode === 'partial', prdno: r.prdno } };
}

// ---------------------------------------------------------------------------
// 💬 תשובת הרכש לעובד — דף ‎/parts.html?t=…‎ (הקישור במייל; בלי התחברות, מוגן באסימון)
// ---------------------------------------------------------------------------

const byToken = (token) => {
  if (!/^[0-9a-f]{36}$/.test(String(token ?? ''))) return null;
  const r = D.get('SELECT id FROM pd_part_requests WHERE token = ?', token);
  return r ? row(r.id) : null;
};
const nameOf = (id) => D.get('SELECT full_name FROM users WHERE id = ?', id)?.full_name ?? '';

/** מה מנהלת הרכש רואה: מי ביקש, אילו פריטים, ומה כבר נענה / נבנה */
function forBuyer(token) {
  const r = byToken(token);
  if (!r) return null;
  return {
    worker: nameOf(r.user_id), company: Priority.companyOf(r.company)?.name ?? r.company, project: r.header?.project?.des ?? '',
    supplier: r.header?.supplier ?? '', receipt: r.mode === 'receipt', open: r.status === 'open', created: r.created_at,
    items: r.missing.map((m) => ({ n: m.n, description: m.description, qty: m.qty, unit: m.unit, note: m.note ?? '',
      built: m.built ? { code: m.built.code, des: m.built.des } : null, answers: m.answers ?? [] }))
  };
}

/**
 * תשובה של מנהלת הרכש על פריט: ‎code‎ — המק"ט (כבר קיים, או נבנה עכשיו) ו/או ‎note‎ — הערה לעובד.
 * העובד מקבל אותה בבוט מיד. מק"ט — חייב להיות קיים ופעיל בחברה; כשלכל הפריטים יש מק"ט — השאלה "להמשיך?".
 */
async function buyerAnswer(token, { n, code = '', note = '' } = {}) {
  const r = byToken(token);
  if (!r) throw Object.assign(new Error('הקישור אינו תקין'), { status: 404 });
  if (r.status !== 'open') throw Object.assign(new Error('הבקשה כבר טופלה — העובד כבר קיבל את המק"טים'), { status: 409 });
  const m = r.missing.find((x) => x.n === Number(n));
  if (!m) throw Object.assign(new Error('הפריט לא נמצא'), { status: 400 });
  const c = String(code ?? '').trim().toUpperCase().slice(0, 40);
  const text = String(note ?? '').trim().slice(0, 500);
  if (!c && !text) throw Object.assign(new Error('כתבו מק"ט או הערה'), { status: 400 });
  let part = null;
  if (c) {
    const p = await Priority.partByCode(r.company, c).catch(() => null);
    if (!p || (p.STATDES ?? 'פעיל') !== 'פעיל') throw Object.assign(new Error(`אין מק"ט פעיל ${c} ב${Priority.companyOf(r.company)?.name ?? r.company}`), { status: 400 });
    part = { ...partOf(p), why: 'לפי הרכש' };
    m.built = part;
  }
  (m.answers ??= []).push({ code: part?.code ?? '', note: text, at: D.nowIso() });
  D.run('UPDATE pd_part_requests SET missing = ? WHERE id = ?', JSON.stringify(r.missing), r.id);
  const buyer = contact()?.name ?? 'הרכש';
  const msg = [`💬 *${buyer} (רכש)* על "${m.description}":`, part ? `✅ המק"ט כבר קיים: *${part.des}* (${part.code})` : null, text ? `"${text}"` : null].filter(Boolean).join('\n');
  D.notify({ targetType: 'user', targetId: r.user_id, kind: 'ai', title: `💬 ${buyer} (רכש): ${m.description}`, body: msg.replace(/\*/g, '') });
  try { if (hooks.send) await hooks.send(r.user_id, msg); } catch (err) { console.error('[משימון] תשובת הרכש לעובד:', err.message); }
  if (r.missing.every((x) => x.built)) await tell(r);
  return forBuyer(token);
}

module.exports = { BTN_REBUILD, BTN_MORE, BTN_SKIP, forBuyer, buyerAnswer, contact, requestBuild, setMode, tick, start, owns, answer, setHooks, _findBuilt: findBuilt, _mailOf: mailOf, _row: row };
