'use strict';
/**
 * 📅 יומן — לכל העובדים.
 *
 * עובד — היומן של עצמו ב-Google: יום ושבוע, וקביעת פגישה בלחיצה על משבצת.
 *
 * מזכירות — גם היומנים שהעובדים שיתפו איתן, כמו "יומן מרובה משתתפים" ב-Google:
 *   • כל היומנים מסומנים כברירת מחדל; מורידים את מי שלא רוצים לראות (נזכר —
 *     ‎calendarHidden‎, כך שעובד חדש ששיתף מופיע לבד). צבע קבוע לכל עובד.
 *   • יום, משולב — כל הפגישות בעמודה אחת, בצבע ובשם של בעל היומן; פגישה
 *     משותפת לכמה עובדים — בלוק אחד עם כל השמות
 *   • יום, לפי עובד — עמודה לכל עובד (מי פנוי עכשיו)
 *   • שבוע — עמודה לכל יום, משולב
 * עובד ששיתף לצפייה בלבד, או לא שיתף — מופיע ב"תפוס" בלבד, באפור.
 *
 * למזכירות בלבד — לוח צף משמאל ליומן, "📌 מחכות לקביעה": המשימות שמחכות
 * לפגישה. "📅 קביעה" או גרירה של המשימה למשבצת ביומן. אפשר למזער אותו
 * לכפתור קטן, והבחירה נזכרת (‎calendarDock‎).
 */

