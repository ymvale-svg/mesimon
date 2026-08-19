'use strict';
/**
 * מסך 1 — דף הבית האישי.
 * כל עובד רואה כאן את המשימות שלו, ומי שרואה את כל הארגון מקבל בנוסף
 * חתך מחלקתי מרוכז.
 */

const HomeView = (() => {
  const { el } = UI;

  let containerRef = null;

  /**
   * משימות שסומנו כהושלמו בביקור הנוכחי במסך. השרת מחזיר ל"המשימות שלי" רק
   * משימות פתוחות, ובלי הזיכרון הזה השורה הייתה נעלמת באותו רגע שסומנה —
   * המשתמש לא היה רואה את הקו החוצה שביקש. ביציאה מהמסך הן נושרות.
   */
  const keepCompleted = new Map();

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
  const LIST_MAX = 40;      // שורות משימה ברשימה האישית — שורה אחת לכל משימה
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

  /**
   * ‎silent‎ — טעינה מחדש ברקע: בלי ספינר, ותוך שמירת מיקום הגלילה. המסך
   * הקיים נשאר לנגד העיניים עד שהתוכן החדש מוכן, וכך עדכון משימה אינו נראה
   * כרענון של כל הדף.
   */
  async function render(container, { silent = false } = {}) {
    containerRef = container;
    const scrollTop = silent ? container.scrollTop : 0;
    // כניסה חדשה למסך מתחילה מדף נקי — המשימות שהושלמו בביקור הקודם כבר סגורות
    if (!silent) { keepCompleted.clear(); UI.mount(container, UI.spinner()); }
    let data;
    let reports = null;
    try {
      // החתך המחלקתי נשען על דוח הארגון. נטען במקביל, וכשל בו לא מפיל את הדשבורד.
      [data, reports] = await Promise.all([
        API.home(),
        showsDepartmentCut() ? API.reports().catch(() => null) : Promise.resolve(null)
      ]);
    } catch (err) {
      // בטעינת רקע כשל רגעי לא ימחק את מה שכבר על המסך
      if (silent) return;
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    App.state.homeData = data;

    /**
     * זיכרון הביקור אינו נדרש עוד: משימה שהושלמה חוזרת מהשרת בכרטיס
     * "הושלמו לאחרונה", ולכן היא עוברת לשם במקום להישאר ברשימת הפתוחות עם
     * קו חוצה. הסימון עצמו נשאר מיידי — הקו מופיע לפני הטעינה מחדש.
     */

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
          doneCard(data.tasks.recentlyDone ?? [], data.archiveAfterDays ?? 3),
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
    if (scrollTop) container.scrollTop = scrollTop;
  }

  /** טעינה מחדש ברקע — לשימוש אחרי עדכון משימה, בלי לבנות מחדש את האתר */
  const reload = () => (containerRef ? render(containerRef, { silent: true }) : Promise.resolve());

  /** עדכון המונים והרשימות אחרי סימון בשורה, בלי הבהוב ובלי לאבד גלילה */
  function refreshQuietly() {
    reload();
    App.refreshNotifications();
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

  /**
   * הסטטוס הסופי של הבורד שהמשימה יושבת בו. אין קביעה קשיחה של מפתח סטטוס —
   * לכל בורד עמודות משלו, והסימון "בוצע" הוא מעבר לעמודה המסומנת כסופית.
   */
  const finalStatusOf = (task) =>
    App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => c.isFinal)?.key ?? null;

  const firstStatusOf = (task) =>
    App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => !c.isFinal)?.key ?? null;

  function completeBox(task) {
    const finalKey = finalStatusOf(task);
    if (!task.canChangeStatus || !finalKey) return null;

    const box = el('input.tc-done-box', {
      type: 'checkbox',
      checked: !!task.isFinal,
      title: task.isFinal ? 'ביטול הסימון' : 'סימון כהושלמה'
    });
    // הלחיצה על התיבה אינה אמורה לפתוח גם את כרטיס המשימה
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', async () => {
      const wantDone = box.checked;
      const target = wantDone ? finalKey : firstStatusOf(task);
      box.disabled = true;
      try {
        await API.updateTask(task.id, { status: target });
        task.isFinal = wantDone;
        // המשימה נשארת ברשימה עם קו חוצה עד היציאה מהמסך, אף שהשרת כבר אינו
        // מחזיר אותה — אחרת הסימון היה נעלם ברגע שנעשה, ולא היה נראה כלל
        if (wantDone) keepCompleted.set(task.id, task);
        else keepCompleted.delete(task.id);
        box.closest('.task-line')?.classList.toggle('is-done', wantDone);
        UI.success(wantDone ? 'המשימה סומנה כהושלמה' : 'הסימון בוטל');
        refreshQuietly();
      } catch (err) {
        box.checked = !wantDone;
        UI.error(err);
      } finally {
        box.disabled = false;
      }
    });
    return box;
  }

  /**
   * שורה אחת למשימה. כרטיס בן ארבע שורות נראה טוב כשיש שלוש משימות, אבל
   * כשיש עשרים אי אפשר לסרוק אותו — ולכן כל המידע נדחס לשורה: פרויקט,
   * כותרת, סטטוס ויעד, וסימני הדחיפות דווקא בקצה, במקום שהעין נחה בו.
   */
  function taskRow(task) {
    const due = UI.dueLabel(task.dueDate);
    const flags = [
      task.overdue ? el('span', { title: `באיחור — יעד ${UI.formatDate(task.dueDate)}`, text: '⏰' }) : null,
      task.priority === 'urgent' ? el('span', { title: 'עדיפות דחוף', text: '🔥' }) : null,
      task.escalated ? el('span', { title: 'הוקפצה לתשומת לב ההנהלה', text: '↑' }) : null
    ].filter(Boolean);

    /**
     * כל תא הוא עמודה בטבלה ולכן נכתב תמיד, גם כשהוא ריק — תא שנשמט היה מזיז
     * את כל מה שאחריו עמודה אחת שמאלה, וכל השורות היו מפסיקות להתיישר.
     */
    return el(`div.task-line${task.isFinal ? '.is-done' : ''}`, {
      onclick: () => TaskCardView.open(task.id),
      title: task.title
    }, [
      // הפס בצבע הפרויקט — אותו סימן שמופיע בטבלה ובקנבן
      el('span.tk-bar', { style: { background: task.projectColor ?? 'transparent' } }),
      el('span', {}, [completeBox(task)]),
      el('span.tk-project', { text: task.projectName ?? '—' }),
      el('span.tk-title', { text: task.title }),
      UI.statusTag(task),
      el('span.tk-due', {
        text: task.dueDate ? due.text : '—',
        class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
      }),
      el('span.tk-flags', {}, [
        // האחראי מוצג רק כשהוא אינו המשתמש עצמו — ברשימה "שלי" זה תמיד הוא
        task.assigneeName && task.assigneeId !== App.state.actor.id
          ? UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' })
          : null,
        ...flags
      ])
    ]);
  }

  /**
   * "הושלמו לאחרונה" — התשובה לשאלה "לאן המשימה הלכה".
   *
   * משימה שסומנה כהושלמה יורדת מ"המשימות שלי", כי הרשימה ההיא היא מה שנותר
   * לעשות. בלי הכרטיס הזה היא נעלמה מהמסך באותו רגע ולא היה שום מקום לראות
   * מה נסגר או לחזור אליו. היא נשארת כאן עד שהאוטומציה מעבירה אותה לארכיון.
   */
  function doneCard(tasks, afterDays) {
    if (!tasks.length) return null;
    const shown = tasks.slice(0, LIST_MAX);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'הושלמו לאחרונה' }),
        el('span.mute-sm', { text: shownLabel(shown.length, tasks.length, 'משימה אחת', 'משימות') }),
        el('div.spacer'),
        el('button.btn.btn-sm', { onclick: () => App.navigate('archive') }, ['לארכיון'])
      ]),
      el('div.card-pad', {}, [
        el('div.mute-sm', { style: { marginBottom: '8px' },
          text: `לאחר ${afterDays} ימים מההשלמה הן עוברות אוטומטית לארכיון, ושם אפשר למצוא אותן לפי פרויקט.` }),
        el('div.task-table', {}, [
          scrollBox(shown.map(taskRow), { maxHeight: '220px', extraClass: '.flex-col' })
        ])
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
        // שורה בגובה אחיד, ולכן תקרה שמראה כעשר שורות שלמות ורומזת להמשך
        ? el('div.card-pad', {}, [
            el('div.task-table', {}, [
              /**
               * הכותרת יושבת בתוך תיבת הגלילה ולא מעליה, ודביקה בראשה. מחוץ
               * לתיבה היא הייתה רחבה ממנה בעובי פס הגלילה, וכל העמודות היו
               * מוסטות ביחס לשורות — כלומר בדיוק הבלגן שהטבלה באה לפתור.
               */
              scrollBox([
                el('div.task-table-head', {}, [
                  el('span'), el('span'),
                  el('span', { text: 'פרויקט' }),
                  el('span', { text: 'משימה' }),
                  el('span', { text: 'סטטוס' }),
                  el('span', { text: 'יעד' }),
                  el('span')
                ]),
                ...shown.map(taskRow)
              ], { maxHeight: '360px', extraClass: '.flex-col' })
            ])
          ])
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
      /**
       * שם היום ותאריכו באותה שורה, ולא זה מעל זה: כך כל יום הוא שורה אחת
       * במקום שתיים, והתיבה תופסת כמחצית ממה שתפסה. יום עמוס עוד מותח את
       * שורתו, אך רוב הימים בשבוע ריקים ואין סיבה לשלם עליהם גובה כפול.
       */
      el('div.card-pad', {}, [scrollBox(days.map((d) =>
        el('div.week-row', {}, [
          el('div.wk-day', {}, [
            el('b', { style: { color: d.isToday ? 'var(--brand)' : 'inherit' },
              text: d.isToday ? 'היום' : dayNames[d.date.getDay()] }),
            el('span.mute-sm', { text: UI.formatDate(d.date.toISOString()).slice(0, 5) })
          ]),
          el('div.wk-items', {}, d.items.length
            ? d.items.map((t) => el('div.wk-item', {
                title: t.title,
                // הצבע מסמן איחור בפועל
                style: { color: t.overdue ? 'var(--danger)' : 'inherit' },
                onclick: () => TaskCardView.open(t.id)
              }, [t.title]))
            : [el('span.mute-sm', { text: '—' })])
        ])
      ), { maxHeight: '210px' })])
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

  return { render, reload };
})();
