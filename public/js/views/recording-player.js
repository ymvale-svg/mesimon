'use strict';
/**
 * 🎥 נגן הקלטה (Timeless) — חלון אחד לכל מה שיצא מהפגישה:
 *
 *   • הסרטון (או שמע בלבד), מהירות ניגון
 *   • "מי דיבר מתי" — פס לכל דובר, לחיצה קופצת לקטע
 *   • התמליל — השורה שמדוברת מודגשת, לחיצה על שורה קופצת אליה, חיפוש בתוכו
 *   • סיכום מובנה — החלטות, משימות (מי, עד מתי, איפה בהקלטה) ו-"+ משימה במשימון",
 *     נקודות פתוחות
 *   • "שאל על הפגישה" — תשובה מהתמליל, עם קפיצה לרגע
 *   • "🔗 קישור לרגע הזה" — ‎/?rec=<id>&t=<שניות>‎ (‎App‎ פותח את הנגן מהקישור)
 *
 * הכול דרך השרת (‎/api/timeless/recordings/:id/…‎), שבודק בכל בקשה שהפגישה נראית למשתמש.
 */

const RecordingPlayer = (() => {
  const { el } = UI;
  const COLORS = ['#2563eb', '#7c3aed', '#c2410c', '#0f766e', '#be123c', '#0891b2', '#65a30d', '#a16207'];
  const SPEEDS = [1, 1.25, 1.5, 2];
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  const enc = encodeURIComponent;
  const base = (id) => `/api/timeless/recordings/${enc(id)}`;
  const shortName = (p) => String(p ?? '').replace(/\s*<[^>]+>\s*$/, '');

  /** Markdown פשוט — כותרות ותבליטים, כטקסט (בלי HTML מבחוץ) */
  function mdView(md) {
    return el('div.rp-md', {}, String(md ?? '').split('\n').map((line) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) return el(h[1].length <= 1 ? 'h3' : 'h4', { text: h[2].replace(/\*\*/g, '') });
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) return el('div.rp-li', { text: `• ${li[1].replace(/\*\*/g, '')}` });
      return line.trim() ? el('div', { text: line.replace(/\*\*/g, '') }) : el('div.rp-gap');
    }));
  }

  /**
   * @param {string} id   מזהה הפגישה ב-Timeless
   * @param {object} [opts]  ‎{ t: שניות להתחלה, tab: 'summary' | 'ask' }‎
   */
  async function open(id, opts = {}) {
    const body = el('div.rp', {}, [UI.spinner()]);
    const m = UI.modal({ title: '🎥 הקלטה', body, size: 'rp-modal' });
    let info;
    try {
      info = await API.get(base(id));
    } catch (err) {
      UI.mount(body, el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: err.message })]));
      return;
    }
    const meeting = info.meeting;
    let linkedTasks = info.tasks ?? [];
    const titleEl = m.box?.querySelector('.modal-head h3');
    if (titleEl) titleEl.textContent = `🎥 ${meeting.title || 'הקלטה'}`;

    // --- הסרטון
    const video = el('video.rp-video', { controls: true, preload: 'metadata', playsInline: true, src: `${base(id)}/play` });
    const noVideo = el('div.rp-novideo', { text: 'אין הקלטה לצפייה בפגישה הזו — רק תמליל וסיכום' });
    noVideo.hidden = true;
    // אין הקלטה (רק תמליל) — בלי הנגן ובלי כפתורי הניגון
    let controls = null;
    video.addEventListener('error', () => { video.hidden = true; video.style.display = 'none'; noVideo.hidden = false; if (controls) controls.hidden = true; });
    if (opts.t) video.addEventListener('loadedmetadata', () => { video.currentTime = Number(opts.t) || 0; }, { once: true });
    const seek = (sec, play = true) => {
      if (video.hidden) return;
      video.currentTime = Math.max(0, Number(sec) || 0);
      if (play) video.play().catch(() => {});
    };
    let speedIx = 0;
    const speedBtn = el('button.btn.btn-sm', { type: 'button', title: 'מהירות ניגון' }, ['×1']);
    speedBtn.addEventListener('click', () => {
      speedIx = (speedIx + 1) % SPEEDS.length;
      video.playbackRate = SPEEDS[speedIx];
      speedBtn.textContent = `×${SPEEDS[speedIx]}`;
    });
    const audioBtn = el('button.btn.btn-sm', { type: 'button', 'aria-pressed': 'false' }, ['שמע בלבד']);
    audioBtn.addEventListener('click', () => {
      const on = video.classList.toggle('is-audio');
      audioBtn.setAttribute('aria-pressed', String(on));
      audioBtn.classList.toggle('btn-primary', on);
    });
    const linkBtn = el('button.btn.btn-sm', { type: 'button', title: 'קישור שפותח את ההקלטה בדיוק ברגע הזה' }, ['🔗 קישור לרגע הזה']);
    linkBtn.addEventListener('click', async () => {
      const t = Math.floor(video.hidden ? 0 : video.currentTime || 0);
      const url = `${location.origin}/?rec=${enc(id)}${t ? `&t=${t}` : ''}`;
      try { await navigator.clipboard.writeText(url); UI.success(`הקישור הועתק${t ? ` (${clock(t)})` : ''}`); } catch { UI.toast(url); }
    });

    // --- ציר דוברים ותמליל (נטענים ברקע)
    const speakersBox = el('div.rp-speakers', {}, [el('div.mute-sm', { text: 'טוען תמליל…' })]);
    const transcriptList = el('div.rp-lines');
    const search = el('input', { type: 'search', placeholder: 'חיפוש בתמליל…', 'aria-label': 'חיפוש בתמליל' });
    const hits = el('span.mute-sm.rp-hits');
    const prevBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-label': 'התוצאה הקודמת' }, ['‹']);
    const nextBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-label': 'התוצאה הבאה' }, ['›']);
    let segs = [];
    let rows = [];
    let current = -1;
    let follow = true;
    transcriptList.addEventListener('wheel', () => { follow = false; clearTimeout(transcriptList._f); transcriptList._f = setTimeout(() => { follow = true; }, 6000); }, { passive: true });

    function drawLines(q = '') {
      const needle = q.trim();
      rows = segs.map((x, i) => {
        const text = el('span.rp-text');
        if (needle && x.text.includes(needle)) {
          x.text.split(needle).forEach((part, k, arr) => {
            text.append(part);
            if (k < arr.length - 1) text.append(el('mark', { text: needle }));
          });
        } else text.textContent = x.text;
        const row = el(`button.rp-line${i === current ? '.is-now' : ''}`, { type: 'button', onclick: () => seek(x.s) }, [
          el('span.rp-time', { text: clock(x.s) }),
          el('b.rp-who', { style: { color: x.color }, text: x.name }),
          text
        ]);
        row.dataset.hit = needle && x.text.includes(needle) ? '1' : '';
        return row;
      });
      UI.mount(transcriptList, ...(rows.length ? rows : [el('div.mute-sm', { text: 'אין תמליל לפגישה הזו' })]));
      matchIx = -1;
      const n = rows.filter((r) => r.dataset.hit).length;
      hits.textContent = needle ? (n ? `${n} תוצאות` : 'לא נמצא') : '';
    }
    let matchIx = -1;
    const jumpMatch = (dir) => {
      const list = rows.filter((r) => r.dataset.hit);
      if (!list.length) return;
      matchIx = (matchIx + dir + list.length) % list.length;
      list[matchIx].scrollIntoView({ block: 'center', behavior: 'smooth' });
      list[matchIx].click();
      hits.textContent = `${matchIx + 1} מתוך ${list.length}`;
    };
    let searchTimer = null;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => drawLines(search.value), 200); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpMatch(e.shiftKey ? -1 : 1); } });
    prevBtn.addEventListener('click', () => jumpMatch(-1));
    nextBtn.addEventListener('click', () => jumpMatch(1));

    video.addEventListener('timeupdate', () => {
      if (!segs.length) return;
      const t = video.currentTime;
      let i = segs.findIndex((x, k) => t >= x.s && (k === segs.length - 1 || t < segs[k + 1].s));
      if (i === current) return;
      rows[current]?.classList.remove('is-now');
      current = i;
      rows[i]?.classList.add('is-now');
      if (follow && rows[i]) rows[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    function drawSpeakers() {
      const total = Math.max(1, video.duration && Number.isFinite(video.duration) ? video.duration : 0, ...segs.map((x) => x.e));
      const bySpeaker = new Map();
      for (const x of segs) {
        const s = bySpeaker.get(x.speaker) ?? { name: x.name, color: x.color, spoken: 0, blocks: [] };
        s.spoken += Math.max(0, x.e - x.s);
        const last = s.blocks.at(-1);
        // קטעים צמודים (פחות מ-5 שניות ביניהם) — פס אחד
        if (last && x.s - last.e < 5) last.e = x.e; else s.blocks.push({ s: x.s, e: x.e });
        bySpeaker.set(x.speaker, s);
      }
      const all = [...bySpeaker.values()].sort((a, b) => b.spoken - a.spoken);
      const sum = all.reduce((n, s) => n + s.spoken, 0) || 1;
      if (!all.length) return UI.mount(speakersBox);
      UI.mount(speakersBox,
        el('div.rp-speakers-head', {}, [el('b', { text: 'מי דיבר מתי' }), el('span.mute-sm', { text: ' · לחיצה על קטע קופצת אליו' })]),
        ...all.slice(0, 8).map((s) => el('div.rp-spk', {}, [
          el('span.rp-spk-name', {}, [el('span.rp-dot', { style: { background: s.color } }), `${s.name} · ${Math.round((s.spoken / sum) * 100)}%`]),
          el('div.rp-spk-track', {}, s.blocks.map((b) => el('button.rp-spk-block', {
            type: 'button',
            title: `${clock(b.s)}–${clock(b.e)}`,
            'aria-label': `${s.name} ${clock(b.s)}`,
            style: { insetInlineStart: `${(b.s / total) * 100}%`, width: `${Math.max(0.4, ((b.e - b.s) / total) * 100)}%`, background: s.color },
            onclick: () => seek(b.s)
          })))
        ])));
    }

    API.get(`${base(id)}/segments`).then((data) => {
      const color = new Map(data.speakers.map((s, i) => [s.id, COLORS[i % COLORS.length]]));
      const name = new Map(data.speakers.map((s) => [s.id, s.name]));
      segs = data.segments.map((x) => ({ ...x, name: name.get(x.speaker) || 'דובר', color: color.get(x.speaker) || COLORS[0] }));
      drawLines(search.value);
      drawSpeakers();
      video.addEventListener('loadedmetadata', drawSpeakers, { once: true });
    }).catch((err) => {
      UI.mount(speakersBox);
      UI.mount(transcriptList, el('div.mute-sm', { text: `התמליל לא נטען: ${err.message}` }));
    });

    // --- הצד: סיכום / שאל
    let tab = opts.tab === 'ask' ? 'ask' : 'summary';
    const side = el('div.rp-side');
    const tabsEl = el('div.seg.rp-tabs');
    const sideBody = el('div.rp-side-body');
    let digest = null;
    let digestErr = '';

    function drawTabs() {
      UI.mount(tabsEl, ...[['summary', 'סיכום'], ['ask', 'שאל על הפגישה']].map(([k, label]) =>
        el(`button${tab === k ? '.active' : ''}`, { type: 'button', onclick: () => { tab = k; drawTabs(); drawSide(); } }, [label])));
    }

    const linkedKeys = () => new Set(linkedTasks.map((t) => t.item).filter(Boolean));

    function drawSide() {
      if (tab === 'ask') return UI.mount(sideBody, askBox());
      if (digestErr) return UI.mount(sideBody, el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: digestErr })]));
      if (!digest) return UI.mount(sideBody, el('div.mute-sm.rp-loading', {}, [el('span.spinner-sm'), ' מכין סיכום מסודר — החלטות, משימות ונקודות פתוחות…']));
      if (digest.noAi) return UI.mount(sideBody, digest.markdown ? mdView(digest.markdown) : UI.empty('אין סיכום', '📋'));
      if (digest.empty) return UI.mount(sideBody, UI.empty('אין עדיין תמליל או סיכום לפגישה הזו', '📋'));
      const done = linkedKeys();
      const openTasks = digest.tasks.filter((t) => !done.has(t.key));
      const section = (title, items) => items.length ? el('div.rp-sec', {}, [el('div.rp-sec-title', { text: title }), ...items]) : null;
      UI.mount(sideBody,
        digest.brief ? el('div.rp-brief', { text: digest.brief }) : null,
        section('החלטות', digest.decisions.map((d) => el('div.rp-bullet', { text: d }))),
        el('div.rp-sec', {}, [
          el('div.rp-sec-head', {}, [
            el('div.rp-sec-title', { text: `משימות (${digest.tasks.length})` }),
            openTasks.length > 1 ? el('button.btn.btn-sm', { type: 'button', onclick: () => tasksDialog(openTasks) }, ['כולן למשימון']) : null
          ]),
          ...(digest.tasks.length ? digest.tasks.map((t) => taskCard(t, done.has(t.key))) : [el('div.mute-sm', { text: 'לא עלו משימות בפגישה' })])
        ]),
        section('נקודות פתוחות', digest.open.map((d) => el('div.rp-bullet.is-open', { text: d }))),
        linkedTasks.length ? el('div.rp-sec', {}, [
          el('div.rp-sec-title', { text: 'משימות שנפתחו מהפגישה' }),
          ...linkedTasks.map((t) => el('button.rp-linked', { type: 'button', onclick: () => TaskCardView.open(t.id) }, [
            el('span.rp-dot', { style: { background: t.done ? '#16a34a' : '#f59e0b' } }),
            el('span', { class: t.done ? 'is-done' : '', text: `${t.title}${t.assignee ? ` — ${t.assignee}` : ''}` }),
            el('span.mute-sm', { text: t.status })
          ]))
        ]) : null,
        el('div.rp-sec-foot', {}, [
          el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'לבנות את הסיכום מחדש', onclick: () => loadDigest(true) }, ['↻ סיכום מחדש']),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: shareSummary }, ['📤 שיתוף הסיכום'])
        ])
      );
    }

    function taskCard(t, done) {
      if (done) {
        const linked = linkedTasks.find((x) => x.item === t.key);
        return el('div.rp-task.is-done', {}, [
          el('div', { class: 'rp-task-title is-struck', text: t.title }),
          el('div.rp-task-meta', { text: `✓ נפתחה משימה${linked?.assignee ? ` · ${linked.assignee}` : ''}` })
        ]);
      }
      return el('div.rp-task', {}, [
        el('div.rp-task-title', { text: t.title }),
        el('div.rp-task-meta', {}, [
          t.assigneeName ? el(`span.rp-chip${t.assigneeId ? '' : '.is-unknown'}`, { title: t.assigneeId ? 'זוהה במשימון' : 'לא זוהה עובד בשם הזה', text: t.assigneeName }) : el('span.mute-sm', { text: 'בלי אחראי' }),
          el('span', { text: t.due ? UI.formatDate(t.due) : 'בלי תאריך' }),
          t.at && !video.hidden ? el('button.rp-at', { type: 'button', onclick: () => seek(t.at) }, [`${clock(t.at)} ▶`]) : null
        ]),
        t.quote ? el('div.rp-quote', { text: `"${t.quote}"` }) : null,
        el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => tasksDialog([t]) }, ['+ משימה במשימון'])
      ]);
    }

    function askBox() {
      const q = el('input', { type: 'text', placeholder: 'למשל: מה סוכם על המחיר?', 'aria-label': 'שאלה על הפגישה' });
      const go = el('button.btn.btn-primary', { type: 'button' }, ['שאל']);
      const out = el('div.rp-answer');
      const run = async () => {
        if (!q.value.trim()) return q.focus();
        go.disabled = true;
        UI.mount(out, el('div.mute-sm', {}, [el('span.spinner-sm'), ' קורא את התמליל…']));
        try {
          const r = await API.post(`${base(id)}/ask`, { question: q.value.trim() });
          UI.mount(out, el('div.rp-brief', { text: r.answer }), r.at && !video.hidden ? el('button.btn.btn-sm', { type: 'button', onclick: () => seek(r.at) }, [`▶ לרגע הזה (${clock(r.at)})`]) : null);
        } catch (err) {
          UI.mount(out, el('div.text-danger', { text: err.message }));
        }
        go.disabled = false;
      };
      go.addEventListener('click', run);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      setTimeout(() => q.focus(), 30);
      return el('div.rp-ask', {}, [el('div.flex', { style: { gap: '6px' } }, [q, go]), out]);
    }

    async function shareSummary() {
      if (!digest) return;
      const text = [
        `סיכום: ${meeting.title}`,
        digest.brief,
        digest.decisions.length ? `\nהחלטות:\n${digest.decisions.map((d) => `• ${d}`).join('\n')}` : '',
        digest.tasks.length ? `\nמשימות:\n${digest.tasks.map((t) => `• ${t.title}${t.assigneeName ? ` — ${t.assigneeName}` : ''}${t.due ? ` (עד ${UI.formatDate(t.due)})` : ''}`).join('\n')}` : '',
        digest.open.length ? `\nנקודות פתוחות:\n${digest.open.map((d) => `• ${d}`).join('\n')}` : '',
        `\nההקלטה: ${location.origin}/?rec=${enc(id)}`
      ].filter(Boolean).join('\n');
      if (navigator.share) { try { await navigator.share({ title: meeting.title, text }); return; } catch { /* בוטל — מעתיקים */ } }
      try { await navigator.clipboard.writeText(text); UI.success('הסיכום הועתק — אפשר להדביק במייל או בוואטסאפ'); } catch { UI.toast('ההעתקה לא הצליחה', 'error'); }
    }

    async function loadDigest(fresh = false) {
      digest = null;
      digestErr = '';
      if (tab === 'summary') drawSide();
      try {
        digest = await API.get(`${base(id)}/digest${fresh ? '?fresh=1' : ''}`);
      } catch (err) {
        digestErr = err.message;
      }
      if (tab === 'summary') drawSide();
    }

    /** ➕ משימות מהסיכום — שם, אחראי ויעד ניתנים לשינוי לפני הפתיחה */
    function tasksDialog(items) {
      const users = App.state.users ?? [];
      const lines = items.map((t) => {
        const check = el('input', { type: 'checkbox', checked: true, 'aria-label': 'לפתוח' });
        const title = el('input', { type: 'text', value: t.title, 'aria-label': 'שם המשימה' });
        const who = el('select', { 'aria-label': 'אחראי' }, [
          el('option', { value: '' }, ['בלי אחראי']),
          ...users.map((u) => el('option', { value: String(u.id), selected: u.id === t.assigneeId }, [u.name]))
        ]);
        const due = el('input', { type: 'date', value: t.due || '', 'aria-label': 'יעד' });
        return { t, check, title, who, due, node: el('div.rp-new', {}, [
          check,
          el('div.rp-new-main', {}, [title, t.quote ? el('div.mute-sm', { text: `"${t.quote}"${t.at ? ` · ${clock(t.at)}` : ''}` }) : null]),
          who, due
        ]) };
      });
      const ok = el('button.btn.btn-primary', {}, [`פתיחת ${items.length === 1 ? 'המשימה' : `${items.length} משימות`}`]);
      const dlg = UI.modal({
        title: '+ משימות מהפגישה',
        size: 'wide',
        body: el('div.rp-new-list', {}, [
          el('div.mute-sm', { text: `${meeting.title} — מה ש-AI זיהה בפגישה. אפשר לשנות לפני שפותחים. כל משימה נפתחת עם הציטוט וקישור לרגע בהקלטה, והאחראי מקבל הודעה כרגיל.` }),
          ...lines.map((l) => l.node)
        ]),
        footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => dlg.close() }, ['ביטול'])]
      });
      const sync = () => { const n = lines.filter((l) => l.check.checked).length; ok.textContent = n ? `פתיחת ${n === 1 ? 'משימה אחת' : `${n} משימות`}` : 'לא נבחרו משימות'; ok.disabled = !n; };
      lines.forEach((l) => l.check.addEventListener('change', sync));
      sync();
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        const links = [];
        const when = meeting.start ? UI.formatDate(meeting.start) : '';
        try {
          for (const l of lines.filter((x) => x.check.checked)) {
            if (!l.title.value.trim()) continue;
            const link = `${location.origin}/?rec=${enc(id)}${l.t.at ? `&t=${Math.floor(l.t.at)}` : ''}`;
            const res = await API.createTask({
              title: l.title.value.trim(),
              description: [`מהפגישה "${meeting.title}"${when ? ` (${when})` : ''}`, l.t.quote ? `"${l.t.quote}"` : '', `▶ ההקלטה: ${link}`].filter(Boolean).join('\n'),
              assigneeType: l.who.value ? 'user' : null,
              assigneeId: l.who.value ? Number(l.who.value) : null,
              dueDate: l.due.value ? UI.fromInputDate(l.due.value) : null
            });
            links.push({ taskId: res.task.id, item: l.t.key });
          }
          if (links.length) linkedTasks = (await API.post(`${base(id)}/tasks`, { links })).tasks;
          dlg.close();
          UI.success(links.length === 1 ? 'המשימה נפתחה' : `נפתחו ${links.length} משימות`);
          drawSide();
          App.refreshView?.();
        } catch (err) {
          ok.disabled = false;
          UI.error(err);
          if (links.length) { try { linkedTasks = (await API.post(`${base(id)}/tasks`, { links })).tasks; drawSide(); } catch { /* ריק */ } }
        }
      });
    }

    // --- הרכבה
    const people = meeting.participants.map(shortName).filter(Boolean);
    const when = meeting.start ? new Date(meeting.start).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    drawTabs();
    side.append(tabsEl, sideBody);
    UI.mount(body,
      el('div.rp-meta', {}, [
        el('span.mute-sm', { text: [when, meeting.durationMinutes ? MeetingView.durationLabel(meeting.durationMinutes) : '', people.slice(0, 5).join(', ') + (people.length > 5 ? ` +${people.length - 5}` : '')].filter(Boolean).join(' · ') }),
        el('div.spacer'),
        linkBtn
      ]),
      el('div.rp-grid', {}, [
        el('div.rp-main', {}, [
          el('div.rp-player', {}, [video, noVideo, controls = el('div.rp-controls', { hidden: video.hidden }, [speedBtn, audioBtn])]),
          speakersBox,
          el('div.rp-transcript', {}, [
            el('div.rp-tr-head', {}, [el('b', { text: 'תמליל' }), search, hits, prevBtn, nextBtn]),
            transcriptList
          ])
        ]),
        side
      ])
    );
    drawSide();
    loadDigest();
  }

  return { open, mdView };
})();
