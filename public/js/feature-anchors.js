'use strict';
/**
 * קטלוג העוגנים של "מה חדש" — כל מקום במערכת שפריט בבאנר יכול להצביע עליו.
 *
 * עוגן הוא שם קבוע (‎home.move-due‎) שאומר: באיזה מסך, איך מגיעים אליו,
 * ואיזה אלמנט מגדילים. הבאנר מציג את המסך החי של המשתמש ומתקרב אל האלמנט,
 * "הראו לי" מדגיש אותו במסך האמיתי, וסריקת ה-AI בוחרת עוגן לכל פריט מתוך
 * הרשימה הזו בלבד.
 *
 * למה קובץ אחד לשני הצדדים: השרת בודק שהעוגן שנשמר קיים, ומעביר את הרשימה
 * ל-AI; הדפדפן מנווט ומחפש את האלמנט. שתי רשימות היו מתפצלות בשקט, ופריט
 * היה מתפרסם עם עוגן שהממשק כבר אינו מכיר. לכן כאן רק נתונים — בלי
 * פונקציות — והשרת טוען את אותו קובץ ב-‎require‎.
 *
 * השדות:
 *   key       — השם הקבוע. לא משנים שם של עוגן קיים: פריטים שפורסמו נשענים עליו.
 *   label     — מה מנהל המערכת רואה בבחירה, וה-AI בהנחיה.
 *   screen    — אותם מפתחות כמו רשימת המסכים של "מה חדש" (‎SCREENS‎ בשרת).
 *   route     — לאן מנווטים (‎App.navigate‎), ו-‎params‎ אם צריך. ‎null‎ — המסך
 *               הנוכחי (הסרגל העליון קיים בכל מסך).
 *   selector  — איך מוצאים את האלמנט. כשלא צוין: ‎[data-anchor="key"]‎. נלקח
 *               המופע הגלוי הראשון, ולכן אפשר לפרט כמה חלופות (מחשב / טלפון).
 *   prepare   — פעולה לפני החיפוש, כשהחידוש נמצא בתוך חלון: ‎account‎ (החשבון
 *               שלי), ‎notifications‎, ‎search‎ (Ctrl+K), ‎aiTask‎ (משימת AI ריקה),
 *               ‎newTask‎ (משימה חדשה ריקה), ‎taskCard‎ (כרטיס של משימה מהלוח),
 *               ‎timeline‎ (ציר הזמן בלוח). בזרקור שבבאנר אף לחיצה אינה נשמרת.
 *   fallback  — עוגן אחר להתקרב אליו כשהאלמנט עצמו אינו קיים כרגע (למשל
 *               חתימה שמופיעה רק אחרי ניסוח).
 *   viewport  — ‎phone‎: הזרקור מוצג בגודל טלפון גם במחשב.
 *
 * עוגן חדש: מוסיפים שורה כאן, ואם אין לאלמנט מחלקה יציבה — מוסיפים לו
 * ‎data-anchor‎ בקוד המסך.
 */
