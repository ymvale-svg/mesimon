'use strict';
/**
 * 🗂 נקודות הקצה של משימון פריוריטי (‎/priority‎) — ‎/api/priority/*‎.
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md".
 *   • ‎GET  /api/priority/me‎        — כל עובד: לאילו מסמכים ולאילו חברות הוא מורשה, והאם הוא מנהל.
 *   • ‎GET|PUT /api/priority/settings‎ — מנהלי מערכת: חיבור, חברות, ברירות מחדל. הסיסמה לעולם לא נשלחת חזרה.
 *   • ‎POST /api/priority/settings/test‎ — בדיקת חיבור (קריאה בלבד).
 *   • ‎GET|PUT /api/priority/access‎  — מנהלי מערכת: מטריצת ההרשאות.
 *   • ‎GET  /api/priority/log‎       — יומן השינויים בהגדרות ובהרשאות.
 */
const Settings = require('../priority').PrioritySettings;
const Access = require('../priority').PriorityAccess;
const Priority = require('../integrations').Priority;
const { badRequest, forbidden, readJson, sendJson } = require('../core').HttpKit;

const userOnly = (ctx) => {
  const actor = ctx.requireActor();
  if (actor.type !== 'user') throw forbidden();
  return actor;
};
const adminOnly = (ctx) => {
  const actor = userOnly(ctx);
  if (!Access.isAdmin(actor)) throw forbidden('רק מנהלי מערכת מנהלים את הגדרות פריוריטי וההרשאות');
  return actor;
};
const asBad = (fn) => {
  try { return fn(); } catch (err) { throw err?.status ? err : badRequest(err.message); }
};
const who = (actor) => ({ id: actor.id, name: actor.name });

function register(router) {
  router.get('/api/priority/me', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const a = Access.of({ id: actor.id, role: actor.role });
    const all = Settings.companies();
    const codes = a.companies === null ? all.map((c) => c.code) : a.companies;
    sendJson(res, 200, {
      name: actor.name,
      admin: Access.isAdmin(actor),
      docs: Access.DOCS.map((d) => ({ key: d.key, label: d.label, ready: d.ready, allowed: a.docs.includes(d.key) })),
      companies: all.filter((c) => codes.includes(c.code) && !c.test).map((c) => ({ code: c.code, name: c.name })),
      allCompanies: a.companies === null,
      connected: Priority.isEnabled()
    });
  });

  router.get('/api/priority/settings', async (req, res, ctx) => {
    adminOnly(ctx);
    sendJson(res, 200, { ...Settings.forDisplay(), payTerms: Priority.PAY_TERMS });
  });

  router.put('/api/priority/settings', async (req, res, ctx) => {
    const actor = adminOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, asBad(() => Settings.save(b, { by: who(actor) })));
  });

  router.post('/api/priority/settings/test', async (req, res, ctx) => {
    adminOnly(ctx);
    const b = await readJson(req).catch(() => ({}));
    if (!Priority.isEnabled()) return sendJson(res, 200, { ok: false, error: 'חסרים שם משתמש או סיסמה' });
    const list = Settings.companies();
    const company = list.find((c) => c.code === b?.company)?.code ?? list.find((c) => !c.test)?.code ?? list[0]?.code;
    try {
      await Priority.ping(company);
      sendJson(res, 200, { ok: true, company });
    } catch (err) {
      sendJson(res, 200, { ok: false, company, error: err.message });
    }
  });

  router.get('/api/priority/access', async (req, res, ctx) => {
    adminOnly(ctx);
    sendJson(res, 200, { ...Access.matrix(), companies: Settings.companies().filter((c) => !c.test) });
  });

  router.put('/api/priority/access', async (req, res, ctx) => {
    const actor = adminOnly(ctx);
    const b = await readJson(req);
    const changes = asBad(() => Access.save(b?.rows));
    Settings.note(Settings.DEFAULT_ORG, who(actor), changes);
    sendJson(res, 200, { ...Access.matrix(), companies: Settings.companies().filter((c) => !c.test), changes });
  });

  router.get('/api/priority/log', async (req, res, ctx) => {
    adminOnly(ctx);
    sendJson(res, 200, { items: Settings.history().slice(0, 100) });
  });
}

module.exports = { register };
