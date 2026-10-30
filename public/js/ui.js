'use strict';
/** עזרי ממשק משותפים: בניית DOM, פורמט תאריכים, תגיות, מודלים והודעות. */

const UI = (() => {
  /** יצירת אלמנט: el('div.card#main', {onclick}, [children]) — המזהה והמחלקות בכל סדר */
  function el(spec, props = {}, children = []) {
    const raw = String(spec);
    const idMatch = raw.match(/#([^.#]+)/);
    const id = idMatch ? idMatch[1] : null;
    const [tag, ...classes] = raw.replace(/#[^.#]+/, '').split('.');
    const node = document.createElement(tag || 'div');
    if (id) node.id = id;
    if (classes.length) node.className = classes.filter(Boolean).join(' ');

    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }

    for (const child of [children].flat(4)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  const mount = (node, ...children) => { clear(node); children.flat(4).filter(Boolean).forEach((c) => node.appendChild(c)); return node; };

  // --- תאריכים ---

  const pad = (n) => String(n).padStart(2, '0');

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relative(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.round(diff / 60000);
    if (min < 1) return 'ממש עכשיו';
    if (min < 60) return `לפני ${min} דק׳`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `לפני ${hours} שע׳`;
    const days = Math.round(hours / 24);
    if (days < 7) return `לפני ${days} ימים`;
    return formatDate(iso);
  }

  /**
   * ניסוח קריא של מרחק לתאריך יעד.
   *
   * ההפרש נמדד בימי לוח ולא בזמן שחלף. חישוב לפי זמן שחלף הזיז את כל
   * התוויות ביום שלם: משימה שיעדה היום נמצאת שבר-יום מעכשיו, ועיגול השבר
   * למעלה הציג אותה כ"מחר" — ומכאן נראה כאילו המערכת מקדימה את התאריך ביום.
   * Math.round ולא floor, כדי שמעבר שעון קיץ (יום של 23 או 25 שעות) לא יסיט.
   */
  function dueLabel(iso) {
    if (!iso) return { text: 'ללא תאריך יעד', tone: 'mute' };

    const due = new Date(iso);
    due.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((due - today) / 86400000);

    if (days < 0) {
      const late = Math.abs(days);
      return { text: late === 1 ? 'באיחור יום' : `באיחור ${late} ימים`, tone: 'danger' };
    }
    if (days === 0) return { text: 'היעד היום', tone: 'warn' };
    if (days === 1) return { text: 'היעד מחר', tone: 'warn' };
    if (days <= 7) return { text: `בעוד ${days} ימים`, tone: 'normal' };
    return { text: formatDate(iso), tone: 'mute' };
  }

  /**
   * תאריך לשדה קלט. מקזזים את היסט אזור הזמן לפני החיתוך, כי toISOString
   * מחזיר UTC: תאריך יעד בשעה מאוחרת היה נחתך ליום הקודם ושדה העריכה היה
   * מציג יום אחד אחורה ממה שמוצג בכל שאר המערכת.
   */
  const toInputDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const fromInputDate = (value) => {
    if (!value) return null;
    const d = new Date(`${value}T17:00:00`);
    return d.toISOString();
  };

  const initials = (name) =>
    String(name ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

  function avatar(name, opts = {}) {
    return el(`div.avatar${opts.small ? '.sm' : ''}${opts.vendor ? '.vendor' : ''}`, { title: name ?? '' }, [initials(name)]);
  }

  // --- תגיות ---

  const priorityTag = (task) => el(`span.tag.tag-${task.priority}`, {}, [task.priorityLabel]);

  function statusTag(task) {
    return el('span.tag.tag-status', { style: { background: task.statusColor } }, [task.statusLabel]);
  }

  /**
   * הבחנה חזותית ברורה בין 'דחוף' (עדיפות) לבין 'באיחור' (חריגת זמן בפועל).
   * אלו שני מצבים שונים ולכן שתי תגיות שונות שיכולות להופיע יחד.
   */
  function taskTags(task) {
    const tags = [];
    if (task.overdue) tags.push(el('span.tag.tag-overdue', {}, [icon('overdue'), 'באיחור']));
    if (task.priority === 'urgent') tags.push(el('span.tag.tag-urgent', {}, [icon('urgent'), 'דחוף']));
    else if (task.priority === 'high') tags.push(el('span.tag.tag-high', {}, ['גבוהה']));
    if (task.escalated) tags.push(el('span.tag.tag-escalated', {}, [icon('urgent'), 'הוקפצה']));
    if (task.scheduled) tags.push(el('span.tag.tag-scheduled', {}, ['🗓 מתוזמנת']));
    if (task.meetingPending) tags.push(el('span.tag.tag-meeting', { title: 'מחכה שתיקבע לה פגישה' }, ['📅 פגישה לקביעה']));
    if (task.isRecurring) tags.push(el('span.tag.tag-recurring', {}, ['⟳ חוזרת']));
    if (task.dependency?.blocking) tags.push(el('span.tag.tag-high', {}, ['🔗 חסומה']));
    // משימת AI — מצב המעקב, ובראש ובראשונה "ממתין לאישורך"
    if (task.ai) {
      const waiting = task.ai.pending || task.ai.state === 'needs_user';
      tags.push(el(`span.tag.tag-ai${waiting ? '.tag-ai-attn' : ''}`, { title: 'משימת AI' },
        [`✨ ${task.ai.pending ? 'ממתין לאישורך' : task.ai.stateLabel}`]));
    }
    return tags;
  }

  // --- שכבות: מודל, מגירה ופאנל צד ---

  const modalRoot = () => document.getElementById('modal-root');

  /*
   * אותו רף כמו ‎PHONE_QUERY‎ שב-app.js וכמו mobile.css. נקרא כאן בנפרד ולא
   * דרך ‎App.isPhone‎, כי ui.js נטען לפני app.js ומשמש גם את מסך הכניסה.
   */
  const PHONE_MQ = window.matchMedia('(max-width: 820px)');
  const REDUCED_MQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LAYER_Z = 100; // ‎.modal-backdrop‎ — מעל המגירה הצדדית (60) והניווט התחתון (50)

  /**
   * ערימת השכבות הפתוחות — מודל, מגירה תחתונה ופאנל צד — מהתחתונה לעליונה.
   *
   * ערימה אחת ולא מאזין לכל חלון: עד כה כל מודל רשם Escape משלו על המסמך,
   * ולכן Escape באישור מחיקה שנפתח מתוך כרטיס משימה סגר את *שניהם*. כאן רק
   * העליונה מגיבה — ל-Escape, ללכידת Tab — והיא גם זו שמקבלת את ה-z-index
   * הגבוה, כך שאישור שנפתח מתוך מגירה יושב תמיד מעליה ולא מתחתיה.
   *
   * ‎node‎ הוא מה שנוסף למסמך (הרקע), ‎box‎ הוא החלון שבתוכו נלכד המיקוד.
   */
  const layers = [];
  let scrollLockSaved = null;

  /*
   * שכבה שהצומת שלה נעלם מהמסמך בלי שעברה ב-‎close()‎. זה קורה בפועל:
   * כפתורי "סגירה" במסכי הניהול וב-tracker.js מסירים את ‎.modal-backdrop‎
   * ישירות. בלי הניקוי הזה השכבה המתה הייתה נשארת בראש הערימה, בולעת את
   * Escape ומשאירה את גלילת הדף נעולה לתמיד.
   */
  function pruneLayers() {
    for (let i = layers.length - 1; i >= 0; i--) {
      if (!layers[i].node.isConnected) layers.splice(i, 1)[0].release();
    }
    syncLayers();
  }

  /** ‎z-index‎ לפי הסדר בערימה, ונעילת גלילת הדף כל עוד יש שכבה חוסמת */
  function syncLayers() {
    layers.forEach((l, i) => { l.node.style.zIndex = String(LAYER_Z + i * 2); });
    const lock = layers.some((l) => l.lock);
    if (lock && scrollLockSaved === null) {
      scrollLockSaved = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } else if (!lock && scrollLockSaved !== null) {
      document.body.style.overflow = scrollLockSaved;
      scrollLockSaved = null;
    }
  }

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), '
    + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), audio[controls], iframe, [contenteditable="true"]';

  // ‎getClientRects‎ ולא ‎offsetParent‎: האחרון הוא ‎null‎ גם לצומת ‎fixed‎ שנראה לגמרי
  const focusablesIn = (box) => [...box.querySelectorAll(FOCUSABLE)]
    .filter((n) => n.getClientRects().length && !n.closest('[inert]'));

  /**
   * רישום שכבה. ‎opts.trap‎ — לכידת Tab בתוכה (בכל שכבה חוסמת), ‎opts.lock‎ —
   * נעילת גלילת הדף. מחזיר ‎release()‎ שמוציא אותה מהערימה ומחזיר את המיקוד.
   */
  function pushLayer({ node, box, close, trap = true, lock = true, side = false }) {
    const opener = document.activeElement;
    let released = false;
    const layer = {
      node, box, close, trap, lock, side,
      release() {
        if (released) return;
        released = true;
        const i = layers.indexOf(layer);
        if (i >= 0) layers.splice(i, 1);
        syncLayers();
        /*
         * המיקוד חוזר למה שפתח את השכבה — אבל רק אם הוא עדיין בתוכה או
         * שאבד לגמרי. מי שסגר פאנל צד בלחיצה על שדה אחר ברשימה ביקש את
         * השדה ההוא, והחזרת המיקוד לשורה הקודמת הייתה גוזלת אותו ממנו.
         */
        const now = document.activeElement;
        const lost = !now || now === document.body || !now.isConnected || box.contains(now);
        if (lost && opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      }
    };
    layers.push(layer);
    syncLayers();
    return layer;
  }

  function onLayerKey(e) {
    if (!layers.length) return;
    pruneLayers();
    const top = layers.at(-1);
    if (!top) return;
    if (e.key === 'Escape') {
      // מי שכבר טיפל ב-Escape בתוך החלון (רשימת התיוג, עריכה במקום) — הוא קובע
      if (e.defaultPrevented) return;
      e.preventDefault();
      top.close();
      return;
    }
    if (e.key !== 'Tab' || !top.trap) return;
    const list = focusablesIn(top.box);
    if (!list.length) { e.preventDefault(); top.box.focus(); return; }
    const first = list[0];
    const last = list.at(-1);
    const at = document.activeElement;
    // מיקוד שברח החוצה (לחיצה על הרקע, למשל) חוזר פנימה בהקשה הבאה
    if (!top.box.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && (at === first || at === top.box)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onLayerKey);

  /*
   * מעקב אחרי הסרה ישירה של צמתים — ראה ‎pruneLayers‎. ‎MutationObserver‎ ולא
   * בדיקה בהקשה הבאה בלבד: נעילת הגלילה צריכה להשתחרר מיד, לא כשמישהו מקיש.
   */
  const layerHost = modalRoot();
  if (layerHost) new MutationObserver(() => { if (layers.length) pruneLayers(); }).observe(layerHost, { childList: true });

  /** השכבות הפתוחות, מהתחתונה לעליונה — לקיצורי מקלדת שצריכים לדעת אם הם מתחת לחלון */
  const openLayers = () => { pruneLayers(); return layers.map((l) => ({ side: l.side, close: l.close })); };

  let dialogSeq = 0;

  /**
   * חלון. ‎side‎ — פאנל בגובה המסך שנצמד לקצה ה-inline-end (שמאל, בעברית),
   * ולא חלון במרכז: הרשימה נשארת גלויה מימין ולחיצה על שורה אחרת בה מחליפה
   * את התוכן. בטלפון ‎side‎ מתעלם — שם כל חלון ממילא תופס את המסך.
   *
   * ‎autofocus‎ — מיקוד השדה הראשון, כפי שהיה תמיד. כבוי — המיקוד עובר לחלון
   * עצמו, וכך קורא מסך ו-Tab נכנסים פנימה בלי לפתוח מקלדת בנייד ובלי
   * לסמן שדה שהמשתמש לא התכוון לערוך.
   *
   * ‎label‎ — שם נגיש לחלון שאין לו כותרת (‎title: null‎).
   * ‎ignoreOutside(e)‎ — בפאנל צד בלבד: לחיצה מחוץ לו שאין לסגור בגללה.
   */
  function modal({ title, body, footer, size = '', onClose, side = false, autofocus = true, label = null, ignoreOutside = null }) {
    const root = modalRoot();
    const asSide = side && !PHONE_MQ.matches;
    let closed = false;
    let layer = null;

    const finish = () => {
      document.removeEventListener('click', onOutside, true);
      layer?.release();
      if (onClose) onClose();
    };
    const close = () => {
      if (closed) return; // רקע, ‎✕‎, Escape ו-‎remove‎ חיצוני — הראשון קובע
      closed = true;
      if (asSide && !REDUCED_MQ.matches && backdrop.isConnected) {
        // הפאנל גולש החוצה לפני ההסרה; המיקוד והערימה משתחררים כבר עכשיו
        backdrop.classList.add('leaving');
        setTimeout(() => backdrop.remove(), 180);
      } else {
        backdrop.remove();
      }
      finish();
    };

    const titleId = `dlg-title-${++dialogSeq}`;
    const box = el(`div.modal${size ? `.${size}` : ''}${asSide ? '.is-side' : ''}`, {
      role: 'dialog',
      'aria-modal': asSide ? 'false' : 'true',
      'aria-labelledby': title === null ? null : titleId,
      'aria-label': title === null ? (label ?? null) : null,
      tabindex: '-1'
    }, [
      title === null ? null : el('div.modal-head', {}, [
        el(`h3#${titleId}`, { text: title ?? '' }),
        el('button.icon-btn', { onclick: close, title: 'סגירה', 'aria-label': 'סגירה' }, ['✕'])
      ]),
      body instanceof Node && body.classList?.contains('task-detail') ? body : el('div.modal-body', {}, [body]),
      footer ? el('div.modal-foot', {}, footer) : null
    ]);

    const backdrop = el(`div.modal-backdrop${asSide ? '.is-side' : ''}`, {
      onclick: (e) => { if (e.target === backdrop) close(); }
    }, [box]);

    /*
     * פאנל הצד אינו חוסם את הדף: הרקע שלו שקוף ללחיצות, כדי שאפשר יהיה
     * לבחור משימה אחרת ברשימה בלי לסגור קודם. לחיצה בכל מקום אחר מחוצה לו
     * סוגרת אותו, כמו רקע של מודל — אלא אם היא פתחה בעצמה תוכן חדש לפאנל
     * (‎ignoreOutside‎), ואז התוכן מתחלף במקום להיסגר ולהיפתח מחדש.
     *
     * בשלב הלכידה ובהשהיה: הבדיקה רצה אחרי מטפלי השורה עצמה, כך ש-‎ignoreOutside‎
     * כבר יודע אם הלחיצה הזו פתחה משימה.
     */
    const onOutside = (e) => {
      if (closed || box.contains(e.target)) return;
      // שכבה אחרת מעליו (אישור, תצוגה מקדימה), טוסט או הקפצה — אינם "בחוץ"
      if (e.target.closest?.('#modal-root > *:not(.is-side), .m-sheet-veil, .toast-root, .notif-pop-root')) return;
      setTimeout(() => { if (!closed && !ignoreOutside?.(e)) close(); }, 0);
    };

    root.appendChild(backdrop);
    layer = pushLayer({ node: backdrop, box, close, trap: !asSide, lock: !asSide, side: asSide });
    if (asSide) setTimeout(() => { if (!closed) document.addEventListener('click', onOutside, true); }, 0);

    const firstInput = autofocus ? box.querySelector('input, textarea, select') : null;
    setTimeout(() => {
      if (closed) return;
      if (firstInput) firstInput.focus();
      // בלי שדה — לפחות החלון עצמו, כדי ש-Tab ו-Escape יפעלו מתוכו
      else if (!box.contains(document.activeElement)) box.focus({ preventScroll: true });
    }, 40);
    return { close, box, backdrop };
  }

  // --- מגירה תחתונה ---

  /**
   * מגירה תחתונה בטלפון — מעטפת אחת לכל המגירות במערכת (סינון, פעולות
   * פרויקט, התראות), על המבנה ‎m-sheet-veil / m-sheet / m-grab‎ שכבר היה.
   * במחשב היא נופלת ל-‎modal()‎, וכך הקורא אינו צריך לבדוק באיזו פריסה הוא.
   *
   * ‎snap‎ — נקודות עצירה כחלק מגובה החלון. המגירה בגובה התוכן, עד הגבוהה
   * שבהן; נפתחת בראשונה, וגרירה למעלה מרחיבה. מגירה שהתוכן שלה קצר מנקודת
   * העצירה פשוט נפתחת במלואה — אין טעם בחצי מגירה ריקה.
   *
   * גרירה: מהידית ומהכותרת תמיד; מהגוף רק כשהוא בראש הגלילה — כלפי מטה
   * (סגירה), או כלפי מעלה כשהמגירה עוד לא בגובה המלא. אחרת זו גלילה רגילה.
   * בשחרור: סגירה אם נגררה מעל רבע מגובהה או בתנופה (מעל ‎0.5‎ פיקסל
   * למילישנייה), ואחרת היצמדות לנקודת העצירה הקרובה.
   *
   * מחזירה ‎{ close, node }‎ — ‎node‎ הוא המגירה עצמה (או החלון, במחשב).
   */
  const SHEET_DISMISS_RATIO = 0.25;
  const SHEET_FLING = 0.5;          // פיקסלים למילישנייה
  const SHEET_MS = 240;

  function sheet({ title, body, footer, snap = [0.5, 0.9], onClose, className = '', label = null } = {}) {
    if (!PHONE_MQ.matches) {
      const m = modal({ title: title ?? null, body, footer, onClose, label: label ?? title ?? null });
      return { close: m.close, node: m.box };
    }

    let closed = false;
    let layer = null;
    const points = [...snap].filter((s) => s > 0 && s <= 1).sort((a, b) => a - b);
    if (!points.length) points.push(0.9);
    const titleId = `dlg-title-${++dialogSeq}`;

    const grab = el('div.m-grab', { 'aria-hidden': 'true' });
    const head = title ? el('div.m-sheet-head', {}, [el(`h3#${titleId}`, { text: title })]) : null;
    const bodyBox = el('div.m-sheet-body', {}, [body]);
    const panel = el(`div.m-sheet.ui-sheet${className ? `.${className}` : ''}`, {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': head ? titleId : null,
      'aria-label': head ? null : (label ?? null),
      tabindex: '-1'
    }, [
      grab, head, bodyBox,
      footer ? el('div.m-sheet-foot', {}, footer) : null
    ]);
    const veil = el('div.m-sheet-veil.ui-sheet-veil', {}, [panel]);

    // גובה המגירה ונקודות העצירה בפיקסלים — מחושבים מחדש בכל פתיחה ושינוי גודל
    let height = 0;
    let offsets = [0];   // היסט כלפי מטה לכל נקודת עצירה; 0 = פתוחה במלואה
    let offset = 0;

    const measure = () => {
      const vh = window.innerHeight;
      panel.style.maxHeight = `${Math.round(points.at(-1) * vh)}px`;
      height = panel.offsetHeight;
      offsets = [...new Set(points.map((s) => Math.max(0, Math.round(height - s * vh))))].sort((a, b) => b - a);
    };

    const place = (y, animate) => {
      offset = y;
      panel.style.transition = animate && !REDUCED_MQ.matches
        ? `transform ${SHEET_MS}ms cubic-bezier(.2, .8, .2, 1)` : 'none';
      panel.style.transform = `translateY(${y}px)`;
      // הרקע מתבהר ככל שהמגירה יורדת — רמז שעוד מעט היא תיסגר
      veil.style.setProperty('--veil', String(Math.max(0, 1 - y / Math.max(1, height))));
    };

    const close = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('resize', onResize);
      layer?.release();
      if (REDUCED_MQ.matches) veil.remove();
      else {
        veil.classList.add('leaving');
        place(height + 24, true);
        setTimeout(() => veil.remove(), SHEET_MS);
      }
      if (onClose) onClose();
    };

    const onResize = () => { if (!closed) { measure(); place(Math.min(offset, offsets[0]), false); } };

    // ---- גרירה ----
    let drag = null;        // { id, y0, from, body, active, samples }
    let swallowClick = false;

    const startDrag = (e, fromBody) => {
      if (closed || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, y0: e.clientY, from: offset, body: fromBody, active: !fromBody, samples: [[e.timeStamp, e.clientY]] };
      if (!fromBody) panel.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!drag.active) {
        if (Math.abs(dy) < 6) return;
        /*
         * גוף שאינו בראש הגלילה, או תנועה כלפי מעלה כשהמגירה כבר פתוחה
         * במלואה — זו גלילה של התוכן, והמגירה מניחה לה.
         */
        if (bodyBox.scrollTop > 0 || (dy < 0 && drag.from === 0)) { drag = null; return; }
        drag.active = true;
        drag.y0 = e.clientY;
        panel.setPointerCapture?.(e.pointerId);
      }
      const raw = drag.from + (e.clientY - drag.y0);
      // מעל הגובה המלא — התנגדות, ולא מגירה שמתנתקת מתחתית המסך
      place(raw < 0 ? raw * 0.2 : raw, false);
      drag.samples.push([e.timeStamp, e.clientY]);
      if (drag.samples.length > 6) drag.samples.shift();
    };

    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.active) return;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
      // מהירות לפי הדגימות האחרונות בלבד: עצירה לפני השחרור אינה תנופה
      const [t0, y0] = d.samples[0];
      const [t1, y1] = d.samples.at(-1);
      const v = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
      const moved = offset - d.from;
      if (e.type !== 'pointercancel' && (moved > height * SHEET_DISMISS_RATIO || v > SHEET_FLING)) return close();
      // תנופה כלפי מעלה מרחיבה לנקודה הבאה, גם אם הגרירה עצמה הייתה קצרה
      let target = offsets.reduce((best, o) => (Math.abs(o - offset) < Math.abs(best - offset) ? o : best), offsets[0]);
      if (v < -SHEET_FLING) target = offsets.find((o) => o < d.from) ?? 0;
      place(target, true);
    };

    for (const zone of [grab, head].filter(Boolean)) {
      zone.addEventListener('pointerdown', (e) => startDrag(e, false));
    }
    bodyBox.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') startDrag(e, true); });
    panel.addEventListener('pointermove', onMove);
    panel.addEventListener('pointerup', onUp);
    panel.addEventListener('pointercancel', onUp);
    /*
     * ‎touch-action: pan-y‎ על הגוף משאיר לדפדפן את הגלילה. כשהוחלט שזו
     * גרירה של המגירה, ‎preventDefault‎ על ‎touchmove‎ הוא מה שמונע מהגלילה
     * להתחיל — ולכן המאזין אינו פסיבי.
     */
    bodyBox.addEventListener('touchmove', (e) => { if (drag?.active && e.cancelable) e.preventDefault(); }, { passive: false });
    // סוף גרירה אינו לחיצה על הכפתור שבמקרה נמצא תחת האצבע
    panel.addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

    modalRoot().appendChild(veil);
    layer = pushLayer({ node: veil, box: panel, close });
    measure();
    place(height, false);                 // מתחת למסך —
    panel.getBoundingClientRect();        // — ונקודת ההתחלה נקבעת לפני המעבר
    place(Math.max(0, Math.round(height - points[0] * window.innerHeight)), true);
    // ההנפשה של ‎.m-sheet‎ מ-mobile.css כבויה כאן — התנועה בשליטת ‎place‎
    window.addEventListener('resize', onResize);

    /*
     * הנגיעה שפתחה את המגירה עדיין בעיצומה: הלחיצה המסונתזת שתגיע בשחרור
     * האצבע תנחת על הרקע שזה עתה נפרש תחתיה ותסגור אותו מיד. לכן הסוגר
     * מחובר רק אחרי שהמחווה הנוכחית הסתיימה.
     */
    setTimeout(() => {
      veil.addEventListener('click', (e) => { if (e.target === veil) close(); });
    }, 120);

    /*
     * המיקוד עובר למגירה עצמה ולא לפריט הראשון בה: טבעת מיקוד על הפריט
     * הראשון נקראת כאילו הוא כבר נבחר, וב-iOS מיקוד של שדה פותח מקלדת.
     * ‎preventScroll‎ — מיקוד לתוך צומת ‎fixed‎ בזמן שהאצבע עוד על המסך
     * מקפיץ את הגלילה בספארי.
     */
    panel.focus({ preventScroll: true });
    return { close, node: panel };
  }

  /**
   * ‎m.close()‎ מפעיל את ‎onClose‎, ולכן חייבים להכריע את התוצאה לפני הסגירה:
   * אחרת הביטול שב-onClose היה קודם לאישור, והבטחה מכבדת רק את ההכרעה הראשונה.
   * הדגל שומר על זה גם אם ייווסף בעתיד מסלול סגירה נוסף.
   */
  function settler(resolve) {
    let done = false;
    return (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
  }

  function confirm(message, { title = 'אישור פעולה', danger = false, okText = 'אישור' } = {}) {
    return new Promise((resolve) => {
      const finish = settler(resolve);
      const m = modal({
        title,
        body: el('p', { text: message, style: { margin: 0 } }),
        footer: [
          el(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`, {
            onclick: () => { finish(true); m.close(); }
          }, [okText]),
          el('button.btn', { onclick: () => { finish(false); m.close(); } }, ['ביטול'])
        ],
        onClose: () => finish(false)
      });
    });
  }

  function prompt(label, { title = 'הזנת ערך', value = '', multiline = false, okText = 'אישור', hint = null } = {}) {
    return new Promise((resolve) => {
      const finish = settler(resolve);
      const input = multiline
        ? el('textarea', { value })
        : el('input', { type: 'text', value });
      if (!multiline) input.value = value;
      const submit = () => { finish(input.value.trim() || null); m.close(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) submit(); });
      const m = modal({
        title,
        // ההסבר מתחת לשדה, כדי לומר מה בדיוק נשמר בלי להאריך את התווית
        body: el('div.field', {}, [
          el('label', { text: label }), input,
          hint ? el('div.hint', { text: hint }) : null
        ]),
        footer: [
          el('button.btn.btn-primary', { onclick: submit }, [okText]),
          el('button.btn', { onclick: () => { finish(null); m.close(); } }, ['ביטול'])
        ],
        onClose: () => finish(null)
      });
    });
  }

  // --- הודעות ---

  function toast(message, kind = '') {
    const node = el(`div.toast${kind ? `.${kind}` : ''}`, { text: message });
    document.getElementById('toast-root').appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s, transform .25s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 260);
    }, 3400);
  }

  const error = (err) => toast(err?.message ?? String(err), 'error');
  const success = (msg) => toast(msg, 'ok');

  /**
   * "המשימה נוצרה" עם לאן נכנסה וכפתור "פתיחה". יצירה רגילה כבר אינה
   * פותחת את הכרטיס המלא מעצמה — ולכן ההודעה אומרת אצל מי ובאיזה פרויקט
   * המשימה יושבת, כדי שלא "תיעלם", ומאפשרת לפתוח אותה בלחיצה.
   */
  function taskCreated(task, { prefix = 'המשימה נוצרה', extra = '' } = {}) {
    if (!task?.id) return success(prefix);
    const where = [
      task.assigneeName ? `אצל ${task.assigneeName}` : 'ללא אחראי',
      task.projectName || 'ללא פרויקט'
    ].join(' · ');
    const open = el('button.btn.btn-sm', {}, ['פתיחה']);
    const node = el('div.toast.ok.toast-action', {}, [
      el('div', {}, [el('b', { text: `✓ ${prefix}` }), ` — ${where}`, extra ? el('div.toast-warn', { text: extra }) : null]),
      el('div.toast-buttons', {}, [open])
    ]);
    const timer = setTimeout(() => node.remove(), 7000);
    open.addEventListener('click', () => { clearTimeout(timer); node.remove(); TaskCardView.open(task.id); });
    document.getElementById('toast-root').appendChild(node);
  }

  /**
   * הודעה עם "ביטול" — לפעולה שכבר נשמרה בשרת ואפשר להפוך אותה.
   *
   * הפעולה עצמה מתבצעת מיד, והביטול הוא קריאה הפוכה (‎onUndo‎) ולא השהיה של
   * השמירה: השהיה הייתה מאבדת את הפעולה אם הלשונית נסגרת בתוך שש השניות,
   * ומשאירה את שאר המשתמשים רואים מצב ישן. לכן גם אין כאן ‎onCommit‎ — אין
   * מה לשמור בסוף, יש רק מה להחזיר בדרך.
   *
   * הזמן נצבר בלולאת ‎requestAnimationFrame‎ ולא ב-‎setTimeout‎ אחד:
   *  - הוא נעצר כשהעכבר על ההודעה או כשהמיקוד בתוכה — מי שמכוון אל "ביטול"
   *    לא יאבד אותו ברגע האחרון;
   *  - כל פריים תורם לכל היותר ‎100‎ מילישניות. לשונית ברקע אינה מריצה
   *    פריימים, וחזרה אליה הייתה מגלה הפרש של דקות ומעלימה את ההודעה מיד —
   *    לפני שהמשתמש ראה שהיא שם.
   *
   * ביטול ופקיעה סוגרים זה את זה: הראשון קובע, והשני אינו עושה דבר. הודעה
   * חדשה מסיימת את הקודמת (הפעולה הקודמת נשארת כפי שהיא) — שני כפתורי
   * "ביטול" זה מעל זה אינם אומרים איזה מהם מבטל מה.
   *
   * מחזירה ‎{ node, undo, dismiss }‎.
   */
  const UNDO_FRAME_CAP = 100;
  const RING_R = 8;
  const RING_C = 2 * Math.PI * RING_R;
  let liveUndo = null;

  function undoToast(message, { onUndo, ms = 6000 } = {}) {
    // הקודמת יורדת מיד ולא בהנפשה — לרגע היו שני כפתורי "ביטול" על המסך
    const prev = liveUndo;
    if (prev) {
      prev.dismiss();
      prev.node.remove();
    }

    let settled = false;
    let elapsed = 0;
    let last = null;
    let raf = 0;
    let hovered = false;
    let focused = false;

    const ring = el('span.undo-ring', {
      'aria-hidden': 'true',
      html: `<svg viewBox="0 0 20 20" width="20" height="20"><circle class="ur-track" cx="10" cy="10" r="${RING_R}"/>`
        + `<circle class="ur-fill" cx="10" cy="10" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="0"/></svg>`
    });
    const fill = ring.querySelector('.ur-fill');
    const btn = el('button.toast-undo-btn', { type: 'button' }, ['ביטול']);
    const node = el('div.toast.toast-undo', { role: 'status', 'aria-live': 'polite' }, [
      ring,
      el('span.tu-text', { text: message }),
      btn
    ]);

    const leave = () => {
      cancelAnimationFrame(raf);
      if (liveUndo?.node === node) liveUndo = null;
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 220);
    };

    /** פקיעה או החלפה — הפעולה נשארת, ההודעה יורדת */
    const dismiss = () => {
      if (settled) return;
      settled = true;
      leave();
    };

    const undo = async () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      btn.disabled = true;
      try {
        await onUndo?.();
      } catch (err) {
        error(err);
      }
      leave();
    };

    const tick = (now) => {
      if (settled) return;
      if (last !== null && !hovered && !focused) elapsed += Math.min(now - last, UNDO_FRAME_CAP);
      last = now;
      // בהעדפת תנועה מופחתת הטבעת נשארת מלאה — השעון ממשיך לרוץ, רק לא נראה
      if (!REDUCED_MQ.matches) fill.setAttribute('stroke-dashoffset', String((RING_C * Math.min(1, elapsed / ms)).toFixed(2)));
      if (elapsed >= ms) return dismiss();
      raf = requestAnimationFrame(tick);
    };

    btn.addEventListener('click', undo);
    node.addEventListener('mouseenter', () => { hovered = true; });
    node.addEventListener('mouseleave', () => { hovered = false; });
    node.addEventListener('focusin', () => { focused = true; });
    node.addEventListener('focusout', (e) => { focused = node.contains(e.relatedTarget); });
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // לא לתת ל-Escape להמשיך ולסגור גם את החלון שמתחת להודעה
      e.preventDefault();
      e.stopPropagation();
      undo();
    });

    document.getElementById('toast-root').appendChild(node);
    raf = requestAnimationFrame(tick);
    liveUndo = { node, dismiss };
    return { node, undo, dismiss };
  }

  /**
   * הודעה על סטטוס שהשתנה מעצמו בעקבות הצ'קליסט.
   *
   * שינוי שהמערכת עשתה ולא המשתמש חייב להיאמר: אחרת המשימה נעלמת מהרשימה
   * הפתוחה והמשתמש אינו יודע למה. וכשהסגירה *לא* קרתה בגלל תלות במשימה
   * אחרת — זו בדיוק ההודעה שמונעת את "סימנתי הכול והמשימה עוד פתוחה".
   */
  function announceAutoStatus(autoStatus) {
    if (!autoStatus) return;
    if (autoStatus.changed === false) return toast(autoStatus.reason, 'error');
    toast(autoStatus.done
      ? `הצ׳קליסט הושלם — המשימה סומנה כ"${autoStatus.label}"`
      : `סעיף נפתח מחדש — המשימה חזרה ל"${autoStatus.label}"`,
    autoStatus.done ? 'ok' : '');
  }

  // --- הקפצת התראות ---

  /**
   * כרטיס התראה שמוקפץ בשפת המסך. זהו אח של toast ולא הרחבה שלו:
   * toast הוא שורת טקסט חולפת שמאשרת פעולה ("נשמר"), ואילו כאן יש מבנה
   * (כותב, תוכן, משימה), לחיצה שמובילה למשימה, השהיה כשהעכבר על הכרטיס
   * וכפתור סגירה. דחיסת כל אלה ל-toast הייתה מעמיסה חתימת אפשרויות על
   * פונקציה שנקראת מעשרות מקומות — ולכן שני מנגנונים, כל אחד פשוט לעצמו.
   */
  const POP_MAX = 3;      // יותר מזה מכסה את המסך במקום להודיע
  /*
   * חמש שניות. שלוש לא הספיקו לקרוא כותב, כותרת ושם משימה בכרטיס אחד —
   * ובמיוחד כשמגיעים שלושה כרטיסים יחד. השעון נעצר כשהעכבר על הכרטיס
   * ונדרך מחדש ביציאה, ולכן ההארכה אינה מאריכה את החשיפה למי שקרא וסיים.
   */
  const POP_MS = 5000;
  const POP_FADE_MS = 220; // חייב להתאים למשך המעבר של ‎.notif-pop.leaving‎

  /**
   * המכל נוצר בפעם הראשונה שצריך אותו — ‎index.html‎ מכיל רק את שורש הטוסטים.
   * ‎dir‎ נקבע במפורש כדי ש-‎inset-inline-end‎ שב-CSS יישאר השפה השמאלית
   * הפיזית של המסך, גם אם הכרטיס ייבנה בעתיד מתוך הקשר שאינו RTL.
   */
  function notifyPopRoot() {
    let node = document.getElementById('notif-pop-root');
    if (!node) {
      node = el('div.notif-pop-root#notif-pop-root', { dir: 'rtl' });
      document.body.appendChild(node);
    }
    return node;
  }

  // הכרטיסים שעל המסך כרגע, כדי שהפינוי יבטל גם את השעון של כל אחד מהם
  const livePops = [];

  /** סגירת כל הכרטיסים בבת אחת — למשל כשנפתחת מגירת ההתראות עצמה */
  function clearNotifyPops() {
    while (livePops.length) livePops.pop().kill();
    const node = document.getElementById('notif-pop-root');
    if (node) clear(node); // גם כרטיס שנמצא באמצע היעלמות אינו נשאר תלוי
  }

  /**
   * ‎author‎ מי כתב, ‎headline‎ מה קרה, ‎body‎ תוכן ההודעה, ‎task‎ שם המשימה.
   * ‎onOpen‎ — בלעדיו הכרטיס אינו נראה כניתן ללחיצה ואינו מגיב לה, כי התראה
   * שאינה קשורה למשימה אין לאן להוביל.
   */
  function notifyPop({ icon = '🔔', bg = '', color = '', author = '', headline = '', body = '', task = null, onOpen = null }) {
    let timer = null;
    let closing = false;

    const forget = () => {
      const i = livePops.findIndex((p) => p.card === card);
      if (i >= 0) livePops.splice(i, 1);
    };

    /** סגירה מיידית בלי הנפשה — לפינוי מרוכז ולפינוי מקום לכרטיס חדש */
    const kill = () => { closing = true; clearTimeout(timer); forget(); card.remove(); };

    const dismiss = () => {
      if (closing) return; // גם לחיצה וגם השעון מסיימים את הכרטיס — הראשון קובע
      closing = true;
      clearTimeout(timer);
      forget();
      card.classList.add('leaving');
      setTimeout(() => card.remove(), POP_FADE_MS);
    };

    /**
     * ‎closing‎ נבדק גם כאן: מי שמזיז את העכבר מהכרטיס בזמן ההיעלמות מפעיל
     * ‎mouseleave‎ על כרטיס שגמר את דרכו, ובלי הבדיקה היה נשאר שעון תלוי אחריו.
     */
    const arm = () => {
      if (closing) return;
      clearTimeout(timer);
      timer = setTimeout(dismiss, POP_MS);
    };

    const card = el(`div.notif-pop${onOpen ? '.is-linked' : ''}`, { role: 'status' }, [
      // ‎icon‎ הוא או צומת (מסכת אייקון) או טקסט — שני המצבים מטופלים כאן
      el('div.pop-icon', {
        style: { background: bg || 'var(--surface-2)', color: color || 'var(--text-soft)' }
      }, [icon]),
      el('div.pop-text', {}, [
        author ? el('div.pop-who', { text: author }) : null,
        headline ? el('div.pop-headline', { text: headline }) : null,
        body ? el('div.pop-msg', { text: body }) : null,
        task ? el('div.pop-task', { text: `📋 ${task}` }) : null
      ]),
      el('button.pop-x', {
        type: 'button',
        title: 'סגירה',
        onclick: (e) => { e.stopPropagation(); dismiss(); } // אחרת הסגירה הייתה גם פותחת את המשימה
      }, ['✕'])
    ]);

    // קריאה לוקחת זמן: כרטיס שנעלם תוך כדי קריאה גרוע מכרטיס שלא הוקפץ כלל
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', arm);
    if (onOpen) card.addEventListener('click', () => { dismiss(); onOpen(); });

    // נוסף בתחתית הערימה: כך כרטיס שהמשתמש קורא בו אינו נדחף ממקומו
    notifyPopRoot().appendChild(card);

    // הישן ביותר מתפנה מיד ולא בהנפשה: המתנה להיעלמותו הייתה מותירה את
    // הערימה מעל התקרה בדיוק ברגע שבו מגיעות התראות בזו אחר זו
    livePops.push({ card, kill });
    while (livePops.length > POP_MAX) livePops.shift().kill();
    arm();

    return { card, dismiss };
  }

  // ‎icon‎ הוא או צומת (מסכת אייקון) או טקסט — שני המצבים מטופלים כאן
  const empty = (message, icon = '📭') =>
    el('div.empty', {}, [el('div.e-icon', {}, [icon]), el('div', { text: message })]);

  const spinner = () => el('div.spinner');

  const field = (label, control, hint) =>
    el('div.field', {}, [el('label', { text: label }), control, hint ? el('span.hint', { text: hint }) : null]);

  /**
   * רשימה נפתחת. פריט שיש בו ‎options‎ הוא קבוצה ומתורגם ל-‎optgroup‎ — כך
   * אפשר להציב את חברי המחלקה בראש רשימה של חמישים אנשים תחת כותרת, ולא
   * סתם למעלה בלי הסבר למה הסדר אינו אלפביתי.
   */
  /**
   * חלוקת המשתמשים לשתי קבוצות: המחלקה שלי, ואחריה שאר הארגון.
   *
   * בארגון של חמישים אנשים רשימה אלפביתית מציבה את מי שיושב איתי באמצע,
   * וכמעט תמיד אליו אני מקצה. מרוכז כאן ולא בכל מסך בנפרד, כי אותה רשימה
   * מופיעה בארבעה מקומות — חלון המשימה, הטבלה, כרטיס המשימה ומסך הבקרה —
   * וסדר שונה בין מסך למסך מבלבל יותר מסדר אלפביתי.
   *
   * מי שאין לו מחלקה מקבל רשימה אחת ללא חלוקה, כי אין למה להשוות.
   *
   * הרשימה מוגבלת למי שמותר לי להקצות לו — השרת מסמן כל משתמש
   * (‎assignable‎) לפי אותה בדיקה שהוא אוכף: עובדים שמתחתיי (המחלקה שלי
   * ותתי-המחלקות שלה), ולהנהלה — המנהלים שמתחתיה. הסינון כאן חוסך בחירה
   * שתידחה; ההכרעה נשארת בשרת.
   *
   * ‎keep‎ — מזהים שנשארים ברשימה גם מחוץ לתחום: האחראים הקיימים של משימה
   * בעריכה, כדי שפתיחתה לא תאפס בשקט אחראי שמישהו אחר קבע.
   */
  function usersByDepartment({ keep = [] } = {}) {
    const all = App.state.users ?? [];
    const me = App.state.actor?.id ?? null;
    // המחלקה שלי ותתי-המחלקות שלה — מנהל "הנדסה וביצוע" רואה גם את "אתר אלעד"
    const actor = App.state.actor;
    const myDepts = new Set(actor?.departmentIds ?? (actor?.departmentId ? [actor.departmentId] : []));
    const inMine = (u) => myDepts.has(u.departmentId);
    const kept = new Set(keep.map(Number));
    const list = all.filter((u) => u.id === me || kept.has(u.id) || u.assignable);
    const near = list.filter(inMine);
    const nearIds = new Set(near.map((u) => u.id));
    return {
      near,
      far: list.filter((u) => !nearIds.has(u.id)),
      deptName: App.state.actor?.department || 'המחלקה שלי'
    };
  }

  /** טלפון שנשמר מנורמל (‎972541234567‎) בתצוגה ישראלית: ‎054-1234567‎ */
  function phone(stored) {
    const s = String(stored ?? '');
    if (/^972\d{8,9}$/.test(s)) {
      const local = `0${s.slice(3)}`;
      return `${local.slice(0, 3)}-${local.slice(3)}`;
    }
    return s ? `+${s}` : '';
  }

  function select(options, value, props = {}) {
    const build = (o) => (Array.isArray(o.options)
      ? el('optgroup', { label: o.label }, o.options.map(build))
      : el('option', { value: o.value, selected: String(o.value) === String(value) }, [o.label]));
    const node = el('select', props, options.map(build));
    node.value = value ?? '';
    return node;
  }

  /** הדגשת תיוגי @שם בתוך טקסט תגובה */
  function renderMentions(text, names) {
    const frag = document.createDocumentFragment();
    let rest = text;
    const sorted = [...(names ?? [])].sort((a, b) => b.length - a.length);
    outer: while (rest.length) {
      for (const name of sorted) {
        const token = `@${name}`;
        const idx = rest.indexOf(token);
        if (idx === 0) {
          frag.appendChild(el('span.mention', { text: token }));
          rest = rest.slice(token.length);
          continue outer;
        }
      }
      const nextAt = rest.indexOf('@', 1);
      const cut = nextAt === -1 ? rest.length : nextAt;
      frag.appendChild(document.createTextNode(rest.slice(0, cut)));
      rest = rest.slice(cut);
    }
    return frag;
  }

  const fileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} ב׳`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  // ---------------------------------------------------------------- לוגו

  /**
   * סמל המערכת — אריח מעוגל ובתוכו רשימת משימות שהשורה האחרונה בה סומנה.
   *
   * שתי השורות העליונות הן רצועות מוטות בצורת הלוחות שבלוגו של אשל הירדן:
   * פאה בהירה ופאה מלאה שנפגשות בקו אמצעי, כמו קופסה שרואים מהפינה. זה
   * הקשר בין המוצר לחברה, בלי להחליף את הטורקיז של המערכת בכחולים שלה —
   * והצורה פשוטה מספיק כדי להיקרא גם בפאביקון של 16 פיקסלים.
   *
   * הגאומטריה זהה לזו שב-tools/make-icons.js ובפאביקון שב-index.html;
   * שינוי כאן מחייב שינוי גם שם.
   *
   * variant: 'light' (אריח לבן על רקע כהה) או 'brand' (אריח בצבע המותג על רקע בהיר)
   */
  function logoMark(size = 40, variant = 'brand') {
    const light = variant === 'light';
    const tile = light ? '#ffffff' : '#0f766e';
    const ink = light ? '#0f766e' : '#ffffff';
    // הפאה הבהירה של כל לוח — טורקיז בהיר על האריח הכהה, וגוון ביניים על הלבן
    const face = light ? '#2dd4bf' : '#5eead4';
    const svg = `
      <svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="0" y="0" width="64" height="64" rx="17" fill="${tile}"/>
        <polygon points="15,16.5 27,14 27,20 15,22.5" fill="${face}"/>
        <polygon points="27,14 40,15.5 40,21.5 27,20" fill="${ink}"/>
        <polygon points="15,27.5 27,25 27,31 15,33.5" fill="${face}"/>
        <polygon points="27,25 33,26.5 33,32.5 27,31" fill="${ink}"/>
        <path d="M16 44.5 L25 53 L48 26" fill="none" stroke="${ink}"
              stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    const wrap = el('span.logo-mark', { html: svg });
    wrap.style.width = `${size}px`;
    wrap.style.height = `${size}px`;
    return wrap;
  }

  /**
   * מותח את הכיתוב כך שרוחבו יהיה בדיוק רוחב המילה MESIMON שמעליו.
   * מקטין את הגופן אם הכיתוב רחב מהלוגו, ואז מחלק את השארית בין האותיות.
   */
  /**
   * רוחב הטקסט עצמו ולא של התיבה. שתי השורות הן אלמנטים בלוקיים, ולכן
   * getBoundingClientRect עליהן מחזיר את רוחב המכל המשותף — מדידה מעגלית.
   * מדידת טווח (Range) מחזירה את גבולות האותיות בפועל.
   */
  function textWidth(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const width = range.getBoundingClientRect().width;
    range.detach?.();
    // letter-spacing מוסיף רווח גם אחרי האות האחרונה — מחסירים אותו
    return Math.max(0, width - (parseFloat(getComputedStyle(node).letterSpacing) || 0));
  }

  function fitTaglineToName(nameEl, tagEl, tries = 0) {
    const target = textWidth(nameEl);

    // בזמן הבנייה האלמנט עדיין לא במסמך ואין לו רוחב — מנסים שוב מעט מאוחר יותר.
    // setTimeout ולא requestAnimationFrame: האחרון אינו פועל בלשונית שאינה מוצגת.
    if (!target) {
      if (tries < 12 && (tries === 0 || document.contains(nameEl))) {
        setTimeout(() => fitTaglineToName(nameEl, tagEl, tries + 1), tries === 0 ? 0 : 60);
      }
      return;
    }

    tagEl.style.letterSpacing = '0px';
    tagEl.style.marginInlineEnd = '0px';
    tagEl.style.fontSize = '';

    let size = parseFloat(getComputedStyle(tagEl).fontSize);
    let natural = textWidth(tagEl);
    while (natural > target && size > 6) {           // רחב מדי — מקטינים עד שנכנס
      size -= 0.5;
      tagEl.style.fontSize = `${size}px`;
      natural = textWidth(tagEl);
    }

    const chars = tagEl.textContent.length;
    if (chars < 2 || natural >= target) return;

    const spacing = (target - natural) / (chars - 1);
    tagEl.style.letterSpacing = `${spacing}px`;
    tagEl.style.marginInlineEnd = `${-spacing}px`;
  }

  /** מחשב מחדש את רוחב הכיתוב בכל הסמלים שנמצאים כרגע במסך */
  function refitLogos() {
    for (const block of document.querySelectorAll('.app-logo')) {
      const name = block.querySelector('.app-logo-name');
      const tag = block.querySelector('.app-logo-tagline');
      if (name && tag) fitTaglineToName(name, tag);
    }
  }

  // מאזין יחיד לכל המסמך — הסמל נבנה מחדש בכל ניווט, ומאזין לכל מופע היה נערם
  let refitBound = false;
  function bindRefit() {
    if (refitBound) return;
    refitBound = true;
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(refitLogos, 120);
    };
    window.addEventListener('resize', debounced);
    document.fonts?.ready.then(debounced);
  }

  /** סמל + שם המערכת, והכיתוב מתחתיו ברוחב השם. */
  function logo({ size = 'sm', tagline = true, variant = 'brand' } = {}) {
    const large = size === 'lg';
    const name = el('div.app-logo-name', { text: 'MESIMON' });
    const tag = tagline ? el('div.app-logo-tagline', { text: 'משימות שעובדות בשבילך' }) : null;

    if (tag) {
      bindRefit();
      fitTaglineToName(name, tag);
    }

    return el(`div.app-logo${large ? '.app-logo-lg' : ''}`, {}, [
      logoMark(large ? 76 : 32, variant),
      el('div.app-logo-text', {}, [name, tag])
    ]);
  }

  // נקרא פעם אחת ומשותף לכל מופעי הלוגו במסך
  let brandingPromise = null;
  const branding = () => {
    brandingPromise ??= fetch('/api/branding').then((r) => r.json()).catch(() => ({}));
    return brandingPromise;
  };

  /**
   * לוגו אשל הירדן. נטען מכל קובץ תמונה שנמצא ב-‎public/img‎,
   * ועד שיהיה שם קובץ מוצג שם החברה כטקסט — כדי לא להציג שחזור לא מדויק.
   */
  function companyLogo(className = '') {
    const fallback = el('div.company-fallback', {}, [
      el('div.company-name', { text: 'אשל הירדן' }),
      el('div.company-tag', { text: 'ליזום. לתכנן. לבצע.' })
    ]);
    const img = el('img.company-img', { alt: 'אשל הירדן' });
    img.style.display = 'none';
    img.addEventListener('load', () => {
      img.style.display = 'block';
      fallback.style.display = 'none';
    });
    // השרת מאתר את הקובץ בתיקיית התמונות, ללא תלות בשם שניתן לו
    branding().then((b) => { if (b.companyLogo) img.src = b.companyLogo; });
    return el(`div.company-logo${className ? `.${className}` : ''}`, {}, [img, fallback]);
  }

  /**
   * הסוגים שהשרת מסכים להגיש לצפייה בתוך הדפדפן. הרשימה זהה ל-INLINE_MIMES
   * שבשרת — כאן היא רק כדי לא להציע כפתור שייכשל. SVG אינו ברשימה בכוונה:
   * הוא מסמך שאפשר לשתול בו סקריפט.
   */
  /**
   * אייקון ממשק. הקבצים ב-‎/icons/ui‎ הם מסכות: התמונה נושאת צורה בלבד, והצבע
   * בא מ-‎currentColor‎ דרך ‎background-color‎. לכן אותו קובץ מופיע בצבע המותג
   * בתפריט, לבן על הסרגל הירוק, ואדום בתגית איחור — בלי גרסה נפרדת לכל הקשר.
   *
   * הרשימה כאן היא כל השמות הקיימים, כדי ששם שגוי ייתפס מיד ולא יופיע כריק.
   */
  const ICONS = ['home', 'board', 'my-tasks', 'vendors', 'archive', 'reports',
    'admin', 'bell', 'pin', 'overdue', 'urgent', 'waiting'];

  function icon(name, { size = null, title = null } = {}) {
    if (!ICONS.includes(name)) {
      console.warn(`[משימון] אין אייקון בשם "${name}"`);
      return el('span.ic');
    }
    const node = el('span.ic', title ? { title } : {});
    // שני הכתיבים — ‎-webkit-‎ נדרש לספארי, שהוא הדפדפן של כל אייפון
    node.style.webkitMaskImage = `url(/icons/ui/${name}.png)`;
    node.style.maskImage = `url(/icons/ui/${name}.png)`;
    if (size) { node.style.width = `${size}px`; node.style.height = `${size}px`; }
    return node;
  }

  /*
   * סמלי קו — לכפתורי פעולה (חיוג, מייל, משימת AI, עריכה, מחיקה) ולאלפון.
   *
   * ‎icon()‎ שלמעלה מגיש את סט האייקונים שעוצב לתפריט, כמסכות PNG. לפעולות
   * האלה אין בו סמלים, והאימוג'י שהיו כאן נראו כל אחד בצבע אחר ובגודל אחר
   * בכל מערכת הפעלה. כאן — SVG בקו אחיד של 2px על רשת 24, בצבע ‎currentColor‎:
   * הצבע נקבע ב-CSS (צבע המותג כברירת מחדל), ואותו סמל משרת כל הקשר.
   *
   * הצורות מבוססות על Lucide (‎lucide.dev‎, רישיון ISC).
   */
  const LINE_ICONS = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    contacts: '<path d="M15 13a3 3 0 1 0-6 0"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><circle cx="12" cy="8" r="2"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    // הצגת/הסתרת סיסמה במסך הכניסה
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.95 3.28 9.94 6.65a1 1 0 0 1 0 .7 10.4 10.4 0 0 1-1.48 2.76"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.45 10.45 0 0 1 12 19c-4.97 0-8.95-3.28-9.94-6.65a1 1 0 0 1 0-.7 10.5 10.5 0 0 1 4.5-5.24"/><path d="m2 2 20 20"/>'
  };

  /** סמל קו בגודל הטקסט שסביבו (‎1.15em‎), או ב-‎size‎ פיקסלים */
  function lineIcon(name, { size = null } = {}) {
    const body = LINE_ICONS[name];
    if (!body) { console.warn(`[משימון] אין סמל קו בשם "${name}"`); return el('span.li'); }
    const node = el('span.li', { 'aria-hidden': 'true' });
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    if (size) { node.style.width = `${size}px`; node.style.height = `${size}px`; }
    return node;
  }

  // פלטת הפרויקטים — זהה לזו שבשרת, שממנה נגזר צבע ברירת המחדל לפי המזהה
  const PROJECT_COLORS = ['#0f766e', '#c2410c', '#2563eb', '#7c3aed', '#be123c', '#0891b2', '#65a30d', '#a16207'];

  const PREVIEW_MIMES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf',
    // הקלטת קול מתנגנת בתוך המערכת, ולא נדרשת הורדה כדי לשמוע אותה
    'audio/wav'
  ];
  // ------------------------------------------------- בורר פרויקטים

  /**
   * דירוג הפרויקטים בבורר, מהרלוונטי לרחוק.
   *
   * ‎mine‎ לבדו אינו מספיק: בארגון שבו מנהל המערכת מוגדר מנהל של כמעט כל
   * פרויקט הדגל דולק אצל כולם, והרשימה נשארת באורך מלא. תדירות היא שאלה
   * אחרת — באילו פרויקטים יש לי עבודה פתוחה וכמה — והיא מדרגת גם אז.
   *
   * הסדר: קודם הנעוצים, אחריהם לפי מספר המשימות הפתוחות שלי, אחריהם
   * פרויקטים של המחלקה שלי, ולבסוף השאר לפי א״ב.
   */
  function rankProjects(projects, { actor = App.state.actor } = {}) {
    const deptId = actor?.departmentId ?? null;
    const tier = (p) => {
      if (p.pinned) return 0;
      if (p.myTaskCount > 0) return 1;
      if (deptId && p.departmentId === deptId) return 2;
      if (p.mine) return 3;
      return 4;
    };
    return [...projects].sort((a, b) =>
      tier(a) - tier(b)
      || (b.myTaskCount ?? 0) - (a.myTaskCount ?? 0)
      || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'he'));
  }

  const TIER_LABEL = ['נעוצים', 'העבודה שלי', 'המחלקה שלי', 'פרויקטים שלי', 'שאר הארגון'];

  /**
   * בורר פרויקטים עם חיפוש.
   *
   * ‎select‎ רגיל אינו מתאים כאן: ברשימה של עשרות פרויקטים אין בו חיפוש, אין
   * דירוג ואין כותרות — ומי שמחפש "מרכזייה" גולל עד שהוא מוצא. כאן ההקלדה
   * מסננת, הפרויקטים שעובדים בהם באמת יושבים בראש, וכל קבוצה מוכרזת כדי
   * שיהיה ברור למה הסדר אינו אלפביתי.
   *
   * ‎onChange(id)‎ מקבל מזהה או מחרוזת ריקה. ‎value()‎ מחזיר את הבחירה — כך
   * הקורא אינו צריך להחזיק אותה בעצמו.
   */
  function projectPicker({
    value = '',
    projects = App.state.projects,
    noneLabel = 'ללא פרויקט',
    allowNone = true,
    onChange = null
  } = {}) {
    let current = value ? String(value) : '';
    const byId = (id) => projects.find((p) => String(p.id) === String(id));

    const face = el('span.pp-face');
    const trigger = el('button.pp-trigger', {
      type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false'
    }, [face, el('span.pp-caret', { text: '▾' })]);

    const paint = () => {
      const p = byId(current);
      clear(face);
      if (p) {
        face.appendChild(el('span.pp-dot', { style: { background: p.color } }));
        face.appendChild(el('span', { text: p.name }));
      } else {
        face.appendChild(el('span.mute-sm', { text: noneLabel }));
      }
    };
    paint();

    let pop = null;
    const close = () => {
      if (!pop) return;
      pop.remove();
      pop = null;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside);
    };
    const onOutside = (e) => {
      if (pop && !pop.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) close();
    };

    const pick = (id) => {
      current = id ? String(id) : '';
      paint();
      close();
      trigger.focus();
      onChange?.(current);
    };

    function open() {
      if (pop) return close();
      const search = el('input.pp-search', { type: 'search', placeholder: 'חיפוש פרויקט…', 'aria-label': 'חיפוש פרויקט' });
      const list = el('div.pp-list', { role: 'listbox' });
      pop = el('div.pp-pop', {}, [search, list]);

      let rows = [];
      let cursor = -1;
      const setCursor = (next) => {
        if (!rows.length) return;
        cursor = (next + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle('is-active', i === cursor));
        rows[cursor].scrollIntoView({ block: 'nearest' });
      };

      const draw = () => {
        const q = search.value.trim().toLowerCase();
        clear(list);
        rows = [];
        cursor = -1;

        if (allowNone && !q) {
          const none = el(`button.pp-opt${current ? '' : '.is-chosen'}`, {
            type: 'button', role: 'option', onclick: () => pick('')
          }, [el('span.pp-dot.is-empty'), el('span', { text: noneLabel })]);
          rows.push(none);
          list.appendChild(none);
        }

        const matches = rankProjects(projects).filter((p) =>
          !q || String(p.name ?? '').toLowerCase().includes(q));

        if (!matches.length) {
          list.appendChild(el('div.pp-empty', { text: `לא נמצא פרויקט בשם "${search.value.trim()}"` }));
        }

        const deptId = App.state.actor?.departmentId ?? null;
        const tierOf = (p) => (p.pinned ? 0 : p.myTaskCount > 0 ? 1
          : (deptId && p.departmentId === deptId) ? 2 : p.mine ? 3 : 4);

        let shownTier = -1;
        for (const p of matches) {
          // כותרות קבוצה רק כשאין חיפוש — בתוצאות חיפוש הן רעש
          const t = tierOf(p);
          if (!q && t !== shownTier) {
            shownTier = t;
            list.appendChild(el('div.pp-group', { text: TIER_LABEL[t] }));
          }
          const row = el(`button.pp-opt${String(p.id) === current ? '.is-chosen' : ''}`, {
            type: 'button', role: 'option', title: p.name, onclick: () => pick(p.id)
          }, [
            el('span.pp-dot', { style: { background: p.color } }),
            el('span.pp-name', { text: p.name }),
            // המספר מסביר את הדירוג: זה מה שהופך "העבודה שלי" למדיד ולא לתחושה
            p.myTaskCount ? el('span.pp-count', { text: String(p.myTaskCount) }) : null
          ]);
          rows.push(row);
          list.appendChild(row);
        }
        if (rows.length) setCursor(0);
      };

      search.addEventListener('input', draw);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setCursor(cursor + (e.key === 'ArrowDown' ? 1 : -1));
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); rows[Math.max(0, cursor)]?.click(); }
      });

      draw();
      trigger.setAttribute('aria-expanded', 'true');
      trigger.parentNode.appendChild(pop);
      search.focus();
      setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    }

    trigger.addEventListener('click', open);

    const wrap = el('div.pp-wrap', {}, [trigger]);
    wrap.value = () => current;
    wrap.setValue = (id) => { current = id ? String(id) : ''; paint(); };
    return wrap;
  }

  const canPreview = (file) => PREVIEW_MIMES.includes(String(file?.mime ?? '').toLowerCase());
  const isPdf = (file) => String(file?.mime ?? '').toLowerCase() === 'application/pdf';
  const isAudio = (file) => String(file?.mime ?? '').toLowerCase().startsWith('audio/');

  /**
   * תצוגה מקדימה בתוך המערכת. ‎files‎ היא רשימת הקבצים שאפשר לדפדף ביניהם,
   * כדי שלא צריך לסגור ולפתוח חלון לכל קובץ; ‎index‎ הוא הקובץ שנפתח.
   */
  /**
   * ‎previewUrls‎ הוא החלון עצמו: הוא מקבל פריטים שיש להם ‎url‎ מוכן, ולכן
   * הוא משרת גם קבצים מצורפים למשימה וגם תמונות של פרויקט — שני מקורות עם
   * נקודות קצה שונות. ‎preview‎ הוא העטיפה למהדקים, שבונה את הכתובות מהמזהה.
   */
  function preview(files, index = 0) {
    const list = (Array.isArray(files) ? files : [files]).filter(canPreview);
    return previewUrls(list.map((f) => ({ ...f, url: `/api/attachments/${f.id}/view`, downloadUrl: `/api/attachments/${f.id}/download` })), index);
  }

  function previewUrls(files, index = 0) {
    const list = (Array.isArray(files) ? files : [files]).filter((f) => f && f.url);
    if (!list.length) return;
    let at = Math.max(0, Math.min(index, list.length - 1));

    const stage = el('div.preview-stage');
    const caption = el('div.preview-caption');
    const counter = el('div.mute-sm');
    const prev = el('button.btn.btn-sm', { title: 'הקודם' }, ['›']);
    const next = el('button.btn.btn-sm', { title: 'הבא' }, ['‹']);

    const show = () => {
      const f = list[at];
      mount(stage,
        isPdf(f)
          // הכותרת הפנימית של הצופה מוסתרת (‎#toolbar=0‎) כדי שלא יופיע כפתור
          // הורדה שני מעל זה שכבר יש בחלון
          ? el('iframe.preview-pdf', { src: `${f.url}#toolbar=0&navpanes=0`, title: f.filename })
          : isAudio(f)
            // ‎controls‎ של הדפדפן ולא נגן משלנו: הוא מביא הפעלה, סרגל
            // התקדמות, עוצמה ומהירות — והוא נגיש במקלדת בלי שנכתוב דבר
            ? el('div.preview-audio', {}, [
                el('div.pa-icon', { text: '🎧' }),
                el('audio', { src: f.url, controls: true, preload: 'metadata' })
              ])
            : el('img.preview-img', { src: f.url, alt: f.filename }));
      mount(caption, el('b', { text: f.filename }),
        f.size ? el('span.mute-sm', { text: ` · ${fileSize(f.size)}` }) : null);
      counter.textContent = list.length > 1 ? `${at + 1} מתוך ${list.length}` : '';
      // תמונת פרויקט מוגשת לצפייה בלבד; כשאין כתובת הורדה הכפתור מוסתר
      dl.href = f.downloadUrl ?? f.url;
      dl.style.display = f.downloadUrl ? '' : 'none';
    };

    const step = (d) => { at = (at + d + list.length) % list.length; show(); };
    prev.addEventListener('click', () => step(1));   // RTL — "הקודם" יושב מימין
    next.addEventListener('click', () => step(-1));

    const dl = el('a.btn.btn-sm', { download: '' }, ['⬇ הורדה']);
    const onKey = (e) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', onKey);

    show();
    return modal({
      title: 'תצוגה מקדימה',
      size: 'xwide',
      body: el('div.preview-wrap', {}, [
        stage,
        el('div.preview-bar', {}, [
          caption,
          el('div.spacer'),
          counter,
          list.length > 1 ? prev : null,
          list.length > 1 ? next : null,
          dl
        ])
      ]),
      onClose: () => document.removeEventListener('keydown', onKey)
    });
  }

  /**
   * שרשור תגובות — מימוש אחד לכל השרשורים במערכת: של המשימה ושל סעיף
   * בצ'קליסט. כולל תיוג עמיתים, הערה פנימית, צירוף קבצים ותצוגה מקדימה.
   *
   * ‎onSend(body, internal, files)‎ הוא זה שיודע לאן ההודעה נשלחת ומה נטען
   * מחדש אחריה; כאן רק האיסוף והתצוגה.
   */
  function commentThread({ comments = [], canComment = false, seeInternal = false, onSend, onDelete = null }) {
    const names = App.state.users.map((u) => u.name);
    const input = el('textarea', { placeholder: 'הוספת תגובה… ניתן לתייג עמיתים באמצעות @שם' });
    const internalCheck = el('input', { type: 'checkbox' });

    // קבצים שנבחרו ועדיין לא נשלחו. נשמרים כאן ולא ב-DOM כדי שהתצוגה
    // תיבנה מהמצב ולא להיפך.
    let pending = [];
    const pendingBox = el('div.file-chips', { style: { margin: '8px 0 0' } });

    const drawPending = () => {
      mount(pendingBox, ...pending.map((f, i) =>
        el('span.file-chip', {}, [
          /*
           * תמונה מוצגת כתמונה קטנה ולא כאייקון גנרי. זה נדרש במיוחד להדבקה:
           * מי שהדביק צילום מסך אינו יודע מה בדיוק היה בלוח, ושם קובץ שנוצר
           * אוטומטית אינו אומר לו דבר.
           */
          f.mime?.startsWith('image/')
            ? el('img.fc-thumb', { src: f.data, alt: '' })
            : el('span', { text: fileIcon(f.filename) }),
          el('span.fc-name', { text: f.filename }),
          el('span.mute-sm', { text: fileSize(f.size) }),
          el('button.chip-x', {
            title: 'הסרה',
            onclick: () => { pending.splice(i, 1); drawPending(); }
          }, ['✕'])
        ])));
      pendingBox.style.display = pending.length ? 'flex' : 'none';
    };
    drawPending();

    const readAsDataUrl = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('הקובץ לא נקרא'));
      reader.readAsDataURL(file);
    });

    /**
     * שם לקובץ שהודבק. בהדבקה מלוח הגזירים אין שם אמיתי — הדפדפן מוסר
     * ‎image.png‎ לכולם, וכך שתי הדבקות באותה הודעה מתנגשות. חותמת השעה
     * הופכת כל אחת לשם משלה, וגם מאפשרת לזהות אחר כך מה הודבק ומתי.
     */
    const pastedName = (file, index) => {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      return `תמונה ${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
    };

    /**
     * הוספת קבצים לתור השליחה — מכל שלושת המסלולים: בחירה, הדבקה וגרירה.
     *
     * מגבלת הגודל נבדקת כאן ולא רק בשרת: צילום מסך של מסך גדול עובר בקלות
     * את המגבלה, ולגלות זאת רק בלחיצה על "שליחה" פירושו לאבד את מה שנכתב.
     */
    async function addFiles(files, { pasted = false } = {}) {
      const maxMb = Number(App.state.settings?.maxUploadMb ?? 25);
      let index = 0;
      for (const file of files) {
        if (!file) continue;
        if (file.size > maxMb * 1024 * 1024) {
          error(new Error(`הקובץ גדול מ-${maxMb}MB ולכן לא צורף`));
          continue;
        }
        try {
          pending.push({
            filename: pasted ? pastedName(file, index) : file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            data: await readAsDataUrl(file)
          });
          index++;
        } catch (err) { error(err); }
      }
      drawPending();
    }

    const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      await addFiles([...fileInput.files]);
      fileInput.value = '';
    });

    /**
     * הדבקה. ‎clipboardData.files‎ מכיל את התמונה גם כשמדביקים צילום מסך
     * ישר מ-Win+Shift+S, וגם כשמעתיקים קובץ מסייר הקבצים.
     *
     * ‎preventDefault‎ רק כשבאמת נמצא קובץ: הדבקת טקסט רגילה חייבת להמשיך
     * לעבוד כרגיל, וחסימה גורפת הייתה שוברת אותה.
     */
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      addFiles(files, { pasted: true });
    });

    // גרירת קובץ אל תיבת התגובה — אותו מסלול, וזו הציפייה הטבעית לצד הדבקה
    const dropZone = el('div.comment-drop');
    for (const evt of ['dragenter', 'dragover']) {
      dropZone.addEventListener(evt, (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dropZone.classList.add('is-over');
      });
    }
    for (const evt of ['dragleave', 'dragend']) {
      dropZone.addEventListener(evt, () => dropZone.classList.remove('is-over'));
    }
    dropZone.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      dropZone.classList.remove('is-over');
      if (!files.length) return;
      e.preventDefault();
      addFiles(files);
    });

    const send = async () => {
      const body = input.value.trim();
      // הודעה עם קובץ בלבד היא שימוש לגיטימי, ולכן לא דורשים טקסט כשיש צירוף
      if (!body && !pending.length) return;
      try {
        await onSend(body, internalCheck.checked, pending);
        input.value = '';
        pending = [];
      } catch (err) { error(err); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });

    /**
     * תיוג נפתח בכפתור ולא בשורת שמות. רשימה פרושה של כל המשתמשים הציפה את
     * תיבת התגובה עוד בעשרה אנשים, ומתפוצצת לגמרי בחמישים — ובכל מקרה תיוג
     * הוא פעולה שנעשית לעיתים, ולא כל פעם שכותבים הודעה.
     */
    const insertMention = (name) => {
      const gap = input.value && !input.value.endsWith(' ') ? ' ' : '';
      input.value += `${gap}@${name} `;
      input.focus();
    };

    /**
     * רשימת התיוג נפתחת מעל תיבת הכתיבה ולא כחלון נפרד. חלון מעל חלון —
     * הרשימה מעל כרטיס המשימה — נראה כמשהו אחר ולא כרשימה שנפתחה מהכפתור,
     * וגם מכסה את מה שכותבים. כאן היא צמודה לכפתור, ונסגרת בבחירה, בלחיצה
     * בחוץ או ב-Escape.
     */
    const pop = el('div.mention-pop', { style: { display: 'none' } });
    let popOpen = false;

    const closePop = () => {
      popOpen = false;
      pop.style.display = 'none';
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onPopKey, true);
    };
    const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== mentionBtn) closePop(); };
    const onPopKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } };

    /**
     * חברי המחלקה של הכותב בראש הרשימה. בארגון של חמישים אנשים מי שמתייג
     * מחפש כמעט תמיד את מי שיושב איתו, ורשימה אלפביתית מציבה אותם באמצע.
     */
    const orderedUsers = (query) => {
      const q = query.trim().toLowerCase();
      const myDept = App.state.actor?.departmentId ?? null;
      const me = App.state.actor?.id;
      const found = App.state.users.filter((u) => u.id !== me && u.name.toLowerCase().includes(q));
      const near = myDept ? found.filter((u) => u.departmentId === myDept) : [];
      const far = found.filter((u) => !near.includes(u));
      return { near, far };
    };

    const drawPop = (query = '') => {
      const { near, far } = orderedUsers(query);
      const option = (u) => el('button.mention-option', {
        type: 'button',
        onclick: () => { insertMention(u.name); closePop(); }
      }, [
        avatar(u.name, { small: true }),
        el('span.mo-name', { text: u.name }),
        u.department ? el('span.mo-dept', { text: u.department }) : null
      ]);

      mount(popList,
        near.length ? el('div.mention-group', { text: App.state.actor.department || 'המחלקה שלי' }) : null,
        ...near.map(option),
        near.length && far.length ? el('div.mention-group', { text: 'שאר הארגון' }) : null,
        ...far.map(option),
        !near.length && !far.length ? el('div.mute-sm', { style: { padding: '10px 8px' }, text: 'אין שם מתאים' }) : null
      );
    };

    const popSearch = el('input', { type: 'text', placeholder: 'חיפוש שם…' });
    const popList = el('div.mention-list');
    popSearch.addEventListener('input', () => drawPop(popSearch.value));
    popSearch.addEventListener('keydown', (e) => {
      // Enter בוחר את הראשון ברשימה — הדרך המהירה כשיודעים את מי מחפשים
      if (e.key !== 'Enter') return;
      e.preventDefault();
      popList.querySelector('.mention-option')?.click();
    });
    mount(pop, popSearch, popList);

    const openPop = () => {
      if (popOpen) return closePop();
      popOpen = true;
      popSearch.value = '';
      drawPop('');
      pop.style.display = 'block';
      popSearch.focus();
      // ההאזנה בשלב הלכידה, כדי שלחיצה על פקד אחר תסגור לפני שהוא מגיב
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onPopKey, true);
    };

    const mentionBtn = seeInternal
      ? el('button.btn.mention-btn', { type: 'button', title: 'תיוג עמית בשיחה', onclick: openPop }, ['@'])
      : null;

    const isImage = (f) => String(f?.mime ?? '').toLowerCase().startsWith('image/') && canPreview(f);

    /**
     * תמונה מוצגת בתוך ההודעה עצמה, בגודל שנכנס לבועה — כמו בכל יישומון
     * הודעות. עד כה גם תמונה הופיעה כשבב עם שם קובץ, ואי אפשר היה לדעת מה
     * נשלח בלי לפתוח אותה. לחיצה עדיין פותחת בגודל מלא.
     */
    const mediaGrid = (images, all) => el('div.b-media', {}, images.map((a) =>
      el('button.b-photo', {
        title: `${a.filename} · ${fileSize(a.size)}`,
        onclick: () => preview(all, all.indexOf(a))
      }, [el('img', { src: `/api/attachments/${a.id}/view`, alt: a.filename, loading: 'lazy' })])
    ));

    const fileChips = (list) => el('div.file-chips', { style: { marginTop: '6px' } }, list.map((a) => {
      const shown = list.filter(canPreview);
      const label = [
        el('span', { text: fileIcon(a.filename) }),
        el('span.fc-name', { text: a.filename }),
        el('span.mute-sm', { text: fileSize(a.size) })
      ];
      // קובץ שאפשר לראות נפתח בתוך המערכת; שאר הסוגים יורדים למחשב
      return canPreview(a)
        ? el('button.file-chip', {
            title: `${a.filename} · ${fileSize(a.size)} — לחיצה לתצוגה`,
            onclick: () => preview(shown, shown.indexOf(a))
          }, label)
        : el('a.file-chip', {
            href: `/api/attachments/${a.id}/download`,
            title: `${a.filename} · ${fileSize(a.size)}`
          }, label);
    }));

    /** האם ההודעה נכתבה על ידי מי שצופה בה כרגע */
    const isMine = (c) => {
      const actor = App.state.actor;
      if (!actor || c.authorType === 'system') return false;
      const myType = actor.type === 'vendor' ? 'vendor' : 'user';
      return c.authorType === myType && c.authorId === actor.id;
    };

    const bubble = (c) => {
      const mine = isMine(c);
      const files = c.attachments ?? [];
      const images = files.filter(isImage);
      const rest = files.filter((f) => !isImage(f));
      const previewable = files.filter(canPreview);

      return el(`div.msg${mine ? '.is-mine' : ''}${c.internal ? '.is-internal' : ''}`, {}, [
        // האווטאר מופיע רק אצל האחרים — בהודעה שלי הוא רק גוזל רוחב
        mine ? null : avatar(c.authorName, { small: true, vendor: c.authorType === 'vendor' }),
        el('div.bubble', {}, [
          // שם הכותב מיותר בהודעה שלי: אני יודע מי אני
          mine ? null : el('div.b-who', {}, [
            el('b', { text: c.authorName }),
            c.authorType === 'vendor' ? el('span.tag.tag-vendor', {}, ['ספק']) : null
          ]),
          c.internal ? el('div.b-flag', { text: '🔒 הערה פנימית — מוסתרת מהספק' }) : null,
          images.length ? mediaGrid(images, previewable) : null,
          c.body ? el('div.c-text', {}, [renderMentions(c.body, names)]) : null,
          rest.length ? fileChips(rest) : null,
          el('div.b-foot', {}, [
            el('time.b-time', { text: formatDateTime(c.createdAt) }),
            // מחיקה רק בהודעה שלי — הכפתור מופיע בריחוף כדי שלא יילחץ בטעות
            mine && onDelete
              ? el('button.b-del', {
                  title: 'מחיקת ההודעה',
                  onclick: async () => {
                    const what = files.length
                      ? 'למחוק את ההודעה? הקבצים שצורפו אליה יימחקו איתה.'
                      : 'למחוק את ההודעה?';
                    if (!await confirm(what, { title: 'מחיקת הודעה', danger: true, okText: 'מחיקה' })) return;
                    try { await onDelete(c); } catch (err) { error(err); }
                  }
                }, ['🗑'])
              : null
          ])
        ])
      ]);
    };

    return el('div', {}, [
      comments.length
        ? el('div.chat', {}, comments.map(bubble))
        : empty('אין תגובות עדיין', '💬'),
      canComment
        ? el('div.composer', {}, [
            pop,
            // אזור הגרירה עוטף את תיבת הכתיבה, כדי שגרירה לכל שטחה תיתפס
            mount(dropZone, input, pendingBox),
            fileInput,
            el('div.flex.composer-bar', {}, [
              el('button.btn.btn-primary', { onclick: send }, ['שליחת תגובה']),
              mentionBtn,
              el('button.btn', {
                title: 'צירוף קובץ — אפשר גם להדביק תמונה או לגרור קובץ לתיבה',
                onclick: () => fileInput.click()
              }, ['📎']),
              seeInternal
                ? el('label.checkbox', { title: 'הערות פנימיות מוסתרות לחלוטין מהספק' }, [internalCheck, '🔒 פנימית'])
                : null,
              el('div.spacer'),
              el('span.mute-sm', { text: 'Ctrl+Enter לשליחה · אפשר להדביק תמונה' })
            ])
          ])
        : null
    ]);
  }

  const fileIcon = (name) => {
    const ext = String(name).split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'psd', 'ai'].includes(ext)) return '🖼️';
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx'].includes(ext)) return '📘';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
    if (['ppt', 'pptx'].includes(ext)) return '📙';
    if (['zip', 'rar'].includes(ext)) return '🗜️';
    if (['mp4', 'mov'].includes(ext)) return '🎬';
    if (['wav', 'mp3', 'm4a', 'ogg'].includes(ext)) return '🎧';
    if (['eml', 'msg'].includes(ext)) return '✉️';
    return '📄';
  };

  return {
    el, clear, mount,
    formatDate, formatDateTime, relative, dueLabel, toInputDate, fromInputDate,
    initials, avatar, priorityTag, statusTag, taskTags,
    modal, sheet, openLayers, confirm, prompt, toast, undoToast, error, success, taskCreated, notifyPop, clearNotifyPops,
    empty, spinner, field, select, phone, projectPicker, rankProjects,
    renderMentions, fileSize, fileIcon, announceAutoStatus,
    usersByDepartment,
    preview, previewUrls, canPreview, PROJECT_COLORS, commentThread, icon, lineIcon,
    logo, logoMark, companyLogo, refitLogos
  };
})();
