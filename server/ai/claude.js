'use strict';
/**
 * לקוח מינימלי ל-Claude — קריאה אחת ל-Messages API, ללא תלויות.
 *
 * למה ‎fetch‎ ולא ה-SDK הרשמי: למשימון אין שום תלות חיצונית, וההפעלה היא
 * לחיצה כפולה על קובץ BAT בלי ‎npm install‎. הוספת חבילה אחת הייתה שוברת
 * את ההבטחה הזו בשביל קריאת HTTP אחת.
 *
 * כל קריאה מחזירה JSON לפי סכמה (‎output_config.format‎), ולכן הקוד שסביבה
 * אינו מפרש טקסט חופשי — מקבלים שדות מוגדרים או שגיאה.
 *
 * מופעל רק אם הוגדר ‎ANTHROPIC_API_KEY‎. בלעדיו משימות AI פשוט אינן זמינות,
 * והממשק אומר זאת במפורש.
 */
const D = require('../db');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';

const apiKey = () => process.env.ANTHROPIC_API_KEY ?? '';
const isEnabled = () => Boolean(apiKey());
const model = () => String(D.getSetting('ai_model', DEFAULT_MODEL) || DEFAULT_MODEL).trim();

const status = () => ({ enabled: isEnabled(), model: model() });

class AiError extends Error {}

/**
 * @param {object} opts
 * @param {string} opts.system           ההנחיות הקבועות (הסקיל)
 * @param {Array}  opts.content          בלוקי התוכן של הודעת המשתמש
 * @param {object} opts.schema           סכמת JSON לתשובה
 * @param {string} [opts.effort]         low | medium | high
 * @param {string} [opts.model]          מודל אחר מברירת המחדל — לעבודה רבה וזולה (זיכרון המייל)
 * @param {(usage: object) => void} [opts.onUsage]  כמה טוקנים נצרכו — למעקב עלות
 * @returns {Promise<object>}            התשובה כאובייקט שעבר את הסכמה
 */
async function json({ system, content, schema, effort = 'medium', model: modelId = null, onUsage = null }) {
  if (!isEnabled()) throw new AiError('חיבור ה-AI אינו מוגדר בשרת (ANTHROPIC_API_KEY)');

  const chosen = String(modelId || model()).trim();
  // ל-Haiku אין מודל חלופי בצד השרת — הפרמטר היה נדחה
  const withFallback = !/haiku/i.test(chosen);
  const body = {
    model: chosen,
    max_tokens: 16000,
    // ההנחיות זהות בכל קריאה — מטמון הפרומפט חוסך את רובן מהקריאה השנייה
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: {
      effort,
      format: { type: 'json_schema', schema }
    },
    // בקשה שנדחתה על ידי מסנני הבטיחות עוברת למודל חלופי בצד השרת
    ...(withFallback ? { fallbacks: 'default' } : {})
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey(),
        'anthropic-version': '2023-06-01',
        ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
  } catch (err) {
    throw new AiError(`אין חיבור לשירות ה-AI: ${err.message}`);
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* מטופל למטה */ }

  if (!res.ok) {
    const msg = data?.error?.message ?? text.slice(0, 300);
    // 429 ו-5xx הם תקלה זמנית — המנוע ינסה שוב בסבב הבא
    const err = new AiError(`שירות ה-AI החזיר שגיאה ${res.status}: ${msg}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  if (onUsage && data?.usage) {
    try { onUsage(data.usage); } catch { /* מעקב בלבד */ }
  }

  if (data?.stop_reason === 'refusal') {
    throw new AiError('ה-AI סירב לטפל בבקשה הזו');
  }
  if (data?.stop_reason === 'max_tokens') {
    throw new AiError('תשובת ה-AI נקטעה באמצע');
  }

  const out = (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new AiError('תשובת ה-AI אינה במבנה הצפוי');
  }
}

/*
 * מחירון לכל מיליון טוקנים (דולר), לחישוב הערכת עלות בלבד — לא לחיוב.
 * מודל שאינו כאן: ההערכה מוצגת בטוקנים בלי סכום.
 */
const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 }
};
const priceOf = (id) => PRICES[String(id ?? '').trim()] ?? null;

module.exports = { json, isEnabled, status, model, priceOf, AiError, DEFAULT_MODEL };
