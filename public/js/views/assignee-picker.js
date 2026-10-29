'use strict';
/**
 * בחירת אחראי בעיגולים — במקום רשימה נפתחת ארוכה.
 *
 * שורה של עד חמישה עיגולים: הראשון הוא מי שאני מטיל עליו הכי הרבה משימות
 * לאחרונה (גם אם זה אני), ואחריו הבאים בתור. "אני" נמצא תמיד בשורה. "＋ עוד"
 * פותח חיפוש על כל מי שמותר לי לשבץ, וספקים בתוכו.
 *
 *   לחיצה           — אחראי ראשי
 *   לחיצה ארוכה     — אחראי נוסף (סימן ＋ על העיגול); לחיצה ארוכה שוב מסירה.
 *                     במחשב גם Ctrl+לחיצה או לחיצה ימנית
 *
 * ה-‎select‎ המקורי נשאר מקור האמת, מוסתר: כל הקוד שקורא ‎select.value‎
 * ומאזין ל-‎change‎ ממשיך לעבוד כמו שהוא. העיגולים רק כותבים אליו.
 *
 * הדירוג מהשרת (‎/api/me/frequent-assignees‎), ונחתך כאן מול רשימת
 * האפשרויות — כלומר רק מי שמותר לי לשבץ.
 */

