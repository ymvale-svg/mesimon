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
    if (task.isRecurring) tags.push(el('span.tag.tag-recurring', {}, ['⟳ חוזרת']));
    if (task.dependency?.blocking) tags.push(el('span.tag.tag-high', {}, ['🔗 חסומה']));
    return tags;
  }

  // --- מודל ---

  const modalRoot = () => document.getElementById('modal-root');

  function modal({ title, body, footer, size = '', onClose }) {
    const root = modalRoot();
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    const box = el(`div.modal${size ? `.${size}` : ''}`, {}, [
      title === null ? null : el('div.modal-head', {}, [
        el('h3', { text: title ?? '' }),
        el('button.icon-btn', { onclick: close, title: 'סגירה' }, ['✕'])
      ]),
      body instanceof Node && body.classList?.contains('task-detail') ? body : el('div.modal-body', {}, [body]),
      footer ? el('div.modal-foot', {}, footer) : null
    ]);

    const backdrop = el('div.modal-backdrop', {
      onclick: (e) => { if (e.target === backdrop) close(); }
    }, [box]);

    document.addEventListener('keydown', onKey);
    root.appendChild(backdrop);
    const firstInput = box.querySelector('input, textarea, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 40);
    return { close, box, backdrop };
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

  function prompt(label, { title = 'הזנת ערך', value = '', multiline = false, okText = 'אישור' } = {}) {
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
        body: el('div.field', {}, [el('label', { text: label }), input]),
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

  // --- הקפצת התראות ---

  /**
   * כרטיס התראה שמוקפץ בשפת המסך. זהו אח של toast ולא הרחבה שלו:
   * toast הוא שורת טקסט חולפת שמאשרת פעולה ("נשמר"), ואילו כאן יש מבנה
   * (כותב, תוכן, משימה), לחיצה שמובילה למשימה, השהיה כשהעכבר על הכרטיס
   * וכפתור סגירה. דחיסת כל אלה ל-toast הייתה מעמיסה חתימת אפשרויות על
   * פונקציה שנקראת מעשרות מקומות — ולכן שני מנגנונים, כל אחד פשוט לעצמו.
   */
  const POP_MAX = 3;      // יותר מזה מכסה את המסך במקום להודיע
  const POP_MS = 3000;
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

  const empty = (message, icon = '📭') =>
    el('div.empty', {}, [el('div.e-icon', { text: icon }), el('div', { text: message })]);

  const spinner = () => el('div.spinner');

  const field = (label, control, hint) =>
    el('div.field', {}, [el('label', { text: label }), control, hint ? el('span.hint', { text: hint }) : null]);

  function select(options, value, props = {}) {
    const node = el('select', props, options.map((o) =>
      el('option', { value: o.value, selected: String(o.value) === String(value) }, [o.label])
    ));
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
   * המוטיב הוא שכבות מוערמות.
   * variant: 'light' (אריח לבן על רקע כהה) או 'brand' (אריח בצבע המותג על רקע בהיר)
   */
  function logoMark(size = 40, variant = 'brand') {
    const tile = variant === 'light' ? '#ffffff' : '#0f766e';
    const ink = variant === 'light' ? '#0f766e' : '#ffffff';
    const svg = `
      <svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="0" y="0" width="64" height="64" rx="17" fill="${tile}"/>
        <rect x="15" y="17" width="24" height="5" rx="2.5" fill="${ink}" opacity=".45"/>
        <rect x="15" y="28" width="16" height="5" rx="2.5" fill="${ink}" opacity=".45"/>
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

  // פלטת הפרויקטים — זהה לזו שבשרת, שממנה נגזר צבע ברירת המחדל לפי המזהה
  const PROJECT_COLORS = ['#0f766e', '#c2410c', '#2563eb', '#7c3aed', '#be123c', '#0891b2', '#65a30d', '#a16207'];

  const PREVIEW_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf'];
  const canPreview = (file) => PREVIEW_MIMES.includes(String(file?.mime ?? '').toLowerCase());
  const isPdf = (file) => String(file?.mime ?? '').toLowerCase() === 'application/pdf';

  /**
   * תצוגה מקדימה בתוך המערכת. ‎files‎ היא רשימת הקבצים שאפשר לדפדף ביניהם,
   * כדי שלא צריך לסגור ולפתוח חלון לכל קובץ; ‎index‎ הוא הקובץ שנפתח.
   */
  function preview(files, index = 0) {
    const list = (Array.isArray(files) ? files : [files]).filter(canPreview);
    if (!list.length) return;
    let at = Math.max(0, Math.min(index, list.length - 1));

    const stage = el('div.preview-stage');
    const caption = el('div.preview-caption');
    const counter = el('div.mute-sm');
    const prev = el('button.btn.btn-sm', { title: 'הקודם' }, ['›']);
    const next = el('button.btn.btn-sm', { title: 'הבא' }, ['‹']);

    const show = () => {
      const f = list[at];
      // מקור אחד לשני סוגי הקבצים: אותה כתובת, והדפדפן מציג לפי סוג התוכן
      const src = `/api/attachments/${f.id}/view`;
      mount(stage, isPdf(f)
        // הכותרת הפנימית של הצופה מוסתרת (‎#toolbar=0‎) כדי שלא יופיע כפתור
        // הורדה שני מעל זה שכבר יש בחלון
        ? el('iframe.preview-pdf', { src: `${src}#toolbar=0&navpanes=0`, title: f.filename })
        : el('img.preview-img', { src, alt: f.filename }));
      mount(caption, el('b', { text: f.filename }), el('span.mute-sm', { text: ` · ${fileSize(f.size)}` }));
      counter.textContent = list.length > 1 ? `${at + 1} מתוך ${list.length}` : '';
      dl.href = `/api/attachments/${f.id}/download`;
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
  function commentThread({ comments = [], canComment = false, seeInternal = false, onSend }) {
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
          el('span', { text: fileIcon(f.filename) }),
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

    const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      for (const file of [...fileInput.files]) {
        pending.push({
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          data: await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          })
        });
      }
      fileInput.value = '';
      drawPending();
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

    const mentionPicker = () => {
      const search = el('input', { type: 'text', placeholder: 'חיפוש שם…' });
      const list = el('div.mention-list');
      let m = null;

      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const found = App.state.users.filter((u) => u.name.toLowerCase().includes(q));
        mount(list, ...(found.length
          ? found.map((u) => el('button.mention-option', {
              onclick: () => { insertMention(u.name); m.close(); }
            }, [avatar(u.name, { small: true }), u.name]))
          : [el('div.mute-sm', { style: { padding: '8px' }, text: 'אין שם מתאים' })]));
      };

      search.addEventListener('input', draw);
      draw();
      m = modal({ title: 'תיוג בשיחה', body: el('div', {}, [search, list]) });
    };

    const mentionBtn = seeInternal
      ? el('button.btn.mention-btn', { type: 'button', title: 'תיוג עמית בשיחה', onclick: mentionPicker }, ['@'])
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
          el('time.b-time', { text: formatDateTime(c.createdAt) })
        ])
      ]);
    };

    return el('div', {}, [
      comments.length
        ? el('div.chat', {}, comments.map(bubble))
        : empty('אין תגובות עדיין', '💬'),
      canComment
        ? el('div.composer', {}, [
            input,
            pendingBox,
            fileInput,
            el('div.flex.composer-bar', {}, [
              el('button.btn.btn-primary', { onclick: send }, ['שליחת תגובה']),
              mentionBtn,
              el('button.btn', { title: 'צירוף קובץ להודעה', onclick: () => fileInput.click() }, ['📎']),
              seeInternal
                ? el('label.checkbox', { title: 'הערות פנימיות מוסתרות לחלוטין מהספק' }, [internalCheck, '🔒 פנימית'])
                : null,
              el('div.spacer'),
              el('span.mute-sm', { text: 'Ctrl+Enter לשליחה' })
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
    return '📄';
  };

  return {
    el, clear, mount,
    formatDate, formatDateTime, relative, dueLabel, toInputDate, fromInputDate,
    initials, avatar, priorityTag, statusTag, taskTags,
    modal, confirm, prompt, toast, error, success, notifyPop, clearNotifyPops,
    empty, spinner, field, select, renderMentions, fileSize, fileIcon,
    preview, canPreview, PROJECT_COLORS, commentThread, icon,
    logo, logoMark, companyLogo, refitLogos
  };
})();
