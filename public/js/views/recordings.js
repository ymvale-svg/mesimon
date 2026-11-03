'use strict';
/**
 * 🎥 הקלטות Zoom — ההקלטות בענן של חשבונות ה-Zoom של החברה.
 *
 * מי שמנהל משתמשים רואה את כל ההקלטות; עובד אחר — של משתמש ה-Zoom המשויך
 * לו ושל פגישות משימון שלו (השרת מסנן). חודש בכל פעם, עם חיפוש.
 *
 * צפייה בקובץ נפתחת דרך השרת (‎/api/zoom/recordings/file‎), שמפנה לכתובת
 * חתומה של Zoom — כך שאסימון החשבון לא מגיע לדפדפן.
 */

const RecordingsView = (() => {
  const { el } = UI;

  let containerRef = null;
  let data = null;
  const view = { month: new Date(), q: '' };

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthRange = () => {
    const a = new Date(view.month.getFullYear(), view.month.getMonth(), 1);
    const b = new Date(view.month.getFullYear(), view.month.getMonth() + 1, 0);
    return { from: ymd(a), to: ymd(b) };
  };

  const FILE_BUTTONS = {
    video: '▶ צפייה',
    audio: '🎧 שמע',
    transcript: '📝 תמליל',
    chat: '💬 צ׳אט',
    summary: '📋 סיכום'
  };
  const VIEW_LABEL = {
    shared_screen_with_speaker_view: 'מסך + דובר',
    shared_screen_with_gallery_view: 'מסך + גלריה',
    shared_screen: 'מסך משותף',
    speaker_view: 'דובר',
    gallery_view: 'גלריה',
    active_speaker: 'דובר',
    audio_only: ''
  };

  async function render(container) {
    containerRef = container;
    await load();
  }

  async function load() {
    if (!containerRef) return;
    UI.mount(containerRef, el('div.rec', {}, [head(), UI.spinner()]));
    const { from, to } = monthRange();
    try {
      data = await API.get(`/api/zoom/recordings?from=${from}&to=${to}`);
    } catch (err) {
      data = { recordings: [], errors: [err.message] };
    }
    draw();
  }

  const reload = () => (containerRef?.isConnected ? load() : Promise.resolve());

  function shiftMonth(n) {
    view.month = new Date(view.month.getFullYear(), view.month.getMonth() + n, 1);
    load();
  }

  function head() {
    const title = view.month.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    const search = el('input', { type: 'search', placeholder: 'חיפוש לפי נושא או מארח…', value: view.q, style: { width: '220px' } });
    search.addEventListener('input', () => { view.q = search.value; drawList(); });
    return el('div.cal-head', {}, [
      el('h2', { text: '🎥 הקלטות Zoom' }),
      el('button.btn.btn-sm', { title: 'החודש הקודם', onclick: () => shiftMonth(-1) }, ['▶']),
      el('b.cal-title', { text: title }),
      el('button.btn.btn-sm', { title: 'החודש הבא', onclick: () => shiftMonth(1) }, ['◀']),
      el('button.btn.btn-sm', { onclick: () => { view.month = new Date(); load(); } }, ['החודש']),
      el('div.spacer'),
      search,
      el('button.btn.btn-sm', { title: 'רענון', onclick: () => load() }, ['⟳'])
    ]);
  }

  let listBox = null;

  function draw() {
    listBox = el('div.rec-list');
    UI.mount(containerRef, el('div.rec', {}, [
      head(),
      ...(data.errors ?? []).map((e) => el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: e })])),
      listBox
    ]));
    drawList();
  }

  function drawList() {
    if (!listBox) return;
    const q = view.q.trim().toLowerCase();
    const list = (data.recordings ?? []).filter((r) => !q
      || r.topic.toLowerCase().includes(q)
      || r.host.name.toLowerCase().includes(q)
      || r.host.email.includes(q)
      || (r.meeting?.title ?? '').toLowerCase().includes(q));
    if (!list.length) {
      UI.mount(listBox, UI.empty(q ? 'אין הקלטות שמתאימות לחיפוש' : 'אין הקלטות בענן בחודש הזה', '🎥'));
      return;
    }
    UI.mount(listBox, ...list.map(card));
  }

  /**
   * הכפתורים של הקלטה: וידאו אחד מוצג כ"צפייה", וכשיש כמה תצוגות — כל אחת
   * עם שמה; שמע, תמליל, צ'אט; וקישור השיתוף של Zoom. משותף גם לכרטיס הפגישה.
   */
  function actions(r) {
    const videos = r.files.filter((f) => f.kind === 'video');
    const others = r.files.filter((f) => f.kind !== 'video' && FILE_BUTTONS[f.kind]);
    const fileButton = (f, label) => el('button.btn.btn-sm', {
      disabled: !f.ready,
      title: f.ready ? `${f.type}${f.size ? ` · ${UI.fileSize(f.size)}` : ''}` : 'Zoom עוד מעבד את הקובץ',
      onclick: () => window.open(`/api/zoom/recordings/file?uuid=${encodeURIComponent(r.uuid)}&file=${encodeURIComponent(f.id)}`, '_blank', 'noopener')
    }, [f.ready ? label : `${label} (בעיבוד)`]);
    return [
      ...videos.map((f) => fileButton(f, videos.length > 1 && VIEW_LABEL[f.view] ? `▶ ${VIEW_LABEL[f.view]}` : FILE_BUTTONS.video)),
      ...others.map((f) => fileButton(f, FILE_BUTTONS[f.kind])),
      r.shareUrl ? el('button.btn.btn-sm', {
        title: 'קישור הצפייה של Zoom — אפשר לשלוח למי שלא במשימון',
        onclick: async () => {
          const text = r.passcode ? `${r.shareUrl}\nקוד: ${r.passcode}` : r.shareUrl;
          try { await navigator.clipboard.writeText(text); UI.success('הקישור הועתק'); } catch { UI.prompt('העתיקו את הקישור', { title: 'קישור ההקלטה', value: text, multiline: true, okText: 'סגירה' }); }
        }
      }, ['🔗 העתקת קישור']) : null
    ];
  }

  function card(r) {
    const when = new Date(r.start);
    const date = when.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
    const time = when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
    const size = r.files.reduce((n, f) => n + f.size, 0);

    return el('div.card.rec-card', {}, [
      el('div.rec-top', {}, [
        el('b', { text: r.topic || 'פגישת Zoom' }),
        el('span.mute-sm', { text: ` · ${date} ${time}${r.minutes ? ` · ${r.minutes} דק׳` : ''}` })
      ]),
      el('div.mute-sm', {}, [
        `מארח: ${r.host.name}`,
        size ? ` · ${UI.fileSize(size)}` : '',
        r.meeting ? ` · פגישת משימון: ${r.meeting.title}` : ''
      ]),
      el('div.rec-actions', {}, [
        ...actions(r),
        r.task ? el('button.btn.btn-sm', { onclick: () => TaskCardView.open(r.task.id) }, ['פתיחת המשימה']) : null
      ])
    ]);
  }

  return { render, reload, actions };
})();
