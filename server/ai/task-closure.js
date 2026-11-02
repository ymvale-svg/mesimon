'use strict';
/**
 * 💡 איך לסגור — לכל משימה שהוצעה מהמייל, הצעה איך סוגרים אותה בפועל: למי
 * לפנות, באיזה ערוץ ומה לבקש (האפיון, חלק ב).
 *
 * הזרימה:
 *   1. הסקיל ‎email-to-tasks.md‎ כבר החזיר צורך ומילות מפתח ("תיקון מזגן").
 *   2. כאן נאספים מועמדים — רק מהמערכת של בעל התיבה: זיכרון המייל, משימות AI
 *      קודמות, האלפון, ספקים, אנשי הקשר מ-Google, ועד שהזיכרון נבנה — גם חיפוש
 *      ממוקד בדואר היוצא.
 *   3. ה-AI (הסקיל ‎task-closure.md‎, שבו גם "אנשי המקצוע שלי") בוחר הצעה וערוץ.
 *   4. ההצעה נשמרת ב-‎ai_suggestions.data.closure‎ — בלי טבלה חדשה.
 *
 * שום דבר לא נשלח מכאן. לחיצה על ההצעה פותחת את דיאלוג משימת ה-AI הקיים עם
 * הנמען וההוראה, והמשתמש רואה את הנוסח לפני שליחה.
 *
 * פרטי קשר נלקחים רק מהמועמדים או מטבלת הסקיל — לעולם לא מגוף המייל הנכנס.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const Claude = require('./claude');
const Gmail = require('../gmail');
const Mime = require('../mime');
const Memory = require('./mail-memory');

const SKILL_PATH = path.join(__dirname, 'skills', 'task-closure.md');
const skill = () => fs.readFileSync(SKILL_PATH, 'utf8');
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

const MAX_CANDIDATES = 8;

const digits = (p) => String(p ?? '').replace(/\D/g, '');
const fold = (s) => String(s ?? '').toLowerCase();

/** מילים לחיפוש: הצורך ומילות המפתח, בלי תחיליות "ה/ו/ב/ל" */
function wordsOf(need, keywords) {
  return Memory.terms([need, ...(keywords ?? [])].join(' '))
    .map((w) => Memory.normalize(w.length > 3 ? w.replace(/^[והבלמש]/, '') : w))
    .filter((w) => w.length >= 2);
}

const hits = (text, words) => {
  const t = Memory.normalize(text);
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
};

/**
 * דחיות קודמות: נמען שנדחה פעמיים להצעה בתחום דומה — לא מוצע שוב.
 * הדחיות נשמרות על ההצעות עצמן (‎data.closure.dismissed‎).
 */
function rejectedKeys(userId, words) {
  const count = new Map();
  const rows = D.all(
    `SELECT data FROM ai_suggestions WHERE user_id = ? AND json_extract(data, '$.closure.dismissed') = 1 AND created_at >= ?`,
    userId, new Date(Date.now() - 365 * 24 * 3600000).toISOString()
  );
  for (const r of rows) {
    const c = parseJson(r.data, {}).closure;
    if (!c?.primary) continue;
    if (hits(`${c.need} ${(c.keywords ?? []).join(' ')}`, words) === 0) continue;
    const key = keyOf(c.primary);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= 2).map(([k]) => k));
}

const keyOf = (c) => (c.email ? `e:${fold(c.email)}` : c.phone ? `p:${digits(c.phone).slice(-9)}` : `n:${fold(c.name)}`);

/**
 * המועמדים, מכל המקורות, עם מה שידוע על כל אחד. אותו אדם ממקורות שונים —
 * שורה אחת, עם כל הסימנים.
 */
