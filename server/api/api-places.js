'use strict';
/**
 * 📍 מיקום ונקודות ציון (‎whatsapp/places.js‎) — תזכורות לפי מיקום.
 *
 *   GET    /api/places                 — נקודות הציון (לכל העובדים)
 *   POST   /api/places                 — הוספה (מנהל / מנהל מערכת)
 *   PUT    /api/places/:id             — עריכה (מנהל)
 *   DELETE /api/places/:id             — מחיקה (מנהל) — תזכורות שחיכו לה מתבטלות
 *   GET    /api/me/location            — מצב השיתוף שלי
 *   PUT    /api/me/location/share      — הפעלה / כיבוי של שיתוף המיקום
 *   POST   /api/me/location            — מיקום מהאפליקציה (רק כשהשיתוף דלוק)
 *   POST   /api/me/location/token      — קישור אישי חדש לאפליקציית מעקב ברקע (מוצג פעם אחת)
 *   POST   /api/location/ping/:token   — מיקום מאפליקציית מעקב (OwnTracks / קיצורי דרך), בלי התחברות — האסימון הוא ההרשאה
 *
 * המיקום עצמו לא חוזר לאף אחד — רק באיזו נקודת ציון העובד נמצא, ולו בלבד.
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

  router.put('/api/me/location/share', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, Places.setSharing(actor.id, b.share === true));
  });

  router.post('/api/me/location', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const r = Places.report(actor.id, { lat: b.lat, lng: b.lng, accuracy: b.accuracy, source: 'app' });
    if (r.reason === 'bad') throw badRequest('מיקום לא תקין');
    sendJson(res, 200, { ok: r.ok, reason: r.reason ?? null, place: r.place ? { id: r.place.id, name: r.place.name } : null, fired: r.fired.length });
  });

  router.post('/api/me/location/token', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { token: Places.newToken(actor.id) });
  });

  /*
   * אפליקציית מעקב ברקע. גוף בפורמט של OwnTracks (‎{ _type: 'location', lat, lon, acc, tst }‎) או פשוט (‎{ lat, lng, accuracy }‎).
   * OwnTracks מצפה למערך בתשובה. אסימון לא מוכר / שיתוף כבוי — 404, בלי לגלות למה.
   */
  router.post('/api/location/ping/:token', async (req, res, ctx) => {
    const userId = Places.userByToken(ctx.params.token);
    if (!userId) throw notFound('לא נמצא');
    const b = await readJson(req).catch(() => ({}));
    if (b._type && b._type !== 'location') return sendJson(res, 200, []);
    const r = Places.report(userId, {
      lat: b.lat ?? b.latitude, lng: b.lng ?? b.lon ?? b.longitude, accuracy: b.acc ?? b.accuracy, source: 'tracker',
      at: Number.isFinite(Number(b.tst)) && b.tst ? new Date(Number(b.tst) * 1000).toISOString() : null
    });
    if (r.reason === 'bad') throw badRequest('מיקום לא תקין');
    sendJson(res, 200, []);
  });
}

module.exports = { register };
