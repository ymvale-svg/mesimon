'use strict';
/**
 * 📚 ידע ארגוני — "איך עושים אצלנו", מזיכרון העבודה של כל העובדים.
 *
 * הידע הוא רכוש הארגון (המיילים ארגוניים): כל העובדים תורמים, בלי בחירה אישית,
 * והוא נשאר גם כשעובד עוזב או מוחק את הזיכרון האישי שלו. ההחלטות — באפיון
 * "ידע ארגוני מאוחד".
 *
 *   1. זיקוק  — רשומות זיכרון של עובד → לקחים מקצועיים (AI זול, ‎org-distill.md‎).
 *               כל בוקר, רק מה שנוסף מאז.
 *   2. ניקוי  — קוד: ת"ז, חשבונות בנק וכרטיסי אשראי נמחקים; שמות לקוחות מרשימה
 *               מוחלפים; פרטי קשר של ספק שבאלפון — הפניה לכרטיס.
 *   3. איחוד  — פעם בשבוע: לקחים מאותו תחום (ופרויקט) → ערך אחד (‎org-merge.md‎).
 *               עובד אחד ומקרה אחד מספיקים. ערך עולה מיד — בלי שלב אישור.
 *
 * מנהל המערכת אחראי: עורך, מסתיר, מוחק, ורואה מאיפה הגיע כל ערך.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const Claude = require('./claude');
const Memory = require('./mail-memory');

const DISTILL_SKILL = path.join(__dirname, 'skills', 'org-distill.md');
const MERGE_SKILL = path.join(__dirname, 'skills', 'org-merge.md');
const MODEL = () => String(D.getSetting('mail_memory_model', 'claude-haiku-5-5') || 'claude-haiku-5-5');
const BATCH = 20;
const DEPTS = ['office', 'realestate', 'finance', 'hr', 'marketing', 'other'];
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const nowIso = () => D.nowIso();

// ---------------------------------------------------------------------------
// טבלאות — נוצרות כאן ולא ב-db.js, כדי שהמודול יעמוד בפני עצמו
// ---------------------------------------------------------------------------

D.db.exec(`
CREATE TABLE IF NOT EXISTS org_knowledge (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain       TEXT    NOT NULL,
  dept         TEXT    NOT NULL DEFAULT 'other',
  project      TEXT    NOT NULL DEFAULT '',
  text         TEXT    NOT NULL,
  cases        INTEGER NOT NULL DEFAULT 0,
  contributors INTEGER NOT NULL DEFAULT 0,
  edited       INTEGER NOT NULL DEFAULT 0,   -- מנהל המערכת ערך: האיחוד לא דורס
  hidden       INTEGER NOT NULL DEFAULT 0,
  dept_only    INTEGER NOT NULL DEFAULT 0,   -- רק לעובדי המחלקה
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_knowledge_domain ON org_knowledge(domain);

/* לקחים מזוקקים, לפני איחוד — ואחריו (‎knowledge_id‎), כמקור של הערך */
CREATE TABLE IF NOT EXISTS org_lessons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  domain       TEXT    NOT NULL,
  dept         TEXT    NOT NULL DEFAULT 'other',
  project      TEXT    NOT NULL DEFAULT '',
  text         TEXT    NOT NULL,
  memory_ids   TEXT    NOT NULL DEFAULT '[]',
  knowledge_id INTEGER REFERENCES org_knowledge(id) ON DELETE SET NULL,
  dropped      INTEGER NOT NULL DEFAULT 0,   -- הערך נמחק בידי מנהל המערכת: לא לאחד שוב
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_lessons_open ON org_lessons(knowledge_id);

