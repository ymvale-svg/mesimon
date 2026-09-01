'use strict';
/**
 * מסך בקרה — משימה והפעולה הבאה שלה, שורה אחת לכל משימה.
 *
 * נבנה בשביל משימות מתמשכות: משימה שאינה נגמרת, ובכל רגע יש בה "פעולה
 * הבאה" עם אחראי ותאריך יעד שמתחלפים. הלוח הרגיל אינו מתאים לזה — הוא מציג
 * משימות זו לצד זו בלי לומר מה תלוי במה ומי הכדור אצלו כרגע.
 *
 * שורה אחת לכל משימת-אב, ובה תת-המשימה הפתוחה עם היעד הקרוב. חץ פותח את
 * שאר תתי-המשימות. הבחירה הזו נעשתה במכוון על פני שורה לכל תת-משימה: כאן
 * אפשר לראות את מצב הפרויקט במבט אחד, ובשורה-לכל-תת-משימה שם האב חוזר
 * בעשרות שורות והטבלה הופכת לרשימה ארוכה שאי אפשר לסרוק.
 *
 * עריכה נעשית בתא עצמו. מסך בקרה שדורש לפתוח כרטיס כדי לשנות תאריך הוא
 * מסך שמסתכלים בו ולא עובדים בו.
 */

