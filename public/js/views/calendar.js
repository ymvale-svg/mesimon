'use strict';
/**
 * 📅 יומן — למזכירות.
 *
 * היומנים שהעובדים שיתפו עם המזכירה ב-Google, זה לצד זה:
 *   • יום  — עמודה לכל עובד (התצוגה שמזכירה עובדת בה: מי פנוי עכשיו)
 *   • שבוע — עמודה לכל יום, הפגישות של כל העובדים שנבחרו בצבעים
 * עובד ששיתף לצפייה בלבד, או לא שיתף — מופיע ב"תפוס" בלבד, באפור.
 *
 * למטה — "מחכות לקביעה": משימות "📅 פגישה לקביעה" מכל המקורות.
 * לחיצה על משבצת ריקה — קביעת פגישה ביומן של העובד, באותה שעה.
 */

const CalendarView = (() => {
  const { el } = UI;

  const PREF = 'calendarUsers';
  const COLORS = ['#2563eb', '#7c3aed', '#0f766e', '#c2410c', '#be123c', '#0891b2', '#65a30d', '#a16207', '#db2777', '#4f46e5'];
  const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const HOUR_FROM = 7;
  const HOUR_TO = 20;
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const hhmm = (s) => new Date(s).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });

  let containerRef = null;
  let info = null;      // היומנים ורמת הגישה
  let data = null;      // האירועים בטווח
  let pending = [];
  const view = { mode: 'day', date: new Date(), users: null, filter: '' };

  const colorOf = (userId) => {
    const i = (view.users ?? []).indexOf(userId);
    return COLORS[(i < 0 ? userId : i) % COLORS.length];
  };

  // ------------------------------------------------------------- טעינה

  async function render(container) {
    containerRef = container;
    UI.mount(container, UI.spinner());
    try {
      [info, { tasks: pending }] = await Promise.all([API.get('/api/meetings/calendars'), API.get('/api/meetings/pending')]);
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    if (!info.secretary) return UI.mount(container, UI.empty('מסך היומן מיועד למזכירות', '📅'));
    if (!view.users) {
      const saved = App.getPref(PREF);
      const shared = info.calendars.filter((c) => c.access !== 'none').map((c) => c.userId);
      view.users = (Array.isArray(saved) && saved.length ? saved : shared.slice(0, 6)).filter((id) => info.calendars.some((c) => c.userId === id));
      if (!view.users.length) view.users = info.calendars.filter((c) => c.self).map((c) => c.userId);
    }
    await loadRange();
  }

  const reload = () => (containerRef?.isConnected ? loadRange() : Promise.resolve());

  function range() {
    if (view.mode === 'day') return { from: iso(view.date), to: iso(view.date), days: [new Date(view.date)] };
    const start = addDays(view.date, -view.date.getDay()); // ראשון
    const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(start, i)); // א׳–ו׳, בלי שבת
    return { from: iso(days[0]), to: iso(days[days.length - 1]), days };
  }

  async function loadRange() {
    const r = range();
    try {
      data = view.users.length
        ? await API.get(`/api/meetings/range?from=${r.from}&to=${r.to}&users=${view.users.join(',')}`)
        : { events: [], access: {} };
    } catch (err) {
      data = { events: [], access: {}, error: err.message };
    }
    draw();
  }

  // ------------------------------------------------------------- המסך

  function draw() {
    if (!containerRef) return;
    const r = range();
    const counts = { write: 0, read: 0, none: 0 };
    for (const c of info.calendars) {
      if (c.self) continue;
      if (['owner', 'write'].includes(c.access)) counts.write++;
      else if (c.access === 'read') counts.read++;
      else counts.none++;
    }
    const title = view.mode === 'day'
      ? view.date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })
      : `${r.days[0].getDate()}.${r.days[0].getMonth() + 1}–${r.days[r.days.length - 1].getDate()}.${r.days[r.days.length - 1].getMonth() + 1}`;

    UI.mount(containerRef, el('div.cal', {}, [
      el('div.cal-head', {}, [
        el('h2', { text: '📅 יומן' }),
        el('div.seg', {}, [['day', 'יום'], ['week', 'שבוע']].map(([k, label]) =>
          el(`button${view.mode === k ? '.active' : ''}`, { onclick: () => { view.mode = k; loadRange(); } }, [label]))),
        el('button.btn.btn-sm', { title: 'הקודם', onclick: () => { view.date = addDays(view.date, view.mode === 'day' ? -1 : -7); loadRange(); } }, ['▶']),
        el('b.cal-title', { text: title }),
        el('button.btn.btn-sm', { title: 'הבא', onclick: () => { view.date = addDays(view.date, view.mode === 'day' ? 1 : 7); loadRange(); } }, ['◀']),
        el('button.btn.btn-sm', { onclick: () => { view.date = new Date(); loadRange(); } }, ['היום']),
        el('div.spacer'),
        el('button.btn.btn-sm', { title: 'רענון רשימת היומנים ששותפו', onclick: async () => { info = await API.get('/api/meetings/calendars?fresh=1'); loadRange(); } }, ['⟳'])
      ]),
      el('div.cal-access', {}, [
        `שיתפו איתך לעריכה: ${counts.write} · לצפייה: ${counts.read} · לא שיתפו: ${counts.none}`,
        counts.none ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); shareHelp(); } }, [' · איך משתפים']) : null
      ]),
      peoplePicker(),
      data?.error ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: data.error })]) : null,
      view.mode === 'day' ? dayGrid(r.days[0]) : weekGrid(r.days),
      pendingList()
    ]));
  }

  /** מי מוצג — שבבים לבחירה, עם חיפוש */
  function peoplePicker() {
    const search = el('input', { type: 'search', placeholder: '🔍 עובד…', value: view.filter, style: { width: '150px' } });
    search.addEventListener('input', () => { view.filter = search.value; drawChips(); });
    const chips = el('div.cal-people');
    const drawChips = () => {
      const q = view.filter.trim();
      const list = info.calendars.filter((c) => !q || c.name.includes(q) || c.email.includes(q));
      UI.mount(chips, ...list.slice(0, 40).map((c) => {
        const on = view.users.includes(c.userId);
        const access = c.self ? 'owner' : c.access;
        return el(`button.cal-chip${on ? '.on' : ''}${['owner', 'write'].includes(access) ? '' : '.is-limited'}`, {
          title: access === 'none' ? 'לא שיתף/ה — רק "תפוס"' : access === 'read' || access === 'freebusy' ? 'צפייה בלבד' : 'עריכה',
          style: on ? { background: colorOf(c.userId), borderColor: colorOf(c.userId) } : {},
          onclick: () => {
            view.users = on ? view.users.filter((x) => x !== c.userId) : [...view.users, c.userId].slice(0, 15);
            App.setPref(PREF, view.users);
            loadRange();
          }
        }, [c.self ? `${c.name} (אני)` : c.name]);
      }));
    };
    drawChips();
    return el('div.cal-people-row', {}, [search, chips]);
  }

  // --- רשת יום: עמודה לכל עובד
  function dayGrid(day) {
    const people = view.users.map((id) => info.calendars.find((c) => c.userId === id)).filter(Boolean);
    if (!people.length) return UI.empty('בחרו עובדים להצגה', '👥');
    return grid(people.map((p) => ({
      key: `u${p.userId}`,
      label: p.self ? `${p.name} (אני)` : p.name,
      date: day,
      ownerId: p.userId,
      writable: ['owner', 'write'].includes(p.self ? 'owner' : p.access),
      events: (data?.events ?? []).filter((e) => e.userId === p.userId && sameDay(e.start, day))
    })));
  }

  // --- רשת שבוע: עמודה לכל יום
  function weekGrid(days) {
    return grid(days.map((d) => ({
      key: iso(d),
      label: `${DAY_NAMES[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}`,
      date: d,
      ownerId: view.users.length === 1 ? view.users[0] : null,
      writable: true,
      events: (data?.events ?? []).filter((e) => sameDay(e.start, d))
    })));
  }

  const sameDay = (s, d) => iso(new Date(s)) === iso(d);

  function grid(columns) {
    const hours = [];
    for (let h = HOUR_FROM; h < HOUR_TO; h++) hours.push(h);
    const total = (HOUR_TO - HOUR_FROM) * 60;
    const top = (s) => {
      const d = new Date(s);
      return Math.max(0, ((d.getHours() - HOUR_FROM) * 60 + d.getMinutes()) / total * 100);
    };
    const now = new Date();

    return el('div.cal-grid', { style: { gridTemplateColumns: `52px repeat(${columns.length}, minmax(120px, 1fr))` } }, [
      el('div.cal-corner'),
      ...columns.map((c) => el('div.cal-colhead', { text: c.label })),
      el('div.cal-hours', {}, hours.map((h) => el('div.cal-hour', { text: `${pad(h)}:00` }))),
      ...columns.map((c) => {
        const allDay = c.events.filter((e) => e.allDay);
        const timed = layout(c.events.filter((e) => !e.allDay));
        const col = el('div.cal-col', {
          onclick: (e) => {
            if (e.target !== col) return;
            const rect = col.getBoundingClientRect();
            const minutes = Math.floor(((e.clientY - rect.top) / rect.height) * total / 15) * 15;
            const start = new Date(c.date);
            start.setHours(HOUR_FROM, 0, 0, 0);
            start.setMinutes(minutes);
            newMeeting(c.ownerId, start);
          }
        }, [
          ...hours.map((h, i) => el('div.cal-line', { style: { top: `${(i / hours.length) * 100}%` } })),
          sameDay(now, c.date) && now.getHours() >= HOUR_FROM && now.getHours() < HOUR_TO
            ? el('div.cal-now', { style: { top: `${top(now)}%` } }) : null,
          ...allDay.map((e, i) => el('div.cal-allday', { style: { top: `${i * 20}px`, background: colorOf(e.userId) }, onclick: () => openEvent(e) }, [e.title ?? 'תפוס'])),
          ...timed.map(({ e, lane, lanes }) => el(`div.cal-ev${e.busyOnly ? '.is-busy' : ''}${e.meetingId ? '.is-ours' : ''}`, {
            style: {
              top: `${top(e.start)}%`,
              height: `${Math.max(2.2, top(e.end) - top(e.start))}%`,
              insetInlineStart: `${(lane / lanes) * 100}%`,
              width: `${100 / lanes}%`,
              ...(e.busyOnly ? {} : { background: colorOf(e.userId) })
            },
            title: `${hhmm(e.start)}–${hhmm(e.end)} ${e.title ?? 'תפוס'}`,
            onclick: (ev) => { ev.stopPropagation(); openEvent(e); }
          }, [
            el('b', { text: e.title ?? 'תפוס' }),
            el('span', { text: ` ${hhmm(e.start)}` }),
            e.meetingId ? el('span', { text: ' ✦' }) : null
          ]))
        ]);
        return col;
      })
    ]);
  }

  /** פגישות חופפות זו לצד זו */
  function layout(events) {
    const sorted = [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
    const out = [];
    let group = [];
    let groupEnd = 0;
    const flush = () => {
      const lanes = [];
      for (const e of group) {
        let lane = lanes.findIndex((end) => end <= new Date(e.start).getTime());
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = new Date(e.end).getTime();
        out.push({ e, lane, lanes: 0 });
      }
      for (const o of out.slice(out.length - group.length)) o.lanes = lanes.length;
      group = [];
    };
    for (const e of sorted) {
      if (group.length && new Date(e.start).getTime() >= groupEnd) flush();
      group.push(e);
      groupEnd = Math.max(groupEnd, new Date(e.end).getTime());
    }
    if (group.length) flush();
    return out;
  }

  // ------------------------------------------------------------- פעולות

  /** משבצת ריקה — פגישה חדשה, למשימה שמחכה או בלי משימה */
  function newMeeting(ownerId, start) {
    const cal = ownerId ? info.calendars.find((c) => c.userId === ownerId) : null;
    if (cal && !['owner', 'write'].includes(cal.self ? 'owner' : cal.access)) {
      return UI.toast(`${cal.name} לא שיתף/ה איתך את היומן לעריכה`, 'error');
    }
    const open = (task = null) => MeetingView.openDialog({ task, prefill: { ownerId, start: start.toISOString() }, onDone: () => { reload(); refreshPending(); } });
    if (!pending.length) return open();
    const m = UI.modal({
      title: `📅 ${start.toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      body: el('div.today-pick', {}, [
        el('div.mute-sm', { text: 'למשימה שמחכה לקביעה?' }),
        ...pending.slice(0, 8).map((t) => el('button.btn.btn-block', { onclick: () => { m.close(); open(t); } }, [t.title])),
        el('button.btn.btn-block.btn-ghost', { onclick: () => { m.close(); open(); } }, ['פגישה חדשה — בלי משימה'])
      ])
    });
  }

  function openEvent(e) {
    const person = info.calendars.find((c) => c.userId === e.userId);
    const buttons = [];
    if (e.taskId) buttons.push(el('button.btn.btn-sm', { onclick: () => { m.close(); TaskCardView.open(e.taskId); } }, ['פתיחת המשימה']));
    if (e.link) buttons.push(el('a.btn.btn-sm', { href: e.link, target: '_blank', rel: 'noopener' }, ['פתיחה ב-Google ↗']));
    if (e.editable && e.organizerIsOwner && !e.busyOnly && !e.allDay) {
      buttons.push(el('button.btn.btn-sm', { onclick: () => { m.close(); moveDialog(e); } }, ['🔀 הזזה']));
    }
    const m = UI.modal({
      title: e.title ?? 'תפוס',
      body: el('div', {}, [
        el('div', { text: `${new Date(e.start).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' })} · ${e.allDay ? 'כל היום' : `${hhmm(e.start)}–${hhmm(e.end)}`}` }),
        el('div.mute-sm', { text: `ביומן של ${person?.name ?? ''}${e.busyOnly ? ' · זמינות בלבד — העובד לא שיתף פרטים' : ''}` }),
        e.location ? el('div.mute-sm', { text: `📍 ${e.location}` }) : null,
        e.attendees?.length ? el('div.mt-people', {}, e.attendees.map((a) => el(`span.mt-person.is-${a.response ?? 'needsAction'}`, {}, [a.name || a.email]))) : null,
        e.editable && !e.organizerIsOwner && !e.busyOnly ? el('div.mute-sm', { text: 'את הפגישה הזו ארגן מישהו אחר — רק הוא יכול להזיז אותה.' }) : null,
        el('div.flex.mt', { style: { flexWrap: 'wrap', gap: '6px' } }, buttons)
      ])
    });
  }

  function moveDialog(e) {
    const d = new Date(e.start);
    const date = el('input', { type: 'date', value: iso(d) });
    const time = el('input', { type: 'time', step: 900, value: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
    const ok = el('button.btn.btn-primary', {}, ['הזזה ושליחת עדכון']);
    const m = UI.modal({
      title: `🔀 הזזת "${e.title}"`,
      body: el('div', {}, [
        el('div.row', {}, [UI.field('תאריך', date), UI.field('שעה', time)]),
        el('div.mute-sm', { text: 'המשתתפים יקבלו עדכון מ-Google, בשם בעל היומן.' })
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    ok.addEventListener('click', async () => {
      const start = new Date(`${date.value}T${time.value}:00`);
      const end = new Date(start.getTime() + (new Date(e.end) - new Date(e.start)));
      ok.disabled = true;
      try {
        await API.post('/api/meetings/move', { ownerId: e.userId, eventId: e.eventId, start: start.toISOString(), end: end.toISOString() });
        m.close();
        UI.success('הפגישה הוזזה');
        reload();
      } catch (err) {
        ok.disabled = false;
        UI.error(err);
      }
    });
  }

  // --- מחכות לקביעה
  async function refreshPending() {
    try { pending = (await API.get('/api/meetings/pending')).tasks; } catch { /* נשאר */ }
    draw();
  }

  function pendingList() {
    return el('div.card.today-sec', { style: { marginTop: '14px' } }, [
      el('div.today-sec-head', {}, [el('b', { text: '📌 מחכות לקביעה' }), el('span.today-count', { text: String(pending.length) })]),
      el('div.today-rows', {}, pending.length
        ? pending.map((t) => el('div.today-row.today-task', { onclick: () => TaskCardView.open(t.id) }, [
            el('div.today-main', {}, [
              el('div.today-title', { text: t.title }),
              el('div.mute-sm', { text: [t.assigneeName, t.projectName, t.statusShort].filter(Boolean).join(' · ') })
            ]),
            el('button.btn.btn-sm.btn-primary', {
              onclick: (e) => { e.stopPropagation(); MeetingView.openDialog({ task: t, onDone: () => { reload(); refreshPending(); } }); }
            }, ['📅 קביעה'])
          ]))
        : [el('div.mute-sm.today-pad', { text: 'אין משימות שמחכות לקביעת פגישה' })])
    ]);
  }

  /** הוראות לעובד: איך משתפים את היומן עם המזכירות */
  function shareHelp() {
    const me = App.state.actor;
    const text = `כדי שאוכל לקבוע לך פגישות ממשימון: Google Calendar ← ⚙ הגדרות ← היומן שלך ← "שיתוף עם אנשים או קבוצות מסוימים" ← הוספה: ${me.email} ← "ביצוע שינויים באירועים". תודה!`;
    const copy = el('button.btn.btn-sm', {}, ['העתקת ההודעה']);
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); UI.success('הועתק'); } catch { UI.toast(text); } });
    UI.modal({
      title: 'איך עובד משתף את היומן',
      size: 'wide',
      body: el('div', {}, [
        el('ol.ai-steps', {}, [
          el('li', { text: 'Google Calendar במחשב ← ⚙ הגדרות.' }),
          el('li', { text: 'בצד: "ההגדרות של היומנים שלי" ← היומן שלו.' }),
          el('li', { text: '"שיתוף עם אנשים או קבוצות מסוימים" ← הוספת אנשים — המייל של המזכירה (או קבוצת "מזכירות").' }),
          el('li', { text: 'הרשאה: "ביצוע שינויים באירועים" ← שליחה.' })
        ]),
        el('div.mute-sm', { text: 'אחרי השיתוף — "⟳" כאן, והיומן שלו מופיע לעריכה.' }),
        el('div.voice-url', {}, [el('span', { text }), copy])
      ])
    });
  }

  return { render, reload };
})();
