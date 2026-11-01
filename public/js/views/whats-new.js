'use strict';
/**
 * "מה חדש" — הבאנר שנפתח באמצע המסך אחרי הכניסה, ולשונית העריכה שלו
 * בניהול המערכת (לאדמין על בלבד).
 *
 * הבאנר מקבץ את הפריטים לפי מסך: רשימת מסכים בצד, ובמרכז פריט אחד בכל פעם
 * עם "זרקור" — המסך החי של המשתמש, מוגדל על מקום החידוש (‎Spotlight‎) — או
 * צילום המסך שצורף כשאין לפריט עוגן. פס התקדמות, "נסו עכשיו" שלוקח ישר למסך
 * ו"הראו לי" שמדגיש את החידוש במסך האמיתי. הוא
 * נפתח מעצמו רק כשיש גרסה שעוד לא נראתה, ונסגר בלחיצה על "דלג" — ואז לא
 * יופיע שוב עד לגרסה הבאה. מהחשבון שלי אפשר לפתוח אותו מחדש בכל עת.
 *
 * הפריטים מגיעים מהשרת כבר מסוננים לקהל של המשתמש — הממשק אינו מחליט מי
 * רואה פריט למנהלים.
 */
const WhatsNewView = (() => {
  const { el } = UI;

  let screensCache = null;
  let audiencesCache = null;

  const screenOf = (key) => (screensCache ?? []).find((s) => s.key === key)
    ?? { key, label: 'כללי', icon: '✨', route: null };
  const audienceLabel = (key) => audiencesCache?.[key]?.label ?? key;

  /** האם המשתמש בכלל יכול להגיע למסך — "נסו עכשיו" מוצג רק אז */
  function canReach(route) {
    if (!route) return false;
    if (route === 'reports') return App.may('view_reports');
    // מסך היומן קיים רק למזכירות; לשאר הוא הודעה "מיועד למזכירות"
    if (route === 'calendar') return !!App.state.actor?.secretary;
    // אותו תנאי כמו פריט "ניהול המערכת" בתפריט הצד
    if (route === 'admin') {
      return App.may('manage_users') || App.may('manage_automations')
        || App.may('assign_task_to_vendor') || App.can('create_project');
    }
    return true;
  }

  // ------------------------------------------------------------- הבאנר

  /**
   * ‎force‎ — פתיחה יזומה (מהתפריט או מקישור במייל): הגרסה האחרונה, גם אם
   * כבר נראתה. ‎preview‎ — תצוגה מקדימה לאדמין, לא נשמר כ"נראה".
   */
  async function open({ force = false, preview = null } = {}) {
    let releases;
    try {
      if (preview) {
        if (!screensCache) {
          const data = await API.get('/api/whats-new?all=1');
          screensCache = data.screens;
          audiencesCache = data.audiences;
        }
        releases = [preview];
      } else {
        const data = await API.get(`/api/whats-new${force ? '?all=1' : ''}`);
        screensCache = data.screens;
        audiencesCache = data.audiences;
        releases = data.releases;
      }
    } catch (err) {
      if (force || preview) UI.error(err);
      return;
    }
    if (!releases.length || !releases.some((r) => r.items.length)) {
      if (force || preview) UI.toast('אין כרגע חידושים להצגה');
      return;
    }
    show(releases, { markSeen: !preview, preview: !!preview });
  }

  /** נקרא אחרי הטעינה — פותח רק אם יש מה להראות */
  function maybeShow() {
    const params = new URLSearchParams(location.search);
    if (params.get('whatsnew') === '1') {
      // הקישור מהמייל: מנקים אותו מהכתובת, כדי שרענון לא יפתח שוב
      params.delete('whatsnew');
      const rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
      setTimeout(() => open({ force: true }), 400);
      return;
    }
    if (App.state.whatsNewPending > 0) setTimeout(() => open(), 600);
  }

  function show(releases, { markSeen, preview = false }) {
    // הפריטים מכל הגרסאות שמחכות, מהחדשה לישנה, כשכל פריט זוכר מאיזו גרסה בא
    const items = releases.flatMap((r) => r.items.map((i) => ({ ...i, release: r })));
    if (!items.length) return;
    const multi = releases.length > 1;
    const head = releases[0];

    // הסדר: לפי סדר המסכים הקבוע, ובתוך מסך — לפי הסדר שנקבע בעריכה
    const order = (screensCache ?? []).map((s) => s.key);
    const groups = [];
    for (const item of items) {
      let g = groups.find((x) => x.screen === item.screen);
      if (!g) groups.push(g = { screen: item.screen, items: [] });
      g.items.push(item);
    }
    groups.sort((a, b) => order.indexOf(a.screen) - order.indexOf(b.screen));
    const flat = groups.flatMap((g) => g.items);

    let index = 0;
    let dir = 0;

    const nav = el('div.wn-nav', { role: 'tablist', 'aria-label': 'מסכים' });
    /*
     * המדיה יושבת מחוץ לכרטיס שמתחלף: ה-‎iframe‎ של הזרקור נטען פעם אחת לכל
     * הבאנר, וכל הוצאה שלו מה-DOM הייתה טוענת את המערכת כולה מחדש.
     */
    let spot = null;
    let spotDead = false;
    const altMedia = el('div.wn-media-alt');
    const media = el('div.wn-media', {}, [altMedia]);
    const copyHost = el('div.wn-copy-host');
    const progress = el('div.wn-progress', { 'aria-hidden': 'true' },
      flat.map(() => el('span', {}, [el('i')])));
    const stage = el('div.wn-stage', {}, [media, copyHost]);
    const counter = el('span.wn-counter');
    const prevBtn = el('button.btn.wn-arrow', { type: 'button', 'aria-label': 'הקודם', onclick: () => go(index - 1) }, ['→']);
    const nextBtn = el('button.btn.btn-primary.wn-next', { type: 'button', onclick: () => (index < flat.length - 1 ? go(index + 1) : finish()) });

    let m = null;
    let done = false;
    const finish = () => m?.close();

    function drawNav() {
      UI.mount(nav, groups.map((g) => {
        const s = screenOf(g.screen);
        const first = flat.indexOf(g.items[0]);
        const active = flat[index].screen === g.screen;
        return el(`button.wn-nav-item${active ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false',
          onclick: () => go(first)
        }, [
          el('span.wn-nav-icon', { text: s.icon }),
          el('span.wn-nav-label', { text: s.label }),
          el('span.wn-nav-count', { text: String(g.items.length) })
        ]);
      }));
    }

    /**
     * מה מוצג מעל הטקסט: זרקור כשיש עוגן מוכר, צילום כשאין, ואייקון רק כשאין
     * גם צילום (או שהמערכת לא נטענה בזרקור — אז הצילום, ואם אין — האייקון).
     */
    function drawMedia(item, s) {
      const anchor = Spotlight.anchorOf(item.anchor);
      if (anchor && !spotDead) {
        if (!spot) {
          spot = Spotlight.stage({
            onFail: () => {
              spotDead = true;
              spot?.node.remove();
              drawMedia(flat[index], screenOf(flat[index].screen));
            }
          });
          media.prepend(spot.node);
        }
        spot.node.hidden = false;
        altMedia.hidden = true;
        spot.show(anchor.key, { caption: `${s.label} · ${anchor.label}` });
        return;
      }
      if (spot) spot.node.hidden = true;
      altMedia.hidden = false;
      UI.mount(altMedia, item.image
        ? el('div.wn-shot', {}, [
          el('div.wn-shot-bar', {}, [el('i'), el('i'), el('i'), el('span', { text: s.label })]),
          el('img', { src: item.image, alt: `צילום מסך: ${item.title}`, loading: 'lazy',
            onclick: () => UI.previewUrls({ url: item.image, name: item.title, mime: 'image/jpeg' }) })
        ])
        : el('div.wn-hero', {}, [
          el('div.wn-hero-orb'),
          el('div.wn-hero-icon', { text: s.icon }),
          el('div.wn-hero-label', { text: s.label })
        ]));
    }

    function drawStage() {
      const item = flat[index];
      const s = screenOf(item.screen);
      // בתצוגה מקדימה אין לאן "לנסות" — האדמין באמצע עריכה
      const reach = !preview && canReach(s.route);
      const anchor = Spotlight.anchorOf(item.anchor);
      // "הראו לי" — כשיש עוגן, והמשתמש יכול להגיע למסך שלו (הסרגל העליון — תמיד)
      const showable = !preview && anchor && (!anchor.route || canReach(anchor.route));

      drawMedia(item, s);
      const card = el(`div.wn-card${dir > 0 ? '.from-next' : dir < 0 ? '.from-prev' : ''}`, { 'aria-live': 'polite' }, [
        el('div.wn-copy', {}, [
          el('div.wn-kicker', {}, [
            el('span.wn-badge', { text: 'חדש' }),
            el('span', { text: `${s.icon} ${s.label}` }),
            // פריט שמיועד לקהל מצומצם אומר זאת — כדי שמנהל יבין למה עובד לא ראה אותו
            item.audience && item.audience !== 'all'
              ? el('span.wn-aud', { text: `ל${audienceLabel(item.audience)} בלבד` })
              : null,
            multi ? el('span.wn-rel', { text: `· ${item.release.title}` }) : null
          ]),
          el('h2.wn-title', { text: item.title }),
          item.body ? el('p.wn-body', { text: item.body }) : null,
          reach ? el('button.btn.wn-try', {
            type: 'button',
            onclick: () => { finish(); App.navigate(s.route); }
          }, [`נסו עכשיו ב${s.label} ←`]) : null,
          showable ? el('button.btn.btn-primary.wn-show', {
            type: 'button',
            title: 'הבאנר נסגר, והחידוש יודגש לך במסך עצמו',
            onclick: () => { finish(); Spotlight.showMe(anchor.key, item.title); }
          }, ['🎯 הראו לי']) : null
        ])
      ]);
      UI.mount(copyHost, card);

      [...progress.children].forEach((seg, i) => {
        seg.className = i < index ? 'done' : i === index ? 'now' : '';
      });
      counter.textContent = `${index + 1} / ${flat.length}`;
      prevBtn.disabled = index === 0;
      nextBtn.textContent = index < flat.length - 1 ? 'הבא ←' : 'יאללה, למשימון ✓';
      drawNav();
    }

    function go(i) {
      if (i < 0 || i >= flat.length || i === index) return;
      dir = i > index ? 1 : -1;
      index = i;
      drawStage();
    }

    const body = el('div.wn', {}, [
      el('div.wn-head', {}, [
        el('div.wn-glow', { 'aria-hidden': 'true' }),
        el('div.wn-head-row', {}, [
          el('div', {}, [
            el('div.wn-eyebrow', { text: preview ? '👁 תצוגה מקדימה' : '✨ מה חדש במשימון' }),
            el('h1.wn-h1', { text: head.title || 'ללא כותרת' }),
            head.summary ? el('div.wn-summary', { text: head.summary }) : null
          ]),
          el('button.wn-skip', { type: 'button', onclick: finish }, ['דלג'])
        ]),
        progress
      ]),
      el('div.wn-main', {}, [nav, stage]),
      el('div.wn-foot', {}, [
        prevBtn,
        counter,
        el('div.spacer'),
        el('button.btn.btn-ghost.wn-later', { type: 'button', onclick: finish }, ['ישר למשימון']),
        nextBtn
      ])
    ]);

    body.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea')) return;
      // ב-RTL "הבא" הוא שמאלה
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index + 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(index - 1); }
    });

    // החלקה בטלפון: ימינה — הקודם, שמאלה — הבא
    let touchX = null;
    stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1));
    });

    m = UI.modal({
      title: null,
      label: `מה חדש במשימון: ${head.title}`,
      body,
      size: 'wn',
      autofocus: false,
      onClose: () => {
        if (done) return;
        done = true;
        spot?.destroy();
        if (markSeen) {
          App.state.whatsNewPending = 0;
          API.post('/api/whats-new/seen').catch(() => {});
        }
      }
    });
    // אחרי שהחלון במסך: הזרקור מודד את המסגרת שלו כדי להתאים אליה את המסך המוטמע
    drawStage();
    setTimeout(() => nextBtn.focus({ preventScroll: true }), 60);
  }

  // ------------------------------------------------------------- ניהול

  /** דחיסת צילום מסך בדפדפן — רוחב עד 1400, ‎JPEG‎ — כדי שלא יכביד על המסד */
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file?.type?.startsWith('image/')) return reject(new Error('יש לבחור קובץ תמונה'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('קריאת התמונה נכשלה'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('התמונה אינה תקינה'));
        img.onload = () => {
          const scale = Math.min(1, 1400 / img.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const g = canvas.getContext('2d');
          g.fillStyle = '#ffffff';
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.84));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** סריקת AI — מחזירה הצעה, או זורקת שגיאה עם הסבר */
  const runScan = (range = 'last') => API.post('/api/admin/releases/scan', { range });

  /**
   * מאיזה זמן לסרוק — לפני הסריקה. "מאז ההודעה האחרונה" היא ברירת המחדל;
   * "24 השעות האחרונות" — כשרוצים רק את מה שנכנס היום. מחזיר את הבחירה, או
   * ‎null‎ כשנסגר בלי לבחור.
   */
  function pickRange() {
    return new Promise((resolve) => {
      let done = false;
      const pick = (v) => { done = true; m.close(); resolve(v); };
      const date = el('input', { type: 'date' });
      const m = UI.modal({
        title: '✨ מאיזה זמן לסרוק את החידושים?',
        body: el('div.today-pick', {}, [
          el('button.btn.btn-block.btn-primary', { type: 'button', onclick: () => pick('last') }, ['מאז ההודעה האחרונה שפורסמה']),
          el('button.btn.btn-block', { type: 'button', onclick: () => pick('24h') }, ['24 השעות האחרונות']),
          el('button.btn.btn-block', { type: 'button', onclick: () => pick('7d') }, ['השבוע האחרון']),
          el('button.btn.btn-block', { type: 'button', onclick: () => pick('30d') }, ['30 הימים האחרונים']),
          el('div.today-pick-other', {}, [
            UI.field('מתאריך', date),
            el('button.btn', { type: 'button', onclick: () => date.value && pick(date.value) }, ['סריקה'])
          ])
        ]),
        autofocus: false,
        onClose: () => { if (!done) resolve(null); }
      });
    });
  }

  /** שורת ההסבר בראש העורך: מה ה-AI עשה, או למה הוא לא רץ */
  function scanNote(result, error) {
    if (error) return el('div.alert.alert-warn.wn-ed-note', {}, [el('div', { text: `סריקת ה-AI נכשלה: ${error.message}. אפשר לכתוב את הפריטים ידנית.` })]);
    if (!result) return null;
    if (!result.enabled) {
      return el('div.alert.alert-info.wn-ed-note', {}, [el('div', { text: 'חיבור ה-AI אינו מוגדר בשרת, ולכן הטיוטה נפתחת ריקה. אפשר לכתוב את הפריטים ידנית.' })]);
    }
    const since = UI.formatDate(result.since);
    const src = { git: 'היסטוריית git', file: 'changelog.json', 'git+file': 'git ו-changelog.json' }[result.source] ?? 'אין מקור';
    // עד מתי ההיסטוריה מגיעה — כך רואים מיד אם המקור לא מעודכן
    const upTo = result.latest ? `, האחרון מ-${UI.formatDateTime(result.latest)}` : '';
    if (!result.commits) return el('div.alert.alert-info.wn-ed-note', {}, [el('div', { text: `לא נמצאו שינויים במערכת מאז ${since} (${src}).` })]);
    if (!result.items.length) {
      return el('div.alert.alert-info.wn-ed-note', {}, [el('div', { text: `נסרקו ${result.commits} שינויים מאז ${since} (${src}${upTo}), ולא נמצא ביניהם חידוש שמשתמשים רואים.` })]);
    }
    return el('div.alert.alert-info.wn-ed-note', {}, [el('div', {}, [
      el('b', { text: `✨ ה-AI הציע ${result.items.length} פריטים` }),
      ` מתוך ${result.commits} שינויים מאז ${since} (${src}${upTo}). עברו על כל פריט, תקנו ובדקו את המקום במסך שה-AI בחר — ורק אז שמרו.`
    ])]);
  }

  /**
   * "גרסה חדשה" — ברירת המחדל היא סריקת AI. חלון המתנה קצר, ואז העורך
   * נפתח עם ההצעה. בלי AI, או כשהסריקה נכשלה, העורך נפתח ריק עם הסבר.
   */
  async function newRelease(screens, onSaved, aiEnabled) {
    if (!aiEnabled) return editor(null, screens, onSaved, { scan: { enabled: false } });
    const range = await pickRange();
    if (!range) return;
    const wait = UI.modal({
      title: 'סורק מה השתנה במערכת…',
      body: el('div.wn-scan', {}, [
        UI.spinner(),
        el('div', { text: 'ה-AI עובר על השינויים מאז ההודעה האחרונה ומכין טיוטה. זה לוקח עד דקה.' })
      ]),
      autofocus: false
    });
    let result = null;
    let error = null;
    try { result = await runScan(range); } catch (err) { error = err; }
    // סגירה ידנית של חלון ההמתנה מבטלת — לא קופצים לעורך מתחת לידיים
    if (!wait.backdrop.isConnected) return;
    wait.close();
    editor(result?.items?.length
      ? { title: result.title, summary: result.summary, items: result.items }
      : null, screens, onSaved, { scan: result, scanError: error });
  }

  /**
   * רשימת העוגנים לבחירה, בקבוצות לפי מסך — באותו סדר כמו המסכים בבאנר.
   * עוגן שנשמר ואינו בקטלוג עוד (שונה שם בקוד) מוצג כ"לא מוכר", כדי שלא
   * ייעלם מהעורך בשקט.
   */
  function anchorOptions(screens, current) {
    const groups = screens.map((s) => ({
      label: `${s.icon} ${s.label}`,
      options: Spotlight.catalog.filter((a) => a.screen === s.key).map((a) => ({ value: a.key, label: a.label }))
    })).filter((g) => g.options.length);
    const unknown = current && !Spotlight.anchorOf(current) ? [{ value: current, label: `⚠ עוגן לא מוכר (${current})` }] : [];
    return [{ value: '', label: '— בלי עוגן (צילום מסך במקום) —' }, ...unknown, ...groups];
  }

  /** פריט שאפשר לפרסם — יש לו מקום במסך, או לפחות צילום */
  const showable = (i) => Boolean(Spotlight.anchorOf(i.anchor) || i.image || i.hasImage);

  function editor(release, screens, onSaved, { scan = null, scanError = null } = {}) {
    const isEdit = !!release?.id;
    const items = (release?.items ?? []).map((i) => ({ audience: 'all', ...i }));
    if (!items.length) items.push({ screen: 'general', title: '', body: '', image: null, audience: 'all' });
    const audiences = audiencesCache ?? { all: { label: 'כולם' } };

    const titleInput = el('input', { type: 'text', placeholder: 'למשל: עדכון נובמבר — יומן, אלפון ו-Today' });
    titleInput.value = release?.title ?? '';
    const summaryInput = el('textarea', { rows: '2', placeholder: 'משפט פתיחה קצר (לא חובה)' });
    summaryInput.value = release?.summary ?? '';
    const list = el('div.wn-ed-list');
    const note = el('div', {}, [scanNote(scan, scanError)]);

    function drawList() {
      UI.mount(list, items.map((item, i) => {
        const screenSel = UI.select(screens.map((s) => ({ value: s.key, label: `${s.icon} ${s.label}` })), item.screen);
        screenSel.addEventListener('change', () => { item.screen = screenSel.value; });
        const audSel = UI.select(Object.entries(audiences).map(([value, a]) => ({ value, label: a.label })), item.audience ?? 'all');
        audSel.addEventListener('change', () => { item.audience = audSel.value; });
        /*
         * העוגן — המקום במסך שהבאנר יתקרב אליו. מהרשימה, או "בחירה על המסך".
         * פריט כללי שמקבל עוגן עובר למסך של העוגן, כדי שיקובץ במקום הנכון.
         */
        const anchorSel = UI.select(anchorOptions(screens, item.anchor), item.anchor ?? '');
        anchorSel.addEventListener('change', () => {
          item.anchor = anchorSel.value || null;
          const a = Spotlight.anchorOf(item.anchor);
          if (a && (!item.screen || item.screen === 'general')) item.screen = a.screen;
          drawList();
        });
        const pickBtn = el('button.btn.wn-ed-pick', {
          type: 'button',
          title: 'המסך נפתח — לוחצים על המקום שבו נמצא החידוש',
          onclick: () => pickOnScreen(i)
        }, ['🎯 בחירה על המסך']);
        const t = el('input', { type: 'text', placeholder: 'מה נוסף? (כותרת)' });
        t.value = item.title;
        t.addEventListener('input', () => { item.title = t.value; });
        const b = el('textarea', { rows: '3', placeholder: 'הסבר קצר: מה זה, איפה זה, ולמה זה טוב' });
        b.value = item.body ?? '';
        b.addEventListener('input', () => { item.body = b.value; });

        const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        const setImage = async (file) => {
          try { item.image = await compressImage(file); drawList(); } catch (err) { UI.error(err); }
        };
        fileInput.addEventListener('change', () => fileInput.files[0] && setImage(fileInput.files[0]));

        const shot = el('div.wn-ed-shot', {
          tabindex: '0',
          role: 'button',
          'aria-label': 'צילום מסך לפריט: לחיצה לבחירת קובץ, גרירה, או הדבקה ב-Ctrl+V',
          title: 'לחיצה לבחירת תמונה, גרירה, או הדבקה (Ctrl+V) של צילום מסך',
          onclick: () => fileInput.click(),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
          onpaste: (e) => {
            const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
            if (file) { e.preventDefault(); setImage(file); }
          },
          ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
          ondragleave: (e) => e.currentTarget.classList.remove('over'),
          ondrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('over');
            const file = e.dataTransfer?.files?.[0];
            if (file) setImage(file);
          }
        }, item.image
          ? [el('img', { src: item.image, alt: '' })]
          : [el('div', { text: '🖼️' }), el('div.mute-sm', { text: 'צילום מסך להמחשה' }), el('div.mute-sm', { text: 'לחיצה / גרירה / Ctrl+V' })]);

        const ok = showable(item);
        return el(`div.wn-ed-item${ok ? '' : '.is-bare'}`, {}, [
          el('div.wn-ed-num', { text: String(i + 1) }),
          el('div.wn-ed-fields', {}, [
            el('div.row', {}, [UI.field('מסך', screenSel), UI.field('מי רואה', audSel)]),
            UI.field('כותרת', t),
            UI.field('תיאור', b),
            el('div.wn-ed-anchor', {}, [
              UI.field('איפה זה במסך — הבאנר יתקרב לשם', anchorSel),
              pickBtn
            ]),
            ok ? null : el('div.wn-ed-warn', { role: 'note' }, [
              '⚠ אין לפריט מקום במסך או צילום — לא ניתן לפרסם את הגרסה עד שיהיה אחד מהם'
            ])
          ]),
          el('div.wn-ed-side', {}, [
            shot, fileInput,
            item.image ? el('button.btn.btn-sm', { type: 'button', onclick: () => { item.image = null; drawList(); } }, ['הסרת התמונה']) : null,
            el('div.wn-ed-tools', {}, [
              el('button.btn.btn-sm', { type: 'button', title: 'למעלה', 'aria-label': 'הזזת הפריט למעלה', disabled: i === 0,
                onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; drawList(); } }, ['↑']),
              el('button.btn.btn-sm', { type: 'button', title: 'למטה', 'aria-label': 'הזזת הפריט למטה', disabled: i === items.length - 1,
                onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; drawList(); } }, ['↓']),
              el('button.btn.btn-sm.btn-danger', { type: 'button', title: 'מחיקת הפריט', 'aria-label': 'מחיקת הפריט',
                onclick: () => { items.splice(i, 1); drawList(); } }, ['✕'])
            ])
          ])
        ]);
      }));
    }
    drawList();

    const collect = () => ({
      title: titleInput.value.trim(),
      summary: summaryInput.value.trim(),
      items: items
        .map((i) => ({
          screen: i.screen, audience: i.audience ?? 'all', anchor: i.anchor || null,
          title: String(i.title ?? '').trim(), body: String(i.body ?? '').trim(), image: i.image ?? null
        }))
        .filter((i) => i.title || i.body || i.image)
    });

    /*
     * סריקה נוספת מתוך העורך — מוסיפה את ההצעות לסוף הרשימה ואינה דורסת את
     * מה שכבר נכתב. פריט שכותרתו כבר קיימת אינו נוסף פעמיים.
     */
    const scanBtn = el('button.btn', { type: 'button', title: 'ה-AI סורק מה השתנה מאז ההודעה האחרונה ומוסיף הצעות' }, ['✨ הצע לי חידושים עם AI']);
    scanBtn.addEventListener('click', async () => {
      const range = await pickRange();
      if (!range) return;
      scanBtn.disabled = true;
      const label = scanBtn.textContent;
      scanBtn.textContent = 'סורק…';
      try {
        const res = await runScan(range);
        UI.mount(note, scanNote(res, null));
        const have = new Set(items.map((i) => String(i.title ?? '').trim()));
        // פריט ריק יחיד (עורך חדש) מפנה את מקומו להצעות
        if (items.length === 1 && !items[0].title && !items[0].body && !items[0].image) items.length = 0;
        for (const s of res.items ?? []) if (!have.has(s.title)) items.push({ ...s });
        if (!items.length) items.push({ screen: 'general', title: '', body: '', image: null, audience: 'all' });
        if (!titleInput.value.trim() && res.title) titleInput.value = res.title;
        if (!summaryInput.value.trim() && res.summary) summaryInput.value = res.summary;
        drawList();
      } catch (err) {
        UI.mount(note, scanNote(null, err));
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = label;
      }
    });

    /**
     * "🎯 בחירה על המסך": העורך נסגר, המסך של הפריט נפתח לבחירה, ובסוף
     * העורך נפתח מחדש עם כל מה שנכתב בו — ועם העוגן שנבחר.
     */
    async function pickOnScreen(i) {
      const snapshot = {
        ...(release ?? {}),
        title: titleInput.value,
        summary: summaryInput.value,
        items: items.map((x) => ({ ...x }))
      };
      const back = { name: App.state.route.name, params: { ...App.state.route.params } };
      const item = snapshot.items[i];
      const current = Spotlight.anchorOf(item.anchor);
      const s = screens.find((x) => x.key === item.screen);
      m.close();
      const key = await Spotlight.pick({
        route: current?.route ?? s?.route ?? null,
        params: current?.params ?? null,
        current: current?.key ?? null
      });
      App.navigate(back.name, back.params);
      if (key) {
        item.anchor = key;
        const a = Spotlight.anchorOf(key);
        if (!item.screen || item.screen === 'general') item.screen = a.screen;
        UI.success(`נבחר: ${a.label}`);
      }
      editor(snapshot, screens, onSaved);
    }

    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, [isEdit ? 'שמירת השינויים' : 'שמירה כטיוטה']);
    const previewBtn = el('button.btn', { type: 'button' }, ['👁 תצוגה מקדימה']);
    const m = UI.modal({
      title: isEdit ? `עריכת "${release.title}"` : 'גרסה חדשה — מה נוסף?',
      size: 'wide',
      body: el('div', {}, [
        note,
        UI.field('כותרת הגרסה', titleInput),
        UI.field('תקציר', summaryInput),
        el('h4.wn-ed-h', { text: 'הפריטים — כל פריט משויך למסך שבו הוא נמצא, ולקהל שיראה אותו' }),
        list,
        el('button.btn.mt', { type: 'button', onclick: () => {
          const last = items[items.length - 1];
          items.push({ screen: last?.screen ?? 'general', title: '', body: '', image: null, audience: 'all' });
          drawList();
          list.lastElementChild?.querySelector('input[type=text]')?.focus();
        } }, ['＋ פריט ידני'])
      ]),
      footer: [saveBtn, previewBtn, el('div.spacer'), App.state.whatsNewAi ? scanBtn : null]
    });

    previewBtn.addEventListener('click', () => {
      const data = collect();
      if (!data.items.length) return UI.toast('אין עדיין פריטים להצגה', 'error');
      show([{ ...data, id: 0 }], { markSeen: false, preview: true });
    });

    saveBtn.addEventListener('click', async () => {
      const data = collect();
      if (!data.title) return UI.toast('נדרשת כותרת לגרסה', 'error');
      if (data.items.some((i) => !i.title)) return UI.toast('לכל פריט נדרשת כותרת', 'error');
      saveBtn.disabled = true;
      try {
        if (isEdit) await API.put(`/api/admin/releases/${release.id}`, data);
        else await API.post('/api/admin/releases', data);
        m.close();
        UI.success('נשמר');
        onSaved();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  // המונה של משלוח שרץ ברקע מתעדכן בלי לרענן ידנית
  let pollTimer = null;

  async function adminTab(body, reload) {
    clearTimeout(pollTimer);
    const data = await API.get('/api/admin/releases');
    screensCache = data.screens;
    audiencesCache = data.audiences;
    // העורך מציג את כפתור הסריקה רק כשיש AI
    App.state.whatsNewAi = data.aiEnabled;
    const screens = data.screens;

    const card = (r) => {
      const published = r.status === 'published';
      const counts = {};
      for (const i of r.items) counts[i.screen] = (counts[i.screen] ?? 0) + 1;
      const limited = r.items.filter((i) => i.audience && i.audience !== 'all');
      // פריטים בלי עוגן ובלי צילום — חוסמים פרסום (וגם השרת חוסם)
      const bare = r.items.filter((i) => !showable(i));

      const act = async (fn, okMsg) => {
        try { await fn(); if (okMsg) UI.success(okMsg); reload(); } catch (err) { UI.error(err); }
      };

      return el('div.card.wn-admin-card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: r.title }),
          el(`span.tag${published ? '.tag-internal' : ''}`, {},
            [published ? `פורסם ${UI.formatDate(r.publishedAt)}` : 'טיוטה']),
          r.emailedAt ? el('span.tag', { title: UI.formatDateTime(r.emailedAt) },
            [r.sending ? `✉ נשלח ל-${r.emailedCount} מתוך ${r.emailedTotal}…` : `✉ נשלח ל-${r.emailedCount}${r.emailedTotal && r.emailedTotal !== r.emailedCount ? ` מתוך ${r.emailedTotal}` : ''} · ${UI.formatDate(r.emailedAt)}`]) : null,
          el('div.spacer'),
          el('button.btn.btn-sm', { onclick: () => editor(r, screens, reload) }, ['✎ עריכה']),
          el('button.btn.btn-sm', { onclick: () => open({ preview: r }) }, ['👁 תצוגה']),
          el('button.btn.btn-sm.btn-danger', {
            onclick: async () => {
              if (!await UI.confirm(`למחוק את "${r.title}"?`, { danger: true, okText: 'מחיקה' })) return;
              act(() => API.del(`/api/admin/releases/${r.id}`), 'נמחק');
            }
          }, ['מחיקה'])
        ]),
        r.summary ? el('div.mute-sm', { text: r.summary }) : null,
        el('div.wn-admin-chips', {}, [
          ...Object.entries(counts).map(([k, n]) => {
            const s = screens.find((x) => x.key === k) ?? { icon: '✨', label: k };
            return el('span.wn-chip', { text: `${s.icon} ${s.label} · ${n}` });
          }),
          limited.length ? el('span.wn-chip.wn-chip-aud', {
            text: `🔒 ${limited.length} לקהל מצומצם`,
            title: limited.map((i) => `${i.title} — ${audienceLabel(i.audience)}`).join('\n')
          }) : null,
          bare.length ? el('span.wn-chip.wn-chip-warn', {
            text: `⚠ ${bare.length === 1 ? 'פריט אחד' : `${bare.length} פריטים`} בלי מקום במסך או צילום`,
            title: bare.map((i) => i.title).join('\n')
          }) : null
        ]),
        el('div.wn-admin-actions', {}, [
          published
            ? el('button.btn.btn-sm', { onclick: () => act(() => API.post(`/api/admin/releases/${r.id}/publish`, { publish: false }), 'הוחזר לטיוטה') }, ['החזרה לטיוטה'])
            : el('button.btn.btn-sm.btn-primary', {
              disabled: bare.length > 0,
              title: bare.length ? 'לכל פריט צריך מקום במסך (עוגן) או צילום — "✎ עריכה" כדי להשלים' : '',
              onclick: async () => {
                if (!await UI.confirm('מהרגע הזה הבאנר ייפתח לכל משתמש בכניסה הבאה שלו (עם אפשרות לדלג). כל משתמש יראה רק את הפריטים שמיועדים לו.', { title: 'פרסום הגרסה', okText: 'פרסום' })) return;
                act(() => API.post(`/api/admin/releases/${r.id}/publish`, {}), 'פורסם — הבאנר יוצג לכולם');
              }
            }, ['🚀 פרסום']),
          el('button.btn.btn-sm', {
            disabled: !data.mailEnabled,
            onclick: () => act(async () => {
              const res = await API.post(`/api/admin/releases/${r.id}/email`, { test: true });
              UI.success(`מייל בדיקה נשלח אל ${res.to}`);
            })
          }, ['✉ מייל בדיקה אליי']),
          el('button.btn.btn-sm', {
            disabled: !data.mailEnabled || !published || r.sending,
            title: !published ? 'יש לפרסם קודם' : '',
            onclick: async () => {
              const again = r.emailedAt ? `\nשימו לב: הגרסה כבר נשלחה ב-${UI.formatDateTime(r.emailedAt)}.` : '';
              if (!await UI.confirm(`לשלוח מייל "מה חדש" אל ${r.recipients} המשתמשים הפעילים?${again}`, { title: 'שליחה לכל המשתמשים', okText: 'שליחה' })) return;
              act(async () => {
                const res = await API.post(`/api/admin/releases/${r.id}/email`, {});
                UI.success(`המשלוח התחיל — ${res.total} נמענים. המונה יתעדכן תוך כדי.`);
              });
            }
          }, ['📣 שליחה במייל לכל המשתמשים'])
        ])
      ]);
    };

    UI.mount(body,
      el('div.flex', { style: { marginBottom: '14px', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1', minWidth: '240px' } }, [
          el('b', { text: 'הודעות "מה חדש"' }),
          el('div.mute-sm', { text: data.aiEnabled
            ? '"גרסה חדשה" סורקת עם AI מה השתנה במערכת מאז ההודעה האחרונה ומכינה טיוטה, כולל המקום במסך של כל חידוש. עוברים עליה, מפרסמים — וכל משתמש יראה באנר בכניסה הבאה, עם המסך שלו מוגדל על החידוש.'
            : 'כותבים מה נוסף, ולכל פריט בוחרים את המקום במסך (או מצרפים צילום). מפרסמים — וכל משתמש יראה באנר בכניסה הבאה, עם המסך שלו מוגדל על החידוש. אפשר גם לשלוח לכולם במייל.' })
        ]),
        el('button.btn', { onclick: () => editor(null, screens, reload) }, ['גרסה ריקה']),
        el('button.btn.btn-primary', { onclick: () => newRelease(screens, reload, data.aiEnabled) },
          [data.aiEnabled ? '✨ גרסה חדשה' : '＋ גרסה חדשה'])
      ]),
      data.mailEnabled ? null : el('div.alert.alert-info', { style: { marginBottom: '12px' } }, [
        el('div', { text: 'שליחת דואר אינה מוגדרת (SMTP), ולכן כפתורי המייל כבויים. הבאנר עובד גם בלי.' })
      ]),
      data.releases.length
        ? el('div.wn-admin-list', {}, data.releases.map(card))
        : UI.empty('עוד לא נכתבה אף גרסה. "גרסה חדשה" כדי להתחיל.', '✨')
    );

    if (data.releases.some((r) => r.sending)) {
      pollTimer = setTimeout(() => { if (body.isConnected) reload(); }, 4000);
    }
  }

  return { open, maybeShow, adminTab };
})();
