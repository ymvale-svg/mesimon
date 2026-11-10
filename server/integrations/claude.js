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
const D = require('../core').Db;

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
 * @param {string} [opts.model]          מודל אחר מברירת המחדל — לעבודה רבה וזולה (זיכרון המייל, ניתוב)
 * @param {(usage: object) => void} [opts.onUsage]  כמה טוקנים נצרכו — למעקב עלות
 * @param {Array}  [opts.serverTools]    כלים שרצים בצד של Anthropic (חיפוש ברשת — ‎WEB_SEARCH‎). התשובה הסופית — עדיין לפי הסכמה
 * @returns {Promise<object>}            התשובה כאובייקט שעבר את הסכמה
 */
async function json({ system, content, schema, effort = 'medium', live = false, model: modelId = null, onUsage = null, serverTools = null }) {
  if (!isEnabled()) throw new AiError('חיבור ה-AI אינו מוגדר בשרת (ANTHROPIC_API_KEY)');
  const m = String(modelId || (live ? botModel() : model())).trim();
  const fast = live && !modelId && fastMode() && FAST_MODELS.has(m);
  try {
    return await request({ system, content, schema, effort, model: m, fast, onUsage, serverTools });
  } catch (err) {
    // המצב המהיר נדחה (מכסה נפרדת, חשבון בלי גישה) — אותה בקשה במהירות רגילה
    if (fast && err.status && err.status < 500) return request({ system, content, schema, effort, model: m, fast: false, onUsage, serverTools });
    throw err;
  }
}

/** חיפוש ברשת — כלי שרץ אצל Anthropic. ‎max‎ — כמה חיפושים לכל היותר בבקשה אחת */
const WEB_SEARCH = (max = 6) => ({ type: 'web_search_20250305', name: 'web_search', max_uses: max, user_location: { type: 'approximate', country: 'IL', timezone: 'Asia/Jerusalem' } });

