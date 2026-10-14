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
 */

const AiTaskView = (() => {
  const { el } = UI;

  const CHANNEL_ICON = { email: '📧', whatsapp: '💬' };
  const KIND_LABEL = {
    initial: 'פנייה', reminder: 'תזכורת', reply: 'תשובה', thanks: 'תודה', inbound: 'תשובה התקבלה'
  };
  const VERDICT = {
    satisfied: ['התקבל', 'ok'],
    partial: ['התקבל חלקית', 'warn'],
    promised: ['הבטחה', 'info'],
    question: ['שאלה', 'warn'],
    declined: ['סירוב / הפניה', 'danger'],
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
      instruction: '',
      contact: { name: '', email: '', phone: '', type: 'external', refId: null },
      channel: status.mail ? 'email' : 'whatsapp',
      projectId: opts.projectId ?? '',
      dueDate: '',
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

      // אנשי קשר — חיפוש חופשי על פני ספקים, עובדים ומי שכבר פנו אליו
      const listId = `ai-contacts-${Date.now()}`;
      const datalist = el('datalist', { id: listId }, status.contacts.map((c) =>
        el('option', { value: c.name }, [[c.email, c.phone].filter(Boolean).join(' · ')])));
      const nameInput = el('input', { type: 'text', list: listId, value: state.contact.name, placeholder: 'שם, או חיפוש ברשימה' });
      const emailInput = el('input', { type: 'email', value: state.contact.email, placeholder: 'name@example.com', dir: 'ltr' });
      const phoneInput = el('input', { type: 'tel', value: state.contact.phone, placeholder: '050-0000000', dir: 'ltr' });
      nameInput.addEventListener('change', () => {
        const hit = status.contacts.find((c) => c.name === nameInput.value);
        if (!hit) { state.contact.type = 'external'; state.contact.refId = null; return; }
        emailInput.value = hit.email || emailInput.value;
        phoneInput.value = hit.phone || phoneInput.value;
        state.contact.type = hit.type;
        state.contact.refId = hit.refId;
      });

      const waReady = status.whatsapp?.state === 'authorized';
      const channelSeg = el('div.seg', {}, [
        ['email', '📧 מייל', status.mail, 'שליחת דואר אינה מוגדרת בשרת'],
        ['whatsapp', '💬 וואטסאפ', waReady, 'הוואטסאפ שלך אינו מחובר — מחברים מ"החשבון שלי"']
      ].map(([key, label, ok, why]) => el(`button${state.channel === key ? '.active' : ''}`, {
        type: 'button', disabled: !ok, title: ok ? '' : why,
        onclick: () => { read(); state.channel = key; draw(); }
      }, [label])));

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
        datalist,
        el('div.row', {}, [
          UI.field('שם', nameInput),
          UI.field('מייל', emailInput),
          UI.field('טלפון (לוואטסאפ)', phoneInput)
        ]),
        el('div.row', {}, [
          UI.field('ערוץ ראשון', channelSeg),
          UI.field('פרויקט', projectSelect),
          UI.field('תאריך יעד', dueInput)
        ]),
        policyBox.node,
        !status.inbox && state.channel === 'email'
          ? el('div.alert.alert-warn', {}, [
              el('span', { text: '📭' }),
              el('div', { text: 'קריאת תשובות מהדואר אינה מוגדרת בשרת, ולכן ה-AI לא יראה תשובות במייל — רק בוואטסאפ. התשובות יגיעו אליך בעותק, ואפשר לסמן ידנית שהתקבל.' })
            ])
          : null,
        el('div.ai-foot', {}, [go, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])])
      ]);
    }

    async function makeDraft(feedback = '') {
      const { draft } = await API.post('/api/ai/draft', {
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
    }

    // --- שלב 2: הטיוטה לאישור

    function previewStep() {
      const d = state.draft;
      const isEmail = state.channel === 'email';
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

      const send = el('button.btn.btn-primary', {}, [isEmail ? '📧 אישור ושליחה' : '💬 אישור ושליחה']);
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
            policy: state.policy
          });
          m.close();
          if (res.sendError) UI.toast(`המשימה נוצרה, אבל השליחה נכשלה: ${res.sendError}`, 'error');
          else UI.success(isEmail ? 'המייל נשלח — ה-AI עוקב מכאן' : 'ההודעה נשלחה — ה-AI עוקב מכאן');
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
        UI.field('שם המשימה במערכת', titleInput),
        el('div.ai-letter', {}, [
          el('div.row', {}, [
            UI.field('אל', toName),
            isEmail ? UI.field('מייל', toEmail) : UI.field('טלפון', toPhone)
          ]),
          isEmail ? UI.field('נושא', subject) : null,
          UI.field(isEmail ? 'המייל' : 'ההודעה', text,
            isEmail ? 'יישלח בשמך. תקבל/י עותק, ותשובות ייקלטו אוטומטית.' : 'יישלח מהוואטסאפ שלך.')
        ]),
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

    const summary = () => `עד ${emailAttempts.value} מיילים כל ${daysEmail.value} ימים${wa.checked ? `, ואז עד ${waAttempts.value} הודעות וואטסאפ כל ${daysWa.value} ימים` : ''}`;
    const sumNode = el('span', { text: summary() });
    for (const i of [emailAttempts, daysEmail, wa, waAttempts, daysWa]) i.addEventListener('input', () => { sumNode.textContent = summary(); });

    const node = el('details.ai-policy', {}, [
      el('summary', {}, ['🔁 מדיניות מעקב: ', sumNode]),
      el('div.ai-policy-grid', {}, [
        el('label', {}, ['מיילים שלא נענו לפני מעבר לוואטסאפ ', emailAttempts]),
        el('label', {}, ['ימי עבודה בין מיילים ', daysEmail]),
        el('label.checkbox', {}, [wa, ' להמשיך בוואטסאפ מהמספר שלי']),
        el('label', {}, ['הודעות וואטסאפ שלא נענו לפני עצירה ', waAttempts]),
        el('label', {}, ['ימי עבודה בין הודעות וואטסאפ ', daysWa])
      ]),
      !waReady ? el('div.mute-sm', { text: 'הוואטסאפ שלך עוד לא מחובר. בלי חיבור, המעקב ייעצר אחרי המיילים ותקבל/י התראה. מחברים מ"החשבון שלי".' }) : null,
      el('div.mute-sm', { text: 'שליחה רק בשעות העבודה ובימים א׳–ה׳. כל תשובה של הנמען מאפסת את הספירה.' })
    ]);

    return {
      node,
      read: () => ({
        emailAttempts: Number(emailAttempts.value),
        daysBetweenEmails: Number(daysEmail.value),
        whatsapp: wa.checked,
        whatsappAttempts: Number(waAttempts.value),
        daysBetweenWhatsapp: Number(daysWa.value)
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
    const contactLine = [a.contact.name, a.contact.email, a.contact.phone].filter(Boolean).join(' · ');
    const progress = [
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
    if (!a.channels.inbox && a.contact.email) {
      lines.push(el('div.mute-sm', { text: 'תשובות במייל אינן נקלטות אוטומטית (קריאת הדואר אינה מוגדרת). כשתגיע תשובה — סמנו כאן שהתקבל.' }));
    }

    // שאלה פתוחה של ה-AI
    if (a.ownerQuestion) {
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

    // ההתכתבות
    const timeline = a.messages.filter((x) => x.status === 'sent' || x.status === 'received').map((msg) => {
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
      a.state === 'waiting' ? action('nudge', '🔔 תזכורת עכשיו') : null,
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

  function editDetails(task, a, onChange) {
    const name = el('input', { type: 'text', value: a.contact.name });
    const email = el('input', { type: 'email', value: a.contact.email, dir: 'ltr' });
    const phone = el('input', { type: 'tel', value: a.contact.phone, dir: 'ltr' });
    const policy = policyEditor(a.policy);
    policy.node.open = true;
    const save = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: 'פרטי המעקב',
      body: el('div', {}, [
        el('div.row', {}, [UI.field('שם', name), UI.field('מייל', email), UI.field('טלפון', phone)]),
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
        UI.field('המספר שלי', phone, 'לתצוגה בלבד — ההודעות יוצאות מהמספר שמקושר ב-Green API')
      ]),
      footer: [save, el('div.spacer'), remove]
    });
  }

  return { openDialog, panel, openWhatsApp };
})();