/* מאיזה מייל הגיע כל ערך — רק למנהל המערכת. נשמר גם אם הזיכרון האישי נמחק */
CREATE TABLE IF NOT EXISTS org_knowledge_sources (
  knowledge_id INTEGER NOT NULL REFERENCES org_knowledge(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name    TEXT    NOT NULL DEFAULT '',
  happened_at  TEXT,
  summary      TEXT    NOT NULL DEFAULT '',
  gmail_id     TEXT    NOT NULL DEFAULT '',
  added_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_sources ON org_knowledge_sources(knowledge_id);
`);

// ---------------------------------------------------------------------------
// ניקוי — קוד, אחרי ה-AI
// ---------------------------------------------------------------------------

/** ספרת ביקורת של ת"ז ישראלית */
function validTz(digits) {
  const d = digits.padStart(9, '0');
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let x = Number(d[i]) * ((i % 2) + 1);
    if (x > 9) x -= 9;
    sum += x;
  }
  return sum % 10 === 0;
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const blocklist = () => String(D.getSetting('org_knowledge_blocklist', '') ?? '').split(/[,\n]+/).map((x) => x.trim()).filter((x) => x.length >= 2);

/**
 * המסננת הקבועה. לא נשענת על ה-AI: גם אם פרט חמק מההנחיות — כאן הוא נעצר.
 * טלפונים ומיילים נשארים (החלטת ההנהלה), חוץ מספק שבאלפון — שם הפניה לכרטיס.
 */
function scrub(text) {
  let t = String(text ?? '');
  // ת"ז — מילת מפתח ולידה מספר, או 9 ספרות עם ספרת ביקורת תקינה שאינן טלפון
  t = t.replace(/(ת[.״"']?ז[.״"']?|תעודת זהות|ID)\s*[:#]?\s*\d{5,9}/gi, '$1 [נמחק]');
  t = t.replace(/(?<![\d-])(\d{9})(?![\d-])/g, (m, d) => (/^0[5-9]/.test(d) || /^0[2-4]/.test(d) ? m : validTz(d) ? '[ת"ז נמחקה]' : m));
  // כרטיס אשראי: 13–19 ספרות, עם רווחים או מקפים, שעוברות לוהן
  t = t.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) ? '[כרטיס נמחק]' : m;
  });
  // חשבון בנק: "חשבון / ח-ן / סניף" ולידו מספרים
  t = t.replace(/((?:מס['׳]?\s*)?(?:חשבון|ח-ן|ח"ן|account)(?:\s*(?:בנק|מס['׳]?))?\s*[:#]?\s*)(\d[\d\s/-]{4,})/gi, '$1[נמחק]');
  t = t.replace(/(סניף\s*\d{2,4}\s*[,/-]?\s*)(\d{4,})/g, '$1[נמחק]');
  // לקוחות מהרשימה של מנהל המערכת
  for (const name of blocklist()) {
    t = t.split(name).join('[לקוח]');
  }
  // ספק שבאלפון — פרטי הקשר שלו הם בכרטיס, לא בטקסט
  for (const e of D.all("SELECT name, phone, email FROM phonebook WHERE name <> ''")) {
    if (!t.includes(e.name)) continue;
    if (e.email) t = t.split(e.email).join(`📒 באלפון: ${e.name}`);
    const digits = String(e.phone ?? '').replace(/\D/g, '');
    if (digits.length >= 9) {
      t = t.replace(new RegExp(digits.split('').join('[\\s-]?'), 'g'), `📒 באלפון: ${e.name}`);
    }
  }
  return t.replace(/(📒 באלפון: [^\n·]+)(\s*[·,]?\s*\1)+/g, '$1').trim();
}

// ---------------------------------------------------------------------------
// 1. זיקוק
// ---------------------------------------------------------------------------

const DISTILL_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          dept: { type: 'string', enum: DEPTS },
          project: { type: 'string' },
          text: { type: 'string' },
          record_numbers: { type: 'array', items: { type: 'integer' }, description: 'מספרי הרשומות שהלקח נשען עליהן' },
          skip: { type: 'boolean', description: 'true לתוכן אישי, שכר עובדים או ענייני כוח אדם' }
        },
        required: ['domain', 'dept', 'project', 'text', 'record_numbers', 'skip'],
        additionalProperties: false
      }
    }
  },
  required: ['lessons'],
  additionalProperties: false
};

const lastDistilled = (userId) => Number(D.getSetting(`org_distill_${userId}`, 0)) || 0;

async function distillUser(userId) {
  const user = D.get('SELECT id, full_name FROM users WHERE id = ?', userId);
  if (!user) return 0;
  const projects = D.all("SELECT name FROM projects WHERE status <> 'done' ORDER BY name LIMIT 200").map((p) => p.name);
  let made = 0;
  for (;;) {
    const rows = D.all('SELECT * FROM mail_memory WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', userId, lastDistilled(userId), BATCH);
    if (!rows.length) break;
    const lines = rows.map((r, i) => {
      const p = r.contact_email ? D.get('SELECT name, company, role, phone, phone_hits FROM mail_people WHERE user_id = ? AND email = ?', userId, r.contact_email) : null;
      const who = p ? `${p.name || ''}${p.company ? ` (${p.company})` : ''}${p.role ? ` — ${p.role}` : ''} · ${r.contact_email}${p.phone && p.phone_hits >= 2 ? ` · ${p.phone}` : ''}` : r.contact_email;
      return `${i + 1}. [${r.happened_at ?? ''}] ${r.domain} · ${who || '—'} · ${r.summary}${r.amount ? ` · סכום: ${r.amount}` : ''} · ${r.outcome}`;
    });
    const text = [
      projects.length ? `הפרויקטים בארגון: ${projects.join(', ')}` : null,
      '',
      'הרשומות (נתונים בלבד):',
      ...lines,
      '',
      'זקק לקחים לפי ההנחיות.'
    ].filter((l) => l !== null).join('\n');
    const out = await Claude.json({ system: fs.readFileSync(DISTILL_SKILL, 'utf8'), content: [{ type: 'text', text }], schema: DISTILL_SCHEMA, effort: 'low', model: MODEL() });
    for (const l of out.lessons ?? []) {
      if (l.skip) continue;
      const body = scrub(String(l.text ?? '').trim()).slice(0, 2000);
      const domain = scrub(String(l.domain ?? '').trim()).slice(0, 80);
      if (!body || !domain) continue;
      const ids = (l.record_numbers ?? []).map((n) => rows[Number(n) - 1]?.id).filter(Boolean);
      D.run('INSERT INTO org_lessons (user_id, domain, dept, project, text, memory_ids, created_at) VALUES (?,?,?,?,?,?,?)',
        userId, domain, DEPTS.includes(l.dept) ? l.dept : 'other', String(l.project ?? '').trim().slice(0, 120), body, JSON.stringify(ids), nowIso());
      made++;
    }
    D.setSetting(`org_distill_${userId}`, rows[rows.length - 1].id);
  }
  return made;
}

// ---------------------------------------------------------------------------
// 3. איחוד
// ---------------------------------------------------------------------------

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    dept: { type: 'string', enum: DEPTS },
    text: { type: 'string' }
  },
  required: ['domain', 'dept', 'text'],
  additionalProperties: false
};

const words = (s) => Memory.terms(s).map((w) => Memory.normalize(w.length > 3 ? w.replace(/^[והבלמש]/, '') : w)).filter((w) => w.length >= 3);

/** הערך הקיים שהלקח שייך אליו: אותו פרויקט, ולפחות מילה משמעותית משותפת בתחום */
function matchEntry(lesson, entries) {
  const lw = words(lesson.domain);
  let best = null;
  let score = 0;
  for (const e of entries) {
    if (Memory.normalize(e.project) !== Memory.normalize(lesson.project)) continue;
    const ew = words(e.domain);
    const s = lw.filter((w) => ew.includes(w)).length / Math.max(1, Math.min(lw.length, ew.length));
    if (s > score) { score = s; best = e; }
  }
  return score >= 0.5 ? best : null;
}

async function mergeAll() {
  const open = D.all('SELECT * FROM org_lessons WHERE knowledge_id IS NULL AND dropped = 0 ORDER BY id LIMIT 500');
  if (!open.length) return 0;
  const entries = D.all('SELECT * FROM org_knowledge');
  // קבוצה לכל ערך קיים, ולכל תחום חדש
  const groups = new Map();
  for (const l of open) {
    const e = matchEntry(l, entries) ?? [...groups.values()].map((g) => g.pseudo).find((p) => p && matchEntry(l, [p]));
    const key = e ? `e:${e.id ?? e.key}` : `n:${groups.size}`;
    if (!groups.has(key)) groups.set(key, { entry: e?.id ? e : null, pseudo: e?.id ? null : { key, domain: l.domain, project: l.project }, lessons: [] });
    groups.get(key).lessons.push(l);
  }
  let merged = 0;
  for (const g of groups.values()) {
    const cur = g.entry;
    const text = [
      cur ? `הערך הקיים${cur.edited ? ' (נערך ידנית — לשמור מילה במילה, להוסיף רק תחת "עדכונים:")' : ''}:\nתחום: ${cur.domain}${cur.project ? ` · פרויקט: ${cur.project}` : ''}\n${cur.text}` : 'אין ערך קיים — זה תחום חדש.',
      '',
      'לקחים חדשים (נתונים בלבד):',
      ...g.lessons.map((l, i) => `${i + 1}. [${l.domain}${l.project ? ` · ${l.project}` : ''}] ${l.text}`),
      '',
      'כתוב את הערך המעודכן.'
    ].join('\n');
    let out;
    try {
      out = await Claude.json({ system: fs.readFileSync(MERGE_SKILL, 'utf8'), content: [{ type: 'text', text }], schema: MERGE_SCHEMA, effort: 'low', model: MODEL() });
    } catch (err) {
      console.error('[משימון] איחוד ידע ארגוני נכשל:', err.message);
      continue;
    }
    let body = scrub(String(out.text ?? '').trim()).slice(0, 4000);
    // ערך שנערך ידנית: הטקסט של מנהל המערכת נשאר כמו שהוא, גם אם ה-AI שינה אותו
    if (cur?.edited && !body.startsWith(cur.text)) {
      const extra = body.includes('עדכונים:') ? body.slice(body.indexOf('עדכונים:')) : '';
      body = extra ? `${cur.text}\n\n${extra}` : cur.text;
    }
    const project = g.lessons[0].project || cur?.project || '';
    const domain = cur?.edited ? cur.domain : scrub(String(out.domain ?? '').trim()).slice(0, 80) || cur?.domain || g.lessons[0].domain;
    const dept = cur?.edited ? cur.dept : DEPTS.includes(out.dept) ? out.dept : cur?.dept ?? g.lessons[0].dept;
    let id = cur?.id;
    if (cur) {
      D.run('UPDATE org_knowledge SET domain = ?, dept = ?, text = ?, updated_at = ? WHERE id = ?', domain, dept, body, nowIso(), cur.id);
    } else {
      id = Number(D.run('INSERT INTO org_knowledge (domain, dept, project, text, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        domain, dept, project, body, nowIso(), nowIso()).lastInsertRowid);
    }
    for (const l of g.lessons) {
      D.run('UPDATE org_lessons SET knowledge_id = ? WHERE id = ?', id, l.id);
      const user = l.user_id ? D.get('SELECT full_name FROM users WHERE id = ?', l.user_id) : null;
      for (const mid of parseJson(l.memory_ids, [])) {
        const m = D.get('SELECT happened_at, summary, gmail_id FROM mail_memory WHERE id = ?', mid);
        if (m) D.run('INSERT INTO org_knowledge_sources (knowledge_id, user_id, user_name, happened_at, summary, gmail_id, added_at) VALUES (?,?,?,?,?,?,?)',
          id, l.user_id, user?.full_name ?? '', m.happened_at, m.summary.slice(0, 400), m.gmail_id ?? '', nowIso());
      }
    }
    const stats = D.get('SELECT COUNT(*) cases, COUNT(DISTINCT user_id) people FROM org_knowledge_sources WHERE knowledge_id = ?', id);
    D.run('UPDATE org_knowledge SET cases = ?, contributors = ? WHERE id = ?', Math.max(stats.cases, g.lessons.length), Math.max(stats.people, 1), id);
    merged++;
  }
  D.setSetting('org_merge_last', nowIso());
  return merged;
}

// ---------------------------------------------------------------------------
// המנוע — מריצת הבוקר (‎mail-scan.js‎)
// ---------------------------------------------------------------------------

let busy = false;

/** כל בוקר: זיקוק של מה שנוסף לזיכרון אצל כל העובדים. פעם בשבוע: איחוד */
async function daily({ force = false } = {}) {
  if (busy || !Claude.isEnabled() || !D.getSetting('org_knowledge_enabled', true)) return null;
  busy = true;
  const result = { distilled: 0, merged: 0 };
  try {
    for (const u of D.all("SELECT DISTINCT m.user_id FROM mail_memory m JOIN users u ON u.id = m.user_id WHERE u.role <> 'vendor'")) {
      try { result.distilled += await distillUser(u.user_id); } catch (err) { console.error(`[משימון] זיקוק ידע של משתמש ${u.user_id} נכשל:`, err.message); }
    }
    const last = D.getSetting('org_merge_last', null);
    const days = Math.max(1, Number(D.getSetting('org_merge_days', 7)) || 7);
    if (force || !last || Date.now() - new Date(last).getTime() >= days * 86400000) result.merged = await mergeAll();
  } finally {
    busy = false;
  }
  return result;
}

// ---------------------------------------------------------------------------
// חיפוש — לסוכנים, ל"איך לסגור" ול"✨ שאל"
// ---------------------------------------------------------------------------

function deptOf(actor) {
  if (actor?.type !== 'user') return '';
  return D.get('SELECT d.name FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?', actor.id)?.name ?? '';
}

const DEPT_LABEL = { office: 'משרד ומינהלה', realestate: 'נדל"ן', finance: 'כספים', hr: 'משאבי אנוש', marketing: 'שיווק ומכירות', other: '' };
const DEPT_MATCH = { office: /משרד|מינהל|הנהלה/, realestate: /נדל|בנייה|הנדס|קרקע|פרויקט/, finance: /כספ|חשבונ|כלכל/, hr: /משאבי אנוש|כוח אדם|HR/i, marketing: /שיווק|מכירות/ };

function search(query, { limit = 5, actor = null } = {}) {
  const ws = words(query);
  if (!ws.length) return [];
  const dept = deptOf(actor);
  const admin = actor?.type === 'user' && ['superadmin', 'admin'].includes(actor.role);
  return D.all('SELECT * FROM org_knowledge WHERE hidden = 0')
    .filter((e) => !e.dept_only || admin || (DEPT_MATCH[e.dept]?.test(dept)))
    .map((e) => {
      const dom = Memory.normalize(`${e.domain} ${e.project}`);
      const txt = Memory.normalize(e.text);
      return { e, s: ws.reduce((n, w) => n + (dom.includes(w) ? 3 : 0) + (txt.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || b.e.cases - a.e.cases)
    .slice(0, limit)
    .map((x) => x.e);
}

// ---------------------------------------------------------------------------
// מסך הניהול
// ---------------------------------------------------------------------------

function list({ q = '', dept = '', week = false } = {}) {
  let rows = q.trim() ? search(q, { limit: 200, actor: { type: 'user', role: 'admin' } }) : D.all('SELECT * FROM org_knowledge ORDER BY updated_at DESC LIMIT 500');
  if (q.trim()) rows = rows.concat(D.all('SELECT * FROM org_knowledge WHERE hidden = 1')).filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i && (e.hidden ? Memory.normalize(`${e.domain} ${e.text}`).includes(Memory.normalize(q)) : true));
  if (dept) rows = rows.filter((e) => e.dept === dept);
  if (week) rows = rows.filter((e) => Date.now() - new Date(e.updated_at).getTime() < 7 * 86400000);
  return {
    entries: rows.map((e) => ({ ...e, deptLabel: DEPT_LABEL[e.dept] ?? '' })),
    stats: {
      total: D.get('SELECT COUNT(*) c FROM org_knowledge').c,
      hidden: D.get('SELECT COUNT(*) c FROM org_knowledge WHERE hidden = 1').c,
      newThisWeek: D.get('SELECT COUNT(*) c FROM org_knowledge WHERE updated_at >= ?', new Date(Date.now() - 7 * 86400000).toISOString()).c,
      pendingLessons: D.get('SELECT COUNT(*) c FROM org_lessons WHERE knowledge_id IS NULL AND dropped = 0').c,
      lastMerge: D.getSetting('org_merge_last', null)
    },
    depts: DEPT_LABEL
  };
}

function edit(id, { domain, text, project, dept, hidden, deptOnly }) {
  const e = D.get('SELECT * FROM org_knowledge WHERE id = ?', id);
  if (!e) throw Object.assign(new Error('לא נמצא'), { status: 404 });
  const changedContent = typeof text === 'string' || typeof domain === 'string';
  D.run(
    'UPDATE org_knowledge SET domain = ?, text = ?, project = ?, dept = ?, hidden = ?, dept_only = ?, edited = ?, updated_at = ? WHERE id = ?',
    typeof domain === 'string' && domain.trim() ? domain.trim().slice(0, 80) : e.domain,
    typeof text === 'string' && text.trim() ? scrub(text.trim()).slice(0, 6000) : e.text,
    typeof project === 'string' ? project.trim().slice(0, 120) : e.project,
    DEPTS.includes(dept) ? dept : e.dept,
    typeof hidden === 'boolean' ? (hidden ? 1 : 0) : e.hidden,
    typeof deptOnly === 'boolean' ? (deptOnly ? 1 : 0) : e.dept_only,
    changedContent ? 1 : e.edited,
    nowIso(), id
  );
  return D.get('SELECT * FROM org_knowledge WHERE id = ?', id);
}

function remove(id) {
  // הלקחים שהרכיבו אותו לא יתאחדו שוב לערך חדש
  D.run('UPDATE org_lessons SET dropped = 1 WHERE knowledge_id = ?', id);
  D.run('DELETE FROM org_knowledge WHERE id = ?', id);
}

/** מאיפה הגיע הערך — עובד, תאריך, מה קרה. המייל עצמו נפתח רק לבעל התיבה */
function sources(id) {
  return D.all('SELECT user_name, happened_at, summary FROM org_knowledge_sources WHERE knowledge_id = ? ORDER BY happened_at DESC LIMIT 100', id);
}

module.exports = { daily, distillUser, mergeAll, search, list, edit, remove, sources, scrub, _internal: { validTz, luhn, matchEntry } };
