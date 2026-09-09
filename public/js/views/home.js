'use strict';
/**
 * מסך 1 — דף הבית האישי.
 * כל עובד רואה כאן את המשימות שלו, ומי שרואה את כל הארגון מקבל בנוסף
 * חתך מחלקתי מרוכז.
 */

const HomeView = (() => {
  const { el } = UI;

  let containerRef = null;
  let boardRef = null;

  /**
   * משימות שסומנו כהושלמו בביקור הנוכחי במסך. השרת מחזיר ל"המשימות שלי" רק
   * משימות פתוחות, ובלי הזיכרון הזה השורה הייתה נעלמת באותו רגע שסומנה —
   * המשתמש לא היה רואה את הקו החוצה שביקש. ביציאה מהמסך הן נושרות.
   */
  const keepCompleted = new Map();

  /** התפקידים שרואים את כל הארגון ולא מחלקה אחת — רק להם יש טעם בחתך מחלקתי */
  const ORG_WIDE_ROLES = ['superadmin', 'admin', 'executive'];

  /**
   * מנהל מחלקה גם הוא בעל הרשאת דוחות, אך מוגבלת למחלקתו — ולכן חתך בין מחלקות
   * אינו רלוונטי לו. לכן נדרשים גם ההרשאה וגם תפקיד ברמת ארגון.
   */
  const showsDepartmentCut = () =>
    !App.isVendor() && App.may('view_reports') && ORG_WIDE_ROLES.includes(App.state.actor?.role);

  /**
   * תקרות הצגה. כל רשימה כאן יושבת בתיבת גלילה בגובה קבוע, ולכן אפשר להרשות
   * יותר פריטים מבעבר: הם אינם מאריכים את העמוד אלא את הגלילה הפנימית.
   */
  const FEED_MAX = 30;      // השרת ממילא מחזיר עד 15 רשומות — זו תקרה הגנתית
  const LIST_MAX = 40;      // שורות משימה ברשימה האישית — שורה אחת לכל משימה
  const APPROVAL_MAX = 15;

  /**
   * תיבת הגלילה של כל חלון.
   *
   * ‎max-height‎ ולא ‎height‎: רשימה קצרה נשארת בגובהה הטבעי, ולכן חלון עם
   * שלוש שורות אינו מציג מתחתן חלל ריק. התקרה נכנסת לפעולה רק כשהרשימה
   * באמת מתחילה למתוח את העמוד.
   *
   * תקרה אחת לכולם, ב-CSS בלבד. קודם לכן כל כרטיס מסר גובה משלו — 210,
   * 220, 300, 360 — וכל חלון נחתך במקום אחר, כך שהלוח נראה משורבב במקום
   * מסודר. חלון שרשימתו קצרה מהתקרה מתכווץ אליה מעצמו, ולכן תקרה משותפת
   * אינה גוררת חלל: היא רק קובעת היכן מתחילה גלילה.
   */
  const scrollBox = (children, { extraClass = '' } = {}) =>
    el(`div.feed-scroll${extraClass}`, {}, children);

  /** ניסוח מספר בעברית — יחיד מקבל מילה ולא ספרה בודדת */
  const countLabel = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

  /**
   * תיבת גלילה מסתירה את סוף הרשימה, ולכן הכותרת נושאת את המספר.
   * כשהתקרה חתכה פריטים נאמר גם המספר המלא, כדי שלא ייראה שזה הכול.
   */
  const shownLabel = (shown, total, one, many) =>
    (shown < total ? `${shown} מתוך ${total} ${many}` : countLabel(total, one, many));

  // ------------------------------------------------------- סידור החלונות

  /**
   * הכרטיסים בדף הבית הם חלונות שהמשתמש מסדר: מזיז, מרחיב לרוחב, משנה גובה
   * ומסתיר. הסידור נשמר בהעדפות בשרת, ולכן הוא הולך אחריו בין מכשירים.
   *
   * רשימה אחת עם עטיפת שורות, ולא שתי עמודות עם גרירה ביניהן. שתי עמודות
   * דורשות להחליט לאיזו עמודה כל כרטיס שייך ומה קורה כשעמודה מתרוקנת;
   * ברשימה אחת "מיקום" הוא מקום בסדר, ו"רוחב" הוא האם הכרטיס תופס חצי שורה
   * או שורה שלמה. שני מושגים במקום ארבעה, ואותה שליטה בפועל.
   *
   * הסדר שכאן הוא ברירת המחדל, וכל מפתח שאינו מוכר מסונן — כך העדפה שנשמרה
   * לפני שכרטיס נולד אינה מסתירה אותו לנצח.
   */
  const CARD_ORDER = ['deptCut', 'myTasks', 'calendar', 'department', 'mentions', 'done', 'approval', 'feed'];
  const CARD_LABEL = {
    deptCut: 'חתך מחלקתי',
    myTasks: 'המשימות שלי',
    calendar: 'השבוע הקרוב',
    department: 'המשימות במחלקה',
    mentions: 'תויגת בהודעות',
    done: 'הושלמו לאחרונה',
    approval: 'ממתין לאישור',
    feed: 'פיד עדכונים אחרון'
  };
  // כרטיסים שברירת המחדל שלהם היא שורה שלמה — טבלת חתך רחבה מדי לחצי שורה
  const WIDE_BY_DEFAULT = new Set(['deptCut']);

  /*
   * גבולות גובה החלון — לא של הרשימה שבתוכו. בכותרת ובריפוד יושבים כ-84
   * פיקסלים, ולכן חלון של 120 היה מציג שורה אחת וחצי; 170 משאיר שתיים-שלוש.
   */
  const SLOT_MIN_H = 170;
  const SLOT_MAX_H = 900;
  /*
   * רוחב מינימלי לחלון בגרירת היחס. 250 ולא רצפת הבסיס (300): כשמצמצמים
   * במפורש חלון אחד לטובת שכנו הגיוני לרדת מתחת לרוחב שהפריסה בוחרת מעצמה,
   * אבל לא עד כדי חלון שאי אפשר לקרוא בו שורה.
   */
  const SHARE_MIN_PX = 250;

  const layout = () => App.getPref('homeLayout', {}) ?? {};
  const saveLayout = (patch) => {
    App.setPref('homeLayout', { ...layout(), ...patch });
    reload();
  };

  const isWide = (key) => {
    const l = layout();
    if ((l.wide ?? []).includes(key)) return true;
    if ((l.narrow ?? []).includes(key)) return false;
    return WIDE_BY_DEFAULT.has(key);
  };
  const isHidden = (key) => (layout().hidden ?? []).includes(key);

  /** הסדר שהמשתמש קבע, וכרטיס חדש נופל לסופו */
  function orderedKeys() {
    const saved = (layout().order ?? []).filter((k) => CARD_ORDER.includes(k));
    return [...saved, ...CARD_ORDER.filter((k) => !saved.includes(k))];
  }

  /*
   * היחס בין רוחבי החלונות שייך ל**זוג**, ולא לחלון בודד. לכן כל פעולה
   * שמשנה מי שכן של מי מאפסת אותו לחלוקה שווה: הזזה, הרחבה לרוחב מלא,
   * הסתרה והחזרה. יחס שנקבע בין שני חלונות והוחל אחר כך על זוג אחר הוא
   * מספר שהמשתמש לא בחר.
   */
  const evenShares = () => ({ shares: {} });

  const toggleWide = (key) => {
    const l = layout();
    const wide = new Set(l.wide ?? []);
    const narrow = new Set(l.narrow ?? []);
    // שתי רשימות, כי לכל כרטיס יש ברירת מחדל משלו ו"לא ברשימה" אינו תשובה
    if (isWide(key)) { wide.delete(key); narrow.add(key); }
    else { narrow.delete(key); wide.add(key); }
    saveLayout({ wide: [...wide], narrow: [...narrow], ...evenShares() });
  };

  const hideCard = (key) => {
    saveLayout({ hidden: [...new Set([...(layout().hidden ?? []), key])], ...evenShares() });
    UI.toast(`"${CARD_LABEL[key]}" הוסתר — אפשר להחזיר מלמטה`);
  };

  const showCard = (key) =>
    saveLayout({ hidden: (layout().hidden ?? []).filter((k) => k !== key), ...evenShares() });

  /**
   * הזזת חלון במקלדת, מהידית.
   *
   * הגרירה במצביע הייתה הדרך היחידה לסדר את הלוח, כלומר מי שאינו יכול
   * לגרור לא יכול היה לסדר אותו כלל. ההחלפה נעשית עם השכן **הנראה** ולא
   * עם הפריט הבא בסדר: בסדר יושבים גם חלונות מוסתרים וחלונות שאין להם
   * תוכן כרגע, והחלפה איתם הייתה נראית כלחיצה שלא עשתה דבר.
   */
  function moveCard(key, delta) {
    if (!boardRef) return;
    const visible = [...boardRef.querySelectorAll('.home-slot')].map((s) => s.dataset.key);
    const at = visible.indexOf(key);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= visible.length) return;

    const keys = orderedKeys();
    const i = keys.indexOf(key);
    const j = keys.indexOf(visible[to]);
    if (i < 0 || j < 0) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    // המיקוד יחזור לאותה ידית אחרי הציור מחדש — ראה tuneBoard
    pendingFocus = key;
    saveLayout({ order: keys, ...evenShares() });
  }

  /* מפתח החלון שידית הגרירה שלו תקבל מיקוד מחדש אחרי הציור */
  let pendingFocus = null;

  /**
   * ידית שינוי הגובה. אחת בתחתית החלון ואחת בראשו.
   *
   * שתי הידיות משנות את אותו גובה, אך בכיוון הפוך: מלמטה גרירה כלפי מטה
   * מגדילה, ומלמעלה גרירה כלפי מעלה מגדילה. זה ההרגל מכל חלון שאפשר למתוח,
   * ולכן הכיוון נגזר מהקצה שנתפס ולא מכיוון התנועה בלבד.
   *
   * הערה על מה שאי אפשר: החלונות יושבים בזרימה ולא בקואורדינטות, ולכן
   * ראש החלון אינו זז מעלה כשמותחים אותו — הוא נשאר במקומו והחלון נפתח
   * כלפי מטה. חלופה שהייתה מזיזה את הראש דורשת מיקום מוחלט, וכל שאר
   * החלונות היו זזים תחתיו בכל גרירה.
   *
   * הגובה שנקבע הוא **תקרה** ולא גובה קבוע, וזה תיקון של החלטה קודמת:
   * גובה קבוע אכן שמר על גודל החלון, אבל ברשימה קצרה ממנו הוא הותיר חלל
   * ריק מתחת לשורות. חלון ריק למחצה גרוע יותר מחלון שגובהו נקבע לפי תוכנו.
   *
   * הגרירה חסומה בגובה התוכן: אי אפשר למתוח מעבר לשורה האחרונה, ולכן
   * הידית "נעצרת" בסוף הרשימה במקום להימשך אל תוך שטח שלא יתמלא לעולם.
   */
  function heightHandle(key, slot, edge = 'bottom') {
    const top = edge === 'top';
    const h = el(`button.slot-resize${top ? '.at-top' : ''}`, {
      type: 'button',
      role: 'separator',
      'aria-label': `גובה החלון ${CARD_LABEL[key]} — ${top ? 'מהקצה העליון' : 'מהקצה התחתון'}`,
      title: 'גרירה לשינוי הגובה · חצים ↑ ↓ · לחיצה כפולה לאיפוס'
    });

    const apply = (px) => slot.style.setProperty('--slot-h', `${px}px`);
    const clear = () => {
      const heights = { ...(layout().heights ?? {}) };
      delete heights[key];
      saveLayout({ heights });
    };
    const commit = (px) => saveLayout({ heights: { ...(layout().heights ?? {}), [key]: px } });

    /**
     * התקרה השימושית: הגובה שבו כל התוכן נראה, ולא יותר ממנו.
     *
     * נמדד ביחידות של **החלון** ולא של תיבת הרשימה, כי ‎--slot-h‎ מוחל על
     * החלון. מדידה בתיבה והחלה על החלון נבדלות בגובה הכותרת, וכל גרירה
     * הייתה "קופצת" בהפרש הזה.
     *
     * ‎scrollHeight - clientHeight‎ הוא בדיוק מה שחסר כדי להציג את הכול,
     * ולכן הוא נוסף לגובה הנוכחי. ‎slot.scrollHeight‎ לא היה עובד כאן: הגולל
     * הוא התיבה הפנימית, ולא החלון.
     */
    const ceiling = (box) => {
      const now = slot.getBoundingClientRect().height;
      const hidden = Math.max(0, box.scrollHeight - box.clientHeight);
      return Math.min(SLOT_MAX_H, Math.max(SLOT_MIN_H, Math.round(now + hidden)));
    };
    /*
     * הגובה נשמר תמיד, גם כשהוא שווה לתקרת התוכן.
     *
     * כאן היה באג שהשבית את ההגדלה לגמרי: קודם לכן ערך שהגיע לתקרה נמחק
     * מההעדפה, כדי שרשימה שתתקצר לא תותיר חלל ריק. הכלל הזה נכון לגובה
     * קבוע, אבל ‎--slot-h‎ הוא ‎max-height‎ — ותקרה אינה יכולה ליצור חלל,
     * היא רק קובעת היכן מתחילה גלילה. התוצאה הייתה שכל גרירה כלפי הגדלה
     * חזרה לתקרת ברירת המחדל, מלמעלה ומלמטה כאחד.
     *
     * איפוס נשאר מפורש: לחיצה כפולה על הידית.
     */
    const store = (px) => commit(px);

    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const box = slot.querySelector('.feed-scroll');
      if (!box) return;
      const startY = e.clientY;
      const startH = slot.getBoundingClientRect().height;
      const max = ceiling(box);
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      // מנטרל את המעבר החלק לזמן הגרירה, אחרת החלון נסחב אחרי הסמן
      slot.classList.add('is-resizing');
      document.body.style.userSelect = 'none';
      let last = Math.round(startH);

      const onMove = (ev) => {
        // הקצה העליון הופך את הסימן: משיכה מעלה מגדילה
        const delta = top ? startY - ev.clientY : ev.clientY - startY;
        last = Math.round(Math.min(max, Math.max(SLOT_MIN_H, startH + delta)));
        apply(last);
      };
      const onUp = () => {
        h.classList.remove('dragging');
        slot.classList.remove('is-resizing');
        document.body.style.userSelect = '';
        h.removeEventListener('pointermove', onMove);
        h.removeEventListener('pointerup', onUp);
        h.removeEventListener('pointercancel', onUp);
        store(last);         // שמירה אחת בסוף — שמירה בכל תזוזה מציירת מחדש
      };
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
      h.addEventListener('pointercancel', onUp);
    });

    h.addEventListener('dblclick', (e) => { e.preventDefault(); clear(); });

    h.addEventListener('keydown', (e) => {
      const raw = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!raw) return;
      e.preventDefault();
      const box = slot.querySelector('.feed-scroll');
      if (!box) return;
      // אותה היפוך כמו בגרירה: בידית העליונה חץ מעלה מגדיל
      const dir = top ? -raw : raw;
      const max = ceiling(box);
      const next = Math.round(Math.min(max, Math.max(SLOT_MIN_H,
        slot.getBoundingClientRect().height + dir * (e.shiftKey ? 60 : 24))));
      apply(next);
      store(next);
    });

    return h;
  }

  /**
   * ידיות הגובה נתלות אחרי ההרכבה ולא בזמנה, כי הן תלויות במדידה: לחלון
   * שרשימתו נכנסת בשלמותה אין מה למתוח, וידית שאינה עושה דבר מזמינה גרירה
   * ומלמדת שהתכונה שבורה. נדרשת בדיקה אחרי שהאלמנטים במסמך — לפני כן כל
   * הגבהים אפס.
   */
  function attachHeightHandles(board) {
    for (const slot of board.querySelectorAll('.home-slot')) {
      // ניקוי לפני תלייה מחדש — ‎tuneBoard‎ רץ גם בשינוי רוחב החלון,
      // ובלעדיו כל שינוי גודל היה מוסיף עוד זוג ידיות על אותו חלון
      for (const old of slot.querySelectorAll(':scope > .slot-resize')) old.remove();

      const box = slot.querySelector('.feed-scroll');
      if (!box) continue;
      const overflows = box.scrollHeight > box.clientHeight + 4;
      // חלון שהמשתמש כבר קיצר חייב להישאר עם ידית, אחרת אין דרך להחזירו
      const pinned = Number.isFinite((layout().heights ?? {})[slot.dataset.key]);
      if (!overflows && !pinned) continue;
      // שני הקצוות, כדי שלא יידרש לגלול לתחתית החלון כדי לקצר אותו
      slot.appendChild(heightHandle(slot.dataset.key, slot, 'top'));
      slot.appendChild(heightHandle(slot.dataset.key, slot, 'bottom'));
    }
  }

  /**
   * גרירת חלונות לשינוי המיקום. HTML5 drag-and-drop, כמו בסידור הפרויקטים
   * בתפריט — הוא נותן בחינם את הסמן, את התמונה הנגררת ואת הגלילה בקצה.
   *
   * נקודת האחיזה היא כותרת החלון ולא כל שטחו: הכרטיסים מכילים כפתורים,
   * שדות ורשימות נגללות, וחלון שנגרר מכל נקודה היה הופך כל לחיצה על שורה
   * לגרירה בטעות.
   */
  function makeSlotsDraggable(slots) {
    if (slots.length < 2) return;
    let dragged = null;
    const clearMarks = () => slots.forEach(({ node }) =>
      node.classList.remove('drop-before', 'drop-after', 'drop-v'));

    for (const entry of slots) {
      const { key, node } = entry;
      const grip = node.querySelector('.slot-grip');
      if (!grip) continue;

      // ‎draggable‎ נדלק רק כשתופסים את הידית, אחרת בחירת טקסט בכרטיס נשברת
      grip.addEventListener('pointerdown', () => { node.draggable = true; });
      grip.addEventListener('pointerup', () => { node.draggable = false; });

      node.addEventListener('dragstart', (e) => {
        dragged = entry;
        node.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);   // נדרש ב-Firefox
      });

      node.addEventListener('dragend', () => {
        node.classList.remove('dragging');
        node.draggable = false;
        clearMarks();
        dragged = null;
      });

      /*
       * לאיזה צד ייפול — בשני הצירים.
       *
       * קודם לכן חלון בחצי רוחב הוכרע לפי ציר ה-X בלבד, ולכן לא היה בכלל
       * מושג של "מתחת": גרירה כלפי מטה אל חלון בשורה נמוכה יותר הכריעה לפי
       * המרחק האופקי, ותמיד הכניסה את הנגרר *לפני* היעד. כלומר אפשר היה
       * להעלות חלון מעל חלון אך לא להוריד אותו מתחתיו.
       *
       * המרחקים מנורמלים לגודל היעד, ולא בפיקסלים: חלון גבוה וצר היה מטה
       * את ההכרעה לציר האנכי בכל גרירה. הציר שבו התרחקנו יותר מהמרכז הוא
       * הציר שמכריע, וחלון ברוחב שורה שלמה נופל אוטומטית לציר האנכי — הרוחב
       * הגדול מקטין את המרחק המנורמל בו.
       */
      const sideOf = (e) => {
        const box = node.getBoundingClientRect();
        const dx = (e.clientX - (box.left + box.width / 2)) / Math.max(1, box.width);
        const dy = (e.clientY - (box.top + box.height / 2)) / Math.max(1, box.height);
        const vertical = Math.abs(dy) > Math.abs(dx);
        const rtl = getComputedStyle(node.parentElement).direction === 'rtl';
        // RTL: הצד הימני הוא הקודם בסדר
        return { after: vertical ? dy > 0 : (rtl ? dx < 0 : dx > 0), vertical };
      };

      /** החלונות שיושבים באותה שורה עם היעד, לפי מדידה בפועל */
      const rowOf = () => slots.filter(({ node: n }) =>
        Math.round(n.offsetTop) === Math.round(node.offsetTop));

      node.addEventListener('dragover', (e) => {
        if (!dragged || dragged.node === node) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const { after, vertical } = sideOf(e);
        clearMarks();
        /*
         * בנפילה אנכית מסומנת השורה כולה ולא רק היעד: החלון הנגרר עומד
         * לקבל שורה לעצמו *בין* השורות, וסימון של חצי שורה היה מרמז שהוא
         * נכנס לתוך הזוג הקיים.
         */
        const marked = vertical ? rowOf().map((x) => x.node) : [node];
        for (const n of marked) {
          n.classList.add(after ? 'drop-after' : 'drop-before');
          n.classList.toggle('drop-v', vertical);
        }
      });

      node.addEventListener('dragleave', () =>
        node.classList.remove('drop-before', 'drop-after', 'drop-v'));

      /*
       * הנפילה קובעת גם את הרוחב, ולא רק את הסדר.
       *
       * זה מה שהיה חסר: הגרירה שינתה מקום בלבד, ולכן חלון שהופל בין שורות
       * נדחס לזוג במקום לקבל שורה — ההיפך ממה שהמחווה אומרת.
       *
       * נפילה אנכית = "שורה לעצמך": הנגרר מסומן ברוחב מלא ונכנס בגבול
       * השורה — לפני החלון הראשון בה או אחרי האחרון — ולכן זוג קיים נשאר
       * זוג ואינו נחצה.
       *
       * נפילה לצד = "תחלקו את השורה": שני החלונות מסומנים כחצי רוחב ומקבלים
       * חלוקה שווה.
       */
      node.addEventListener('drop', (e) => {
        if (!dragged || dragged.node === node) return;
        e.preventDefault();
        const { after, vertical } = sideOf(e);
        const keys = orderedKeys().filter((k) => k !== dragged.key);
        const wide = new Set(layout().wide ?? []);
        const narrow = new Set(layout().narrow ?? []);

        let at;
        if (vertical) {
          const row = rowOf().map((x) => x.key).filter((k) => k !== dragged.key);
          const edge = after ? row[row.length - 1] : row[0];
          at = keys.indexOf(edge ?? key) + (after ? 1 : 0);
          narrow.delete(dragged.key);
          wide.add(dragged.key);
        } else {
          at = keys.indexOf(key) + (after ? 1 : 0);
          for (const k of [dragged.key, key]) { wide.delete(k); narrow.add(k); }
        }

        keys.splice(Math.max(0, at), 0, dragged.key);
        clearMarks();
        // זוג חדש מתחיל בחלוקה שווה — ראה evenShares
        saveLayout({ order: keys, wide: [...wide], narrow: [...narrow], ...evenShares() });
      });
    }
  }

  /**
   * עטיפת כרטיס לחלון: כותרת נגררת, כפתורי רוחב והסתרה, וידית גובה.
   *
   * הכפתורים נדחפים לתוך ‎.card-head‎ הקיים של הכרטיס ולא לשורה נוספת מעליו:
   * שורת כלים לכל חלון הייתה מוסיפה שמונה שורות לדף שכל תכליתו תמונת מצב
   * במבט אחד.
   */
  function slotFor(key, card) {
    const wide = isWide(key);
    const height = (layout().heights ?? {})[key];
    /*
     * ‎has-list‎ הוא מה שמחיל את תקרת הגובה המשותפת. חלון בלי רשימה נגללת
     * (טבלת חתך פרושה, טקסט) אינו נחתך — תקרה עליו הייתה מסתירה תוכן שאין
     * דרך להגיע אליו.
     */
    const hasList = !!card.querySelector('.feed-scroll');
    const share = Number((layout().shares ?? {})[key]);
    // שני משתני CSS על אותו אלמנט, ולכן מחרוזת אחת — ‎el‎ אינו מעביר
    // משתני CSS כאובייקט סגנון
    const vars = [
      Number.isFinite(height) ? `--slot-h: ${height}px` : null,
      Number.isFinite(share) && share > 0 ? `--share: ${share}` : null
    ].filter(Boolean).join('; ');
    const slot = el(`div.home-slot${wide ? '.is-wide' : ''}${hasList ? '.has-list' : ''}`, {
      'data-key': key,
      style: vars
    }, [card]);

    const head = card.querySelector('.card-head');
    if (head) {
      head.classList.add('has-slot-tools');

      const grip = el('button.slot-btn.slot-grip', {
        type: 'button',
        title: 'גרירה לשינוי המיקום · חצים להזזה במקלדת',
        'aria-label': `הזזת החלון ${CARD_LABEL[key]}`
      }, ['⠿']);
      /*
       * חצים במקלדת, כדי שסידור הלוח לא יהיה תלוי ביכולת לגרור. ‎↑‎ ו-‎→‎
       * מקדימים ב-RTL, ‎↓‎ ו-‎←‎ מאחרים — הכיוון החזותי, ולא סדר המערך.
       */
      grip.addEventListener('keydown', (e) => {
        const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
        const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
        const fwd = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
        if (!back && !fwd) return;
        e.preventDefault();
        moveCard(key, back ? -1 : 1);
      });

      /*
       * ‎aria-pressed‎ ומצב מודגש, ולא רק אייקון מתחלף. זו הייתה תלונת
       * "פעם עובד פעם לא": חלון שנשאר לבד בשורה ממלא אותה ממילא מכוח
       * ההתרחבות, ולכן סימונו כרוחב מלא אינו משנה דבר במסך — הלחיצה עבדה
       * אך לא נראתה. מצב הכפתור מראה שהבחירה נרשמה, והיא כן משפיעה ברגע
       * שמתפנה מקום לשכן באותה שורה.
       */
      const wideBtn = el('button.slot-btn.slot-wide', {
        type: 'button',
        'aria-pressed': wide ? 'true' : 'false',
        title: wide
          ? 'מסומן כרוחב מלא — לחיצה מחזירה לחצי שורה'
          : 'הרחבה לרוחב מלא — החלון יקבל שורה לעצמו',
        onclick: () => toggleWide(key)
      }, [wide ? '⇥⇤' : '⇤⇥']);

      head.appendChild(el('div.slot-tools', {}, [
        grip,
        wideBtn,
        el('button.slot-btn.slot-hide', {
          type: 'button',
          title: 'הסתרת החלון',
          'aria-label': `הסתרת החלון ${CARD_LABEL[key]}`,
          onclick: () => hideCard(key)
        }, ['✕'])
      ]));
    }

    // ידית הגובה נתלית אחרי ההרכבה, כי היא תלויה במדידה — ראה attachHeightHandles
    return slot;
  }

  /** שורת החלונות המוסתרים, ואיפוס הסידור */
  function layoutFooter(available) {
    const hidden = (layout().hidden ?? []).filter((k) => available.has(k));
    const l = layout();
    const touched = (l.order ?? []).length || (l.wide ?? []).length
      || (l.narrow ?? []).length || Object.keys(l.heights ?? {}).length
      || Object.keys(l.shares ?? {}).length || hidden.length;
    if (!touched) return null;

    return el('div.layout-footer', {}, [
      hidden.length
        ? el('div.flex', { style: { gap: '7px', flexWrap: 'wrap', alignItems: 'center' } }, [
            el('span.mute-sm', { text: 'חלונות מוסתרים:' }),
            ...hidden.map((k) => el('button.btn.btn-sm.btn-ghost', {
              title: 'החזרה לדף', onclick: () => showCard(k)
            }, [`＋ ${CARD_LABEL[k]}`]))
          ])
        : null,
      el('div.spacer'),
      el('button.btn.btn-sm.btn-ghost', {
        title: 'החזרת כל החלונות לסידור המקורי',
        // ‎null‎ מוחק את ההעדפה בשרת ומחזיר את ברירת המחדל
        onclick: () => { App.setPref('homeLayout', null); reload(); }
      }, ['איפוס הסידור'])
    ]);
  }

  /** לוח החלונות — מקבל מפה של כרטיסים שנבנו, ומסדר אותם לפי ההעדפה */
  function homeBoard(cards) {
    const available = new Set(Object.keys(cards).filter((k) => cards[k]));
    const slots = [];
    const board = el('div.home-board', {},
      orderedKeys()
        .filter((k) => available.has(k) && !isHidden(k))
        .map((k) => {
          const slot = slotFor(k, cards[k]);
          slots.push({ key: k, node: slot });
          return slot;
        }));

    makeSlotsDraggable(slots);
    boardRef = board;
    if (boardWatcher) { boardWatcher.disconnect(); boardWatcher.observe(board); }
    return [board, layoutFooter(available)];
  }

  /**
   * ידית היחס בין שני חלונות שכנים באותה שורה.
   *
   * שני החלונות משתנים יחד ובכיוון הפוך: מה שאחד מוותר עליו עובר לשני,
   * וסכום הרוחבים נשאר רוחב השורה. זו אינה החלטה של הקוד אלא של הפריסה —
   * הידית משנה רק את שני המשקלים ומשמרת את סכומם, וה-CSS גוזר מכך את
   * הרוחבים (ראה ההסבר על ‎--share‎ בגיליון).
   *
   * המשקל נשמר ולא הרוחב: רוחב בפיקסלים היה נשבר בכל שינוי גודל של החלון,
   * והיחס נשאר נכון בכל רוחב מסך.
   */
  function widthHandle(slot, next) {
    const h = el('button.slot-wresize', {
      type: 'button',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': `היחס בין ${CARD_LABEL[slot.dataset.key]} ל${CARD_LABEL[next.dataset.key]}`,
      title: 'גרירה לשינוי היחס בין שני החלונות · חצים ← → · לחיצה כפולה לחלוקה שווה'
    });

    const round = (n) => Math.round(n * 1000) / 1000;

    /**
     * שמירה של הזוג. כששניהם חזרו לחלוקה שווה המפתחות נמחקים ולא נשמרים
     * כ-1 — כך העדפה נקייה נשארת נקייה, ואיפוס מזוהה כאיפוס.
     */
    const store = (s1, s2) => {
      const shares = { ...(layout().shares ?? {}) };
      const even = Math.abs(s1 - 1) < 0.02 && Math.abs(s2 - 1) < 0.02;
      if (even) {
        delete shares[slot.dataset.key];
        delete shares[next.dataset.key];
      } else {
        shares[slot.dataset.key] = round(s1);
        shares[next.dataset.key] = round(s2);
      }
      saveLayout({ shares });
    };

    /** המצב ההתחלתי של הזוג — רוחבים בפועל, ומשקלים שסכומם נשמר */
    const pair = () => {
      const shares = layout().shares ?? {};
      const s1 = Number(shares[slot.dataset.key]) || 1;
      const s2 = Number(shares[next.dataset.key]) || 1;
      const w1 = slot.getBoundingClientRect().width;
      const w2 = next.getBoundingClientRect().width;
      return { s1, s2, sum: s1 + s2, w1, w2, total: w1 + w2 };
    };

    /** רוחב חדש לחלון המוביל → משקלים לשניהם, בגבול המינימום לכל אחד */
    const sharesFor = (nextW1, p) => {
      const w1 = Math.min(p.total - SHARE_MIN_PX, Math.max(SHARE_MIN_PX, nextW1));
      const s1 = p.sum * w1 / p.total;
      return [s1, p.sum - s1];
    };

    const apply = (s1, s2) => {
      slot.style.setProperty('--share', String(round(s1)));
      next.style.setProperty('--share', String(round(s2)));
    };

    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rtl = getComputedStyle(slot.parentElement).direction === 'rtl';
      const startX = e.clientX;
      const p = pair();
      // שני החלונות צריכים מקום למינימום, אחרת אין מה לגרור
      if (p.total < SHARE_MIN_PX * 2) return;

      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      document.body.style.userSelect = 'none';
      let last = [p.s1, p.s2];

      const onMove = (ev) => {
        // ב-RTL החלון המוביל הוא הימני, ולכן משיכה שמאלה מרחיבה אותו
        const delta = rtl ? startX - ev.clientX : ev.clientX - startX;
        last = sharesFor(p.w1 + delta, p);
        apply(last[0], last[1]);
      };
      const onUp = () => {
        h.classList.remove('dragging');
        document.body.style.userSelect = '';
        h.removeEventListener('pointermove', onMove);
        h.removeEventListener('pointerup', onUp);
        h.removeEventListener('pointercancel', onUp);
        store(last[0], last[1]);
      };
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
      h.addEventListener('pointercancel', onUp);
    });

    // לחיצה כפולה — חזרה לחלוקה שווה בין השניים
    h.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store(1, 1);
    });

    h.addEventListener('keydown', (e) => {
      const raw = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
      if (!raw) return;
      e.preventDefault();
      const rtl = getComputedStyle(slot.parentElement).direction === 'rtl';
      const p = pair();
      if (p.total < SHARE_MIN_PX * 2) return;
      const step = (e.shiftKey ? 60 : 20) * (rtl ? raw : -raw);
      const [s1, s2] = sharesFor(p.w1 + step, p);
      apply(s1, s2);
      store(s1, s2);
    });

    return h;
  }

  /**
   * תליית ידיות היחס. נדרשת מדידה: "שכן באותה שורה" תלוי בעטיפה, והיא
   * משתנה עם רוחב המסך. חלון שנשאר לבד בשורה אינו מקבל ידית — אין ממי
   * לקחת רוחב.
   */
  function attachWidthHandles(board) {
    const slots = [...board.querySelectorAll('.home-slot')];
    for (const s of slots) {
      for (const old of s.querySelectorAll(':scope > .slot-wresize')) old.remove();
    }
    slots.forEach((slot, i) => {
      const next = slots[i + 1];
      if (!next) return;
      if (slot.classList.contains('is-wide') || next.classList.contains('is-wide')) return;
      // אותה שורה בפועל, ולא לפי הנחה על מספר החלונות בשורה
      if (Math.round(slot.offsetTop) !== Math.round(next.offsetTop)) return;
      slot.appendChild(widthHandle(slot, next));
    });
  }

  /**
   * התאמה שדורשת מדידה, ולכן רצה אחרי ההרכבה: לאיזה חלון יש בכלל מה למתוח.
   *
   * מה שהיה כאן קודם ואינו עוד: סיווג "מי נשאר לבד בשורה" כדי להרחיב אותו.
   * הפריסה עושה זאת בעצמה מאז ש-‎flex-grow‎ הוא 1, ולכן זה נמחק — חישוב
   * שרץ בהשהיה אחרי כל שינוי גודל הוא בדיוק מה שנראה כקפיצה מאוחרת.
   *
   * ‎ResizeObserver‎ ולא ‎window.resize‎: רוחב הלוח משתנה גם בלי שגודל החלון
   * משתנה — קיפול תפריט הצד, למשל — ואירוע החלון אינו נורה אז כלל.
   */
  function tuneBoard() {
    if (!boardRef?.isConnected) return;
    attachHeightHandles(boardRef);
    attachWidthHandles(boardRef);

    // אחרי הזזה במקלדת המיקוד היה נופל לגוף המסמך, והחץ הבא לא היה עושה דבר
    if (pendingFocus) {
      boardRef.querySelector(`.home-slot[data-key="${pendingFocus}"] .slot-grip`)?.focus();
      pendingFocus = null;
    }
  }

  let tuneTimer = null;
  const scheduleTune = () => {
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(tuneBoard, 120);
  };

  /*
   * המשקיף נוצר פעם אחת ומחובר מחדש בכל ציור, כדי שלא יצטבר משקיף לכל
   * טעינה של המסך.
   */
  const boardWatcher = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleTune)
    : null;
  if (!boardWatcher) window.addEventListener('resize', scheduleTune);

  /**
   * ‎silent‎ — טעינה מחדש ברקע: בלי ספינר, ותוך שמירת מיקום הגלילה. המסך
   * הקיים נשאר לנגד העיניים עד שהתוכן החדש מוכן, וכך עדכון משימה אינו נראה
   * כרענון של כל הדף.
   */
  async function render(container, { silent = false } = {}) {
    containerRef = container;
    const scrollTop = silent ? container.scrollTop : 0;
    // כניסה חדשה למסך מתחילה מדף נקי — המשימות שהושלמו בביקור הקודם כבר סגורות
    if (!silent) { keepCompleted.clear(); UI.mount(container, UI.spinner()); }
    let data;
    let reports = null;
    try {
      // החתך המחלקתי נשען על דוח הארגון. נטען במקביל, וכשל בו לא מפיל את הדשבורד.
      [data, reports] = await Promise.all([
        API.home(),
        showsDepartmentCut() ? API.reports().catch(() => null) : Promise.resolve(null)
      ]);
    } catch (err) {
      // בטעינת רקע כשל רגעי לא ימחק את מה שכבר על המסך
      if (silent) return;
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    App.state.homeData = data;

    /**
     * זיכרון הביקור אינו נדרש עוד: משימה שהושלמה חוזרת מהשרת בכרטיס
     * "הושלמו לאחרונה", ולכן היא עוברת לשם במקום להישאר ברשימת הפתוחות עם
     * קו חוצה. הסימון עצמו נשאר מיידי — הקו מופיע לפני הטעינה מחדש.
     */

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';

    /*
     * הכרטיסים נבנים למפה ולא ישירות לעץ, כי הסדר, הרוחב וההסתרה שלהם הם
     * העדפה של המשתמש. כרטיס שאין לו תוכן מחזיר ‎null‎, ולוח החלונות מדלג
     * עליו — וגם אינו מציע להחזיר חלון שאין בו דבר.
     */
    const cards = {
      deptCut: reports ? departmentCutCard(reports.departments) : null,
      myTasks: myTasksCard(data.tasks.mine),
      calendar: calendarCard(data.weekAhead),
      department: departmentTasksCard(data.tasks.department ?? []),
      mentions: mentionsCard(data.mentions),
      done: doneCard(data.tasks.recentlyDone ?? [], data.archiveAfterDays ?? 3),
      approval: App.may('approve_vendor_output') || App.isVendor()
        ? approvalCard(data.tasks.awaitingApproval)
        : null,
      feed: feedCard(data.feed)
    };

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: `${greeting}, ${App.state.actor.name.split(' ')[0]}` }),
          el('div.sub', { text: 'תמונת מצב אישית. גרירת חלון בין שורות תיתן לו שורה שלמה, גרירה לצד חלון תחלק את השורה בין השניים, ואת הגבולות אפשר למשוך.' })
        ])
      ]),
      widgets(data.widgets),
      ...homeBoard(cards)
    );
    tuneBoard();
    if (scrollTop) container.scrollTop = scrollTop;
  }

  /** טעינה מחדש ברקע — לשימוש אחרי עדכון משימה, בלי לבנות מחדש את האתר */
  const reload = () => (containerRef ? render(containerRef, { silent: true }) : Promise.resolve());

  /** עדכון המונים והרשימות אחרי סימון בשורה, בלי הבהוב ובלי לאבד גלילה */
  function refreshQuietly() {
    reload();
    App.refreshNotifications();
  }

  /** ווידג'טים עם ספירה ומעבר ישיר לרשימה המסוננת */
  function widgets(w) {
    const go = (filters) => {
      if (App.isVendor()) App.navigate('vendor', filters);
      else App.navigate('board', { scope: 'internal', ...filters });
    };

    const make = (cls, iconName, num, label, onclick) =>
      el(`button.widget.${cls}`, { onclick }, [
        el('div.w-icon', {}, [UI.icon(iconName)]),
        el('div', {}, [el('div.w-num', { text: String(num) }), el('div.w-label', { text: label })])
      ]);

    return el('div.grid.grid-4', {}, [
      make('w-mine', 'my-tasks', w.mine, 'המשימות שלי', () => go({ mine: true })),
      make('w-over', 'overdue', w.overdue, 'באיחור', () => go({ mine: true, overdue: true })),
      make('w-urgent', 'urgent', w.urgent, 'דחוף', () => go({ mine: true, priority: 'urgent' })),
      make('w-approve', 'waiting', w.awaitingApproval, App.isVendor() ? 'ממתין לבדיקת הצוות' : 'ממתין לאישור',
        () => (App.isVendor() ? App.navigate('vendor') : App.navigate('vendorBoards', { pendingReview: true })))
    ]);
  }


  /**
   * משימה ארגונית מסומנת בתגית משלה, גם כשהיא מופיעה בתוך רשימה מעורבת
   * (כרטיסי האישור), כדי שהרמה תהיה מובחנת במבט אחד ולא רק לפי הכותרת שמעליה.
   */

  /**
   * הסטטוס הסופי של הבורד שהמשימה יושבת בו. אין קביעה קשיחה של מפתח סטטוס —
   * לכל בורד עמודות משלו, והסימון "בוצע" הוא מעבר לעמודה המסומנת כסופית.
   */
  const finalStatusOf = (task) =>
    App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => c.isFinal)?.key ?? null;

  const firstStatusOf = (task) =>
    App.state.boards.find((b) => b.id === task.boardId)?.columns.find((c) => !c.isFinal)?.key ?? null;

  function completeBox(task) {
    const finalKey = finalStatusOf(task);
    if (!task.canChangeStatus || !finalKey) return null;

    const box = el('input.tc-done-box', {
      type: 'checkbox',
      checked: !!task.isFinal,
      title: task.isFinal ? 'ביטול הסימון' : 'סימון כהושלמה'
    });
    // הלחיצה על התיבה אינה אמורה לפתוח גם את כרטיס המשימה
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', async () => {
      const wantDone = box.checked;
      const target = wantDone ? finalKey : firstStatusOf(task);
      box.disabled = true;
      try {
        await API.updateTask(task.id, { status: target });
        task.isFinal = wantDone;
        // המשימה נשארת ברשימה עם קו חוצה עד היציאה מהמסך, אף שהשרת כבר אינו
        // מחזיר אותה — אחרת הסימון היה נעלם ברגע שנעשה, ולא היה נראה כלל
        if (wantDone) keepCompleted.set(task.id, task);
        else keepCompleted.delete(task.id);
        box.closest('.task-line')?.classList.toggle('is-done', wantDone);
        UI.success(wantDone ? 'המשימה סומנה כהושלמה' : 'הסימון בוטל');
        refreshQuietly();
      } catch (err) {
        box.checked = !wantDone;
        UI.error(err);
      } finally {
        box.disabled = false;
      }
    });
    return box;
  }

  /**
   * שורה אחת למשימה. כרטיס בן ארבע שורות נראה טוב כשיש שלוש משימות, אבל
   * כשיש עשרים אי אפשר לסרוק אותו — ולכן כל המידע נדחס לשורה: פרויקט,
   * כותרת, סטטוס ויעד, וסימני הדחיפות דווקא בקצה, במקום שהעין נחה בו.
   */
  /**
   * שורת משימה. שבע עמודות קבועות, ושתיים מהן מתחלפות לפי ההקשר:
   *
   * ‎lead‎  — העמודה השלישית: שם הפרויקט או שם האחראי.
   * ‎trail‎ — העמודה החמישית: תג הסטטוס או שם האחראי.
   *
   * שני שמות ולא שני דגלים בוליאניים, כי בחלון המחלקה נדרשות **שתי**
   * העמודות יחד — פרויקט וגם אחראי — ודגל "הצג אחראי" לא היה יכול לומר
   * באיזו מהן.
   */
  function taskRow(task, { lead = 'project', trail = 'status' } = {}) {
    const leadText = (lead === 'assignee' ? task.assigneeName : task.projectName) ?? '—';
    const due = UI.dueLabel(task.dueDate);
    const flags = [
      task.overdue ? el('span.text-danger', { title: `באיחור — יעד ${UI.formatDate(task.dueDate)}` }, [UI.icon('overdue')]) : null,
      task.priority === 'urgent' ? el('span.text-warn', { title: 'עדיפות דחוף' }, [UI.icon('urgent')]) : null,
      task.escalated ? el('span', { title: 'הוקפצה לתשומת לב ההנהלה', text: '↑' }) : null
    ].filter(Boolean);

    /**
     * כל תא הוא עמודה בטבלה ולכן נכתב תמיד, גם כשהוא ריק — תא שנשמט היה מזיז
     * את כל מה שאחריו עמודה אחת שמאלה, וכל השורות היו מפסיקות להתיישר.
     */
    return el(`div.task-line${task.isFinal ? '.is-done' : ''}`, {
      onclick: () => TaskCardView.open(task.id),
      title: task.title
    }, [
      // הפס בצבע הפרויקט — אותו סימן שמופיע בטבלה ובקנבן
      el('span.tk-bar', { style: { background: task.projectColor ?? 'transparent' } }),
      el('span', {}, [completeBox(task)]),
      el('span.tk-project', { text: leadText }),
      el('span.tk-title', { text: task.title }),
      trail === 'assignee'
        ? el('span.tk-owner', { text: task.assigneeName ?? 'ללא אחראי', title: task.assigneeName ?? '' })
        : UI.statusTag(task),
      el('span.tk-due', {
        text: task.dueDate ? due.text : '—',
        class: due.tone === 'danger' ? 'text-danger' : due.tone === 'warn' ? 'text-warn' : ''
      }),
      el('span.tk-flags', {}, [
        // האחראי מוצג רק כשהוא אינו המשתמש עצמו — ברשימה "שלי" זה תמיד הוא
        task.assigneeName && task.assigneeId !== App.state.actor.id
          ? UI.avatar(task.assigneeName, { small: true, vendor: task.assigneeType === 'vendor' })
          : null,
        ...flags
      ])
    ]);
  }

  /**
   * "הושלמו לאחרונה" — התשובה לשאלה "לאן המשימה הלכה".
   *
   * משימה שסומנה כהושלמה יורדת מ"המשימות שלי", כי הרשימה ההיא היא מה שנותר
   * לעשות. בלי הכרטיס הזה היא נעלמה מהמסך באותו רגע ולא היה שום מקום לראות
   * מה נסגר או לחזור אליו. היא נשארת כאן עד שהאוטומציה מעבירה אותה לארכיון.
   */
  function doneCard(tasks, afterDays) {
    if (!tasks.length) return null;
    const shown = tasks.slice(0, LIST_MAX);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'הושלמו לאחרונה' }),
        el('span.mute-sm', { text: shownLabel(shown.length, tasks.length, 'משימה אחת', 'משימות') }),
        el('div.spacer'),
        /*
         * ההסבר על הארכיון עבר לכפתור. כפסקה בתוך הכרטיס הוא גזל שורה שלמה
         * בכל טעינה של הדף — הוא נחוץ פעם אחת, ואחריה הוא רעש שדוחק את
         * המשימות עצמן מטה.
         */
        el('button.btn.btn-sm', {
          title: `לאחר ${afterDays} ימים מההשלמה המשימות עוברות אוטומטית לארכיון, ושם אפשר למצוא אותן לפי פרויקט`,
          onclick: () => App.navigate('archive')
        }, ['לארכיון'])
      ]),
      el('div.card-pad', {}, [
        el('div.task-table', {}, [
          scrollBox(shown.map(taskRow), { extraClass: '.flex-col' })
        ])
      ])
    ]);
  }

  /** באיחור קודם, ואחריו לפי קרבת תאריך היעד; משימות ללא יעד בסוף */
  const byUrgency = (tasks) => [...tasks].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  /** כרטיס רשימה אחד. קבוצה ריקה מסתפקת בשורה שקטה ולא במסגרת ריקה עם איור. */
  function taskListCard({ title, note, tasks, emptyText, onAll, filter = null }) {
    const sorted = byUrgency(tasks);
    const shown = sorted.slice(0, LIST_MAX);
    // המחלקה והמספר בכותרת אחת ולא בשני שדות — כדי לא לדחוק את כפתור 'לכל המשימות'
    const subtitle = [note, sorted.length ? shownLabel(shown.length, sorted.length, 'משימה אחת', 'משימות') : null]
      .filter(Boolean).join(' · ');

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: title }),
        subtitle ? el('span.mute-sm', { text: subtitle }) : null,
        el('div.spacer'),
        filter,
        sorted.length ? el('button.btn.btn-sm', { onclick: onAll }, ['לכל המשימות']) : null
      ]),
      sorted.length
        // שורה בגובה אחיד, ולכן תקרה שמראה כעשר שורות שלמות ורומזת להמשך
        ? el('div.card-pad', {}, [
            el('div.task-table', {}, [
              /**
               * הכותרת יושבת בתוך תיבת הגלילה ולא מעליה, ודביקה בראשה. מחוץ
               * לתיבה היא הייתה רחבה ממנה בעובי פס הגלילה, וכל העמודות היו
               * מוסטות ביחס לשורות — כלומר בדיוק הבלגן שהטבלה באה לפתור.
               */
              scrollBox([
                el('div.task-table-head', {}, [
                  el('span'), el('span'),
                  el('span', { text: 'פרויקט' }),
                  el('span', { text: 'משימה' }),
                  el('span', { text: 'סטטוס' }),
                  el('span', { text: 'יעד' }),
                  el('span')
                ]),
                ...shown.map(taskRow)
              ], { extraClass: '.flex-col' })
            ])
          ])
        : el('div.card-pad', {}, [el('div.mute-sm', { text: emptyText })])
    ]);
  }

  /**
   * רשימת המשימות האישית מפוצלת לשתי קבוצות מופרדות — מחלקתי וארגוני.
   * רמת המשימה מגיעה כבר בנתוני דף הבית (level), ולכן אין צורך בטעינה נוספת.
   */
  /**
   * משימות המחלקה שאינן שלי. מנהל מחלקה צריך לראות במה הצוות עסוק בלי לעבור
   * ללוח ולסנן, ולכן זהו כרטיס נפרד ולא ערבוב לתוך "המשימות שלי" — הרשימה
   * האישית היא מה שעליי לעשות, וזו תמונת מצב של אחרים.
   */
  function departmentTasksCard(tasks) {
    if (!tasks.length) return null;
    const sorted = byUrgency(tasks);
    const shown = sorted.slice(0, LIST_MAX);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'המשימות במחלקה' }),
        el('span.mute-sm', { text: [App.state.actor.department, shownLabel(shown.length, sorted.length, 'משימה אחת', 'משימות')].filter(Boolean).join(' · ') }),
        el('div.spacer'),
        el('button.btn.btn-sm', {
          onclick: () => App.navigate('board', { departmentId: App.state.actor.departmentId })
        }, ['לכל המשימות'])
      ]),
      el('div.card-pad', {}, [
        el('div.task-table', {}, [
          scrollBox([
            el('div.task-table-head', {}, [
              el('span'), el('span'),
              el('span', { text: 'פרויקט' }),
              el('span', { text: 'משימה' }),
              el('span', { text: 'אחראי' }),
              el('span', { text: 'תאריך יעד' }),
              el('span')
            ]),
            /*
             * ארבע העמודות שנדרשו לחלון הזה: פרויקט, משימה, אחראי ותאריך
             * יעד. הסטטוס יצא — בחלון שמציג רק משימות פתוחות הוא כמעט תמיד
             * אותו ערך, ובמקומו נכנס האחראי, שהוא השאלה האמיתית של מנהל
             * מחלקה שמסתכל על עבודת הצוות.
             */
            ...shown.map((t) => taskRow(t, { lead: 'project', trail: 'assignee' }))
          ], { extraClass: '.flex-col' })
        ])
      ])
    ]);
  }

  /**
   * חתך הפרויקט ברשימה האישית.
   *
   * נשמר בהעדפות בשרת ולא במכשיר, כמו שאר החתכים במערכת. הרשימה הנפתחת
   * נבנית מהפרויקטים שיש בהם משימות שלי בפועל, ולא מכל הפרויקטים בארגון:
   * בחירה בפרויקט שאין לי בו משימה הייתה מייצרת רשימה ריקה בלי הסבר.
   *
   * הסינון קודם, המיון אחריו — ‎byUrgency‎ ממשיך לסדר לפי איחור, דחיפות
   * ותאריך יעד בתוך הפרויקט שנבחר.
   */
  const savedHomeProject = () => String(App.getPref('homeProject', '') ?? '');

  function projectFilterSelect(tasks, onPick) {
    const seen = new Map();
    for (const t of tasks) {
      const key = t.projectId ? String(t.projectId) : '';
      if (!seen.has(key)) seen.set(key, { label: t.projectName ?? 'ללא פרויקט', n: 0 });
      seen.get(key).n += 1;
    }
    // פחות משני פרויקטים — אין מה לסנן, ובורר עם אפשרות אחת הוא רעש
    if (seen.size < 2) return null;

    const options = [
      { value: '', label: `כל הפרויקטים (${tasks.length})` },
      ...[...seen.entries()]
        .sort((a, b) => a[1].label.localeCompare(b[1].label, 'he'))
        .map(([value, v]) => ({ value, label: `${v.label} (${v.n})` }))
    ];
    return UI.select(options, savedHomeProject(), {
      class: 'home-filter',
      title: 'סינון לפי פרויקט',
      onchange: (e) => onPick(e.target.value)
    });
  }

  function myTasksCard(tasks) {
    const all = tasks ?? [];
    const picked = savedHomeProject();
    // חתך שנשמר על פרויקט שאין בו עוד משימות אינו מרוקן את הרשימה בשקט
    const stillThere = !picked || all.some((t) => String(t.projectId ?? '') === picked);
    const shown = stillThere && picked
      ? all.filter((t) => String(t.projectId ?? '') === picked)
      : all;

    const filter = projectFilterSelect(all, (value) => {
      App.setPref('homeProject', value);
      reload();
    });

    return taskListCard({
      title: 'המשימות שלי',
      // ספק אינו משויך למחלקה ואינו מקבל משימות ארגוניות
      note: App.isVendor() ? null : (App.state.actor.department || null),
      tasks: shown,
      filter,
      emptyText: picked && stillThere
        ? 'אין משימות פתוחות שלך בפרויקט הזה'
        : 'אין משימות פתוחות המשויכות אליך',
      onAll: () => (App.isVendor()
        ? App.navigate('vendor')
        : App.navigate('board', picked ? { projectId: Number(picked) } : { mine: true }))
    });
  }

  /**
   * חתך מחלקתי מרוכז — שורה למחלקה, ולחיצה עליה פותחת את הלוח מסונן לאותה מחלקה.
   * 'באיחור' ו'דחוף' נשארים שני מצבים נפרדים גם כאן, בשתי עמודות.
   */
  /**
   * החתך המחלקתי מקופל כברירת מחדל. הוא כלי בקרה שמסתכלים בו מדי פעם, ולא
   * מה שההנהלה צריכה לראות בפתיחת המסך — ופרוש הוא דוחק את המשימות עצמן
   * מטה. מצב הקיפול נשמר במכשיר.
   */
  const DEPT_CUT_KEY = 'mesimon.deptCutOpen';

  function departmentCutCard(rows) {
    const list = (rows ?? []).filter((d) => d.people || d.open || d.overdue);
    if (!list.length) return null;
    const open = localStorage.getItem(DEPT_CUT_KEY) === '1';

    const cell = (value, tagClass) =>
      el('td', {}, [value ? el(`span.tag.${tagClass}`, {}, [String(value)]) : el('span.mute-sm', { text: '—' })]);

    const body = el('div', { style: { display: open ? '' : 'none' } });
    const toggle = el('button.btn.btn-sm', {}, [open ? 'הסתרה' : 'הצגה']);
    toggle.addEventListener('click', () => {
      const nowOpen = body.style.display === 'none';
      body.style.display = nowOpen ? '' : 'none';
      toggle.textContent = nowOpen ? 'הסתרה' : 'הצגה';
      localStorage.setItem(DEPT_CUT_KEY, nowOpen ? '1' : '0');
    });

    // ‎.mt‎ הוסר: הכרטיס יושב בלוח החלונות, והמרווח בא מ-‎gap‎ שלו
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'חתך מחלקתי' }),
        el('span.mute-sm', {
          text: `${countLabel(list.length, 'מחלקה אחת', 'מחלקות')} · לחיצה על מחלקה פותחת את הלוח שלה`
        }),
        el('div.spacer'),
        toggle,
        el('button.btn.btn-sm', { onclick: () => App.navigate('reports') }, ['לדוחות המלאים'])
      ]),
      UI.mount(body,
      // התיבה על ‎.table-wrap‎ עצמו ולא סביבו: הוא כבר אזור הגלילה של הטבלה,
      // ורק כך כותרת העמודות הדביקה (‎th sticky‎) נשארת גלויה בזמן הגלילה
      el('div.table-wrap.feed-scroll', { style: { border: '0' } }, [
        el('table.data', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'מחלקה' }),
              el('th', { text: 'עובדים' }),
              el('th', { text: 'פתוחות' }),
              el('th', { text: 'באיחור' }),
              el('th', { text: 'דחופות' })
            ])
          ]),
          el('tbody', {}, list.map((d) => el('tr', {
            // שורת "ללא שיוך" מגיעה מהשרת בלי מזהה, ואין לוח שאפשר לסנן אליה
            onclick: d.id ? () => App.navigate('board', { departmentId: d.id }) : null,
            style: { cursor: d.id ? 'pointer' : 'default' },
            title: d.id ? `פתיחת הלוח של ${d.name}` : null
          }, [
            el('td.wrap', {}, [el('b', { text: d.name })]),
            el('td', { text: String(d.people) }),
            el('td', { text: String(d.open) }),
            cell(d.overdue, 'tag-overdue'),
            cell(d.urgent, 'tag-urgent')
          ])))
        ])
      ]))
    ]);
  }

  function approvalCard(tasks) {
    const shown = tasks.slice(0, APPROVAL_MAX);
    const rows = shown.map((t) => el('div.task-card', { onclick: () => TaskCardView.open(t.id) }, [
      el('div.tc-title', { text: t.title }),
      el('div.tc-tags', {}, [
        UI.statusTag(t),
        t.assigneeName ? el('span.tag.tag-vendor', {}, [t.assigneeName]) : null,
        ...UI.taskTags(t)
      ])
    ]));

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: App.isVendor() ? 'ממתין לבדיקת הצוות' : 'תוצרי ספקים הממתינים לאישור' }),
        shown.length
          ? el('span.mute-sm', { text: shownLabel(shown.length, tasks.length, 'פריט אחד', 'פריטים') })
          : null,
        el('div.spacer'),
        !App.isVendor() ? el('button.btn.btn-sm', { onclick: () => App.navigate('vendorBoards') }, ['לבורדי הספקים']) : null
      ]),
      el('div.card-pad', {}, [
        // כרטיס כאן נמוך מזה שברשימה האישית (בלי שורת תחתית), ולכן תקרה נמוכה יותר
        rows.length
          ? scrollBox(rows, { extraClass: '.flex-col' })
          : UI.empty('אין פריטים הממתינים לבדיקה', '✅')
      ])
    ]);
  }

  /** תצוגת לוח שנה מקוצרת לשבוע הקרוב */
  function calendarCard(weekAhead) {
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 7; i++) {
      const day = new Date(today);
      day.setDate(day.getDate() + i);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const items = weekAhead.filter((t) => {
        const d = new Date(t.dueDate);
        return d >= day && d < next;
      });
      const overdueToday = i === 0 ? weekAhead.filter((t) => new Date(t.dueDate) < today) : [];
      days.push({ date: day, items: [...overdueToday, ...items], isToday: i === 0 });
    }

    const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

    /**
     * שישי ושבת אינם ימי עבודה, ושורה ריקה עבורם היא שתי שורות מתוך שבע
     * שאינן אומרות דבר — בתיבה קטנה זה שליש מהגובה. הם נסתרים כברירת מחדל
     * ומופיעים כשיש בהם משימה: אם מישהו קבע יעד לשבת הוא התכוון לכך, וזו
     * בדיוק המשימה שאסור להסתיר.
     *
     * "היום" תמיד מוצג, גם בשבת — מסך שלא מראה את היום הנוכחי מבלבל.
     */
    const WEEKEND = [5, 6];   // getDay: 5 שישי, 6 שבת
    const shownDays = days.filter((d) =>
      d.isToday || d.items.length || !WEEKEND.includes(d.date.getDay()));

    /**
     * המונה נספר מן השורות עצמן ולא מאורך weekAhead: השרת מחזיר משימות עד
     * שבוע מרגע זה, כלומר גם משימה שיעדה מחרתיים־בעוד־שבוע בשעה מאוחרת מן
     * השעה הנוכחית — והיא נופלת מחוץ לשבעת הימים המוצגים. מונה שמראה מספר
     * גדול ממה שבתיבה נראה כאילו התיבה מסתירה, וזה בדיוק מה שהמונה בא למנוע.
     */
    const shownCount = days.reduce((sum, d) => sum + d.items.length, 0);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'השבוע הקרוב' }),
        shownCount
          ? el('span.mute-sm', { text: countLabel(shownCount, 'משימה אחת', 'משימות') })
          : null
      ]),
      /**
       * שם היום ותאריכו באותה שורה, ולא זה מעל זה: כך כל יום הוא שורה אחת
       * במקום שתיים, והתיבה תופסת כמחצית ממה שתפסה. יום עמוס עוד מותח את
       * שורתו, אך רוב הימים בשבוע ריקים ואין סיבה לשלם עליהם גובה כפול.
       */
      el('div.card-pad', {}, [scrollBox(shownDays.map((d) =>
        el('div.week-row', {}, [
          el('div.wk-day', {}, [
            el('b', { style: { color: d.isToday ? 'var(--brand)' : 'inherit' },
              text: d.isToday ? 'היום' : dayNames[d.date.getDay()] }),
            el('span.mute-sm', { text: UI.formatDate(d.date.toISOString()).slice(0, 5) })
          ]),
          el('div.wk-items', {}, d.items.length
            ? d.items.map((t) => el('div.wk-item', {
                title: t.title,
                // הצבע מסמן איחור בפועל
                style: { color: t.overdue ? 'var(--danger)' : 'inherit' },
                onclick: () => TaskCardView.open(t.id)
              }, [t.title]))
            : [el('span.mute-sm', { text: '—' })])
        ])
      ))])
    ]);
  }

  const ACTION_TEXT = {
    created: 'יצר/ה משימה',
    updated: 'עדכן/ה',
    status_changed: 'שינה/תה סטטוס',
    comment: 'הגיב/ה',
    attachment: 'העלה/תה קובץ',
    checklist: 'עדכן/ה צ׳קליסט',
    automation: 'אוטומציה'
  };

  function feedRow(f) {
    return el('div.history-item', {
      class: f.actorType === 'system' ? 'system' : '',
      style: { cursor: 'pointer' },
      onclick: () => TaskCardView.open(f.taskId)
    }, [
      el('div.h-dot'),
      el('div.h-body', {}, [
        el('div', {}, [
          el('b', { text: f.actorName }),
          ' ',
          el('span', { text: ACTION_TEXT[f.action] ?? f.action }),
          ' — ',
          el('span', { style: { color: 'var(--brand)' }, text: f.taskTitle })
        ]),
        // יש רשומות ללא פירוט, ובלי הסינון היה נדפס 'undefined' לפני הזמן
        el('div.h-meta', { text: [f.details, UI.relative(f.createdAt)].filter(Boolean).join(' · ') })
      ])
    ]);
  }

  /**
   * הפיד יושב בתיבת גלילה בגובה קבוע: קודם לכן כל עדכון הוסיף שורה לעמוד
   * והאריך אותו בלי סוף. הכותרת מציינת את מספר העדכונים כדי שגובה קבוע
   * לא יסתיר את העובדה שיש עוד מתחת לקיפול.
   */
  function feedCard(feed) {
    const items = feed.slice(0, FEED_MAX);
    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'פיד עדכונים אחרון' }),
        items.length
          ? el('span.mute-sm', { text: shownLabel(items.length, feed.length, 'עדכון אחד', 'עדכונים') })
          : null
      ]),
      el('div.card-pad', {}, [
        items.length
          ? scrollBox(items.map(feedRow))
          : UI.empty('אין עדכונים במשימות ובפרויקטים שלך', '📰')
      ])
    ]);
  }

  /**
   * הודעות שתויגתי בהן.
   *
   * כרטיס נפרד ולא שורות בפיד: תיוג הוא בקשה מפורשת שאדם הפנה אליי, וזה
   * הדבר שהכי לא צריך להיעלם. בפיד הכללי הוא נבלע בין עדכוני סטטוס ותאריכים.
   *
   * הכרטיס אינו נבנה כשאין תיוגים — מסך הבית עמוס דיו בלי כרטיס ריק.
   */
  function mentionsCard(mentions) {
    if (!mentions?.length) return null;

    const row = (m) => el('div.mention-item', {
      title: 'פתיחת המשימה',
      onclick: () => TaskCardView.open(m.taskId)
    }, [
      el('div.flex', { style: { gap: '7px' } }, [
        UI.avatar(m.authorName, { small: true }),
        el('b', { text: m.authorName, style: { fontSize: '12.5px' } }),
        m.internal ? el('span.mute-sm', { title: 'הערה פנימית', text: '🔒' }) : null,
        el('div.spacer'),
        el('small.mute-sm', { text: UI.relative(m.createdAt) })
      ]),
      // התיוג מוצג מודגש בתוך ההודעה, כמו בשרשור עצמו — לכן נדרשת רשימת השמות
      el('div.mi-body', {}, [UI.renderMentions(m.body, App.state.users.map((u) => u.name))]),
      el('div.mi-task', { text: m.taskTitle })
    ]);

    return el('div.card', {}, [
      el('div.card-head', {}, [
        el('span', { text: '@', style: { fontWeight: '800', color: 'var(--brand)' } }),
        el('h3', { text: 'תויגת בהודעות' }),
        el('div.spacer'),
        el('span.mute-sm', { text: countLabel(mentions.length, 'הודעה אחת', 'הודעות') })
      ]),
      el('div.card-pad', {}, [scrollBox(mentions.map(row))])
    ]);
  }

  return { render, reload };
})();
