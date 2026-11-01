'use strict';
/**
 * 📅 קביעת פגישה מתוך משימה.
 *
 *   openDialog — הדיאלוג: נושא מהמשימה, "ביומן של" (למזכירה — כל עובד ששיתף
 *                איתה), משתתפים מאנשי הקשר, משך, מועד עם שורת זמינות, "💡 הצע
 *                מועדים", "🔀 חלופות" כשהמועד תפוס, ו-Zoom בסימון אחד.
 *   panel      — הכרטיס בתוך המשימה: הפגישה שנקבעה, מי אישר, Zoom, שינוי וביטול.
 *
 * כל ההחלטות על הרשאות — בשרת (‎server/meetings.js‎), לפי מה שכל עובד שיתף ב-Google.
 */

const MeetingView = (() => {
  const { el } = UI;

  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hhmm = (iso) => localTime(new Date(iso));
  const when = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const shortWhen = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const RESPONSE = { accepted: '✓', declined: '✗', tentative: '?', needsAction: '·' };
  const RESPONSE_TITLE = { accepted: 'אישר/ה', declined: 'דחה/תה', tentative: 'אולי', needsAction: 'עוד לא ענה/תה' };

  /** המועד הקרוב שמתחיל ברבע שעה עגולה, לפחות שעה מעכשיו */
  /** המועד העגול הבא שעוד בשעות הפגישות ("08:30-18:00"); אחרי השעות — יום העבודה הבא */
  function nextRoundSlot(hours = '08:30-18:00', minutes = 30) {
    const [from, to] = String(hours).split('-').map((x) => x.split(':').map(Number));
    const d = new Date(Date.now() + 60 * 60000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    const atFrom = (x) => { x.setHours(from[0], from[1] || 0, 0, 0); return x; };
    const mins = (x) => x.getHours() * 60 + x.getMinutes();
    if (mins(d) < from[0] * 60 + (from[1] || 0)) atFrom(d);
    if (mins(d) + minutes > to[0] * 60 + (to[1] || 0)) { d.setDate(d.getDate() + 1); atFrom(d); }
    while (d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }

  // ------------------------------------------------------------- הדיאלוג

  /**
   * @param {object} opts
   * @param {object} [opts.task]      המשימה שממנה קובעים
   * @param {object} [opts.meeting]   פגישה קיימת — שינוי
   * @param {object} [opts.prefill]   ‎{ attendees: [{email,name}], start, minutes, ownerId }‎
   * @param {Function} [opts.onDone]  נקרא עם הפגישה אחרי קביעה או שינוי
   */
  async function openDialog(opts = {}) {
    let info;
    try {
      info = await API.get('/api/meetings/calendars');
    } catch (err) {
      return UI.error(err);
    }
    const editing = opts.meeting ?? null;
    const writable = info.calendars.filter((c) => ['owner', 'write'].includes(c.access));
    if (!writable.length && !editing) {
      UI.modal({
        title: '📅 קביעת פגישה',
        body: el('div.alert.alert-warn', {}, [el('span', { text: '📅' }), el('div', {}, [
          el('b', { text: 'צריך לחבר את היומן של Google' }),
          el('div', { text: 'הפגישה נקבעת ביומן שלך ב-Google, וההזמנה יוצאת ממנו. חיבור פעם אחת — "החשבון שלי ← חיבור Google".' }),
          el('a.btn.btn-primary.mt', { href: '/api/me/gmail/connect' }, ['חיבור Google'])
        ])])
      });
      return;
    }

    const me = App.state.actor;
    const state = {
      ownerId: editing?.ownerId ?? opts.prefill?.ownerId ?? (writable.find((c) => c.self)?.userId ?? writable[0]?.userId),
      attendees: (editing?.attendees ?? opts.prefill?.attendees ?? []).map((a) => ({ email: a.email, name: a.name ?? '' })),
      minutes: editing?.minutes ?? opts.prefill?.minutes ?? info.defaults.minutes,
      date: '',
      time: '',
      locationType: editing?.locationType ?? (info.zoom.enabled ? 'zoom' : 'place'),
      suggestions: null,
      alternatives: null,
      avail: null
    };
    const startAt = editing ? new Date(editing.start) : opts.prefill?.start ? new Date(opts.prefill.start) : nextRoundSlot(info.defaults.hours, opts.prefill?.minutes ?? info.defaults.minutes);
    state.date = localDate(startAt);
    state.time = localTime(startAt);

    const titleInput = el('input', { type: 'text', value: editing?.title ?? opts.task?.title ?? '' });
    const notesInput = el('textarea', { placeholder: 'נכנס לתיאור הפגישה ביומן', style: { minHeight: '56px' } });
    notesInput.value = editing?.notes ?? '';
    const locationInput = el('input', { type: 'text', value: editing?.locationType !== 'zoom' ? editing?.location ?? '' : '' });
    const sendInvites = el('input', { type: 'checkbox', checked: true });
    const dateInput = el('input', { type: 'date', value: state.date });
    const timeInput = el('input', { type: 'time', value: state.time, step: 900 });

    const body = el('div.mt-dialog');
    const m = UI.modal({ title: editing ? '📅 שינוי פגישה' : '📅 קביעת פגישה', body, size: 'wide' });
    const startIso = () => new Date(`${state.date}T${state.time}:00`).toISOString();
    const emails = () => state.attendees.map((a) => a.email);

    // --- ביומן של
    const ownerField = () => {
      if (!info.secretary) return null;
      const options = info.calendars.map((c) => ({
        value: String(c.userId),
        label: `${c.name}${c.self ? ' (אני)' : ''}${['owner', 'write'].includes(c.access) ? '' : c.access === 'read' ? ' — צפייה בלבד' : ' — לא שיתף/ה'}`
      }));
      const sel = UI.select(options, String(state.ownerId));
      for (const o of sel.options) {
        const c = info.calendars.find((x) => String(x.userId) === o.value);
        if (!['owner', 'write'].includes(c?.access)) o.disabled = true;
      }
      sel.addEventListener('change', () => { state.ownerId = Number(sel.value); state.suggestions = null; state.alternatives = null; draw(); loadAvailability(); });
      const notShared = info.calendars.filter((c) => !c.self && !['owner', 'write'].includes(c.access)).length;
      return UI.field('ביומן של', sel, notShared
        ? `${notShared} עובדים לא שיתפו איתך את היומן לעריכה — הם מופיעים באפור. ההזמנה יוצאת בשם בעל היומן.`
        : 'ההזמנה יוצאת בשם בעל היומן');
    };

    // --- משתתפים
    function attendeesBox() {
      const picker = ContactPicker.create({
        onPick: (c) => {
          const email = c.email || c.emails?.[0]?.value;
          if (!email) return UI.toast(`ל${c.name} אין כתובת מייל — אי אפשר להזמין`, 'error');
          picker.input.value = '';
          if (!state.attendees.some((a) => a.email === email)) state.attendees.push({ email, name: c.name || '' });
          state.alternatives = null;
          draw();
          loadAvailability();
          setTimeout(() => body.querySelector('.cp input')?.focus(), 30);
        }
      });
      // כתובת שהוקלדה ידנית ואינה ברשימה — Enter מוסיף אותה
      picker.input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = picker.input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
        e.preventDefault();
        if (!state.attendees.some((a) => a.email === v)) state.attendees.push({ email: v, name: '' });
        picker.input.value = '';
        draw();
        loadAvailability();
      });
      picker.input.placeholder = 'שם, חברה או מייל — ו-Enter לכתובת חדשה';
      return el('div', {}, [
        picker.node,
        state.attendees.length
          ? el('div.mt-chips', {}, state.attendees.map((a) => {
              const resp = editing?.attendees.find((x) => x.email === a.email)?.response;
              return el('span.chip.chip-assignee', { title: a.email }, [
                resp ? el('span', { title: RESPONSE_TITLE[resp], text: `${RESPONSE[resp]} ` }) : null,
                el('span', { text: a.name ? `${a.name} · ${a.email}` : a.email }),
                el('button.chip-x', { type: 'button', title: 'הסרה', onclick: () => { state.attendees = state.attendees.filter((x) => x.email !== a.email); state.alternatives = null; draw(); loadAvailability(); } }, ['✕'])
              ]);
            }))
          : el('div.mute-sm', { text: 'אפשר גם בלי משתתפים — פגישה ביומן בלבד.' })
      ]);
    }

    // --- משך
    function minutesBox() {
      const preset = [30, 45, 60, 90];
      const other = el('input', { type: 'number', min: 5, max: 600, step: 5, value: preset.includes(state.minutes) ? '' : state.minutes, placeholder: 'אחר', style: { width: '80px' } });
      other.addEventListener('change', () => { if (Number(other.value) > 0) { state.minutes = Number(other.value); state.suggestions = null; draw(); } });
      return el('div.flex', { style: { flexWrap: 'wrap', gap: '6px' } }, [
        el('div.seg', {}, preset.map((n) => el(`button${state.minutes === n ? '.active' : ''}`, {
          type: 'button', onclick: () => { state.minutes = n; state.suggestions = null; state.alternatives = null; draw(); }
        }, [`${n} דק׳`]))),
        other
      ]);
    }

    // --- שורת הזמינות
    function availabilityBox() {
      const a = state.avail;
      if (!a) return el('div.mt-avail.mute-sm', { text: 'טוען זמינות…' });
      if (a.error) return el('div.mt-avail.mute-sm', { text: a.error });
      const [fh, fm] = a.hours.from.split(':').map(Number);
      const [th, tm] = a.hours.to.split(':').map(Number);
      const dayStart = new Date(`${a.date}T${pad(Math.max(0, fh - 1))}:00:00`).getTime();
      const dayEnd = new Date(`${a.date}T${pad(Math.min(23, th + 1))}:00:00`).getTime();
      const span = dayEnd - dayStart;
      const pos = (iso) => Math.max(0, Math.min(100, ((new Date(iso).getTime() - dayStart) / span) * 100));
      const selStart = new Date(startIso()).getTime();
      const selEnd = selStart + state.minutes * 60000;
      const ticks = [];
      for (let h = Math.max(0, fh - 1); h <= Math.min(23, th + 1); h++) ticks.push(h);
      const rows = a.rows.map((r) => el('div.mt-row', {}, [
        el('div.mt-who', { title: r.email, text: r.name }),
        el('div.mt-track', {}, r.internal
          ? [
              ...r.busy.map((b) => {
                const clash = new Date(b.start).getTime() < selEnd && new Date(b.end).getTime() > selStart;
                return el(`div.mt-busy${clash ? '.is-clash' : ''}`, {
                  style: { insetInlineStart: `${pos(b.start)}%`, width: `${Math.max(0.8, pos(b.end) - pos(b.start))}%` },
                  title: `${hhmm(b.start)}–${hhmm(b.end)}${b.title ? ` · ${b.title}` : b.private ? ' · פרטי' : ''}`
                });
              }),
              r.error ? el('span.mt-note', { text: r.error === 'reconnect' ? 'צריך לחבר מחדש את Google' : 'אין מידע על זמינות' }) : null
            ]
          : [el('span.mt-note', { text: 'מחוץ לארגון — אין מידע על זמינות' })])
      ]));
      return el('div.mt-avail', {}, [
        el('div.mt-row.mt-head', {}, [el('div.mt-who'), el('div.mt-track', {}, ticks.map((h) => el('span.mt-tick', { style: { insetInlineStart: `${pos(`${a.date}T${pad(h)}:00:00`)}%` }, text: String(h) })))]),
        ...rows,
        el('div.mt-row.mt-sel-row', {}, [el('div.mt-who'), el('div.mt-track', {}, [
          el('div.mt-sel', { style: { insetInlineStart: `${pos(new Date(selStart).toISOString())}%`, width: `${Math.max(1, pos(new Date(selEnd).toISOString()) - pos(new Date(selStart).toISOString()))}%` } })
        ])])
      ]);
    }

    function conflictsOf() {
      const a = state.avail;
      if (!a || a.error) return [];
      const s = new Date(startIso()).getTime();
      const e = s + state.minutes * 60000;
      const out = [];
      for (const r of a.rows) {
        for (const b of r.busy) {
          if (new Date(b.start).getTime() < e && new Date(b.end).getTime() > s) out.push({ who: r.name, ...b });
        }
      }
      return out;
    }

    let availSeq = 0;
    async function loadAvailability() {
      const mine = ++availSeq;
      state.avail = null;
      redrawAvail();
      try {
        const res = await API.post('/api/meetings/availability', { ownerId: state.ownerId, emails: emails(), date: state.date });
        if (mine !== availSeq) return;
        state.avail = res;
      } catch (err) {
        if (mine !== availSeq) return;
        state.avail = { error: err.message };
      }
      redrawAvail();
    }

    const availSlot = el('div');
    const conflictSlot = el('div');
    function redrawAvail() {
      UI.mount(availSlot, availabilityBox());
      const conflicts = conflictsOf();
      UI.mount(conflictSlot,
        conflicts.length
          ? el('div.mt-conflicts', {}, [
              ...conflicts.map((c) => el('div.text-danger', { text: `⚠ ${c.who} תפוס/ה ${hhmm(c.start)}–${hhmm(c.end)}${c.title ? ` (${c.title})` : ''}` })),
              el('button.btn.btn-sm.mt', { type: 'button', onclick: loadAlternatives }, ['🔀 חלופות — מה להזיז'])
            ])
          : state.avail && !state.avail.error ? el('div.text-ok.mute-sm', { text: '✓ כל המשתתפים מהארגון פנויים במועד הזה' }) : null,
        alternativesBox()
      );
    }

    // --- הצעת מועדים
    async function loadSuggestions(btn) {
      btn.disabled = true;
      btn.textContent = 'מחפש…';
      try {
        state.suggestions = await API.post('/api/meetings/suggest', { ownerId: state.ownerId, emails: emails(), minutes: state.minutes });
      } catch (err) {
        UI.error(err);
      }
      draw();
    }
    function suggestionsBox() {
      const s = state.suggestions;
      if (!s) return null;
      if (!s.slots.length) return el('div.mute-sm', { text: 'לא נמצא מועד שכולם פנויים בו בשבוע הקרוב — נסו "🔀 חלופות".' });
      return el('div.mt-slots', {}, [
        el('div.mute-sm', { text: `💡 מועדים שבהם כולם פנויים${s.unknown?.length ? ` (בלי מידע על ${s.unknown.length})` : ''}:` }),
        ...s.slots.map((x) => el(`button.mt-slot${startIso() === x.start ? '.on' : ''}`, {
          type: 'button',
          onclick: () => {
            const d = new Date(x.start);
            state.date = localDate(d);
            state.time = localTime(d);
            dateInput.value = state.date;
            timeInput.value = state.time;
            state.alternatives = null;
            draw();
            loadAvailability();
          }
        }, [shortWhen(x.start)]))
      ]);
    }

    // --- חלופות
    async function loadAlternatives() {
      state.alternatives = { loading: true };
      redrawAvail();
      try {
        state.alternatives = await API.post('/api/meetings/alternatives', { ownerId: state.ownerId, emails: emails(), start: startIso(), minutes: state.minutes });
      } catch (err) {
        state.alternatives = { error: err.message };
      }
      redrawAvail();
    }
    function alternativesBox() {
      const a = state.alternatives;
      if (!a) return null;
      if (a.loading) return el('div.mt-alts.mute-sm', {}, [el('span.spinner-sm'), ' ה-AI בודק אילו פגישות אפשר להזיז…']);
      if (a.error) return el('div.mt-alts.text-danger', { text: a.error });
      if (!a.options.length) return el('div.mt-alts.mute-sm', { text: 'לא נמצאו חלופות. אפשר לקבוע בכל זאת — הפגישה תחפוף.' });
      return el('div.mt-alts', {}, [
        el('b', { text: `🔀 כדי לקבוע ב-${shortWhen(startIso())}:` }),
        ...a.options.map((o, i) => altRow(o, i))
      ]);
    }
    function altRow(o, i) {
      let label;
      let btnText;
      let act;
      if (o.type === 'slot') {
        label = `לקבוע את הפגישה ב-${shortWhen(o.to.start)} — כולם פנויים, בלי להזיז כלום`;
        btnText = `קביעה ב-${hhmm(o.to.start)}`;
        act = () => {
          const d = new Date(o.to.start);
          state.date = localDate(d); state.time = localTime(d);
          dateInput.value = state.date; timeInput.value = state.time;
          state.alternatives = null;
          draw(); loadAvailability();
        };
      } else if (o.type === 'ask') {
        label = `${o.who} תפוס/ה ${hhmm(o.conflict.start)}–${hhmm(o.conflict.end)} (בלי פרטים — לא שיתף/ה את היומן)`;
        btnText = null;
      } else {
        const c = o.conflict;
        label = `להזיז את "${c.title}" (${c.person}${c.attendees ? ` + ${c.attendees}` : ''}) ל-${shortWhen(o.to.start)}`;
        if (o.action === 'move') {
          btnText = 'הזזה וקביעה';
          act = async (btn) => {
            btn.disabled = true;
            try {
              await API.post('/api/meetings/move', { ownerId: c.ownerId, eventId: c.eventId, start: o.to.start, end: o.to.end });
              UI.success(`"${c.title}" הוזזה — המשתתפים שלה קיבלו עדכון`);
              await save();
            } catch (err) {
              btn.disabled = false;
              UI.error(err);
            }
          };
        } else if (o.action === 'request') {
          btnText = `בקשה מ${c.organizer} וקביעה`;
          act = async (btn) => {
            btn.disabled = true;
            try {
              const r = await API.post('/api/meetings/request-move', {
                organizerId: o.requestTo, eventId: c.eventId, calendarEmail: c.calendarEmail, to: { start: o.to.start }
              });
              UI.toast(`נשלחה בקשה ל${r.organizer} להזיז את "${c.title}"`);
              await save();
            } catch (err) {
              btn.disabled = false;
              UI.error(err);
            }
          };
        }
      }
      const btn = btnText ? el(`button.btn.btn-sm${i === 0 ? '.btn-primary' : ''}`, { type: 'button' }, [btnText]) : null;
      btn?.addEventListener('click', () => act(btn));
      return el('div.mt-alt', {}, [
        el('span.mt-alt-n', { text: String(i + 1) }),
        el('div.mt-alt-main', {}, [el('div', { text: label }), o.reason ? el('div.mute-sm', { text: `💬 ${o.reason}` }) : null]),
        btn
      ]);
    }

    // --- מיקום
    function locationBox() {
      const types = [
        info.zoom.enabled ? ['zoom', '🎥 Zoom — קישור נוצר אוטומטית'] : null,
        ['place', '📍 במשרד / כתובת'],
        ['link', '🔗 קישור משלי'],
        ['none', 'בלי מיקום']
      ].filter(Boolean);
      return el('div', {}, [
        el('div.mt-loc', {}, types.map(([key, label]) => el('label.today-radio', {}, [
          el('input', { type: 'radio', name: 'mt-loc', checked: state.locationType === key, onchange: () => { state.locationType = key; draw(); } }),
          el('span', { text: label })
        ]))),
        ['place', 'link'].includes(state.locationType) ? locationInput : null,
        state.locationType === 'zoom' ? el('div.mute-sm', { text: 'מחשבון ה-Zoom של החברה — מהמשתמש המקושר לבעל היומן, ואם הוא תפוס — ממשתמש פנוי.' }) : null,
        !info.zoom.enabled ? el('div.mute-sm', { text: 'Zoom עדיין לא מוגדר בשרת.' }) : null
      ]);
    }

    // --- שמירה
    const saveBtn = el('button.btn.btn-primary', {}, [editing ? 'שמירת שינויים' : '📅 קביעה']);
    async function save() {
      const title = titleInput.value.trim();
      if (!title) return UI.toast('נדרש נושא לפגישה', 'error');
      if (!state.date || !state.time) return UI.toast('נדרש מועד', 'error');
      saveBtn.disabled = true;
      const payload = {
        taskId: opts.task?.id ?? null,
        ownerId: state.ownerId,
        title,
        attendees: state.attendees,
        start: startIso(),
        minutes: state.minutes,
        locationType: state.locationType,
        location: locationInput.value.trim(),
        notes: notesInput.value,
        sendInvites: sendInvites.checked
      };
      try {
        const res = editing ? await API.patch(`/api/meetings/${editing.id}`, payload) : await API.post('/api/meetings', payload);
        m.close();
        UI.success(editing ? 'הפגישה עודכנה — המשתתפים קיבלו עדכון' : `הפגישה נקבעה ל${when(res.meeting.start)}${sendInvites.checked ? ' — ההזמנות יצאו' : ''}`);
        if (res.note) UI.toast(res.note);
        opts.onDone?.(res.meeting);
        App.refreshView();
      } catch (err) {
        saveBtn.disabled = false;
        UI.error(err);
      }
    }
    saveBtn.addEventListener('click', save);

    dateInput.addEventListener('change', () => { state.date = dateInput.value; state.alternatives = null; loadAvailability(); });
    timeInput.addEventListener('change', () => { state.time = timeInput.value; state.alternatives = null; redrawAvail(); });

    function draw() {
      const suggestBtn = el('button.btn.btn-sm', { type: 'button' }, ['💡 הצע מועדים']);
      suggestBtn.addEventListener('click', () => loadSuggestions(suggestBtn));
      UI.mount(body,
        !info.google.freebusy && info.google.calendar
          ? el('div.alert.alert-warn', {}, [el('span', { text: '🔄' }), el('div', {}, ['כדי לראות את הזמינות של עמיתים צריך לחבר מחדש את Google פעם אחת. ', el('a', { href: '/api/me/gmail/connect' }, ['חיבור מחדש'])])])
          : null,
        UI.field('נושא', titleInput),
        ownerField(),
        UI.field('משתתפים', attendeesBox()),
        UI.field('משך', minutesBox()),
        el('div.field', {}, [
          el('label', { text: 'מועד' }),
          el('div.flex', { style: { gap: '8px', flexWrap: 'wrap' } }, [dateInput, timeInput, suggestBtn]),
          suggestionsBox(),
          availSlot,
          conflictSlot
        ]),
        UI.field('מיקום', locationBox()),
        UI.field('הערות', notesInput),
        el('label.checkbox', {}, [sendInvites, editing ? ' לשלוח עדכון במייל למשתתפים' : ' לשלוח הזמנה במייל לכל המשתתפים']),
        el('div.ai-foot', { style: { marginTop: '14px' } }, [saveBtn, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])])
      );
      redrawAvail();
    }

    draw();
    loadAvailability();
    setTimeout(() => body.querySelector('.cp input')?.focus(), 60);
  }

  // ------------------------------------------------------------- כרטיס במשימה

  /**
   * הפגישה של המשימה, בתוך כרטיס המשימה. נטען ברקע — כרטיס המשימה לא מחכה לו.
   * @param {object} task
   * @param {Function} onChange  נקרא כשהמשימה השתנתה (נקבעה / בוטלה)
   */
  function panel(task, onChange) {
    if (App.isVendor()) return null;
    const box = el('div.mt-panel');
    const draw = (meetings) => {
      const current = meetings.find((x) => x.status === 'scheduled');
      const lastCancelled = !current ? meetings.find((x) => x.status === 'cancelled') : null;
      const schedule = (prefill = null) => openDialog({ task, prefill, onDone: () => onChange() });

      if (!current) {
        UI.mount(box, el(`div.mt-empty${task.meetingPending ? '.is-pending' : ''}`, {}, [
          el('span', { text: '📅' }),
          el('div.spacer-0', {}, [
            task.meetingPending ? el('b', { text: lastCancelled ? 'הפגישה בוטלה — לקביעה מחדש' : 'פגישה לקביעה' }) : el('span.mute-sm', { text: 'אין פגישה למשימה' }),
            lastCancelled ? el('div.mute-sm', { text: `בוטלה: ${when(lastCancelled.start)}` }) : null
          ]),
          el('div.spacer'),
          el(`button.btn.btn-sm${task.meetingPending ? '.btn-primary' : ''}`, {
            onclick: () => schedule(lastCancelled ? { attendees: lastCancelled.attendees, minutes: lastCancelled.minutes, ownerId: lastCancelled.ownerId } : null)
          }, [lastCancelled ? '📅 לקבוע מחדש' : '📅 קביעת פגישה'])
        ]));
        return;
      }

      const past = current.past;
      const join = current.zoom ? el('button.btn.btn-sm.btn-primary', {}, ['▶ פתיחת Zoom']) : null;
      join?.addEventListener('click', async () => {
        try {
          const r = await API.get(`/api/meetings/${current.id}/join`);
          window.open(r.url, '_blank', 'noopener');
        } catch (err) { UI.error(err); }
      });
      const edit = el('button.btn.btn-sm', { onclick: () => openDialog({ task, meeting: current, onDone: () => onChange() }) }, ['✎ שינוי']);
      const cancel = el('button.btn.btn-sm.btn-ghost', {}, ['✕ ביטול']);
      cancel.addEventListener('click', async () => {
        if (!await UI.confirm(`לבטל את הפגישה של ${when(current.start)}? המשתתפים יקבלו הודעת ביטול${current.zoom ? ', וה-Zoom יימחק' : ''}.`, { danger: true, okText: 'ביטול הפגישה' })) return;
        try {
          await API.del(`/api/meetings/${current.id}`);
          UI.success('הפגישה בוטלה');
          onChange();
        } catch (err) { UI.error(err); }
      });

      UI.mount(box, el(`div.mt-card${past ? '.is-past' : ''}`, {}, [
        el('div.mt-card-head', {}, [
          el('span.mt-card-ic', { text: '📅' }),
          el('div', {}, [
            el('b', { text: `${when(current.start)}–${hhmm(current.end)}` }),
            el('div.mute-sm', {
              text: [current.ownerName ? `ביומן של ${current.ownerName}` : null,
                current.zoom ? `Zoom${current.zoom.host ? ` (${current.zoom.host})` : ''}` : current.location || null].filter(Boolean).join(' · ')
            })
          ]),
          el('div.spacer'),
          past ? null : join,
          past ? null : edit,
          past ? null : cancel
        ]),
        current.attendees.length
          ? el('div.mt-people', {}, current.attendees.map((a) => el(`span.mt-person.is-${a.response ?? 'needsAction'}`, { title: RESPONSE_TITLE[a.response ?? 'needsAction'] }, [`${RESPONSE[a.response ?? 'needsAction']} ${a.name || a.email}`])))
          : null,
        current.zoom?.basic && current.minutes > 40 && current.attendees.length >= 2
          ? el('div.mute-sm.text-warn', { text: '⚠ חשבון Zoom חינמי — פגישה של 3 משתתפים ומעלה נקטעת אחרי 40 דקות' })
          : null,
        current.syncError ? el('div.mute-sm.text-warn', { text: `⚠ ${current.syncError}` }) : null,
        past ? el('div.mt-after', {}, [
          el('span', { text: 'הפגישה התקיימה?' }),
          el('button.btn.btn-sm.btn-primary', { onclick: () => closeTask(task, onChange) }, ['✓ סגירת המשימה']),
          el('button.btn.btn-sm', { onclick: () => schedule({ attendees: current.attendees, minutes: current.minutes, ownerId: current.ownerId }) }, ['📅 פגישת המשך'])
        ]) : null
      ]));
    };

    API.get(`/api/meetings/task/${task.id}`).then((r) => draw(r.meetings)).catch(() => UI.mount(box));
    return box;
  }

  async function closeTask(task, onChange) {
    const finalKey = App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => c.isFinal)?.key;
    if (!finalKey) return;
    try {
      await API.updateTask(task.id, { status: finalKey });
      UI.success('המשימה נסגרה');
      onChange();
    } catch (err) {
      UI.error(err);
    }
  }

  return { openDialog, panel, closeTask, when, hhmm };
})();
