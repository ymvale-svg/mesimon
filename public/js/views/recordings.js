'use strict';
/**
 * 🎥 הפגישות שלי — הקלטות פגישות ה-Zoom, הסיכומים, והמשימות שעלו בהן.
 *
 * לכל עובד: הפגישות שהיו (עם הקלטה, סיכום ומה שמחכה לאישורו), והפגישות
 * הקרובות שהמקליט ייכנס אליהן — עם "לא להקליט". למעלה — ההגדרה האישית:
 * להקליט את הפגישות שלי או לא.
 *
 * ‎open(id)‎ — חלון הפגישה: נגן, סיכום, החלטות, משימות ותמלול. נפתח גם
 * מ-Today ("📝 סיכום") ומההתראה.
 */

const RecordingsView = (() => {
  const { el } = UI;

  let containerRef = null;
  let data = null;
  let filter = '';

  const day = (iso) => new Date(iso).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const STATUS_CLASS = { done: 'ok', recording: 'live', joining: 'live', processing: 'wait', scheduled: 'wait', failed: 'bad', skipped: 'mute', cancelled: 'mute' };

  async function render(container) {
    containerRef = container;
    UI.mount(container, UI.spinner());
    try {
      data = await API.get('/api/recordings');
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    draw();
  }

  const reload = () => (containerRef?.isConnected ? render(containerRef) : Promise.resolve());

  function draw() {
    const search = el('input', { type: 'search', placeholder: 'חיפוש פגישה…', value: filter });
    search.addEventListener('input', () => { filter = search.value; drawLists(); });
    const lists = el('div');

    function drawLists() {
      const q = filter.trim();
      const match = (r) => !q || r.title.includes(q) || (r.headline ?? '').includes(q);
      const past = data.past.filter(match);
      const upcoming = data.upcoming.filter(match);
      UI.mount(lists, el('div', {}, [
        upcoming.length ? el('div.card.mb', {}, [
          el('div.card-head', {}, [el('h3', { text: '⏳ קרובות — המקליט ייכנס' })]),
          el('div.rec-rows', {}, upcoming.map(upcomingRow))
        ]) : null,
        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: '🎥 פגישות שהוקלטו' })]),
          past.length
            ? el('div.rec-rows', {}, past.map(pastRow))
            : UI.empty(q ? 'אין פגישה שמתאימה לחיפוש' : 'עוד אין פגישות מוקלטות. פגישת Zoom ביומן שלך תוקלט ותסוכם כאן.', '🎥')
        ])
      ]));
    }

    UI.mount(containerRef, el('div.recordings-page', {}, [
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: '🎥 הפגישות שלי' }),
          el('div.sub', { text: 'כל פגישת Zoom ביומן — מוקלטת, נשמרת בדרייב של החברה ומסוכמת. המשימות שעלו בה מחכות לאישורך.' })
        ]),
        el('div.spacer'),
        prefToggle()
      ]),
      data.enabled ? null : el('div.alert.alert-warn.mb', {}, [el('span', { text: '⚠️' }), el('div', { text: 'המקליט כבוי כרגע במערכת — פגישות חדשות אינן מוקלטות. מנהל המערכת מפעיל אותו ב"ניהול המערכת".' })]),
      el('div.mb.rec-search', {}, [search]),
      lists
    ]));
    drawLists();
  }

  function prefToggle() {
    const box = el('input', { type: 'checkbox', checked: data.recordMeetings });
    box.addEventListener('change', async () => {
      try {
        const r = await API.put('/api/recordings/prefs', { recordMeetings: box.checked });
        data.recordMeetings = r.recordMeetings;
        UI.success(r.recordMeetings ? 'הפגישות שלך יוקלטו ויסוכמו' : 'הפגישות שלך לא יוקלטו מעכשיו');
      } catch (err) {
        box.checked = !box.checked;
        UI.error(err);
      }
    });
    return el('label.checkbox.rec-pref', { title: 'כבוי = המקליט לא ייכנס לאף פגישה שאת/ה משתתף/ת בה' }, [box, ' להקליט ולסכם את הפגישות שלי']);
  }

  const badge = (r) => el(`span.rec-badge.rec-${STATUS_CLASS[r.status] ?? 'mute'}`, { text: r.statusLabel });

  function pastRow(r) {
    return el('div.rec-row', { onclick: () => open(r.id) }, [
      el('div.rec-when', {}, [el('b', { text: day(r.start) }), el('span.mute-sm', { text: hhmm(r.start) })]),
      el('div.rec-main', {}, [
        el('div.rec-title', {}, [r.title, ' ', badge(r)]),
        r.headline ? el('div.rec-headline', { text: r.headline }) : r.error ? el('div.mute-sm', { text: r.error }) : null
      ]),
      el('div.rec-flags', {}, [
        r.myTasks ? el('span.ai-chip', { text: `✋ ${r.myTasks} משימות שלך` }) : null,
        r.hasVideo ? el('span', { title: 'יש הקלטה', text: '▶' }) : null
      ])
    ]);
  }

  function upcomingRow(r) {
    const actions = [];
    if (r.canSkip) {
      const b = el('button.btn.btn-sm', { title: 'המקליט לא ייכנס לפגישה הזו. המשתתפים האחרים מהחברה יקבלו הודעה' }, ['🚫 לא להקליט']);
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        b.disabled = true;
        try { await API.post(`/api/recordings/${r.id}/skip`); UI.success('המקליט לא ייכנס לפגישה'); await reload(); } catch (err) { b.disabled = false; UI.error(err); }
      });
      actions.push(b);
    }
    if (r.canRestore) {
      const b = el('button.btn.btn-sm', {}, ['↩ כן להקליט']);
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        b.disabled = true;
        try { await API.post(`/api/recordings/${r.id}/restore`); await reload(); } catch (err) { b.disabled = false; UI.error(err); }
      });
      actions.push(b);
    }
    if (r.joinUrl) actions.push(el('a.btn.btn-sm', { href: r.joinUrl, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, ['🎥 הצטרפות']));
    return el('div.rec-row', {}, [
      el('div.rec-when', {}, [el('b', { text: day(r.start) }), el('span.mute-sm', { text: hhmm(r.start) })]),
      el('div.rec-main', {}, [
        el('div.rec-title', {}, [r.title, ' ', badge(r)]),
        r.status === 'skipped' && r.error ? el('div.mute-sm', { text: r.error }) : null
      ]),
      el('div.rec-flags', {}, actions)
    ]);
  }

  // ------------------------------------------------------------- חלון הפגישה

  async function open(id) {
    let rec;
    try {
      ({ recording: rec } = await API.get(`/api/recordings/${id}`));
    } catch (err) {
      return UI.error(err);
    }
    const body = el('div.rec-detail');
    const m = UI.modal({ title: `🎥 ${rec.title}`, size: 'wide', body });
    const redraw = async () => {
      try { ({ recording: rec } = await API.get(`/api/recordings/${id}`)); } catch { /* מה שיש */ }
      fill();
    };

    function fill() {
      const s = rec.summary;
      UI.mount(body, el('div', {}, [
        el('div.mute-sm.mb', {}, [
          `${day(rec.start)} · ${hhmm(rec.start)} עד ${hhmm(rec.end)}`,
          rec.participants.length ? ` · ${rec.participants.map((p) => p.name).join(', ')}` : '',
          ' · ', badge(rec)
        ]),
        rec.hasVideo
          ? el('video.rec-video', { controls: true, preload: 'metadata', src: `/api/recordings/${rec.id}/video` })
          : el('div.alert.mb', {}, [el('span', { text: rec.status === 'failed' ? '⚠️' : '⏳' }), el('div', {
            text: rec.status === 'failed' ? `הפגישה לא הוקלטה: ${rec.error}` : rec.status === 'skipped' ? `לא הוקלטה: ${rec.error}` : 'ההקלטה בעיבוד — תופיע כאן בדקות הקרובות'
          })]),
        el('div.rec-links', {}, [
          rec.driveLink ? el('a.btn.btn-sm', { href: rec.driveLink, target: '_blank', rel: 'noopener' }, ['📁 בדרייב של החברה']) : null,
          rec.hasTranscript ? el('a.btn.btn-sm', { href: `/api/recordings/${rec.id}/transcript` }, ['⬇ התמלול']) : null,
          (!s && rec.hasTranscript) || (rec.status === 'failed' && rec.error) ? retryButton() : null
        ]),
        s ? summaryBlock(s) : rec.hasTranscript ? el('div.mute-sm', { text: 'הסיכום עוד לא מוכן.' }) : null,
        rec.hasTranscript ? transcriptBlock() : null
      ]));
    }

    function retryButton() {
      const b = el('button.btn.btn-sm', {}, ['⟳ ניסיון חוזר']);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { ({ recording: rec } = await API.post(`/api/recordings/${rec.id}/retry`)); fill(); UI.success('בוצע'); } catch (err) { b.disabled = false; UI.error(err); }
      });
      return b;
    }

    function summaryBlock(s) {
      return el('div.rec-summary', {}, [
        el('h4', { text: '📝 סיכום' }),
        el('p', { text: s.text }),
        s.decisions.length ? el('div', {}, [el('h4', { text: '✅ הוחלט' }), el('ul', {}, s.decisions.map((d) => el('li', { text: d })))]) : null,
        s.actionItems.length ? el('div', {}, [el('h4', { text: '📌 משימות' }), el('div.rec-items', {}, s.actionItems.map(itemRow))]) : null,
        s.openQuestions.length ? el('div', {}, [el('h4', { text: '❓ נשאר פתוח' }), el('ul', {}, s.openQuestions.map((d) => el('li', { text: d })))]) : null
      ]);
    }

    function itemRow(it) {
      const state = it.state === 'approved' || it.state === 'auto' ? '✓ נוצרה משימה'
        : it.state === 'rejected' ? 'נדחתה' : it.state === 'duplicate' ? 'כבר קיימת' : it.state === 'pending' ? 'ממתינה לאישור' : '';
      const actions = [];
      if (it.mine && it.state === 'pending' && it.suggestionId) {
        const ok = el('button.btn.btn-sm.btn-primary', {}, ['✓ להוסיף למשימות שלי']);
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          try {
            const r = await API.post(`/api/ai/suggestions/${it.suggestionId}/approve`, {});
            UI.success('נוסף למשימות שלך');
            App.refreshNotifications?.();
            if (r.taskId) it.taskId = r.taskId;
            await redraw();
          } catch (err) { ok.disabled = false; UI.error(err); }
        });
        const edit = el('button.btn.btn-sm', { title: 'עריכה לפני ההוספה — כותרת, יעד, שותפים' }, ['✎']);
        edit.addEventListener('click', async () => {
          try {
            const inbox = await API.get('/api/ai/inbox');
            const sug = inbox.suggestions.pending.find((x) => x.id === it.suggestionId);
            if (!sug) return redraw();
            AiInbox.editSuggestion(sug, redraw);
          } catch (err) { UI.error(err); }
        });
        const no = el('button.btn.btn-sm.btn-ghost', {}, ['לא שלי']);
        no.addEventListener('click', async () => {
          no.disabled = true;
          try { await API.post(`/api/ai/suggestions/${it.suggestionId}/reject`, {}); await redraw(); } catch (err) { no.disabled = false; UI.error(err); }
        });
        actions.push(ok, edit, no);
      } else if (it.mine && it.taskId) {
        actions.push(el('button.btn.btn-sm', { onclick: () => TaskCardView.open(it.taskId) }, ['פתיחת המשימה']));
      }
      return el(`div.rec-item${it.mine ? '.is-mine' : ''}`, {}, [
        el('div.rec-item-main', {}, [
          el('b', { text: it.title }),
          el('div.mute-sm', {}, [
            it.owner ? `👤 ${it.owner}` : '👤 לא נקבע אחראי',
            it.dueDate ? ` · עד ${new Date(`${it.dueDate}T12:00:00`).toLocaleDateString('he-IL')}` : '',
            state ? ` · ${state}` : ''
          ]),
          it.details ? el('div.rec-item-details', { text: it.details }) : null,
          it.quote ? el('div.rec-quote', { text: `"${it.quote}"` }) : null
        ]),
        actions.length ? el('div.rec-item-actions', {}, actions) : null
      ]);
    }

    function transcriptBlock() {
      const box = el('div.rec-transcript', { hidden: true });
      const toggle = el('button.btn.btn-sm.btn-ghost', {}, ['📄 הצגת התמלול']);
      toggle.addEventListener('click', async () => {
        if (!box.hidden) { box.hidden = true; toggle.textContent = '📄 הצגת התמלול'; return; }
        if (!box.textContent) {
          try {
            const res = await fetch(`/api/recordings/${rec.id}/transcript`, { credentials: 'same-origin' });
            box.textContent = (await res.text()).replace(/^﻿/, '');
          } catch (err) { return UI.error(err); }
        }
        box.hidden = false;
        toggle.textContent = 'הסתרת התמלול';
      });
      return el('div.mt', {}, [toggle, box]);
    }

    fill();
    return m;
  }

  return { render, reload, open };
})();
