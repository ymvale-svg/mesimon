'use strict';
/**
 * נקודות הקצה של האלפון הארגוני (‎phonebook.js‎). פתוח לכל העובדים — צפייה,
 * הוספה, עריכה, מחיקה, ייבוא וייצוא. ספקים לא.
 */
const D = require('./db');
const Phonebook = require('./phonebook');
const Spreadsheet = require('./spreadsheet');
const Xlsx = require('./xlsx-write');
const { badRequest, forbidden, notFound, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router) {
  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };
  const asBad = (fn) => {
    try { return fn(); } catch (err) { throw err?.status ? err : badRequest(err.message); }
  };

  router.get('/api/phonebook', async (req, res, ctx) => {
    userOnly(ctx);
    const url = parseUrl(req);
    const q = url.searchParams.get('q') ?? '';
    const all = url.searchParams.get('all') === '1';
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 12));
    sendJson(res, 200, {
      items: all ? Phonebook.all() : Phonebook.search(q, { limit }),
      total: Phonebook.count()
    });
  });

  router.post('/api/phonebook', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const entry = asBad(() => Phonebook.create(actor, b));
    sendJson(res, 201, { entry, duplicates: Phonebook.duplicatesOf(entry, entry.id) });
  });

  /** בדיקת כפילות לפני שמירה — "כבר באלפון: דני כהן" */
  router.post('/api/phonebook/check', async (req, res, ctx) => {
    userOnly(ctx);
    const b = await readJson(req);
    sendJson(res, 200, { duplicates: Phonebook.duplicatesOf({ phone: b.phone, phone2: b.phone2, fax: b.fax, email: b.email }, b.id ? Number(b.id) : null) });
  });

  router.put('/api/phonebook/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const entry = asBad(() => Phonebook.update(actor, Number(ctx.params.id), b));
    if (!entry) throw notFound('הרשומה לא נמצאה');
    sendJson(res, 200, { entry, duplicates: Phonebook.duplicatesOf(entry, entry.id) });
  });

  router.delete('/api/phonebook/:id', async (req, res, ctx) => {
    userOnly(ctx);
    if (!Phonebook.remove(Number(ctx.params.id))) throw notFound('הרשומה לא נמצאה');
    sendJson(res, 200, { ok: true });
  });

  /**
   * ייבוא: ‎commit=false‎ — תצוגה מקדימה עם שגיאות וכפילויות לכל שורה;
   * ‎commit=true‎ — שמירת השורות התקינות. כפולות מדולגות אלא אם ‎includeDuplicates‎.
   */
  router.post('/api/phonebook/import', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const raw = String(b.data ?? '');
    const buffer = Buffer.from(raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64');
    if (!buffer.length) throw badRequest('לא נשלח קובץ');
    const maxMb = Number(D.getSetting('max_upload_mb', 25));
    if (buffer.length > maxMb * 1024 * 1024) throw badRequest(`הקובץ גדול מ-${maxMb}MB`);
    let matrix;
    try {
      matrix = Spreadsheet.parse(buffer, String(b.filename ?? ''));
    } catch (err) {
      throw badRequest(`לא ניתן לקרוא את הקובץ: ${err.message}`);
    }
    const analysis = Phonebook.analyseImport(matrix);
    if (!b.commit) return sendJson(res, 200, { ...analysis, committed: false });
    sendJson(res, 200, { ...Phonebook.commitImport(actor, analysis, { includeDuplicates: Boolean(b.includeDuplicates) }), committed: true });
  });

  router.get('/api/phonebook/export', async (req, res, ctx) => {
    userOnly(ctx);
    const rows = Phonebook.all().map((e) => [e.name, e.phone, e.phone2, e.fax, e.email, e.note]);
    const file = Xlsx.build([['שם מלא', "טל' 1", "טל' 2", 'פקס', 'מייל', 'הערות'], ...rows], { sheetName: 'אלפון', widths: [26, 16, 16, 16, 30, 40] });
    const stamp = D.nowIso().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-length': file.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`אלפון ${stamp}.xlsx`)}`,
      'x-content-type-options': 'nosniff'
    });
    res.end(file);
  });
}

module.exports = { register };