(function (root) {
  const ANCHORS = [
    // ----- כללי: הסרגל העליון, קיים בכל מסך
    { key: 'app.search', label: 'חיפוש ומעבר מהיר (Ctrl+K)', screen: 'general', route: 'home',
      selector: '.global-search, .m-search-btn' },
    { key: 'app.notifications', label: 'פעמון ההתראות', screen: 'general', route: null, selector: '.notif-bell, .tabbar button:nth-child(4)' },
    { key: 'app.notif-drawer', label: 'מגירת ההתראות המקובצות', screen: 'general', route: null,
      selector: '#notif-panel, .notif-sheet', prepare: 'notifications' },
    { key: 'app.account', label: 'החשבון שלי (העיגול בפינה)', screen: 'general', route: null, selector: '.user-chip' },
    { key: 'app.new-task', label: '＋ משימה חדשה', screen: 'general', route: null, selector: '.topbar .btn-primary, .fab' },

    // ----- החשבון שלי
    { key: 'account.theme', label: 'מצב לילה — בורר המראה ב"החשבון שלי"', screen: 'general', route: null,
      selector: 'tr:has(.theme-switch)', prepare: 'account' },
    { key: 'account.office-phone', label: 'הטלפון שלי במשרד ב"החשבון שלי"', screen: 'phonebook', route: null, prepare: 'account' },
    { key: 'account.phone', label: 'הטלפון שלי — זיהוי בבוט הוואטסאפ', screen: 'whatsapp', route: null, prepare: 'account' },
    { key: 'account.google', label: 'חיבור Google ועוזר ה-AI', screen: 'ai', route: null, prepare: 'account' },
    { key: 'account.whats-new', label: '"✨ מה חדש במערכת" ב"החשבון שלי"', screen: 'general', route: null, prepare: 'account' },

    // ----- דף הבית
    { key: 'home.add-window', label: '"＋ הוספת חלון" בלוח הבית', screen: 'home', route: 'home', selector: '.home-add-btn' },
    { key: 'home.my-tasks', label: 'החלון "המשימות שלי"', screen: 'home', route: 'home', selector: '.home-slot[data-key="myTasks"]' },
    { key: 'home.move-due', label: '📅 דחיית יעד ב"המשימות שלי"', screen: 'home', route: 'home', selector: '.home-slot .tk-move',
      fallback: 'home.my-tasks' },
    { key: 'home.ai-inbox', label: 'החלון "ממתין לאישורך"', screen: 'home', route: 'home', selector: '.home-slot[data-key="aiInbox"]' },
    { key: 'home.not-task', label: '"✕ לא משימה" ב"ממתין לאישורך"', screen: 'home', route: 'home',
      selector: '.home-slot[data-key="aiInbox"] button[title^="לא משימה"]', fallback: 'home.ai-inbox' },
    { key: 'home.quick-task', label: 'פתיחת משימה מהירה (הלשונית בצד)', screen: 'home', route: 'home', selector: '.qt-tab' },

    // ----- Today
    { key: 'today.button', label: 'כפתור ☀ Today', screen: 'today', route: null, selector: '.today-btn, .m-action-today' },
    { key: 'today.head', label: 'Today — סיכום היום', screen: 'today', route: 'today', selector: '.today-head' },
    { key: 'today.calendar', label: 'Today — היומן של היום', screen: 'today', route: 'today',
      selector: '.today-sec:has(.today-event)', fallback: 'today.head' },
    { key: 'today.suggestions', label: 'Today — הצעות מהמייל ומהוואטסאפ', screen: 'today', route: 'today',
      selector: '.today-sec:has(.today-mail, .today-older-line)', fallback: 'today.head' },
    { key: 'today.insights', label: 'Today — תובנות', screen: 'today', route: 'today',
      selector: '.today-sec:has(.today-insight, .today-ins-group)', fallback: 'today.head' },
    { key: 'today.settings', label: 'Today במייל והקלטה (⚙)', screen: 'today', route: 'today',
      selector: '.today-head button[title^="Today במייל"]' },
    { key: 'today.voice', label: '🎙 משימה מהקלטה', screen: 'today', route: null, selector: '.mic-btn, .m-actionbar' },

    // ----- לוח המשימות
    { key: 'board.filters', label: 'מסננים כתגיות בלוח', screen: 'board', route: 'board', selector: '.fchip-add' },
    { key: 'board.view-switch', label: 'טבלה / כרטיסיות / ציר זמן', screen: 'board', route: 'board', selector: 'main .view-switch' },
    { key: 'board.timeline-zoom', label: 'זום בציר הזמן', screen: 'board', route: 'board', selector: '.tl-zoom', prepare: 'timeline' },

    // ----- כרטיס משימה וחלון משימה חדשה
    { key: 'task.meeting', label: 'קביעת פגישה מתוך כרטיס משימה', screen: 'calendar', route: 'board',
      selector: '.task-detail .mt-panel', prepare: 'taskCard' },
    { key: 'task.files', label: 'קבצים ומייל מצורף בכרטיס משימה', screen: 'task', route: 'board',
      selector: '.task-detail .tabs', prepare: 'taskCard' },
    { key: 'task.assignees', label: 'בחירת אחראי בעיגולים (משימה חדשה)', screen: 'task', route: null,
      selector: '.modal .ap', prepare: 'newTask' },

    // ----- יומן ופגישות
    { key: 'calendar.grid', label: 'היומן — שבוע ויום', screen: 'calendar', route: 'calendar', selector: '.cal-grid' },
    { key: 'calendar.people', label: 'היומן — בחירת עובדים', screen: 'calendar', route: 'calendar', selector: '.cal-people-row' },

    // ----- משימות AI
    { key: 'ai.dialog', label: 'חלון משימת AI', screen: 'ai', route: null, selector: '.modal:has(.ai-dialog)', prepare: 'aiTask' },
    { key: 'ai.cc', label: 'משימת AI — העתק (CC)', screen: 'ai', route: null, selector: '.field:has(> .ai-cc)',
      prepare: 'aiTask', fallback: 'ai.dialog' },
    { key: 'ai.contact-note', label: 'משימת AI — "נמצא באנשי הקשר"', screen: 'ai', route: null, selector: '.ai-found',
      prepare: 'aiTask', fallback: 'ai.dialog' },
    { key: 'ai.signature', label: 'משימת AI — החתימה מ-Gmail', screen: 'ai', route: null, selector: '.ai-signature-box',
      prepare: 'aiTask', fallback: 'ai.dialog' },

    // ----- אלפון
    { key: 'phonebook.sidebar', label: 'חיפוש באלפון בתפריט הצד', screen: 'phonebook', route: 'home', selector: '.pb-side' },
    { key: 'phonebook.search', label: 'אלפון — שורת החיפוש', screen: 'phonebook', route: 'phonebook', selector: '.pb-tools' },
    { key: 'phonebook.filters', label: 'אלפון — סינון עובדים / ספקים / אנשי קשר', screen: 'phonebook', route: 'phonebook', selector: '.pb-filter' },
    { key: 'phonebook.actions', label: 'אלפון — חיוג, וואטסאפ ומייל בלחיצה', screen: 'phonebook', route: 'phonebook',
      selector: '.pb-table .pb-cell', fallback: 'phonebook.search' },
    { key: 'phonebook.import', label: 'אלפון — הוספה, ייבוא וייצוא', screen: 'phonebook', route: 'phonebook', selector: '.pb-head-acts' },

    // ----- דוחות
    { key: 'reports.scope', label: 'דוחות — בחירת מחלקה', screen: 'reports', route: 'reports', selector: 'main .page-head + *' },

    // ----- בטלפון
    { key: 'mobile.actionbar', label: 'בטלפון: Today והקלטה בתחתית', screen: 'mobile', route: 'today', selector: '.m-actionbar', viewport: 'phone' },
    { key: 'mobile.fab', label: 'בטלפון: ＋ משימה חדשה', screen: 'mobile', route: 'today', selector: '.fab', viewport: 'phone' },
    { key: 'mobile.tabbar', label: 'בטלפון: הניווט התחתון', screen: 'mobile', route: 'today', selector: '.tabbar', viewport: 'phone' },

    // ----- ניהול המערכת
    { key: 'admin.users-tools', label: 'משתמשים — סינון וייבוא מאקסל', screen: 'admin', route: 'admin', params: { tab: 'users' } },
    { key: 'admin.departments', label: 'מחלקות ותתי-מחלקות', screen: 'admin', route: 'admin', params: { tab: 'departments' },
      selector: '#admin-tab-departments' },
    { key: 'admin.whatsapp', label: 'ניהול בוט הוואטסאפ', screen: 'admin', route: 'admin', params: { tab: 'whatsapp' },
      selector: '#admin-tab-whatsapp' },
    { key: 'admin.matrix', label: 'מטריצת ההרשאות', screen: 'admin', route: 'admin', params: { tab: 'matrix' },
      selector: '.matrix-table thead', fallback: 'admin.matrix-tab' },
    { key: 'admin.matrix-tab', label: 'הלשונית "מטריצת הרשאות"', screen: 'admin', route: 'admin', params: { tab: 'matrix' },
      selector: '#admin-tab-matrix' },
    { key: 'admin.whats-new', label: 'הלשונית "✨ מה חדש"', screen: 'admin', route: 'admin', params: { tab: 'whatsnew' },
      selector: '#admin-tab-whatsnew' }
  ];

  for (const a of ANCHORS) Object.freeze(a);
  Object.freeze(ANCHORS);
  if (typeof module === 'object' && module.exports) module.exports = ANCHORS;
  else root.FeatureAnchors = ANCHORS;
})(typeof window !== 'undefined' ? window : globalThis);
