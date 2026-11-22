'use strict';
/**
 * 📍 מיקום ונקודות ציון (‎whatsapp/places.js‎) — תזכורות לפי מיקום.
 *
 *   GET    /api/places                 — נקודות הציון (לכל העובדים)
 *   POST   /api/places                 — הוספה (מנהל / מנהל מערכת)
 *   PUT    /api/places/:id             — עריכה (מנהל)
 *   DELETE /api/places/:id             — מחיקה (מנהל) — תזכורות שחיכו לה מתבטלות
 *   GET    /api/me/location            — המצב שלי: משתף מיקום בזמן אמת עם הבוט? באיזו נקודת ציון? כמה תזכורות מחכות
 *
 * המיקום עצמו מגיע רק מוואטסאפ (‎whatsapp/places.js‎) — שיתוף מהאפליקציה הוסר (16.11.26: היא לא פתוחה אצל העובדים כל הזמן).
 */
const Places = require('../whatsapp').Places;
const { badRequest, forbidden, notFound, readJson, sendJson } = require('../core').HttpKit;

// מנהל מחלקה ומעלה (מנהל מערכת, הנהלה) — עורכים נקודות ציון; כל העובדים רואים אותן
const isManagerial = (actor) => ['superadmin', 'admin', 'executive', 'manager'].includes(actor.role);

function register(router) {
  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };
  const manager = (ctx) => {
    const actor = userOnly(ctx);
    if (!isManagerial(actor)) throw forbidden('רק מנהל יכול לערוך נקודות ציון');
    return actor;
  };
  const asBad = (fn) => {
    try { return fn(); } catch (err) { throw err?.status ? err : badRequest(err.message); }
  };

  router.get('/api/places', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { places: Places.list(), canEdit: isManagerial(actor), kinds: Places.KINDS, radius: Places.DEFAULT_RADIUS });
  });

  router.post('/api/places', async (req, res, ctx) => {
    const actor = manager(ctx);
    const b = await readJson(req);
    sendJson(res, 201, { place: asBad(() => Places.create(actor, b)) });
  });

  router.put('/api/places/:id', async (req, res, ctx) => {
    manager(ctx);
    const b = await readJson(req);
    const place = asBad(() => Places.update(Number(ctx.params.id), b));
    if (!place) throw notFound('המקום לא נמצא');
    sendJson(res, 200, { place });
  });

  router.delete('/api/places/:id', async (req, res, ctx) => {
    manager(ctx);
    if (!Places.remove(Number(ctx.params.id))) throw notFound('המקום לא נמצא');
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me/location', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, Places.status(actor.id));
  });
}

module.exports = { register };
