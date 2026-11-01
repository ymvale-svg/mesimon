'use strict';
/**
 * מסך 2 — לוח המשימות.
 * שלוש תצוגות: כרטיסיות (קנבן) עם גרירה ושחרור, טבלה, וציר זמן.
 * מציג את הבורד הפנימי בלבד; בורדי הספקים מוצגים בתצוגת-העל הנפרדת.
 */

const BoardView = (() => {
  const { el } = UI;

  // הטבלה המקובצת היא תצוגת ברירת המחדל — מסך העבודה היומיומי של המחלקה
  const view = { mode: 'table', selection: new Set() };
  let filters = {};
  let currentScope = 'internal';
  let currentTasks = [];
  let containerRef = null;

  // רשימת המחלקות לחתך המחלקתי. נטענת פעם אחת בלבד — היא משתנה לעיתים רחוקות,
  // ואין טעם לפנות לשרת בכל רענון של הלוח.
  let departments = [];

  /**
   * האם השחקן רואה יותר ממחלקה אחת. זו אותה הגדרה שהשרת מפעיל (isOrgWide),
   * והוא מתעלם מפרמטר departmentId לכל תפקיד אחר — ולכן לא מציעים לו את החתך.
   */
  const isOrgWide = () => ['superadmin', 'admin', 'executive'].includes(App.state.actor?.role);

  /**
   * מנהל מחלקה נפתח על "משימות שנתתי" — המשימות שהוא פתח — ובבחירה אחת
   * עובר ל"כל משימות המחלקה". כל המחלקה היא רשימה ארוכה מדי כברירת מחדל,
   * ומה שמנהל בודק ביום-יום הוא מה שהוא הטיל על אחרים.
   */
  const isDeptManager = () => App.state.actor?.role === 'manager';
  const REACH_OPTIONS = [
    { value: 'given', label: 'משימות שנתתי' },
    { value: 'department', label: 'כל משימות המחלקה' }
  ];

  /*
   * ערך המסנן "פתוחות בלבד". אינו מפתח סטטוס אמיתי, ולכן הוא נבחר כמחרוזת
   * שלא תתנגש עם מפתח עמודה — עמודות נוצרות מקוד ומקבלות מפתחות כמו
   * ‎in_progress‎, והקו התחתון הכפול מבטיח שאין התנגשות גם אם יתווספו עוד.
   */
  const OPEN_ONLY = '__open';

  // ------------------------------------------------------------- טעינה

  async function render(container, params = {}) {
    containerRef = container;
    const scopeChanged = currentScope !== (params.scope ?? 'internal');
    currentScope = params.scope ?? 'internal';
    view.selection.clear();
    if (scopeChanged) GridView.resetGrouping();

    // מצב התצוגה שהמשתמש עבד בו, אם נשמר
    const savedView = App.getPref('boardView');
    if (['table', 'kanban', 'timeline'].includes(savedView)) view.mode = savedView;

    /**
     * סדר העדיפות: מה שהועבר בניווט (למשל לחיצה על ווידג'ט "באיחור") גובר,
     * ואחריו מה שנשמר מהפעם הקודמת. כך קיצור דרך מהדשבורד עדיין עובד, אבל
     * פתיחה רגילה של הלוח מחזירה את החתך שהמשתמש עבד בו.
     */
    const saved = readSaved(params.archived ? 'archive' : currentScope);
    const pick = (key, fromParams) => (fromParams !== undefined && fromParams !== null && fromParams !== ''
      ? fromParams
      : (saved[key] ?? ''));

    filters = {
      scope: currentScope,
      projectId: params.projectId ?? (params.keepFilters ? filtersKeep('projectId', params) : pick('projectId')),
      assignee: params.mine
        ? `${App.isVendor() ? 'vendor' : 'user'}:${App.state.actor.id}`
        : pick('assignee', params.assignee),
      priority: pick('priority', params.priority),
      /*
       * ברירת המחדל היא "פתוחות בלבד", ולא "כל הסטטוסים".
       *
       * ‎pick‎ מחזיר מחרוזת ריקה כשאין העדפה שמורה, וריק פירושו כל
       * הסטטוסים — כלומר הלוח נפתח מלא במשימות שהושלמו. הברירה חלה רק
       * כשהמשתמש לא בחר דבר, ורק מחוץ לארכיון: הארכיון כולו הושלמו,
       * וברירת מחדל שמסתירה אותם הייתה פותחת אותו ריק.
       */
      status: params.archived
        ? pick('status', params.status)
        : (pick('status', params.status) || (saved.status === undefined ? OPEN_ONLY : '')),
      boardId: pick('boardId', params.boardId),
      departmentId: pick('departmentId', params.departmentId),
      /*
       * קיצור דרך (פרויקט, מחלקה, "שלי") מבקש תמונה שלמה, ולכן פותח את כל
       * המחלקה; פתיחה רגילה חוזרת למה שנבחר בפעם הקודמת, ובראשונה — שנתתי.
       */
      reach: !isDeptManager() ? ''
        : params.reach ?? (params.projectId || params.departmentId || params.mine
          ? 'department'
          : (saved.reach || 'given')),
      // חיפוש טקסט לא נשמר בכוונה
      q: '',
      archived: params.archived ? '1' : '',
      onlyOverdue: params.overdue !== undefined ? !!params.overdue : !!saved.onlyOverdue,
      pendingReview: params.pendingReview !== undefined ? !!params.pendingReview : !!saved.pendingReview
    };

    await load();
  }

  const filtersKeep = (key, params) => (params.keepFilters ? filters[key] : '');

  /**
   * החתך נשמר בנפרד לכל תצוגה (פנימי / ספקים / ארכיון) — מי שעובד תמיד
   * בחתך אחד לא יבחר אותו מחדש בכל פתיחה.
   *
   * נשמר בשני מקומות בכוונה: בשרת, כדי שההעדפה תלך אחרי המשתמש בין
   * מכשירים ובין דפדפנים (זו הייתה הסיבה שהחתך "לא נשמר" — ‎localStorage‎
   * לבדו נשאר במכשיר שנבחר בו), וגם במכשיר, כי הוא זמין מיידית בטעינה
   * ראשונה וממשיך לעבוד גם כשהרשת נופלת.
   *
   * ‎q‎ אינו נשמר: מחרוזת חיפוש היא חיפוש חד-פעמי, ולא הגדרת עבודה. לוח
   * שנפתח עם חיפוש ישן נראה כאילו חסרות בו משימות.
   */
  const FILTER_KEY = 'mesimon.boardFilters';
  const PERSISTED = ['projectId', 'assignee', 'priority', 'status', 'boardId', 'departmentId', 'reach', 'onlyOverdue', 'pendingReview'];

  const localFilters = () => {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}'); } catch { return {}; }
  };

  /* השרת קודם — הוא המקור שמשותף לכל המכשירים, והמכשיר הוא רק גיבוי */
  const readSaved = (scope) =>
    App.getPref('boardFilters', {})?.[scope] ?? localFilters()[scope] ?? {};

  function saveFilters() {
    const key = filters.archived === '1' ? 'archive' : currentScope;
    const mine = Object.fromEntries(PERSISTED.map((k) => [k, filters[k]]));

    const merged = { ...App.getPref('boardFilters', {}), ...localFilters(), [key]: mine };
    App.setPref('boardFilters', merged);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(merged));
    } catch { /* מצב פרטי — נשאר רק מה שנשמר בשרת */ }
  }

  async function ensureDepartments() {
    if (!isOrgWide() || departments.length) return;
    try {
      const data = await API.departments();
      departments = data.departments;
    } catch {
      // כשל בטעינת המחלקות אינו אמור למנוע את הצגת הלוח — החתך פשוט לא יוצע
    }
  }

  async function load(opts = {}) {
    if (!opts.silent) UI.mount(containerRef, header(), UI.spinner());
    try {
      await ensureDepartments();
      const query = { ...filters };
      delete query.onlyOverdue;
      delete query.pendingReview;
      /*
       * "פתוחות בלבד" אינו מפתח סטטוס אמיתי ואינו נשלח לשרת. הסינון נעשה
       * על ‎isFinal‎, שהשרת מחשב לפי העמודה — כך הוא נכון גם לבורד הפנימי
       * וגם לבורדי הספקים, שהסטטוס הסופי בהם נקרא אחרת.
       */
      const openOnly = filters.status === OPEN_ONLY;
      if (openOnly) delete query.status;
      const data = await API.tasks(query);
      currentTasks = data.tasks;
      if (openOnly) currentTasks = currentTasks.filter((t) => !t.isFinal);
      if (filters.onlyOverdue) currentTasks = currentTasks.filter((t) => t.overdue);
      if (filters.pendingReview) currentTasks = currentTasks.filter((t) => ['uploaded', 'pending_team_review', 'in_team_review'].includes(t.status));
      draw();
      if (opts.keepFocus) GridView.restoreFocus(opts.keepFocus);
    } catch (err) {
      // כשל רגעי בטעינת רקע לא ימחק את מה שכבר על המסך
      if (!opts.silent) UI.mount(containerRef, header(), UI.empty(err.message, '⚠️'));
    }
  }

  /*
   * מיקוד אחרי בנייה מחדש. ‎draw‎ מחליף את כל המסך, כולל הפקד שהמשתמש עמד
   * עליו — ובלי שחזור, כל הסרת שבב או החלפת זום במקלדת זרקה את המיקוד לראש
   * הדף. המפתח הוא ‎data-fk‎ יציב (‎q‎, ‎add‎, ‎chip:status‎, ‎card:12‎), ולא
   * הפניה לאלמנט: האלמנט הישן כבר אינו במסמך.
   */
  let pendingFocus = null;
  const focusKey = () => {
    const node = document.activeElement?.closest?.('[data-fk]');
    return node && containerRef?.contains(node) ? node.dataset.fk : null;
  };

  function restoreFocus(key) {
    if (!key || !containerRef) return;
    const find = (k) => containerRef.querySelector(`[data-fk="${CSS.escape(k)}"]`);
    // שבב שנעלם (בחירת "הכול" בתפריט) — כפתור ההוספה הוא המקום הטבעי לחזור אליו
    const node = find(key) ?? (key.startsWith('chip:') ? find('add') : null);
    if (!node) return;
    node.focus({ preventScroll: true });
    if (key === 'q') node.setSelectionRange?.(node.value.length, node.value.length);
  }

  function draw() {
    const scrollTop = containerRef?.scrollTop ?? 0;
    const focus = pendingFocus ?? focusKey();
    pendingFocus = null;
    // מה שהוקלד בחיפוש בזמן שהטעינה רצה — אחרת הבנייה מחדש מחזירה את הערך הישן
    const typing = document.activeElement?.dataset?.fk === 'q' ? document.activeElement.value : null;

    const body =
      view.mode === 'kanban' ? kanban() :
      view.mode === 'table' ? grid() :
      timeline();
    UI.mount(containerRef, header(), toolbar(), bulkBar(), body);
    if (typing !== null) {
      const input = containerRef.querySelector('[data-fk="q"]');
      if (input) input.value = typing;
    }
    if (view.mode === 'timeline') scrollTimelineToToday();
    if (scrollTop) containerRef.scrollTop = scrollTop;
    restoreFocus(focus);
  }

  /** תצוגת הטבלה המקובצת — הקישור בין הלוח למודול הגריד */
  function grid() {
    return GridView.render({
      tasks: currentTasks,
      scope: currentScope,
      archived: filters.archived === '1',
      selectable: !App.isVendor(),
      selection: view.selection,
      onReload: (o) => load({ silent: true, ...o }),
      onRedraw: draw,
      onSelectionChanged: draw,
      // עריכה במקום עלולה להוציא את המשימה מגבולות הסינון הנוכחי (שינוי סטטוס
      // בזמן סינון לפי סטטוס, דחיית תאריך יעד תחת "רק באיחור", העברה לבורד ספק).
      // שכפול לוגיקת הסינון כאן היה נסחף מהשרת — לכן טוענים מחדש בשקט.
      onTaskUpdated: () => {
        load({ silent: true });
        App.refreshNotifications();
      }
    });
  }

  // ------------------------------------------------------------- כותרת וסרגל

  function header() {
    const project = filters.projectId ? App.project(Number(filters.projectId)) : null;
    let title = 'לוח המשימות';
    let sub = 'הבורד הפנימי של הצוות — משימות פנימיות בלבד.';

    if (filters.archived === '1') {
      title = 'ארכיון';
      sub = 'משימות שהושלמו והועברו לארכיון. אינן מוצגות בתצוגה הראשית.';
    } else if (currentScope === 'vendors') {
      title = 'כל משימות הספקים';
      sub = 'תצוגת-על המרכזת את הפעילות מכל בורדי הספקים לצורך בקרה ודיווח.';
    } else if (project) {
      title = project.name;
      sub = project.description || 'תצוגת משימות הפרויקט.';
    }

    return el('div.page-head', {}, [
      // הלוגו של הפרויקט לצד שמו, כשהוגדר לו אחד
      project?.logoId
        ? el('img.head-logo', { src: `/api/project-images/${project.logoId}/view`, alt: project.name })
        : null,
      el('div', {}, [el('h2', { text: title }), el('div.sub', { text: sub })]),
      el('div.spacer'),
      // ‎canEdit‎ מגיע מהשרת ולא נגזר כאן: ל"יש הרשאת פרויקטים" ול"מותר לערוך
      // את הפרויקט הזה" אין אותה תשובה, ומי שמנחש מציג כפתור שנכשל ב-403
      project?.canEdit
        ? el('button.btn', { onclick: () => openProjectDialog(project) }, ['✎ עריכת פרויקט'])
        : null,
      App.may('export_data')
        ? el('a.btn', { href: '/api/export/tasks.csv' }, ['⬇ ייצוא CSV'])
        : null,
      // פרויקט חדש לצד משימה חדשה: פתיחת פרויקט היא פעולה שנעשית מאותו מקום
      // ובאותו רגע — כשמתברר שהמשימה החדשה אינה שייכת לשום פרויקט קיים
      App.may('create_project') && filters.archived !== '1'
        ? el('button.btn', { onclick: () => openProjectDialog() }, ['＋ פרויקט חדש'])
        : null,
      App.may('create_task') && filters.archived !== '1'
        ? el('button.btn.btn-primary', {
            onclick: () => openTaskDialog(null, { projectId: filters.projectId, scope: currentScope })
          }, ['＋ משימה חדשה'])
        : null
    ]);
  }

  /**
   * הגדרת שדות הסינון — מקור אחד גם לשבבים, גם לתפריט ההוספה וגם לניקוי.
   *
   * ‎def‎ הוא ערך ברירת המחדל שהסרת שבב מחזירה אליו, ולא בהכרח "הכול":
   * בסטטוס, מחוץ לארכיון, ברירת המחדל היא "פתוחות בלבד" (ראו ‎render‎),
   * והסרת "סטטוס: הושלם" צריכה להחזיר ללוח הרגיל ולא לפתוח את כל ההיסטוריה.
   *
   * ‎implicit‎ מסמן ערך שהוא ברירת מחדל ובכל זאת מסתיר נתונים. הוא מוצג
   * כשבב בלי ✕, כדי שהסרגל לעולם לא ייראה "ללא מסננים" בשעה שמשימות
   * שהושלמו מוסתרות מהמשתמש.
   */
  function filterFields() {
    const archived = filters.archived === '1';

    const projectOptions = [{ value: '', label: 'כל הפרויקטים' },
      ...App.state.projects.map((p) => ({ value: p.id, label: p.name }))];

    const assigneeOptions = [{ value: '', label: 'כל האחראים' },
      ...App.state.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
      ...App.state.vendors.map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק)` }))];

    const priorityOptions = [{ value: '', label: 'כל העדיפויות' },
      ...App.state.priorities.map((p) => ({ value: p.key, label: p.label }))];

    const statusSource = currentScope === 'vendors'
      ? App.vendorBoards()[0]?.columns ?? []
      : App.internalBoard()?.columns ?? [];
    /*
     * "פתוחות בלבד" הוא ערך בבורר עצמו, ולא תיבת סימון נפרדת לצדו.
     *
     * זו ברירת המחדל של הלוח: מי שפותח אותו רוצה לראות מה נשאר לעשות, ולא
     * את כל מה שנעשה מאז ומעולם. הסטטוס הסופי זמין בבחירה מפורשת, ומסך
     * הארכיון ממילא נפתח על מה שהושלם.
     *
     * ערך בבורר ולא דגל, כי הבורר הוא מה שהמשתמש קורא כדי לדעת מה מוצג —
     * דגל נפרד היה מאפשר "כל הסטטוסים" מסומן יחד עם הסתרת ההושלמו, כלומר
     * כיתוב שמשקר.
     */
    const statusOptions = [
      { value: OPEN_ONLY, label: 'פתוחות בלבד' },
      { value: '', label: 'כל הסטטוסים' },
      ...statusSource.map((c) => ({ value: c.key, label: c.label }))
    ];

    const fields = [
      /*
       * היקף הלוח של מנהל מחלקה. "שנתתי" הוא ברירת המחדל ובכל זאת מסתיר את
       * שאר משימות המחלקה — ולכן שבב קבוע, כמו "פתוחות בלבד"
       */
      ...(isDeptManager()
        ? [{ key: 'reach', label: 'היקף', options: REACH_OPTIONS, def: 'given', implicit: 'given' }]
        : []),
      { key: 'status', label: 'סטטוס', options: statusOptions, def: archived ? '' : OPEN_ONLY, implicit: OPEN_ONLY },
      { key: 'projectId', label: 'פרויקט', options: projectOptions, def: '' },
      { key: 'assignee', label: 'אחראי', options: assigneeOptions, def: '' },
      { key: 'priority', label: 'עדיפות', options: priorityOptions, def: '' }
    ];

    if (isOrgWide() && departments.length) {
      fields.push({ key: 'departmentId', label: 'מחלקה', def: '', options: [{ value: '', label: 'כל המחלקות' },
        ...departments.map((d) => ({ value: d.id, label: d.label ?? d.name }))] });
    }

    if (currentScope === 'vendors') {
      fields.push({ key: 'boardId', label: 'ספק', def: '', options: [{ value: '', label: 'כל הספקים' },
        ...App.state.vendors.map((v) => ({ value: v.boardId, label: v.name }))] });
    }

    // "רק באיחור" היה תיבת סימון בסרגל. עכשיו הוא שדה כמו כל השאר, ולכן גם
    // הוא מקבל שבב — אחרת היה המסנן היחיד שפעיל בלי שום סימן בסרגל
    fields.push({ key: 'onlyOverdue', label: 'איחור', def: false, bool: true, options: [
      { value: false, label: 'כל המשימות' }, { value: true, label: 'באיחור בלבד' }] });

    // אין לו פקד משלו — מגיע רק מקיצור הדרך בדשבורד. שבב בלבד, כדי שאפשר יהיה
    // לראות שהוא פעיל ולהסיר אותו; אין טעם להציע אותו בתפריט
    if (filters.pendingReview) {
      fields.push({ key: 'pendingReview', label: 'בדיקה', def: false, bool: true, hidden: true, options: [
        { value: false, label: 'כל המשימות' }, { value: true, label: 'ממתינות לבדיקה' }] });
    }
    return fields;
  }

  // השוואה כמחרוזת: מזהי פרויקט מגיעים כמספר מהרשימה וכמחרוזת מההעדפות
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const optionLabel = (field, value) =>
    field.options.find((o) => same(o.value, value))?.label ?? String(value);

  /** השבבים הפעילים לפי הסדר שבו הם מוצגים — גם הבסיס לבחירת השכן להתמקדות */
  function activeChips(fields) {
    return fields
      .filter((f) => !same(filters[f.key], f.def) || (f.implicit !== undefined && same(filters[f.key], f.implicit)))
      // ‎false‎ ו'' שקולים ל"ללא מסנן" גם כשהם אינם ברירת המחדל (ארכיון ללא סטטוס)
      .filter((f) => filters[f.key] !== '' && filters[f.key] !== false && filters[f.key] !== undefined)
      .map((f) => ({
        field: f,
        implicit: f.implicit !== undefined && same(filters[f.key], f.implicit),
        // שדה כן/לא נקרא טוב יותר בערכו בלבד — "באיחור בלבד", ולא "איחור: באיחור בלבד"
        text: f.bool || (f.implicit !== undefined && same(filters[f.key], f.implicit))
          ? optionLabel(f, filters[f.key])
          : `${f.label}: ${optionLabel(f, filters[f.key])}`
      }));
  }

  /*
   * אזור הכרזה אחד לכל הלוח, מחוץ לסרגל. הסרגל נבנה מחדש בכל שינוי, ואזור
   * ‎aria-live‎ שנוצר יחד עם התוכן שלו אינו מוכרז ברוב קוראי המסך — הם
   * מאזינים לשינויים באזור שכבר קיים, לא לאזור שנולד.
   */
  let liveNode = null;
  function announce(text) {
    if (!liveNode || !liveNode.isConnected) {
      liveNode = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(liveNode);
    }
    // ריקון ואז כתיבה בתור הבא — אותו משפט פעמיים ברצף (שתי הסרות) הוא
    // לא-שינוי מבחינת קורא המסך, והשני היה נבלע
    liveNode.textContent = '';
    setTimeout(() => { liveNode.textContent = text; }, 30);
  }

  const isPhone = () => window.matchMedia('(max-width: 820px)').matches;

  function toolbar() {
    /*
     * ‎focusAfter‎ — מה יקבל את המיקוד אחרי הבנייה מחדש. ‎draw‎ מחליף את כל
     * הסרגל, ומי שהסיר שבב במקלדת היה נזרק לראש הדף ומתחיל לנווט מההתחלה.
     */
    const set = (key, value, focusAfter) => {
      filters[key] = value;
      saveFilters();
      pendingFocus = focusAfter ?? focusKey();
      // חיפוש טקסט נטען בשקט: ספינר היה מוחק את שדה החיפוש באמצע ההקלדה
      load(key === 'q' ? { silent: true } : {});
    };

    const fields = filterFields();
    const chips = activeChips(fields);
    const removable = chips.filter((c) => !c.implicit);

    const searchInput = el('input', {
      type: 'search', placeholder: 'סינון לפי טקסט…', value: filters.q,
      'aria-label': 'סינון המשימות לפי טקסט', dataset: { fk: 'q' }
    });
    let timer;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => set('q', searchInput.value.trim(), 'q'), 300);
    });

    const removeChip = (chip) => {
      const i = chips.indexOf(chip);
      // השכן שאחריו, ואם אין — זה שלפניו. שבב "פתוחות בלבד" שנולד מההסרה
      // (הסרת סטטוס מפורש) הוא שכן כשר: הוא באותו מקום בדיוק
      const neighbour = chips[i + 1] ?? chips[i - 1];
      const after = chip.field.implicit !== undefined && chip.field.def === chip.field.implicit
        ? `chip:${chip.field.key}`
        : neighbour ? `chip:${neighbour.field.key}` : 'add';
      announce(`הוסר ${chip.text}`);
      set(chip.field.key, chip.field.def, after);
    };

    const chipNodes = chips.map((chip) => {
      const key = chip.field.key;
      const body = el('button.fchip-body', {
        type: 'button',
        dataset: { fk: `chip:${key}` },
        'aria-haspopup': 'menu',
        title: chip.implicit ? 'ברירת המחדל של הלוח — לחיצה לבחירת סטטוס אחר' : `שינוי ${chip.field.label}`,
        onclick: (e) => openFilterMenu(e.currentTarget, fields, set, chip.field)
      }, [chip.text, chip.implicit ? el('span.fchip-caret', { 'aria-hidden': 'true', text: '▾' }) : null]);

      return el(`div.fchip${chip.implicit ? '.is-implicit' : ''}`, { role: 'listitem' }, [
        body,
        chip.implicit ? null : el('button.chip-x', {
          type: 'button',
          'aria-label': `הסרת הסינון ${chip.text}`,
          title: 'הסרה',
          onclick: () => removeChip(chip)
        }, ['✕'])
      ]);
    });

    if (removable.length >= 2) {
      chipNodes.push(el('button.fchip-clear', {
        type: 'button',
        onclick: () => {
          for (const c of removable) filters[c.field.key] = c.field.def;
          announce('נוקו כל המסננים');
          set('q', filters.q, 'add');
        }
      }, ['ניקוי הכול']));
    }

    const addBtn = el('button.btn.btn-sm.fchip-add', {
      type: 'button',
      'aria-haspopup': 'menu',
      dataset: { fk: 'add' },
      onclick: (e) => openFilterMenu(e.currentTarget, fields, set)
    }, [
      el('span.fa-desk', { text: '＋ סינון' }),
      // בטלפון השבבים בשורה נגללת ולא תמיד כולם בתצוגה — המונה אומר כמה יש
      el('span.fa-phone', { text: chips.length ? `סינון (${chips.length})` : 'סינון' })
    ]);

    const items = [
      el('div.view-switch', { role: 'group', 'aria-label': 'תצוגת הלוח' }, [
        ['table', '☰ טבלה'], ['kanban', '▦ כרטיסיות'], ['timeline', '▤ ציר זמן']
      ].map(([mode, label]) =>
        el(`button${view.mode === mode ? '.active' : ''}`, {
          type: 'button',
          'aria-pressed': String(view.mode === mode),
          // גם מצב התצוגה הוא העדפה — מי שעובד בכרטיסיות לא רוצה לחזור לטבלה בכל כניסה
          onclick: () => { view.mode = mode; App.setPref('boardView', mode); draw(); }
        }, [label])
      )),
      view.mode === 'timeline' ? zoomSwitch() : null,
      searchInput,
      addBtn,
      el('div.fchips', { role: 'list', 'aria-label': 'מסננים פעילים' }, chipNodes)
    ];

    items.push(el('div.spacer'));

    // מסננים אישיים שמורים
    if (!App.isVendor()) {
      if (App.state.savedFilters.length) {
        items.push(UI.select(
          [{ value: '', label: 'מסננים שמורים…' }, ...App.state.savedFilters.map((f) => ({ value: f.id, label: f.name }))],
          '',
          {
            class: 'tb-saved',
            'aria-label': 'החלת מסנן שמור',
            onchange: (e) => {
              const saved = App.state.savedFilters.find((f) => String(f.id) === e.target.value);
              // מסנן שנשמר לפני שנוספו רמת המשימה והחתך המחלקתי אינו נושא את
              // המפתחות האלה — מאפסים אותם ל"הכול" כדי שהמסנן יטען כפי שנשמר
              if (saved) { filters = { ...filters, departmentId: '', ...saved.payload }; load(); }
            }
          }
        ));
      }
      items.push(el('button.btn.btn-sm.tb-saved', { onclick: saveCurrentFilter, title: 'שמירת המסננים הנוכחיים' }, ['💾 שמור מסנן']));
    }

    return el('div.toolbar.board-toolbar', {}, items);
  }

  /**
   * תפריט הוספת מסנן בשני שלבים: שדה ← ערך.
   *
   * דפוס תפריט ARIA מלא (‎role=menu‎, ‎menuitemradio‎ עם ‎aria-checked‎, מיקוד
   * נודד) ולא רשימת כפתורים, כי קורא המסך מודיע אז "תפריט, 7 פריטים, נבחר"
   * — ומשתמש המקלדת מקבל חצים במקום עשרים לחיצות Tab.
   *
   * ב-RTL הכניסה לשלב הערכים היא חץ שמאלה והחזרה חץ ימינה — כיוון הקריאה,
   * כמו בתפריטי משנה של מערכת ההפעלה בעברית.
   *
   * ‎startField‎ — לחיצה על שבב קיים פותחת ישר את ערכי השדה שלו. בחירת שדה
   * שכבר יש לו שבב מחליפה אותו: לכל שדה ערך אחד, והשבב הוא אותו מפתח.
   */
  function openFilterMenu(opener, fields, set, startField = null) {
    let step = startField ? 'values' : 'fields';
    let field = startField;
    let lastField = startField;
    let typed = '';
    let typedTimer = null;

    const list = el('div.fmenu', { role: 'menu' });
    let handle = null;
    const phone = isPhone();

    const close = (returnFocus = true) => {
      if (!handle) return;
      const h = handle;
      handle = null;
      h.close();
      if (returnFocus && opener.isConnected) opener.focus();
    };

    const items = () => [...list.querySelectorAll('[role^="menuitem"]')];
    const focusItem = (node) => {
      for (const it of items()) it.tabIndex = it === node ? 0 : -1;
      node?.focus();
    };

    const pick = (f, opt) => {
      const had = !same(filters[f.key], f.def);
      close(false);
      if (same(filters[f.key], opt.value)) { opener.isConnected && opener.focus(); return; }
      const isNone = same(opt.value, f.def) || opt.value === '' || opt.value === false;
      announce(isNone
        ? `הוסר ${f.label}`
        : `${had ? 'הוחלף' : 'נוסף'} ${f.label}: ${opt.label}`);
      set(f.key, opt.value, `chip:${f.key}`);
    };

    function drawStep() {
      // מחרוזת הקלדה מהשלב הקודם אינה רלוונטית לרשימה החדשה
      typed = '';
      if (step === 'fields') {
        list.setAttribute('aria-label', 'סינון לפי');
        UI.mount(list, ...fields.filter((f) => !f.hidden).map((f) => el('button.popover-option', {
          type: 'button', role: 'menuitem', tabIndex: -1, 'aria-haspopup': 'menu',
          dataset: { key: f.key },
          onclick: () => { field = f; lastField = f; step = 'values'; drawStep(); }
        }, [
          el('span', { text: f.label }),
          // הערך הנוכחי ליד השדה — "החלפה" נראית אחרת מ"הוספה"
          !same(filters[f.key], f.def) ? el('span.fm-current', { text: optionLabel(f, filters[f.key]) }) : null,
          el('span.fm-arrow', { 'aria-hidden': 'true', text: '‹' })
        ])));
        const back = lastField && list.querySelector(`[data-key="${lastField.key}"]`);
        focusItem(back ?? items()[0]);
        return;
      }
      list.setAttribute('aria-label', field.label);
      const checked = field.options.find((o) => same(o.value, filters[field.key]));
      UI.mount(list,
        el('button.popover-option.fm-back', {
          type: 'button', role: 'menuitem', tabIndex: -1,
          onclick: () => { step = 'fields'; drawStep(); }
        }, [el('span.fm-arrow', { 'aria-hidden': 'true', text: '›' }), 'כל השדות']),
        el('div.fm-sep', { role: 'separator' }),
        ...field.options.map((o) => el('button.popover-option', {
          type: 'button', role: 'menuitemradio', tabIndex: -1,
          'aria-checked': String(o === checked),
          onclick: () => pick(field, o)
        }, [el('span', { text: o.label }), o === checked ? el('span.check', { 'aria-hidden': 'true', text: '✓' }) : null]))
      );
      focusItem(list.querySelector('[aria-checked="true"]') ?? items()[1]);
    }

    list.addEventListener('keydown', (e) => {
      const all = items();
      const at = all.indexOf(document.activeElement);
      const move = (i) => { e.preventDefault(); focusItem(all[(i + all.length) % all.length]); };

      if (e.key === 'ArrowDown') return move(at + 1);
      if (e.key === 'ArrowUp') return move(at - 1);
      if (e.key === 'Home') return move(0);
      if (e.key === 'End') return move(all.length - 1);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
      if (e.key === 'Tab') return close(false);
      // RTL: שמאלה = פנימה, ימינה = חזרה
      if (e.key === 'ArrowLeft' && step === 'fields' && at >= 0) { e.preventDefault(); return all[at].click(); }
      if (e.key === 'ArrowRight' && step === 'values') { e.preventDefault(); step = 'fields'; return drawStep(); }
      if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { e.preventDefault(); return all[at].click(); }

      /*
       * הקלדה מקדימה: אותיות שמוקלדות ברצף בתוך 700ms מצטרפות למחרוזת אחת,
       * כך ש"דנ" מגיע לדנה ולא לדוד. אות בודדת מתחילה מהפריט הבא, כדי שלחיצות
       * חוזרות על אותה אות יעברו בין כל מי שמתחיל בה.
       */
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
        e.preventDefault();
        clearTimeout(typedTimer);
        typed += e.key.toLowerCase();
        typedTimer = setTimeout(() => { typed = ''; }, 700);
        const from = typed.length === 1 ? at + 1 : Math.max(0, at);
        const order = [...all.slice(from), ...all.slice(0, from)];
        const hit = order.find((n) => n.textContent.trim().toLowerCase().startsWith(typed));
        if (hit) focusItem(hit);
      }
    });

    /*
     * בטלפון — גיליון תחתון (או המודל, עד ש-‎UI.sheet‎ קיים): תפריט צף ליד
     * כפתור קטן נפתח מתחת לאגודל ונחתך במקלדת. במחשב — תפריט צף רגיל ליד
     * הכפתור, כי מודל על כל המסך לבחירת ערך אחד הוא כבד מדי.
     */
    if (phone) {
      const open = UI.sheet ?? UI.modal;
      // סגירה מבחוץ (✕ של הגיליון, החלקה למטה) מחזירה גם היא את המיקוד לכפתור
      handle = open({
        title: 'סינון', body: list,
        onClose: () => { if (handle) { handle = null; if (opener.isConnected) opener.focus(); } }
      });
    } else {
      const pop = el('div.cell-popover.fmenu-pop', {}, [list]);
      document.body.appendChild(pop);
      const rect = opener.getBoundingClientRect();
      pop.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 200)}px`;
      // RTL — יישור לקצה הימני של הכפתור, כמו שאר הפופאוברים
      pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      pop.style.maxHeight = `${Math.max(180, window.innerHeight - rect.bottom - 16)}px`;
      const onOutside = (e) => { if (!pop.contains(e.target) && !opener.contains(e.target)) close(false); };
      const t = setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
      handle = {
        close: () => { clearTimeout(t); document.removeEventListener('mousedown', onOutside); pop.remove(); }
      };
    }
    drawStep();
  }

  async function saveCurrentFilter() {
    const name = await UI.prompt('שם המסנן', { title: 'שמירת מסנן אישי' });
    if (!name) return;
    try {
      const { projectId, assignee, priority, status, boardId, departmentId, q, onlyOverdue } = filters;
      const data = await API.saveFilter(name, { projectId, assignee, priority, status, boardId, departmentId, q, onlyOverdue });
      App.state.savedFilters = data.savedFilters;
      UI.success('המסנן נשמר');
      draw();
    } catch (err) { UI.error(err); }
  }

  // ------------------------------------------------------------- פעולות אצווה

  function bulkBar() {
    if (!view.selection.size || App.isVendor()) return null;

    const columns = currentScope === 'vendors'
      ? App.vendorBoards()[0]?.columns ?? []
      : App.internalBoard()?.columns ?? [];

    const run = async (action, value) => {
      try {
        const res = await API.bulk([...view.selection], action, value);
        view.selection.clear();
        const verb = action === 'delete' ? 'נמחקו' : 'עודכנו';
        UI.success(`${verb} ${res.affected} משימות`);
        if (res.errors.length) UI.toast(`${res.errors.length} משימות לא ${verb} (הרשאות או חוקי זרימה)`, 'error');
        await load({ silent: true });
        App.refreshNotifications();
      } catch (err) { UI.error(err); }
    };

    // ‎{}‎ מפורש: הארגומנט השני הוא תכונות, ורשימת הילדים שהועברה במקומו
    // הפכה כל כפתור לתכונה ‎0="[object HTMLElement]"‎ — סרגל ריק לגמרי
    return el('div.toolbar.bulk-bar', {}, [
      el('b', { text: `${view.selection.size} משימות נבחרו` }),
      el('div.sep'),
      UI.select([{ value: '', label: 'שינוי סטטוס…' }, ...columns.map((c) => ({ value: c.key, label: c.label }))], '', {
        onchange: (e) => e.target.value && run('status', e.target.value)
      }),
      UI.select([{ value: '', label: 'שינוי אחראי…' },
        // רק מי שמותר לי לשייך אליו — אותו סינון של כל בוררי האחראי
        ...(({ near, far }) => [...near, ...far])(UI.usersByDepartment()).map((u) => ({ value: `user:${u.id}`, label: u.name })),
        ...(App.may('assign_task_to_vendor') ? App.state.vendors.map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק)` })) : [])
      ], '', { onchange: (e) => e.target.value && run('assignee', e.target.value) }),
      UI.select([{ value: '', label: 'שינוי עדיפות…' }, ...App.state.priorities.map((p) => ({ value: p.key, label: p.label }))], '', {
        onchange: (e) => e.target.value && run('priority', e.target.value)
      }),
      /**
       * העברה בין פרויקטים. כאן ולא רק בתא הפרויקט, כי בקיבוץ לפי פרויקט —
       * שהוא ברירת המחדל — אין בכלל עמודת פרויקט, ואז לא הייתה דרך להעביר.
       * ‎__none__‎ ולא ערך ריק, כי ריק הוא הכיתוב "העברה לפרויקט…" עצמו.
       */
      UI.select([
        { value: '', label: 'העברה לפרויקט…' },
        { value: '__none__', label: 'ללא פרויקט' },
        ...App.state.projects.filter((p) => p.canAddTask).map((p) => ({ value: String(p.id), label: p.name }))
      ], '', {
        onchange: (e) => e.target.value && run('project', e.target.value === '__none__' ? '' : e.target.value)
      }),
      el('button.btn.btn-sm', { onclick: () => run('archive', filters.archived === '1' ? 0 : 1) },
        [filters.archived === '1' ? '↩ החזרה מארכיון' : '🗄 העברה לארכיון']),
      /**
       * מחיקה מחייבת אישור מפורש שנוקב במספר. זו הפעולה היחידה בסרגל שאין
       * ממנה חזרה — ארכיון אפשר לבטל, מחיקה לא — ולכן היא גם נפרדת חזותית
       * ולא נמצאת לצד שאר הפעולות בטעות.
       */
      App.may('edit_delete_task')
        ? el('button.btn.btn-sm.btn-danger', {
            onclick: async () => {
              const n = view.selection.size;
              const ok = await UI.confirm(
                n === 1
                  ? 'למחוק את המשימה שנבחרה? המחיקה כוללת את השיחה, הצ׳קליסט והקבצים שבה, ואינה ניתנת לביטול.'
                  : `למחוק ${n} משימות? המחיקה כוללת את השיחה, הצ׳קליסט והקבצים שבהן, ואינה ניתנת לביטול.`,
                { title: 'מחיקת משימות', danger: true, okText: n === 1 ? 'מחיקה' : `מחיקת ${n} משימות` }
              );
              if (ok) run('delete');
            }
          }, ['🗑 מחיקה'])
        : null,
      el('div.spacer'),
      el('button.btn.btn-sm', { onclick: () => { view.selection.clear(); draw(); } }, ['ביטול בחירה'])
    ]);
  }

  // ------------------------------------------------------------- כרטיס משימה בלוח

  function card(task) {
    const due = UI.dueLabel(task.dueDate);
    const selectable = !App.isVendor();
    /*
     * ‎canChangeStatus‎ מגיע מהשרת — אותו רמז שהטבלה משתמשת בו כדי להחליט אם
     * תא הסטטוס לחיץ. כרטיס שאין לו הרשאה אינו נגרר כלל: גרירה שנגמרת בשגיאת
     * 403 מלמדת את המשתמש שהגרירה "לא עובדת", במקום שאין לו הרשאה.
     */
    const movable = !!task.canChangeStatus;

    const node = el('div.task-card', {
      class: [task.overdue ? 'is-overdue' : '', task.priority === 'urgent' ? 'is-urgent' : '', task.escalated ? 'is-escalated' : '',
        movable ? 'is-movable' : ''].filter(Boolean).join(' '),
      tabindex: '0',
      role: 'group',
      'aria-label': task.title,
      'aria-roledescription': movable ? 'כרטיס נגרר' : null,
      'aria-keyshortcuts': movable ? 'Space' : null,
      dataset: { fk: `card:${task.id}`, taskId: String(task.id) },
      // פס בצבע הפרויקט בקצה הכרטיס — זיהוי ויזואלי בלי לקרוא את שם הפרויקט
      style: task.projectColor ? { borderInlineStartColor: task.projectColor, borderInlineStartWidth: '3px' } : {},
      onclick: (e) => {
        // הלחיצה שהדפדפן שולח מיד אחרי שחרור גרירה אינה בקשה לפתוח את המשימה
        if (performance.now() - drag.endedAt < 400) return;
        if (!e.target.closest('.select-box')) TaskCardView.open(task.id);
      }
    }, [
      selectable ? el('label.select-box', {}, [
        el('input', {
          type: 'checkbox',
          'aria-label': `בחירת ${task.title}`,
          checked: view.selection.has(task.id),
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            if (e.target.checked) view.selection.add(task.id);
            else view.selection.delete(task.id);
            draw();
          }
        })
      ]) : null,
      task.projectName
        ? el('div.tc-project', {}, [el('span.project-dot', { style: { background: task.projectColor } }), task.projectName])
        : null,
      el('div.tc-title', { text: task.title, style: selectable ? { paddingInlineEnd: '18px' } : {} }),
      el('div.tc-tags', {}, UI.taskTags(task)),
      el('div.tc-foot', {}, [
        task.checklistTotal
          ? el('span.tc-check', {}, [
              el('div.progress-mini', {}, [el('div', { style: { width: `${(task.checklistDone / task.checklistTotal) * 100}%` } })]),
              `${task.checklistDone}/${task.checklistTotal}`
            ])
          : null,
        // מונה המהדקים הוסר — הקבצים עצמם מוצגים למעלה בכרטיס
        task.commentsCount ? el('span', { text: `💬 ${task.commentsCount}` }) : null,
        el('div.spacer'),
        el('span', {
          text: due.text,
          class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
        }),
        task.assigneeName ? UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' }) : null
      ])
    ]);

    node.addEventListener('keydown', (e) => {
      if (e.target !== node) return;   // מקשים מתוך תיבת הבחירה שבכרטיס
      // טעינת רקע בנתה את הלוח מחדש בזמן שכרטיס היה מורם — ההרמה הישנה מתה איתו
      if (kbd && !kbd.node.isConnected) kbd = null;
      // Enter פותח את המשימה — הכרטיס הוא גם הדרך היחידה להגיע אליה במקלדת.
      // ההרמה ברווח בלבד, כמו בספריות הגרירה הנגישות המוכרות
      if (!kbd && e.key === 'Enter') { e.preventDefault(); TaskCardView.open(task.id); return; }
      if (movable) keyboardDrag(e, task, node);
    });
    node.addEventListener('blur', () => { if (kbd?.node === node) kbdCancel(); });

    if (movable) {
      node.addEventListener('pointerdown', (e) => pointerDown(e, task, node));
      // לחיצה ארוכה באנדרואיד פותחת תפריט הקשר — היא הלחיצה שמרימה את הכרטיס
      node.addEventListener('contextmenu', (e) => { if (drag.pending || drag.active) e.preventDefault(); });
      /*
       * חסימת הגלילה רק אחרי ההרמה. ‎touch-action: none‎ על הכרטיס היה מונע
       * גלילה של הלוח כולו כשהאצבע מתחילה על כרטיס — כלומר כמעט תמיד בטלפון.
       * ‎passive: false‎ חובה, אחרת ‎preventDefault‎ מתעלם בשקט.
       */
      node.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
    }
    return node;
  }

  // ------------------------------------------------------------- גרירה בקנבן

  /*
   * גרירה בסמן ובמגע (Pointer Events) במקום HTML5 ‎draggable‎. הגרירה של
   * HTML5 אינה עובדת במגע כלל, אין לה מקלדת, ותמונת הגרירה שלה שקופה
   * למחצה ובגודל שהדפדפן קובע.
   *
   * עקרונות:
   * - הפעלה בעכבר אחרי תזוזה של כמה פיקסלים, כדי שלחיצה רגילה תפתח משימה.
   *   במגע — לחיצה ארוכה, כי תזוזה במגע היא גלילה, וגרירה מכל נגיעה הייתה
   *   הופכת את הלוח לבלתי ניתן לגלילה.
   * - המדידות נעשות פעם אחת בתחילת הגרירה. מדידה בכל תזוזה, אחרי שמציין
   *   המקום כבר הוכנס, מזיזה את הכרטיסים שמתחתיו — והמציין קופץ הלוך וחזור.
   * - רק שינוי עמודה נשמר. למשימות אין שדה סדר, ולכן הסדר בתוך העמודה הוא
   *   סדר התצוגה של השרת; לשמור "מיקום" שלא נשמר בשום מקום היה שקר.
   */
  const DRAG_MOUSE_PX = 6;      // תזוזה לפני שלחיצת עכבר הופכת לגרירה
  const DRAG_TOUCH_MS = 250;    // לחיצה ארוכה במגע
  const DRAG_TOUCH_SLOP = 8;    // רעד אצבע מותר בזמן הלחיצה הארוכה
  const DRAG_EDGE_PX = 70;      // מרחק מקצה הלוח שבו מתחילה גלילה אוטומטית
  const DRAG_EDGE_SPEED = 16;   // פיקסלים לפריים בקצה ממש

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const drag = { pending: null, active: null, endedAt: 0 };

  function pointerDown(e, task, node) {
    if (e.button !== 0 || drag.active || kbd) return;
    if (e.target.closest('.select-box, a, button, input')) return;

    const p = { task, node, id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: null };
    drag.pending = p;

    if (p.type === 'touch') {
      // לפני ההרמה הדף נגלל כרגיל; אחריה — גרירה
      p.timer = setTimeout(() => { if (drag.pending === p) startDrag(p); }, DRAG_TOUCH_MS);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function detachPointer() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    const p = drag.pending ?? drag.active;
    if (!p || e.pointerId !== p.id) return;
    p.x = e.clientX; p.y = e.clientY;

    if (drag.pending) {
      const dist = Math.hypot(p.x - p.x0, p.y - p.y0);
      if (p.type === 'touch') {
        // האצבע זזה לפני שהלחיצה הארוכה הבשילה — זו גלילה, לא גרירה
        if (dist > DRAG_TOUCH_SLOP) { clearTimeout(p.timer); drag.pending = null; detachPointer(); }
        return;
      }
      if (dist < DRAG_MOUSE_PX) return;
      startDrag(p);
    }
    if (drag.active) { e.preventDefault(); moveOverlay(); updateTarget(); }
  }

  function onPointerUp(e) {
    const p = drag.pending ?? drag.active;
    if (!p || e.pointerId !== p.id) return;
    if (drag.pending) { clearTimeout(p.timer); drag.pending = null; detachPointer(); return; }
    finishDrag(true);
  }

  function onPointerCancel(e) {
    const p = drag.pending ?? drag.active;
    if (!p || e.pointerId !== p.id) return;
    if (drag.pending) { clearTimeout(p.timer); drag.pending = null; detachPointer(); return; }
    finishDrag(false);
  }

  const onDragKey = (e) => {
    if (e.key !== 'Escape' || !drag.active) return;
    e.preventDefault();
    e.stopPropagation();
    finishDrag(false);
  };

  /**
   * מדידת העמודות והכרטיסים, פעם אחת. אמצעי הכרטיסים נשמרים יחסית לראש
   * רשימת העמודה (כולל הגלילה שלה), ולא כקואורדינטות מסך — כך הם נשארים
   * נכונים גם כשהלוח נגלל אופקית בזמן הגרירה. הכרטיס הנגרר עצמו אינו
   * נמדד: הוא "יצא" מהרשימה, ומקום לפיו היה נקבע ביחס לחור שהשאיר.
   */
  function measure(board, source) {
    return [...board.querySelectorAll(':scope > .kanban-col')].map((col) => {
      const body = col.querySelector('.kanban-col-body');
      const bodyRect = body.getBoundingClientRect();
      const mids = [...body.querySelectorAll(':scope > .task-card')]
        .filter((c) => c !== source)
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { node: c, mid: r.top + r.height / 2 - bodyRect.top + body.scrollTop };
        });
      return { col, body, rect: col.getBoundingClientRect(), mids, status: col.dataset.status, label: col.dataset.label };
    });
  }

  function startDrag(p) {
    drag.pending = null;
    const board = p.node.closest('.kanban');
    if (!board) return;
    clearTimeout(p.timer);

    const rect = p.node.getBoundingClientRect();
    p.board = board;
    p.cols = measure(board, p.node);
    p.scroll0 = board.scrollLeft;
    p.dx = p.x0 - rect.left;
    p.dy = p.y0 - rect.top;
    p.source = p.cols.find((c) => c.col.contains(p.node));
    p.target = p.source;
    p.index = -1;

    /*
     * השכבה הנגררת היא העתק ב-‎position: fixed‎ שזז ב-‎transform‎ בלבד —
     * בלי layout בכל תזוזה. הכרטיס המקורי נשאר במקומו, חיוור, כדי שיהיה
     * ברור מאיפה יצא ולאן ישוב אם הגרירה תבוטל.
     */
    const overlay = p.node.cloneNode(true);
    overlay.classList.add('kanban-drag-overlay');
    overlay.removeAttribute('tabindex');
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, { width: `${rect.width}px`, left: '0px', top: '0px' });
    if (reducedMotion()) overlay.classList.add('no-tilt');
    document.body.appendChild(overlay);
    p.overlay = overlay;

    p.placeholder = el('div.kanban-placeholder', { 'aria-hidden': 'true', style: { height: `${rect.height}px` } },
      [el('span', { text: 'שחררו כאן' })]);

    p.node.classList.add('is-ghost');
    board.classList.add('is-dragging');
    document.body.classList.add('kanban-dragging');
    if (p.type === 'mouse') { try { p.node.setPointerCapture?.(p.id); } catch { /* הכרטיס כבר אינו במסמך */ } }
    window.addEventListener('keydown', onDragKey, true);
    // רטט קצר בהרמה במגע — האישור היחיד שהלחיצה הארוכה נקלטה, לפני שהאצבע זזה
    if (p.type === 'touch') navigator.vibrate?.(12);

    drag.active = p;
    announce(`הורם: ${p.task.title}`);
    moveOverlay();
    updateTarget();
    autoScroll();
  }

  function moveOverlay() {
    const p = drag.active;
    if (!p) return;
    p.overlay.style.transform = `translate3d(${p.x - p.dx}px, ${p.y - p.dy}px, 0)`;
  }

  /**
   * העמודה היא זו שמכילה את הסמן אופקית, ואם אין כזו (רווח בין עמודות,
   * מחוץ ללוח) — הקרובה ביותר. כך שחרור במרווח שבין שתי עמודות אינו
   * "מפספס" ומחזיר את הכרטיס.
   */
  function updateTarget() {
    const p = drag.active;
    if (!p) return;
    const shift = p.board.scrollLeft - p.scroll0;
    const x = p.x + shift;
    const inside = p.cols.find((c) => x >= c.rect.left && x <= c.rect.right);
    const target = inside ?? p.cols.reduce((best, c) => {
      const d = Math.abs(x - (c.rect.left + c.rect.width / 2));
      return !best || d < best.d ? { c, d } : best;
    }, null).c;

    const y = p.y - target.body.getBoundingClientRect().top + target.body.scrollTop;
    const at = target.mids.findIndex((m) => m.mid > y);
    const index = at === -1 ? target.mids.length : at;

    if (target === p.target && index === p.index) return;
    if (target !== p.target) {
      p.target.col.classList.remove('drop-target');
      announce(`עמודה: ${target.label}`);
    }
    p.target = target;
    p.index = index;
    target.col.classList.add('drop-target');

    // בעמודת המקור הכרטיס החיוור עצמו הוא המציין — שם הוא ינחת אם ישוחרר
    if (target === p.source) { p.placeholder.remove(); return; }
    const before = target.mids[index]?.node ?? null;
    target.body.insertBefore(p.placeholder, before);
  }

  /** גלילה אופקית של הלוח כשהסמן קרוב לקצה — אחרת אין דרך להגיע לעמודה שמחוץ למסך */
  function autoScroll() {
    const p = drag.active;
    if (!p) return;
    const r = p.board.getBoundingClientRect();
    let v = 0;
    if (p.x < r.left + DRAG_EDGE_PX) v = -DRAG_EDGE_SPEED * Math.min(1, (r.left + DRAG_EDGE_PX - p.x) / DRAG_EDGE_PX);
    else if (p.x > r.right - DRAG_EDGE_PX) v = DRAG_EDGE_SPEED * Math.min(1, (p.x - (r.right - DRAG_EDGE_PX)) / DRAG_EDGE_PX);
    if (v) {
      // ‎scrollLeft‎ שלילי ב-RTL, אבל הכיוון עקבי: הקטנה = שמאלה בשני הכיוונים
      const before = p.board.scrollLeft;
      p.board.scrollLeft += v;
      if (p.board.scrollLeft !== before) updateTarget();
    }
    p.raf = requestAnimationFrame(autoScroll);
  }

  function cleanupDrag(p) {
    cancelAnimationFrame(p.raf);
    detachPointer();
    window.removeEventListener('keydown', onDragKey, true);
    p.overlay?.remove();
    p.placeholder?.remove();
    p.node.classList.remove('is-ghost');
    p.target?.col.classList.remove('drop-target');
    p.board.classList.remove('is-dragging');
    document.body.classList.remove('kanban-dragging');
    drag.active = null;
    drag.endedAt = performance.now();
  }

  function finishDrag(commit) {
    const p = drag.active;
    if (!p) return;
    const target = p.target;
    const changed = commit && target && target !== p.source;
    if (changed) {
      // העברה מיידית למקום שבו המציין עמד, לפני תשובת השרת — בלי הבהוב חזרה
      p.target.body.insertBefore(p.node, p.placeholder);
    }
    cleanupDrag(p);
    if (!commit) { announce('בוטל'); return; }
    if (!changed) { announce(`הונח ב-${p.source.label} — ללא שינוי`); return; }
    announce(`הונח ב-${target.label}`);
    moveTask(p.task, target.status, target.label);
  }

  /** אותו מסלול עדכון ששימש את השחרור של HTML5 — ההודעה, הטעינה וההתראות */
  async function moveTask(task, status, label) {
    try {
      await API.updateTask(task.id, { status });
      UI.success(`המשימה הועברה ל"${label}"`);
    } catch (err) {
      UI.error(err);
    }
    // גם בכישלון — הכרטיס כבר הוזז במסך, והטעינה מחזירה אותו למקומו האמיתי
    await load({ silent: true });
    App.refreshNotifications();
  }

  // ------------------------------------------------------------- גרירה במקלדת

  /*
   * רווח מרים, חצים ימינה ושמאלה מעבירים בין עמודות, רווח או Enter מניחים
   * ו-Escape מבטל. כל צעד מוכרז — משתמש קורא מסך אינו רואה את המציין.
   *
   * הכיוון נגזר מהסדר החזותי של העמודות על המסך, ולא מסדרן ב-DOM: ב-RTL
   * העמודה הראשונה היא הימנית, וחץ שמאלה חייב להוביל לעמודה שמשמאל.
   */
  let kbd = null;

  function keyboardDrag(e, task, node) {
    if (!kbd) {
      if (e.key !== ' ') return;
      e.preventDefault();
      const board = node.closest('.kanban');
      if (!board || drag.active) return;
      const cols = measure(board, node).sort((a, b) => a.rect.left - b.rect.left);
      const source = cols.find((c) => c.col.contains(node));
      kbd = { task, node, board, cols, source, target: source,
        placeholder: el('div.kanban-placeholder', { 'aria-hidden': 'true', style: { height: `${node.offsetHeight}px` } },
          [el('span', { text: 'שחררו כאן' })]) };
      node.classList.add('is-lifted');
      board.classList.add('is-dragging');
      source.col.classList.add('drop-target');
      announce(`הורם: ${task.title}. חיצים ימינה ושמאלה להעברה בין עמודות, רווח להנחה, Escape לביטול. עמודה: ${source.label}`);
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const at = kbd.cols.indexOf(kbd.target);
      const next = kbd.cols[at + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (!next) return;
      kbd.target.col.classList.remove('drop-target');
      kbd.target = next;
      next.col.classList.add('drop-target');
      if (next === kbd.source) kbd.placeholder.remove();
      else next.body.insertBefore(kbd.placeholder, next.body.firstChild);
      next.col.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      announce(`עמודה: ${next.label}`);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); kbdDrop(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); kbdCancel(); return; }
    // חיצים למעלה ולמטה אינם מגללים את הדף בזמן שהכרטיס מורם
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
  }

  function kbdEnd() {
    const k = kbd;
    kbd = null;
    k.placeholder.remove();
    k.node.classList.remove('is-lifted');
    k.target.col.classList.remove('drop-target');
    k.board.classList.remove('is-dragging');
    return k;
  }

  function kbdCancel() {
    if (!kbd) return;
    kbdEnd();
    announce('בוטל');
  }

  function kbdDrop() {
    const k = kbdEnd();
    if (k.target === k.source) { announce(`הונח ב-${k.source.label} — ללא שינוי`); return; }
    k.target.body.insertBefore(k.node, k.target.body.firstChild);
    // הכרטיס עובר עמודה ב-DOM, והטעינה תבנה אותו מחדש — המיקוד חוזר אליו אחריה
    pendingFocus = `card:${k.task.id}`;
    k.node.focus({ preventScroll: true });
    announce(`הונח ב-${k.target.label}`);
    moveTask(k.task, k.target.status, k.target.label);
  }

  // ------------------------------------------------------------- תצוגת קנבן

  function kanban() {
    // בתצוגת-על של ספקים מקבצים לפי בורד הספק; אחרת לפי עמודות הסטטוס
    const boards = currentScope === 'vendors'
      ? App.vendorBoards().filter((b) => !filters.boardId || String(b.id) === String(filters.boardId))
      : [App.internalBoard()].filter(Boolean);

    if (!boards.length) return UI.empty('אין בורדים להצגה', '📋');

    const sections = boards.map((board) => {
      const boardTasks = currentTasks.filter((t) => t.boardId === board.id);
      const cols = board.columns.map((col) => {
        const colTasks = boardTasks.filter((t) => t.status === col.key);
        const body = el('div.kanban-col-body', {}, colTasks.length
          ? colTasks.map(card)
          // מוצג רק בזמן גרירה (CSS) — עמודה ריקה נראית אחרת "לא מקום"
          : [el('div.kanban-empty-hint', { 'aria-hidden': 'true', text: 'שחררו כאן' })]);

        return el('div.kanban-col', { dataset: { status: col.key, label: col.label } }, [
          el('div.kanban-col-head', {}, [
            el('span.dot', { style: { background: col.color } }),
            el('h4', { text: col.label }),
            el('span.num', { text: String(colTasks.length) })
          ]),
          body
        ]);
      });

      return el('div', { style: { marginBottom: '22px' } }, [
        boards.length > 1
          ? el('h3', { text: board.name, style: { marginBottom: '10px', fontSize: '15px', color: 'var(--accent)' } })
          : null,
        el('div.kanban', {}, cols)
      ]);
    });

    if (!currentTasks.length) {
      return el('div', {}, [...sections, UI.empty('אין משימות התואמות את הסינון הנוכחי', '🔍')]);
    }
    return el('div', {}, sections);
  }

  // ------------------------------------------------------------- ציר זמן

  /*
   * הזום הוא פיקסלים ליום, ולא אחוזים מרוחב המסך. באחוזים כל משימה של
   * יומיים הייתה פס של כמה פיקסלים בטווח של חודשיים, והשם שבתוכו נמחץ עד
   * שלא נשאר ממנו דבר. בפיקסלים ליום הציר פשוט ארוך יותר מהמסך — ונגלל.
   */
  const TL_ZOOM = { day: 30, week: 9, month: 2.6 };
  const TL_ZOOM_LABEL = { day: 'יום', week: 'שבוע', month: 'חודש' };
  const TL_LABEL_W = { desk: 230, phone: 120 };   // רוחב עמודת השמות — זהה ל-CSS
  const TL_INSIDE_MIN = 60;                         // פס צר מזה מקבל את התווית מחוצה לו
  const DAY_MS = 86400000;

  const timelineZoom = () => {
    const z = App.getPref('timelineZoom');
    return TL_ZOOM[z] ? z : 'week';
  };

  function zoomSwitch() {
    const current = timelineZoom();
    return el('div.seg.tl-zoom', { role: 'group', 'aria-label': 'זום ציר הזמן' },
      Object.keys(TL_ZOOM).map((z) => el(`button${z === current ? '.active' : ''}`, {
        type: 'button',
        'aria-pressed': String(z === current),
        dataset: { fk: `zoom:${z}` },
        onclick: () => {
          App.setPref('timelineZoom', z);
          pendingFocus = `zoom:${z}`;
          draw();
        }
      }, [TL_ZOOM_LABEL[z]])));
  }

  /*
   * תווית בכל יום (זום יום), בכל יום ראשון (שבוע — השבוע הישראלי מתחיל
   * בראשון), או בראשון לכל חודש (חודש). תוויות במרווח קבוע מ"היום" הציגו
   * תאריכים שרירותיים; קווים בתחילת שבוע וחודש הם מה שהעין מחפשת.
   */
  function timelineTicks(start, days, unit, zoom) {
    const ticks = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const first = d.getDate() === 1;
      let text = null;
      if (zoom === 'day') text = first ? `${d.getDate()}.${d.getMonth() + 1}` : String(d.getDate());
      else if (zoom === 'week' && d.getDay() === 0) text = `${d.getDate()}.${d.getMonth() + 1}`;
      else if (zoom === 'month' && first) text = d.toLocaleDateString('he-IL', { month: 'short', year: '2-digit' });
      if (text === null) continue;
      ticks.push(el(`div.tl-tick${first ? '.is-month' : ''}${zoom === 'day' && [5, 6].includes(d.getDay()) ? '.is-weekend' : ''}`, {
        style: { insetInlineStart: `${i * unit}px` }
      }, [el('span.tl-tick-label', { text })]));
    }
    return ticks;
  }

  function timeline() {
    const withDates = currentTasks.filter((t) => t.dueDate);
    if (!withDates.length) return UI.empty('אין משימות עם תאריך יעד להצגה בציר הזמן', '📅');

    const zoom = timelineZoom();
    const today = new Date(); today.setHours(0, 0, 0, 0);

    /*
     * הציר מתחיל במשימה הוותיקה ביותר (הפס מתחיל ביום פתיחתה), אך לא יותר
     * מ-120 יום אחורה — משימה פתוחה מלפני שנה הייתה מותחת את כל הציר בשביל
     * פס אחד. מה שנפתח לפני כן פשוט נחתך בקצה, כמו קודם.
     */
    const earliest = Math.min(today.getTime() - 7 * DAY_MS,
      ...withDates.map((t) => new Date(t.createdAt ?? t.dueDate).getTime()));
    const start = new Date(Math.max(earliest, today.getTime() - 120 * DAY_MS));
    start.setHours(0, 0, 0, 0);
    const maxDate = Math.max(...withDates.map((t) => new Date(t.dueDate).getTime()), today.getTime() + 14 * DAY_MS);
    const end = new Date(maxDate); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 4);
    const days = Math.max(1, Math.round((end - start) / DAY_MS));

    /*
     * כשהטווח קצר והמסך רחב, הזום מתמתח למילוי הרוחב — ציר שתופס חצי מסך
     * ומשאיר חצי ריק נראה כמו תקלה. ‎containerRef‎ כבר במסמך, ולכן אפשר
     * למדוד אותו לפני שהציר עצמו נבנה.
     */
    const labelW = isPhone() ? TL_LABEL_W.phone : TL_LABEL_W.desk;
    const avail = Math.max(0, (containerRef?.clientWidth ?? 0) - labelW - 64);
    const unit = Math.max(TL_ZOOM[zoom], avail / days);
    const chartW = Math.ceil(days * unit);
    const px = (date) => ((new Date(date) - start) / DAY_MS) * unit;
    const todayX = px(today);

    // קבוצה לכל פרויקט — הסדר לפי היעד הקרוב בקבוצה, כמו סדר השורות בתוכה
    const groups = new Map();
    for (const t of [...withDates].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))) {
      const key = t.projectId ?? 'none';
      if (!groups.has(key)) groups.set(key, { name: t.projectName || 'ללא פרויקט', color: t.projectColor || 'var(--text-mute)', tasks: [] });
      groups.get(key).tasks.push(t);
    }

    const row = (t) => {
      const endX = px(t.dueDate);
      // משימה שנפתחה אחרי היעד שלה, או בלי תאריך פתיחה — פס של יום אחד לפני היעד
      const created = t.createdAt && new Date(t.createdAt) < new Date(t.dueDate) ? t.createdAt : null;
      const startX = Math.max(0, created ? px(created) : endX - unit);
      const width = Math.max(6, endX - startX);
      const inside = width >= TL_INSIDE_MIN;
      const who = t.assigneeName ?? '';
      const tip = `${t.title}${who ? ` · ${who}` : ''} — יעד ${UI.formatDate(t.dueDate)}`;

      return el('div.tl-row', {}, [
        el('button.tl-label', { type: 'button', text: t.title, title: t.title, onclick: () => TaskCardView.open(t.id) }),
        el('div.tl-track', { style: { width: `${chartW}px` } }, [
          el('div.tl-bar', {
            style: {
              insetInlineStart: `${startX}px`,
              width: `${width}px`,
              background: t.overdue ? 'var(--danger)' : t.isFinal ? 'var(--ok)' : t.statusColor
            },
            title: tip,
            'aria-hidden': 'true',
            onclick: () => TaskCardView.open(t.id)
          }, [inside ? el('span.tl-bar-text', { text: who }) : null]),
          // פס צר אינו מקום לטקסט — התווית יושבת אחרי סוף הפס, קריאה ושלמה
          !inside && who
            ? el('span.tl-bar-out', { text: who, 'aria-hidden': 'true', style: { insetInlineStart: `${startX + width + 6}px` } })
            : null
        ])
      ]);
    };

    const lanes = [...groups.values()].map((g) => el('div.tl-lane', {}, [
      // רצועת הכותרת צבועה בצבע הפרויקט — אותו צבע של הפס בכרטיס ושל הנקודה בתפריט
      el('div.tl-lane-head', {
        style: {
          borderInlineStartColor: g.color,
          background: `color-mix(in srgb, ${g.color} 11%, var(--surface))`
        }
      }, [
        el('span.tl-lane-name', {}, [el('span.project-dot', { style: { background: g.color } }), g.name,
          el('span.tl-lane-num', { text: String(g.tasks.length) })])
      ]),
      ...g.tasks.map(row)
    ]));

    const node = el('div.timeline', {}, [
      el('div.tl-scroll', { tabindex: '0', role: 'region', 'aria-label': 'ציר זמן המשימות' }, [
        el('div.tl-grid', { style: { width: `${labelW + chartW + 140}px` } }, [
          el('div.tl-head', {}, [
            el('div.tl-label', { text: 'משימה' }),
            el('div.tl-days', { style: { width: `${chartW}px` } }, [
              ...timelineTicks(start, days, unit, zoom),
              el('div.tl-today-mark', { style: { insetInlineStart: `${todayX}px` } },
                [el('span', { text: `היום ${today.getDate()}.${today.getMonth() + 1}` })])
            ])
          ]),
          // קו היום לכל גובה הציר — שכבה אחת מעל כל השורות, ולא קו בכל שורה
          el('div.tl-today-line', { 'aria-hidden': 'true', style: { insetInlineStart: `${labelW + todayX}px` } }),
          ...lanes
        ])
      ])
    ]);
    // משתנה CSS אינו נכנס דרך ‎Object.assign‎ על ‎style‎ — רק ‎setProperty‎
    node.style.setProperty('--tl-label-w', `${labelW}px`);
    return node;
  }

  /*
   * בפתיחה הציר נגלל כך ש"היום" באמצע. לא דרך ‎scrollLeft‎: ב-RTL הערך שלו
   * שלילי בכרום ובפיירפוקס וחיובי בגרסאות ישנות של ספארי — ‎scrollIntoView‎
   * מחשב את זה בעצמו בכל דפדפן.
   */
  function scrollTimelineToToday() {
    const mark = containerRef?.querySelector('.tl-today-mark');
    mark?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ------------------------------------------------------------- דיאלוג משימה

  /**
   * ‎opts.prefill‎ — ערכים התחלתיים למשימה חדשה (מהקלטה, מפגישה ביומן):
   * ‎title, description, projectId, assignee ('user:12'), priority, dueDate
   * ('YYYY-MM-DD'), checklist[], statusShort, recurrence, activateDate‎.
   * ‎opts.voice‎ — נפתח מהקלטה: ‎{ transcript, warnings, uncertain[] }‎ — מה שלא
   * ודאי מסומן לבדיקה, ו"🎙 הוסף עוד" ממשיך את אותה הקלטה.
   * ‎opts.onSaved‎ — נקרא אחרי שמירה.
   */
  function openTaskDialog(task = null, opts = {}) {
    const isEdit = !!task;
    const pre = (!isEdit && opts.prefill) || {};
    const titleInput = el('input', { type: 'text', value: task?.title ?? pre.title ?? '', placeholder: 'מה צריך לעשות?' });
    const descInput = el('textarea', { placeholder: 'תיאור מפורט (אופציונלי)' });
    descInput.value = task?.description ?? pre.description ?? '';

    /**
     * בורר הפרויקטים — חיפוש ודירוג, ולא רשימה מסוננת.
     *
     * שתי גרסאות קודמות ניסו לצמצם את הרשימה ונכשלו, כל אחת מסיבה אחרת.
     * הראשונה סיננה לפי מחלקת הפרויקט, שנגזרת ממנהל המשימות שלו — ומכיוון
     * שלרוב הפרויקטים אין מנהל, החריג "פרויקט בלי מנהל מוצג לכולם" בלע את
     * הכלל. השנייה סיננה לפי ‎mine‎, אבל בארגון שבו מנהל המערכת מוגדר מנהל
     * של כמעט כל פרויקט הדגל דולק אצל כולם והרשימה נשארה באורך מלא.
     *
     * המסקנה: סינון בינארי אינו הכלי. הרשימה נשארת מלאה — פרויקט לעולם
     * אינו "נעלם" — אבל היא ניתנת לחיפוש ומדורגת לפי כמה אני עובד בפועל בכל
     * פרויקט (‎myTaskCount‎ מהשרת), ואחריו המחלקה שלי. מי שמחפש מקליד, ומי
     * שלא — מוצא בראש את מה שהוא נוגע בו כל יום.
     */
    const current = task?.projectId ?? (pre.projectId || opts.projectId) ?? '';
    // רק פרויקטים שבהם מותר לי לפתוח משימה (‎canAddTask‎ מהשרת) — והפרויקט הנוכחי, שלא יתאפס
    const projectPicker = UI.projectPicker({
      value: current,
      projects: App.state.projects.filter((p) => p.canAddTask || String(p.id) === String(current))
    });

    /*
     * חברי המחלקה של הפותח בראש הרשימה, תחת כותרת. בארגון של חמישים אנשים
     * רשימה אלפביתית מציבה את מי שיושב איתי באמצע, וכמעט תמיד אליו אני
     * מקצה — בעיקר כשהשם ארוך והרשימה נגללת. אותו סדר שכבר קיים בתיוג ‎@‎.
     *
     * ‎optgroup‎ ולא סתם סדר: כותרת מסבירה למה הסדר אינו אלפביתי, ובלעדיה
     * זה נראה כמו רשימה מבולגנת.
     */
    const userOption = (u) => ({
      value: `user:${u.id}`,
      // רמת הגישה מצורפת לשם רק כשהצופה רשאי לראות רמות
      label: u.roleLabel ? `${u.name} — ${u.roleLabel}` : u.name
    });
    const { near, far, deptName } = UI.usersByDepartment({
      keep: [task?.assigneeType === 'user' ? task.assigneeId : null, ...(task?.extraAssignees ?? []).filter((e) => e.type === 'user').map((e) => e.id)].filter(Boolean)
    });

    const vendorOptions = App.may('assign_task_to_vendor')
      ? App.state.vendors.filter((v) => v.status === 'active')
        .map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק חיצוני)` }))
      : [];

    const assigneeOptions = [
      { value: '', label: 'ללא אחראי' },
      // קבוצות רק כשיש בהן טעם — במחלקה אחת בלבד הכותרות היו רעש
      ...(near.length && far.length
        ? [
            { label: deptName, options: near.map(userOption) },
            { label: 'שאר הארגון', options: far.map(userOption) }
          ]
        : [...near, ...far].map(userOption)),
      ...(vendorOptions.length
        ? [{ label: 'ספקים חיצוניים', options: vendorOptions }]
        : [])
    ];
    /*
     * במשימה חדשה האחראי הוא מי שפותח אותה. רוב המשימות נפתחות בשביל עצמי,
     * ו"ללא אחראי" כברירת מחדל יצר משימות יתומות שאינן מופיעות אצל אף אחד
     * בדף הבית — כלומר בדיוק המשימות שנשכחות. מי שפותח בשביל אחר משנה שורה
     * אחת; מי שפותח לעצמו אינו צריך לעשות דבר.
     *
     * ספק אינו ברירת מחדל לעצמו: הוא ממילא אינו פותח משימות.
     */
    const meAsAssignee = App.state.actor && !App.isVendor()
      ? `user:${App.state.actor.id}`
      : '';
    const assigneeSelect = UI.select(assigneeOptions,
      task?.assigneeId ? `${task.assigneeType}:${task.assigneeId}` : (isEdit ? '' : pre.assignee || meAsAssignee));

    /*
     * אחראים נוספים.
     *
     * רשימה ולא שדה בודד: משימה שמתחלקת בין שניים מתחלקת לפעמים בין שלושה,
     * ושדה "אחראי שני" היה מזמין מיד את הבקשה לשלישי.
     *
     * מאותה רשימת אפשרויות של האחראי הראשי, ולכן ספק יכול להיות אחראי נוסף
     * בזמן שהאחראי הראשי הוא עובד פנימי — האחראי הראשי הוא זה שקובע באיזה
     * בורד המשימה יושבת, ואחראי נוסף אינו מזיז אותה.
     */
    const extraAssignees = (task?.extraAssignees ?? []).map((e) => `${e.type}:${e.id}`);
    const extraList = el('div.extra-assignees');
    let assigneePicker = null;  // העיגולים — נבנים אחרי ‎drawExtras‎, שמרענן אותם

    const drawExtras = () => {
      const taken = new Set([assigneeSelect.value, ...extraAssignees].filter(Boolean));
      // מי שכבר נבחר אינו מוצע שוב — אותו אדם פעמיים אינו שתי אחריויות
      const free = assigneeOptions
        .map((o) => (o.options ? { ...o, options: o.options.filter((x) => !taken.has(x.value)) } : o))
        .filter((o) => (o.options ? o.options.length : o.value && !taken.has(o.value)));

      const labelOf = (value) => {
        for (const o of assigneeOptions) {
          if (o.options) { const hit = o.options.find((x) => x.value === value); if (hit) return hit.label; }
          else if (o.value === value) return o.label;
        }
        // אחראי שאינו ברשימה (ספק למי שאין לו הרשאת ספקים) — לפי מה שהשרת שלח
        const known = (task?.extraAssignees ?? []).find((e) => `${e.type}:${e.id}` === value);
        return known?.name ?? value;
      };

      UI.mount(extraList,
        ...extraAssignees.map((value) => el('span.chip.chip-assignee', {}, [
          el('span', { text: labelOf(value) }),
          el('button.chip-x', {
            type: 'button', title: 'הסרה',
            onclick: () => {
              extraAssignees.splice(extraAssignees.indexOf(value), 1);
              drawExtras();
            }
          }, ['✕'])
        ])),
        free.length
          ? UI.select([{ value: '', label: '＋ הוספת אחראי נוסף…' }, ...free], '', {
              class: 'extra-add',
              onchange: (e) => {
                if (!e.target.value) return;
                extraAssignees.push(e.target.value);
                drawExtras();
              }
            })
          : el('span.mute-sm', { text: 'אין עוד למי להוסיף' })
      );
      assigneePicker?.redraw();
    };
    drawExtras();
    /*
     * עיגולים במקום הרשימה הנפתחת — הראשון הוא מי שאני הכי הרבה מטיל עליו.
     * במשימה חדשה בלי אחראי שנקבע מראש (הקלטה, תת-משימה) הוא גם נבחר מעצמו.
     */
    assigneePicker = AssigneePicker.create({
      select: assigneeSelect,
      options: assigneeOptions,
      extras: extraAssignees,
      onExtras: drawExtras,
      autoPick: !isEdit && !pre.assignee
    });
    // החלפת האחראי הראשי מוציאה אותו מרשימת האחראים הנוספים אם הוא בה
    assigneeSelect.addEventListener('change', () => {
      const at = extraAssignees.indexOf(assigneeSelect.value);
      if (at !== -1) extraAssignees.splice(at, 1);
      drawExtras();
    });

    const prioritySelect = UI.select(App.state.priorities.map((p) => ({ value: p.key, label: p.label })), task?.priority ?? pre.priority ?? 'normal');
    const dueInput = el('input', { type: 'date', value: isEdit ? UI.toInputDate(task?.dueDate) : pre.dueDate ?? '' });
    const activateInput = el('input', { type: 'date', value: isEdit ? UI.toInputDate(task?.activateAt) : pre.activateDate ?? '' });

    const dependencyOptions = [{ value: '', label: 'ללא תלות' },
      ...currentTasks.filter((t) => !task || t.id !== task.id).map((t) => ({ value: t.id, label: `#${t.id} — ${t.title}` }))];
    const dependsSelect = UI.select(dependencyOptions, task?.dependsOnTaskId ?? '');

    const recurringCheck = el('input', { type: 'checkbox', checked: !!task?.isRecurring || Boolean(pre.recurrence) });
    const freqSelect = UI.select(
      [{ value: 'daily', label: 'יומי' }, { value: 'weekly', label: 'שבועי' }, { value: 'monthly', label: 'חודשי' }],
      task?.recurrenceFreq ?? (pre.recurrence || 'weekly')
    );
    const policySelect = UI.select([
      { value: 'inherit', label: 'לפי ברירת המחדל של המערכת' },
      { value: 'skip_if_open', label: 'לא ליצור מופע חדש עד לסגירת הקודם' },
      { value: 'always', label: 'ליצור מופע חדש בכל מקרה' }
    ], task?.recurrencePolicy ?? 'inherit');

    const recurringBox = el('div', { style: { display: recurringCheck.checked ? 'block' : 'none' } }, [
      el('div.row', {}, [UI.field('תדירות', freqSelect), UI.field('מדיניות חפיפה', policySelect)])
    ]);
    recurringCheck.addEventListener('change', () => {
      recurringBox.style.display = recurringCheck.checked ? 'block' : 'none';
    });

    const checklistInput = el('textarea', { placeholder: 'סעיף בכל שורה (אופציונלי)', style: { minHeight: '62px' } });
    checklistInput.value = (pre.checklist ?? []).join('\n');

    /**
     * תבנית משימה. עד כה אפשר היה לשמור תבניות מסוג 'task' ומעולם לא היה
     * מקום להשתמש בהן. בחירת תבנית ממלאת את הכותרת, התיאור, העדיפות
     * והצ'קליסט — ומכאן אפשר לשנות כל שדה לפני היצירה.
     */
    let taskTemplates = [];
    const taskTemplateSelect = UI.select([{ value: '', label: 'ללא תבנית' }], '');
    const taskTemplateField = UI.field('יצירה מתבנית', taskTemplateSelect,
      'ממלא את הכותרת, התיאור, העדיפות והצ׳קליסט. אפשר לשנות הכול לאחר מכן.');
    taskTemplateField.style.display = 'none';

    if (!isEdit) {
      API.templates().then((data) => {
        taskTemplates = (data.templates ?? []).filter((t) => t.kind === 'task');
        if (!taskTemplates.length) return;
        for (const t of taskTemplates) {
          taskTemplateSelect.appendChild(el('option', { value: String(t.id) }, [t.name]));
        }
        taskTemplateField.style.display = '';
      }).catch(() => { /* תבניות אינן תנאי ליצירת משימה */ });

      taskTemplateSelect.addEventListener('change', () => {
        const tpl = taskTemplates.find((t) => String(t.id) === taskTemplateSelect.value);
        if (!tpl) return;
        const p = tpl.payload ?? {};
        if (p.title) titleInput.value = p.title;
        if (p.description) descInput.value = p.description;
        if (p.priority) prioritySelect.value = p.priority;
        // הסעיפים נכתבים לתיבת הטקסט, כדי שיהיו ניתנים לעריכה לפני השמירה
        checklistInput.value = (p.checklist ?? [])
          .map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
        titleInput.focus();
      });
    }

    /*
     * משימה רגילה או משימת AI. רק ביצירה ורק ברמה הראשית: משימת AI היא
     * פנייה לאדם מחוץ למשימה, ואין לה משמעות כתת-משימה או כעריכה.
     */
    const modeToggle = !isEdit && !opts.parentTaskId && !App.isVendor()
      ? el('div.task-mode-row', {}, [
          el('div.seg.task-mode', {}, [
            el('button.active', { type: 'button' }, ['משימה רגילה']),
            el('button', {
              type: 'button',
              title: 'ה-AI ינסח פנייה, ישלח אחרי אישורך, ויעקוב עד שתתקבל תשובה',
              onclick: () => { m.close(); AiTaskView.openDialog({ projectId: opts.projectId ?? '' }); }
            }, ['✨ משימת AI'])
          ]),
          el('div.spacer'),
          // הכתבה — אומרים את המשימה, והדיאלוג נפתח שוב ממולא
          el('button.btn.btn-sm', {
            type: 'button',
            title: 'לומר את המשימה במקום להקליד',
            onclick: () => {
              m.close();
              opts.voice
                ? VoiceView.open({ baseText: opts.voice.transcript, forcePreview: true })
                : VoiceView.open({ forcePreview: true });
            }
          }, [opts.voice ? '🎙 הוסף עוד' : '🎙 הכתבה'])
        ])
      : null;

    /*
     * מהקלטה: מה שלא ודאי מסומן בצהוב, והאזהרות למעלה — כדי שהבדיקה תהיה של
     * שדה אחד ולא של כל הטופס.
     */
    const voice = !isEdit ? opts.voice : null;
    const fieldOf = (key, label, control, hint) => {
      const node = UI.field(label, control, hint);
      if (voice?.uncertain?.includes(key)) node.classList.add('field-warn');
      return node;
    };
    const voiceBox = voice
      ? el('div.alert.alert-info.voice-from', {}, [
          el('span', { text: '🎙' }),
          el('div', {}, [
            el('div.mute-sm', { text: `נשמע: "${voice.transcript}"` }),
            ...(voice.warnings ?? []).map((w) => el('div.voice-warn', { text: `⚠ ${w.text}` }))
          ])
        ])
      : null;

    const body = el('div', {}, [
      modeToggle,
      voiceBox,
      fieldOf('title', 'כותרת המשימה', titleInput),
      UI.field('תיאור', descInput),
      // האחראי בשורה משלו — העיגולים צריכים רוחב
      fieldOf('assignee', 'אחראי', assigneePicker.node, 'משימה ללא אחראי לא תופיע ב"המשימות שלי" של אף אחד'),
      fieldOf('projectId', 'פרויקט', projectPicker, 'משימה ללא פרויקט תופיע בלוח בקבוצת "ללא פרויקט"'),
      UI.field('אחראים נוספים', extraList,
        'המשימה תופיע גם אצלם, והם יקבלו את ההתראות. אפשר לצרף גם ספק חיצוני — המשימה נשארת בלוח הפנימי'),
      el('div.row', {}, [UI.field('עדיפות', prioritySelect), fieldOf('dueDate', 'תאריך יעד', dueInput)]),
      el('div.row', {}, [
        UI.field('תלות במשימה אחרת', dependsSelect, 'המשימה לא תיסגר לפני שהמשימה החוסמת תושלם'),
        UI.field('תאריך הפעלה (משימה עתידית)', activateInput, 'עד למועד זה המשימה לא תופיע ברשימות הפעילות')
      ]),
      !isEdit ? taskTemplateField : null,
      !isEdit ? UI.field('צ׳קליסט', checklistInput) : null,
      el('div.field', {}, [
        el('label.checkbox', {}, [recurringCheck, 'משימה חוזרת']),
        recurringBox
      ])
    ]);

    const saveBtn = el('button.btn.btn-primary', {}, [isEdit ? 'שמירת שינויים' : 'שמירה']);
    // יצירה אינה פותחת את הכרטיס המלא מעצמה — מי שרוצה להמשיך לערוך בוחר בזה
    const saveOpenBtn = isEdit ? null : el('button.btn', {}, ['שמירה ופתיחה בהרחבה']);
    const m = UI.modal({
      title: isEdit
        ? `עריכת משימה #${task.id}`
        : (opts.parentTitle ? `תת-משימה בתוך "${opts.parentTitle}"` : 'משימה חדשה'),
      body,
      footer: [saveBtn, saveOpenBtn, el('div.spacer')]
    });

    const save = async ({ openAfter = false } = {}) => {
      const title = titleInput.value.trim();
      if (!title) return UI.toast('נדרשת כותרת למשימה', 'error');
      const [aType, aId] = assigneeSelect.value ? assigneeSelect.value.split(':') : [null, null];

      const payload = {
        title,
        description: descInput.value,
        projectId: projectPicker.value() || null,
        assigneeType: aType,
        assigneeId: aId ? Number(aId) : null,
        // תמיד נשלח, גם כשריק: רשימה ריקה היא הסרת כל האחראים הנוספים
        extraAssignees,
        priority: prioritySelect.value,
        dueDate: UI.fromInputDate(dueInput.value),
        activateAt: UI.fromInputDate(activateInput.value),
        dependsOnTaskId: dependsSelect.value || null,
        isRecurring: recurringCheck.checked,
        recurrenceFreq: freqSelect.value,
        recurrencePolicy: policySelect.value
      };
      // בלי הרשאה להטיל משימה ארגונית לא שולחים את השדה כלל, כדי שעריכה של
      // משימה ארגונית קיימת לא תוריד אותה בשוגג לרמה המחלקתית
      if (!isEdit) {
        payload.checklist = checklistInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (pre.statusShort) payload.statusShort = pre.statusShort;
        // תת-משימה: נשלח רק ביצירה, כי העברת משימה קיימת תחת אב היא פעולה אחרת
        if (opts.parentTaskId) payload.parentTaskId = opts.parentTaskId;
      }

      saveBtn.disabled = true;
      if (saveOpenBtn) saveOpenBtn.disabled = true;
      try {
        let created = null;
        if (isEdit) await API.updateTask(task.id, payload);
        else created = await API.createTask(payload);
        m.close();
        /**
         * משימה חדשה אינה נפתחת מעצמה — הכרטיס המלא קפץ גם למי שרק רצה
         * לרשום משימה ולהמשיך. כדי שלא "תיעלם" (משימה בלי אחראי אינה בדף
         * הבית, ובלי פרויקט היא בתחתית הלוח), ההודעה אומרת אצל מי ובאיזה
         * פרויקט היא יושבת, עם "פתיחה". מי שרוצה להמשיך לערוך — "שמירה
         * ופתיחה בהרחבה".
         */
        if (!isEdit) AssigneePicker.refresh();
        if (isEdit) UI.success('המשימה עודכנה');
        else if (!openAfter) UI.taskCreated(created?.task);
        await App.reloadReference();
        // הדיאלוג נפתח גם מהסרגל העליון, כשהמסך שמאחוריו אינו הלוח
        await App.refreshView();
        App.refreshNotifications();
        opts.onSaved?.(created?.task ?? null);
        if (openAfter && created?.task?.id) TaskCardView.open(created.task.id);
      } catch (err) {
        saveBtn.disabled = false;
        if (saveOpenBtn) saveOpenBtn.disabled = false;
        UI.error(err);
      }
    };
    saveBtn.addEventListener('click', () => save());
    saveOpenBtn?.addEventListener('click', () => save({ openAfter: true }));
  }

  // ------------------------------------------------------------- דיאלוג פרויקט

  /**
   * מחיקת פרויקט, כולל האישור. זרימה אחת שמשרתת גם את דיאלוג העריכה וגם את
   * תפריט ההקלקה הימנית בתפריט הצד — שני אישורים נפרדים היו מתפצלים ברגע
   * שהכללים בשרת ישתנו, ואז מסך אחד היה מבטיח משהו שהשני אינו מקיים.
   *
   * האישור אומר בדיוק מה יקרה, עם המספרים האמיתיים של הפרויקט הזה. המשימות
   * אינן נמחקות — הן עוברות ל"ללא פרויקט" — וזה ההבדל בין פעולה שאפשר
   * להתאושש ממנה לבין מחיקה של עבודה, והמשתמש צריך לדעת אותו לפני הלחיצה
   * ולא אחריה.
   */
  async function deleteProjectFlow(project, { onDeleted } = {}) {
    const parts = [`הפרויקט "${project.name}" יימחק.`];
    /*
     * המונה שבתפריט סופר עבודה פעילה בלבד, אך המחיקה מנתקת גם את הארכיון —
     * ולכן הספירה כאן היא של שניהם יחד. המספר באישור חייב להיות אותו מספר
     * שיוחזר אחרי המחיקה, אחרת האישור מבטיח דבר אחד והדיווח אומר אחר.
     */
    const archived = project.tasksArchived ?? 0;
    const moving = (project.tasksTotal ?? 0) + archived;
    if (moving) {
      parts.push(`${moving} המשימות שבו לא יימחקו — הן יעברו ל"ללא פרויקט"${
        archived ? ` (${archived} מהן בארכיון).` : ' ויישארו בלוח.'}`);
    }
    if (project.subProjectsCount) {
      parts.push(`${project.subProjectsCount} תתי-פרויקטים יעלו לרמה הראשית.`);
    }
    parts.push('הלוגו והתמונות של הפרויקט יימחקו לצמיתות.');

    if (!await UI.confirm(parts.join(' '), {
      title: 'מחיקת פרויקט', danger: true, okText: 'מחיקת הפרויקט'
    })) return false;

    try {
      const r = await API.deleteProject(project.id);
      onDeleted?.();
      await App.reloadReference();
      /*
       * רק מי שעומד על הלוח של הפרויקט שנמחק חייב לזוז ממנו. מי שמחק פרויקט
       * מתפריט הצד תוך כדי עבודה במסך אחר נשאר במקומו — הזזתו הייתה מאבדת לו
       * את ההקשר בלי סיבה.
       */
      if (String(App.state.route.params?.projectId ?? '') === String(project.id)) {
        App.navigate('board');
      } else {
        App.refreshChrome();
        await App.refreshView();
      }
      UI.success(r.tasksDetached
        ? `הפרויקט נמחק · ${r.tasksDetached} משימות עברו ל"ללא פרויקט"`
        : 'הפרויקט נמחק');
      return true;
    } catch (err) {
      UI.error(err);
      return false;
    }
  }

  function openProjectDialog(project = null, opts = {}) {
    const isEdit = !!project;
    const nameInput = el('input', { type: 'text', value: project?.name ?? '' });

    /*
     * פרויקט אב. מוצעים רק פרויקטים ראשיים — שתי רמות בלבד, והשרת כופה זאת
     * בכל מקרה. הפרויקט הנערך עצמו מוחרג, כדי שלא ייבחר כאב של עצמו.
     */
    const parentOptions = [
      { value: '', label: 'פרויקט ראשי (ללא אב)' },
      ...App.state.projects
        .filter((p) => !p.parentProjectId && p.status !== 'done' && (!project || p.id !== project.id))
        .map((p) => ({ value: p.id, label: p.name }))
    ];
    const parentSelect = UI.select(parentOptions,
      String(project?.parentProjectId ?? opts.parentProjectId ?? ''));

    /*
     * רשימת סטטוסי הבקרה שתחול על הפרויקט. הרשימות אישיות — כל אחד בונה את
     * שלו — והבחירה כאן היא מה שמפעיל את צביעת השורות במסך הבקרה. בלי בחירה
     * הפרויקט אינו נצבע בכלל, וזו ברירת המחדל.
     *
     * הרשימות נטענות בפתיחת הדיאלוג ולא מגיעות ב-bootstrap: הן משתנות לעיתים
     * רחוקות, ורוב פתיחות הדיאלוג אינן נוגעות בשדה הזה.
     */
    const statusOwnerSelect = UI.select([{ value: '', label: 'ללא צביעה' }], String(project?.statusOwnerId ?? ''));
    API.statusList().then((d) => {
      for (const l of d.lists ?? []) {
        const mine = l.ownerId === App.state.actor?.id;
        statusOwnerSelect.appendChild(el('option', { value: l.ownerId },
          [`${mine ? 'הרשימה שלי' : `הרשימה של ${l.ownerName}`} (${l.count} סטטוסים)`]));
      }
      statusOwnerSelect.value = String(project?.statusOwnerId ?? '');
    }).catch(() => {});
    const descInput = el('textarea');
    descInput.value = project?.description ?? '';
    /*
     * בפרויקט חדש המנהל הוא מי שפותח אותו, כמו האחראי במשימה חדשה. מי שפותח
     * פרויקט בשביל מישהו אחר משנה שורה אחת, ומי שפותח לעצמו אינו נדרש לדבר.
     */
    // אותה קבוצה בראש הרשימה כמו באחראי משימה — ראה ההסבר שם
    const pMyDept = App.state.actor?.departmentId ?? null;
    const pNear = pMyDept ? App.state.users.filter((u) => u.departmentId === pMyDept) : [];
    const pFar = App.state.users.filter((u) => !pNear.includes(u));
    const pOption = (u) => ({ value: u.id, label: u.name });

    const managerSelect = UI.select(
      [
        { value: '', label: 'ללא מנהל' },
        ...(pNear.length && pFar.length
          ? [
              { label: App.state.actor.department || 'המחלקה שלי', options: pNear.map(pOption) },
              { label: 'שאר הארגון', options: pFar.map(pOption) }
            ]
          : [...pNear, ...pFar].map(pOption))
      ],
      project?.managerId ?? (isEdit || App.isVendor() ? '' : App.state.actor?.id ?? '')
    );
    const startInput = el('input', { type: 'date', value: UI.toInputDate(project?.startDate) });
    const dueInput = el('input', { type: 'date', value: UI.toInputDate(project?.dueDate) });
    const statusSelect = UI.select([
      { value: 'active', label: 'פעיל' }, { value: 'frozen', label: 'מוקפא' }, { value: 'done', label: 'הושלם' }
    ], project?.status ?? 'active');

    /**
     * צבע הפרויקט. לכל פרויקט יש כבר צבע — נגזר ממזההו — ולכן הבורר נפתח על
     * הצבע שרואים בפועל, ולא על ריק שהיה מרמז שאין צבע.
     */
    const colorInput = el('input', { type: 'color', value: project?.color ?? '#0f766e' });
    const colorSwatches = el('div.color-swatches', {}, UI.PROJECT_COLORS.map((c) =>
      el('button.color-swatch', {
        type: 'button', title: c, style: { background: c },
        onclick: () => { colorInput.value = c; }
      })
    ));

    /**
     * לוגו וגלריית תמונות. זמינים רק בעריכה ולא ביצירה: התמונות נשמרות מול
     * מזהה הפרויקט, ובזמן היצירה עדיין אין מזהה. אין טעם לצבור קבצים בזיכרון
     * ולשלוח אותם אחר כך — עדיף לומר זאת במשפט אחד.
     */
    const imagesBox = el('div.proj-images');
    let images = [];

    const uploadImage = async (file, kind) => {
      const data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      const r = await API.uploadProjectImage(project.id, {
        kind, filename: file.name, mime: file.type || 'image/png', data
      });
      images = r.images;
      drawImages();
      await App.reloadReference();
      App.refreshChrome();
    };

    const pickFile = (kind, multiple) => {
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple, style: { display: 'none' } });
      input.addEventListener('change', async () => {
        for (const file of [...input.files]) {
          try { await uploadImage(file, kind); UI.success(`"${file.name}" הועלה`); }
          catch (err) { UI.error(err); }
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => input.remove(), 0);
    };

    const removeImage = async (image) => {
      if (!await UI.confirm(`למחוק את "${image.filename}"?`, { danger: true, okText: 'מחיקה' })) return;
      try {
        const r = await API.deleteProjectImage(image.id);
        images = r.images;
        drawImages();
        await App.reloadReference();
        App.refreshChrome();
      } catch (err) { UI.error(err); }
    };

    function drawImages() {
      const logo = images.find((i) => i.kind === 'logo') ?? null;
      const gallery = images.filter((i) => i.kind === 'gallery');
      // אותה רשימה שנפתחת בתצוגה המקדימה, כדי שאפשר לדפדף בין ההדמיות
      const previewable = gallery.map((i) => ({ id: i.id, filename: i.filename, size: i.size, mime: i.mime, url: `/api/project-images/${i.id}/view` }));

      UI.mount(imagesBox,
        el('div.field', {}, [
          el('label', { text: 'לוגו הפרויקט' }),
          el('div.flex', { style: { gap: '10px', alignItems: 'flex-start' } }, [
            logo
              ? el('div.proj-logo-box', {}, [
                  el('img', { src: `/api/project-images/${logo.id}/view`, alt: logo.filename }),
                  el('button.chip-x', { title: 'הסרת הלוגו', onclick: () => removeImage(logo) }, ['✕'])
                ])
              : el('div.proj-logo-box.is-empty', { text: 'ללא לוגו' }),
            el('div', {}, [
              el('button.btn.btn-sm', { onclick: () => pickFile('logo', false) }, [logo ? 'החלפת הלוגו' : '＋ העלאת לוגו']),
              el('div.hint', { style: { marginTop: '4px' }, text: 'מופיע לצד שם הפרויקט בכותרת ובתפריט' })
            ])
          ])
        ]),
        el('div.field', {}, [
          el('label', { text: `תמונות והדמיות${gallery.length ? ` (${gallery.length})` : ''}` }),
          el('div.hint', { text: 'חומר חזותי של הפרויקט — הדמיות, סקיצות, צילומי מצב. לחיצה פותחת בגודל מלא.' }),
          gallery.length
            ? el('div.proj-gallery', {}, gallery.map((img, i) =>
                el('div.proj-thumb', {}, [
                  el('img', {
                    src: `/api/project-images/${img.id}/view`, alt: img.filename, title: img.filename,
                    onclick: () => UI.previewUrls(previewable, i)
                  }),
                  el('button.chip-x', { title: 'מחיקה', onclick: () => removeImage(img) }, ['✕'])
                ])))
            : null,
          el('button.btn.btn-sm', { style: { marginTop: '8px' }, onclick: () => pickFile('gallery', true) }, ['＋ העלאת תמונות'])
        ])
      );
    }

    if (isEdit) {
      drawImages();
      API.projectImages(project.id)
        .then((d) => { images = d.images; drawImages(); })
        .catch(() => { /* כשל בטעינת תמונות אינו מונע עריכת הפרויקט */ });
    } else {
      UI.mount(imagesBox, el('div.hint', {
        text: 'לוגו ותמונות אפשר להוסיף מיד לאחר יצירת הפרויקט, מתוך "עריכת פרויקט".'
      }));
    }

    const templateSelect = UI.select([{ value: '', label: 'ללא תבנית' }], '');
    if (!isEdit) {
      API.templates().then((data) => {
        for (const t of data.templates.filter((x) => x.kind === 'project')) {
          templateSelect.appendChild(el('option', { value: t.id }, [t.name]));
        }
      }).catch(() => {});
    }

    const body = el('div', {}, [
      UI.field('שם הפרויקט', nameInput),
      UI.field('תיאור', descInput),
      el('div.row', {}, [
        // "מנהל הפרויקט" לא היה ברור. זהו מי שאחראי על התקדמות המשימות שבו,
        // והוא גם רואה את הפרויקט ברשימה שלו גם בלי משימה משלו בתוכו.
        UI.field('מנהל המשימות בפרויקט', managerSelect, 'אחראי על התקדמות המשימות בפרויקט'),
        UI.field('סטטוס', statusSelect)
      ]),
      el('div.row', {}, [
        UI.field('פרויקט אב', parentSelect,
          'בחירת פרויקט אב הופכת את הפרויקט לתת-פרויקט, והוא יוצג מתחתיו בתפריט'),
        UI.field('סטטוסי בקרה', statusOwnerSelect,
          'איזו רשימת סטטוסים תצבע את שורות הפרויקט במסך הבקרה')
      ]),
      el('div.row', {}, [UI.field('תאריך התחלה', startInput), UI.field('תאריך יעד', dueInput)]),
      UI.field('צבע הפרויקט', el('div.flex', {}, [colorInput, colorSwatches]),
        'הצבע מסמן את שורות המשימות של הפרויקט, לזיהוי במבט'),
      imagesBox,
      !isEdit ? UI.field('יצירה מתבנית', templateSelect, 'התבנית תיצור אוטומטית את משימות הבסיס של הפרויקט') : null
    ]);

    const saveBtn = el('button.btn.btn-primary', {}, [isEdit ? 'שמירה' : 'יצירת פרויקט']);
    const footer = [saveBtn, el('div.spacer')];

    // ‎canDelete‎ מחושב בשרת לפי אותו כלל שנאכף ב-DELETE, ולא נגזר כאן מחדש:
    // לקוח שמנחש הרשאות מציג כפתור שנכשל ב-403
    if (isEdit && project.canDelete) {
      footer.push(el('button.btn.btn-danger', {
        onclick: () => deleteProjectFlow(project, { onDeleted: () => m.close() })
      }, ['מחיקת פרויקט']));
    }

    const m = UI.modal({ title: isEdit ? 'עריכת פרויקט' : 'פרויקט חדש', body, footer });

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return UI.toast('נדרש שם פרויקט', 'error');
      const payload = {
        name,
        description: descInput.value,
        managerId: managerSelect.value || null,
        startDate: UI.fromInputDate(startInput.value),
        dueDate: UI.fromInputDate(dueInput.value),
        status: statusSelect.value,
        color: colorInput.value,
        parentProjectId: parentSelect.value || null,
        statusOwnerId: statusOwnerSelect.value || null,
        templateId: templateSelect.value || null
      };
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.updateProject(project.id, payload);
        else await API.createProject(payload);
        m.close();
        UI.success(isEdit ? 'הפרויקט עודכן' : 'הפרויקט נוצר');
        // רשימת הפרויקטים בתפריט הצד משתנה, אך אין סיבה לבנות מחדש את המסך
        await App.reloadReference();
        App.refreshChrome();
        await App.refreshView();
      } catch (err) {
        saveBtn.disabled = false;
        UI.error(err);
      }
    });
  }

  return { render, openTaskDialog, openProjectDialog, deleteProjectFlow, reload: load };
})();
