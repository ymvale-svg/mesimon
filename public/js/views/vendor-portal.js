'use strict';
/**
 * מסך 4 — פורטל ספקים חיצוניים.
 * הספק רואה אך ורק את המשימות שהוקצו לו, בבורד הייעודי שלו.
 * אין גישה לנתוני צוות פנימי, לפרויקטים אחרים, לספקים אחרים או להערות פנימיות.
 */

const VendorPortalView = (() => {
  const { el } = UI;

  let containerRef = null;
  let tasks = [];
  let mode = 'board';

  async function render(container) {
    containerRef = container;
    await load();
  }

  /**
   * ‎silent‎ — טעינה מחדש ברקע: בלי ספינר ותוך שמירת הגלילה, כדי שעדכון
   * משימה לא ייראה כרענון של כל הדף.
   */
  async function load({ silent = false } = {}) {
    const scrollTop = silent ? containerRef?.scrollTop ?? 0 : 0;
    if (!silent) UI.mount(containerRef, banner(), UI.spinner());
    try {
      const data = await API.tasks({});
      tasks = data.tasks;
      draw();
      if (scrollTop) containerRef.scrollTop = scrollTop;
    } catch (err) {
      // כשל רגעי בטעינת רקע לא ימחק את מה שכבר על המסך
      if (!silent) UI.mount(containerRef, banner(), UI.empty(err.message, '⚠️'));
    }
  }

  function banner() {
    const actor = App.state.actor;
    return el('div.vendor-banner', {}, [
      el('div', { text: '🏢', style: { fontSize: '30px' } }),
      el('div', { style: { flex: '1' } }, [
        el('h2', { text: actor.name }),
        el('p', { text: 'פורטל הספקים — כאן מרוכזות המשימות שהוקצו לך.' })
      ]),
      actor.readOnly ? el('span.tag', { style: { background: '#fff', color: 'var(--accent)' } }, ['צפייה בלבד']) : null
    ]);
  }

  function draw() {
    const open = tasks.filter((t) => !t.isFinal);
    const needsAction = open.filter((t) => ['awaiting_upload', 'needs_fix'].includes(t.status));
    const waiting = open.filter((t) => ['uploaded', 'pending_team_review', 'in_team_review'].includes(t.status));
    const done = tasks.filter((t) => t.isFinal);
    const overdue = open.filter((t) => t.overdue);

    UI.mount(containerRef,
      banner(),
      el('div.grid.grid-4', {}, [
        stat('w-mine', UI.icon('my-tasks'), open.length, 'משימות פתוחות'),
        stat('w-urgent', '✍️', needsAction.length, 'ממתינות לפעולה שלך'),
        stat('w-approve', UI.icon('waiting'), waiting.length, 'ממתינות לבדיקת הצוות'),
        stat('w-over', UI.icon('overdue'), overdue.length, 'באיחור')
      ]),
      el('div.toolbar.mt', {}, [
        el('div.view-switch', {}, [['board', 'לפי שלב'], ['list', 'רשימה']].map(([m, label]) =>
          el(`button${mode === m ? '.active' : ''}`, { onclick: () => { mode = m; draw(); } }, [label]))),
        el('div.spacer'),
        el('span.mute-sm', { text: `סה״כ ${tasks.length} משימות` })
      ]),
      mode === 'board' ? stageBoard(needsAction, waiting, done) : list(tasks)
    );
  }

  /** ‎icon‎ הוא או צומת (מסכת אייקון) או טקסט — שני המצבים מטופלים כאן */
  function stat(cls, icon, num, label) {
    return el(`div.widget.${cls}`, { style: { cursor: 'default' } }, [
      el('div.w-icon', {}, [icon]),
      el('div', {}, [el('div.w-num', { text: String(num) }), el('div.w-label', { text: label })])
    ]);
  }

  function stageBoard(needsAction, waiting, done) {
    const column = (title, color, items, hint) =>
      el('div.kanban-col', {}, [
        el('div.kanban-col-head', {}, [
          el('span.dot', { style: { background: color } }),
          el('h4', { text: title }),
          el('span.num', { text: String(items.length) })
        ]),
        el('div.kanban-col-body', {}, items.length
          ? items.map(card)
          : [el('div.mute-sm', { text: hint, style: { padding: '10px', textAlign: 'center' } })])
      ]);

    return el('div.kanban', {}, [
      column('נדרשת פעולה מצדך', '#dc2626', needsAction, 'אין משימות הממתינות לך כרגע'),
      column('ממתין לבדיקת הצוות', '#0891b2', waiting, 'אין תוצרים בבדיקה'),
      column('הושלם ואושר', '#16a34a', done, 'עדיין אין משימות שאושרו')
    ]);
  }

  function card(task) {
    const due = UI.dueLabel(task.dueDate);
    return el('div.task-card', {
      class: task.overdue ? 'is-overdue' : task.priority === 'urgent' ? 'is-urgent' : '',
      onclick: () => TaskCardView.open(task.id)
    }, [
      el('div.tc-title', { text: task.title }),
      el('div.tc-tags', {}, [UI.statusTag(task), ...UI.taskTags(task)]),
      el('div.tc-foot', {}, [
        task.attachmentsCount ? el('span', { text: `📎 ${task.attachmentsCount}` }) : null,
        task.commentsCount ? el('span', { text: `💬 ${task.commentsCount}` }) : null,
        el('div.spacer'),
        el('span', {
          text: due.text,
          class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
        })
      ])
    ]);
  }

  function list(items) {
    if (!items.length) return UI.empty('לא הוקצו לך משימות', '📦');
    return el('div.table-wrap', {}, [
      el('table.data', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'משימה' }),
            el('th', { text: 'סטטוס' }),
            el('th', { text: 'עדיפות' }),
            el('th', { text: 'תאריך יעד' }),
            el('th', { text: 'קבצים' })
          ])
        ]),
        el('tbody', {}, items.map((t) => {
          const due = UI.dueLabel(t.dueDate);
          return el('tr', { onclick: () => TaskCardView.open(t.id) }, [
            el('td.wrap', {}, [el('b', { text: t.title })]),
            el('td', {}, [UI.statusTag(t)]),
            el('td', {}, [UI.priorityTag(t)]),
            el('td', { class: due.tone === 'danger' ? 'text-danger' : '' , text: t.dueDate ? `${UI.formatDate(t.dueDate)} · ${due.text}` : '—' }),
            el('td', { text: t.attachmentsCount ? `📎 ${t.attachmentsCount}` : '—' })
          ]);
        }))
      ])
    ]);
  }

  return { render, reload: load };
})();
