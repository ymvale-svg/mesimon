'use strict';
/**
 * מסך 1 — דף הבית האישי.
 * כל עובד — מנהל מחלקה כמו עובד פנימי — רואה כאן את המשימות שלו בשתי הרמות:
 * המשימות המחלקתיות והמשימות שהוטלו ברמה הארגונית. מי שרואה את כל הארגון
 * מקבל בנוסף חתך מחלקתי מרוכז.
 */

const HomeView = (() => {
  const { el } = UI;

  /** התפקידים שרואים את כל הארגון ולא מחלקה אחת — רק להם יש טעם בחתך מחלקתי */
  const ORG_WIDE_ROLES = ['superadmin', 'admin', 'executive'];

  /**
   * מנהל מחלקה גם הוא בעל הרשאת דוחות, אך מוגבלת למחלקתו — ולכן חתך בין מחלקות
   * אינו רלוונטי לו. לכן נדרשים גם ההרשאה וגם תפקיד ברמת ארגון.
   */
  const showsDepartmentCut = () =>
    !App.isVendor() && App.may('view_reports') && ORG_WIDE_ROLES.includes(App.state.actor?.role);

  async function render(container) {
    UI.mount(container, UI.spinner());
    let data;
    let reports = null;
    try {
      // החתך המחלקתי נשען על דוח הארגון. נטען במקביל, וכשל בו לא מפיל את הדשבורד.
      [data, reports] = await Promise.all([
        API.home(),
        showsDepartmentCut() ? API.reports().catch(() => null) : Promise.resolve(null)
      ]);
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
      reports ? departmentCutCard(reports.departments) : null,
      el('div.grid.grid-2.mt', { style: { alignItems: 'start' } }, [
        el('div.flex-col', { style: { gap: '14px' } }, [
          ...myTasksCards(data.tasks.mine),
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

  const isOrgTask = (task) => task.level === 'organization';

  /**
   * משימה ארגונית מסומנת בתגית משלה, גם כשהיא מופיעה בתוך רשימה מעורבת
   * (כרטיסי האישור), כדי שהרמה תהיה מובחנת במבט אחד ולא רק לפי הכותרת שמעליה.
   */
  const levelTag = (task) => (isOrgTask(task) ? el('span.tag.tag-internal', {}, ['🏢 ארגונית']) : null);

  function taskRow(task) {
    const due = UI.dueLabel(task.dueDate);
    return el('div.task-card', { onclick: () => TaskCardView.open(task.id) }, [
      task.projectName ? el('div.tc-project', { text: task.projectName }) : null,
      el('div.tc-title', { text: task.title }),
      el('div.tc-tags', {}, [UI.statusTag(task), levelTag(task), ...UI.taskTags(task)]),
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

  /** באיחור קודם, ואחריו לפי קרבת תאריך היעד; משימות ללא יעד בסוף */
  const byUrgency = (tasks) => [...tasks].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  /** כרטיס רשימה אחד. קבוצה ריקה מסתפקת בשורה שקטה ולא במסגרת ריקה עם איור. */
  function taskListCard({ title, note, tasks, emptyText, onAll }) {
    const sorted = byUrgency(tasks);
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: title }),
        note ? el('span.mute-sm', { text: note }) : null,
        el('div.spacer'),
        sorted.length ? el('button.btn.btn-sm', { onclick: onAll }, ['לכל המשימות']) : null
      ]),
      sorted.length
        ? el('div.card-pad.flex-col', {}, sorted.slice(0, 8).map(taskRow))
        : el('div.card-pad', {}, [el('div.mute-sm', { text: emptyText })])
    ]);
  }

  /**
   * רשימת המשימות האישית מפוצלת לשתי קבוצות מופרדות — מחלקתי וארגוני.
   * רמת המשימה מגיעה כבר בנתוני דף הבית (level), ולכן אין צורך בטעינה נוספת.
   */
  function myTasksCards(tasks) {
    // ספק אינו משויך למחלקה ואינו מקבל משימות ארגוניות — עבורו נשארת רשימה אחת
    if (App.isVendor()) {
      return [taskListCard({
        title: 'המשימות שלי',
        tasks,
        emptyText: 'אין משימות פתוחות המשויכות אליך',
        onAll: () => App.navigate('vendor')
      })];
    }

    const orgTasks = tasks.filter(isOrgTask);
    const deptTasks = tasks.filter((t) => !isOrgTask(t));

    return [
      taskListCard({
        title: 'המשימות שלי במחלקה',
        note: App.state.actor.department || null,
        tasks: deptTasks,
        emptyText: 'אין משימות מחלקתיות פתוחות',
        onAll: () => App.navigate('board', { mine: true, level: 'department' })
      }),
      taskListCard({
        title: 'משימות ברמה הארגונית',
        note: 'משימות שהוטלו על פני כל הארגון',
        tasks: orgTasks,
        emptyText: 'לא הוטלו עליך משימות ברמה הארגונית',
        onAll: () => App.navigate('board', { mine: true, level: 'organization' })
      })
    ];
  }

  /**
   * חתך מחלקתי מרוכז — שורה למחלקה, ולחיצה עליה פותחת את הלוח מסונן לאותה מחלקה.
   * 'באיחור' ו'דחוף' נשארים שני מצבים נפרדים גם כאן, בשתי עמודות.
   */
  function departmentCutCard(rows) {
    const list = (rows ?? []).filter((d) => d.people || d.open || d.overdue);
    if (!list.length) return null;

    const cell = (value, tagClass) =>
      el('td', {}, [value ? el(`span.tag.${tagClass}`, {}, [String(value)]) : el('span.mute-sm', { text: '—' })]);

    return el('div.card.mt', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'חתך מחלקתי' }),
        el('span.mute-sm', { text: 'לחיצה על מחלקה פותחת את הלוח שלה' }),
        el('div.spacer'),
        el('button.btn.btn-sm', { onclick: () => App.navigate('reports') }, ['לדוחות המלאים'])
      ]),
      el('div.table-wrap', { style: { border: '0' } }, [
        el('table.data', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'מחלקה' }),
              el('th', { text: 'עובדים' }),
              el('th', { text: 'פתוחות' }),
              el('th', { text: 'באיחור' }),
              el('th', { text: 'דחופות' }),
              el('th', { text: 'ארגוניות' })
            ])
          ]),
          el('tbody', {}, list.map((d) => el('tr', {
            // שורת "ללא שיוך" מגיעה מהשרת בלי מזהה, ואין לוח שאפשר לסנן אליה
            onclick: d.id ? () => App.navigate('board', { departmentId: d.id }) : null,
            style: { cursor: d.id ? 'pointer' : 'default' },
            title: d.id ? `פתיחת הלוח של ${d.name}` : null
          }, [
            el('td.wrap', {}, [el('b', { text: d.name })]),
            el('td', { text: String(d.people) }),
            el('td', { text: String(d.open) }),
            cell(d.overdue, 'tag-overdue'),
            cell(d.urgent, 'tag-urgent'),
            cell(d.orgTasks, 'tag-internal')
          ])))
        ])
      ])
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
                levelTag(t),
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
                onclick: () => TaskCardView.open(t.id),
                title: isOrgTask(t) ? 'משימה ברמה הארגונית' : null
              }, [
                // הצבע מסמן איחור בפועל, והסמל מסמן שהמשימה ארגונית — שני מצבים נפרדים
                el('span', {
                  style: { color: t.overdue ? 'var(--danger)' : 'inherit' },
                  text: `• ${isOrgTask(t) ? '🏢 ' : ''}${t.title}`
                })
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
