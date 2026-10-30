'use strict';
/**
 * 📒 אלפון ארגוני — שם מלא, טל' 1, טל' 2, פקס, מייל והערות (ההקשר לפרויקט),
 * משותף לכל העובדים.
 *
 *   sidebarSearch — שורת החיפוש בבאנר הימני, מעל "פרויקטים". לחיצה עליה אינה
 *                   פותחת דבר; התוצאות מופיעות רק כשמקלידים, בחלון צף לידה
 *                   (בטלפון — מתחתיה, בתוך התפריט). הוספה וניהול — שני
 *                   סמלים בתוך השורה
 *   openSearch    — אותו חיפוש בחלון, מהכפתור "אלפון" בדשבורד הנייד
 *   contactCard   — כרטיס איש קשר: רק השדות שהוזנו, וליד כל אחד הפעולה שלו
 *   render        — מסך הניהול: עריכה בשורה, הוספה, מחיקה, ייבוא וייצוא
 *   editDialog    — הוספה או עריכה של רשומה אחת
 *
 * שורת החיפוש בנויה לפי דפוס ה-autocomplete של 21st.dev (ReUI / coss
 * Async Autocomplete): תוצאות תוך כדי הקלדה בקבוצות, הדגשת מה שהוקלד, סמן
 * טעינה בתוך השדה, וניווט במקלדת.
 *
 * סדר התוצאות נקבע בשרת (‎server/phonebook.js‎): קודם שמות שמתחילים במה
 * שהוקלד, אחר כך שמות שמכילים, אחר כך מספרים ומייל, ואחר כך הערות.
 */

