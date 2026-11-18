'use strict';
/**
 * מסך הניהול — "🤖 סוכנים וידע ארגוני":
 *   • 🤖 סוכנים — הפעלה וכיבוי, ולאילו מחלקות (ביטוי; ריק = כולם), הכלים של כל סוכן
 *   • 🌐 מקורות נתונים — מצב שרתי הנתונים
 *   • 📚 ידע ארגוני — כל הערכים: חיפוש, מחלקה, נושא, "חדש השבוע", עריכה, הסתרה, מחיקה, מקור
 *   • 🔒 טבלת רגישות — הנושאים, המחלקות של כל נושא ורמת המינימום; מי ההנהלה; "איך זה נראה לעובד"
 *   • 📜 יומן — מי שאל, איזה סוכן ענה, אילו כלים
 * הכול עולה מיד; מנהל המערכת מתקן כשהוא רואה צורך.
 */

const AdminAiView = (() => {
  const { el } = UI;

  async function tab(body) {
    let sub = 'knowledge';
    const holder = el('div');
    const seg = el('div.seg', {}, [['knowledge', '📚 ידע ארגוני'], ['topics', '🔒 טבלת רגישות'], ['memory', '🧠 זיכרון'], ['agents', '🤖 סוכנים'], ['log', '📜 יומן']].map(([key, label]) => {
      const b = el(`button${key === sub ? '.active' : ''}`, { type: 'button' }, [label]);
      b.addEventListener('click', () => { sub = key; for (const x of seg.children) x.classList.toggle('active', x === b); draw(); });
      return b;
    }));
    UI.mount(body, el('div.card', {}, [el('div.card-pad', {}, [seg, holder])]));
    const draw = () => (sub === 'knowledge' ? knowledge(holder) : sub === 'topics' ? topicsView(holder) : sub === 'memory' ? memory(holder) : sub === 'agents' ? agents(holder) : log(holder));
    draw();
  }

  // ------------------------------------------------------------ 📚 ידע ארגוני

  async function knowledge(holder) {
    let q = '';
    let dept = '';
    let topic = '';
    let week = false;
    let topicsTable = {};
    const list = el('div.mm-list');
    const statsLine = el('div.mute-sm');
    const search = el('input', { type: 'search', placeholder: 'חיפוש בידע הארגוני…' });
    const deptSel = el('select');
    const topicSel = el('select');
    const weekBox = el('input', { type: 'checkbox' });
    const run = el('button.btn.btn-sm', { type: 'button', title: 'זיקוק של מה שנוסף לזיכרון אצל כל העובדים, ואיחוד — עכשיו, בלי לחכות לבוקר' }, ['🔄 עדכן עכשיו']);
    const blockInput = el('textarea', { rows: '2', placeholder: 'שמות לקוחות, מופרדים בפסיק — יוסרו תמיד מהידע' });
    const blockSave = el('button.btn.btn-sm', { type: 'button' }, ['שמירה']);
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 300); });
    deptSel.addEventListener('change', () => { dept = deptSel.value; load(); });
    topicSel.addEventListener('change', () => { topic = topicSel.value; load(); });
    weekBox.addEventListener('change', () => { week = weekBox.checked; load(); });
    run.addEventListener('click', async () => {
      run.disabled = true;
      try { await API.post('/api/admin/knowledge/run'); UI.success('העדכון רץ ברקע — הערכים יופיעו כאן כשיסתיים'); } catch (err) { UI.error(err); }
      setTimeout(() => { run.disabled = false; load(); }, 4000);
    });
    blockSave.addEventListener('click', async () => {
      try { await API.put('/api/admin/knowledge/blocklist', { blocklist: blockInput.value }); UI.success('נשמר'); } catch (err) { UI.error(err); }
    });

    UI.mount(holder,
      el('p.mute-sm', { text: '"איך פעלנו אצלנו" — מזיכרון העבודה של כל העובדים, לפי סכמה קבועה: איזו מחלקה פעלה ואיך (בלי שמות עובדים), לאיזה ספק או בעל מקצוע פנתה — בשם, עם טלפון ומייל, והניסיון איתו טוב ורע, כולל תלונות — כמה זה עלה (מדויק) וכמה זמן לקח, ומקור עם חודש ושנה בלבד ("מקור: מחלקת בדק, מרץ 2026"). כל ערך עולה מיד — אין מה לאשר — ומשמש את העוזר, ההצעות "איך לסגור" ו"✨ שאל". כאן מתקנים, מסתירים ומוחקים כשרואים צורך.' }),
      el('div.mm-tools', {}, [search, deptSel, topicSel, el('label.checkbox', {}, [weekBox, ' חדש השבוע']), run]),
      statsLine,
      list,
      el('details', { style: { marginTop: '12px' } }, [el('summary', { text: 'לקוחות שתמיד יוסרו' }), blockInput, blockSave])
    );

    async function load() {
      UI.mount(list, UI.spinner());
      try {
        const r = await API.get(`/api/admin/knowledge?q=${encodeURIComponent(q)}&dept=${dept}&topic=${encodeURIComponent(topic)}&week=${week ? 1 : 0}`);
        topicsTable = r.topics ?? {};
        if (!topicSel.children.length) {
          UI.mount(topicSel, el('option', { value: '' }, ['כל הנושאים']), el('option', { value: '_none' }, ['🔒 לא מסווג']), ...Object.entries(topicsTable).map(([k, t]) => el('option', { value: k }, [t.label])));
        }
        if (!deptSel.children.length) {
          UI.mount(deptSel, el('option', { value: '' }, ['כל המחלקות']), ...Object.entries(r.depts).filter(([, v]) => v).map(([k, v]) => el('option', { value: k }, [v])));
          blockInput.value = r.blocklist ?? '';
        }
        const s = r.stats;
        statsLine.textContent = `${s.total} ערכים · ${s.newThisWeek} עודכנו השבוע${s.hidden ? ` · ${s.hidden} מוסתרים` : ''}${s.pendingLessons ? ` · ${s.pendingLessons} לקחים בעיבוד — עולים אוטומטית בעדכון הבא, בלי אישור` : ''}${s.oldFormat ? ` · ${s.oldFormat} ערכים ישנים נכתבים מחדש לפי הסכמה` : ''}${s.unclassified ? ` · 🔒 ${s.unclassified} ממתינים לסיווג — גלויים להנהלה בלבד עד אז` : ''}${s.lastMerge ? ` · עדכון אחרון ${UI.relative(s.lastMerge)}` : ''}`;
        UI.mount(list, ...(r.entries.length ? r.entries.map(entryRow) : [UI.empty(q ? 'לא נמצא' : 'עוד אין ידע ארגוני. הוא נבנה מזיכרון העבודה של העובדים — כל בוקר.', '📚')]));
      } catch (err) {
        UI.mount(list, UI.empty(err.message, '⚠️'));
      }
    }

    function entryRow(e) {
      const row = el(`div.mm-row${e.hidden ? '.mm-hidden' : ''}`);
      const act = (label, title, fn) => {
        const b = el('button.btn.btn-sm.btn-ghost', { type: 'button', title }, [label]);
        b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (err) { UI.error(err); } b.disabled = false; });
        return b;
      };
      UI.mount(row,
        el('div.mm-row-main', {}, [
          el('div', {}, [el('b', { text: e.domain }), e.project ? el('span.ai-chip', { text: `📁 ${e.project}` }) : null, e.deptLabel ? el('span.mute-sm', { text: ` · ${e.deptLabel}` }) : null,
            classChip(e, topicsTable),
            e.hidden ? el('span.ai-chip.ai-chip-warn', { text: 'מוסתר' }) : null, e.edited ? el('span.ai-chip', { text: 'נערך ידנית' }) : null]),
          el('div.mask-a', { text: e.text }),
          el('div.mute-sm', { text: `${e.cases} מקרים · ${e.contributors} עובדים · עודכן ${UI.relative(e.updated_at)}` })
        ]),
        e.masked ? null : act('✎', 'עריכה — כולל נושא ורמה', () => editEntry(e, topicsTable, load)),
        e.masked && (e.sens || 0) < 4 ? act('🔒', 'להחמיר לסודי — הנהלה בלבד', async () => { await API.put(`/api/admin/knowledge/${e.id}`, { sens: 4 }); load(); }) : null,
        e.masked ? null : act('🔍', 'מאיפה זה', () => showSources(e)),
        act(e.hidden ? '👁' : '🙈', e.hidden ? 'הצגה' : 'הסתרה', async () => { await API.put(`/api/admin/knowledge/${e.id}`, { hidden: !e.hidden }); load(); }),
        act('🗑', 'מחיקה', async () => {
          if (!await UI.confirm(`למחוק את "${e.domain}" מהידע הארגוני? המקרים שהרכיבו אותו לא יתאחדו לערך חדש.`, { danger: true, okText: 'מחיקה' })) return;
          await API.del(`/api/admin/knowledge/${e.id}`);
          row.remove();
        })
      );
      return row;
    }

    load();
  }

  const LEVEL_TEXT = { 1: '🟢 כללי — כל העובדים', 2: '🔵 מקצועי — עובדי המחלקות של הנושא', 3: '🟠 רגיש — מנהלי המחלקות של הנושא והנהלה', 4: '🔴 סודי — הנהלה בלבד' };

  function classChip(e, table) {
    if (!e.classified || !e.topic) return el('span.ai-chip.ai-chip-warn', { text: '🔒 לא מסווג — הנהלה בלבד', title: 'ייסווג בעדכון הבא. עד אז עובדים לא מקבלים אותו' });
    const t = table[e.topic];
    const lvl = Math.max(e.sens || 4, t?.floor ?? 4);
    return el(`span.ai-chip${lvl >= 3 ? '.ai-chip-warn' : ''}`, { text: `${t?.label ?? e.topic} · ${LEVEL_TEXT[lvl].split(' — ')[0]}`, title: LEVEL_TEXT[lvl] });
  }

  function editEntry(e, table, done) {
    const domain = el('input', { type: 'text', value: e.domain });
    const project = el('input', { type: 'text', value: e.project ?? '' });
    const text = el('textarea', { rows: '10' });
    text.value = e.text;
    const topicSel = el('select', {}, [el('option', { value: '' }, ['— בחר נושא —']), ...Object.entries(table).map(([k, t]) => el('option', { value: k }, [t.label]))]);
    topicSel.value = e.topic || '';
    const sensSel = el('select');
    const fillSens = () => {
      const floor = table[topicSel.value]?.floor ?? 1;
      UI.mount(sensSel, ...[1, 2, 3, 4].filter((l) => l >= floor).map((l) => el('option', { value: String(l) }, [LEVEL_TEXT[l]])));
      sensSel.value = String(Math.max(e.sens || 4, floor));
    };
    topicSel.addEventListener('change', fillSens);
    fillSens();
    const save = el('button.btn.btn-primary', { type: 'button' }, ['שמירה']);
    const m = UI.modal({
      title: `✎ ${e.domain}`,
      size: 'wide',
      body: el('div', {}, [UI.field('תחום', domain), UI.field('פרויקט', project), UI.field('הטקסט', text),
        UI.field('נושא', topicSel), UI.field('רמת רגישות', sensSel),
        el('div.mute-sm', { text: 'מה שתכתוב כאן לא יידרס באיחוד הבא — מידע חדש יתווסף בסוף, תחת "עדכונים:". הרמה לא יורדת מתחת למינימום של הנושא. מספרי ת"ז, חשבונות וכרטיסים יוסרו גם מכאן.' })]),
      footer: [save, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const body = { domain: domain.value, project: project.value, text: text.value };
        if (topicSel.value) Object.assign(body, { topic: topicSel.value, sens: Number(sensSel.value) });
        await API.put(`/api/admin/knowledge/${e.id}`, body);
        m.close();
        done();
      } catch (err) { save.disabled = false; UI.error(err); }
    });
  }

  // ------------------------------------------------------------ 🔒 טבלת רגישות

  async function topicsView(holder) {
    UI.mount(holder, UI.spinner());
    let r;
    try { r = await API.get('/api/admin/knowledge/topics'); } catch (err) { UI.mount(holder, UI.empty(err.message, '⚠️')); return; }
    const rows = Object.entries(r.topics).map(([key, t]) => {
      const label = el('input', { type: 'text', value: t.label });
      const deps = el('input', { type: 'text', value: t.departments.join(', '), placeholder: 'חלקי שמות מחלקות, בפסיק · * = כל המחלקות' });
      const floor = el('select', {}, [1, 2, 3, 4].map((l) => el('option', { value: String(l) }, [LEVEL_TEXT[l].split(' — ')[0]])));
      floor.value = String(t.floor);
      const examples = el('textarea', { rows: '2' });
      examples.value = t.examples;
      return { key, label, deps, floor, examples, row: el('tr', {}, [el('td', {}, [label]), el('td', {}, [deps]), el('td', {}, [floor]), el('td', {}, [examples])]) };
    });
    const save = el('button.btn.btn-primary', { type: 'button' }, ['שמירת הטבלה']);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const topics = {};
        for (const x of rows) topics[x.key] = { label: x.label.value, departments: x.deps.value.split(',').map((d) => d.trim()).filter(Boolean), floor: Number(x.floor.value), examples: x.examples.value };
        await API.put('/api/admin/knowledge/topics', { topics });
        UI.success('נשמר — הסיווג של כל ערך נבדק מחדש מיד לפי הטבלה');
      } catch (err) { UI.error(err); }
      save.disabled = false;
    });

    // "איך זה נראה לעובד"
    const pvDept = el('select', {}, [el('option', { value: '' }, ['בלי מחלקה']), ...r.departments.map((d) => el('option', { value: String(d.id) }, [d.name]))]);
    const pvRole = el('select', {}, [['employee', 'עובד'], ['manager', 'מנהל מחלקה'], ['executive', 'הנהלה'], ['admin', 'מנהל מערכת'], ['superadmin', 'אדמין על']].map(([v, l]) => el('option', { value: v }, [l])));
    const pvOut = el('div.mm-list');
    const preview = async () => {
      try {
        const p = await API.get(`/api/admin/knowledge/preview?department=${pvDept.value}&role=${pvRole.value}`);
        UI.mount(pvOut, ...p.rows.map((x) => el('div.mm-row', {}, [el('div.mm-row-main', {}, [el('b', { text: x.label }), el('span.mute-sm', { text: ` · ${x.upTo ? `רואה עד ${LEVEL_TEXT[x.upTo].split(' — ')[0]}` : 'לא רואה כלום'}` })])])));
      } catch (err) { UI.error(err); }
    };
    pvDept.addEventListener('change', preview);
    pvRole.addEventListener('change', preview);

    UI.mount(holder,
      el('p.mute-sm', { text: 'כל פריט בידע הארגוני מסווג לפי התוכן שלו — נושא ורמת רגישות — ולא לפי מי כתב אותו או באיזו תיבה. הטבלה קובעת מי רואה: 🟢 כללי — כל העובדים · 🔵 מקצועי — העובדים במחלקות של הנושא · 🟠 רגיש — רק מנהלי המחלקות של הנושא, וההנהלה · 🔴 סודי — ההנהלה בלבד. הרמה של פריט לא יורדת מתחת למינימום של הנושא שלו. הדוגמאות נכנסות להנחיות הסיווג של ה-AI.' }),
      el('div', { style: { overflowX: 'auto' } }, [el('table.data', {}, [
        el('thead', {}, [el('tr', {}, ['נושא', 'מחלקות הנושא', 'מינימום', 'דוגמאות לפי רמה'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows.map((x) => x.row))
      ])]),
      save,
      el('h4', { text: '👑 ההנהלה — רואה את כל הרמות', style: { marginTop: '16px' } }),
      el('p.mute-sm', { text: 'אדמין על, ו"הנהלה" שאינו משויך למחלקה מקצועית (בלי מחלקה, או מחלקה בשם הנהלה / מנכ"ל). "הנהלה" שמשויך למחלקה אחרת — למשל סמנכ"ל כספים במחלקת כספים — מקבל את מה שמנהל המחלקה שלו מקבל. מנהל מערכת אינו הנהלה.' }),
      el('div.mm-list', {}, r.leadership.map((u) => el('div.mm-row', {}, [el('div.mm-row-main', {}, [el('b', { text: u.name }), el('span.mute-sm', { text: ` · ${u.leader ? '👑 הנהלה — רואה הכול' : `כמנהל ${u.departments.join(' › ') || ''}`}` })])]))),
      el('h4', { text: '👁 איך זה נראה לעובד', style: { marginTop: '16px' } }),
      el('div.mm-tools', {}, [pvDept, pvRole]),
      pvOut
    );
    preview();
  }

  async function showSources(e) {
    try {
      const r = await API.get(`/api/admin/knowledge/${e.id}/sources`);
      UI.modal({
        title: `🔍 מאיפה: ${e.domain}`,
        body: el('div.mm-list', {}, r.sources.length
          ? r.sources.map((s) => el('div.mm-row', {}, [el('div.mm-row-main', {}, [
              el('div', {}, [el('b', { text: s.user_name || 'עובד' }), el('span.mute-sm', { text: ` · ${s.happened_at ?? ''}` })]),
              el('div', { text: s.summary })
            ])]))
          : [UI.empty('אין מקורות רשומים', '🔍')])
      });
    } catch (err) {
      UI.error(err);
    }
  }

  // ------------------------------------------------------------ 🧠 זיכרון העבודה של העובדים

  const STATE = { idle: '⚪ טרם התחיל', mapping: '🗺 ממפה', mapped: '⏳ ממתין לאישור', running: '📖 קורא', paused: '⏸ מושהה', done: '✅ מוכן', error: '⚠️ נעצר' };

  async function memory(holder) {
    UI.mount(holder, UI.spinner());
    let r;
    try { r = await API.get('/api/admin/mail-memory'); } catch (err) { return UI.mount(holder, UI.empty(err.message, '⚠️')); }
    const total = r.users.reduce((n, u) => n + (u.cost ?? 0), 0);
    const act = (u, action, label, confirmText) => {
      const b = el('button.btn.btn-sm', { type: 'button' }, [label]);
      b.addEventListener('click', async () => {
        if (confirmText && !await UI.confirm(confirmText, { danger: true, okText: label })) return;
        b.disabled = true;
        try { await API.post(`/api/admin/mail-memory/${u.userId}/${action}`); memory(holder); } catch (err) { b.disabled = false; UI.error(err); }
      });
      return b;
    };
    UI.mount(holder,
      el('p.mute-sm', { text: r.auto
        ? `סריקה אוטומטית: כל עובד שחיבר Gmail נסרק לבד — העובדים אינם רואים את זה. ${r.hours ? `קריאת ההיסטוריה בשעות ${r.hours}, ` : ''}עד ${r.perDay} שרשורים ביום לעובד${r.night?.on ? ` — ובמצב לילה (${r.night.hours}) בלי תקרה, ברצף${r.night.now ? '. 🌙 מצב לילה פעיל עכשיו' : ''}` : ''}.`
        : 'סריקה ידנית: כל עובד מפעיל בעצמו ומאשר עלות. (ההגדרה "זיכרון העבודה: סריקה אוטומטית" — בהגדרות המערכת.)' }),
      el('div.mute-sm', { text: `${r.users.length} עובדים · עלות עד עכשיו: כ-$${Math.round(total * 100) / 100}` }),
      // 🌙 זיכרון השרת — כמה נקרא במקביל עכשיו, והשיא (מאז שהשרת עלה)
      r.memory ? el('div.mute-sm', { text: `זיכרון השרת: ${r.memory.rssMb}MB מתוך תקרת לילה של ${r.memory.budgetMb}MB · נקראים עכשיו ${r.memory.reading} במקביל (ביום עד ${r.memory.dayParallel}, בלילה עד ${r.memory.maxNight})${r.memory.peakMb ? ` · שיא ${r.memory.peakMb}MB עם ${r.memory.peakReading} במקביל, ${UI.relative(r.memory.peakAt)}` : ''}${r.memory.heldBack ? ` · ${r.memory.heldBack} פעמים חיכה לזיכרון` : ''}` }) : null,
      el('div.mm-list', {}, r.users.length ? r.users.map((u) => {
        const q = u.queue ?? {};
        const total = (q.done ?? 0) + (q.pending ?? 0);
        return el('div.mm-row', {}, [
          el('div.mm-row-main', {}, [
            el('div', {}, [el('b', { text: u.name }), el('span.mute-sm', { text: ` · ${STATE[u.state] ?? u.state}` })]),
            el('div.mute-sm', { text: [
              u.boxes.length ? `📬 ${u.boxes.join(', ')}` : '📭 לא מחובר',
              u.state === 'mapping' ? `${u.mapped} שרשורים מופו` : total ? `${q.done ?? 0} מתוך ${total} נקראו` : null,
              `👤 ${u.counts?.people ?? 0} · 🗂 ${u.counts?.events ?? 0} · 📎 ${u.counts?.docs ?? 0}`,
              u.cost !== null ? `$${u.cost}` : null,
              u.lastIncrementalAt ? `עדכון ${UI.relative(u.lastIncrementalAt)}` : null
            ].filter(Boolean).join(' · ') }),
            u.error ? el('div.mute-sm.text-warn', { text: `⏳ ${u.error}` }) : null
          ]),
          ['running', 'mapping'].includes(u.state) ? act(u, 'pause', '⏸ השהיה') : null,
          ['paused', 'error', 'idle', 'mapped'].includes(u.state) ? act(u, 'resume', '▶ המשך') : null,
          act(u, 'forget', '↺ איפוס', `למחוק את כל זיכרון העבודה של ${u.name} ולסרוק מחדש מההתחלה?`)
        ]);
      }) : [UI.empty('עוד אף עובד לא חיבר Gmail', '🧠')])
    );
  }

  // ------------------------------------------------------------ 🤖 סוכנים

  async function agents(holder) {
    UI.mount(holder, UI.spinner());
    let r;
    try { r = await API.get('/api/admin/agents'); } catch (err) { return UI.mount(holder, UI.empty(err.message, '⚠️')); }
    const byDept = new Map();
    for (const a of r.agents) {
      if (!byDept.has(a.deptLabel)) byDept.set(a.deptLabel, { icon: a.deptIcon, list: [] });
      byDept.get(a.deptLabel).list.push(a);
    }
    const mcpRows = Object.entries(r.mcp ?? {}).map(([k, s]) => el('div.mute-sm', { text: `${s.started ? '🟢' : '⚪'} ${s.label ?? k}${s.toolCount ? ` · ${s.toolCount} כלים` : ''}${s.lastError ? ` · ${s.lastError}` : ''}` }));
    const healthBox = el('div');
    let last = null;
    try { last = (await API.get('/api/admin/agents/health')).last; } catch { /* בלי תוצאה קודמת */ }
    const runBtn = el('button.btn.btn-primary', { type: 'button' }, ['🩺 בדיקת סוכנים']);
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = '🩺 בודק… (עד דקה)';
      try { drawHealth(healthBox, (await API.post('/api/admin/agents/health')).last); } catch (err) { UI.error(err); }
      runBtn.disabled = false;
      runBtn.textContent = '🩺 בדיקה שוב';
    });
    if (last) drawHealth(healthBox, last);
    UI.mount(holder,
      el('div.ai-sec', {}, [
        el('div.ai-sec-head', {}, [el('b', { text: '🩺 בדיקת סוכנים' }), el('span.mute-sm', { text: ' · מהשרת החי: קריאה אמיתית לכל מקור נתונים, ל-AI, למחשבונים ול-Timeless שלך' })]),
        el('div', { style: { margin: '6px 0' } }, [runBtn]),
        healthBox
      ]),
      el('p.mute-sm', { text: `כל הסוכנים פתוחים לכל העובדים, חוץ ממה שהוגבל כאן. "מחלקות" — ביטוי שמתאים לשם המחלקה (ריק = כולם; מנהלי מערכת תמיד). תקרה: ${r.dailyLimit} שאלות ביום לעובד.` }),
      ...[...byDept.entries()].map(([label, g]) => el('div.ai-sec', {}, [
        el('div.ai-sec-head', {}, [el('b', { text: `${g.icon} ${label}` })]),
        ...g.list.map(agentRow)
      ])),
      el('div.ai-sec', {}, [el('div.ai-sec-head', {}, [el('b', { text: '🌐 מקורות נתונים' }), el('span.mute-sm', { text: ' · עולים כשסוכן צריך אותם לראשונה' })]), ...(mcpRows.length ? mcpRows : [el('div.mute-sm', { text: 'עוד לא הופעלו מאז שהשרת עלה.' })])])
    );
  }

  function drawHealth(box, h) {
    const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '➖');
    const stateMark = { ok: '✅', partial: '⚠️', error: '❌', unknown: '➖' };
    const okCount = h.agents.filter((a) => a.state === 'ok').length;
    UI.mount(box,
      el('div.mute-sm', { text: `נבדק ${UI.relative(h.at)}${h.by ? ` · ${h.by}` : ''} · ${okCount} מתוך ${h.agents.length} סוכנים עובדים במלואם` }),
      el('div.ai-health', {}, [
        el('b', { text: 'תשתית' }),
        el('div', { text: `${mark(h.claude.ok)} AI (${h.claude.model})${h.claude.ms ? ` · ${(h.claude.ms / 1000).toFixed(1)} ש׳` : ''}${h.claude.error ? ` — ${h.claude.error}` : ''}` }),
        ...h.mcp.map((m) => el('div', { title: m.sample || m.error }, [
          `${m.state === 'warming' ? '⏳' : mark(m.ok)} ${m.label} · ${(m.ms / 1000).toFixed(1)} ש׳`,
          m.state === 'warming' ? el('span.mute-sm', { text: ' — עלה, טוען בפעם הראשונה; בדיקה נוספת בעוד דקה' }) : null,
          m.error ? el('div.mute-sm.text-warn', { text: m.error }) : null
        ])),
        el('div', { text: `${h.calc.every((c) => c.ok) ? '✅' : '❌'} מחשבונים (${h.calc.filter((c) => c.ok).length}/${h.calc.length})${h.calc.filter((c) => !c.ok).map((c) => ` — ${c.key}: ${c.error}`).join('')}` }),
        el('div', { text: `${mark(h.timeless.ok)} Timeless${h.timeless.error ? ` — ${h.timeless.error}` : ` · ${h.timeless.org ? 'אסימון ארגוני — לכל העובדים, ' : ''}${h.timeless.connectedUsers} חיברו אישי`}` })
      ]),
      el('div.ai-health', {}, [
        el('b', { text: 'סוכנים' }),
        ...h.agents.map((a) => el('div', {}, [
          `${stateMark[a.state] ?? '➖'} ${a.icon} ${a.title}`,
          a.enabled ? null : el('span.mute-sm', { text: ' · כבוי' }),
          a.failing.length ? el('span.mute-sm', { text: ` — לא עובד: ${a.failing.join(', ')}` }) : null,
          !a.failing.length && a.unknown.length ? el('span.mute-sm', { text: ` — לא נבדק: ${a.unknown.join(', ')}` }) : null
        ]))
      ])
    );
  }

  function agentRow(a) {
    const on = el('input', { type: 'checkbox', checked: a.enabled });
    const deps = el('input', { type: 'text', value: a.departments ?? '', placeholder: 'כל המחלקות', style: { maxWidth: '200px' } });
    const save = async (body) => { try { await API.put(`/api/admin/agents/${a.key}`, body); UI.success('נשמר'); } catch (err) { UI.error(err); } };
    on.addEventListener('change', () => save({ enabled: on.checked }));
    deps.addEventListener('change', () => save({ departments: deps.value }));
    const tools = [...a.calc.map(() => '🧮'), ...a.mcp.map((m) => `🌐 ${m}`), a.timeless ? '🎥 Timeless' : null, a.project ? '📋 פרויקטים' : null].filter(Boolean);
    return el('div.mm-row', {}, [
      el('label.checkbox', {}, [on]),
      el('div.mm-row-main', {}, [
        el('div', {}, [el('b', { text: `${a.icon} ${a.title}` })]),
        el('div.mute-sm', { text: a.short }),
        tools.length ? el('div.mute-sm', { text: [...new Set(tools)].join(' · ') }) : null
      ]),
      el('div', {}, [el('div.mute-sm', { text: 'מחלקות' }), deps])
    ]);
  }

  // ------------------------------------------------------------ 📜 יומן

  async function log(holder) {
    UI.mount(holder, UI.spinner());
    try {
      const r = await API.get('/api/admin/agents');
      UI.mount(holder, ...(r.log.length ? r.log.map((x) => el('div.mm-row', {}, [el('div.mm-row-main', {}, [
        el('div', {}, [el('b', { text: x.full_name || 'עובד' }), el('span.mute-sm', { text: ` · ${UI.relative(x.created_at)} · ${x.channel === 'whatsapp' ? '💬' : '🖥'} · ${x.agent || '—'}${x.mail ? ' · 📧' : ''} · ${(x.ms / 1000).toFixed(1)} ש׳` }), x.ok ? null : el('span.ai-chip.ai-chip-warn', { text: 'שגיאה' })]),
        el('div', { text: x.question }),
        x.tools.length ? el('div.mute-sm', { text: x.tools.map((t) => `${t.ok ? '✓' : '✕'} ${t.name}`).join(' · ') }) : null,
        x.error ? el('div.mute-sm.text-warn', { text: x.error }) : null
      ])])) : [UI.empty('עוד אין שאלות', '📜')]));
    } catch (err) {
      UI.mount(holder, UI.empty(err.message, '⚠️'));
    }
  }

  return { tab };
})();
