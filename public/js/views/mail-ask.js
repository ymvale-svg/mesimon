'use strict';
/**
 * ✨ שאל את אשל — שאלה חופשית אחת, תשובה מכל מה שהעוזר יודע. נפתח מהכפתור
 * שליד החיפוש העליון, מכרטיס משימה, ומהעוזר. חיפוש משימות ופרויקטים — בשדה
 * החיפוש עצמו, לא כאן: התשובה לא מוצפת ברשימת משימות שנמצאו לפי מילה.
 *
 * הסדר בתשובה:
 *   📧 מהמיילים — למי שחיבר את התיבה, כשהשאלה נוגעת למה שבמייל
 *   🤖 הסוכן המתאים — סקיל של מחלקה, עם מחשבונים ומקורות נתונים
 *   📚 מהידע הארגוני — "איך עושים אצלנו"
 *
 * אותו חלון ממשיך את השיחה ("ומה לפני זה?"). אפשר לצרף מסמך (קבלה, נסח טאבו,
 * מכתב מהעירייה). ליד התשובה — פעולות קיימות בלבד; שום דבר לא נשלח בלי לחיצה.
 */

const AskView = (() => {
  const { el } = UI;
  const ICON = { mail: '📧', memory: '🧠', doc: '📎', org: '📚' };
  const MAX_FILE = 12 * 1024 * 1024;

  /*
   * במחשב — חלונית צד שנשארת פתוחה (‎ask-dock‎), לא חלון באמצע המסך: שואלים,
   * וממשיכים לעבוד במערכת לידה — לעבור מסך, לפתוח משימה, להעתיק מהתשובה.
   * בלי רקע כהה; שאר המסך מצטמצם לצידה ולא מוסתר. נשארת בין מסכים (היא על
   * ה-body, מחוץ לאזור שמצויר מחדש בכל ניווט), ונסגרת רק ב-✕ או Escape מתוכה.
   * בטלפון — חלון מלא, כמו קודם.
   */
  const PHONE = window.matchMedia('(max-width: 820px)');
  let dock = null; // ‎{ panel, input, ask(question) }‎ — החלונית הפתוחה

  function openDock(content, onClose) {
    const closeBtn = el('button.icon-btn', { type: 'button', title: 'סגירה', 'aria-label': 'סגירת שאל את אשל' }, ['✕']);
    const panel = el('aside.ask-dock', { role: 'complementary', 'aria-label': 'שאל את אשל' }, [
      el('div.ask-dock-head', {}, [el('b', { text: '✨ שאל את אשל' }), el('div.spacer'), closeBtn]),
      el('div.ask-dock-body', {}, [content])
    ]);
    const close = () => {
      panel.remove();
      document.body.classList.remove('has-ask-dock');
      dock = null;
      onClose?.();
    };
    closeBtn.addEventListener('click', close);
    panel.addEventListener('keydown', (e) => {
      // Escape רק כשהמיקוד בחלונית — כדי לא לסגור אותה כשסוגרים חלון אחר מעליה
      if (e.key === 'Escape' && !document.querySelector('#modal-root .modal-backdrop')) { e.stopPropagation(); close(); }
    });
    document.body.appendChild(panel);
    document.body.classList.add('has-ask-dock');
    return { close, panel };
  }

  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error(`לא הצלחתי לקרוא את ${file.name}`));
    r.readAsDataURL(file);
  });

  /**
   * @param {object} [opts]
   * @param {string} [opts.question]  שאלה לשלוח מיד
   * @param {number} [opts.taskId]    מכרטיס משימה — הכותרת והתיאור הם ההקשר
   * @param {string} [opts.taskTitle]
   */
  async function open(opts = {}) {
    // כבר פתוחה במחשב — אותה שיחה: שאלה חדשה נשלחת בה, אחרת רק מיקוד
    if (dock && !PHONE.matches) {
      if (opts.question) dock.ask(opts.question);
      else dock.input.focus();
      return;
    }
    const docked = !PHONE.matches;
    const history = [];
    let files = [];
    const thread = el('div.mask-thread');
    const input = el('input', { type: 'text', placeholder: 'שאלה חופשית — "כמה מס רכישה על 2.4 מיליון?", "מה סיכמנו עם העירייה?"', maxlength: '1000', 'aria-label': 'השאלה' });
    const go = el('button.btn.btn-primary', { type: 'submit' }, ['✨ שאל']);
    const fileInput = el('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv', style: { display: 'none' } });
    const attach = el('button.btn', { type: 'button', title: 'לצרף מסמך — קבלה, נסח טאבו, מכתב, קורות חיים' }, ['📎']);
    const fileChips = el('div.mask-chips');
    const recentBox = el('div.mask-recent');
    /*
     * 🎙 לשאול בקול — זיהוי הדיבור של הדפדפן (עברית). הטקסט מופיע בשדה תוך
     * כדי דיבור, ובסוף נשלח. בלי זיהוי דיבור (פיירפוקס) — הכפתור לא מוצג.
     */
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    const mic = Recognition ? el('button.btn.mask-mic', { type: 'button', title: 'לשאול בקול', 'aria-label': 'לשאול בקול' }, ['🎙']) : null;
    let rec = null;
    mic?.addEventListener('click', () => {
      if (rec) { try { rec.stop(); } catch { /* כבר עצר */ } return; }
      try {
        rec = new Recognition();
        rec.lang = 'he-IL';
        rec.interimResults = true;
        rec.continuous = false;
        let said = '';
        rec.onstart = () => mic.classList.add('is-live');
        rec.onresult = (e) => {
          said = [...e.results].map((r) => r[0].transcript).join(' ').trim();
          input.value = said;
        };
        rec.onerror = (e) => { if (e.error === 'not-allowed') UI.toast('אין הרשאה למיקרופון', 'error'); };
        rec.onend = () => {
          mic.classList.remove('is-live');
          rec = null;
          if (said) submit();
        };
        rec.start();
      } catch {
        rec = null;
      }
    });
    const form = el('form.mask-form', {}, [input, mic, attach, go, fileInput]);
    attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      for (const f of fileInput.files) {
        if (f.size > MAX_FILE) { UI.toast(`${f.name} גדול מדי (עד 12MB)`, 'error'); continue; }
        if (files.length < 3) files.push(f);
      }
      fileInput.value = '';
      drawFiles();
    });
    const drawFiles = () => UI.mount(fileChips, ...files.map((f, i) => el('span.chip', {}, [`📎 ${f.name} `, el('button.btn-link', { type: 'button', title: 'הסרה', onclick: () => { files.splice(i, 1); drawFiles(); } }, ['✕'])])));

    const content = el('div.mask', {}, [
      // במחשב, לפני השאלה הראשונה — כותרת מעל השדה, שניהם במרכז החלונית
      docked ? el('div.mask-hello', { text: '✨ מה תרצה לשאול את אשל?' }) : null,
        opts.taskTitle ? el('div.mute-sm', { text: `על המשימה: ${opts.taskTitle}` }) : null,
        form,
        fileChips,
        recentBox,
        thread,
        el('div.mute-sm.mask-foot', { text: 'המיילים שלך, סוכני המחלקות והידע הארגוני — במקום אחד. כל תשובה עם המקור; שום דבר לא נשלח בלי לחיצה. משימות ופרויקטים — בשדה החיפוש.' })
      ]);
    /*
     * בטלפון — מגירה מלמטה (מהעיגול הצף ✨): קומפקטית בגובה השאלה, וגדלה עם
     * התשובה עד כמעט כל המסך. נגררת למטה לסגירה, כמו שאר המגירות.
     */
    const m = docked ? openDock(content) : UI.sheet({ title: '✨ מה תרצה לשאול את אשל?', body: content, snap: [0.95], className: 'ask-sheet', label: 'שאל את אשל' });
    if (!docked) setTimeout(() => input.focus(), 60);
    if (docked) dock = { panel: m.panel, input, ask: (q) => { input.value = q; submit(); } };
    // פעולה מהתשובה (פתיחת משימה, מעבר ל"ממתין לאישורך"): החלון בטלפון נסגר; החלונית במחשב נשארת
    const leave = () => { if (!docked) m.close(); };

    async function loadRecent() {
      try {
        const [r, a] = await Promise.all([API.get('/api/ai/mail-ask/recent'), API.get('/api/ai/agents')]);
        if (history.length) return;
        const recent = r.recent.slice(0, 5).map((q) => el('button.chip', { type: 'button', onclick: () => { input.value = q; submit(); } }, [q.length > 40 ? `${q.slice(0, 38)}…` : q]));
        const depts = [...new Map(a.agents.map((x) => [x.deptLabel, x.deptIcon])).entries()];
        UI.mount(recentBox,
          recent.length ? el('div.mask-chips', {}, [el('span.mute-sm', { text: 'אחרונות:' }), ...recent]) : null,
          depts.length ? el('div.mute-sm', { text: `אפשר לשאול גם את הסוכנים: ${depts.map(([label, icon]) => `${icon} ${label}`).join(' · ')}` }) : null);
      } catch { /* בלי רשימה */ }
    }

    async function submit() {
      const question = input.value.trim();
      if (!question) return input.focus();
      UI.mount(recentBox);
      go.disabled = true;
      const answerBox = el('div', {}, [el('div.mute-sm', {}, [el('span.spinner-sm'), ' הסוכנים, המיילים והידע הארגוני עונים יחד…'])]);
      const turnEl = el('div.mask-turn', {}, [el('div.mask-q', { text: question }), answerBox]);
      /*
       * בחלונית שבמחשב — כמו שיחה: החדש למטה, ליד השדה שיורד לתחתית. בטלפון —
       * החדש למעלה, מתחת לשדה, כמו קודם.
       */
      if (docked) {
        thread.append(turnEl);
        content.classList.add('has-turns');
        turnEl.scrollIntoView({ block: 'end' });
      } else {
        thread.prepend(turnEl);
      }
      const sent = files;
      files = [];
      drawFiles();
      try {
        const attachments = await Promise.all(sent.map(async (f) => ({ filename: f.name, mime: f.type || 'application/octet-stream', data: await toBase64(f) })));
        const r = await API.post('/api/ai/ask', { question, history, taskId: opts.taskId ?? null, attachments });
        history.push({ q: question, a: (r.merged ? [r.agent?.text] : [r.mail?.answer, r.agent?.text]).filter(Boolean).join('\n').slice(0, 1500) });
        UI.mount(answerBox, ...answer(r, question));
        input.value = '';
        input.placeholder = 'שאלת המשך…';
      } catch (err) {
        turnEl.remove();
        if (!thread.children.length) content.classList.remove('has-turns');
        files = sent;
        drawFiles();
        UI.error(err);
      } finally {
        go.disabled = false;
        input.focus();
      }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    function answer(r, question) {
      const out = [];
      if (r.clarify && !r.agent?.text && !r.mail?.answer) out.push(el('div.mask-a', { text: r.clarify }));

      // ✨ תשובה מאוחדת — קודם; מהמיילים נשארים רק המקורות והפעולות
      const mailBox = r.merged && r.mail?.answer && r.mail.found !== false ? el('div.mask-sec', {}, [
        el('div.mask-sec-title', { text: '📧 המיילים שעליהם נשענה התשובה' }),
        r.mail.sources?.length ? el('div.mask-sources', {}, r.mail.sources.map(sourceRow)) : null,
        el('div.mask-actions', {}, mailActions(r.mail))
      ]) : null;

      // 📧 מהמיילים
      if (r.mail?.answer && !r.merged) {
        out.push(el('div.mask-sec', {}, [
          el('div.mask-sec-title', { text: '📧 מהמיילים שלך' }),
          rich(r.mail.answer, r.mail.found ? '' : '.mask-none'),
          r.mail.sources?.length ? el('div.mask-sources', {}, r.mail.sources.map(sourceRow)) : null,
          el('div.mask-actions', {}, mailActions(r.mail))
        ]));
      } else if (r.mail?.error) {
        out.push(el('div.mute-sm', { text: `📧 החיפוש במיילים לא הצליח: ${r.mail.error}` }));
      }

      // 🤖 הסוכן
      if (r.agent?.text) {
        const a = r.agent;
        out.push(el('div.mask-sec', {}, [
          el('div.mask-sec-title', { text: `${a.icon ?? '🤖'} ${a.title}` }),
          rich(a.text),
          r.contributors?.length ? el('div.mute-sm', { text: `ענו יחד: ${r.contributors.map((c) => `${c.icon ?? '🤖'} ${c.title}`).join(' · ')}` }) : null,
          a.sources?.length ? el('div.mute-sm', { text: `מקורות: ${a.sources.join(' · ')}` }) : null,
          r.failed?.length ? el('div.mute-sm', { text: `⚠️ לא ענו: ${r.failed.map((f) => f.title).join(', ')}` }) : null,
          a.proposed?.length ? el('div.alert.alert-info.ai-mini', {}, [el('span', { text: '📌' }), el('div', {}, [
            `${a.proposed.length === 1 ? 'הוצעה משימה' : `הוצעו ${a.proposed.length} משימות`}: ${a.proposed.map((p) => p.title).join(' · ')} — `,
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); leave(); App.navigate('home', {}); } }, ['לאישור ב"ממתין לאישורך"'])
          ])]) : null,
          el('div.mask-actions', {}, [
            el('button.btn.btn-sm', { type: 'button', onclick: () => { leave(); BoardView.openTaskDialog(null, { prefill: { title: question.slice(0, 120), description: `${a.text}\n\n${a.icon ?? '🤖'} ${a.title}` } }); } }, ['📌 משימה מזה']),
            copyButton(a.text)
          ])
        ]));
      } else if (r.agent?.error) {
        out.push(el('div.mute-sm', { text: `${r.agent.title ?? 'הסוכן'} לא הצליח לענות: ${r.agent.error}` }));
      }
      if (mailBox) out.push(mailBox);

      // 📚 הידע הארגוני — כשהסוכן לא כבר נשען עליו
      if (r.org?.length && !r.agent?.sources?.includes('📚 הידע הארגוני')) {
        out.push(el('div.mask-sec', {}, [
          el('div.mask-sec-title', { text: '📚 מהידע הארגוני' }),
          ...r.org.map((e) => el('div.mask-org', {}, [
            el('b', { text: e.domain }), e.project ? el('span.mute-sm', { text: ` · ${e.project}` }) : null,
            rich(e.text),
            // מקור — רק להנהלה, ורק כטקסט; לעובד — התוכן המקצועי בלבד
            e.source ? el('div.mute-sm', { text: `מקור: ${e.source}` }) : null
          ]))
        ]));
      }
      if (!out.length) out.push(el('div.mask-a.mask-none', { text: 'לא מצאתי תשובה.' }));
      return out;
    }

    /*
     * התשובה מגיעה ב-Markdown (‎**מודגש**‎, רשימות, כותרות, קישורים). בונים
     * ממנה אלמנטים — לא ‎innerHTML‎ — כך שטקסט מהמיילים לעולם אינו מתפרש כ-HTML.
     */
    function rich(text, extra = '') {
      const box = el(`div.mask-a.mask-rich${extra}`);
      let list = null;
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) { list = null; continue; }
        const h = line.match(/^#{1,4}\s+(.*)$/);
        const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (h) { list = null; box.appendChild(el('div.mask-h', {}, inline(h[1]))); continue; }
        if (li) {
          const ordered = /^\d/.test(line);
          if (!list || list.ordered !== ordered) {
            // רשימה ממוספרת שנקטעה בתת-סעיפים ממשיכה מהמספר שכתוב ("3."), לא מ-1
            list = el(ordered ? 'ol' : 'ul', ordered ? { start: String(parseInt(line, 10) || 1) } : {});
            list.ordered = ordered;
            box.appendChild(list);
          }
          list.appendChild(el('li', {}, inline(li[1])));
          continue;
        }
        list = null;
        box.appendChild(el('p', {}, inline(line)));
      }
      return box;
    }

    /** ‎**מודגש**‎ וקישורים בתוך שורה */
    function inline(text) {
      const out = [];
      const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)|((?:[a-z0-9-]+\.)+(?:gov\.il|org\.il|co\.il)(?:\/[^\s)]*)?)/gi;
      let last = 0;
      for (const m of String(text).matchAll(re)) {
        if (m.index > last) out.push(String(text).slice(last, m.index));
        if (m[1]) out.push(el('b', { text: m[1] }));
        else {
          const label = m[2] ?? m[4] ?? m[5];
          const href = m[3] ?? m[4] ?? `https://${m[5]}`;
          out.push(el('a', { href, target: '_blank', rel: 'noopener', text: label }));
        }
        last = m.index + m[0].length;
      }
      if (last < String(text).length) out.push(String(text).slice(last));
      return out.map((x) => (typeof x === 'string' ? x.replace(/\*\*/g, '') : x));
    }

    function mailActions(mail) {
      return [
        mail.actions?.task ? el('button.btn.btn-sm', { type: 'button', onclick: () => { leave(); BoardView.openTaskDialog(null, { prefill: { title: mail.actions.task, description: `${mail.answer}\n\n📧 מתוך המיילים: "${mail.question}"` } }); } }, ['📌 משימה מזה']) : null,
        mail.actions?.contact ? el('button.btn.btn-sm', {
          type: 'button',
          onclick: () => { leave(); AiTaskView.openDialog({ instruction: '', contact: { name: mail.actions.contact.name, email: mail.actions.contact.email, phone: mail.actions.contact.phone }, contactFromSystem: true }); }
        }, [`✨ פנייה ל${mail.actions.contact.name}`]) : null,
        mail.actions?.reply ? replyButton(mail.actions.reply) : null,
        copyButton(mail.answer)
      ];
    }

    function copyButton(text) {
      const b = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, ['📋 העתק']);
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); UI.success('הועתק'); } catch { UI.toast('ההעתקה לא הצליחה', 'error'); }
      });
      return b;
    }

    function sourceRow(s) {
      return el('div.mask-src', {}, [
        el('span', { text: ICON[s.type] ?? '📧' }),
        el('div.mask-src-main', {}, [
          el('b', { text: s.type === 'mail' ? (s.from || s.fromEmail) : s.type === 'doc' ? (s.filename || s.subject) : s.subject }),
          s.dateLabel ? el('span.mute-sm', { text: ` · ${s.dateLabel}` }) : null,
          el('div.mute-sm', { text: s.type === 'mail' ? s.subject : s.type === 'doc' ? s.subject : s.summary ?? '' })
        ]),
      ]);
    }

    /*
     * ↩︎ תשובה למייל — שתי דרכים לטיוטה:
     *   💡 הצע תשובה — העוזר מציע לבד, לפי המייל, איך ענית לשולח בעבר, זיכרון
     *      העבודה והידע הארגוני; מה שלא נמצא נשאר בסוגריים "[מועד]".
     *   ✍️ נסח — לפי מה שכתבת ב"מה לענות".
     * אחר כך עריכה, ושליחה רק בלחיצה.
     */
    function replyButton(src) {
      const b = el('button.btn.btn-sm', { type: 'button' }, ['↩︎ תשובה במייל']);
      b.addEventListener('click', () => {
        const what = el('textarea', { rows: '2', placeholder: 'מה לענות? למשל: שנאשר ונשלח עד יום חמישי — או "💡 הצע תשובה" והעוזר יציע לבד' });
        const bodyBox = el('textarea', { rows: '7', style: { display: 'none' } });
        const note = el('div.mask-suggest-note', { style: { display: 'none' } });
        const suggestBtn = el('button.btn.btn-primary', { type: 'button', title: 'לפי המייל, התשובות הקודמות שלך לשולח, זיכרון העבודה והידע הארגוני' }, ['💡 הצע תשובה']);
        const draftBtn = el('button.btn', { type: 'button' }, ['✍️ נסח לפי מה שכתבתי']);
        const send = el('button.btn.btn-primary', { type: 'button', style: { display: 'none' } }, ['📧 שליחה']);
        const dm = UI.modal({
          title: `↩︎ תשובה ל${src.to}`,
          body: el('div', {}, [el('div.mute-sm', { text: src.subject }), UI.field('מה לענות', what), note, bodyBox]),
          footer: [suggestBtn, draftBtn, send, el('div.spacer'), el('button.btn', { onclick: () => dm.close() }, ['ביטול'])]
        });
        suggestBtn.addEventListener('click', async () => {
          suggestBtn.disabled = true;
          draftBtn.disabled = true;
          const label = suggestBtn.textContent;
          suggestBtn.textContent = '💡 מציע…';
          try {
            const d = await API.post('/api/ai/mail-ask/reply/suggest', { gmailId: src.gmailId, box: src.box ?? 0 });
            bodyBox.value = d.body;
            bodyBox.style.display = '';
            send.style.display = '';
            UI.mount(note,
              d.basis?.length ? el('div.mute-sm', { text: `💡 לפי: ${d.basis.join(' · ')}` }) : el('div.mute-sm', { text: '💡 הצעה לפי המייל עצמו — לא נמצאו תשובות קודמות או ידע רלוונטי.' }),
              d.missing ? el('div.alert.alert-warn.ai-mini', {}, [el('span', { text: '⚠️' }), el('div', { text: d.missing })]) : null);
            note.style.display = '';
            suggestBtn.textContent = '💡 הצע שוב';
          } catch (err) { suggestBtn.textContent = label; UI.error(err); } finally { suggestBtn.disabled = false; draftBtn.disabled = false; }
        });
        draftBtn.addEventListener('click', async () => {
          if (!what.value.trim()) return what.focus();
          draftBtn.disabled = true;
          try {
            note.style.display = 'none';
            const d = await API.post('/api/ai/mail-ask/reply/draft', { gmailId: src.gmailId, box: src.box ?? 0, request: what.value.trim() });
            bodyBox.value = d.body;
            bodyBox.style.display = '';
            send.style.display = '';
            draftBtn.textContent = '✍️ נסח מחדש לפי מה שכתבתי';
          } catch (err) { UI.error(err); } finally { draftBtn.disabled = false; }
        });
        send.addEventListener('click', async () => {
          if (!bodyBox.value.trim()) return bodyBox.focus();
          send.disabled = true;
          try {
            await API.post('/api/ai/mail-ask/reply/send', { gmailId: src.gmailId, box: src.box ?? 0, body: bodyBox.value.trim() });
            dm.close();
            UI.success('התשובה נשלחה מתיבת ה-Gmail שלך');
          } catch (err) { send.disabled = false; UI.error(err); }
        });
      });
      return b;
    }

    loadRecent();
    if (opts.question) { input.value = opts.question; submit(); } else setTimeout(() => input.focus(), 50);
  }

  return { open };
})();

// השם הקודם — מכרטיס המשימה ומהחיפוש
const MailAskView = AskView;