const TrackerView = (() => {
  const { el } = UI;

  let containerRef = null;
  let rows = [];
  let allOpen = 0;
  let expanded = new Set();

  // הסינונים נשמרים למשתמש, כמו בלוח — ראה server/api.js, PREF_KEYS
  const savedProject = () => App.getPref('trackerProject', '') ?? '';
  const savedScope = () => App.getPref('trackerScope', 'mine') ?? 'mine';

  async function render(container, params = {}) {
    containerRef = container;
    if (params.projectId !== undefined) App.setPref('trackerProject', String(params.projectId ?? ''));
    UI.mount(container, UI.spinner());
    await load();
  }

  /** הפרויקטים שהמשתמש אחראי עליהם — אותו דגל ‎mine‎ שמסנן את תפריט הצד */
  const myProjectIds = () =>
    new Set(App.state.projects.filter((p) => p.mine).map((p) => p.id));

  async function load() {
    const projectId = savedProject();
    try {
      const data = await API.tasks({ scope: 'internal', parent: 'none', projectId: projectId || undefined });

      /*
       * שני סינונים שנעשים כאן ולא בשרת.
       *
       * הושלמו: מסך בקרה עוסק במה שפתוח. משימה שנסגרה אינה דורשת החלטה,
       * והצגתה דוחקת מהמסך את מה שכן. היא נשארת בלוח ובארכיון.
       *
       * "שלי": ברירת המחדל היא הפרויקטים שאני אחראי עליהם, כמו בתפריט הצד —
       * מנהל מערכת רואה את כל הפרויקטים בחברה, וטבלה שמערבבת אותם עם שלו
       * אינה כלי בקרה אלא רשימה. מעבר ל"כל הארגון" זמין ליד הסינון.
       */
      const mine = myProjectIds();
      const scoped = savedScope() === 'mine';
      rows = data.tasks
        .filter((t) => !t.isFinal)
        .filter((t) => !scoped || mine.has(t.projectId));
      // סך הכול לפני הסינון, כדי שהמעבר יוכל לומר כמה מוסתרות
      allOpen = data.tasks.filter((t) => !t.isFinal).length;
      draw();
    } catch (err) {
      UI.mount(containerRef, UI.empty(`לא ניתן לטעון: ${err.message}`, '⚠️'));
    }
  }

  const reload = () => load();

  /** עדכון שדה בודד, בלי לרענן את כל הטבלה — הפוקוס לא ייקח מהמשתמש באמצע */
  async function patch(taskId, body, { redraw = false } = {}) {
    try {
      await API.updateTask(taskId, body);
      if (redraw) await reload();
      return true;
    } catch (err) {
      UI.error(err);
      await reload();      // הערך שנכשל אינו נשאר על המסך כאילו נשמר
      return false;
    }
  }

  // ------------------------------------------------------------- תאים

  /**
   * שדה טקסט שנשמר ביציאה מהתא או ב-Enter, ולא בכל הקשה. שמירה בכל הקשה
   * הייתה שולחת עשרים בקשות על משפט אחד.
   */
  function shortStatusCell(task) {
    const input = el('input.tr-short', {
      type: 'text',
      value: task.statusShort ?? '',
      placeholder: task.canEdit ? 'סטטוס בשורה אחת…' : '',
      readonly: !task.canEdit,
      title: task.statusShort || ''
    });
    input.value = task.statusShort ?? '';
    if (!task.canEdit) return input;

    let last = input.value;
    const save = async () => {
      const next = input.value.trim();
      if (next === last) return;
      last = next;
      if (await patch(task.id, { statusShort: next })) task.statusShort = next;
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = last; input.blur(); }
    });
    return input;
  }

  /**
   * סטטוס הבקרה — נקודת צבע בלבד, בלי טקסט.
   *
   * הטקסט מיותר כאן פעמיים: השורה כולה נצבעת בצבע הסטטוס, ובטבלה של תשע
   * עמודות תווית כמו "הצהרה אפשר במיידי" גוזלת רוחב שנחוץ לשם המשימה. השם
   * זמין בריחוף ובבורר.
   *
   * האפשרויות מגיעות מהפרויקט של המשימה ולא מרשימה גלובלית: פרויקט שלא
   * הוחלה עליו רשימה אינו מציג בורר כלל, וזה מה שהופך את השימוש לרמת
   * פרויקט.
   */
  function trackCell(task) {
    const options = task.trackOptions ?? [];
    if (!options.length) {
      return el('span.tr-nodot', { title: 'לפרויקט לא הוחלה רשימת סטטוסים' });
    }

    const dot = el('button.tr-dot', {
      type: 'button',
      title: task.trackStatusLabel ? `${task.trackStatusLabel} — לחיצה לשינוי` : 'בחירת סטטוס בקרה',
      disabled: !task.canEdit,
      style: task.trackStatusColor ? `background: ${task.trackStatusColor}` : ''
    }, [task.trackStatusColor ? '' : '+']);

    if (!task.canEdit) return dot;

    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      openStatusPicker(dot, task, options);
    });
    return dot;
  }

  /**
   * בורר קטן שנפתח מהנקודה. מוצמד למקום הלחיצה ולא במרכז המסך: בטבלה ארוכה
   * חלון שנפתח במרכז מנתק את הבחירה מהשורה שעליה מדובר.
   */
  function openStatusPicker(anchor, task, options) {
    document.getElementById('track-pop')?.remove();
    const box = anchor.getBoundingClientRect();

    const choose = async (id) => {
      pop.remove();
      await patch(task.id, { trackStatusId: id }, { redraw: true });
    };

    const pop = el('div.track-pop#track-pop', {}, [
      ...options.map((s) => el('button.track-opt', {
        onclick: () => choose(s.id)
      }, [
        el('span.track-swatch', { style: `background: ${s.color}` }),
        el('span', { text: s.label }),
        task.trackStatusId === s.id ? el('span.mute-sm', { text: '✓' }) : null
      ])),
      task.trackStatusId
        ? el('button.track-opt.is-clear', { onclick: () => choose(null) }, [
            el('span.track-swatch.is-empty'),
            el('span', { text: 'ללא סטטוס' })
          ])
        : null
    ]);

    document.body.appendChild(pop);
    // מוצמד מתחת לנקודה, ונדחק פנימה אם הוא חורג מהמסך
    const w = pop.offsetWidth;
    pop.style.top = `${Math.min(box.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
    pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - w - 8))}px`;

    const close = (ev) => {
      if (pop.contains(ev.target) || ev.target === anchor) return;
      pop.remove();
      document.removeEventListener('mousedown', close);
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  function assigneeCell(sub) {
    if (!sub) return el('span.mute-sm', { text: '—' });
    // אותו סדר כמו בכל שאר בוררי האחראי במערכת
    const { near, far, deptName } = UI.usersByDepartment();
    const opt = (u) => ({ value: `user:${u.id}`, label: u.name });
    const options = [
      { value: '', label: 'ללא אחראי' },
      ...(near.length && far.length
        ? [{ label: deptName, options: near.map(opt) }, { label: 'שאר הארגון', options: far.map(opt) }]
        : [...near, ...far].map(opt))
    ];
    const current = sub.assigneeId ? `${sub.assigneeType}:${sub.assigneeId}` : '';
    return UI.select(options, current, {
      class: 'tr-inline',
      onchange: async (e) => {
        const [type, id] = e.target.value ? e.target.value.split(':') : ['user', ''];
        await patch(sub.id, { assigneeType: id ? type : null, assigneeId: id ? Number(id) : null }, { redraw: true });
      }
    });
  }

  function dueCell(task, { muted = false } = {}) {
    if (!task) return el('span.mute-sm', { text: '—' });
    const input = el('input.tr-inline', {
      type: 'date',
      value: UI.toInputDate(task.dueDate),
      // צבע האזהרה מגיע מהשרת ולא מחישוב מקומי, כדי שיהיה זהה לכל המסכים
      class: task.overdue ? 'is-overdue' : (muted ? 'is-muted' : '')
    });
    input.addEventListener('change', async () => {
      await patch(task.id, { dueDate: UI.fromInputDate(input.value) }, { redraw: true });
    });
    return input;
  }

  /** אייקוני הסטטוס והעדיפות, אותם שנמצאים בכל מקום אחר במערכת */
  const statusIcons = (task) => el('span.tr-icons', {}, [
    el('span.dot-chip', { title: task.statusLabel, style: { background: task.statusColor } }),
    task.priority === 'urgent' ? UI.icon('urgent', { size: 13, title: 'דחוף' }) : null,
    task.overdue ? UI.icon('overdue', { size: 13, title: 'באיחור' }) : null,
    task.escalated ? el('span', { title: 'הוקפצה', text: '⚡' }) : null
  ]);

  // ------------------------------------------------------------- שורות

  /**
   * הגדרת העמודות — מקור אחד לכותרת, לרוחב, לתא ולמפתח המיון.
   *
   * טבלה שהעמודות שלה בנויות בקוד קשיח אינה יכולה להסתיר, להזיז או למיין:
   * כל אחת מהיכולות האלה דורשת שהעמודות יהיו נתון ולא קוד.
   *
   * ‎fixed‎ — אינה נבחרת ואינה מוזזת (טור הפעולות נשאר בקצה).
   * ‎always‎ — ניתנת להזזה אך לא להסתרה: טבלה בלי עמודת המשימה אינה טבלה.
   */
  const COLUMNS = [
    { key: 'project', label: 'פרויקט', width: '150px', sort: (t) => t.projectName ?? '' },
    { key: 'title', label: 'משימה', width: null, always: true, sort: (t) => t.title },
    { key: 'due', label: 'תאריך יעד', width: '128px', sort: (t) => t.dueDate ?? '9999-99-99' },
    { key: 'track', label: 'סטטוס', width: '58px', title: 'סטטוס בקרה — נקודת צבע', sort: (t) => t.trackStatusLabel ?? '' },
    { key: 'short', label: 'סטטוס מקוצר', width: '16%', sort: (t) => t.statusShort ?? '' },
    { key: 'subtask', label: 'תת-משימה', width: null, sort: (t) => t.activeSubtask?.title ?? '' },
    { key: 'assignee', label: 'אחראי', width: '150px', sort: (t) => t.activeSubtask?.assigneeName ?? '' },
    { key: 'subDue', label: 'יעד תת-משימה', width: '128px', sort: (t) => t.activeSubtask?.dueDate ?? '9999-99-99' },
    { key: 'actions', label: '', width: '120px', fixed: true }
  ];

  const colByKey = new Map(COLUMNS.map((c) => [c.key, c]));
  const colPref = () => App.getPref('trackerColumns', {}) ?? {};

  /**
   * העמודות בסדר שהמשתמש קבע. מפתח שאינו מוכר מסונן, ועמודה שתתווסף בעתיד
   * נכנסת לסוף — כך העדפה שנשמרה לפני שהעמודה נולדה אינה מסתירה אותה לנצח.
   */
  function orderedColumns() {
    const order = (colPref().order ?? []).filter((k) => colByKey.has(k));
    const rest = COLUMNS.filter((c) => !order.includes(c.key)).map((c) => c.key);
    return [...order, ...rest].map((k) => colByKey.get(k));
  }

  const shownColumns = () => {
    const hidden = new Set(colPref().hidden ?? []);
    return orderedColumns().filter((c) => c.fixed || c.always || !hidden.has(c.key));
  };

  const saveColumns = (patch) => {
    App.setPref('trackerColumns', { ...colPref(), ...patch });
    draw();
  };

  /** תוכן התא לפי מפתח העמודה */
  function cellFor(key, task) {
    const sub = task.activeSubtask;
    switch (key) {
      case 'project':
        return task.projectId
          ? el('button.txt.tr-project', {
              title: `מעבר ללוח של ${task.projectName}`,
              onclick: () => App.navigate('board', { projectId: task.projectId })
            }, [
              el('span.project-dot', { style: { background: task.projectColor, margin: '0' } }),
              el('span', { text: task.projectName })
            ])
          : el('span.mute-sm', { text: 'ללא פרויקט' });
      case 'title': return titleCell(task);
      case 'due': return dueCell(task);
      case 'track': return trackCell(task);
      case 'short': return shortStatusCell(task);
      case 'subtask':
        return sub
          ? el('button.txt.txt-open', { onclick: () => TaskCardView.open(sub.id) }, [sub.title])
          : el('span.mute-sm', { text: 'אין פעולה פתוחה' });
      case 'assignee': return assigneeCell(sub);
      case 'subDue': return dueCell(sub, { muted: true });
      case 'actions':
        return App.may('create_task')
          ? el('button.btn.btn-sm', {
              title: 'הוספת תת-משימה',
              // אין צורך ברענון יזום: שמירת משימה קוראת ל-App.refreshView
              onclick: () => BoardView.openTaskDialog(null, {
                projectId: task.projectId, parentTaskId: task.id, parentTitle: task.title
              })
            }, ['＋ תת-משימה'])
          : null;
      default: return null;
    }
  }

  /**
   * שם המשימה עם פותח העץ.
   *
   * פותח העץ בולט במכוון. קודם היה כאן חץ זעיר וחיוור שאיש לא הבחין בו,
   * ומשימה עם חמש תתי-משימות נראתה כמשימה בודדת. עכשיו זה כפתור עם מסגרת
   * ועם מספר תתי-המשימות בתוכו — המספר הוא מה שאומר שיש בכלל מה לפתוח,
   * ובלעדיו הכפתור נראה דקורטיבי.
   *
   * משימה בלי תתי-משימות אינה מקבלת כפתור מושבת אלא רווח בגודלו: כפתור
   * שאינו עושה דבר מזמין לחיצה, ורווח שומר על יישור הכותרות בטור.
   */
  function titleCell(task) {
    const isOpen = expanded.has(task.id);
    const toggle = task.subtasksTotal
      ? el(`button.tr-expand${isOpen ? '.open' : ''}`, {
          title: isOpen ? 'סגירת תתי-המשימות' : `הצגת ${task.subtasksTotal} תתי-המשימות`,
          onclick: (e) => {
            e.stopPropagation();
            if (isOpen) expanded.delete(task.id); else expanded.add(task.id);
            draw();
          }
        }, [
          el('span.tx-arrow', { text: '▸' }),
          el('span.tx-count', { text: String(task.subtasksTotal) })
        ])
      : el('span.tr-expand-empty');

    return el('div.tr-title', {}, [
      toggle,
      statusIcons(task),
      el('button.txt.txt-open', {
        title: 'פתיחת המשימה',
        onclick: () => TaskCardView.open(task.id)
      }, [task.title])
    ]);
  }

  function parentRow(task) {
    const isOpen = expanded.has(task.id);

    const tinted = /^#[0-9a-f]{6}$/i.test(task.trackStatusColor ?? '');
    const tint = tinted ? { style: `--row-tint: ${task.trackStatusColor}` } : {};

    return el(`tr.tr-parent${isOpen ? '.is-open' : ''}${tinted ? '.is-tinted' : ''}`, tint,
      shownColumns().map((c) => el(`td.td-${c.key}`, {}, [cellFor(c.key, task)])));
  }

  /**
   * שורת תת-משימה, כשהאב פרוש. מוזחת פנימה ובלי חזרה על שם האב ועל הפרויקט —
   * הם באותה שורה ממש מעליה.
   */
  const subRow = (sub) => el(`tr.tr-sub${sub.isFinal ? '.is-done' : ''}`, {}, [
    /*
     * תא אחד לרוחב כל הטבלה, ולא תא לכל עמודה: העמודות ניתנות להסתרה
     * ולהזזה, ותת-משימה אינה נושאת את אותם שדות כמו האב (אין לה פרויקט משלה
     * ואין לה תת-משימה). יישור לעמודות היה דורש מפה שנייה שנשברת בכל שינוי
     * בבחירת העמודות.
     */
    el('td', { colspan: String(shownColumns().length) }, [
      el('div.tr-subtitle', {}, [
        el('span.tr-branch', { text: '↳' }),
        el('span.dot-chip', { title: sub.statusLabel, style: { background: sub.statusColor } }),
        el('button.txt.txt-open', { onclick: () => TaskCardView.open(sub.id) }, [sub.title]),
        sub.statusShort ? el('span.tr-substatus', { text: sub.statusShort, title: sub.statusShort }) : null,
        el('div.spacer'),
        el('span.sub-field', {}, [assigneeCell(sub)]),
        el('span.sub-field', {}, [dueCell(sub, { muted: true })])
      ])
    ])
  ]);

  // ------------------------------------------------------------- ציור

  /**
   * ניהול רשימת הסטטוסים האישית — הוספה, שינוי שם וצבע, מחיקה.
   *
   * אישית ולא ארגונית: כל אחד בונה את שלו, ומחיל אותה על פרויקטים שהוא
   * מנהל. לכן המסך נפתח מכאן ולא ממסך הניהול, שאינו נגיש לעובד.
   *
   * העריכה נשמרת ביציאה מהשדה, כמו בשאר הטבלה. מחיקה מותרת גם כשהסטטוס
   * בשימוש — המשימות חוזרות ללא סטטוס, וכך אין צורך לעבור משימה-משימה כדי
   * לתקן טעות בשם.
   */
  async function openStatusManager() {
    let data;
    try { data = await API.statusList(); } catch (err) { return UI.error(err); }

    const body = el('div');
    const draw = () => {
      const rowsEl = data.statuses.map((s) => {
        const label = el('input', { type: 'text', value: s.label });
        label.value = s.label;
        const color = el('input.sm-color', { type: 'color', value: s.color });

        const save = async (patchBody) => {
          try { data = await API.updateStatus(s.id, patchBody); draw(); }
          catch (err) { UI.error(err); draw(); }
        };
        label.addEventListener('blur', () => {
          if (label.value.trim() && label.value.trim() !== s.label) save({ label: label.value.trim() });
        });
        label.addEventListener('keydown', (e) => { if (e.key === 'Enter') label.blur(); });
        color.addEventListener('change', () => save({ color: color.value }));

        return el('div.sm-row', {}, [
          color,
          label,
          // לחיצה על צבע מהלוח קובעת אותו מיד — מהיר מבורר הצבעים של המערכת
          el('div.sm-palette', {}, (data.palette ?? []).map((c) =>
            el('button.sm-swatch', {
              title: c, style: `background: ${c}`,
              onclick: () => save({ color: c })
            })
          )),
          el('button.btn.btn-sm.btn-ghost.del', {
            title: 'מחיקת הסטטוס',
            onclick: async () => {
              const ok = await UI.confirm(
                `הסטטוס "${s.label}" יימחק. משימות שסומנו בו יחזרו ללא סטטוס.`,
                { title: 'מחיקת סטטוס', danger: true, okText: 'מחיקה' }
              );
              if (!ok) return;
              try {
                const r = await API.deleteStatus(s.id);
                data = r;
                if (r.cleared) UI.toast(`${r.cleared} משימות חזרו ללא סטטוס`);
                draw();
                reload();
              } catch (err) { UI.error(err); }
            }
          }, ['🗑'])
        ]);
      });

      const newLabel = el('input', { type: 'text', placeholder: 'שם הסטטוס' });
      const newColor = el('input.sm-color', { type: 'color', value: data.palette?.[0] ?? '#a9d08e' });
      const add = async () => {
        const label = newLabel.value.trim();
        if (!label) return;
        try { data = await API.addStatus({ label, color: newColor.value }); draw(); }
        catch (err) { UI.error(err); }
      };
      newLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

      UI.mount(body,
        data.statuses.length
          ? el('div.sm-list', {}, rowsEl)
          : el('div.alert.alert-info', {}, [
              el('span', { text: 'ℹ️' }),
              el('div', { text: 'אין לך עוד סטטוסים. אפשר להתחיל מרשימה מוצעת ולערוך אותה, או לבנות משלך.' }),
              el('button.btn.btn-sm.btn-primary', {
                style: { flex: 'none' },
                onclick: async () => {
                  try { data = await API.seedStatuses(); draw(); } catch (err) { UI.error(err); }
                }
              }, ['רשימה מוצעת'])
            ]),
        el('div.sm-row.sm-new', {}, [newColor, newLabel,
          el('button.btn.btn-sm', { onclick: add }, ['＋ הוספה'])]),
        el('div.hint.mt', {
          text: 'הרשימה שלך. כדי שהצבעים יחולו על פרויקט, יש לבחור אותה בשדה "סטטוסי בקרה" בעריכת הפרויקט.'
        })
      );
    };
    draw();

    UI.modal({
      title: 'רשימת סטטוסי הבקרה שלי',
      body,
      footer: [el('div.spacer'), el('button.btn', {
        onclick: () => { document.querySelector('.modal-backdrop')?.remove(); reload(); }
      }, ['סגירה'])]
    });
  }

  function toolbar() {
    const scoped = savedScope() === 'mine';
    const mine = myProjectIds();
    /*
     * רשימת הפרויקטים מצטמצמת לחתך הנבחר: הצעת פרויקט שאינו בחתך הייתה
     * מייצרת טבלה ריקה בלי הסבר.
     */
    const live = App.state.projects.filter((p) => p.status !== 'done' && (!scoped || mine.has(p.id)));
    const projectOptions = [{ value: '', label: 'כל הפרויקטים' },
      ...live.map((p) => ({ value: p.id, label: p.name }))];

    const hidden = allOpen - rows.length;

    return el('div.toolbar', {}, [
      UI.select(projectOptions, savedProject(), {
        onchange: (e) => { App.setPref('trackerProject', e.target.value); load(); }
      }),
      // אותו מעבר שיש בתפריט הצד, ובאותה ברירת מחדל
      el('div.view-switch', {}, [['mine', 'שלי'], ['all', 'כל הארגון']].map(([key, label]) =>
        el(`button${scoped === (key === 'mine') ? '.active' : ''}`, {
          onclick: () => {
            App.setPref('trackerScope', key);
            // פרויקט שנבחר עלול לא להיות בחתך החדש
            App.setPref('trackerProject', '');
            load();
          }
        }, [label])
      )),
      el('div.spacer'),
      App.may('create_task')
        ? el('button.btn.btn-sm.btn-primary', {
            onclick: () => BoardView.openTaskDialog(null, { projectId: savedProject() || undefined })
          }, ['＋ משימה חדשה'])
        : null,
      App.may('create_project')
        ? el('button.btn.btn-sm', { onclick: () => BoardView.openProjectDialog() }, ['＋ פרויקט חדש'])
        : null,
      /*
       * הורדה בניווט ולא ב-fetch: כך הדפדפן מטפל בקובץ כהורדה רגילה, עם שם
       * הקובץ שהשרת קבע. בנייה של blob בלקוח הייתה מחייבת לקרוא את הקובץ
       * לזיכרון ולהמציא שם, בלי שום יתרון.
       */
      el('button.btn.btn-sm', {
        title: 'בחירת עמודות, הסתרה והזזה',
        onclick: (e) => openColumnPicker(e.currentTarget)
      }, ['▦ עמודות']),
      el('button.btn.btn-sm', {
        title: 'ניהול רשימת סטטוסי הבקרה שלי',
        onclick: () => openStatusManager()
      }, ['⬤ סטטוסים']),
      el('button.btn.btn-sm', {
        title: 'הורדת הטבלה כקובץ אקסל, באותו חתך שמוצג',
        onclick: () => {
          const p = new URLSearchParams({ scope: savedScope() });
          if (savedProject()) p.set('projectId', savedProject());
          window.location.assign(`/api/tracker/export?${p}`);
        }
      }, ['⤓ אקסל']),
      el('span.mute-sm', {
        title: 'משימות שהושלמו אינן מוצגות במסך הבקרה',
        text: hidden > 0 && scoped
          ? `${rows.length} משימות · ${hidden} בפרויקטים אחרים`
          : `${rows.length} משימות`
      })
    ]);
  }

  /**
   * בורר העמודות — בחירה, הסתרה, הזזה ואיפוס.
   *
   * חצים ולא גרירה: גרירת כותרות טבלה נראית אלגנטית ונשברת במסך צר ובמגע,
   * וכאן די בשתי לחיצות כדי להזיז עמודה למקומה. הבורר נבנה מחדש אחרי כל
   * שינוי, כדי שהסדר שבו יראה בדיוק את מה שקרה בטבלה.
   */
  function openColumnPicker(anchor) {
    document.getElementById('col-pop')?.remove();
    const hidden = new Set(colPref().hidden ?? []);
    // טור הפעולות אינו נבחר ואינו מוזז — הוא חייב להישאר בקצה
    const list = orderedColumns().filter((c) => !c.fixed);

    const move = (key, delta) => {
      const keys = list.map((c) => c.key);
      const at = keys.indexOf(key);
      if (at + delta < 0 || at + delta >= keys.length) return;
      [keys[at], keys[at + delta]] = [keys[at + delta], keys[at]];
      // ‎actions‎ נשמר בסוף הסדר, אחרת הוא היה נודד לראש בטעינה הבאה
      saveColumns({ order: [...keys, 'actions'] });
      openColumnPicker(anchor);
    };

    const pop = el('div.col-pop#col-pop', {}, [
      el('div.col-head', { text: 'עמודות בטבלה' }),
      ...list.map((c, i) => {
        const box = el('input', {
          type: 'checkbox',
          checked: !hidden.has(c.key),
          disabled: !!c.always
        });
        box.addEventListener('change', () => {
          const next = new Set(hidden);
          if (box.checked) next.delete(c.key); else next.add(c.key);
          saveColumns({ hidden: [...next] });
          openColumnPicker(anchor);
        });
        return el('div.col-row', {}, [
          el('label.checkbox', { title: c.always ? 'עמודה שאינה ניתנת להסתרה' : '' }, [box, c.label]),
          el('div.spacer'),
          el('button.col-move', { title: 'הזזה למעלה', disabled: i === 0, onclick: () => move(c.key, -1) }, ['▲']),
          el('button.col-move', { title: 'הזזה למטה', disabled: i === list.length - 1, onclick: () => move(c.key, 1) }, ['▼'])
        ]);
      }),
      el('button.btn.btn-sm.col-reset', {
        onclick: () => {
          // ‎null‎ מוחק את ההעדפה בשרת ומחזיר את ברירת המחדל, ולא שומר אובייקט ריק
          App.setPref('trackerColumns', null);
          pop.remove();
          draw();
        }
      }, ['איפוס לברירת המחדל'])
    ]);

    document.body.appendChild(pop);
    const box = anchor.getBoundingClientRect();
    pop.style.top = `${Math.min(box.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
    pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - pop.offsetWidth - 8))}px`;

    const close = (ev) => {
      if (pop.contains(ev.target) || ev.target === anchor) return;
      pop.remove();
      document.removeEventListener('mousedown', close);
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  /**
   * מיון בלחיצה על הכותרת. שלושה מצבים: עולה, יורד, וחזרה לסדר ברירת המחדל
   * שהשרת מחזיר (יעד קרוב קודם). מצב שלישי נדרש כדי שאפשר יהיה לבטל מיון
   * בלי לנחש איזו עמודה הייתה המקורית.
   */
  function toggleSort(key) {
    const cur = colPref().sort;
    if (!cur || cur.key !== key) return saveColumns({ sort: { key, dir: 'asc' } });
    if (cur.dir === 'asc') return saveColumns({ sort: { key, dir: 'desc' } });
    return saveColumns({ sort: null });
  }

  /** השורות בסדר התצוגה — מיון המשתמש, או הסדר שהשרת קבע */
  function sortedRows() {
    const s = colPref().sort;
    const col = s && colByKey.get(s.key);
    if (!col?.sort) return rows;
    const dir = s.dir === 'desc' ? -1 : 1;
    // localeCompare בעברית: סדר אלפביתי נכון, ומספרים ותאריכים כמחרוזות ISO
    return [...rows].sort((a, b) =>
      dir * String(col.sort(a) ?? '').localeCompare(String(col.sort(b) ?? ''), 'he', { numeric: true }));
  }

  function headerRow(cols) {
    const s = colPref().sort;
    return el('tr', {}, cols.map((c) => {
      const active = s?.key === c.key;
      const sortable = !!c.sort;
      const th = el(`th.th-${c.key}${sortable ? '.is-sortable' : ''}${active ? '.is-sorted' : ''}`, {
        style: c.width ? { width: c.width } : {},
        title: c.title ?? (sortable ? `מיון לפי ${c.label}` : '')
      }, [
        el('span', { text: c.label }),
        active ? el('span.th-arrow', { text: s.dir === 'desc' ? '▼' : '▲' }) : null
      ]);
      if (sortable) th.addEventListener('click', () => toggleSort(c.key));
      return th;
    }));
  }

  function draw() {
    const cols = shownColumns();
    const body = [];
    for (const task of sortedRows()) {
      body.push(parentRow(task));
      if (expanded.has(task.id)) {
        /*
         * הרשימה המלאה נטענת לפי דרישה ולא מראש: בטבלה של חמישים משימות היא
         * הייתה מאות שאילתות שכמעט תמיד אינן נצפות.
         */
        const cached = task.__subs;
        if (cached) body.push(...cached.map(subRow));
        else {
          body.push(el('tr.tr-sub', {}, [el('td', { colspan: String(cols.length) }, [UI.spinner()])]));
          API.task(task.id).then((d) => { task.__subs = d.task.subtasks ?? []; draw(); }).catch(() => {});
        }
      }
    }

    UI.mount(containerRef,
      el('div.view-head', {}, [
        el('h2', { text: 'בקרת משימות' }),
        el('p.hint', { text: 'משימה והפעולה הבאה שלה. עריכה נעשית ישירות בטבלה, ולחיצה על כותרת ממיינת.' })
      ]),
      toolbar(),
      el('div.card', {}, [
        el('div.table-wrap', {}, [
          el('table.data.tracker', {}, [
            el('thead', {}, [headerRow(cols)]),
            el('tbody', {}, body.length ? body : [
              el('tr', {}, [el('td', { colspan: String(cols.length) }, [
                UI.empty(savedScope() === 'mine' && allOpen > 0
                  ? 'אין משימות פתוחות בפרויקטים שלך — נסה "כל הארגון"'
                  : 'אין משימות פתוחות בחתך הזה', UI.icon('board'))
              ])])
            ])
          ])
        ])
      ])
    );
  }


  return { render };
})();
