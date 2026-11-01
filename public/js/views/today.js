'use strict';
/**
 * ☀ Today — "מה אני צריך לעשות היום?" במסך אחד.
 *
 * שלושה מקורות, כפי שהשרת מאחד אותם (‎GET /api/today‎):
 *   📅 היומן          — הפגישות של היום מ-Google Calendar
 *   ⚠ באיחור / ✅ היום — המשימות שלי שהיעד שלהן עבר או היום
 *   📧 מהמייל         — הצעות משימה שעוד לא הוחלט עליהן. "להיום" כברירת מחדל,
 *                        עד שמחליטים: משימה להיום · תאריך אחר · משימת AI · לא משימה
 *
 * בטלפון זה מסך הפתיחה. וגם: ההגדרות של Today במייל ושל ההקלטה (‎openSettings‎).
 */

const TodayView = (() => {
  const { el } = UI;

  let containerRef = null;
  let data = null;

  const hhmm = (iso) => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const shortDay = (dateStr) => `יום ${DAY_NAMES[weekdayOf(dateStr)]} ${Number(dateStr.slice(8))}.${Number(dateStr.slice(5, 7))}`;
  const addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  /** תחילת השבוע הבא — ראשון הקרוב שאחרי היום */
  const nextSunday = (dateStr) => addDays(dateStr, 7 - weekdayOf(dateStr));

  // ------------------------------------------------------------- טעינה

  async function render(container, { silent = false, fresh = false } = {}) {
    containerRef = container;
    if (!silent) UI.mount(container, UI.spinner());
    try {
      data = await API.get(`/api/today${fresh ? '?fresh=1' : ''}`);
    } catch (err) {
      if (silent) return;
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    App.setTodayCount?.(data.counts.overdue + data.counts.today + data.counts.mail);
    draw();
  }

  const reload = (opts = {}) => (containerRef?.isConnected ? render(containerRef, { silent: true, ...opts }) : Promise.resolve());

  /** פעולה על כפתור — נעילה בזמן הבקשה, שגיאה למשתמש, ורענון בסוף */
  const run = (button, fn) => async (e) => {
    e?.stopPropagation?.();
    if (button) button.disabled = true;
    try {
      await fn();
      await reload();
      App.refreshNotifications();
    } catch (err) {
      if (button) button.disabled = false;
      UI.error(err);
    }
  };

  // ------------------------------------------------------------- המסך

  function draw() {
    if (!containerRef || !data) return;
    const scrollTop = containerRef.scrollTop;
    const c = data.counts;
    const summary = [
      c.events ? `${c.events} פגישות` : null,
      c.today ? `${c.today} משימות` : null,
      c.overdue ? `${c.overdue} באיחור` : null,
      c.mail ? `${c.mail} מהמייל` : null
    ].filter(Boolean).join(' · ');

    const empty = !c.total && !data.calendar.events.length;

    UI.mount(containerRef, el('div.today', {}, [
      el('div.today-head', {}, [
        el('div', {}, [
          el('h2', {}, ['☀ ', data.dateLabel]),
          el('div.today-summary', { text: summary || 'אין משימות להיום' }),
          c.doneToday ? el('div.today-done', { text: `✓ ${c.doneToday} הושלמו היום` }) : null
        ]),
        el('div.spacer'),
        el('button.btn.btn-sm', { title: 'רענון, כולל היומן', onclick: (e) => { e.currentTarget.disabled = true; reload({ fresh: true }); } }, ['⟳']),
        el('button.btn.btn-sm', { title: 'Today במייל והקלטה', onclick: () => openSettings() }, ['⚙'])
      ]),
      !data.isWorkDay ? el('div.alert.alert-info.today-note', {}, [el('span', { text: '🌿' }), el('div', { text: 'היום אינו יום עבודה שלך. מה שמופיע כאן מחכה ליום העבודה הבא.' })]) : null,
      googleBanner(),
      nextUp(),
      empty ? el('div.today-clear', {}, [el('div.e-icon', { text: '🌤' }), el('b', { text: 'יום נקי' }), el('div.mute-sm', { text: 'אין פגישות, אין משימות להיום ואין מיילים שמחכים להחלטה.' })]) : null,
      calendarSection(),
      meetingsSection(),
      tasksSection('⚠ באיחור', data.tasks.overdue, { late: true }),
      tasksSection('✅ היום', data.tasks.today, { late: false }),
      mailSection()
    ]));
    containerRef.scrollTop = scrollTop;
  }

  /** חיבור Google חסר, או חיבור ישן בלי יומן — פס אחד עם הדרך לחבר */
  function googleBanner() {
    const g = data.google;
    if (!g.enabled) return null;
    if (!g.connected) {
      return el('div.alert.alert-info.today-note', {}, [el('span', { text: '📅' }), el('div', {}, [
        'חברו את Google כדי לראות כאן את היומן ואת המיילים שמחכים להחלטה. ',
        el('a', { href: '/api/me/gmail/connect' }, ['חיבור Google'])
      ])]);
    }
    if (g.missing.includes('calendar')) {
      return el('div.alert.alert-warn.today-note', {}, [el('span', { text: '📅' }), el('div', {}, [
        'חברו מחדש את Google כדי לראות כאן את היומן ואת אנשי הקשר. ',
        el('a', { href: '/api/me/gmail/connect' }, ['חיבור מחדש'])
      ])]);
    }
    return null;
  }

  /** "עכשיו / הבא" — הפגישה שמתקיימת עכשיו או הקרובה */
  function nextUp() {
    const now = Date.now();
    const next = data.calendar.events.find((e) => !e.allDay && new Date(e.end).getTime() > now);
    if (!next) return null;
    const start = new Date(next.start).getTime();
    const mins = Math.round((start - now) / 60000);
    const when = start <= now ? 'עכשיו' : mins < 60 ? `בעוד ${mins} דק׳` : `ב-${hhmm(next.start)}`;
    return el(`div.today-next${start <= now ? '.is-now' : ''}`, {}, [
      el('span.today-next-when', { text: when }),
      el('b', { text: next.title }),
      next.location ? el('span.mute-sm', { text: ` · ${next.location}` }) : null,
      el('div.spacer'),
      next.meetLink ? el('a.btn.btn-sm.btn-primary', { href: next.meetLink, target: '_blank', rel: 'noopener' }, ['הצטרפות']) : null
    ]);
  }

  function section(title, count, rows, extra = null) {
    return el('div.card.today-sec', {}, [
      el('div.today-sec-head', {}, [el('b', { text: title }), count !== null ? el('span.today-count', { text: String(count) }) : null, el('div.spacer'), extra]),
      el('div.today-rows', {}, rows)
    ]);
  }

  // ------------------------------------------------------------- היומן

  function calendarSection() {
    const cal = data.calendar;
    if (!cal.connected) return null;
    if (cal.error && !cal.events.length) return section('📅 היומן', null, [el('div.mute-sm.today-pad', { text: cal.error })]);
    if (!cal.events.length) return section('📅 היומן', 0, [el('div.mute-sm.today-pad', { text: 'אין פגישות היום' })]);
    const now = Date.now();
    return section('📅 היומן', cal.events.length, cal.events.map((e) => {
      const past = !e.allDay && new Date(e.end).getTime() < now;
      return el(`div.today-row.today-event${past ? '.is-past' : ''}`, {}, [
        el('span.today-time', { text: e.allDay ? 'כל היום' : hhmm(e.start) }),
        el('div.today-main', {}, [
          el('div.today-title', {}, [past ? '✓ ' : '', e.title]),
          el('div.mute-sm', { text: [e.allDay ? null : `עד ${hhmm(e.end)}`, e.location, e.calendarName].filter(Boolean).join(' · ') })
        ]),
        el('div.today-actions', {}, [
          e.meetLink && !past ? el('a.btn.btn-sm', { href: e.meetLink, target: '_blank', rel: 'noopener', title: 'הצטרפות לשיחה' }, ['🎥']) : null,
          e.link ? el('a.btn.btn-sm.btn-ghost', { href: e.link, target: '_blank', rel: 'noopener', title: 'פתיחה ב-Google Calendar' }, ['↗']) : null,
          el('button.btn.btn-sm', {
            title: 'משימה חדשה מהפגישה — מעקב, סיכום, מה שסוכם',
            onclick: () => BoardView.openTaskDialog(null, { prefill: { title: e.title, dueDate: data.date }, onSaved: () => reload() })
          }, ['+ משימה'])
        ])
      ]);
    }));
  }

  /** פגישה שבוטלה ביומן, או בקשה להזיז — אותן שורות של "ממתין לאישורך" */
  function meetingsSection() {
    const items = data.meetings ?? [];
    if (!items.length) return null;
    return section('📅 פגישות — מחכה להחלטה', items.length, items.map((s) => AiInboxView.meetingRow(s, () => reload())));
  }

  // ------------------------------------------------------------- משימות

  function tasksSection(title, tasks, { late }) {
    if (!tasks.length) return null;
    return section(title, tasks.length, tasks.map((t) => taskRow(t, late)));
  }

  function taskRow(task, late) {
    const board = App.state.boards.find((b) => b.id === task.boardId);
    const finalKey = board?.columns.find((x) => x.isFinal)?.key;
    const box = el('input.m-check', {
      type: 'checkbox',
      disabled: !task.canChangeStatus || !finalKey,
      title: 'סימון כהושלמה'
    });
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', async () => {
      // הסטטוס שממנו יצאנו — "ביטול" מחזיר אליו, ולא לעמודה הראשונה בלוח
      const prevStatus = task.status ?? board?.columns.find((x) => !x.isFinal)?.key;
      box.disabled = true;
      try {
        await API.updateTask(task.id, { status: finalKey });
        /*
         * סימון ב-Today מעלים את השורה מהרשימה מיד, ולכן טעות כאן היא
         * משימה שנעלמה — "ביטול" מחזיר אותה, והיא חוזרת למקומה ברענון.
         */
        UI.undoToast('המשימה סומנה כהושלמה', {
          onUndo: async () => {
            await API.updateTask(task.id, { status: prevStatus });
            await reload();
            App.refreshNotifications();
          }
        });
        await reload();
        App.refreshNotifications();
      } catch (err) {
        box.checked = false;
        box.disabled = false;
        UI.error(err);
      }
    });

    const due = UI.dueLabel(task.dueDate);
    const toToday = late && task.canEdit ? el('button.btn.btn-sm', { title: 'להעביר את היעד להיום' }, ['להיום']) : null;
    toToday?.addEventListener('click', run(toToday, () => API.updateTask(task.id, { dueDate: UI.fromInputDate(data.date) })));
    const move = task.canEdit ? el('button.btn.btn-sm', { title: 'להזיז את היעד', onclick: (e) => { e.stopPropagation(); moveDialog(task); } }, ['📅']) : null;

    return el(`div.today-row.today-task${late ? '.is-late' : ''}`, { onclick: () => TaskCardView.open(task.id) }, [
      el('span.m-bar', { style: { background: task.projectColor ?? 'transparent' } }),
      box,
      el('div.today-main', {}, [
        el('div.today-title', { text: task.title }),
        el('div.mute-sm', {}, [
          [
            task.projectName,
            late ? due.text : task.opensToday ? 'נפתחה היום' : null,
            task.checklistTotal ? `${task.checklistDone}/${task.checklistTotal} בצ׳קליסט` : null,
            task.statusShort || null
          ].filter(Boolean).join(' · ')
        ]),
        el('div.today-tags', {}, UI.taskTags({ ...task, overdue: false }))
      ]),
      el('div.today-actions', {}, [toToday, move])
    ]);
  }

  /** הזזת יעד: היום · מחר (יום העבודה הבא) · תחילת השבוע הבא · תאריך */
  function pickDate(title, { onPick, includeToday = true }) {
    const input = el('input', { type: 'date', value: data.tomorrow });
    const choose = (date) => { m.close(); onPick(date); };
    const sunday = nextSunday(data.date);
    const options = [
      includeToday ? ['היום', data.date] : null,
      [`מחר — ${shortDay(data.tomorrow)}`, data.tomorrow],
      sunday !== data.tomorrow ? [`תחילת השבוע — ${shortDay(sunday)}`, sunday] : null
    ].filter(Boolean);
    const m = UI.modal({
      title,
      body: el('div.today-pick', {}, [
        ...options.map(([label, date]) => el('button.btn.btn-block', { onclick: () => choose(date) }, [label])),
        el('div.today-pick-other', {}, [
          UI.field('תאריך אחר', input),
          el('button.btn.btn-primary', { onclick: () => input.value && choose(input.value) }, ['קביעה'])
        ])
      ])
    });
  }

  function moveDialog(task) {
    pickDate(`יעד חדש: ${task.title}`, {
      onPick: async (date) => {
        try {
          await API.updateTask(task.id, { dueDate: UI.fromInputDate(date) });
          UI.success(date === data.date ? 'היעד הועבר להיום' : `היעד הועבר ל${shortDay(date)}`);
          await reload();
        } catch (err) {
          UI.error(err);
        }
      }
    });
  }

  // ------------------------------------------------------------- מהמייל

  function mailSection() {
    if (!data.mail.connected || !data.mail.items.length) return null;
    const fresh = data.mail.items.filter((s) => !s.older);
    const older = data.mail.items.filter((s) => s.older);
    return section('📧 מהמייל — ממתין להחלטה', data.mail.items.length, [
      el('div.mute-sm.today-pad', { text: 'כל מייל כאן נחשב להיום, עד שתחליטו אחרת.' }),
      ...fresh.map(mailRow),
      older.length ? el('div.today-subhead', { text: 'מאתמול ולפני' }) : null,
      ...older.map(mailRow)
    ]);
  }

  function mailRow(s) {
    const d = s.data ?? {};
    // הצעה עם אנשים נוספים, ספק או אזהרה — מחייבת מבט, ולכן עוברת דרך העריכה
    const needsLook = Boolean(d.people?.length || d.ambiguous?.length || d.warning);
    const dueToday = d.dueDate && d.dueDate !== data.date ? null : data.date;

    const approve = el('button.btn.btn-sm.btn-primary', {}, [d.dueDate && d.dueDate !== data.date ? `✓ משימה ל-${shortDay(d.dueDate)}` : '✓ משימה להיום']);
    approve.addEventListener('click', needsLook
      ? (e) => { e.stopPropagation(); AiInboxView.editSuggestion(s, () => reload()); }
      : run(approve, async () => {
          await API.post(`/api/ai/suggestions/${s.id}/approve`, { dueDate: d.dueDate || dueToday });
          UI.success('נוצרה משימה');
        }));
    if (needsLook) approve.textContent = 'בדיקה ואישור';

    const later = el('button.btn.btn-sm', { title: 'משימה עם תאריך יעד אחר' }, ['📅 תאריך אחר']);
    later.addEventListener('click', (e) => {
      e.stopPropagation();
      pickDate(`תאריך יעד: ${d.title ?? s.subject}`, {
        includeToday: false,
        onPick: async (date) => {
          if (needsLook) return AiInboxView.editSuggestion({ ...s, data: { ...d, dueDate: date } }, () => reload());
          try {
            await API.post(`/api/ai/suggestions/${s.id}/approve`, { dueDate: date });
            UI.success(`נוצרה משימה ל${shortDay(date)} — היא תחזור ל-Today באותו יום`);
            await reload();
          } catch (err) {
            UI.error(err);
          }
        }
      });
    });

    const toAi = el('button.btn.btn-sm', { title: 'לבקש את זה ממישהו — העוזר ינסח פנייה לאישורך ויעקוב' }, ['✨ משימת AI']);
    toAi.addEventListener('click', (e) => {
      e.stopPropagation();
      AiTaskView.openDialog({
        suggestionId: s.id,
        instruction: d.aiRequest?.instruction || `${d.title}. ${d.summary ?? ''}`,
        contact: d.aiRequest ? { name: d.aiRequest.contactName, email: d.aiRequest.contactEmail, phone: d.aiRequest.contactPhone } : {},
        onCreated: () => reload()
      });
    });

    const reject = el('button.btn.btn-sm.btn-ghost', { title: 'לא משימה' }, ['✕ לא משימה']);
    reject.addEventListener('click', (e) => { e.stopPropagation(); AiInboxView.rejectDialog(s, () => reload()); });

    return el('div.today-row.today-mail', { onclick: () => AiInboxView.editSuggestion(s, () => reload()) }, [
      el('div.today-main', {}, [
        el('div.today-title', { text: d.title ?? s.subject }),
        d.summary ? el('div.today-sum', { text: d.summary }) : null,
        el('div.mute-sm', {}, [
          `מאת ${s.from.name}`,
          s.receivedAt ? ` · ${UI.relative(s.receivedAt)}` : '',
          s.older ? el('span.today-older', { text: ' · מחכה מאתמול' }) : null,
          s.link ? el('a', { href: s.link, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, [' · פתיחת המייל ↗']) : null
        ]),
        el('div.today-mail-actions', {}, [approve, later, toAi, reject])
      ])
    ]);
  }

  // ------------------------------------------------------------- הגדרות

  /**
   * Today במייל, משימה מהקלטה והפעלה בקול, ובחירת יומנים — מסך אחד, מ"החשבון
   * שלי" ומכפתור ⚙ ב-Today.
   */
  async function openSettings() {
    let info;
    try {
      info = await API.get('/api/me/today-prefs');
    } catch (err) {
      return UI.error(err);
    }
    const body = el('div.today-settings');
    const m = UI.modal({ title: '☀ Today והקלטה', body, size: 'wide' });

    const save = async (patch) => {
      try {
        info = await API.put('/api/me/today-prefs', patch);
        App.state.prefs.voice = info.voice;
        App.state.prefs.todayDigest = info.digest;
        draw();
        App.refreshChrome();
        VoiceWake.sync?.();
      } catch (err) {
        UI.error(err);
        draw();
      }
    };

    function draw() {
      const dg = info.digest;
      const enabled = el('input', { type: 'checkbox', checked: dg.enabled });
      enabled.addEventListener('change', () => save({ digest: { enabled: enabled.checked } }));
      const time = el('input', { type: 'time', value: dg.time, style: { width: '120px' } });
      time.addEventListener('change', () => time.value && save({ digest: { time: time.value } }));
      const skip = el('input', { type: 'checkbox', checked: dg.skipEmpty });
      skip.addEventListener('change', () => save({ digest: { skipEmpty: skip.checked } }));

      // ימים: "ימי העבודה שלי" (ברירת המחדל) או בחירה. שבת אינה בחירה
      const custom = Array.isArray(dg.days);
      const chosen = new Set(custom ? dg.days : info.workDays);
      const dayButtons = [0, 1, 2, 3, 4, 5].map((d) => el(`button.day-chip${chosen.has(d) ? '.on' : ''}`, {
        type: 'button',
        onclick: () => {
          if (chosen.has(d)) chosen.delete(d); else chosen.add(d);
          save({ digest: { days: [...chosen] } });
        }
      }, [DAY_LETTERS[d]]));

      const test = el('button.btn.btn-sm', {}, ['📨 שלח לי עכשיו לבדיקה']);
      test.addEventListener('click', async () => {
        test.disabled = true;
        try {
          await API.post('/api/me/today-digest/test');
          UI.success('נשלח — בדקו את תיבת הדואר');
        } catch (err) {
          UI.error(err);
        }
        test.disabled = false;
      });

      const v = info.voice;
      const mode = (key, label, hint) => el('label.today-radio', {}, [
        el('input', { type: 'radio', name: 'voice-mode', checked: v.mode === key, onchange: () => save({ voice: { mode: key } }) }),
        el('div', {}, [el('b', { text: label }), el('div.mute-sm', { text: hint })])
      ]);
      const wake = el('input', { type: 'checkbox', checked: v.wake });
      wake.addEventListener('change', () => save({ voice: { wake: wake.checked } }));
      const wakeMinutes = el('input', { type: 'number', min: 5, max: 240, value: v.wakeMinutes, style: { width: '80px' } });
      wakeMinutes.addEventListener('change', () => save({ voice: { wakeMinutes: Number(wakeMinutes.value) } }));

      UI.mount(body,
        el('div.ai-section-title', { text: '📨 Today במייל' }),
        el('label.checkbox', {}, [enabled, ' שלח לי את Today במייל כל בוקר']),
        el('div.mute-sm', { text: 'הפגישות, המשימות של היום, מה שבאיחור והמיילים שמחכים להחלטה — בלי ללחוץ על כלום.' }),
        el('div.today-digest-grid', { style: { opacity: dg.enabled ? '1' : '.55' } }, [
          UI.field('שעה', time),
          UI.field(custom ? 'ימים' : `ימים — ימי העבודה שלך (${info.workDaysLabel})`, el('div.day-chips', {}, [
            ...dayButtons,
            custom ? el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => save({ digest: { days: null } }) }, ['חזרה לימי העבודה שלי']) : null
          ]), 'בשבת לא נשלח לעולם'),
          el('label.checkbox', {}, [skip, ' ביום בלי כלום — לא לשלוח'])
        ]),
        info.digestVia
          ? el('div.mute-sm', { text: info.digestVia === 'gmail' ? 'יישלח מתיבת ה-Gmail שלך, אליך בלבד.' : 'יישלח מתיבת המערכת של משימון.' })
          : el('div.alert.alert-warn', {}, [el('span', { text: '📭' }), el('div', { text: 'אין כרגע דרך לשלוח: שליחת מיילים אינה מוגדרת בשרת, ותיבת ה-Gmail שלך אינה מחוברת לשליחה. חברו את Google ב"החשבון שלי".' })]),
        info.digestError ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: `השליחה האחרונה נכשלה: ${info.digestError}` })]) : null,
        el('div', { style: { marginTop: '8px' } }, [test]),

        el('div.ai-section-title', { text: '🎙 משימה מהקלטה', style: { marginTop: '20px' } }),
        !info.ai ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: 'חיבור ה-AI עדיין לא הוגדר בשרת — ההקלטה תיפתח כשמנהל המערכת יגדיר אותו.' })]) : null,
        mode('preview', 'תמיד תצוגה מקדימה', 'המשימה נפתחת ממולאת, ואתם לוחצים "יצירת משימה".'),
        mode('direct', 'יצירה ישירה כשאומרים "פתח משימה"', 'הקלטה שנפתחת ב"פתח משימה" או "פתח במשימון" — המשימה נוצרת לבד, עם "ביטול" ל-10 שניות. בלי המילים האלה — תצוגה מקדימה.'),
        el('div.mute-sm', { style: { marginTop: '6px' }, text: 'ברירות המחדל: אחראי — אתם · יעד — יום העבודה הבא · עדיפות — רגילה. משימת AI תמיד עוברת דרך האשף, כי היא שולחת הודעה לאדם אחר.' }),

        el('div.ai-section-title', { text: '👂 הפעלה בקול — "משימון!"', style: { marginTop: '20px' } }),
        el('label.checkbox', {}, [wake, ' להציג בטלפון את מתג ההאזנה']),
        el('div.mute-sm', { text: 'כשהמתג דולק ומשימון פתוח על המסך: אומרים "משימון" — והמערכת שואלת "במה אפשר לעזור?" ומאזינה, בלי ללחוץ.' }),
        el('div.today-digest-grid', { style: { opacity: v.wake ? '1' : '.55' } }, [
          UI.field('כיבוי אוטומטי אחרי (דקות בלי שימוש)', wakeMinutes)
        ]),
        el('div.alert.alert-info', {}, [el('span', { text: '🔒' }), el('div', {}, [
          el('div', { text: 'האזנה אפשרית רק כשמשימון פתוח על המסך והמסך דולק. כשהטלפון נעול — "היי Siri, משימון" באייפון, או "Hey Google, פתח משימון" באנדרואיד.' }),
          el('div', { text: 'באנדרואיד (כרום), זיהוי הדיבור של הדפדפן מעביר את הקול ל-Google כל עוד ההאזנה דולקת. משימון עצמו מקבל רק את מה שנאמר אחרי "משימון".' }),
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); VoiceView.shortcutHelp(); } }, ['איך מוסיפים קיצור ל-Siri / Google'])
        ])]),

        info.calendar.connected ? calendarsBox() : null
      );
    }

    function calendarsBox() {
      const box = el('div', {}, [el('div.ai-section-title', { text: '📅 יומנים ב-Today', style: { marginTop: '20px' } }), UI.spinner()]);
      API.get('/api/me/calendars').then(({ calendars }) => {
        if (!calendars.length) {
          UI.mount(box, el('div.ai-section-title', { text: '📅 יומנים ב-Today', style: { marginTop: '20px' } }),
            el('div.mute-sm', { text: 'מוצג היומן הראשי. לבחירת יומנים נוספים — חברו מחדש את Google.' }));
          return;
        }
        const chosen = new Set(calendars.filter((c) => c.selected).map((c) => c.id));
        UI.mount(box,
          el('div.ai-section-title', { text: '📅 יומנים ב-Today', style: { marginTop: '20px' } }),
          ...calendars.map((c) => {
            const cb = el('input', { type: 'checkbox', checked: chosen.has(c.id) });
            cb.addEventListener('change', () => {
              if (cb.checked) chosen.add(c.id); else chosen.delete(c.id);
              save({ calendars: [...chosen] });
            });
            return el('label.checkbox', {}, [cb, el('span.cal-dot', { style: { background: c.color ?? 'var(--brand)' } }), ` ${c.name}${c.primary ? ' (ראשי)' : ''}`]);
          })
        );
      }).catch(() => UI.mount(box, el('div.mute-sm', { text: 'רשימת היומנים אינה זמינה כרגע' })));
      return box;
    }

    draw();
    return m;
  }

  return { render, reload, openSettings };
})();
