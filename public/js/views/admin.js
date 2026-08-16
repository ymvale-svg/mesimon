'use strict';
/** מסכי ניהול: משתמשים, ספקים, אוטומציות והגדרות, מטריצת הרשאות ותבניות. */

const AdminView = (() => {
  const { el } = UI;

  let tab = 'users';
  let containerRef = null;
  let settingsData = null;

  const TABS = [
    { key: 'users', label: 'משתמשים והרשאות', perm: 'manage_users' },
    { key: 'departments', label: 'מחלקות', perm: 'manage_departments' },
    { key: 'vendors', label: 'ספקים חיצוניים', perm: 'assign_task_to_vendor' },
    { key: 'automations', label: 'אוטומציות וכללים', perm: 'manage_automations' },
    { key: 'settings', label: 'הגדרות מערכת', perm: 'manage_automations' },
    { key: 'matrix', label: 'מטריצת הרשאות', perm: 'manage_users' },
    { key: 'templates', label: 'תבניות', perm: 'create_project' }
  ];

  async function render(container, params = {}) {
    containerRef = container;
    if (params.tab) tab = params.tab;
    // מטריצת ההרשאות פורשת את כל היררכיית הרמות, ולכן היא סגורה בפני מי
    // שאינו רשאי לראות רמות גישה — גם אם הוא מנהל משתמשים במחלקתו
    const allowed = TABS.filter((t) => App.may(t.perm) && (t.key !== 'matrix' || App.state.actor.seesRoles));
    if (!allowed.some((t) => t.key === tab)) tab = allowed[0]?.key;

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: 'ניהול המערכת' }),
          el('div.sub', { text: 'משתמשים, ספקים, כללי אוטומציה והגדרות תפעוליות.' })
        ])
      ]),
      el('div.tabs', {}, allowed.map((t) =>
        el(`button${tab === t.key ? '.active' : ''}`, { onclick: () => { tab = t.key; render(container); } }, [t.label])
      )),
      el('div#admin-body', {}, [UI.spinner()])
    );

    const body = container.querySelector('#admin-body');
    try {
      if (tab === 'users') await usersTab(body);
      else if (tab === 'departments') await departmentsTab(body);
      else if (tab === 'vendors') vendorsTab(body);
      else if (tab === 'automations') await automationsTab(body);
      else if (tab === 'settings') await settingsTab(body);
      else if (tab === 'matrix') await matrixTab(body);
      else if (tab === 'templates') await templatesTab(body);
    } catch (err) {
      UI.mount(body, UI.empty(err.message, '⚠️'));
    }
  }

  const reload = () => render(containerRef);

  // ------------------------------------------------------------- משתמשים

  /** מציג את תוצאת ההזמנה — ואם הדואר לא נשלח, את הקישור להעתקה ידנית */
  function showInviteResult(invite, name) {
    if (!invite) return;
    if (invite.emailSent) return UI.success(`נשלחה הזמנה במייל אל ${name}`);

    const linkBox = el('input', { type: 'text', value: invite.link, readonly: true, style: { direction: 'ltr' } });
    linkBox.value = invite.link;
    UI.modal({
      title: 'ההזמנה נוצרה — הדואר לא נשלח',
      body: el('div', {}, [
        el('div.alert.alert-warn', {}, [
          el('span', { text: '✉️' }),
          el('div', { text: invite.emailError === 'שליחת דואר אינה מוגדרת במערכת'
            ? 'שליחת דואר אינה מוגדרת עדיין. אפשר להעביר את הקישור הזה ידנית.'
            : `שליחת הדואר נכשלה: ${invite.emailError}` })
        ]),
        UI.field(`קישור אישי עבור ${name}`, linkBox, 'הקישור מאפשר לקבוע סיסמה ולהיכנס. תקף 14 יום.'),
        el('button.btn.btn-primary', {
          onclick: () => {
            linkBox.select();
            navigator.clipboard?.writeText(invite.link);
            UI.success('הקישור הועתק');
          }
        }, ['העתקת הקישור'])
      ]),
      footer: [el('button.btn', { onclick: () => document.querySelector('.modal-backdrop')?.remove() }, ['סגירה'])]
    });
  }

  async function usersTab(body) {
    const data = await API.adminUsers();
    const scoped = data.scope === 'department';

    UI.mount(body,
      scoped
        ? el('div.alert.alert-info.mb', {}, [
            el('span', { text: 'ℹ️' }),
            el('div', { text: `כמנהל/ת מחלקה אפשר להוסיף ולנהל עובדים פנימיים במחלקת ${data.department} בלבד. להוספת מנהלים או מחלקות אחרות יש לפנות למנהל המערכת.` })
          ])
        : null,
      el('div.flex.mb', {}, [
        el('div.spacer'),
        el('button.btn.btn-primary', { onclick: () => userDialog(null, data) }, ['＋ משתמש חדש'])
      ]),
      el('div.table-wrap', {}, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'שם' }), el('th', { text: 'אימייל' }),
            data.seesRoles ? el('th', { text: 'רמת גישה' }) : null,
            el('th', { text: 'מחלקה' }), el('th', { text: 'סטטוס' }), el('th', { text: '' })
          ])]),
          el('tbody', {}, data.users.map((u) =>
            el('tr', {}, [
              el('td', {}, [el('div.flex', {}, [UI.avatar(u.name, { small: true }), el('b', { text: u.name })])]),
              el('td', { text: u.email }),
              data.seesRoles ? el('td', {}, [el('span.tag.tag-internal', {}, [u.roleLabel])]) : null,
              // משתמש יכול להיות ללא שיוך למחלקה (הנהלה, מנהל מערכת) — מסומן במקף ולא בתא ריק
              el('td', { text: u.department || '—' }),
              el('td', {}, [el('span', {
                class: u.status === 'active' ? 'text-ok' : 'text-danger',
                text: u.status === 'active' ? '● פעיל' : '○ לא פעיל'
              })]),
              el('td', {}, [
                el('div.flex', {}, [
                  el('button.btn.btn-sm', { onclick: () => userDialog(u, data) }, ['עריכה']),
                  el('button.btn.btn-sm', {
                    title: 'שליחה חוזרת של הזמנה לקביעת סיסמה',
                    onclick: async () => {
                      try {
                        const r = await API.resendInvite('user', u.id);
                        showInviteResult(r.invite, u.name);
                      } catch (err) { UI.error(err); }
                    }
                  }, ['✉ הזמנה'])
                ])
              ])
            ])
          ))
        ])
      ])
    );
  }

  /** בחירת "מחלקה חדשה" בתוך הרשימה הנפתחת — נשלח כ-newDepartmentName ולא כמזהה */
  const NEW_DEPT = '__new__';

  function userDialog(user = null, listData = {}) {
    const isEdit = !!user;
    const scoped = listData.scope === 'department';
    const nameInput = el('input', { type: 'text', value: user?.name ?? '' });
    const emailInput = el('input', { type: 'email', value: user?.email ?? '' });

    // רמות הגישה מגיעות מהשרת כשהן מסוננות לפי מה שהמשתמש המחובר רשאי להעניק —
    // מנהל מחלקה יקבל כך רק 'עובד פנימי', בלי החלטה בקוד הממשק.
    // אם רמת הגישה הנוכחית של הנערך אינה ברשימה (רמה שווה או גבוהה משל המנהל),
    // מוסיפים אותה כדי לא להציג שדה ריק ולא לשנות לו רמה בשוגג.
    const roleOptions = [...(listData.assignableRoles ?? [])];
    if (isEdit && !roleOptions.some((r) => String(r.value) === user.role)) {
      // ללא הרשאה לראות רמות אין תווית להציג — נשמר הערך בלי לחשוף את שמו
      roleOptions.unshift({ value: user.role, label: user.roleLabel ?? 'הרמה הנוכחית' });
    }
    const roleSelect = UI.select(roleOptions, user?.role ?? roleOptions[0]?.value ?? '');

    // המחלקות הן ישויות במערכת — בחירה מרשימה סגורה ולא הקלדה חופשית,
    // כדי שלא ייווצרו מחלקות כפולות בגלל הבדל באיות.
    const deptOptions = [
      { value: '', label: 'ללא שיוך' },
      ...(listData.departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))
    ];
    if (listData.mayManageDepartments) deptOptions.push({ value: NEW_DEPT, label: '＋ הגדרת מחלקה חדשה…' });
    const deptSelect = UI.select(
      deptOptions,
      String(user?.departmentId ?? (scoped ? listData.departmentId : '') ?? ''),
      // מנהל מחלקה מוסיף עובדים למחלקה שלו בלבד, והשרת כופה זאת בכל מקרה
      scoped ? { disabled: true } : {}
    );

    /**
     * הרשאות אישיות — רלוונטיות לעובד פנימי בלבד, ולכן האזור מוצג ומוסתר
     * לפי רמת הגישה שנבחרה ולא לפי מה שהיה בפתיחת החלון.
     */
    const grantChecks = new Map();
    const grantsBox = el('div', { style: { display: 'none' } }, [
      el('div.field', {}, [
        el('label', { text: 'הרשאות נוספות לעובד' }),
        el('div.hint', { text: 'מעל רמת הגישה — למשל מזכירה שצריכה לראות את כל משימות המחלקה ולהקצות משימות לחברי הצוות.' }),
        ...(listData.grantCatalog ?? []).map((g) => {
          const box = el('input', { type: 'checkbox', checked: (user?.grants ?? []).includes(g.key) });
          grantChecks.set(g.key, box);
          return el('label.checkbox', { title: g.hint, style: { marginTop: '6px' } }, [box, g.label]);
        })
      ])
    ]);

    const syncGrantsVisibility = () => {
      grantsBox.style.display = roleSelect.value === 'employee' && grantChecks.size ? 'block' : 'none';
    };
    roleSelect.addEventListener('change', syncGrantsVisibility);
    syncGrantsVisibility();

    const newDeptInput = el('input', { type: 'text', placeholder: 'שם המחלקה החדשה' });
    const newDeptField = UI.field('שם המחלקה החדשה', newDeptInput, 'המחלקה תיווצר עם שמירת המשתמש');

    // מנהל מחלקה חייב שיוך — עדיף להסביר מראש מאשר להפתיע בשגיאה בשמירה
    const managerNote = el('div.alert.alert-warn', {}, [
      el('span', { text: '👤' }),
      el('div', { text: 'מנהל מחלקה חייב להיות משויך למחלקה. יש לבחור מחלקה קיימת, או להגדיר מחלקה חדשה שהוא ינהל.' })
    ]);

    function syncDeptFields() {
      const wantsNew = deptSelect.value === NEW_DEPT;
      newDeptField.style.display = wantsNew ? '' : 'none';
      if (!wantsNew) newDeptInput.value = '';
      managerNote.style.display = roleSelect.value === 'manager' ? '' : 'none';
    }
    roleSelect.addEventListener('change', syncDeptFields);
    deptSelect.addEventListener('change', syncDeptFields);
    syncDeptFields();

    const statusSelect = UI.select([{ value: 'active', label: 'פעיל' }, { value: 'inactive', label: 'לא פעיל' }], user?.status ?? 'active');
    const passInput = el('input', { type: 'text', placeholder: isEdit ? 'השאר ריק כדי לא לשנות' : 'ריק = תישלח הזמנה' });

    const saveBtn = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: isEdit ? `עריכת משתמש — ${user.name}` : 'משתמש חדש',
      body: el('div', {}, [
        UI.field('שם מלא', nameInput),
        UI.field('אימייל', emailInput, 'משמש גם לכניסה למערכת'),
        el('div.row', {}, [UI.field('רמת גישה', roleSelect), UI.field('סטטוס', statusSelect)]),
        el('div.row', {}, [
          UI.field('מחלקה', deptSelect, scoped ? 'נקבע לפי המחלקה שלך' : 'ברירת המחדל היא ללא שיוך למחלקה'),
          UI.field('סיסמה', passInput, isEdit ? null : 'מומלץ להשאיר ריק — תישלח הזמנה לקביעת סיסמה')
        ]),
        newDeptField,
        grantsBox,
        managerNote,
        !isEdit
          ? el('div.alert.alert-info', {}, [
              el('span', { text: '✉️' }),
              el('div', { text: 'עם השמירה תישלח הזמנה במייל ובה הלוגו של המערכת, שמך ושם הארגון. המוזמן קובע לעצמו סיסמה.' })
            ])
          : null
      ]),
      footer: [saveBtn, el('div.spacer')]
    });

    saveBtn.addEventListener('click', async () => {
      const wantsNewDept = deptSelect.value === NEW_DEPT;
      const payload = {
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        role: roleSelect.value,
        status: statusSelect.value
      };
      // או מזהה מחלקה קיימת, או שם למחלקה חדשה — השרת אינו מקבל שם מחלקה חופשי
      if (wantsNewDept) payload.newDepartmentName = newDeptInput.value.trim();
      else payload.departmentId = deptSelect.value ? Number(deptSelect.value) : null;

      if (passInput.value.trim()) payload.password = passInput.value.trim();
      if (!payload.name || !payload.email) return UI.toast('נדרשים שם ואימייל', 'error');
      if (wantsNewDept && !payload.newDepartmentName) return UI.toast('נדרש שם למחלקה החדשה', 'error');
      if (payload.role === 'manager' && !wantsNewDept && !payload.departmentId) {
        return UI.toast('מנהל מחלקה חייב להיות משויך למחלקה — יש לבחור מחלקה קיימת או להגדיר מחלקה חדשה', 'error');
      }
      saveBtn.disabled = true;
      try {
        // ההרשאות האישיות נשמרות בנקודת קצה נפרדת, כי הן חלות רק על עובד
        // פנימי והשרת דוחה אותן לתפקידים אחרים
        const wantedGrants = payload.role === 'employee'
          ? [...grantChecks.entries()].filter(([, box]) => box.checked).map(([key]) => key)
          : [];

        let created = null;
        let savedId = user?.id ?? null;
        if (isEdit) await API.updateUser(user.id, payload);
        else {
          created = await API.createUser(payload);
          savedId = created?.userId ?? null;
        }

        if (savedId && grantChecks.size) {
          const before = (user?.grants ?? []).slice().sort().join(',');
          if (before !== wantedGrants.slice().sort().join(',')) {
            await API.setUserGrants(savedId, wantedGrants);
          }
        }
        m.close();
        if (created?.invite) showInviteResult(created.invite, payload.name);
        else UI.success('נשמר');
        // רינדור מלא ולא רק של גוף המסך: שינוי פרטי המשתמש המחובר משפיע
        // גם על הסרגל העליון, שנבנה בנפרד ואחרת נשאר עם השם הישן
        await App.reloadReference();
        App.render();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  // ------------------------------------------------------------- מחלקות

  async function departmentsTab(body) {
    // מסך הניהול מציג גם מחלקות מושבתות; טפסי שיוך מקבלים פעילות בלבד
    const data = await API.departments({ includeInactive: true });

    UI.mount(body,
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: '🏢' }),
        el('div', { text: 'המחלקה היא היחידה שלפיה נחתכות ההרשאות: מנהל מחלקה רואה ומנהל את המשימות והעובדים של המחלקה שלו. משימה יכולה להיות מחלקתית או ארגונית.' })
      ]),
      el('div.flex.mb', {}, [
        el('div.spacer'),
        el('button.btn.btn-primary', { onclick: () => departmentDialog() }, ['＋ מחלקה חדשה'])
      ]),
      el('div.table-wrap', {}, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'מחלקה' }), el('th', { text: 'מנהל/ת' }), el('th', { text: 'אנשים' }),
            el('th', { text: 'סטטוס' }), el('th', { text: '' })
          ])]),
          el('tbody', {}, data.departments.length ? data.departments.map((d) =>
            el('tr', {}, [
              el('td', {}, [el('b', { text: d.name })]),
              el('td', {}, [d.managerName
                ? el('div.flex', {}, [UI.avatar(d.managerName, { small: true }), el('span', { text: d.managerName })])
                : el('span.mute-sm', { text: 'לא הוגדר' })]),
              el('td', { text: String(d.peopleCount) }),
              el('td', {}, [el('span', {
                class: d.status === 'active' ? 'text-ok' : 'text-danger',
                text: d.status === 'active' ? '● פעילה' : '○ לא פעילה'
              })]),
              el('td', {}, [
                el('div.flex', {}, [
                  el('button.btn.btn-sm', { onclick: () => departmentDialog(d) }, ['עריכה']),
                  el('button.btn.btn-sm.btn-danger', {
                    onclick: async () => {
                      if (!await UI.confirm(`למחוק את המחלקה "${d.name}"?`, { danger: true, okText: 'מחיקה' })) return;
                      try {
                        await API.deleteDepartment(d.id);
                        UI.success('המחלקה נמחקה');
                        reload();
                      } catch (err) {
                        // מחלקה שעדיין משויכים לה אנשים אינה נמחקת — השרת מסביר בדיוק כמה ומה לעשות
                        UI.error(err);
                      }
                    }
                  }, ['מחיקה'])
                ])
              ])
            ])
          ) : [el('tr', {}, [el('td', { colspan: '5' }, [UI.empty('אין מחלקות מוגדרות', '🏢')])])])
        ])
      ])
    );
  }

  function departmentDialog(dept = null) {
    const isEdit = !!dept;
    const nameInput = el('input', { type: 'text', value: dept?.name ?? '' });

    // כל המשתמשים הפעילים מוצעים כמנהלים — מי מהם באמת מתאים נקבע בשרת,
    // ולכן רמת הגישה מוצגת לצד השם כדי שהבחירה תהיה מושכלת
    const managerSelect = UI.select([
      { value: '', label: 'ללא מנהל' },
      // רמת הגישה מצורפת לשם רק כשהצופה רשאי לראות רמות
      ...App.state.users.map((u) => ({ value: String(u.id), label: u.roleLabel ? `${u.name} — ${u.roleLabel}` : u.name }))
    ], String(dept?.managerUserId ?? ''));

    const statusSelect = UI.select(
      [{ value: 'active', label: 'פעילה' }, { value: 'inactive', label: 'לא פעילה' }],
      dept?.status ?? 'active'
    );

    const saveBtn = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: isEdit ? `עריכת מחלקה — ${dept.name}` : 'מחלקה חדשה',
      body: el('div', {}, [
        UI.field('שם המחלקה', nameInput, isEdit ? 'שינוי השם מתעדכן בכל המשתמשים המשויכים למחלקה' : null),
        UI.field('מנהל/ת המחלקה', managerSelect, 'מי שייבחר ישויך למחלקה הזו ויקבל עליה אחריות ניהולית'),
        isEdit ? UI.field('סטטוס', statusSelect) : null
      ]),
      footer: [saveBtn, el('div.spacer')]
    });

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return UI.toast('נדרש שם מחלקה', 'error');
      // ריק נשלח כ-null במפורש, כדי שאפשר יהיה גם לבטל מנהל קיים
      const managerUserId = managerSelect.value ? Number(managerSelect.value) : null;
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.updateDepartment(dept.id, { name, managerUserId, status: statusSelect.value });
        else await API.createDepartment({ name, managerUserId });
        m.close();
        UI.success('נשמר');
        // מינוי מנהל משייך אותו למחלקה — כולל את המשתמש המחובר עצמו,
        // ולכן נטענים מחדש נתוני הייחוס ולא רק הטבלה
        await App.reloadReference();
        reload();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  // ------------------------------------------------------------- ספקים

  function vendorsTab(body) {
    UI.mount(body,
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: 'ℹ️' }),
        el('div', { text: 'כל ספק מקבל בורד ייעודי משלו הכולל אך ורק את המשימות שהוקצו לו. ספק אינו רואה ספקים אחרים ואינו רואה את הבורד הפנימי.' })
      ]),
      el('div.flex.mb', {}, [
        el('div.spacer'),
        el('button.btn.btn-primary', { onclick: () => vendorDialog() }, ['＋ ספק חדש'])
      ]),
      el('div.table-wrap', {}, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'ספק / חברה' }), el('th', { text: 'איש קשר' }), el('th', { text: 'אימייל' }),
            el('th', { text: 'טלפון' }), el('th', { text: 'סטטוס' }), el('th', { text: 'הרשאה' }), el('th', { text: '' })
          ])]),
          el('tbody', {}, App.state.vendors.length ? App.state.vendors.map((v) =>
            el('tr', {}, [
              el('td', {}, [el('div.flex', {}, [UI.avatar(v.name, { small: true, vendor: true }), el('b', { text: v.name })])]),
              el('td', { text: v.contactName || '—' }),
              el('td', { text: v.email }),
              el('td', { text: v.phone || '—' }),
              el('td', {}, [el('span', {
                class: v.status === 'active' ? 'text-ok' : 'text-danger',
                text: v.status === 'active' ? '● פעיל' : '○ מושהה'
              })]),
              el('td', {}, [v.readOnly ? el('span.tag.tag-high', {}, ['צפייה בלבד']) : el('span.tag.tag-normal', {}, ['מלאה'])]),
              el('td', {}, [
                el('div.flex', {}, [
                  el('button.btn.btn-sm', { onclick: () => vendorDialog(v) }, ['עריכה']),
                  el('button.btn.btn-sm', {
                    title: 'שליחה חוזרת של הזמנה לפורטל הספקים',
                    onclick: async () => {
                      try {
                        const r = await API.resendInvite('vendor', v.id);
                        showInviteResult(r.invite, v.contactName || v.name);
                      } catch (err) { UI.error(err); }
                    }
                  }, ['✉ הזמנה']),
                  v.boardId ? el('button.btn.btn-sm', { onclick: () => App.navigate('vendorBoards', { boardId: v.boardId }) }, ['לבורד']) : null
                ])
              ])
            ])
          ) : [el('tr', {}, [el('td', { colspan: '7' }, [UI.empty('אין ספקים רשומים', '🤝')])])])
        ])
      ])
    );
  }

  function vendorDialog(vendor = null) {
    const isEdit = !!vendor;
    const nameInput = el('input', { type: 'text', value: vendor?.name ?? '' });
    const contactInput = el('input', { type: 'text', value: vendor?.contactName ?? '' });
    const emailInput = el('input', { type: 'email', value: vendor?.email ?? '' });
    const phoneInput = el('input', { type: 'text', value: vendor?.phone ?? '' });
    const statusSelect = UI.select([{ value: 'active', label: 'פעיל' }, { value: 'suspended', label: 'מושהה' }], vendor?.status ?? 'active');
    const readOnlyCheck = el('input', { type: 'checkbox', checked: !!vendor?.readOnly });
    const passInput = el('input', { type: 'text', placeholder: isEdit ? 'השאר ריק כדי לא לשנות' : '1234' });

    const saveBtn = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: isEdit ? `עריכת ספק — ${vendor.name}` : 'ספק חדש',
      body: el('div', {}, [
        UI.field('שם ספק / חברה', nameInput),
        el('div.row', {}, [UI.field('איש קשר', contactInput), UI.field('טלפון', phoneInput)]),
        UI.field('אימייל', emailInput, 'משמש לכניסה לפורטל הספקים'),
        el('div.row', {}, [UI.field('סטטוס', statusSelect), UI.field('סיסמה', passInput)]),
        el('div.field', {}, [el('label.checkbox', {}, [readOnlyCheck, 'הרשאת צפייה בלבד (ללא יכולת עדכון)'])]),
        !isEdit ? el('div.alert.alert-info', {}, [el('span', { text: '📋' }), el('div', { text: 'עם יצירת הספק ייווצר עבורו אוטומטית בורד ייעודי נפרד.' })]) : null
      ]),
      footer: [saveBtn, el('div.spacer')]
    });

    saveBtn.addEventListener('click', async () => {
      const payload = {
        name: nameInput.value.trim(),
        contactName: contactInput.value.trim(),
        email: emailInput.value.trim(),
        phone: phoneInput.value.trim(),
        status: statusSelect.value,
        readOnly: readOnlyCheck.checked
      };
      if (passInput.value.trim()) payload.password = passInput.value.trim();
      if (!payload.name || !payload.email) return UI.toast('נדרשים שם ואימייל', 'error');
      saveBtn.disabled = true;
      try {
        let created = null;
        if (isEdit) await API.updateVendor(vendor.id, payload);
        else created = await API.createVendor(payload);
        m.close();
        if (created?.invite) showInviteResult(created.invite, payload.contactName || payload.name);
        else UI.success('נשמר');
        // רינדור מלא ולא רק של גוף המסך: שינוי פרטי המשתמש המחובר משפיע
        // גם על הסרגל העליון, שנבנה בנפרד ואחרת נשאר עם השם הישן
        await App.reloadReference();
        App.render();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  // ------------------------------------------------------------- אוטומציות

  async function automationsTab(body) {
    settingsData = await API.settings();
    const { rules, catalog } = settingsData;

    UI.mount(body,
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: '⚙️' }),
        el('div', {}, [
          el('b', { text: 'מנוע כללים ניתן להרחבה' }),
          el('div', { text: 'ניתן לשנות כללים קיימים או להוסיף כללים חדשים בכל שלב, ללא שינוי מבני במערכת. כל הפרמטרים המספריים נקראים מהגדרות המערכת ואינם מקודדים בקוד.' })
        ])
      ]),
      el('div.flex.mb', {}, [
        el('button.btn', { onclick: runNow }, ['▶ הרצת כל הכללים עכשיו']),
        el('div.spacer'),
        el('button.btn.btn-primary', { onclick: () => ruleDialog(null, catalog) }, ['＋ כלל חדש'])
      ]),
      el('div.table-wrap', {}, [
        el('table.data', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'פעיל' }), el('th', { text: 'שם הכלל' }), el('th', { text: 'טריגר' }),
            el('th', { text: 'פעולה' }), el('th', { text: 'פרמטרים' }), el('th', { text: 'הרצה אחרונה' }), el('th', { text: '' })
          ])]),
          el('tbody', {}, rules.map((r) => {
            const trigger = catalog.triggers.find((t) => t.key === r.triggerKey);
            const action = catalog.actions.find((a) => a.key === r.actionKey);
            const paramText = Object.entries(r.params).map(([k, v]) => {
              if (k.endsWith('_setting')) return `${v} (מהגדרות)`;
              return `${k}=${v}`;
            }).join(', ') || '—';
            return el('tr', {}, [
              el('td', {}, [el('input', {
                type: 'checkbox',
                checked: r.enabled,
                onchange: async (e) => {
                  try { await API.updateRule(r.id, { enabled: e.target.checked }); UI.success('עודכן'); }
                  catch (err) { UI.error(err); }
                }
              })]),
              el('td.wrap', {}, [el('b', { text: r.name }), r.builtIn ? el('span.tag.tag-internal', { style: { marginInlineStart: '6px' } }, ['מובנה']) : null]),
              el('td.wrap', { text: trigger?.label ?? r.triggerKey }),
              el('td.wrap', { text: action?.label ?? r.actionKey }),
              el('td', { text: paramText }),
              el('td', { text: r.lastRunAt ? UI.formatDateTime(r.lastRunAt) : '—' }),
              el('td', {}, [
                el('div.flex', {}, [
                  el('button.btn.btn-sm', { onclick: () => ruleDialog(r, catalog) }, ['עריכה']),
                  !r.builtIn ? el('button.btn.btn-sm.btn-danger', {
                    onclick: async () => {
                      if (!await UI.confirm(`למחוק את הכלל "${r.name}"?`, { danger: true, okText: 'מחיקה' })) return;
                      try { await API.deleteRule(r.id); reload(); } catch (err) { UI.error(err); }
                    }
                  }, ['מחיקה']) : null
                ])
              ])
            ]);
          }))
        ])
      ])
    );
  }

  async function runNow() {
    try {
      const data = await API.runRules();
      const lines = data.summary.rules.map((r) => `${r.rule}: ${r.error ? `שגיאה — ${r.error}` : `${r.fired} הפעלות`}`);
      UI.modal({
        title: 'תוצאות הרצת מנוע הכללים',
        body: el('div', {}, lines.map((l) => el('div', { text: `• ${l}`, style: { padding: '3px 0' } }))),
        footer: [el('button.btn.btn-primary', { onclick: () => document.querySelector('.modal-backdrop')?.remove() }, ['סגירה'])]
      });
      App.refreshNotifications();
    } catch (err) { UI.error(err); }
  }

  function ruleDialog(rule, catalog) {
    const isEdit = !!rule;
    const nameInput = el('input', { type: 'text', value: rule?.name ?? '' });
    const triggerSelect = UI.select(catalog.triggers.map((t) => ({ value: t.key, label: t.label })), rule?.triggerKey ?? catalog.triggers[0].key);
    const actionSelect = UI.select(catalog.actions.map((a) => ({ value: a.key, label: a.label })), rule?.actionKey ?? catalog.actions[0].key);
    const paramsBox = el('div');

    function drawParams() {
      const trigger = catalog.triggers.find((t) => t.key === triggerSelect.value);
      UI.clear(paramsBox);
      for (const p of trigger?.paramsSchema ?? []) {
        const value = rule?.params?.[p.key] ?? '';
        const input = el('input', { type: 'number', value, placeholder: p.settingKey ? 'ריק = לפי הגדרות המערכת' : '' });
        input.dataset.key = p.key;
        input.dataset.settingKey = p.settingKey ?? '';
        paramsBox.appendChild(UI.field(p.label, input,
          p.settingKey ? `אם יישאר ריק — ייקרא הערך מהגדרת המערכת "${p.settingKey}"` : null));
      }
      if (!(trigger?.paramsSchema ?? []).length) {
        paramsBox.appendChild(el('div.mute-sm', { text: 'לטריגר זה אין פרמטרים.' }));
      }
    }
    triggerSelect.addEventListener('change', drawParams);
    drawParams();

    const saveBtn = el('button.btn.btn-primary', {}, ['שמירה']);
    const m = UI.modal({
      title: isEdit ? 'עריכת כלל' : 'כלל אוטומציה חדש',
      body: el('div', {}, [
        UI.field('שם הכלל', nameInput),
        UI.field('מתי (טריגר)', triggerSelect, isEdit ? 'לא ניתן לשנות טריגר של כלל קיים' : null),
        UI.field('מה קורה (פעולה)', actionSelect, isEdit ? 'לא ניתן לשנות פעולה של כלל קיים' : null),
        el('h4', { text: 'פרמטרים', style: { fontSize: '13px', margin: '10px 0 8px' } }),
        paramsBox
      ]),
      footer: [saveBtn, el('div.spacer')]
    });
    if (isEdit) { triggerSelect.disabled = true; actionSelect.disabled = true; }

    saveBtn.addEventListener('click', async () => {
      const params = {};
      for (const input of paramsBox.querySelectorAll('input')) {
        if (input.value.trim()) params[input.dataset.key] = Number(input.value);
        else if (input.dataset.settingKey) params[`${input.dataset.key === 'days_before' ? 'days_before' : input.dataset.key}_setting`] = input.dataset.settingKey;
      }
      const payload = { name: nameInput.value.trim() || 'כלל חדש', triggerKey: triggerSelect.value, actionKey: actionSelect.value, params };
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.updateRule(rule.id, { name: payload.name, params });
        else await API.createRule(payload);
        m.close();
        UI.success('הכלל נשמר');
        reload();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  // ------------------------------------------------------------- הגדרות

  /** כל הגדרה והסבר קצר מה היא עושה בפועל */
  const SETTING_LABELS = {
    vendor_reminder_days_before: ['X — ימים לפני היעד לתזכורת ראשונה לספק', 'הערך שמנוע הכללים משתמש בו לתזכורת האוטומטית לספק'],
    manager_alert_hours_before: ['Y — שעות לפני היעד להתראה מקדימה למנהל', 'ההתראה נשלחת למנהל לפני שהמשימה חורגת מהיעד'],
    escalation_hours_urgent: ['שעות ללא שינוי סטטוס עד להקפצת משימה דחופה', 'משימה דחופה שאינה זזה מוקפצת אוטומטית לתשומת לב המנהל'],
    scheduler_interval_minutes: ['תדירות הרצת מנוע הכללים (דקות)', ''],
    max_upload_mb: ['גודל מרבי לקובץ (MB)', 'נאכף בכל העלאת קובץ — הן במשימות והן בפורטל הספקים'],
    allowed_extensions: ['סוגי קבצים מותרים (מופרדים בפסיק)', 'קובץ מסוג שאינו ברשימה יידחה בהעלאה'],
    recurring_default_policy: ['מדיניות ברירת מחדל למשימות חוזרות חופפות', 'קובע מה קורה כשמגיע מועד למופע חדש והמופע הקודם עדיין פתוח'],
    org_name: ['שם הארגון', 'מופיע בכותרות המערכת ובהזמנות שנשלחות במייל'],
    public_url: ['כתובת המערכת באינטרנט', 'הכתובת שממנה משתמשים נכנסים — קישורי ההזמנות במייל נבנים ממנה. לדוגמה https://mesimon.co.il. אם משאירים ריק, הקישור נבנה מהכתובת שדרכה נכנסתם.']
  };

  /**
   * מצב החיבורים החיצוניים. תכונה שתלויה במפתח בשרת נעלמת בשקט כשהמפתח
   * חסר, ואין שום סימן לכך בממשק — הכרטיס הזה הופך את זה לגלוי.
   */
  function integrationsCard(x) {
    if (!x) return null;

    const row = (title, ok, okText, missing, hint) =>
      el('div', { style: { padding: '11px 0', borderBottom: '1px solid var(--border)' } }, [
        el('div.flex', {}, [
          el('span', { text: ok ? '✅' : '○', style: { fontSize: '15px' } }),
          el('b', { text: title }),
          el('div.spacer'),
          el('span', {
            class: ok ? 'text-ok' : 'text-danger',
            style: { fontSize: '12.5px', fontWeight: '700' },
            text: ok ? okText : 'לא מוגדר'
          })
        ]),
        !ok && missing.length
          ? el('div.mute-sm', { style: { marginTop: '3px' }, text: `חסרים בשרת: ${missing.join(', ')}` })
          : null,
        hint ? el('div.mute-sm', { style: { marginTop: '3px' }, text: hint }) : null
      ]);

    return el('div.card.mb', {}, [
      el('div.card-head', {}, [el('h3', { text: 'חיבורים חיצוניים' })]),
      el('div.card-pad', { style: { paddingTop: '0' } }, [
        row('כניסה עם חשבון Google', x.google.enabled, 'פעיל', x.google.missing,
          x.google.enabled ? 'הכפתור מוצג במסך הכניסה.' : 'כל עוד המפתחות חסרים, הכפתור אינו מוצג כלל במסך הכניסה.'),
        row('שליחת דואר', x.mail.enabled, `דרך ${x.mail.host}`, x.mail.missing,
          x.mail.enabled ? `נשלח מהכתובת ${x.mail.from}` : 'ההזמנות נוצרות אך אינן נשלחות; הקישור מוצג להעברה ידנית.'),
        row('כתובת המערכת', !!x.publicUrl, x.publicUrl ?? '', [],
          x.publicUrl ? 'קישורי ההזמנות נבנים מכתובת זו.' : 'קישורי ההזמנות נבנים מהכתובת שדרכה נכנסתם.')
      ])
    ]);
  }

  /** מצב אחסון הנתונים — התשובה לשאלה "האם הנתונים שלי נשמרים" */
  function storageCard(s) {
    if (!s) return null;

    const label = {
      env: 'דיסק קבוע לפי הגדרות השרת',
      detected: `דיסק קבוע שזוהה אוטומטית (${s.disk})`,
      local: 'תיקייה מקומית על המחשב'
    }[s.source] ?? s.source;

    const rows = [
      ['מיקום מסד הנתונים', s.dataDir],
      ['מיקום הקבצים המצורפים', s.uploadsDir],
      ['סוג האחסון', label],
      ['גודל מסד הנתונים', s.dbSizeKb === null ? '—' : `${s.dbSizeKb} KB`],
      ['מסד הנתונים נוצר בתאריך', s.installedAt ? UI.formatDateTime(s.installedAt) : '—'],
      ['מספר הפעלות של השרת מאז', String(s.bootCount || 0)]
    ];

    const alert = s.ephemeralInCloud
      ? el('div.alert.alert-danger', {}, [
          el('span', { text: '⚠️' }),
          el('div', {}, [
            el('b', { text: 'הנתונים אינם נשמרים' }),
            el('div', { text: 'המערכת כותבת לתוך תיקיית הקוד בשרת, שנמחקת בכל פרסום גרסה. כל המשימות, המשתמשים והקבצים יימחקו בעדכון הבא. יש לחבר דיסק קבוע בנתיב /var/mesimon.' })
          ])
        ])
      : el('div.alert.alert-ok', {}, [
          el('span', { text: '✅' }),
          el('div', {}, [
            el('b', { text: 'הנתונים נשמרים' }),
            el('div', { text: 'אם התאריך שלמטה נשאר זהה גם אחרי פרסום גרסה חדשה — האחסון תקין.' })
          ])
        ]);

    return el('div.card.mb', {}, [
      el('div.card-head', {}, [el('h3', { text: 'אחסון הנתונים' })]),
      el('div.card-pad', {}, [
        alert,
        el('table.data', { style: { width: '100%' } }, [
          el('tbody', {}, rows.map(([k, v]) =>
            el('tr', { style: { cursor: 'default' } }, [
              el('th', { style: { width: '230px' }, text: k }),
              el('td.wrap', { text: v })
            ])
          ))
        ])
      ])
    ]);
  }

  async function settingsTab(body) {
    settingsData = await API.settings();
    const s = settingsData.settings;
    const inputs = {};

    const fields = Object.entries(SETTING_LABELS).map(([key, [label, hint]]) => {
      let control;
      if (key === 'recurring_default_policy') {
        control = UI.select([
          { value: 'skip_if_open', label: 'לא ליצור מופע חדש עד לסגירת הקודם' },
          { value: 'always', label: 'ליצור מופע חדש בכל מקרה' }
        ], s[key]);
      } else if (key === 'allowed_extensions') {
        control = el('input', { type: 'text', value: (s[key] ?? []).join(', ') });
      } else if (typeof s[key] === 'number') {
        control = el('input', { type: 'number', value: s[key] });
      } else {
        control = el('input', { type: 'text', value: s[key] ?? '' });
      }
      inputs[key] = control;
      return UI.field(label, control, hint || null);
    });

    const saveBtn = el('button.btn.btn-primary', {}, ['שמירת הגדרות']);
    saveBtn.addEventListener('click', async () => {
      const payload = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (key === 'allowed_extensions') {
          payload[key] = input.value.split(',').map((x) => x.trim().replace('.', '').toLowerCase()).filter(Boolean);
        } else if (input.type === 'number') {
          payload[key] = Number(input.value);
        } else {
          payload[key] = input.value;
        }
      }
      saveBtn.disabled = true;
      try {
        await API.saveSettings(payload);
        UI.success('ההגדרות נשמרו והוחלו על מנוע הכללים');
        await App.reloadReference();
        saveBtn.disabled = false;
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });

    UI.mount(body,
      integrationsCard(settingsData.integrations),
      storageCard(settingsData.storage),
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: '🔧' }),
        el('div', { text: 'כל הפרמטרים המספריים של האוטומציות מוגדרים כאן ולא בקוד — כך שניתן לכוונן אותם תוך כדי עבודה, בהתאם לצורך בפועל.' })
      ]),
      el('div.card', {}, [
        el('div.card-pad', {}, [
          el('div.grid.grid-2', {}, fields),
          el('div.mt', {}, [saveBtn])
        ])
      ]),
      wipeCard()
    );
  }

  /** ניקוי נתוני ההדגמה לפני תחילת עבודה אמיתית */
  function wipeCard() {
    return el('div.card.mt', { style: { borderColor: '#fecaca' } }, [
      el('div.card-head', { style: { borderColor: '#fecaca' } }, [
        el('h3', { text: 'אתחול תוכן המערכת', style: { color: 'var(--danger)' } })
      ]),
      el('div.card-pad', {}, [
        el('p', { style: { marginTop: '0' } }, [
          'מוחק את ',
          el('b', { text: 'כל' }),
          ' המשימות, הפרויקטים, הספקים והמשתמשים — למעט החשבון שלך. ',
          'ההגדרות וכללי האוטומציה נשמרים.'
        ]),
        el('div.alert.alert-warn', {}, [
          el('span', { text: '⚠️' }),
          el('div', { text: 'הפעולה אינה הפיכה. השתמש בה כדי לנקות את נתוני ההדגמה לפני שמתחילים לעבוד באמת.' })
        ]),
        el('button.btn.btn-danger', { onclick: confirmWipe }, ['אתחול תוכן המערכת'])
      ])
    ]);
  }

  function confirmWipe() {
    const input = el('input', { type: 'text', placeholder: 'אתחול' });
    const okBtn = el('button.btn.btn-danger', {}, ['מחיקה סופית']);
    const m = UI.modal({
      title: 'אתחול תוכן המערכת',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 } }, ['כל המשימות, הפרויקטים, הספקים, הקבצים והמשתמשים יימחקו לצמיתות.']),
        el('p', {}, [
          'החשבון שלך (',
          el('b', { text: App.state.actor.email }),
          ') יישמר, ותישאר מחובר.'
        ]),
        UI.field('להמשך, הקלד את המילה: אתחול', input)
      ]),
      footer: [okBtn, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });

    okBtn.addEventListener('click', async () => {
      if (input.value.trim() !== 'אתחול') return UI.toast('יש להקליד את המילה: אתחול', 'error');
      okBtn.disabled = true;
      try {
        const res = await API.wipeSystem(input.value.trim());
        m.close();
        UI.success(`נמחקו ${res.removed.tasks} משימות, ${res.removed.projects} פרויקטים, ${res.removed.vendors} ספקים ו-${res.removed.users} משתמשים`);
        await App.reloadReference();
        App.navigate('admin', { tab: 'users' });
      } catch (err) {
        okBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  // ------------------------------------------------------------- מטריצת הרשאות

  /**
   * ניסוח הסייגים בתא במטריצה. ערך שאינו true/false מגדיר היקף מוקטן,
   * ו-'department' — ההיקף החדש — מוגבל למחלקה של המשתמש.
   */
  const SCOPE_LABELS = {
    department: 'המחלקה שלו',
    own: 'שלו בלבד',
    assigned: 'שהוקצו לו',
    self_board: 'הבורד שלו'
  };

  async function matrixTab(body) {
    settingsData = settingsData ?? await API.settings().catch(() => null);
    if (!settingsData) return UI.mount(body, UI.empty('אין הרשאה לצפות במטריצה', '🔒'));

    const cell = (v) => {
      if (v.value === true) return el('td.v-yes', { text: '✓' });
      if (v.value === false) return el('td.v-no', {}, [v.note ? el('span.v-partial', { text: `✗ ${v.note}` }) : el('span', { text: '✗' })]);
      // הסייג עצמו בשורה אחת, וההערה מהמטריצה מתחתיו כהבהרה
      return el('td.v-partial', {}, [
        el('b', { text: `◑ ${SCOPE_LABELS[v.value] ?? 'חלקי'}` }),
        v.note ? el('div.mute-sm', { text: v.note }) : null
      ]);
    };

    UI.mount(body,
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: '🔐' }),
        el('div', { text: 'זוהי מטריצת ההרשאות המלאה של המערכת. היא נאכפת בצד השרת ומהווה מקור אמת יחיד — הממשק בונה את התצוגה ממנה ואינו קובע הרשאות בעצמו.' })
      ]),
      el('div.flex.mb', {}, [
        el('span.mute-sm', { text: '✓ מותר במלואו' }),
        el('span.mute-sm', { text: '◑ מותר בהיקף מוגבל' }),
        el('span.mute-sm', { text: '✗ אסור' }),
        el('div.spacer'),
        el('span.mute-sm', { text: 'שש רמות גישה — אפשר לגלול את הטבלה לצדדים' })
      ]),
      el('div.table-wrap', {}, [
        // שש עמודות תפקידים אינן נכנסות לרוחב המסך; רוחב מינימלי מפעיל את
        // הגלילה האופקית של ‎.table-wrap‎ במקום לדחוס את העמודות לבלי קרוא
        el('table.data.matrix-table', { style: { minWidth: '1040px' } }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { style: { minWidth: '250px' }, text: 'פעולה' }),
            ...settingsData.roles.map((r) =>
              el('th', { style: { textAlign: 'center', minWidth: '130px' }, text: settingsData.roleLabels[r] }))
          ])]),
          el('tbody', {}, settingsData.matrix.map((row) =>
            el('tr', { style: { cursor: 'default' } }, [el('td.wrap', {}, [el('b', { text: row.label })]), ...row.values.map(cell)])
          ))
        ])
      ])
    );
  }

  // ------------------------------------------------------------- תבניות

  async function templatesTab(body) {
    const data = await API.templates();

    const dialog = () => {
      const kindSelect = UI.select([{ value: 'task', label: 'תבנית משימה' }, { value: 'project', label: 'תבנית פרויקט' }], 'task');
      const nameInput = el('input', { type: 'text' });
      const itemsInput = el('textarea', { placeholder: 'פריט בכל שורה — סעיפי צ׳קליסט (למשימה) או משימות (לפרויקט)' });
      const saveBtn = el('button.btn.btn-primary', {}, ['שמירה']);
      const m = UI.modal({
        title: 'תבנית חדשה',
        body: el('div', {}, [UI.field('סוג', kindSelect), UI.field('שם התבנית', nameInput), UI.field('פריטים', itemsInput)]),
        footer: [saveBtn, el('div.spacer')]
      });
      saveBtn.addEventListener('click', async () => {
        const items = itemsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const payload = kindSelect.value === 'task' ? { checklist: items } : { tasks: items };
        try {
          await API.createTemplate({ kind: kindSelect.value, name: nameInput.value.trim(), payload });
          m.close();
          reload();
        } catch (err) { UI.error(err); }
      });
    };

    UI.mount(body,
      el('div.alert.alert-info.mb', {}, [
        el('span', { text: '📑' }),
        el('div', { text: 'תבניות למשימות ולפרויקטים שחוזרים על עצמם. תבנית פרויקט יוצרת אוטומטית את משימות הבסיס שלו.' })
      ]),
      el('div.flex.mb', {}, [el('div.spacer'), el('button.btn.btn-primary', { onclick: dialog }, ['＋ תבנית חדשה'])]),
      el('div.grid.grid-2', {}, data.templates.length ? data.templates.map((t) =>
        el('div.card', {}, [
          el('div.card-head', {}, [
            el('h3', { text: t.name }),
            el('span.tag', { class: t.kind === 'task' ? 'tag-internal' : 'tag-vendor' }, [t.kind === 'task' ? 'משימה' : 'פרויקט']),
            el('div.spacer'),
            el('button.btn.btn-sm.btn-danger', {
              onclick: async () => {
                if (!await UI.confirm(`למחוק את התבנית "${t.name}"?`, { danger: true, okText: 'מחיקה' })) return;
                try { await API.deleteTemplate(t.id); reload(); } catch (err) { UI.error(err); }
              }
            }, ['מחיקה'])
          ]),
          el('div.card-pad', {}, (t.payload.checklist ?? t.payload.tasks ?? []).map((item) =>
            el('div', { text: `• ${item}`, style: { padding: '2px 0', fontSize: '13px' } })))
        ])
      ) : [UI.empty('אין תבניות', '📑')])
    );
  }

  return { render };
})();
