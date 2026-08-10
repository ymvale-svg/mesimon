'use strict';
/** דוחות ואנליטיקה — שלב ד׳ ברודמאפ (פרק 10). */

const ReportsView = (() => {
  const { el } = UI;

  async function render(container) {
    UI.mount(container, UI.spinner());
    let data;
    try {
      data = await API.reports();
    } catch (err) {
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: 'דוחות מחלקתיים' }),
          el('div.sub', { text: 'עומס, עיכובים וביצועי ספקים — תמונת מצב בזמן אמת.' })
        ]),
        el('div.spacer'),
        App.may('export_data') ? el('a.btn', { href: '/api/export/tasks.csv' }, ['⬇ ייצוא כל המשימות ל-CSV']) : null
      ]),
      departmentCard(data.departments),
      el('div.grid.grid-2.mt', { style: { alignItems: 'start' } }, [
        workloadCard(data.workload),
        statusCard(data.statusBreakdown)
      ]),
      el('div.mt', {}, [vendorCard(data.vendors)]),
      el('div.mt', {}, [projectCard(data.projects)])
    );
  }

  /** חתך מחלקתי — תמונת החברה לפי מחלקות */
  function departmentCard(rows) {
    if (!rows?.length) return null;
    const maxOpen = Math.max(1, ...rows.map((r) => r.open));

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'חתך מחלקתי' }),
        el('div.spacer'),
        el('span.mute-sm', { text: `${rows.length} מחלקות` })
      ]),
      el('div.card-pad', {}, [
        el('div.grid.grid-3', {}, rows.map((d) =>
          el('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '13px 15px' } }, [
            el('div.flex', {}, [
              el('b', { text: d.name, style: { fontSize: '14px' } }),
              el('div.spacer'),
              el('span.mute-sm', { text: `${d.people} עובדים` })
            ]),
            el('div', { style: { fontSize: '25px', fontWeight: '800', lineHeight: '1.2', marginTop: '4px' }, text: String(d.open) }),
            el('div.mute-sm', { text: 'משימות פתוחות' }),
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
          ])
        ))
      ])
    ]);
  }

  function workloadCard(rows) {
    const max = Math.max(1, ...rows.map((r) => r.open));
    return el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'עומס לפי עובד' })]),
      el('div.card-pad', {}, rows.length ? rows.map((r) =>
        el('div', { style: { marginBottom: '11px' } }, [
          el('div.flex', {}, [
            UI.avatar(r.name, { small: true }),
            el('b', { text: r.name, style: { fontSize: '13px' } }),
            el('span.mute-sm', { text: r.department }),
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
      ) : [UI.empty('אין נתוני עומס', '📊')])
    ]);
  }

  function statusCard(rows) {
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
      el('div.card-head', {}, [el('h3', { text: 'פילוח משימות לפי סטטוס' })]),
      el('div.card-pad', {}, [
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