const CalendarView = (() => {
  const { el } = UI;

  const HIDDEN_PREF = 'calendarHidden';   // היומנים שהורדו — כל השאר מוצגים
  const LAYOUT_PREF = 'calendarLayout';   // ביום: ‎combined‎ (ברירת מחדל) או ‎columns‎
  const DOCK_PREF = 'calendarDock';
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
  // ‎tab‎: ‎calendar‎ — היומנים; ‎recordings‎ — 🎥 הקלטות (‎RecordingsView‎): מ-Timeless, ומ-Zoom כשיש חיבור
  const view = { tab: 'calendar', mode: 'day', layout: null, date: new Date(), users: null, hidden: null, filter: '' };

  // צבע קבוע לכל עובד — לפי מקומו ברשימת היומנים, לא לפי מי מסומן: הורדת יומן לא צובעת מחדש את האחרים
  const colorOf = (userId) => {
    const i = (info?.calendars ?? []).findIndex((c) => c.userId === userId);
    return COLORS[(i < 0 ? userId : i) % COLORS.length];
  };
  const nameOf = (userId) => {
    const c = info?.calendars.find((x) => x.userId === userId);
    return c ? (c.self ? `${c.name} (אני)` : c.name) : '';
  };

  /** המוצגים — כל היומנים שלא הורדו, בסדר הרשימה */
  function syncUsers() {
    view.users = info.calendars.filter((c) => !view.hidden.has(c.userId)).map((c) => c.userId);
  }

  // ------------------------------------------------------------- טעינה

  async function render(container) {
    containerRef = container;
    UI.mount(container, UI.spinner());
    try {
      info = await API.get('/api/meetings/calendars');
      // "מחכות לקביעה" — רק למזכירות
      pending = info.secretary ? (await API.get('/api/meetings/pending')).tasks : [];
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    if (!view.hidden) {
      const saved = App.getPref(HIDDEN_PREF);
      view.hidden = new Set(Array.isArray(saved) ? saved : []);
      view.layout = App.getPref(LAYOUT_PREF, 'combined') === 'columns' ? 'columns' : 'combined';
    }
    syncUsers();
    if (view.tab === 'recordings') return drawRecordings();
    await loadRange();
  }

  // בלשונית ההקלטות — לא פונים ל-Zoom בכל רענון רקע; "⟳ רענון" שם מושך מחדש
  const reload = () => (!containerRef?.isConnected ? Promise.resolve() : view.tab === 'recordings' ? Promise.resolve() : loadRange());

  /** הלשוניות בראש המסך: היומן, וההקלטות (Timeless / Zoom) */
  function tabs() {
    const go = (tab) => {
      if (view.tab === tab) return;
      view.tab = tab;
      if (tab === 'recordings') drawRecordings();
      else loadRange();
    };
    return el('div.seg.cal-tabs', {}, [['calendar', '📅 יומן'], ['recordings', '🎥 הקלטות']].map(([k, label]) =>
      el(`button${view.tab === k ? '.active' : ''}`, { onclick: () => go(k) }, [label])));
  }

  function drawRecordings() {
    const box = el('div');
    UI.mount(containerRef, el('div.cal', {}, [tabs(), box]));
    RecordingsView.render(box, { embedded: true, zoom: Boolean(info.zoom?.enabled), timeless: Boolean(info.timeless?.connected) });
  }

  function range() {
    if (view.mode === 'day') return { from: iso(view.date), to: iso(view.date), days: [new Date(view.date)] };
    const start = addDays(view.date, -view.date.getDay()); // ראשון
    const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(start, i)); // א׳–ו׳, בלי שבת
    return { from: iso(days[0]), to: iso(days[days.length - 1]), days };
  }

  /*
   * 🎥 הקלטות Timeless בטווח (רק מה שכבר היה) — כל פגישה ביומן, גם כזו שלא נקבעה
   * במשימון, שיש לה הקלטה, מקבלת תג ונפתחת בנגן. ההתאמה: מתחילה עד 20 דקות מהאירוע,
   * ושם דומה או משתתף משותף. נשמר לשתי דקות, כדי שהורדה והוספה של יומנים לא ימשכו שוב.
   */
  const recCache = new Map();
  async function loadRecordings(r) {
    if (!info.timeless?.connected) return [];
    const today = iso(new Date());
    if (r.from > today) return [];
    const key = `${r.from}|${r.to < today ? r.to : today}`;
    const hit = recCache.get(key);
    if (hit && Date.now() - hit.at < 120000) return hit.list;
    try {
      const list = (await API.get(`/api/timeless/recordings?from=${r.from}&to=${r.to < today ? r.to : today}`)).recordings ?? [];
      recCache.set(key, { at: Date.now(), list });
      return list;
    } catch { return []; }
  }
  const normTitle = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const mailsOf = (list) => new Set(list.flatMap((p) => String(p).match(/[^\s<>"']+@[^\s<>"']+/g) ?? []).map((x) => x.toLowerCase()));
  function markRecordings(events, recs) {
    if (!recs.length) return;
    const prepared = recs.map((rec) => ({ rec, t: new Date(rec.start).getTime(), title: normTitle(rec.title), mails: mailsOf(rec.participants ?? []) }));
    for (const e of events) {
      if (e.allDay || e.busyOnly) continue;
      const t = new Date(e.start).getTime();
      const title = normTitle(e.title);
      const owner = info.calendars.find((c) => c.userId === e.userId)?.email?.toLowerCase();
      const mails = new Set([owner, ...(e.attendees ?? []).map((a) => String(a.email ?? '').toLowerCase())].filter(Boolean));
      const hit = prepared.find((p) => Math.abs(p.t - t) <= 20 * 60000
        && ((title && p.title && (title.includes(p.title) || p.title.includes(title))) || [...p.mails].some((m) => mails.has(m))));
      if (hit) e.rec = { id: hit.rec.id, title: hit.rec.title };
    }
  }

  // רק התשובה האחרונה נכנסת למסך — לחיצות מהירות על היומנים לא מחזירות תמונה ישנה
  let rangeSeq = 0;
  async function loadRange() {
    const r = range();
    const mine = ++rangeSeq;
    let res;
    const recsP = loadRecordings(r);
    try {
      res = view.users.length
        ? await API.get(`/api/meetings/range?from=${r.from}&to=${r.to}&users=${view.users.join(',')}`)
        : { events: [], access: {} };
    } catch (err) {
      res = { events: [], access: {}, error: err.message };
    }
    markRecordings(res.events ?? [], await recsP);
    if (mine !== rangeSeq) return;
    data = res;
    draw();
  }

  // הורדה / הוספה של יומן: המסך מתעדכן מיד מהנתונים שכבר יש, והטעינה — אחרי שהלחיצות נרגעות
  let toggleTimer = null;
  function usersChanged() {
    App.setPref(HIDDEN_PREF, [...view.hidden]);
    const before = new Set(view.users);
    syncUsers();
    draw();
    const added = view.users.some((id) => !before.has(id));
    clearTimeout(toggleTimer);
    // רק הורדה — אין מה לטעון, האירועים כבר במסך
    if (added) toggleTimer = setTimeout(loadRange, 350);
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

    const secretary = Boolean(info.secretary);
    // ברירת מחדל: פתוח במחשב, ממוזער בטלפון (שם הוא צף מעל היומן)
    const narrow = window.matchMedia?.('(max-width: 820px)').matches;
    const dockOpen = secretary && App.getPref(DOCK_PREF, narrow ? 'min' : 'open') !== 'min';
    UI.mount(containerRef, el(`div.cal${dockOpen ? '.has-dock' : ''}`, {}, [
      // ראשון במסמך: במחשב הוא צף ממילא; בטלפון הכפתור הממוזער יושב בראש היומן
      secretary ? pendingDock(dockOpen) : null,
      tabs(),
      el('div.cal-head', {}, [
        el('h2', { text: '📅 יומן' }),
        el('div.seg', {}, [['day', 'יום'], ['week', 'שבוע']].map(([k, label]) =>
          el(`button${view.mode === k ? '.active' : ''}`, { onclick: () => { view.mode = k; loadRange(); } }, [label]))),
        // ביום, כשמוצג יותר מיומן אחד: הכול בעמודה אחת, או עמודה לכל עובד
        secretary && view.mode === 'day' && view.users.length > 1
          ? el('div.seg', { title: 'איך להציג כמה יומנים' }, [['combined', 'משולב'], ['columns', 'עמודה לכל עובד']].map(([k, label]) =>
              el(`button${view.layout === k ? '.active' : ''}`, { onclick: () => { view.layout = k; App.setPref(LAYOUT_PREF, k); draw(); } }, [label])))
          : null,
        el('button.btn.btn-sm', { title: 'הקודם', onclick: () => { view.date = addDays(view.date, view.mode === 'day' ? -1 : -7); loadRange(); } }, ['▶']),
        el('b.cal-title', { text: title }),
        el('button.btn.btn-sm', { title: 'הבא', onclick: () => { view.date = addDays(view.date, view.mode === 'day' ? 1 : 7); loadRange(); } }, ['◀']),
        el('button.btn.btn-sm', { onclick: () => { view.date = new Date(); loadRange(); } }, ['היום']),
        el('div.spacer'),
        // קביעת פגישה בלי לבחור משבצת ובלי משימה — מזכירה: בכל יומן ששותף איתה; עובד: ביומן שלו
        info.google?.calendar || secretary ? el('button.btn.btn-sm.btn-primary', { onclick: scheduleNew }, ['📅 קביעת פגישה']) : null,
        el('button.btn.btn-sm.cal-refresh', { title: secretary ? 'רענון: היומנים ששותפו, הפגישות והמשימות שמחכות' : 'רענון הפגישות', onclick: (e) => refreshAll(e.currentTarget) }, ['⟳ רענון'])
      ]),
      // היומן של Google לא מחובר — בלי זה אין מה להציג
      !info.google?.calendar ? el('div.alert.alert-warn', {}, [el('span', { text: '📅' }), el('div', {}, [
        el('b', { text: 'צריך לחבר את היומן של Google' }),
        el('div', { text: 'היומן כאן הוא היומן שלך ב-Google. חיבור פעם אחת — ואפשר לראות פגישות ולקבוע אותן מכאן.' }),
        el('a.btn.btn-primary.btn-sm.mt', { href: '/api/me/gmail/connect' }, ['חיבור Google'])
      ])]) : null,
      secretary ? el('div.cal-access', {}, [
        `שיתפו איתך לעריכה: ${counts.write} · לצפייה: ${counts.read} · לא שיתפו: ${counts.none}`,
        counts.none ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); shareHelp(); } }, [' · איך משתפים']) : null
      ]) : null,
      // עובד רואה רק את היומן של עצמו — אין את מי לבחור
      secretary ? peoplePicker() : null,
      data?.error ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: data.error })]) : null,
      view.mode === 'week' ? weekGrid(r.days) : view.layout === 'columns' && view.users.length > 1 ? dayGrid(r.days[0]) : combinedDay(r.days[0])
    ]));
  }

  /**
   * היומנים — כמו ב-Google: כולם מסומנים, לחיצה מורידה / מחזירה. הצבע של כל
   * עובד קבוע, וזה המקרא של הפגישות ביומן.
   */
  function peoplePicker() {
    const search = el('input', { type: 'search', placeholder: 'חיפוש עובד…', value: view.filter, style: { width: '150px' } });
    search.addEventListener('input', () => { view.filter = search.value; drawChips(); });
    const chips = el('div.cal-people');
    const visible = () => {
      const q = view.filter.trim();
      return info.calendars.filter((c) => !q || c.name.includes(q) || c.email.includes(q));
    };
    const drawChips = () => {
      UI.mount(chips, ...visible().map((c) => {
        const on = !view.hidden.has(c.userId);
        const access = c.self ? 'owner' : c.access;
        const color = colorOf(c.userId);
        return el(`button.cal-chip${on ? '.on' : ''}${['owner', 'write'].includes(access) ? '' : '.is-limited'}`, {
          type: 'button',
          'aria-pressed': String(on),
          title: `${on ? 'להוריד מהתצוגה' : 'להציג'} · ${access === 'none' ? 'לא שיתף/ה — רק "תפוס"' : access === 'read' || access === 'freebusy' ? 'צפייה בלבד' : 'עריכה'}`,
          style: on ? { background: color, borderColor: color } : { borderColor: color },
          onclick: () => {
            // לפי המצב הנוכחי — לא לפי מה שהיה כשהשבב צויר (לחיצה כפולה לא מכפילה)
            if (view.hidden.has(c.userId)) view.hidden.delete(c.userId);
            else view.hidden.add(c.userId);
            usersChanged();
          }
        }, [el('span.cal-chip-box', { text: on ? '✓' : '', style: on ? {} : { borderColor: color } }), c.self ? `${c.name} (אני)` : c.name]);
      }));
    };
    drawChips();
    const setAll = (show) => {
      const ids = visible().map((c) => c.userId);
      for (const id of ids) show ? view.hidden.delete(id) : view.hidden.add(id);
      usersChanged();
    };
    return el('div.cal-people-row', {}, [
      el('div.cal-people-tools', {}, [
        search,
        el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'להציג את כל היומנים (שברשימה)', onclick: () => setAll(true) }, ['הכול']),
        el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'להוריד את כל היומנים (שברשימה)', onclick: () => setAll(false) }, ['נקה'])
      ]),
      chips
    ]);
  }

  /**
   * פגישה שמופיעה בכמה יומנים (כולם מוזמנים) — בלוק אחד, עם כל בעלי היומנים.
   * ‎userId‎ של הבלוק — מי שארגן אותה, כדי ש"הזזה" תעבוד ממנו.
   */
  function mergeShared(events) {
    const byKey = new Map();
    const out = [];
    for (const e of events) {
      const key = e.eventId && !e.busyOnly ? `${e.eventId}|${e.start}` : null;
      const hit = key ? byKey.get(key) : null;
      if (!hit) {
        const x = { ...e, owners: [e.userId] };
        if (key) byKey.set(key, x);
        out.push(x);
        continue;
      }
      if (!hit.owners.includes(e.userId)) hit.owners.push(e.userId);
      if (e.organizerIsOwner && e.editable && !(hit.organizerIsOwner && hit.editable)) {
        Object.assign(hit, { ...e, owners: hit.owners });
      }
    }
    return out;
  }

  // --- רשת יום משולבת: עמודה אחת, כל היומנים המוצגים
  function combinedDay(day) {
    if (!view.users.length) return UI.empty('בחרו יומנים להצגה', '👥');
    const single = view.users.length === 1 ? info.calendars.find((c) => c.userId === view.users[0]) : null;
    return grid([{
      key: iso(day),
      label: single ? nameOf(single.userId) : `${DAY_NAMES[day.getDay()]} ${day.getDate()}.${day.getMonth() + 1} · ${view.users.length} יומנים`,
      date: day,
      ownerId: single ? single.userId : null,
      writable: true,
      showWho: view.users.length > 1,
      events: mergeShared((data?.events ?? []).filter((e) => view.users.includes(e.userId) && sameDay(e.start, day)))
    }]);
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
      color: colorOf(p.userId),
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
      showWho: view.users.length > 1,
      events: mergeShared((data?.events ?? []).filter((e) => view.users.includes(e.userId) && sameDay(e.start, d)))
    })));
  }

  const sameDay = (s, d) => iso(new Date(s)) === iso(d);
  /** בעלי היומנים של הבלוק: "מורן אדי", או "מורן אדי +2" */
  const whoOf = (e) => {
    const owners = e.owners ?? [e.userId];
    const first = nameOf(e.userId); // בצבע שלו הבלוק — מי שארגן
    return owners.length > 1 ? `${first} +${owners.length - 1}` : first;
  };

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
      ...columns.map((c) => el('div.cal-colhead', c.color ? { style: { boxShadow: `inset 0 -3px 0 ${c.color}` } } : {}, [c.label])),
      el('div.cal-hours', {}, hours.map((h) => el('div.cal-hour', { text: `${pad(h)}:00` }))),
      ...columns.map((c) => {
        const allDay = c.events.filter((e) => e.allDay);
        const timed = layout(c.events.filter((e) => !e.allDay));
        // השעה במשבצת שמתחת לסמן — ברבעי שעה
        const slotAt = (clientY) => {
          const rect = col.getBoundingClientRect();
          const minutes = Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * total / 15) * 15);
          const start = new Date(c.date);
          start.setHours(HOUR_FROM, 0, 0, 0);
          start.setMinutes(minutes);
          return start;
        };
        const col = el('div.cal-col', {
          onclick: (e) => {
            if (e.target !== col) return;
            newMeeting(c.ownerId, slotAt(e.clientY));
          },
          // משימה שנגררה מ"מחכות לקביעה" — הדיאלוג נפתח עם המשימה, היומן והשעה
          ondragover: (e) => {
            if (!dragTask) return;
            e.preventDefault();
            col.classList.add('is-drop');
          },
          ondragleave: () => col.classList.remove('is-drop'),
          ondrop: (e) => {
            col.classList.remove('is-drop');
            if (!dragTask) return;
            e.preventDefault();
            const task = dragTask;
            dragTask = null;
            scheduleTask(task, c.ownerId, slotAt(e.clientY));
          }
        }, [
          ...hours.map((h, i) => el('div.cal-line', { style: { top: `${(i / hours.length) * 100}%` } })),
          sameDay(now, c.date) && now.getHours() >= HOUR_FROM && now.getHours() < HOUR_TO
            ? el('div.cal-now', { style: { top: `${top(now)}%` } }) : null,
          ...allDay.map((e, i) => el('div.cal-allday', { style: { top: `${i * 20}px`, background: colorOf(e.userId) }, onclick: (ev) => { ev.stopPropagation(); openEvent(e); } },
            [c.showWho ? `${whoOf(e)} · ${e.title ?? 'תפוס'}` : e.title ?? 'תפוס'])),
          ...timed.map(({ e, lane, lanes }) => el(`div.cal-ev${e.busyOnly ? '.is-busy' : ''}${e.meetingId ? '.is-ours' : ''}`, {
            style: {
              top: `${top(e.start)}%`,
              height: `${Math.max(2.2, top(e.end) - top(e.start))}%`,
              insetInlineStart: `${(lane / lanes) * 100}%`,
              width: `${100 / lanes}%`,
              // "תפוס" בלי פרטים — אפור, ובתצוגה משולבת פס בצבע של העובד
              ...(e.busyOnly ? (c.showWho ? { borderInlineStart: `4px solid ${colorOf(e.userId)}` } : {}) : { background: colorOf(e.userId) })
            },
            title: `${hhmm(e.start)}–${hhmm(e.end)} ${e.title ?? 'תפוס'}${c.showWho ? ` · ${whoOf(e)}` : ''}`,
            onclick: (ev) => { ev.stopPropagation(); openEvent(e); }
          }, [
            // בתצוגה משולבת — של מי הפגישה: שם, ונקודה בצבע של כל יומן נוסף
            c.showWho ? el('div.cal-ev-who', {}, [
              ...(e.owners ?? []).filter((id) => id !== e.userId).slice(0, 5).map((id) => el('span.cal-ev-dot', { style: { background: colorOf(id) } })),
              whoOf(e)
            ]) : null,
            el('b', { text: e.title ?? 'תפוס' }),
            el('span', { text: ` ${hhmm(e.start)}` }),
            e.meetingId ? el('span', { text: ' ✦' }) : null,
            e.rec ? el('span.cal-ev-rec', { title: 'יש הקלטה ב-Timeless' }, ['🎥 הקלטה']) : null
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

  /**
   * ⟳ — שואל את Google מחדש מי שיתף (גם יומנים שעוד לא נוספו לרשימה), טוען
   * את הפגישות ואת "מחכות לקביעה", ואומר מה השתנה.
   */
  async function refreshAll(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.textContent = '⟳ מרענן…';
    const writable = (list) => new Set(list.filter((c) => !c.self && ['owner', 'write'].includes(c.access)).map((c) => c.userId));
    const before = writable(info.calendars);
    try {
      info = await API.get(`/api/meetings/calendars${info.secretary ? '?fresh=1' : ''}`);
      pending = info.secretary ? (await API.get('/api/meetings/pending')).tasks : [];
      const after = writable(info.calendars);
      const added = [...after].filter((id) => !before.has(id));
      // עובד ששיתף עכשיו — מופיע מיד במסך
      for (const id of added) view.hidden.delete(id);
      if (added.length) App.setPref(HIDDEN_PREF, [...view.hidden]);
      syncUsers();
      await loadRange();
      if (info.accessError) UI.toast(info.accessError, 'error');
      else if (!info.secretary) UI.success('עודכן');
      else if (added.length) {
        const names = added.map((id) => info.calendars.find((c) => c.userId === id)?.name).filter(Boolean);
        UI.success(`נוספו ${added.length === 1 ? 'יומן אחד' : `${added.length} יומנים`} לעריכה: ${names.join(', ')}`);
      } else UI.success(`עודכן — ${after.size} יומנים משותפים לעריכה`);
    } catch (err) {
      UI.error(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.textContent = '⟳ רענון';
    }
  }

  /**
   * "📅 קביעת פגישה" בראש המסך — הדיאלוג הרגיל, בלי משימה. ביומן של העובד
   * היחיד שמוצג (אם שיתף לעריכה), ואחרת ביומן שלי; בדיאלוג אפשר להחליף.
   */
  function scheduleNew() {
    const editable = (c) => c && (c.self || ['owner', 'write'].includes(c.access));
    const shown = view.users.map((id) => info.calendars.find((c) => c.userId === id)).filter(editable);
    const ownerId = shown.length === 1 ? shown[0].userId : info.calendars.find((c) => c.self)?.userId;
    MeetingView.openDialog({ prefill: ownerId ? { ownerId } : {}, onDone: () => { reload(); refreshPending(); } });
  }

  /** האם אפשר לקבוע ביומן של העובד — ‎null‎, או ההסבר למה לא */
  function blockedCalendar(ownerId) {
    const cal = ownerId ? info.calendars.find((c) => c.userId === ownerId) : null;
    if (cal?.self && cal.access === 'none') return 'כדי לקבוע פגישות צריך לחבר את היומן של Google';
    if (cal && !['owner', 'write'].includes(cal.self ? 'owner' : cal.access)) return `${cal.name} לא שיתף/ה איתך את היומן לעריכה`;
    return null;
  }

  /** משימה מ"מחכות לקביעה" שנגררה למשבצת — הדיאלוג, ממולא */
  function scheduleTask(task, ownerId, start) {
    const why = blockedCalendar(ownerId);
    if (why) return UI.toast(why, 'error');
    MeetingView.openDialog({ task, prefill: { ...(ownerId ? { ownerId } : {}), start: start.toISOString() }, onDone: () => { reload(); refreshPending(); } });
  }

  /** משבצת ריקה — פגישה חדשה, למשימה שמחכה או בלי משימה */
  function newMeeting(ownerId, start) {
    const why = blockedCalendar(ownerId);
    if (why) return UI.toast(why, 'error');
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
    if (e.rec) {
      buttons.push(el('button.btn.btn-sm.btn-primary', { onclick: () => { m.close(); RecordingPlayer.open(e.rec.id); } }, ['▶ צפייה ותמליל']));
      buttons.push(el('button.btn.btn-sm', { onclick: () => { m.close(); RecordingPlayer.open(e.rec.id, { tab: 'summary' }); } }, ['📋 סיכום ומשימות']));
    }
    if (e.taskId) buttons.push(el('button.btn.btn-sm', { onclick: () => { m.close(); TaskCardView.open(e.taskId); } }, ['פתיחת המשימה']));
    // פגישה שהוקלטה — משפט אחד מהסיכום (נטען כשהחלון נפתח)
    const brief = e.rec ? el('div.cal-rec-brief.mute-sm', {}, [el('span.spinner-sm'), ' טוען סיכום…']) : null;
    if (e.rec) {
      API.get(`/api/timeless/recordings/${encodeURIComponent(e.rec.id)}/digest`)
        .then((d) => { if (d.brief) UI.mount(brief, el('b', { text: 'בקצרה: ' }), el('span', { text: d.brief })); else brief.remove(); })
        .catch(() => brief.remove());
    }
    if (e.link) buttons.push(el('a.btn.btn-sm', { href: e.link, target: '_blank', rel: 'noopener' }, ['פתיחה ב-Google ↗']));
    if (e.editable && e.organizerIsOwner && !e.busyOnly && !e.allDay) {
      buttons.push(el('button.btn.btn-sm', { onclick: () => { m.close(); moveDialog(e); } }, ['🔀 הזזה']));
    }
    const m = UI.modal({
      title: e.title ?? 'תפוס',
      body: el('div', {}, [
        el('div', { text: `${new Date(e.start).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' })} · ${e.allDay ? 'כל היום' : `${hhmm(e.start)}–${hhmm(e.end)}`}` }),
        el('div.mute-sm', { text: `${(e.owners?.length ?? 1) > 1 ? `ביומנים של ${e.owners.map(nameOf).join(', ')}` : `ביומן של ${person?.name ?? ''}`}${e.busyOnly ? ' · זמינות בלבד — העובד לא שיתף פרטים' : ''}` }),
        e.location ? el('div.mute-sm', { text: `📍 ${e.location}` }) : null,
        brief,
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

  // --- מחכות לקביעה — למזכירות בלבד
  let dragTask = null;

  async function refreshPending() {
    if (info?.secretary) {
      try { pending = (await API.get('/api/meetings/pending')).tasks; } catch { /* נשאר */ }
    }
    draw();
  }

  const setDock = (state) => { App.setPref(DOCK_PREF, state); draw(); };

  /**
   * לוח צף משמאל ליומן. פתוח — רשימת המשימות, עם "📅 קביעה" וגרירה למשבצת;
   * ממוזער — כפתור קטן עם המספר. היומן מפנה לו מקום (‎.cal.has-dock‎).
   */
  function pendingDock(open) {
    if (!open) {
      return el('button.cal-dock-pill', { title: 'פתיחת המשימות שמחכות לקביעה', onclick: () => setDock('open') }, [
        el('span', { text: '📌 מחכות לקביעה' }),
        el('span.today-count', { text: String(pending.length) })
      ]);
    }
    return el('aside.cal-dock', { 'aria-label': 'משימות שמחכות לקביעת פגישה' }, [
      el('div.cal-dock-head', {}, [
        el('b', { text: '📌 מחכות לקביעה' }),
        el('span.today-count', { text: String(pending.length) }),
        el('div.spacer'),
        el('button.btn.btn-sm.btn-ghost.cal-dock-min', { title: 'מזעור', 'aria-label': 'מזעור', onclick: () => setDock('min') }, ['—'])
      ]),
      pending.length ? el('div.mute-sm.cal-dock-hint', { text: 'גררו משימה למשבצת ביומן, או "📅 קביעה"' }) : null,
      el('div.cal-dock-list', {}, pending.length
        ? pending.map((t) => el('div.cal-dock-task', {
            draggable: 'true',
            ondragstart: (e) => {
              dragTask = t;
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('text/plain', t.title);
            },
            ondragend: () => { dragTask = null; }
          }, [
            el('div.cal-dock-main', { onclick: () => TaskCardView.open(t.id) }, [
              el('div.today-title', { text: t.title }),
              el('div.mute-sm', { text: [t.requestedByName ? `ביקש/ה: ${t.requestedByName}` : null, t.assigneeName, t.projectName, t.statusShort].filter(Boolean).join(' · ') })
            ]),
            el('button.btn.btn-sm.btn-primary', {
              onclick: () => {
                // משימה למזכירות — ביומן של מי שביקש, אם שיתף אותו לעריכה
                const ownerId = t.requestedBy && !blockedCalendar(t.requestedBy) ? t.requestedBy : undefined;
                MeetingView.openDialog({ task: t, prefill: ownerId ? { ownerId } : null, onDone: () => { reload(); refreshPending(); } });
              }
            }, ['📅 קביעה'])
          ]))
        : [el('div.mute-sm.cal-dock-empty', { text: 'אין משימות שמחכות לקביעת פגישה ✓' })])
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
