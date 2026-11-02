'use strict';
/**
 * 🔎 שאל את המיילים — שאלה חופשית על כל היסטוריית התיבה, ותשובה מתוך המיילים
 * עם המקורות. נפתח מהחיפוש העליון (Ctrl+K), מכרטיס משימה, ומהעוזר.
 *
 * אותו חלון ממשיך את השיחה: "ומה הוא לקח לפני זה?" נשלח עם השאלות הקודמות.
 * ליד התשובה — פעולות קיימות בלבד: משימה, משימת AI, תשובה במייל (באישור), העתקה.
 */

const MailAskView = (() => {
  const { el } = UI;
  const ICON = { mail: '📧', memory: '🧠', doc: '📎' };

  /**
   * @param {object} [opts]
   * @param {string} [opts.question]  שאלה לשלוח מיד
   * @param {number} [opts.taskId]    מכרטיס משימה — הכותרת והתיאור הם ההקשר
   * @param {string} [opts.taskTitle]
   */
  async function open(opts = {}) {
    const history = [];
    const thread = el('div.mask-thread');
    const input = el('input', { type: 'text', placeholder: 'למשל: כמה ליוניד לקח על תיקון המזגן?', maxlength: '500', 'aria-label': 'השאלה' });
    const go = el('button.btn.btn-primary', { type: 'submit' }, ['🔎 שאל']);
    const recentBox = el('div.mask-recent');
    const form = el('form.mask-form', {}, [input, go]);

    const m = UI.modal({
      title: '🔎 שאל את המיילים',
      size: 'wide',
      body: el('div.mask', {}, [
        opts.taskTitle ? el('div.mute-sm', { text: `על המשימה: ${opts.taskTitle}` }) : null,
        form,
        recentBox,
        thread,
        el('div.mute-sm.mask-foot', { text: 'רק התיבה שלך. התשובה מבוססת על המיילים, זיכרון העבודה והמסמכים — עם קישור לכל מקור.' })
      ])
    });

    async function loadRecent() {
      try {
        const r = await API.get('/api/ai/mail-ask/recent');
        if (!r.available) {
          UI.mount(recentBox, el('div.alert.alert-warn', {}, [el('span', { text: '📭' }), el('div', {}, [
            'כדי לחפש במיילים צריך לחבר את תיבת ה-Gmail. ',
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); m.close(); AiInboxView.openGmail(); } }, ['לחיבור'])
          ])]));
          go.disabled = true;
          return;
        }
        if (!r.recent.length || history.length) return UI.mount(recentBox);
        const clear = el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'מחיקת השאלות האחרונות' }, ['ניקוי']);
        clear.addEventListener('click', async () => { try { await API.del('/api/ai/mail-ask/recent'); UI.mount(recentBox); } catch (err) { UI.error(err); } });
        UI.mount(recentBox, el('div.mask-chips', {}, [
          el('span.mute-sm', { text: 'אחרונות:' }),
          ...r.recent.slice(0, 6).map((q) => el('button.chip', { type: 'button', onclick: () => { input.value = q; submit(); } }, [q.length > 40 ? `${q.slice(0, 38)}…` : q])),
          clear
        ]));
      } catch { /* בלי רשימה */ }
    }

    async function submit() {
      const question = input.value.trim();
      if (!question) return input.focus();
      UI.mount(recentBox);
      go.disabled = true;
      const pending = el('div.mask-turn', {}, [el('div.mask-q', { text: question }), el('div.mute-sm', {}, [el('span.spinner-sm'), ' מחפש בתיבה…'])]);
      thread.prepend(pending);
      try {
        const r = await API.post('/api/ai/mail-ask', { question, history, taskId: opts.taskId ?? null });
        history.push({ q: question, a: r.answer });
        pending.replaceWith(turn(r));
        input.value = '';
        input.placeholder = 'שאלת המשך…';
      } catch (err) {
        pending.remove();
        UI.error(err);
      } finally {
        go.disabled = false;
        input.focus();
      }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    function turn(r) {
      const copy = el('button.btn.btn-sm.btn-ghost', { type: 'button' }, ['📋 העתק']);
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.answer); UI.success('הועתק'); } catch { UI.toast('ההעתקה לא הצליחה', 'error'); }
      });
      const actions = [
        r.actions.task
          ? el('button.btn.btn-sm', { type: 'button', onclick: () => { m.close(); BoardView.openTaskDialog(null, { prefill: { title: r.actions.task, description: `${r.answer}\n\n🔎 מתוך המיילים: "${r.question}"` } }); } }, ['📌 משימה מזה'])
          : null,
        r.actions.contact
          ? el('button.btn.btn-sm', {
              type: 'button',
              onclick: () => { m.close(); AiTaskView.openDialog({ instruction: '', contact: { name: r.actions.contact.name, email: r.actions.contact.email, phone: r.actions.contact.phone } }); }
            }, [`✨ פנייה ל${r.actions.contact.name}`])
          : null,
        r.actions.reply ? replyButton(r.actions.reply) : null,
        copy
      ];
      return el('div.mask-turn', {}, [
        el('div.mask-q', { text: r.question }),
        el(`div.mask-a${r.found ? '' : '.mask-none'}`, { text: r.answer || 'לא מצאתי.' }),
        r.sources.length ? el('div.mask-sources', {}, r.sources.map(sourceRow)) : null,
        el('div.mute-sm', { text: `נבדקו ${r.searched.mails} מיילים${r.searched.memory ? `, ${r.searched.memory} רשומות זיכרון` : ''}${r.searched.docs ? `, ${r.searched.docs} מסמכים` : ''}` }),
        el('div.mask-actions', {}, actions)
      ]);
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
