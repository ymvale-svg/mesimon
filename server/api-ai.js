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
const Phonebook = require('./phonebook');
const Gmail = require('./gmail');
const MailScan = require('./ai/mail-scan');
const GContacts = require('./google-contacts');
const WaScan = require('./ai/whatsapp-scan');
const Calendar = require('./calendar');
const WaBot = require('./ai/wa-bot');
const WaActions = require('./ai/wa-actions');
const Memory = require('./ai/mail-memory');
const MailAsk = require('./ai/mail-ask');
const Agents = require('./ai/agents');
const OrgKnowledge = require('./ai/org-knowledge');
const Timeless = require('./timeless');
const MailInsights = require('./ai/mail-insights');
const Mime = require('./mime');
const { badRequest, forbidden, notFound, readJson, sendJson, parseUrl } = require('./http-kit');

function register(router, h) {
  const { getTaskOr404, assertVisible, mayOnTask, shapeTask, actorRef, saveAttachment, createTask, assertMayAssignTo, assertMayUseProject, listProjectsFor, newTaskProjects, assignableUserIds, assignBlockReason, botTaskOps } = h;

  AiTasks.setHooks({ saveFile: saveAttachment, scanWhatsApp: WaScan.handle, scanningUsers: WaScan.scanningUsers });
  MailScan.init({ createTask });
  Agents.init({ listProjectsFor, projectTasks: (actor, projectId) => botTaskOps.projectTasks(actor, projectId) });
  WaBot.init({ createTask, listProjectsFor, newTaskProjects, assignableUserIds, assignBlockReason, tasks: botTaskOps, mail: { searchContacts, createAiTask } });

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

  /**
   * חיפוש נמען — מאחד את המקורות של משימון (עובדים, ספקים, נמענים קודמים)
   * עם אנשי הקשר של Google ועם האלפון הארגוני. אותו אדם מופיע פעם אחת: לפי
   * מייל או טלפון.
   *
   * הסדר: אנשי הקשר של Google (שמורים וספריית הארגון) ← עובדים, ספקים
   * ונמענים קודמים במשימון ← האלפון הארגוני ← מי שהתכתבתי איתו ב-Gmail ולא
   * שמרתי. איש קשר מ-Google שהוא עובד או ספק במשימון — נשאר עם המשמעות
   * שלו במשימון (עובד / ספק), והטלפון שחסר לספק נלקח מ-Google.
   *
   * ‎only‎ — 'phonebook' (רק האלפון: "תביא לי מהאלפון…") או 'google' (רק Google).
   * ‎unsaved‎ — לא שמור באנשי הקשר של Google, ולכן מוצע "⭐ שמור".
   */
  function searchContacts(actor, q, { only = null } = {}) {
    const { tokens, digits } = GContacts.matcher(q);
    const canSave = Gmail.has(actor.id, 'contacts');
    const all = contactsFor(actor);
    const local = all.filter((c) => {
      if (!tokens.length && !digits) return c.type !== 'user';
      const hay = GContacts.fold([c.name, c.email].join(' '));
      if (digits.length >= 3 && GContacts.phoneKey(c.phone).includes(digits)) return true;
      return tokens.length && tokens.every((t) => hay.includes(t));
    });

    const out = [];
    const seen = new Set();
    const keysOf = (emails, phones) => [
      ...emails.map((e) => `e:${String(e).toLowerCase()}`),
      ...phones.map((p) => GContacts.phoneKey(p)).filter((p) => p.length >= 9).map((p) => `p:${p}`)
    ];
    const add = (entry, keys) => {
      if (keys.some((k) => seen.has(k))) return;
      keys.forEach((k) => seen.add(k));
      out.push(entry);
    };
    // ספקים במשימון לפי מייל וטלפון — כדי שאיש קשר מ-Google שהוא ספק יישאר ספק
    const vendorByKey = new Map();
    for (const c of all.filter((x) => x.type === 'vendor')) for (const k of keysOf([c.email].filter(Boolean), [c.phone].filter(Boolean))) vendorByKey.set(k, c);

    const addGoogle = (g) => {
      // עובד בארגון שנמצא בספריית Google — מופיע כעובד במשימון
      const colleague = g.emails.map((e) => D.get("SELECT id, full_name FROM users WHERE lower(email) = ? AND status = 'active'", e.value)).find(Boolean);
      if (colleague && colleague.id === actor.id) return;
      const keys = keysOf(g.emails.map((e) => e.value), g.phones.map((p) => p.value));
      const vendor = colleague ? null : keys.map((k) => vendorByKey.get(k)).find(Boolean);
      add({
        type: colleague ? 'user' : vendor ? 'vendor' : 'external',
        refId: colleague?.id ?? vendor?.refId ?? null,
        source: g.source,
        resourceName: g.resourceName,
        name: colleague?.full_name ?? vendor?.name ?? g.name,
        email: vendor?.email || g.emails[0]?.value || '',
        phone: vendor?.phone || g.phones[0]?.value || '',
        emails: g.emails, phones: g.phones, organization: g.organization, title: g.title,
        unsaved: canSave && g.source === 'other'
      }, keys);
    };

    const google = only === 'phonebook' ? [] : GContacts.search(actor.id, q, 30);

    // 1. אנשי הקשר של Google — השמורים וספריית הארגון
    for (const g of google.filter((x) => x.source !== 'other')) addGoogle(g);

    // 2. משימון: עובדים, ספקים ונמענים קודמים
    if (!only) {
      for (const c of local.slice(0, 30)) {
        const g = GContacts.lookup(actor.id, { email: c.email, phone: c.phone });
        const phone = c.phone || g?.phones[0]?.value || '';
        add({
          type: c.type, refId: c.refId, source: c.recent ? 'recent' : c.type,
          name: c.name, email: c.email ?? '', phone,
          emails: c.email ? [{ value: c.email, label: '' }] : [],
          phones: phone ? [{ value: phone, label: '' }] : [],
          organization: '',
          unsaved: canSave && c.type !== 'user' && !GContacts.isSaved(actor.id, { email: c.email, phone })
        }, keysOf([c.email].filter(Boolean), [phone].filter(Boolean)));
      }
    }

    // 3. האלפון הארגוני
    if (q && only !== 'google') {
      for (const e of Phonebook.search(q, { limit: 20 })) {
        /*
         * עובדים וספקים נמצאים באלפון, אך כאן הם מגיעים מהמקור שלהם, עם
         * המשמעות שלהם במשימון (‎contactsFor‎). ספק נשאר מהאלפון רק למי שאינו
         * רואה ספקים — אצלו הוא איש קשר חיצוני רגיל. בחיפוש באלפון בלבד —
         * כל הרשומות.
         */
        if (!only && e.kind === 'user') continue;
        if (!only && e.kind === 'vendor' && P.may(actor, 'view_vendor_boards')) continue;
        const colleague = !only && e.email ? D.get("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", e.email) : null;
        if (colleague) continue;  // עובד — מופיע כעובד, עם המשמעות שלו במשימון
        const two = e.phone && e.phone2;
        add({
          type: e.kind === 'user' ? 'user' : 'external', refId: e.kind === 'user' ? Number(String(e.id).replace(/\D/g, '')) || null : null, source: 'phonebook',
          name: e.name, email: e.email, phone: e.phone || e.phone2,
          emails: e.email ? [{ value: e.email, label: '' }] : [],
          phones: [[e.phone, two ? "טל' 1" : ''], [e.phone2, "טל' 2"]].filter(([v]) => v).map(([value, label]) => ({ value, label })),
          organization: e.org || e.note,
          unsaved: canSave && !GContacts.isSaved(actor.id, { email: e.email, phone: e.phone })
        }, keysOf([e.email].filter(Boolean), [e.phone, e.phone2].filter(Boolean)));
      }
    }

    // 4. מי שהתכתבתי איתו ב-Gmail ולא שמרתי — בסוף
    for (const g of google.filter((x) => x.source === 'other')) addGoogle(g);

    /*
     * ‎mobile‎ — הנייד (05X) מבין המספרים, לכל מקור. שדה וואטסאפ מתמלא רק
     * ממנו: טלפון משרד או פקס אינם מקבלים וואטסאפ, ועדיף שדה ריק משליחה
     * למספר שלא יגיע אליו כלום.
     */
    return out.slice(0, 20).map((c) => ({
      ...c,
      mobile: [c.phone, ...(c.phones ?? []).map((p) => p.value)].find((p) => p && Phonebook.isMobile(p)) ?? ''
    }));
  }

  router.get('/api/ai/contacts', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const q = String(parseUrl(req).searchParams.get('q') ?? '').trim().slice(0, 100);
    sendJson(res, 200, { contacts: searchContacts(actor, q), google: GContacts.status(actor.id) });
  });

  /** האם להציע לשמור את הנמען באנשי הקשר — אחרי שליחה, בכרטיס המשימה */
  router.get('/api/ai/contacts/check', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const q = parseUrl(req).searchParams;
    const contact = { email: q.get('email') ?? '', phone: q.get('phone') ?? '' };
    sendJson(res, 200, { suggest: GContacts.shouldSuggest(actor.id, contact) });
  });

  router.post('/api/ai/contacts/save', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const b = await readJson(req);
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) throw badRequest('כתובת המייל אינה תקינה');
    try {
      sendJson(res, 200, { contact: await GContacts.save(actor.id, b) });
    } catch (err) {
      throw userError(err);
    }
  });

  router.post('/api/ai/contacts/dismiss', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const b = await readJson(req);
    GContacts.dismiss(actor.id, { email: b.email, phone: b.phone });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/me/google/contacts/sync', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    GContacts.syncSoon(actor.id);
    sendJson(res, 202, { google: { ...GContacts.status(actor.id), running: true } });
  });

  router.get('/api/ai/status', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    sendJson(res, 200, {
      enabled: Claude.isEnabled(),
      // מייל יוצא רק מתיבת ה-Gmail של המשתמש; תשובות חוזרות אליה ונקלטות משם
      mail: Gmail.canSend(actor.id),
      inbox: Gmail.isConnected(actor.id),
      gmail: Gmail.publicStatus(actor.id),
      // יותר מתיבה אחת עם שליחה — באשף מופיע "שליחה מ…"
      sendBoxes: Gmail.sendBoxes(actor.id),
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
        cc: Array.isArray(b.cc) ? b.cc : [],
        dueDate: b.dueDate ?? null,
        projectName: project?.name ?? null,
        // וואטסאפ רק למי שחיבר אותו — אחרת הנוסח נכתב למייל
        channel: b.channel === 'whatsapp' && WhatsApp.isReady(actor.id) ? 'whatsapp' : 'email',
        feedback: String(b.feedback ?? '').trim(),
        previous: b.previous ?? null,
        context: b.channel === 'whatsapp' ? '' : await AiTasks.mailContext(actor.id, b.contact?.email)
      });
      // החתימה מ-Gmail — לתצוגה מתחת לנוסח בלבד; נערכת רק ב-Gmail עצמו
      const sig = b.channel === 'whatsapp' ? null : await Gmail.signatureInfo(actor.id);
      sendJson(res, 200, {
        draft,
        signature: sig?.state === 'ok' ? sig.html : null,
        // אין חתימה ב-Gmail — למה, ומה יופיע בסוף המייל במקומה
        signatureMissing: sig && sig.state !== 'ok' ? { state: sig.state, help: sig.help, fallback: Gmail.fallbackSignature(actor.id)?.text ?? '' } : null
      });
    } catch (err) {
      throw userError(err);
    }
  });

  /**
   * פתיחת משימת AI מטיוטה שאושרה — מהאשף באפליקציה ומבוט הוואטסאפ, באותן
   * בדיקות בדיוק. מחזיר את מזהה המשימה, ושגיאת שליחה אם הייתה (המשימה
   * והטיוטה נשמרות גם אז, ואפשר לשלוח שוב מהכרטיס).
   */
  async function createAiTask(actor, b) {
    const instruction = String(b.instruction ?? '').trim();
    const draft = b.draft ?? {};
    /*
     * וואטסאפ רק למי שחיבר אותו. בקשה ישנה, או משימה מהקלטה, שביקשה וואטסאפ
     * בלי חיבור יוצאת במייל — ולא נתקעת על ערוץ שאינו קיים.
     */
    const waReady = WhatsApp.isReady(actor.id);
    const channel = b.channel === 'whatsapp' && waReady ? 'whatsapp' : 'email';
    // מאיזו תיבה יוצא המייל — ‎0‎ הראשית, או תיבה נוספת של המשתמש
    const fromBox = Number.isInteger(Number(b.fromBox)) && Number(b.fromBox) > 0 ? Number(b.fromBox) : 0;
    const policy = { ...(b.policy ?? {}), ...(waReady ? {} : { whatsapp: false }) };
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

    /*
     * משימה קיימת שהופכת למשימת AI ("💡 איך לסגור" בכרטיס): הפנייה יוצאת עליה,
     * בלי משימה חדשה. רק מי שרשאי לערוך אותה, ורק אם אין בה כבר מעקב.
     */
    const existing = b.taskId ? getTaskOr404(Number(b.taskId)) : null;
    if (existing) {
      assertVisible(actor, existing);
      if (!mayOnTask(actor, 'edit_delete_task', existing) && !(existing.assignee_type === 'user' && existing.assignee_id === actor.id)) throw forbidden('אין הרשאה לערוך את המשימה');
      if (AiTasks.requestByTask(existing.id)) throw badRequest('במשימה הזו כבר יש מעקב AI');
      if (colleague) throw badRequest('העברה לעובד — בשיוך המשימה, לא במשימת AI');
    }
    if (colleague) {
      assertMayAssignTo(actor, 'user', colleague.id);
      contact.name = contact.name || colleague.full_name;
      contact.email = colleague.email;
    } else if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw badRequest('נדרשת כתובת מייל תקינה לנמען');
      if (!String(draft.subject ?? '').trim()) throw badRequest('נדרש נושא למייל');
      if (fromBox && !Gmail.canSend(Gmail.handle(actor.id, fromBox))) throw badRequest('אי אפשר לשלוח מהתיבה שנבחרה — היא לא מחוברת עם הרשאת שליחה');
      if (!Gmail.canSend(Gmail.handle(actor.id, fromBox))) throw badRequest(`כדי לשלוח מייל צריך לחבר את תיבת ה-Gmail שלך ("החשבון שלי ← Gmail ועוזר ה-AI").${waReady ? ' אפשר גם לפתוח בוואטסאפ' : ''}`);
    } else {
      if (!WhatsApp.normalizePhone(contact.phone)) throw badRequest('נדרש מספר טלפון תקין לנמען');
      if (!WhatsApp.isReady(actor.id)) throw badRequest('הוואטסאפ שלך אינו מחובר. מחברים אותו מ"החשבון שלי"');
    }

    // נפתחה מהצעה שהגיעה מהמייל ("הפוך למשימת AI") — רק הצעה של המשתמש עצמו
    const suggestion = b.suggestionId ? MailScan.suggestionById(Number(b.suggestionId)) : null;
    if (suggestion && (suggestion.user_id !== actor.id || suggestion.status !== 'pending')) throw badRequest('ההצעה כבר טופלה');

    const projectId = b.projectId ? Number(b.projectId) : null;
    if (projectId && !D.get('SELECT 1 FROM projects WHERE id = ?', projectId)) throw badRequest('הפרויקט לא נמצא');
    assertMayUseProject(actor, projectId);

    // בהעתק — רק במייל לגורם מבחוץ; משימה פנימית לעובד אינה מייל
    const cc = channel === 'email' && !colleague
      ? AiTasks.cleanCc(b.cc, { contactEmail: contact.email, ownerEmail: actor.email })
      : [];
    const title = String(draft.title || draft.goal || instruction).trim().slice(0, 120);
    const description = [
      colleague ? draft.body : draft.goal,
      draft.success_criteria ? `נחשב כהתקבל כאשר: ${draft.success_criteria}` : null,
      colleague ? `ביקש/ה: ${actor.name}` : `נמען: ${[contact.name, contact.email, contact.phone].filter(Boolean).join(' · ')}`,
      cc.length ? `בהעתק: ${cc.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email)).join(', ')}` : null
    ].filter(Boolean).join('\n');

    const taskId = existing ? existing.id : createTask(actor, {
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
      await AiTasks.launch({ taskId, owner, instruction, draft, contact, cc, policy, channel, fromBox });
    } catch (err) {
      // המשימה והטיוטה נשמרו; אפשר לנסות לשלוח שוב מהכרטיס אחרי תיקון התקלה
      sendError = err.message;
    }

    return { taskId, sendError };
  }

  router.post('/api/ai/tasks', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    if (!P.may(actor, 'create_task')) throw forbidden();
    const { taskId, sendError } = await createAiTask(actor, await readJson(req));
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

  /** "להציע משימות ופגישות מהוואטסאפ שלי" — שיחות פרטיות, ורשימת "לא לסרוק" */
  router.get('/api/me/wa-scan', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    sendJson(res, 200, { ...WaScan.publicPrefs(actor.id), ai: Claude.isEnabled() });
  });

  router.put('/api/me/wa-scan', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const b = await readJson(req);
    WaScan.setPrefs(actor.id, b);
    sendJson(res, 200, { ...WaScan.publicPrefs(actor.id), ai: Claude.isEnabled() });
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

  const meUser = (actor) => D.get('SELECT id, full_name, email, role FROM users WHERE id = ?', actor.id);

  const gmailInfo = (actor) => ({
    // זיכרון העבודה — רק מנהל המערכת רואה ושולט; אצל העובדים הוא רץ אוטומטית ברקע
    memory: P.can(actor, 'manage_automations') ? Memory.status(meUser(actor)) : null,
    enabled: Gmail.isEnabled(),
    ai: Claude.isEnabled(),
    scanEnabled: Boolean(D.getSetting('ai_mail_scan_enabled', true)),
    scanTime: D.getSetting('ai_scan_time', '07:00'),
    dailyLimit: Number(D.getSetting('ai_scan_daily_limit', 100)),
    connection: Gmail.publicStatus(actor.id),
    // התיבות שאפשר לשלוח מהן — לבחירת "שליחה מ…" במשימת AI
    sendBoxes: Gmail.sendBoxes(actor.id),
    contacts: GContacts.status(actor.id),
    calendar: { connected: Calendar.isConnected(actor.id) },
    senders: MailScan.senders(actor.id),
    prefs: {
      approveReminders: AiTasks.defaultPolicy(actor.id).approveReminders,
      mailAutoCreate: D.userPrefs(actor.id).mailAutoCreate === true
    }
  });

  router.get('/api/me/gmail', async (req, res, ctx) => {
    sendJson(res, 200, gmailInfo(userOnly(ctx)));
  });

  /** החתימה מ-Gmail למסך החשבון — ‎?refresh=1‎ קורא אותה מחדש עכשיו */
  router.get('/api/me/gmail/signature', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    internalOnly(actor);
    const fresh = parseUrl(req).searchParams.get('refresh') === '1';
    const info = await Gmail.signatureInfo(actor.id, { fresh });
    sendJson(res, 200, { ...info, fallback: info.state === 'ok' ? null : Gmail.fallbackSignature(actor.id)?.text ?? '' });
  });

  router.get('/api/me/gmail/connect', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    if (!Gmail.isEnabled()) throw badRequest('חיבור Google אינו מוגדר בשרת');
    const user = D.get('SELECT id, email FROM users WHERE id = ?', actor.id);
    // ‎?add=1‎ — חשבון Google נוסף (רק למי שכבר חיבר את הראשי)
    const add = parseUrl(req).searchParams.get('add') === '1' && Boolean(Gmail.connectionOf(actor.id));
    res.writeHead(302, { location: Gmail.authorizeUrl(req, user, { add }), 'cache-control': 'no-store' });
    res.end();
  });

  /** ניתוק תיבה נוספת אחת — הראשית נשארת */
  router.delete('/api/me/gmail/accounts/:box', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const box = Number(ctx.params.box);
    if (!Number.isInteger(box) || box <= 0 || !Gmail.connectionOf(Gmail.handle(actor.id, box))) throw notFound('התיבה לא נמצאה');
    await Gmail.disconnect(Gmail.handle(actor.id, box));
    Calendar.forget(actor.id);
    sendJson(res, 200, gmailInfo(actor));
  });

  router.delete('/api/me/gmail', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    // ‎?forget=1‎ — המשתמש בחר בזמן הניתוק למחוק גם את זיכרון העבודה
    if (parseUrl(req).searchParams.get('forget') === '1') Memory.forget(actor.id);
    else if (Memory.status(meUser(actor)).state !== 'idle') {
      // בלי חיבור אין המשך — ריצה פעילה נעצרת, הזיכרון נשמר
      D.run("UPDATE mail_memory_runs SET state = CASE WHEN state IN ('mapping','running','mapped') THEN 'paused' ELSE state END WHERE user_id = ?", actor.id);
    }
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

  // --- 🧠 זיכרון העבודה מהמייל — של המשתמש עצמו בלבד ---

  const memoryCall = (fn) => async (req, res, ctx) => {
    const actor = userOnly(ctx);
    // השליטה בזיכרון — מנהל המערכת בלבד (החלטת ההנהלה: אצל העובדים הסריקה אוטומטית ושקופה)
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    const b = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    try {
      sendJson(res, 200, await fn(meUser(actor), b, ctx, req));
    } catch (err) {
      throw userError(err);
    }
  };
  router.get('/api/me/mail-memory', memoryCall((user) => Memory.status(user)));
  router.post('/api/me/mail-memory/start', memoryCall((user, b) => Memory.start(user, {
    fromDate: b.fromDate || null, withDocs: b.withDocs !== false, internal: b.internal !== false,
    excludedLabels: Array.isArray(b.excludedLabels) ? b.excludedLabels : []
  })));
  router.post('/api/me/mail-memory/approve', memoryCall((user, b) => Memory.approve(user, { withDocs: typeof b.withDocs === 'boolean' ? b.withDocs : undefined })));
  router.post('/api/me/mail-memory/pause', memoryCall((user) => Memory.pause(user)));
  router.put('/api/me/mail-memory', memoryCall((user, b) => Memory.update(user, b)));
  router.delete('/api/me/mail-memory', memoryCall((user) => { Memory.forget(user.id); return Memory.status(user); }));
  router.get('/api/me/mail-memory/browse', memoryCall((user, b, ctx, req) => {
    const sp = parseUrl(req).searchParams;
    return Memory.browse(user.id, { q: sp.get('q') ?? '', tab: sp.get('tab') ?? 'people', offset: sp.get('offset') ?? 0 });
  }));
  router.put('/api/me/mail-memory/people/:id', memoryCall((user, b, ctx) => Memory.editPerson(user.id, Number(ctx.params.id), b)));
  router.delete('/api/me/mail-memory/:kind/:id', memoryCall((user, b, ctx) => {
    Memory.remove(user.id, ctx.params.kind, Number(ctx.params.id));
    return { ok: true };
  }));
  /** תוויות ה-Gmail — לבחירת מה להחריג מהסריקה */
  router.get('/api/me/gmail/labels', memoryCall(async (user) => {
    if (!Gmail.has(user.id, 'mail')) return { labels: [] };
    return { labels: (await Gmail.labels(user.id)).filter((l) => l.type === 'user').map((l) => l.name).sort() };
  }));

  // --- ✉️ שאל את המיילים ---

  router.post('/api/ai/mail-ask', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    let context = '';
    if (b.taskId) {
      const task = getTaskOr404(Number(b.taskId));
      assertVisible(actor, task);
      context = `המשימה: ${task.title}${task.description ? `\n${task.description}` : ''}`;
    }
    try {
      sendJson(res, 200, await MailAsk.ask(meUser(actor), b.question, Array.isArray(b.history) ? b.history : [], { context }));
    } catch (err) {
      throw userError(err);
    }
  });
  router.get('/api/ai/mail-ask/recent', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { recent: MailAsk.recent(actor.id), available: MailAsk.available(actor.id) });
  });
  router.delete('/api/ai/mail-ask/recent', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    MailAsk.clearRecent(actor.id);
    sendJson(res, 200, { recent: [] });
  });

  /** "↩︎ תשובה במייל" מתוך תשובה — אותו ניסוח של תשובה מהבוט, ושליחה רק באישור */
  router.post('/api/ai/mail-ask/reply/draft', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (!Gmail.canSend(actor.id)) throw badRequest('כדי לענות צריך לחבר את תיבת ה-Gmail עם הרשאת שליחה');
    try {
      const prev = b.previous && b.feedback ? { body: String(b.previous.body ?? '') } : null;
      const box = Number(b.box) || 0;
      const reply = await MailInsights.draftReply(actor.id, String(b.gmailId ?? ''), String(b.request ?? ''), { box, ...(prev ? { feedback: String(b.feedback), previous: prev } : {}) });
      sendJson(res, 200, { body: reply.body, to: reply.to, toName: reply.toName, subject: reply.subject });
    } catch (err) {
      throw userError(err);
    }
  });
  /** 💡 הצעת תשובה — בלי "מה לענות": לפי המייל, תשובות קודמות, הזיכרון והידע הארגוני */
  router.post('/api/ai/mail-ask/reply/suggest', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const box = Number(b.box) || 0;
    if (!Gmail.canSend(Gmail.handle(actor.id, box))) throw badRequest('כדי לענות צריך לחבר את תיבת ה-Gmail עם הרשאת שליחה');
    try {
      const r = await MailInsights.suggestReply(actor.id, String(b.gmailId ?? ''), { box });
      sendJson(res, 200, { body: r.body, basis: r.basis, missing: r.missing, to: r.to, toName: r.toName, subject: r.subject });
    } catch (err) {
      throw userError(err);
    }
  });
  router.post('/api/ai/mail-ask/reply/send', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    const body = String(b.body ?? '').trim();
    if (!body) throw badRequest('אין מה לשלוח');
    try {
      // הנמען, הנושא והשרשור — מהמייל המקורי בתיבה, לא ממה שהגיע מהדפדפן.
      // התיבה — רק אחת מהתיבות של המשתמש עצמו (‎handle‎ בונה אותה מהמזהה שלו)
      const box = Number(b.box) || 0;
      const msg = await Gmail.raw(Gmail.handle(actor.id, box), String(b.gmailId ?? ''));
      const mail = Mime.parse(msg.raw);
      await MailInsights.sendReply(actor.id, {
        box,
        threadId: msg.threadId,
        to: mail.from.address,
        toName: mail.from.name || '',
        subject: /^(re|תשובה)\s*:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`,
        inReplyTo: mail.messageId,
        references: [...mail.references.slice(-9), mail.messageId].filter(Boolean),
        body
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      throw userError(err);
    }
  });

  // --- ✨ שאל — שאלה חופשית: משימות, מיילים, סוכנים וידע ארגוני ---

  router.post('/api/ai/ask', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    let context = '';
    if (b.taskId) {
      const task = getTaskOr404(Number(b.taskId));
      assertVisible(actor, task);
      context = `המשימה: ${task.title}${task.description ? `\n${task.description}` : ''}`;
    }
    // מסמכים שצורפו לשאלה (קבלה, נסח טאבו, מכתב מהעירייה) — לא נשמרים
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 3).map((a) => ({
      filename: String(a.filename ?? 'קובץ').slice(0, 200),
      mime: String(a.mime ?? 'application/octet-stream').slice(0, 100),
      data: Buffer.from(String(a.data ?? ''), 'base64')
    })).filter((a) => a.data.length && a.data.length <= 15 * 1024 * 1024);
    try {
      sendJson(res, 200, await Agents.ask(meUser(actor), actor, b.question, {
        history: Array.isArray(b.history) ? b.history.slice(-6) : [], attachments, context, channel: 'web'
      }));
    } catch (err) {
      throw userError(err);
    }
  });

  /** הסוכנים שמותרים לי — לתצוגה ("מה אפשר לשאול") */
  router.get('/api/ai/agents', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    sendJson(res, 200, { agents: Agents.allowedFor(actor).map(({ key, title, icon, short, deptLabel, deptIcon }) => ({ key, title, icon, short, deptLabel, deptIcon })) });
  });

  // --- 🎥 Timeless — אסימון אישי ---

  router.get('/api/me/timeless', async (req, res, ctx) => {
    sendJson(res, 200, Timeless.publicStatus(userOnly(ctx).id));
  });
  router.put('/api/me/timeless', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    const b = await readJson(req);
    if (!String(b.token ?? '').trim()) throw badRequest('נדרש אסימון');
    try {
      sendJson(res, 200, await Timeless.connect(actor.id, String(b.token).trim()));
    } catch (err) {
      throw userError(err);
    }
  });
  router.delete('/api/me/timeless', async (req, res, ctx) => {
    const actor = userOnly(ctx);
    Timeless.disconnect(actor.id);
    sendJson(res, 200, Timeless.publicStatus(actor.id));
  });

  // --- 🤖 סוכנים ו-📚 ידע ארגוני — מנהל המערכת ---

  const aiAdmin = (ctx) => {
    const actor = userOnly(ctx);
    if (!P.can(actor, 'manage_automations')) throw forbidden();
    return actor;
  };

  // 🧠 זיכרון העבודה של כל העובדים
  router.get('/api/admin/mail-memory', async (req, res, ctx) => {
    aiAdmin(ctx);
    sendJson(res, 200, { users: Memory.adminOverview(), auto: Memory.auto(), hours: D.getSetting('mail_memory_hours', ''), perDay: Number(D.getSetting('mail_memory_nightly_threads', 1500)) });
  });
  router.post('/api/admin/mail-memory/:userId/:action', async (req, res, ctx) => {
    aiAdmin(ctx);
    try {
      sendJson(res, 200, { user: Memory.adminAction(Number(ctx.params.userId), ctx.params.action) });
    } catch (err) {
      throw userError(err);
    }
  });

  router.get('/api/admin/agents', async (req, res, ctx) => {
    aiAdmin(ctx);
    let mcp = {};
    try { mcp = require('./ai/mcp-client').status(); } catch { mcp = {}; }
    sendJson(res, 200, { agents: Agents.catalog(), mcp, log: Agents.recentLog({ limit: 100 }), dailyLimit: Number(D.getSetting('agents_daily_limit', 40)) });
  });
  router.put('/api/admin/agents/:key', async (req, res, ctx) => {
    aiAdmin(ctx);
    const b = await readJson(req);
    try {
      Agents.setConfig(ctx.params.key, { enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, departments: typeof b.departments === 'string' ? b.departments : undefined });
    } catch (err) {
      throw userError(err);
    }
    sendJson(res, 200, { agents: Agents.catalog() });
  });

  router.get('/api/admin/knowledge', async (req, res, ctx) => {
    aiAdmin(ctx);
    const sp = parseUrl(req).searchParams;
    sendJson(res, 200, { ...OrgKnowledge.list({ q: sp.get('q') ?? '', dept: sp.get('dept') ?? '', week: sp.get('week') === '1' }), blocklist: D.getSetting('org_knowledge_blocklist', '') });
  });
  router.put('/api/admin/knowledge/blocklist', async (req, res, ctx) => {
    aiAdmin(ctx);
    const b = await readJson(req);
    D.setSetting('org_knowledge_blocklist', String(b.blocklist ?? '').slice(0, 5000));
    sendJson(res, 200, { blocklist: D.getSetting('org_knowledge_blocklist', '') });
  });
  router.post('/api/admin/knowledge/run', async (req, res, ctx) => {
    aiAdmin(ctx);
    if (!Claude.isEnabled()) throw badRequest('חיבור ה-AI אינו מוגדר בשרת');
    // רץ ברקע — זיקוק של כל העובדים יכול לקחת דקות
    OrgKnowledge.daily({ force: true }).catch((err) => console.error('[משימון] עדכון הידע הארגוני נכשל:', err.message));
    sendJson(res, 202, { started: true });
  });
  router.get('/api/admin/knowledge/:id/sources', async (req, res, ctx) => {
    aiAdmin(ctx);
    sendJson(res, 200, { sources: OrgKnowledge.sources(Number(ctx.params.id)) });
  });
  router.put('/api/admin/knowledge/:id', async (req, res, ctx) => {
    aiAdmin(ctx);
    const b = await readJson(req);
    try {
      sendJson(res, 200, { entry: OrgKnowledge.edit(Number(ctx.params.id), b) });
    } catch (err) {
      throw userError(err);
    }
  });
  router.delete('/api/admin/knowledge/:id', async (req, res, ctx) => {
    aiAdmin(ctx);
    OrgKnowledge.remove(Number(ctx.params.id));
    sendJson(res, 200, { ok: true });
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
      // אישור "לסגור?" / "לעדכן?" ממתין לקבצים מ-Gmail — לכן ‎await‎ תמיד
      const taskId = await fn(Number(ctx.params.id), actor, b);
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
  suggestionAction('restore', (id, actor) => MailScan.restore(id, actor));
  suggestionAction('ignore-sender', (id, actor) => MailScan.ignoreSenderOf(id, actor));
  suggestionAction('closure-dismiss', (id, actor) => MailScan.dismissClosure(id, actor));

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

  const botSettings = () => ({
    enabled: Boolean(D.getSetting('wa_bot_enabled', true)),
    quietMinutes: Number(D.getSetting('wa_quiet_minutes', 3)) || 0,
    summaryTime: String(D.getSetting('wa_summary_time', '08:00')),
    hours: String(D.getSetting('wa_hours', '') ?? ''),
    shabbat: Boolean(D.getSetting('wa_shabbat', true)),
    // השוואת ספקי התמלול: כולם רצים על כל הודעה קולית, והתוצאות ביומן
    speechCompare: Boolean(D.getSetting('speech_compare', false))
  });

  const botInfo = () => ({
    ...WaBot.publicStatus(),
    groups: WaBot.listGroups(),
    projects: D.all("SELECT id, name FROM projects WHERE status <> 'done' ORDER BY name"),
    users: D.all("SELECT id, full_name AS name, role, phone <> '' AS hasPhone FROM users WHERE status = 'active' AND role <> 'vendor' ORDER BY full_name"),
    usersWithoutPhone: D.all("SELECT full_name FROM users WHERE status = 'active' AND role <> 'vendor' AND phone = '' ORDER BY full_name").map((u) => u.full_name),
    actions: WaActions.list().map(({ key, icon, label, channel, description, enabled, audience, examples, defaultExamples }) =>
      ({ key, icon, label, channel, description, enabled, audience, examples, defaultExamples })),
    settings: botSettings(),
    sendingNow: WaBot.inHours(),
    today: WaBot.todayStats()
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

  router.put('/api/admin/wa-bot/actions', async (req, res, ctx) => {
    botAdmin(ctx);
    const b = await readJson(req);
    WaActions.save(b.actions);
    sendJson(res, 200, botInfo());
  });

  router.put('/api/admin/wa-bot/settings', async (req, res, ctx) => {
    botAdmin(ctx);
    const b = await readJson(req);
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (b.summaryTime !== undefined && !time.test(String(b.summaryTime))) throw badRequest('שעת הסיכום אינה תקינה (HH:MM)');
    const hours = String(b.hours ?? '').trim();
    if (hours && !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(hours)) throw badRequest('שעות הפעילות בפורמט 07:00-22:00, או ריק לכל היום');
    if (b.enabled !== undefined) D.setSetting('wa_bot_enabled', Boolean(b.enabled));
    if (b.quietMinutes !== undefined) D.setSetting('wa_quiet_minutes', Math.max(0, Math.min(60, Number(b.quietMinutes) || 0)));
    if (b.summaryTime !== undefined) D.setSetting('wa_summary_time', String(b.summaryTime));
    if (b.hours !== undefined) D.setSetting('wa_hours', hours);
    if (b.shabbat !== undefined) D.setSetting('wa_shabbat', Boolean(b.shabbat));
    if (b.speechCompare !== undefined) D.setSetting('speech_compare', Boolean(b.speechCompare));
    sendJson(res, 200, botInfo());
  });

  router.get('/api/admin/wa-bot/log', async (req, res, ctx) => {
    botAdmin(ctx);
    const q = new URL(req.url, 'http://x').searchParams;
    sendJson(res, 200, {
      entries: WaBot.readLog({
        channel: q.get('channel') ?? '', status: q.get('status') ?? '', userId: Number(q.get('userId')) || 0,
        chatId: q.get('chatId') ?? '', q: (q.get('q') ?? '').trim().slice(0, 100), before: Number(q.get('before')) || 0
      })
    });
  });

  // בדיקה בלי וואטסאפ: מה הבוט היה עונה ועושה. לא נשלח ולא מבוצע דבר
  router.post('/api/admin/wa-bot/simulate', async (req, res, ctx) => {
    const actor = botAdmin(ctx);
    const b = await readJson(req);
    try {
      sendJson(res, 200, b.chatId
        ? await WaBot.simulateGroup({ chatId: String(b.chatId), userId: b.userId, text: b.text })
        : await WaBot.simulate(actor, { userId: b.userId, text: b.text, reset: b.reset === true }));
    } catch (err) {
      throw userError(err);
    }
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
