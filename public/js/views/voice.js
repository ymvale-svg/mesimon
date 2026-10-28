'use strict';
/**
 * 🎙 משימה מהקלטה.
 *
 * זיהוי הדיבור הוא של הדפדפן (Web Speech API, ‎he-IL‎): הטקסט מופיע תוך כדי
 * דיבור, ולשרת נשלח רק הטקסט — לא הקלטה. הדפדפן עצמו (כרום) מעביר את הקול
 * ל-Google לזיהוי; זה חלק מהדפדפן ולא ממשימון.
 *
 * לחיצה — מתחילים להאזין. לחיצה שנייה — עוצרים (לא לחיצה ארוכה). קודם
 * ‎POST /api/voice/route‎: בקשה אחת לפתוח משימה — למסלול המשימה כאן; כל
 * השאר (מייל, Today, תובנות, כמה בקשות יחד) — לעוזר (‎assistant.js‎), באותה
 * שיחה של בוט הוואטסאפ. מסלול המשימה (‎POST /api/voice/task‎):
 *   • נוצרה ישר (העדפה "יצירה ישירה" + "פתח משימה") — הודעה עם עריכה וביטול
 *   • טיוטה — דיאלוג המשימה הרגיל נפתח ממולא, ומה שלא ודאי מסומן
 *   • משימת AI — אשף משימת AI, עם ההוראה ממולאת
 *
 * בלי זיהוי דיבור (פיירפוקס) — אותו מסך עם שדה הקלדה, באותו מסלול.
 *
 * ‎handsFree‎ — נפתח מ"משימון!" (‎voice-wake.js‎): אין יד על הטלפון, ולכן
 * שתיקה של 3 שניות או המילה "סיום" עוצרות, והתוצאה נאמרת בקול.
 */

