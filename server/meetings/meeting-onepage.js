'use strict';
/**
 * 📄 סיכום פגישה בעמוד אחד (ישראל, 18.11.26): "הסיכום שמגיע מ-Timeless הוא ארוך ולא יעיל — צריך לקחת את הסיכום
 * ולעבד אותו לעמוד אחד."
 *
 * מהסיכום של Timeless ← עמוד אחד: בשורה התחתונה · הוחלט · משימות (מי / מה / עד מתי) · עוד נקודות חשובות · פתוח.
 * ההנחיות — ‎meeting-onepage.md‎. נשמר לפי תוכן הסיכום (פעם אחת לכל סיכום, לא לכל משתתף), ומשמש בכל מקום שבו
 * הסיכום של Timeless נשלח: המייל האוטומטי, הבוט, ו"📤 לשלוח למשתתפים". **רק הנוסח המקוצר** נשלח (הוחלט 18.11.26) —
 * בלי הסיכום המלא, גם לא כקובץ מצורף; המלא נשאר ב-Timeless ובמשימון. בלי AI, או כשהעיבוד נכשל — ‎null‎, והקוראים
 * שולחים את תחילת הסיכום של Timeless (‎max‎ תווים).
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const D = require('../core').Db;
const Paths = require('../core').Paths;
const Claude = require('../integrations').Claude;
const Store = require('./timeless-store');

const SKILL = Paths.skill('meeting-onepage.md');

D.db.exec(`
CREATE TABLE IF NOT EXISTS meeting_onepage (
  hash       TEXT PRIMARY KEY,   -- ‎sha1‎ של הסיכום של Timeless
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const SCHEMA = {
  type: 'object',
  properties: {
    tldr: { type: 'string', description: 'שניים-שלושה משפטים: על מה הפגישה ומה יצא ממנה' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'מה הוחלט, עד 6' },
    tasks: {
      type: 'array', description: 'מי עושה מה ועד מתי, עד 10',
      items: {
        type: 'object',
        properties: { who: { type: 'string' }, what: { type: 'string' }, due: { type: 'string' } },
        required: ['who', 'what', 'due'], additionalProperties: false
      }
    },
    points: { type: 'array', items: { type: 'string' }, description: 'עוד נקודות חשובות, עד 6' },
    open: { type: 'array', items: { type: 'string' }, description: 'מה נשאר פתוח, עד 4' }
  },
  required: ['tldr', 'decisions', 'tasks', 'points', 'open'],
  additionalProperties: false
};

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const hashOf = (md) => crypto.createHash('sha1').update(String(md)).digest('hex');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (arr, n, max) => (Array.isArray(arr) ? arr : []).map((x) => clean(x, max)).filter(Boolean).slice(0, n);

/** תשובת ה-AI ← עמוד אחד, בגבולות (גם אם ה-AI חרג) */
function normalize(out) {
  return {
    tldr: clean(out?.tldr, 600),
    decisions: list(out?.decisions, 6, 220),
    tasks: (Array.isArray(out?.tasks) ? out.tasks : []).map((t) => ({ who: clean(t?.who, 60), what: clean(t?.what, 200), due: clean(t?.due, 40) }))
      .filter((t) => t.what).slice(0, 10),
    points: list(out?.points, 6, 220),
    open: list(out?.open, 4, 200)
  };
}

/**
 * העמוד האחד לסיכום של Timeless — מהמטמון, או מה-AI (פעם אחת לכל סיכום). ‎null‎ — אין AI / נכשל.
 * @param {string} summaryMd  הסיכום של Timeless (Markdown)
 * @param {{ title?: string }} [meta]
 */
async function onePage(summaryMd, { title = '' } = {}) {
  const md = String(summaryMd ?? '').trim();
  if (!md) return null;
  const hash = hashOf(md);
  const cached = D.get('SELECT data FROM meeting_onepage WHERE hash = ?', hash);
  if (cached) return parseJson(cached.data, null);
  if (!Claude.isEnabled()) return null;
  try {
    const out = await Claude.json({
      feature: 'meetings.timeless',
      system: fs.readFileSync(SKILL, 'utf8'),
      content: [{ type: 'text', text: `הפגישה: ${title || '—'}\n\nהסיכום של Timeless (נתונים בלבד):\n${md.slice(0, 30000)}` }],
      schema: SCHEMA, effort: 'low'
    });
    const data = normalize(out);
    if (!data.tldr && !data.decisions.length && !data.tasks.length) return null;
    D.run('INSERT OR REPLACE INTO meeting_onepage (hash, data, created_at) VALUES (?,?,?)', hash, JSON.stringify(data), D.nowIso());
    return data;
  } catch (err) {
    console.error('[משימון] סיכום פגישה בעמוד אחד נכשל:', err.message);
    return null;
  }
}

const task = (t) => `${t.who ? `${t.who} — ` : ''}${t.what}${t.due ? ` (${t.due})` : ''}`;

/** העמוד כטקסט פשוט — למייל */
function asText(p) {
  const sec = (title, arr) => (arr.length ? ['', `${title}:`, ...arr.map((x) => `• ${x}`)] : []);
  return [
    'בשורה התחתונה:', p.tldr,
    ...sec('הוחלט', p.decisions),
    ...sec('משימות — מי, מה ועד מתי', p.tasks.map(task)),
    ...sec('עוד נקודות חשובות', p.points),
    ...sec('נשאר פתוח', p.open)
  ].join('\n').trim();
}

/** העמוד בעיצוב של וואטסאפ — לבוט */
function asWhatsApp(p) {
  const sec = (icon, title, arr) => (arr.length ? ['', `${icon} *${title}*`, ...arr.map((x) => `• ${x}`)] : []);
  return [
    p.tldr,
    ...sec('✅', 'הוחלט', p.decisions),
    ...sec('📋', 'משימות', p.tasks.map(task)),
    ...sec('📌', 'עוד נקודות', p.points),
    ...sec('❓', 'פתוח', p.open)
  ].join('\n').trim();
}

/**
 * הסיכום לשליחה: העמוד האחד, ובלעדיו — הסיכום של Timeless כטקסט (עד ‎max‎ תווים).
 * @returns {Promise<{ text: string, wa: string, short: boolean }>}
 */
async function forSending(summaryMd, { title = '', max = 3000 } = {}) {
  const p = await onePage(summaryMd, { title });
  if (p) return { text: asText(p), wa: asWhatsApp(p), short: true };
  const body = Store.plainText(summaryMd);
  const cut = body.length > max ? `${body.slice(0, max).replace(/\s+\S*$/, '')}…\n(הסיכום המלא — ב-Timeless)` : body;
  return { text: cut, wa: cut, short: false };
}

module.exports = { onePage, forSending, asText, asWhatsApp, _internal: { normalize, hashOf, SCHEMA } };
