'use strict';
/**
 * נקודות הקצה של משימות AI והחיבורים האישיים (וואטסאפ).
 *
 * קובץ נפרד מ-api.js, שכבר גדול מאוד, אך על אותו נתב ועם אותם עזרי הרשאה —
 * הם מוזרקים מ-api.js ב-‎register‎, כדי שלא יהיו כאן גרסאות מקבילות של
 * "מי רואה משימה" שמתפצלות עם הזמן.
 */
const D = require('./db');
const P = require('./permissions');
const Rules = require('./rules-engine');
const AiTasks = require('./ai-tasks');
const Claude = require('./ai/claude');
const Imap = require('./imap');
const Mailer = require('./mailer');
const WhatsApp = require('./whatsapp');
const { badRequest, forbidden, notFound, readJson, sendJson } = require('./http-kit');

function register(router, h) {
  const { getTaskOr404, assertVisible, mayOnTask, shapeTask, actorRef, saveAttachment } = h;

  AiTasks.setHooks({ saveFile: saveAttachment });

  const internalOnly = (actor) => {
    if (actor.type === 'vendor') throw forbidden();
  };

  /** בקשת ה-AI של המשימה, אחרי בדיקת ראייה והרשאת פעולה */
  function requestFor(ctx, { act = false } = {}) {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const task = getTaskOr404(ctx.params.taskId);
    assertVisible(actor, task);
    const req = AiTasks.requestByTask(task.id);
    if (!req) throw notFound('זו אינה משימת AI');
    // פעולה על המעקב — מי שפתח אותו, או מי שרשאי לערוך את המשימה
    if (act && req.owner_id !== actor.id && !mayOnTask(actor, 'edit_delete_task', task)) {
      throw forbidden('רק מי שפתח את משימת ה-AI או מי שרשאי לערוך אותה יכול לפעול עליה');
    }
    return { actor, task, req };
  }

  const reply = (res, actor, task) =>
    sendJson(res, 200, { task: shapeTask(getTaskOr404(task.id), actor, { withDetails: true }) });

  /** שגיאת AI או ערוץ היא שגיאה שהמשתמש צריך לקרוא, לא "שגיאה פנימית" */
  const userError = (err) => (err?.status ? err : badRequest(err.message));

  /**
   * אנשי קשר מוצעים: ספקים, עובדים, ומי שכבר פנו אליו במשימות AI קודמות.
   * כך מי שפונים אליו שוב ושוב (פקיד בעירייה, רואה החשבון) אינו מוקלד מחדש.
   */
  function contactsFor(actor) {
    const out = [];
    if (P.may(actor, 'view_vendor_boards')) {
      for (const v of D.all("SELECT id, name, contact_name, email, phone FROM vendors WHERE status = 'active' ORDER BY name")) {
        out.push({ type: 'vendor', refId: v.id, name: v.contact_name ? `${v.contact_name} (${v.name})` : v.name, email: v.email, phone: v.phone });
      }
    }
    for (const u of D.all("SELECT id, full_name, email FROM users WHERE status = 'active' AND id <> ? ORDER BY full_name", actor.id)) {
      out.push({ type: 'user', refId: u.id, name: u.full_name, email: u.email, phone: '' });
    }
    const seen = new Set(out.map((c) => c.email.toLowerCase()));
    for (const c of D.all(
      `SELECT contact_name, contact_email, contact_phone, MAX(created_at) at FROM ai_requests
        WHERE owner_id = ? AND contact_type = 'external' GROUP BY lower(contact_email), contact_phone ORDER BY at DESC LIMIT 50`,
      actor.id
    )) {
      if (c.contact_email && seen.has(c.contact_email)) continue;
      seen.add(c.contact_email);
      out.push({ type: 'external', refId: null, name: c.contact_name, email: c.contact_email, phone: c.contact_phone, recent: true });
    }
    return out;
  }

  router.get('/api/ai/status', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    sendJson(res, 200, {
      enabled: Claude.isEnabled(),
      mail: Mailer.isEnabled(),
      inbox: Imap.isEnabled(),
      whatsapp: WhatsApp.publicChannel(actor.id),
      defaults: AiTasks.defaultPolicy(),
      contacts: contactsFor(actor)
    });
  });

  router.post('/api/ai/draft', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    if (!P.may(actor, 'create_task')) throw forbidden();
    const b = await readJson(req);
    const instruction = String(b.instruction ?? '').trim();
    if (!instruction) throw badRequest('נדרש לכתוב מה המשימה');
    const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
    const project = b.projectId ? D.get('SELECT name FROM projects WHERE id = ?', Number(b.projectId)) : null;
    try {
      const draft = await AiTasks.draftInitial({
        owner,
        instruction,
        contact: b.contact ?? {},
        dueDate: b.dueDate ?? null,
        projectName: project?.name ?? null,
        channel: b.channel === 'whatsapp' ? 'whatsapp' : 'email',
        feedback: String(b.feedback ?? '').trim(),
        previous: b.previous ?? null
      });
      sendJson(res, 200, { draft });
    } catch (err) {
      throw userError(err);
    }
  });

  router.post('/api/ai/tasks', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    if (!P.may(actor, 'create_task')) throw forbidden();
    const b = await readJson(req);

    const instruction = String(b.instruction ?? '').trim();
    const draft = b.draft ?? {};
    const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const contact = {
      name: String(b.contact?.name ?? '').trim(),
      email: String(b.contact?.email ?? '').trim(),
      phone: String(b.contact?.phone ?? '').trim(),
      type: b.contact?.type,
      refId: b.contact?.refId ? Number(b.contact.refId) : null
    };
    if (!instruction) throw badRequest('נדרש לכתוב מה המשימה');
    if (!String(draft.body ?? '').trim()) throw badRequest('אין נוסח לשליחה');
    if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw badRequest('נדרשת כתובת מייל תקינה לנמען');
      if (!String(draft.subject ?? '').trim()) throw badRequest('נדרש נושא למייל');
      if (!Mailer.isEnabled()) throw badRequest('שליחת דואר אינה מוגדרת בשרת — אפשר לפתוח בוואטסאפ, או לפנות למנהל המערכת');
    } else {
      if (!WhatsApp.normalizePhone(contact.phone)) throw badRequest('נדרש מספר טלפון תקין לנמען');
      if (!WhatsApp.isReady(actor.id)) throw badRequest('הוואטסאפ שלך אינו מחובר. מחברים אותו מ"החשבון שלי"');
    }

    const projectId = b.projectId ? Number(b.projectId) : null;
    if (projectId && !D.get('SELECT 1 FROM projects WHERE id = ?', projectId)) throw badRequest('הפרויקט לא נמצא');

    const boardId = D.internalBoard().id;
    const title = String(draft.title || draft.goal || instruction).trim().slice(0, 120);
    const description = [
      draft.goal,
      draft.success_criteria ? `נחשב כהתקבל כאשר: ${draft.success_criteria}` : null,
      `נמען: ${[contact.name, contact.email, contact.phone].filter(Boolean).join(' · ')}`
    ].filter(Boolean).join('\n');

    const inserted = D.run(
      `INSERT INTO tasks (title, description, project_id, board_id, assignee_type, assignee_id, status, priority,
         due_date, created_at, created_by, status_changed_at, department_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      title, description, projectId, boardId, 'user', actor.id, Rules.firstColumnKey(boardId),
      ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal',
      b.dueDate || null, D.nowIso(), actor.id, D.nowIso(), actor.departmentId ?? null
    );
    const taskId = Number(inserted.lastInsertRowid);
    D.audit(taskId, actorRef(actor), 'created', 'המשימה נוצרה כמשימת AI');

    let sendError = null;
    try {
      const owner = D.get('SELECT id, full_name, email FROM users WHERE id = ?', actor.id);
      await AiTasks.launch({ taskId, owner, instruction, draft, contact, policy: b.policy ?? {}, channel });
    } catch (err) {
      // המשימה והטיוטה נשמרו; אפשר לנסות לשלוח שוב מהכרטיס אחרי תיקון התקלה
      sendError = err.message;
    }

    sendJson(res, 201, { task: shapeTask(getTaskOr404(taskId), actor, { withDetails: true }), sendError });
  });

  router.post('/api/ai/tasks/:taskId/messages/:msgId/approve', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const b = await readJson(req);
    try {
      await AiTasks.approve(aiReq, Number(ctx.params.msgId), b);
    } catch (err) {
      throw userError(err);
    }
    reply(res, actor, task);
  });

  router.post('/api/ai/tasks/:taskId/messages/:msgId/discard', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    AiTasks.discard(aiReq, Number(ctx.params.msgId));
    reply(res, actor, task);
  });

  router.post('/api/ai/tasks/:taskId/messages/:msgId/revise', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const { feedback } = await readJson(req);
    if (!String(feedback ?? '').trim()) throw badRequest('מה לשנות בטיוטה?');
    try {
      await AiTasks.reviseMessage(aiReq, Number(ctx.params.msgId), String(feedback).trim());
    } catch (err) {
      throw userError(err);
    }
    reply(res, actor, task);
  });

  router.post('/api/ai/tasks/:taskId/answer', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const { answer } = await readJson(req);
    if (!String(answer ?? '').trim()) throw badRequest('נדרשת תשובה');
    try {
      await AiTasks.answerQuestion(aiReq, String(answer).trim());
    } catch (err) {
      throw userError(err);
    }
    reply(res, actor, task);
  });

  router.post('/api/ai/tasks/:taskId/action', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const { action } = await readJson(req);
    if (!['pause', 'resume', 'nudge', 'stop', 'complete'].includes(action)) throw badRequest('פעולה לא מוכרת');
    AiTasks.setState(aiReq, action, actor);
    // "תזכורת עכשיו" לא מחכה לסבב הבא של המנוע
    if (action === 'nudge') await AiTasks.tick();
    reply(res, actor, task);
  });

  router.patch('/api/ai/tasks/:taskId', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const b = await readJson(req);
    if (b.contact?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.contact.email).trim())) {
      throw badRequest('כתובת המייל אינה תקינה');
    }
    AiTasks.updateDetails(aiReq, b);
    D.audit(task.id, actorRef(actor), 'ai_updated', 'עודכנו פרטי המעקב של ה-AI');
    reply(res, actor, task);
  });

  // --- וואטסאפ אישי ---

  router.get('/api/me/whatsapp', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    sendJson(res, 200, { channel: WhatsApp.publicChannel(actor.id) });
  });

  router.put('/api/me/whatsapp', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const b = await readJson(req);
    if (!/^\d{6,15}$/.test(String(b.instanceId ?? '').trim())) throw badRequest('מזהה המכשיר (idInstance) אינו תקין');
    const existing = WhatsApp.publicChannel(actor.id);
    if (!String(b.apiToken ?? '').trim() && !existing?.hasToken) throw badRequest('נדרש האסימון (apiTokenInstance)');
    if (b.apiUrl && !/^https:\/\/[^\s/]+/.test(String(b.apiUrl).trim())) throw badRequest('כתובת ה-API חייבת להתחיל ב-https://');
    WhatsApp.save(actor.id, b);
    const state = await WhatsApp.checkState(actor.id);
    sendJson(res, 200, { channel: WhatsApp.publicChannel(actor.id), ...state });
  });

  router.post('/api/me/whatsapp/test', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const state = await WhatsApp.checkState(actor.id);
    sendJson(res, 200, { channel: WhatsApp.publicChannel(actor.id), ...state });
  });

  router.delete('/api/me/whatsapp', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    WhatsApp.remove(actor.id);
    sendJson(res, 200, { channel: null });
  });

  // --- ניהול ---

  router.post('/api/admin/ai/test-inbox', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    try {
      await Imap.test();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
  });
}

module.exports = { register };