const PhonebookView = (() => {
  const { el } = UI;

  const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches;
  const narrow = () => window.matchMedia?.('(max-width: 820px)').matches;

  /** טקסט עם הדגשה של מה שהוקלד */
  function marked(text, q) {
    const value = String(text ?? '');
    const query = String(q ?? '').trim();
    if (!query) return value;
    const at = value.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return value;
    return el('span', {}, [value.slice(0, at), el('mark', { text: value.slice(at, at + query.length) }), value.slice(at + query.length)]);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); UI.success(`${text} הועתק`); } catch { UI.toast(text); }
  }

  const iconBtn = (icon, label, onclick, cls = '') => el(`button.icon-btn.pb-act${cls}`, {
    type: 'button', title: label, 'aria-label': label,
    onclick: (e) => { e.stopPropagation(); onclick(e); }
  }, [UI.lineIcon(icon)]);

  /** חיוג — בטלפון מחייג; במחשב מעתיק, כי ‎tel:‎ במחשב פותח אפליקציה זרה */
  function callButton(phone) {
    if (!phone) return null;
    if (isPhone()) {
      return el('a.icon-btn.pb-act', {
        href: `tel:${phone.replace(/[^\d+]/g, '')}`, title: `חיוג ל-${phone}`, 'aria-label': `חיוג ל-${phone}`,
        onclick: (e) => e.stopPropagation()
      }, [UI.lineIcon('phone')]);
    }
    return iconBtn('phone', `העתקת ${phone}`, () => copy(phone));
  }

  const mailButton = (email) => (email
    ? el('a.icon-btn.pb-act', { href: `mailto:${email}`, title: `מייל ל-${email}`, 'aria-label': `מייל ל-${email}`, onclick: (e) => e.stopPropagation() }, [UI.lineIcon('mail')])
    : null);

  /**
   * משימת AI לאיש הזה — השם והמייל ממולאים. הטלפון שם הוא לוואטסאפ, ולכן
   * נמסר רק נייד (05X); לאיש קשר עם טלפון משרד בלבד — השדה נשאר ריק.
   */
  function aiButton(entry) {
    if (!App.may('create_task')) return null;
    return iconBtn('sparkles', `משימת AI ל${entry.name}`, () => {
      AiTaskView.openDialog({ contact: { name: entry.name, email: entry.email, phone: entry.mobile ?? '', type: 'external', refId: null, source: 'phonebook' } });
    }, '.pb-ai');
  }

  // ------------------------------------------------------------- כרטיס איש קשר

  /**
   * השורות שבכרטיס — רק מה שהוזן. כשיש טלפון אחד הוא "טלפון", בלי מספור;
   * רק כשיש שניים — "טל' 1" ו"טל' 2".
   */
  function lines(e) {
    const two = e.phone && e.phone2;
    return [
      e.phone ? { key: 'phone', icon: 'phone', label: two ? "טל' 1" : 'טלפון', value: e.phone } : null,
      e.phone2 ? { key: 'phone2', icon: 'phone', label: "טל' 2", value: e.phone2 } : null,
      e.fax ? { key: 'fax', icon: 'copy', label: 'פקס', value: e.fax } : null,
      e.email ? { key: 'email', icon: 'mail', label: 'מייל', value: e.email } : null
    ].filter(Boolean);
  }

  /**
   * @param {object} entry
   * @param {{q?: string, onEdit?: Function}} opts
   */
  function contactCard(entry, { q = '', onEdit = null } = {}) {
    const action = (l) => {
      if (l.key === 'email') return mailButton(l.value);
      if (l.key === 'fax') return iconBtn('copy', `העתקת הפקס ${l.value}`, () => copy(l.value));
      return callButton(l.value);
    };
    return el('div.pbc', {}, [
      el('div.pbc-head', {}, [
        el('b.pbc-name', {}, [marked(entry.name, entry.match === 'name' ? q : '')]),
        el('div.pbc-head-acts', {}, [
          aiButton(entry),
          onEdit ? iconBtn('pencil', `עריכת ${entry.name}`, () => onEdit(entry)) : null
        ])
      ]),
      entry.note ? el('div.pbc-note', {}, [marked(entry.note, entry.match === 'note' ? q : '')]) : null,
      el('div.pbc-lines', {}, lines(entry).map((l) => el('div.pbc-line', {}, [
        el('span.pbc-label', { text: l.label }),
        el('span.pbc-value', { dir: 'ltr' }, [marked(l.value, ['phone', 'email'].includes(entry.match) ? q : '')]),
        action(l)
      ])))
    ]);
  }

  // ------------------------------------------------------------- חיפוש

  /**
   * שדה החיפוש והתוצאות — משותף לבאנר הימני ולחלון בטלפון.
   *
   * כל תוצאה היא שורה קצרה (שם, הערה, מספר ראשון); לחיצה או Enter פותחים
   * אותה לכרטיס המלא במקום. ↑↓ בין השורות, Esc מנקה ואחר כך סוגר.
   *
   * בשדה ריק אין תוצאות ואין חלון — ‎onChange(false)‎; מההקלדה הראשונה —
   * ‎onChange(true)‎. בתוך השדה שני סמלים: הוספה (עם מה שהוקלד) וניהול.
   */
  function searchPanel({ onEscape = () => {}, onChange = () => {} } = {}) {
    const input = el('input.pb-search', {
      type: 'text', placeholder: 'חיפוש באלפון…', autocomplete: 'off',
      role: 'combobox', 'aria-expanded': 'false', 'aria-label': 'חיפוש באלפון — שם, טלפון או הערה'
    });
    const add = el('button.pb-field-btn', {
      type: 'button', title: 'הוספה לאלפון', 'aria-label': 'הוספה לאלפון',
      onclick: () => {
        const q = input.value.trim();
        editDialog(/@/.test(q) ? { email: q } : /^[\d\s+\-()]{5,}$/.test(q) ? { phone: q } : { name: q }, { onSaved: search });
      }
    }, [UI.lineIcon('plus')]);
    const manage = el('button.pb-field-btn', {
      type: 'button', title: 'ניהול האלפון', 'aria-label': 'ניהול האלפון',
      onclick: () => { onEscape(); App.navigate('phonebook'); }
    }, [UI.lineIcon('list')]);
    const field = el('div.pb-field', {}, [
      UI.lineIcon('contacts'), input,
      el('div.pb-field-acts', {}, [el('span.pb-spin', { 'aria-hidden': 'true' }), add, manage])
    ]);
    const list = el('div.pb-list', { role: 'listbox' });
    const count = el('span.mute-sm');
    let timer = null;
    let seq = 0;
    let items = [];
    let active = -1;
    let open = null;     // מזהה הכרטיס הפתוח
    let query = '';

    const edit = (entry) => editDialog(entry, { onSaved: search });

    function row(entry, i) {
      const first = lines(entry)[0];
      const isOpen = open === entry.id;
      const node = el(`div.pb-row${i === active ? '.active' : ''}${isOpen ? '.open' : ''}`, {
        role: 'option', 'aria-selected': i === active ? 'true' : 'false',
        onclick: () => toggle(i)
      }, isOpen
        ? [contactCard(entry, { q: query, onEdit: edit })]
        : [
            el('div.pb-main', {}, [
              el('b', {}, [marked(entry.name, entry.match === 'name' ? query : '')]),
              entry.note ? el('div.pb-note', {}, [marked(entry.note, entry.match === 'note' ? query : '')]) : null
            ]),
            first ? el('span.pb-first', { dir: 'ltr' }, [first.value]) : null
          ]);
      return node;
    }

    function toggle(i) {
      const e = items[i];
      if (!e) return;
      active = i;
      open = open === e.id ? null : e.id;
      draw();
    }

    function draw(emptyNote = null) {
      const names = items.filter((e) => e.match !== 'note');
      const notes = items.filter((e) => e.match === 'note');
      const group = (title, arr) => (arr.length
        ? [el('div.pb-group', { text: title }), ...arr.map((e) => row(e, items.indexOf(e)))]
        : []);
      UI.mount(list, ...group('אנשי קשר', names), ...group('מופיע בהערות', notes), emptyNote);
      input.setAttribute('aria-expanded', 'true');
      list.querySelector('.pb-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    async function search() {
      const mine = ++seq;
      query = input.value.trim();
      if (!query) {
        items = [];
        open = null;
        UI.mount(list);
        input.setAttribute('aria-expanded', 'false');
        onChange(false);
        return;
      }
      field.classList.add('is-loading');
      try {
        const data = await API.get(`/api/phonebook?q=${encodeURIComponent(query)}&limit=20`);
        if (mine !== seq) return;
        items = data.items;
        count.textContent = data.total ? `${data.total} אנשי קשר` : '';
        active = items.length ? 0 : -1;
        if (!items.some((e) => e.id === open)) open = null;
        draw(items.length ? null : el('div.pb-empty.mute-sm', { text: `לא נמצא "${query}" — ＋ בשורת החיפוש מוסיף אותו לאלפון` }));
        onChange(true);
      } catch (err) {
        if (mine === seq) UI.mount(list, el('div.pb-empty.mute-sm', { text: err.message }));
      } finally {
        if (mine === seq) field.classList.remove('is-loading');
      }
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; draw(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); toggle(active); }
      else if (e.key === 'Escape') {
        e.stopPropagation();
        if (input.value) { input.value = ''; search(); } else onEscape();
      }
    });
    return { input, field, list, count, search };
  }

  /*
   * הבאנר הימני — מעל "פרויקטים".
   *
   * התפריט נבנה מחדש בכל רענון, ולכן הרכיב נבנה פעם אחת ונשמר — אחרת
   * החיפוש היה נמחק תחת ידיו של מי שמקליד.
   *
   * חלון התוצאות יושב בתוך התפריט עצמו, במיקום ‎fixed‎: כך הוא אינו נחתך
   * ברוחב התפריט, ובכל זאת נחשב חלק ממנו — התפריט המכווץ נשאר פתוח כל עוד
   * העכבר או המיקוד בתוצאות. בטלפון התוצאות נפתחות מתחת לשדה.
   */
  let side = null;

  function sidebarSearch() {
    if (side) {
      if (document.activeElement === side.panel.input) {
        const pos = side.panel.input.selectionStart;
        setTimeout(() => { side.panel.input.focus(); side.panel.input.setSelectionRange(pos, pos); }, 0);
      }
      return side.node;
    }
    const pop = el('div.pb-pop', { hidden: true });
    const close = () => { pop.hidden = true; side.panel.input.setAttribute('aria-expanded', 'false'); };
    // החלון נפתח רק כשיש מה להראות — כשמקלידים, ולא בלחיצה על השדה
    const panel = searchPanel({
      onEscape: () => { close(); panel.input.blur(); },
      onChange: (has) => { if (has) { place(); pop.hidden = false; } else close(); }
    });
    pop.appendChild(panel.list);

    const place = () => {
      if (narrow()) { pop.style.cssText = ''; return; }
      const r = panel.field.getBoundingClientRect();
      pop.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - 160))}px`;
      // התפריט מימין — החלון נפתח משמאלו
      pop.style.right = `${window.innerWidth - r.left + 10}px`;
    };
    window.addEventListener('resize', () => { if (!pop.hidden) place(); });

    const node = el('div.pb-side', { title: 'אלפון' }, [panel.field, pop]);
    // לחיצה מחוץ לאלפון סוגרת את חלון התוצאות (לא בתוך חלון עריכה שנפתח ממנו)
    document.addEventListener('pointerdown', (e) => {
      if (pop.hidden || node.contains(e.target) || e.target.closest?.('.modal-backdrop')) return;
      close();
    });
    side = { node, panel };
    return node;
  }

  /** בטלפון — אותו חיפוש בחלון, מהכפתור "אלפון" בדשבורד הנייד */
  function openSearch() {
    const panel = searchPanel({ onEscape: () => m.close() });
    const m = UI.modal({
      title: 'אלפון',
      body: el('div.pb-modal', {}, [panel.field, panel.list])
    });
    setTimeout(() => panel.input.focus(), 50);
  }

  // ------------------------------------------------------------- הוספה ועריכה

  /**
   * @param {object} entry   רשומה קיימת (עם ‎id‎), או ערכים התחלתיים לרשומה חדשה
   * @param {{onSaved?: Function}} opts
   */
  function editDialog(entry = {}, { onSaved = () => {} } = {}) {
    const isEdit = Boolean(entry.id);
    const input = (type, value, placeholder, ltr = true) => el('input', { type, value: value ?? '', placeholder, ...(ltr ? { dir: 'ltr' } : {}) });
    const f = {
      name: input('text', entry.name, 'דני כהן', false),
      phone: input('tel', entry.phone, '050-0000000'),
      phone2: input('tel', entry.phone2, '03-0000000'),
      fax: input('tel', entry.fax, '03-0000000'),
      email: input('email', entry.email, 'name@example.com'),
      note: input('text', entry.note, 'למשל: יועץ תסריט, פרויקט הגפן', false)
    };
    const dupBox = el('div');

    // "כבר באלפון: דני כהן" — אזהרה, לא חסימה: לשני אנשים יכול להיות מספר משרד משותף
    const check = async () => {
      if (!['phone', 'phone2', 'fax', 'email'].some((k) => f[k].value.trim())) return UI.mount(dupBox);
      try {
        const { duplicates } = await API.post('/api/phonebook/check', {
          id: entry.id ?? null, phone: f.phone.value, phone2: f.phone2.value, fax: f.fax.value, email: f.email.value
        });
        UI.mount(dupBox, duplicates.length
          ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: `כבר באלפון: ${duplicates.map((d) => d.name).join(', ')}` })])
          : null);
      } catch { /* הבדיקה אינה תנאי לשמירה */ }
    };
    for (const k of ['phone', 'phone2', 'fax', 'email']) f[k].addEventListener('change', check);

    const save = el('button.btn.btn-primary', {}, [isEdit ? 'שמירה' : 'הוספה לאלפון']);
    const del = isEdit ? el('button.btn.btn-danger.btn-ghost', {}, [UI.lineIcon('trash'), 'מחיקה']) : null;
    const m = UI.modal({
      title: isEdit ? entry.name : 'הוספה לאלפון',
      body: el('div', {}, [
        UI.field('שם מלא', f.name),
        el('div.row', {}, [UI.field("טל' 1", f.phone), UI.field("טל' 2", f.phone2)]),
        el('div.row', {}, [UI.field('פקס', f.fax), UI.field('מייל', f.email)]),
        UI.field('הערות', f.note, 'ההקשר לפרויקט: תפקיד, חברה, באיזה פרויקט — גם לפי זה אפשר לחפש'),
        el('div.mute-sm', { text: 'אפשר למלא רק חלק — בכרטיס יופיעו רק השדות שמולאו.' }),
        dupBox,
        isEdit && entry.updatedBy ? el('div.mute-sm', { text: `עודכן לאחרונה בידי ${entry.updatedBy} · ${UI.formatDateTime(entry.updatedAt)}` }) : null
      ]),
      footer: [save, el('div.spacer'), del, el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    setTimeout(() => (entry.name ? f.phone : f.name).focus(), 50);
    if (entry.phone || entry.email) check();

    save.addEventListener('click', async () => {
      save.disabled = true;
      const body = Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value]));
      try {
        const res = isEdit ? await API.put(`/api/phonebook/${entry.id}`, body) : await API.post('/api/phonebook', body);
        m.close();
        UI.success(isEdit ? 'נשמר' : `${res.entry.name} נוסף/ה לאלפון`);
        onSaved(res.entry);
      } catch (err) {
        save.disabled = false;
        UI.error(err);
      }
    });
    del?.addEventListener('click', async () => {
      if (!await UI.confirm(`למחוק את ${entry.name} מהאלפון? הרשומה תימחק לכל העובדים.`, { danger: true, okText: 'מחיקה' })) return;
      try {
        await API.del(`/api/phonebook/${entry.id}`);
        m.close();
        UI.success('נמחק מהאלפון');
        onSaved(null);
      } catch (err) { UI.error(err); }
    });
  }

  // ------------------------------------------------------------- מסך הניהול

  async function render(container) {
    UI.mount(container, UI.spinner());
    let items = [];
    const search = el('input.pb-search', { type: 'search', placeholder: 'חיפוש לפי שם, טלפון, פקס, מייל או הערה…', autocomplete: 'off', 'aria-label': 'חיפוש באלפון' });
    const tbody = el('tbody');
    const summary = el('span.mute-sm');
    let editing = null;

    const load = async () => {
      try {
        items = (await API.get('/api/phonebook?all=1')).items;
        draw();
      } catch (err) { UI.error(err); }
    };

    /** אותו דירוג של החיפוש בשרת, על הרשימה שכבר כאן — בלי שאילתה בכל הקלדה */
    function filtered() {
      const q = search.value.trim().toLowerCase();
      if (!q) return items;
      const digitsOf = (x) => String(x ?? '').replace(/\D/g, '').replace(/^972/, '0');
      const digits = digitsOf(q);
      const rank = (e) => {
        const name = e.name.toLowerCase();
        if (name.startsWith(q)) return 0;
        if (name.split(/[\s\-'"׳״.,()]+/).some((w) => w.startsWith(q))) return 1;
        if (name.includes(q)) return 2;
        if (digits.length >= 2 && [e.phone, e.phone2, e.fax].some((p) => digitsOf(p).includes(digits))) return 3;
        if (e.email.toLowerCase().includes(q)) return 4;
        if (e.note.toLowerCase().includes(q)) return 5;
        return null;
      };
      return items.map((e) => ({ e, r: rank(e) })).filter((x) => x.r !== null)
        .sort((a, b) => a.r - b.r || a.e.name.localeCompare(b.e.name, 'he')).map((x) => x.e);
    }

    // ערך וליד הפעולה שלו — חיוג, העתקת פקס, מייל. תא ריק נשאר ריק, ובטלפון אינו מוצג
    const cell = (value, action) => el('div.pb-cell', {}, [el('span', { dir: 'ltr', text: value }), action]);

    function viewRow(e) {
      return el('tr', {}, [
        el('td', {}, [el('b', { text: e.name })]),
        el('td', {}, e.phone ? [cell(e.phone, callButton(e.phone))] : []),
        el('td', {}, e.phone2 ? [cell(e.phone2, callButton(e.phone2))] : []),
        el('td', {}, e.fax ? [cell(e.fax, iconBtn('copy', `העתקת הפקס ${e.fax}`, () => copy(e.fax)))] : []),
        el('td', {}, e.email ? [cell(e.email, mailButton(e.email))] : []),
        el('td', { text: e.note }),
        el('td.pb-row-acts', {}, [
          aiButton(e),
          iconBtn('pencil', `עריכת ${e.name}`, () => { editing = e.id; draw(); }),
          iconBtn('trash', `מחיקת ${e.name}`, async () => {
            if (!await UI.confirm(`למחוק את ${e.name} מהאלפון? הרשומה תימחק לכל העובדים.`, { danger: true, okText: 'מחיקה' })) return;
            try { await API.del(`/api/phonebook/${e.id}`); UI.success('נמחק'); load(); } catch (err) { UI.error(err); }
          }, '.pb-del')
        ])
      ]);
    }

    /** עריכה בשורה עצמה: Enter שומר, Escape מבטל */
    function editRow(e) {
      const f = {
        name: el('input', { type: 'text', value: e.name, 'aria-label': 'שם מלא' }),
        phone: el('input', { type: 'tel', dir: 'ltr', value: e.phone, placeholder: "טל' 1", 'aria-label': "טל' 1" }),
        phone2: el('input', { type: 'tel', dir: 'ltr', value: e.phone2, placeholder: "טל' 2", 'aria-label': "טל' 2" }),
        fax: el('input', { type: 'tel', dir: 'ltr', value: e.fax, 'aria-label': 'פקס' }),
        email: el('input', { type: 'email', dir: 'ltr', value: e.email, 'aria-label': 'מייל' }),
        note: el('input', { type: 'text', value: e.note, 'aria-label': 'הערות' })
      };
      const save = async () => {
        try {
          await API.put(`/api/phonebook/${e.id}`, Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])));
          editing = null;
          UI.success('נשמר');
          load();
        } catch (err) { UI.error(err); }
      };
      for (const i of Object.values(f)) {
        i.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); save(); }
          if (ev.key === 'Escape') { ev.stopPropagation(); editing = null; draw(); }
        });
      }
      setTimeout(() => f.name.focus(), 0);
      return el('tr.pb-editing', {}, [
        el('td', {}, [f.name]), el('td', {}, [f.phone]), el('td', {}, [f.phone2]), el('td', {}, [f.fax]), el('td', {}, [f.email]), el('td', {}, [f.note]),
        el('td.pb-row-acts', {}, [
          el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: save }, ['שמירה']),
          el('button.btn.btn-sm', { type: 'button', onclick: () => { editing = null; draw(); } }, ['ביטול'])
        ])
      ]);
    }

    function draw() {
      const shown = filtered();
      summary.textContent = search.value.trim() ? `${shown.length} מתוך ${items.length}` : `${items.length} אנשי קשר`;
      UI.mount(tbody, ...(shown.length
        ? shown.map((e) => (e.id === editing ? editRow(e) : viewRow(e)))
        : [el('tr', {}, [el('td', { colspan: 7 }, [UI.empty(items.length ? 'לא נמצא' : 'האלפון עוד ריק', UI.lineIcon('contacts', { size: 34 }))])])]));
    }
    search.addEventListener('input', draw);

    const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv', style: { display: 'none' } });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) importFlow(fileInput.files[0], load); fileInput.value = ''; });

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2.pb-title', {}, [UI.lineIcon('contacts'), 'אלפון ארגוני']),
          el('div.sub', { text: 'טלפונים, פקס ומיילים משותפים לכל העובדים. כל אחד יכול להוסיף, לעדכן ולמחוק.' })
        ]),
        el('div.spacer'),
        el('div.pb-head-acts', {}, [
          el('button.btn.btn-primary', { onclick: () => editDialog({}, { onSaved: load }) }, [UI.lineIcon('plus'), 'הוספה']),
          el('button.btn', { onclick: () => fileInput.click() }, [UI.lineIcon('upload'), 'ייבוא מאקסל']),
          el('a.btn', { href: '/api/phonebook/export', download: '' }, [UI.lineIcon('download'), 'ייצוא'])
        ]),
        fileInput
      ]),
      el('div.card', {}, [
        el('div.card-pad', {}, [
          el('div.flex.pb-tools', {}, [search, summary]),
          el('div.table-wrap.pb-table-wrap', {}, [
            el('table.data.pb-table', {}, [
              // העמודות כמו בכרטיס: שם מלא, טל' 1, טל' 2, פקס, מייל, הערות
              el('thead', {}, [el('tr', {}, ['שם מלא', "טל' 1", "טל' 2", 'פקס', 'מייל', 'הערות', ''].map((h) => el('th', { text: h })))]),
              tbody
            ])
          ])
        ])
      ])
    );
    await load();
    search.focus();
  }

  // ------------------------------------------------------------- ייבוא

  /**
   * ייבוא מאקסל או CSV: קודם תצוגה מקדימה — כל שורה עם מה שזוהה, שגיאה אם
   * יש, וסימון כפילות מול האלפון או בתוך הקובץ — ורק אחר כך שמירה.
   */
  async function importFlow(file, onDone) {
    let data;
    try {
      data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('הקובץ לא נקרא'));
        r.readAsDataURL(file);
      });
    } catch (err) { return UI.error(err); }

    let preview;
    try {
      preview = await API.post('/api/phonebook/import', { data, filename: file.name, commit: false });
    } catch (err) { return UI.error(err); }

    const rows = preview.rows;
    const ok = rows.filter((r) => !r.error && !r.duplicate).length;
    const dups = rows.filter((r) => !r.error && r.duplicate).length;
    const bad = rows.filter((r) => r.error).length;
    const withDups = el('input', { type: 'checkbox' });
    const go = el('button.btn.btn-primary', {}, [`ייבוא ${ok} אנשי קשר`]);
    withDups.addEventListener('change', () => { go.textContent = `ייבוא ${ok + (withDups.checked ? dups : 0)} אנשי קשר`; });

    const m = UI.modal({
      title: `ייבוא לאלפון — ${file.name}`,
      size: 'wide',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 } }, [
          `${rows.length} שורות: ${ok} חדשות`,
          dups ? `, ${dups} כבר קיימות` : '',
          bad ? `, ${bad} עם שגיאה (יידלגו)` : '',
          preview.header ? '' : ". לא זוהו כותרות — הסדר נלקח כשם · טל' 1 · טל' 2 · פקס · מייל · הערות."
        ]),
        dups ? el('label.checkbox', {}, [withDups, ' לייבא גם את הכפולות']) : null,
        el('div.table-wrap.pb-import', {}, [
          el('table.data', {}, [
            el('thead', {}, [el('tr', {}, ['שורה', 'שם מלא', "טל' 1", "טל' 2", 'פקס', 'מייל', 'הערות', ''].map((h) => el('th', { text: h })))]),
            el('tbody', {}, rows.map((r) => el(`tr${r.error ? '.pb-bad' : r.duplicate ? '.pb-dup' : ''}`, {}, [
              el('td.mute-sm', { text: String(r.line) }),
              el('td', { text: r.name }),
              el('td', { dir: 'ltr', text: r.phone }), el('td', { dir: 'ltr', text: r.phone2 ?? '' }), el('td', { dir: 'ltr', text: r.fax ?? '' }),
              el('td', { dir: 'ltr', text: r.email }), el('td', { text: r.note }),
              el('td.mute-sm', { text: r.error || r.duplicate || '✓' })
            ])))
          ])
        ])
      ]),
      footer: [go, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    if (!ok && !dups) go.disabled = true;

    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const res = await API.post('/api/phonebook/import', { data, filename: file.name, commit: true, includeDuplicates: withDups.checked });
        m.close();
        UI.success(`נוספו ${res.created} אנשי קשר${res.skipped ? ` · ${res.skipped} דולגו` : ''}`);
        onDone?.();
      } catch (err) {
        go.disabled = false;
        UI.error(err);
      }
    });
  }

  return { sidebarSearch, openSearch, contactCard, render, editDialog };
})();