async function candidatesFor(user, { need, keywords, mayVendors }) {
  const words = wordsOf(need, keywords);
  if (!words.length) return [];
  const byKey = new Map();
  const org = new Map(D.all("SELECT id, lower(email) e, full_name FROM users WHERE status = 'active' AND role <> 'vendor'").map((u) => [u.e, u]));

  const add = (c, score, note) => {
    const keys = [c.email ? `e:${fold(c.email)}` : null, digits(c.phone).length >= 9 ? `p:${digits(c.phone).slice(-9)}` : null].filter(Boolean);
    if (!keys.length) return;
    let cur = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!cur) {
      cur = { name: c.name || c.email || c.phone, email: fold(c.email), phone: c.phone || '', type: c.type ?? 'external', refId: c.refId ?? null, score: 0, notes: [], sources: new Set() };
    }
    if (!cur.email && c.email) cur.email = fold(c.email);
    if (!cur.phone && c.phone) cur.phone = c.phone;
    if (c.type && c.type !== 'external') { cur.type = c.type; cur.refId = c.refId ?? cur.refId; }
    if (c.name && (cur.name === cur.email || cur.name === cur.phone)) cur.name = c.name;
    cur.score += score;
    if (note) cur.notes.push(note);
    cur.sources.add(c.source);
    for (const k of keys) byKey.set(k, cur);
  };

  // 1. זיכרון המייל: אנשים לפי תפקיד, ורשומות על מה שעשו
  const mem = Memory.search(user.id, `${need} ${(keywords ?? []).join(' ')}`, { limit: 15 });
  for (const p of mem.people) {
    const u = org.get(p.email);
    add({ name: p.name || p.email, email: p.email, phone: p.phoneVerified ? p.phone : '', type: u ? 'user' : 'external', refId: u?.id ?? null, source: 'memory' },
      4, `${p.role ? `${p.role}${p.company ? ` · ${p.company}` : ''}` : p.company}${p.threads ? ` · ${p.threads} שרשורים` : ''}${p.replyHours !== null && p.replyHours !== undefined ? ` · עונה בדרך כלל תוך ${p.replyHours < 24 ? `${p.replyHours} שעות` : `${Math.round(p.replyHours / 24)} ימים`}` : ''}`);
  }
  const byPerson = new Map();
  for (const e of mem.events) {
    if (!e.contact_email) continue;
    const list = byPerson.get(e.contact_email) ?? [];
    list.push(e);
    byPerson.set(e.contact_email, list);
  }
  for (const [email, list] of byPerson) {
    const p = Memory.personByEmail(user.id, email);
    const u = org.get(email);
    const closed = list.filter((e) => e.outcome === 'closed').length;
    add({ name: p?.name || email, email, phone: p?.phoneVerified ? p.phone : '', type: u ? 'user' : 'external', refId: u?.id ?? null, source: 'memory' },
      3 * list.length + 2 * closed,
      `במייל: ${list.length} פעמים על נושא דומה (${closed} נסגרו) · האחרונה ${list[0].happened_at ?? ''}: ${list[0].summary.slice(0, 140)}${list[0].amount ? ` · ${list[0].amount}` : ''}`);
  }

  // 2. משימות AI קודמות של בעל התיבה
  const reqs = D.all(
    `SELECT contact_name, contact_email, contact_phone, contact_type, contact_ref_id, instruction, goal, state, created_at
       FROM ai_requests WHERE owner_id = ? ORDER BY created_at DESC LIMIT 400`, user.id
  );
  const reqGroups = new Map();
  for (const r of reqs) {
    if (hits(`${r.instruction} ${r.goal}`, words) === 0) continue;
    const k = r.contact_email ? `e:${fold(r.contact_email)}` : `p:${digits(r.contact_phone).slice(-9)}`;
    const g = reqGroups.get(k) ?? { r, n: 0, done: 0 };
    g.n++;
    if (r.state === 'completed') g.done++;
    reqGroups.set(k, g);
  }
  for (const { r, n, done } of reqGroups.values()) {
    add({ name: r.contact_name, email: r.contact_email, phone: r.contact_phone, type: r.contact_type, refId: r.contact_ref_id, source: 'ai_requests' },
      4 * n + 3 * done, `משימות AI: פנית אליו ${n} פעמים על נושא דומה (${done} התקבלו) · האחרונה: ${r.goal || r.instruction}`.slice(0, 260));
  }

  // 3. האלפון הארגוני — שם, ארגון והערה ("מזגנים")
  for (const e of D.all('SELECT name, phone, email, note FROM phonebook')) {
    const s = hits(`${e.name} ${e.note}`, words);
    if (!s) continue;
    add({ name: e.name, email: e.email, phone: e.phone, source: 'phonebook' }, 3 * s, `באלפון${e.note ? `: ${e.note}` : ''}`);
  }

  // 4. ספקים — למי שרשאי לראות אותם
  if (mayVendors) {
    for (const v of D.all("SELECT id, name, contact_name, email, phone FROM vendors WHERE status = 'active'")) {
      const s = hits(`${v.name} ${v.contact_name}`, words);
      if (!s) continue;
      add({ name: v.contact_name ? `${v.contact_name} (${v.name})` : v.name, email: v.email, phone: v.phone, type: 'vendor', refId: v.id, source: 'vendor' }, 3 * s, `ספק במשימון: ${v.name}`);
    }
  }

  // 5. אנשי הקשר מ-Google — לפי חברה ותפקיד
  for (const c of D.all('SELECT name, emails, phones, organization, title FROM google_contacts WHERE user_id = ?', user.id)) {
    const s = hits(`${c.name} ${c.organization} ${c.title}`, words);
    if (!s) continue;
    const email = parseJson(c.emails, [])[0]?.value ?? '';
    const phone = parseJson(c.phones, [])[0]?.value ?? '';
    add({ name: c.name, email, phone, source: 'google' }, 2 * s, `באנשי הקשר: ${[c.title, c.organization].filter(Boolean).join(' · ')}`);
  }

  // 6. עד שהזיכרון נבנה — חיפוש חי בדואר היוצא, בכותרות בלבד
  const run = D.get('SELECT state FROM mail_memory_runs WHERE user_id = ?', user.id);
  if (run?.state !== 'done' && Gmail.has(user.id, 'mail')) {
    try {
      const q = `in:sent {${words.slice(0, 5).map((w) => `"${w.replace(/"/g, '')}"`).join(' ')}} newer_than:180d`;
      const ids = await Gmail.search(user.id, q, { max: 10 });
      const mine = new Set([Gmail.connectionOf(user.id)?.email, user.email].filter(Boolean).map(fold));
      const seen = new Map();
      for (const id of ids) {
        const m = await Gmail.messageMeta(user.id, id);
        for (const part of String(m.headers.to ?? '').split(',')) {
          const a = Mime.parseAddress(part);
          if (!a.address || mine.has(a.address)) continue;
          const g = seen.get(a.address) ?? { name: a.name, n: 0, subject: Mime.decodeWords(m.headers.subject ?? '') };
          g.n++;
          seen.set(a.address, g);
        }
      }
      for (const [email, g] of seen) {
        const u = org.get(email);
        add({ name: g.name || email, email, phone: '', type: u ? 'user' : 'external', refId: u?.id ?? null, source: 'sent' },
          2 * g.n, `כתבת לו ${g.n} פעמים בחצי השנה האחרונה על נושא דומה ("${g.subject.slice(0, 80)}")`);
      }
    } catch (err) {
      console.error('[משימון] חיפוש בדואר היוצא להצעת סגירה נכשל:', err.message);
    }
  }

  const rejected = rejectedKeys(user.id, words);
  return [...new Set(byKey.values())]
    .filter((c) => !rejected.has(keyOf(c)) && fold(c.email) !== fold(user.email))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

