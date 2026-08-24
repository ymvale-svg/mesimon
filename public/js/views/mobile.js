'use strict';
/**
 * דשבורד הנייד — המסך שממנו נעשית כמעט כל העבודה מהטלפון.
 *
 * למה מסך נפרד ולא הדשבורד הרגיל בפריסה צרה: טבלת המשימות במחשב היא ברוחב
 * מינימלי של 920 פיקסלים ובנויה משבע עמודות, וסרגל הסינון שלה הוא שש רשימות
 * נפתחות. על מסך של 390 פיקסלים אין דרך לכווץ אותם למשהו שאפשר לעבוד בו —
 * צריך צורה אחרת: שורה בשתי שורות, ושבבי סינון בנגיעה אחת.
 *
 * מה כן משותף למחשב: כרטיס המשימה, דיאלוג המשימה החדשה, דיאלוג הפרויקט,
 * חלון התצוגה המקדימה והשיחה — כולם נטענים כמו שהם ומקבלים פריסת נייד
 * מ-mobile.css. אין כאן מימוש שני של שום דבר שכבר עובד.
 */

const MobileView = (() => {
  const { el } = UI;

  let containerRef = null;
  let tasks = [];
  let loading = false;

  /**
   * החתך הנוכחי. מי שעובד תמיד באותו חתך — "רק הפרויקט הזה, רק באיחור" —
   * לא יבחר אותו מחדש בכל פתיחה של האפליקציה.
   *
   * נשמר גם במכשיר וגם בשרת: המכשיר זמין כבר בטעינת הקובץ, לפני שהשרת ענה,
   * והשרת הוא זה שגורם לחתך להיות זהה בטלפון ובמחשב.
   */
  const FILTER_KEY = 'mesimon.mobileFilter';
  const DEFAULTS = { mode: 'open', projectId: '', status: '', priority: '', q: '' };
  let filter = { ...DEFAULTS };

  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
    if (saved && typeof saved === 'object') filter = { ...DEFAULTS, ...saved };
  } catch { /* חתך פגום בזיכרון אינו סיבה לא לפתוח את המסך */ }

  /*
   * החתך מהשרת נקרא בפתיחת המסך ולא בטעינת הקובץ, כי בטעינה עוד אין
   * ‎App.state‎. נקרא פעם אחת לכל משתמש — אחרת כל רענון מסך היה מבטל את
   * החתך שהמשתמש בחר לפני רגע.
   *
   * הזיהוי הוא לפי מזהה המשתמש ולא דגל בוליאני: התנתקות וכניסה מחדש באותה
   * לשונית אינן טוענות את הדף מחדש, ודגל היה משאיר את המשתמש הבא עם החתך
   * של קודמו.
   */
  let filterOwner = null;
  function adoptServerFilter() {
    const me = App.state.actor?.id ?? null;
    if (me === null || filterOwner === me) return;
    const first = filterOwner === null;
    filterOwner = me;
    const fromServer = App.getPref('mobileFilter');
    if (fromServer && typeof fromServer === 'object') {
      filter = { ...DEFAULTS, ...fromServer };
    } else if (!first) {
      // משתמש אחר נכנס באותה לשונית — החתך שנשמר במכשיר אינו שלו
      filter = { ...DEFAULTS };
    }
    // ובכניסה הראשונה, כשלשרת אין עדיין העדפה, נשאר מה שנקרא מהמכשיר
  }

  const saveFilter = () => {
    App.setPref('mobileFilter', filter);
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch { /* מצב פרטי */ }
  };

  const MODES = [
    { key: 'open', label: 'פתוחות' },
    { key: 'overdue', label: 'באיחור' },
    { key: 'urgent', label: 'דחוף' },
    { key: 'done', label: 'הושלמו' }
  ];

  // ------------------------------------------------------------- נתונים

  /**
   * הסינון שאפשר לעשות בשרת נעשה בשרת, והשאר כאן. "באיחור" ו"הושלמו" אינם
   * פרמטרים של נקודת הקצה אלא תכונות מחושבות של המשימה, ולכן הם מסוננים
   * מקומית — על רשימה שממילא הגיעה.
   */
  async function fetchTasks() {
    const query = {
      scope: 'internal',
      assignee: `user:${App.state.actor.id}`,
      projectId: filter.projectId || '',
      status: filter.status || '',
      priority: filter.priority || '',
      q: filter.q || ''
    };
    // "הושלמו" מציג גם את מה שכבר בארכיון — שם הן יושבות אחרי כמה ימים
    const [live, archived] = await Promise.all([
      API.tasks(query),
      filter.mode === 'done' ? API.tasks({ ...query, archived: '1' }) : Promise.resolve({ tasks: [] })
    ]);
    return [...live.tasks, ...archived.tasks];
  }

  const visible = () => {
    if (filter.mode === 'done') return tasks.filter((t) => t.isFinal);
    const open = tasks.filter((t) => !t.isFinal);
    if (filter.mode === 'overdue') return open.filter((t) => t.overdue);
    if (filter.mode === 'urgent') return open.filter((t) => t.priority === 'urgent');
    return open;
  };

  /** באיחור קודם, ואחריו לפי קרבת היעד; ללא יעד בסוף */
  const sorted = (list) => [...list].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  const counts = () => {
    const open = tasks.filter((t) => !t.isFinal);
    return {
      open: open.length,
      overdue: open.filter((t) => t.overdue).length,
      urgent: open.filter((t) => t.priority === 'urgent').length,
      done: tasks.filter((t) => t.isFinal).length
    };
  };

  // ------------------------------------------------------------- מסך

  async function render(container, { silent = false } = {}) {
    containerRef = container;
    adoptServerFilter();
    if (!silent) UI.mount(container, UI.spinner());
    loading = true;
    try {
      tasks = await fetchTasks();
    } catch (err) {
      loading = false;
      // כשל בטעינת רקע לא ימחק את מה שכבר על המסך
      if (silent) return;
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    loading = false;
    draw();
  }

  const reload = () => (containerRef ? render(containerRef, { silent: true }) : Promise.resolve());

  /** שינוי חתך — טוען מחדש רק כשהשינוי נוגע לשרת */
  function setFilter(patch, { refetch = false } = {}) {
    Object.assign(filter, patch);
    saveFilter();
    if (refetch || filter.mode === 'done') reload();
    else draw();
  }

  function draw() {
    if (!containerRef) return;
    const scrollTop = containerRef.scrollTop;
    const c = counts();
    const list = sorted(visible());
    const project = filter.projectId ? App.project(Number(filter.projectId)) : null;

    UI.mount(containerRef,
      el('div.page-head', {}, [
        el('div', {}, [el('h2', { text: `שלום, ${App.state.actor.name.split(' ')[0]}` })])
      ]),

      // שלושת המונים — גם תמונת מצב וגם קיצור דרך לחתך
      el('div.m-counts', {}, [
        countBox('open', c.open, 'פתוחות', ''),
        countBox('overdue', c.overdue, 'באיחור', 'is-danger'),
        countBox('urgent', c.urgent, 'דחוף', 'is-warn')
      ]),

      el('div.m-chips', { style: { marginTop: '10px' } }, [
        ...MODES.map((m) =>
          el(`button.m-chip${filter.mode === m.key ? '.on' : ''}`, {
            onclick: () => setFilter({ mode: m.key })
          }, [m.label])),
        // המסנן המלא, ומספר המסננים הפעילים שבו
        el(`button.m-chip${activeExtras() ? '.on' : ''}`, { onclick: openSheet }, [
          '⚙ סינון',
          activeExtras() ? el('span.n', { text: String(activeExtras()) }) : null
        ])
      ]),

      project
        ? el('div.mute-sm', { style: { marginTop: '8px' }, text: `מסונן לפרויקט: ${project.name}` })
        : null,

      list.length
        ? el('div.m-list', { style: { marginTop: '12px' } }, list.map(taskRow))
        : el('div', { style: { marginTop: '20px' } }, [
            UI.empty(emptyText(), UI.icon(filter.mode === 'done' ? 'waiting' : 'my-tasks'))
          ])
    );
    containerRef.scrollTop = scrollTop;
  }

  const activeExtras = () =>
    [filter.projectId, filter.status, filter.priority, filter.q].filter(Boolean).length;

  function emptyText() {
    if (activeExtras()) return 'אין משימות בחתך הזה';
    if (filter.mode === 'overdue') return 'אין משימות באיחור';
    if (filter.mode === 'urgent') return 'אין משימות דחופות';
    if (filter.mode === 'done') return 'עדיין לא הושלמו משימות';
    return 'אין משימות פתוחות המשויכות אליך';
  }

  const countBox = (mode, num, label, tone) =>
    el(`button.m-count.${tone || 'is-plain'}${filter.mode === mode ? '.active' : ''}`, {
      onclick: () => setFilter({ mode })
    }, [
      el('b', { text: String(num) }),
      el('span', { text: label })
    ]);

  /**
   * שורת משימה. שתי שורות ולא אחת: על 390 פיקסלים שורה אחת עם פרויקט, כותרת,
   * סטטוס ויעד נחתכת עד לחוסר קריאות. הכותרת למעלה, וההקשר מתחתיה.
   */
  function taskRow(task) {
    const due = UI.dueLabel(task.dueDate);
    const finalKey = App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => c.isFinal)?.key;

    const box = el('input.m-check', {
      type: 'checkbox',
      checked: !!task.isFinal,
      disabled: !task.canChangeStatus || !finalKey,
      title: task.isFinal ? 'ביטול הסימון' : 'סימון כהושלמה'
    });
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', async () => {
      const wantDone = box.checked;
      const first = App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => !c.isFinal)?.key;
      box.disabled = true;
      try {
        await API.updateTask(task.id, { status: wantDone ? finalKey : first });
        UI.success(wantDone ? 'המשימה סומנה כהושלמה' : 'הסימון בוטל');
        await reload();
        App.refreshNotifications();
      } catch (err) {
        box.checked = !wantDone;
        box.disabled = false;
        UI.error(err);
      }
    });

    return el(`div.m-task${task.isFinal ? '.is-done' : ''}`, {
      onclick: () => TaskCardView.open(task.id)
    }, [
      el('span.m-bar', { style: { background: task.projectColor ?? 'transparent' } }),
      box,
      el('div.m-body', {}, [
        el('div.m-title', { text: task.title, title: task.title }),
        el('div.m-meta', {}, [
          task.projectName ? el('span.m-proj', { text: task.projectName }) : null,
          task.projectName ? el('span', { text: '·' }) : null,
          el('span', {
            text: task.statusLabel,
            style: { color: task.statusColor, fontWeight: '700', flex: 'none' }
          }),
          task.dueDate ? el('span', { text: '·', style: { flex: 'none' } }) : null,
          task.dueDate
            ? el('span', {
                text: due.text, style: { flex: 'none' },
                class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
              })
            : null
        ])
      ]),
      el('div.m-side', {}, [
        task.overdue ? el('span.text-danger', { title: 'באיחור' }, [UI.icon('overdue')]) : null,
        task.priority === 'urgent' ? el('span.text-warn', { title: 'דחוף' }, [UI.icon('urgent')]) : null
      ])
    ]);
  }

  // ------------------------------------------------------------- מגירת הסינון

  /**
   * המסנן המלא במגירה מלמטה. השבבים למעלה מכסים את רוב המקרים בנגיעה אחת,
   * וכאן נמצא מה שנדרש לעיתים — פרויקט, סטטוס, עדיפות וחיפוש.
   */
  function openSheet() {
    const projectSelect = UI.select(
      [{ value: '', label: 'כל הפרויקטים' },
        ...App.state.projects.map((p) => ({ value: String(p.id), label: p.name }))],
      String(filter.projectId ?? '')
    );
    const statusSource = App.internalBoard()?.columns ?? [];
    const statusSelect = UI.select(
      [{ value: '', label: 'כל הסטטוסים' }, ...statusSource.map((c) => ({ value: c.key, label: c.label }))],
      filter.status
    );
    const prioritySelect = UI.select(
      [{ value: '', label: 'כל העדיפויות' },
        ...App.state.priorities.map((p) => ({ value: p.key, label: p.label }))],
      filter.priority
    );
    const searchInput = el('input', { type: 'search', placeholder: 'חיפוש בכותרת ובתיאור' });
    searchInput.value = filter.q ?? '';

    const veil = el('div.m-sheet-veil');
    const close = () => veil.remove();
    veil.addEventListener('click', (e) => { if (e.target === veil) close(); });

    const apply = () => {
      close();
      setFilter({
        projectId: projectSelect.value,
        status: statusSelect.value,
        priority: prioritySelect.value,
        q: searchInput.value.trim()
      }, { refetch: true });
    };

    veil.appendChild(el('div.m-sheet', {}, [
      el('div.m-grab'),
      el('div.flex', { style: { marginBottom: '4px' } }, [
        el('b', { text: 'סינון' }),
        el('div.spacer'),
        el('button.btn.btn-sm', {
          onclick: () => {
            close();
            setFilter({ projectId: '', status: '', priority: '', q: '' }, { refetch: true });
          }
        }, ['ניקוי'])
      ]),
      UI.field('פרויקט', projectSelect),
      UI.field('סטטוס', statusSelect),
      UI.field('עדיפות', prioritySelect),
      UI.field('חיפוש', searchInput),
      el('button.btn.btn-primary.btn-block', { onclick: apply }, ['הצגת המשימות'])
    ]));

    document.body.appendChild(veil);
    // הרשימות הנפתחות מיישמות מיד — כך אין צורך ללחוץ "הצגה" בשינוי אחד
    for (const s of [projectSelect, statusSelect, prioritySelect]) {
      s.addEventListener('change', () => { /* מיושם ב"הצגת המשימות" */ });
    }
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  }

  return { render, reload, draw };
})();
