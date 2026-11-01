'use strict';
/**
 * "זרקור" — הצבעה על מקום במסך לפי עוגן מהקטלוג (‎feature-anchors.js‎).
 *
 * שלושה שימושים, קוד אחד שיודע לנווט, להכין ולמצוא את האלמנט:
 *
 *   stage()   — בבאנר "מה חדש": המסך החי של המשתמש בתוך ‎iframe‎ מוקטן, עם
 *               התקרבות בהנפשה אל האלמנט, טבעת מהבהבת ועמעום של כל השאר.
 *               למה ‎iframe‎ של המערכת עצמה ולא צילום: כל עובד רואה את הנתונים
 *               שלו (לא של המנהל), והתמונה לעולם אינה מתיישנת.
 *   showMe()  — "הראו לי": הבאנר נסגר, והאלמנט מודגש במסך האמיתי.
 *   pick()    — בעורך: מנהל המערכת לוחץ על אלמנט במסך, וזה העוגן של הפריט.
 *
 * מצב ‎?embed=spot‎ הוא הצד השני של ‎stage()‎: המערכת נטענת בתוך הבאנר
 * לתצוגה בלבד. היא אינה מקבלת לחיצות ומקשים, אינה שולחת לשרת שום בקשה
 * שמשנה משהו, אינה מפעילה התראות, סקרים או Service Worker, ואינה פותחת
 * באנר בתוך באנר. היא רק מנווטת, מכינה, מוצאת ומדווחת היכן האלמנט.
 */
