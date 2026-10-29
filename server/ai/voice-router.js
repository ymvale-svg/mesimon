'use strict';
/**
 * הקלטה אחת, כמה בקשות — "פתח משימה לשושנה, ושלח מייל לאורן שיביא את
 * ההסכם". משמש את ההקלטה באפליקציה ואת ההודעות הקוליות לבוט: הבקשות
 * מטופלות אחת-אחת, וכל אחת מקבלת אישור משלה.
 *
 * הודעה קצרה אינה נשלחת לפירוק — בקשה של משפט אחד היא בקשה אחת, וקריאה
 * נוספת ל-AI רק הייתה מאטה אותה.
 */
const fs = require('node:fs');
const path = require('node:path');
const Claude = require('./claude');

const SKILL = path.join(__dirname, 'skills', 'voice-router.md');
const MIN_WORDS = 10;
const MAX_REQUESTS = 5;

// מילים שמחברות בקשות — בלעדיהן אין סיבה לחשוד שיש יותר מאחת
const JOINERS = /(?:^|\s)(?:ו(?:גם|תפתח|תשלח|שלח|פתח|תגיד|תכתוב|תזכיר|תענה|תקבע|קבע)|וכן|אחר כך|בנוסף|דבר נוסף|ועוד)(?=\s|$)/;

const SCHEMA = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['task', 'other'] }, text: { type: 'string' } },
        required: ['kind', 'text'],
        additionalProperties: false
      }
    }
  },
  required: ['requests'],
  additionalProperties: false
};

/**
 * @param {string} text
 * @param {{classify?: boolean}} opts  ‎classify‎ — גם בבקשה אחת לדעת אם היא משימה (באפליקציה)
 * @returns {Promise<{kind: 'task'|'other'|null, text: string}[]>}  ‎kind‎ ‎null‎ — לא סווג
 */
async function split(text, { classify = false } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ').length;
  const maybeMany = words >= MIN_WORDS && JOINERS.test(clean);
  if (!Claude.isEnabled() || (!maybeMany && !classify)) return [{ kind: null, text: clean }];
  try {
    const out = await Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text: `<<<\n${clean.slice(0, 4000)}\n>>>` }], schema: SCHEMA, effort: 'low' });
    const requests = (out.requests ?? [])
      .map((r) => ({ kind: r.kind === 'task' ? 'task' : 'other', text: String(r.text ?? '').trim() }))
      .filter((r) => r.text)
      .slice(0, MAX_REQUESTS);
    return requests.length ? requests : [{ kind: null, text: clean }];
  } catch (err) {
    // בלי פירוק — הכול כבקשה אחת, כמו קודם
    console.error('[משימון] פירוק ההקלטה לבקשות נכשל:', err.message);
    return [{ kind: null, text: clean }];
  }
}

module.exports = { split };
