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

  // ------------------------------------------------------- לוח החלונות

  /**
   * הכרטיסים בדף הבית הם חלונות על רשת חופשית, ברוח Draggable Widget Grid:
   * תופסים חלון בכותרת וגוררים, מושכים כל קצה או פינה כדי לשנות גודל, ושאר
   * הלוח מתפנה בזמן אמת. אין "מצב עריכה" — הלוח תמיד חי.
   *
   * למה לא מצב עריכה (כמו שהיה): הסידור עבד רק אחרי לחיצה על "סידור הלוח",
   * ומי שלא ידע על הכפתור לא ידע שאפשר לסדר בכלל. גרירה מהכותרת אינה מתנגשת
   * בשום דבר בחלון — הרשימות, הגלילה והלחיצות כולן בגוף החלון, ולכן הכותרת
   * פנויה להיות ידית.
   *
   * הסדר שכאן הוא ברירת המחדל, וכל מפתח שאינו מוכר מסונן — כך העדפה שנשמרה
   * לפני שכרטיס נולד אינה מסתירה אותו לנצח.
   */
  const CARD_ORDER = ['aiInbox', 'deptCut', 'myTasks', 'calendar', 'department', 'mentions', 'done', 'approval', 'feed'];
  const CARD_LABEL = {
    aiInbox: 'ממתין לאישורך',
    deptCut: 'חתך מחלקתי',
    myTasks: 'המשימות שלי',
    calendar: 'השבוע הקרוב',
    department: 'המשימות במחלקה',
    mentions: 'תויגת בהודעות',
    done: 'הושלמו לאחרונה',
    approval: 'ממתין לאישור',
    feed: 'פיד עדכונים אחרון'
  };
  /*
   * שורת הסבר לכל חלון, לתפריט "הוספת חלון". שם החלון לבדו אינו מספיק כדי
   * להחליט אם להחזיר אותו: "ממתין לאישור" ו"ממתין לאישורך" הם שני חלונות
   * שונים לגמרי, וההבדל ביניהם הוא בדיוק מה שהשורה הזו אומרת.
   */
  const CARD_HINT = {
    aiInbox: 'משימות שעוזר ה-AI זיהה בדואר וממתינות לאישורך',
    deptCut: 'פתוחות, באיחור ודחופות בכל מחלקה',
    myTasks: 'המשימות הפתוחות שלך, באיחור ראשונות',
    calendar: 'יעדים בשבעת הימים הקרובים',
    department: 'משימות הצוות במחלקה שלך',
    mentions: 'הודעות שבהן תייגו אותך',
    done: 'מה שנסגר לאחרונה, עד שעובר לארכיון',
    approval: 'תוצרי ספקים שמחכים לבדיקה',
    feed: 'מה קרה לאחרונה במשימות בכל הארגון',
    phonebook: 'חיפוש מהיר באנשי הקשר של הארגון'
  };
  // שם לתצוגה גם לחלון שנוסף בקובץ אחר ועדיין לא קיבל שם כאן
  const labelOf = (key) => CARD_LABEL[key] ?? key;

  /**
   * מידות הרשת.
   *
   * שורה של 40 פיקסלים ורווח של 14 — אותו רווח לרוחב ולגובה, כמו בדוגמה.
   * שורה נמוכה ולא "תא" גבוה: הגובה של חלון הוא מה שקובע כמה שורות משימה
   * רואים, ובצעד של 54 פיקסלים אפשר לעצור כמעט בכל גובה שהיד רוצה.
   *
   * ‎MD_BELOW‎ נמדד על רוחב הלוח ולא על רוחב המסך: תפריט הצד הנעוץ גוזל
   * 232 פיקסלים, ולוח של 800 פיקסלים בשתים-עשרה עמודות הוא עמודות של 55.
   */
  const GRID = { ROW: 40, GAP: 14, MIN_W: 3, MIN_H: 3, MD_BELOW: 900 };
  const UNIT_Y = GRID.ROW + GRID.GAP;
  const COLS = { lg: 12, md: 6, sm: 1 };

  /*
   * גובה מינימלי לפי סוג החלון — כך שהכותרת ושורה אחת תמיד נראות. בחלון
   * ה-AI יש כותרת ביניים לכל קבוצה, ולכן "שורה אחת" שם גבוהה יותר. החתך
   * המחלקתי מקופל כברירת מחדל — כותרת בלבד — ולכן הוא יכול לרדת לשתיים.
   */
  const MIN_H = { aiInbox: 4, deptCut: 2 };
  const minH = (key) => MIN_H[key] ?? GRID.MIN_H;
  const minW = (cols) => Math.min(GRID.MIN_W, cols);

  /*
   * ברירת המחדל: שורות של זוגות, וחלון שנשאר בלי בן זוג (כי אין לו תוכן או
   * כי אינו רלוונטי לתפקיד) ממלא את השורה לבדו. הגובה כאן הוא תקרה — חלון
   * שתוכנו קצר מתכווץ אליו (ראה fitToContent), ושני חלונות בזוג מקבלים את
   * אותו גובה כדי שהשורה תיגמר בקו אחד.
   */
  const DEFAULT_ROWS = [['aiInbox'], ['deptCut'], ['myTasks', 'calendar'], ['department', 'mentions'], ['done', 'approval'], ['feed']];
  const DEFAULT_H = { aiInbox: 7, deptCut: 6, myTasks: 9, calendar: 9, department: 8, mentions: 8, done: 7, approval: 7, feed: 8 };
  const PAIR_W = { myTasks: 7, calendar: 5, department: 7, mentions: 5 };   // מתוך 12; השאר חצי-חצי
  const defaultH = (key) => DEFAULT_H[key] ?? 7;

  /** גודל מהיר מתפריט החלון — חלק מרוחב הלוח, ולכן נכון גם ב-6 עמודות */
  const QUICK_SIZES = [
    { label: 'קטן', part: 1 / 3 },
    { label: 'בינוני', part: 1 / 2 },
    { label: 'רחב', part: 2 / 3 },
    { label: 'רוחב מלא', part: 1 }
  ];

  // הכרטיסים שברירת המחדל שלהם בלוח הישן הייתה שורה שלמה — להמרה בלבד
  const WIDE_BY_DEFAULT = new Set(['deptCut', 'aiInbox']);

  // ------------------------------------------------------- שמירה והמרה

  /**
   * ההעדפה: ‎{ v: 2, lg, md, sm, hidden }‎. לכל פריסה מפה של
   * ‎key → [x, y, w, h]‎ — מערך ולא אובייקט, כי ההעדפה מוגבלת בשרת ל-4KB
   * ושלוש פריסות של תשעה חלונות עם שמות שדות היו מתקרבות לתקרה.
   *
   * שלוש פריסות נפרדות ולא אחת שמתורגמת: חלון של שליש במחשב הוא חצי
   * בטאבלט ושורה שלמה בטלפון, ומי שסידר את הטלפון לפי מה שחשוב לו בדרכים
   * לא רוצה שהסידור במשרד ידרוס אותו. פריסה שלא נשמרה נגזרת מהגדולה ממנה.
   *
   * ‎x‎ נספר מתחילת השורה — בעברית מימין — ולכן אותו מספר נכון בכל כיוון.
   */
  function stored() {
    const raw = App.getPref('homeLayout', null);
    if (!raw || typeof raw !== 'object') return { v: 2, hidden: [] };
    if (raw.v === 2) return raw;
    return migrate(raw);
  }

  /**
   * הלוח הקודם שמר סדר, "רחב" או "צר", וגובה בפיקסלים. ההמרה פורסת אותו
   * לפי אותו סדר: רחב הוא 12 עמודות, צר הוא 6, ושני צרים יושבים בשורה אחת
   * — בדיוק כפי שנראו קודם. הגובה עובר לשורות; מי שלא קבע גובה מקבל את
   * ברירת המחדל. ההמרה נעשית בזיכרון ונשמרת עם השינוי הראשון.
   *
   * ‎shown‎ — החלונות שמוצגים עכשיו. בלוח הישן חלון בלי תוכן פשוט לא תפס
   * מקום, ולכן זוגות נקבעו רק בין המוצגים; פריסה לפי כל החלונות הייתה
   * מפרידה זוג שישב יחד בגלל חלון רחב שאינו מוצג בכלל.
   */
  function migrate(old, shown = CARD_ORDER) {
    const wide = new Set(old.wide ?? []);
    const narrow = new Set(old.narrow ?? []);
    const isWide = (k) => wide.has(k) || (!narrow.has(k) && WIDE_BY_DEFAULT.has(k));
    const saved = (old.order ?? []).filter((k) => CARD_ORDER.includes(k));
    const order = [...saved, ...CARD_ORDER.filter((k) => !saved.includes(k))]
      .filter((k) => shown.includes(k));
    const lg = {};
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const k of order) {
      const w = isWide(k) ? 12 : 6;
      const px = Number(old.heights?.[k]);
      const h = Number.isFinite(px) ? Math.max(minH(k), Math.round((px + GRID.GAP) / UNIT_Y)) : defaultH(k);
      if (x + w > 12) { y += rowH; x = 0; rowH = 0; }
      lg[k] = [x, y, w, h];
      x += w;
      rowH = Math.max(rowH, h);
    }
    return { v: 2, lg, hidden: Array.isArray(old.hidden) ? old.hidden : [] };
  }

  const hiddenKeys = () => new Set(stored().hidden ?? []);

  const pack = (items) => Object.fromEntries(items.map((i) => [i.key, [i.x, i.y, i.w, i.h]]));
  function unpack(map, keys) {
    const out = [];
    for (const key of keys) {
      const v = map?.[key];
      if (!Array.isArray(v) || v.length !== 4 || !v.every(Number.isFinite)) continue;
      const [x, y, w, h] = v;
      out.push({ key, x, y, w, h });
    }
    return out;
  }

  // ------------------------------------------------------- מנוע הרשת

  /*
   * המנוע עובד על מערך של ‎{ key, x, y, w, h }‎ ביחידות רשת, בלי DOM. כל
   * פעולה — גרירה, שינוי גודל, מקלדת, הסתרה — מחשבת פריסה חדשה מהפריסה
   * שלפני הפעולה, ולא מצטברת צעד אחר צעד. כך Escape באמצע גרירה הוא פשוט
   * חזרה לפריסה ההתחלתית, ותנועה הלוך-חזור של העכבר אינה משאירה עקבות.
   */
  const overlaps = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const hitAmong = (it, placed) => placed.find((p) => p.key !== it.key && overlaps(it, p));
  const bottomOf = (items) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);

  /**
   * הנחת חלון אחד מול מה שכבר הונח: חלון שמתנגש יורד מתחת למה שחוסם אותו,
   * וחלון פנוי עולה עד שהוא נוגע במשהו. עלייה צעד-צעד ולא קפיצה ל"מקום
   * הפנוי הראשון": קפיצה הייתה מעבירה חלון מעל חלון אחר אל חור שנפתח
   * מעליו, וזה נראה כמו ערבוב.
   */
  function place(it, placed) {
    it.y = Math.max(0, it.y);
    if (hitAmong(it, placed)) {
      for (let hit = hitAmong(it, placed); hit; hit = hitAmong(it, placed)) it.y = hit.y + hit.h;
      return;
    }
    while (it.y > 0 && !hitAmong({ ...it, y: it.y - 1 }, placed)) it.y--;
  }

  /**
   * דחיסה כלפי מעלה, בלי חורים. הסדר הוא לפי השורה, אחר כך לפי המקום שבו
   * החלון היה לפני הפעולה (‎rank‎) — כך שני חלונות שנדחפו לאותה שורה שומרים
   * על הסדר שהיה ביניהם — ורק אז לפי העמודה.
   */
  function compact(items) {
    const sorted = [...items].sort((a, b) =>
      (a.y - b.y) || ((a.rank ?? a.y) - (b.rank ?? b.y)) || (a.x - b.x));
    const placed = [];
    for (const it of sorted) { place(it, placed); placed.push(it); }
    for (const it of items) delete it.rank;
    return items;
  }

  /** חלון בתוך גבולות הרשת: רוחב ומיקום בעמודות, גובה מינימלי */
  function clampItem(it, cols) {
    it.w = Math.max(minW(cols), Math.min(cols, Math.round(it.w)));
    it.x = Math.max(0, Math.min(cols - it.w, Math.round(it.x)));
    it.h = Math.max(minH(it.key), Math.round(it.h));
    it.y = Math.max(0, Math.round(it.y));
    return it;
  }
  const normalize = (items, cols) => compact(items.map((i) => clampItem({ ...i }, cols)));

  /**
   * הפריסה אחרי שהחלון ‎moved‎ הונח במקום חדש או קיבל גודל חדש.
   *
   * החלון שבידי המשתמש קובע; כל חלון שהוא נוגע בו מחליט אם הוא נשאר מעליו
   * או יורד מתחתיו. ההחלטה לפי **אמצע** החלון השכן, כמו ברשימה ממוינת:
   *  - גרירה כלפי מטה: השכן קופץ מעל כשהקצה התחתון של הנגרר עובר את אמצעו;
   *  - גרירה כלפי מעלה, או לשורה של השכן: השכן יורד כשהקצה העליון של
   *    הנגרר עובר את אמצעו.
   * בלי זה הנגרר היה צריך לעבור את **כל** גובה השכן לפני שמשהו זז, וחלון
   * גבוה נראה כקיר שאי אפשר לעבור.
   *
   * החלפה בתוך שורה: כשגוררים חלון הצידה אל שכנו, השכן עובר לצד השני של
   * הנגרר, אל המקום שהתפנה — ולא יורד שורה ומשאיר חור. דחיסה כלפי מעלה בלבד לא הייתה ממלאת את
   * החור הזה לעולם, כי הוא בצד ולא מעל.
   *
   * בשינוי גודל ‎(resize)‎ השכנים שמתחת תמיד יורדים — הם נדחפים, לא מדלגים
   * מעל — ואינם מתכווצים.
   */
  function settle(base, moved, mode, cols) {
    const D0 = base.find((i) => i.key === moved.key);
    const out = base.map((i) => ({ ...(i.key === moved.key ? moved : i), rank: i.y }));
    if (!D0) out.push({ ...moved, rank: moved.y });
    const D = out.find((i) => i.key === moved.key);
    for (const E of out) {
      if (E === D || !overlaps(E, D)) continue;
      if (mode === 'move' && D0 && E.y === D0.y) {
        // הצד הפנוי של הנגרר — זה שקרוב יותר למקום שבו השכן עומד
        const side = [D.x + D.w, D.x - E.w]
          .filter((x) => x >= 0 && x + E.w <= cols && !overlaps({ ...E, x }, D))
          .sort((p, q) => Math.abs(p - E.x) - Math.abs(q - E.x))[0];
        if (side !== undefined) { E.x = side; continue; }
      }
      const fromBelow = D0 ? E.y > D0.y : false;
      const above = fromBelow
        ? mode === 'move' && D.y + D.h > E.y + E.h / 2
        : D.y >= E.y + E.h / 2;
      /*
       * שכן שעולה מעל — רק מי שבא מלמטה זז בפועל. מי שכבר היה מעל נשאר
       * במקומו: הזזה שלו למעלה הייתה מקפיצה אותו גם מעל חלונות אחרים.
       */
      if (above) { if (fromBelow) E.y = Math.min(E.y, D.y - E.h); }
      else E.y = D.y + D.h;
    }
    return compact(out);
  }

  /**
   * פריסה במסך בינוני מתוך פריסת המחשב: חצאים או שורה שלמה, בסדר הקריאה.
   * תרגום יחסי של העמודות היה יוצר שברים — 7 ו-5 מתוך 12 הם 3.5 ו-2.5 מתוך
   * 6 — והעיגול היה מפיל זוגות זה על זה. כאן כל חלון מקבל חצי (או שורה
   * שלמה אם היה רחב), ונכנס למקום הפנוי הראשון.
   */
  function reflow(items, cols) {
    const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const placed = [];
    for (const src of sorted) {
      const w = cols === 1 ? 1 : (src.w >= 9 ? cols : Math.max(minW(cols), Math.round(cols / 2)));
      const it = { key: src.key, x: 0, y: 0, w, h: src.h };
      for (let y = 0, done = false; !done; y++) {
        for (let x = 0; x + w <= cols; x++) {
          if (!hitAmong({ ...it, x, y }, placed)) { it.x = x; it.y = y; done = true; break; }
        }
      }
      placed.push(it);
    }
    return placed;
  }

  /**
   * ברירת המחדל לחלונות שאין להם מקום שמור, מתחת ל-‎top‎. כל חלון מסומן
   * בקבוצה (‎group‎) של השורה שלו, כדי שהתאמת הגובה לתוכן תשאיר זוג באותו
   * גובה.
   */
  function defaults(keys, cols, top) {
    const rows = DEFAULT_ROWS.map((r) => r.filter((k) => keys.includes(k)));
    for (const k of keys) if (!DEFAULT_ROWS.some((r) => r.includes(k))) rows.push([k]);
    const out = [];
    let y = top;
    rows.filter((r) => r.length).forEach((row, g) => {
      const h = Math.max(...row.map(defaultH));
      if (cols === 1 || row.length === 1) {
        for (const k of row) { out.push({ key: k, x: 0, y, w: cols, h: defaultH(k), group: `g${g}${k}` }); y += defaultH(k); }
        return;
      }
      const [a, b] = row;
      const wa = cols === 12 ? (PAIR_W[a] ?? 6) : Math.round(cols / 2);
      out.push({ key: a, x: 0, y, w: wa, h, group: `g${g}` });
      out.push({ key: b, x: wa, y, w: cols - wa, h, group: `g${g}` });
      y += h;
    });
    return out;
  }

  /**
   * הפריסה של נקודת שבירה, לחלונות שמוצגים עכשיו. מה ששמור — כמו שהוא;
   * מסך בינוני או טלפון שלא סודרו — נגזרים מהמחשב; וחלון שאין לו מקום (חלון
   * חדש, או ברירת מחדל מלאה) — לתחתית, ונמדד לפי תוכנו.
   *
   * חלון ששמור בפריסה אך אין לו תוכן היום (הפיד אצל מי שאינו מנהל, "ממתין
   * לאישורך" כשאין הצעות) פשוט אינו בין ‎keys‎ — והדחיסה סוגרת את מקומו.
   */
  function layoutFor(bpName, keys) {
    const raw = App.getPref('homeLayout', null);
    const st = raw && typeof raw === 'object' && raw.v !== 2 ? migrate(raw, keys) : stored();
    const cols = COLS[bpName];
    let items = [];
    if (st[bpName]) items = unpack(st[bpName], keys);
    else if (bpName !== 'lg' && st.lg) items = reflow(unpack(st.lg, keys), cols);
    else if (bpName === 'sm' && st.md) items = reflow(unpack(st.md, keys), cols);
    if (cols === 1) for (const it of items) { it.x = 0; it.w = 1; }
    const missing = keys.filter((k) => !items.some((i) => i.key === k));
    const extra = defaults(missing, cols, bottomOf(items));
    const auto = new Map(extra.map((i) => [i.key, i.group]));
    /*
     * טלפון שלא סודר: הסדר מהמחשב, אבל הגובה לפי התוכן. בעמודה צרה הכותרת
     * נשברת לשתיים-שלוש שורות, וגובה שנקבע לחלון רחב היה חותך אותו.
     */
    if (cols === 1 && !st[bpName]) for (const it of items) auto.set(it.key, it.key);
    return { items: normalize([...items, ...extra.map(({ group, ...i }) => i)], cols), auto };
  }

  // ------------------------------------------------------- מצב הלוח במסך

  let phRef = null;          // מסגרת הנחיתה המקווקוות
  let liveRef = null;        // הכרזות לקורא מסך
  let addBtnRef = null;      // "＋ הוספת חלון"
  let cardsRef = {};         // הכרטיסים שנבנו בציור האחרון — גם המוסתרים
  let slotCache = new Map(); // חלון לכל כרטיס — כרטיס עטוף פעם אחת, גם אם הוסתר והוחזר
  let bp = 'lg';
  let items = [];            // הפריסה שעל המסך
  let autoFit = new Map();   // חלונות בברירת מחדל שגובהם נגזר מתוכנם

  /*
   * היסטוריית הביטול — ההעדפה כולה לפני כל שינוי. שייכת לביקור במסך:
   * ביטול של סידור מלפני שבוע אינו מה שמישהו מצפה לו מ-Ctrl+Z.
   */
  const undoStack = [];
  const UNDO_MAX = 30;

  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const slotOf = (key) => boardRef?.querySelector(`:scope > .home-slot[data-key="${key}"]`) ?? null;
  const visibleKeys = () => items.map((i) => i.key);

  /** נקודת השבירה לפי המסך והלוח — טלפון, לוח צר (6) או רחב (12) */
  function bpNow() {
    if (App.isPhone()) return 'sm';
    const w = boardRef?.clientWidth || containerRef?.clientWidth || 1200;
    return w < GRID.MD_BELOW ? 'md' : 'lg';
  }

  /** גודל תא בפיקסלים, למעקב אחרי הסמן */
  function metrics() {
    const cols = COLS[bp];
    const width = boardRef.clientWidth;
    const col = (width - (cols - 1) * GRID.GAP) / cols;
    return { cols, unitX: col + GRID.GAP, rtl: getComputedStyle(boardRef).direction === 'rtl' };
  }

  const setVars = (node, it) => {
    node.style.setProperty('--x', String(it.x));
    node.style.setProperty('--y', String(it.y));
    node.style.setProperty('--w', String(it.w));
    node.style.setProperty('--h', String(it.h));
  };

  /** החלת פריסה על המסך. המעבר עצמו — בהנפשה ב-CSS */
  function paint(list, { skip = null } = {}) {
    if (!boardRef) return;
    boardRef.style.setProperty('--cols', String(COLS[bp]));
    boardRef.style.setProperty('--rows', String(bottomOf(list)));
    for (const it of list) {
      const slot = slotOf(it.key);
      if (slot && it.key !== skip) setVars(slot, it);
    }
  }

  /**
   * התאמת הגובה לתוכן — לחלונות בברירת מחדל, ומהתפריט לחלון אחד.
   *
   * בברירת המחדל הגובה הוא תקרה: חלון "תויגת" עם הודעה אחת לא צריך תשעה
   * שורות, וחלל ריק מתחת לשורה אחת נראה כתקלה. המדידה בגובה טבעי (מחלקה
   * זמנית שמשחררת את הגובה הקבוע), כל החלונות יחד — כדי שהדפדפן יחשב
   * פריסה פעם אחת ולא פעם לכל חלון.
   */
  function naturalRows(keys) {
    const slots = keys.map(slotOf).filter(Boolean);
    for (const s of slots) s.classList.add('is-measuring');
    const out = new Map(slots.map((s) => [s.dataset.key,
      Math.ceil((s.firstElementChild.offsetHeight + GRID.GAP) / UNIT_Y)]));
    for (const s of slots) s.classList.remove('is-measuring');
    return out;
  }

  function fitToContent() {
    if (!autoFit.size) return;
    const need = naturalRows([...autoFit.keys()]);
    const groups = new Map();
    for (const [key, group] of autoFit) {
      const it = items.find((i) => i.key === key);
      if (!it || !need.has(key)) continue;
      it.h = Math.max(minH(key), Math.min(defaultH(key), need.get(key)));
      groups.set(group, Math.max(groups.get(group) ?? 0, it.h));
    }
    // זוג בשורה אחת — באותו גובה, אחרת השורה נגמרת בשני קווים
    for (const [key, group] of autoFit) {
      const it = items.find((i) => i.key === key);
      if (it) it.h = groups.get(group) ?? it.h;
    }
    items = compact(items);
  }

  /**
   * שמירה: הפריסה של נקודת השבירה הנוכחית, על גבי מה שכבר שמור — חלון
   * ששמור אך אינו מוצג היום שומר את מקומו לפעם הבאה שיהיה לו תוכן.
   */
  function commit(next, { message, nextHidden = null } = {}) {
    const before = App.getPref('homeLayout', null);
    const st = stored();
    const hidden = nextHidden ?? st.hidden ?? [];
    const saved = { ...(st[bp] ?? {}) };
    for (const k of hidden) delete saved[k];
    App.setPref('homeLayout', { ...st, v: 2, [bp]: { ...saved, ...pack(next) }, hidden });
    undoStack.push(before === null ? null : JSON.parse(JSON.stringify(before)));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    items = next;
    autoFit = new Map();
    if (message) UI.undoToast(message, { onUndo: undo });
  }

  /** ביטול השינוי האחרון — מהטוסט או ב-Ctrl+Z */
  function undo() {
    if (!undoStack.length) return;
    const prev = undoStack.pop();
    const hiddenBefore = [...hiddenKeys()].join();
    App.setPref('homeLayout', prev);
    // חלון שהוסתר או הוחזר — הלוח נבנה מחדש מהכרטיסים; אחרת רק הזזה
    if ([...hiddenKeys()].join() !== hiddenBefore) return rebuild();
    relayout();
    announce('השינוי האחרון בוטל');
  }

  /** פריסה מחדש מההעדפה, בלי לבנות את החלונות — אחרי ביטול או שינוי רוחב */
  function relayout() {
    if (!boardRef?.isConnected) return;
    bp = bpNow();
    const res = layoutFor(bp, visibleKeys());
    items = res.items;
    autoFit = res.auto;
    boardRef.dataset.bp = bp;
    paint(items);
    fitToContent();
    paint(items);
    syncHandles();
  }

  function announce(text) {
    if (!liveRef) return;
    // ריקון ומילוי, כדי שאותה הודעה פעמיים ברצף תוקרא גם בפעם השנייה
    liveRef.textContent = '';
    requestAnimationFrame(() => { if (liveRef) liveRef.textContent = text; });
  }

  const describe = (it) => (bp === 'sm'
    ? `${labelOf(it.key)} במקום ${items.filter((i) => i.y < it.y).length + 1}, גובה ${it.h}`
    : `${labelOf(it.key)} בשורה ${it.y + 1}, עמודה ${it.x + 1}, רוחב ${it.w}, גובה ${it.h}`);

  // ------------------------------------------------------- גרירה

  const DRAG = {
    START_SLOP: 4,      // עכבר: תזוזה שהופכת לחיצה לגרירה
    LONG_PRESS_MS: 380, // מגע: זמן לחיצה על הכותרת עד שהחלון מורם
    PRESS_SLOP: 8,      // מגע: תזוזה מותרת בזמן הלחיצה לפני שזו גלילה
    SWALLOW_MS: 300,    // אחרי שחרור — חסימת הלחיצה שהדפדפן יורה מיד אחריו
    LANDED_MS: 650,     // משך הסימון של חלון שנחת
    EDGE: 70            // גלילה אוטומטית ליד קצה המסך
  };

  /** האב הראשון שנגלל, לגלילה אוטומטית ליד הקצה */
  const scrollerOf = (node) => {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  };

  /* פקדים בכותרת שהלחיצה עליהם היא לחיצה, ולא תחילת גרירה */
  const INTERACTIVE = 'button, a, input, select, textarea, label, [contenteditable], [role="button"]';

  /**
   * הדפדפן יורה ‎click‎ מיד אחרי השחרור, על האב המשותף של נקודת הלחיצה
   * ונקודת השחרור. כשהשחרור נופל על שורת משימה זו הייתה פותחת את כרטיס
   * המשימה — כלומר כל גרירה שהסתיימה מעל רשימה פתחה משימה שאיש לא ביקש.
   */
  function swallowNextClick() {
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), DRAG.SWALLOW_MS);
  }

  /** תחילת לחיצה על כותרת: עכבר — אחרי תזוזה קטנה; מגע — לחיצה ארוכה */
  function onHeadPointerDown(e, slot) {
    if (e.button !== 0 || !e.isPrimary || e.target.closest(INTERACTIVE)) return;
    const pointerId = e.pointerId;
    const touch = e.pointerType === 'touch';
    const origin = { x: e.clientX, y: e.clientY };
    let session = null;
    let timer = 0;
    // עכבר: מונע בחירת טקסט בכותרת. מגע: לא — אחרת הדף לא היה נגלל מהכותרת
    if (!touch) e.preventDefault();

    const begin = () => {
      timer = 0;
      slot.classList.remove('is-holding');
      navigator.vibrate?.(10);
      session = liftSlot(slot, origin);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      if (session) { ev.preventDefault(); session.move(ev.clientX, ev.clientY); return; }
      const dist = Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y);
      if (touch) { if (dist > DRAG.PRESS_SLOP) finish(ev, true); }   // זו גלילה, לא גרירה
      else if (dist > DRAG.START_SLOP) { begin(); session.move(ev.clientX, ev.clientY); }
    };
    // חסימת גלילת הדף רק אחרי שהחלון הורם
    const blockTouch = (ev) => { if (session) ev.preventDefault(); };
    const onKey = (ev) => { if (ev.key === 'Escape' && session) { ev.preventDefault(); ev.stopPropagation(); finish(null, true); } };
    const finish = (ev, cancelled = false) => {
      if (ev && ev.pointerId !== pointerId) return;
      clearTimeout(timer);
      slot.classList.remove('is-holding');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', blockTouch);
      window.removeEventListener('keydown', onKey, true);
      if (session) session.drop(cancelled);
    };
    const onUp = (ev) => finish(ev, false);
    // ‎pointercancel‎ — הדפדפן לקח את המגע (גלילה, מחווה): חזרה למקום
    const onCancel = (ev) => finish(ev, true);

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchmove', blockTouch, { passive: false });
    window.addEventListener('keydown', onKey, true);
    if (touch) {
      slot.classList.add('is-holding');
      timer = setTimeout(begin, DRAG.LONG_PRESS_MS);
    }
  }

  /**
   * גרירה אחת: החלון "מורם" — הגדלה קלה, צל עמוק וסמן יד — ועוקב אחרי
   * הסמן בפיקסלים, בלי הצמדה. מקום הנחיתה מוצמד לרשת ומסומן במסגרת
   * מקווקוות, ושאר החלונות זזים אליו בהנפשה. בשחרור החלון נוחת במסגרת.
   *
   * מצביע ולא HTML5 drag-and-drop: באחרון הדפדפן מצייר תמונת רפאים שקופה
   * ואין שליטה על שאר הלוח תוך כדי, ובמגע הוא אינו עובד כלל.
   */
  function liftSlot(slot, origin) {
    const key = slot.dataset.key;
    const base = items.map((i) => ({ ...i }));
    const D0 = base.find((i) => i.key === key);
    const m = metrics();
    const scroller = scrollerOf(boardRef);
    const r0 = slot.getBoundingClientRect();
    // היכן בתוך החלון נתפס — כדי שהחלון לא "יקפוץ" אל הסמן
    const grab = { inline: m.rtl ? r0.right - origin.x : origin.x - r0.left, y: origin.y - r0.top };
    let pointer = { ...origin };
    let target = { x: D0.x, y: D0.y };
    let next = base;
    let frame = 0;

    slot.classList.add('is-lifted');
    boardRef.classList.add('is-arranging');
    document.body.classList.add('is-dragging-slot');
    setVars(phRef, D0);
    phRef.hidden = false;

    const follow = () => {
      const b = boardRef.getBoundingClientRect();
      const inline = m.rtl ? b.right - pointer.x - grab.inline : pointer.x - b.left - grab.inline;
      const top = pointer.y - b.top - grab.y;
      slot.style.setProperty('--drag-x', `${inline}px`);
      slot.style.setProperty('--drag-y', `${top}px`);
      const x = Math.max(0, Math.min(m.cols - D0.w, Math.round(inline / m.unitX)));
      const y = Math.max(0, Math.round(top / UNIT_Y));
      if (x === target.x && y === target.y) return;
      target = { x, y };
      next = settle(base, { ...D0, x, y }, 'move', m.cols);
      const landing = next.find((i) => i.key === key);
      setVars(phRef, landing);
      paint(next, { skip: key });
    };

    /** גלילה אוטומטית כשהסמן קרוב לקצה המסך */
    const autoscroll = () => {
      const h = window.innerHeight;
      const speed = pointer.y < DRAG.EDGE ? -(DRAG.EDGE - pointer.y)
        : pointer.y > h - DRAG.EDGE ? pointer.y - (h - DRAG.EDGE) : 0;
      if (speed) scroller.scrollTop += speed * 0.35;
    };

    // לולאה אחת לכל פריים: גם כשהסמן עומד, הגלילה והמעקב ממשיכים
    const tick = () => { autoscroll(); follow(); frame = requestAnimationFrame(tick); };
    // מיד ולא בפריים הבא: בלי מיקום בפיקסלים החלון היה מהבהב בפינת הלוח
    follow();
    frame = requestAnimationFrame(tick);

    return {
      move(x, y) { pointer = { x, y }; },
      drop(cancelled) {
        cancelAnimationFrame(frame);
        document.body.classList.remove('is-dragging-slot');
        boardRef.classList.remove('is-arranging');
        flushReload();
        phRef.hidden = true;
        const result = cancelled ? base : next;
        paint(result, { skip: key });
        setVars(slot, result.find((i) => i.key === key));
        // הסרת ‎is-lifted‎ מחזירה את החלון מהפיקסלים אל הרשת — במעבר ה-CSS
        slot.classList.remove('is-lifted');
        slot.style.removeProperty('--drag-x');
        slot.style.removeProperty('--drag-y');
        landed(slot);
        swallowNextClick();
        if (cancelled) { announce('הגרירה בוטלה'); return; }
        const changed = JSON.stringify(pack(next)) !== JSON.stringify(pack(base));
        if (!changed) return;
        commit(next, { message: `"${labelOf(key)}" הוזז` });
        announce(`${describe(next.find((i) => i.key === key))}`);
        syncHandles();
      }
    };
  }

  /*
   * רענון רקע שהגיע באמצע גרירה (עדכון משימה, סריקת דואר) נדחה לסופה:
   * ציור מחדש היה מחליף את החלון שביד במשהו אחר, והגרירה הייתה נקטעת.
   */
  let reloadWaiting = false;
  const flushReload = () => {
    if (!reloadWaiting) return;
    reloadWaiting = false;
    setTimeout(reload, 0);
  };

  /** מסגרת רגעית סביב חלון שנחת — העין מוצאת אותו במקומו החדש */
  function landed(slot) {
    slot.classList.add('is-landed');
    setTimeout(() => slot.classList.remove('is-landed'), DRAG.LANDED_MS);
  }

  // ------------------------------------------------------- שינוי גודל

  /*
   * שמונה ידיות: ארבעה צדדים וארבע פינות. השמות לוגיים — ‎s‎ (start) הוא
   * תחילת השורה, ובעברית הצד הימני — כדי שאותו קוד יעבוד בכל כיוון כתיבה.
   * בטלפון רק התחתונה: אין שינוי רוחב בעמודה אחת.
   */
  const HANDLES = ['t', 'b', 's', 'e', 'ts', 'te', 'bs', 'be'];

  function resizeHandles(slot) {
    const phone = bp === 'sm';
    return (phone ? ['b'] : HANDLES).map((dir) => {
      const h = el(`span.slot-rz.rz-${dir}`, { 'aria-hidden': 'true', 'data-dir': dir });
      h.addEventListener('pointerdown', (e) => startResize(e, slot, dir));
      h.addEventListener('dblclick', (e) => { e.preventDefault(); fitOne(slot.dataset.key); });
      return h;
    });
  }

  /** הידיות נבנות מחדש כשהלוח עובר בין טלפון למחשב — שם יש רק ידית אחת */
  function syncHandles() {
    if (!boardRef) return;
    const want = bp === 'sm' ? 1 : HANDLES.length;
    for (const slot of boardRef.querySelectorAll(':scope > .home-slot')) {
      const have = slot.querySelectorAll(':scope > .slot-rz');
      if (have.length === want) continue;
      for (const h of have) h.remove();
      slot.append(...resizeHandles(slot));
    }
  }

  function startResize(e, slot, dir) {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    const key = slot.dataset.key;
    const base = items.map((i) => ({ ...i }));
    const D0 = base.find((i) => i.key === key);
    const m = metrics();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let next = base;
    let shape = { ...D0 };

    const tip = slot.appendChild(el('span.slot-size', { 'aria-hidden': 'true' }));
    const showTip = (it) => { tip.textContent = bp === 'sm' ? `גובה ${it.h}` : `${it.w} × ${it.h}`; };
    showTip(D0);
    slot.classList.add('is-resizing');
    boardRef.classList.add('is-arranging');
    document.body.classList.add(`is-resizing-slot`);
    document.body.dataset.rz = dir;
    setVars(phRef, D0);
    phRef.hidden = false;

    const onMove = (ev) => {
      // ‎inline‎ חיובי = לכיוון סוף השורה (בעברית — שמאלה)
      const dInline = Math.round((m.rtl ? start.x - ev.clientX : ev.clientX - start.x) / m.unitX);
      const dy = Math.round((ev.clientY - start.y) / UNIT_Y);
      const it = { ...D0 };
      const lowW = minW(m.cols);
      if (dir.includes('e')) it.w = Math.max(lowW, Math.min(m.cols - D0.x, D0.w + dInline));
      if (dir.includes('s')) {
        const dx = Math.max(-D0.x, Math.min(D0.w - lowW, dInline));
        it.x = D0.x + dx;
        it.w = D0.w - dx;
      }
      if (dir.includes('b')) it.h = Math.max(minH(key), D0.h + dy);
      if (dir.includes('t')) {
        const d = Math.max(-D0.y, Math.min(D0.h - minH(key), dy));
        it.y = D0.y + d;
        it.h = D0.h - d;
      }
      if (it.x === shape.x && it.y === shape.y && it.w === shape.w && it.h === shape.h) return;
      shape = it;
      next = settle(base, it, 'resize', m.cols);
      paint(next);
      setVars(phRef, next.find((i) => i.key === key));
      showTip(shape);
    };
    const end = (cancelled) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      tip.remove();
      slot.classList.remove('is-resizing');
      boardRef.classList.remove('is-arranging');
      flushReload();
      document.body.classList.remove('is-resizing-slot');
      delete document.body.dataset.rz;
      phRef.hidden = true;
      if (cancelled) { paint(base); announce('שינוי הגודל בוטל'); return; }
      paint(next);
      if (JSON.stringify(pack(next)) === JSON.stringify(pack(base))) return;
      swallowNextClick();
      commit(next, { message: `גודל "${labelOf(key)}" השתנה` });
      announce(describe(next.find((i) => i.key === key)));
    };
    const onUp = () => end(false);
    const onCancel = () => end(true);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(true); } };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  // ------------------------------------------------------- פעולות על חלון

  /** הזזה או שינוי גודל בצעד אחד — מהמקלדת ומהתפריט */
  function applyShape(key, shape, mode, message) {
    const base = items.map((i) => ({ ...i }));
    const next = settle(base, clampItem({ ...shape, key }, COLS[bp]), mode, COLS[bp]);
    if (JSON.stringify(pack(next)) === JSON.stringify(pack(base))) return false;
    paint(next);
    commit(next, { message });
    announce(describe(next.find((i) => i.key === key)));
    return true;
  }

  /**
   * מקלדת, מהכותרת: Ctrl וחצים מזיזים, Shift וחצים משנים גודל.
   *
   * הזזה אנכית מחפשת את הצעד הראשון שמשנה משהו. שורה אחת למטה לרוב אינה
   * משנה דבר — הדחיסה מחזירה את החלון למעלה — ולחיצה שלא עושה דבר נראית
   * כתקלה. לכן הצעד גדל עד שהחלון באמת עובר את שכנו.
   *
   * בעברית חץ שמאלה הוא "קדימה" בשורה — לכיוון סוף השורה.
   */
  function onSlotKey(e, slot) {
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [1, 0], ArrowRight: [-1, 0] };
    const step = arrows[e.key];
    if (!step || e.altKey) return;
    // רק מהכותרת — בגוף החלון החצים שייכים לרשימה ולשדות שבו
    if (!e.target.closest('.card-head') || e.target.closest('input, select, textarea, [contenteditable]')) return;
    const moving = (e.ctrlKey || e.metaKey) && !e.shiftKey;
    const sizing = e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (!moving && !sizing) return;
    const it = items.find((i) => i.key === slot.dataset.key);
    if (!it) return;
    e.preventDefault();
    const rtl = getComputedStyle(boardRef).direction === 'rtl';
    const dx = rtl ? step[0] : -step[0];
    const [, dy] = step;
    if (bp === 'sm' && dx) return;   // בטלפון אין רוחב ואין צד

    if (sizing) {
      const shape = { ...it, w: it.w + dx, h: it.h + dy };
      if (!applyShape(it.key, shape, 'resize', `גודל "${labelOf(it.key)}" השתנה`)) announce(describe(it));
      return;
    }
    if (dx) {
      if (!applyShape(it.key, { ...it, x: it.x + dx }, 'move', `"${labelOf(it.key)}" הוזז`)) announce(describe(it));
      return;
    }
    const base = items.map((i) => ({ ...i }));
    const was = JSON.stringify(pack(base));
    for (let y = it.y + dy, n = 0; y >= 0 && n < 80; y += dy, n++) {
      const next = settle(base, { ...it, y }, 'move', COLS[bp]);
      if (JSON.stringify(pack(next)) === was) continue;
      paint(next);
      commit(next, { message: `"${labelOf(it.key)}" הוזז` });
      announce(describe(next.find((i) => i.key === it.key)));
      return;
    }
    announce(describe(it));
  }

  /** גובה לפי התוכן לחלון אחד — מהתפריט ובלחיצה כפולה על ידית */
  function fitOne(key) {
    const it = items.find((i) => i.key === key);
    if (!it) return;
    const need = naturalRows([key]).get(key);
    if (!need) return;
    applyShape(key, { ...it, h: Math.max(minH(key), need) }, 'resize', `גובה "${labelOf(key)}" הותאם לתוכן`);
  }

  function hideCard(key) {
    const slot = slotOf(key);
    if (!slot) return;
    const hidden = [...new Set([...(stored().hidden ?? []), key])];
    slot.remove();
    slot.classList.remove('is-landed');
    const next = compact(items.filter((i) => i.key !== key).map((i) => ({ ...i })));
    paint(next);
    commit(next, { message: `"${labelOf(key)}" הוסתר`, nextHidden: hidden });
    announce(`${labelOf(key)} הוסתר. אפשר להחזיר אותו מ"הוספת חלון".`);
    afterMembershipChange();
  }

  /**
   * החזרת חלון מוסתר — לתחתית הלוח, ומיד לעין. הכרטיס כבר נבנה בציור
   * האחרון (ראה ‎cardsRef‎), ולכן אין צורך לטעון את הדף מחדש.
   */
  function showCard(key) {
    const card = cardsRef[key];
    if (!card) return;
    const hidden = (stored().hidden ?? []).filter((k) => k !== key);
    const slot = slotCache.get(key) ?? slotFor(key, card);
    slotCache.set(key, slot);
    boardRef.insertBefore(slot, phRef);
    const [it] = defaults([key], COLS[bp], bottomOf(items));
    const fresh = { ...it };
    delete fresh.group;
    setVars(slot, fresh);
    const rows = naturalRows([key]).get(key);
    if (rows) fresh.h = Math.max(minH(key), Math.min(defaultH(key), rows));
    const next = compact([...items.map((i) => ({ ...i })), fresh]);
    paint(next);
    commit(next, { message: `"${labelOf(key)}" הוחזר ללוח`, nextHidden: hidden });
    afterMembershipChange();
    landed(slot);
    slot.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    slot.querySelector('.card-head')?.focus({ preventScroll: true });
  }

  /** איפוס: כל החלונות גלויים, בברירת המחדל ובגובה לפי התוכן */
  function resetBoard() {
    const before = App.getPref('homeLayout', null);
    App.setPref('homeLayout', null);
    undoStack.push(before === null ? null : JSON.parse(JSON.stringify(before)));
    UI.undoToast('הלוח חזר לסידור המקורי', { onUndo: undo });
    rebuild();
  }

  /** מספר החלונות המוסתרים על הכפתור, ולוח ריק — הודעה */
  function afterMembershipChange() {
    refreshAddButton();
    const wrap = boardRef?.parentElement;
    wrap?.querySelector(':scope > .home-empty')?.remove();
    if (wrap && !items.length) wrap.appendChild(emptyNote());
  }

  const emptyNote = () => el('div.card.card-pad.mute-sm.home-empty', {
    text: 'כל החלונות מוסתרים. "＋ הוספת חלון" בראש הדף מחזיר אותם.'
  });

  /** בנייה מחדש של הלוח מהכרטיסים שכבר נבנו — אחרי איפוס או ביטול הסתרה */
  function rebuild() {
    if (!boardRef?.isConnected) return;
    boardRef.parentElement.replaceWith(homeBoard(cardsRef));
    layoutBoard();
    refreshAddButton();
  }

  // ------------------------------------------------------- תפריטים

  /**
   * תפריט קטן צף, ליד הכפתור שפתח אותו. אחד בכל פעם; נסגר בלחיצה בחוץ,
   * ב-Escape, בגלילה ובשינוי גודל — הוא ‎fixed‎ ואחרת היה מתנתק מהכפתור.
   * (גלילה: רק כזו שבאמת הזיזה את הכפתור. הדפדפן יורה את אירוע הגלילה
   * בפריים שאחרי הגלילה, ולחיצה מיד אחרי גלילה סגרה את התפריט ברגע שנפתח.)
   * חצים למעלה ולמטה עוברים בין הפריטים, והמיקוד חוזר לכפתור בסגירה.
   */
  let menuClose = null;

  function popMenu(anchor, entries, label) {
    const wasOpen = menuClose && anchor.getAttribute('aria-expanded') === 'true';
    menuClose?.();
    if (wasOpen) return;
    const options = [];
    const list = el('div.popover-list.slot-menu', { role: 'menu', 'aria-label': label },
      entries.map((en) => {
        if (en === '-') return el('div.fm-sep', { role: 'separator' });
        if (en.heading) return el('div.sm-heading', { text: en.heading });
        const b = el(`button.popover-option${en.danger ? '.is-danger' : ''}`, {
          type: 'button',
          role: en.checked === undefined ? 'menuitem' : 'menuitemradio',
          'aria-checked': en.checked === undefined ? null : String(!!en.checked),
          disabled: en.disabled || null,
          onclick: () => { close(); en.run(); }
        }, [
          el('span.sm-text', {}, [
            el('span', { text: en.label }),
            en.hint ? el('span.sm-hint', { text: en.hint }) : null
          ]),
          en.checked ? el('span.check', {}, [UI.lineIcon('check')]) : null
        ]);
        options.push(b);
        return b;
      }));
    const node = el('div.cell-popover.slot-menu-pop', {}, [list]);
    document.body.appendChild(node);

    // מיקום: מתחת לכפתור, מיושר לקצה שלו שפונה פנימה; למעלה אם אין מקום
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    const down = window.innerHeight - r.bottom > h + 12 || r.top < h + 12;
    node.style.left = `${left}px`;
    node.style.top = `${down ? r.bottom + 4 : r.top - h - 4}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const onOutside = (ev) => { if (!node.contains(ev.target) && !anchor.contains(ev.target)) close(); };
    // גלילה שהזיזה את הכפתור — ולא אירוע גלילה מאוחר של גלילה שכבר נגמרה
    const onScroll = (ev) => {
      if (node.contains(ev.target)) return;
      if (Math.abs(anchor.getBoundingClientRect().top - r.top) > 2) close();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); anchor.focus(); return; }
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      const live = options.filter((o) => !o.disabled);
      const i = live.indexOf(document.activeElement);
      live[(i + (ev.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length]?.focus();
    };
    const timer = setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', close);
    node.addEventListener('keydown', onKey);

    function close() {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', close);
      anchor.setAttribute('aria-expanded', 'false');
      node.remove();
      if (menuClose === close) menuClose = null;
    }
    menuClose = close;
    options.find((o) => !o.disabled)?.focus();
  }

  /** תפריט ⋯ של חלון: הסתרה, גודל מהיר, גובה לפי התוכן ואיפוס הלוח */
  function slotMenu(anchor, key) {
    const it = items.find((i) => i.key === key);
    if (!it) return;
    const cols = COLS[bp];
    const sizes = bp === 'sm' ? [] : QUICK_SIZES.map((s) => {
      const w = Math.max(minW(cols), Math.round(cols * s.part));
      return { w, label: s.label };
    }).filter((s, i, all) => all.findLastIndex((o) => o.w === s.w) === i);   // ב-6 עמודות קטן ובינוני זהים

    popMenu(anchor, [
      ...(sizes.length ? [{ heading: 'גודל' }] : []),
      ...sizes.map((s) => ({
        label: s.label,
        hint: `${s.w} מתוך ${cols}`,
        checked: it.w === s.w,
        run: () => applyShape(key, { ...it, w: s.w, x: Math.min(it.x, cols - s.w) }, 'resize', `גודל "${labelOf(key)}" השתנה`)
      })),
      ...(sizes.length ? ['-'] : []),
      { label: 'גובה לפי התוכן', run: () => fitOne(key) },
      { label: 'הסתרת החלון', run: () => hideCard(key) },
      '-',
      { label: 'איפוס הלוח לברירת מחדל', danger: true, run: resetBoard }
    ], `אפשרויות החלון ${labelOf(key)}`);
  }

  /** "＋ הוספת חלון" — החלונות המוסתרים שיש בהם תוכן כרגע */
  function addMenu(anchor) {
    const hidden = hiddenKeys();
    const can = CARD_ORDER.filter((k) => hidden.has(k) && cardsRef[k]);
    popMenu(anchor, [
      ...(can.length
        ? can.map((k) => ({ label: labelOf(k), hint: CARD_HINT[k], run: () => showCard(k) }))
        : [{ label: 'כל החלונות כבר מוצגים', disabled: true, run: () => {} }]),
      '-',
      { label: 'איפוס הלוח לברירת מחדל', danger: true, run: resetBoard }
    ], 'הוספת חלון');
  }

  function refreshAddButton() {
    if (!addBtnRef) return;
    const hidden = hiddenKeys();
    const n = CARD_ORDER.filter((k) => hidden.has(k) && cardsRef[k]).length;
    addBtnRef.querySelector('.hab-count')?.remove();
    if (n) addBtnRef.appendChild(el('span.hab-count', { text: String(n), title: `${n} חלונות מוסתרים` }));
    addBtnRef.title = n ? `החזרת חלון מוסתר (${n})` : 'כל החלונות מוצגים';
  }

  // ------------------------------------------------------- בניית הלוח

  /**
   * עטיפת כרטיס לחלון: הכותרת נעשית ידית גרירה (ומקבלת מיקוד, לקיצורי
   * המקלדת), כפתור ⋯ נכנס לקבוצת הפקדים שלה, וידיות הגודל יושבות על הקצוות.
   */
  function slotFor(key, card) {
    const hasList = !!card.querySelector('.feed-scroll');
    const slot = el(`div.home-slot${hasList ? '.has-list' : ''}`, {
      'data-key': key,
      role: 'listitem',
      'aria-label': labelOf(key)
    }, [card]);

    const head = card.querySelector('.card-head');
    if (head) {
      head.classList.add('is-handle');
      head.tabIndex = 0;
      head.setAttribute('aria-roledescription', 'כותרת חלון נגרר');
      head.setAttribute('aria-label', labelOf(key));
      head.setAttribute('aria-describedby', 'home-board-help');
      const actions = headActions(head);
      const menuBtn = el('button.slot-menu-btn', {
        type: 'button',
        title: 'אפשרויות החלון',
        'aria-label': `אפשרויות החלון ${labelOf(key)}`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: (e) => { e.stopPropagation(); slotMenu(menuBtn, key); }
      }, [UI.lineIcon('ellipsis')]);
      actions.appendChild(menuBtn);
      head.addEventListener('pointerdown', (e) => onHeadPointerDown(e, slot));
      // לחיצה ארוכה במגע פותחת אחרת תפריט הקשר או בחירת טקסט
      head.addEventListener('contextmenu', (e) => { if (!e.target.closest(INTERACTIVE)) e.preventDefault(); });
    }
    slot.addEventListener('keydown', (e) => onSlotKey(e, slot));
    /*
     * התוכן השתנה מבפנים (החתך המחלקתי נפתח או נסגר). חלון שגובהו נגזר
     * מהתוכן — כלומר המשתמש עוד לא קבע לו גודל — נמדד מחדש; גודל שנקבע ביד
     * נשאר, והתוכן נגלל בתוכו.
     */
    slot.addEventListener('home:content', () => { if (autoFit.has(key)) relayout(); });
    slot.append(...resizeHandles(slot));
    return slot;
  }

  /**
   * סידור כותרת החלון לשתי קבוצות: הכותרת ותת-הכותרת, והפקדים.
   *
   * הכותרת הייתה שורת ‎flex‎ אחת שאינה נשברת, ובחלון צר כל פריט בה התכווץ —
   * וה-‎h3‎, שהוא היחיד שיכול לשבור שורות, התכווץ לעמודה של מילה אחת בשורה,
   * בעוד "לכל המשימות" נדחק אל מחוץ לכרטיס. עכשיו כל מה שאחרי ה-‎spacer‎
   * (הסינון, הכפתורים ו-⋯) עובר לקבוצה אחת, שנשברת לשורה משלה **כיחידה**
   * כשאין לה מקום — ולעולם לא באמצע (ראה ‎.head-actions‎ בגיליון).
   *
   * נעשה כאן ולא בכל כרטיס: הכרטיסים נבנים בכמה קבצים (תיבת ה-AI, האלפון),
   * וכולם כבר מסמנים את הגבול באותו ‎spacer‎. מה שלפניו הוא הכותרת.
   */
  function headActions(head) {
    const spacer = head.querySelector(':scope > .spacer');
    const actions = el('div.head-actions');
    if (spacer) {
      for (let n = spacer.nextSibling; n;) {
        const next = n.nextSibling;
        actions.appendChild(n);
        n = next;
      }
      spacer.remove();
    }
    if (!actions.childElementCount) actions.classList.add('only-tools');
    for (const child of head.children) {
      if (child.tagName === 'H3' && !child.title) child.title = child.textContent.trim();
      else if (child.classList.contains('mute-sm')) {
        child.classList.add('head-sub');
        if (!child.title) child.title = child.textContent.trim();
      }
    }
    head.appendChild(actions);
    return actions;
  }

  /**
   * לוח החלונות — מקבל מפה של כרטיסים שנבנו. כרטיס שאין לו תוכן מחזיר
   * ‎null‎ ומדולג, וגם אינו מוצע ב"הוספת חלון". המיקום עצמו מחושב אחרי
   * ההרכבה (ראה layoutBoard), כי הוא תלוי ברוחב הלוח במסך.
   */
  function homeBoard(cards) {
    if (cards !== cardsRef) slotCache = new Map();
    cardsRef = cards;
    const hidden = hiddenKeys();
    const keys = CARD_ORDER.filter((k) => cards[k] && !hidden.has(k));
    /*
     * ‎role=list‎: לקורא מסך הלוח הוא רשימה של חלונות. ההוראות למקלדת
     * יושבות פעם אחת בטקסט נסתר, וכל כותרת מפנה אליהן.
     */
    const board = el('div.home-board', { role: 'list', 'aria-label': 'חלונות דף הבית' },
      keys.map((k) => {
        if (!slotCache.has(k)) slotCache.set(k, slotFor(k, cards[k]));
        return slotCache.get(k);
      }));
    phRef = el('div.home-ph', { hidden: true, 'aria-hidden': 'true' });
    board.appendChild(phRef);
    liveRef = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    boardRef = board;
    items = keys.map((key) => ({ key, x: 0, y: 0, w: 1, h: 1 }));
    if (boardWatcher) { boardWatcher.disconnect(); boardWatcher.observe(board); }
    const wrap = el('div.home-board-wrap', {}, [
      el('p.sr-only', {
        id: 'home-board-help',
        text: 'גרירה מהכותרת מזיזה את החלון, ומשיכת הקצוות משנה את גודלו. במקלדת: Control וחצים להזזה, Shift וחצים לשינוי הגודל.'
      }),
      liveRef,
      board,
      keys.length ? null : emptyNote()
    ]);
    return wrap;
  }

  /** מיקום החלונות אחרי שהלוח במסמך — נקודת השבירה תלויה ברוחב שלו */
  function layoutBoard() {
    if (!boardRef?.isConnected) return;
    // בלי הנפשה בציור הראשון: החלונות לא "עפים" ממקום אפס למקומם
    boardRef.classList.add('is-static');
    relayout();
    void boardRef.offsetHeight;
    requestAnimationFrame(() => boardRef?.classList.remove('is-static'));
  }

  /*
   * מעבר בין 12 ל-6 עמודות כשהלוח משנה רוחב — גם בלי שגודל החלון השתנה:
   * קיפול תפריט הצד משנה את רוחב הלוח, ואירוע ‎resize‎ של החלון אינו נורה
   * אז כלל. רוחב בתוך אותה נקודת שבירה אינו דורש דבר — ה-CSS מחשב.
   */
  const boardWatcher = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (!boardRef?.isConnected || boardRef.classList.contains('is-arranging')) return;
        if (bpNow() !== bp) relayout();
      })
    : null;

  /*
   * Ctrl+Z מבטל את השינוי האחרון בלוח — רק כשהלוח על המסך, ולא מתוך שדה
   * טקסט (שם זה הביטול של ההקלדה) או מתחת לחלון קופץ.
   */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    if (!boardRef?.isConnected || !undoStack.length) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    undo();
  });

  /**
   * ‎silent‎ — טעינה מחדש ברקע: בלי ספינר, ותוך שמירת מיקום הגלילה. המסך
   * הקיים נשאר לנגד העיניים עד שהתוכן החדש מוכן, וכך עדכון משימה אינו נראה
   * כרענון של כל הדף.
   */
  async function render(container, { silent = false } = {}) {
    if (silent && boardRef?.isConnected && boardRef.classList.contains('is-arranging')) {
      reloadWaiting = true;
      return;
    }
    containerRef = container;
    const scrollTop = silent ? container.scrollTop : 0;
    // כניסה חדשה למסך מתחילה מדף נקי — המשימות שהושלמו בביקור הקודם כבר סגורות
    if (!silent) { keepCompleted.clear(); UI.mount(container, UI.spinner()); }
    // היסטוריית הביטול שייכת לביקור — מי שחוזר לדף מתחיל בלי ביטולים ישנים
    if (!silent) undoStack.length = 0;
    let data;
    let reports = null;
    let inbox = null;
    try {
      // החתך המחלקתי נשען על דוח הארגון. נטען במקביל, וכשל בו לא מפיל את הדשבורד.
      // כך גם "ממתין לאישורך" של עוזר ה-AI.
      [data, reports, inbox] = await Promise.all([
        API.home(),
        showsDepartmentCut() ? API.reports().catch(() => null) : Promise.resolve(null),
        App.isVendor() ? Promise.resolve(null) : AiInboxView.load().catch(() => null)
      ]);
    } catch (err) {
      // בטעינת רקע כשל רגעי לא ימחק את מה שכבר על המסך
      if (silent) return;
      return UI.mount(container, UI.empty(err.message, '⚠️'));
    }
    App.state.homeData = data;
    // הגרירה התחילה בזמן שהנתונים היו בדרך — הציור יחכה לסופה
    if (silent && boardRef?.isConnected && boardRef.classList.contains('is-arranging')) {
      reloadWaiting = true;
      return;
    }

    /**
     * זיכרון הביקור אינו נדרש עוד: משימה שהושלמה חוזרת מהשרת בכרטיס
     * "הושלמו לאחרונה", ולכן היא עוברת לשם במקום להישאר ברשימת הפתוחות עם
     * קו חוצה. הסימון עצמו נשאר מיידי — הקו מופיע לפני הטעינה מחדש.
     */

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';

    /*
     * הכרטיסים נבנים למפה ולא ישירות לעץ, כי המקום, הגודל וההסתרה שלהם
     * הם העדפה של המשתמש. כרטיס שאין לו תוכן מחזיר ‎null‎, ולוח החלונות מדלג
     * עליו — וגם אינו מציע להחזיר חלון שאין בו דבר.
     */
    const cards = {
      aiInbox: inbox ? AiInboxView.card(inbox, { reload }) : null,
      deptCut: reports ? departmentCutCard(reports.departments) : null,
      myTasks: myTasksCard(data.tasks.mine),
      calendar: calendarCard(data.weekAhead),
      department: departmentTasksCard(data.tasks.department ?? []),
      mentions: mentionsCard(data.mentions),
      done: doneCard(data.tasks.recentlyDone ?? [], data.archiveAfterDays ?? 3),
      approval: App.may('approve_vendor_output') || App.isVendor()
        ? approvalCard(data.tasks.awaitingApproval)
        : null,
      // פיד הארגון — למנהל המערכת בלבד. ‎null‎ גם מוציא אותו מרשימת "סידור הלוח"
      feed: App.may('view_activity_feed') ? feedCard(data.feed ?? []) : null
    };

    /*
     * "הוספת חלון" בכותרת הדף ולא בתוך הלוח: הוא נוגע בלוח כולו, ובמקום
     * הזה הוא נמצא גם כשכל החלונות הוסתרו. המספר עליו — כמה מוסתרים.
     */
    menuClose?.();
    addBtnRef = el('button.btn.btn-sm.home-add-btn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: () => addMenu(addBtnRef)
    }, [el('span.hab-plus', { 'aria-hidden': 'true', text: '＋' }), 'הוספת חלון']);

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          // ‎h1‎ — הכותרת הראשית של העמוד; עד כה לא הייתה לו כזו כלל
          el('h1', { text: `${greeting}, ${App.state.actor.name.split(' ')[0]}` }),
          /*
           * שורה אחת. ההוראות לסידור החלונות אינן כאן: הכותרת נראית כמו
           * ידית (סמן יד, פס גרירה בריחוף), והקצוות מגלים ידיות כשמתקרבים.
           */
          el('div.sub', { text: 'תמונת מצב אישית של העבודה שלך.' })
        ]),
        el('div.spacer'),
        addBtnRef
      ]),
      widgets(data.widgets),
      homeBoard(cards)
    );
    layoutBoard();
    refreshAddButton();
    ensureQuickTab();
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
  /**
   * 📅 — דחיית היעד ישר מהרשימה, בלי לפתוח את הכרטיס: להיום, למחר, לתחילת
   * השבוע או לתאריך אחר. כמו ב-Today. רק למי שרשאי לערוך, ורק למשימה פתוחה.
   */
  function moveDueButton(task) {
    if (!task.canEdit || task.isFinal) return null;
    return el('button.tk-move', {
      type: 'button',
      title: 'דחיית היעד — להיום או לתאריך אחר',
      'aria-label': `דחיית היעד: ${task.title}`,
      onclick: (e) => {
        e.stopPropagation();
        const pick = UI.pickDueDate(`יעד חדש: ${task.title}`, {
          workDays: App.state.actor.workDays,
          onPick: async (date) => {
            try {
              await API.updateTask(task.id, { dueDate: UI.fromInputDate(date) });
              UI.success(date === pick.today ? 'היעד הועבר להיום' : `היעד הועבר ל${pick.label(date)}`);
              reload();
            } catch (err) { UI.error(err); }
          }
        });
      }
    }, [UI.lineIcon('calendar')]);
  }

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
        moveDueButton(task),
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
      // הגובה של החלון נגזר מהתוכן כל עוד לא נקבע ביד — ראה ‎home:content‎
      toggle.dispatchEvent(new CustomEvent('home:content', { bubbles: true }));
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
            el('b', { style: { color: d.isToday ? 'var(--brand-ink)' : 'inherit' },
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
    automation: 'אוטומציה',
    ai_created: 'פתח/ה משימת AI',
    ai_sent: 'שלח',
    ai_inbound: 'קלט תשובה',
    ai_stalled: 'עצר את המעקב',
    ai_paused: 'השהה/תה מעקב AI',
    ai_resumed: 'חידש/ה מעקב AI',
    ai_nudge: 'ביקש/ה תזכורת',
    ai_stopped: 'הפסיק/ה מעקב AI',
    ai_completed: 'סימן/ה שהתקבל',
    ai_updated: 'עדכן/ה פרטי מעקב',
    tiful360: 'עדכן/ה'
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
          el('span', { style: { color: 'var(--brand-ink)' }, text: f.taskTitle })
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
          : UI.empty('אין עדכונים אחרונים בארגון', '📰')
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
        el('span', { text: '@', style: { fontWeight: '800', color: 'var(--brand-ink)' } }),
        el('h3', { text: 'תויגת בהודעות' }),
        el('div.spacer'),
        el('span.mute-sm', { text: countLabel(mentions.length, 'הודעה אחת', 'הודעות') })
      ]),
      el('div.card-pad', {}, [scrollBox(mentions.map(row))])
    ]);
  }

  // ------------------------------------------------- פתיחת משימה מהירה

  /*
   * באנר צף בשפה השמאלית של המסך, לפתיחת משימה בלי לעבור מסך ובלי הדיאלוג
   * המלא. חמישה שדות בלבד — נושא, פרויקט, אחראי, תאריך יעד וקבצים — כי זה
   * מה שנדרש כדי לרשום משימה לפני ששוכחים אותה; השאר נערך אחר כך בכרטיס.
   *
   * יושב על ‎document.body‎ ולא בתוך מסך הבית, וזה מכוון: דף הבית נבנה מחדש
   * בכל רענון רקע — אחרי כל שינוי במשימה — וטופס שיושב בתוכו היה נמחק תחת
   * ידיו של הכותב באמצע ההקלדה.
   */
  let quickPanel = null;   // הטופס הפתוח, אם יש
  let quickTab = null;     // הלשונית הצפה

  function closeQuick({ all = false } = {}) {
    quickPanel?.remove();
    quickPanel = null;
    quickTab?.classList.remove('is-open');
    if (all) { quickTab?.remove(); quickTab = null; }
  }

  function quickForm() {
    const titleInput = el('input', { type: 'text', placeholder: 'מה צריך לעשות?' });

    /*
     * אותו בורר של הדיאלוג המלא: חיפוש ודירוג לפי כמה עובדים בכל פרויקט.
     * פרויקטים שהושלמו אינם מוצעים — אין טעם לפתוח בהם משימה חדשה.
     */
    const projectPicker = UI.projectPicker({
      projects: App.state.projects.filter((p) => p.status !== 'done' && p.canAddTask)
    });

    // אותה רשימה מקובצת של הדיאלוג — חברי המחלקה בראש
    const userOption = (u) => ({
      value: `user:${u.id}`,
      label: u.roleLabel ? `${u.name} — ${u.roleLabel}` : u.name
    });
    const { near, far, deptName } = UI.usersByDepartment();
    const vendorOptions = App.may('assign_task_to_vendor')
      ? App.state.vendors.filter((v) => v.status === 'active')
        .map((v) => ({ value: `vendor:${v.id}`, label: `${v.name} (ספק חיצוני)` }))
      : [];
    const assigneeOptions = [
      { value: '', label: 'ללא אחראי' },
      ...(near.length && far.length
        ? [{ label: deptName, options: near.map(userOption) },
           { label: 'שאר הארגון', options: far.map(userOption) }]
        : [...near, ...far].map(userOption)),
      ...(vendorOptions.length ? [{ label: 'ספקים חיצוניים', options: vendorOptions }] : [])
    ];
    const assigneeSelect = UI.select(assigneeOptions, `user:${App.state.actor.id}`);  // ברירת מחדל: אני, כמו בדיאלוג המלא
    // עיגולים, כמו בדיאלוג המלא — הראשון ונבחר: מי שאני הכי הרבה מטיל עליו
    const assigneePicker = AssigneePicker.create({ select: assigneeSelect, options: assigneeOptions, autoPick: true, max: 4 });

    const dueInput = el('input', { type: 'date' });

    /*
     * קבצים. השרת מקבל צירוף רק למשימה קיימת, ולכן הם נאספים כאן ונשלחים
     * אחרי היצירה. הגודל נבדק עוד לפני: אחרת המשימה כבר נוצרה, ההעלאה
     * נכשלת, והמשתמש נשאר עם משימה חלקית בלי להבין מה קרה.
     */
    let files = [];
    const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    const chips = el('div.file-chips');
    const drawChips = () => {
      UI.mount(chips, ...files.map((f, i) => el('span.file-chip', {}, [
        el('span', { text: UI.fileIcon(f.name) }),
        el('span.fc-name', { text: f.name, title: f.name }),
        el('span.mute-sm', { text: UI.fileSize(f.size) }),
        el('button.chip-x', {
          title: 'הסרה', 'aria-label': `הסרת ${f.name}`, onclick: () => { files.splice(i, 1); drawChips(); }
        }, [UI.lineIcon('x')])
      ])));
      chips.style.display = files.length ? 'flex' : 'none';
    };
    drawChips();

    const addFiles = (list) => {
      const maxMb = Number(App.state.settings?.maxUploadMb ?? 25);
      for (const f of list) {
        if (f.size > maxMb * 1024 * 1024) { UI.error(new Error(`"${f.name}" גדול מ-${maxMb}MB ולכן לא צורף`)); continue; }
        files.push(f);
      }
      drawChips();
    };
    fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

    const drop = el('div.qt-drop', { onclick: () => fileInput.click() },
      [el('span.mute-sm', { text: '📎 צירוף קבצים — לחיצה או גרירה' })]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    });

    const saveBtn = el('button.btn.btn-primary.btn-block', {}, ['שמירה']);
    const saveOpenBtn = el('button.btn.btn-block', { type: 'button' }, ['שמירה ופתיחה בהרחבה']);

    const submit = async ({ openAfter = false } = {}) => {
      const title = titleInput.value.trim();
      if (!title) { UI.toast('נדרשת כותרת למשימה', 'error'); titleInput.focus(); return; }
      const [aType, aId] = assigneeSelect.value ? assigneeSelect.value.split(':') : [null, null];

      saveBtn.disabled = true;
      saveOpenBtn.disabled = true;
      saveBtn.textContent = 'יוצר…';
      try {
        const payload = {
          title,
          projectId: projectPicker.value() || null,
          assigneeType: aType,
          assigneeId: aId ? Number(aId) : null,
          dueDate: UI.fromInputDate(dueInput.value)
        };
        // "יש כבר משימה דומה" במחלקה (פרק 11ב) — כמו בדיאלוג המלא
        const dup = await TaskSyncView.checkDuplicate(payload);
        if (!dup.proceed) {
          saveBtn.disabled = false;
          saveOpenBtn.disabled = false;
          saveBtn.textContent = 'שמירה';
          if (!dup.back) {
            closeQuick();
            await App.refreshView();
          }
          return;
        }
        if (dup.dupChecked) payload.dupChecked = dup.dupChecked;
        const created = await API.createTask(payload);
        const id = created?.task?.id;

        /*
         * הקבצים נשלחים אחרי היצירה, וכישלון בהם אינו מבטל את המשימה —
         * היא כבר קיימת. לכן נאמר במדויק מה לא עלה, במקום הודעת הצלחה
         * גורפת שמשאירה את המשתמש בטוח שהקובץ מצורף.
         */
        const failed = [];
        for (const f of files) {
          try {
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('הקובץ לא נקרא'));
              reader.readAsDataURL(f);
            });
            await API.upload(id, f.name, f.type, data);
          } catch { failed.push(f.name); }
        }

        closeQuick();
        AssigneePicker.refresh();
        const sent = files.length - failed.length;
        if (failed.length) {
          UI.toast(`המשימה נוצרה, אך ${failed.length === 1 ? `הקובץ "${failed[0]}" לא צורף` : `${failed.length} קבצים לא צורפו: ${failed.join(', ')}`}`, 'error');
        } else if (!openAfter) {
          UI.taskCreated(created?.task, { prefix: sent ? `המשימה נוצרה עם ${countLabel(sent, 'קובץ אחד', 'קבצים')}` : 'המשימה נוצרה' });
        }
        await App.reloadReference();
        await App.refreshView();
        App.refreshNotifications();
        if (openAfter && id) TaskCardView.open(id);
      } catch (err) {
        saveBtn.disabled = false;
        saveOpenBtn.disabled = false;
        saveBtn.textContent = 'שמירה';
        UI.error(err);
      }
    };

    saveBtn.addEventListener('click', () => submit());
    saveOpenBtn.addEventListener('click', () => submit({ openAfter: true }));
    // Enter בשורת הנושא שולח — זה טופס של שדה אחד חובה, ומי שהקליד נושא סיים
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    return el('div.qt-panel', { role: 'dialog', 'aria-label': 'פתיחת משימה מהירה' }, [
      el('div.qt-head', {}, [
        el('b', { text: 'משימה מהירה' }),
        el('div.spacer'),
        el('button.chip-x', { title: 'סגירה', 'aria-label': 'סגירה', onclick: () => closeQuick() }, [UI.lineIcon('x')])
      ]),
      el('div.qt-body', {}, [
        UI.field('נושא', titleInput),
        UI.field('שם פרויקט', projectPicker),
        UI.field('אחראי', assigneePicker.node),
        UI.field('תאריך יעד', dueInput),
        // בורר הקבצים חייב להיות במסמך — לחיצה על ‎input‎ מנותק אינה פותחת
        // את חלון הבחירה בכל הדפדפנים
        fileInput,
        drop,
        chips,
        saveBtn,
        saveOpenBtn
      ])
    ]);
  }

  function toggleQuick() {
    if (quickPanel) return closeQuick();
    quickPanel = quickForm();
    document.body.appendChild(quickPanel);
    quickTab?.classList.add('is-open');
    quickPanel.querySelector('input')?.focus();
  }

  /**
   * הלשונית נבנית פעם אחת ושורדת את רענוני הרקע של דף הבית. היא נבנית רק
   * כאן, ולכן אינה מופיעה במסכים אחרים — הפתיחה המהירה היא חלק מהדשבורד.
   */
  function ensureQuickTab() {
    // אותו תנאי בדיוק של "＋ משימה חדשה" בכל שאר המסכים — מי שאינו רשאי
    // לפתוח משימה לא יראה כאן קיצור דרך שייכשל ב-403
    if (!App.may('create_task') || App.isVendor()) return;
    if (quickTab?.isConnected) return;
    /*
     * אייקון בלבד, והפלוס עצמו מצויר ב-CSS בשני פסים — ראה ‎.qt-tab::before‎.
     * השם נשאר ב-‎aria-label‎ וב-‎title‎: אייקון בלי שם נגיש הוא כפתור אילם
     * לקורא מסך, וסימן פלוס לבדו אינו אומר במה מדובר.
     */
    quickTab = el('button.qt-tab', {
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-label': 'פתיחת משימה מהירה',
      title: 'פתיחת משימה מהירה',
      onclick: toggleQuick
    });
    document.body.appendChild(quickTab);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && quickPanel) { e.preventDefault(); closeQuick(); }
    });
  }

  return { render, reload, closeQuick };
})();
