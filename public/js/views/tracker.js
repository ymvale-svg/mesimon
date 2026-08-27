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
    const options = [
      { value: '', label: 'ללא אחראי' },
      ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: u.name }))
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

  function parentRow(task) {
    const sub = task.activeSubtask;
    const isOpen = expanded.has(task.id);
    const more = task.subtasksTotal - (sub ? 1 : 0);

    const toggle = el(`button.tr-toggle${isOpen ? '.open' : ''}`, {
      title: task.subtasksTotal ? 'הצגת כל תתי-המשימות' : 'אין תתי-משימות',
      disabled: !task.subtasksTotal,
      onclick: () => {
        if (isOpen) expanded.delete(task.id); else expanded.add(task.id);
        draw();
      }
    }, ['▸']);

    /*
     * צבע השורה בא מסטטוס הבקרה. נמסר כמשתנה CSS ונצרך ב-CSS על התאים ולא
     * על ה-‎tr‎, מפני שרקע על שורה בטבלה נחתך בחלק מהדפדפנים.
     *
     * ‎style‎ כמחרוזת ולא כאובייקט: ‎el‎ מחיל אובייקט סגנון דרך
     * ‎Object.assign‎, וזה מתעלם בשקט ממשתני CSS. הצבע מאומת כ-hex אף
     * שמקורו ברשימה סגורה בשרת — ערך שנכנס לתוך תכונת ‎style‎ אינו מקום
     * להסתמך על מקור אמין.
     */
    const tinted = /^#[0-9a-f]{6}$/i.test(task.trackStatusColor ?? '');
    const tint = tinted ? { style: `--row-tint: ${task.trackStatusColor}` } : {};

    return el(`tr.tr-parent${isOpen ? '.is-open' : ''}${tinted ? '.is-tinted' : ''}`, tint, [
      // עמודת הפרויקט: נקודת הצבע שלו ושמו, אותו סימון שבשורות המשימות בלוח
      el('td', {}, [
        task.projectId
          ? el('button.txt.tr-project', {
              title: `מעבר ללוח של ${task.projectName}`,
              onclick: () => App.navigate('board', { projectId: task.projectId })
            }, [
              el('span.project-dot', { style: { background: task.projectColor, margin: '0' } }),
              el('span', { text: task.projectName })
            ])
          : el('span.mute-sm', { text: 'ללא פרויקט' })
      ]),
      el('td', {}, [
        el('div.tr-title', {}, [
          toggle,
          statusIcons(task),
          el('button.txt.txt-open', {
            title: 'פתיחת המשימה',
            onclick: () => TaskCardView.open(task.id)
          }, [task.title]),
          more > 0 ? el('span.tr-count', { title: `${task.subtasksTotal} תתי-משימות`, text: `+${more}` }) : null
        ])
      ]),
      el('td', {}, [dueCell(task)]),
      el('td', {}, [trackCell(task)]),
      el('td', {}, [shortStatusCell(task)]),
      el('td', {}, [
        sub
          ? el('button.txt.txt-open', { onclick: () => TaskCardView.open(sub.id) }, [sub.title])
          : el('span.mute-sm', { text: 'אין פעולה פתוחה' })
      ]),
      el('td', {}, [assigneeCell(sub)]),
      el('td', {}, [dueCell(sub, { muted: true })]),
      el('td', {}, [
        App.may('create_task')
          ? el('button.btn.btn-sm', {
              title: 'הוספת תת-משימה',
              // אין צורך ברענון יזום: שמירת משימה קוראת ל-App.refreshView
              onclick: () => BoardView.openTaskDialog(null, {
                projectId: task.projectId, parentTaskId: task.id, parentTitle: task.title
              })
            }, ['＋ תת-משימה'])
          : null
      ])
    ]);
  }

  /**
   * שורת תת-משימה, כשהאב פרוש. מוזחת פנימה ובלי חזרה על שם האב ועל הפרויקט —
   * הם באותה שורה ממש מעליה.
   */
  const subRow = (sub) => el(`tr.tr-sub${sub.isFinal ? '.is-done' : ''}`, {}, [
    el('td', { colspan: '5' }, [
      el('div.tr-subtitle', {}, [
        el('span.tr-branch', { text: '↳' }),
        el('span.dot-chip', { title: sub.statusLabel, style: { background: sub.statusColor } }),
        el('button.txt.txt-open', { onclick: () => TaskCardView.open(sub.id) }, [sub.title]),
        sub.statusShort ? el('span.tr-substatus', { text: sub.statusShort, title: sub.statusShort }) : null
      ])
    ]),
    el('td', { text: sub.statusLabel }),
    el('td', {}, [assigneeCell(sub)]),
    el('td', {}, [dueCell(sub, { muted: true })]),
    el('td', {})
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
      /*
       * הורדה בניווט ולא ב-fetch: כך הדפדפן מטפל בקובץ כהורדה רגילה, עם שם
       * הקובץ שהשרת קבע. בנייה של blob בלקוח הייתה מחייבת לקרוא את הקובץ
       * לזיכרון ולהמציא שם, בלי שום יתרון.
       */
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

  function draw() {
    const body = [];
    for (const task of rows) {
      body.push(parentRow(task));
      if (expanded.has(task.id)) {
        /*
         * הרשימה המלאה נטענת לפי דרישה ולא מראש: בטבלה של חמישים משימות היא
         * הייתה מאות שאילתות שכמעט תמיד אינן נצפות.
         */
        const cached = task.__subs;
        if (cached) body.push(...cached.map(subRow));
        else {
          body.push(el('tr.tr-sub', {}, [el('td', { colspan: '9' }, [UI.spinner()])]));
          API.task(task.id).then((d) => { task.__subs = d.task.subtasks ?? []; draw(); }).catch(() => {});
        }
      }
    }

    UI.mount(containerRef,
      el('div.view-head', {}, [
        el('h2', { text: 'בקרת משימות' }),
        el('p.hint', { text: 'משימה והפעולה הבאה שלה. עריכה נעשית ישירות בטבלה.' })
      ]),
      toolbar(),
      el('div.card', {}, [
        el('div.table-wrap', {}, [
          el('table.data.tracker', {}, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'פרויקט', style: { width: '150px' } }),
              el('th', { text: 'משימה' }),
              el('th', { text: 'תאריך יעד', style: { width: '128px' } }),
              el('th', { text: 'סטטוס', title: 'סטטוס בקרה — נקודת צבע', style: { width: '58px' } }),
              el('th', { text: 'סטטוס מקוצר', style: { width: '16%' } }),
              el('th', { text: 'תת-משימה' }),
              el('th', { text: 'אחראי', style: { width: '150px' } }),
              el('th', { text: 'תאריך יעד', style: { width: '128px' } }),
              el('th', { text: '', style: { width: '120px' } })
            ])]),
            el('tbody', {}, body.length ? body : [
              el('tr', {}, [el('td', { colspan: '9' }, [
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
