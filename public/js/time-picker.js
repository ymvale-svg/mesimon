'use strict';
/**
 * 🕒 בורר שעה — שעון, במקום הרשימה של הדפדפן. לכל שדה שעה במערכת.
 *
 * כל ‎<input type="time">‎ שנכנס למסך (גם בחלונות ובדיאלוגים) מוחלף לבד:
 * השדה נשאר שדה טקסט שאפשר להקליד בו ("930" ← 09:30), ולחיצה עליו פותחת שעון:
 *   • טבעת חיצונית — דקות (לפי ‎step‎ של השדה: 900 = רבעי שעה, אחרת כל 5 דק׳)
 *   • טבעת אמצעית — שעות היום, 7–18 (במקום שלהן על השעון)
 *   • טבעת פנימית — ערב ולילה, 19–6
 * לוחצים או גוררים על השעון; המחוגים זזים. ‎input‎ בזמן גרירה, ‎change‎ כשעוזבים —
 * כך מסך שטוען זמינות על כל שינוי לא נטען עשרות פעמים.
 *
 * הערך זהה לשדה שעה רגיל — "HH:MM" — ולכן הקוד של המסכים לא משתנה.
 */

const TimePicker = (() => {
  const SIZE = 264;
  const C = SIZE / 2;
  const R_MIN = 112;   // דקות
  const R_DAY = 80;    // 7–18
  const R_NIGHT = 50;  // 19–6
  const NS = 'http://www.w3.org/2000/svg';
  const pad = (n) => String(n).padStart(2, '0');

  // מיקום על השעון: 12 למעלה, עם כיוון השעון
  const at = (pos12, r) => {
    const a = (pos12 / 12) * 2 * Math.PI;
    return [C + r * Math.sin(a), C - r * Math.cos(a)];
  };
  const DAY_HOURS = [12, 13, 14, 15, 16, 17, 18, 7, 8, 9, 10, 11];  // לפי מקום 0..11
  const NIGHT_HOURS = [0, 1, 2, 3, 4, 5, 6, 19, 20, 21, 22, 23];

  /** "930", "9:5", "14.30", "1430" ← "09:30"... ; לא תקין — ‎null‎ */
  function parse(text) {
    const s = String(text ?? '').trim().replace(/[.,;\s]/g, ':');
    if (!s) return '';
    let h;
    let m;
    const parts = s.split(':').filter(Boolean);
    if (parts.length >= 2) [h, m] = parts;
    else if (/^\d{3,4}$/.test(s)) { h = s.slice(0, -2); m = s.slice(-2); }
    else if (/^\d{1,2}$/.test(s)) { h = s; m = '0'; }
    else return null;
    if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m)) return null;
    const H = Number(h);
    const M = Number(m);
    if (H > 23 || M > 59) return null;
    return `${pad(H)}:${pad(M)}`;
  }

  const stepOf = (input) => {
    const s = Number(input.dataset.tpStep) || 60;
    return Math.max(1, Math.round(s / 60));
  };

  // --------------------------------------------------------------- שדות

  function enhance(input) {
    if (input.dataset.tp) return;
    input.dataset.tp = '1';
    input.dataset.tpStep = input.getAttribute('step') || '60';
    input.type = 'text';
    input.removeAttribute('step');
    input.classList.add('tp-input');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('maxlength', '5');
    input.setAttribute('dir', 'ltr');
    if (!input.placeholder) input.placeholder = '--:--';
    input.setAttribute('aria-haspopup', 'dialog');
    input.dataset.tpLast = input.value;
    input.addEventListener('click', () => open(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); open(input); }
    });
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches?.('input[type="time"]')) enhance(root);
    for (const x of root.querySelectorAll?.('input[type="time"]') ?? []) enhance(x);
  }

  // הקלדה חופשית — מנורמל לפני שהמסך מקבל את ה-‎change‎ (שלב הלכידה, לפני המאזינים של השדה)
  document.addEventListener('change', (e) => {
    const input = e.target;
    if (!input?.dataset?.tp) return;
    const v = parse(input.value);
    if (v === null) {
      input.value = input.dataset.tpLast ?? '';
      UI.toast?.('שעה לא תקינה — למשל 09:30', 'error');
      return;
    }
    input.value = v;
    input.dataset.tpLast = v;
  }, true);

  // --------------------------------------------------------------- השעון

  let pop = null;   // ‎{ node, input, cleanup }‎

  function close() {
    if (!pop) return;
    pop.cleanup();
    pop.node.remove();
    pop.input.setAttribute('aria-expanded', 'false');
    pop = null;
  }

  function svg(tag, attrs = {}, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function open(input) {
    if (input.disabled || input.readOnly) return;
    if (pop?.input === input) return;
    close();
    const step = stepOf(input);
    const minStep = step >= 15 ? 15 : step >= 5 ? 5 : 1; // מה אפשר לבחור על השעון
    const now = new Date();
    const start = parse(input.value) || `${pad(now.getHours())}:${pad(Math.round(now.getMinutes() / minStep) * minStep % 60)}`;
    let [h, m] = start.split(':').map(Number);
    const original = input.value;

    const node = document.createElement('div');
    node.className = 'tp-pop';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'בחירת שעה');

    // תצוגה דיגיטלית — גדולה, וזה גם מה שמאשר שהבחירה נקלטה
    const digits = document.createElement('div');
    digits.className = 'tp-digits';
    digits.setAttribute('dir', 'ltr');
    const hEl = document.createElement('span');
    const mEl = document.createElement('span');
    digits.append(hEl, Object.assign(document.createElement('i'), { textContent: ':' }), mEl);

    const dial = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'tp-dial', role: 'presentation' });
    dial.append(svg('circle', { cx: C, cy: C, r: C - 4, class: 'tp-face' }));
    dial.append(svg('circle', { cx: C, cy: C, r: (R_DAY + R_MIN) / 2 + 2, class: 'tp-sep' }));
    // מחוגים — מתחת למספרים
    const hourHand = svg('line', { x1: C, y1: C, x2: C, y2: C - R_DAY, class: 'tp-hand tp-hand-h' });
    const minHand = svg('line', { x1: C, y1: C, x2: C, y2: C - R_MIN, class: 'tp-hand tp-hand-m' });
    const hourKnob = svg('circle', { cx: C, cy: C - R_DAY, r: 15, class: 'tp-knob tp-knob-h' });
    const minKnob = svg('circle', { cx: C, cy: C - R_MIN, r: 15, class: 'tp-knob tp-knob-m' });
    const hourG = svg('g', { class: 'tp-rot' });
    const minG = svg('g', { class: 'tp-rot' });
    hourG.append(hourHand, hourKnob);
    minG.append(minHand, minKnob);
    dial.append(minG, hourG, svg('circle', { cx: C, cy: C, r: 4, class: 'tp-center' }));

    const labels = [];
    const label = (pos, r, text, cls, data) => {
      const [x, y] = at(pos, r);
      const t = svg('text', { x, y, class: cls, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, text);
      t.dataset.kind = data.kind;
      t.dataset.val = String(data.val);
      labels.push(t);
      dial.append(t);
    };
    for (let i = 0; i < 12; i++) {
      const mm = i * 5;
      const enabled = mm % minStep === 0;
      label(i, R_MIN, enabled ? pad(mm) : '·', `tp-num tp-min${enabled ? '' : ' is-off'}`, { kind: 'm', val: mm });
      label(i, R_DAY, String(DAY_HOURS[i]), 'tp-num tp-hday', { kind: 'h', val: DAY_HOURS[i] });
      label(i, R_NIGHT, String(NIGHT_HOURS[i]), 'tp-num tp-hnight', { kind: 'h', val: NIGHT_HOURS[i] });
    }

    function paint() {
      hEl.textContent = pad(h);
      mEl.textContent = pad(m);
      const night = NIGHT_HOURS.includes(h);
      const r = night ? R_NIGHT : R_DAY;
      hourHand.setAttribute('y2', C - r);
      hourKnob.setAttribute('cy', C - r);
      hourKnob.setAttribute('r', night ? 12 : 15);
      hourG.style.transform = `rotate(${(h % 12) * 30}deg)`;
      minG.style.transform = `rotate(${m * 6}deg)`;
      for (const t of labels) {
        const on = t.dataset.kind === 'h' ? Number(t.dataset.val) === h : Number(t.dataset.val) === m;
        t.classList.toggle('is-on', on);
      }
    }

    function commit(final) {
      input.value = `${pad(h)}:${pad(m)}`;
      input.dataset.tpLast = input.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (final) input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // לחיצה / גרירה: לפי המרחק מהמרכז — איזו טבעת; לפי הזווית — איזה ערך
    let dragging = null;
    function pick(e, kindLock) {
      const rect = dial.getBoundingClientRect();
      const scale = SIZE / rect.width;
      const x = (e.clientX - rect.left) * scale - C;
      const y = (e.clientY - rect.top) * scale - C;
      const dist = Math.hypot(x, y);
      let ang = Math.atan2(x, -y) * 180 / Math.PI;
      if (ang < 0) ang += 360;
      const kind = kindLock ?? (dist > (R_DAY + R_MIN) / 2 ? 'm' : 'h');
      if (kind === 'm') {
        const snap = Math.max(minStep, 1);
        m = Math.round(ang / 6 / snap) * snap % 60;
      } else {
        const pos = Math.round(ang / 30) % 12;
        h = (dist < (R_NIGHT + R_DAY) / 2 ? NIGHT_HOURS : DAY_HOURS)[pos];
      }
      paint();
      return kind;
    }
    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dial.setPointerCapture?.(e.pointerId);
      dragging = pick(e);
      commit(false);
    });
    dial.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pick(e, dragging);
      commit(false);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = null;
      commit(true);
    };
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);

    const nowBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm btn-ghost', textContent: 'עכשיו' });
    nowBtn.addEventListener('click', () => {
      const d = new Date();
      const total = Math.ceil((d.getHours() * 60 + d.getMinutes()) / minStep) * minStep;
      h = Math.floor(total / 60) % 24;
      m = total % 60;
      paint();
      commit(true);
    });
    const okBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm btn-primary', textContent: '✓ אישור' });
    okBtn.addEventListener('click', () => {
      if (input.value !== `${pad(h)}:${pad(m)}`) commit(true);
      close();
      input.focus();
    });
    const cancelBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm btn-ghost', textContent: 'ביטול' });
    cancelBtn.addEventListener('click', () => {
      if (input.value !== original) {
        input.value = original;
        input.dataset.tpLast = original;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
      input.focus();
    });

    const hint = Object.assign(document.createElement('div'), { className: 'tp-hint', textContent: 'בפנים שעות · בחוץ דקות' });
    const foot = document.createElement('div');
    foot.className = 'tp-foot';
    foot.append(nowBtn, Object.assign(document.createElement('div'), { className: 'spacer' }), cancelBtn, okBtn);
    node.append(digits, dial, hint, foot);
    document.body.append(node);
    paint();

    // מיקום: מתחת לשדה, או מעליו כשאין מקום; בטלפון — גיליון מלמטה
    const place = () => {
      if (window.matchMedia('(max-width: 560px)').matches) {
        node.classList.add('is-sheet');
        return;
      }
      node.classList.remove('is-sheet');
      const r = input.getBoundingClientRect();
      const w = node.offsetWidth;
      const ht = node.offsetHeight;
      let top = r.bottom + 6;
      if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 6);
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      node.style.top = `${top}px`;
      node.style.left = `${left}px`;
    };
    place();
    requestAnimationFrame(() => node.classList.add('is-open'));

    const onDown = (e) => { if (!node.contains(e.target) && e.target !== input) close(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cancelBtn.click(); }
      else if (e.key === 'Enter' && (node.contains(e.target) || e.target === input)) { e.preventDefault(); okBtn.click(); }
    };
    const onScroll = (e) => { if (!node.contains(e.target)) place(); };
    // השדה הוקלד — השעון מתעדכן
    const onType = () => {
      const v = parse(input.value);
      if (v) { [h, m] = v.split(':').map(Number); paint(); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    input.addEventListener('input', onType);
    input.setAttribute('aria-expanded', 'true');
    pop = {
      node, input,
      cleanup: () => {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', onScroll, true);
        input.removeEventListener('input', onType);
      }
    };
  }

  // שדה שעה שנכנס למסך — מוחלף מיד; שדה שיצא מהמסך — השעון שלו נסגר
  function start() {
    scan(document.body);
    new MutationObserver((list) => {
      for (const rec of list) for (const n of rec.addedNodes) scan(n);
      if (pop && !pop.input.isConnected) close();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  return { open, close, parse, enhance };
})();
