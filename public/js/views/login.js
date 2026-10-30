'use strict';
/** מסך ההתחברות. */

const LoginView = (() => {
  const { el } = UI;

  /*
   * ---------------------------------------------------------- אזור המיתוג
   *
   * המרכז הוא הלוגו של משימון עצמו — האריח, השם והסלוגן — ולא סמל אחר
   * לצדו. כל האינטראקציה יושבת על הלוגו: שני הלוחות שבאריח (הצורה מהלוגו
   * של אשל הירדן) מתרוממים זה מעל זה כשהסמן מתקרב, האריח והשם נוטים אליו
   * בעומקים שונים, וברק עובר על האריח במקום שהסמן מצביע עליו.
   *
   * המכניקה מועתקת לונילה משלושה רכיבים ב-21st.dev:
   * - Tilt — הטיה תלת־ממדית אחרי הסמן עם קפיץ (‎useSpring‎ שם, ‎spring()‎ כאן).
   * - Isometric Cube — שכבות שמתרוממות עם הסמן ושוקעות חזרה ביציאה; כאן
   *   אלה שני הלוחות שבסמל, העליון יותר מהתחתון.
   * - Tweenly Hero Background (סגנון dots) — רשת נקודות על canvas שנדחפות
   *   מהסמן, גדלות ומתבהרות ברדיוס ~140px, עם קפיץ ודעיכה לכל נקודה.
   *
   * ביצועים: לולאת rAF אחת לכל החלקים, והיא נעצרת ברגע שהכול נח. הנשימה
   * האיטית ברקע היא אנימציית CSS על שכבת זוהר (‎transform‎ בלבד), כדי שהמסך
   * לא ייראה מת בלי עכבר — בלי להחזיק את ה-JS ער כשאיש לא נוגע במסך.
   */

  const LIFT = 3.2;          // הרמה מרבית של הלוח העליון, ביחידות של הסמל (64); התחתון ×0.45
  const DROP = 16;           // מאיפה הלוחות נוחתים בכניסה, באותן יחידות
  const TILT = 10;           // הטיה מרבית במעלות
  const DOT_GAP = 26;        // מרווח רשת הנקודות
  const DOT_R = 1.25;        // רדיוס נקודה במנוחה
  const REACH = 140;         // רדיוס ההשפעה של הסמן על הנקודות

  /**
   * קפיץ במקום מעבר CSS: יעד שמשתנה באמצע תנועה ממשיך מהמהירות הנוכחית
   * ולא מתחיל עקומה חדשה מאפס — זה מה שנותן לרכיב Tilt את התחושה ה"חיה".
   */
  const spring = (x, k = 120, c = 14) => ({ x, v: 0, to: x, k, c });
  function stepSpring(s, dt) {
    s.v += (s.k * (s.to - s.x) - s.c * s.v) * dt;
    s.x += s.v * dt;
    // סף מנוחה — בלעדיו הקפיץ "רועד" באלפיות פיקסל לנצח והלולאה לא נעצרת
    if (Math.abs(s.to - s.x) < 0.002 && Math.abs(s.v) < 0.002) { s.x = s.to; s.v = 0; return false; }
    return true;
  }

  /**
   * הלוגו של אזור המיתוג וההפניות לחלקים שזזים בו. הלוגו הוא ‎UI.logo‎ כמו
   * בכל מקום אחר — לא עותק — כדי שסמל שישתנה שם ישתנה גם כאן.
   *
   * ‎UI.logoMark‎ מצייר את הסמל כ: אריח, ואז ארבעה מצולעים (פאה ופאה לכל
   * לוח, העליון קודם), ואז הווי. אם הסדר שם משתנה — גם כאן.
   */
  function heroLogo() {
    const logo = UI.logo({ size: 'lg', tagline: true, variant: 'light' });
    const tile = logo.querySelector('.logo-mark');
    const svg = tile.querySelector('svg');
    const polys = [...svg.querySelectorAll('polygon')];
    const check = svg.querySelector('path');
    // אורך נורמלי של 1, כדי שציור הווי יהיה פשוט ‎dashoffset‎ מ-1 ל-0
    check.setAttribute('pathLength', '1');
    check.style.strokeDasharray = '1';

    // השם מתפרק לאותיות כדי שייכנסו אחת-אחת. ‎aria-label‎ על המכל — קורא
    // מסך שמקריא אות-אות "M E S I M O N" גרוע מהשם עצמו (האזור מוסתר ממילא)
    const name = logo.querySelector('.app-logo-name');
    const word = name.textContent;
    name.textContent = '';
    [...word].forEach((ch, i) => {
      const letter = el('span.hero-letter', { text: ch });
      letter.style.setProperty('--n', i);
      name.appendChild(letter);
    });

    const sheen = el('span.hero-sheen');
    tile.appendChild(sheen);
    return {
      node: el('div.hero-logo', { 'aria-hidden': 'true' }, [logo]),
      logo, tile,
      slabs: [polys.slice(0, 2), polys.slice(2, 4)],
      check
    };
  }

  /**
   * מחבר את ההתנהגות לאזור המיתוג. מחזיר ‎settle()‎ — אנימציית "הלוחות
   * נסגרים" לאחר כניסה מוצלחת — ו-‎destroy()‎.
   */
  function bindHero(hero, canvas, mark) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');

    // --- מצב הלוגו
    const tiltX = spring(0), tiltY = spring(0);
    const lift = spring(0, 160, 18);       // 0..1 — כמה הלוחות נפרדים
    const gap = spring(1, 220, 22);        // 1 = רווח מנוחה, 0 = צמודים (בכניסה מוצלחת)
    // ציור הווי: 1 = לא צויר, 0 = מלא. מתחיל אחרי שהלוחות נחתו
    const draw = spring(reduced ? 0 : 1, 90, 16);
    // ירידה בכניסה: התחתון נוחת קודם והעליון 110ms אחריו — כמו ערימה שנבנית
    const drop = [0, 1].map(() => spring(reduced ? 0 : 1, 170, 17));
    const t0 = performance.now();
    const dropAt = [t0 + 260, t0 + 150];   // לפי סדר הלוחות: העליון, התחתון
    const drawAt = t0 + 520;

    // --- מצב הנקודות (מערכים שטוחים — אלף נקודות בלי אלף אובייקטים)
    let W = 0, H = 0, n = 0, cols = 0;
    let hx, hy, ox, oy, vx, vy, sc, base;
    const ptr = { tx: 0, ty: 0, x: 0, y: 0, inside: false, presence: 0 };

    let raf = 0, last = 0, destroyed = false;

    function layoutDots() {
      const r = hero.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      // DPR מוגבל ל-2: מעבר לזה הקנבס גדל פי 2.25 ואין הבדל שהעין רואה בנקודות
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / DOT_GAP) + 1;
      const rows = Math.ceil(H / DOT_GAP) + 1;
      n = cols * rows;
      const x0 = (W - (cols - 1) * DOT_GAP) / 2, y0 = (H - (rows - 1) * DOT_GAP) / 2;
      hx = new Float32Array(n); hy = new Float32Array(n);
      ox = new Float32Array(n); oy = new Float32Array(n);
      vx = new Float32Array(n); vy = new Float32Array(n);
      sc = new Float32Array(n); base = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        hx[i] = x0 + (i % cols) * DOT_GAP;
        hy[i] = y0 + Math.floor(i / cols) * DOT_GAP;
        // שקיפות בסיס משתנה מעט בין נקודות, דטרמיניסטית — רשת אחידה לגמרי נראית כמו טפט
        const h = Math.sin(hx[i] * 12.9898 + hy[i] * 78.233) * 43758.5453;
        base[i] = 0.10 + (h - Math.floor(h)) * 0.10;
      }
    }

    /** השפעה חלקה 0..1 של הסמן על נקודה — smoothstep, כמו במקור */
    function influence(x, y) {
      if (ptr.presence < 0.002) return 0;
      const dx = x - ptr.x, dy = y - ptr.y, d2 = dx * dx + dy * dy;
      if (d2 >= REACH * REACH) return 0;
      const k = 1 - Math.sqrt(d2) / REACH;
      return k * k * (3 - 2 * k) * ptr.presence;
    }

    /** מקדם את הנקודות; מחזיר אמת אם משהו עדיין זז */
    function stepDots(dt) {
      const follow = 1 - Math.exp(-dt * 16);
      ptr.x += (ptr.tx - ptr.x) * follow;
      ptr.y += (ptr.ty - ptr.y) * follow;
      const target = ptr.inside ? 1 : 0;
      ptr.presence += (target - ptr.presence) * (1 - Math.exp(-dt * (ptr.inside ? 8 : 4)));
      if (!ptr.inside && ptr.presence < 0.003) ptr.presence = 0;

      const push = REACH * 0.15;     // דחיפה עדינה — חור גדול סביב הסמן נראה כמו באג
      const k = 170 * dt, damp = Math.exp(-13 * dt), ease = 1 - Math.exp(-dt * 10);
      let moving = ptr.presence > 0;
      for (let i = 0; i < n; i++) {
        const f = influence(hx[i], hy[i]);
        let tx = 0, ty = 0;
        if (f > 0) {
          const dx = hx[i] - ptr.x, dy = hy[i] - ptr.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          tx = (dx / d) * f * push; ty = (dy / d) * f * push;
        }
        vx[i] = (vx[i] + (tx - ox[i]) * k) * damp;
        vy[i] = (vy[i] + (ty - oy[i]) * k) * damp;
        ox[i] += vx[i] * dt; oy[i] += vy[i] * dt;
        sc[i] += (f - sc[i]) * ease;
        if (Math.abs(ox[i]) + Math.abs(oy[i]) > 0.02 || sc[i] > 0.003) moving = true;
        else { ox[i] = oy[i] = vx[i] = vy[i] = sc[i] = 0; }
      }
      return moving;
    }

    /*
     * ציור בקבוצות לפי רמת שקיפות: ‎fillStyle‎ ו-‎fill()‎ אחד לכל רמה, ולא
     * לכל נקודה — אותו טריק של המקור (palette buckets), פי עשרות פחות קריאות.
     */
    const LEVELS = 10;
    function drawDots() {
      ctx.clearRect(0, 0, W, H);
      const level = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const a = base[i] + sc[i] * 0.62;
        level[i] = Math.min(LEVELS - 1, Math.round(a * (LEVELS - 1) / 0.8));
      }
      for (let p = 0; p < LEVELS; p++) {
        ctx.fillStyle = `rgba(255, 255, 255, ${(p * 0.8 / (LEVELS - 1)).toFixed(3)})`;
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < n; i++) {
          if (level[i] !== p) continue;
          const r = DOT_R * (1 + sc[i] * 1.3);
          const x = hx[i] + ox[i], y = hy[i] + oy[i];
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
          any = true;
        }
        if (any) ctx.fill();
      }
    }

    function applyMark(now) {
      if (!reduced && now >= drawAt) draw.to = 0;
      // הרמה מצטברת: העליון עולה LIFT, התחתון פחות מחצי — "כל לוח נושא את שמעליו".
      // ‎gap‎ סוגר את הרווח בכניסה מוצלחת: העליון יורד אל התחתון
      const ups = [LIFT * lift.x - 2.5 * (1 - gap.x), LIFT * 0.45 * lift.x];
      mark.slabs.forEach((faces, i) => {
        if (!reduced && now >= dropAt[i]) drop[i].to = 0;
        const y = drop[i].x * DROP - ups[i];
        const t = `translateY(${y.toFixed(2)}px)`;
        // ‎opacity‎ יחד עם הנפילה — לוח שנופל מעבר לשפת האריח היה נחתך באמצע
        for (const f of faces) { f.style.transform = t; f.style.opacity = (1 - drop[i].x).toFixed(3); }
      });
      mark.check.style.strokeDashoffset = draw.x.toFixed(4);
      // האריח נוטה יותר מהשם (עומק שונה ב-CSS), ולכן הם זזים זה מול זה — פרלקסה
      mark.logo.style.transform = `rotateX(${tiltX.x.toFixed(2)}deg) rotateY(${tiltY.x.toFixed(2)}deg)`;
    }

    function frame(now) {
      raf = 0;
      // המסך הוחלף (כניסה הצליחה) — מפרקים הכול, גם בלי שה-MutationObserver הספיק
      if (!hero.isConnected) { destroy(); return; }
      if (document.hidden) return;              // חוזרים מ-visibilitychange
      const dt = last ? Math.min(Math.max((now - last) / 1000, 0.001), 1 / 30) : 1 / 60;
      last = now;

      let moving = false;
      for (const s of [tiltX, tiltY, lift, gap, draw, ...drop]) if (stepSpring(s, dt)) moving = true;
      // לוח שעוד לא "שוחרר" לנפילה, או וי שעוד לא התחיל, הם תנועה ממתינה ולא מנוחה
      if (dropAt.some((t, i) => now < t && drop[i].x > 0) || (now < drawAt && draw.x > 0)) moving = true;
      applyMark(now);
      if (W && stepDots(dt)) moving = true;
      if (W) drawDots();

      if (moving) raf = requestAnimationFrame(frame);
      else last = 0;
    }

    const wake = () => {
      if (reduced || destroyed || raf || document.hidden) return;
      raf = requestAnimationFrame(frame);
    };

    // --- קלט
    function onMove(e) {
      const r = hero.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      // הנקודה הראשונה אחרי כניסה קופצת למקום — אחרת הנקודות "נגררות" מהפינה
      if (!ptr.inside && ptr.presence < 0.02) { ptr.x = x; ptr.y = y; }
      ptr.tx = x; ptr.ty = y; ptr.inside = true;

      // ההטיה יחסית למרכז הלוגו ולא למרכז האזור: הסמן שמימין ללוגו מטה אותו ימינה
      const m = mark.node.getBoundingClientRect();
      const cx = m.left + m.width / 2, cy = m.top + m.height / 2;
      const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / (r.width / 2)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / (r.height / 2)));
      tiltY.to = nx * TILT;           // פונה אל הסמן
      tiltX.to = -ny * TILT;
      // הלוחות נפרדים ככל שהסמן קרוב יותר לאריח — לא מתג של "בפנים/בחוץ"
      const t = mark.tile.getBoundingClientRect();
      const d = Math.hypot(e.clientX - (t.left + t.width / 2), e.clientY - (t.top + t.height / 2));
      lift.to = Math.max(0.25, 1 - d / 420);
      // הברק על האריח — מיקום הסמן ביחס לאריח, באחוזים (CSS קורא אותו)
      mark.tile.style.setProperty('--sx', `${((e.clientX - t.left) / t.width * 100).toFixed(1)}%`);
      mark.tile.style.setProperty('--sy', `${((e.clientY - t.top) / t.height * 100).toFixed(1)}%`);
      mark.tile.classList.add('is-lit');
      wake();
    }
    function onLeave() {
      ptr.inside = false;
      tiltX.to = tiltY.to = lift.to = 0;
      mark.tile.classList.remove('is-lit');
      wake();
    }
    // במגע ‎pointermove‎ מגיע רק כשהאצבע על המסך, וביציאה מגיע ‎pointerup‎/‎cancel‎
    function onUp(e) { if (e.pointerType !== 'mouse') onLeave(); }
    const onVisible = () => { if (!document.hidden) wake(); };

    const ro = new ResizeObserver(() => {
      layoutDots();
      // ציור מיידי — שינוי גודל מנקה את הקנבס, ובמנוחה אין לולאה שתצייר מחדש
      if (reduced || !raf) drawDots();
    });

    // הוחלף המסך? ‎root‎ מרוקן ב-‎UI.mount‎ — אז ההורה של הדף משתנה
    const mo = new MutationObserver(() => { if (!hero.isConnected) destroy(); });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf); raf = 0;
      ro.disconnect(); mo.disconnect();
      hero.removeEventListener('pointermove', onMove);
      hero.removeEventListener('pointerdown', onMove);
      hero.removeEventListener('pointerleave', onLeave);
      hero.removeEventListener('pointerup', onUp);
      hero.removeEventListener('pointercancel', onLeave);
      document.removeEventListener('visibilitychange', onVisible);
    }

    function start() {
      ro.observe(hero);
      mo.observe(hero.closest('.login-page')?.parentNode || document.body, { childList: true });
      if (reduced) { applyMark(0); return; }
      hero.addEventListener('pointermove', onMove);
      hero.addEventListener('pointerdown', onMove);
      hero.addEventListener('pointerleave', onLeave);
      hero.addEventListener('pointerup', onUp);
      hero.addEventListener('pointercancel', onLeave);
      document.addEventListener('visibilitychange', onVisible);
      applyMark(performance.now());
      wake();
    }

    /**
     * "נסגר" אחרי כניסה מוצלחת: הלוחות נצמדים זה לזה והווי מצויר מחדש —
     * "המשימה סומנה". לעולם לא מעכב יותר
     * מ-420ms, ואם אין מה להראות (תנועה מופחתת, האזור מוסתר, לשונית ברקע)
     * חוזר מיד — הכניסה עצמה היא העיקר.
     */
    function settle() {
      if (reduced || destroyed || document.hidden || !hero.offsetParent) return Promise.resolve();
      ptr.inside = false;
      tiltX.to = tiltY.to = lift.to = 0;
      mark.tile.classList.remove('is-lit');
      gap.to = 0;
      lift.k = 260;
      // הווי נמחק ונצבע מחדש, מהיר מהציור של הכניסה
      draw.x = 1; draw.to = 0; draw.k = 260; draw.c = 30;
      wake();
      return new Promise((resolve) => setTimeout(resolve, 420));
    }

    return { start, settle, destroy };
  }

  // ------------------------------------------------------------ הטופס

  function passwordField(passInput) {
    const eye = () => UI.lineIcon(passInput.type === 'password' ? 'eye' : 'eye-off', { size: 18 });
    const toggle = el('button.pw-toggle', {
      type: 'button', 'aria-label': 'הצגת סיסמה', 'aria-pressed': 'false'
    }, [eye()]);
    toggle.addEventListener('click', () => {
      const show = passInput.type === 'password';
      passInput.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'הסתרת סיסמה' : 'הצגת סיסמה');
      UI.mount(toggle, eye());
      // הסמן חוזר לשדה ולסופו: מי שלחץ כדי לבדוק הקלדה ימשיך להקליד
      passInput.focus();
      const end = passInput.value.length;
      passInput.setSelectionRange?.(end, end);
    });
    return el('div.pw-wrap', {}, [passInput, toggle]);
  }

  function render(root, onSuccess) {
    const emailInput = el('input', { type: 'email', placeholder: 'name@eshel.co.il', autocomplete: 'username' });
    const passInput = el('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
    const errorBox = el('div.alert.alert-danger', { style: { display: 'none' } });
    const button = el('button.btn.btn-primary.btn-block', { type: 'submit' }, ['כניסה למערכת']);
    let hero = null;

    async function submit(e) {
      e?.preventDefault();
      errorBox.style.display = 'none';
      button.disabled = true;
      button.textContent = 'מתחבר…';
      try {
        await API.login(emailInput.value.trim(), passInput.value);
        // רק אחרי הצלחה; שגיאה עוברת ישר ל-catch בלי שום עיכוב
        await hero?.settle().catch(() => {});
        await onSuccess();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.style.display = 'flex';
        button.disabled = false;
        button.textContent = 'כניסה למערכת';
      }
    }

    const form = el('form.login-form', { onsubmit: submit, id: 'login-email-form' }, [
      UI.field('כתובת אימייל', emailInput),
      UI.field('סיסמה', passwordField(passInput)),
      button
    ]);

    /*
     * Google היא הדרך הראשית להתחבר, ואימייל וסיסמה הם הדרך המשנית.
     *
     * לכן כשהכניסה עם Google מוגדרת בשרת היא כפתור גדול בראש, והטופס מקופל
     * מאחורי כפתור טקסט קטן — מי שצריך אותו (ספק, חשבון ללא Google) פותח
     * אותו בלחיצה. כשהיא לא מוגדרת אין שום דבר לקפל: הטופס מוצג כרגיל והוא
     * הכפתור הראשי, אחרת המסך היה מציג דרך כניסה ראשית שאינה קיימת.
     *
     * עד שהשרת עונה לא מוצג אף אחד מהשניים (‎is-pending‎), כדי שהטופס לא
     * יהבהב ואז ייעלם. אם התשובה מתעכבת או נכשלת — הטופס מוצג; הכניסה
     * עצמה לא תלויה ב-Google.
     */
    const googleSlot = el('div.google-slot');
    const methods = el('div.login-methods.is-pending', {}, [googleSlot, form]);

    const showFormOnly = () => {
      methods.classList.remove('is-pending');
      emailInput.focus();
    };
    const fallback = setTimeout(showFormOnly, 1500);

    fetch('/api/branding').then((r) => r.json()).then((b) => {
      clearTimeout(fallback);
      if (!b.googleLogin) { showFormOnly(); return; }

      const toggle = el('button.email-toggle', {
        type: 'button', 'aria-expanded': 'false', 'aria-controls': 'login-email-form'
      }, ['כניסה עם אימייל וסיסמה']);
      toggle.addEventListener('click', () => {
        form.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        toggle.hidden = true;
        emailInput.focus();
      });

      form.hidden = true;
      // הכפתור של הטופס כבר אינו הראשי — Google היא הראשית, ושני כפתורים
      // מלאים זה מתחת לזה היו מתחרים על העין
      button.classList.remove('btn-primary');
      UI.mount(googleSlot,
        el('a.btn.btn-block.google-btn.google-btn-lg', { href: '/api/auth/google/start' }, [
          el('span.google-mark', {
            html: `<svg viewBox="0 0 48 48" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
              <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3z"/>
              <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8 41.3 15.4 46 24 46z"/>
              <path fill="#FBBC05" d="M11.8 28.4c-.4-1.3-.7-2.7-.7-4.4s.3-3.1.7-4.4v-5.7H4.5C2.9 17.1 2 20.4 2 24s.9 6.9 2.5 10.1l7.3-5.7z"/>
              <path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 30 2 24 2 15.4 2 8 6.7 4.5 13.9l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z"/>
            </svg>`
          }),
          'כניסה עם חשבון Google'
        ]),
        toggle
      );
      methods.classList.remove('is-pending');
    }).catch(showFormOnly);

    // הודעת שגיאה שחוזרת מזרימת Google
    const googleError = new URLSearchParams(location.search).get('googleError');
    if (googleError) {
      errorBox.textContent = googleError;
      errorBox.style.display = 'flex';
      history.replaceState(null, '', location.pathname);
    }

    // אזור המיתוג הוא קישוט בלבד — מוסתר מקוראי מסך ואין בו שום דבר שמקבל פוקוס
    const mark = heroLogo();
    const canvas = el('canvas.hero-dots', { 'aria-hidden': 'true' });
    const heroEl = el('div.login-hero', {}, [
      canvas,
      el('div.hero-glow', { 'aria-hidden': 'true' }),
      el('div.hero-center', {}, [mark.node])
    ]);

    const page = el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: 'ברוכים הבאים' }),
        el('p.muted', { text: 'התחברו כדי להמשיך לניהול המשימות והפרויקטים.' }),
        // השגיאה מחוץ לטופס: שגיאה שחוזרת מ-Google צריכה להיראות גם כשהטופס מקופל
        errorBox,
        methods
      ]),
      heroEl
    ]);

    UI.mount(root, page);
    UI.refitLogos();
    hero = bindHero(heroEl, canvas, mark);
    hero.start();
  }

  return { render };
})();
