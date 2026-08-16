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

    filters = {
      scope: currentScope,
      projectId: params.projectId ?? filtersKeep('projectId', params),
      assignee: params.mine ? `${App.isVendor() ? 'vendor' : 'user'}:${App.state.actor.id}` : (params.assignee ?? ''),
      priority: params.priority ?? '',
      status: params.status ?? '',
      boardId: params.boardId ?? '',
      departmentId: params.departmentId ?? '',
      q: '',
      archived: params.archived ? '1' : '',
      onlyOverdue: !!params.overdue,
      pendingReview: !!params.pendingReview
    };

    await load();
  }

  const filtersKeep = (key, params) => (params.keepFilters ? filters[key] : '');

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
      UI.mount(containerRef, header(), UI.empty(err.message, '⚠️'));
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
    const set = (key, value) => { filters[key] = value; load(); };

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
          onclick: () => { view.mode = mode; draw(); }
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
        onchange: (e) => { filters.onlyOverdue = e.target.checked; load(); }
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
        UI.success(`עודכנו ${res.affected} משימות`);
        if (res.errors.length) UI.toast(`${res.errors.length} משימות לא עודכנו (הרשאות או חוקי זרימה)`, 'error');
        await load();
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
      el('button.btn.btn-sm', { onclick: () => run('archive', filters.archived === '1' ? 0 : 1) },
        [filters.archived === '1' ? '↩ החזרה מארכיון' : '🗄 העברה לארכיון']),
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
      task.projectName ? el('div.tc-project', { text: task.projectName }) : null,
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
            await load();
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

    const assigneeOptions = [
      { value: '', label: 'ללא אחראי' },
      ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: `${u.name} — ${u.roleLabel}` })),
      ...(App.may('assign_task_to_vendor')
        ? App.state.vendors.filter((v) => v.status === 'active').map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק חיצוני)` }))
        : [])
    ];
    const assigneeSelect = UI.select(assigneeOptions,
      task?.assigneeId ? `${task.assigneeType}:${task.assigneeId}` : '');

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

    const body = el('div', {}, [
      UI.field('כותרת המשימה', titleInput),
      UI.field('תיאור', descInput),
      el('div.row', {}, [UI.field('פרויקט', projectSelect), UI.field('אחראי', assigneeSelect)]),
      el('div.row', {}, [UI.field('עדיפות', prioritySelect), UI.field('תאריך יעד', dueInput)]),
      el('div.row', {}, [
        UI.field('תלות במשימה אחרת', dependsSelect, 'המשימה לא תיסגר לפני שהמשימה החוסמת תושלם'),
        UI.field('תאריך הפעלה (משימה עתידית)', activateInput, 'עד למועד זה המשימה לא תופיע ברשימות הפעילות')
      ]),
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
        if (isEdit) await API.updateTask(task.id, payload);
        else await API.createTask(payload);
        m.close();
        UI.success(isEdit ? 'המשימה עודכנה' : 'המשימה נוצרה');
        await App.reloadReference();
        if (containerRef) await load();
        App.refreshNotifications();
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
    const managerSelect = UI.select(
      [{ value: '', label: 'ללא מנהל' }, ...App.state.users.map((u) => ({ value: u.id, label: u.name }))],
      project?.managerId ?? ''
    );
    const startInput = el('input', { type: 'date', value: UI.toInputDate(project?.startDate) });
    const dueInput = el('input', { type: 'date', value: UI.toInputDate(project?.dueDate) });
    const statusSelect = UI.select([
      { value: 'active', label: 'פעיל' }, { value: 'frozen', label: 'מוקפא' }, { value: 'done', label: 'הושלם' }
    ], project?.status ?? 'active');

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
      el('div.row', {}, [UI.field('מנהל הפרויקט', managerSelect), UI.field('סטטוס', statusSelect)]),
      el('div.row', {}, [UI.field('תאריך התחלה', startInput), UI.field('תאריך יעד', dueInput)]),
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
        templateId: templateSelect.value || null
      };
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.updateProject(project.id, payload);
        else await API.createProject(payload);
        m.close();
        UI.success(isEdit ? 'הפרויקט עודכן' : 'הפרויקט נוצר');
        await App.refresh({ reference: true });
      } catch (err) {
        saveBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  return { render, openTaskDialog, openProjectDialog, reload: load };
})();
