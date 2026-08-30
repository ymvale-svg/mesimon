'use strict';
/**
 * תצוגת הטבלה הראשית — לוח מקובץ בסגנון "בורד" תפעולי.
 *
 * העיקרון: שורה אחת למשימה, קיבוץ מתקפל לפי פרויקט/אחראי/סטטוס, ותאי סטטוס
 * ועדיפות שהם עצמם פקד — לחיצה על התא משנה את הערך במקום, בלי לפתוח כרטיס.
 * לכל קבוצה שורת סיכום ושורת הוספה מהירה.
 *
 * הרשאות: כל תא נערך רק אם השרת סימן את המשימה כניתנת לעריכה (canEdit /
 * canChangeStatus). האכיפה עצמה בצד השרת — כאן זו רק התצוגה.
 */

const GridView = (() => {
  const { el } = UI;

  // מצב שנשמר בין רינדורים כדי שקיפול קבוצות לא יאבד בכל רענון
  const state = {
    collapsed: new Set(),
    groupBy: null
  };

  const GROUP_COLORS = ['#0f766e', '#c2410c', '#2563eb', '#7c3aed', '#be123c', '#0891b2', '#65a30d', '#a16207'];

  const GROUP_OPTIONS = [
    { value: 'project', label: 'פרויקט' },
    { value: 'assignee', label: 'אחראי' },
    { value: 'department', label: 'מחלקה' },
    { value: 'status', label: 'סטטוס' },
    { value: 'priority', label: 'עדיפות' },
    { value: 'board', label: 'בורד' },
    { value: 'none', label: 'ללא קיבוץ' }
  ];

  let ctx = null;

  const columnsOfBoard = (boardId) => App.state.boards.find((b) => b.id === boardId)?.columns ?? [];

  const defaultGroupBy = (scope) => (scope === 'vendors' ? 'board' : 'project');

  /**
   * בטלפון העמודות שאינן הכרחיות אינן נבנות כלל, ולא רק מוסתרות ב-CSS:
   * בפריסת טבלה קבועה רוחבי ה-colgroup מחייבים גם כשהתא מוסתר, ולכן הסתרה
   * לבדה השאירה את הטבלה רחבה מהמסך ואילצה גלילה אופקית. מה שנשאר בטלפון:
   * שם המשימה, נקודת הסטטוס, נקודת העדיפות והיעד.
   */
  const phone = () => (typeof App !== 'undefined' && App.isPhone ? App.isPhone() : false);
  const slim = () => phone();

  // ------------------------------------------------------------- קיבוץ

  function buildGroups(tasks, groupBy) {
    if (groupBy === 'none') {
      return [{ key: 'all', label: 'כל המשימות', tasks, meta: {} }];
    }

    const map = new Map();
    const push = (key, label, meta, task) => {
      if (!map.has(key)) map.set(key, { key, label, meta, tasks: [] });
      map.get(key).tasks.push(task);
    };

    for (const t of tasks) {
      if (groupBy === 'project') {
        push(t.projectId ?? 'none', t.projectName ?? 'ללא פרויקט', { projectId: t.projectId }, t);
      } else if (groupBy === 'assignee') {
        const key = t.assigneeId ? `${t.assigneeType}:${t.assigneeId}` : 'none';
        push(key, t.assigneeName ?? 'ללא אחראי', { assignee: t.assigneeId ? key : null }, t);
      } else if (groupBy === 'department') {
        push(t.departmentId ?? 'none', t.departmentName ?? 'ללא שיוך', { departmentId: t.departmentId }, t);
      } else if (groupBy === 'status') {
        push(`${t.boardId}:${t.status}`, t.statusLabel, { status: t.status, boardId: t.boardId, color: t.statusColor }, t);
      } else if (groupBy === 'priority') {
        push(t.priority, t.priorityLabel, { priority: t.priority }, t);
      } else if (groupBy === 'board') {
        push(t.boardId, t.boardName ?? '—', { boardId: t.boardId }, t);
      }
    }

    const groups = [...map.values()];

    if (groupBy === 'priority') {
      const order = ['urgent', 'high', 'normal', 'low'];
      groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    } else {
      // קבוצת "ללא" תמיד בסוף
      groups.sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : 0));
    }

    groups.forEach((g, i) => {
      g.color = g.meta.color ?? GROUP_COLORS[i % GROUP_COLORS.length];
    });
    return groups;
  }

  // ------------------------------------------------------------- פופאובר

  let openPopoverNode = null;
  let openPopoverCleanup = null;
  let openPopoverAnchor = null;

  /** סגירה יחידה לכל המסלולים — מבטיחה שכל המאזינים מוסרים */
  function closePopover() {
    openPopoverCleanup?.();
    openPopoverCleanup = null;
    openPopoverNode?.remove();
    openPopoverNode = null;
    openPopoverAnchor = null;
  }

  /**
   * מציב את הפופאובר מול התא. הפופאובר הוא position:fixed ואילו הגלילה מתבצעת
   * במיכל ‎.main‎ — לכן הוא נצמד לצד שיש בו מקום, מוגבל לגובה החלון,
   * ונסגר בגלילה או בשינוי גודל כדי שלא יתנתק מהשורה שלו.
   */
  function place(node, anchor) {
    const rect = anchor.getBoundingClientRect();
    const cap = parseFloat(getComputedStyle(node).maxHeight) || Infinity;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openDown = spaceBelow >= Math.min(node.offsetHeight, spaceAbove);

    node.style.maxHeight = `${Math.min(cap, Math.max(80, openDown ? spaceBelow : spaceAbove))}px`;
    const height = node.offsetHeight; // נמדד מחדש אחרי ההגבלה
    const top = openDown ? rect.bottom + 4 : rect.top - height - 4;
    node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    // RTL — יישור לקצה הימני של התא
    node.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    node.style.minWidth = `${Math.max(160, rect.width)}px`;

    // תיקון אחרון לפי המידה שנרנדרה בפועל (עיגול, גבולות, גלילה)
    const painted = node.getBoundingClientRect();
    if (painted.bottom > window.innerHeight - 8 || painted.top < 8) {
      node.style.top = `${Math.max(8, window.innerHeight - 8 - painted.height)}px`;
    }
  }

  function popover(anchor, content) {
    // לחיצה חוזרת על אותו תא סוגרת — התנהגות ה"טוגל" הצפויה
    const sameAnchor = openPopoverAnchor === anchor;
    closePopover();
    if (sameAnchor) return null;

    const node = el('div.cell-popover', {}, [content]);
    document.body.appendChild(node);
    place(node, anchor);
    openPopoverNode = node;
    openPopoverAnchor = anchor;

    const onOutside = (e) => {
      if (!node.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopover();
    };
    // גלילה בתוך הפופאובר עצמו (רשימת אחראים ארוכה) אינה סוגרת אותו
    const onScroll = (e) => { if (!node.contains(e.target)) closePopover(); };
    const onResize = () => closePopover();

    const timer = setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);

    openPopoverCleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
    };
    return node;
  }

  // ------------------------------------------------------------- עדכון משימה

  async function patch(task, payload) {
    closePopover();
    try {
      await API.updateTask(task.id, payload);
      ctx.onTaskUpdated();
    } catch (err) {
      UI.error(err);
      ctx.onTaskUpdated(); // החזרת התצוגה למצב שהשרת מכיר
    }
  }

  // ------------------------------------------------------------- תאים

  /** תא סטטוס — צבוע במלוא רוחב התא, לחיצה פותחת בחירה */
  /**
   * סטטוס ועדיפות כנקודת צבע וטקסט, ולא כתגית צבועה במלוא רוחב התא.
   *
   * התגית הצבועה אכלה 270 פיקסלים משתי עמודות, ובלוח צר זה בא על חשבון שם
   * המשימה — שהוא המידע העיקרי בשורה. נקודה בצבע הסטטוס שומרת על הזיהוי
   * במבט, והטקסט לצדה שומר על השם: אייקון לבדו לא היה עובד כאן, כי לסטטוס
   * שהמשתמש מוסיף בעצמו אין אייקון מוגדר.
   */
  function statusCell(task) {
    const cell = el('td.cell-status', {});
    const chip = el('div.dot-chip', {
      title: task.canChangeStatus ? `${task.statusLabel} — לחיצה לשינוי` : task.statusLabel
    }, [
      el('span.dc-dot', { style: { background: task.statusColor } }),
      el('span.dc-text', { text: task.statusLabel })
    ]);
    if (task.canChangeStatus) {
      chip.classList.add('editable');
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const options = columnsOfBoard(task.boardId);
        popover(chip, el('div.popover-list', {}, options.map((c) =>
          el('button.popover-option', {
            onclick: () => patch(task, { status: c.key })
          }, [
            el('span.swatch', { style: { background: c.color } }),
            c.label,
            c.key === task.status ? el('span.check', { text: '✓' }) : null
          ])
        )));
      });
    }
    cell.appendChild(chip);
    return cell;
  }

  function priorityCell(task) {
    const colors = Object.fromEntries(App.state.priorities.map((p) => [p.key, p.color]));
    const cell = el('td.cell-status', {});
    /**
     * בעדיפות "רגיל" — שהיא ברירת המחדל של רוב המשימות — מוצגת נקודה בלבד.
     * המילה "רגיל" בכל שורה היא רעש שאינו מוסיף דבר; מה שצריך לבלוט הוא
     * החריג, ולכן דחוף וגבוה מקבלים גם טקסט.
     */
    const quiet = task.priority === 'normal' || task.priority === 'low';
    const chip = el(`div.dot-chip${quiet ? '.is-quiet' : ''}`, {
      title: task.canEdit ? `${task.priorityLabel} — לחיצה לשינוי` : task.priorityLabel
    }, [
      el('span.dc-dot', { style: { background: colors[task.priority] ?? '#94a3b8' } }),
      quiet ? null : el('span.dc-text', { text: task.priorityLabel })
    ]);
    if (task.canEdit) {
      chip.classList.add('editable');
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        popover(chip, el('div.popover-list', {}, App.state.priorities.map((p) =>
          el('button.popover-option', {
            onclick: () => patch(task, { priority: p.key })
          }, [
            el('span.swatch', { style: { background: p.color } }),
            p.label,
            p.key === task.priority ? el('span.check', { text: '✓' }) : null
          ])
        )));
      });
    }
    cell.appendChild(chip);
    return cell;
  }

  /**
   * תא הפרויקט הוא גם הדרך להעביר משימה מפרויקט לפרויקט: לחיצה פותחת רשימה,
   * ובה גם "ללא פרויקט". זו הפעולה שהתבקשה, והמקום הטבעי לה הוא התא שמציג
   * את הפרויקט — ולא טופס עריכה מלא.
   */
  function projectCell(task) {
    const cell = el('td.cell-project', {});
    const inner = el('div.proj-box', {}, task.projectName
      ? [el('span.project-dot', { style: { background: task.projectColor } }), el('span.pb-name', { text: task.projectName })]
      : [el('span.mute-sm', { text: 'ללא פרויקט' })]);

    if (task.canEdit) {
      inner.classList.add('editable');
      inner.title = 'לחיצה להעברה לפרויקט אחר';
      inner.addEventListener('click', (e) => {
        e.stopPropagation();
        const options = [{ id: '', name: 'ללא פרויקט', color: null }, ...App.state.projects];
        popover(inner, el('div.popover-list', {}, options.map((p) =>
          el('button.popover-option', {
            onclick: () => patch(task, { projectId: p.id === '' ? null : p.id })
          }, [
            el('span.swatch', { style: { background: p.color ?? '#e2e8f0' } }),
            p.name,
            String(p.id) === String(task.projectId ?? '') ? el('span.check', { text: '✓' }) : null
          ])
        )));
      });
    }
    cell.appendChild(inner);
    return cell;
  }

  function assigneeCell(task) {
    const cell = el('td.cell-assignee', {});
    const inner = el('div.assignee-box', {}, task.assigneeName
      ? [UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' }),
         el('span', { text: task.assigneeName })]
      : [el('span.mute-sm', { text: 'ללא אחראי' })]);

    if (task.canEdit) {
      inner.classList.add('editable');
      inner.addEventListener('click', (e) => {
        e.stopPropagation();
        /*
         * חברי המחלקה שלי בראש הרשימה, תחת כותרת — אותו סדר שקיים בחלון
         * המשימה, בכרטיס ובתיוג ‎@‎. ברשימה של חמישים אנשים מי שיושב איתי
         * נופל בדיוק באמצע, והוא זה שאליו מקצים כמעט תמיד.
         */
        const { near, far, deptName } = UI.usersByDepartment();
        const userOpt = (u) => ({ value: `user:${u.id}`, label: u.name, vendor: false });
        const vendors = App.may('assign_task_to_vendor')
          ? App.state.vendors.filter((v) => v.status === 'active')
            .map((v) => ({ value: `vendor:${v.id}`, label: v.name, vendor: true }))
          : [];

        const current = task.assigneeId ? `${task.assigneeType}:${task.assigneeId}` : '';
        const option = (o) => el('button.popover-option', {
          onclick: () => {
            const [type, id] = o.value ? o.value.split(':') : [null, null];
            patch(task, { assigneeType: type, assigneeId: id ? Number(id) : null });
          }
        }, [
          o.value ? UI.avatar(o.label, { small: true, vendor: o.vendor }) : el('span.swatch', { style: { background: '#e2e8f0' } }),
          o.label,
          o.vendor ? el('span.tag.tag-vendor', {}, ['ספק']) : null,
          o.value === current ? el('span.check', { text: '✓' }) : null
        ]);

        // כותרות רק כשיש שתי קבוצות — במחלקה אחת הן רעש
        const grouped = near.length && far.length;
        popover(inner, el('div.popover-list', {}, [
          option({ value: '', label: 'ללא אחראי', vendor: false }),
          grouped ? el('div.popover-group', { text: deptName }) : null,
          ...near.map((u) => option(userOpt(u))),
          grouped ? el('div.popover-group', { text: 'שאר הארגון' }) : null,
          ...far.map((u) => option(userOpt(u))),
          vendors.length ? el('div.popover-group', { text: 'ספקים חיצוניים' }) : null,
          ...vendors.map(option)
        ]));
      });
    }
    cell.appendChild(inner);
    return cell;
  }

  function dueCell(task) {
    const due = UI.dueLabel(task.dueDate);
    const cell = el('td.cell-due', {});
    const box = el('div.due-box', {
      class: due.tone === 'danger' ? 'is-danger' : due.tone === 'warn' ? 'is-warn' : ''
    }, [
      el('span', { text: task.dueDate ? UI.formatDate(task.dueDate) : '—' }),
      task.dueDate ? el('small', { text: due.text }) : null
    ]);

    if (task.canEdit) {
      box.classList.add('editable');
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'date', value: UI.toInputDate(task.dueDate) });
        const pop = popover(box, el('div', { style: { padding: '8px' } }, [
          input,
          el('div.flex', { style: { marginTop: '8px' } }, [
            el('button.btn.btn-sm.btn-primary', {
              onclick: () => patch(task, { dueDate: UI.fromInputDate(input.value) })
            }, ['שמירה']),
            el('button.btn.btn-sm', { onclick: () => patch(task, { dueDate: null }) }, ['ניקוי'])
          ])
        ]));
        pop?.querySelector('input').focus();
      });
    }
    cell.appendChild(box);
    return cell;
  }

  /**
   * הכותרת היא טקסט בלבד. שינוי שם נעשה מתוך כרטיס המשימה, בכפתור עריכה
   * מפורש: לחיצה על השורה פותחת את המשימה, ועריכה במקום הייתה מתנגשת בכך —
   * אותה לחיצה עצמה לא יכולה גם לפתוח וגם להיכנס למצב הקלדה.
   */
  function titleCell(task) {
    const cell = el('td.cell-title', {});
    cell.appendChild(el('div.title-box', {}, [
      el('span.title-text', { text: task.title }),
      el('div.title-tags', {}, UI.taskTags(task))
    ]));
    return cell;
  }

  /**
   * התקדמות ותגובות בלבד. מונה המהדקים הוסר מכאן — הקבצים עצמם מוצגים
   * בתא הכותרת, ומספר לצד סרגל ההתקדמות לא אמר איזה קובץ הועלה.
   */
  function progressCell(task) {
    if (!task.checklistTotal) {
      return el('td.cell-progress', {}, [
        el('div.flex', { style: { gap: '6px', color: 'var(--text-mute)', fontSize: '12px' } }, [
          task.commentsCount ? el('span', { text: `💬 ${task.commentsCount}` }) : null,
          !task.commentsCount ? el('span', { text: '—' }) : null
        ])
      ]);
    }
    const pct = Math.round((task.checklistDone / task.checklistTotal) * 100);
    return el('td.cell-progress', {}, [
      el('div.flex', { style: { gap: '6px' } }, [
        el('div.bar-track', { style: { width: '58px' } }, [
          el('div', { style: { width: `${pct}%`, background: pct === 100 ? 'var(--ok)' : 'var(--brand)' } })
        ]),
        el('span.mute-sm', { text: `${task.checklistDone}/${task.checklistTotal}` }),
        task.commentsCount ? el('span.mute-sm', { text: `💬${task.commentsCount}` }) : null
      ])
    ]);
  }

  // ------------------------------------------------------------- שורות

  function taskRow(task, group, showBoard) {
    const selected = ctx.selection.has(task.id);
    const row = el('tr.grid-row.is-clickable', {
      class: [selected ? 'selected' : '', task.overdue ? 'is-overdue' : '', task.escalated ? 'is-escalated' : ''].filter(Boolean).join(' '),
      dataset: { taskId: String(task.id) },
      title: 'לחיצה לפתיחת המשימה',
      // התאים הניתנים לעריכה מהירה עוצרים את הבועה בעצמם, ולכן לחיצה עליהם
      // אינה פותחת את הכרטיס — רק לחיצה על שאר השורה
      onclick: () => TaskCardView.open(task.id)
    }, [
      /**
       * הפס הצדדי נושא את צבע הפרויקט, ולא את צבע הקבוצה. הקבוצה כבר מסומנת
       * בכותרת שמעליה, ואילו הצבע הזה הוא מה שמאפשר לזהות במבט לאיזה פרויקט
       * שייכת שורה כשהרשימה מקובצת לפי אחראי או סטטוס ולא לפי פרויקט.
       */
      el('td.cell-bar', { style: { background: task.projectColor ?? group.color } }),
      ctx.selectable
        ? el('td.cell-check', {}, [
            el('input', {
              type: 'checkbox',
              checked: selected,
              onclick: (e) => e.stopPropagation(),
              onchange: (e) => {
                if (e.target.checked) ctx.selection.add(task.id);
                else ctx.selection.delete(task.id);
                ctx.onSelectionChanged();
              }
            })
          ])
        : null,
      titleCell(task),
      showBoard && !slim() ? el('td.cell-board', {}, [
        el(`span.tag.${task.boardType === 'vendor' ? 'tag-vendor' : 'tag-internal'}`, {}, [task.boardName ?? '—'])
      ]) : null,
      state.groupBy !== 'project' && !slim() ? projectCell(task) : null,
      slim() ? null : assigneeCell(task),
      statusCell(task),
      priorityCell(task),
      dueCell(task),
      slim() ? null : progressCell(task)
    ]);
    return row;
  }

  /** שורת סיכום — פילוח סטטוסים, אחוז השלמה וחריגות */
  function summaryRow(group, colspan, showBoard) {
    const total = group.tasks.length;
    const done = group.tasks.filter((t) => t.isFinal).length;
    const overdue = group.tasks.filter((t) => t.overdue).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    const byStatus = new Map();
    for (const t of group.tasks) {
      const key = `${t.statusLabel}|${t.statusColor}`;
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }

    const bar = el('div.summary-bar', {}, [...byStatus.entries()].map(([key, count]) => {
      const [label, color] = key.split('|');
      return el('div', { style: { flex: String(count), background: color }, title: `${label}: ${count}` });
    }));

    const dates = group.tasks.filter((t) => t.dueDate).map((t) => new Date(t.dueDate));
    const lastDue = dates.length ? new Date(Math.max(...dates)) : null;

    return el('tr.grid-summary', {}, [
      el('td.cell-bar', { style: { background: group.color, opacity: '.45' } }),
      el('td', { colspan: String(colspan) }, [
        el('div.summary-inner', {}, [
          el('span.summary-count', { text: total === 1 ? 'משימה אחת' : `${total} משימות` }),
          bar,
          el('span.mute-sm', { text: `${done} הושלמו · ${pct}%` }),
          overdue ? el('span.tag.tag-overdue', {}, [`${overdue} באיחור`]) : null,
          el('div.spacer'),
          lastDue ? el('span.mute-sm', { text: `יעד אחרון: ${UI.formatDate(lastDue.toISOString())}` }) : null
        ])
      ])
    ]);
  }

  /** שורת הוספה מהירה — כותבים ו-Enter, בלי דיאלוג */
  function quickAddRow(group, colspan) {
    const input = el('input.quick-add-input', {
      type: 'text',
      placeholder: '＋ הוספת משימה — כתיבה ו-Enter'
    });

    // Enter מנטרל את השדה, וניטרול שדה ממוקד מפעיל blur — בלי הדגל הזה
    // המשימה הייתה נוצרת פעמיים
    let submitting = false;

    const submit = async () => {
      const title = input.value.trim();
      if (!title || submitting) return;
      submitting = true;
      input.value = '';
      input.disabled = true;
      const payload = { title };

      // הקבוצה קובעת את ערך ההתחלה של השדה שלפיו קיבצנו
      if (state.groupBy === 'project' && group.meta.projectId) payload.projectId = group.meta.projectId;
      if (state.groupBy === 'priority') payload.priority = group.key;
      // בקבוצת "ללא שיוך" אין מחלקה להציע, והשרת ישייך לפי האחראי או היוצר
      if (state.groupBy === 'department' && group.meta.departmentId) payload.departmentId = group.meta.departmentId;
      if (state.groupBy === 'assignee' && group.meta.assignee) {
        const [type, id] = group.meta.assignee.split(':');
        payload.assigneeType = type;
        payload.assigneeId = Number(id);
      }
      if (state.groupBy === 'status' && group.meta.boardId) {
        payload.boardId = group.meta.boardId;
        payload.status = group.meta.status;
      }
      if (state.groupBy === 'board' && group.meta.boardId) {
        const board = App.state.boards.find((b) => b.id === group.meta.boardId);
        if (board?.type === 'vendor') {
          payload.assigneeType = 'vendor';
          payload.assigneeId = board.vendorId;
        }
      }

      try {
        await API.createTask(payload);
        await ctx.onReload({ keepFocus: `quick-${group.key}` });
      } catch (err) {
        input.disabled = false;
        input.value = title;
        submitting = false;
        UI.error(err);
      }
    };

    input.dataset.quickKey = `quick-${group.key}`;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.addEventListener('blur', () => { if (input.value.trim()) submit(); });

    return el('tr.grid-quickadd', {}, [
      el('td.cell-bar', { style: { background: group.color, opacity: '.3' } }),
      el('td', { colspan: String(colspan) }, [input])
    ]);
  }

  // ------------------------------------------------------------- קבוצה

  function groupBlock(group, showBoard) {
    const collapsed = state.collapsed.has(group.key);
    const cols = 4 + (ctx.selectable ? 1 : 0) + (showBoard ? 1 : 0) + (state.groupBy !== 'project' ? 1 : 0) + 2;

    const head = el('div.group-head', { style: { borderColor: group.color } }, [
      el('button.group-toggle', {
        style: { color: group.color },
        title: collapsed ? 'פתיחה' : 'קיפול',
        onclick: () => {
          if (collapsed) state.collapsed.delete(group.key);
          else state.collapsed.add(group.key);
          ctx.onRedraw();
        }
      }, [collapsed ? '▸' : '▾']),
      el('h3.group-title', { style: { color: group.color }, text: group.label }),
      el('span.group-count', { text: `${group.tasks.length}` }),
      el('div.spacer'),
      state.groupBy === 'project' && group.meta.projectId && App.may('create_project')
        ? el('button.btn.btn-sm.btn-ghost', {
            onclick: () => BoardView.openProjectDialog(App.project(group.meta.projectId))
          }, ['✎ פרויקט'])
        : null
    ]);

    if (collapsed) {
      const n = group.tasks.length;
      return el('section.grid-group', {}, [head, el('div.group-collapsed-note', {}, [
        el('span.mute-sm', {
          text: `${n === 1 ? 'משימה אחת מקופלת' : `${n} משימות מקופלות`} · ${group.tasks.filter((t) => t.isFinal).length} הושלמו`
        })
      ])]);
    }

    // בתצוגת-העל של הספקים מותר להוסיף רק כשהקבוצה מזהה בורד ספק ספציפי —
    // אחרת המשימה הייתה נוצרת בשקט בבורד הפנימי ונעלמת מהמסך
    const resolvesVendorBoard = ['board', 'status'].includes(state.groupBy)
      || (state.groupBy === 'assignee' && String(group.meta.assignee ?? '').startsWith('vendor:'));
    const canAdd = App.may('create_task') && !ctx.archived
      && (ctx.scope !== 'vendors' || resolvesVendorBoard);

    return el('section.grid-group', {}, [
      head,
      el('div.grid-table-wrap', {}, [
        el('table.grid-table', {}, [
          // רוחב מפורש לכל עמודה — בלעדיו כל קבוצה היא טבלה נפרדת עם רוחב משלה
          // והעמודות לא מתיישרות בין הקבוצות
          el('colgroup', {}, [
            el('col', { style: { width: '5px' } }),
            ctx.selectable ? el('col', { style: { width: '34px' } }) : null,
            /*
             * בטלפון רוחב הכותרת נקבע באחוזים ולא כ-auto. בפריסה קבועה חלוקת
             * השארית לעמודות ה-auto לא נתנה לכותרת את מה שהתפנה, והיא יצאה
             * צרה מכל השאר — בדיוק ההפוך ממה שנדרש. אחוז הוא חד-משמעי.
             */
            slim() ? el('col', { style: { width: '56%' } }) : el('col'),
            showBoard && !slim() ? el('col', { style: { width: '150px' } }) : null,
            state.groupBy !== 'project' && !slim() ? el('col', { style: { width: '150px' } }) : null,
            slim() ? null : el('col', { style: { width: '180px' } }),
            // סטטוס ועדיפות התכווצו מ-150 ומ-120 — הרוחב שהתפנה עובר לכותרת
            el('col', { style: { width: slim() ? '34px' : '104px' } }),
            el('col', { style: { width: slim() ? '30px' : '74px' } }),
            el('col', { style: { width: slim() ? '76px' : '140px' } }),
            slim() ? null : el('col', { style: { width: '175px' } })
          ]),
          el('thead', {}, [
            el('tr', {}, [
              el('th.cell-bar'),
              ctx.selectable ? el('th.cell-check', {}, [
                el('input', {
                  type: 'checkbox',
                  checked: group.tasks.every((t) => ctx.selection.has(t.id)) && group.tasks.length > 0,
                  onchange: (e) => {
                    for (const t of group.tasks) {
                      if (e.target.checked) ctx.selection.add(t.id);
                      else ctx.selection.delete(t.id);
                    }
                    ctx.onSelectionChanged();
                  }
                })
              ]) : null,
              el('th', { text: 'משימה' }),
              showBoard && !slim() ? el('th.cell-board', { text: 'בורד' }) : null,
              state.groupBy !== 'project' && !slim() ? el('th.cell-project', { text: 'פרויקט' }) : null,
              slim() ? null : el('th.cell-assignee', { text: 'אחראי' }),
              el('th', { text: slim() ? '' : 'סטטוס' }),
              el('th', { text: slim() ? '' : 'עדיפות' }),
              el('th.cell-due', { text: slim() ? 'יעד' : 'תאריך יעד' }),
              slim() ? null : el('th.cell-progress', { text: 'התקדמות' })
            ])
          ]),
          el('tbody', {}, [
            ...group.tasks.map((t) => taskRow(t, group, showBoard)),
            canAdd ? quickAddRow(group, cols) : null,
            summaryRow(group, cols, showBoard)
          ])
        ])
      ])
    ]);
  }

  // ------------------------------------------------------------- API של המודול

  /**
   * @param {object} options
   *   tasks, scope, archived, selectable, selection (Set)
   *   onReload(), onRedraw(), onTaskUpdated(task), onSelectionChanged()
   */
  function render(options) {
    ctx = options;
    closePopover();

    if (!state.groupBy) state.groupBy = defaultGroupBy(ctx.scope);

    const showBoard = ctx.scope === 'vendors' && state.groupBy !== 'board';
    const groups = buildGroups(ctx.tasks, state.groupBy);

    const groupSelector = el('div.group-control', {}, [
      el('span.mute-sm', { text: 'קיבוץ לפי' }),
      UI.select(GROUP_OPTIONS, state.groupBy, {
        onchange: (e) => {
          state.groupBy = e.target.value;
          state.collapsed.clear();
          ctx.onRedraw();
        }
      }),
      el('div.spacer'),
      el('button.btn.btn-sm', {
        onclick: () => {
          if (state.collapsed.size) state.collapsed.clear();
          else groups.forEach((g) => state.collapsed.add(g.key));
          ctx.onRedraw();
        }
      }, [state.collapsed.size ? '⤢ פתיחת הכל' : '⤡ קיפול הכל'])
    ]);

    if (!ctx.tasks.length) {
      return el('div', {}, [groupSelector, UI.empty('אין משימות התואמות את הסינון הנוכחי', '🔍')]);
    }

    return el('div.grid-view', {}, [groupSelector, ...groups.map((g) => groupBlock(g, showBoard))]);
  }

  /** החזרת המיקוד לשורת ההוספה המהירה לאחר יצירת משימה */
  function restoreFocus(key) {
    if (!key) return;
    const input = document.querySelector(`.quick-add-input[data-quick-key="${key}"]`);
    input?.focus();
  }

  const resetGrouping = () => { state.groupBy = null; state.collapsed.clear(); };

  return { render, restoreFocus, resetGrouping, closePopover, state };
})();
