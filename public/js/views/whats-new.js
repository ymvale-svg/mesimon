'use strict';
/**
 * "מה חדש" — הבאנר שנפתח באמצע המסך אחרי הכניסה, ולשונית העריכה שלו
 * בניהול המערכת (לאדמין על בלבד).
 *
 * הבאנר מקבץ את הפריטים לפי מסך: רשימת מסכים בצד, ובמרכז פריט אחד בכל פעם
 * עם סרטון ההדמיה שלו. פריטים של גרסאות ישנות, בלי סרטון, מוצגים ב"זרקור" —
 * המסך החי של המשתמש, מוגדל על מקום החידוש (‎Spotlight‎) — או בצילום שצורף
 * להם. פס התקדמות, "נסו עכשיו" שלוקח ישר למסך ו"הראו לי" שמדגיש את החידוש
 * במסך האמיתי. הוא
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
      /*
       * סרטון ההדמיה — מתנגן לבד, בלי קול ובלולאה. מי שביקש במערכת ההפעלה
       * להפחית תנועה מקבל את התמונה הראשונה וכפתור ניגון, בלי ניגון אוטומטי.
       */
      if (item.video) {
        if (spot) spot.node.hidden = true;
        altMedia.hidden = false;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const video = el('video', {
          src: item.video, poster: item.poster ?? null, muted: true, loop: true, playsinline: true,
          preload: 'auto', autoplay: !still, controls: still, 'aria-label': `הדמיה: ${item.title}`
        });
        video.muted = true; // התכונה לבדה אינה מספיקה לחלק מהדפדפנים כדי לנגן לבד
        UI.mount(altMedia, el('div.wn-shot.wn-shot-video', {}, [
          el('div.wn-shot-bar', {}, [el('i'), el('i'), el('i'), el('span', { text: s.label })]),
          video
        ]));
        if (!still) video.play().catch(() => { video.controls = true; });
        return;
      }
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

  /*
   * הגרסאות אינן נכתבות כאן: כל גרסה מגיעה עם הקוד, כולל סרטון הדמיה לכל
   * פריט, ונוצרת כטיוטה בעצמה. בעורך משתנה רק הניסוח — כותרת ותקציר, וכותרת
   * ותיאור לכל פריט — והסרטון מוצג לידו, כדי לראות על מה מדברים.
   */
  function editor(release, onSaved) {
    const items = release.items.map((i) => ({ ...i }));
    const titleInput = el('input', { type: 'text' });
    titleInput.value = release.title ?? '';
    const summaryInput = el('textarea', { rows: '2', placeholder: 'משפט פתיחה קצר (לא חובה)' });
    summaryInput.value = release.summary ?? '';

    const list = el('div.wn-ed-list', {}, items.map((item, i) => {
      const s = screenOf(item.screen);
      const t = el('input', { type: 'text' });
      t.value = item.title;
      t.addEventListener('input', () => { item.title = t.value; });
      const b = el('textarea', { rows: '3' });
      b.value = item.body ?? '';
      b.addEventListener('input', () => { item.body = b.value; });
      return el('div.wn-ed-item', {}, [
        el('div.wn-ed-num', { text: String(i + 1) }),
        el('div.wn-ed-fields', {}, [
          el('div.wn-ed-meta', {}, [
            el('span.wn-chip', { text: `${s.icon} ${s.label}` }),
            item.audience && item.audience !== 'all' ? el('span.wn-chip.wn-chip-aud', { text: `🔒 ${audienceLabel(item.audience)}` }) : null
          ]),
          UI.field('כותרת', t),
          UI.field('תיאור', b)
        ]),
        item.video
          ? el('video.wn-ed-video', { src: item.video, poster: item.poster ?? null, muted: true, loop: true, playsinline: true, preload: 'metadata', controls: true })
          : el('div.wn-ed-novideo.mute-sm', { text: 'פריט מגרסה קודמת, בלי סרטון' })
      ]);
    }));

    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, ['שמירת הניסוח']);
    const previewBtn = el('button.btn', { type: 'button' }, ['👁 תצוגה מקדימה']);
    const collect = () => ({
      title: titleInput.value.trim(),
      summary: summaryInput.value.trim(),
      items: items.map((i) => ({ title: String(i.title ?? '').trim(), body: String(i.body ?? '').trim() }))
    });
    const m = UI.modal({
      title: `תיקון ניסוח — "${release.title}"`,
      size: 'wide',
      body: el('div', {}, [
        UI.field('כותרת הגרסה', titleInput),
        UI.field('תקציר', summaryInput),
        el('h4.wn-ed-h', { text: 'הפריטים — הסרטון והמסך הגיעו עם הגרסה; כאן משנים רק את הניסוח' }),
        list
      ]),
      footer: [saveBtn, previewBtn]
    });

    previewBtn.addEventListener('click', () => {
      const d = collect();
      show([{ ...release, ...d, items: items.map((i, n) => ({ ...i, ...d.items[n] })) }], { markSeen: false, preview: true });
    });
    saveBtn.addEventListener('click', async () => {
      const data = collect();
      if (!data.title) return UI.toast('נדרשת כותרת לגרסה', 'error');
      if (data.items.some((i) => !i.title)) return UI.toast('לכל פריט נדרשת כותרת', 'error');
      saveBtn.disabled = true;
      try {
        await API.put(`/api/admin/releases/${release.id}`, data);
        m.close();
        UI.success('נשמר');
        onSaved();
      } catch (err) { saveBtn.disabled = false; UI.error(err); }
    });
  }

  /** פריט שאפשר לפרסם — יש לו סרטון, או (בגרסאות ישנות) מקום במסך או צילום */
  const showable = (i) => Boolean(i.video || Spotlight.anchorOf(i.anchor) || i.image || i.hasImage);

  // המונה של משלוח שרץ ברקע מתעדכן בלי לרענן ידנית
  let pollTimer = null;

  async function adminTab(body, reload) {
    clearTimeout(pollTimer);
    const data = await API.get('/api/admin/releases');
    screensCache = data.screens;
    audiencesCache = data.audiences;
    const screens = data.screens;

    const card = (r) => {
      const published = r.status === 'published';
      const counts = {};
      for (const i of r.items) counts[i.screen] = (counts[i.screen] ?? 0) + 1;
      const limited = r.items.filter((i) => i.audience && i.audience !== 'all');
      // פריטים בלי הדמיה — חוסמים פרסום (וגם השרת חוסם)
      const bare = r.items.filter((i) => !showable(i));
      const videos = r.items.filter((i) => i.video).length;

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
          el('button.btn.btn-sm', { onclick: () => editor(r, reload) }, ['✎ ניסוח']),
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
          videos ? el('span.wn-chip', { text: `🎬 ${videos === r.items.length ? 'סרטון לכל פריט' : `${videos} סרטונים`}` }) : null,
          limited.length ? el('span.wn-chip.wn-chip-aud', {
            text: `🔒 ${limited.length} לקהל מצומצם`,
            title: limited.map((i) => `${i.title} — ${audienceLabel(i.audience)}`).join('\n')
          }) : null,
          bare.length ? el('span.wn-chip.wn-chip-aud', {
            text: `⚠ ${bare.length === 1 ? 'פריט אחד' : `${bare.length} פריטים`} בלי סרטון`,
            title: bare.map((i) => i.title).join('\n')
          }) : null
        ]),
        el('div.wn-admin-actions', {}, [
          published
            ? el('button.btn.btn-sm', { onclick: () => act(() => API.post(`/api/admin/releases/${r.id}/publish`, { publish: false }), 'הוחזר לטיוטה') }, ['החזרה לטיוטה'])
            : el('button.btn.btn-sm.btn-primary', {
              disabled: bare.length > 0,
              title: bare.length ? 'לכל פריט צריך סרטון הדמיה' : '',
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
          el('div.mute-sm', { text: 'כל גרסה מגיעה מוכנה עם עדכון המערכת — מלל וסרטון הדמיה לכל חידוש — ומחכה כאן כטיוטה. צופים בתצוגה המקדימה, מתקנים ניסוח אם צריך, ומפרסמים: כל משתמש יראה את הבאנר בכניסה הבאה שלו. אפשר גם לשלוח לכולם במייל.' })
        ])
      ]),
      data.mailEnabled ? null : el('div.alert.alert-info', { style: { marginBottom: '12px' } }, [
        el('div', { text: 'שליחת דואר אינה מוגדרת (SMTP), ולכן כפתורי המייל כבויים. הבאנר עובד גם בלי.' })
      ]),
      data.releases.length
        ? el('div.wn-admin-list', {}, data.releases.map(card))
        : UI.empty('אין כרגע גרסה. הגרסה הבאה תופיע כאן עם עדכון המערכת.', '✨')
    );

    if (data.releases.some((r) => r.sending)) {
      pollTimer = setTimeout(() => { if (body.isConnected) reload(); }, 4000);
    }
  }

  return { open, maybeShow, adminTab };
})();
