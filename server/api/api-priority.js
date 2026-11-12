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
 *   • טור המיילים והגרירה (‎priority-docs.js‎): ‎/api/priority/inbox‎, ‎/api/priority/docs‎ — כל עובד, רק שלו.
 */
const Settings = require('../priority').PrioritySettings;
const Access = require('../priority').PriorityAccess;
const Docs = require('../priority').PriorityDocs;
const Chain = require('../priority').PriorityChain;
const Desk = require('../priority').PriorityDesk;
const Priority = require('../integrations').Priority;
const { HttpError, badRequest, forbidden, readJson, sendJson, parseUrl } = require('../core').HttpKit;

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
/** שגיאה עם ‎status‎ מ-‎priority-docs.js‎ — כמו שהיא; אחרת 400 */
const docErr = (err) => (err instanceof HttpError ? err : new HttpError(err?.status ?? 400, err?.message ?? 'שגיאה'));
const docs = async (fn) => { try { return await fn(); } catch (err) { throw docErr(err); } };

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

  // ---------------------------------------------------------------- טור המיילים והגרירה
  router.get('/api/priority/inbox', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { items: Docs.inbox(actor) });
  });

  router.post('/api/priority/inbox/:id/take', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 201, { doc: await docs(() => Docs.take(actor, ctx.params.id, String(b.doc ?? ''))) });
  });

  router.post('/api/priority/inbox/:id/dismiss', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await docs(() => Docs.dismiss(actor, ctx.params.id));
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/priority/docs', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const doc = parseUrl(req).searchParams.get('doc') || null;
    sendJson(res, 200, { items: Docs.list(actor, { doc }), counts: Docs.counts(actor) });
  });

  router.post('/api/priority/docs', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 201, { doc: await docs(() => Docs.upload(actor, b)) });
  });

  router.get('/api/priority/docs/:id/file', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const f = await docs(() => Docs.file(actor, ctx.params.id));
    res.writeHead(200, {
      'content-type': f.mime,
      'content-length': f.buf.length,
      'content-disposition': `${f.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'self'"
    });
    res.end(f.buf);
  });

  router.delete('/api/priority/docs/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await docs(() => Docs.remove(actor, ctx.params.id));
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/priority/docs/:id/bot', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { doc: await docs(() => Docs.toBot(actor, ctx.params.id)) });
  });

  // ---------------------------------------------------------------- עבודה מתוך המסך (אותו מנוע כמו הבוט)
  router.post('/api/priority/desk/start', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    try {
      sendJson(res, 200, await Desk.start(actor, Number(b.id), { force: Boolean(b.force) }));
    } catch (err) {
      if (err?.status === 409) return sendJson(res, 409, { error: err.message, open: err.open });
      throw docErr(err);
    }
  });

  router.get('/api/priority/desk/file/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const f = await docs(() => Desk.fileOf(actor, ctx.params.id));
    res.writeHead(200, { 'content-type': f.mime, 'content-length': f.buf.length, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self'" });
    res.end(f.buf);
  });

  router.get('/api/priority/desk/:flow', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, await docs(() => Desk.state(actor, ctx.params.flow)));
  });

  router.post('/api/priority/desk/:flow/file', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, await docs(() => Desk.sendFile(actor, ctx.params.flow, b, { attach: b.attach !== false })));
  });

  router.post('/api/priority/docs/:id/pages', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, { doc: await docs(() => Docs.addPage(actor, ctx.params.id, b)) });
  });

  router.post('/api/priority/desk/:flow/say', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, await docs(() => Desk.say(actor, ctx.params.flow, b.text)));
  });

  // ---------------------------------------------------------------- השרשרת
  router.get('/api/priority/chain', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const url = parseUrl(req);
    const doc = url.searchParams.get('doc') || null;
    // מנהל מערכת — אפשר לראות את כל הארגון (‎all=1‎); עובד — רק שלו
    const all = Access.isAdmin(actor) && url.searchParams.get('all') === '1';
    sendJson(res, 200, { ...Chain.board(actor, { doc, all }), all });
  });

  router.get('/api/priority/log', async (req, res, ctx) => {
    adminOnly(ctx);
    sendJson(res, 200, { items: Settings.history().slice(0, 100) });
  });
}

module.exports = { register };