const AssigneePicker = (() => {
  const { el } = UI;
  const SHOWN = 5;
  const LONG_PRESS_MS = 480;

  let cache = null;
  /** הדירוג נטען פעם אחת, ונטען מחדש אחרי שנוצרה משימה */
  const frequent = () => {
    cache ??= API.get('/api/me/frequent-assignees').then((r) => r.items).catch(() => []);
    return cache;
  };
  const refresh = () => { cache = null; };

  /** אפשרויות שטוחות מתוך רשימה עם קבוצות */
  const flatten = (options) => options.flatMap((o) => (o.options ? o.options : [o])).filter((o) => o.value);

  const shortName = (label) => String(label).split(' — ')[0].replace(/\s*\(ספק חיצוני\)$/, '');
  const firstName = (label) => shortName(label).split(/\s+/)[0];

  /**
   * @param {object} opts
   * @param {HTMLSelectElement} opts.select     ה-select המקורי — מקור האמת
   * @param {Array} opts.options                 אותה רשימת אפשרויות של ה-select
   * @param {string[]} [opts.extras]             רשימת האחראים הנוספים (משתנה במקום)
   * @param {Function} [opts.onExtras]           נקרא אחרי שינוי באחראים הנוספים
   * @param {number} [opts.max]                 כמה עיגולים לפני "עוד" (בחלון צר — פחות)
   * @param {boolean} [opts.autoPick]            לבחור מעצמו את הראשון בדירוג
   *                                             (משימה חדשה בלי אחראי שנקבע מראש)
   */
  function create({ select, options, extras = null, onExtras = () => {}, autoPick = false, max = SHOWN }) {
    const all = flatten(options);
    const byValue = new Map(all.map((o) => [o.value, o]));
    const me = App.state.actor ? `user:${App.state.actor.id}` : '';
    let ranked = [];
    let pinned = [];   // מי שנבחר מ"עוד" ונשאר בשורה
    let touched = false;

    const row = el('div.ap-row', { role: 'group', 'aria-label': 'בחירת אחראי' });
    const hint = el('div.ap-hint.mute-sm', { text: extras ? 'לחיצה — אחראי · לחיצה ארוכה — אחראי נוסף' : '' });
    select.style.display = 'none';
    const node = el('div.ap', {}, [row, hint, select]);

    /** מי בשורה: הנבחר, הדירוג, אני, ומי שהוצמד מ"עוד" — בלי כפילויות */
    function shown() {
      const out = [];
      const add = (v) => { if (v && byValue.has(v) && !out.includes(v)) out.push(v); };
      ranked.forEach(add);
      if (!ranked.length) add(me);
      const head = out.slice(0, max);
      if (me && byValue.has(me) && !head.includes(me)) head.splice(Math.min(head.length, max - 1), 0, me);
      const extra = [select.value, ...(extras ?? []), ...pinned].filter((v) => v && byValue.has(v) && !head.includes(v));
      return [...head.slice(0, max), ...extra];
    }

    function setPrimary(value) {
      touched = true;
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      draw();
    }

    function toggleExtra(value) {
      if (!extras) return setPrimary(value);
      touched = true;
      if (value === select.value) return UI.toast('זה כבר האחראי הראשי');
      const at = extras.indexOf(value);
      if (at === -1) extras.push(value); else extras.splice(at, 1);
      onExtras();
      draw();
      try { navigator.vibrate?.(30); } catch { /* אין רטט */ }
    }

    function circle(value) {
      const o = byValue.get(value);
      const vendor = value.startsWith('vendor:');
      const isMe = value === me;
      const primary = select.value === value;
      const extra = extras?.includes(value);
      const label = isMe ? 'אני' : firstName(o.label);
      const b = el(`button.ap-circle${primary ? '.is-primary' : ''}${extra ? '.is-extra' : ''}`, {
        type: 'button',
        role: 'radio',
        'aria-checked': primary ? 'true' : 'false',
        'aria-label': `${shortName(o.label)}${primary ? ' — אחראי' : extra ? ' — אחראי נוסף' : ''}`,
        title: `${shortName(o.label)}${vendor ? ' (ספק)' : ''}${extras ? ' · לחיצה ארוכה — אחראי נוסף' : ''}`,
        'data-value': value
      }, [
        el(`span.ap-avatar${vendor ? '.is-vendor' : ''}${isMe ? '.is-me' : ''}`, {}, [isMe ? '👤' : UI.initials(shortName(o.label))]),
        extra ? el('span.ap-badge', { text: '＋' }) : null,
        primary ? el('span.ap-check', { text: '✓' }) : null,
        el('span.ap-name', { text: label })
      ]);

      // לחיצה ארוכה — אחראי נוסף. הלחיצה הרגילה שאחריה מבוטלת
      let timer = null;
      let longFired = false;
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        longFired = false;
        timer = setTimeout(() => { longFired = true; toggleExtra(value); }, LONG_PRESS_MS);
      });
      const cancel = () => clearTimeout(timer);
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointerleave', cancel);
      b.addEventListener('pointercancel', cancel);
      b.addEventListener('click', (e) => {
        if (longFired) { longFired = false; return; }
        if (e.ctrlKey || e.metaKey) return toggleExtra(value);
        setPrimary(value);
      });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!longFired) toggleExtra(value); });
      return b;
    }

    function moreButton() {
      return el('button.ap-circle.ap-more', { type: 'button', title: 'בחירה מכל הרשימה', onclick: openMore }, [
        el('span.ap-avatar', { text: '＋' }),
        el('span.ap-name', { text: 'עוד' })
      ]);
    }

    /** "＋ עוד" — חיפוש על כל הרשימה, בחלון קטן מתחת לשורה */
    let pop = null;
    function closeMore() { pop?.remove(); pop = null; }
    function openMore() {
      if (pop) return closeMore();
      const input = el('input', { type: 'search', placeholder: 'חיפוש שם…', autocomplete: 'off' });
      const list = el('div.ap-pop-list', { role: 'listbox' });
      let active = 0;
      let items = [];
      const choose = (value, asExtra) => {
        if (value && !shown().includes(value)) pinned.push(value);
        closeMore();
        if (asExtra && value) toggleExtra(value); else setPrimary(value);
      };
      const drawList = () => {
        const q = input.value.trim().toLowerCase();
        items = [{ value: '', label: 'ללא אחראי' }, ...all]
          .filter((o) => !q || o.label.toLowerCase().includes(q))
          .slice(0, 40);
        active = Math.min(active, Math.max(0, items.length - 1));
        UI.mount(list, ...(items.length ? items.map((o, i) => el(`div.ap-pop-row${i === active ? '.active' : ''}${select.value === o.value ? '.is-current' : ''}`, {
          role: 'option',
          onmousedown: (e) => { e.preventDefault(); choose(o.value, e.ctrlKey || e.metaKey); }
        }, [
          o.value ? el(`span.ap-avatar.sm${o.value.startsWith('vendor:') ? '.is-vendor' : ''}`, { text: UI.initials(shortName(o.label)) }) : el('span.ap-avatar.sm', { text: '–' }),
          el('span', { text: o.label }),
          o.value.startsWith('vendor:') ? el('span.tag', { text: 'ספק' }) : null
        ])) : [el('div.mute-sm', { text: 'לא נמצא', style: { padding: '8px' } })]));
      };
      input.addEventListener('input', () => { active = 0; drawList(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); drawList(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); drawList(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active].value, e.ctrlKey || e.metaKey); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMore(); }
      });
      input.addEventListener('blur', () => setTimeout(closeMore, 150));
      pop = el('div.ap-pop', {}, [input, list]);
      node.insertBefore(pop, hint);
      drawList();
      input.focus();
    }

    function draw() {
      UI.mount(row, ...shown().map(circle), moreButton());
      hint.style.display = extras ? '' : 'none';
    }

    // חצים בין העיגולים — ימינה/שמאלה לפי כיוון הקריאה
    row.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const btns = [...row.querySelectorAll('.ap-circle')];
      const at = btns.indexOf(document.activeElement);
      if (at === -1) return;
      e.preventDefault();
      const rtl = getComputedStyle(row).direction === 'rtl';
      const step = (e.key === 'ArrowLeft') === rtl ? 1 : -1;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (at + step + btns.length) % btns.length;
      btns[next].focus();
    });

    select.addEventListener('change', draw);
    draw();

    frequent().then((items) => {
      ranked = items.map((i) => i.value).filter((v) => byValue.has(v));
      // משימה חדשה: מי שאני הכי הרבה מטיל עליו — אלא אם המשתמש כבר בחר
      if (autoPick && !touched && ranked[0] && select.value !== ranked[0]) {
        select.value = ranked[0];
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      draw();
    });

    return { node, redraw: draw };
  }

  return { create, refresh, prefetch: frequent };
})();
