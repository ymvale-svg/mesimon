'use strict';
/**
 * 🎙 משימה מהקלטה.
 *
 * זיהוי הדיבור הוא של הדפדפן (Web Speech API, ‎he-IL‎): הטקסט מופיע תוך כדי
 * דיבור, ולשרת נשלח רק הטקסט — לא הקלטה. הדפדפן עצמו (כרום) מעביר את הקול
 * ל-Google לזיהוי; זה חלק מהדפדפן ולא ממשימון.
 *
 * לחיצה — מתחילים להאזין. לחיצה שנייה — עוצרים (לא לחיצה ארוכה). ההבנה
 * בשרת (‎POST /api/voice/task‎), ומשם:
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
  const QUESTION = 'איזו משימה תרצה לפתוח היום?';
  const STOP_WORDS = /[\s,.]*(?:סיום|זהו|זה הכל|זה הכול|סוף)[\s,.!]*$/;

  let current = null; // המסך הפתוח, אם יש

  // ------------------------------------------------------------- תמלול נקי

  /*
   * למה זה נחוץ: כרום באנדרואיד מחזיר במצב ‎continuous‎ כל תוצאה "סופית"
   * יחד עם כל מה שנאמר לפניה, ולפעמים אותה תוצאה שוב אחרי שההאזנה מתחדשת
   * מעצמה. הקוד הקודם צירף כל תוצאה לטקסט — ואותן מילים הופיעו פעמיים,
   * ארבע ועשר. כאן כל קטע חדש *ממוזג* במה שכבר נקלט, ולא מצורף אליו.
   */
  const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();

  /** מיזוג קטע תמלול חדש במה שכבר נקלט */
  function mergeSegment(acc, seg) {
    acc = norm(acc);
    seg = norm(seg);
    if (!seg) return acc;
    if (!acc) return seg;
    // אנדרואיד: התוצאה החדשה מכילה את כל מה שנקלט ועוד
    if (seg.startsWith(acc)) return seg;
    const a = acc.split(' ');
    const b = seg.split(' ');
    // אותו משפט שוב — כבר נקלט
    if (b.length >= 2 && acc.endsWith(seg)) return acc;
    // חפיפה: סוף מה שנקלט הוא תחילת הקטע החדש (שתי מילים לפחות, כדי לא
    // לבלוע מילה קצרה שחוזרת במקרה)
    for (let k = Math.min(a.length, b.length); k >= 2; k--) {
      if (a.slice(-k).join(' ') === b.slice(0, k).join(' ')) return [...a, ...b.slice(k)].join(' ');
    }
    return `${acc} ${seg}`;
  }

  /**
   * חזרות רצופות שנשארו: רצף של 2–8 מילים שמופיע פעמיים ברצף, ומילה בודדת
   * שחוזרת שלוש פעמים ומעלה. "מאוד מאוד" נשאר — שתי חזרות של מילה אחת הן
   * לפעמים דיבור אמיתי.
   */
  function cleanRepeats(text) {
    const w = norm(text).split(' ').filter(Boolean);
    let changed = true;
    while (changed) {
      changed = false;
      for (let n = Math.min(8, Math.floor(w.length / 2)); n >= 2 && !changed; n--) {
        for (let i = 0; i + 2 * n <= w.length; i++) {
          if (w.slice(i, i + n).join(' ') === w.slice(i + n, i + 2 * n).join(' ')) {
            w.splice(i + n, n);
            changed = true;
            break;
          }
        }
      }
    }
    return w.filter((x, i) => !(i >= 2 && x === w[i - 1] && x === w[i - 2])).join(' ');
  }

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
    let sessionBase = '';   // מה שנקלט לפני סבב ההאזנה הנוכחי
    let rec = null;
    let listening = false;
    let wantListen = false;
    let busy = false;
    let typing = !supported();
    let startedAt = 0;
    let silenceTimer = null;
    let maxTimer = null;
    let closed = false;

    const text = () => cleanRepeats(mergeSegment(finals, interim));

    const status = el('div.voice-status');
    const live = el('div.voice-live');
    const qa = el('div.voice-qa');           // שיחת ההשלמה — שאלה, הצעות ותשובה
    let conversing = false;
    let answerMic = null;                    // המיקרופון בזמן שאלה: מאזין לתשובה
    let answerRec = null;                    // ההאזנה לתשובה הנוכחית — נעצרת בסגירה
    const input = el('textarea.voice-input', { placeholder: 'לדוגמה: פתח משימה לסדר את המעליות, אחראי דני, עד יום חמישי. צ׳קליסט: אחת להזמין טכנאי, שתיים לבדוק את הלוח.' });
    const mic = el('button.voice-mic', { type: 'button', title: 'הקלטה' }, [el('span.voice-mic-ic', { text: '🎙' })]);
    const sendBtn = el('button.btn.btn-primary.voice-send', { type: 'button' }, ['✓ יצירת משימה']);
    const typeBtn = el('button.btn.btn-ghost', { type: 'button' }, ['⌨ הקלדה']);
    const closeBtn = el('button.icon-btn.voice-close', { type: 'button', title: 'סגירה' }, ['✕']);
    const hint = el('div.voice-hint', {}, [
      el('div', { text: 'אמרו את המשימה. למשל:' }),
      el('div.voice-example', { text: '"פתח משימה לסדר את המעליות"' }),
      el('div.voice-example', { text: '"פתח משימה. הנושא: השגת טופס ממשה. אחראי: דני. עד יום חמישי. צ׳קליסט: אחת… שתיים… שלוש…"' }),
      el('div.mute-sm', { text: 'אחראי — אתם, יעד — יום העבודה הבא ועדיפות רגילה, אלא אם נאמר אחרת.' })
    ]);

    const overlay = el('div.voice-overlay', { role: 'dialog', 'aria-label': 'משימה מהקלטה' }, [
      el('div.voice-panel', {}, [
        el('div.voice-top', {}, [el('b', { text: '🎙 משימה מהקלטה' }), el('div.spacer'), closeBtn]),
        o.baseText ? el('div.voice-base', {}, [el('span.mute-sm', { text: 'עד עכשיו: ' }), o.baseText]) : null,
        mic,
        status,
        live,
        qa,
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
        rec.onstart = () => {
          // כל סבב (גם התחדשות אחרי שתיקה) מתחיל רשימת תוצאות חדשה
          sessionBase = finals;
          listening = true;
          setStatus('מקשיב… לחצו שוב כדי לעצור', 'live');
          drawState();
        };
        rec.onresult = (e) => {
          // בונים מחדש מכל התוצאות של הסבב, ולא מוסיפים — ראה ‎mergeSegment‎
          let merged = sessionBase;
          let pending = '';
          for (let i = 0; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) merged = mergeSegment(merged, r[0].transcript);
            else pending = mergeSegment(pending, r[0].transcript);
          }
          finals = merged ? `${cleanRepeats(merged)} ` : '';
          interim = pending;
          drawState();
          clearTimeout(silenceTimer);
          // "סיום" / "זהו" בסוף המשפט — סוף ההקלטה
          if (o.handsFree && STOP_WORDS.test(finals.trim())) {
            finals = finals.trim().replace(STOP_WORDS, '');
            interim = '';
            stopListening({ send: true });
            return;
          }
          /*
           * שתיקה אחרי שנאמר משהו — סוף ההקלטה, והמערכת ממשיכה לבד: מבינה,
           * ושואלת על מה שחסר. בהכתבה מתוך דיאלוג המשימה (‎forcePreview‎)
           * לא — שם עוצרים בלחיצה וממשיכים לערוך על המסך.
           */
          if (o.handsFree || !o.forcePreview) {
            silenceTimer = setTimeout(() => { if (text() && !closed) stopListening({ send: true }); }, SILENCE_MS);
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
      if (interim) { finals = `${text()} `; interim = ''; }
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
      if (conversing) return answerMic?.();
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
      setStatus('מבין את המשימה…', 'busy');
      drawState();
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
      // חסרים אחראי, תאריך או פרויקט — שואלים עליהם כאן, במסך הזה
      if (res.ask?.length && !res.created) {
        busy = false;
        return converse(res);
      }
      close({ keepCallback: true });
      await handleResult(res, o);
      o.onClose?.();
    }
    sendBtn.addEventListener('click', submit);

    // --- שיחת השלמה: "מי אחראי?", "עד מתי?", "לאיזה פרויקט?"

    /**
     * האזנה לתשובה אחת קצרה. ‎onText‎ — מה שנאמר; ‎onNothing‎ — נגמר בלי
     * תשובה (שתיקה, או שהמשתמש לחץ על הצעה).
     */
    function listenOnce(onText, onNothing) {
      if (!supported() || closed) { onNothing(); return { stop() {} }; }
      let got = false;
      let r = null;
      try {
        r = new Recognition();
        r.lang = 'he-IL';
        r.continuous = false;
        r.interimResults = true;
        r.onstart = () => { listening = true; overlay.classList.add('is-listening'); setStatus('מקשיב לתשובה…', 'live'); };
        r.onresult = (e) => {
          if (closed) return;
          let said = '';
          let final = false;
          for (let i = 0; i < e.results.length; i++) {
            said = mergeSegment(said, e.results[i][0].transcript);
            if (e.results[i].isFinal) final = true;
          }
          live.textContent = cleanRepeats(said);
          if (final && !got) {
            got = true;
            try { r.stop(); } catch { /* כבר עצר */ }
            onText(cleanRepeats(said));
          }
        };
        r.onerror = () => {};
        r.onend = () => {
          listening = false;
          overlay.classList.remove('is-listening');
          if (!got) { got = true; onNothing(); }
        };
        r.start();
      } catch {
        onNothing();
      }
      answerRec = { stop: () => { got = true; try { r?.abort(); } catch { /* כבר עצר */ } } };
      return answerRec;
    }

    /** הצעות ללחיצה, לפי השאלה */
    function suggestions(field, d) {
      if (field === 'assignee') {
        const me = `user:${App.state.actor.id}`;
        const { near, far } = UI.usersByDepartment();
        const names = new Map([...near, ...far].map((u) => [`user:${u.id}`, u.name]));
        const top = frequentCache.filter((v) => names.has(v) && v !== me).slice(0, 4);
        return [{ value: me, label: 'אני', full: App.state.actor.name }, ...top.map((v) => ({ value: v, label: names.get(v).split(' ')[0], full: names.get(v) }))];
      }
      if (field === 'dueDate') return ['היום', 'מחר', 'מחרתיים', 'סוף השבוע', 'שבוע הבא'].map((t) => ({ say: t, label: t }));
      // שלי קודם, ואחריהם שאר הפעילים — למי שעוד לא מנהל פרויקט משלו
      const open = App.state.projects.filter((p) => p.status !== 'done');
      const ordered = [...open.filter((p) => p.mine), ...open.filter((p) => !p.mine)];
      return [
        ...ordered.slice(0, 5).map((p) => ({ value: p.id, label: p.name })),
        { value: null, label: 'ללא פרויקט' }
      ];
    }
    let frequentCache = [];
    let saidText = '';   // מה שנאמר בהקלטה — נשאר על המסך בזמן השאלות

    /** שאלה אחת, עד שתי חזרות. נפתר ב-‎{value,label}‎ או ‎{skip:true}‎ */
    function askField(field, question, d) {
      return new Promise((resolve) => {
        let done = false;
        let tries = 0;
        let listener = null;
        let candidates = null;
        const heard = el('div.voice-heard');
        const chips = el('div.voice-chips');
        const typed = el('input.voice-typed', { type: 'text', placeholder: 'או הקלידו כאן ו-Enter' });

        const finish = (r) => {
          if (done) return;
          done = true;
          listener?.stop();
          answerMic = null;
          resolve(r);
        };

        const drawChips = (items) => UI.mount(chips, ...items.map((c) => el('button.voice-chip', {
          type: 'button',
          title: c.full ?? c.label,
          onclick: () => (c.say ? handle(c.say) : finish({ value: c.value, label: c.full ?? c.label }))
        }, [c.label])));

        const listen = () => {
          listener?.stop();
          listener = listenOnce(handle, () => {
            if (!done) setStatus('לחצו על המיקרופון כדי לענות, או בחרו', '');
          });
        };
        answerMic = listen;

        const ask = async (prefix = '') => {
          const say = `${prefix}${question}`;
          setStatus(say, 'busy');
          await speak(say);
          if (!done && !closed) listen();
        };

        async function handle(text) {
          if (done) return;
          const t = String(text ?? '').trim();
          if (!t) return;
          listener?.stop();
          heard.textContent = `"${t}"`;
          if (/^(דלג|תדלג|לא משנה|הלאה|תמשיך)$/.test(t)) return finish({ skip: true });
          // בחירה מתוך כמה התאמות: "השני", או שם שמופיע באחת מהן
          if (candidates) {
            const ord = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'].findIndex((w) => t.includes(w));
            const hit = ord >= 0 ? candidates[ord] : candidates.find((c) => t.split(/\s+/).some((w) => w.length > 1 && c.label.includes(w)));
            if (hit) return finish(hit);
          }
          let r;
          try {
            r = await API.post('/api/voice/answer', { field, text: t, assignee: d.assignee });
          } catch (err) {
            setStatus(err.message, 'error');
            return;
          }
          if (done) return;
          if (r.value !== undefined) return finish(r);
          if (r.candidates?.length) {
            candidates = r.candidates;
            drawChips(candidates.map((c) => ({ value: c.value, label: c.label })));
            return ask(`יש כמה: ${candidates.map((c) => c.label).join(', או ')}. `).then(() => {});
          }
          tries += 1;
          if (tries > 2) return finish({ skip: true });
          ask('לא הבנתי. ');
        }

        typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handle(typed.value); typed.value = ''; } });
        drawChips(suggestions(field, d));
        UI.mount(qa,
          saidText ? el('div.voice-said', { text: `"${saidText}"` }) : null,
          el('div.voice-q', { text: question }),
          chips,
          heard,
          el('div.voice-qa-foot', {}, [typed, el('button.btn.btn-sm', { type: 'button', title: 'להשאיר את ברירת המחדל', onclick: () => finish({ skip: true }) }, ['דלג ←'])])
        );
        live.textContent = '';
        ask();
      });
    }

    async function converse(res) {
      conversing = true;
      overlay.classList.add('is-asking');
      typing = false;
      drawState();
      try { frequentCache = (await AssigneePicker.prefetch()).map((i) => i.value); } catch { frequentCache = []; }
      const d = { ...res.draft };
      const me = `user:${App.state.actor.id}`;
      saidText = res.transcript ?? '';
      for (const field of res.ask) {
        if (closed) return;
        const r = await askField(field, res.questions?.[field] ?? '', d);
        if (closed) return;
        if (r.skip) {
          if (field === 'projectId') d.projectId = null;
          continue;
        }
        if (field === 'assignee') { d.assignee = r.value; d.assigneeGuess = r.value; d.assigneeName = r.label; }
        if (field === 'dueDate') d.dueDate = r.value;
        if (field === 'projectId') d.projectId = r.value;
      }
      if (!closed) confirmStep(d, res, me);
    }

    /** הסיכום — "לפתוח?" בקול, וגם כפתורים */
    function confirmStep(d, res, me) {
      const who = d.assignee === me ? 'אני' : (d.assigneeName || 'אני');
      const project = d.projectId ? (App.project(Number(d.projectId))?.name ?? '') : 'ללא פרויקט';
      const line = `${d.title} · ${who} · ${dayLabel(d.dueDate)} · ${project}`;
      const ok = el('button.btn.btn-primary', { type: 'button' }, ['✓ פתיחת המשימה']);
      const editBtn = el('button.btn', { type: 'button' }, ['✏ עריכה מלאה']);
      let listener = null;

      const commit = async () => {
        listener?.stop();
        ok.disabled = true;
        setStatus('פותח את המשימה…', 'busy');
        try {
          const out = await API.post('/api/voice/commit', { draft: d, transcript: res.transcript });
          close({ keepCallback: true });
          createdToast(out.created, line, res.warnings ?? []);
          if (o.handsFree) speak('המשימה נפתחה.');
          await App.reloadReference();
          await App.refreshView();
          App.refreshNotifications();
          o.onClose?.();
        } catch (err) {
          ok.disabled = false;
          setStatus(err.message, 'error');
        }
      };
      const edit = () => {
        listener?.stop();
        close({ keepCallback: true });
        handleResult({ ...res, draft: d, ask: null }, { ...o, handsFree: false });
        o.onClose?.();
      };
      ok.addEventListener('click', commit);
      editBtn.addEventListener('click', edit);

      UI.mount(qa,
        el('div.voice-q', { text: 'לפתוח את המשימה?' }),
        el('div.voice-summary', {}, [
          el('b', { text: d.title }),
          el('div', {}, [el('span.mute-sm', { text: 'אחראי: ' }), who]),
          el('div', {}, [el('span.mute-sm', { text: 'עד: ' }), dayLabel(d.dueDate)]),
          el('div', {}, [el('span.mute-sm', { text: 'פרויקט: ' }), project])
        ]),
        el('div.voice-qa-foot', {}, [ok, editBtn])
      );
      live.textContent = '';

      const listen = () => {
        listener?.stop();
        listener = listenOnce((t) => {
          if (/(^|\s)(כן|פתח|תפתח|אישור|מאשר|מאשרת|נכון|יאללה|סבבה|בסדר|אוקיי)(\s|$)/.test(t)) commit();
          else if (/(עריכה|ערוך|תערוך|לשנות|שנה)/.test(t)) edit();
          else if (/(^|\s)(לא|ביטול|בטל|תבטל)(\s|$)/.test(t)) close();
          else setStatus('אמרו "כן" כדי לפתוח, או לחצו', '');
        }, () => setStatus('אמרו "כן" או לחצו "פתיחת המשימה"', ''));
      };
      answerMic = listen;
      (async () => {
        const say = `${d.title}. ${who === 'אני' ? 'אצלך' : `אחראי ${who}`}, ${dayLabel(d.dueDate).replace(/ \d.*$/, '')}${d.projectId ? `, ${project}` : ''}. לפתוח?`;
        setStatus('לפתוח את המשימה?', 'busy');
        await speak(say);
        if (!closed) listen();
      })();
    }

    function close({ keepCallback = false } = {}) {
      if (closed) return;
      closed = true;
      wantListen = false;
      clearTimeout(silenceTimer);
      clearTimeout(maxTimer);
      try { rec?.abort(); } catch { /* כבר עצר */ }
      answerRec?.stop();
      try { window.speechSynthesis?.cancel(); } catch { /* אין הקראה */ }
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
          el('li', { text: 'מעכשיו: "היי Siri, משימון" — משימון נפתח, שואל "איזו משימה תרצה לפתוח היום?" ומאזין.' })
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

  return { open, speak, chime, supported, shortcutHelp, createdToast, QUESTION, _text: { mergeSegment, cleanRepeats } };
})();
