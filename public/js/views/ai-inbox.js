'use strict';
/**
 * "✨ ממתין לאישורך" — כל מה שהעוזר מחכה בו למשתמש, בחלון אחד בדף הבית:
 *
 *   • היום יוצאים     — הנדנודים המתוכננים להיום. עצור · דחה · דיברתי איתו.
 *                        מה שלא נעצר יוצא כמתוכנן.
 *   • מחכה להחלטה שלך — תזכורת לאישור, "ראיתי שהתכתבת", "סוכם בטלפון", שאלה.
 *   • מהמייל          — הצעות משימה מהסריקה. אישור · עריכה · דחייה · הפוך למשימת AI.
 *   • נוספו לבד       — משימות משולחים מהימנים, עם ביטול.
 *
 * וגם חיבור ה-Gmail האישי (‎openGmail‎), מ"החשבון שלי".
 */

const AiInboxView = (() => {
  const { el } = UI;

  const ROLE_LABEL = { assignee: 'אחראי/ת', co_assignee: 'שותף/ה', watcher: 'לידיעה', checklist: 'סעיף' };
  const CHANNEL_LABEL = { email: '📧 מייל', whatsapp: '💬 וואטסאפ', system: '🔔 תזכורת במשימון' };

  const load = () => API.get('/api/ai/inbox');

  const time = (iso) => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  /** פעולה על כפתור — נעילה בזמן הבקשה, שגיאה למשתמש, ורענון בסוף */
  function run(button, fn, reload) {
    return async () => {
      if (button) button.disabled = true;
      try {
        await fn();
        await reload();
      } catch (err) {
        if (button) button.disabled = false;
        UI.error(err);
      }
    };
  }

  // ------------------------------------------------------------ החלון

  let pollTimer = null;

  /**
   * @param {object} data   התשובה של ‎/api/ai/inbox‎
   * @param {{reload: () => Promise}} opts
   * @returns {HTMLElement|null}  ‎null‎ כשאין מה להציג וגם אין תיבה מחוברת
   */
  function card(data, { reload }) {
    const g = data.gmail;
    const pending = data.suggestions.pending;
    const auto = data.suggestions.auto;
    const total = data.upcoming.length + data.waiting.length + pending.length;
    if (!total && !auto.length && !g.connection) return null;

    // בזמן סריקה — רענון קצר עד שהיא מסתיימת. רק כל עוד החלון עדיין על המסך:
    // אחרי מעבר למסך אחר, רענון של דף הבית היה דורס אותו
    clearTimeout(pollTimer);
    let node = null;
    if (g.connection?.scanning) pollTimer = setTimeout(() => { if (node?.isConnected) reload(); }, 5000);

    const sections = [];

    if (g.connection?.scanning) {
      const p = g.connection.progress ?? {};
      sections.push(el('div.ai-scan-progress', {}, [
        el('span.spinner-sm'),
        ` סורק את המייל… ${p.done ?? 0} מתוך ${p.total ?? '?'}`,
        p.suggested ? ` · ${p.suggested} הצעות` : ''
      ]));
    } else if (g.connection?.state === 'revoked') {
      sections.push(el('div.alert.alert-warn', {}, [el('span', { text: '📭' }), el('div', {}, [
        'החיבור ל-Gmail בוטל. ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); openGmail(reload); } }, ['לחיבור מחדש'])
      ])]));
    }

    if (data.upcoming.length) {
      sections.push(section('🔔 היום יוצאים בשמך', 'מה שלא תעצרו — יוצא כמתוכנן', data.upcoming.map((u) => upcomingRow(u, reload))));
    }
    if (data.waiting.length) {
      sections.push(section('✋ מחכה להחלטה שלך', null, data.waiting.map((w) => waitingRow(w, reload))));
    }
    if (pending.length) {
      const all = el('button.btn.btn-sm', {}, ['✓ אשר הכול']);
      all.title = 'מאשר את ההצעות שכולן שלך. הצעות עם אנשים נוספים או פנייה החוצה נשארות לבדיקה';
      all.addEventListener('click', run(all, async () => {
        const r = await API.post('/api/ai/suggestions/approve-all');
        UI.success(`${r.approved} משימות נוצרו${r.left ? ` · ${r.left} נשארו לבדיקה שלך` : ''}`);
        App.refreshNotifications();
      }, reload));
      sections.push(section('📧 מהמייל', null, pending.map((s) => suggestionRow(s, reload)), all));
    }
    if (auto.length) {
      sections.push(section('➕ נוספו לבד', 'משולחים שסימנת כמהימנים', auto.map((s) => autoRow(s, reload))));
    }
    if (!sections.length) {
      sections.push(UI.empty(g.connection?.lastScanAt ? `אין כלום שמחכה לך. סריקה אחרונה: ${UI.relative(g.connection.lastScanAt)}` : 'אין כלום שמחכה לך', '✅'));
    }

    node = el('div.card.ai-inbox', {}, [
      el('div.card-head', {}, [
        el('span', { text: '✨' }),
        el('h3', { text: 'ממתין לאישורך' }),
        total ? el('span.ai-count', { text: String(total) }) : null,
        el('div.spacer'),
        g.connection?.state === 'ok' && g.scanEnabled
          ? el('button.btn.btn-sm', { disabled: g.connection.scanning, onclick: () => scanDialog(reload) }, ['🔍 סרוק עכשיו'])
          : null,
        el('button.btn.btn-sm.btn-ghost', { title: 'חיבור Gmail והעדפות', onclick: () => openGmail(reload) }, ['⚙'])
      ]),
      el('div.card-pad', {}, [el('div.feed-scroll', {}, sections)])
    ]);
    return node;
  }

  function section(title, hint, rows, action = null) {
    return el('div.ai-sec', {}, [
      el('div.ai-sec-head', {}, [el('b', { text: title }), hint ? el('span.mute-sm', { text: ` · ${hint}` }) : null, el('div.spacer'), action]),
      ...rows
    ]);
  }

  // ------------------------------------------------------------ היום יוצאים

  function upcomingRow(u, reload) {
    const stop = el('button.btn.btn-sm.btn-ghost', {}, ['עצור']);
    stop.addEventListener('click', async () => {
      if (!await UI.confirm(`לעצור את המעקב מול ${u.contactName}? לא יישלחו עוד תזכורות.`, { okText: 'עצירה' })) return;
      run(stop, () => API.post(`/api/ai/tasks/${u.taskId}/action`, { action: 'stop' }), reload)();
    });
    const later = el('button.btn.btn-sm', {}, ['דחה ליום']);
    later.addEventListener('click', run(later, () => API.post(`/api/ai/tasks/${u.taskId}/action`, { action: 'postpone', days: 1 }), reload));
    const talk = el('button.btn.btn-sm', { onclick: () => AiTaskView.talked({ id: u.taskId, title: u.title }, () => reload()) }, ['📞 דיברתי איתו']);
    return el('div.ai-row', {}, [
      el('div.ai-row-main', { onclick: () => TaskCardView.open(u.taskId) }, [
        el('div', {}, [el('b', { text: u.contactName }), el('span.mute-sm', { text: ` · ${CHANNEL_LABEL[u.channel] ?? ''}${u.attempt ? ` · ניסיון ${u.attempt}` : ''} · ${new Date(u.at) < new Date() ? 'בסבב הקרוב' : `מ-${time(u.at)}`}` })]),
        el('div.mute-sm', { text: u.title })
      ]),
      el('div.ai-row-actions', {}, [talk, later, stop])
    ]);
  }

  // ------------------------------------------------------------ מחכה להחלטה

  function waitingRow(w, reload) {
    const open = () => TaskCardView.open(w.taskId);
    let what;
    let actions = [];
    if (w.attention === 'approve_reminder' && w.draft) {
      what = el('div', {}, [el('div', { text: `תזכורת ל${w.contactName} ממתינה לאישורך:` }), el('div.ai-quote', { text: w.draft.body })]);
      const send = el('button.btn.btn-sm.btn-primary', {}, ['✓ שלח']);
      send.addEventListener('click', run(send, () => API.post(`/api/ai/tasks/${w.taskId}/messages/${w.draft.id}/approve`, {}), reload));
      const skip = el('button.btn.btn-sm', {}, ['דלג על התזכורת']);
      skip.addEventListener('click', run(skip, () => API.post(`/api/ai/tasks/${w.taskId}/messages/${w.draft.id}/discard`), reload));
      actions = [send, el('button.btn.btn-sm', { onclick: open }, ['✎ עריכה']), skip,
        el('button.btn.btn-sm', { onclick: () => AiTaskView.talked({ id: w.taskId, title: w.title }, () => reload()) }, ['📞 דיברתי איתו'])];
    } else if (w.attention === 'contact_detected' || w.attention === 'handled_elsewhere') {
      what = el('div', { text: w.attention === 'contact_detected'
        ? (w.question || `ראיתי שהתכתבת עם ${w.contactName}. מה המצב?`)
        : `${w.contactName} כתב/ה שזה סוכם מחוץ להתכתבות${w.summary ? ` — ${w.summary}` : ''}. מה המצב?` });
      actions = [el('button.btn.btn-sm.btn-primary', { onclick: () => AiTaskView.talked({ id: w.taskId, title: w.title }, () => reload()) }, ['📞 עדכון'])];
    } else if (w.state === 'stalled') {
      what = el('div', { text: `לא התקבלה תשובה מ${w.contactName}. ${w.error || ''}`.trim() });
      const again = el('button.btn.btn-sm', {}, ['🔁 סבב נוסף']);
      again.addEventListener('click', run(again, () => API.post(`/api/ai/tasks/${w.taskId}/action`, { action: 'resume' }), reload));
      const stop = el('button.btn.btn-sm.btn-ghost', {}, ['עצירה']);
      stop.addEventListener('click', run(stop, () => API.post(`/api/ai/tasks/${w.taskId}/action`, { action: 'stop' }), reload));
      actions = [again, el('button.btn.btn-sm', { onclick: () => AiTaskView.talked({ id: w.taskId, title: w.title }, () => reload()) }, ['📞 דיברתי איתו']), stop];
    } else {
      // טיוטת תשובה, שאלה מהנמען — ההקשר המלא בכרטיס
      what = el('div', { text: w.question || (w.draft ? `טיוטה ל${w.contactName} ממתינה לאישורך` : w.summary || 'נדרשת החלטה שלך') });
      actions = [el('button.btn.btn-sm.btn-primary', { onclick: open }, ['פתיחה'])];
    }
    return el('div.ai-row', {}, [
      el('div.ai-row-main', { onclick: open }, [el('div.mute-sm', { text: w.title }), what]),
      el('div.ai-row-actions', {}, actions)
    ]);
  }

  // ------------------------------------------------------------ הצעות מהמייל

  function peopleChips(people) {
    return (people ?? []).map((p) => el('span.ai-chip', { text: `${p.name} · ${ROLE_LABEL[p.role] ?? ''}${p.role === 'checklist' ? ` ${p.checklistIndex}` : ''}` }));
  }

  function fromLine(s) {
    return el('div.mute-sm', {}, [
      `מאת ${s.from.name}`,
      s.receivedAt ? ` · ${UI.relative(s.receivedAt)}` : '',
      s.link ? el('a', { href: s.link, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, [' · פתיחת המייל ↗']) : null
    ]);
  }

  function suggestionRow(s, reload) {
    if (s.kind === 'duplicate') {
      const join = el('button.btn.btn-sm.btn-primary', {}, ['צרף אותי']);
      join.addEventListener('click', run(join, () => API.post(`/api/ai/suggestions/${s.id}/join`), reload));
      const skip = el('button.btn.btn-sm', {}, ['דלג']);
      skip.addEventListener('click', run(skip, () => API.post(`/api/ai/suggestions/${s.id}/skip`), reload));
      return el('div.ai-row', {}, [
        el('div.ai-row-main', { onclick: () => s.taskId && TaskCardView.open(s.taskId) }, [
          el('div', {}, [el('b', { text: 'כבר קיימת משימה' }), ` — אצל ${s.data.ownerName ?? 'עמית'}`]),
          el('div.mute-sm', { text: s.data.taskTitle ?? s.subject }),
          fromLine(s)
        ]),
        el('div.ai-row-actions', {}, [join, skip])
      ]);
    }

    const d = s.data;
    const approve = el('button.btn.btn-sm.btn-primary', {}, ['✓ אישור']);
    approve.addEventListener('click', run(approve, () => API.post(`/api/ai/suggestions/${s.id}/approve`, {}), reload));
    const reject = el('button.btn.btn-sm.btn-ghost', {}, ['✕']);
    reject.title = 'דחייה';
    reject.addEventListener('click', () => rejectDialog(s, reload));
    const toAi = el('button.btn.btn-sm', {}, ['✨ משימת AI']);
    toAi.title = 'לבקש את זה ממישהו — העוזר ינסח פנייה לאישורך ויעקוב';
    toAi.addEventListener('click', () => AiTaskView.openDialog({
      suggestionId: s.id,
      instruction: d.aiRequest?.instruction || `${d.title}. ${d.summary}`,
      contact: d.aiRequest ? { name: d.aiRequest.contactName, email: d.aiRequest.contactEmail, phone: d.aiRequest.contactPhone } : {},
      onCreated: () => reload()
    }));

    const flags = [
      d.dueDate ? el('span.ai-chip', { text: `📅 ${new Date(`${d.dueDate}T12:00:00`).toLocaleDateString('he-IL')}` }) : null,
      d.priority && d.priority !== 'normal' ? el('span.ai-chip.ai-chip-warn', { text: d.priority === 'urgent' ? 'דחוף' : 'גבוהה' }) : null,
      d.checklist?.length ? el('span.ai-chip', { text: `☑ ${d.checklist.length} שלבים` }) : null,
      ...peopleChips(d.people),
      d.aiRequest ? el('span.ai-chip.ai-chip-ai', { text: '✨ בקשה מגורם אחר' }) : null
    ];

    return el('div.ai-row', {}, [
      el('div.ai-row-main', { onclick: () => editSuggestion(s, reload) }, [
        el('div', {}, [el('b', { text: d.title })]),
        d.summary ? el('div.ai-sum', { text: d.summary }) : null,
        el('div.ai-chips', {}, flags),
        d.warning ? el('div.alert.alert-warn.ai-mini', {}, [el('span', { text: '⚠️' }), el('div', { text: `שימו לב: ${d.warning}` })]) : null,
        d.ambiguous?.length ? el('div.mute-sm', { text: `❓ לא ברור למי הכוונה: ${d.ambiguous.join(', ')} — בחרו בעריכה` }) : null,
        d.alsoSuggestedTo?.length ? el('div.mute-sm', { text: `👥 הוצע גם ל${d.alsoSuggestedTo.join(', ')}` }) : null,
        fromLine(s)
      ]),
      el('div.ai-row-actions', {}, [
        // הצעה עם אנשים נוספים או ספק מחייבת מבט — האישור המהיר עובר דרך העריכה
        (d.people?.length || d.ambiguous?.length || d.warning) ? el('button.btn.btn-sm.btn-primary', { onclick: () => editSuggestion(s, reload) }, ['בדיקה ואישור']) : approve,
        el('button.btn.btn-sm', { onclick: () => editSuggestion(s, reload) }, ['✎']),
        toAi,
        reject
      ])
    ]);
  }

  function autoRow(s, reload) {
    const undo = el('button.btn.btn-sm.btn-ghost', {}, ['ביטול']);
    undo.addEventListener('click', run(undo, () => API.post(`/api/ai/suggestions/${s.id}/undo`), reload));
    return el('div.ai-row', {}, [
      el('div.ai-row-main', { onclick: () => s.taskId && TaskCardView.open(s.taskId) }, [el('b', { text: s.data.title }), fromLine(s)]),
      el('div.ai-row-actions', {}, [undo])
    ]);
  }

  async function rejectDialog(s, reload) {
    const ignore = el('input', { type: 'checkbox' });
    const ok = el('button.btn.btn-primary', {}, ['דחייה']);
    const m = UI.modal({
      title: 'דחיית ההצעה',
      body: el('div', {}, [
        el('p', { text: `"${s.data.title}" לא תיווצר, ולא תוצע שוב.` }),
        el('label.checkbox', {}, [ignore, ` לא להציע יותר משימות מ-${s.from.email}`])
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    ok.addEventListener('click', run(ok, async () => {
      await API.post(`/api/ai/suggestions/${s.id}/reject`, { ignoreSender: ignore.checked });
      m.close();
    }, reload));
  }

  /**
   * עריכה ואישור — כותרת, תקציר, יעד, צ'קליסט ומי מעורב. כל שיוך לעובד אחר
   * נבדק בשרת לפי ההרשאות; מה שלא מורשה ייכשל עם הסבר ולא ייווצר בשקט.
   */
  function editSuggestion(s, reload) {
    const d = s.data;
    const title = el('input', { type: 'text', value: d.title });
    const summary = el('textarea', {});
    summary.value = d.summary ?? '';
    const due = el('input', { type: 'date', value: d.dueDate ?? '' });
    const priority = UI.select([
      { value: 'normal', label: 'רגילה' }, { value: 'high', label: 'גבוהה' }, { value: 'urgent', label: 'דחופה' }, { value: 'low', label: 'נמוכה' }
    ], d.priority ?? 'normal');
    const project = UI.select([{ value: '', label: 'ללא פרויקט' }, ...App.state.projects.filter((p) => p.mine).map((p) => ({ value: p.id, label: p.name }))], '');

    // אנשים — שורה לכל אחד, עם תפקיד שאפשר לשנות או להסיר
    const people = (d.people ?? []).map((p) => ({ ...p }));
    const users = App.state.users.filter((u) => u.id !== App.state.actor.id);
    const peopleBox = el('div');
    const drawPeople = () => UI.mount(peopleBox, el('div.ai-people', {}, [
      ...people.map((p, i) => {
        const role = UI.select(Object.entries(ROLE_LABEL).filter(([k]) => k !== 'checklist' || p.role === 'checklist').map(([value, label]) => ({ value, label })), p.role);
        role.addEventListener('change', () => { p.role = role.value; });
        return el('div.ai-person', {}, [
          el('b', { text: p.name }), role,
          el('button.btn.btn-sm.btn-ghost', { onclick: () => { people.splice(i, 1); drawPeople(); } }, ['הסרה'])
        ]);
      }),
      addPerson()
    ]));
    function addPerson() {
      const pick = UI.select([{ value: '', label: '+ הוספת עובד/ת' }, ...users.map((u) => ({ value: u.id, label: u.name }))], '');
      pick.addEventListener('change', () => {
        const u = users.find((x) => String(x.id) === pick.value);
        if (u && !people.some((p) => p.userId === u.id && p.role !== 'checklist')) people.push({ userId: u.id, name: u.name, role: 'co_assignee', checklistIndex: 0 });
        drawPeople();
      });
      return pick;
    }
    drawPeople();

    const checklist = el('textarea', { placeholder: 'סעיף בכל שורה' });
    checklist.value = (d.checklist ?? []).join('\n');
    const trust = el('input', { type: 'checkbox', checked: s.trusted });

    const ok = el('button.btn.btn-primary', {}, ['✓ יצירת המשימה']);
    const m = UI.modal({
      title: '📧 משימה מהמייל',
      size: 'wide',
      body: el('div', {}, [
        el('div.ai-letter', {}, [
          el('div', {}, [el('b', { text: s.subject || '(ללא נושא)' })]),
          fromLine(s)
        ]),
        d.warning ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: d.warning })]) : null,
        UI.field('כותרת', title),
        UI.field('תקציר', summary, 'יופיע בתיאור המשימה. עמיתים שישויכו יראו את התקציר והכותרת — לא את המייל עצמו'),
        el('div.row', {}, [UI.field('תאריך יעד', due), UI.field('עדיפות', priority), UI.field('פרויקט', project)]),
        UI.field('צ׳קליסט', checklist),
        el('div.ai-section-title', { text: 'מי עוד מעורב' }),
        d.ambiguous?.length ? el('div.mute-sm', { text: `❓ לא ברור למי הכוונה: ${d.ambiguous.join(', ')} — הוסיפו ידנית אם צריך`, style: { marginBottom: '6px' } }) : null,
        peopleBox,
        el('div.mute-sm', { text: 'אחראי/ת — המשימה אצלו/ה, ואת/ה נשאר/ת שותף/ה. שותף/ה — אחראי/ת נוסף/ת. לידיעה — מתויג/ת בהערה ומקבל/ת עדכונים.', style: { margin: '6px 0 10px' } }),
        el('label.checkbox', {}, [trust, ` מ-${s.from.email} — ליצור ישר בפעם הבאה (רק משימות שכולן שלך)`])
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });

    ok.addEventListener('click', run(ok, async () => {
      const items = checklist.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const res = await API.post(`/api/ai/suggestions/${s.id}/approve`, {
        title: title.value.trim(),
        summary: summary.value.trim(),
        dueDate: due.value,
        priority: priority.value,
        projectId: project.value || null,
        checklist: items,
        people: people.filter((p) => p.role !== 'checklist' || p.checklistIndex <= items.length),
        trustSender: trust.checked && !s.trusted
      });
      m.close();
      UI.success('המשימה נוצרה');
      App.refreshNotifications();
      if (res.taskId) TaskCardView.open(res.taskId);
    }, reload));
  }

  // ------------------------------------------------------------ סריקה

  function scanDialog(reload) {
    let range = 'yesterday';
    const from = el('input', { type: 'date' });
    const to = el('input', { type: 'date' });
    const custom = el('div.row', { style: { display: 'none' } }, [UI.field('מתאריך', from), UI.field('עד תאריך', to)]);
    const seg = el('div.seg', {}, [
      ['yesterday', 'מאתמול'], ['week', 'שבוע אחרון'], ['month', 'חודש אחרון'], ['custom', 'בין תאריכים']
    ].map(([key, label]) => {
      const b = el(`button${key === range ? '.active' : ''}`, { type: 'button' }, [label]);
      b.addEventListener('click', () => {
        range = key;
        for (const x of seg.children) x.classList.toggle('active', x === b);
        custom.style.display = key === 'custom' ? '' : 'none';
      });
      return b;
    }));
    const go = el('button.btn.btn-primary', {}, ['🔍 סריקה']);
    const m = UI.modal({
      title: '🔍 סריקת המייל',
      body: el('div', {}, [
        el('p', { style: { marginTop: 0 }, text: 'רק מיילים שלא נקראו בדואר הנכנס. פרסומות ורשתות חברתיות מדולגות, ומייל שכבר נסרק לא ייסרק שוב.' }),
        seg,
        custom
      ]),
      footer: [go, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    go.addEventListener('click', run(go, async () => {
      if (range === 'custom' && !from.value) { from.focus(); throw new Error('נדרש תאריך התחלה'); }
      await API.post('/api/me/gmail/scan', { range, from: from.value, to: to.value });
      m.close();
      UI.success('הסריקה התחילה — ההצעות יופיעו כאן');
    }, reload));
  }

  // ------------------------------------------------------------ חיבור Gmail והעדפות

  async function openGmail(onChange = () => {}) {
    let info;
    try {
      info = await API.get('/api/me/gmail');
    } catch (err) {
      return UI.error(err);
    }
    const body = el('div');
    const m = UI.modal({ title: '🔗 חיבור Google ועוזר ה-AI', body, size: 'wide' });

    const refresh = (next) => { info = next; draw(); onChange(); };
    const pref = (key, label, hint) => {
      const box = el('input', { type: 'checkbox', checked: Boolean(info.prefs[key]) });
      box.addEventListener('change', async () => {
        try { refresh(await API.put('/api/me/ai-prefs', { [key]: box.checked })); } catch (err) { box.checked = !box.checked; UI.error(err); }
      });
      return el('div.ai-pref', {}, [el('label.checkbox', {}, [box, ` ${label}`]), hint ? el('div.mute-sm', { text: hint }) : null]);
    };

    function draw() {
      const c = info.connection;
      const connectBox = !info.enabled
        ? el('div.alert.alert-warn', {}, [el('span', { text: '⚠️' }), el('div', { text: 'חיבור Google אינו מוגדר בשרת. מנהל המערכת צריך להגדיר אותו — ראו "הגדרת Gmail ו-AI".' })])
        : !c || c.state !== 'ok'
          ? el('div', {}, [
              c?.state === 'revoked' ? el('div.alert.alert-warn', {}, [el('span', { text: '📭' }), el('div', { text: c.error || 'החיבור בוטל — יש לחבר מחדש' })]) : null,
              el('p', { style: { marginTop: 0 } }, [
                'אישור אחד ב-Google, ל',
                el('b', { text: 'דואר, יומן ואנשי קשר' }),
                ':'
              ]),
              el('ul.google-what', {}, [
                el('li', { text: '📧 Gmail — מיילים של משימות AI ייצאו מהתיבה שלך (רק מה שאישרת) ויישארו אצלך ב"דואר יוצא"; התשובות ייקלטו; מיילים שלא נקראו יהפכו להצעות משימה. משימון לא מוחק ולא מסמן כנקרא.' }),
                el('li', { text: '📅 יומן — הפגישות של היום ב-Today. ההרשאה כוללת כתיבה לפיצ\'רים עתידיים; כרגע משימון רק קורא.' }),
                el('li', { text: '👥 אנשי קשר — בחירת נמען במשימת AI בלי להקליד מייל וטלפון, ושמירת איש קשר חדש בלחיצה.' })
              ]),
              el('div.mute-sm', { style: { marginBottom: '10px' }, text: 'במסך של Google — סמנו את כל התיבות.' }),
              el('a.btn.btn-primary', { href: '/api/me/gmail/connect' }, ['חיבור Google'])
            ])
          : el('div', {}, [
              // חיבור מלפני היומן ואנשי הקשר — אישור אחד נוסף משלים אותו
              c.missing?.some((k) => ['calendar', 'contacts'].includes(k))
                ? el('div.alert.alert-warn', {}, [el('span', { text: '🔄' }), el('div', {}, [
                    `חסר בחיבור: ${[c.missing.includes('calendar') ? 'יומן' : null, c.missing.includes('contacts') ? 'אנשי קשר' : null].filter(Boolean).join(' ו')}. `,
                    el('a', { href: '/api/me/gmail/connect' }, ['חיבור מחדש']),
                    ' — אותו מסך של Google, לסמן את כל התיבות.'
                  ])])
                : null,
              !c.canSend
                ? el('div.alert.alert-warn', {}, [el('span', { text: '✉️' }), el('div', {}, [
                    'התיבה מחוברת לקריאה בלבד, ולכן מיילים של משימות AI לא יוצאים ממנה. ',
                    el('a', { href: '/api/me/gmail/connect' }, ['חיבור מחדש עם הרשאת שליחה'])
                  ])])
                : null,
              el('div.flex', { style: { gap: '8px', alignItems: 'center' } }, [
                el('span', { text: '✅' }), el('b', { text: c.email }),
                el('span.mute-sm', { text: [c.scopes?.mail ? (c.canSend ? '📧 קריאה ושליחה' : '📧 קריאה') : null, c.scopes?.calendar ? '📅 יומן' : null, c.scopes?.contacts ? '👥 אנשי קשר' : null].filter(Boolean).join(' · ') }),
                el('span.mute-sm', { text: c.lastScanAt ? `סריקה אחרונה ${UI.relative(c.lastScanAt)}` : 'עוד לא נסרקה' }),
                el('div.spacer'),
                (() => {
                  const b = el('button.btn.btn-sm.btn-ghost', {}, ['ניתוק']);
                  b.addEventListener('click', async () => {
                    if (!await UI.confirm('לנתק את Google? הסריקה תיפסק, תזכורות במייל לא ייצאו, היומן ייעלם מ-Today, אנשי הקשר יימחקו ממשימון, וההרשאה תבוטל גם ב-Google.', { danger: true, okText: 'ניתוק' })) return;
                    try { refresh(await API.del('/api/me/gmail')); } catch (err) { UI.error(err); }
                  });
                  return b;
                })()
              ]),
              info.scanEnabled
                ? el('div.mute-sm', { style: { marginTop: '6px' }, text: `סריקה אוטומטית כל בוקר ב-${info.scanTime}, עד ${info.dailyLimit} מיילים ביום.` })
                : el('div.mute-sm', { style: { marginTop: '6px' }, text: 'סריקת המיילים כבויה כרגע במסך הניהול.' }),
              info.scanEnabled ? el('button.btn.btn-sm.mt', { onclick: () => { m.close(); scanDialog(onChange); } }, ['🔍 סרוק עכשיו']) : null,
              contactsLine()
            ]);

      /** אנשי הקשר: כמה סונכרנו, מתי, ורענון */
      function contactsLine() {
        const g = info.contacts;
        if (!g?.available) return null;
        const counts = g.counts ?? {};
        const parts = [
          counts.contacts !== undefined ? `${counts.contacts} שמורים` : null,
          counts.directory !== undefined ? `${counts.directory} בספריית הארגון` : null,
          counts.other !== undefined ? `${counts.other} שהתכתבת איתם` : null
        ].filter(Boolean);
        const sync = el('button.btn.btn-sm', { disabled: g.running }, [g.running ? 'מסתנכרן…' : '🔄 רענון']);
        sync.addEventListener('click', async () => {
          sync.disabled = true;
          try {
            await API.post('/api/me/google/contacts/sync');
            UI.success('אנשי הקשר מסתנכרנים ברקע');
            setTimeout(async () => { try { info = await API.get('/api/me/gmail'); draw(); } catch { /* נשאר */ } }, 4000);
          } catch (err) {
            sync.disabled = false;
            UI.error(err);
          }
        });
        return el('div.flex.mt', { style: { gap: '8px', flexWrap: 'wrap' } }, [
          el('span', { text: '👥' }),
          el('span.mute-sm', { text: g.lastSyncAt ? `אנשי קשר: ${parts.join(' · ') || g.total} · עודכן ${UI.relative(g.lastSyncAt)}` : 'אנשי הקשר עוד לא סונכרנו' }),
          sync,
          g.error ? el('span.mute-sm.text-warn', { text: g.error }) : null
        ]);
      }

      const senderRows = info.senders.map((x) => {
        const b = el('button.btn.btn-sm.btn-ghost', {}, ['הסרה']);
        b.addEventListener('click', async () => { try { refresh(await API.put('/api/me/mail-senders', { email: x.email, mode: null })); } catch (err) { UI.error(err); } });
        return el('div.ai-person', {}, [el('span', { text: x.mode === 'trust' ? '⭐' : '🚫' }), el('bdi', { text: x.email }), el('span.mute-sm', { text: x.mode === 'trust' ? 'נוצר ישר' : 'לא מציעים' }), el('div.spacer'), b]);
      });

      UI.mount(body,
        el('div.ai-section-title', { text: 'חשבון Google' }),
        connectBox,
        el('div.ai-section-title', { text: 'העדפות', style: { marginTop: '16px' } }),
        pref('approveReminders', 'כל תזכורת שלי מחכה לאישור לפני שיוצאת',
          'כבוי: אחרי שאישרת את הפנייה הראשונה, התזכורות יוצאות לבד — ובכל בוקר רואים "היום יוצאים" ואפשר לעצור. אפשר לשנות גם לכל משימה בנפרד.'),
        pref('mailAutoCreate', 'ליצור משימות מהמייל בלי אישור',
          'רק משימות שכולן שלך — בלי עובדים נוספים ובלי פנייה החוצה. הן מופיעות תחת "נוספו לבד" עם ביטול.'),
        info.senders.length ? el('div.ai-section-title', { text: 'שולחים', style: { marginTop: '16px' } }) : null,
        ...senderRows
      );
    }
    draw();
  }

  /** החזרה מ-Google אחרי חיבור התיבה — ‎?gmail=connected‎ או ‎?gmailError=…‎ */
  function handleReturn() {
    const q = new URLSearchParams(location.search);
    if (!q.has('gmail') && !q.has('gmailError')) return;
    const error = q.get('gmailError');
    history.replaceState(null, '', location.pathname);
    if (error) {
      UI.toast(`חיבור Google נכשל: ${error}`, 'error');
      return;
    }
    UI.success('חשבון Google חובר — דואר, יומן ואנשי קשר');
    setTimeout(() => scanDialog(() => HomeView.reload()), 300);
  }

  return { load, card, openGmail, scanDialog, handleReturn, editSuggestion, rejectDialog };
})();