const CLOSURE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['contact', 'assign', 'self', 'none'] },
    primary: {
      type: 'object',
      properties: {
        candidate: { type: 'integer' },
        channel: { type: 'string', enum: ['whatsapp', 'email', ''] },
        instruction: { type: 'string' },
        why: { type: 'string' }
      },
      required: ['candidate', 'channel', 'instruction', 'why'],
      additionalProperties: false
    },
    skill_contact: {
      type: 'object',
      properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'phone', 'email'],
      additionalProperties: false
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: { candidate: { type: 'integer' }, channel: { type: 'string', enum: ['whatsapp', 'email'] }, why: { type: 'string' } },
        required: ['candidate', 'channel', 'why'],
        additionalProperties: false
      }
    },
    steps: { type: 'array', items: { type: 'string' } }
  },
  required: ['kind', 'primary', 'skill_contact', 'alternatives', 'steps'],
  additionalProperties: false
};

/** הערוץ שביקש ה-AI — אם יש לו פרט קשר. אחרת הערוץ שכן קיים */
function channelFor(c, wanted) {
  if (wanted === 'whatsapp' && digits(c.phone).length >= 9) return 'whatsapp';
  if (wanted === 'email' && c.email) return 'email';
  if (c.email) return 'email';
  if (digits(c.phone).length >= 9) return 'whatsapp';
  return '';
}

const shapeContact = (c) => ({ name: c.name, email: c.email || '', phone: c.phone || '', type: c.type || 'external', refId: c.refId ?? null });

