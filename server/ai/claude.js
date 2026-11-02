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

/*
 * שיחה חיה (הבוט, ההקלטה) — מישהו מחכה לתשובה. מודל משלה (‎ai_bot_model‎,
 * ריק = המודל הראשי), ומצב מהיר (‎ai_fast_mode‎): אותו מודל, פלט מהיר עד פי
 * 2.5, במחיר כפול. רק במודלים שתומכים בו; כשהמצב המהיר אינו זמין (מכסה,
 * מודל אחר) — אותה בקשה בלעדיו, כך שהמהירות לעולם אינה עולה בתשובה.
 */
const FAST_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']);
const botModel = () => String(D.getSetting('ai_bot_model', '') || '').trim() || model();
const fastMode = () => Boolean(D.getSetting('ai_fast_mode', true));

const withFallback = (m) => /^claude-(opus|fable|sonnet-5-5)/.test(m);

const status = () => ({ enabled: isEnabled(), model: model(), botModel: botModel(), fast: fastMode() });

class AiError extends Error {}

/**
 * @param {object} opts
 * @param {string} opts.system           ההנחיות הקבועות (הסקיל)
 * @param {Array}  opts.content          בלוקי התוכן של הודעת המשתמש
 * @param {object} opts.schema           סכמת JSON לתשובה
 * @param {string} [opts.effort]         low | medium | high
 * @param {boolean} [opts.live]          מישהו מחכה לתשובה — מודל הבוט ומצב מהיר
 * @returns {Promise<object>}            התשובה כאובייקט שעבר את הסכמה
 */
async function json({ system, content, schema, effort = 'medium', live = false }) {
  if (!isEnabled()) throw new AiError('חיבור ה-AI אינו מוגדר בשרת (ANTHROPIC_API_KEY)');
  const m = live ? botModel() : model();
  const fast = live && fastMode() && FAST_MODELS.has(m);
  try {
    return await request({ system, content, schema, effort, model: m, fast });
  } catch (err) {
    // המצב המהיר נדחה (מכסה נפרדת, חשבון בלי גישה) — אותה בקשה במהירות רגילה
    if (fast && err.status && err.status < 500) return request({ system, content, schema, effort, model: m, fast: false });
    throw err;
  }
}

async function request({ system, content, schema, effort, model: modelId, fast }) {
  const body = {
    model: modelId,
    max_tokens: 16000,
    // ההנחיות זהות בכל קריאה — מטמון הפרומפט חוסך את רובן מהקריאה השנייה
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: {
      effort,
      format: { type: 'json_schema', schema }
    },
    // בקשה שנדחתה על ידי מסנני הבטיחות עוברת למודל חלופי בצד השרת (לא ב-Haiku)
    ...(withFallback(modelId) ? { fallbacks: 'default' } : {}),
    ...(fast ? { speed: 'fast' } : {})
  };

  const betas = [withFallback(modelId) ? 'server-side-fallback-2026-07-01' : null, fast ? 'fast-mode-2026-02-01' : null].filter(Boolean);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey(),
        'anthropic-version': '2023-06-01',
        ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {})
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
    err.status = res.status;
    throw err;
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

module.exports = { json, isEnabled, status, model, botModel, AiError, DEFAULT_MODEL };
