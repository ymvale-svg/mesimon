'use strict';
/**
 * 📒 אלפון ארגוני — שם, טלפון, מייל והערה, משותף לכל העובדים.
 *
 *   card        — חלון החיפוש בדשבורד: מקלידים שם, טלפון או מילה מההערה,
 *                 ומכל שורה אפשר לחייג, לשלוח מייל, או לפתוח משימת AI עם
 *                 פרטי האיש כבר ממולאים
 *   render      — מסך הניהול (מ"החשבון שלי" ומהחלון בדשבורד): עריכה בשורה,
 *                 הוספה, מחיקה, ייבוא מאקסל וייצוא
 *   editDialog  — הוספה או עריכה של רשומה אחת
 *
 * סדר התוצאות נקבע בשרת (‎server/phonebook.js‎): קודם שמות שמתחילים במה
 * שהוקלד, אחר כך שמות שמכילים, אחר כך טלפון ומייל, ואחר כך הערות.
 */

const PhonebookView = (() => {
  const { el } = UI;

  const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches;
  // מקום ריק במקום כפתור חסר — כך 📞 ✉ ✨ באותו טור בכל השורות
  const gap = () => el('span.pb-act-gap', { 'aria-hidden': 'true' });

  /** טקסט עם הדגשה של מה שהוקלד */
  function marked(text, q) {
    const value = String(text ?? '');
    const query = String(q ?? '').trim();
    if (!query) return value;
    const at = value.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return value;
    return el('span', {}, [value.slice(0, at), el('mark', { text: value.slice(at, at + query.length) }), value.slice(at + query.length)]);
  }

  /** 📞 — בטלפון מחייג; במחשב מעתיק את המספר, כי ‎tel:‎ במחשב פותח אפליקציה זרה */
  function callButton(phone) {
    if (!phone) return null;
    if (isPhone()) return el('a.icon-btn.pb-act', { href: `tel:${phone.replace(/[^\d+]/g, '')}`, title: `חיוג ל-${phone}`, 'aria-label': `חיוג ל-${phone}` }, ['📞']);
    return el('button.icon-btn.pb-act', {
      type: 'button',
      title: `העתקת ${phone}`,
      'aria-label': `העתקת המספר ${phone}`,
      onclick: async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(phone); UI.success(`${phone} הועתק`); } catch { UI.toast(phone); }
      }
    }, ['📞']);
  }

  const mailButton = (email) => (email
    ? el('a.icon-btn.pb-act', { href: `mailto:${email}`, title: `מייל ל-${email}`, 'aria-label': `מייל ל-${email}`, onclick: (e) => e.stopPropagation() }, ['✉'])
    : null);

  /** ✨ משימת AI לאיש הזה — השם, המייל והטלפון כבר ממולאים */
  function aiButton(entry) {
    if (!App.may('create_task')) return null;
    return el('button.icon-btn.pb-act.pb-ai', {
      type: 'button',
      title: `משימת AI ל${entry.name}`,
      'aria-label': `משימת AI ל${entry.name}`,
      onclick: (e) => {
        e.stopPropagation();
        AiTaskView.openDialog({ contact: { name: entry.name, email: entry.email, phone: entry.phone, type: 'external', refId: null, source: 'phonebook' } });
      }
    }, ['✨']);
  }

  // ------------------------------------------------------------- חלון בדשבורד

  /*
   * החלון נבנה פעם אחת ונשמר: דף הבית נבנה מחדש בכל רענון רקע, וחלון שנבנה
   * מחדש היה מוחק את החיפוש תחת ידיו של מי שמקליד. אותו אלמנט עובר לחלון
   * החדש, והמיקוד חוזר אליו.
   */
  let cardNode = null;
  let cardInput = null;

  function card() {
    if (cardNode) {
      // כלי הסידור של לוח החלונות נוספים לכותרת בכל בנייה — מסירים את הקודמים
      cardNode.querySelectorAll('.slot-tools').forEach((n) => n.remove());
      if (document.activeElement === cardInput) {
        const pos = cardInput.selectionStart;
        setTimeout(() => { cardInput.focus(); cardInput.setSelectionRange(pos, pos); }, 0);
      }
      return cardNode;
    }
    const panel = searchPanel();
    cardInput = panel.input;
    cardNode = el('div.card.pb-card', {}, [
      el('div.card-head', {}, [
        el('h3', { text: '📒 אלפון' }),
        panel.count,
        el('div.spacer'),
        el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'הוספה לאלפון', onclick: () => editDialog({}, { onSaved: panel.search }) }, ['＋']),
        el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => App.navigate('phonebook') }, ['ניהול'])
      ]),
      el('div.card-pad', {}, [panel.input, panel.list])
    ]);
    return cardNode;
  }

  /** בטלפון — אותו חיפוש בחלון, מכפתור בדשבורד הנייד */
  function openSearch() {
    const panel = searchPanel();
    const m = UI.modal({
      title: '📒 אלפון',
      body: el('div.pb-card', {}, [panel.input, panel.list]),
      footer: [
        el('button.btn', { onclick: () => editDialog({}, { onSaved: panel.search }) }, ['＋ הוספה']),
        el('div.spacer'),
        el('button.btn', { onclick: () => { m.close(); App.navigate('phonebook'); } }, ['ניהול'])
      ]
    });
    setTimeout(() => panel.input.focus(), 50);
  }

  /** שדה החיפוש והתוצאות — משותף לחלון בדשבורד ולחלון בטלפון */
  function searchPanel() {
    const input = el('input.pb-search', { type: 'search', placeholder: 'שם, טלפון או הערה…', autocomplete: 'off', 'aria-label': 'חיפוש באלפון' });
    const list = el('div.pb-list.feed-scroll');
    const count = el('span.mute-sm');
    let timer = null;
    let seq = 0;

    function row(entry, q) {
      return el('div.pb-row', {
        title: 'עריכה',
        onclick: () => editDialog(entry, { onSaved: search })
      }, [
        el('div.pb-main', {}, [
          el('b', {}, [marked(entry.name, entry.match === 'name' ? q : '')]),
          entry.note ? el('div.mute-sm.pb-note', {}, [marked(entry.note, entry.match === 'note' ? q : '')]) : null,
          el('div.mute-sm.pb-detail', { dir: 'ltr' }, [
            entry.phone ? marked(entry.phone, entry.match === 'phone' ? q : '') : null,
            entry.phone && entry.email ? ' · ' : null,
            entry.email ? marked(entry.email, entry.match === 'email' ? q : '') : null
          ])
        ]),
        el('div.pb-acts', {}, [callButton(entry.phone) ?? gap(), mailButton(entry.email) ?? gap(), aiButton(entry)])
      ]);
    }

    /** "＋ להוסיף את 'דני' לאלפון" — מה שהוקלד נכנס לשדה המתאים */
    function addLine(q) {
      const prefill = /@/.test(q) ? { email: q } : /^[\d\s+\-()]{5,}$/.test(q) ? { phone: q } : { name: q };
      return el('button.btn.btn-sm.pb-add', { type: 'button', onclick: () => editDialog(prefill, { onSaved: search }) },
        [q ? `＋ להוסיף את "${q}" לאלפון` : '＋ הוספה לאלפון']);
    }

    async function search() {
      const mine = ++seq;
      const q = input.value.trim();
      try {
        const data = await API.get(`/api/phonebook?q=${encodeURIComponent(q)}&limit=${q ? 12 : 6}`);
        if (mine !== seq) return;
        count.textContent = data.total ? `${data.total} אנשי קשר` : '';
        if (!data.total) {
          UI.mount(list, el('div.pb-empty', {}, [
            el('div.mute-sm', { text: 'האלפון עוד ריק. מוסיפים כאן אחד-אחד, או מייבאים מאקסל במסך הניהול.' }),
            addLine('')
          ]));
          return;
        }
        if (q && !data.items.length) {
          UI.mount(list, el('div.pb-empty', {}, [el('div.mute-sm', { text: `לא נמצא "${q}"` }), addLine(q)]));
          return;
        }
        UI.mount(list, ...data.items.map((e) => row(e, q)), q ? null : el('div.mute-sm.pb-hint', { text: 'מקלידים שם, טלפון או מילה מההערה' }));
      } catch (err) {
        if (mine === seq) UI.mount(list, el('div.mute-sm', { text: err.message }));
      }
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 140); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; search(); } });
    search();
    return { input, list, count, search };
  }

  // ------------------------------------------------------------- הוספה ועריכה

  /**
   * @param {object} entry   רשומה קיימת (עם ‎id‎), או ערכים התחלתיים לרשומה חדשה
   * @param {{onSaved?: Function}} opts
   */
  function editDialog(entry = {}, { onSaved = () => {} } = {}) {
    const isEdit = Boolean(entry.id);
    const name = el('input', { type: 'text', value: entry.name ?? '', placeholder: 'דני כהן' });
    const phone = el('input', { type: 'tel', dir: 'ltr', value: entry.phone ?? '', placeholder: '050-0000000' });
    const email = el('input', { type: 'email', dir: 'ltr', value: entry.email ?? '', placeholder: 'name@example.com' });
    const note = el('input', { type: 'text', value: entry.note ?? '', placeholder: 'למשל: יועץ תסריט, פרויקט הגפן' });
    const dupBox = el('div');

    // "כבר באלפון: דני כהן" — אזהרה, לא חסימה: לשני אנשים יכול להיות מספר משרד משותף
    const check = async () => {
      if (!phone.value.trim() && !email.value.trim()) return UI.mount(dupBox);
      try {
        const { duplicates } = await API.post('/api/phonebook/check', { id: entry.id ?? null, phone: phone.value, email: email.value });
        UI.mount(dupBox, duplicates.length
          ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: `כבר באלפון: ${duplicates.map((d) => d.name).join(', ')}` })])
          : null);
      } catch { /* הבדיקה אינה תנאי לשמירה */ }
    };
    phone.addEventListener('change', check);
    email.addEventListener('change', check);

    const save = el('button.btn.btn-primary', {}, [isEdit ? 'שמירה' : 'הוספה לאלפון']);
    const del = isEdit ? el('button.btn.btn-danger.btn-ghost', {}, ['מחיקה']) : null;
    const m = UI.modal({
      title: isEdit ? `📒 ${entry.name}` : '📒 הוספה לאלפון',
      body: el('div', {}, [
        UI.field('שם', name),
        el('div.row', {}, [UI.field('טלפון', phone), UI.field('מייל', email)]),
        UI.field('הערה', note, 'תפקיד, חברה או פרויקט — גם לפי זה אפשר לחפש'),
        dupBox,
        isEdit && entry.updatedBy ? el('div.mute-sm', { text: `עודכן לאחרונה בידי ${entry.updatedBy} · ${UI.formatDateTime(entry.updatedAt)}` }) : null
      ]),
      footer: [save, el('div.spacer'), del, el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    setTimeout(() => (entry.name ? phone : name).focus(), 50);
    if (entry.phone || entry.email) check();

    save.addEventListener('click', async () => {
      save.disabled = true;
      const body = { name: name.value, phone: phone.value, email: email.value, note: note.value };
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
    const search = el('input.pb-search', { type: 'search', placeholder: 'חיפוש לפי שם, טלפון, מייל או הערה…', autocomplete: 'off' });
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
      const digits = q.replace(/\D/g, '').replace(/^972/, '0');
      const rank = (e) => {
        const name = e.name.toLowerCase();
        if (name.startsWith(q)) return 0;
        if (name.split(/[\s\-'"׳״.,()]+/).some((w) => w.startsWith(q))) return 1;
        if (name.includes(q)) return 2;
        if (digits.length >= 2 && e.phone.replace(/\D/g, '').replace(/^972/, '0').includes(digits)) return 3;
        if (e.email.toLowerCase().includes(q)) return 4;
        if (e.note.toLowerCase().includes(q)) return 5;
        return null;
      };
      return items.map((e) => ({ e, r: rank(e) })).filter((x) => x.r !== null)
        .sort((a, b) => a.r - b.r || a.e.name.localeCompare(b.e.name, 'he')).map((x) => x.e);
    }

    function viewRow(e) {
      return el('tr', {}, [
        el('td', {}, [el('b', { text: e.name })]),
        el('td', { dir: 'ltr', text: e.phone }),
        el('td', { dir: 'ltr', text: e.email }),
        el('td', { text: e.note }),
        el('td.mute-sm', { text: e.updatedBy ? `${e.updatedBy} · ${UI.formatDate(e.updatedAt)}` : '' }),
        el('td.pb-row-acts', {}, [
          callButton(e.phone) ?? gap(), mailButton(e.email) ?? gap(), aiButton(e),
          el('button.icon-btn', { type: 'button', title: 'עריכה', 'aria-label': `עריכת ${e.name}`, onclick: () => { editing = e.id; draw(); } }, ['✏']),
          el('button.icon-btn', {
            type: 'button', title: 'מחיקה', 'aria-label': `מחיקת ${e.name}`,
            onclick: async () => {
              if (!await UI.confirm(`למחוק את ${e.name} מהאלפון? הרשומה תימחק לכל העובדים.`, { danger: true, okText: 'מחיקה' })) return;
              try { await API.del(`/api/phonebook/${e.id}`); UI.success('נמחק'); load(); } catch (err) { UI.error(err); }
            }
          }, ['🗑'])
        ])
      ]);
    }

    /** עריכה בשורה עצמה: Enter שומר, Escape מבטל */
    function editRow(e) {
      const f = {
        name: el('input', { type: 'text', value: e.name }),
        phone: el('input', { type: 'tel', dir: 'ltr', value: e.phone }),
        email: el('input', { type: 'email', dir: 'ltr', value: e.email }),
        note: el('input', { type: 'text', value: e.note })
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
        el('td', {}, [f.name]), el('td', {}, [f.phone]), el('td', {}, [f.email]), el('td', {}, [f.note]), el('td'),
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
        : [el('tr', {}, [el('td', { colspan: 6 }, [UI.empty(items.length ? 'לא נמצא' : 'האלפון עוד ריק', '📒')])])]));
    }
    search.addEventListener('input', draw);

    const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv', style: { display: 'none' } });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) importFlow(fileInput.files[0], load); fileInput.value = ''; });

    UI.mount(container,
      el('div.page-head', {}, [
        el('div', {}, [
          el('h2', { text: '📒 אלפון ארגוני' }),
          el('div.sub', { text: 'טלפונים ומיילים משותפים לכל העובדים. כל אחד יכול להוסיף, לעדכן ולמחוק.' })
        ]),
        el('div.spacer'),
        el('div.pb-head-acts', {}, [
          el('button.btn.btn-primary', { onclick: () => editDialog({}, { onSaved: load }) }, ['＋ הוספה']),
          el('button.btn', { onclick: () => fileInput.click() }, ['⬆ ייבוא מאקסל']),
          el('a.btn', { href: '/api/phonebook/export', download: '' }, ['⬇ ייצוא'])
        ]),
        fileInput
      ]),
      el('div.card', {}, [
        el('div.card-pad', {}, [
          el('div.flex.pb-tools', {}, [search, summary]),
          el('div.table-wrap.pb-table-wrap', {}, [
            el('table.data.pb-table', {}, [
              el('thead', {}, [el('tr', {}, ['שם', 'טלפון', 'מייל', 'הערה', 'עודכן', ''].map((h) => el('th', { text: h })))]),
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
      title: `⬆ ייבוא לאלפון — ${file.name}`,
      size: 'wide',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 } }, [
          `${rows.length} שורות: ${ok} חדשות`,
          dups ? `, ${dups} כבר קיימות` : '',
          bad ? `, ${bad} עם שגיאה (יידלגו)` : '',
          preview.header ? '' : '. לא זוהו כותרות — הסדר נלקח כשם · טלפון · מייל · הערה.'
        ]),
        dups ? el('label.checkbox', {}, [withDups, ' לייבא גם את הכפולות']) : null,
        el('div.table-wrap.pb-import', {}, [
          el('table.data', {}, [
            el('thead', {}, [el('tr', {}, ['שורה', 'שם', 'טלפון', 'מייל', 'הערה', ''].map((h) => el('th', { text: h })))]),
            el('tbody', {}, rows.map((r) => el(`tr${r.error ? '.pb-bad' : r.duplicate ? '.pb-dup' : ''}`, {}, [
              el('td.mute-sm', { text: String(r.line) }),
              el('td', { text: r.name }), el('td', { dir: 'ltr', text: r.phone }), el('td', { dir: 'ltr', text: r.email }), el('td', { text: r.note }),
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

  return { card, openSearch, render, editDialog };
})();
