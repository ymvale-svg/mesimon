'use strict';
/** שלד האפליקציה: מצב גלובלי, ניווט, סרגל עליון, תפריט צד והתראות. */

const App = (() => {
  const { el } = UI;

  const state = {
    actor: null,
    permissions: {},
    boards: [],
    projects: [],
    users: [],
    vendors: [],
    priorities: [],
    settings: {},
    savedFilters: [],
    notifications: [],
    unread: 0,
    route: { name: 'home', params: {} },
    homeData: null
  };

  const root = () => document.getElementById('app');

  const may = (action) => state.permissions[action] && state.permissions[action] !== false;
  const can = (action) => state.permissions[action] === true;
  const isVendor = () => state.actor?.type === 'vendor';

  const userName = (id) => state.users.find((u) => u.id === id)?.name ?? null;
  const vendorName = (id) => state.vendors.find((v) => v.id === id)?.name ?? null;
  const project = (id) => state.projects.find((p) => p.id === id) ?? null;
  const internalBoard = () => state.boards.find((b) => b.type === 'internal') ?? null;
  const vendorBoards = () => state.boards.filter((b) => b.type === 'vendor');

  // ------------------------------------------------------------- טעינה

  async function boot() {
    UI.mount(root(), UI.spinner());

    // קישור הזמנה — קביעת סיסמה לפני שיש בכלל סשן
    const inviteToken = InviteView.tokenFromUrl();
    if (inviteToken) return InviteView.render(root(), inviteToken, boot);

    /**
     * כל כניסה למערכת פותחת סשן התראות חדש. האיפוס דווקא כאן, ולא רק
     * בהתנתקות, כי מי שנכנס עכשיו אינו בהכרח מי שיצא: סשן שפג באמצע העבודה
     * עוצר את הסקר אך מותיר בזיכרון את מזהי ההתראות של הקודם ואת הדגל
     * "כבר הוקפץ" — וכך המשתמש הבא באותה לשונית היה מוצף בכל ההתראות
     * שלא נקראו שלו בבת אחת, בדיוק מה שההשהיה הראשונה באה למנוע.
     */
    resetNotifSession();

    try {
      const data = await API.bootstrap();
      Object.assign(state, data);
      await refreshNotifications();
      startNotifPolling();
      navigate(isVendor() ? 'vendor' : 'home');
    } catch (err) {
      if (err.status === 401) LoginView.render(root(), boot);
      else {
        UI.mount(root(), el('div.empty', {}, [
          el('div.e-icon', { text: '⚠️' }),
          el('div', { text: `לא ניתן לטעון את המערכת: ${err.message}` }),
          el('button.btn.mt', { onclick: boot }, ['ניסיון חוזר'])
        ]));
      }
    }
  }

  async function reloadReference() {
    const data = await API.bootstrap();
    Object.assign(state, data);
  }

  async function logout() {
    // לפני הבקשה ולא אחריה: אם השרת אינו זמין הבקשה נכשלת, והסקר היה נשאר חי
    resetNotifSession();
    await API.logout();
    state.actor = null;
    LoginView.render(root(), boot);
  }

  // ------------------------------------------------------------- ניווט

  const ROUTES = {
    home: { label: 'דף הבית', icon: '🏠', render: (c) => HomeView.render(c) },
    board: { label: 'לוח המשימות', icon: '📋', render: (c, p) => BoardView.render(c, { ...p, scope: 'internal' }) },
    vendorBoards: { label: 'כל משימות הספקים', icon: '🤝', render: (c, p) => BoardView.render(c, { ...p, scope: 'vendors' }) },
    archive: { label: 'ארכיון', icon: '🗄️', render: (c, p) => BoardView.render(c, { ...p, scope: 'internal', archived: true }) },
    reports: { label: 'דוחות', icon: '📈', render: (c) => ReportsView.render(c) },
    admin: { label: 'ניהול המערכת', icon: '⚙️', render: (c, p) => AdminView.render(c, p) },
    vendor: { label: 'המשימות שלי', icon: '📦', render: (c) => VendorPortalView.render(c) }
  };

  function navigate(name, params = {}) {
    state.route = { name, params };
    render();
  }

  // ------------------------------------------------------------- התראות

  const NOTIF_POLL_MS = 30000;
  const NOTIF_POP_MAX = 3;      // כמה כרטיסים מקפיצים ממחזור אחד, גם אם הגיעו עשר התראות
  const SYSTEM_AUTHOR = 'המערכת';

  // פלטה אחת לסוגי ההתראות, משותפת למגירת ההתראות ולכרטיס המוקפץ
  const NOTIF_STYLE = {
    vendor_reminder: { icon: '⏳', bg: '#fffbeb', color: '#d97706' },
    manager_alert: { icon: '📣', bg: '#eff6ff', color: '#2563eb' },
    overdue: { icon: '⏰', bg: '#fef2f2', color: '#dc2626' },
    escalation: { icon: '↑', bg: '#fef2f2', color: '#7c2d12' },
    mention: { icon: '@', bg: '#f0fdfa', color: '#0f766e' },
    status_change: { icon: '🔄', bg: '#f8fafc', color: '#475569' },
    assignment: { icon: '📌', bg: '#f5f3ff', color: '#7c3aed' }
  };

  /**
   * מה כבר ראינו בסשן הזה. ההבאה הראשונה רק ממלאת את הקבוצה ואינה מקפיצה דבר:
   * למי שנכנס בבוקר מחכות לפעמים עשרים התראות שלא נקראו, ועשרים כרטיסים
   * שנפתחים יחד מכסים את המסך במקום להודיע על חדש.
   */
  const seenNotifIds = new Set();
  let notifPrimed = false;
  let notifTimer = null;

  async function refreshNotifications() {
    try {
      const data = await API.notifications();
      state.notifications = data.notifications;
      state.unread = data.unread;
      updateBell();
      // בלי await: הבאת כותרות המשימות להקפצה לא תעכב את עדכון הפעמון
      popNewNotifications(data.notifications);
    } catch (err) {
      // סשן שפג — עוצרים את הסקר, אחרת הוא ממשיך לדפוק בשרת כל חצי דקה לשווא
      if (err?.status === 401) stopNotifPolling();
      /* שאר השגיאות בשקט — לא מפריע לעבודה */
    }
  }

  /**
   * סקר יחיד. ‎boot()‎ נקרא שוב אחרי כל התחברות, ושני טיימרים היו מכפילים
   * גם את הבקשות לשרת וגם את ההקפצות.
   */
  function startNotifPolling() {
    if (notifTimer) return;
    notifTimer = setInterval(refreshNotifications, NOTIF_POLL_MS);
  }

  function stopNotifPolling() {
    clearInterval(notifTimer);
    notifTimer = null;
  }

  /**
   * ניקוי בין סשנים — נקרא בכל כניסה למערכת ובכל התנתקות. המשתמש הבא לא צריך
   * לראות את ההתראות של קודמו, ואינו צריך שההתראות שלו ייחשבו כמי שכבר הוקפצו.
   */
  function resetNotifSession() {
    stopNotifPolling();
    seenNotifIds.clear();
    notifPrimed = false;
    state.notifications = [];
    state.unread = 0;
    UI.clearNotifyPops();
  }

  /**
   * הקפצת החדשות בלבד, מהישן לחדש: הכרטיסים נוספים בתחתית הערימה, וכך
   * החדשה ביותר יושבת למטה ואף כרטיס שנקרא כרגע אינו זז ממקומו.
   */
  function popNewNotifications(list) {
    const fresh = [];
    for (const n of list) {          // השרת מחזיר מהחדש לישן
      if (seenNotifIds.has(n.id)) continue;
      seenNotifIds.add(n.id);
      if (notifPrimed && !n.isRead) fresh.push(n);
    }
    notifPrimed = true;              // נקבע לפני ההמתנות, כדי שהבאה מקבילה לא תקפיץ הכול מחדש
    for (const n of fresh.slice(0, NOTIF_POP_MAX).reverse()) popNotification(n);
  }

  /**
   * פירוק ההתראה לחלקי הכרטיס: מי כתב, מה קרה ומה תוכן ההודעה.
   *
   * באובייקט ההתראה אין שדה כותב. כשיש כותב הוא יושב בתוך הכותרת
   * ("דנה לוי תייג/ה אותך בתגובה") או בזנב הגוף בתבנית "משימה — שם", ולכן
   * מזהים אותו מול המשתמשים והספקים שכבר בזיכרון — מהשם הארוך לקצר, כדי
   * ש"דנה" לא תיתפס בתוך "דנה לוי". התראות האוטומציות נכתבות ללא אדם.
   * את השם מקצצים מהטקסט שיוצג, כדי שלא יופיע פעמיים באותו כרטיס.
   */
  function notifParts(n) {
    const names = [...state.users, ...state.vendors]
      .map((p) => p.name).filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const headline = String(n.title ?? '').trim();
    const body = String(n.body ?? '').trim();

    const prefix = names.find((name) => headline.startsWith(name));
    if (prefix) return { author: prefix, headline: headline.slice(prefix.length).trim() || headline, body };

    const inTitle = names.find((name) => headline.includes(name));
    if (inTitle) return { author: inTitle, headline, body };

    // התאמה מלאה בלבד לזנב הגוף: "שם המשימה — הושלם" הוא תווית סטטוס, לא אדם
    const cut = body.lastIndexOf(' — ');
    const tail = cut === -1 ? '' : body.slice(cut + 3).trim();
    if (names.includes(tail)) return { author: tail, headline, body: body.slice(0, cut).trim() };

    return { author: SYSTEM_AUTHOR, headline, body };
  }

  function popNotification(n) {
    const style = NOTIF_STYLE[n.kind] ?? NOTIF_STYLE.status_change;
    // שם המשימה מגיע מהשרת יחד עם ההתראה; קודם נשלחה בקשה נפרדת לכל משימה
    const taskTitle = n.taskTitle ?? null;
    const parts = notifParts(n);

    UI.notifyPop({
      icon: style.icon,
      bg: style.bg,
      color: style.color,
      author: parts.author,
      headline: parts.headline,
      // בהתראות כמו הקצאה הגוף הוא בדיוק שם המשימה — שורה כפולה באותו כרטיס
      body: parts.body === taskTitle ? '' : parts.body,
      task: n.taskId ? (taskTitle ?? 'פתיחת המשימה') : null,
      onOpen: n.taskId
        ? () => {
            TaskCardView.open(n.taskId); // קודם נפתחת המשימה — הסימון כנקרא יכול להמתין לרשת
            if (!n.isRead) markNotifRead(n);
          }
        : null
    });
  }

  async function markNotifRead(n) {
    try {
      await API.markRead(n.id);
      n.isRead = true;
      await refreshNotifications();  // המונה על הפעמון יורד
    } catch { /* יסומן בפתיחת מגירת ההתראות */ }
  }

  function updateBell() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.style.display = state.unread ? 'grid' : 'none';
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
  }

  function toggleNotifPanel(anchor) {
    const existing = document.getElementById('notif-panel');
    if (existing) { existing.remove(); return; }

    // המגירה נפתחת באותה פינה ומציגה את אותן התראות — הכרטיסים המוקפצים מיותרים כאן
    UI.clearNotifyPops();

    const panel = el('div.notif-panel#notif-panel', {}, [
      el('div.np-head', {}, [
        el('h3', { text: 'התראות', style: { flex: '1', fontSize: '15px' } }),
        state.unread
          ? el('button.btn.btn-sm', {
              onclick: async () => {
                await API.markRead(null);
                await refreshNotifications();
                panel.remove();
              }
            }, ['סמן הכל כנקרא'])
          : null
      ]),
      el('div.np-list', {}, state.notifications.length
        ? state.notifications.map((n) => {
            const style = NOTIF_STYLE[n.kind] ?? NOTIF_STYLE.status_change;
            return el(`div.notif${n.isRead ? '' : '.unread'}`, {
              onclick: async () => {
                if (!n.isRead) { await API.markRead(n.id); await refreshNotifications(); }
                panel.remove();
                if (n.taskId) TaskCardView.open(n.taskId);
              }
            }, [
              el('div.n-icon', { style: { background: style.bg, color: style.color }, text: style.icon }),
              el('div.n-body', {}, [
                el('b', { text: n.title }),
                n.body ? el('div', { text: n.body, style: { fontSize: '12.5px' } }) : null,
                el('small', { text: UI.relative(n.createdAt) })
              ])
            ]);
          })
        : [UI.empty('אין התראות חדשות', '🔔')])
    ]);

    document.body.appendChild(panel);
    const closeOnOutside = (e) => {
      if (!panel.contains(e.target) && e.target !== anchor) {
        panel.remove();
        document.removeEventListener('mousedown', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 0);
  }

  // ------------------------------------------------------------- חיפוש גלובלי

  function globalSearch() {
    const input = el('input', { type: 'search', placeholder: 'חיפוש משימות ופרויקטים (כולל ארכיון)…' });
    const results = el('div.search-results', { style: { display: 'none' } });
    let timer = null;

    const hide = () => { results.style.display = 'none'; };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return hide();
      timer = setTimeout(async () => {
        try {
          const data = await API.search(q);
          UI.clear(results);
          if (!data.tasks.length && !data.projects.length) {
            results.appendChild(el('div', { style: { padding: '14px', color: 'var(--text-mute)' }, text: 'לא נמצאו תוצאות' }));
          } else {
            if (data.projects.length) {
              results.appendChild(el('div.sr-group', { text: 'פרויקטים' }));
              for (const p of data.projects) {
                results.appendChild(el('button', {
                  onclick: () => { hide(); input.value = ''; navigate('board', { projectId: p.id }); }
                }, [el('div.sr-title', { text: p.name })]));
              }
            }
            if (data.tasks.length) {
              results.appendChild(el('div.sr-group', { text: 'משימות' }));
              for (const t of data.tasks) {
                results.appendChild(el('button', {
                  onclick: () => { hide(); input.value = ''; TaskCardView.open(t.id); }
                }, [
                  el('div.sr-title', { text: t.title }),
                  el('div.sr-meta', { text: `${t.statusLabel} · ${t.projectName ?? 'ללא פרויקט'}${t.archived ? ' · בארכיון' : ''}` })
                ]));
              }
            }
          }
          results.style.display = 'block';
        } catch { /* התעלמות */ }
      }, 260);
    });

    document.addEventListener('mousedown', (e) => {
      if (!results.contains(e.target) && e.target !== input) hide();
    });

    return el('div.global-search', {}, [input, el('span.icon', { text: '🔍' }), results]);
  }

  // ------------------------------------------------------------- תצוגה

  /**
   * כפתור נעיצת פרויקט, יושב בתוך שורת הניווט של הפרויקט.
   * השורה עצמה היא כפתור שמנווט ללוח, ולכן חייבים לעצור את בעבוע האירוע —
   * אחרת כל נעיצה הייתה גם מחליפה מסך תחת ידיו של המשתמש.
   */
  function pinButton(p) {
    const btn = el(`button.nav-pin${p.pinned ? '.is-pinned' : ''}`, {
      type: 'button',
      title: p.pinned ? 'שחרור הנעיצה' : 'נעיצה לראש הרשימה'
    }, ['📌']);

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.disabled = true; // לחיצה כפולה בזמן הבקשה הייתה שולחת נעיצה וביטול זה אחר זה
      try {
        await API.pinProject(p.id, !p.pinned);
        await reloadReference();
        render(); // התפריט נבנה מחדש ומסדר את הנעוצים בראש הרשימה
      } catch (err) {
        btn.disabled = false;
        UI.error(err);
      }
    });
    return btn;
  }

  function sidebar() {
    const items = [];
    const add = (name, params, extra = {}) => {
      const route = ROUTES[name];
      items.push(el(`button.nav-item${state.route.name === name && !extra.matchParam ? '.active' : ''}`, {
        onclick: () => navigate(name, params ?? {})
      }, [
        el('span.ico', { text: extra.icon ?? route.icon }),
        el('span', { text: extra.label ?? route.label }),
        extra.count !== undefined ? el('span.count', { text: String(extra.count) }) : null
      ]));
    };

    if (isVendor()) {
      add('vendor');
      return el('aside.sidebar#sidebar', {}, [...items, UI.companyLogo('in-sidebar')]);
    }

    add('home');
    add('board');
    if (may('view_vendor_boards')) add('vendorBoards');

    // הבלוק הזה כולו לא נבנה לספק — מסלול הספק חזר כבר למעלה עם רשימת הניווט שלו
    items.push(el('div.nav-group', { text: 'פרויקטים' }));
    const projectItem = (p) =>
      el(`button.nav-item${state.route.name === 'board' && state.route.params.projectId === p.id ? '.active' : ''}`, {
        onclick: () => navigate('board', { projectId: p.id })
      }, [
        el('span.ico', { text: '•' }),
        // minWidth: 0 הוא מה שמאפשר לשלוש הנקודות לעבוד בכלל: בלעדיו פריט בתוך flex
        // לא מתכווץ מתחת לרוחב הטקסט, ושם ארוך היה דוחף את המונה ואת כפתור הנעיצה
        // מחוץ לרוחב התפריט — כלומר הנעיצה הייתה נחתכת ולא ניתנת ללחיצה
        el('span', { text: p.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0' } }),
        el('span.count', { text: `${p.tasksDone}/${p.tasksTotal}` }),
        pinButton(p)
      ]);

    /**
     * השרת כבר מחזיר את הנעוצים בראש, אך את החלוקה מחשבים כאן מחדש כדי שהחוצץ
     * יישאר במקום הנכון גם אחרי סינון הפרויקטים שהושלמו.
     */
    const openProjects = state.projects.filter((p) => p.status !== 'done');
    const pinnedProjects = openProjects.filter((p) => p.pinned);
    const otherProjects = openProjects.filter((p) => !p.pinned);
    items.push(...pinnedProjects.map(projectItem));
    // חוצץ רק כששתי הקבוצות מאוכלסות — אחרת היה נראה כקו תלוש בראש הרשימה או בסופה
    if (pinnedProjects.length && otherProjects.length) items.push(el('div.nav-pinned-sep'));
    items.push(...otherProjects.map(projectItem));
    if (may('create_project')) {
      items.push(el('button.nav-item', { onclick: () => BoardView.openProjectDialog() }, [
        el('span.ico', { text: '＋' }), el('span', { text: 'פרויקט חדש' })
      ]));
    }

    items.push(el('div.nav-group', { text: 'כללי' }));
    add('archive');
    if (may('view_reports')) add('reports');
    // מנהל מחלקה מגיע לניהול ספקים ותבניות; מנהל מערכת מקבל גם משתמשים ואוטומציות
    if (may('manage_users') || may('manage_automations') || may('assign_task_to_vendor') || may('create_project')) {
      add('admin');
    }

    return el('aside.sidebar#sidebar', {}, [...items, UI.companyLogo('in-sidebar')]);
  }

  function topbar() {
    const bell = el('button.icon-btn', { title: 'התראות' }, [
      '🔔',
      el('span.badge-dot#notif-badge', { style: { display: state.unread ? 'grid' : 'none' } }, [String(state.unread)])
    ]);
    bell.addEventListener('click', () => toggleNotifPanel(bell));

    return el('header.topbar', {}, [
      el('button.icon-btn', {
        style: { display: window.innerWidth <= 900 ? 'grid' : 'none' },
        onclick: () => document.getElementById('sidebar')?.classList.toggle('open')
      }, ['☰']),
      el('div.brand', {}, [UI.logo({ size: 'sm', tagline: true, variant: 'brand' })]),
      globalSearch(),
      el('div.topbar-spacer'),
      !isVendor() && may('create_task')
        ? el('button.btn.btn-primary', { onclick: () => BoardView.openTaskDialog() }, ['＋ משימה חדשה'])
        : null,
      bell,
      el('button.user-chip', { onclick: userMenu }, [
        UI.avatar(state.actor.name, { vendor: isVendor() }),
        el('div', {}, [
          el('div.name', { text: state.actor.name }),
          el('div.role', { text: state.actor.roleLabel })
        ])
      ])
    ]);
  }

  function userMenu() {
    UI.modal({
      title: 'החשבון שלי',
      body: el('div', {}, [
        el('div.flex', { style: { gap: '12px', marginBottom: '16px' } }, [
          UI.avatar(state.actor.name, { vendor: isVendor() }),
          el('div', {}, [
            el('b', { text: state.actor.name }),
            el('div.mute-sm', { text: state.actor.email })
          ])
        ]),
        el('table.data', { style: { width: '100%' } }, [
          el('tbody', {}, [
            el('tr', {}, [el('th', { text: 'רמת גישה' }), el('td', { text: state.actor.roleLabel })]),
            state.actor.department ? el('tr', {}, [el('th', { text: 'מחלקה' }), el('td', { text: state.actor.department })]) : null,
            isVendor() ? el('tr', {}, [el('th', { text: 'הרשאת עדכון' }), el('td', { text: state.actor.readOnly ? 'צפייה בלבד' : 'מלאה' })]) : null
          ])
        ]),
        el('div.alert.alert-info.mt', {}, [
          el('div', {}, [
            el('b', { text: 'מה מותר לי במערכת?' }),
            el('div', { text: 'ההרשאות נקבעות לפי מטריצת ההרשאות של המחלקה. לשינוי — יש לפנות למנהל המערכת.' })
          ])
        ])
      ]),
      footer: [
        el('button.btn.btn-danger', { onclick: () => logout() }, ['התנתקות']),
        el('div.spacer'),
        el('button.btn', { onclick: () => document.querySelector('.modal-backdrop')?.remove() }, ['סגירה'])
      ]
    });
  }

  function render() {
    const content = el('main.main#main');
    UI.mount(root(), el('div.shell', {}, [
      topbar(),
      el('div.body', {}, [sidebar(), content])
    ]));
    UI.refitLogos(); // הסמל נבנה מחדש בכל רינדור — מיישרים את הכיתוב לרוחב השם
    const route = ROUTES[state.route.name] ?? ROUTES.home;
    route.render(content, state.route.params);
  }

  /** רענון התצוגה הנוכחית לאחר שינוי נתונים */
  async function refresh({ reference = false } = {}) {
    if (reference) await reloadReference();
    await refreshNotifications();
    render();
  }

  return {
    state, boot, navigate, refresh, refreshNotifications, logout, render,
    may, can, isVendor, userName, vendorName, project, internalBoard, vendorBoards,
    reloadReference
  };
})();

document.addEventListener('DOMContentLoaded', App.boot);