async function request({ system, content, schema, effort, model: modelId, fast, onUsage = null, serverTools = null }) {
  // חיפוש ארוך עוצר באמצע (‎pause_turn‎) — שולחים שוב עם מה שנעשה עד עכשיו, עד 4 פעמים
  const messages = [{ role: 'user', content }];
  for (let round = 0; ; round++) {
    const data = await requestOnce({ system, messages, schema, effort, model: modelId, fast, onUsage, serverTools });
    if (data?.stop_reason === 'pause_turn' && round < 4) {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    return parseOutput(data);
  }
}

async function requestOnce({ system, messages, schema, effort, model: modelId, fast, onUsage, serverTools }) {
  const body = {
    model: modelId,
    max_tokens: 16000,
    // ההנחיות זהות בכל קריאה — מטמון הפרומפט חוסך את רובן מהקריאה השנייה
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    ...(serverTools?.length ? { tools: serverTools } : {}),
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

  if (onUsage && data?.usage) {
    try { onUsage(data.usage); } catch { /* מעקב בלבד */ }
  }
  return data;
}

function parseOutput(data) {
  if (data?.stop_reason === 'refusal') {
    throw new AiError('ה-AI סירב לטפל בבקשה הזו');
  }
  if (data?.stop_reason === 'max_tokens') {
    throw new AiError('תשובת ה-AI נקטעה באמצע');
  }

  // עם חיפוש ברשת יש טקסט ביניים לפני החיפושים — התשובה היא הטקסט שאחרי הכלי האחרון
  const blocks = data?.content ?? [];
  const lastTool = blocks.map((b) => /tool_use|tool_result/.test(b.type)).lastIndexOf(true);
  const out = blocks.slice(lastTool + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new AiError('תשובת ה-AI אינה במבנה הצפוי');
  }
}

/**
 * שיחה עם כלים — לסוכנים: ה-AI קורא לכלים (מחשבון, מקור נתונים, קובץ עזר)
 * באמצע התשובה, הקוד מריץ אותם ומחזיר את התוצאה, עד שיש תשובה סופית.
 *
 * תוכן התשובה של ה-AI מוחזר לשיחה **כמו שהוא** (כולל בלוקי חשיבה) — כך דורש
 * ה-API בשיחה עם כלים. אין כפייה של כלי (‎tool_choice: auto‎): במודלים החדשים
 * כפייה נדחית.
 *
 * @param {object} opts
 * @param {string} opts.system
 * @param {Array}  opts.content              ההודעה הראשונה (בלוקי תוכן)
 * @param {Array}  opts.tools                הגדרות הכלים ‎{name, description, input_schema}‎
 * @param {(name: string, input: object) => Promise<any>} opts.onTool
 * @param {number} [opts.maxTurns]           כמה סבבי כלים לכל היותר
 * @param {boolean} [opts.live]              מישהו מחכה (✨ שאל, הבוט) — מצב מהיר, כמו ב-‎json‎
 * @returns {Promise<{text: string, calls: Array<{name, input, ok, ms}>}>}
 */
async function withTools({ system, content, tools, onTool, effort = 'medium', model: modelId = null, maxTurns = 6, onUsage = null, live = false }) {
  if (!isEnabled()) throw new AiError('חיבור ה-AI אינו מוגדר בשרת (ANTHROPIC_API_KEY)');
  const chosen = String(modelId || model()).trim();
  const fallback = withFallback(chosen);
  // מצב מהיר: אותו מודל, פלט מהיר עד פי 2.5. נדחה (מכסה, חשבון) — ממשיכים בלעדיו
  let fast = live && fastMode() && FAST_MODELS.has(chosen);
  const messages = [{ role: 'user', content }];
  const calls = [];

  for (let turn = 0; ; turn++) {
    const last = turn >= maxTurns;
    const body = {
      model: chosen,
      max_tokens: 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort },
      // בסבב האחרון — בלי כלים: חייבים לענות עם מה שיש
      ...(tools?.length && !last ? { tools, tool_choice: { type: 'auto' } } : {}),
      ...(fallback ? { fallbacks: 'default' } : {}),
      ...(fast ? { speed: 'fast' } : {})
    };
    const betas = [fallback ? 'server-side-fallback-2026-07-01' : null, fast ? 'fast-mode-2026-02-01' : null].filter(Boolean);
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
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* למטה */ }
    if (!res.ok && fast && res.status < 500) {
      // המצב המהיר נדחה — אותו סבב שוב, במהירות רגילה
      fast = false;
      turn--;
      continue;
    }
    if (!res.ok) {
      const err = new AiError(`שירות ה-AI החזיר שגיאה ${res.status}: ${data?.error?.message ?? raw.slice(0, 300)}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    if (onUsage && data?.usage) { try { onUsage(data.usage); } catch { /* מעקב בלבד */ } }
    if (data?.stop_reason === 'refusal') throw new AiError('ה-AI סירב לטפל בבקשה הזו');

    const blocks = data?.content ?? [];
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (data?.stop_reason !== 'tool_use' || !uses.length || last) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text && data?.stop_reason === 'max_tokens') throw new AiError('תשובת ה-AI נקטעה באמצע');
      return { text, calls };
    }

    messages.push({ role: 'assistant', content: blocks });
    // כל התוצאות של הסבב — בהודעה אחת, כמו שה-API מצפה
    const results = await Promise.all(uses.map(async (u) => {
      const started = Date.now();
      try {
        const out = await onTool(u.name, u.input ?? {});
        calls.push({ name: u.name, input: u.input, ok: true, ms: Date.now() - started });
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        return { type: 'tool_result', tool_use_id: u.id, content: text.slice(0, 40000) };
      } catch (err) {
        calls.push({ name: u.name, input: u.input, ok: false, ms: Date.now() - started, error: err.message });
        return { type: 'tool_result', tool_use_id: u.id, content: `שגיאה: ${err.message}`, is_error: true };
      }
    }));
    messages.push({ role: 'user', content: results });
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

module.exports = { json, withTools, isEnabled, status, model, botModel, priceOf, AiError, DEFAULT_MODEL, WEB_SEARCH };
