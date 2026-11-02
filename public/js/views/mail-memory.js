'use strict';
/**
 * 🧠 זיכרון העבודה — הפעלה, מצב, ו"מה העוזר יודע עליי".
 *
 *   section(…)  — האזור בחלון "חיבור Google ועוזר ה-AI": מיפוי (בלי AI), הערכת
 *                 עלות ואישור, התקדמות, השהיה, ו"שכח הכול".
 *   browse()    — עיון בזיכרון: אנשי קשר, רשומות ומסמכים. חיפוש, תיקון ומחיקה.
 */

const MailMemoryView = (() => {
  const { el } = UI;
  const KIND = { quote: 'הצעת מחיר', invoice: 'חשבונית', contract: 'חוזה', plan: 'תוכנית', permit: 'היתר', report: 'דוח', form: 'טופס', other: 'מסמך' };
  const OUTCOME = { closed: '✔ נסגר', open: '⏳ פתוח', stuck: '⚠ נתקע', cancelled: '✕ בוטל', info: 'ℹ מידע' };
  const num = (n) => Number(n ?? 0).toLocaleString('he-IL');
  const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL') : '');

  let poll = null;

  /**
   * @param {object} mem       ‎gmailInfo.memory‎ מהשרת
   * @param {(next?: object) => void} onChange
   */
  function section(mem, onChange) {
    const box = el('div.mm-box');
    let state = mem;

    const call = async (method, url, body) => {
      const r = method === 'del' ? await API.del(url) : method === 'put' ? await API.put(url, body ?? {}) : await API.post(url, body ?? {});
      state = r;
      draw();
      onChange?.();
    };
    const act = (label, fn, cls = '') => {
      const b = el(`button.btn.btn-sm${cls}`, { type: 'button' }, [label]);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await fn(); } catch (err) { UI.error(err); } finally { b.disabled = false; }
      });
      return b;
    };

    function schedule() {
      clearTimeout(poll);
      if (!['mapping', 'running'].includes(state.state)) return;
      poll = setTimeout(async () => {
        if (!box.isConnected) return;
        try { state = await API.get('/api/me/mail-memory'); draw(); } catch { /* בסבב הבא */ }
      }, 5000);
    }

    function options() {
      const from = el('input', { type: 'date' });
      const docs = el('input', { type: 'checkbox', checked: true });
      const internal = el('input', { type: 'checkbox', checked: true });
      const labels = el('input', { type: 'text', placeholder: 'למשל: אישי, משפחה', list: 'mm-labels' });
      const dl = el('datalist', { id: 'mm-labels' });
      API.get('/api/me/gmail/labels').then((r) => UI.mount(dl, ...r.labels.map((l) => el('option', { value: l })))).catch(() => {});
      const start = act('🧠 מיפוי התיבה', () => call('post', '/api/me/mail-memory/start', {
        fromDate: from.value || null, withDocs: docs.checked, internal: internal.checked,
        excludedLabels: labels.value.split(',').map((x) => x.trim()).filter(Boolean)
      }), '.btn-primary');
      return el('div', {}, [
        el('p.mute-sm', { style: { marginTop: 0 }, text: 'העוזר קורא את כל המיילים שלך — נכנסים ויוצאים — ולומד עם מי אתה עובד, על מה, ואיך זה נגמר. כך הוא מציע את מי לקחת, עונה על שאלות ומזכיר מסמכים שפג תוקפם. נשמר רק מה שהוסק — לא המיילים ולא הקבצים. מיילים אישיים מדולגים.' }),
        el('div.mm-grid', {}, [
          UI.field('מאיזה תאריך (ריק = מההתחלה)', from),
          UI.field('תוויות שלא נסרקות', el('div', {}, [labels, dl]))
        ]),
        el('label.checkbox', {}, [docs, ' לקרוא גם מסמכים מצורפים (הצעות מחיר, חשבוניות, חוזים)']),
        el('label.checkbox', {}, [internal, ' לכלול מיילים בין עובדים — "מי בארגון מטפל במה"']),
        el('div.mute-sm', { style: { margin: '6px 0' }, text: 'שלב ראשון — מיפוי בכותרות בלבד, בלי AI ובלי עלות. בסופו תראה כמה שרשורים נמצאו ומה הערכת העלות, והקריאה תתחיל רק אחרי שתאשר.' }),
        start
      ]);
    }

    function counts() {
      const c = state.counts ?? {};
      if (!c.people && !c.events && !c.docs) return null;
      return el('div.mm-counts', {}, [
        el('span', { text: `👤 ${num(c.people)} אנשי קשר` }),
        el('span', { text: `🗂 ${num(c.events)} רשומות` }),
        el('span', { text: `📎 ${num(c.docs)} מסמכים` }),
        el('button.btn.btn-sm', { type: 'button', onclick: () => browse() }, ['🧠 מה העוזר יודע עליי'])
      ]);
    }

    function forgetButton() {
      return act('שכח הכול', async () => {
        if (!await UI.confirm('למחוק את כל זיכרון העבודה — אנשי קשר, רשומות ומסמכים? אפשר לסרוק מחדש אחר כך.', { danger: true, okText: 'מחיקה' })) return;
        await call('del', '/api/me/mail-memory');
        UI.success('הזיכרון נמחק');
      }, '.btn-ghost');
    }

    function draw() {
      const s = state;
      const parts = [];
      if (!s.allowed) {
        parts.push(el('div.mute-sm', { text: 'זיכרון העבודה אינו פתוח עבורך כרגע — מנהל המערכת קובע מי משתתף (ניהול ← הגדרות).' }));
        if (s.counts?.people || s.counts?.events) parts.push(counts(), forgetButton());
        return UI.mount(box, ...parts);
      }
      if (!s.connected) return UI.mount(box, el('div.mute-sm', { text: 'אחרי חיבור Gmail אפשר להפעיל כאן את זיכרון העבודה.' }));
      if (!s.aiEnabled) return UI.mount(box, el('div.mute-sm', { text: 'חיבור ה-AI אינו מוגדר בשרת.' }));

      const q = s.queue ?? {};
      const st = s.stats ?? {};
      // כמה חשבונות Google — כולם נכנסים לזיכרון; תיבה שנוספה אחר כך ממופה לבד
      if ((s.boxes ?? []).length > 1) {
        parts.push(el('div.mute-sm', { text: `📬 ${s.boxes.length} תיבות: ${s.boxes.map((b) => b.email).filter(Boolean).join(' · ')}` }));
      }
      switch (s.state) {
        case 'idle':
          parts.push(options());
          break;
        case 'mapping':
          parts.push(el('div.ai-scan-progress', {}, [el('span.spinner-sm'), ` ממפה את התיבה (כותרות בלבד)… ${num(st.mapped)} שרשורים`]),
            el('div.mute-sm', { text: 'אפשר לסגור את החלון — המיפוי ממשיך ברקע, ותקבל התראה בסופו.' }),
            s.error ? el('div.mute-sm.text-warn', { text: `⏳ ${s.error}` }) : null,
            act('⏸ עצירה', () => call('post', '/api/me/mail-memory/pause')));
          break;
        case 'mapped':
        case 'paused': {
          const e = s.estimate ?? {};
          const docs = el('input', { type: 'checkbox', checked: s.withDocs });
          parts.push(
            el('div.mm-estimate', {}, [
              el('b', { text: s.state === 'paused' ? '⏸ הקריאה מושהית' : '✅ המיפוי הסתיים' }),
              el('div', { text: `${num(e.threads)} שרשורים לקריאה${q.skipped ? ` · ${num(q.skipped)} דולגו (דיוור, אישי, לא עניתי)` : ''}` }),
              el('div', { text: e.cost !== null && e.cost !== undefined ? `הערכת עלות: כ-$${e.cost} (מודל ${e.model})` : `הערכה: כ-${num(e.tokens)} טוקנים (מודל ${e.model})` }),
              e.docsTokens ? el('div.mute-sm', { text: `מתוכם מסמכים: ${e.threadsWithFiles} שרשורים עם קבצים${e.docsCost !== null && e.docsCost !== undefined ? ` · כ-$${e.docsCost}` : ''}` }) : null,
              el('div.mute-sm', { text: `קצב: עד ${num(s.perDay)} שרשורים ביום${s.hours ? `, בשעות ${s.hours}` : ''} — כ-${e.days} ימים. מהחדש לישן.` })
            ]),
            el('label.checkbox', {}, [docs, ' כולל מסמכים מצורפים']),
            el('div.flex', { style: { gap: '8px' } }, [
              act(s.state === 'paused' ? '▶ המשך' : '✓ אישור והתחלת קריאה', () => call('post', '/api/me/mail-memory/approve', { withDocs: docs.checked }), '.btn-primary'),
              s.state === 'mapped' ? act('מיפוי מחדש', () => call('post', '/api/me/mail-memory/start', { fromDate: s.fromDate, withDocs: s.withDocs, internal: s.internal, excludedLabels: s.excludedLabels })) : null
            ])
          );
          break;
        }
        case 'running': {
          const total = (q.done ?? 0) + (q.pending ?? 0);
          parts.push(
            el('div.ai-scan-progress', {}, [el('span.spinner-sm'), ` קורא… ${num(q.done)} מתוך ${num(total)} שרשורים${q.reachedBack ? ` · הגיע ל-${day(q.reachedBack)}` : ''}`]),
            el('div.mute-sm', { text: `${s.hours ? `הקריאה רצה בשעות ${s.hours}, ` : ''}עד ${num(s.perDay)} שרשורים ביום.${st.tokensIn ? ` נצרכו עד עכשיו כ-${num(Math.round((st.tokensIn + (st.tokensOut ?? 0)) / 1000))} אלף טוקנים.` : ''}` }),
            s.error ? el('div.mute-sm.text-warn', { text: `⏳ ${s.error}` }) : null,
            act('⏸ השהיה', () => call('post', '/api/me/mail-memory/pause'))
          );
          break;
        }
        case 'done':
          parts.push(el('div', { text: `✅ הזיכרון מוכן${s.lastIncrementalAt ? ` · עודכן ${UI.relative(s.lastIncrementalAt)}` : ''} — מתעדכן כל בוקר מהמיילים החדשים.` }));
          break;
        case 'error':
          parts.push(el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: `המיפוי נעצר: ${s.error}` })]),
            act('נסה שוב', () => call('post', '/api/me/mail-memory/start', { fromDate: s.fromDate, withDocs: s.withDocs, internal: s.internal, excludedLabels: s.excludedLabels }), '.btn-primary'));
          break;
        default:
          break;
      }
      const c = counts();
      if (c) parts.push(c);
      if (s.state !== 'idle' || c) parts.push(el('div.mm-foot', {}, [forgetButton()]));
      UI.mount(box, ...parts);
      schedule();
    }

    draw();
    return box;
  }

  // ------------------------------------------------------------ מה העוזר יודע עליי

  function browse() {
    let tab = 'people';
    let q = '';
    const list = el('div.mm-list');
    const search = el('input', { type: 'search', placeholder: 'חיפוש: מזגן, מודד, שם, חברה…' });
    const tabs = el('div.seg', {}, [['people', '👤 אנשי קשר'], ['events', '🗂 רשומות'], ['docs', '📎 מסמכים']].map(([key, label]) => {
      const b = el(`button${key === tab ? '.active' : ''}`, { type: 'button' }, [label]);
      b.addEventListener('click', () => { tab = key; for (const x of tabs.children) x.classList.toggle('active', x === b); load(); });
      return b;
    }));
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 300); });

    UI.modal({
      title: '🧠 מה העוזר יודע עליי',
      size: 'wide',
      body: el('div', {}, [
        el('div.mute-sm', { text: 'רק אתה רואה את זה. אפשר לתקן ולמחוק כל דבר — העוזר יתחשב בתיקון.' }),
        el('div.mm-tools', {}, [search, tabs]),
        list
      ])
    });

    async function load() {
      UI.mount(list, UI.spinner());
      try {
        const r = await API.get(`/api/me/mail-memory/browse?tab=${tab}&q=${encodeURIComponent(q)}`);
        const rows = [
          ...(r.people ?? []).map(personRow),
          ...(r.events ?? []).map(eventRow),
          ...(r.docs ?? []).map(docRow)
        ];
        UI.mount(list, ...(rows.length ? rows : [UI.empty(q ? 'לא נמצא' : 'עוד אין כאן כלום', '🧠')]));
      } catch (err) {
        UI.mount(list, UI.empty(err.message, '⚠️'));
      }
    }

    const del = (kind, id, row) => {
      const b = el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'מחיקה מהזיכרון' }, ['🗑']);
      b.addEventListener('click', async () => {
        try { await API.del(`/api/me/mail-memory/${kind}/${id}`); row.remove(); } catch (err) { UI.error(err); }
      });
      return b;
    };

    function personRow(p) {
      const row = el('div.mm-row');
      const edit = el('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'תיקון' }, ['✎']);
      edit.addEventListener('click', () => editPerson(p, (next) => { Object.assign(p, next); row.replaceWith(personRow(p)); }));
      UI.mount(row,
        el('div.mm-row-main', {}, [
          el('div', {}, [el('b', { text: p.name || p.email }), p.role ? el('span', { text: ` · ${p.role}` }) : null, p.company ? el('span.mute-sm', { text: ` · ${p.company}` }) : null, p.internal ? el('span.ai-chip', { text: 'עובד' }) : null]),
          el('div.mute-sm', {}, [el('bdi', { text: p.email }), p.phone ? el('span', { text: ` · ${p.phone}${p.phoneVerified ? '' : ' (לא מאומת)'}` }) : null]),
          el('div.mute-sm', { text: `${num(p.threads)} שרשורים · ממנו ${num(p.mailsIn)}, אליו ${num(p.mailsOut)}${p.lastAt ? ` · אחרון ${day(p.lastAt)}` : ''}${p.replyHours !== null && p.replyHours !== undefined ? ` · עונה תוך ~${p.replyHours < 24 ? `${p.replyHours} שעות` : `${Math.round(p.replyHours / 24)} ימים`}` : ''}` })
        ]),
        edit, del('person', p.id, row));
      return row;
    }

    function eventRow(e) {
      const row = el('div.mm-row');
      UI.mount(row,
        el('div.mm-row-main', {}, [
          el('div', {}, [el('b', { text: e.domain || 'אירוע' }), el('span.mute-sm', { text: ` · ${day(e.happened_at)} · ${OUTCOME[e.outcome] ?? ''}` }), e.amount ? el('span.ai-chip', { text: e.amount }) : null]),
          el('div', { text: e.summary }),
          e.contact_email ? el('div.mute-sm', {}, [el('bdi', { text: e.contact_email })]) : null
        ]),
        e.link ? el('a.btn.btn-sm.btn-ghost', { href: e.link, target: '_blank', rel: 'noopener', title: 'פתח ב-Gmail' }, ['📧']) : null,
        del('event', e.id, row));
      return row;
    }

    function docRow(d) {
      const row = el('div.mm-row');
      const f = d.fields ?? {};
      UI.mount(row,
        el('div.mm-row-main', {}, [
          el('div', {}, [el('b', { text: `📎 ${KIND[d.kind] ?? 'מסמך'}` }), el('span', { text: ` · ${d.title || d.filename}` })]),
          el('div.mute-sm', { text: [d.filename, d.doc_date ? day(d.doc_date) : null, f.amount, f.number ? `מס' ${f.number}` : null, f.gush_helka, d.valid_until ? `בתוקף עד ${day(d.valid_until)}` : null].filter(Boolean).join(' · ') })
        ]),
        d.link ? el('a.btn.btn-sm.btn-ghost', { href: d.link, target: '_blank', rel: 'noopener', title: 'פתח ב-Gmail' }, ['📧']) : null,
        del('doc', d.id, row));
      return row;
    }

    load();
    setTimeout(() => search.focus(), 50);
  }

  function editPerson(p, done) {
    const name = el('input', { type: 'text', value: p.name });
    const role = el('input', { type: 'text', value: p.role, placeholder: 'מה הוא עושה בשבילך — "טכנאי מזגנים"' });
    const company = el('input', { type: 'text', value: p.company });
    const phone = el('input', { type: 'tel', value: p.phone });
    const save = el('button.btn.btn-primary', { type: 'button' }, ['שמירה']);
    const m = UI.modal({
      title: `✎ ${p.email}`,
      body: el('div', {}, [UI.field('שם', name), UI.field('תפקיד בשבילי', role), UI.field('חברה', company), UI.field('טלפון', phone),
        el('div.mute-sm', { text: 'מה שתיקנת כאן לא יידרס בסריקות הבאות.' })]),
      footer: [save, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const next = await API.put(`/api/me/mail-memory/people/${p.id}`, { name: name.value, role: role.value, company: company.value, phone: phone.value });
        m.close();
        done(next);
      } catch (err) { save.disabled = false; UI.error(err); }
    });
  }

  return { section, browse };
})();
