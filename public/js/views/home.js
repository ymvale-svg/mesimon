'use strict';
/**
 * מסך 1 — דף הבית האישי.
 * כל עובד רואה כאן את המשימות שלו, ומי שרואה את כל הארגון מקבל בנוסף
 * חתך מחלקתי מרוכז.
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

  /**
   * תקרות הצגה. כל רשימה כאן יושבת בתיבת גלילה בגובה קבוע, ולכן אפשר להרשות
   * יותר פריטים מבעבר: הם אינם מאריכים את העמוד אלא את הגלילה הפנימית.
   */
  const FEED_MAX = 30;      // השרת ממילא מחזיר עד 15 רשומות — זו תקרה הגנתית
  const LIST_MAX = 20;      // כרטיסי משימה ברשימה האישית
  const APPROVAL_MAX = 15;

  /**
   * ‎.feed-scroll‎ מגדיר max-height ולא height, ולכן רשימה קצרה אינה נכנסת
   * לתיבה קטועה — היא פשוט נשארת בגובהה הטבעי. מכאן שאין צורך בתנאי על
   * מספר הפריטים: התיבה נכנסת לפעולה רק כשהרשימה באמת מתחילה למתוח את העמוד.
   * הגובה עצמו ב-CSS; inline נמסר רק היכן שפריט גבוה בהרבה משורת פיד.
   */
  const scrollBox = (children, { maxHeight = null, extraClass = '' } = {}) =>
    el(`div.feed-scroll${extraClass}`, maxHeight ? { style: { maxHeight } } : {}, children);

  /** ניסוח מספר בעברית — יחיד מקבל מילה ולא ספרה בודדת */
  const countLabel = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

  /**
   * תיבת גלילה מסתירה את סוף הרשימה, ולכן הכותרת נושאת את המספר.
   * כשהתקרה חתכה פריטים נאמר גם המספר המלא, כדי שלא ייראה שזה הכול.
   */
  const shownLabel = (shown, total, one, many) =>
    (shown < total ? `${shown} מתוך ${total} ${many}` : countLabel(total, one, many));

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


  /**
   * משימה ארגונית מסומנת בתגית משלה, גם כשהיא מופיעה בתוך רשימה מעורבת
   * (כרטיסי האישור), כדי שהרמה תהיה מובחנת במבט אחד ולא רק לפי הכותרת שמעליה.
   */

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
    const shown = sorted.slice(0, LIST_MAX);
    // המחלקה והמספר בכותרת אחת ולא בשני שדות — כדי לא לדחוק את כפתור 'לכל המשימות'
    const subtitle = [note, sorted.length ? shownLabel(shown.length, sorted.length, 'משימה אחת', 'משימות') : null]
      .filter(Boolean).join(' · ');

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: title }),
        subtitle ? el('span.mute-sm', { text: subtitle }) : null,
        el('div.spacer'),
        sorted.length ? el('button.btn.btn-sm', { onclick: onAll }, ['לכל המשימות']) : null
      ]),
      sorted.length
        // כרטיס משימה גבוה פי כמה משורת פיד, ולכן תקרה נדיבה מזו שב-CSS —
        // אחרת נראה כרטיס אחד וחצי והרשימה מרגישה קטועה ולא נגללת
        ? el('div.card-pad', {}, [scrollBox(shown.map(taskRow), { maxHeight: '420px', extraClass: '.flex-col' })])
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

    return [taskListCard({
      title: 'המשימות שלי',
      note: App.state.actor.department || null,
      tasks,
      emptyText: 'אין משימות פתוחות המשויכות אליך',
      onAll: () => App.navigate('board', { mine: true })
    })];
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
        el('span.mute-sm', {
          text: `${countLabel(list.length, 'מחלקה אחת', 'מחלקות')} · לחיצה על מחלקה פותחת את הלוח שלה`
        }),
        el('div.spacer'),
        el('button.btn.btn-sm', { onclick: () => App.navigate('reports') }, ['לדוחות המלאים'])
      ]),
      // התיבה על ‎.table-wrap‎ עצמו ולא סביבו: הוא כבר אזור הגלילה של הטבלה,
      // ורק כך כותרת העמודות הדביקה (‎th sticky‎) נשארת גלויה בזמן הגלילה
      el('div.table-wrap.feed-scroll', { style: { border: '0' } }, [
        el('table.data', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'מחלקה' }),
              el('th', { text: 'עובדים' }),
              el('th', { text: 'פתוחות' }),
              el('th', { text: 'באיחור' }),
              el('th', { text: 'דחופות' })
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
            cell(d.urgent, 'tag-urgent')
          ])))
        ])
      ])
    ]);
  }

  function approvalCard(tasks) {
    const shown = tasks.slice(0, APPROVAL_MAX);
    const rows = shown.map((t) => el('div.task-card', { onclick: () => TaskCardView.open(t.id) }, [
      el('div.tc-title', { text: t.title }),
      el('div.tc-tags', {}, [
        UI.statusTag(t),
        t.assigneeName ? el('span.tag.tag-vendor', {}, [t.assigneeName]) : null,
        ...UI.taskTags(t)
      ])
    ]));

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: App.isVendor() ? 'ממתין לבדיקת הצוות' : 'תוצרי ספקים הממתינים לאישור' }),
        shown.length
          ? el('span.mute-sm', { text: shownLabel(shown.length, tasks.length, 'פריט אחד', 'פריטים') })
          : null,
        el('div.spacer'),
        !App.isVendor() ? el('button.btn.btn-sm', { onclick: () => App.navigate('vendorBoards') }, ['לבורדי הספקים']) : null
      ]),
      el('div.card-pad', {}, [
        // כרטיס כאן נמוך מזה שברשימה האישית (בלי שורת תחתית), ולכן תקרה נמוכה יותר
        rows.length
          ? scrollBox(rows, { maxHeight: '360px', extraClass: '.flex-col' })
          : UI.empty('אין פריטים הממתינים לבדיקה', '✅')
      ])
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

    /**
     * המונה נספר מן השורות עצמן ולא מאורך weekAhead: השרת מחזיר משימות עד
     * שבוע מרגע זה, כלומר גם משימה שיעדה מחרתיים־בעוד־שבוע בשעה מאוחרת מן
     * השעה הנוכחית — והיא נופלת מחוץ לשבעת הימים המוצגים. מונה שמראה מספר
     * גדול ממה שבתיבה נראה כאילו התיבה מסתירה, וזה בדיוק מה שהמונה בא למנוע.
     */
    const shownCount = days.reduce((sum, d) => sum + d.items.length, 0);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'השבוע הקרוב' }),
        shownCount
          ? el('span.mute-sm', { text: countLabel(shownCount, 'משימה אחת', 'משימות') })
          : null
      ]),
      // שבע השורות קבועות, אך יום עמוס מותח אותן — אותה תיבה, בגובה שמראה שבוע רגיל שלם
      el('div.card-pad', {}, [scrollBox(days.map((d) =>
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
                // הצבע מסמן איחור בפועל
                el('span', {
                  style: { color: t.overdue ? 'var(--danger)' : 'inherit' },
                  text: `• ${t.title}`
                })
              ]))
            : [el('div.mute-sm', { text: '—' })])
        ])
      ), { maxHeight: '380px' })])
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

  function feedRow(f) {
    return el('div.history-item', {
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
        // יש רשומות ללא פירוט, ובלי הסינון היה נדפס 'undefined' לפני הזמן
        el('div.h-meta', { text: [f.details, UI.relative(f.createdAt)].filter(Boolean).join(' · ') })
      ])
    ]);
  }

  /**
   * הפיד יושב בתיבת גלילה בגובה קבוע: קודם לכן כל עדכון הוסיף שורה לעמוד
   * והאריך אותו בלי סוף. הכותרת מציינת את מספר העדכונים כדי שגובה קבוע
   * לא יסתיר את העובדה שיש עוד מתחת לקיפול.
   */
  function feedCard(feed) {
    const items = feed.slice(0, FEED_MAX);
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'פיד עדכונים אחרון' }),
        items.length
          ? el('span.mute-sm', { text: shownLabel(items.length, feed.length, 'עדכון אחד', 'עדכונים') })
          : null
      ]),
      el('div.card-pad', {}, [
        items.length ? scrollBox(items.map(feedRow)) : UI.empty('אין עדכונים אחרונים', '📰')
      ])
    ]);
  }

  return { render };
})();