const Spotlight = (() => {
  const { el } = UI;

  const embedded = new URLSearchParams(location.search).get('embed') === 'spot' && window.parent !== window;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  const catalog = window.FeatureAnchors ?? [];
  const byKey = new Map(catalog.map((a) => [a.key, a]));
  const anchorOf = (key) => (key ? byKey.get(key) ?? null : null);
  const selectorOf = (a) => a.selector ?? `[data-anchor="${a.key}"]`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ------------------------------------------------------------- מציאת האלמנט

  /**
   * גלוי ממש — לא ‎display:none‎, לא בגודל אפס (חלופה למחשב כשאנחנו בטלפון),
   * ולא מחוץ לרוחב המסך: מגירת הניווט הסגורה בטלפון מוזזת הצידה, ואליה
   * אי אפשר לגלול.
   */
  function visible(node) {
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.left >= innerWidth) return false;
    const cs = getComputedStyle(node);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function findNow(a) {
    try {
      return [...document.querySelectorAll(selectorOf(a))].find(visible) ?? null;
    } catch {
      return null; // בורר שהדפדפן אינו מכיר (‎:has‎ בדפדפן ישן) — כאילו לא נמצא
    }
  }

  /**
   * ממתינים לאלמנט עד ‎timeout‎ — אבל מסך שסיים להיטען (אין בו ספינר כבר
   * שנייה) ועדיין אין בו את האלמנט, כנראה לא יציג אותו: לא מחכים לחינם.
   */
  async function waitFor(a, timeout, alive = () => true) {
    const start = Date.now();
    let calmSince = null;
    for (;;) {
      if (!alive()) return null;
      const node = findNow(a);
      const now = Date.now();
      if (node || now - start > timeout) return node;
      calmSince = document.querySelector('.spinner') ? null : calmSince ?? now;
      if (calmSince && now - calmSince > 1000 && now - start > 1400) return null;
      await sleep(120);
    }
  }

  /**
   * האלמנט, או העוגן החלופי כשהוא אינו קיים אצל המשתמש הזה (רשימה ריקה,
   * חתימה שמופיעה רק אחרי ניסוח). המסך נטען ברקע, ולכן ממתינים — אבל לא
   * יותר מכמה שניות: מסך שבו האלמנט פשוט אינו קיים לא ייטען אותו לעולם.
   */
  async function locate(a, alive) {
    const node = await waitFor(a, a.fallback ? 2600 : 3800, alive);
    if (node) return { node, exact: true };
    const fb = anchorOf(a.fallback);
    const other = fb ? await waitFor(fb, 800, alive) : null;
    return other ? { node: other, exact: false } : null;
  }

  // ------------------------------------------------------------- הכנה

  const clickFirst = (selector) => {
    const node = [...document.querySelectorAll(selector)].find(visible);
    node?.click();
    return node;
  };

  async function waitSelector(selector, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const node = [...document.querySelectorAll(selector)].find(visible);
      if (node || Date.now() > end) return node ?? null;
      await sleep(120);
    }
  }

  /**
   * פעולות ההכנה. בבאנר הן רצות בתוך המערכת המוטמעת, שבה שום שינוי אינו
   * מגיע לשרת — ולכן "פתיחת משימת AI" שם היא חלון ריק לתצוגה בלבד. ב"הראו
   * לי" הן רצות במערכת האמיתית, וזו בדיוק הכוונה: החלון נפתח באמת.
   */
  const PREPARE = {
    account: () => clickFirst('.user-chip'),
    notifications: () => {
      if (!document.querySelector('#notif-panel, .notif-sheet')) clickFirst('.notif-bell, .tabbar button:nth-child(4)');
    },
    search: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true })),
    aiTask: () => AiTaskView.openDialog(),
    newTask: () => BoardView.openTaskDialog(),
    taskCard: async () => {
      const row = await waitSelector('main [data-task-id]', 3500);
      if (row) await TaskCardView.open(Number(row.dataset.taskId));
    },
    timeline: async () => {
      const sw = await waitSelector('main .view-switch', 3500);
      const btn = sw?.querySelectorAll('button')[2];
      if (btn && !btn.classList.contains('active')) btn.click();
    }
  };

  async function prepare(a) {
    const fn = PREPARE[a.prepare];
    if (!fn) return;
    try { await fn(); } catch { /* הכנה שנכשלה — מחפשים בכל זאת, ונופלים לחלופה */ }
    // חלון שנפתח עדיין בהנפשת הכניסה; מדידה עכשיו הייתה תופסת אותו באמצע
    await sleep(260);
  }

  /** סגירת כל מה שפתוח מעל המסך — חלונות, מגירת ההתראות */
  function closeOverlays() {
    for (const layer of UI.openLayers?.() ?? []) layer.close();
    if (document.getElementById('notif-panel')) clickFirst('.notif-bell');
  }

  /**
   * המלבן שמתקרבים אליו. שורת כפתורים ברוחב כל המסך (המסננים באלפון,
   * בחירת המחלקה בדוחות) תופסת את כל הרוחב, אבל התוכן שלה בפינה אחת — אז
   * מתקרבים לתוכן ולא לשורה הריקה.
   */
  function focusRect(node) {
    const r = node.getBoundingClientRect();
    const kids = [...node.children].map((c) => c.getBoundingClientRect()).filter((k) => k.width > 1 && k.height > 1);
    if (!kids.length) return r;
    const left = Math.min(...kids.map((k) => k.left));
    const right = Math.max(...kids.map((k) => k.right));
    const top = Math.min(...kids.map((k) => k.top));
    const bottom = Math.max(...kids.map((k) => k.bottom));
    if (right - left > r.width * 0.7) return r;
    return { left, top, width: right - left, height: Math.max(bottom - top, 1) };
  }

  // ------------------------------------------------------------- מצב מוטמע

  function post(msg) {
    window.parent.postMessage({ ...msg, spot: true }, location.origin);
  }

  if (embedded) {
    document.documentElement.classList.add('spot-embed');
    /*
     * תצוגה בלבד, בשתי שכבות. האחת — שום בקשה שמשנה נתונים אינה יוצאת
     * לשרת: לא העדפה שנשמרת כשהלוח נמדד, ולא "נקרא" על התראה. השנייה —
     * שום לחיצה או מקש אמיתיים אינם מגיעים למסך (הבאנר ממילא חוסם את
     * הסמן). לחיצות שהקוד עצמו יוזם בהכנה (‎isTrusted‎ שקרי) עוברות.
     */
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const method = String(opts.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return Promise.resolve(new Response(JSON.stringify({ error: 'תצוגה בלבד' }), {
          status: 403, headers: { 'content-type': 'application/json' }
        }));
      }
      return realFetch(url, opts);
    };
    for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'touchstart', 'keydown', 'submit', 'contextmenu', 'dragstart']) {
      window.addEventListener(type, (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, { capture: true, passive: false });
    }
    window.open = () => null;
  }

  let embedToken = 0;

  /**
   * בקשה מהבאנר: לנווט למסך של העוגן, להכין, למצוא ולמדוד. בקשה חדשה
   * מבטלת את הקודמת (מעבר מהיר בין פריטים).
   */
  async function embedShow({ key, seq }) {
    const token = ++embedToken;
    const alive = () => token === embedToken;
    const a = anchorOf(key);
    if (!a) return post({ type: 'spot:rect', seq, found: 'none' });
    closeOverlays();
    App.navigate(a.route ?? 'home', a.params ? { ...a.params } : {});
    await sleep(60);
    if (a.prepare) await prepare(a);
    if (!alive()) return;
    const hit = await locate(a, alive);
    if (!alive()) return;
    if (!hit) return post({ type: 'spot:rect', seq, found: 'none', vw: innerWidth, vh: innerHeight });

    hit.node.scrollIntoView({ block: 'center', inline: 'nearest' });
    // מחכים שהפריסה תתייצב: שתי מדידות זהות ברצף, או עד שנייה וחצי
    let last = null;
    for (let i = 0; i < 12; i++) {
      await frame();
      await sleep(110);
      if (!alive() || !hit.node.isConnected) break;
      const r = hit.node.getBoundingClientRect();
      const now = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
      if (now === last) break;
      last = now;
    }
    if (!alive()) return;
    const r = focusRect(hit.node);
    post({
      type: 'spot:rect', seq, found: hit.exact ? 'exact' : 'fallback',
      rect: { x: r.left, y: r.top, w: r.width, h: r.height }, vw: innerWidth, vh: innerHeight
    });
  }

  function embedBoot() {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (e.data?.type === 'spot:show') embedShow(e.data);
    });
    App.navigate('home');
    post({ type: 'spot:ready' });
  }

  const embedFail = () => post({ type: 'spot:fail' });

  // ------------------------------------------------------------- הבמה בבאנר

  // גודל ה"מסך" שבתוך המסגרת: מחשב רגיל, או טלפון
  const DESKTOP_W = 1280;
  const PHONE_W = 390;
  const PHONE_H = 820;

  /**
   * במת הזרקור — אלמנט אחד שנשאר בבאנר לאורך כל הפריטים, עם ‎iframe‎ אחד:
   * בין פריט לפריט רק מבקשים מהמערכת המוטמעת לנווט, בלי לטעון אותה מחדש.
   * ‎onFail‎ — המערכת לא עלתה (חיבור, סשן) — הבאנר עובר לצילום או לאייקון.
   */
  function stage({ onFail = () => {} } = {}) {
    const ring = el('div.wn-spot-ring', { 'aria-hidden': 'true' });
    let iframe = null;
    const cam = el('div.wn-spot-cam', {}, [ring]);
    const label = el('span.wn-spot-label');
    const note = el('div.wn-spot-note', { 'aria-live': 'polite' });
    const loader = el('div.wn-spot-load', { 'aria-hidden': 'true' }, [el('div.spinner'), el('span', { text: 'טוען את המסך שלך…' })]);
    const view = el('div.wn-spot-view', {}, [cam, loader, note]);
    const node = el('div.wn-spot', { role: 'img' }, [
      el('div.wn-shot-bar', {}, [el('i'), el('i'), el('i'), label]),
      view
    ]);

    let ready = false;
    let failed = false;
    let seq = 0;
    let want = null;      // העוגן המבוקש כרגע
    let vp = null;        // 'desktop' | 'phone'
    let size = { w: DESKTOP_W, h: 800 };
    let shot = null;      // התוצאה האחרונה, לחישוב מחדש בשינוי גודל
    let zoomTimer = null;
    let loadTimer = null;
    let bootTimer = null;

    const box = () => view.getBoundingClientRect();

    function onMessage(e) {
      if (e.origin !== location.origin || e.source !== iframe?.contentWindow || !e.data?.spot) return;
      const d = e.data;
      if (d.type === 'spot:ready') {
        ready = true;
        clearTimeout(bootTimer);
        if (want) request();
      } else if (d.type === 'spot:fail') {
        fail();
      } else if (d.type === 'spot:rect' && d.seq === seq) {
        landed(d);
      }
    }
    window.addEventListener('message', onMessage);

    function fail() {
      if (failed) return;
      failed = true;
      clearTimeout(bootTimer);
      onFail();
    }

    /** הקטנה שמכניסה את כל המסך למסגרת */
    function fitTransform() {
      const b = box();
      const s = Math.min(b.width / size.w, b.height / size.h);
      return { s, x: (b.width - size.w * s) / 2, y: Math.max(0, (b.height - size.h * s) / 2) };
    }

    function apply(t, { instant = false } = {}) {
      cam.classList.toggle('no-anim', instant || REDUCED.matches);
      cam.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
      cam.style.setProperty('--s', String(t.s));
    }

    function ensureFrame(nextVp) {
      const b = box();
      if (nextVp === 'phone') size = { w: PHONE_W, h: PHONE_H };
      // גובה המסך המדומה לפי יחס המסגרת — כך המסך ממלא אותה בלי פסים
      else size = { w: DESKTOP_W, h: Math.round(Math.min(900, Math.max(620, DESKTOP_W * (b.height / Math.max(1, b.width))))) };
      node.classList.toggle('is-phone', nextVp === 'phone');
      if (!iframe) {
        iframe = el('iframe.wn-spot-frame', {
          src: '/?embed=spot',
          title: 'המסך שלך',
          tabindex: '-1',
          'aria-hidden': 'true',
          loading: 'eager'
        });
        iframe.inert = true;
        cam.insertBefore(iframe, ring);
        // מערכת שלא עלתה תוך זמן סביר — לא משאירים ספינר לנצח
        bootTimer = setTimeout(() => { if (!ready) fail(); }, 15000);
      }
      iframe.style.width = `${size.w}px`;
      iframe.style.height = `${size.h}px`;
      cam.style.width = `${size.w}px`;
      cam.style.height = `${size.h}px`;
      vp = nextVp;
    }

    function request() {
      if (!ready || !want || failed) return;
      seq += 1;
      iframe.contentWindow.postMessage({ type: 'spot:show', key: want.key, seq }, location.origin);
    }

    /** מעבר לפריט: מתרחקים אל המסך כולו, והמערכת המוטמעת עוברת למסך הבא */
    function show(key, { caption = '' } = {}) {
      const a = anchorOf(key);
      if (!a || failed) return false;
      want = a;
      shot = null;
      clearTimeout(zoomTimer);
      clearTimeout(loadTimer);
      label.textContent = caption || a.label;
      node.setAttribute('aria-label', `המסך שלך, עם הדגשה של: ${a.label}`);
      note.classList.remove('on');
      ring.classList.remove('on');
      node.classList.remove('is-zoomed');
      const nextVp = a.viewport === 'phone' || (typeof App !== 'undefined' && App.isPhone()) ? 'phone' : 'desktop';
      ensureFrame(nextVp);
      apply(fitTransform());
      // הספינר רק כשבאמת מחכים — מעבר מהיר בין פריטים אינו מהבהב
      loadTimer = setTimeout(() => loader.classList.add('on'), ready ? 700 : 150);
      request();
      return true;
    }

    /** התשובה מהמערכת המוטמעת: היכן האלמנט — ואז התקרבות אליו */
    function landed(d) {
      clearTimeout(loadTimer);
      loader.classList.remove('on');
      shot = d;
      if (d.found === 'none' || !d.rect) {
        apply(fitTransform());
        note.textContent = 'החידוש אינו מופיע אצלך במסך כרגע — זה המסך שבו הוא נמצא';
        note.classList.add('on');
        return;
      }
      // רגע של המסך כולו, ואז התקרבות — כך רואים מאיפה באנו
      zoomTimer = setTimeout(() => zoomTo(d.rect), REDUCED.matches ? 0 : 380);
    }

    function zoomTo(r) {
      const b = box();
      const fit = fitTransform();
      const pad = vp === 'phone' ? 8 : 14;
      const w = r.w + pad * 2;
      const h = r.h + pad * 2;
      const max = vp === 'phone' ? 1.5 : 1.1;
      let s = Math.min(max, (b.width * 0.8) / w, (b.height * 0.72) / h);
      s = Math.max(s, fit.s);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const x = size.w * s <= b.width ? (b.width - size.w * s) / 2 : clamp(b.width / 2 - s * cx, b.width - size.w * s, 0);
      const y = size.h * s <= b.height ? (b.height - size.h * s) / 2 : clamp(b.height / 2 - s * cy, b.height - size.h * s, 0);
      Object.assign(ring.style, {
        left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${w}px`, height: `${h}px`
      });
      apply({ s, x, y });
      node.classList.add('is-zoomed');
      ring.classList.add('on');
    }

    // שינוי גודל החלון — מחשבים מחדש את ההתקרבות למסגרת החדשה
    const ro = new ResizeObserver(() => {
      if (!want || !iframe) return;
      if (shot?.rect) zoomTo(shot.rect);
      else apply(fitTransform(), { instant: true });
    });
    ro.observe(view);

    function destroy() {
      window.removeEventListener('message', onMessage);
      ro.disconnect();
      clearTimeout(zoomTimer);
      clearTimeout(loadTimer);
      clearTimeout(bootTimer);
      iframe?.remove();
      iframe = null;
    }

    return { node, show, destroy, get failed() { return failed; } };
  }

  // ------------------------------------------------------------- "הראו לי"

  let showing = null;

  /**
   * במסך האמיתי: מנווטים, מכינים, גוללים אל האלמנט ומדגישים אותו עם
   * בועית של שם החידוש. ההדגשה דועכת מעצמה, ונעלמת בכל לחיצה או מקש —
   * והלחיצה עצמה עוברת לאלמנט, כך שאפשר ללחוץ ישר על מה שהודגש.
   */
  async function showMe(key, title = '') {
    const a = anchorOf(key);
    if (!a) return;
    showing?.();
    if (a.route) App.navigate(a.route, a.params ? { ...a.params } : {});
    await sleep(60);
    if (a.prepare) await prepare(a);
    const hit = await locate(a, () => true);
    if (!hit) {
      UI.toast('החידוש אינו מופיע אצלך במסך כרגע');
      return;
    }
    hit.node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: REDUCED.matches ? 'auto' : 'smooth' });
    await sleep(REDUCED.matches ? 50 : 420);
    highlight(hit.node, title || a.label);
  }

  function highlight(target, title) {
    const ring = el('div.spot-hl', { 'aria-hidden': 'true' });
    const tip = el('div.spot-tip', { role: 'status' }, [el('span.spot-tip-badge', { text: 'חדש' }), el('span', { text: title })]);
    document.body.append(ring, tip);

    let raf = 0;
    const place = () => {
      if (!target.isConnected) return done();
      const r = target.getBoundingClientRect();
      const pad = 6;
      Object.assign(ring.style, {
        left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`
      });
      // הבועית מתחת לאלמנט, ואם אין שם מקום — מעליו
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const below = r.bottom + pad + 10 + th < innerHeight;
      const left = Math.min(innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
      Object.assign(tip.style, { left: `${left}px`, top: `${below ? r.bottom + pad + 10 : r.top - pad - 10 - th}px` });
      tip.classList.toggle('above', !below);
      raf = requestAnimationFrame(place);
    };

    let ended = false;
    function done() {
      if (ended) return;
      ended = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      document.removeEventListener('pointerdown', done, true);
      document.removeEventListener('keydown', done, true);
      showing = null;
      ring.classList.add('out');
      tip.classList.add('out');
      setTimeout(() => { ring.remove(); tip.remove(); }, 320);
    }
    showing = done;
    place();
    requestAnimationFrame(() => { ring.classList.add('on'); tip.classList.add('on'); });
    const timer = setTimeout(done, 6500);
    // הלחיצה שפתחה את "הראו לי" כבר מאחורינו; כל לחיצה מכאן — סוגרת
    setTimeout(() => {
      if (ended) return;
      document.addEventListener('pointerdown', done, true);
      document.addEventListener('keydown', done, true);
    }, 0);
  }

  // ------------------------------------------------------------- בחירה על המסך

  /** העוגן של אלמנט — הקרוב ביותר אליו בעץ, מבין העוגנים שבקטלוג */
  function anchorAt(target) {
    for (let n = target; n && n !== document.body; n = n.parentElement) {
      for (const a of catalog) {
        try { if (n.matches(selectorOf(a))) return { a, node: n }; } catch { /* בורר לא נתמך */ }
      }
    }
    return null;
  }

  // החלונות שאפשר לפתוח מפס הבחירה — ‎[הכנה, כיתוב, מסך שצריך להיות בו, סמל]‎
  const OPENERS = [
    ['account', 'החשבון שלי', null, 'user'],
    ['aiTask', 'משימת AI', null, 'sparkles'],
    ['newTask', 'משימה חדשה', null, 'plus'],
    ['taskCard', 'כרטיס משימה', 'board', 'note'],
    ['notifications', 'התראות', null, 'bell']
  ];

  /**
   * "🎯 בחירה על המסך" בעורך. המסך נפתח במקום שבו הפריט נמצא (או במסך
   * שלו), וכל אלמנט שיש לו עוגן מסומן בקו מקווקו. ריחוף — מסגרת ושם; לחיצה —
   * בחירה. לחיצה על כל דבר אחר עובדת כרגיל, כדי שאפשר יהיה לנווט ולפתוח
   * חלון (למשל משימת AI) ולבחור בתוכו. ‎Esc‎ — ביטול.
   *
   * מחזיר את מפתח העוגן שנבחר, או ‎null‎.
   */
  function pick({ route = null, params = null, current = null } = {}) {
    return new Promise((resolve) => {
      const cur = anchorOf(current);
      if (route) App.navigate(route, params ? { ...params } : {});

      const box = el('div.spot-pick-box', { 'aria-hidden': 'true' });
      // השם יושב מחוץ למסגרת, כדי שאפשר יהיה להצמיד אותו לגבולות המסך
      const name = el('div.spot-pick-name', { 'aria-hidden': 'true' });
      const cancel = el('button.btn.btn-sm', { type: 'button' }, ['ביטול']);
      /*
       * פתיחת חלון מתוך הפס: הכפתור שפותח את "החשבון שלי" הוא בעצמו עוגן,
       * ולחיצה עליו בוחרת אותו במקום לפתוח. כאן פותחים בלי לבחור.
       */
      const openers = el('div.spot-pick-open', {}, [
        el('span', { text: 'פתיחת חלון:' }),
        ...OPENERS.map(([kind, text, route, icon]) => el('button.btn.btn-sm', {
          type: 'button',
          onclick: async () => {
            closeOverlays();
            if (route && App.state.route.name !== route) App.navigate(route);
            await prepare({ prepare: kind });
          }
        }, [UI.lineIcon(icon), text]))
      ]);
      const bar = el('div.spot-pick-bar', { role: 'dialog', 'aria-label': 'בחירת מקום במסך' }, [
        el('div.spot-pick-row', {}, [
          el('span.spot-pick-icon', { text: '🎯' }),
          el('div', {}, [
            el('b', { text: 'לחצו על המקום שבו נמצא החידוש' }),
            el('div.spot-pick-sub', { text: 'המקומות שאפשר לבחור מסומנים בקו מקווקו. אפשר לעבור מסך כרגיל · Esc לביטול' })
          ]),
          cancel
        ]),
        openers
      ]);
      document.body.append(box, name, bar);
      document.documentElement.classList.add('spot-picking');

      // הסימון מתעדכן כל הזמן: מסכים נטענים ברקע, וחלונות נפתחים ונסגרים
      const mark = () => {
        for (const n of document.querySelectorAll('.spot-pickable')) n.classList.remove('spot-pickable');
        for (const a of catalog) {
          try {
            for (const n of document.querySelectorAll(selectorOf(a))) if (!bar.contains(n)) n.classList.add('spot-pickable');
          } catch { /* בורר לא נתמך */ }
        }
      };
      mark();
      const marker = setInterval(mark, 700);

      const onMove = (e) => {
        const hit = bar.contains(e.target) ? null : anchorAt(e.target);
        if (!hit) { box.classList.remove('on'); name.classList.remove('on'); return; }
        const r = hit.node.getBoundingClientRect();
        Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
        name.textContent = hit.a.label;
        const nw = name.offsetWidth;
        const nh = name.offsetHeight;
        const top = r.top - nh - 10 >= 4 ? r.top - nh - 10 : Math.min(innerHeight - nh - 4, r.bottom + 10);
        Object.assign(name.style, {
          left: `${Math.min(innerWidth - nw - 8, Math.max(8, r.right - nw))}px`,
          top: `${top}px`
        });
        box.classList.add('on');
        name.classList.add('on');
      };
      // לחיצה שהקוד יזם (פתיחת חלון מהפס) אינה בחירה — רק לחיצה של אדם
      const swallow = (e) => {
        if (!e.isTrusted || bar.contains(e.target)) return;
        if (anchorAt(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
      };
      const onClick = (e) => {
        if (!e.isTrusted || bar.contains(e.target)) return;
        const hit = anchorAt(e.target);
        if (!hit) return; // לא עוגן — הלחיצה עוברת כרגיל (ניווט, פתיחת חלון)
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(hit.a.key);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(null);
      };
      cancel.addEventListener('click', () => finish(null));

      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerdown', swallow, true);
      document.addEventListener('mousedown', swallow, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);

      let ended = false;
      function finish(key) {
        if (ended) return;
        ended = true;
        clearInterval(marker);
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerdown', swallow, true);
        document.removeEventListener('mousedown', swallow, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        for (const n of document.querySelectorAll('.spot-pickable')) n.classList.remove('spot-pickable');
        document.documentElement.classList.remove('spot-picking');
        box.remove();
        name.remove();
        bar.remove();
        // חלון שנפתח לצורך הבחירה (משימת AI, החשבון שלי) נסגר איתה
        closeOverlays();
        resolve(key);
      }

      // העוגן הנוכחי בתוך חלון — פותחים אותו, כדי שאפשר יהיה לבחור שם שוב
      if (cur?.prepare) setTimeout(() => { if (!ended) prepare(cur); }, 120);
    });
  }

  return { embedded, catalog, anchorOf, stage, showMe, pick, embedBoot, embedFail };
})();
