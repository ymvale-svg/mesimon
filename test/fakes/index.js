'use strict';
/**
 * זיופים לשירותים החיצוניים — לבדיקות של זרימה שלמה (תחום אחד מול "העולם").
 * כל זיוף מוחלף דרך ‎t.mock.method‎ על אובייקט המודול שב-‎server/integrations/‎, ולכן מוחזר אוטומטית בסוף הבדיקה.
 *
 *   const wa = Fakes.whatsapp(t);            // כל מה שהבוט "שלח": wa.texts(), wa.buttons(), wa.last()
 *   Fakes.claude(t, (opts) => ({ … }));      // תשובת ה-AI לכל קריאה (‎json‎ / ‎withTools‎)
 *   const pr = Fakes.priority(t, { getOrder: async () => ({ … }) });  // קריאות; כל כתיבה נרשמת ב-pr.writes
 */
const WhatsApp = require('../../server/integrations/whatsapp');
const Claude = require('../../server/integrations/claude');
const Priority = require('../../server/integrations/priority');

/** וואטסאפ: כל ‎call‎ נרשם ומחזיר הצלחה. ‎opts.fail‎ — שיטות שייכשלו (למשל כפתורים) */
function whatsapp(t, { fail = [] } = {}) {
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (channel, method, opts = {}) => {
    calls.push({ method, body: opts.body ?? null });
    if (fail.includes(method)) throw new Error(`${method} נכשל (זיוף)`);
    return { idMessage: `fake-${calls.length}` };
  });
  t.mock.method(WhatsApp, 'sendFile', async (...args) => { calls.push({ method: 'sendFile', body: args }); return { idMessage: 'fake-file' }; });
  const out = () => calls.filter((c) => c.method !== 'sendReaction');
  return {
    calls,
    /** הודעות טקסט וכפתורים — הטקסט בלבד */
    texts: () => out().map((c) => c.body?.message ?? c.body?.body ?? '').filter(Boolean),
    /** הכיתובים של הכפתורים בהודעה האחרונה שהיו בה כפתורים */
    buttons: () => (out().filter((c) => c.method === 'sendInteractiveButtonsReply').at(-1)?.body.buttons ?? []).map((b) => b.buttonText),
    reactions: () => calls.filter((c) => c.method === 'sendReaction').map((c) => c.body?.reaction),
    last: () => out().at(-1),
    clear: () => { calls.length = 0; }
  };
}

/** Claude: מופעל, וכל קריאה עוברת ב-‎responder(opts, kind)‎. ‎calls‎ — מה נשאל */
function claude(t, responder = () => ({})) {
  const calls = [];
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(Claude, 'json', async (opts) => { calls.push({ kind: 'json', opts }); return responder(opts, 'json'); });
  t.mock.method(Claude, 'withTools', async (opts) => { calls.push({ kind: 'tools', opts }); return responder(opts, 'tools'); });
  return { calls };
}

/** פונקציות של פריוריטי שכותבות. בזיוף הן נרשמות ולא מגיעות לשום מקום */
const WRITES = ['createReceipt', 'addOrderLine', 'addFreeLine', 'setLineQty', 'setLineDes', 'setHeader', 'attach', 'deleteAttachment',
  'setDialog', 'finalizeReceipt', 'cancelReceipt', 'deleteLines', 'createDemand', 'addDemandLine', 'setDemand', 'submitDemand',
  'cancelDemand', 'setDemandDialog', 'attachDemand'];

/**
 * פריוריטי: ‎reads‎ — מימושים לקריאות; ‎writes‎ — מימושים לכתיבות (ברירת מחדל: נרשם ומחזיר ‎{}‎).
 * כל פונקציה אחרת שנקראת ולא זויפה — זורקת, כדי שבדיקה לא תסתמך בטעות על התנהגות אמיתית.
 */
function priority(t, reads = {}, { writes = {}, enabled = true } = {}) {
  const log = [];
  t.mock.method(Priority, 'isEnabled', () => enabled);
  for (const name of Object.keys(Priority)) {
    if (typeof Priority[name] !== 'function' || name === 'isEnabled' || /^[A-Z]/.test(name)) continue;
    if (reads[name]) t.mock.method(Priority, name, async (...a) => reads[name](...a));
    else if (WRITES.includes(name)) {
      t.mock.method(Priority, name, async (...a) => { log.push({ name, args: a }); return writes[name] ? writes[name](...a) : {}; });
    } else if (['allowed', 'companyOf', 'isTest', 'resolveCompany', 'companiesByName', 'payTerm', 'payLabel', 'payFromText', 'dueDate',
      'nextSigner', 'isNoApproversError', 'matchProjects'].includes(name)) {
      continue; // עזרים טהורים — האמיתיים
    } else {
      t.mock.method(Priority, name, async () => { throw new Error(`פריוריטי.${name} לא זויף בבדיקה`); });
    }
  }
  return { writes: log, wrote: (name) => log.filter((w) => w.name === name) };
}

module.exports = { whatsapp, claude, priority, WRITES };
