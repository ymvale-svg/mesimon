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
const AiTasks = require('./ai-tasks');
const Claude = require('./ai/claude');
const WhatsApp = require('./whatsapp');
const Gmail = require('./gmail');
const MailScan = require('./ai/mail-scan');
const WaBot = require('./ai/wa-bot');
const { badRequest, forbidden, notFound, readJson, sendJson } = require('./http-kit');

function register(router, h) {
  const { getTaskOr404, assertVisible, mayOnTask, shapeTask, actorRef, saveAttachment, createTask, assertMayAssignTo, listProjectsFor } = h;

  AiTasks.setHooks({ saveFile: saveAttachment });
  MailScan.init({ createTask });
  WaBot.init({ createTask, listProjectsFor });

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
      // מייל יוצא רק מתיבת ה-Gmail של המשתמש; תשובות חוזרות אליה ונקלטות משם
      mail: Gmail.canSend(actor.id),
      inbox: Gmail.isConnected(actor.id),
      gmail: Gmail.publicStatus(actor.id),
      gmailEnabled: Gmail.isEnabled(),
      whatsapp: WhatsApp.publicChannel(actor.id),
      defaults: AiTasks.defaultPolicy(actor.id),
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

    /*
     * הנמען עובד בארגון: אין מייל מבחוץ. המשימה משויכת אליו במשימון — עם
     * אותה בדיקת הרשאה של כל שיוך — והמעקב הוא תזכורות בתוך המערכת.
     */
    const colleague = contact.type === 'user' && contact.refId
      ? D.get("SELECT id, full_name, email FROM users WHERE id = ? AND status = 'active'", contact.refId)
      : null;
    if (contact.type === 'user' && contact.refId && !colleague) throw badRequest('העובד שנבחר אינו פעיל');
    if (colleague && colleague.id === actor.id) throw badRequest('אי אפשר לפתוח משימת AI לעצמך');
    if (colleague) {
      assertMayAssignTo(actor, 'user', colleague.id);
      contact.name = contact.name || colleague.full_name;
      contact.email = colleague.email;
    } else if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw badRequest('נדרשת כתובת מייל תקינה לנמען');
      if (!String(draft.subject ?? '').trim()) throw badRequest('נדרש נושא למייל');
      if (!Gmail.canSend(actor.id)) throw badRequest('כדי לשלוח מייל צריך לחבר את תיבת ה-Gmail שלך ("החשבון שלי ← Gmail ועוזר ה-AI"). אפשר גם לפתוח בוואטסאפ');
    } else {
      if (!WhatsApp.normalizePhone(contact.phone)) throw badRequest('נדרש מספר טלפון תקין לנמען');
      if (!WhatsApp.isReady(actor.id)) throw badRequest('הוואטסאפ שלך אינו מחובר. מחברים אותו מ"החשבון שלי"');
    }

    // נפתחה מהצעה שהגיעה מהמייל ("הפוך למשימת AI") — רק הצעה של המשתמש עצמו
    const suggestion = b.suggestionId ? MailScan.suggestionById(Number(b.suggestionId)) : null;
    if (suggestion && (suggestion.user_id !== actor.id || suggestion.status !== 'pending')) throw badRequest('ההצעה כבר טופלה');

    const projectId = b.projectId ? Number(b.projectId) : null;
    if (projectId && !D.get('SELECT 1 FROM projects WHERE id = ?', projectId)) throw badRequest('הפרויקט לא נמצא');

    const title = String(draft.title || draft.goal || instruction).trim().slice(0, 120);
    const description = [
      colleague ? draft.body : draft.goal,
      draft.success_criteria ? `נחשב כהתקבל כאשר: ${draft.success_criteria}` : null,
      colleague ? `ביקש/ה: ${actor.name}` : `נמען: ${[contact.name, contact.email, contact.phone].filter(Boolean).join(' · ')}`
    ].filter(Boolean).join('\n');

    const taskId = createTask(actor, {
      title,
      description,
      projectId,
      // משימה לעובד אצלו בלוח; משימה מול גורם חיצוני — אצל מי שפתח אותה
      assigneeType: 'user',
      assigneeId: colleague ? colleague.id : actor.id,
      priority: ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal',
      dueDate: b.dueDate || null,
      source: suggestion ? 'email' : '',
      sourceRef: suggestion?.header_id ?? null,
      sourceUserId: suggestion ? actor.id : null,
      auditNote: suggestion ? `המשימה נוצרה כמשימת AI ממייל של ${suggestion.from_name}` : 'המשימה נוצרה כמשימת AI'
    });
    if (suggestion) MailScan.markConverted(suggestion.id, actor.id, taskId);

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
    const b = await readJson(req);
    const { action, days } = b;
    if (!['pause', 'resume', 'nudge', 'stop', 'complete', 'postpone'].includes(action)) throw badRequest('פעולה לא מוכרת');
    AiTasks.setState(aiReq, action, actor, { days });
    // "תזכורת עכשיו" לא מחכה לסבב הבא של המנוע
    if (action === 'nudge') await AiTasks.tick();
    reply(res, actor, task);
  });

  // --- "דיברתי איתו": עדכון ממה שקרה מחוץ להתכתבות ---

  router.post('/api/ai/tasks/:taskId/note/interpret', async (req, res, ctx) => {
    const { req: aiReq } = requestFor(ctx, { act: true });
    const { note } = await readJson(req);
    if (!String(note ?? '').trim()) throw badRequest('מה קרה? כתבו שורה אחת');
    try {
      sendJson(res, 200, { proposal: await AiTasks.interpretNote(aiReq, String(note).trim()) });
    } catch (err) {
      throw userError(err);
    }
  });

  router.post('/api/ai/tasks/:taskId/note', async (req, res, ctx) => {
    const { actor, task, req: aiReq } = requestFor(ctx, { act: true });
    const b = await readJson(req);
    if (b.action === 'reschedule' && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? ''))) throw badRequest('נדרש תאריך');
    try {
      AiTasks.applyNote(aiReq, actor, b);
    } catch (err) {
      throw userError(err);
    }
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
    if (state.state === 'authorized') await WhatsApp.enableOutgoingNotifications(actor.id);
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

  // --- Gmail אישי ---

  const userOnly = (ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') throw forbidden();
    return actor;
  };

  const gmailInfo = (actor) => ({
    enabled: Gmail.isEnabled(),
    ai: Claude.isEnabled(),
    scanEnabled: Boolean(D.getSetting('ai_mail_scan_enabled', true)),
    scanTime: D.getSetting('ai_scan_time', '07:00'),
    dailyLimit: Number(D.getSetting('ai_scan_daily_limit', 100)),
    connection: Gmail.publicStatus(actor.id),
    senders: MailScan.senders(actor.id),
    prefs: {
      approveReminders: AiTasks.defaultPolicy(actor.id).approveReminders,
      mailAutoCreate: D.userPrefs(actor.id).mailAutoCreate === true
    }
  });

  router.get('/api/me/gmail', async (req, res, ctx) => {
    sendJson(res, 200, gmailInfo(userOnly(ctx)));
  });

  router.get('/api/me/gmail/connect', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Gmail.isEnabled()) throw badRequest('חיבור Google אינו מוגדר בשרת');
    const user = D.get('SELECT id, email FROM users WHERE id = ?', actor.id);
    res.writeHead(302, { location: Gmail.authorizeUrl(req, user), 'cache-control': 'no-store' });
    res.end();
  });

  router.delete('/api/me/gmail', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    await Gmail.disconnect(actor.id);
    sendJson(res, 200, gmailInfo(actor));
  });

  router.post('/api/me/gmail/scan', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Claude.isEnabled()) throw badRequest('חיבור ה-AI אינו מוגדר בשרת');
    if (!D.getSetting('ai_mail_scan_enabled', true)) throw badRequest('סריקת המיילים כבויה במסך הניהול');
    const b = await readJson(req);
    try {
      MailScan.startScan(actor.id, { range: b.range, from: b.from, to: b.to });
    } catch (err) {
      throw userError(err);
    }
    sendJson(res, 202, gmailInfo(actor));
  });

  router.put('/api/me/ai-prefs', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (typeof b.approveReminders === 'boolean') D.setUserPref(actor.id, 'aiApproveReminders', b.approveReminders);
    if (typeof b.mailAutoCreate === 'boolean') D.setUserPref(actor.id, 'mailAutoCreate', b.mailAutoCreate);
    sendJson(res, 200, gmailInfo(actor));
  });

  router.put('/api/me/mail-senders', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (!/^[^\s@]+@[^\s@]+$/.test(String(b.email ?? '').trim())) throw badRequest('כתובת לא תקינה');
    MailScan.setSender(actor.id, b.email, ['trust', 'ignore'].includes(b.mode) ? b.mode : null);
    sendJson(res, 200, gmailInfo(actor));
  });

  // --- "ממתין לאישורך" — כל מה שהעוזר מחכה בו למשתמש ---

  router.get('/api/ai/inbox', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, {
      upcoming: AiTasks.upcomingFor(actor.id),
      waiting: AiTasks.waitingOnUser(actor.id),
      suggestions: MailScan.listFor(actor.id),
      gmail: gmailInfo(actor)
    });
  });

  const suggestionAction = (name, fn) => router.post(`/api/ai/suggestions/:id/${name}`, async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    try {
      const taskId = fn(Number(ctx.params.id), actor, b);
      sendJson(res, 200, { ok: true, taskId: typeof taskId === 'number' ? taskId : null });
    } catch (err) {
      throw userError(err);
    }
  });
  suggestionAction('approve', (id, actor, b) => MailScan.approve(id, actor, b ?? {}));
  suggestionAction('reject', (id, actor, b) => MailScan.reject(id, actor, { ignoreSender: Boolean(b?.ignoreSender) }));
  suggestionAction('join', (id, actor) => MailScan.join(id, actor));
  suggestionAction('skip', (id, actor) => MailScan.skip(id, actor));
  suggestionAction('undo', (id, actor) => MailScan.undo(id, actor));

  router.post('/api/ai/suggestions/approve-all', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, MailScan.approveAll(actor));
  });

  // --- בוט הוואטסאפ של הארגון — מנהל המערכת בלבד ---

  const botAdmin = (ctx) => {
    const actor = userOnly(ctx);
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    return actor;
  };

  const botInfo = () => ({
    ...WaBot.publicStatus(),
    groups: WaBot.listGroups(),
    projects: D.all("SELECT id, name FROM projects WHERE status <> 'done' ORDER BY name"),
    usersWithoutPhone: D.all("SELECT full_name FROM users WHERE status = 'active' AND role <> 'vendor' AND phone = '' ORDER BY full_name").map((u) => u.full_name)
  });

  router.get('/api/admin/wa-bot', async (req, res, ctx) => {
    botAdmin(ctx);
    sendJson(res, 200, botInfo());
  });

  router.put('/api/admin/wa-bot', async (req, res, ctx) => {
    botAdmin(ctx);
    const b = await readJson(req);
    if (!/^\d{6,15}$/.test(String(b.instanceId ?? '').trim())) throw badRequest('מזהה המכשיר (idInstance) אינו תקין');
    if (!String(b.apiToken ?? '').trim() && !WaBot.publicStatus().connection?.hasToken) throw badRequest('נדרש האסימון (apiTokenInstance)');
    if (b.apiUrl && !/^https:\/\/[^\s/]+/.test(String(b.apiUrl).trim())) throw badRequest('כתובת ה-API חייבת להתחיל ב-https://');
    WaBot.save(b);
    const state = await WaBot.checkState();
    sendJson(res, 200, { ...botInfo(), ...state });
  });

  router.post('/api/admin/wa-bot/test', async (req, res, ctx) => {
    botAdmin(ctx);
    const state = await WaBot.checkState();
    sendJson(res, 200, { ...botInfo(), ...state });
  });

  router.get('/api/admin/wa-bot/qr', async (req, res, ctx) => {
    botAdmin(ctx);
    try {
      sendJson(res, 200, await WaBot.qr());
    } catch (err) {
      throw userError(err);
    }
  });

  router.delete('/api/admin/wa-bot', async (req, res, ctx) => {
    botAdmin(ctx);
    WaBot.remove();
    sendJson(res, 200, botInfo());
  });

  router.put('/api/admin/wa-groups/:chatId', async (req, res, ctx) => {
    const actor = botAdmin(ctx);
    const b = await readJson(req);
    try {
      WaBot.bindGroup(ctx.params.chatId, actor, { projectId: b.projectId, ignore: b.ignore === true });
    } catch (err) {
      throw userError(err);
    }
    sendJson(res, 200, botInfo());
  });

}

module.exports = { register };
