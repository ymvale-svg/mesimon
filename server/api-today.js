'use strict';
/**
 * נקודות הקצה של Today, משימה מהקלטה, והעדפות שלהם.
 *
 * כמו ‎api-ai.js‎: על אותו נתב ועם אותם עזרי הרשאה, שמוזרקים מ-api.js
 * ב-‎register‎ — בלי גרסה מקבילה של "מי רואה משימה" או "איך נוצרת משימה".
 */
const D = require('./db');
const W = require('./workdays');
const Today = require('./today');
const Voice = require('./voice');
const VoiceDialog = require('./voice-dialog');
const Calendar = require('./calendar');
const Gmail = require('./gmail');
const Mailer = require('./mailer');
const Claude = require('./ai/claude');
const VoiceRouter = require('./ai/voice-router');
const WaBot = require('./ai/wa-bot');
const { badRequest, forbidden, notFound, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router, h) {
  const { shapeTask, createTask, getTaskOr404, listProjectsFor, assertMayAssignTo } = h;
  Today.init({ shapeTask });

  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };

  /** שגיאת שירות חיצוני היא שגיאה שהמשתמש צריך לקרוא, לא "שגיאה פנימית" */
  const userError = (err) => (err?.status ? err : badRequest(err.message));

  // --- Today ---

  router.get('/api/today', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const fresh = parseUrl(req).searchParams.get('fresh') === '1';
    sendJson(res, 200, await Today.build(actor, { fresh }));
  });

  /** המונה שעל כפתור Today — מהיר, בלי היומן */
  router.get('/api/today/count', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { count: Today.quickCount(actor) });
  });

  // --- העדפות: Today במייל, הקלטה, יומנים ---

  const prefsInfo = (actor) => {
    const p = D.userPrefs(actor.id);
    return {
      digest: Today.digestPrefs(actor.id),
      digestSentOn: p.todayDigestSentOn ?? null,
      digestError: p.todayDigestError ?? null,
      // איך יישלח מייל הבוקר — כדי שההגדרה לא תבטיח מה שאי אפשר לקיים
      digestVia: Mailer.isEnabled() ? 'system' : Gmail.canSend(actor.id) ? 'gmail' : null,
      voice: Voice.prefs(actor.id),
      ai: Claude.isEnabled(),
      workDays: W.workDaysOf(actor.id),
      workDaysLabel: W.daysLabel(W.workDaysOf(actor.id)),
      calendar: {
        connected: Calendar.isConnected(actor.id),
        selected: Calendar.selectedCalendars(actor.id)
      }
    };
  };

  router.get('/api/me/today-prefs', async (req, res, ctx) => {
    sendJson(res, 200, prefsInfo(userOnly(ctx)));
  });

  router.put('/api/me/today-prefs', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    try {
      if (b.digest && typeof b.digest === 'object') {
        D.setUserPref(actor.id, 'todayDigest', Today.cleanDigest(b.digest, Today.digestPrefs(actor.id)));
      }
      if (b.voice && typeof b.voice === 'object') {
        D.setUserPref(actor.id, 'voice', Voice.cleanPrefs(b.voice, Voice.prefs(actor.id)));
      }
    } catch (err) {
      throw badRequest(err.message);
    }
    if (Array.isArray(b.calendars)) {
      const ids = b.calendars.map(String).filter((id) => id && id.length < 300).slice(0, 10);
      D.setUserPref(actor.id, 'todayCalendars', ids.length ? ids : null);
      Calendar.forget(actor.id);
    }
    sendJson(res, 200, prefsInfo(actor));
  });

  /** "שלח לי עכשיו" — לבדיקה, גם ביום בלי כלום */
  router.post('/api/me/today-digest/test', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    try {
      const r = await Today.sendDigest(actor.id, { force: true });
      if (!r.sent) throw badRequest(r.reason);
      sendJson(res, 200, r);
    } catch (err) {
      throw userError(err);
    }
  });

  router.get('/api/me/calendars', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    try {
      sendJson(res, 200, { connected: Calendar.isConnected(actor.id), calendars: await Calendar.listCalendars(actor.id) });
    } catch (err) {
      throw userError(err);
    }
  });

  // --- משימה מהקלטה ---

  /** הפרויקטים שאפשר לשייך אליהם בקול — שלי קודם, ורק פעילים */
  const voiceProjects = (actor) => listProjectsFor(actor)
    .filter((p) => p.mine || p.status === 'active')
    .sort((a, b) => Number(b.mine) - Number(a.mine))
    .slice(0, 300)
    .map((p) => ({ id: p.id, name: p.name }));

  router.post('/api/voice/task', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    let out;
    try {
      out = await Voice.handle(actor, { text: b.text, forcePreview: Boolean(b.forcePreview) }, {
        projects: voiceProjects(actor),
        createTask,
        assertMayAssignTo
      });
    } catch (err) {
      throw userError(err);
    }
    const { taskId, ...rest } = out;
    sendJson(res, 200, {
      ...rest,
      created: taskId ? shapeTask(getTaskOr404(taskId), actor, { withDetails: true }) : null
    });
  });

  /**
   * הקלטה — לאן היא הולכת. בקשה אחת לפתוח משימה: למסלול המשימה מהקלטה (עם
   * הדיאלוג המלא). כל השאר — מייל, Today, תובנות, כמה בקשות יחד — לעוזר,
   * באותה שיחה של בוט הוואטסאפ.
   */
  router.post('/api/voice/route', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const text = String(b.text ?? '').trim().slice(0, 4000);
    if (!text) throw badRequest('לא נקלט טקסט');
    const trigger = Voice.detectTrigger(text).trigger;
    const requests = await VoiceRouter.split(text, { classify: !trigger });
    // לא סווג (בלי AI, או "פתח משימה" מפורש) — משימה, כמו שההקלטה עבדה תמיד
    const shaped = requests.map((r) => ({ kind: r.kind ?? (trigger || !Claude.isEnabled() ? 'task' : 'other'), text: r.text }));
    sendJson(res, 200, {
      requests: shaped,
      route: shaped.length === 1 && shaped[0].kind === 'task' ? 'task' : 'assistant'
    });
  });

  /** העוזר — הקלטה או הקלדה, ותשובות לכפתורים שמתחת לתשובה */
  router.post('/api/assistant', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const text = String(b.text ?? '').trim().slice(0, 4000);
    if (!text) throw badRequest('לא נקלט טקסט');
    try {
      sendJson(res, 200, await WaBot.assistant(actor.id, text, {
        voice: Boolean(b.voice),
        reset: Boolean(b.reset),
        requests: Array.isArray(b.requests) ? b.requests.map((r) => String(r?.text ?? r ?? '').trim()).filter(Boolean).slice(0, 5) : null
      }));
    } catch (err) {
      throw userError(err);
    }
  });

  /**
   * תשובה בשיחת ההשלמה: "מי אחראי?" — "דני"; "עד מתי?" — "יום חמישי";
   * "לאיזה פרויקט?" — "הגפן". מחזיר ‎{value,label}‎, ‎{candidates}‎ או ‎{none}‎.
   */
  router.post('/api/voice/answer', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const text = String(b.text ?? '').slice(0, 300);
    if (b.field === 'assignee') {
      return sendJson(res, 200, VoiceDialog.matchPerson(text, VoiceDialog.assignablePeople(actor, assertMayAssignTo), `user:${actor.id}`));
    }
    if (b.field === 'dueDate') {
      const [type, id] = String(b.assignee ?? '').split(':');
      const date = VoiceDialog.parseDate(text, { ownerId: type === 'user' ? Number(id) : actor.id });
      return sendJson(res, 200, date ? { value: date, label: W.hebrewDate(date) } : { none: true });
    }
    if (b.field === 'projectId') return sendJson(res, 200, VoiceDialog.matchProject(text, voiceProjects(actor)));
    throw badRequest('שדה לא מוכר');
  });

  /** יצירת המשימה בסוף שיחת ההשלמה — מהטיוטה שהמשתמש אישר */
  router.post('/api/voice/commit', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const d = b.draft ?? {};
    const title = String(d.title ?? '').trim();
    if (!title) throw badRequest('לא זוהה נושא למשימה');
    const [aType, aId] = String(d.assignee ?? `user:${actor.id}`).split(':');
    if (!['user', 'vendor'].includes(aType) || !Number(aId)) throw badRequest('אחראי לא תקין');
    if (!(aType === 'user' && Number(aId) === actor.id)) assertMayAssignTo(actor, aType, Number(aId));
    const projectId = d.projectId ? Number(d.projectId) : null;
    if (projectId && !voiceProjects(actor).some((p) => p.id === projectId)) throw badRequest('הפרויקט לא נמצא');
    const draft = {
      ...d,
      title,
      assignee: `${aType}:${Number(aId)}`,
      projectId,
      dueDate: W.isDate(d.dueDate) ? d.dueDate : W.nextWorkDay(aType === 'user' ? Number(aId) : actor.id),
      checklist: Array.isArray(d.checklist) ? d.checklist.map((c) => String(c).slice(0, 200)).slice(0, 15) : [],
      recurrence: ['daily', 'weekly', 'monthly'].includes(d.recurrence) ? d.recurrence : '',
      activateDate: W.isDate(d.activateDate) ? d.activateDate : null,
      priority: ['low', 'normal', 'high', 'urgent'].includes(d.priority) ? d.priority : 'normal',
      description: String(d.description ?? '').slice(0, 4000),
      statusShort: String(d.statusShort ?? '').slice(0, 200)
    };
    let taskId;
    try {
      taskId = createTask(actor, Voice.taskBody(draft, String(b.transcript ?? '')));
    } catch (err) {
      throw userError(err);
    }
    sendJson(res, 200, { created: shapeTask(getTaskOr404(taskId), actor, { withDetails: true }), draft });
  });

  /**
   * "ביטול" מההודעה הקופצת אחרי יצירה ישירה. רק מי שיצר, רק משימה מהקלטה,
   * רק בדקות הראשונות ורק כשאיש עוד לא נגע בה — אחרת מוחקים מהכרטיס עצמו.
   */
  router.post('/api/voice/undo/:taskId', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const task = D.get('SELECT * FROM tasks WHERE id = ?', Number(ctx.params.taskId));
    if (!task) throw notFound('המשימה לא נמצאה');
    if (task.source !== 'voice' || task.created_by !== actor.id) throw forbidden('אפשר לבטל רק משימה שיצרת מהקלטה');
    if (Date.now() - new Date(task.created_at).getTime() > 15 * 60000) throw badRequest('עבר זמן רב מדי — מוחקים מהכרטיס עצמו');
    const touched = D.get('SELECT 1 FROM comments WHERE task_id = ? UNION SELECT 1 FROM attachments WHERE task_id = ?', task.id, task.id);
    if (touched) throw badRequest('כבר יש במשימה הערות או קבצים — מוחקים אותה מהכרטיס עצמו');
    D.run('DELETE FROM tasks WHERE id = ?', task.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { register };
