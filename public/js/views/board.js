'use strict';
/**
 * מסך 2 — לוח המשימות.
 * שלוש תצוגות: כרטיסיות (קנבן) עם גרירה ושחרור, טבלה, וציר זמן.
 * מציג את הבורד הפנימי בלבד; בורדי הספקים מוצגים בתצוגת-העל הנפרדת.
 */

const BoardView = (() => {
  const { el } = UI;

  // הטבלה המקובצת היא תצוגת ברירת המחדל — מסך העבודה היומיומי של המחלקה
  const view = { mode: 'table', selection: new Set() };
  let filters = {};
  let currentScope = 'internal';
  let currentTasks = [];
  let containerRef = null;

  // רשימת המחלקות לחתך המחלקתי. נטענת פעם אחת בלבד — היא משתנה לעיתים רחוקות,
  // ואין טעם לפנות לשרת בכל רענון של הלוח.
  let departments = [];

  /**
   * האם השחקן רואה יותר ממחלקה אחת. זו אותה הגדרה שהשרת מפעיל (isOrgWide),
   * והוא מתעלם מפרמטר departmentId לכל תפקיד אחר — ולכן לא מציעים לו את החתך.
   */
  const isOrgWide = () => ['superadmin', 'admin', 'executive'].includes(App.state.actor?.role);

  // ------------------------------------------------------------- טעינה

  async function render(container, params = {}) {
    containerRef = container;
    const scopeChanged = currentScope !== (params.scope ?? 'internal');
    currentScope = params.scope ?? 'internal';
    view.selection.clear();
    if (scopeChanged) GridView.resetGrouping();

    // מצב התצוגה שהמשתמש עבד בו, אם נשמר
    const savedView = App.getPref('boardView');
    if (['table', 'kanban', 'timeline'].includes(savedView)) view.mode = savedView;

    /**
     * סדר העדיפות: מה שהועבר בניווט (למשל לחיצה על ווידג'ט "באיחור") גובר,
     * ואחריו מה שנשמר מהפעם הקודמת. כך קיצור דרך מהדשבורד עדיין עובד, אבל
     * פתיחה רגילה של הלוח מחזירה את החתך שהמשתמש עבד בו.
     */
    const saved = readSaved(params.archived ? 'archive' : currentScope);
    const pick = (key, fromParams) => (fromParams !== undefined && fromParams !== null && fromParams !== ''
      ? fromParams
      : (saved[key] ?? ''));

    filters = {
      scope: currentScope,
      projectId: params.projectId ?? (params.keepFilters ? filtersKeep('projectId', params) : pick('projectId')),
      assignee: params.mine
        ? `${App.isVendor() ? 'vendor' : 'user'}:${App.state.actor.id}`
        : pick('assignee', params.assignee),
      priority: pick('priority', params.priority),
      status: pick('status', params.status),
      boardId: pick('boardId', params.boardId),
      departmentId: pick('departmentId', params.departmentId),
      // חיפוש טקסט לא נשמר בכוונה
      q: '',
      archived: params.archived ? '1' : '',
      onlyOverdue: params.overdue !== undefined ? !!params.overdue : !!saved.onlyOverdue,
      pendingReview: params.pendingReview !== undefined ? !!params.pendingReview : !!saved.pendingReview
    };

    await load();
  }

  const filtersKeep = (key, params) => (params.keepFilters ? filters[key] : '');

  /**
   * החתך נשמר בנפרד לכל תצוגה (פנימי / ספקים / ארכיון) — מי שעובד תמיד
   * בחתך אחד לא יבחר אותו מחדש בכל פתיחה.
   *
   * נשמר בשני מקומות בכוונה: בשרת, כדי שההעדפה תלך אחרי המשתמש בין
   * מכשירים ובין דפדפנים (זו הייתה הסיבה שהחתך "לא נשמר" — ‎localStorage‎
   * לבדו נשאר במכשיר שנבחר בו), וגם במכשיר, כי הוא זמין מיידית בטעינה
   * ראשונה וממשיך לעבוד גם כשהרשת נופלת.
   *
   * ‎q‎ אינו נשמר: מחרוזת חיפוש היא חיפוש חד-פעמי, ולא הגדרת עבודה. לוח
   * שנפתח עם חיפוש ישן נראה כאילו חסרות בו משימות.
   */
  const FILTER_KEY = 'mesimon.boardFilters';
  const PERSISTED = ['projectId', 'assignee', 'priority', 'status', 'boardId', 'departmentId', 'onlyOverdue', 'pendingReview'];

  const localFilters = () => {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}'); } catch { return {}; }
  };

  /* השרת קודם — הוא המקור שמשותף לכל המכשירים, והמכשיר הוא רק גיבוי */
  const readSaved = (scope) =>
    App.getPref('boardFilters', {})?.[scope] ?? localFilters()[scope] ?? {};

  function saveFilters() {
    const key = filters.archived === '1' ? 'archive' : currentScope;
    const mine = Object.fromEntries(PERSISTED.map((k) => [k, filters[k]]));

    const merged = { ...App.getPref('boardFilters', {}), ...localFilters(), [key]: mine };
    App.setPref('boardFilters', merged);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(merged));
    } catch { /* מצב פרטי — נשאר רק מה שנשמר בשרת */ }
  }

  async function ensureDepartments() {
    if (!isOrgWide() || departments.length) return;
    try {
      const data = await API.departments();
      departments = data.departments;
    } catch {
      // כשל בטעינת המחלקות אינו אמור למנוע את הצגת הלוח — החתך פשוט לא יוצע
    }
  }

  async function load(opts = {}) {
    if (!opts.silent) UI.mount(containerRef, header(), UI.spinner());
    try {
      await ensureDepartments();
      const query = { ...filters };
      delete query.onlyOverdue;
      delete query.pendingReview;
      const data = await API.tasks(query);
      currentTasks = data.tasks;
      if (filters.onlyOverdue) currentTasks = currentTasks.filter((t) => t.overdue);
      if (filters.pendingReview) currentTasks = currentTasks.filter((t) => ['uploaded', 'pending_team_review', 'in_team_review'].includes(t.status));
      draw();
      if (opts.keepFocus) GridView.restoreFocus(opts.keepFocus);
    } catch (err) {
      // כשל רגעי בטעינת רקע לא ימחק את מה שכבר על המסך
      if (!opts.silent) UI.mount(containerRef, header(), UI.empty(err.message, '⚠️'));
    }
  }

  function draw() {
    const scrollTop = containerRef?.scrollTop ?? 0;
    const body =
      view.mode === 'kanban' ? kanban() :
      view.mode === 'table' ? grid() :
      timeline();
    UI.mount(containerRef, header(), toolbar(), bulkBar(), body);
    if (scrollTop) containerRef.scrollTop = scrollTop;
  }

  /** תצוגת הטבלה המקובצת — הקישור בין הלוח למודול הגריד */
  function grid() {
    return GridView.render({
      tasks: currentTasks,
      scope: currentScope,
      archived: filters.archived === '1',
      selectable: !App.isVendor(),
      selection: view.selection,
      onReload: (o) => load({ silent: true, ...o }),
      onRedraw: draw,
      onSelectionChanged: draw,
      // עריכה במקום עלולה להוציא את המשימה מגבולות הסינון הנוכחי (שינוי סטטוס
      // בזמן סינון לפי סטטוס, דחיית תאריך יעד תחת "רק באיחור", העברה לבורד ספק).
      // שכפול לוגיקת הסינון כאן היה נסחף מהשרת — לכן טוענים מחדש בשקט.
      onTaskUpdated: () => {
        load({ silent: true });
        App.refreshNotifications();
      }
    });
  }

  // ------------------------------------------------------------- כותרת וסרגל

  function header() {
    const project = filters.projectId ? App.project(Number(filters.projectId)) : null;
    let title = 'לוח המשימות';
    let sub = 'הבורד הפנימי של הצוות — משימות פנימיות בלבד.';

    if (filters.archived === '1') {
      title = 'ארכיון';
      sub = 'משימות שהושלמו והועברו לארכיון. אינן מוצגות בתצוגה הראשית.';
    } else if (currentScope === 'vendors') {
      title = 'כל משימות הספקים';
      sub = 'תצוגת-על המרכזת את הפעילות מכל בורדי הספקים לצורך בקרה ודיווח.';
    } else if (project) {
      title = project.name;
      sub = project.description || 'תצוגת משימות הפרויקט.';
    }

    return el('div.page-head', {}, [
      // הלוגו של הפרויקט לצד שמו, כשהוגדר לו אחד
      project?.logoId
        ? el('img.head-logo', { src: `/api/project-images/${project.logoId}/view`, alt: project.name })
        : null,
      el('div', {}, [el('h2', { text: title }), el('div.sub', { text: sub })]),
      el('div.spacer'),
      project && App.may('create_project')
        ? el('button.btn', { onclick: () => openProjectDialog(project) }, ['✎ עריכת פרויקט'])
        : null,
      App.may('export_data')
        ? el('a.btn', { href: '/api/export/tasks.csv' }, ['⬇ ייצוא CSV'])
        : null,
      App.may('create_task') && filters.archived !== '1'
        ? el('button.btn.btn-primary', {
            onclick: () => openTaskDialog(null, { projectId: filters.projectId, scope: currentScope })
          }, ['＋ משימה חדשה'])
        : null
    ]);
  }

  function toolbar() {
    const set = (key, value) => { filters[key] = value; saveFilters(); load(); };

    const projectOptions = [{ value: '', label: 'כל הפרויקטים' },
      ...App.state.projects.map((p) => ({ value: p.id, label: p.name }))];

    const assigneeOptions = [{ value: '', label: 'כל האחראים' },
      ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
      ...App.state.vendors.map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק)` }))];

    const priorityOptions = [{ value: '', label: 'כל העדיפויות' },
      ...App.state.priorities.map((p) => ({ value: p.key, label: p.label }))];

    const statusSource = currentScope === 'vendors'
      ? App.vendorBoards()[0]?.columns ?? []
      : App.internalBoard()?.columns ?? [];
    const statusOptions = [{ value: '', label: 'כל הסטטוסים' },
      ...statusSource.map((c) => ({ value: c.key, label: c.label }))];

    const searchInput = el('input', { type: 'search', placeholder: 'סינון לפי טקסט…', value: filters.q });
    let timer;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => set('q', searchInput.value.trim()), 300);
    });

    const items = [
      el('div.view-switch', {}, [
        ['table', '☰ טבלה'], ['kanban', '▦ כרטיסיות'], ['timeline', '▤ ציר זמן']
      ].map(([mode, label]) =>
        el(`button${view.mode === mode ? '.active' : ''}`, {
          // גם מצב התצוגה הוא העדפה — מי שעובד בכרטיסיות לא רוצה לחזור לטבלה בכל כניסה
          onclick: () => { view.mode = mode; App.setPref('boardView', mode); draw(); }
        }, [label])
      )),
      el('div.sep'),
      UI.select(projectOptions, filters.projectId, { onchange: (e) => set('projectId', e.target.value) }),
      UI.select(assigneeOptions, filters.assignee, { onchange: (e) => set('assignee', e.target.value) }),
      UI.select(statusOptions, filters.status, { onchange: (e) => set('status', e.target.value) }),
      UI.select(priorityOptions, filters.priority, { onchange: (e) => set('priority', e.target.value) })
    ];

    if (isOrgWide() && departments.length) {
      const departmentOptions = [{ value: '', label: 'כל המחלקות' },
        ...departments.map((d) => ({ value: d.id, label: d.name }))];
      items.push(UI.select(departmentOptions, filters.departmentId, { onchange: (e) => set('departmentId', e.target.value) }));
    }

    if (currentScope === 'vendors') {
      const vendorOptions = [{ value: '', label: 'כל הספקים' },
        ...App.state.vendors.map((v) => ({ value: v.boardId, label: v.name }))];
      items.push(UI.select(vendorOptions, filters.boardId, { onchange: (e) => set('boardId', e.target.value) }));
    }

    items.push(searchInput);
    items.push(el('label.checkbox', {}, [
      el('input', {
        type: 'checkbox',
        checked: filters.onlyOverdue,
        // דרך set, כמו כל שאר החתכים — אחרת "רק באיחור" היה החתך היחיד שאינו נשמר
        onchange: (e) => set('onlyOverdue', e.target.checked)
      }),
      'רק באיחור'
    ]));

    items.push(el('div.spacer'));

    // מסננים אישיים שמורים
    if (!App.isVendor()) {
      if (App.state.savedFilters.length) {
        items.push(UI.select(
          [{ value: '', label: 'מסננים שמורים…' }, ...App.state.savedFilters.map((f) => ({ value: f.id, label: f.name }))],
          '',
          {
            onchange: (e) => {
              const saved = App.state.savedFilters.find((f) => String(f.id) === e.target.value);
              // מסנן שנשמר לפני שנוספו רמת המשימה והחתך המחלקתי אינו נושא את
              // המפתחות האלה — מאפסים אותם ל"הכול" כדי שהמסנן יטען כפי שנשמר
              if (saved) { filters = { ...filters, departmentId: '', ...saved.payload }; load(); }
            }
          }
        ));
      }
      items.push(el('button.btn.btn-sm', { onclick: saveCurrentFilter, title: 'שמירת המסננים הנוכחיים' }, ['💾 שמור מסנן']));
    }

    return el('div.toolbar', {}, items);
  }

  async function saveCurrentFilter() {
    const name = await UI.prompt('שם המסנן', { title: 'שמירת מסנן אישי' });
    if (!name) return;
    try {
      const { projectId, assignee, priority, status, boardId, departmentId, q, onlyOverdue } = filters;
      const data = await API.saveFilter(name, { projectId, assignee, priority, status, boardId, departmentId, q, onlyOverdue });
      App.state.savedFilters = data.savedFilters;
      UI.success('המסנן נשמר');
      draw();
    } catch (err) { UI.error(err); }
  }

  // ------------------------------------------------------------- פעולות אצווה

  function bulkBar() {
    if (!view.selection.size || App.isVendor()) return null;

    const columns = currentScope === 'vendors'
      ? App.vendorBoards()[0]?.columns ?? []
      : App.internalBoard()?.columns ?? [];

    const run = async (action, value) => {
      try {
        const res = await API.bulk([...view.selection], action, value);
        view.selection.clear();
        const verb = action === 'delete' ? 'נמחקו' : 'עודכנו';
        UI.success(`${verb} ${res.affected} משימות`);
        if (res.errors.length) UI.toast(`${res.errors.length} משימות לא ${verb} (הרשאות או חוקי זרימה)`, 'error');
        await load({ silent: true });
        App.refreshNotifications();
      } catch (err) { UI.error(err); }
    };

    return el('div.toolbar', { style: { background: 'var(--brand-light)', borderColor: 'var(--brand)' } }, [
      el('b', { text: `${view.selection.size} משימות נבחרו` }),
      el('div.sep'),
      UI.select([{ value: '', label: 'שינוי סטטוס…' }, ...columns.map((c) => ({ value: c.key, label: c.label }))], '', {
        onchange: (e) => e.target.value && run('status', e.target.value)
      }),
      UI.select([{ value: '', label: 'שינוי אחראי…' },
        ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
        ...(App.may('assign_task_to_vendor') ? App.state.vendors.map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק)` })) : [])
      ], '', { onchange: (e) => e.target.value && run('assignee', e.target.value) }),
      UI.select([{ value: '', label: 'שינוי עדיפות…' }, ...App.state.priorities.map((p) => ({ value: p.key, label: p.label }))], '', {
        onchange: (e) => e.target.value && run('priority', e.target.value)
      }),
      /**
       * העברה בין פרויקטים. כאן ולא רק בתא הפרויקט, כי בקיבוץ לפי פרויקט —
       * שהוא ברירת המחדל — אין בכלל עמודת פרויקט, ואז לא הייתה דרך להעביר.
       * ‎__none__‎ ולא ערך ריק, כי ריק הוא הכיתוב "העברה לפרויקט…" עצמו.
       */
      UI.select([
        { value: '', label: 'העברה לפרויקט…' },
        { value: '__none__', label: 'ללא פרויקט' },
        ...App.state.projects.map((p) => ({ value: String(p.id), label: p.name }))
      ], '', {
        onchange: (e) => e.target.value && run('project', e.target.value === '__none__' ? '' : e.target.value)
      }),
      el('button.btn.btn-sm', { onclick: () => run('archive', filters.archived === '1' ? 0 : 1) },
        [filters.archived === '1' ? '↩ החזרה מארכיון' : '🗄 העברה לארכיון']),
      /**
       * מחיקה מחייבת אישור מפורש שנוקב במספר. זו הפעולה היחידה בסרגל שאין
       * ממנה חזרה — ארכיון אפשר לבטל, מחיקה לא — ולכן היא גם נפרדת חזותית
       * ולא נמצאת לצד שאר הפעולות בטעות.
       */
      App.may('edit_delete_task')
        ? el('button.btn.btn-sm.btn-danger', {
            onclick: async () => {
              const n = view.selection.size;
              const ok = await UI.confirm(
                n === 1
                  ? 'למחוק את המשימה שנבחרה? המחיקה כוללת את השיחה, הצ׳קליסט והקבצים שבה, ואינה ניתנת לביטול.'
                  : `למחוק ${n} משימות? המחיקה כוללת את השיחה, הצ׳קליסט והקבצים שבהן, ואינה ניתנת לביטול.`,
                { title: 'מחיקת משימות', danger: true, okText: n === 1 ? 'מחיקה' : `מחיקת ${n} משימות` }
              );
              if (ok) run('delete');
            }
          }, ['🗑 מחיקה'])
        : null,
      el('div.spacer'),
      el('button.btn.btn-sm', { onclick: () => { view.selection.clear(); draw(); } }, ['ביטול בחירה'])
    ]);
  }

  // ------------------------------------------------------------- כרטיס משימה בלוח

  function card(task) {
    const due = UI.dueLabel(task.dueDate);
    const selectable = !App.isVendor();

    const node = el('div.task-card', {
      class: [task.overdue ? 'is-overdue' : '', task.priority === 'urgent' ? 'is-urgent' : '', task.escalated ? 'is-escalated' : ''].filter(Boolean).join(' '),
      draggable: !App.isVendor() || true,
      // פס בצבע הפרויקט בקצה הכרטיס — זיהוי ויזואלי בלי לקרוא את שם הפרויקט
      style: task.projectColor ? { borderInlineStartColor: task.projectColor, borderInlineStartWidth: '3px' } : {},
      onclick: (e) => { if (!e.target.closest('.select-box')) TaskCardView.open(task.id); }
    }, [
      selectable ? el('label.select-box', {}, [
        el('input', {
          type: 'checkbox',
          checked: view.selection.has(task.id),
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            if (e.target.checked) view.selection.add(task.id);
            else view.selection.delete(task.id);
            draw();
          }
        })
      ]) : null,
      task.projectName
        ? el('div.tc-project', {}, [el('span.project-dot', { style: { background: task.projectColor } }), task.projectName])
        : null,
      el('div.tc-title', { text: task.title, style: selectable ? { paddingInlineEnd: '18px' } : {} }),
      el('div.tc-tags', {}, UI.taskTags(task)),
      el('div.tc-foot', {}, [
        task.checklistTotal
          ? el('span.tc-check', {}, [
              el('div.progress-mini', {}, [el('div', { style: { width: `${(task.checklistDone / task.checklistTotal) * 100}%` } })]),
              `${task.checklistDone}/${task.checklistTotal}`
            ])
          : null,
        // מונה המהדקים הוסר — הקבצים עצמם מוצגים למעלה בכרטיס
        task.commentsCount ? el('span', { text: `💬 ${task.commentsCount}` }) : null,
        el('div.spacer'),
        el('span', {
          text: due.text,
          class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
        }),
        task.assigneeName ? UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' }) : null
      ])
    ]);

    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(task.id));
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    return node;
  }

  // ------------------------------------------------------------- תצוגת קנבן

  function kanban() {
    // בתצוגת-על של ספקים מקבצים לפי בורד הספק; אחרת לפי עמודות הסטטוס
    const boards = currentScope === 'vendors'
      ? App.vendorBoards().filter((b) => !filters.boardId || String(b.id) === String(filters.boardId))
      : [App.internalBoard()].filter(Boolean);

    if (!boards.length) return UI.empty('אין בורדים להצגה', '📋');

    const sections = boards.map((board) => {
      const boardTasks = currentTasks.filter((t) => t.boardId === board.id);
      const cols = board.columns.map((col) => {
        const colTasks = boardTasks.filter((t) => t.status === col.key);
        const body = el('div.kanban-col-body', {}, colTasks.length ? colTasks.map(card) : []);

        const colNode = el('div.kanban-col', {}, [
          el('div.kanban-col-head', {}, [
            el('span.dot', { style: { background: col.color } }),
            el('h4', { text: col.label }),
            el('span.num', { text: String(colTasks.length) })
          ]),
          body
        ]);

        colNode.addEventListener('dragover', (e) => { e.preventDefault(); colNode.classList.add('drop-target'); });
        colNode.addEventListener('dragleave', () => colNode.classList.remove('drop-target'));
        colNode.addEventListener('drop', async (e) => {
          e.preventDefault();
          colNode.classList.remove('drop-target');
          const id = Number(e.dataTransfer.getData('text/plain'));
          const task = currentTasks.find((t) => t.id === id);
          if (!task || task.status === col.key) return;
          try {
            await API.updateTask(id, { status: col.key });
            UI.success(`המשימה הועברה ל"${col.label}"`);
            await load({ silent: true });
            App.refreshNotifications();
          } catch (err) { UI.error(err); }
        });

        return colNode;
      });

      return el('div', { style: { marginBottom: '22px' } }, [
        boards.length > 1
          ? el('h3', { text: board.name, style: { marginBottom: '10px', fontSize: '15px', color: 'var(--accent)' } })
          : null,
        el('div.kanban', {}, cols)
      ]);
    });

    if (!currentTasks.length) {
      return el('div', {}, [...sections, UI.empty('אין משימות התואמות את הסינון הנוכחי', '🔍')]);
    }
    return el('div', {}, sections);
  }

  // ------------------------------------------------------------- ציר זמן

  function timeline() {
    const withDates = currentTasks.filter((t) => t.dueDate);
    if (!withDates.length) return UI.empty('אין משימות עם תאריך יעד להצגה בציר הזמן', '📅');

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - 7);
    const dates = withDates.map((t) => new Date(t.dueDate).getTime());
    const maxDate = new Date(Math.max(...dates, today.getTime() + 14 * 86400000));
    const end = new Date(maxDate); end.setDate(end.getDate() + 3);

    const totalDays = Math.max(1, Math.ceil((end - start) / 86400000));
    const pct = (date) => ((new Date(date) - start) / 86400000 / totalDays) * 100;

    // התוויות ממוקמות באחוזים בדיוק כמו הפסים. קודם הן היו פריטי flex בחלוקה
    // שווה, כלומר מערכת קואורדינטות שנייה שלא התלכדה עם התאריכים — והסטייה
    // הצטברה לרוחב הציר.
    const todayOffset = Math.round((today - start) / 86400000);
    const step = Math.max(1, Math.round(totalDays / 14));
    const ticks = [];

    // סדרת התוויות עוגנת ביום הנוכחי, כך שהיום עצמו תמיד מקבל תווית.
    // בלי העיגון הזה, צעד של יומיים גרם ליום הנוכחי ליפול בין שתי תוויות.
    for (let i = todayOffset % step; i < totalDays; i += step) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const isToday = i === todayOffset;
      ticks.push(el(`div.tl-day${isToday ? '.today' : ''}`, {
        style: { insetInlineStart: `${(i / totalDays) * 100}%` }
      }, [
        el('span.tl-day-label', { text: isToday ? `היום ${d.getDate()}.${d.getMonth() + 1}` : `${d.getDate()}.${d.getMonth() + 1}` })
      ]));
    }

    const rows = withDates
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .map((t) => {
        const barStart = t.createdAt ? Math.max(0, pct(t.createdAt)) : Math.max(0, pct(t.dueDate) - 4);
        const barEnd = pct(t.dueDate);
        const width = Math.max(2.2, barEnd - barStart);
        return el('div.tl-row', {}, [
          el('div.tl-label', { text: t.title, title: t.title, onclick: () => TaskCardView.open(t.id) }),
          el('div.tl-track', {}, [
            el('div.tl-today-line', { style: { insetInlineStart: `${pct(today)}%` } }),
            el('div.tl-bar', {
              style: {
                insetInlineStart: `${barStart}%`,
                width: `${width}%`,
                background: t.overdue ? 'var(--danger)' : t.isFinal ? 'var(--ok)' : t.statusColor
              },
              title: `${t.title} — יעד ${UI.formatDate(t.dueDate)}`,
              onclick: () => TaskCardView.open(t.id)
            }, [t.assigneeName ?? ''])
          ])
        ]);
      });

    return el('div.timeline', {}, [
      el('div.tl-grid', {}, [
        el('div.tl-head', {}, [el('div.tl-label', { text: 'משימה' }), el('div.tl-days', {}, ticks)]),
        ...rows
      ])
    ]);
  }

  // ------------------------------------------------------------- דיאלוג משימה

  function openTaskDialog(task = null, opts = {}) {
    const isEdit = !!task;
    const titleInput = el('input', { type: 'text', value: task?.title ?? '', placeholder: 'מה צריך לעשות?' });
    const descInput = el('textarea', { placeholder: 'תיאור מפורט (אופציונלי)' });
    descInput.value = task?.description ?? '';

    const projectSelect = UI.select(
      [{ value: '', label: 'ללא פרויקט' }, ...App.state.projects.map((p) => ({ value: p.id, label: p.name }))],
      task?.projectId ?? opts.projectId ?? ''
    );

    /*
     * חברי המחלקה של הפותח בראש הרשימה, תחת כותרת. בארגון של חמישים אנשים
     * רשימה אלפביתית מציבה את מי שיושב איתי באמצע, וכמעט תמיד אליו אני
     * מקצה — בעיקר כשהשם ארוך והרשימה נגללת. אותו סדר שכבר קיים בתיוג ‎@‎.
     *
     * ‎optgroup‎ ולא סתם סדר: כותרת מסבירה למה הסדר אינו אלפביתי, ובלעדיה
     * זה נראה כמו רשימה מבולגנת.
     */
    const userOption = (u) => ({
      value: `user:${u.id}`,
      // רמת הגישה מצורפת לשם רק כשהצופה רשאי לראות רמות
      label: u.roleLabel ? `${u.name} — ${u.roleLabel}` : u.name
    });
    const myDept = App.state.actor?.departmentId ?? null;
    const near = myDept ? App.state.users.filter((u) => u.departmentId === myDept) : [];
    const far = App.state.users.filter((u) => !near.includes(u));

    const vendorOptions = App.may('assign_task_to_vendor')
      ? App.state.vendors.filter((v) => v.status === 'active')
        .map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק חיצוני)` }))
      : [];

    const assigneeOptions = [
      { value: '', label: 'ללא אחראי' },
      // קבוצות רק כשיש בהן טעם — במחלקה אחת בלבד הכותרות היו רעש
      ...(near.length && far.length
        ? [
            { label: App.state.actor.department || 'המחלקה שלי', options: near.map(userOption) },
            { label: 'שאר הארגון', options: far.map(userOption) }
          ]
        : [...near, ...far].map(userOption)),
      ...(vendorOptions.length
        ? [{ label: 'ספקים חיצוניים', options: vendorOptions }]
        : [])
    ];
    /*
     * במשימה חדשה האחראי הוא מי שפותח אותה. רוב המשימות נפתחות בשביל עצמי,
     * ו"ללא אחראי" כברירת מחדל יצר משימות יתומות שאינן מופיעות אצל אף אחד
     * בדף הבית — כלומר בדיוק המשימות שנשכחות. מי שפותח בשביל אחר משנה שורה
     * אחת; מי שפותח לעצמו אינו צריך לעשות דבר.
     *
     * ספק אינו ברירת מחדל לעצמו: הוא ממילא אינו פותח משימות.
     */
    const meAsAssignee = App.state.actor && !App.isVendor()
      ? `user:${App.state.actor.id}`
      : '';
    const assigneeSelect = UI.select(assigneeOptions,
      task?.assigneeId ? `${task.assigneeType}:${task.assigneeId}` : (isEdit ? '' : meAsAssignee));

    const prioritySelect = UI.select(App.state.priorities.map((p) => ({ value: p.key, label: p.label })), task?.priority ?? 'normal');
    const dueInput = el('input', { type: 'date', value: UI.toInputDate(task?.dueDate) });
    const activateInput = el('input', { type: 'date', value: UI.toInputDate(task?.activateAt) });

    const dependencyOptions = [{ value: '', label: 'ללא תלות' },
      ...currentTasks.filter((t) => !task || t.id !== task.id).map((t) => ({ value: t.id, label: `#${t.id} — ${t.title}` }))];
    const dependsSelect = UI.select(dependencyOptions, task?.dependsOnTaskId ?? '');

    const recurringCheck = el('input', { type: 'checkbox', checked: !!task?.isRecurring });
    const freqSelect = UI.select(
      [{ value: 'daily', label: 'יומי' }, { value: 'weekly', label: 'שבועי' }, { value: 'monthly', label: 'חודשי' }],
      task?.recurrenceFreq ?? 'weekly'
    );
    const policySelect = UI.select([
      { value: 'inherit', label: 'לפי ברירת המחדל של המערכת' },
      { value: 'skip_if_open', label: 'לא ליצור מופע חדש עד לסגירת הקודם' },
      { value: 'always', label: 'ליצור מופע חדש בכל מקרה' }
    ], task?.recurrencePolicy ?? 'inherit');

    const recurringBox = el('div', { style: { display: task?.isRecurring ? 'block' : 'none' } }, [
      el('div.row', {}, [UI.field('תדירות', freqSelect), UI.field('מדיניות חפיפה', policySelect)])
    ]);
    recurringCheck.addEventListener('change', () => {
      recurringBox.style.display = recurringCheck.checked ? 'block' : 'none';
    });

    const checklistInput = el('textarea', { placeholder: 'סעיף בכל שורה (אופציונלי)', style: { minHeight: '62px' } });

    /**
     * תבנית משימה. עד כה אפשר היה לשמור תבניות מסוג 'task' ומעולם לא היה
     * מקום להשתמש בהן. בחירת תבנית ממלאת את הכותרת, התיאור, העדיפות
     * והצ'קליסט — ומכאן אפשר לשנות כל שדה לפני היצירה.
     */
    let taskTemplates = [];
    const taskTemplateSelect = UI.select([{ value: '', label: 'ללא תבנית' }], '');
    const taskTemplateField = UI.field('יצירה מתבנית', taskTemplateSelect,
      'ממלא את הכותרת, התיאור, העדיפות והצ׳קליסט. אפשר לשנות הכול לאחר מכן.');
    taskTemplateField.style.display = 'none';

    if (!isEdit) {
      API.templates().then((data) => {
        taskTemplates = (data.templates ?? []).filter((t) => t.kind === 'task');
        if (!taskTemplates.length) return;
        for (const t of taskTemplates) {
          taskTemplateSelect.appendChild(el('option', { value: String(t.id) }, [t.name]));
        }
        taskTemplateField.style.display = '';
      }).catch(() => { /* תבניות אינן תנאי ליצירת משימה */ });

      taskTemplateSelect.addEventListener('change', () => {
        const tpl = taskTemplates.find((t) => String(t.id) === taskTemplateSelect.value);
        if (!tpl) return;
        const p = tpl.payload ?? {};
        if (p.title) titleInput.value = p.title;
        if (p.description) descInput.value = p.description;
        if (p.priority) prioritySelect.value = p.priority;
        // הסעיפים נכתבים לתיבת הטקסט, כדי שיהיו ניתנים לעריכה לפני השמירה
        checklistInput.value = (p.checklist ?? [])
          .map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
        titleInput.focus();
      });
    }

    const body = el('div', {}, [
      UI.field('כותרת המשימה', titleInput),
      UI.field('תיאור', descInput),
      el('div.row', {}, [
        UI.field('פרויקט', projectSelect, 'משימה ללא פרויקט תופיע בלוח בקבוצת "ללא פרויקט"'),
        UI.field('אחראי', assigneeSelect, 'משימה ללא אחראי לא תופיע ב"המשימות שלי" של אף אחד')
      ]),
      el('div.row', {}, [UI.field('עדיפות', prioritySelect), UI.field('תאריך יעד', dueInput)]),
      el('div.row', {}, [
        UI.field('תלות במשימה אחרת', dependsSelect, 'המשימה לא תיסגר לפני שהמשימה החוסמת תושלם'),
        UI.field('תאריך הפעלה (משימה עתידית)', activateInput, 'עד למועד זה המשימה לא תופיע ברשימות הפעילות')
      ]),
      !isEdit ? taskTemplateField : null,
      !isEdit ? UI.field('צ׳קליסט', checklistInput) : null,
      el('div.field', {}, [
        el('label.checkbox', {}, [recurringCheck, 'משימה חוזרת']),
        recurringBox
      ])
    ]);

    const saveBtn = el('button.btn.btn-primary', {}, [isEdit ? 'שמירת שינויים' : 'יצירת משימה']);
    const m = UI.modal({ title: isEdit ? `עריכת משימה #${task.id}` : 'משימה חדשה', body, footer: [saveBtn, el('div.spacer')] });

    saveBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) return UI.toast('נדרשת כותרת למשימה', 'error');
      const [aType, aId] = assigneeSelect.value ? assigneeSelect.value.split(':') : [null, null];

      const payload = {
        title,
        description: descInput.value,
        projectId: projectSelect.value || null,
        assigneeType: aType,
        assigneeId: aId ? Number(aId) : null,
        priority: prioritySelect.value,
        dueDate: UI.fromInputDate(dueInput.value),
        activateAt: UI.fromInputDate(activateInput.value),
        dependsOnTaskId: dependsSelect.value || null,
        isRecurring: recurringCheck.checked,
        recurrenceFreq: freqSelect.value,
        recurrencePolicy: policySelect.value
      };
      // בלי הרשאה להטיל משימה ארגונית לא שולחים את השדה כלל, כדי שעריכה של
      // משימה ארגונית קיימת לא תוריד אותה בשוגג לרמה המחלקתית
      if (!isEdit) {
        payload.checklist = checklistInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
      }

      saveBtn.disabled = true;
      try {
        let created = null;
        if (isEdit) await API.updateTask(task.id, payload);
        else created = await API.createTask(payload);
        m.close();
        UI.success(isEdit ? 'המשימה עודכנה' : 'המשימה נוצרה');
        await App.reloadReference();
        // הדיאלוג נפתח גם מהסרגל העליון, כשהמסך שמאחוריו אינו הלוח
        await App.refreshView();
        App.refreshNotifications();
        /**
         * משימה חדשה נפתחת מיד. בלי זה היא "נעלמת": משימה בלי אחראי אינה
         * מופיעה בדף הבית, ומשימה בלי פרויקט נופלת לקבוצת "ללא פרויקט"
         * בתחתית הלוח — והיוצר נשאר בלי שום סימן לאן הלכה.
         */
        if (created?.task?.id) TaskCardView.open(created.task.id);
      } catch (err) {
        saveBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  // ------------------------------------------------------------- דיאלוג פרויקט

  function openProjectDialog(project = null) {
    const isEdit = !!project;
    const nameInput = el('input', { type: 'text', value: project?.name ?? '' });
    const descInput = el('textarea');
    descInput.value = project?.description ?? '';
    /*
     * בפרויקט חדש המנהל הוא מי שפותח אותו, כמו האחראי במשימה חדשה. מי שפותח
     * פרויקט בשביל מישהו אחר משנה שורה אחת, ומי שפותח לעצמו אינו נדרש לדבר.
     */
    // אותה קבוצה בראש הרשימה כמו באחראי משימה — ראה ההסבר שם
    const pMyDept = App.state.actor?.departmentId ?? null;
    const pNear = pMyDept ? App.state.users.filter((u) => u.departmentId === pMyDept) : [];
    const pFar = App.state.users.filter((u) => !pNear.includes(u));
    const pOption = (u) => ({ value: u.id, label: u.name });

    const managerSelect = UI.select(
      [
        { value: '', label: 'ללא מנהל' },
        ...(pNear.length && pFar.length
          ? [
              { label: App.state.actor.department || 'המחלקה שלי', options: pNear.map(pOption) },
              { label: 'שאר הארגון', options: pFar.map(pOption) }
            ]
          : [...pNear, ...pFar].map(pOption))
      ],
      project?.managerId ?? (isEdit || App.isVendor() ? '' : App.state.actor?.id ?? '')
    );
    const startInput = el('input', { type: 'date', value: UI.toInputDate(project?.startDate) });
    const dueInput = el('input', { type: 'date', value: UI.toInputDate(project?.dueDate) });
    const statusSelect = UI.select([
      { value: 'active', label: 'פעיל' }, { value: 'frozen', label: 'מוקפא' }, { value: 'done', label: 'הושלם' }
    ], project?.status ?? 'active');

    /**
     * צבע הפרויקט. לכל פרויקט יש כבר צבע — נגזר ממזההו — ולכן הבורר נפתח על
     * הצבע שרואים בפועל, ולא על ריק שהיה מרמז שאין צבע.
     */
    const colorInput = el('input', { type: 'color', value: project?.color ?? '#0f766e' });
    const colorSwatches = el('div.color-swatches', {}, UI.PROJECT_COLORS.map((c) =>
      el('button.color-swatch', {
        type: 'button', title: c, style: { background: c },
        onclick: () => { colorInput.value = c; }
      })
    ));

    /**
     * לוגו וגלריית תמונות. זמינים רק בעריכה ולא ביצירה: התמונות נשמרות מול
     * מזהה הפרויקט, ובזמן היצירה עדיין אין מזהה. אין טעם לצבור קבצים בזיכרון
     * ולשלוח אותם אחר כך — עדיף לומר זאת במשפט אחד.
     */
    const imagesBox = el('div.proj-images');
    let images = [];

    const uploadImage = async (file, kind) => {
      const data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      const r = await API.uploadProjectImage(project.id, {
        kind, filename: file.name, mime: file.type || 'image/png', data
      });
      images = r.images;
      drawImages();
      await App.reloadReference();
      App.refreshChrome();
    };

    const pickFile = (kind, multiple) => {
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple, style: { display: 'none' } });
      input.addEventListener('change', async () => {
        for (const file of [...input.files]) {
          try { await uploadImage(file, kind); UI.success(`"${file.name}" הועלה`); }
          catch (err) { UI.error(err); }
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => input.remove(), 0);
    };

    const removeImage = async (image) => {
      if (!await UI.confirm(`למחוק את "${image.filename}"?`, { danger: true, okText: 'מחיקה' })) return;
      try {
        const r = await API.deleteProjectImage(image.id);
        images = r.images;
        drawImages();
        await App.reloadReference();
        App.refreshChrome();
      } catch (err) { UI.error(err); }
    };

    function drawImages() {
      const logo = images.find((i) => i.kind === 'logo') ?? null;
      const gallery = images.filter((i) => i.kind === 'gallery');
      // אותה רשימה שנפתחת בתצוגה המקדימה, כדי שאפשר לדפדף בין ההדמיות
      const previewable = gallery.map((i) => ({ id: i.id, filename: i.filename, size: i.size, mime: i.mime, url: `/api/project-images/${i.id}/view` }));

      UI.mount(imagesBox,
        el('div.field', {}, [
          el('label', { text: 'לוגו הפרויקט' }),
          el('div.flex', { style: { gap: '10px', alignItems: 'flex-start' } }, [
            logo
              ? el('div.proj-logo-box', {}, [
                  el('img', { src: `/api/project-images/${logo.id}/view`, alt: logo.filename }),
                  el('button.chip-x', { title: 'הסרת הלוגו', onclick: () => removeImage(logo) }, ['✕'])
                ])
              : el('div.proj-logo-box.is-empty', { text: 'ללא לוגו' }),
            el('div', {}, [
              el('button.btn.btn-sm', { onclick: () => pickFile('logo', false) }, [logo ? 'החלפת הלוגו' : '＋ העלאת לוגו']),
              el('div.hint', { style: { marginTop: '4px' }, text: 'מופיע לצד שם הפרויקט בכותרת ובתפריט' })
            ])
          ])
        ]),
        el('div.field', {}, [
          el('label', { text: `תמונות והדמיות${gallery.length ? ` (${gallery.length})` : ''}` }),
          el('div.hint', { text: 'חומר חזותי של הפרויקט — הדמיות, סקיצות, צילומי מצב. לחיצה פותחת בגודל מלא.' }),
          gallery.length
            ? el('div.proj-gallery', {}, gallery.map((img, i) =>
                el('div.proj-thumb', {}, [
                  el('img', {
                    src: `/api/project-images/${img.id}/view`, alt: img.filename, title: img.filename,
                    onclick: () => UI.previewUrls(previewable, i)
                  }),
                  el('button.chip-x', { title: 'מחיקה', onclick: () => removeImage(img) }, ['✕'])
                ])))
            : null,
          el('button.btn.btn-sm', { style: { marginTop: '8px' }, onclick: () => pickFile('gallery', true) }, ['＋ העלאת תמונות'])
        ])
      );
    }

    if (isEdit) {
      drawImages();
      API.projectImages(project.id)
        .then((d) => { images = d.images; drawImages(); })
        .catch(() => { /* כשל בטעינת תמונות אינו מונע עריכת הפרויקט */ });
    } else {
      UI.mount(imagesBox, el('div.hint', {
        text: 'לוגו ותמונות אפשר להוסיף מיד לאחר יצירת הפרויקט, מתוך "עריכת פרויקט".'
      }));
    }

    const templateSelect = UI.select([{ value: '', label: 'ללא תבנית' }], '');
    if (!isEdit) {
      API.templates().then((data) => {
        for (const t of data.templates.filter((x) => x.kind === 'project')) {
          templateSelect.appendChild(el('option', { value: t.id }, [t.name]));
        }
      }).catch(() => {});
    }

    const body = el('div', {}, [
      UI.field('שם הפרויקט', nameInput),
      UI.field('תיאור', descInput),
      el('div.row', {}, [
        // "מנהל הפרויקט" לא היה ברור. זהו מי שאחראי על התקדמות המשימות שבו,
        // והוא גם רואה את הפרויקט ברשימה שלו גם בלי משימה משלו בתוכו.
        UI.field('מנהל המשימות בפרויקט', managerSelect, 'אחראי על התקדמות המשימות בפרויקט'),
        UI.field('סטטוס', statusSelect)
      ]),
      el('div.row', {}, [UI.field('תאריך התחלה', startInput), UI.field('תאריך יעד', dueInput)]),
      UI.field('צבע הפרויקט', el('div.flex', {}, [colorInput, colorSwatches]),
        'הצבע מסמן את שורות המשימות של הפרויקט, לזיהוי במבט'),
      imagesBox,
      !isEdit ? UI.field('יצירה מתבנית', templateSelect, 'התבנית תיצור אוטומטית את משימות הבסיס של הפרויקט') : null
    ]);

    const saveBtn = el('button.btn.btn-primary', {}, [isEdit ? 'שמירה' : 'יצירת פרויקט']);
    const footer = [saveBtn, el('div.spacer')];
    if (isEdit) {
      footer.push(el('button.btn.btn-danger', {
        onclick: async () => {
          if (!await UI.confirm(`למחוק את הפרויקט "${project.name}"? המשימות יישארו במערכת ללא שיוך.`, { danger: true, okText: 'מחיקה' })) return;
          try {
            await API.deleteProject(project.id);
            m.close();
            await App.reloadReference();
            App.navigate('board');
          } catch (err) { UI.error(err); }
        }
      }, ['מחיקה']));
    }

    const m = UI.modal({ title: isEdit ? 'עריכת פרויקט' : 'פרויקט חדש', body, footer });

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return UI.toast('נדרש שם פרויקט', 'error');
      const payload = {
        name,
        description: descInput.value,
        managerId: managerSelect.value || null,
        startDate: UI.fromInputDate(startInput.value),
        dueDate: UI.fromInputDate(dueInput.value),
        status: statusSelect.value,
        color: colorInput.value,
        templateId: templateSelect.value || null
      };
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.updateProject(project.id, payload);
        else await API.createProject(payload);
        m.close();
        UI.success(isEdit ? 'הפרויקט עודכן' : 'הפרויקט נוצר');
        // רשימת הפרויקטים בתפריט הצד משתנה, אך אין סיבה לבנות מחדש את המסך
        await App.reloadReference();
        App.refreshChrome();
        await App.refreshView();
      } catch (err) {
        saveBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  return { render, openTaskDialog, openProjectDialog, reload: load };
})();
