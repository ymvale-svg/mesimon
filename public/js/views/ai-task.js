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
    initial: 'פנייה', reminder: 'תזכורת', reply: 'תשובה', thanks: 'תודה', cc_added: 'הוספה לשרשור', inbound: 'תשובה התקבלה',
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
      // מ"💡 איך לסגור" הנמען נלקח מאנשי הקשר והזיכרון של המשתמש — לא מהמייל
      fromEmail: Boolean(opts.suggestionId) && !opts.contactFromSystem,
      // וואטסאפ קיים כאן רק למי שחיבר אותו; מי שלא — הכול במייל.
      // מ"💡 איך לסגור" מגיע ערוץ מוצע — אם הוא זמין
      channel: opts.channel === 'whatsapp' && status.whatsapp?.state === 'authorized' ? 'whatsapp'
        : opts.channel === 'email' ? 'email'
          : status.mail || status.whatsapp?.state !== 'authorized' ? 'email' : 'whatsapp',
      // משימה קיימת שהופכת למשימת AI (מכרטיס המשימה) — בלי משימה חדשה
      taskId: opts.taskId ?? null,
      projectId: opts.projectId ?? '',
      // מהקלטה — היעד שנאמר כבר מולא
      dueDate: opts.dueDate ?? '',
      policy: { ...status.defaults },
      // בהעתק (CC): ‎[{name, email}]‎ · ‎ccAsk‎ — שמות מההוראה שלא ברור למי הם
      cc: [],
      ccAsk: [],
      // מאיזו תיבה יוצא המייל — ‎0‎ הראשית (רק למי שחיבר יותר מחשבון Google אחד)
      fromBox: 0,
      draft: null
    };

    /** בורר התיבה שממנה יוצא המייל — הכתובות של חשבונות ה-Google שלו */
    function fromBoxSelect() {
      const sel = el('select', { dir: 'ltr' }, (status.sendBoxes ?? []).map((b) => el('option', { value: String(b.box) }, [b.email])));
      sel.value = String(state.fromBox);
      sel.addEventListener('change', () => { state.fromBox = Number(sel.value) || 0; });
      return sel;
    }

    const body = el('div.ai-dialog');
    const m = UI.modal({ title: opts.taskId ? '✨ פנייה עם מעקב AI' : '✨ משימת AI חדשה', body, size: 'wide' });

    const draw = () => UI.mount(body, state.step === 'compose' ? composeStep() : previewStep());

    // --- חיפוש הנמען לפי שם באנשי הקשר (עובדים, ספקים, אלפון, Google)

    async function findByName(name) {
      const q = String(name ?? '').trim();
      if (q.length < 2) return [];
      try {
        const { contacts } = await API.get(`/api/ai/contacts?q=${encodeURIComponent(q)}`);
        return contacts.filter((c) => c.email || c.type === 'user').slice(0, 6);
      } catch {
        return [];
      }
    }

    /** ממלאים מעצמנו רק התאמה אחת, עם מייל, שאינה עובד בארגון */
    const autoMatch = (found) => (found.length === 1 && found[0].email && found[0].type !== 'user' ? found[0] : null);

    const sourceLabel = (c) => ContactPicker.SOURCE[c.source]?.label ?? 'אנשי הקשר';

    const foundNote = (c) => el('div.mute-sm.ai-found', {
      text: `📇 נמצא באנשי הקשר: ${c.email} · ${sourceLabel(c)}`
    });

    function matchChoices(found, onPick) {
      return el('div.ai-matches', {}, [
        el('div.mute-sm', { text: 'נמצאו כמה אנשי קשר בשם הזה — בחרו:' }),
        el('div.flex', { style: { gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, found.map((c) =>
          el('button.btn.btn-sm', { type: 'button', onclick: () => onPick(c) },
            [`${c.name} — ${c.type === 'user' ? 'עובד/ת בארגון' : c.email} · ${sourceLabel(c)}`])))
      ]);
    }

    function applyContact(c) {
      state.contact = {
        ...state.contact,
        name: c.name,
        email: c.email || '',
        phone: state.contact.phone || ContactPicker.mobileOf(c),
        type: c.type === 'user' ? 'user' : c.type === 'vendor' ? 'vendor' : 'external',
        refId: c.refId ?? null,
        source: c.source
      };
    }

    /**
     * אחרי ניסוח: שם בלי מייל (הוקלד חופשי, או שה-AI חילץ אותו מההוראה) —
     * חיפוש באנשי הקשר. התוצאה נשמרת ב-‎state.lookup‎ ומוצגת בשלב הטיוטה.
     */
    /**
     * שורת ההעתק — שבבים עם ✕, ושדה להוספה מאנשי הקשר. ‎onChange‎ — אחרי
     * כל שינוי (בשלב הטיוטה: לצייר מחדש).
     */
    function ccEditor(onChange = () => {}) {
      const chips = el('div.ai-cc-chips');
      const drawChips = () => UI.mount(chips, state.cc.map((c, i) => el('span.ai-cc-chip', { title: c.email }, [
        c.name || c.email,
        el('button', { type: 'button', 'aria-label': `הסרה מההעתק: ${c.name || c.email}`, onclick: () => { state.cc.splice(i, 1); drawChips(); onChange(); } }, ['✕'])
      ])));
      const add = (c) => {
        const email = String(c.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return UI.toast(`ל${c.name || 'איש הקשר'} אין כתובת מייל`, 'error');
        if (email === String(state.contact.email ?? '').toLowerCase()) return UI.toast('זה הנמען הראשי', 'error');
        if (!state.cc.some((x) => x.email === email)) state.cc.push({ name: c.name || '', email });
        picker.input.value = '';
        drawChips();
        onChange();
      };
      const picker = ContactPicker.create({ onPick: add });
      picker.input.placeholder = 'הוספה להעתק — שם או מייל';
      // כתובת שהוקלדה ידנית — Enter מוסיף אותה
      picker.input.addEventListener('keydown', (e) => {
        const v = picker.input.value.trim();
        if (e.key === 'Enter' && /@/.test(v)) { e.preventDefault(); add({ email: v }); }
      });
      drawChips();
      return el('div.ai-cc', {}, [chips, picker.node]);
    }

    /** השמות שה-AI הוציא מההוראה ("תשים בכתב את דני") — מחפשים כל אחד באנשי הקשר */
    async function resolveCcNames(names) {
      state.ccAsk = [];
      for (const raw of (names ?? []).map((x) => String(x).trim()).filter(Boolean)) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
          if (!state.cc.some((c) => c.email === raw.toLowerCase())) state.cc.push({ name: '', email: raw.toLowerCase() });
          continue;
        }
        if (state.cc.some((c) => c.name && c.name.includes(raw))) continue;
        const found = (await findByName(raw)).filter((c) => c.email && c.email.toLowerCase() !== String(state.contact.email).toLowerCase());
        if (found.length === 1) state.cc.push({ name: found[0].name, email: found[0].email.toLowerCase() });
        else state.ccAsk.push({ name: raw, found });
      }
    }

    async function lookupRecipient() {
      const c = state.contact;
      if (state.channel !== 'email' || c.type === 'user' || c.email || !c.name) { state.lookup = null; return; }
      const found = await findByName(c.name);
      const single = autoMatch(found);
      if (single) { applyContact(single); state.lookup = { filled: single }; }
      else state.lookup = { query: c.name, found };
    }

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
          /*
           * הקלדה של שם אחר אחרי שנבחר איש קשר — המייל והטלפון שלו כבר אינם
           * של מי שבשדה. בלי הניקוי הפנייה הייתה יוצאת לאדם הקודם.
           */
          if (pickedDetails) {
            emailInput.value = '';
            phoneInput.value = '';
            pickedDetails = false;
          }
          UI.mount(extrasBox);
          showColleague();
        },
        onPick: (c) => pickContact(c)
      });
      // המייל והטלפון שבשדות מולאו מבחירת איש קשר (ולא הוקלדו ידנית)
      let pickedDetails = !!state.contact.email && !!state.contact.source;
      function pickContact(c) {
        {
          pickedDetails = true;
          // בחירה מהצעת החיפוש (ולא מהרשימה של השדה) — השם מתעדכן לשם המלא
          if (picker.input.value.trim() !== c.name) picker.input.value = c.name;
          state.contact.source = c.source;
          emailInput.value = c.email || '';
          // שדה הטלפון כאן הוא לוואטסאפ — רק נייד (05X), אחרת נשאר ריק
          phoneInput.value = ContactPicker.mobileOf(c);
          state.contact.type = c.type === 'user' ? 'user' : c.type === 'vendor' ? 'vendor' : 'external';
          state.contact.refId = c.refId ?? null;
          UI.mount(extrasBox,
            ContactPicker.variants(ContactPicker.mobilesOnly(c), { onEmail: (v) => { emailInput.value = v; }, onPhone: (v) => { phoneInput.value = v; } }),
            c.unsaved
              ? el('div.cp-save-line', {}, [
                  el('span.mute-sm', { text: 'לא שמור באנשי הקשר שלך. ' }),
                  el('button.btn.btn-sm', {
                    type: 'button',
                    onclick: () => ContactPicker.saveDialog({ ...c, email: emailInput.value, phone: phoneInput.value || c.phone }, { onSaved: () => UI.mount(extrasBox) })
                  }, ['⭐ שמור באנשי הקשר של Google'])
                ])
              : null);
          showColleague();
          fromPhonebook = c.source === 'phonebook';
          showPbSave();
        }
      }
      const nameInput = picker.input;
      showColleague();

      /*
       * שם שהוקלד ולא נבחר מהרשימה, בלי מייל: מחפשים אותו באנשי הקשר כשעוזבים
       * את השדה. התאמה אחת עם מייל — ממלאים; כמה — מציעים לבחור. עובד אינו
       * נבחר מעצמו: בחירה בו הופכת את הפנייה למשימה פנימית, וזו החלטה של המשתמש.
       */
      picker.input.addEventListener('change', async () => {
        const name = picker.input.value.trim();
        if (state.contact.type !== 'external' || emailInput.value.trim() || name.length < 2) return;
        const found = await findByName(name);
        if (picker.input.value.trim() !== name || emailInput.value.trim()) return;
        const single = autoMatch(found);
        if (single) {
          pickContact(single);
          extrasBox.prepend(foundNote(single));
        } else if (found.length) {
          UI.mount(extrasBox, matchChoices(found, pickContact));
        }
      });

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
        state.channel === 'email' ? UI.field('📎 בהעתק (CC) — לא חובה', ccEditor(), 'אפשר גם לכתוב בהוראה: "לשים בכתב את דני"') : null,
        state.channel === 'email' && (status.sendBoxes ?? []).length > 1 ? UI.field('📤 שליחה מהתיבה', fromBoxSelect(), 'התשובות יחזרו לתיבה הזו וייקלטו משם') : null,
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
      const { draft, signature, signatureMissing } = await API.post('/api/ai/draft', {
        instruction: state.instruction,
        contact: state.contact,
        cc: state.cc,
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
      if (!feedback) await lookupRecipient();
      if (state.channel === 'email') await resolveCcNames(draft.cc_names);
      // תיקון טיוטה אינו דורס כותרת שהמשתמש כבר ערך
      state.draft = feedback && state.draft ? { ...draft, title: state.draft.title } : draft;
      state.signature = signature ?? null;
      state.signatureMissing = signatureMissing ?? null;
    }

    /** אין חתימה ב-Gmail — למה, ומה ייכתב בסוף המייל במקומה */
    function signatureWarning(miss) {
      return el('div.alert.alert-warn.ai-signature-warn', {}, [
        el('span', { text: '✍️' }),
        el('div', {}, [
          el('b', { text: 'המייל ייצא בלי החתימה שלך. ' }),
          el('span', { text: miss.help ?? '' }),
          miss.fallback ? el('div.mute-sm', { style: { marginTop: '4px', whiteSpace: 'pre-line' }, text: `עד אז יתווסף בסוף המייל:\n${miss.fallback}` }) : null
        ])
      ]);
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
      // שינוי השם בטיוטה — הנמען הקודם אינו תקף; מחפשים את החדש באנשי הקשר
      toName.addEventListener('change', async () => {
        if (toName.value.trim() === state.contact.name) return;
        read();
        state.contact.email = '';
        state.contact.type = 'external';
        state.contact.refId = null;
        await lookupRecipient();
        draw();
      });
      // שמות להעתק שלא ברור למי הם — שואלים, ולא מנחשים
      const ccAskBox = () => (state.ccAsk.length ? el('div.ai-matches', {}, state.ccAsk.map((a) => el('div', { style: { marginBottom: '6px' } }, [
        el('div.mute-sm', { text: a.found.length ? `בהעתק — למי התכוונת ב"${a.name}"?` : `"${a.name}" לא נמצא באנשי הקשר — הוסיפו אותו בשדה ההעתק עם כתובת מייל` }),
        el('div.flex', { style: { gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, [
          ...a.found.map((c) => el('button.btn.btn-sm', { type: 'button', onclick: () => {
            read();
            if (!state.cc.some((x) => x.email === c.email.toLowerCase())) state.cc.push({ name: c.name, email: c.email.toLowerCase() });
            state.ccAsk = state.ccAsk.filter((x) => x !== a);
            draw();
          } }, [`${c.name} — ${c.email} · ${sourceLabel(c)}`])),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { read(); state.ccAsk = state.ccAsk.filter((x) => x !== a); draw(); } }, ['בלי'])
        ])
      ]))) : null);
      const lookupBox = (() => {
        const l = state.lookup;
        if (!l || internal || !isEmail) return null;
        if (l.filled) return foundNote(l.filled);
        if (l.found?.length) return matchChoices(l.found, (c) => { read(); applyContact(c); state.lookup = { filled: c.email ? c : null }; draw(); });
        return el('div.mute-sm.ai-found', { text: `לא נמצא "${l.query}" באנשי הקשר — הקלידו את כתובת המייל` });
      })();
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
      // מייל בלי כתובת היה יוצר משימה שהשליחה שלה נכשלת — הכפתור כבוי עד שיש כתובת
      const noAddress = () => isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.value.trim());
      const ccPending = () => isEmail && state.ccAsk.length > 0;
      const syncSend = () => {
        send.disabled = noAddress() || ccPending();
        send.title = noAddress() ? 'חסרה כתובת מייל תקינה לנמען' : ccPending() ? 'בחרו מי בהעתק, או "בלי"' : '';
      };
      toEmail.addEventListener('input', syncSend);
      syncSend();
      send.addEventListener('click', async () => {
        read();
        send.disabled = true;
        try {
          const res = await API.post('/api/ai/tasks', {
            instruction: state.instruction,
            draft: d,
            contact: state.contact,
            cc: isEmail ? state.cc : [],
            channel: state.channel,
            fromBox: isEmail ? state.fromBox : 0,
            projectId: state.projectId || null,
            dueDate: UI.fromInputDate(state.dueDate),
            policy: state.policy,
            suggestionId: state.suggestionId,
            taskId: state.taskId
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
          lookupBox,
          isEmail ? UI.field('📎 בהעתק (CC)', ccEditor()) : null,
          isEmail ? ccAskBox() : null,
          isEmail ? UI.field('נושא', subject) : null,
          UI.field(internal ? 'הבקשה (תופיע בתיאור המשימה)' : isEmail ? 'המייל' : 'ההודעה', text,
            internal ? 'המשימה תשויך אליו במשימון, עם התראה רגילה על משימה חדשה.'
              : isEmail ? 'יישלח מתיבת ה-Gmail שלך ויישאר אצלך ב"דואר יוצא". התשובה תחזור אליך ותיקלט אוטומטית.' : 'יישלח מהוואטסאפ שלך.')
        ]),
        isEmail && state.signature ? signaturePreview(state.signature) : null,
        isEmail && !state.signature && state.signatureMissing ? signatureWarning(state.signatureMissing) : null,
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
  // ------------------------------------------------- הצעת מייל למשימה

  /**
   * משימה שהיא פנייה החוצה ("לבקש הצעת מחיר מהדפוס") — ליד המשימה נוסח מייל
   * מוכן לנמען שנמצא באנשי הקשר. השרת מחליט אם בכלל (ומחשב פעם אחת); כאן
   * רק מציגים: הנוסח לעריכה, תיקון במילים, ושליחה — שהופכת את המשימה הזו
   * עצמה למשימת AI שעוקבת אחרי התשובה.
   */
  function outreach(task, onChange) {
    if (task.aiDetail || task.completedAt || task.archived || App.isVendor()) return null;
    const box = el('div');
    const base = `/api/tasks/${task.id}/outreach`;
    let open = false;

    const draw = (o) => {
      box.replaceChildren();
      if (!o) return;
      const who = o.contact ? (o.contact.name || o.contact.email) : (o.recipient?.name || o.recipient?.org || '');
      const head = el('div.flex', { style: { alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
        el('span', { text: '✉️' }),
        el('b', { text: o.state === 'ready' ? `הכנתי נוסח מייל ל${who}` : 'אפשר לשלוח מכאן מייל לנמען' }),
        el('div.spacer'),
        o.state === 'ready' && !open ? el('button.btn.btn-sm.btn-primary', { onclick: () => { open = true; draw(o); } }, ['הצגת הנוסח']) : null,
        el('button.btn.btn-sm', {
          title: 'לא להציע שוב למשימה הזו',
          onclick: async () => {
            try { await API.post(`${base}/dismiss`); box.replaceChildren(); } catch (err) { UI.error(err); }
          }
        }, ['לא עכשיו'])
      ]);

      const busy = async (button, fn) => {
        button.disabled = true;
        try { await fn(); } catch (err) { button.disabled = false; UI.error(err); }
      };
      const redraft = (body) => API.post(`${base}/draft`, body).then((r) => { open = true; draw(r.outreach); });

      // אין נמען ודאי: בחירה מהרשימה, או מייל שמקלידים
      if (o.state === 'no_contact') {
        const email = el('input', { type: 'email', placeholder: 'כתובת המייל של הנמען', dir: 'ltr' });
        const name = el('input', { type: 'text', placeholder: 'שם (לא חובה)', value: o.recipient?.name ?? '' });
        const go = el('button.btn.btn-sm.btn-primary', {}, ['✨ הכנת נוסח']);
        go.addEventListener('click', () => {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return UI.toast('כתבו כתובת מייל תקינה', 'error');
          busy(go, () => redraft({ contact: { name: name.value.trim(), email: email.value.trim() } }));
        });
        box.append(el('div.ai-panel', {}, [
          head,
          el('div.mute-sm', { style: { margin: '6px 0' }, text: o.candidates.length ? `למי מהם${who ? ` ("${who}")` : ''}?` : `${who ? `לא מצאתי את "${who}" באנשי הקשר. ` : ''}למי לשלוח?` }),
          o.candidates.length
            ? el('div.flex', { style: { gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } }, o.candidates.map((c) => {
                const b = el('button.btn.btn-sm', {}, [`${c.name}${c.organization ? ` · ${c.organization}` : ''} <${c.email}>`]);
                b.addEventListener('click', () => busy(b, () => redraft({ contact: c })));
                return b;
              }))
            : null,
          el('div.flex', { style: { gap: '6px', flexWrap: 'wrap' } }, [name, email, go])
        ]));
        return;
      }

      if (!open) { box.append(el('div.ai-panel', {}, [head])); return; }

      const toName = el('input', { type: 'text', value: o.contact.name ?? '' });
      const toEmail = el('input', { type: 'email', value: o.contact.email ?? '', dir: 'ltr' });
      const subject = el('input', { type: 'text', value: o.draft.subject ?? '' });
      const text = el('textarea', { rows: 6 }, []);
      text.value = o.draft.body ?? '';
      const feedback = el('input', { type: 'text', placeholder: 'מה לתקן? למשל: "תוסיף שזה דחוף" או "באנגלית"' });
      const redo = el('button.btn', {}, ['✨ תיקון']);
      const doRedo = () => {
        if (!feedback.value.trim()) return;
        busy(redo, () => redraft({ feedback: feedback.value.trim() }));
      };
      redo.addEventListener('click', doRedo);
      feedback.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRedo(); } });

      const send = el('button.btn.btn-primary', {}, ['📧 שליחה']);
      send.addEventListener('click', () => busy(send, async () => {
        const res = await API.post(`${base}/send`, {
          subject: subject.value, body: text.value,
          contact: { name: toName.value.trim(), email: toEmail.value.trim() }
        });
        UI.success('המייל נשלח — ה-AI עוקב אחרי התשובה');
        onChange(res.task);
      }));

      box.append(el('div.ai-panel', {}, [
        head,
        o.notes ? el('div.alert.alert-info', { style: { marginTop: '8px' } }, [el('span', { text: '💡' }), el('div', { text: o.notes })]) : null,
        o.suggestions?.length
          ? el('div.alert.alert-info', { style: { marginTop: '8px' } }, [
              el('span', { text: '📨' }),
              el('div', {}, [
                el('div', { text: 'מההתכתבות האחרונה איתו — אולי להוסיף:' }),
                el('div.flex', { style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px' } }, o.suggestions.map((x) =>
                  el('button.btn.btn-sm', { onclick: () => { feedback.value = `הוסף למייל: ${x}`; doRedo(); } }, [`＋ ${x}`])))
              ])
            ])
          : null,
        el('div.ai-letter', { style: { marginTop: '10px' } }, [
          el('div.row', {}, [UI.field('אל', toName), UI.field('מייל', toEmail)]),
          UI.field('נושא', subject),
          UI.field('המייל', text, 'יישלח מתיבת ה-Gmail שלך, עם החתימה שלך. המשימה תעבור למעקב AI עד שתגיע תשובה.')
        ]),
        el('div.ai-revise', {}, [feedback, redo]),
        el('div.ai-foot', {}, [send, el('div.spacer'), el('button.btn', { onclick: () => { open = false; draw(o); } }, ['הסתרה'])])
      ]));
    };

    API.get(base).then((r) => draw(r.outreach)).catch(() => {});
    return box;
  }

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
      // הטלפון כאן הוא לוואטסאפ — רק נייד (05X) של מי שנבחר
      onPick: (c) => { email.value = c.email || email.value; phone.value = ContactPicker.mobileOf(c); }
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
     * דרך הבוט הארגוני), ורק עם אנשי קשר עסקיים. שתי רשימות, מספר בשורה:
     * עסקיים נוספים, ו"לא לסרוק" — שגוברת על הכול.
     */
    function scanBox() {
      const box = el('div', { style: { marginTop: '14px' } });
      const local = (n) => (n.startsWith('972') ? `0${n.slice(3)}` : n);
      const listOf = (ta) => ta.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      API.get('/api/me/wa-scan').then((p) => {
        const on = el('input', { type: 'checkbox', checked: p.enabled });
        const business = el('textarea', { dir: 'ltr', placeholder: '050-0000000', style: { minHeight: '56px' } });
        business.value = (p.business ?? []).map(local).join('\n');
        const ignore = el('textarea', { dir: 'ltr', placeholder: '050-0000000', style: { minHeight: '56px' } });
        ignore.value = (p.ignore ?? []).map(local).join('\n');
        const savePrefs = async () => {
          try {
            await API.put('/api/me/wa-scan', { enabled: on.checked, business: listOf(business), ignore: listOf(ignore) });
            UI.success('נשמר');
          } catch (err) { UI.error(err); }
        };
        on.addEventListener('change', savePrefs);
        business.addEventListener('change', savePrefs);
        ignore.addEventListener('change', savePrefs);
        UI.mount(box,
          el('div.ai-section-title', { text: '💬 הצעות ותובנות מהוואטסאפ שלי' }),
          el('label.checkbox', {}, [on, ' להציע משימות ופגישות מהודעות שמגיעות אליי בוואטסאפ']),
          el('div.mute-sm', { text: 'רק שיחות פרטיות, ורק עם אנשי קשר עסקיים — ההצעות מגיעות ל"ממתין לאישורך", ושום דבר לא נוצר בלי אישור. תוכן ההודעות לא נשמר במשימון.' }),
          !p.ai ? el('div.mute-sm.text-warn', { text: 'חיבור ה-AI עוד לא מוגדר בשרת — ההצעות יתחילו כשיוגדר.' }) : null,
          el('div.alert.alert-info.wa-business-note', {}, [el('span', { text: '💼' }), el('div', {}, [
            el('b', { text: 'מי נחשב עסקי אוטומטית: ' }),
            'עובדים בארגון, אנשי האלפון, ספקים, אנשי קשר בגוגל עם חברה או תפקיד, ומי שעבדת איתו במשימות, במשימות AI ובפגישות. ',
            'כל שיחה אחרת לא נקראת ולא נשלחת ל-AI. ממספר לא מוכר ששלח כמה הודעות — הבוט ישאל אותך פעם אחת "עסקי או אישי?".'
          ])]),
          UI.field('אנשי קשר עסקיים נוספים', business, 'אחד בשורה · אפשר גם בבוט: "יוסי עסקי"'),
          UI.field('מספרים שלא לסרוק (משפחה, חברים)', ignore, 'אחד בשורה · גובר על "עסקי" · בבוט: "אל תסרוק את דני"'),
          p.asked?.length ? el('div.mute-sm', { text: `מחכה לתשובה שלך על ${p.asked.length === 1 ? 'מספר אחד' : `${p.asked.length} מספרים`}: ${p.asked.map(local).join(', ')} — הוסיפו לאחת הרשימות, או ענו לבוט.` }) : null
        );
      }).catch(() => {});
      return box;
    }
  }

  return { openDialog, panel, outreach, openWhatsApp, talked, postponeButton };
})();
