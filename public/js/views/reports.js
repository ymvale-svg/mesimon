'use strict';
/** דוחות ואנליטיקה — עומס, עיכובים, חתך מחלקתי וביצועי ספקים. */

const ReportsView = (() => {
  const { el } = UI;

  let containerRef = null;
  let data = null;
  /** בחירת המשתמש במסנן המחלקות: '' = כל הארגון, 'none' = מי שאינו משויך למחלקה */
  let selected = '';

  async function render(container) {
    containerRef = container;
    UI.mount(container, UI.spinner());
    try {
      data = await API.reports();
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    draw();
  }

  /**
   * טווח הראייה של הצופה. רמת ההרשאה היא שמכריעה ולא רשימת תפקידים כאן:
   * הרשאת דוחות מלאה = כל הארגון, והערך 'department' מצמצם למחלקה של המשתמש.
   */
  const orgWide = () => App.can('view_reports');

  /** מזהה מחלקה כמפתח אחיד לסינון. מי שאינו משויך למחלקה מקובץ תחת 'none' */
  const deptKey = (id) => String(id ?? 'none');

  /** המחלקה של המשתמש עצמו. הסשן מחזיר שם מחלקה, ומכאן נגזרת השורה בדוח */
  const ownDepartment = () =>
    data.departments.find((d) => d.name === App.state.actor?.department) ?? null;

  /** המחלקה שהדוח מצטמצם אליה כרגע, או null כשהתמונה ארגונית */
  function activeKey() {
    if (orgWide()) return selected || null;
    const own = ownDepartment();
    // אם לא זוהתה המחלקה, מוטב להציג את מה שהשרת החזיר מלהסתיר נתונים בטעות
    return own ? deptKey(own.id) : null;
  }

  function draw() {
    const key = activeKey();
    const dept = key ? data.departments.find((d) => deptKey(d.id) === key) ?? null : null;
    const workload = key ? data.workload.filter((r) => deptKey(r.departmentId) === key) : data.workload;
    // בתמונה ארגונית מוצגות כל המחלקות; מנהל מחלקה רואה את שלו בלבד
    const departments = orgWide() || !key
      ? data.departments
      : data.departments.filter((d) => deptKey(d.id) === key);

    UI.mount(containerRef,
      pageHead(dept),
      scopeBar(dept, workload),
      departmentCard(departments, key),
      el('div.grid.grid-2.mt', { style: { alignItems: 'start' } }, [
        workloadCard(workload, key),
        statusCard(data.statusBreakdown, dept)
      ]),
      el('div.mt', {}, [vendorCard(data.vendors)]),
      el('div.mt', {}, [projectCard(data.projects)])
    );
  }

  /** הכותרת מצהירה על טווח הנתונים שמוצג בפועל — ארגון שלם, מחלקה אחת, או המחלקה שלי */
  function pageHead(dept) {
    const org = App.state.settings.orgName ?? 'הארגון';
    let title;
    let sub;
    if (!orgWide()) {
      title = `דוחות — ${dept?.name ?? App.state.actor?.department ?? 'המחלקה שלי'}`;
      sub = 'עומס, עיכובים וביצועי ספקים במחלקה שלך — תמונת מצב בזמן אמת.';
    } else if (dept) {
      title = `דוחות — ${dept.name}`;
      sub = `חתך של מחלקה אחת מתוך ${data.departments.length} ב${org}. לניקוי הסינון — "כל המחלקות".`;
    } else {
      title = 'דוחות ארגוניים';
      sub = data.departments.length
        ? `כל ${data.departments.length} המחלקות ב${org} — עומס, עיכובים וביצועי ספקים בזמן אמת.`
        : `תמונת מצב ארגונית ב${org} — עומס, עיכובים וביצועי ספקים בזמן אמת.`;
    }

    return el('div.page-head', {}, [
      el('div', {}, [
        el('h2', { text: title }),
        el('div.sub', { text: sub })
      ]),
      el('div.spacer'),
      App.may('export_data') ? el('a.btn', { href: '/api/export/tasks.csv' }, ['⬇ ייצוא כל המשימות ל-CSV']) : null
    ]);
  }

  /**
   * מסנן המחלקות. מנהל מחלקה אינו בוחר מחלקה — הדוח שלו נעול על המחלקה שלו,
   * ולכן מוצג לו שם המחלקה כתווית ולא רשימת בחירה.
   */
  function scopeBar(dept, workload) {
    const summary = el('span.mute-sm', {
      text: `${workload.length} אנשים בתצוגה · ${workload.reduce((sum, r) => sum + r.open, 0)} משימות פתוחות`
    });

    if (!orgWide()) {
      return el('div.toolbar', {}, [
        el('span.mute-sm', { text: 'חתך:' }),
        el('span.tag.tag-internal', {}, [dept?.name ?? App.state.actor?.department ?? 'המחלקה שלי']),
        el('div.spacer'),
        summary
      ]);
    }

    const options = [{ value: '', label: 'כל המחלקות' },
      ...data.departments.map((d) => ({ value: deptKey(d.id), label: `${d.name} (${d.open})` }))];

    return el('div.toolbar', {}, [
      el('span.mute-sm', { text: 'סינון לפי מחלקה:' }),
      data.departments.length
        ? UI.select(options, selected, { onchange: (e) => { selected = e.target.value; draw(); } })
        : el('span.mute-sm', { text: 'לא הוגדרו מחלקות' }),
      selected ? el('button.btn.btn-sm', { onclick: () => { selected = ''; draw(); } }, ['נקה סינון']) : null,
      el('div.spacer'),
      summary
    ]);
  }

  /** נתון בודד בקלף המחלקה: מספר גדול והסבר מתחתיו */
  function figure(value, label, { secondary = false, hint = null } = {}) {
    return el('div', { title: hint }, [
      el('div', {
        style: { fontSize: secondary ? '18px' : '25px', fontWeight: '800', lineHeight: '1.25' },
        text: String(value ?? 0)
      }),
      el('div.mute-sm', { text: label })
    ]);
  }

  /** חתך מחלקתי — תמונת הארגון לפי מחלקות. לחיצה על מחלקה מצמצמת אליה את הדוח */
  function departmentCard(rows, key) {
    if (!rows?.length) return null;
    const maxOpen = Math.max(1, ...rows.map((r) => r.open));
    const clickable = orgWide();

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'חתך מחלקתי' }),
        el('div.spacer'),
        el('span.mute-sm', { text: rows.length === 1 ? rows[0].name : `${rows.length} מחלקות` })
      ]),
      el('div.card-pad', {}, [
        el('div.grid.grid-3', {}, rows.map((d) => {
          const active = key === deptKey(d.id);
          return el('div', {
            onclick: clickable ? () => { selected = active ? '' : deptKey(d.id); draw(); } : null,
            title: clickable ? (active ? 'לחיצה לביטול הסינון' : `סינון הדוח ל${d.name}`) : null,
            style: {
              border: `1px solid ${active ? 'var(--brand)' : 'var(--border)'}`,
              background: active ? 'var(--brand-light)' : '',
              borderRadius: 'var(--radius-lg)',
              padding: '13px 15px',
              cursor: clickable ? 'pointer' : 'default'
            }
          }, [
            el('div.flex', {}, [
              el('b', { text: d.name, style: { fontSize: '14px' } }),
              el('div.spacer'),
              el('span.mute-sm', { text: `${d.people} עובדים` })
            ]),
            el('div.flex', { style: { gap: '18px', marginTop: '5px', alignItems: 'flex-end' } }, [
              figure(d.open, 'משימות פתוחות'),
              // משימות שהוטלו ברמה הארגונית נספרות למחלקה של האחראי עליהן
              figure(d.orgTasks, 'משימות ארגוניות', {
                secondary: true,
                hint: 'משימות שהוטלו ברמה הארגונית ויושבות על אנשי המחלקה'
              })
            ]),
            el('div.bar-track', { style: { marginTop: '8px' } }, [
              el('div', {
                style: {
                  width: `${(d.open / maxOpen) * 100}%`,
                  background: d.overdue ? 'var(--danger)' : 'var(--brand)'
                }
              })
            ]),
            el('div.flex', { style: { marginTop: '9px', flexWrap: 'wrap' } }, [
              d.overdue ? el('span.tag.tag-overdue', {}, [`${d.overdue} באיחור`]) : null,
              d.urgent ? el('span.tag.tag-urgent', {}, [`${d.urgent} דחוף`]) : null,
              el('span.mute-sm', { text: `${d.done} הושלמו` })
            ])
          ]);
        }))
      ])
    ]);
  }

  function workloadCard(rows, key) {
    const max = Math.max(1, ...rows.map((r) => r.open));
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'עומס לפי עובד' }),
        el('div.spacer'),
        el('span.mute-sm', { text: `${rows.length} אנשים` })
      ]),
      el('div.card-pad', {}, rows.length ? rows.map((r) =>
        el('div', { style: { marginBottom: '11px' } }, [
          el('div.flex', {}, [
            UI.avatar(r.name, { small: true }),
            el('b', { text: r.name, style: { fontSize: '13px' } }),
            // התפקיד לצד השם — כדי לראות במבט אחד אם העומס יושב על מנהל או על עובד
            r.roleLabel ? el('span.tag.tag-internal', {}, [r.roleLabel]) : null,
            // כשהדוח מצומצם למחלקה אחת שם המחלקה חוזר בכל שורה ולכן מיותר
            key ? null : el('span.mute-sm', { text: r.department }),
            el('div.spacer'),
            r.overdue ? el('span.tag.tag-overdue', {}, [`${r.overdue} באיחור`]) : null,
            r.urgent ? el('span.tag.tag-urgent', {}, [`${r.urgent} דחוף`]) : null,
            el('span.mute-sm', { text: `${r.open} פתוחות · ${r.done} הושלמו` })
          ]),
          el('div.bar-track', { style: { marginTop: '5px' } }, [
            el('div', {
              style: {
                width: `${(r.open / max) * 100}%`,
                background: r.overdue ? 'var(--danger)' : r.open > max * 0.7 ? 'var(--warn)' : 'var(--brand)'
              }
            })
          ])
        ])
      ) : [UI.empty('אין נתוני עומס בתצוגה זו', '📊')])
    ]);
  }

  /**
   * פילוח לפי עמודות הבורד. הנתון מגיע כמצרף של כל משימות הארגון וללא חתך מחלקתי,
   * ולכן כשהדוח מצומצם למחלקה מצוין הדבר במפורש — שלא ייקרא בטעות כנתון של המחלקה.
   */
  function statusCard(rows, dept) {
    const internal = rows.filter((r) => r.board_type === 'internal');
    const vendor = rows.filter((r) => r.board_type === 'vendor');
    const group = (title, items) => {
      const total = items.reduce((sum, r) => sum + r.count, 0) || 1;
      return el('div', { style: { marginBottom: '16px' } }, [
        el('h4', { text: title, style: { fontSize: '13px', marginBottom: '8px' } }),
        el('div', { style: { display: 'flex', height: '20px', borderRadius: '6px', overflow: 'hidden', marginBottom: '8px' } },
          items.map((r) => el('div', {
            style: { width: `${(r.count / total) * 100}%`, background: r.color },
            title: `${r.label}: ${r.count}`
          }))),
        el('div.flex', { style: { flexWrap: 'wrap', gap: '10px' } }, items.map((r) =>
          el('div.flex', { style: { gap: '5px' } }, [
            el('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: r.color, display: 'inline-block' } }),
            el('span.mute-sm', { text: `${r.label} (${r.count})` })
          ])))
      ]);
    };

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'פילוח משימות לפי סטטוס' }),
        el('div.spacer'),
        el('span.mute-sm', { text: 'כל הארגון' })
      ]),
      el('div.card-pad', {}, [
        dept
          ? el('div.mute-sm', {
              style: { marginBottom: '11px' },
              text: `הפילוח כולל את כל משימות הארגון ואינו מצומצם ל${dept.name}.`
            })
          : null,
        internal.length ? group('בורד פנימי', internal) : null,
        vendor.length ? group('בורדי ספקים', vendor) : null,
        !internal.length && !vendor.length ? UI.empty('אין נתונים', '📊') : null
      ])
    ]);
  }

  function vendorCard(rows) {
    return el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'ביצועי ספקים' })]),
      el('div.table-wrap', { style: { border: '0' } }, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'ספק' }),
            el('th', { text: 'סה״כ משימות' }),
            el('th', { text: 'פתוחות' }),
            el('th', { text: 'באיחור' }),
            el('th', { text: 'הושלמו' }),
            el('th', { text: 'עמידה בזמנים' }),
            el('th', { text: 'זמן טיפול ממוצע' })
          ])]),
          el('tbody', {}, rows.length ? rows.map((v) =>
            el('tr', { onclick: () => App.navigate('vendorBoards', { boardId: App.state.vendors.find((x) => x.id === v.id)?.boardId }) }, [
              el('td', {}, [el('div.flex', {}, [UI.avatar(v.name, { small: true, vendor: true }), el('b', { text: v.name })])]),
              el('td', { text: String(v.total) }),
              el('td', { text: String(v.open) }),
              el('td', { class: v.overdue ? 'text-danger' : '', text: String(v.overdue) }),
              el('td', { text: String(v.done) }),
              el('td', {}, v.onTimeRate === null ? ['—'] : [
                el('div.flex', {}, [
                  el('div.bar-track', { style: { width: '80px' } }, [
                    el('div', {
                      style: {
                        width: `${v.onTimeRate}%`,
                        background: v.onTimeRate >= 80 ? 'var(--ok)' : v.onTimeRate >= 50 ? 'var(--warn)' : 'var(--danger)'
                      }
                    })
                  ]),
                  el('span', { text: `${v.onTimeRate}%` })
                ])
              ]),
              el('td', { text: v.avgDays === null ? '—' : `${v.avgDays} ימים` })
            ])
          ) : [el('tr', {}, [el('td', { colspan: '7' }, [UI.empty('אין ספקים רשומים', '🤝')])])])
        ])
      ])
    ]);
  }

  function projectCard(rows) {
    return el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'התקדמות פרויקטים' })]),
      el('div.table-wrap', { style: { border: '0' } }, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'פרויקט' }),
            el('th', { text: 'מנהל' }),
            el('th', { text: 'סטטוס' }),
            el('th', { text: 'יעד' }),
            el('th', { text: 'באיחור' }),
            el('th', { text: 'התקדמות' })
          ])]),
          el('tbody', {}, rows.length ? rows.map((p) => {
            const pct = p.tasksTotal ? Math.round((p.tasksDone / p.tasksTotal) * 100) : 0;
            return el('tr', { onclick: () => App.navigate('board', { projectId: p.id }) }, [
              el('td', {}, [el('b', { text: p.name })]),
              el('td', { text: p.managerName ?? '—' }),
              el('td', { text: { active: 'פעיל', frozen: 'מוקפא', done: 'הושלם' }[p.status] }),
              el('td', { text: p.dueDate ? UI.formatDate(p.dueDate) : '—' }),
              el('td', { class: p.overdue ? 'text-danger' : '', text: String(p.overdue) }),
              el('td', {}, [
                el('div.flex', {}, [
                  el('div.bar-track', { style: { width: '110px' } }, [
                    el('div', { style: { width: `${pct}%`, background: pct === 100 ? 'var(--ok)' : 'var(--brand)' } })
                  ]),
                  el('span.mute-sm', { text: `${p.tasksDone}/${p.tasksTotal}` })
                ])
              ])
            ]);
          }) : [el('tr', {}, [el('td', { colspan: '6' }, [UI.empty('אין פרויקטים', '📁')])])])
        ])
      ])
    ]);
  }

  return { render };
})();