const VoiceView = (() => {
  const { el } = UI;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const supported = () => Boolean(Recognition);
  const MAX_MS = 3 * 60 * 1000;
  const SILENCE_MS = 3000;
  const QUESTION = 'במה אפשר לעזור?';
  const STOP_WORDS = /[\s,.]*(?:סיום|זהו|זה הכל|זה הכול|סוף)[\s,.!]*$/;

  let current = null; // המסך הפתוח, אם יש

  // ------------------------------------------------------------- קול

  /** הקראה בקול עברי. נפתר בסוף ההקראה, או אחרי זמן סביר אם אין קול עברי */
  function speak(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !window.SpeechSynthesisUtterance) return resolve(false);
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'he-IL';
        const voice = synth.getVoices().find((v) => /^he|^iw/i.test(v.lang));
        if (voice) u.voice = voice;
        u.rate = 1.05;
        const done = () => resolve(true);
        u.onend = done;
        u.onerror = () => resolve(false);
        setTimeout(done, Math.min(8000, 1200 + text.length * 90));
        synth.speak(u);
      } catch {
        resolve(false);
      }
    });
  }

  /** צליל קצר + רטט — "שמעתי אותך" */
  function chime() {
    try { navigator.vibrate?.(60); } catch { /* אין רטט */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close().catch(() => {}), 400);
    } catch { /* בלי צליל */ }
  }

  // ------------------------------------------------------------- תאריכים

  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const dayLabel = (dateStr) => {
    if (!dateStr) return '';
    const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    return `יום ${DAY_NAMES[wd]} ${Number(dateStr.slice(8))}.${Number(dateStr.slice(5, 7))}`;
  };

  // ------------------------------------------------------------- המסך

  /**
   * @param {object} opts
   * @param {boolean} [opts.autoStart=true]   להתחיל להאזין מיד
   * @param {boolean} [opts.handsFree=false]   נפתח מ"משימון!" — עצירה בשתיקה, תשובה בקול
   * @param {boolean} [opts.forcePreview=false] תמיד טיוטה, גם במצב ישיר (הכתבה בדיאלוג)
   * @param {string}  [opts.baseText='']       טקסט קודם — "הוסף עוד" ממשיך אותו
   * @param {string}  [opts.initialText='']    טקסט שכבר נאמר (אחרי "משימון" באותו משפט)
   * @param {boolean} [opts.autoSend=false]    לשלוח מיד את ‎initialText‎
   * @param {boolean} [opts.ask=false]         לשאול בקול "איזו משימה…" לפני ההאזנה
   * @param {Function} [opts.onClose]          נקרא כשהמסך נסגר, בכל מסלול
   */
  function open(opts = {}) {
    if (current) current.close();
    const o = { autoStart: true, handsFree: false, forcePreview: false, baseText: '', initialText: '', autoSend: false, ask: false, ...opts };

    let finals = o.initialText ? `${o.initialText} ` : '';
    let interim = '';
    let rec = null;
    let listening = false;
    let wantListen = false;
    let busy = false;
    let typing = !supported();
    let startedAt = 0;
    let silenceTimer = null;
    let maxTimer = null;
    let closed = false;

    const text = () => `${finals}${interim}`.replace(/\s+/g, ' ').trim();

    const status = el('div.voice-status');
    const live = el('div.voice-live');
    const input = el('textarea.voice-input', { placeholder: 'לדוגמה: פתח משימה לסדר את המעליות, אחראי דני, עד יום חמישי. צ׳קליסט: אחת להזמין טכנאי, שתיים לבדוק את הלוח.' });
    const mic = el('button.voice-mic', { type: 'button', title: 'הקלטה' }, [el('span.voice-mic-ic', { text: '🎙' })]);
    const sendBtn = el('button.btn.btn-primary.voice-send', { type: 'button' }, [o.forcePreview ? '✓ יצירת משימה' : '✓ המשך']);
    const typeBtn = el('button.btn.btn-ghost', { type: 'button' }, ['⌨ הקלדה']);
    const closeBtn = el('button.icon-btn.voice-close', { type: 'button', title: 'סגירה' }, ['✕']);
    const hint = el('div.voice-hint', {}, [
      el('div', { text: o.forcePreview ? 'אמרו את המשימה. למשל:' : 'אמרו מה לעשות. למשל:' }),
      el('div.voice-example', { text: '"פתח משימה לסדר את המעליות"' }),
      o.forcePreview ? null : el('div.voice-example', { text: '"שלח מייל לאורן ממשרד עורכי הדין כהן שיביא את טיוטת ההסכם"' }),
      o.forcePreview ? null : el('div.voice-example', { text: '"מה חדש במייל?" · "מה יש לי היום?" · "שלח לי את Today"' }),
      el('div.voice-example', { text: '"פתח משימה. הנושא: השגת טופס ממשה. אחראי: דני. עד יום חמישי. צ׳קליסט: אחת… שתיים… שלוש…"' }),
      el('div.mute-sm', { text: 'אחראי — אתם, יעד — יום העבודה הבא ועדיפות רגילה, אלא אם נאמר אחרת.' })
    ]);

    const overlay = el('div.voice-overlay', { role: 'dialog', 'aria-label': 'משימה מהקלטה' }, [
      el('div.voice-panel', {}, [
        el('div.voice-top', {}, [el('b', { text: o.forcePreview ? '🎙 משימה מהקלטה' : '🎙 הקלטה' }), el('div.spacer'), closeBtn]),
        o.baseText ? el('div.voice-base', {}, [el('span.mute-sm', { text: 'עד עכשיו: ' }), o.baseText]) : null,
        mic,
        status,
        live,
        input,
        hint,
        el('div.voice-foot', {}, [sendBtn, el('div.spacer'), supported() ? typeBtn : null])
      ])
    ]);

    function setStatus(msg, tone = '') {
      status.className = `voice-status${tone ? ` is-${tone}` : ''}`;
      status.textContent = msg;
    }

    function drawState() {
      overlay.classList.toggle('is-listening', listening);
      overlay.classList.toggle('is-typing', typing);
      overlay.classList.toggle('is-busy', busy);
      mic.disabled = busy || !supported();
      sendBtn.disabled = busy || !(typing ? input.value.trim() : text());
      typeBtn.textContent = typing ? '🎙 חזרה להקלטה' : '⌨ הקלדה';
      live.textContent = typing ? '' : text();
      hint.style.display = (typing ? input.value.trim() : text()) ? 'none' : '';
    }

    // --- זיהוי דיבור

    function startListening() {
      if (!supported() || busy || closed) return;
      wantListen = true;
      startedAt = startedAt || Date.now();
      try {
        rec = new Recognition();
        rec.lang = 'he-IL';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onstart = () => { listening = true; setStatus('מקשיב… לחצו שוב כדי לעצור', 'live'); drawState(); };
        rec.onresult = (e) => {
          interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finals += `${r[0].transcript} `;
            else interim += r[0].transcript;
          }
          drawState();
          if (o.handsFree) {
            clearTimeout(silenceTimer);
            // "סיום" / "זהו" בסוף המשפט — סוף ההקלטה
            if (STOP_WORDS.test(finals.trim())) {
              finals = finals.trim().replace(STOP_WORDS, '');
              interim = '';
              stopListening({ send: true });
              return;
            }
            silenceTimer = setTimeout(() => { if (text()) stopListening({ send: true }); }, SILENCE_MS);
          }
        };
        rec.onerror = (e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          wantListen = false;
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            setStatus('אין הרשאה למיקרופון. לפתיחה: סמל המנעול שליד הכתובת ← מיקרופון ← אפשר. אפשר גם להקליד.', 'error');
            typing = true;
          } else if (e.error === 'network') {
            setStatus('זיהוי הדיבור דורש חיבור לרשת. אפשר להקליד.', 'error');
          } else {
            setStatus(`זיהוי הדיבור נעצר (${e.error}). לחצו כדי לנסות שוב, או הקלידו.`, 'error');
          }
          drawState();
        };
        rec.onend = () => {
          listening = false;
          // הדפדפן עוצר לבד אחרי שתיקה — כל עוד לא לחצו "עצור", ממשיכים להאזין
          if (wantListen && !closed && Date.now() - startedAt < MAX_MS) {
            try { rec.start(); return; } catch { /* נבנה מחדש למטה */ }
            setTimeout(startListening, 150);
            return;
          }
          if (!busy && !closed && status.classList.contains('is-live')) setStatus(text() ? 'אפשר לתקן את הטקסט, ללחוץ שוב להמשך, או ליצור משימה' : 'לחצו על המיקרופון כדי להתחיל');
          drawState();
        };
        rec.start();
        clearTimeout(maxTimer);
        maxTimer = setTimeout(() => stopListening({ send: o.handsFree }), MAX_MS);
      } catch (err) {
        wantListen = false;
        // ספארי דורש נגיעה במסך לפני שהמיקרופון נפתח — המיקרופון הענק הוא הנגיעה
        setStatus('לחצו על המיקרופון כדי להתחיל', '');
        drawState();
      }
    }

    function stopListening({ send = false } = {}) {
      wantListen = false;
      clearTimeout(silenceTimer);
      clearTimeout(maxTimer);
      if (interim) { finals += `${interim} `; interim = ''; }
      try { rec?.stop(); } catch { /* כבר עצר */ }
      listening = false;
      // אחרי העצירה הטקסט פתוח לתיקון — זיהוי דיבור טועה בשמות
      if (text()) {
        input.value = text();
        typing = true;
      }
      setStatus(text() ? 'אפשר לתקן את הטקסט, ללחוץ שוב להמשך, או ליצור משימה' : 'לא נקלט דיבור. לחצו שוב, או הקלידו.');
      drawState();
      if (send && text()) submit();
    }

    mic.addEventListener('click', () => {
      if (listening || wantListen) return stopListening();
      // המשך הקלטה אחרי תיקון — ממשיך מהטקסט שעל המסך
      if (typing) {
        finals = input.value.trim() ? `${input.value.trim()} ` : '';
        typing = false;
      }
      startedAt = Date.now();
      startListening();
    });

    typeBtn.addEventListener('click', () => {
      if (!typing) {
        if (listening) stopListening();
        input.value = text();
        typing = true;
        drawState();
        input.focus();
      } else {
        finals = input.value.trim() ? `${input.value.trim()} ` : '';
        typing = false;
        drawState();
      }
    });
    input.addEventListener('input', drawState);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });

    // --- שליחה

    async function submit() {
      if (busy) return;
      if (listening || wantListen) stopListening();
      const said = typing ? input.value.trim() : text();
      if (!said) return;
      const full = [o.baseText, said].filter(Boolean).join(' ');
      busy = true;
      setStatus('מבין…', 'busy');
      drawState();

      // משימה אחת — המסלול הרגיל. כל השאר — לעוזר
      if (!o.forcePreview) {
        const route = await API.post('/api/voice/route', { text: full }).catch(() => null);
        if (route?.route === 'assistant') {
          close({ keepCallback: true });
          AssistantView.open({ text: full, requests: route.requests.length > 1 ? route.requests : null, voice: true, handsFree: o.handsFree });
          o.onClose?.();
          return;
        }
      }

      let res;
      try {
        res = await API.post('/api/voice/task', { text: full, forcePreview: o.forcePreview });
      } catch (err) {
        busy = false;
        typing = true;
        input.value = said;
        setStatus(err.message, 'error');
        drawState();
        if (o.handsFree) speak('לא הצלחתי להבין. נסו שוב.');
        return;
      }
      close({ keepCallback: true });
      await handleResult(res, o);
      o.onClose?.();
    }
    sendBtn.addEventListener('click', submit);

    function close({ keepCallback = false } = {}) {
      if (closed) return;
      closed = true;
      wantListen = false;
      clearTimeout(silenceTimer);
      clearTimeout(maxTimer);
      try { rec?.abort(); } catch { /* כבר עצר */ }
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (current?.overlay === overlay) current = null;
      if (!keepCallback) o.onClose?.();
    }
    closeBtn.addEventListener('click', () => close());
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    current = { close, overlay };
    if (typing && !supported()) setStatus('הדפדפן הזה אינו תומך בזיהוי דיבור — הקלידו את המשימה, והיא תיבנה באותה דרך.');
    else setStatus('לחצו על המיקרופון כדי להתחיל');
    input.value = finals.trim();
    drawState();

    (async () => {
      if (o.autoSend && finals.trim()) return submit();
      if (o.ask) {
        setStatus(QUESTION, 'live');
        await speak(QUESTION);
      }
      if (o.autoStart && !typing && !closed) startListening();
      if (typing) input.focus();
    })();

    return { close };
  }

  // ------------------------------------------------------------- התוצאה

  async function handleResult(res, o) {
    const d = res.draft;
    // "קבע פגישה עם…" — המשימה נוצרה, ודיאלוג הפגישה נפתח ממולא
    if (res.created && d.meeting) {
      if (o.handsFree) speak('המשימה נפתחה. אשר את הפגישה במסך.');
      await App.reloadReference();
      App.refreshView();
      const attendees = [];
      for (const name of d.meeting.with ?? []) {
        try {
          const { contacts } = await API.get(`/api/ai/contacts?q=${encodeURIComponent(name)}`);
          const hit = contacts.find((c) => c.email && !(c.type === 'user' && c.refId === App.state.actor.id));
          if (hit && !attendees.some((a) => a.email === hit.email)) attendees.push({ email: hit.email, name: hit.name });
        } catch { /* מוסיפים ידנית בדיאלוג */ }
      }
      const start = d.meeting.date && d.meeting.time ? new Date(`${d.meeting.date}T${d.meeting.time}:00`).toISOString() : null;
      const { task } = await API.task(res.created.id);
      MeetingView.openDialog({ task, prefill: { attendees, ...(start ? { start } : {}), ...(d.meeting.minutes ? { minutes: d.meeting.minutes } : {}) } });
      if ((d.meeting.with ?? []).length > attendees.length) UI.toast('חלק מהמשתתפים לא נמצאו באנשי הקשר — הוסיפו אותם בדיאלוג');
      return;
    }
    if (res.created) {
      const t = res.created;
      const who = d.assigneeName && d.assignee !== `user:${App.state.actor.id}` ? d.assigneeName : 'אני';
      createdToast(t, `${t.title} · ${who} · ${dayLabel(d.dueDate)}`, res.warnings);
      if (o.handsFree) speak(`נפתחה משימה: ${t.title}, עד ${dayLabel(d.dueDate).replace(/ \d.*$/, '')}.`);
      await App.reloadReference();
      await App.refreshView();
      App.refreshNotifications();
      return;
    }
    if (d.kind === 'ai_task') {
      if (o.handsFree) speak('משימת AI מוכנה. אשר במסך.');
      AiTaskView.openDialog({
        instruction: d.aiInstruction || res.transcript,
        dueDate: d.dueDate,
        projectId: d.projectId ?? d.projectGuess ?? ''
      });
      return;
    }
    if (o.handsFree) speak('המשימה מוכנה. אשר במסך.');
    BoardView.openTaskDialog(null, {
      prefill: {
        title: d.title,
        description: d.description,
        projectId: d.projectId ?? d.projectGuess ?? '',
        assignee: d.assigneeGuess ?? d.assignee,
        priority: d.priority,
        dueDate: d.dueDate,
        checklist: d.checklist,
        statusShort: d.statusShort,
        recurrence: d.recurrence,
        activateDate: d.activateDate
      },
      voice: {
        transcript: res.transcript,
        warnings: res.warnings,
        // ניחוש שלא ודאי מסומן לבדיקה
        uncertain: [
          d.assigneeGuess && d.assigneeGuess !== d.assignee ? 'assignee' : null,
          d.projectGuess && d.projectGuess !== d.projectId ? 'projectId' : null,
          ...res.warnings.map((w) => w.field).filter(Boolean)
        ].filter(Boolean)
      }
    });
  }

  /**
   * "✓ נוצרה" עם עריכה וביטול, ל-10 שניות. לא ה-‎toast‎ הרגיל — יש בו
   * כפתורים, והוא נשאר מספיק זמן כדי להספיק לבטל.
   */
  function createdToast(task, line, warnings = []) {
    const root = document.getElementById('toast-root');
    const undo = el('button.btn.btn-sm', {}, ['ביטול']);
    const edit = el('button.btn.btn-sm', {}, ['עריכה']);
    const node = el('div.toast.ok.toast-action', {}, [
      el('div', {}, [
        el('b', { text: '✓ נוצרה: ' }), line,
        ...warnings.map((w) => el('div.toast-warn', { text: `⚠ ${w.text}` }))
      ]),
      el('div.toast-buttons', {}, [edit, undo])
    ]);
    const remove = () => node.remove();
    const timer = setTimeout(remove, warnings.length ? 15000 : 10000);
    edit.addEventListener('click', () => { clearTimeout(timer); remove(); TaskCardView.open(task.id); });
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await API.post(`/api/voice/undo/${task.id}`);
        clearTimeout(timer);
        remove();
        UI.toast('המשימה בוטלה');
        await App.reloadReference();
        await App.refreshView();
      } catch (err) {
        undo.disabled = false;
        UI.error(err);
      }
    });
    root.appendChild(node);
  }

  // ------------------------------------------------------------- קיצורים

  /** איך פותחים את ההקלטה מהטלפון הנעול — Siri ו-Google */
  function shortcutHelp() {
    const url = `${location.origin}/?voice=1`;
    const copy = el('button.btn.btn-sm', {}, ['העתקה']);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); UI.success('הכתובת הועתקה'); } catch { UI.toast(url); }
    });
    UI.modal({
      title: '🎙 הקלטה מהטלפון הנעול',
      size: 'wide',
      body: el('div.voice-help', {}, [
        el('p', { style: { marginTop: 0 }, text: 'משימון יכול להאזין רק כשהוא פתוח על המסך. כשהטלפון נעול — העוזר הקולי של הטלפון פותח את משימון ישר להקלטה.' }),
        el('div.voice-url', {}, [el('code', { dir: 'ltr', text: url }), copy]),
        el('div.ai-section-title', { text: '🍎 אייפון — "היי Siri, משימון"' }),
        el('ol.ai-steps', {}, [
          el('li', { text: 'פותחים את האפליקציה "קיצורים" (Shortcuts) ← ＋ קיצור חדש.' }),
          el('li', { text: 'הוספת פעולה ← "פתח כתובת URL" (Open URLs) ← מדביקים את הכתובת שלמעלה.' }),
          el('li', { text: 'שם הקיצור: משימון. שומרים.' }),
          el('li', { text: 'מעכשיו: "היי Siri, משימון" — משימון נפתח, שואל "במה אפשר לעזור?" ומאזין.' })
        ]),
        el('div.ai-section-title', { text: '🤖 אנדרואיד — "Hey Google, פתח משימון"' }),
        el('ol.ai-steps', {}, [
          el('li', { text: 'אחרי התקנת משימון למסך הבית: "Hey Google, פתח משימון" פותח את האפליקציה.' }),
          el('li', { text: 'לחיצה ארוכה על סמל משימון ← "משימה בקול" — פותח ישר להקלטה. אפשר לגרור אותו למסך הבית.' })
        ]),
        el('div.mute-sm', { text: 'ייתכן שהדפדפן יבקש נגיעה אחת במסך לפני שהמיקרופון נפתח — זו הגנה של הדפדפן מפני האזנה בלי ידיעתכם.' })
      ])
    });
  }

  return { open, speak, chime, supported, shortcutHelp, createdToast, QUESTION };
})();