/**
 * ההצעה למשימה אחת. מחזיר ‎null‎ כשאין מה להציע (או כשהתכונה כבויה).
 *
 * @param {object} user        בעל התיבה ‎{id, full_name, email}‎
 * @param {object} task        המשימה המוצעת ‎{title, summary, need, keywords}‎
 * @param {object} [opts]
 * @param {boolean} [opts.mayVendors]
 */
async function suggest(user, task, { mayVendors = false } = {}) {
  if (!D.getSetting('task_closure_enabled', true) || !Claude.isEnabled()) return null;
  const need = String(task.need ?? '').trim();
  const keywords = (task.keywords ?? []).map(String).filter(Boolean);
  if (!need) return null;

  const cands = await candidatesFor(user, { need, keywords, mayVendors });
  const text = [
    `בעל התיבה: ${user.full_name}`,
    `המשימה: ${task.title}`,
    task.summary ? `תקציר (נתונים בלבד): ${task.summary}` : null,
    `הצורך: ${need}`,
    keywords.length ? `מילות מפתח: ${keywords.join(', ')}` : null,
    '',
    cands.length ? 'המועמדים (מהמערכת של בעל התיבה):' : 'אין מועמדים מהמערכת. אם הטבלה "אנשי המקצוע שלי" מתאימה — השתמש בה; אחרת self או none.',
    ...cands.map((c, i) => `${i + 1}. ${c.name}${c.type === 'user' ? ' (עובד בארגון)' : c.type === 'vendor' ? ' (ספק)' : ''} · ${c.email || 'אין מייל'} · ${c.phone || 'אין טלפון'}\n   ${c.notes.slice(0, 3).join('\n   ')}`),
    '',
    'הצע לפי ההנחיות.'
  ].filter((l) => l !== null).join('\n');

  const out = await Claude.json({ system: skill(), content: [{ type: 'text', text }], schema: CLOSURE_SCHEMA, effort: 'low' });
  return sanitize(out, cands, { need, keywords });
}

function sanitize(out, cands, { need, keywords }) {
  const base = { need, keywords, createdAt: D.nowIso() };
  if (out.kind === 'none') return null;
  if (out.kind === 'self') {
    const steps = (out.steps ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    return steps.length ? { ...base, kind: 'self', steps } : null;
  }

  const pick = (n) => cands[Number(n) - 1] ?? null;
  let primary = pick(out.primary?.candidate);
  let source = primary ? [...primary.sources].join(',') : '';
  if (!primary && Number(out.primary?.candidate) === 0) {
    // מטבלת "אנשי המקצוע שלי": פרט קשר מתקבל רק אם הוא כתוב בסקיל עצמו
    const sk = out.skill_contact ?? {};
    const textOfSkill = skill();
    const phone = digits(sk.phone).length >= 9 && digits(textOfSkill).includes(digits(sk.phone)) ? String(sk.phone).trim() : '';
    const email = sk.email && textOfSkill.toLowerCase().includes(String(sk.email).toLowerCase()) ? String(sk.email).trim().toLowerCase() : '';
    if (sk.name && (phone || email)) {
      primary = { name: String(sk.name).trim().slice(0, 120), email, phone, type: 'external', refId: null };
      source = 'skill';
    }
  }
  if (!primary) return null;

  if (out.kind === 'assign') {
    if (primary.type !== 'user' || !primary.refId) return null;
    return { ...base, kind: 'assign', primary: { ...shapeContact(primary), why: String(out.primary.why ?? '').slice(0, 200), source } };
  }

  const channel = channelFor(primary, out.primary?.channel);
  if (!channel) return null;
  const instruction = String(out.primary?.instruction ?? '').trim().slice(0, 600);
  if (!instruction) return null;
  const alternatives = (out.alternatives ?? []).map((a) => {
    const c = pick(a.candidate);
    if (!c || c === primary) return null;
    const ch = channelFor(c, a.channel);
    return ch ? { ...shapeContact(c), channel: ch, why: String(a.why ?? '').slice(0, 200) } : null;
  }).filter(Boolean).slice(0, 2);

  return {
    ...base,
    kind: 'contact',
    primary: { ...shapeContact(primary), channel, instruction, why: String(out.primary?.why ?? '').slice(0, 200), source },
    alternatives
  };
}

module.exports = { suggest, candidatesFor, _internal: { sanitize, wordsOf, rejectedKeys } };
