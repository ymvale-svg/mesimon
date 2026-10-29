'use strict';
/**
 * משימת AI — המשתמש כותב במילים שלו מה צריך ממי, ה-AI מנסח מייל, ואחרי
 * אישור המייל יוצא בשמו ונפתח מעקב: תזכורות, וואטסאפ, והכרעה אם מה שחזר
 * הוא באמת מה שהתבקש.
 *
 * שלושה חלקים:
 *   openDialog   — פתיחת משימה: הוראה → טיוטה → אישור ושליחה
 *   panel        — הפאנל בכרטיס המשימה: מצב, טיוטות לאישור, ההתכתבות
 *   openWhatsApp — חיבור הוואטסאפ האישי (מ"החשבון שלי")
 *   talked       — "דיברתי איתו": עדכון ממה שקרה מחוץ להתכתבות
 */

const AiTaskView = (() => {
  const { el } = UI;

  const CHANNEL_ICON = { email: '📧', whatsapp: '💬', note: '📝', system: '🔔' };
  const KIND_LABEL = {
    initial: 'פנייה', reminder: 'תזכורת', reply: 'תשובה', thanks: 'תודה', inbound: 'תשובה התקבלה',
    manual: 'עדכון שלך', owner_contact: 'כתבת לנמען בעצמך', internal: 'הועבר במשימון'
  };
  const EVENT_LABEL = {
    ai_paused: '⏸ המעקב הושהה', ai_resumed: '▶ המעקב חודש', ai_stopped: '⏹ המעקב הופסק',
    ai_postponed: '⏭ נדנוד נדחה', ai_completed: '✅ סומן שהתקבל', ai_stalled: '⏸ המעקב נעצר',
    ai_updated: '✎ עודכנו פרטי המעקב', ai_nudge: '🔔 בוקשה תזכורת מיידית'
  };
  const VERDICT = {
    satisfied: ['התקבל', 'ok'],
    partial: ['התקבל חלקית', 'warn'],
    promised: ['הבטחה', 'info'],
    question: ['שאלה', 'warn'],
    declined: ['סירוב / הפניה', 'danger'],
    handled_elsewhere: ['סוכם מחוץ להתכתבות', 'info'],
    auto_reply: ['מענה אוטומטי', 'mute'],
    unrelated: ['לא קשור', 'mute']
  };


  // ------------------------------------------------------------- פתיחה

  async function openDialog(opts = {}) {
    let status;
    try {
      status = await API.get('/api/ai/status');
    } catch (err) {
      return UI.error(err);
    }

    if (!status.enabled) {
      UI.modal({
        title: '✨ משימת AI',
        body: el('div.alert.alert-warn', {}, [
          el('span', { text: '⚠️' }),
          el('div', {}, [
            el('b', { text: 'חיבור ה-AI עדיין לא הוגדר בשרת' }),
            el('div', { text: 'מנהל המערכת צריך להגדיר את המשתנה ANTHROPIC_API_KEY. אחרי זה האפשרות תיפתח כאן.' })
          ])
        ])
      });
      return;
    }

    const state = {
      step: 'compose',
      instruction: opts.instruction ?? '',
      contact: { name: '', email: '', phone: '', type: 'external', refId: null, ...(opts.contact ?? {}) },
      // נפתח מהצעה שהגיעה מהמייל — פרטי הנמען חולצו מתוכן שלא אנחנו כתבנו
      suggestionId: opts.suggestionId ?? null,
      fromEmail: Boolean(opts.suggestionId),
      // וואטסאפ קיים כאן רק למי שחיבר אותו; מי שלא — הכול במייל
      channel: status.mail || status.whatsapp?.state !== 'authorized' ? 'email' : 'whatsapp',
      projectId: opts.projectId ?? '',
      // מהקלטה — היעד שנאמר כבר מולא
      dueDate: opts.dueDate ?? '',
      policy: { ...status.defaults },
      draft: null
    };

    const body = el('div.ai-dialog');
    const m = UI.modal({ title: '✨ משימת AI חדשה', body, size: 'wide' });

    const draw = () => UI.mount(body, state.step === 'compose' ? composeStep() : previewStep());

    // --- שלב 1: מה צריך וממי

    function composeStep() {
      const instruction = el('textarea.ai-instruction', {
        placeholder: 'לדוגמה: לפנות לדני מהעירייה ולבקש את טופס 4 של פרויקט הגפן. צריך עד סוף החודש.'
      });
      instruction.value = state.instruction;

      /*
       * אנשי קשר — חיפוש על פני עובדים, ספקים, נמענים קודמים ואנשי הקשר של
       * Google (‎ContactPicker‎). בחירה ממלאת מייל וטלפון; שם שהוקלד חופשי
       * הוא נמען חיצוני חדש.
       */
      const emailInput = el('input', { type: 'email', value: state.contact.email, placeholder: 'name@example.com', dir: 'ltr' });
      const phoneInput = el('input', { type: 'tel', value: state.contact.phone, placeholder: '050-0000000', dir: 'ltr' });
      const colleagueNote = el('div');
      const extrasBox = el('div');
      const showColleague = () => UI.mount(colleagueNote, state.contact.type === 'user'
        ? el('div.alert.alert-info', {}, [
            el('span', { text: '👤' }),
            el('div', { text: 'זה עובד בארגון — לא יישלח אליו מייל מבחוץ. המשימה תיכנס אליו במשימון, והעוזר יזכיר לו בתוך המערכת עד שיסמן "בוצע".' })
          ])
        : null);
      const picker = ContactPicker.create({
        value: state.contact.name,
        onType: () => {
          state.contact.type = 'external';
          state.contact.refId = null;
          UI.mount(extrasBox);
          showColleague();
        },
        onPick: (c) => {
          state.contact.source = c.source;
          emailInput.value = c.email || '';
          phoneInput.value = c.phone || '';
          state.contact.type = c.type === 'user' ? 'user' : c.type === 'vendor' ? 'vendor' : 'external';
          state.contact.refId = c.refId ?? null;
          UI.mount(extrasBox,
            ContactPicker.variants(c, { onEmail: (v) => { emailInput.value = v; }, onPhone: (v) => { phoneInput.value = v; } }),
            c.unsaved
              ? el('div.cp-save-line', {}, [
                  el('span.mute-sm', { text: 'לא שמור באנשי הקשר שלך. ' }),
                  el('button.btn.btn-sm', {
                    type: 'button',
                    onclick: () => ContactPicker.saveDialog({ ...c, email: emailInput.value, phone: phoneInput.value }, { onSaved: () => UI.mount(extrasBox) })
                  }, ['⭐ שמור באנשי הקשר של Google'])
                ])
              : null);
          showColleague();
          fromPhonebook = c.source === 'phonebook';
          showPbSave();
        }
      });
      const nameInput = picker.input;
      showColleague();

      /*
       * נמען מבחוץ שאינו באלפון הארגוני — הצעה קטנה לשמור אותו שם, כדי
       * שהעמיתים ימצאו אותו בפעם הבאה. נבחר מהאלפון, או עובד — אין הצעה.
       */
      const pbBox = el('div');
      let fromPhonebook = state.contact.source === 'phonebook';
      const showPbSave = () => {
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();
        const show = !fromPhonebook && state.contact.type !== 'user' && name && (email || phone);
        UI.mount(pbBox, show
          ? el('div.cp-save-line', {}, [
              el('span.mute-sm', { text: 'לא באלפון הארגוני. ' }),
              el('button.btn.btn-sm', {
                type: 'button',
                onclick: () => PhonebookView.editDialog({ name, email, phone }, {
                  onSaved: (entry) => { if (entry) { fromPhonebook = true; showPbSave(); } }
                })
              }, ['📒 שמירה באלפון'])
            ])
          : null);
      };
      picker.input.addEventListener('input', () => { fromPhonebook = false; showPbSave(); });
      emailInput.addEventListener('change', showPbSave);
      phoneInput.addEventListener('change', showPbSave);
      showPbSave();

      /*
       * בחירת ערוץ רק למי שחיבר וואטסאפ. מי שלא חיבר אינו רואה כפתור אפור
       * של ערוץ שאינו קיים אצלו, וגם לא שדה טלפון — הפנייה יוצאת במייל.
       */
      const waReady = status.whatsapp?.state === 'authorized';
      const channelSeg = waReady
        ? el('div.seg', {}, [
            ['email', '📧 מייל', status.mail, 'מייל יוצא מתיבת ה-Gmail שלך — מחברים מ"החשבון שלי ← Gmail ועוזר ה-AI"'],
            ['whatsapp', '💬 וואטסאפ', true, '']
          ].map(([key, label, ok, why]) => el(`button${state.channel === key ? '.active' : ''}`, {
            type: 'button', disabled: !ok, title: ok ? '' : why,
            onclick: () => { read(); state.channel = key; draw(); }
          }, [label])))
        : null;

      const projectSelect = UI.select([{ value: '', label: 'ללא פרויקט' },
        ...App.state.projects.filter((p) => p.mine || String(p.id) === String(state.projectId))
          .map((p) => ({ value: p.id, label: p.name }))], state.projectId);
      const dueInput = el('input', { type: 'date', value: state.dueDate });

      const policyBox = policyEditor(state.policy, { waReady });

      function read() {
        state.instruction = instruction.value.trim();
        state.contact.name = nameInput.value.trim();
        state.contact.email = emailInput.value.trim();
        state.contact.phone = phoneInput.value.trim();
        state.projectId = projectSelect.value;
        state.dueDate = dueInput.value;
        Object.assign(state.policy, policyBox.read());
      }

      const go = el('button.btn.btn-primary', {}, ['✨ נסח לי את הפנייה']);
      go.addEventListener('click', async () => {
        read();
        if (!state.instruction) return UI.toast('כתבו מה המשימה', 'error');
        go.disabled = true;
        go.textContent = 'ה-AI כותב…';
        try {
          await makeDraft();
          state.step = 'preview';
          draw();
        } catch (err) {
          go.disabled = false;
          go.textContent = '✨ נסח לי את הפנייה';
          UI.error(err);
        }
      });

      return el('div', {}, [
        UI.field('מה המשימה?', instruction,
          'כתבו בחופשיות: למי לפנות, מה לבקש, ואם יש — עד מתי ולמה. ה-AI ינסח, ואתם תאשרו לפני שליחה.'),
        el('div.ai-section-title', { text: 'הנמען' }),
        state.fromEmail
          ? el('div.alert.alert-warn', {}, [el('span', { text: '📧' }), el('div', { text: 'פרטי הנמען חולצו מתוך המייל שהתקבל. בדקו שהם נכונים — הפנייה תצא אליהם בשמך.' })])
          : null,
        el('div.row', {}, [
          UI.field('שם', picker.node),
          UI.field('מייל', emailInput),
          waReady ? UI.field('טלפון', phoneInput) : null
        ]),
        extrasBox,
        pbBox,
        colleagueNote,
        el('div.row', {}, [
          channelSeg ? UI.field('ערוץ ראשון', channelSeg) : null,
          UI.field('פרויקט', projectSelect),
          UI.field('תאריך יעד', dueInput)
        ]),
        policyBox.node,
        // מייל יוצא רק מהתיבה האישית — מי שלא חיבר אותה רואה כאן איך לחבר
        !status.mail && state.contact.type !== 'user'
          ? el('div.alert.alert-warn', {}, [
              el('span', { text: '📭' }),
              el('div', {}, [
                status.gmail?.state === 'ok' && !status.gmail.canSend
                  ? 'תיבת ה-Gmail שלך מחוברת לקריאה בלבד. כדי לשלוח ממנה צריך לחבר אותה מחדש ולאשר גם שליחה. '
                  : 'כדי שהעוזר ישלח מייל בשמך, צריך לחבר את תיבת ה-Gmail שלך — המייל ייצא ממנה וישאר אצלך ב"דואר יוצא". ',
                status.gmailEnabled ? el('a', { href: '/api/me/gmail/connect' }, ['לחיבור Gmail']) : 'חיבור Google עדיין לא הוגדר בשרת.'
              ])
            ])
          : null,
        el('div.ai-foot', {}, [go, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])])
      ]);
    }

    async function makeDraft(feedback = '') {
      const { draft, signature } = await API.post('/api/ai/draft', {
        instruction: state.instruction,
        contact: state.contact,
        channel: state.channel,
        projectId: state.projectId || null,
        dueDate: state.dueDate || null,
        feedback,
        previous: feedback ? state.draft : null
      });
      // ה-AI חילץ פרטי נמען מההוראה — ממלאים רק מה שהמשתמש השאיר ריק
      if (!state.contact.name && draft.contact_name) state.contact.name = draft.contact_name;
      if (!state.contact.email && draft.contact_email) state.contact.email = draft.contact_email;
      if (!state.contact.phone && draft.contact_phone) state.contact.phone = draft.contact_phone;
      // תיקון טיוטה אינו דורס כותרת שהמשתמש כבר ערך
      state.draft = feedback && state.draft ? { ...draft, title: state.draft.title } : draft;
      state.signature = signature ?? null;
    }

    /**
     * החתימה מ-Gmail, כפי שתצורף — לקריאה בלבד: עורכים אותה רק ב-Gmail.
     * ב-iframe בלי הרשאת סקריפטים — HTML שמגיע מבחוץ (תמונות וקישורים בלבד).
     */
    function signaturePreview(html) {
      const frame = el('iframe.ai-signature', { sandbox: 'allow-same-origin', title: 'החתימה מ-Gmail' });
      frame.srcdoc = `<!DOCTYPE html><html dir="auto"><body style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#374151">${html}</body></html>`;
      frame.addEventListener('load', () => {
        try { frame.style.height = `${Math.min(220, frame.contentDocument.body.scrollHeight + 8)}px`; } catch { /* נשאר בגובה ברירת המחדל */ }
      });
      return el('div.ai-signature-box', {}, [
        el('div.mute-sm', { text: '✍️ החתימה שלך מ-Gmail תצורף בסוף המייל (משנים אותה ב-Gmail ← הגדרות ← חתימה)' }),
        frame
      ]);
    }

    // --- שלב 2: הטיוטה לאישור

    function previewStep() {
      const d = state.draft;
      const internal = state.contact.type === 'user' && state.contact.refId;
      const isEmail = state.channel === 'email' && !internal;
      const titleInput = el('input', { type: 'text', value: d.title });
      const toEmail = el('input', { type: 'email', value: state.contact.email, dir: 'ltr' });
      const toPhone = el('input', { type: 'tel', value: state.contact.phone, dir: 'ltr' });
      const toName = el('input', { type: 'text', value: state.contact.name });
      const subject = el('input', { type: 'text', value: d.subject });
      const text = el('textarea.ai-body', {});
      text.value = d.body;
      const criteria = el('input', { type: 'text', value: d.success_criteria });

      const read = () => {
        d.title = titleInput.value.trim();
        d.subject = subject.value.trim();
        d.body = text.value;
        d.success_criteria = criteria.value.trim();
        state.contact.name = toName.value.trim();
        state.contact.email = toEmail.value.trim();
        state.contact.phone = toPhone.value.trim();
      };

      const feedback = el('input', { type: 'text', placeholder: 'מה לשנות? למשל: "יותר רשמי", "להוסיף שזה דחוף", "באנגלית"' });
      const redo = el('button.btn', {}, ['✨ תקן']);
      const doRedo = async () => {
        if (!feedback.value.trim()) return feedback.focus();
        read();
        redo.disabled = true;
        redo.textContent = 'כותב…';
        try {
          await makeDraft(feedback.value.trim());
          draw();
        } catch (err) {
          redo.disabled = false;
          redo.textContent = '✨ תקן';
          UI.error(err);
        }
      };
      redo.addEventListener('click', doRedo);
      feedback.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRedo(); });

      const send = el('button.btn.btn-primary', {}, [internal ? `👤 העברה ל${state.contact.name || 'עובד'}` : isEmail ? '📧 אישור ושליחה' : '💬 אישור ושליחה']);
      send.addEventListener('click', async () => {
        read();
        send.disabled = true;
        try {
          const res = await API.post('/api/ai/tasks', {
            instruction: state.instruction,
            draft: d,
            contact: state.contact,
            channel: state.channel,
            projectId: state.projectId || null,
            dueDate: UI.fromInputDate(state.dueDate),
            policy: state.policy,
            suggestionId: state.suggestionId
          });
          m.close();
          if (res.sendError) UI.toast(`המשימה נוצרה, אבל השליחה נכשלה: ${res.sendError}`, 'error');
          else UI.success(internal ? 'המשימה הועברה — העוזר יזכיר עד שתסומן כבוצעה' : isEmail ? 'המייל נשלח — ה-AI עוקב מכאן' : 'ההודעה נשלחה — ה-AI עוקב מכאן');
          opts.onCreated?.(res.task);
          await App.reloadReference();
          await App.refreshView();
          App.refreshNotifications();
          TaskCardView.open(res.task.id);
        } catch (err) {
          send.disabled = false;
          UI.error(err);
        }
      });

      return el('div', {}, [
        d.notes ? el('div.alert.alert-info', {}, [el('span', { text: '💡' }), el('div', { text: d.notes })]) : null,
        // מההתכתבות האחרונה עם הנמען: מה כדאי להוסיף. לחיצה — ה-AI מוסיף למייל
        d.suggestions?.length && !internal
          ? el('div.alert.alert-info', {}, [
              el('span', { text: '📨' }),
              el('div', {}, [
                el('div', { text: 'מההתכתבות האחרונה איתו — אולי להוסיף:' }),
                el('div.flex', { style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px' } }, d.suggestions.map((x) =>
                  el('button.btn.btn-sm', { onclick: () => { feedback.value = `הוסף למייל: ${x}`; doRedo(); } }, [`＋ ${x}`])))
              ])
            ])
          : null,
        UI.field('שם המשימה במערכת', titleInput),
        el('div.ai-letter', {}, [
          el('div.row', {}, [
            UI.field('אל', toName),
            internal ? null : isEmail ? UI.field('מייל', toEmail) : UI.field('טלפון', toPhone)
          ]),
          isEmail ? UI.field('נושא', subject) : null,
          UI.field(internal ? 'הבקשה (תופיע בתיאור המשימה)' : isEmail ? 'המייל' : 'ההודעה', text,
            internal ? 'המשימה תשויך אליו במשימון, עם התראה רגילה על משימה חדשה.'
              : isEmail ? 'יישלח מתיבת ה-Gmail שלך ויישאר אצלך ב"דואר יוצא". התשובה תחזור אליך ותיקלט אוטומטית.' : 'יישלח מהוואטסאפ שלך.')
        ]),
        isEmail && state.signature ? signaturePreview(state.signature) : null,
        el('div.ai-revise', {}, [feedback, redo]),
        UI.field('מתי זה נחשב שהתקבל?', criteria, 'לפי זה ה-AI יכריע אם התשובה שחזרה מספיקה וסוגר את המשימה'),
        el('div.ai-foot', {}, [
          send,
          el('div.spacer'),
          el('button.btn', { onclick: () => { read(); state.step = 'compose'; draw(); } }, ['→ חזרה'])
        ])
      ]);
    }

    draw();
  }

  /** עורך מדיניות המעקב — מקופל כברירת מחדל, כי ברירות המחדל מתאימות לרוב */
  function policyEditor(policy, { waReady = true } = {}) {
    const num = (value, min, max) => el('input', { type: 'number', min, max, value, style: { width: '72px' } });
    const emailAttempts = num(policy.emailAttempts, 0, 10);
    const daysEmail = num(policy.daysBetweenEmails, 1, 30);
    const wa = el('input', { type: 'checkbox', checked: policy.whatsapp });
    const waAttempts = num(policy.whatsappAttempts, 0, 10);
    const daysWa = num(policy.daysBetweenWhatsapp, 1, 30);
    const approveAll = el('input', { type: 'checkbox', checked: Boolean(policy.approveReminders) });

    // בלי וואטסאפ מחובר — אין מעקב בוואטסאפ, ושורותיו אינן מוצגות
    if (!waReady) wa.checked = false;

    const summary = () => `עד ${emailAttempts.value} מיילים כל ${daysEmail.value} ימים${wa.checked ? `, ואז עד ${waAttempts.value} הודעות וואטסאפ כל ${daysWa.value} ימים` : ''}${approveAll.checked ? ' · כל תזכורת באישור' : ' · תזכורות יוצאות לבד'}`;
    const sumNode = el('span', { text: summary() });
    for (const i of [emailAttempts, daysEmail, wa, waAttempts, daysWa, approveAll]) i.addEventListener('input', () => { sumNode.textContent = summary(); });

    const node = el('details.ai-policy', {}, [
      el('summary', {}, ['🔁 מדיניות מעקב: ', sumNode]),
      el('div.ai-policy-grid', {}, [
        el('label', {}, [waReady ? 'מיילים שלא נענו לפני מעבר לוואטסאפ ' : 'מיילים שלא נענו לפני עצירה ', emailAttempts]),
        el('label', {}, ['ימי עבודה בין מיילים ', daysEmail]),
        waReady ? el('label.checkbox', {}, [wa, ' להמשיך בוואטסאפ מהמספר שלי']) : null,
        waReady ? el('label', {}, ['הודעות וואטסאפ שלא נענו לפני עצירה ', waAttempts]) : null,
        waReady ? el('label', {}, ['ימי עבודה בין הודעות וואטסאפ ', daysWa]) : null,
        el('label.checkbox', {}, [approveAll, ' כל תזכורת מחכה לאישור שלי (במקום לצאת לבד)'])
      ]),
      !waReady ? el('div.mute-sm', { text: 'רוצים גם מעקב בוואטסאפ? מחברים מ"החשבון שלי".' }) : null,
      el('div.mute-sm', { text: 'שליחה רק בשעות העבודה ובימים א׳–ה׳. כל תשובה של הנמען מאפסת את הספירה. בכל בוקר מופיע "היום יוצאים", ואפשר לעצור או לדחות כל נדנוד לפני שיוצא.' })
    ]);

    return {
      node,
      read: () => ({
        emailAttempts: Number(emailAttempts.value),
        daysBetweenEmails: Number(daysEmail.value),
        whatsapp: wa.checked,
        whatsappAttempts: Number(waAttempts.value),
        daysBetweenWhatsapp: Number(daysWa.value),
        approveReminders: approveAll.checked
      })
    };
  }

  // ------------------------------------------------------------- פאנל בכרטיס

  /**
   * @param {object} task     המשימה כפי שהשרת שלח, עם ‎aiDetail‎
   * @param {(task) => void} onChange  נקרא עם המשימה המעודכנת אחרי כל פעולה
   */
  function panel(task, onChange) {
    const a = task.aiDetail;
    if (!a) return null;

    const act = async (button, fn) => {
      if (button) button.disabled = true;
      try {
        const res = await fn();
        if (res?.task) onChange(res.task);
      } catch (err) {
        if (button) button.disabled = false;
        UI.error(err);
      }
    };
    const base = `/api/ai/tasks/${task.id}`;
    const action = (name, label, cls = '') => {
      const b = el(`button.btn.btn-sm${cls}`, {}, [label]);
      b.addEventListener('click', () => act(b, () => API.post(`${base}/action`, { action: name })));
      return b;
    };

    const open = ['waiting', 'needs_user', 'paused', 'stalled'].includes(a.state);
    const contactLine = a.internal
      ? `👤 ${a.contact.name} (עובד/ת בארגון)`
      : [a.contact.name, a.contact.email, a.contact.phone].filter(Boolean).join(' · ');
    const progress = a.internal
      ? `🔔 ${a.unansweredEmail} תזכורות במערכת`
      : [
          a.policy.emailAttempts ? `📧 ${a.unansweredEmail}/${a.policy.emailAttempts}` : null,
          a.policy.whatsapp && a.policy.whatsappAttempts ? `💬 ${a.unansweredWhatsapp}/${a.policy.whatsappAttempts}` : null
        ].filter(Boolean).join(' · ');

    const head = el('div.ai-head', {}, [
      el('span.ai-badge', { text: '✨ AI' }),
      el(`span.ai-state.ai-state-${a.state}`, { text: a.stateLabel }),
      el('span.ai-contact', { text: contactLine }),
      el('div.spacer'),
      open && progress ? el('span.mute-sm', { title: 'ניסיונות שלא נענו מתוך המדיניות', text: progress }) : null
    ]);

    const lines = [];
    if (a.state === 'waiting' && a.nextActionAt) {
      lines.push(el('div.mute-sm', { text: `הצעד הבא: ${UI.formatDateTime(a.nextActionAt)}` }));
    }
    if (a.lastSummary) {
      lines.push(el('div.ai-summary', {}, [el('b', { text: 'מה ענו: ' }), a.lastSummary]));
    }
    if (a.error) {
      lines.push(el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: a.error })]));
    }
    // נמען מבחוץ שאינו באנשי הקשר של Google — הצעה לשמור אותו, פעם אחת
    if (!a.internal && (a.contact.email || a.contact.phone)) lines.push(ContactPicker.suggestion(a.contact));
    if (!a.channels.inbox && a.contact.email) {
      lines.push(el('div.mute-sm', { text: 'תיבת ה-Gmail של מי שפתח את הבקשה אינה מחוברת, ולכן תשובות במייל אינן נקלטות ותזכורות במייל לא יוצאות. כשתגיע תשובה — סמנו כאן שהתקבל.' }));
    }

    // המעקב נעצר כי ייתכן שסוכם משהו מחוץ להתכתבות — "דיברתי איתו" הוא התשובה
    if (a.attention === 'contact_detected' || a.attention === 'handled_elsewhere') {
      const b = el('button.btn.btn-primary.btn-sm', { onclick: () => talked(task, onChange) }, ['📞 עדכון: מה המצב?']);
      lines.push(el('div.ai-question', {}, [
        el('div', {}, [
          el('b', { text: a.attention === 'contact_detected' ? '👀 ' : '📞 ' }),
          a.attention === 'contact_detected'
            ? (a.ownerQuestion || 'זוהתה התכתבות שלך עם הנמען. מה המצב?')
            : `${a.contact.name || 'הנמען'} כתב/ה שהעניין סוכם מחוץ להתכתבות. התזכורות נעצרו — מה המצב?`
        ]),
        el('div', {}, [b])
      ]));
    }

    // שאלה פתוחה של ה-AI
    if (a.ownerQuestion && a.attention !== 'contact_detected') {
      const answer = el('textarea', { placeholder: 'התשובה שלך — ה-AI ינסח ממנה תשובה לנמען, לאישורך' });
      const send = el('button.btn.btn-primary.btn-sm', {}, ['✨ נסח תשובה']);
      send.addEventListener('click', () => {
        if (!answer.value.trim()) return answer.focus();
        act(send, () => API.post(`${base}/answer`, { answer: answer.value.trim() }));
      });
      lines.push(el('div.ai-question', {}, [
        el('div', {}, [el('b', { text: '❓ ה-AI צריך אותך: ' }), a.ownerQuestion]),
        answer,
        el('div', {}, [send])
      ]));
    }

    // טיוטות שממתינות לאישור (וגם שליחה שנכשלה — אפשר לנסות שוב)
    const pending = a.messages.filter((x) => x.status === 'pending_approval' || (x.status === 'failed' && x.direction === 'out'));
    const drafts = pending.map((msg) => {
      // רק בפנייה הראשונה יש נושא לערוך: כל ההמשך נשלח בנושא של השרשור
      const subject = msg.channel === 'email' && msg.kind === 'initial' ? el('input', { type: 'text', value: msg.subject }) : null;
      const text = el('textarea.ai-body', {});
      text.value = msg.body;
      const approve = el('button.btn.btn-primary.btn-sm', {}, [`${CHANNEL_ICON[msg.channel]} אישור ושליחה`]);
      approve.addEventListener('click', () => act(approve, () =>
        API.post(`${base}/messages/${msg.id}/approve`, { subject: subject?.value, body: text.value })));
      const fix = el('button.btn.btn-sm', {}, ['✨ תקן']);
      fix.addEventListener('click', async () => {
        const feedback = await UI.prompt('מה לשנות בטיוטה?', { title: 'תיקון עם AI' });
        if (feedback) act(fix, () => API.post(`${base}/messages/${msg.id}/revise`, { feedback }));
      });
      const drop = el('button.btn.btn-ghost.btn-sm', {}, ['מחיקה']);
      drop.addEventListener('click', () => act(drop, () => API.post(`${base}/messages/${msg.id}/discard`)));
      return el('div.ai-draft', {}, [
        el('div.ai-draft-head', {}, [
          el('b', { text: msg.status === 'failed' ? '⚠️ השליחה נכשלה' : `טיוטה ל${KIND_LABEL[msg.kind] ?? 'הודעה'} — ממתינה לאישורך` }),
          msg.error ? el('span.mute-sm', { text: ` · ${msg.error}` }) : null
        ]),
        subject,
        text,
        el('div.flex', { style: { gap: '6px' } }, [approve, fix, el('div.spacer'), drop])
      ]);
    });

    // ההתכתבות, ולצדה העדכונים שלך והאירועים במעקב — ציר זמן אחד, מהישן לחדש
    const items = [
      ...a.messages.filter((x) => x.status === 'sent' || x.status === 'received').map((m) => ({ at: m.sentAt ?? m.createdAt, msg: m })),
      ...(a.events ?? []).map((e) => ({ at: e.at, event: e }))
    ].sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const timeline = items.map(({ msg, event }) => {
      if (event) {
        return el('div.ai-event', {}, [
          el('span', { text: EVENT_LABEL[event.action] ?? event.action }),
          event.details ? el('span.mute-sm', { text: ` · ${event.details}` }) : null,
          el('span.mute-sm', { text: ` · ${event.actor} · ${UI.formatDateTime(event.at)}` })
        ]);
      }
      if (msg.channel === 'note') {
        return el('div.ai-msg.ai-msg-note', {}, [
          el('div.ai-msg-meta', {}, [
            `${CHANNEL_ICON.note} ${KIND_LABEL[msg.kind] ?? 'עדכון'}`,
            el('span.mute-sm', { text: ` · ${UI.formatDateTime(msg.sentAt ?? msg.createdAt)}` })
          ]),
          el('div.ai-msg-body', { text: msg.body })
        ]);
      }
      const verdict = msg.verdict ? VERDICT[msg.verdict] : null;
      return el(`div.ai-msg.ai-msg-${msg.direction}`, {}, [
        el('div.ai-msg-meta', {}, [
          `${CHANNEL_ICON[msg.channel]} ${msg.direction === 'in' ? (a.contact.name || 'הנמען') : (KIND_LABEL[msg.kind] ?? '')}`,
          el('span.mute-sm', { text: ` · ${UI.formatDateTime(msg.sentAt ?? msg.createdAt)}` }),
          verdict ? el(`span.ai-verdict.ai-verdict-${verdict[1]}`, { text: verdict[0] }) : null
        ]),
        msg.subject ? el('div.ai-msg-subject', { text: msg.subject }) : null,
        el('div.ai-msg-body', { text: msg.body || '(ללא טקסט)' }),
        msg.attachments.length
          ? el('div.ai-msg-files', {}, msg.attachments.map((f) =>
              // ‎bdi‎ — שם קובץ עברי עם סיומת לטינית מתהפך בלעדיו ("pdf.2 טופס")
              el('a', { href: `/api/attachments/${f.id}/download`, target: '_blank', rel: 'noopener' }, ['📎 ', el('bdi', { text: f.filename })])))
          : null,
        msg.analysis?.summary && msg.direction === 'in'
          ? el('div.ai-msg-analysis', {}, ['✨ ', msg.analysis.summary, msg.analysis.missing ? ` · חסר: ${msg.analysis.missing}` : ''])
          : null
      ]);
    });

    const actions = el('div.ai-actions', {}, [
      open ? el('button.btn.btn-sm', { title: 'סוכם משהו בטלפון, בפגישה או בהודעה אחרת', onclick: () => talked(task, onChange) }, ['📞 דיברתי איתו']) : null,
      a.state === 'waiting' ? action('nudge', '🔔 תזכורת עכשיו') : null,
      a.state === 'waiting' && a.nextActionAt ? postponeButton(task, onChange) : null,
      a.state === 'waiting' || a.state === 'needs_user' ? action('pause', '⏸ השהיה') : null,
      a.state === 'paused' || a.state === 'stalled' ? action('resume', a.state === 'stalled' ? '🔁 סבב מעקב נוסף' : '▶ חידוש') : null,
      open ? action('complete', '✅ התקבל') : null,
      open ? el('button.btn.btn-sm', { onclick: () => editDetails(task, a, onChange) }, ['✎ פרטים ומדיניות']) : null,
      el('div.spacer'),
      open ? action('stop', 'עצירת המעקב', '.btn-ghost') : null
    ]);

    return el('div.ai-panel', {}, [
      head,
      ...lines,
      ...drafts,
      timeline.length ? el('div.ai-timeline', {}, timeline) : null,
      actions,
      el('details.ai-origin', {}, [
        el('summary', { text: 'ההוראה המקורית' }),
        el('div', { text: a.instruction }),
        a.successCriteria ? el('div.mute-sm', { text: `נחשב שהתקבל כאשר: ${a.successCriteria}` }) : null
      ])
    ]);
  }

  /** "דחה" — הנדנוד הבא זז בכמה ימי עבודה, והספירה אינה משתנה */
  function postponeButton(task, onChange) {
    const b = el('button.btn.btn-sm', {}, ['⏭ דחייה']);
    b.addEventListener('click', async () => {
      const days = await UI.prompt('בכמה ימי עבודה לדחות את הנדנוד הבא?', { title: 'דחיית נדנוד', value: '1' });
      if (!days) return;
      b.disabled = true;
      try {
        const res = await API.post(`/api/ai/tasks/${task.id}/action`, { action: 'postpone', days: Number(days) || 1 });
        onChange?.(res.task);
      } catch (err) {
        b.disabled = false;
        UI.error(err);
      }
    });
    return b;
  }

  const NOTE_ACTIONS = [
    ['complete', '✅ התקבל / לא צריך יותר — לסגור'],
    ['reschedule', '📅 סוכם מועד — להמתין עד אליו'],
    ['update_request', '✎ הבקשה השתנתה'],
    ['pause', '⏸ להשהות בלי מועד'],
    ['continue', '🔁 להמשיך במעקב כרגיל'],
    ['stop', '⏹ לעצור את המעקב']
  ];

  /**
   * "דיברתי איתו" — המשתמש כותב שורה חופשית על מה שקרה מחוץ להתכתבות,
   * העוזר מציע מה זה אומר למעקב, והמשתמש מאשר או בוחר אחרת. דבר אינו
   * מתבצע לפני האישור.
   *
   * @param {{id:number, title?:string}} task
   */
  function talked(task, onChange) {
    const base = `/api/ai/tasks/${task.id}`;
    const note = el('textarea', { placeholder: 'לדוגמה: "דיברתי איתו, ישלח ביום ראשון" · "סיכמנו טופס 2 במקום 4" · "לא צריך יותר"' });
    const proposalBox = el('div');
    const actionSel = UI.select(NOTE_ACTIONS.map(([value, label]) => ({ value, label })), 'continue');
    const date = el('input', { type: 'date' });
    const goal = el('input', { type: 'text', placeholder: 'מה מבקשים עכשיו' });
    const criteria = el('input', { type: 'text', placeholder: 'מתי זה נחשב שהתקבל' });
    const extra = el('div');
    const drawExtra = () => UI.mount(extra,
      actionSel.value === 'reschedule' ? UI.field('המועד שסוכם', date, 'המעקב ימתין, ויחזור למחרת המועד אם לא יגיע')
        : actionSel.value === 'update_request' ? el('div', {}, [UI.field('הבקשה המעודכנת', goal), UI.field('נחשב שהתקבל כאשר', criteria)])
          : null);
    actionSel.addEventListener('change', drawExtra);

    const understand = el('button.btn', {}, ['✨ מה זה אומר?']);
    const save = el('button.btn.btn-primary', {}, ['שמירה']);
    understand.addEventListener('click', async () => {
      if (!note.value.trim()) return note.focus();
      understand.disabled = true;
      understand.textContent = 'קורא…';
      try {
        const { proposal } = await API.post(`${base}/note/interpret`, { note: note.value.trim() });
        actionSel.value = proposal.action;
        if (proposal.date) date.value = proposal.date;
        if (proposal.goal) goal.value = proposal.goal;
        if (proposal.success_criteria) criteria.value = proposal.success_criteria;
        drawExtra();
        UI.mount(proposalBox, el('div.alert.alert-info', {}, [el('span', { text: '✨' }), el('div', { text: proposal.explanation })]));
      } catch (err) {
        UI.error(err);
      }
      understand.disabled = false;
      understand.textContent = '✨ מה זה אומר?';
    });
    save.addEventListener('click', async () => {
      if (actionSel.value === 'reschedule' && !date.value) return date.focus();
      save.disabled = true;
      try {
        const res = await API.post(`${base}/note`, {
          note: note.value.trim(), action: actionSel.value, date: date.value,
          goal: goal.value.trim(), successCriteria: criteria.value.trim()
        });
        m.close();
        UI.success('עודכן — העוזר ימשיך מכאן לפי מה שסוכם');
        onChange?.(res.task);
      } catch (err) {
        save.disabled = false;
        UI.error(err);
      }
    });

    drawExtra();
    const m = UI.modal({
      title: '📞 דיברתי איתו',
      body: el('div', {}, [
        task.title ? el('div.mute-sm', { text: task.title, style: { marginBottom: '8px' } }) : null,
        UI.field('מה קרה?', note, 'נשמר בהתכתבות של המשימה, והתזכורות הבאות ייכתבו לפיו'),
        el('div', { style: { marginBottom: '10px' } }, [understand]),
        proposalBox,
        UI.field('מה עכשיו?', actionSel),
        extra
      ]),
      footer: [save, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    setTimeout(() => note.focus(), 50);
  }

  function editDetails(task, a, onChange) {
    const email = el('input', { type: 'email', value: a.contact.email, dir: 'ltr' });
    const phone = el('input', { type: 'tel', value: a.contact.phone, dir: 'ltr' });
    const picker = ContactPicker.create({
      value: a.contact.name,
      onPick: (c) => { email.value = c.email || email.value; phone.value = c.phone || phone.value; }
    });
    const name = picker.input;
    const waReady = Boolean(a.channels?.waConnected);
    const policy = policyEditor(a.policy, { waReady });
    policy.node.open = true;
    const save = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: 'פרטי המעקב',
      body: el('div', {}, [
        el('div.row', {}, [UI.field('שם', picker.node), UI.field('מייל', email), waReady ? UI.field('טלפון', phone) : null]),
        policy.node
      ]),
      footer: [save, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const res = await API.patch(`/api/ai/tasks/${task.id}`, {
          contact: { name: name.value, email: email.value, phone: phone.value },
          policy: policy.read()
        });
        m.close();
        onChange(res.task);
      } catch (err) {
        save.disabled = false;
        UI.error(err);
      }
    });
  }

  // ------------------------------------------------------------- וואטסאפ

  async function openWhatsApp() {
    let channel = null;
    try {
      channel = (await API.get('/api/me/whatsapp')).channel;
    } catch (err) {
      return UI.error(err);
    }

    const STATES = {
      authorized: ['מחובר ✅', 'ok'],
      notAuthorized: ['ממתין לסריקת QR', 'warn'],
      starting: ['מתחבר…', 'warn'],
      blocked: ['חסום', 'danger'],
      error: ['שגיאת חיבור', 'danger'],
      unknown: ['לא נבדק', 'warn']
    };

    const apiUrl = el('input', { type: 'url', dir: 'ltr', value: channel?.apiUrl ?? 'https://api.green-api.com' });
    const instanceId = el('input', { type: 'text', dir: 'ltr', value: channel?.instanceId ?? '', placeholder: '1101000001' });
    const token = el('input', { type: 'password', dir: 'ltr', placeholder: channel?.hasToken ? '•••••••• (שמור — להשאיר ריק)' : 'apiTokenInstance' });
    const phone = el('input', { type: 'tel', dir: 'ltr', value: channel?.phone ?? '', placeholder: '050-0000000' });
    const stateBox = el('div');

    const showState = (state, error) => {
      const [label, kind] = STATES[state] ?? [state, 'warn'];
      UI.mount(stateBox, el(`div.alert.alert-${kind === 'ok' ? 'ok' : kind === 'danger' ? 'danger' : 'warn'}`, {}, [
        el('span', { text: '💬' }),
        el('div', {}, [el('b', { text: `מצב: ${label}` }), error ? el('div', { text: error }) : null,
          state === 'notAuthorized' ? el('div', { text: 'יש לסרוק את קוד ה-QR בלוח הבקרה של Green API: וואטסאפ בטלפון ← מכשירים מקושרים ← קישור מכשיר.' }) : null])
      ]));
    };
    if (channel) showState(channel.state);

    const save = el('button.btn.btn-primary', {}, ['שמירה ובדיקה']);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const res = await API.put('/api/me/whatsapp', {
          apiUrl: apiUrl.value.trim(), instanceId: instanceId.value.trim(), apiToken: token.value.trim(), phone: phone.value.trim()
        });
        token.value = '';
        showState(res.state, res.error);
        if (res.state === 'authorized') UI.success('הוואטסאפ מחובר');
      } catch (err) {
        UI.error(err);
      }
      save.disabled = false;
    });
    const remove = channel ? el('button.btn.btn-ghost', {}, ['ניתוק']) : null;
    remove?.addEventListener('click', async () => {
      if (!await UI.confirm('לנתק את הוואטסאפ מהמערכת? משימות AI לא ימשיכו בוואטסאפ.', { danger: true, okText: 'ניתוק' })) return;
      await API.del('/api/me/whatsapp');
      m.close();
      UI.success('הוואטסאפ נותק');
    });

    const m = UI.modal({
      title: '💬 חיבור הוואטסאפ שלי',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 } }, [
          'משימות AI יכולות להמשיך מעקב בוואטסאפ — ',
          el('b', { text: 'מהמספר שלך' }),
          ', כך שהנמען רואה הודעה ממך. החיבור עובד כמו וואטסאפ ווב ("מכשיר מקושר"), וההתכתבות נשארת גלויה בטלפון שלך.'
        ]),
        el('ol.ai-steps', {}, [
          el('li', {}, ['נרשמים ב-', el('a', { href: 'https://green-api.com', target: '_blank', rel: 'noopener' }, ['green-api.com']), ' ויוצרים Instance.']),
          el('li', { text: 'בלוח הבקרה שלהם סורקים את ה-QR מהטלפון: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר.' }),
          el('li', { text: 'מעתיקים לכאן את apiUrl, idInstance ו-apiTokenInstance.' })
        ]),
        stateBox,
        UI.field('apiUrl', apiUrl),
        el('div.row', {}, [UI.field('idInstance', instanceId), UI.field('apiTokenInstance', token)]),
        UI.field('המספר שלי', phone, 'לתצוגה בלבד — ההודעות יוצאות מהמספר שמקושר ב-Green API'),
        channel ? scanBox() : null
      ]),
      footer: [save, el('div.spacer'), remove]
    });

    /**
     * "להציע משימות ופגישות מהוואטסאפ שלי" — שיחות פרטיות בלבד (קבוצות נסרקות
     * דרך הבוט הארגוני). מספרים שלא לסרוק — אחד בשורה.
     */
    function scanBox() {
      const box = el('div', { style: { marginTop: '14px' } });
      API.get('/api/me/wa-scan').then((p) => {
        const on = el('input', { type: 'checkbox', checked: p.enabled });
        const ignore = el('textarea', { dir: 'ltr', placeholder: '050-0000000', style: { minHeight: '56px' } });
        ignore.value = (p.ignore ?? []).map((n) => (n.startsWith('972') ? `0${n.slice(3)}` : n)).join('\n');
        const savePrefs = async () => {
          try {
            await API.put('/api/me/wa-scan', { enabled: on.checked, ignore: ignore.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) });
            UI.success('נשמר');
          } catch (err) { UI.error(err); }
        };
        on.addEventListener('change', savePrefs);
        ignore.addEventListener('change', savePrefs);
        UI.mount(box,
          el('div.ai-section-title', { text: '💬 הצעות מהוואטסאפ שלי' }),
          el('label.checkbox', {}, [on, ' להציע משימות ופגישות מהודעות שמגיעות אליי בוואטסאפ']),
          el('div.mute-sm', { text: 'רק שיחות פרטיות, ורק עניינים של עבודה — ההצעות מגיעות ל"ממתין לאישורך", ושום דבר לא נוצר בלי אישור. תוכן ההודעות לא נשמר במשימון.' }),
          !p.ai ? el('div.mute-sm.text-warn', { text: 'חיבור ה-AI עוד לא מוגדר בשרת — ההצעות יתחילו כשיוגדר.' }) : null,
          UI.field('מספרים שלא לסרוק (משפחה, חברים)', ignore, 'אחד בשורה')
        );
      }).catch(() => {});
      return box;
    }
  }

  return { openDialog, panel, openWhatsApp, talked, postponeButton };
})();
