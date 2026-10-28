'use strict';
/**
 * שדה השלמה לנמען — מקלידים "משה", ומופיעים כל המשה-ים: עובדים, ספקים, מי
 * שפניתי אליו בעבר, אנשי הקשר שלי ב-Google, ספריית הארגון, ומי שהתכתבתי איתו
 * ולא שמרתי. בחירה ממלאת שם, מייל וטלפון — לא מקלידים אותם.
 *
 * החיפוש בשרת (‎GET /api/ai/contacts‎) על עותק מקומי של אנשי הקשר, ולכן הוא
 * מיידי. בלי חיבור Google השדה עובד כמו קודם — עובדים, ספקים ונמענים קודמים.
 *
 * משמש באשף משימת AI, בעריכת פרטי הנמען, ובכרטיס המשימה ("⭐ שמור").
 */

const ContactPicker = (() => {
  const { el } = UI;

  const SOURCE = {
    user: { icon: '👤', label: 'עובד/ת' },
    vendor: { icon: '🏢', label: 'ספק' },
    recent: { icon: '🕘', label: 'פנית בעבר' },
    contacts: { icon: 'G', label: 'אנשי הקשר שלי' },
    directory: { icon: '🏛', label: 'ספריית הארגון' },
    other: { icon: '✉', label: 'התכתבת' }
  };

  /**
   * @param {object} opts
   * @param {string} [opts.value]                    השם ההתחלתי
   * @param {(c: object) => void} opts.onPick         נבחר איש קשר
   * @param {() => void} [opts.onType]                המשתמש הקליד שם חופשי (לא מהרשימה)
   * @returns {{node: HTMLElement, input: HTMLInputElement}}
   */
  function create({ value = '', onPick, onType = () => {} } = {}) {
    const input = el('input', { type: 'text', value, placeholder: 'שם, חברה, מייל או טלפון', autocomplete: 'off' });
    const list = el('div.cp-list', { role: 'listbox' });
    const node = el('div.cp', {}, [input, list]);

    let results = [];
    let google = null;
    let active = -1;
    let timer = null;
    let seq = 0;

    const hide = () => { list.classList.remove('open'); active = -1; };

    async function search() {
      const mine = ++seq;
      try {
        const data = await API.get(`/api/ai/contacts?q=${encodeURIComponent(input.value.trim())}`);
        if (mine !== seq) return; // תשובה ישנה שהגיעה אחרי חדשה
        results = data.contacts;
        google = data.google;
        draw();
      } catch {
        /* החיפוש אינו תנאי — אפשר תמיד להקליד ידנית */
      }
    }

    function draw() {
      if (document.activeElement !== input) return hide();
      const rows = results.map((c, i) => {
        const s = SOURCE[c.source] ?? SOURCE.contacts;
        const detail = [c.phone, c.email].filter(Boolean).join(' · ');
        return el(`div.cp-row${i === active ? '.active' : ''}`, {
          role: 'option',
          onmousedown: (e) => { e.preventDefault(); pick(c); }
        }, [
          el(`span.cp-ic.cp-${c.source}`, { title: s.label, text: s.icon }),
          el('div.cp-main', {}, [
            el('div', {}, [
              el('b', { text: c.name || c.email || c.phone }),
              c.organization ? el('span.mute-sm', { text: ` · ${c.organization}` }) : null,
              c.source === 'user' ? el('span.mute-sm', { text: ' (עובד/ת)' }) : null
            ]),
            detail ? el('div.mute-sm', { dir: 'auto', text: detail }) : null
          ]),
          c.unsaved ? el('span.cp-unsaved', { text: 'לא שמור' }) : null
        ]);
      });
      const foot = google && !google.available
        ? el('div.cp-foot', {}, ['חברו את אנשי הקשר של Google כדי לבחור מהם · ', el('a', { href: '/api/me/gmail/connect', onmousedown: (e) => e.preventDefault() }, ['חיבור'])])
        : google?.running ? el('div.cp-foot', { text: 'אנשי הקשר מסתנכרנים מ-Google…' }) : null;
      UI.mount(list, ...rows, foot);
      list.classList.toggle('open', rows.length > 0 || Boolean(foot));
    }

    function pick(c) {
      input.value = c.name || c.email || c.phone || '';
      hide();
      onPick(c);
    }

    input.addEventListener('input', () => {
      onType(input.value);
      clearTimeout(timer);
      timer = setTimeout(search, 160);
    });
    input.addEventListener('focus', () => { clearTimeout(timer); timer = setTimeout(search, 60); });
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('open') || !results.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % results.length; draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + results.length) % results.length; draw(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(results[active]); }
      else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
    });

    return { node, input };
  }

  /**
   * לאיש קשר כמה מיילים או טלפונים — בחירה קטנה ("עבודה / נייד"). מחזיר ‎null‎
   * כשיש אחד בלבד מכל סוג.
   */
  function variants(c, { onEmail, onPhone }) {
    const chip = (item, current, fn) => el(`button.cp-chip${item.value === current ? '.on' : ''}`, {
      type: 'button', dir: 'auto', onclick: () => fn(item.value)
    }, [item.label ? `${item.label}: ` : '', item.value]);
    const emails = (c.emails ?? []).length > 1 ? c.emails : [];
    const phones = (c.phones ?? []).length > 1 ? c.phones : [];
    if (!emails.length && !phones.length) return null;
    const box = el('div.cp-variants');
    const draw = (email, phone) => UI.mount(box,
      emails.length ? el('div', {}, [el('span.mute-sm', { text: 'מייל: ' }), ...emails.map((x) => chip(x, email, (v) => { onEmail(v); draw(v, phone); }))]) : null,
      phones.length ? el('div', {}, [el('span.mute-sm', { text: 'טלפון: ' }), ...phones.map((x) => chip(x, phone, (v) => { onPhone(v); draw(email, v); }))]) : null);
    draw(c.email, c.phone);
    return box;
  }

  /**
   * "⭐ שמור באנשי הקשר של Google" — עם השלמת שם וטלפון לפני השמירה.
   * ‎contact.resourceName‎ של "איש קשר אחר" מועתק; אחרת נוצר חדש.
   */
  function saveDialog(contact, { onSaved = () => {} } = {}) {
    const name = el('input', { type: 'text', value: contact.name ?? '' });
    const email = el('input', { type: 'email', dir: 'ltr', value: contact.email ?? '' });
    const phone = el('input', { type: 'tel', dir: 'ltr', value: contact.phone ?? '' });
    const ok = el('button.btn.btn-primary', {}, ['⭐ שמירה']);
    const m = UI.modal({
      title: '⭐ שמירה באנשי הקשר של Google',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 }, text: 'איש הקשר יישמר אצלך ב-Google, ויופיע מעכשיו בכל מקום — בטלפון, ב-Gmail ובמשימון.' }),
        UI.field('שם', name),
        el('div.row', {}, [UI.field('מייל', email), UI.field('טלפון', phone)])
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        const res = await API.post('/api/ai/contacts/save', {
          resourceName: contact.source === 'other' ? contact.resourceName : null,
          name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim()
        });
        m.close();
        UI.success('נשמר באנשי הקשר');
        onSaved(res.contact);
      } catch (err) {
        ok.disabled = false;
        UI.error(err);
      }
    });
  }

  /**
   * הצעה לשמור נמען שאינו באנשי הקשר — בכרטיס משימת AI, אחרי שליחה.
   * "לא, תודה" נזכר לאותה כתובת ולא שואל שוב.
   */
  function suggestion(contact) {
    const box = el('div');
    if (!contact?.email && !contact?.phone) return box;
    const q = new URLSearchParams({ email: contact.email ?? '', phone: contact.phone ?? '' });
    API.get(`/api/ai/contacts/check?${q}`).then(({ suggest }) => {
      if (!suggest) return;
      const no = el('button.btn.btn-sm.btn-ghost', {}, ['לא, תודה']);
      no.addEventListener('click', async () => {
        box.remove();
        API.post('/api/ai/contacts/dismiss', { email: contact.email, phone: contact.phone }).catch(() => {});
      });
      UI.mount(box, el('div.alert.alert-info.cp-suggest', {}, [
        el('span', { text: '⭐' }),
        el('div', {}, [el('b', { text: contact.name || contact.email || contact.phone }), ' אינו באנשי הקשר שלך ב-Google.']),
        el('div.spacer'),
        el('button.btn.btn-sm.btn-primary', { onclick: () => saveDialog(contact, { onSaved: () => box.remove() }) }, ['⭐ שמור']),
        no
      ]));
    }).catch(() => {});
    return box;
  }

  return { create, variants, saveDialog, suggestion, SOURCE };
})();
