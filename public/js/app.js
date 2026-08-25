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
    // העדפות תצוגה של המשתמש, כפי שהגיעו מהשרת ב-bootstrap
    prefs: {},
    route: { name: 'home', params: {} },
    homeData: null
  };

  /**
   * שמירת העדפת תצוגה. נכתבת מיד ל-‎state‎ כדי שהמסך יגיב בלי המתנה לרשת,
   * ונשלחת לשרת בהשהיה — בחירת חתך היא לחיצה אחת אחרי השנייה, ולא צריך
   * בקשה על כל אחת. ‎localStorage‎ נשאר במקביל כמטמון מקומי: הוא זמין
   * מיידית בטעינה, לפני שהשרת ענה.
   *
   * כשל ברשת אינו מוצג למשתמש — העדפת תצוגה שלא נשמרה אינה שווה הודעת
   * שגיאה, והמטמון המקומי ממילא זוכר אותה במכשיר הזה.
   */
  const prefTimers = {};
  function setPref(key, value) {
    state.prefs[key] = value;
    clearTimeout(prefTimers[key]);
    prefTimers[key] = setTimeout(() => {
      API.savePrefs({ [key]: value }).catch(() => {});
    }, 600);
  }

  const getPref = (key, fallback = null) => state.prefs?.[key] ?? fallback;

  const root = () => document.getElementById('app');

  // חתך רשימת הפרויקטים בתפריט — 'mine' או 'all'. נשמר במכשיר, לא בשרת.
  const PROJECT_SCOPE_KEY = 'mesimon.projectScope';

  /**
   * האם התפריט נעוץ פתוח. ברצועה מצומצמת צריך להעביר את העכבר בכל פעם כדי
   * לקרוא שם של פרויקט, ומי שעובד עם רשימת פרויקטים ארוכה רוצה אותה פרושה
   * כל הזמן. נעוץ — התוכן מפנה לו מקום ולא נדחף מתחתיו.
   */
  const SIDEBAR_PIN_KEY = 'mesimon.sidebarPinned';
  const sidebarPinned = () => localStorage.getItem(SIDEBAR_PIN_KEY) === '1';

  // מכמה פרויקטים תיבת החיפוש בתפריט מתחילה להופיע
  const PROJECT_SEARCH_MIN = 6;

  /**
   * רוחב התפריט הפרוש, בפיקסלים. נשמר במכשיר ונקבע כמשתנה CSS על השורש —
   * וכך הוא חל גם על הפרוש בריחוף, גם על הנעוץ וגם על השוליים של התוכן,
   * בלי לשכפל את המספר בשלושה מקומות.
   */
  const SIDEBAR_WIDTH_KEY = 'mesimon.sidebarWidth';
  const SIDEBAR_MIN = 210;
  const SIDEBAR_MAX = 520;
  const SIDEBAR_DEFAULT = 292;

  const savedSidebarWidth = () => {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!raw || Number.isNaN(raw)) return null;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
  };

  function applySidebarWidth(px) {
    const w = px ?? savedSidebarWidth();
    document.documentElement.style.setProperty('--sidebar-w', `${w ?? SIDEBAR_DEFAULT}px`);
  }

  /**
   * הרוחב שממנו המערכת עוברת לפריסת נייד. אותו מספר שב-mobile.css, ולכן הוא
   * נקרא משם דרך matchMedia ולא נכתב כאן שוב — שני מקומות היו נפרדים בשקט
   * ברגע שאחד מהם משתנה.
   */
  const PHONE_QUERY = window.matchMedia('(max-width: 820px)');
  const isPhone = () => PHONE_QUERY.matches;

  /**
   * מעבר בין פריסות בסיבוב המכשיר או בשינוי גודל החלון. בלי זה נשארו מצבים
   * שבורים: כפתור התפריט חושב פעם אחת לפי הרוחב, וסיבוב הטלפון השאיר את
   * הניווט בלתי נגיש או את המגירה פתוחה מעל פריסת מחשב.
   */
  let lastPhone = isPhone();
  const onViewportChange = () => {
    if (isPhone() === lastPhone) return;
    lastPhone = isPhone();
    closeDrawer();
    if (state.actor) render();
  };
  PHONE_QUERY.addEventListener('change', onViewportChange);

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

    // קישור הרשמה עצמית — נשלח לאישור מנהל, ולכן אינו מסתיים בכניסה למערכת
    const signupToken = SignupView.tokenFromUrl();
    if (signupToken) return SignupView.render(root(), signupToken);

    /**
     * כל כניסה למערכת פותחת סשן התראות חדש. האיפוס דווקא כאן, ולא רק
     * בהתנתקות, כי מי שנכנס עכשיו אינו בהכרח מי שיצא: סשן שפג באמצע העבודה
     * עוצר את הסקר אך מותיר בזיכרון את מזהי ההתראות של הקודם ואת הדגל
     * "כבר הוקפץ" — וכך המשתמש הבא באותה לשונית היה מוצף בכל ההתראות
     * שלא נקראו שלו בבת אחת, בדיוק מה שההשהיה הראשונה באה למנוע.
     */
    resetNotifSession();
    applySidebarWidth();

    try {
      const data = await API.bootstrap();
      Object.assign(state, data);
      await refreshNotifications();
      startNotifPolling();
      navigate(isVendor() ? 'vendor' : 'home');
      openTaskFromUrl();
      registerServiceWorker();
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

  /**
   * ‎?task=12‎ — קישור ישיר למשימה, כמו זה שנשלח בדואר ההקצאה. הפרמטר נמחק
   * מהכתובת אחרי הפתיחה, כדי שרענון הדף לא יפתח את הכרטיס שוב ושוב.
   */
  function openTaskFromUrl() {
    const id = Number(new URLSearchParams(location.search).get('task'));
    if (!id) return;
    history.replaceState(null, '', location.pathname);
    TaskCardView.open(id);
  }

  /**
   * רישום ה-Service Worker. אינו תנאי לעבודה — בלעדיו האפליקציה פשוט דורשת
   * רשת בכל פתיחה — ולכן כשל בו נרשם ליומן ואינו מפריע לטעינה. הוא גם אינו
   * נרשם ב-http, כי הדפדפן ממילא אינו מאפשר זאת מחוץ ל-localhost.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[משימון] רישום ה-Service Worker נכשל:', err.message);
    });
    /*
     * לחיצה על התראת מערכת ההפעלה מגיעה לכאן מה-Service Worker: הוא ממקד את
     * הלשונית ושולח את מזהה המשימה, ואנחנו פותחים את הכרטיס בלי לטעון מחדש.
     */
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-task' && event.data.taskId) {
        TaskCardView.open(Number(event.data.taskId));
      }
    });
  }

  // -------------------------------------------- התראות במחשב (מחוץ לדפדפן)

  /**
   * התראות מערכת ההפעלה — מה שרואים בפינת המסך בוואטסאפ ווב.
   *
   * למה זה נדרש: הכרטיס המוקפץ בתוך הדף עובד רק כשמסתכלים על הדף. מי שכותב
   * לעובד הודעה בתוך משימה מצפה שהיא תגיע אליו גם כשהוא עובד באקסל — ובלי
   * זה השרשור בתוך המשימה הוא תיבת דואר שנפתחת רק במקרה.
   *
   * מוצגות דרך ה-Service Worker ולא דרך ‎new Notification‎: כך הן נכנסות
   * למרכז ההתראות של Windows ונשארות בו, ולא נעלמות עם הלשונית. ‎new
   * Notification‎ נשאר כגיבוי לדפדפן שאין בו Service Worker.
   *
   * מקום ההתראה על המסך אינו בשליטת האפליקציה — Windows מציב אותו בפינה
   * שנקבעה בהגדרות המערכת (בממשק בעברית זו הפינה השמאלית).
   *
   * ההרשאה נדרשת מהמשתמש בלחיצה מפורשת ולא מעצמה: דפדפן חוסם בקשת הרשאה
   * שלא באה ממחווה של המשתמש, ובקשה שקופצת בכניסה הראשונה נדחית כמעט תמיד.
   */
  const DESKTOP_NOTIF_KEY = 'mesimon.desktopNotify';
  const DESKTOP_ASK_KEY = 'mesimon.desktopNotifyAsked';
  const supportsDesktopNotif = () => 'Notification' in window;

  /**
   * ‎'insecure'‎ הוא המצב שאי אפשר לנחש ממנו שמשהו לא בסדר: ב-HTTP רגיל
   * (למשל כניסה לשרת דרך כתובת ה-IP ברשת הפנימית) הדפדפן אינו חושף את
   * ‎Notification‎ כלל — הוא לא מבקש אישור ולא מודיע על שגיאה, פשוט שקט.
   * בלי המצב הזה הכפתור היה נראה שבור ולא היה שום הסבר למה.
   *
   * 'unsupported' | 'insecure' | 'default' | 'granted' | 'denied' | 'muted'
   */
  function desktopNotifState() {
    if (!window.isSecureContext) return 'insecure';
    if (!supportsDesktopNotif()) return 'unsupported';
    if (Notification.permission === 'granted') {
      return localStorage.getItem(DESKTOP_NOTIF_KEY) === '0' ? 'muted' : 'granted';
    }
    return Notification.permission;
  }

  async function enableDesktopNotifications() {
    if (!supportsDesktopNotif()) return 'unsupported';
    // הושתק במכשיר הזה בלבד — אין צורך לבקש הרשאה שוב, רק להסיר את ההשתקה
    if (Notification.permission === 'granted') {
      localStorage.setItem(DESKTOP_NOTIF_KEY, '1');
      return 'granted';
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') localStorage.setItem(DESKTOP_NOTIF_KEY, '1');
      return result;
    } catch {
      return Notification.permission;
    }
  }

  const muteDesktopNotifications = () => localStorage.setItem(DESKTOP_NOTIF_KEY, '0');

  /**
   * שורת ההצעה בראש המסך, כמו בוואטסאפ ווב.
   *
   * הכפתור במגירת ההתראות לבדו לא הספיק: מי שלא חשב לפתוח את המגירה לא ידע
   * שיש בכלל מה להפעיל, ולכן נראה כאילו הדפדפן אינו מבקש אישור. הבקשה עצמה
   * *חייבת* לצאת מלחיצה — דפדפן חוסם ‎requestPermission‎ שלא בא ממחווה של
   * המשתמש, ו-Chrome מעניש אתרים שמבקשים מיד בטעינה. לכן שורה שמזמינה
   * ללחוץ, ולא בקשה שקופצת מעצמה.
   *
   * נדחית לתמיד בלחיצה על "לא עכשיו": הצעה שחוזרת בכל כניסה היא נודניק,
   * והכפתור במגירת ההתראות נשאר שם למי שיתחרט.
   */
  function desktopNotifBanner() {
    if (desktopNotifState() !== 'default') return null;
    if (localStorage.getItem(DESKTOP_ASK_KEY) === '0') return null;
    if (isVendor()) return null;   // לספק אין שרשורים פנימיים שממתינים לו

    const bar = el('div.notif-invite', {}, [
      el('span', { text: '🔔' }),
      el('div', { text: 'להפעיל התראות במחשב? הודעה שנכתבת לך בתוך משימה תופיע בפינת המסך גם כשמשימון מוסתר.' }),
      el('button.btn.btn-sm.btn-primary', {
        onclick: async () => {
          const result = await enableDesktopNotifications();
          bar.remove();
          if (result === 'granted') UI.success('התראות במחשב הופעלו');
          else if (result === 'denied') {
            localStorage.setItem(DESKTOP_ASK_KEY, '0');
            UI.error('הדפדפן חסם את ההתראות. אפשר לאשר אותן בהגדרות האתר');
          }
        }
      }, ['הפעלה']),
      el('button.btn.btn-sm', {
        onclick: () => { localStorage.setItem(DESKTOP_ASK_KEY, '0'); bar.remove(); }
      }, ['לא עכשיו'])
    ]);
    return bar;
  }

  /**
   * ההתראה מוצגת רק כשהחלון אינו מול העיניים. כשהוא כן — הכרטיס המוקפץ
   * בתוך הדף כבר אמר את אותו דבר, והתראת מערכת נוספת עליו היא כפל רעש.
   * זו גם ההתנהגות בוואטסאפ ווב.
   */
  const windowIsWatched = () => !document.hidden && document.hasFocus();

  async function showDesktopNotification(n) {
    if (desktopNotifState() !== 'granted' || windowIsWatched()) return;
    if (!desktopKindEnabled(n.kind)) return;

    const parts = notifParts(n);

    /*
     * מבנה של הודעה בצ'אט: מי כתב ואיפה בכותרת, ומה הוא כתב בגוף. הגוף
     * שנשמר בשרת בנוי "שם המשימה — ההודעה", ושם המשימה כבר בכותרת — ולכן
     * הוא נחתך כאן. בלי זה שם המשימה מופיע פעמיים באותה התראה קטנה.
     */
    const taskTitle = n.taskTitle ?? '';
    const prefix = taskTitle ? `${taskTitle} — ` : '';
    const message = prefix && parts.body.startsWith(prefix)
      ? parts.body.slice(prefix.length)
      : parts.body;

    const title = parts.author === SYSTEM_AUTHOR
      ? (n.title || 'משימון')
      : [parts.author, taskTitle].filter(Boolean).join(' · ');

    /*
     * כשיש משימה בכותרת, הגוף הוא ההודעה עצמה. כשאין — למשל מינוי לאחראי
     * משימות בפרויקט, שאינו תלוי במשימה — ההסבר מה קרה חייב להיכנס לגוף,
     * אחרת ההתראה מציגה שם של אדם ושם של פרויקט בלי שום פועל שמקשר ביניהם.
     */
    const body = taskTitle
      ? (message || parts.headline)
      : [parts.headline, message].filter(Boolean).join(' — ');

    const options = {
      body: String(body || taskTitle).slice(0, 300),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      lang: 'he',
      dir: 'rtl',
      // ‎tag‎ לפי מזהה ההתראה — אותה התראה לא תוצג פעמיים אם הסקר חזר עליה
      tag: `mesimon-${n.id}`,
      /*
       * ההתראה נשארת על המסך עד שנוגעים בה, ואינה נעלמת אחרי כמה שניות.
       * זו כל הנקודה בהתראה שמגיעה כשלא מסתכלים: התראה שמופיעה ונעלמת בזמן
       * שאדם בפגישה או בחדר אחר לא הודיעה לו דבר. היא גם ממילא נשמרת במרכז
       * ההתראות של Windows, אך שם צריך לפתוח אותו כדי לדעת שיש בו משהו.
       */
      requireInteraction: true,
      data: { taskId: n.taskId ?? null, notificationId: n.id }
    };

    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg) return await reg.showNotification(title, options);
    } catch { /* נופלים לגיבוי שלמטה */ }
    try {
      const note = new Notification(title, options);
      note.onclick = () => {
        window.focus();
        if (n.taskId) TaskCardView.open(n.taskId);
        note.close();
      };
    } catch { /* הדפדפן סירב — אין מה לעשות, הכרטיס בדף עדיין מוצג */ }
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
    home: { label: 'דף הבית', icon: 'home', render: (c) => HomeView.render(c) },
    board: { label: 'לוח המשימות', icon: 'board', render: (c, p) => BoardView.render(c, { ...p, scope: 'internal' }) },
    vendorBoards: { label: 'כל משימות הספקים', icon: 'vendors', render: (c, p) => BoardView.render(c, { ...p, scope: 'vendors' }) },
    archive: { label: 'ארכיון', icon: 'archive', render: (c, p) => BoardView.render(c, { ...p, scope: 'internal', archived: true }) },
    reports: { label: 'דוחות', icon: 'reports', render: (c) => ReportsView.render(c) },
    admin: { label: 'ניהול המערכת', icon: 'admin', render: (c, p) => AdminView.render(c, p) },
    vendor: { label: 'המשימות שלי', icon: 'my-tasks', render: (c) => VendorPortalView.render(c) }
  };

  function navigate(name, params = {}) {
    state.route = { name, params };
    closeDrawer();
    render();
  }

  // ------------------------------------------------------------- התראות

  const NOTIF_POLL_MS = 30000;
  const NOTIF_POP_MAX = 3;      // כמה כרטיסים מקפיצים ממחזור אחד, גם אם הגיעו עשר התראות
  const SYSTEM_AUTHOR = 'המערכת';

  // פלטה אחת לסוגי ההתראות, משותפת למגירת ההתראות ולכרטיס המוקפץ
  const NOTIF_STYLE = {
    vendor_reminder: { mask: 'waiting', bg: '#fffbeb', color: '#d97706' },
    manager_alert: { mask: 'bell', bg: '#eff6ff', color: '#2563eb' },
    overdue: { mask: 'overdue', bg: '#fef2f2', color: '#dc2626' },
    escalation: { mask: 'urgent', bg: '#fef2f2', color: '#7c2d12' },
    mention: { icon: '@', bg: '#f0fdfa', color: '#0f766e' },
    status_change: { icon: '🔄', bg: '#f8fafc', color: '#475569' },
    assignment: { mask: 'my-tasks', bg: '#f5f3ff', color: '#7c3aed' },
    // הודעה בשרשור של משימה — הסוג היחיד שהוא שיחה בין אנשים ולא דיווח
    comment: { icon: '💬', bg: '#f0fdf4', color: '#15803d' },
    // משימה שפתחתי ומישהו אחר סגר
    completed: { icon: '✅', bg: '#f0fdf4', color: '#15803d' }
  };

  /**
   * קטלוג ההתראות, לבחירה במסך ניהול ההתראות.
   *
   * ‎desktop‎ הוא ברירת המחדל, לא נעילה: כל שורה כאן ניתנת לשינוי בידי
   * המשתמש. ברירת המחדל דולקת לכל מה שאדם אחר עשה ולמשימה שאיחרה, וכבויה
   * להתראות שמנוע האוטומציות מפיק *על* מישהו אחר (תזכורת שנשלחה לספק,
   * התראה מקדימה למנהל) — אלה מעניינות לקריאה ולא להקפצה מעל כל חלון.
   */
  const NOTIF_CATALOG = [
    { key: 'assignment', label: 'משימה ששוייכה לי, ומינוי לאחראי משימות בפרויקט', desktop: true },
    { key: 'comment', label: 'הודעה בשרשור של משימה שאני חלק ממנה', desktop: true },
    { key: 'mention', label: 'תיוג שלי (@) בתגובה', desktop: true },
    { key: 'completed', label: 'משימה שפתחתי והושלמה בידי אחר', desktop: true },
    { key: 'status_change', label: 'שינוי סטטוס, וחומר שספק הזין', desktop: true },
    { key: 'overdue', label: 'משימה שעברה את תאריך היעד', desktop: true },
    { key: 'escalation', label: 'הקפצת משימה דחופה שאינה זזה', desktop: false },
    { key: 'manager_alert', label: 'התראה מקדימה לפני תאריך היעד', desktop: false },
    { key: 'vendor_reminder', label: 'תזכורת שנשלחה לספק', desktop: false }
  ];

  const NOTIF_DESKTOP_DEFAULTS = Object.fromEntries(NOTIF_CATALOG.map((k) => [k.key, k.desktop]));

  /*
   * בחירה מפורשת של המשתמש גוברת; מה שלא נבחר נופל לברירת המחדל. שמירת
   * הבחירות בלבד, ולא העתק של כל הקטלוג, כדי שסוג התראה שיתווסף בעתיד יקבל
   * את ברירת המחדל שלו ולא ייחשב "כבוי" רק מפני שלא היה קיים בזמן השמירה.
   */
  const desktopKindEnabled = (kind) =>
    getPref('notifyKinds', {})?.[kind] ?? NOTIF_DESKTOP_DEFAULTS[kind] ?? false;

  /**
   * מה כבר ראינו בסשן הזה. ההבאה הראשונה רק ממלאת את הקבוצה ואינה מקפיצה דבר:
   * למי שנכנס בבוקר מחכות לפעמים עשרים התראות שלא נקראו, ועשרים כרטיסים
   * שנפתחים יחד מכסים את המסך במקום להודיע על חדש.
   */
  const seenNotifIds = new Set();
  let notifPrimed = false;
  let notifTimer = null;
  // מאזיני החזרה לחלון נרשמים פעם אחת לכל חיי הדף, ולא בכל התחברות מחדש
  let visibilityHooked = false;

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
   *
   * חלון ממוזער או מוסתר ממשיך לסקור, אבל הדפדפן מאט טיימרים בלשונית שאינה
   * נראית — ב-Chrome עד פעם בדקה. לכן נוסף סקר מיד כשחוזרים לחלון: מי שהיה
   * בפגישה ופתח את המסך מקבל את התמונה העדכנית באותו רגע, ולא ממתין למחזור
   * המואט הבא.
   */
  function startNotifPolling() {
    if (notifTimer) return;
    notifTimer = setInterval(refreshNotifications, NOTIF_POLL_MS);
    if (!visibilityHooked) {
      visibilityHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && notifTimer) refreshNotifications();
      });
      // חלון שהיה פתוח אך לא ממוקד אינו ‎hidden‎, ולכן ‎focus‎ הוא אירוע נפרד
      window.addEventListener('focus', () => { if (notifTimer) refreshNotifications(); });
    }
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

    /*
     * התראת מערכת ההפעלה לכל אחת מהחדשות — גם לאלה שלא נכנסו למגבלת
     * הכרטיסים בדף. שם המגבלה קיימת כדי לא לכסות את המסך, וכאן ממילא
     * Windows הוא שמנהל את התור ומקבץ אותן.
     */
    for (const n of fresh) showDesktopNotification(n);
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
      icon: style.mask ? UI.icon(style.mask, { size: 15 }) : style.icon,
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

  /**
   * שורת ההתראות במחשב, בראש מגירת ההתראות. זה המקום הטבעי לשאול עליה —
   * מי שפתח את רשימת ההתראות הוא מי שחושב עליהן כרגע.
   *
   * המצב "נדחה" אינו ניתן לתיקון מתוך הדף: דפדפן שנדחתה בו בקשת ההרשאה לא
   * ישאל שוב, וההחזרה נעשית רק בהגדרות האתר. לכן במצב הזה מוצג הסבר ולא
   * כפתור שלא יעשה כלום.
   */
  function desktopNotifRow(onChanged) {
    // ‎mode‎ ולא ‎state‎: ‎state‎ הוא מצב האפליקציה כולה, והצללה שלו כאן היא באג ממתין
    const mode = desktopNotifState();
    if (mode === 'unsupported') return null;

    const row = (children) => el('div.np-desktop', {}, children);

    if (mode === 'insecure') {
      return row([
        el('span', { text: '🔒' }),
        el('div', { text: `התראות במחשב זמינות רק בכתובת מאובטחת (https). הכתובת הנוכחית היא ${location.protocol}//${location.host}` })
      ]);
    }
    if (mode === 'denied') {
      return row([
        el('span', { text: '🔕' }),
        el('div', { text: 'התראות במחשב חסומות בדפדפן. לפתיחה: סמל המנעול שליד הכתובת ← התראות ← אפשר' })
      ]);
    }
    if (mode === 'granted') {
      return row([
        el('span', { text: '🔔' }),
        el('div', { text: 'התראות במחשב פעילות — הודעה במשימה תופיע גם כשהחלון מוסתר' }),
        el('button.btn.btn-sm', {
          onclick: () => { muteDesktopNotifications(); onChanged?.(); }
        }, ['השתקה'])
      ]);
    }

    // 'default' (טרם נשאל) או 'muted' (הושתק במכשיר הזה)
    return row([
      el('span', { text: '🔔' }),
      el('div', { text: mode === 'muted'
        ? 'התראות במחשב מושתקות במכשיר הזה'
        : 'להפעיל התראות במחשב? הודעה שנכתבת לך במשימה תופיע בפינת המסך גם כשמשימון מוסתר' }),
      el('button.btn.btn-sm.btn-primary', {
        onclick: async () => {
          const result = await enableDesktopNotifications();
          if (result === 'granted') UI.success('התראות במחשב הופעלו');
          else if (result === 'denied') UI.error('הדפדפן חסם את ההתראות. אפשר לאשר אותן בהגדרות האתר');
          onChanged?.();
        }
      }, [mode === 'muted' ? 'ביטול ההשתקה' : 'הפעלה'])
    ]);
  }

  /**
   * התראת בדיקה. נשלחת בלחיצה, ולכן החלון דווקא כן מול העיניים — ומשום כך
   * היא עוקפת את הבדיקה הרגילה שמונעת הקפצה בחלון פעיל. בדיקה שאינה מציגה
   * דבר אינה בדיקה.
   */
  async function sendTestNotification() {
    if (desktopNotifState() !== 'granted') return UI.error('ההתראות במחשב אינן פעילות');
    const options = {
      body: 'אם אתה רואה את זה — התראות המחשב עובדות. כך תיראה הודעה שנכתבת לך במשימה.',
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      lang: 'he', dir: 'rtl', tag: 'mesimon-test',
      requireInteraction: true, data: { taskId: null }
    };
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg) {
        await reg.showNotification('משימון · בדיקה', options);
        return UI.success('נשלחה התראת בדיקה — חפש אותה בפינת המסך');
      }
    } catch { /* גיבוי למטה */ }
    try {
      new Notification('משימון · בדיקה', options);
      UI.success('נשלחה התראת בדיקה');
    } catch (err) {
      UI.error(`לא ניתן להציג התראה: ${err.message}`);
    }
  }

  /**
   * ניהול התראות. מסך אישי ולא הגדרת מערכת — לכל אחד תפקיד אחר, ומה שחיוני
   * לאחד הוא רעש לאחר.
   *
   * הבחירה היא על ההקפצה בווינדוס בלבד, ולא על עצם קיום ההתראה: התראה
   * שנעלמת לגמרי פירושה שמשימה שהוקצתה לי לא תופיע בשום מקום, וזו תקלה ולא
   * העדפה. הרשימה במגירת ההתראות נשארת מלאה תמיד.
   */
  function notifSettingsDialog() {
    const body = el('div');

    const draw = () => {
      const mode = desktopNotifState();

      const header = mode === 'insecure'
        ? el('div.alert.alert-danger', {}, [
            el('span', { text: '🔒' }),
            el('div', { text: `התראות במחשב זמינות רק בכתובת מאובטחת (https). הכתובת הנוכחית היא ${location.protocol}//${location.host}` })
          ])
        : mode === 'unsupported'
          ? el('div.alert.alert-danger', {}, [
              el('span', { text: '🚫' }),
              el('div', { text: 'הדפדפן הזה אינו תומך בהתראות מערכת.' })
            ])
          : mode === 'denied'
            ? el('div.alert.alert-danger', {}, [
                el('span', { text: '🔕' }),
                el('div', { text: 'ההתראות חסומות בדפדפן. לפתיחה: סמל המנעול שליד הכתובת ← התראות ← אפשר. אחרי השינוי יש לרענן את הדף.' })
              ])
            : mode === 'granted'
              ? el('div.alert.alert-ok', {}, [
                  el('span', { text: '🔔' }),
                  el('div', { text: 'התראות במחשב פעילות. הן מוצגות כשחלון משימון אינו מול העיניים.' }),
                  el('div.flex', { style: { gap: '6px', flex: 'none' } }, [
                    el('button.btn.btn-sm', { onclick: () => sendTestNotification() }, ['בדיקה']),
                    el('button.btn.btn-sm', {
                      onclick: () => { muteDesktopNotifications(); draw(); }
                    }, ['השתקה'])
                  ])
                ])
              : el('div.alert.alert-info', {}, [
                  el('span', { text: '🔔' }),
                  el('div', { text: mode === 'muted'
                    ? 'ההתראות מושתקות במכשיר הזה. ההגדרות שלמטה יחזרו לפעול עם ביטול ההשתקה.'
                    : 'ההתראות במחשב עדיין לא הופעלו. ההגדרות שלמטה ייכנסו לתוקף לאחר ההפעלה.' }),
                  el('button.btn.btn-sm.btn-primary', {
                    style: { flex: 'none' },
                    onclick: async () => {
                      const r = await enableDesktopNotifications();
                      if (r === 'denied') UI.error('הדפדפן חסם את ההתראות');
                      draw();
                    }
                  }, [mode === 'muted' ? 'ביטול ההשתקה' : 'הפעלה'])
                ]);

      const rows = NOTIF_CATALOG.map((k) => {
        const box = el('input', { type: 'checkbox', checked: desktopKindEnabled(k.key) });
        box.addEventListener('change', () => {
          // נשמרות הבחירות בלבד — ראה ההערה ליד NOTIF_DESKTOP_DEFAULTS
          setPref('notifyKinds', { ...(getPref('notifyKinds', {}) ?? {}), [k.key]: box.checked });
        });
        const style = NOTIF_STYLE[k.key] ?? NOTIF_STYLE.status_change;
        return el('tr', {}, [
          el('td', {}, [
            el('div.flex', {}, [
              el('span.n-icon', { style: { background: style.bg, color: style.color } },
                [style.mask ? UI.icon(style.mask, { size: 14 }) : style.icon]),
              el('span', { text: k.label })
            ])
          ]),
          el('td', { style: { textAlign: 'center', width: '110px' } }, [el('label.checkbox', {}, [box])])
        ]);
      });

      UI.mount(body,
        header,
        el('div.table-wrap.mt', {}, [
          el('table.data', {}, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'סוג ההתראה' }),
              el('th', { text: 'קפיצה במחשב', style: { textAlign: 'center' } })
            ])]),
            el('tbody', {}, rows)
          ])
        ]),
        el('div.alert.alert-info.mt', {}, [
          el('span', { text: 'ℹ️' }),
          el('div', { text: 'הכיבוי חל על הקפיצה בפינת המסך בלבד. כל ההתראות ממשיכות להופיע ברשימה שמתחת לפעמון, כדי שדבר לא ייעלם.' })
        ])
      );
    };

    draw();
    UI.modal({
      title: 'ניהול התראות',
      body,
      footer: [
        el('div.spacer'),
        el('button.btn', { onclick: () => document.querySelector('.modal-backdrop')?.remove() }, ['סגירה'])
      ]
    });
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
          : null,
        el('button.btn.btn-sm', {
          title: 'ניהול התראות — מה קופץ בפינת המסך',
          onclick: () => { panel.remove(); notifSettingsDialog(); }
        }, ['⚙'])
      ]),
      desktopNotifRow(() => { panel.remove(); toggleNotifPanel(anchor); }),
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
              el('div.n-icon', { style: { background: style.bg, color: style.color } },
                [style.mask ? UI.icon(style.mask, { size: 15 }) : style.icon]),
              el('div.n-body', {}, [
                el('b', { text: n.title }),
                n.body ? el('div', { text: n.body, style: { fontSize: '12.5px' } }) : null,
                el('small', { text: UI.relative(n.createdAt) })
              ])
            ]);
          })
        : [UI.empty('אין התראות חדשות', UI.icon('bell'))])
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
    }, [UI.icon('pin')]);

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

  /**
   * סדר הפרויקטים בתפריט, כפי שהמשתמש סידר אותם בגרירה.
   *
   * העדפה אישית ולא הגדרה של הפרויקט: לכל אחד סדר עבודה משלו, ומי שגורר את
   * "רכבים" לראש הרשימה אינו מחליט זאת בשביל כל החברה. נשמר בשרת כמו שאר
   * העדפות התצוגה, ולכן הסדר זהה במחשב ובטלפון.
   *
   * נשמרים מזהים בלבד, וכל מה שאינו ברשימה נופל לסופה בסדר המקורי — כך
   * פרויקט חדש אינו נעלם ואינו קופץ לראש, ופרויקט שנמחק אינו משאיר חור.
   */
  function orderProjects(list) {
    const saved = getPref('projectOrder');
    if (!Array.isArray(saved) || !saved.length) return list;
    const rank = new Map(saved.map((id, i) => [Number(id), i]));
    const at = (p) => (rank.has(p.id) ? rank.get(p.id) : Number.MAX_SAFE_INTEGER);
    // סדר מקורי כשובר שוויון — ‎sort‎ יציב, ולכן די בהשוואת הדירוג
    return [...list].sort((a, b) => at(a) - at(b));
  }

  /**
   * גרירת שורות בתוך קבוצה אחת. HTML5 drag-and-drop ולא מצביע גולמי: הוא נותן
   * בחינם את סמן הגרירה, את התמונה הנגררת ואת התנהגות הגלילה בקצה הרשימה.
   *
   * הגרירה מוגבלת לקבוצה — נעוצים בין נעוצים, שאר בין שאר. משיכת פרויקט לא
   * נעוץ מעל נעוץ הייתה מבטלת בשקט את משמעות הנעיצה ("לראש הרשימה"), וזה
   * מבלבל יותר ממה שהוא פותר.
   */
  function makeReorderable(entries, onOrder) {
    if (entries.length < 2) return;
    let dragged = null;

    for (const { p, node } of entries) {
      node.draggable = true;
      node.classList.add('nav-draggable');

      node.addEventListener('dragstart', (e) => {
        dragged = { p, node };
        node.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // נדרש ב-Firefox, שאינו מתחיל גרירה בלי מטען
        e.dataTransfer.setData('text/plain', String(p.id));
      });

      node.addEventListener('dragend', () => {
        node.classList.remove('dragging');
        for (const x of entries) x.node.classList.remove('drop-before', 'drop-after');
        dragged = null;
      });

      node.addEventListener('dragover', (e) => {
        if (!dragged || dragged.node === node) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // חצי עליון = לפני, חצי תחתון = אחרי. סימון ויזואלי לאן זה ייפול
        const box = node.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        node.classList.toggle('drop-before', !after);
        node.classList.toggle('drop-after', after);
      });

      node.addEventListener('dragleave', () => {
        node.classList.remove('drop-before', 'drop-after');
      });

      node.addEventListener('drop', (e) => {
        if (!dragged || dragged.node === node) return;
        e.preventDefault();
        const box = node.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;

        const ids = entries.map((x) => x.p.id).filter((id) => id !== dragged.p.id);
        const target = ids.indexOf(p.id);
        ids.splice(after ? target + 1 : target, 0, dragged.p.id);
        onOrder(ids);
      });
    }
  }

  function sidebar() {
    const items = [];

    /**
     * נעיצה. הכפתור בראש התפריט ולא בהגדרות: זו החלטה שמשנים תוך עבודה,
     * לפי מה שעושים כרגע, ולא פעם אחת בחיים.
     */
    const pinned = sidebarPinned();
    items.push(el('button.nav-item.nav-pin-toggle', {
      title: pinned ? 'שחרור הנעיצה — התפריט יתכנס לרצועת אייקונים' : 'נעיצת התפריט פתוח',
      onclick: () => {
        localStorage.setItem(SIDEBAR_PIN_KEY, pinned ? '0' : '1');
        refreshChrome();
      }
    }, [
      el('span.ico', { text: pinned ? '⇥' : '⇤' }),
      el('span', { text: pinned ? 'כיווץ התפריט' : 'נעיצת התפריט' })
    ]));
    const add = (name, params, extra = {}) => {
      const route = ROUTES[name];
      items.push(el(`button.nav-item${state.route.name === name && !extra.matchParam ? '.active' : ''}`, {
        onclick: () => navigate(name, params ?? {})
      }, [
        el('span.ico', {}, [extra.icon ? extra.icon : UI.icon(route.icon)]),
        el('span', { text: extra.label ?? route.label }),
        extra.count !== undefined ? el('span.count', { text: String(extra.count) }) : null
      ]));
    };

    if (isVendor()) {
      add('vendor');
      return el(`aside.sidebar#sidebar${sidebarPinned() ? '.pinned' : ''}`, {}, [...items, UI.companyLogo('in-sidebar')]);
    }

    add('home');
    add('board');
    if (may('view_vendor_boards')) add('vendorBoards');

    // הבלוק הזה כולו לא נבנה לספק — מסלול הספק חזר כבר למעלה עם רשימת הניווט שלו
    const projectItem = (p) =>
      el(`button.nav-item${state.route.name === 'board' && state.route.params.projectId === p.id ? '.active' : ''}`, {
        onclick: () => navigate('board', { projectId: p.id })
      }, [
        // הלוגו כשיש, ואחרת נקודה בצבע הפרויקט — אותו סימן שבשורות המשימות שלו
        el('span.ico', {}, [
          p.logoId
            ? el('img.nav-logo', { src: `/api/project-images/${p.logoId}/view`, alt: '' })
            : el('span.project-dot', { style: { background: p.color, margin: '0' } })
        ]),
        // minWidth: 0 הוא מה שמאפשר לשלוש הנקודות לעבוד בכלל: בלעדיו פריט בתוך flex
        // לא מתכווץ מתחת לרוחב הטקסט, ושם ארוך היה דוחף את המונה ואת כפתור הנעיצה
        // מחוץ לרוחב התפריט — כלומר הנעיצה הייתה נחתכת ולא ניתנת ללחיצה
        // ‎title‎ מלא, כי גם בשתי שורות שם ארוך במיוחד עוד עשוי להיחתך
        el('span.nav-name', { text: p.name, title: p.name }),
        el('span.count', { text: `${p.tasksDone}/${p.tasksTotal}` }),
        pinButton(p)
      ]);

    /**
     * השרת כבר מחזיר את הנעוצים בראש, אך את החלוקה מחשבים כאן מחדש כדי שהחוצץ
     * יישאר במקום הנכון גם אחרי סינון הפרויקטים שהושלמו.
     */
    const live = state.projects.filter((p) => p.status !== 'done');

    /**
     * למנהל מערכת יש גם עבודה משלו, ורשימה שמערבבת את הפרויקטים שלו עם כל
     * פרויקט בארגון אינה משרתת אף אחד מהשניים. לכן כשיש פרויקטים שאינם שלו
     * מוצג מעבר, וברירת המחדל היא שלו. הבחירה נשמרת במכשיר — מי שעובד תמיד
     * בחתך אחד לא יבחר אותו מחדש בכל טעינה.
     */
    const mineCount = live.filter((p) => p.mine).length;
    const foreign = live.length - mineCount;
    const saved = localStorage.getItem(PROJECT_SCOPE_KEY);
    /**
     * ברירת המחדל היא "שלי", אבל רק כשיש כאלה: מנהל מערכת שלא פתח פרויקט
     * ואינו מנהל אף אחד היה מקבל רשימה ריקה, וזה גרוע יותר מרשימה מעורבת.
     */
    const showAll = foreign > 0 && (saved === 'all' || (!saved && mineCount === 0));
    const openProjects = foreign > 0 && !showAll ? live.filter((p) => p.mine) : live;

    const ordered = orderProjects(openProjects);
    const pinnedProjects = ordered.filter((p) => p.pinned);
    const otherProjects = ordered.filter((p) => !p.pinned);

    /**
     * הרשימה מכילה רק את הפרויקטים של המשתמש, ולכן היא עשויה להיות ריקה
     * לגמרי — ואז גם הכותרת "פרויקטים" מיותרת ולא נבנית, כדי שלא תישאר
     * כותרת תלויה באוויר בלי דבר תחתיה.
     */
    if (openProjects.length || foreign || may('create_project')) {
      items.push(el('div.nav-group.with-action', {}, [
        el('span', { text: 'פרויקטים' }),
        foreign
          ? el('button.nav-scope', {
              title: showAll
                ? `מוצגים כל ${live.length} הפרויקטים בארגון — מעבר לשלי בלבד`
                : `מוצגים הפרויקטים שלי — מעבר לכל ${live.length} שבארגון`,
              onclick: () => {
                localStorage.setItem(PROJECT_SCOPE_KEY, showAll ? 'mine' : 'all');
                refreshChrome();
              }
            }, [showAll ? `כל הארגון · ${live.length}` : `שלי · ${openProjects.length}`])
          : null
      ]));
    }
    /**
     * חיפוש פרויקט. מופיע רק מ-‎PROJECT_SEARCH_MIN‎ פרויקטים ומעלה — בחמישה
     * פרויקטים תיבת חיפוש היא רעש, ובעשרים היא הדרך המהירה היחידה.
     *
     * הסינון מתבצע על הצמתים שכבר בנויים ולא בבנייה מחדש של התפריט: בנייה
     * מחדש בכל הקשה הייתה מחליפה את תיבת החיפוש עצמה ומאבדת את המיקוד
     * והטקסט שהוקלד.
     */
    const pinnedNodes = pinnedProjects.map((p) => ({ p, node: projectItem(p) }));
    const otherNodes = otherProjects.map((p) => ({ p, node: projectItem(p) }));
    const projectNodes = [...pinnedNodes, ...otherNodes];
    const separator = pinnedProjects.length && otherProjects.length ? el('div.nav-pinned-sep') : null;

    /*
     * הסדר החדש נשמר כרשימה של *כל* הפרויקטים הגלויים, ולא של הקבוצה שנגררה
     * בלבד: אחרת גרירה בתוך הנעוצים הייתה מוחקת את הסדר של השאר.
     */
    const commitOrder = (groupIds, groupKey) => {
      const full = groupKey === 'pinned'
        ? [...groupIds, ...otherProjects.map((p) => p.id)]
        : [...pinnedProjects.map((p) => p.id), ...groupIds];
      setPref('projectOrder', full);
      refreshChrome();
    };
    makeReorderable(pinnedNodes, (ids) => commitOrder(ids, 'pinned'));
    makeReorderable(otherNodes, (ids) => commitOrder(ids, 'other'));

    if (openProjects.length >= PROJECT_SEARCH_MIN) {
      const search = el('input.nav-search', { type: 'search', placeholder: 'חיפוש פרויקט…' });
      const noMatch = el('div.nav-note', { text: 'אין פרויקט מתאים', style: { display: 'none' } });

      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const { p, node } of projectNodes) {
          const hit = !q || p.name.toLowerCase().includes(q);
          node.style.display = hit ? '' : 'none';
          if (hit) shown++;
        }
        // החוצץ בין הנעוצים לשאר מאבד משמעות בזמן סינון
        if (separator) separator.style.display = q ? 'none' : '';
        noMatch.style.display = shown ? 'none' : '';
      });
      // Escape מנקה ומחזיר את הרשימה המלאה, בלי לצאת מהתפריט
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        search.value = '';
        search.dispatchEvent(new Event('input'));
      });

      items.push(el('div.nav-search-wrap', {}, [search]));
      items.push(...projectNodes.map((x) => x.node));
      if (separator) items.splice(items.length - otherProjects.length, 0, separator);
      items.push(noMatch);
    } else {
      items.push(...projectNodes.filter((x) => x.p.pinned).map((x) => x.node));
      // חוצץ רק כששתי הקבוצות מאוכלסות — אחרת היה נראה כקו תלוש בראש או בסוף
      if (separator) items.push(separator);
      items.push(...projectNodes.filter((x) => !x.p.pinned).map((x) => x.node));
    }
    // הסבר קצר כשהרשימה ריקה רק מפני שהחתך מצומצם, ולא מפני שאין פרויקטים
    if (!openProjects.length && foreign) {
      items.push(el('div.nav-note', { text: 'אין פרויקטים שאתה חלק מהם' }));
    }
    if (may('create_project')) {
      items.push(el('button.nav-item', { onclick: () => BoardView.openProjectDialog() }, [
        el('span.ico', { text: '＋' }), el('span', { text: 'פרויקט חדש' })
      ]));
    }

    items.push(el('div.nav-group', { text: 'כללי' }));
    add('archive');
    if (may('view_reports')) add('reports');
    // מנהל מחלקה מגיע לניהול ספקים ותבניות; מנהל מערכת מקבל גם משתמשים ואוטומציות
    // עובד פנימי פותח פרויקטים ברמת 'own' ואין לו מה לעשות במסך הניהול,
    // ולכן כאן נדרשת הרשאה מלאה לפרויקטים ולא עצם היכולת לפתוח אחד
    if (may('manage_users') || may('manage_automations') || may('assign_task_to_vendor') || can('create_project')) {
      add('admin');
    }

    return el(`aside.sidebar#sidebar${sidebarPinned() ? '.pinned' : ''}`, {},
      [...items, UI.companyLogo('in-sidebar'), resizeHandle()]);
  }

  /**
   * ידית לשינוי רוחב התפריט. גרירה קובעת רוחב, לחיצה כפולה מחזירה לברירת
   * המחדל. מוצגת רק בפריסת מחשב (ב-CSS) — בטלפון התפריט הוא מגירה ברוחב קבוע.
   *
   * ‎pointer‎ ולא ‎mouse‎: אותו קוד מטפל גם בעכבר וגם במסך מגע של מחשב נייד,
   * ו-‎setPointerCapture‎ מבטיח שהגרירה נמשכת גם כשהסמן יוצא מהידית — בלעדיו
   * גרירה מהירה "נשמטת" באמצע.
   */
  function resizeHandle() {
    /*
     * ‎button‎ ולא ‎div‎: כך הידית מגיעה בטאב ואפשר להרחיב את התפריט בחצים,
     * בלי לתפוס רצועה של 12 פיקסלים בעכבר. גרירה בעכבר עדיין הדרך המהירה,
     * אבל היא כבר לא הדרך *היחידה*.
     */
    const handle = el('button.sidebar-resize', {
      type: 'button',
      title: 'גרירה לשינוי הרוחב · חצים ← → · לחיצה כפולה לאיפוס',
      'aria-label': 'רוחב התפריט',
      role: 'separator',
      'aria-orientation': 'vertical'
    });

    const setWidth = (px) => {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
      applySidebarWidth(w);
      handle.setAttribute('aria-valuenow', String(w));
      return w;
    };
    setWidth(savedSidebarWidth() ?? SIDEBAR_DEFAULT);
    handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
    handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));

    // במסמך RTL התפריט בימין: חץ שמאלה מרחיב, חץ ימינה מצמצם
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const current = savedSidebarWidth() ?? SIDEBAR_DEFAULT;
      let next = null;
      if (e.key === 'ArrowLeft') next = current + step;
      else if (e.key === 'ArrowRight') next = current - step;
      else if (e.key === 'Home') next = SIDEBAR_DEFAULT;
      if (next === null) return;
      e.preventDefault();
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(setWidth(next)));
    });

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      // בזמן גרירה אין בחירת טקסט, אחרת כל המסך נצבע בכחול
      document.body.style.userSelect = 'none';

      const bar = document.getElementById('sidebar');
      const startRight = bar.getBoundingClientRect().right;

      // המסמך RTL והתפריט בצד ימין — הרוחב הוא המרחק מקצהו הימני שמאלה
      const onMove = (ev) => setWidth(startRight - ev.clientX);
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        const now = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
        if (now) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(now));
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    handle.addEventListener('dblclick', () => {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      setWidth(SIDEBAR_DEFAULT);
      UI.toast('רוחב התפריט אופס');
    });

    return handle;
  }

  function topbar() {
    const bell = el('button.icon-btn', { title: 'התראות' }, [
      UI.icon('bell', { size: 19 }),
      el('span.badge-dot#notif-badge', { style: { display: state.unread ? 'grid' : 'none' } }, [String(state.unread)])
    ]);
    bell.addEventListener('click', () => toggleNotifPanel(bell));

    return el('header.topbar', {}, [
      // הנראות נקבעת ב-CSS ולא כאן: חישוב רוחב חד-פעמי ב-JS השאיר את הכפתור
      // מוסתר אחרי סיבוב המכשיר, ואז לא הייתה דרך להגיע לניווט
      el('button.icon-btn.drawer-btn', { onclick: toggleDrawer }, ['☰']),
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
          // רמת הגישה מוצגת רק למי שרשאי לראות רמות; לשאר מוצגת המחלקה
          el('div.role', { text: state.actor.roleLabel ?? state.actor.department ?? (isVendor() ? 'ספק חיצוני' : '') })
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
            state.actor.roleLabel
              ? el('tr', {}, [el('th', { text: 'רמת גישה' }), el('td', { text: state.actor.roleLabel })])
              : null,
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

  /** סגירת מגירת הניווט. נקראת גם בניווט, גם בלחיצה על הרקע וגם ב-Escape. */
  function closeDrawer() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-veil')?.classList.remove('open');
  }

  function toggleDrawer() {
    const bar = document.getElementById('sidebar');
    const veil = document.querySelector('.sidebar-veil');
    const open = !bar?.classList.contains('open');
    bar?.classList.toggle('open', open);
    veil?.classList.toggle('open', open);
  }

  /**
   * הניווט התחתון. ארבעה יעדים בלבד — אלה שנעשים מהטלפון. השאר (ניהול,
   * דוחות, ארכיון, בורדי ספקים) נשארים במגירה, כי הם מסכים של מחשב.
   */
  function tabbar() {
    const tab = (routeName, iconName, label, extra = {}) => {
      const active = state.route.name === routeName;
      return el(`button${active ? '.active' : ''}`, {
        onclick: () => { closeDrawer(); navigate(routeName, extra.params ?? {}); }
      }, [
        el('span.ic-wrap', {}, [
          UI.icon(iconName),
          extra.badge ? el('span.tab-dot', { text: String(extra.badge) }) : null
        ]),
        el('span.lbl', { text: label })
      ]);
    };

    if (isVendor()) {
      return el('nav.tabbar', {}, [
        tab('vendor', 'my-tasks', 'המשימות שלי'),
        el('button', { onclick: () => toggleNotifPanel(null) }, [
          el('span.ic-wrap', {}, [UI.icon('bell'), state.unread ? el('span.tab-dot', { text: String(state.unread) }) : null]),
          el('span.lbl', { text: 'התראות' })
        ])
      ]);
    }

    return el('nav.tabbar', {}, [
      tab('home', 'my-tasks', 'המשימות שלי'),
      tab('board', 'board', 'הלוח'),
      el('button', { onclick: () => toggleNotifPanel(null) }, [
        el('span.ic-wrap', {}, [UI.icon('bell'), state.unread ? el('span.tab-dot', { text: String(state.unread) }) : null]),
        el('span.lbl', { text: 'התראות' })
      ]),
      el(`button${state.route.name === 'admin' ? '.active' : ''}`, { onclick: toggleDrawer }, [
        el('span.ic-wrap', {}, [UI.icon('admin')]),
        el('span.lbl', { text: 'עוד' })
      ])
    ]);
  }

  function render() {
    const content = el('main.main#main');
    const phone = isPhone();

    UI.mount(root(), el(`div.shell${!phone && sidebarPinned() ? '.rail-pinned' : ''}`, {}, [
      topbar(),
      desktopNotifBanner(),
      el('div.body', {}, [sidebar(), content]),
      // הרקע והניווט התחתון נבנים תמיד; ב-CSS הם מוצגים רק בפריסת נייד
      el('div.sidebar-veil', { onclick: closeDrawer }),
      phone ? tabbar() : null,
      phone && !isVendor() && may('create_task')
        ? el('button.fab', { title: 'משימה חדשה', onclick: () => BoardView.openTaskDialog() }, ['＋'])
        : null
    ]));
    UI.refitLogos(); // הסמל נבנה מחדש בכל רינדור — מיישרים את הכיתוב לרוחב השם

    const route = ROUTES[state.route.name] ?? ROUTES.home;
    /**
     * בטלפון מסך הבית הוא דשבורד אחר לגמרי, ולא הדשבורד של המחשב בפריסה צרה:
     * שם יש טבלה ברוחב מינימלי של 920 פיקסלים וסרגל של שש רשימות נפתחות, ואין
     * דרך לכווץ אותם למשהו שאפשר לעבוד בו על 390 פיקסלים.
     */
    if (phone && state.route.name === 'home' && !isVendor()) MobileView.render(content);
    else route.render(content, state.route.params);
  }

  /** רענון התצוגה הנוכחית לאחר שינוי נתונים */
  async function refresh({ reference = false } = {}) {
    if (reference) await reloadReference();
    await refreshNotifications();
    render();
  }

  /**
   * ריענון המסגרת בלבד — הסרגל העליון ותפריט הצד — בלי לגעת בתוכן המסך.
   * ‎render()‎ בונה מחדש גם את ‎main‎, וכל הרצתו אחרי שינוי קטן נראית למשתמש
   * כרענון של כל האתר: המסך מהבהב, הגלילה קופצת לראש והמיקוד אובד.
   */
  function refreshChrome() {
    const shell = root().querySelector('.shell');
    if (!shell) return;
    shell.querySelector('.topbar')?.replaceWith(topbar());
    shell.querySelector('#sidebar')?.replaceWith(sidebar());
    // מצב הנעיצה יושב על השלד — הוא מה שקובע כמה מקום התוכן מפנה לתפריט
    shell.classList.toggle('rail-pinned', !isPhone() && sidebarPinned());
    UI.refitLogos(); // הסמל נבנה מחדש — מיישרים שוב את הכיתוב לרוחב השם
  }

  /**
   * ריענון תוכן המסך הנוכחי ברקע. כל מסך יודע לטעון את עצמו מחדש בלי ספינר
   * ובלי לאבד גלילה, ולכן עדכון משימה כבר אינו מחייב בנייה מחדש של האתר.
   */
  const RELOADABLE = {
    home: () => (isPhone() && !isVendor() ? MobileView.reload() : HomeView.reload()),
    board: () => BoardView.reload({ silent: true }),
    vendorBoards: () => BoardView.reload({ silent: true }),
    archive: () => BoardView.reload({ silent: true }),
    vendor: () => VendorPortalView.reload({ silent: true })
  };

  async function refreshView() {
    const reload = RELOADABLE[state.route.name];
    // מסך שאין לו טעינה נקודתית (ניהול, דוחות) נבנה מחדש כרגיל
    if (!reload) return render();
    try {
      await reload();
    } catch {
      /* כשל בריענון ברקע אינו מפיל את המסך — התוכן הקיים נשאר על המסך */
    }
  }

  return {
    state, boot, navigate, refresh, refreshNotifications, logout, render,
    refreshChrome, refreshView, isPhone, closeDrawer, setPref, getPref,
    may, can, isVendor, userName, vendorName, project, internalBoard, vendorBoards,
    reloadReference
  };
})();

document.addEventListener('DOMContentLoaded', App.boot);
