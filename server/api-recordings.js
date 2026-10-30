'use strict';
/**
 * נקודות הקצה של הקלטות הפגישות — "🎥 הפגישות שלי", הנגן, וההגדרות.
 *
 * מי רואה הקלטה: רק מי שהפגישה ביומן שלו, או משתתף מהארגון לפי המייל
 * (‎recording_access‎). אין "מנהל רואה הכול" — הקלטה של פגישה היא של המשתתפים בה.
 */
const fs = require('node:fs');
const { Readable } = require('node:stream');

const D = require('./db');
const P = require('./permissions');
const Recordings = require('./recordings');
const Drive = require('./gdrive');
const { HttpError, badRequest, forbidden, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router) {
  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };
  const userError = (err) => (err instanceof HttpError ? err
    : err instanceof Recordings.RecordingError ? new HttpError(err.status, err.message)
    : badRequest(err.message));
  const run = async (res, fn) => {
    try {
      sendJson(res, 200, await fn());
    } catch (err) {
      throw userError(err);
    }
  };
  const idOf = (ctx) => Number(ctx.params.id);

  router.get('/api/recordings', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const q = parseUrl(req).searchParams;
    sendJson(res, 200, {
      enabled: Recordings.isActive(),
      recordMeetings: Recordings.wantsRecording(actor.id),
      past: Recordings.listFor(actor.id, { scope: 'past', limit: Math.min(300, Number(q.get('limit')) || 100) }),
      upcoming: Recordings.listFor(actor.id, { scope: 'upcoming', limit: 50 })
    });
  });

  router.get('/api/recordings/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const rec = Recordings.detail(actor.id, idOf(ctx));
    if (!rec) throw new HttpError(404, 'ההקלטה לא נמצאה');
    sendJson(res, 200, { recording: rec });
  });

  /**
   * הנגן — עם ‎Range‎, כדי שאפשר יהיה לקפוץ לאמצע ההקלטה. מהדרייב דרך השרת:
   * לעובדים אין גישה ישירה ל-Shared Drive, ואין צורך שתהיה.
   */
  router.get('/api/recordings/:id/video', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    let src;
    try { src = Recordings.videoSource(actor.id, idOf(ctx)); } catch (err) { throw userError(err); }
    const range = String(req.headers.range ?? '');

    if (src.drive) {
      const up = await Drive.download(src.drive, range);
      if (!up.ok && up.status !== 206) throw new HttpError(502, 'הווידאו אינו זמין כרגע בדרייב');
      const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
      for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) headers[h] = up.headers.get(h);
      res.writeHead(up.status, headers);
      const stream = Readable.fromWeb(up.body);
      req.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    const { file, size } = src;
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = size - 1;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return res.end();
      }
    }
    const partial = Boolean(m && (m[1] || m[2]));
    res.writeHead(partial ? 206 : 200, {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      'cache-control': 'private, max-age=3600'
    });
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });

  router.get('/api/recordings/:id/transcript', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    let t;
    try { t = Recordings.transcriptOf(actor.id, idOf(ctx)); } catch (err) { throw userError(err); }
    const name = `תמלול — ${t.title}.txt`.replace(/[\\/:*?"<>|]/g, '-');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="transcript.txt"; filename*=UTF-8''${encodeURIComponent(name)}`
    });
    // BOM — כדי שהפנקס של Windows יפתח את העברית נכון
    res.end(`﻿${t.text}`);
  });

  router.post('/api/recordings/:id/skip', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, async () => { await Recordings.skip(actor, idOf(ctx)); return { ok: true }; });
  });

  router.post('/api/recordings/:id/restore', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, async () => { Recordings.restore(actor, idOf(ctx)); return { ok: true }; });
  });

  router.post('/api/recordings/:id/retry', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, async () => ({ recording: await Recordings.retry(actor, idOf(ctx)) }));
  });

  /** ההגדרה האישית: להקליט את הפגישות שלי או לא */
  router.put('/api/recordings/prefs', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (typeof b.recordMeetings !== 'boolean') throw badRequest('ערך לא תקין');
    D.setUserPref(actor.id, 'recordMeetings', b.recordMeetings);
    sendJson(res, 200, { recordMeetings: Recordings.wantsRecording(actor.id) });
  });

  // --- ניהול ---

  router.get('/api/admin/recorder', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    const check = parseUrl(req).searchParams.get('check') === '1';
    sendJson(res, 200, await Recordings.adminStatus({ check }));
  });

  router.post('/api/admin/recorder/scan', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    if (!Recordings.isActive()) throw badRequest('המקליט כבוי או אינו מוגדר');
    await run(res, async () => ({ scan: await Recordings.discover() }));
  });
}

module.exports = { register };
