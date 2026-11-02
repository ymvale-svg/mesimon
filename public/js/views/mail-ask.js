'use strict';
/**
 * ✨ שאל — שאלה חופשית אחת, תשובה מכל מה שהעוזר יודע. נפתח מהחיפוש העליון
 * (Ctrl+K), מכרטיס משימה, ומהעוזר.
 *
 * הסדר בתשובה:
 *   📋 משימות ופרויקטים בעניין — מהחיפוש הקיים, לפי מילות המפתח של השאלה
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
    const history = [];
    let files = [];
    const thread = el('div.mask-thread');
    const input = el('input', { type: 'text', placeholder: 'שאלה חופשית — "כמה מס רכישה על 2.4 מיליון?", "מה סיכמנו עם העירייה?"', maxlength: '1000', 'aria-label': 'השאלה' });
    const go = el('button.btn.btn-primary', { type: 'submit' }, ['✨ שאל']);
    const fileInput = el('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv', style: { display: 'none' } });
    const attach = el('button.btn', { type: 'button', title: 'לצרף מסמך — קבלה, נסח טאבו, מכתב, קורות חיים' }, ['📎']);
    const fileChips = el('div.mask-chips');
    const recentBox = el('div.mask-recent');
    const form = el('form.mask-form', {}, [input, attach, go, fileInput]);
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

    const m = UI.modal({
      title: '✨ שאל',
      size: 'wide',
      body: el('div.mask', {}, [
        opts.taskTitle ? el('div.mute-sm', { text: `על המשימה: ${opts.taskTitle}` }) : null,
        form,
        fileChips,
        recentBox,
        thread,
        el('div.mute-sm.mask-foot', { text: 'משימות, המיילים שלך, סוכני המחלקות והידע הארגוני — במקום אחד. כל תשובה עם המקור; שום דבר לא נשלח בלי לחיצה.' })
      ])
    });

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
      const tasksBox = el('div');
      const answerBox = el('div', {}, [el('div.mute-sm', {}, [el('span.spinner-sm'), ' מחפש במיילים, בסוכנים ובידע הארגוני…'])]);
      const turnEl = el('div.mask-turn', {}, [el('div.mask-q', { text: question }), tasksBox, answerBox]);
      thread.prepend(turnEl);
      const sent = files;
      files = [];
      drawFiles();
      try {
        const attachments = await Promise.all(sent.map(async (f) => ({ filename: f.name, mime: f.type || 'application/octet-stream', data: await toBase64(f) })));
        const r = await API.post('/api/ai/ask', { question, history, taskId: opts.taskId ?? null, attachments });
        history.push({ q: question, a: [r.mail?.answer, r.agent?.text].filter(Boolean).join('\n').slice(0, 1500) });
        // משימות בעניין — ראשונות, מהחיפוש הקיים
        tasksSection(r.keywords, tasksBox);
        UI.mount(answerBox, ...answer(r, question));
        input.value = '';
        input.placeholder = 'שאלת המשך…';
      } catch (err) {
        turnEl.remove();
        files = sent;
        drawFiles();
        UI.error(err);
      } finally {
        go.disabled = false;
        input.focus();
      }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    async function tasksSection(keywords, box) {
      const seen = new Map();
      for (const k of (keywords ?? []).slice(0, 3)) {
        try {
          const res = await API.get(`/api/search?q=${encodeURIComponent(k)}`);
          for (const x of res.results ?? []) if (!seen.has(`${x.type}:${x.id}`)) seen.set(`${x.type}:${x.id}`, x);
        } catch { /* בלי משימות */ }
      }
      const items = [...seen.values()].slice(0, 6);
      if (!items.length) return;
      UI.mount(box, el('div.mask-sec', {}, [
        el('div.mask-sec-title', { text: '📋 משימות ופרויקטים בעניין' }),
        ...items.map((x) => el('button.mask-item', {
          type: 'button',
          onclick: () => { m.close(); if (x.type === 'task') TaskCardView.open(x.id); else App.navigate('board', { projectId: x.id }); }
        }, [el('span', { text: x.type === 'task' ? '📋' : '📁' }), el('b', { text: x.title }), x.subtitle ? el('span.mute-sm', { text: ` · ${x.subtitle}` }) : null]))
      ]));
    }

    function answer(r, question) {
      const out = [];
      if (r.clarify && !r.agent?.text && !r.mail?.answer) out.push(el('div.mask-a', { text: r.clarify }));

      // 📧 מהמיילים
      if (r.mail?.answer) {
        out.push(el('div.mask-sec', {}, [
          el('div.mask-sec-title', { text: '📧 מהמיילים שלך' }),
          el(`div.mask-a${r.mail.found ? '' : '.mask-none'}`, { text: r.mail.answer }),
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
          el('div.mask-a', { text: a.text }),
          a.sources?.length ? el('div.mute-sm', { text: `מקורות: ${a.sources.join(' · ')}` }) : null,
          a.proposed?.length ? el('div.alert.alert-info.ai-mini', {}, [el('span', { text: '📌' }), el('div', {}, [
            `${a.proposed.length === 1 ? 'הוצעה משימה' : `הוצעו ${a.proposed.length} משימות`}: ${a.proposed.map((p) => p.title).join(' · ')} — `,
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); m.close(); App.navigate('home', {}); } }, ['לאישור ב"ממתין לאישורך"'])
          ])]) : null,
          el('div.mask-actions', {}, [
            el('button.btn.btn-sm', { type: 'button', onclick: () => { m.close(); BoardView.openTaskDialog(null, { prefill: { title: question.slice(0, 120), description: `${a.text}\n\n${a.icon ?? '🤖'} ${a.title}` } }); } }, ['📌 משימה מזה']),
            copyButton(a.text)
          ])
        ]));
      } else if (r.agent?.error) {
        out.push(el('div.mute-sm', { text: `${r.agent.title ?? 'הסוכן'} לא הצליח לענות: ${r.agent.error}` }));
      }

      // 📚 הידע הארגוני — כשהסוכן לא כבר נשען עליו
      if (r.org?.length && !r.agent?.sources?.includes('📚 הידע הארגוני')) {
        out.push(el('div.mask-sec', {}, [
          el('div.mask-sec-title', { text: '📚 מהידע הארגוני' }),
          ...r.org.map((e) => el('div.mask-org', {}, [
            el('b', { text: e.domain }), e.project ? el('span.mute-sm', { text: ` · ${e.project}` }) : null,
            el('div.mask-a', { text: e.text }),
            el('div.mute-sm', { text: `${e.cases ? `${e.cases} מקרים · ` : ''}עודכן ${new Date(e.updatedAt).toLocaleDateString('he-IL')}` })
          ]))
        ]));
      }
      if (!out.length) out.push(el('div.mask-a.mask-none', { text: 'לא מצאתי תשובה.' }));
      return out;
    }

    function mailActions(mail) {
      return [
        mail.actions?.task ? el('button.btn.btn-sm', { type: 'button', onclick: () => { m.close(); BoardView.openTaskDialog(null, { prefill: { title: mail.actions.task, description: `${mail.answer}\n\n📧 מתוך המיילים: "${mail.question}"` } }); } }, ['📌 משימה מזה']) : null,
        mail.actions?.contact ? el('button.btn.btn-sm', {
          type: 'button',
          onclick: () => { m.close(); AiTaskView.openDialog({ instruction: '', contact: { name: mail.actions.contact.name, email: mail.actions.contact.email, phone: mail.actions.contact.phone }, contactFromSystem: true }); }
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
        s.link ? el('a.btn.btn-sm.btn-ghost', { href: s.link, target: '_blank', rel: 'noopener' }, ['פתח ב-Gmail']) : null
      ]);
    }

    /** ↩︎ תשובה למייל: מה לענות → טיוטה → עריכה → שליחה, רק בלחיצה */
    function replyButton(src) {
      const b = el('button.btn.btn-sm', { type: 'button' }, ['↩︎ תשובה במייל']);
      b.addEventListener('click', () => {
        const what = el('textarea', { rows: '2', placeholder: 'מה לענות? למשל: שנאשר ונשלח עד יום חמישי' });
        const bodyBox = el('textarea', { rows: '7', style: { display: 'none' } });
        const draftBtn = el('button.btn.btn-primary', { type: 'button' }, ['✍️ נסח']);
        const send = el('button.btn.btn-primary', { type: 'button', style: { display: 'none' } }, ['📧 שליחה']);
        const dm = UI.modal({
          title: `↩︎ תשובה ל${src.to}`,
          body: el('div', {}, [el('div.mute-sm', { text: src.subject }), UI.field('מה לענות', what), bodyBox]),
          footer: [draftBtn, send, el('div.spacer'), el('button.btn', { onclick: () => dm.close() }, ['ביטול'])]
        });
        draftBtn.addEventListener('click', async () => {
          if (!what.value.trim()) return what.focus();
          draftBtn.disabled = true;
          try {
            const d = await API.post('/api/ai/mail-ask/reply/draft', { gmailId: src.gmailId, request: what.value.trim() });
            bodyBox.value = d.body;
            bodyBox.style.display = '';
            send.style.display = '';
            draftBtn.textContent = '✍️ נסח מחדש';
          } catch (err) { UI.error(err); } finally { draftBtn.disabled = false; }
        });
        send.addEventListener('click', async () => {
          if (!bodyBox.value.trim()) return bodyBox.focus();
          send.disabled = true;
          try {
            await API.post('/api/ai/mail-ask/reply/send', { gmailId: src.gmailId, body: bodyBox.value.trim() });
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
