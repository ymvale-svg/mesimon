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
const Timeless = require('./timeless');
const TimelessMedia = require('./timeless-media');
const Gmail = require('./gmail');
const WaBot = require('./ai/wa-bot');
const WaActions = require('./ai/wa-actions');
const { HttpError, badRequest, forbidden, notFound, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router, h) {
  const { getTaskOr404, assertVisible, shapeTask, canSeeTask } = h;

  Meetings.init({
    botReady: () => WaBot.isConfigured() && Boolean(D.getSetting('wa_bot_enabled', true)),
    botAllowed: () => Boolean(WaActions.byKey('meeting_reminder')?.enabled),
    // 📅 התראה מהיומן — עם כפתור "מי משתתף?"
    sendButtons: async (chatId, text, buttons) => {
      await WaBot.sendButtons(chatId, text, buttons);
      WaBot.log({ channel: 'summary', chatId, action: 'meeting_reminder', status: 'ok', result: `${text.split('\n')[0]} (מהיומן)` });
    },
    sendWhatsApp: async (chatId, text) => {
      await WaBot.sendText(chatId, text);
      WaBot.log({ channel: 'summary', chatId, action: 'meeting_reminder', status: 'ok', result: text.split('\n')[0] });
    }
  });

  // התראה למזכירות על פגישה שלא מוקלטת ב-Timeless — דרך אותו בוט, ניתנת לכיבוי בפעולות הבוט
  TimelessMedia.init({
    botReady: () => WaBot.isConfigured() && Boolean(D.getSetting('wa_bot_enabled', true)),
    botAllowed: () => WaActions.byKey('timeless_unrecorded')?.enabled !== false,
    sendWhatsApp: async (chatId, text) => {
      await WaBot.sendText(chatId, text);
      WaBot.log({ channel: 'summary', chatId, action: 'timeless_unrecorded', status: 'ok', result: text.split('\n')[0] });
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
      // ‎chooseHost‎ — מזכירות והנהלה בוחרים משתמש Zoom משני החשבונות (‎/api/meetings/zoom-hosts‎);
      // ‎own‎ — לכל השאר: משתמש ה-Zoom המשויך להם, שבו בלבד נפתחת הפגישה
      zoom: (() => {
        const chooseHost = Zoom.isEnabled() && Meetings.canChooseZoomHost(actor);
        const own = Meetings.ownZoomUser(actor.id);
        return { enabled: Zoom.isEnabled(), chooseHost, own: own ? { name: own.name, email: own.email, basic: own.license === 'basic' } : null };
      })(),
      // 🎥 הקלטות מ-Timeless — כשיש חיבור (אישי, או הארגוני מהשרת)
      timeless: { connected: Timeless.isConnected(actor.id) },
      defaults: {
        minutes: Number(D.getSetting('meeting_default_minutes', 30)),
        record: Boolean(D.getSetting('meeting_record_default', false)),
        hours: D.getSetting('meeting_hours', '08:30-18:00'),
        officeAddress: String(D.getSetting('meeting_office_address', '') ?? '').trim()
      },
      calendars: await Meetings.calendarsFor(actor, { fresh }),
      accessError: Meetings.accessError(actor.id)
    }));
  });

  // משתמשי ה-Zoom בשני החשבונות, ומי תפוס במועד — לבורר המארח
  router.get('/api/meetings/zoom-hosts', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Meetings.canChooseZoomHost(actor)) throw forbidden();
    const q = parseUrl(req).searchParams;
    const start = Date.parse(q.get('start') ?? '');
    const minutes = Math.max(5, Number(q.get('minutes')) || 30);
    const range = Number.isFinite(start) ? [new Date(start).toISOString(), new Date(start + minutes * 60000).toISOString()] : [null, null];
    sendJson(res, 200, { hosts: Zoom.hostsAt(range[0], range[1], Number(q.get('exclude')) || null), multi: Zoom.accounts().filter((a) => a.enabled).length > 1 });
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

  // מי שקשור לפגישה: בעל היומן, מי שקבע, משתתף, או מי שרואה את המשימה שלה
  const involved = (actor, m) => [m.owner_id, m.created_by].includes(actor.id)
    || JSON.parse(m.attendees || '[]').some((a) => a.email === String(actor.email ?? '').toLowerCase())
    || Boolean(m.task_id && canSeeTask(actor, D.get('SELECT * FROM tasks WHERE id = ?', m.task_id)));

  // מי שהיה בפגישה: בעל היומן, מי שקבע (גם בשם אחר) או מי שהוזמן. הקלטה ותמליל — רק להם ולהנהלה,
  // לא לכל מי שרואה את המשימה (issue #65). אותו כלל כמו ‎Zoom.recordingScope‎
  const attended = (actor, m) => [m.owner_id, m.created_by, m.via_user_id].includes(actor.id)
    || JSON.parse(m.attendees || '[]').some((a) => String(a.email ?? '').toLowerCase() === String(actor.email ?? '').toLowerCase() && Boolean(actor.email));

  router.get('/api/meetings/:id/join', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const m = Meetings.meetingById(Number(ctx.params.id));
    if (!m) throw notFound();
    if (!involved(actor, m)) throw forbidden();
    await run(res, () => Meetings.joinLink(actor, m.id));
  });

  // ההקלטה של הפגישה — ‎null‎ כשאין עדיין (לא הוקלטה, או ש-Zoom עוד מעבד)
  router.get('/api/meetings/:id/recording', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const m = Meetings.meetingById(Number(ctx.params.id));
    if (!m) throw notFound();
    if (!attended(actor, m) && !P.can(actor, 'manage_users')) throw forbidden();
    await run(res, async () => ({ recording: await Meetings.recording(m.id) }));
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
    ).filter((t) => (secretary ? canSeeTask(actor, t) : (t.assignee_type === 'user' && t.assignee_id === actor.id) || t.created_by === actor.id));
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
    // תצוגה משולבת — כל היומנים מסומנים כברירת מחדל, לכן עד 80 (בלי כפילויות)
    const ids = [...new Set(String(q.get('users') ?? '').split(',').map(Number).filter(Boolean))].slice(0, 80);
    const secretary = Meetings.isSecretary(actor);
    if (!secretary && ids.some((id) => id !== actor.id)) throw forbidden('מסך היומן מיועד למזכירות');
    await run(res, async () => {
      const fromIso = W.ilWallToUtc(from, 0, 0).toISOString();
      const toIso = W.ilWallToUtc(W.addDays(to, 1), 0, 0).toISOString();
      const access = await Meetings.accessMap(actor);
      const users = ids.map((id) => D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active'", id)).filter(Boolean);
      const perUser = new Map(users.map((u) => [u.id, []]));
      const fbNeeded = [];
      // כמה עובדים במקביל — עם עשרות יומנים, אחד-אחד לוקח יותר מדי
      const loadOne = async (u) => {
        const out = perUser.get(u.id);
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
      };
      const queue = [...users];
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length) await loadOne(queue.shift());
      }));
      const out = users.flatMap((u) => perUser.get(u.id));
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
    sendJson(res, 200, { enabled: Zoom.isEnabled(), missing: Zoom.missing(), accounts: Zoom.accounts(), users: Zoom.listUsers() });
  });

  router.post('/api/admin/zoom/sync', async (req, res, ctx) => {
    zoomAdmin(ctx);
    await run(res, async () => {
      const { users, errors } = await Zoom.syncUsers();
      return { enabled: true, missing: [], accounts: Zoom.accounts(), users, errors };
    });
  });

  // --- Zoom: הקלטות בענן (מי רואה מה — ‎Zoom.recordingScope‎) ---

  router.get('/api/zoom/recordings', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Zoom.isEnabled()) throw badRequest('חיבור Zoom אינו מוגדר בשרת');
    const q = parseUrl(req).searchParams;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const to = day.test(q.get('to') ?? '') ? q.get('to') : new Date().toISOString().slice(0, 10);
    const from = day.test(q.get('from') ?? '') ? q.get('from') : new Date(Date.parse(to) - 30 * 86400000).toISOString().slice(0, 10);
    if (from > to) throw badRequest('טווח תאריכים לא תקין');
    if (Date.parse(to) - Date.parse(from) > 92 * 86400000) throw badRequest('אפשר להציג עד שלושה חודשים בכל פעם');
    await run(res, async () => {
      const r = await Zoom.recordingsFor(actor, from, to);
      return {
        from, to, all: r.all, hosts: r.hosts, errors: r.errors,
        recordings: r.recordings.map(({ meeting, ...rec }) => {
          const task = meeting?.taskId ? D.get('SELECT * FROM tasks WHERE id = ?', meeting.taskId) : null;
          return {
            ...rec,
            meeting: meeting ? { id: meeting.id, title: meeting.title } : null,
            task: task && canSeeTask(actor, task) ? { id: task.id, title: task.title } : null
          };
        })
      };
    });
  });

  // --- 🎥 Timeless: ההקלטות, התמלול והסיכום. הרשאות — ב-‎timeless.js‎ (אסימון אישי,
  // או הארגוני: הנהלה רואה הכול, עובד — רק פגישות שהשתתף בהן) ---

  // ‎401‎ של Timeless (אסימון פג) — לא ‎401‎ של משימון: המשתמש מחובר, רק צריך לחבר מחדש את Timeless
  const tlError = (err) => (err instanceof HttpError ? err : new HttpError(err.status === 401 ? 400 : err.status >= 400 && err.status < 500 ? err.status : 502, err.message));

  router.get('/api/timeless/recordings', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Timeless.isConnected(actor.id)) throw badRequest('Timeless אינו מחובר — "החשבון שלי ← AI ← Timeless"');
    const q = parseUrl(req).searchParams;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const to = day.test(q.get('to') ?? '') ? q.get('to') : new Date().toISOString().slice(0, 10);
    const from = day.test(q.get('from') ?? '') ? q.get('from') : new Date(Date.parse(to) - 30 * 86400000).toISOString().slice(0, 10);
    if (from > to) throw badRequest('טווח תאריכים לא תקין');
    try {
      sendJson(res, 200, { from, to, status: Timeless.publicStatus(actor.id), recordings: await Timeless.recordings(actor.id, from, to) });
    } catch (err) {
      throw tlError(err);
    }
  });

  // צפייה — הפניה לכתובת החתומה של Timeless (נוצרת מחדש בכל לחיצה)
  router.get('/api/timeless/recordings/:id/play', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    let url;
    try {
      url = await Timeless.recordingUrl(actor.id, ctx.params.id);
    } catch (err) {
      throw tlError(err);
    }
    if (!url) throw notFound('לפגישה הזו אין הקלטה ב-Timeless — רק תמלול וסיכום');
    res.writeHead(302, { location: url, 'cache-control': 'no-store' });
    res.end();
  });

  router.get('/api/timeless/recordings/:id/transcript', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    try {
      sendJson(res, 200, await Timeless.transcript(actor.id, ctx.params.id, { maxChars: 200000 }));
    } catch (err) {
      throw tlError(err);
    }
  });

  // סיכום — מסמכי ה-AI של הפגישה, כ-Markdown
  router.get('/api/timeless/recordings/:id/summary', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    try {
      const refs = await Timeless.documents(actor.id, ctx.params.id);
      const docs = [];
      for (const ref of refs.slice(0, 5)) docs.push({ ...ref, markdown: await Timeless.document(actor.id, ref.id, { verified: true }) });
      sendJson(res, 200, { documents: docs });
    } catch (err) {
      throw tlError(err);
    }
  });

  // --- 🎥 הנגן: הפגישה, התמליל כקטעים, הסיכום המובנה, שאלה, ומשימות שנפתחו ממנה ---

  const tl = async (res, fn) => {
    try { sendJson(res, 200, await fn()); } catch (err) { throw tlError(err); }
  };

  router.get('/api/timeless/recordings/:id', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await tl(res, async () => {
      const m = await Timeless.meeting(actor.id, ctx.params.id);
      if (!m) throw new HttpError(404, 'הפגישה לא נמצאה ב-Timeless, או שאין לך גישה אליה');
      return { meeting: m, tasks: TimelessMedia.tasksOf(m.id, (t) => canSeeTask(actor, t)) };
    });
  });

  router.get('/api/timeless/recordings/:id/segments', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await tl(res, () => Timeless.segments(actor.id, ctx.params.id));
  });

  router.get('/api/timeless/recordings/:id/digest', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const fresh = parseUrl(req).searchParams.get('fresh') === '1';
    await tl(res, () => TimelessMedia.digest(actor.id, ctx.params.id, { fresh }));
  });

  router.post('/api/timeless/recordings/:id/ask', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await tl(res, () => TimelessMedia.ask(actor.id, ctx.params.id, b.question));
  });

  // משימות שנפתחו מהנגן — הקישור לפגישה, אחרי שהמשימות נוצרו (‎POST /api/tasks‎)
  router.post('/api/timeless/recordings/:id/tasks', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    await tl(res, async () => {
      const m = await Timeless.meeting(actor.id, ctx.params.id);
      if (!m) throw new HttpError(404, 'הפגישה לא נמצאה ב-Timeless, או שאין לך גישה אליה');
      const links = (Array.isArray(b.links) ? b.links : []).slice(0, 20).filter((x) => {
        const t = D.get('SELECT * FROM tasks WHERE id = ?', Number(x.taskId));
        return t && canSeeTask(actor, t);
      });
      TimelessMedia.linkTasks(m.id, links);
      return { tasks: TimelessMedia.tasksOf(m.id, (t) => canSeeTask(actor, t)) };
    });
  });

  // פגישת משימון שהתקיימה — ההקלטה שלה ב-Timeless (לכרטיס המשימה), אם יש
  router.get('/api/meetings/:id/timeless', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const m = Meetings.meetingById(Number(ctx.params.id));
    if (!m) throw notFound();
    if (!attended(actor, m) && !P.can(actor, 'manage_users')) throw forbidden();
    await tl(res, async () => {
      const rec = await TimelessMedia.forMeeting(actor.id, m);
      return { recording: rec, tasks: rec ? TimelessMedia.tasksOf(rec.id, (t) => canSeeTask(actor, t)) : [] };
    });
  });

  // צפייה בקובץ — הפניה לכתובת חתומה של Zoom, אחרי בדיקת הרשאה
  router.get('/api/zoom/recordings/file', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const q = parseUrl(req).searchParams;
    const uuid = q.get('uuid') ?? '';
    const fileId = q.get('file') ?? '';
    if (!uuid || !fileId) throw badRequest('חסר מזהה הקלטה');
    let link;
    try {
      link = await Zoom.recordingFileUrl(uuid, fileId);
    } catch (err) {
      throw err.status === 404 ? notFound('ההקלטה לא נמצאה ב-Zoom') : userError(err);
    }
    const ours = link.meetingId ? D.get('SELECT * FROM meetings WHERE zoom_meeting_id = ? ORDER BY id DESC LIMIT 1', link.meetingId) : null;
    if (!Zoom.mayWatch(Zoom.recordingScope(actor), link.meetingId) && !(ours && attended(actor, ours))) {
      throw forbidden('אין לך הרשאה לצפות בהקלטה הזו');
    }
    res.writeHead(302, { location: link.url, 'cache-control': 'no-store' });
    res.end();
  });
}

module.exports = { register };
