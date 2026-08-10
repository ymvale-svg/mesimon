'use strict';
/** מסך 1 — דף הבית האישי (פרק 5.1 באפיון). */

const HomeView = (() => {
  const { el } = UI;

  async function render(container) {
    UI.mount(container, UI.spinner());
    let data;
    try {
      data = await API.home();
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    App.state.homeData = data;

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: `${greeting}, ${App.state.actor.name.split(' ')[0]}` }),
          el('div.sub', { text: 'תמונת מצב אישית — המשימות, החריגות והעדכונים שלך.' })
        ])
      ]),
      widgets(data.widgets),
      el('div.grid.grid-2.mt', { style: { alignItems: 'start' } }, [
        el('div.flex-col', { style: { gap: '14px' } }, [
          myTasksCard(data.tasks.mine),
          App.may('approve_vendor_output') || App.isVendor()
            ? approvalCard(data.tasks.awaitingApproval)
            : null
        ]),
        el('div.flex-col', { style: { gap: '14px' } }, [
          calendarCard(data.weekAhead),
          feedCard(data.feed)
        ])
      ])
    );
  }

  /** ווידג'טים עם ספירה ומעבר ישיר לרשימה המסוננת */
  function widgets(w) {
    const go = (filters) => {
      if (App.isVendor()) App.navigate('vendor', filters);
      else App.navigate('board', { scope: 'internal', ...filters });
    };

    const make = (cls, icon, num, label, onclick) =>
      el(`button.widget.${cls}`, { onclick }, [
        el('div.w-icon', { text: icon }),
        el('div', {}, [el('div.w-num', { text: String(num) }), el('div.w-label', { text: label })])
      ]);

    return el('div.grid.grid-4', {}, [
      make('w-mine', '📋', w.mine, 'המשימות שלי', () => go({ mine: true })),
      make('w-over', '⏰', w.overdue, 'באיחור', () => go({ mine: true, overdue: true })),
      make('w-urgent', '🔥', w.urgent, 'דחוף', () => go({ mine: true, priority: 'urgent' })),
      make('w-approve', '✅', w.awaitingApproval, App.isVendor() ? 'ממתין לבדיקת הצוות' : 'ממתין לאישור',
        () => (App.isVendor() ? App.navigate('vendor') : App.navigate('vendorBoards', { pendingReview: true })))
    ]);
  }

  function taskRow(task) {
    const due = UI.dueLabel(task.dueDate);
    return el('div.task-card', { onclick: () => TaskCardView.open(task.id) }, [
      task.projectName ? el('div.tc-project', { text: task.projectName }) : null,
      el('div.tc-title', { text: task.title }),
      el('div.tc-tags', {}, [UI.statusTag(task), ...UI.taskTags(task)]),
      el('div.tc-foot', {}, [
        el('span', {
          text: due.text,
          class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
        }),
        el('div.spacer'),
        task.assigneeName ? UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' }) : null
      ])
    ]);
  }

  function myTasksCard(tasks) {
    const sorted = [...tasks].sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate) - new Date(b.dueDate);
    });
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'המשימות שלי' }),
        el('div.spacer'),
        el('button.btn.btn-sm', {
          onclick: () => (App.isVendor() ? App.navigate('vendor') : App.navigate('board', { mine: true }))
        }, ['לכל המשימות'])
      ]),
      el('div.card-pad.flex-col', {},
        sorted.length ? sorted.slice(0, 8).map(taskRow) : [UI.empty('אין משימות פתוחות המשויכות אליך', '🎉')])
    ]);
  }

  function approvalCard(tasks) {
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: App.isVendor() ? 'ממתין לבדיקת הצוות' : 'תוצרי ספקים הממתינים לאישור' }),
        el('div.spacer'),
        !App.isVendor() ? el('button.btn.btn-sm', { onclick: () => App.navigate('vendorBoards') }, ['לבורדי הספקים']) : null
      ]),
      el('div.card-pad.flex-col', {},
        tasks.length
          ? tasks.slice(0, 6).map((t) => el('div.task-card', { onclick: () => TaskCardView.open(t.id) }, [
              el('div.tc-title', { text: t.title }),
              el('div.tc-tags', {}, [
                UI.statusTag(t),
                t.assigneeName ? el('span.tag.tag-vendor', {}, [t.assigneeName]) : null,
                ...UI.taskTags(t)
              ])
            ]))
          : [UI.empty('אין פריטים הממתינים לבדיקה', '✅')])
    ]);
  }

  /** תצוגת לוח שנה מקוצרת לשבוע הקרוב */
  function calendarCard(weekAhead) {
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 7; i++) {
      const day = new Date(today);
      day.setDate(day.getDate() + i);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const items = weekAhead.filter((t) => {
        const d = new Date(t.dueDate);
        return d >= day && d < next;
      });
      const overdueToday = i === 0 ? weekAhead.filter((t) => new Date(t.dueDate) < today) : [];
      days.push({ date: day, items: [...overdueToday, ...items], isToday: i === 0 });
    }

    const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

    return el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'השבוע הקרוב' })]),
      el('div.card-pad', {}, days.map((d) =>
        el('div', { style: { display: 'flex', gap: '10px', padding: '6px 0', borderBottom: '1px dashed var(--border)' } }, [
          el('div', { style: { width: '86px', flex: 'none' } }, [
            el('div', { style: { fontWeight: d.isToday ? '800' : '600', color: d.isToday ? 'var(--brand)' : 'inherit' },
              text: d.isToday ? 'היום' : dayNames[d.date.getDay()] }),
            el('div.mute-sm', { text: UI.formatDate(d.date.toISOString()).slice(0, 5) })
          ]),
          el('div', { style: { flex: '1' } }, d.items.length
            ? d.items.map((t) => el('div', {
                style: { cursor: 'pointer', fontSize: '13px', padding: '2px 0' },
                onclick: () => TaskCardView.open(t.id)
              }, [
                el('span', { style: { color: t.overdue ? 'var(--danger)' : 'inherit' }, text: `• ${t.title}` })
              ]))
            : [el('div.mute-sm', { text: '—' })])
        ])
      ))
    ]);
  }

  const ACTION_TEXT = {
    created: 'יצר/ה משימה',
    updated: 'עדכן/ה',
    status_changed: 'שינה/תה סטטוס',
    comment: 'הגיב/ה',
    attachment: 'העלה/תה קובץ',
    checklist: 'עדכן/ה צ׳קליסט',
    automation: 'אוטומציה'
  };

  function feedCard(feed) {
    return el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'פיד עדכונים אחרון' })]),
      el('div.card-pad', {}, feed.length
        ? feed.map((f) => el('div.history-item', {
            class: f.actorType === 'system' ? 'system' : '',
            style: { cursor: 'pointer' },
            onclick: () => TaskCardView.open(f.taskId)
          }, [
            el('div.h-dot'),
            el('div.h-body', {}, [
              el('div', {}, [
                el('b', { text: f.actorName }),
                ' ',
                el('span', { text: ACTION_TEXT[f.action] ?? f.action }),
                ' — ',
                el('span', { style: { color: 'var(--brand)' }, text: f.taskTitle })
              ]),
              el('div.h-meta', { text: `${f.details} · ${UI.relative(f.createdAt)}` })
            ])
          ]))
        : [UI.empty('אין עדכונים אחרונים', '📰')])
    ]);
  }

  return { render };
})();
