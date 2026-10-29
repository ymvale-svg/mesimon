'use strict';
/**
 * נקודות הקצה של קביעת פגישות, מסך היומן ושיוך Zoom.
 *
 * כמו ‎api-ai.js‎ ו-‎api-today.js‎: על אותו נתב, עם עזרי ההרשאה של api.js
 * שמוזרקים ב-‎register‎. מי רשאי לפעול ביומן של מי — ‎meetings.js‎, לפי מה
 * שהעובד שיתף ב-Google; כאן רק מי רשאי לראות את המשימה.
 */
const D = require('./db');
const W = require('./workdays');
const P = require('./permissions');
const Meetings = require('./meetings');
const Zoom = require('./zoom');
const Gmail = require('./gmail');
const WaBot = require('./ai/wa-bot');
const WaActions = require('./ai/wa-actions');
const { HttpError, badRequest, forbidden, notFound, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router, h) {
  const { getTaskOr404, assertVisible, shapeTask, canSeeTask } = h;

  Meetings.init({
    botReady: () => WaBot.isConfigured() && Boolean(D.getSetting('wa_bot_enabled', true)),
    botAllowed: () => Boolean(WaActions.byKey('meeting_reminder')?.enabled),
    sendWhatsApp: async (chatId, text) => {
      await WaBot.sendText(chatId, text);
      WaBot.log({ channel: 'summary', chatId, action: 'meeting_reminder', status: 'ok', result: text.split('\n')[0] });
    }
  });

  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };
  // שגיאה של הפגישות — ההודעה בעברית מגיעה למשתמש עם הסטטוס שלה, ולא כ"שגיאה פנימית"
  const userError = (err) => (err instanceof HttpError ? err
    : err instanceof Meetings.MeetingError ? new HttpError(err.status, err.message)
    : badRequest(err.message));
  const run = async (res, fn, status = 200) => {
    try {
      sendJson(res, status, await fn());
    } catch (err) {
      throw userError(err);
    }
  };

  // --- היומנים שאפשר לקבוע בהם, וזמינות ---

  router.get('/api/meetings/calendars', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const fresh = parseUrl(req).searchParams.get('fresh') === '1';
    await run(res, async () => ({
      secretary: Meetings.isSecretary(actor),
      google: {
        calendar: Gmail.has(actor.id, 'calendar'),
        freebusy: Gmail.has(actor.id, 'freebusy'),
        calendarList: Gmail.has(actor.id, 'calendarList')
      },
      zoom: { enabled: Zoom.isEnabled() },
      defaults: {
        minutes: Number(D.getSetting('meeting_default_minutes', 30)),
        hours: D.getSetting('meeting_hours', '08:30-18:00')
      },
      calendars: await Meetings.calendarsFor(actor, { fresh })
    }));
  });

  router.post('/api/meetings/availability', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.availability(actor, { ownerId: Number(b.ownerId) || actor.id, emails: b.emails ?? [], date: b.date }));
  });

  router.post('/api/meetings/suggest', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.suggest(actor, { ownerId: Number(b.ownerId) || actor.id, emails: b.emails ?? [], minutes: b.minutes, days: 7, max: 8 }));
  });

  router.post('/api/meetings/alternatives', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.alternatives(actor, { ownerId: Number(b.ownerId) || actor.id, emails: b.emails ?? [], start: b.start, minutes: b.minutes }));
  });

  // --- קביעה, שינוי, ביטול ---

  router.post('/api/meetings', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (b.taskId) assertVisible(actor, getTaskOr404(b.taskId));
    await run(res, async () => {
      const out = await Meetings.create(actor, b);
      if (b.taskId) Meetings.markRescheduled(Number(b.taskId));
      return out;
    }, 201);
  });

  router.patch('/api/meetings/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.update(actor, Number(ctx.params.id), b));
  });

  router.delete('/api/meetings/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, async () => ({ meeting: await Meetings.cancel(actor, Number(ctx.params.id)) }));
  });

  router.get('/api/meetings/task/:taskId', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const task = getTaskOr404(ctx.params.taskId);
    assertVisible(actor, task);
    sendJson(res, 200, { meetings: Meetings.forTask(task.id), pending: Boolean(task.meeting_pending) });
  });

  router.get('/api/meetings/:id/join', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const m = Meetings.meetingById(Number(ctx.params.id));
    if (!m) throw notFound();
    const involved = [m.owner_id, m.created_by].includes(actor.id)
      || JSON.parse(m.attendees || '[]').some((a) => a.email === String(actor.email ?? '').toLowerCase())
      || (m.task_id && canSeeTask(actor, D.get('SELECT * FROM tasks WHERE id = ?', m.task_id)));
    if (!involved) throw forbidden();
    await run(res, () => Meetings.joinLink(actor, m.id));
  });

  /** "📅 פגישה לקביעה" — סימון ידני על משימה */
  router.post('/api/tasks/:id/meeting-pending', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const task = getTaskOr404(ctx.params.id);
    assertVisible(actor, task);
    const b = await readJson(req);
    D.run('UPDATE tasks SET meeting_pending = ? WHERE id = ?', b.pending ? 1 : 0, task.id);
    sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });
  });

  // --- חלופות: הזזה, ובקשה מהמארגן ---

  router.post('/api/meetings/move', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.moveEvent(actor, { ownerId: Number(b.ownerId), eventId: String(b.eventId), start: b.start, end: b.end }));
  });

  router.post('/api/meetings/request-move', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await run(res, () => Meetings.requestMove(actor, {
      organizerId: Number(b.organizerId), eventId: b.eventId ? String(b.eventId) : null, calendarEmail: String(b.calendarEmail ?? ''),
      to: b.to && typeof b.to === 'object' ? { start: b.to.start } : null
    }));
  });

  router.get('/api/meetings/move-requests/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, () => Meetings.previewMove(actor, Number(ctx.params.id)));
  });

  router.post('/api/meetings/move-requests/:id/approve', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, () => Meetings.approveMove(actor, Number(ctx.params.id)));
  });

  router.post('/api/meetings/move-requests/:id/reject', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    D.run("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE id = ? AND user_id = ? AND kind = 'meeting_move'", D.nowIso(), Number(ctx.params.id), actor.id);
    sendJson(res, 200, { ok: true });
  });

  /** "לדחות" פגישה שבוטלה ביומן — ההצעה יורדת; את המשימה סוגר הלקוח, עם בדיקת ההרשאה הרגילה */
  router.post('/api/meetings/cancelled/:id/decline', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await run(res, () => ({ taskId: Meetings.declineReschedule(actor, Number(ctx.params.id)) }));
  });

  // --- מסך היומן ---

  /**
   * משימות שמחכות לקביעה: למזכירה — כל מה שהיא רשאית לראות (להרשאה רחבה —
   * "צפייה בכל משימות המחלקה" בכרטיס העובד); לשאר — שלי.
   */
  router.get('/api/meetings/pending', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const secretary = Meetings.isSecretary(actor);
    const rows = D.all(
      `SELECT t.* FROM tasks t LEFT JOIN board_columns c ON c.board_id = t.board_id AND c.key = t.status
        WHERE t.meeting_pending = 1 AND t.archived = 0 AND COALESCE(c.is_final, 0) = 0
        ORDER BY t.created_at DESC LIMIT 200`
    ).filter((t) => (secretary ? canSeeTask(actor, t) : t.assignee_id === actor.id || t.created_by === actor.id));
    sendJson(res, 200, { tasks: rows.map((t) => shapeTask(t, actor)) });
  });

  /**
   * האירועים של כמה עובדים בטווח — למסך היומן. רק מה ש-Google מראה למשתמש:
   * יומן משותף — עם פרטים; זמינות בלבד — "תפוס".
   */
  router.get('/api/meetings/range', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const q = parseUrl(req).searchParams;
    const from = q.get('from');
    const to = q.get('to');
    if (!W.isDate(from) || !W.isDate(to) || to < from) throw badRequest('טווח לא תקין');
    const ids = String(q.get('users') ?? '').split(',').map(Number).filter(Boolean).slice(0, 15);
    const secretary = Meetings.isSecretary(actor);
    if (!secretary && ids.some((id) => id !== actor.id)) throw forbidden('מסך היומן מיועד למזכירות');
    await run(res, async () => {
      const fromIso = W.ilWallToUtc(from, 0, 0).toISOString();
      const toIso = W.ilWallToUtc(W.addDays(to, 1), 0, 0).toISOString();
      const access = await Meetings.accessMap(actor);
      const users = ids.map((id) => D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active'", id)).filter(Boolean);
      const out = [];
      const fbNeeded = [];
      for (const u of users) {
        const level = u.id === actor.id ? (Gmail.has(actor.id, 'calendar') ? 'owner' : 'none') : access.get(u.id) ?? 'none';
        if (['owner', 'write', 'read'].includes(level)) {
          try {
            const page = await Gmail.googleCall(actor.id, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(u.id === actor.id ? 'primary' : u.email)}/events`, {
              timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: 500
            });
            const ours = new Map(D.all("SELECT id, google_event_id, task_id FROM meetings WHERE owner_id = ? AND status = 'scheduled'", u.id).map((m) => [m.google_event_id, m]));
            for (const e of page.items ?? []) {
              if (e.status === 'cancelled') continue;
              const hidden = e.visibility === 'private' || e.visibility === 'confidential';
              out.push({
                userId: u.id, eventId: e.id, title: hidden ? null : e.summary ?? '(ללא כותרת)',
                start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, allDay: Boolean(e.start?.date),
                location: hidden ? '' : e.location ?? '', link: /^https:\/\//.test(e.htmlLink ?? '') ? e.htmlLink : null,
                organizerIsOwner: Boolean(e.organizer?.self) || String(e.organizer?.email ?? '').toLowerCase() === u.email.toLowerCase(),
                attendees: hidden ? [] : (e.attendees ?? []).filter((a) => !a.resource).map((a) => ({ email: a.email, name: a.displayName ?? '', response: a.responseStatus })),
                meetingId: ours.get(e.id)?.id ?? null, taskId: ours.get(e.id)?.task_id ?? null,
                editable: ['owner', 'write'].includes(level), busyOnly: false
              });
            }
          } catch (err) {
            fbNeeded.push(u);
          }
        } else {
          fbNeeded.push(u);
        }
      }
      if (fbNeeded.length) {
        const fb = await Meetings.freeBusy(actor, fbNeeded.map((u) => u.email), fromIso, toIso);
        for (const u of fbNeeded) {
          for (const b of fb.get(u.email.toLowerCase())?.busy ?? []) {
            out.push({ userId: u.id, eventId: null, title: null, start: b.start, end: b.end, allDay: false, busyOnly: true, editable: false });
          }
        }
      }
      return { events: out, access: Object.fromEntries(users.map((u) => [u.id, u.id === actor.id ? 'owner' : access.get(u.id) ?? 'none'])) };
    });
  });

  // --- Zoom: משתמשי החשבון ושיוך לעובדים ---

  const zoomAdmin = (ctx) => {
    const actor = userOnly(ctx);
    if (!P.may(actor, 'manage_users')) throw forbidden();
    return actor;
  };

  router.get('/api/admin/zoom/users', async (req, res, ctx) => {
    zoomAdmin(ctx);
    sendJson(res, 200, { enabled: Zoom.isEnabled(), missing: Zoom.missing(), users: Zoom.listUsers() });
  });

  router.post('/api/admin/zoom/sync', async (req, res, ctx) => {
    zoomAdmin(ctx);
    await run(res, async () => ({ enabled: true, missing: [], users: await Zoom.syncUsers() }));
  });
}

module.exports = { register };
