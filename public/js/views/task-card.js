'use strict';
/**
 * מסך 3 — כרטיס משימה מפורט.
 * נפתח בלחיצה מכל מקום במערכת.
 */

const TaskCardView = (() => {
  const { el } = UI;

  let modalRef = null;
  let task = null;
  let activeTab = 'comments';

  async function open(taskId) {
    activeTab = 'comments';
    try {
      const data = await API.task(taskId);
      task = data.task;
    } catch (err) {
      return UI.error(err);
    }
    if (modalRef) modalRef.close();
    const body = el('div.task-detail');
    modalRef = UI.modal({
      title: null,
      body,
      size: 'xwide',
      onClose: () => { modalRef = null; }
    });
    draw(body);
  }

  async function reload() {
    const data = await API.task(task.id);
    task = data.task;
    const body = modalRef?.box.querySelector('.task-detail');
    if (body) draw(body);
    App.refreshNotifications();
  }

  /**
   * רענון התצוגה שמאחורי המודל. הכול ברקע ובלי ספינר: המשתמש עדיין עומד
   * בתוך כרטיס המשימה, ובנייה מחדש של המסך מאחוריו נראית כרענון של כל האתר.
   */
  function refreshBackground() {
    App.refreshView();
  }

  function draw(container) {
    UI.mount(container, mainPane(), sidePane());
  }

  // ------------------------------------------------------------- פאנל ראשי

  function mainPane() {
    const canEdit = task.permissions.edit;

    /**
     * שם המשימה נערך מכאן בלבד, ובכפתור מפורש. ברשימה לחיצה על השורה פותחת
     * את המשימה, ולכן אין שם עוד עריכה במקום — וכפתור עדיף על "לחיצה על
     * הכותרת" גם כאן, כדי שההתנהגות תהיה אחת בכל המערכת.
     */
    const titleNode = el('h2', { text: task.title, style: { fontSize: '20px' } });
    const editTitleBtn = canEdit
      // "שינוי שם" ולא "עריכה" — בכרטיס יש כבר כפתור "עריכה מלאה" לכל השדות
      ? el('button.btn.btn-sm', { title: 'עריכת שם המשימה' }, ['✎ שינוי שם'])
      : null;
    // הכפתור נעלם בזמן ההקלדה — לחיצה שנייה עליו הייתה מנסה להחליף צומת
    // שכבר הוחלף בתיבת הקלט, ולא הייתה עושה דבר
    editTitleBtn?.addEventListener('click', () => {
      editTitleBtn.style.display = 'none';
      inlineEdit('title', titleNode);
    });
    const titleRow = el('div.flex', { style: { marginBottom: '4px', gap: '8px' } }, [titleNode, editTitleBtn]);

    const alerts = [];

    // אזהרה חזותית אם המשימה תלויה במשימה שטרם הושלמה
    if (task.dependency?.blocking) {
      alerts.push(el('div.alert.alert-warn', {}, [
        el('span', { text: '🔗' }),
        el('div', {}, [
          el('b', { text: 'המשימה חסומה' }),
          el('div', {}, [
            'לא ניתן לסגור אותה לפני שתושלם המשימה ',
            el('a', { onclick: () => open(task.dependency.id) }, [`"${task.dependency.title}"`]),
            '.'
          ])
        ])
      ]));
    }
    if (task.scheduled) {
      alerts.push(el('div.alert.alert-info', {}, [
        el('span', { text: '🗓' }),
        el('div', {}, [
          el('b', { text: 'משימה עתידית מתוזמנת' }),
          el('div', { text: `המשימה תופעל אוטומטית בתאריך ${UI.formatDate(task.activateAt)} ועד אז אינה מופיעה ברשימות הפעילות, בדוחות העומס ובהתראות.` })
        ])
      ]));
    }
    if (task.escalated) {
      alerts.push(el('div.alert.alert-danger', {}, [
        el('span', { text: '↑' }),
        el('div', {}, [el('b', { text: 'המשימה הוקפצה אוטומטית' }), el('div', { text: 'משימה בעדיפות דחוף שסטטוסה לא השתנה בפרק הזמן שהוגדר.' })])
      ]));
    }
    if (task.overdue) {
      alerts.push(el('div.alert.alert-danger', {}, [
        el('span', { text: '⏰' }),
        el('div', {}, [el('b', { text: 'חריגה מתאריך היעד' }), el('div', { text: `תאריך היעד היה ${UI.formatDate(task.dueDate)}.` })])
      ]));
    }

    const descNode = el('p', {
      text: task.description || (canEdit ? 'לחיצה להוספת תיאור…' : 'ללא תיאור'),
      style: { color: task.description ? 'var(--text)' : 'var(--text-mute)', whiteSpace: 'pre-wrap', cursor: canEdit ? 'text' : 'default' }
    });
    if (canEdit) descNode.addEventListener('click', () => inlineEdit('description', descNode, true));

    return el('div.td-main', {}, [
      el('div.flex', { style: { marginBottom: '8px' } }, [
        el('span.mute-sm', { text: `#${task.id}` }),
        task.projectName ? el('span.mute-sm', { text: `· ${task.projectName}` }) : null,
        el(`span.tag.${task.boardType === 'vendor' ? 'tag-vendor' : 'tag-internal'}`, {},
          [task.boardType === 'vendor' ? `בורד ספק — ${task.assigneeName ?? ''}` : 'בורד פנימי']),
        el('div.spacer'),
        el('button.icon-btn', { onclick: () => modalRef.close(), title: 'סגירה' }, ['✕'])
      ]),
      titleRow,
      el('div.flex', { style: { marginBottom: '14px', flexWrap: 'wrap' } }, [UI.statusTag(task), ...UI.taskTags(task)]),
      ...alerts,
      vendorWorkflowBar(),
      descNode,
      checklistSection(),
      el('div.tabs', {}, [
        el(`button${activeTab === 'comments' ? '.active' : ''}`, { onclick: () => { activeTab = 'comments'; draw(modalRef.box.querySelector('.task-detail')); } },
          [`תגובות ועדכונים (${task.comments.length})`]),
        el(`button${activeTab === 'files' ? '.active' : ''}`, { onclick: () => { activeTab = 'files'; draw(modalRef.box.querySelector('.task-detail')); } },
          [`קבצים (${task.attachments.length})`]),
        task.permissions.seeInternal
          ? el(`button${activeTab === 'history' ? '.active' : ''}`, { onclick: () => { activeTab = 'history'; draw(modalRef.box.querySelector('.task-detail')); } },
              ['לוג היסטוריה'])
          : null
      ]),
      activeTab === 'comments' ? commentsSection() : activeTab === 'files' ? filesSection() : historySection()
    ]);
  }

  /** פעולות זרימת העבודה מול הספק */
  function vendorWorkflowBar() {
    if (task.boardType !== 'vendor') return null;
    const actions = [];

    if (App.isVendor()) {
      if (!task.permissions.changeStatus) {
        return el('div.alert.alert-info', {}, [el('span', { text: 'ℹ️' }), el('div', { text: 'לחשבון שלך הוגדרה הרשאת צפייה בלבד.' })]);
      }
      if (['awaiting_upload', 'uploaded', 'needs_fix'].includes(task.status)) {
        actions.push(el('button.btn.btn-primary', { onclick: () => { activeTab = 'files'; draw(modalRef.box.querySelector('.task-detail')); } }, ['📎 העלאת תוצרים']));
        actions.push(el('button.btn', {
          onclick: async () => {
            if (!await UI.confirm('לסמן את המשימה כהושלמה מצדך ולהעביר לבדיקת הצוות?', { okText: 'סימון כהושלם' })) return;
            try {
              await API.updateTask(task.id, { status: 'pending_team_review' });
              UI.success('המשימה הועברה לבדיקת הצוות');
              await reload();
              refreshBackground();
            } catch (err) { UI.error(err); }
          }
        }, ['✓ סיימתי — להעביר לבדיקת הצוות']));
      } else if (task.status === 'pending_team_review' || task.status === 'in_team_review') {
        return el('div.alert.alert-info', {}, [el('span', { text: '⏳' }), el('div', { text: 'התוצר הועבר לבדיקת הצוות. תישלח אליך התראה עם התוצאה.' })]);
      } else if (task.status === 'approved') {
        return el('div.alert.alert-ok', {}, [el('span', { text: '✅' }), el('div', { text: 'התוצר אושר סופית על ידי הצוות. המשימה הושלמה.' })]);
      }
    } else if (task.permissions.approve && task.status !== 'approved') {
      if (['uploaded', 'pending_team_review'].includes(task.status)) {
        actions.push(el('button.btn', {
          onclick: () => decide('start_review', 'העברה לבדיקת הצוות', false)
        }, ['🔍 התחלת בדיקה']));
      }
      actions.push(el('button.btn.btn-primary', { onclick: () => decide('approve', 'אישור סופי של התוצר', false) }, ['✅ אישור סופי']));
      actions.push(el('button.btn.btn-danger', { onclick: () => decide('reject', 'החזרה לספק עם הערות תיקון', true) }, ['↩ נדרש תיקון']));
    }

    if (!actions.length) return null;
    return el('div.alert.alert-info', { style: { flexWrap: 'wrap' } }, [
      el('span', { text: '🤝' }),
      el('div', { style: { flex: '1' } }, [
        el('b', { text: 'זרימת עבודה מול הספק' }),
        el('div.flex', { style: { marginTop: '8px', flexWrap: 'wrap' } }, actions)
      ])
    ]);
  }

  function decide(decision, title, requireNote) {
    const noteInput = el('textarea', { placeholder: requireNote ? 'פרט/י מה נדרש לתקן — ההערות יישלחו לספק' : 'הערה (אופציונלי)' });
    const okBtn = el(`button.btn.${decision === 'reject' ? 'btn-danger' : 'btn-primary'}`, {}, ['אישור']);
    const m = UI.modal({ title, body: UI.field('הערות', noteInput), footer: [okBtn, el('div.spacer')] });

    okBtn.addEventListener('click', async () => {
      const note = noteInput.value.trim();
      if (requireNote && !note) return UI.toast('נדרשות הערות תיקון לספק', 'error');
      okBtn.disabled = true;
      try {
        await API.review(task.id, decision, note);
        m.close();
        UI.success(decision === 'approve' ? 'התוצר אושר סופית' : decision === 'reject' ? 'המשימה הוחזרה לספק עם הערות' : 'המשימה בבדיקת הצוות');
        await reload();
        refreshBackground();
      } catch (err) {
        okBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  // ------------------------------------------------------------- צ'קליסט

  function checklistSection() {
    const pct = task.checklistTotal ? Math.round((task.checklistDone / task.checklistTotal) * 100) : 0;
    const addInput = el('input', { type: 'text', placeholder: 'הוספת סעיף לצ׳קליסט…' });
    addInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !addInput.value.trim()) return;
      try {
        const data = await API.addChecklist(task.id, addInput.value.trim());
        task = data.task;
        draw(modalRef.box.querySelector('.task-detail'));
      } catch (err) { UI.error(err); }
    });

    return el('div', { style: { margin: '16px 0' } }, [
      el('div.flex', {}, [
        el('h4', { text: 'צ׳קליסט', style: { fontSize: '13.5px' } }),
        el('div.spacer'),
        task.checklistTotal ? el('span.mute-sm', { text: `${task.checklistDone}/${task.checklistTotal} · ${pct}%` }) : null
      ]),
      task.checklistTotal ? el('div.progress-bar', {}, [el('div', { style: { width: `${pct}%` } })]) : null,
      ...task.checklist.map((item) =>
        el(`div.checklist-item${item.done ? '.done' : ''}`, {}, [
          el('input', {
            type: 'checkbox',
            checked: item.done,
            disabled: !task.permissions.changeStatus,
            onchange: async (e) => {
              try {
                const data = await API.toggleChecklist(item.id, e.target.checked);
                task = data.task;
                draw(modalRef.box.querySelector('.task-detail'));
              } catch (err) { UI.error(err); }
            }
          }),
          /**
           * שם הסעיף הוא כפתור פתיחה: לסעיף יש מסך משלו, ובו הערה ושרשור
           * תגובות. סעיף אינו תמיד שורה אחת — לפעמים יש בו תהליך שלם.
           */
          el('button.txt.txt-open', {
            title: 'פתיחת הסעיף — הערה ותגובות',
            onclick: () => ChecklistItemView.open(item.id, async () => {
              // חזרה מהסעיף: הכרטיס נטען מחדש כדי שהמונים והסימונים יתעדכנו
              await reload();
              refreshBackground();
            })
          }, [item.text]),
          // סימון שיש תוכן בתוך הסעיף — אחרת אין דרך לדעת שכדאי להיכנס
          item.note ? el('span.item-badge', { title: 'יש הערה בסעיף', text: '📝' }) : null,
          item.commentsCount ? el('span.item-badge', { title: `${item.commentsCount} תגובות`, text: `💬${item.commentsCount}` }) : null,
          el('div.spacer'),
          task.permissions.edit
            ? el('button.btn.btn-sm.btn-ghost.del', {
                onclick: async () => {
                  try {
                    const data = await API.deleteChecklist(item.id);
                    task = data.task;
                    draw(modalRef.box.querySelector('.task-detail'));
                  } catch (err) { UI.error(err); }
                }
              }, ['✕'])
            : null
        ])
      ),
      task.permissions.edit ? el('div', { style: { marginTop: '6px' } }, [addInput]) : null
    ]);
  }

  // ------------------------------------------------------------- תגובות

  /**
   * שרשור התגובות של המשימה. המימוש עצמו ב-‎UI.commentThread‎, כדי שסעיף
   * צ'קליסט — שיש לו שרשור משל עצמו — יקבל בדיוק את אותה התנהגות.
   */
  function commentsSection() {
    return UI.commentThread({
      comments: task.comments,
      canComment: task.permissions.comment,
      seeInternal: task.permissions.seeInternal,
      onSend: async (body, internal, files) => {
        const data = await API.addComment(task.id, body, internal, files);
        task = data.task;
        draw(modalRef.box.querySelector('.task-detail'));
        refreshBackground();
      },
      onDelete: async (comment) => {
        const data = await API.deleteComment(comment.id);
        task = data.task;
        draw(modalRef.box.querySelector('.task-detail'));
        refreshBackground();
        UI.success('ההודעה נמחקה');
      }
    });
  }

  // ------------------------------------------------------------- קבצים

  const filesTab = () => { activeTab = 'files'; draw(modalRef.box.querySelector('.task-detail')); };

  function filesSection() {
    const fileInput = el('input', { type: 'file', style: { display: 'none' }, multiple: true });

    const uploadFiles = async (files) => {
      for (const file of files) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const data = await API.upload(task.id, file.name, file.type, dataUrl);
          task = data.task;
          UI.success(`הקובץ "${file.name}" הועלה`);
        } catch (err) { UI.error(err); }
      }
      draw(modalRef.box.querySelector('.task-detail'));
      refreshBackground();
    };

    fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));

    const dropzone = el('div.dropzone', { onclick: () => fileInput.click() }, [
      el('div', { text: '📎 גרירת קבצים לכאן, או לחיצה לבחירה' }),
      el('div.mute-sm', { text: `עד ${App.state.settings.maxUploadMb}MB · גרסאות קודמות נשמרות ואינן נדרסות` })
    ]);
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('over');
      uploadFiles([...e.dataTransfer.files]);
    });

    // כל הקבצים הניתנים לצפייה, כדי שהחלון יאפשר לדפדף ביניהם ולא רק לראות אחד
    const previewable = task.attachments.filter(UI.canPreview);

    // קיבוץ לפי שם קובץ — הגרסה האחרונה בראש וגרסאות היסטוריות מתחתיה
    const groups = new Map();
    for (const a of task.attachments) {
      if (!groups.has(a.filename)) groups.set(a.filename, []);
      groups.get(a.filename).push(a);
    }

    return el('div', {}, [
      task.permissions.upload ? el('div', { style: { marginBottom: '14px' } }, [dropzone, fileInput]) : null,
      groups.size
        ? el('div', {}, [...groups.entries()].map(([name, versions]) =>
            el('div', { style: { marginBottom: '10px' } }, versions.map((a, i) =>
              el(`div.file-row${i > 0 ? '.old-version' : ''}`, {}, [
                el('div.f-icon', { text: UI.fileIcon(name) }),
                el('div.f-name', {}, [
                  el('b', { text: name }),
                  el('small', { text: `גרסה ${a.version}${i === 0 ? ' (עדכנית)' : ''} · ${UI.fileSize(a.size)} · ${a.uploaderName} · ${UI.formatDateTime(a.createdAt)}` })
                ]),
                // תמונות ו-PDF נפתחים בתוך המערכת; שאר הסוגים בהורדה בלבד
                UI.canPreview(a)
                  ? el('button.btn.btn-sm', { onclick: () => UI.preview(previewable, previewable.indexOf(a)) }, ['👁 תצוגה'])
                  : null,
                el('a.btn.btn-sm', { href: `/api/attachments/${a.id}/download` }, ['⬇ הורדה'])
              ])
            ))))
        : UI.empty('לא הועלו קבצים למשימה זו', '📁')
    ]);
  }

  // ------------------------------------------------------------- לוג היסטוריה

  const ACTION_LABEL = {
    created: 'יצירת המשימה',
    updated: 'עדכון פרטים',
    status_changed: 'שינוי סטטוס',
    comment: 'תגובה',
    attachment: 'קובץ מצורף',
    checklist: 'צ׳קליסט',
    automation: 'אוטומציה'
  };

  function historySection() {
    return el('div', {}, [
      el('div.alert.alert-info', {}, [
        el('span', { text: '🔒' }),
        el('div', { text: 'לוג ההיסטוריה הוא רשומת שינויים לקריאה בלבד — לא ניתן למחוק או לערוך אותו.' })
      ]),
      ...task.history.map((h) =>
        el(`div.history-item${h.actorType === 'system' ? '.system' : ''}`, {}, [
          el('div.h-dot'),
          el('div.h-body', {}, [
            el('div', {}, [el('b', { text: ACTION_LABEL[h.action] ?? h.action }), ' — ', h.details]),
            el('div.h-meta', { text: `${h.actorName} · ${UI.formatDateTime(h.createdAt)}` })
          ])
        ])
      )
    ]);
  }

  // ------------------------------------------------------------- פאנל צד

  function sidePane() {
    const sec = (label, content) => el('div.sec', {}, [el('label', { text: label }), content]);

    const statusControl = task.permissions.changeStatus && !(App.isVendor() && task.boardType === 'vendor')
      ? UI.select(task.columns.map((c) => ({ value: c.key, label: c.label })), task.status, {
          onchange: async (e) => {
            try {
              await API.updateTask(task.id, { status: e.target.value });
              await reload();
              refreshBackground();
            } catch (err) {
              UI.error(err);
              await reload();
            }
          }
        })
      : el('div', {}, [UI.statusTag(task)]);

    const assigneeControl = task.permissions.edit
      ? UI.select([
          { value: '', label: 'ללא אחראי' },
          ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
          ...(App.may('assign_task_to_vendor') ? App.state.vendors.map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק)` })) : [])
        ], task.assigneeId ? `${task.assigneeType}:${task.assigneeId}` : '', {
          onchange: async (e) => {
            const [type, id] = e.target.value ? e.target.value.split(':') : [null, null];
            try {
              await API.updateTask(task.id, { assigneeType: type, assigneeId: id ? Number(id) : null });
              await reload();
              refreshBackground();
            } catch (err) { UI.error(err); }
          }
        })
      : el('div.flex', {}, task.assigneeName
          ? [UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' }), task.assigneeName]
          : ['—']);

    const priorityControl = task.permissions.edit
      ? UI.select(App.state.priorities.map((p) => ({ value: p.key, label: p.label })), task.priority, {
          onchange: async (e) => {
            try {
              await API.updateTask(task.id, { priority: e.target.value });
              await reload();
              refreshBackground();
            } catch (err) { UI.error(err); }
          }
        })
      : el('div', {}, [UI.priorityTag(task)]);

    const dueControl = task.permissions.edit
      ? el('input', {
          type: 'date',
          value: UI.toInputDate(task.dueDate),
          onchange: async (e) => {
            try {
              await API.updateTask(task.id, { dueDate: UI.fromInputDate(e.target.value) });
              await reload();
              refreshBackground();
            } catch (err) { UI.error(err); }
          }
        })
      : el('div', { text: UI.formatDate(task.dueDate) });

    const due = UI.dueLabel(task.dueDate);

    return el('div.td-side', {}, [
      sec('סטטוס', statusControl),
      sec('אחראי', assigneeControl),
      sec('עדיפות', priorityControl),
      sec('תאריך יעד', el('div', {}, [
        dueControl,
        el('div.mute-sm', {
          text: due.text,
          class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : '',
          style: { marginTop: '4px' }
        })
      ])),
      /**
       * הפרויקט נבחר כאן, וכך משימה עוברת מפרויקט לפרויקט — וגם משימה שנפתחה
       * ללא פרויקט מקבלת אחד. עד כה זו הייתה שורת טקסט, והדרך היחידה לשנות
       * הייתה "עריכה מלאה".
       */
      sec('פרויקט', (() => {
        if (!task.permissions.edit) return el('div', { text: task.projectName ?? 'ללא פרויקט' });
        const select = UI.select(
          [{ value: '', label: 'ללא פרויקט' },
            ...App.state.projects.map((p) => ({ value: String(p.id), label: p.name }))],
          String(task.projectId ?? '')
        );
        select.addEventListener('change', async () => {
          try {
            await API.updateTask(task.id, { projectId: select.value || null });
            UI.success(select.value
              ? `המשימה הועברה ל"${App.project(Number(select.value))?.name}"`
              : 'המשימה הוסרה מהפרויקט');
            await reload();
            refreshBackground();
          } catch (err) {
            UI.error(err);
            select.value = String(task.projectId ?? '');
          }
        });
        return select;
      })()),
      sec('מחלקה', el('div', { text: task.departmentName ?? 'ללא שיוך' })),
      task.dependency
        ? sec('תלות במשימה', el('a', { onclick: () => open(task.dependency.id), style: { cursor: 'pointer' } },
            [`#${task.dependency.id} — ${task.dependency.title}`, task.dependency.blocking ? ' ⚠️' : ' ✓']))
        : null,
      task.isRecurring
        ? sec('חזרתיות', el('div', { text: { daily: 'יומי', weekly: 'שבועי', monthly: 'חודשי' }[task.recurrenceFreq] ?? '—' }))
        : null,
      sec('נוצרה', el('div.mute-sm', { text: UI.formatDateTime(task.createdAt) })),
      task.completedAt ? sec('הושלמה', el('div.mute-sm', { text: UI.formatDateTime(task.completedAt) })) : null,

      task.permissions.edit
        ? el('div', { style: { marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '7px' } }, [
            el('button.btn.btn-block', {
              onclick: () => { modalRef.close(); BoardView.openTaskDialog(task); }
            }, ['✎ עריכה מלאה']),

            /**
             * שכפול ושמירה כתבנית — שתי דרכים לחסוך בנייה מחדש של אותה עבודה.
             * שכפול הוא לפעם אחת נוספת באותו פרויקט; תבנית היא לכל פעם מכאן
             * והלאה, גם בפרויקט אחר.
             */
            App.may('create_task')
              ? el('button.btn.btn-block', {
                  onclick: async () => {
                    const name = await UI.prompt('שם המשימה החדשה', {
                      title: 'שכפול משימה',
                      value: `${task.title} — עותק`,
                      okText: 'שכפול'
                    });
                    if (name === null) return;
                    try {
                      const r = await API.duplicateTask(task.id, { title: name });
                      UI.success('המשימה שוכפלה');
                      refreshBackground();
                      // נפתחת מיד, כדי שיהיה ברור מה נוצר ואיפה
                      open(r.task.id);
                    } catch (err) { UI.error(err); }
                  }
                }, ['⧉ שכפול המשימה'])
              : null,

            App.may('create_task')
              ? el('button.btn.btn-block', {
                  onclick: async () => {
                    const name = await UI.prompt('שם התבנית', {
                      title: 'שמירה כתבנית',
                      value: task.title,
                      hint: `נשמרים הכותרת, התיאור, העדיפות והצ׳קליסט (${task.checklist.length} סעיפים) עם ההערות שבו. השיחה והקבצים אינם חלק מהתבנית.`,
                      okText: 'שמירת התבנית'
                    });
                    if (name === null) return;
                    try {
                      const r = await API.saveTaskTemplate(task.id, name);
                      UI.success(r.checklistCount
                        ? `התבנית "${name}" נשמרה, כולל ${r.checklistCount} סעיפי צ׳קליסט`
                        : `התבנית "${name}" נשמרה`);
                    } catch (err) { UI.error(err); }
                  }
                }, ['💾 שמירה כתבנית'])
              : null,
            el('button.btn.btn-block', {
              onclick: async () => {
                try {
                  await API.updateTask(task.id, { archived: !task.archived });
                  UI.success(task.archived ? 'הוחזרה מהארכיון' : 'הועברה לארכיון');
                  await reload();
                  refreshBackground();
                } catch (err) { UI.error(err); }
              }
            }, [task.archived ? '↩ החזרה מארכיון' : '🗄 העברה לארכיון']),
            el('button.btn.btn-danger.btn-block', {
              onclick: async () => {
                if (!await UI.confirm('למחוק את המשימה לצמיתות? לוג ההיסטוריה שלה יימחק יחד איתה.', { danger: true, okText: 'מחיקה' })) return;
                try {
                  await API.deleteTask(task.id);
                  modalRef.close();
                  UI.success('המשימה נמחקה');
                  refreshBackground();
                } catch (err) { UI.error(err); }
              }
            }, ['🗑 מחיקה'])
          ])
        : null
    ]);
  }

  // ------------------------------------------------------------- עריכה מהירה

  function inlineEdit(fieldName, node, multiline = false) {
    const current = fieldName === 'title' ? task.title : task.description;
    const input = multiline ? el('textarea') : el('input', { type: 'text' });
    input.value = current;
    input.style.width = '100%';
    node.replaceWith(input);
    input.focus();

    const commit = async () => {
      const value = input.value.trim();
      if (value === current) return draw(modalRef.box.querySelector('.task-detail'));
      try {
        await API.updateTask(task.id, { [fieldName]: value });
        await reload();
        refreshBackground();
      } catch (err) {
        UI.error(err);
        draw(modalRef.box.querySelector('.task-detail'));
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  return { open };
})();
