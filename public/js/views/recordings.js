'use strict';
/**
 * 🎥 הקלטות — לשונית במסך היומן (‎CalendarView‎). שני מקורות:
 *   • Timeless (ברירת המחדל) — הפגישות שהוקלטו ותומללו; כל אחת נפתחת בנגן
 *     (‎RecordingPlayer‎): סרטון, תמליל צמוד, סיכום מובנה ומשימות. דרך החיבור ל-Timeless (אישי, או הארגוני מהשרת — הנהלה רואה
 *     הכול, עובד רק פגישות שהשתתף בהן; הסינון בשרת, ‎server/timeless.js‎).
 *   • Zoom — ההקלטות בענן של חשבונות ה-Zoom של החברה, כשיש חיבור Zoom.
 *
 * Zoom:
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
  const view = { month: new Date(), q: '', source: null };
  const sources = { zoom: false, timeless: false };

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

  let embedded = false;

  /** ‎embedded‎ — בתוך מסך היומן, מתחת ללשוניות: בלי כותרת משלו */
  async function render(container, opts = {}) {
    containerRef = container;
    embedded = Boolean(opts.embedded);
    if (opts.zoom === undefined || opts.timeless === undefined) {
      // מסך עצמאי (לא מתוך היומן) — בודקים מה מחובר
      try {
        const info = await API.get('/api/meetings/calendars');
        opts = { ...opts, zoom: Boolean(info.zoom?.enabled), timeless: Boolean(info.timeless?.connected) };
      } catch { opts = { ...opts, zoom: false, timeless: false }; }
    }
    sources.zoom = Boolean(opts.zoom);
    sources.timeless = Boolean(opts.timeless);
    // Timeless — ברירת המחדל (גם כשעוד לא מחובר: מוצג החיבור); Zoom — כשבוחרים בו
    if (!view.source || (view.source === 'zoom' && !sources.zoom)) view.source = 'timeless';
    await load();
  }

  async function load() {
    if (!containerRef) return;
    UI.mount(containerRef, el('div.rec', {}, [head(), UI.spinner()]));
    const { from, to } = monthRange();
    if (view.source === 'timeless') {
      if (!sources.timeless) { data = { recordings: [], connect: true }; return draw(); }
      try {
        data = await API.get(`/api/timeless/recordings?from=${from}&to=${to}`);
      } catch (err) {
        data = { recordings: [], errors: [err.message] };
      }
      return draw();
    }
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
    const search = el('input', { type: 'search', placeholder: view.source === 'timeless' ? 'חיפוש לפי נושא או משתתף…' : 'חיפוש לפי נושא או מארח…', value: view.q, style: { width: '220px' } });
    search.addEventListener('input', () => { view.q = search.value; drawList(); });
    return el('div.cal-head', {}, [
      embedded ? null : el('h2', { text: '🎥 הקלטות' }),
      // המקור — רק כשיש גם Zoom
      sources.zoom ? el('div.seg', {}, [['timeless', 'Timeless'], ['zoom', 'Zoom']].map(([k, label]) =>
        el(`button${view.source === k ? '.active' : ''}`, { onclick: () => { if (view.source !== k) { view.source = k; load(); } } }, [label]))) : null,
      el('button.btn.btn-sm', { title: 'החודש הקודם', onclick: () => shiftMonth(-1) }, ['▶']),
      el('b.cal-title', { text: title }),
      el('button.btn.btn-sm', { title: 'החודש הבא', onclick: () => shiftMonth(1) }, ['◀']),
      el('button.btn.btn-sm', { onclick: () => { view.month = new Date(); load(); } }, ['החודש']),
      el('div.spacer'),
      search,
      el('button.btn.btn-sm', { title: view.source === 'timeless' ? 'רענון מ-Timeless' : 'רענון מ-Zoom', onclick: async (e) => { e.currentTarget.disabled = true; await load(); UI.success('ההקלטות עודכנו'); } }, ['⟳ רענון'])
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
    if (view.source === 'timeless') return drawTimeless();
    const q = view.q.trim().toLowerCase();
    const list = (data.recordings ?? []).filter((r) => !q
      || r.topic.toLowerCase().includes(q)
      || r.host.name.toLowerCase().includes(q)
      || r.host.email.includes(q)
      || (r.meeting?.title ?? '').toLowerCase().includes(q));
    if (!list.length) {
      if (q) { UI.mount(listBox, UI.empty('אין הקלטות שמתאימות לחיפוש', '🎥')); return; }
      // ריק — ולמה זה יכול לקרות, כדי שלא ייראה כמו תקלה
      UI.mount(listBox, UI.empty('אין הקלטות בענן בחודש הזה', '🎥'), el('ul.rec-why.mute-sm', {}, [
        data.all
          ? el('li', { text: `נבדקו ${data.hosts ?? 0} משתמשי Zoom בחשבונות של החברה.` })
          : el('li', { text: 'מוצגות רק הקלטות של פגישות משימון שקבעת, שהן ביומן שלך או שהוזמנת אליהן. הקלטות אחרות — אצל מנהלי המערכת.' }),
        el('li', { text: 'רק הקלטה לענן מגיעה לכאן. הקלטה למחשב ("Record on this computer") נשמרת במחשב של מי שהקליט.' }),
        el('li', { text: 'משתמש Zoom חינמי (Basic) לא מקליט לענן.' }),
        el('li', { text: 'אחרי סוף הפגישה Zoom מעבד את ההקלטה — לפעמים עד כמה שעות.' })
      ]));
      return;
    }
    UI.mount(listBox, ...list.map(card));
  }

  /**
   * הכפתורים של הקלטה: וידאו אחד מוצג כ"צפייה", וכשיש כמה תצוגות — כל אחת
   * עם שמה; שמע, תמליל, צ'אט. משותף גם לכרטיס הפגישה.
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
        el('span.mute-sm', { text: ` · ${date} ${time}${r.minutes ? ` · ${MeetingView.durationLabel(r.minutes)}` : ''}` })
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

  // ------------------------------------------------------------- Timeless

  function drawTimeless() {
    if (data.connect) return UI.mount(listBox, connectBox());
    const q = view.q.trim().toLowerCase();
    const list = (data.recordings ?? []).filter((r) => !q
      || r.title.toLowerCase().includes(q)
      || r.participants.some((p) => p.toLowerCase().includes(q)));
    if (!list.length) {
      // הטעינה נכשלה (למשל Timeless מגביל את הקצב) — ההודעה למעלה מספיקה; "אין פגישות" יטעה
      if (!q && (data.errors ?? []).length) { UI.mount(listBox); return; }
      UI.mount(listBox, UI.empty(q ? 'אין הקלטות שמתאימות לחיפוש' : 'אין פגישות מוקלטות ב-Timeless בחודש הזה', '🎥'),
        data.status?.source === 'org' && data.status.scope === 'mine'
          ? el('div.mute-sm', { style: { textAlign: 'center' }, text: 'מוצגות הפגישות שהשתתפת בהן (לפי המייל שלך).' })
          : null);
      return;
    }
    UI.mount(listBox, ...list.map(tlCard));
  }

  function tlCard(r) {
    const when = r.start ? new Date(r.start) : null;
    const date = when ? when.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' }) : '';
    const time = when ? when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    // "שם <מייל>" ← השם בלבד
    const people = r.participants.map((p) => p.replace(/\s*<[^>]+>\s*$/, '')).filter(Boolean);
    return el('div.card.rec-card', {}, [
      el('div.rec-top', {}, [
        el('b', { text: r.title || 'פגישה' }),
        el('span.mute-sm', { text: ` · ${date} ${time}${r.durationMinutes ? ` · ${MeetingView.durationLabel(r.durationMinutes)}` : ''}` })
      ]),
      people.length ? el('div.mute-sm', { text: `משתתפים: ${people.slice(0, 6).join(', ')}${people.length > 6 ? ` +${people.length - 6}` : ''}` }) : null,
      el('div.rec-actions', {}, [
        el('button.btn.btn-sm.btn-primary', { onclick: () => RecordingPlayer.open(r.id) }, ['▶ צפייה ותמליל']),
        el('button.btn.btn-sm', { onclick: () => RecordingPlayer.open(r.id, { tab: 'summary' }) }, ['📋 סיכום ומשימות']),
        el('button.btn.btn-sm.btn-ghost', { onclick: () => RecordingPlayer.open(r.id, { tab: 'ask' }) }, ['✨ שאל על הפגישה'])
      ])
    ]);
  }

  /** Timeless עוד לא מחובר — חיבור כאן, עם האסימון האישי */
  function connectBox() {
    const token = el('input', { type: 'password', placeholder: 'האסימון מ-my.timeless.day/api-token', autocomplete: 'off' });
    const save = el('button.btn.btn-primary', { type: 'button' }, ['חיבור Timeless']);
    save.addEventListener('click', async () => {
      if (!token.value.trim()) return token.focus();
      save.disabled = true;
      try {
        await API.put('/api/me/timeless', { token: token.value.trim() });
        sources.timeless = true;
        UI.success('Timeless חובר');
        load();
      } catch (err) { save.disabled = false; UI.error(err); }
    });
    return el('div.card.card-pad.rec-connect', {}, [
      el('b', { text: '🎥 ההקלטות מגיעות מ-Timeless' }),
      el('ol.ai-steps', {}, [
        el('li', {}, ['נכנסים ל-', el('a', { href: 'https://my.timeless.day/api-token', target: '_blank', rel: 'noopener' }, ['my.timeless.day/api-token']), ' ומעתיקים את האסימון.']),
        el('li', { text: 'מדביקים כאן ← "חיבור Timeless".' })
      ]),
      el('div.flex', { style: { gap: '8px' } }, [token, save]),
      el('div.mute-sm', { text: 'האסימון נשמר מוצפן ואינו מוצג שוב. אפשר לנתק ב"החשבון שלי". מנהל המערכת יכול גם להגדיר אסימון ארגוני לכולם (TIMELESS_ACCESS_TOKEN).' })
    ]);
  }

  return { render, reload, actions };
})();
