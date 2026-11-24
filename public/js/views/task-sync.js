'use strict';
/**
 * פרק 11 בממשק — הצעות על משימות קיימות, ושאלת "יש כבר משימה דומה".
 *
 *   • "לסגור?" / "לעדכן?" — מייל או וואטסאפ שעונה על משימה שפתחתי (‎task_close‎ /
 *     ‎task_update‎). אישור מוסיף את ההודעה כהערה; סגירה, יעד וסטטוס — רק מה
 *     שסומן. "לא קשור" — בלחיצה אחת, עם ביטול. המשימה לא נכונה — בחלון: 🔀 לצרף את ההודעה
 *     למשימה אחרת, או ➕ משימה חדשה ממנה.
 *   • "למזג?" — שתי משימות במחלקה שנראות אותה עבודה (‎task_merge‎). מספיק אישור
 *     של אחד האחראים. "לא כפולות" — לא יוצע שוב.
 *   • בדיאלוג "משימה חדשה": "יש כבר משימה דומה: '…' אצל יוסי" — לפתוח בכל זאת /
 *     לא לפתוח / להצטרף למשימה של יוסי (‎checkDuplicate‎).
 *
 * השורות מוצגות גם ב"ממתין לאישורך" (‎variant: 'inbox'‎) וגם ב-Today
 * (‎variant: 'today'‎) — אותן פעולות, במראה של כל מסך.
 */

const TaskSyncView = (() => {
  const { el } = UI;

  const KINDS = ['task_close', 'task_update', 'task_merge'];
  const handles = (s) => KINDS.includes(s?.kind);
  const isSync = (s) => s.kind === 'task_close' || s.kind === 'task_update';

  /** ‎2026-11-05‎ → "5.11" */
  const dm = (ymd) => (ymd ? `${Number(ymd.slice(8, 10))}.${Number(ymd.slice(5, 7))}` : '');

  const taskLink = (id, title) => el('a.ts-task', {
    href: '#',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); TaskCardView.open(id); }
  }, [`"${title}"`]);

  /** מאיפה ההודעה: 📧 השולח · לפני שעה · פתיחת המייל ↗ */
  function originLine(s) {
    const d = s.data ?? {};
    const who = d.channel === 'mail' ? `📧 ${s.from.name}` : d.personal ? `💬 ${s.from.name}` : `👥 ${d.groupName} · ${s.from.name}`;
    return el('div.mute-sm', {}, [
      who,
      s.receivedAt ? ` · ${UI.relative(s.receivedAt)}` : '',
      s.link ? el('a', { href: s.link, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, [' · פתיחת המייל ↗']) : null
    ]);
  }

  /** פעולה על כפתור — נעילה בזמן הבקשה, שגיאה למשתמש, ורענון בסוף */
  const run = (button, fn, reload) => async (e) => {
    e?.stopPropagation?.();
    if (button) button.disabled = true;
    try {
      await fn();
      await reload();
      App.refreshNotifications();
    } catch (err) {
      if (button) button.disabled = false;
      UI.error(err);
    }
  };

  // ------------------------------------------------------------ "לא קשור" / "לא כפולות"

  /**
   * בלחיצה אחת, בלי חלון — כמו "לא משימה". ההודעה מאפשרת "ביטול", ובהצעה על
   * משימה — גם לפתוח אותה.
   */
  async function rejectNow(s, reload) {
    await API.post(`/api/ai/suggestions/${s.id}/reject`, {});
    const d = s.data ?? {};
    const merge = s.kind === 'task_merge';
    UI.undoToast(merge ? 'לא כפולות — לא יוצעו שוב' : `"${d.taskTitle}" — לא קשור`, {
      ms: 8000,
      onUndo: async () => {
        await API.post(`/api/ai/suggestions/${s.id}/restore`, {});
        await reload();
      },
      extra: !merge && s.taskId ? { label: 'פתיחת המשימה', onClick: () => TaskCardView.open(s.taskId) } : null
    });
  }

  // ------------------------------------------------------------ אישור עם בחירה

  /**
   * החלון של "לעדכן?" (וגם "לסגור?" כשרוצים רק הערה): ההערה לעריכה, וכל שינוי
   * במשימה — בתיבת סימון משלו, עם הערך המוצע שאפשר לשנות.
   */
  function approveDialog(s, reload) {
    const d = s.data ?? {};
    const p = d.proposed ?? {};
    const comment = el('textarea', { rows: 5 });
    comment.value = d.comment ?? '';
    const closeBox = el('input', { type: 'checkbox', checked: s.kind === 'task_close' });
    const dueBox = el('input', { type: 'checkbox', checked: Boolean(p.dueDate) });
    const due = el('input', { type: 'date', value: p.dueDate || d.currentDue || '' });
    due.addEventListener('input', () => { dueBox.checked = Boolean(due.value); });
    const statusBox = el('input', { type: 'checkbox', checked: Boolean(p.status) });
    const changes = el('div.ts-changes', {}, [
      el('label.checkbox', {}, [closeBox, ' לסגור את המשימה (בוצעה)']),
      el('div.ts-change', {}, [el('label.checkbox', {}, [dueBox, ' לעדכן את תאריך היעד ל-']), due,
        d.currentDue ? el('span.mute-sm', { text: ` (עכשיו: ${dm(d.currentDue)})` }) : null]),
      p.status ? el('label.checkbox', {}, [statusBox, ` לשנות את הסטטוס ל"${p.statusLabel}"`]) : null
    ]);
    // סגירה ושינוי יעד/סטטוס אינם הולכים יחד
    const sync = () => {
      for (const x of [dueBox, due, statusBox]) x.disabled = closeBox.checked;
    };
    closeBox.addEventListener('change', sync);
    sync();

    const ok = el('button.btn.btn-primary', {}, ['✓ אישור']);
    const m = UI.modal({
      title: s.kind === 'task_close' ? '✅ הודעה שעונה על משימה שפתחת' : '📝 עדכון למשימה שפתחת',
      size: 'wide',
      body: el('div', {}, [
        el('div.ai-letter', {}, [el('div', {}, ['המשימה: ', taskLink(s.taskId, d.taskTitle)]), originLine(s)]),
        d.reason ? el('div.mute-sm', { text: `💡 ${d.reason}`, style: { margin: '6px 0' } }) : null,
        UI.field('ההערה שתתווסף למשימה', comment, 'עם המקור והקישור אליו. קבצים מהמייל יצורפו אליה.'),
        el('div.ai-section-title', { text: 'ומה עוד לשנות במשימה' }),
        changes,
        el('div.mute-sm', { text: 'רק מה שמסומן ישתנה.', style: { marginTop: '6px' } }),
        el('div.ai-section-title', { text: 'המשימה לא נכונה?' }),
        el('div.ts-redirect', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          el('button.btn.btn-sm', {
            title: 'ההודעה תתווסף כהערה למשימה שתבחר/י. המשימה שהוצעה לא תשתנה',
            onclick: () => { m.close(); attachOtherDialog(s, comment.value.trim(), reload); }
          }, [UI.lineIcon('merge'), 'לצרף למשימה אחרת…']),
          el('button.btn.btn-sm', {
            title: 'משימה חדשה באחריותך, וההודעה נשמרת בה כהערה. המשימה שהוצעה לא תשתנה',
            onclick: () => { m.close(); newTaskDialog(s, comment.value.trim(), reload); }
          }, [UI.lineIcon('plus'), 'משימה חדשה מההודעה'])
        ])
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    ok.addEventListener('click', run(ok, async () => {
      const r = await API.post(`/api/ai/suggestions/${s.id}/approve`, {
        comment: comment.value.trim(),
        close: closeBox.checked,
        applyDue: !closeBox.checked && dueBox.checked && Boolean(due.value),
        dueDate: due.value || null,
        applyStatus: !closeBox.checked && statusBox.checked && Boolean(p.status),
        status: p.status || null
      });
      m.close();
      UI.success(closeBox.checked ? 'המשימה נסגרה — ההודעה נשמרה בה' : 'העדכון נוסף למשימה');
      if (r.taskId) TaskCardView.open(r.taskId);
    }, reload));
  }

  // ------------------------------------------------------------ המשימה לא נכונה

  /**
   * 🔀 ההודעה למשימה אחרת: חיפוש משימה פתוחה (כמו ב"איחוד" בכרטיס המשימה) ← אישור ← ההערה נכנסת לשם
   * (‎POST /api/ai/suggestions/:id/attach‎). השרת בודק שמותר לערוך את המשימה שנבחרה.
   */
  function attachOtherDialog(s, comment, reload) {
    const d = s.data ?? {};
    const input = el('input', { type: 'search', placeholder: 'שם המשימה שאליה לצרף…', 'aria-label': 'חיפוש משימה', style: { width: '100%' } });
    const list = el('div', { style: { marginTop: '10px', maxHeight: '320px', overflow: 'auto' } });
    let seq = 0;
    const search = async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (q.length < 2) { UI.mount(list, el('div.mute-sm', { text: 'הקלידו לפחות 2 אותיות.' })); return; }
      try {
        const r = await API.search(q, 'all');
        if (mine !== seq) return;
        const hits = (r.results ?? []).filter((x) => x.type === 'task' && x.id !== s.taskId && !/הושלם|בארכיון/.test(x.subtitle ?? '')).slice(0, 12);
        UI.mount(list, hits.length ? hits.map((h) => el('button.btn.btn-block', {
          style: { textAlign: 'start', marginBottom: '6px' },
          onclick: () => confirmAttach(h)
        }, [el('div', { text: h.title }), el('div.mute-sm', { text: h.subtitle ?? '' })])) : el('div.mute-sm', { text: 'לא נמצאו משימות פתוחות.' }));
      } catch (err) { UI.error(err); }
    };
    let timer = null;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    const m = UI.modal({
      title: '🔀 לצרף את ההודעה למשימה אחרת',
      body: el('div', {}, [
        el('p.mute-sm', { style: { marginTop: 0 }, text: `ההודעה תתווסף כהערה למשימה שתבחרו, עם המקור והקבצים. "${d.taskTitle}" לא תשתנה.` }),
        input, list
      ])
    });
    setTimeout(() => input.focus(), 0);
    async function confirmAttach(h) {
      // חלון החיפוש נסגר קודם — אחרת האישור נפתח מאחוריו
      m.close();
      if (!await UI.confirm(`לצרף את ההודעה כהערה ל"${h.title}"?`, { title: 'צירוף למשימה אחרת', okText: 'לצרף' })) return;
      await run(null, async () => {
        const r = await API.post(`/api/ai/suggestions/${s.id}/attach`, { taskId: h.id, comment });
        UI.success(`ההודעה נוספה ל"${h.title}"`);
        if (r.taskId) TaskCardView.open(r.taskId);
      }, reload)();
    }
  }

  /** ➕ משימה חדשה מההודעה — כותרת ותיאור לעריכה; ההודעה עצמה נשמרת בה כהערה (‎POST …/new-task‎) */
  function newTaskDialog(s, comment, reload) {
    const d = s.data ?? {};
    const title = el('input', { type: 'text', maxlength: 120, style: { width: '100%' } });
    title.value = String(d.summary || s.subject || d.comment || '').trim().split('\n')[0].slice(0, 120);
    const description = el('textarea', { rows: 3 });
    description.value = d.summary ?? '';
    const ok = el('button.btn.btn-primary', {}, [UI.lineIcon('plus'), 'פתיחת המשימה']);
    const m = UI.modal({
      title: '➕ משימה חדשה מההודעה',
      body: el('div', {}, [
        el('div.ai-letter', {}, [originLine(s)]),
        UI.field('כותרת', title),
        UI.field('תיאור', description, 'המשימה תהיה באחריותך. ההודעה, המקור והקבצים יישמרו בה כהערה.'),
        el('div.mute-sm', { text: `"${d.taskTitle}" לא תשתנה.` })
      ]),
      footer: [ok, el('div.spacer'), el('button.btn', { onclick: () => m.close() }, ['ביטול'])]
    });
    ok.addEventListener('click', run(ok, async () => {
      if (!title.value.trim()) throw new Error('נדרשת כותרת למשימה');
      const r = await API.post(`/api/ai/suggestions/${s.id}/new-task`, { title: title.value.trim(), description: description.value.trim(), comment });
      m.close();
      UI.success('נפתחה משימה חדשה — ההודעה נשמרה בה');
      if (r.taskId) TaskCardView.open(r.taskId);
    }, reload));
  }

  // ------------------------------------------------------------ השורות

  function syncParts(s, reload) {
    const d = s.data ?? {};
    const p = d.proposed ?? {};
    const close = s.kind === 'task_close';
    const actions = [];
    if (close) {
      const ok = el('button.btn.btn-sm.btn-primary', {}, ['✓ לסגור']);
      ok.title = 'המשימה תסומן כבוצעה, וההודעה תישמר בה כהערה עם קישור למקור';
      ok.addEventListener('click', run(ok, async () => {
        await API.post(`/api/ai/suggestions/${s.id}/approve`, {});
        UI.success(`"${d.taskTitle}" נסגרה — ההודעה נשמרה בה`);
      }, reload));
      const note = el('button.btn.btn-sm', { title: 'רק להוסיף כהערה, בלי לסגור' }, [UI.lineIcon('pencil'), 'רק הערה']);
      note.addEventListener('click', (e) => { e.stopPropagation(); approveDialog({ ...s, kind: 'task_close', data: d }, reload); });
      actions.push(ok, note);
    } else if (p.dueDate || p.status) {
      // יש שינוי מוצע — בחירה מפורשת בחלון
      actions.push(el('button.btn.btn-sm.btn-primary', { onclick: (e) => { e.stopPropagation(); approveDialog(s, reload); } }, ['בדיקה ואישור']));
    } else {
      const ok = el('button.btn.btn-sm.btn-primary', {}, ['✓ להוסיף כהערה']);
      ok.addEventListener('click', run(ok, async () => {
        await API.post(`/api/ai/suggestions/${s.id}/approve`, {});
        UI.success('העדכון נוסף למשימה');
      }, reload));
      actions.push(ok, el('button.btn.btn-sm', { title: 'עריכה ושינויים נוספים', onclick: (e) => { e.stopPropagation(); approveDialog(s, reload); } }, [UI.lineIcon('pencil')]));
    }
    const no = el('button.btn.btn-sm.btn-ghost', { title: 'לא קשור — ההודעה לא תוצע שוב למשימה הזו' }, ['✕ לא קשור']);
    no.addEventListener('click', run(no, () => rejectNow(s, reload), reload));
    actions.push(no);

    const what = d.channel === 'mail' ? 'המייל' : 'ההודעה';
    return {
      title: close
        ? el('div', {}, [el('b', {}, [UI.lineIcon('check-circle'), 'לסגור? ']), `נראה ש${what} מ${s.from.name} עונה על `, taskLink(s.taskId, d.taskTitle)])
        : el('div', {}, [el('b', {}, [UI.lineIcon('pencil'), 'עדכון ל']), taskLink(s.taskId, d.taskTitle), d.summary ? `: ${d.summary}` : '']),
      lines: [
        d.comment ? el('div.ai-quote.ts-quote', { text: d.comment.length > 240 ? `${d.comment.slice(0, 240)}…` : d.comment }) : null,
        (p.dueDate || p.status || d.files?.length) ? el('div.ai-chips', {}, [
          p.dueDate ? el('span.ai-chip', { text: `📅 יעד ← ${dm(p.dueDate)}${d.currentDue ? ` (במקום ${dm(d.currentDue)})` : ''}` }) : null,
          p.status ? el('span.ai-chip', { text: `סטטוס ← ${p.statusLabel}` }) : null,
          d.files?.length ? el('span.ai-chip', {}, [UI.lineIcon('paperclip'), '', d.files.length === 1 ? el('bdi', { text: d.files[0] }) : `${d.files.length} קבצים`]) : null
        ]) : null,
        originLine(s)
      ],
      actions,
      open: () => approveDialog(s, reload)
    };
  }

  function mergeParts(s, reload) {
    const d = s.data ?? {};
    const ok = el('button.btn.btn-sm.btn-primary', {}, [UI.lineIcon('merge'), 'למזג']);
    ok.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await UI.confirm(`"${d.keepTitle}" תישאר, ו"${d.dropTitle}" תיסגר עם קישור אליה. האחראים, ההערות, הקבצים והצ'קליסט יעברו, והיעד יהיה המוקדם מבין השניים.`, { okText: 'מיזוג' })) return;
      run(ok, async () => {
        const r = await API.post(`/api/ai/suggestions/${s.id}/approve`, {});
        UI.success('המשימות מוזגו');
        if (r.taskId) TaskCardView.open(r.taskId);
      }, reload)();
    });
    const no = el('button.btn.btn-sm.btn-ghost', { title: 'לא כפולות — הזוג לא יוצע שוב' }, ['✕ לא כפולות']);
    no.addEventListener('click', run(no, () => rejectNow(s, reload), reload));
    return {
      title: el('div', {}, [el('b', {}, [UI.lineIcon('merge'), 'למזג? ']), 'נראה ש', taskLink(d.dropId, d.dropTitle), ` (אצל ${d.dropOwner}) ו`, taskLink(d.keepId, d.keepTitle), ` (אצל ${d.keepOwner}) הן אותה עבודה`]),
      lines: [
        el('div.mute-sm', { text: `"${d.keepTitle}" הוותיקה תישאר${d.projectName ? ` · 📁 ${d.projectName}` : ''}${s.receivedAt ? ` · ${UI.relative(s.receivedAt)}` : ''}` })
      ],
      actions: [ok, no],
      open: null
    };
  }

  /**
   * שורה אחת. ‎variant‎ — 'inbox' ("ממתין לאישורך") או 'today'.
   */
  function row(s, { reload, variant = 'inbox' }) {
    const parts = isSync(s) ? syncParts(s, reload) : mergeParts(s, reload);
    if (variant === 'today') {
      return el('div.today-row.today-mail.ts-row', { onclick: parts.open ?? null }, [
        el('div.today-main', {}, [
          el('div.today-title', {}, [parts.title]),
          ...parts.lines,
          el('div.today-mail-actions', {}, parts.actions)
        ])
      ]);
    }
    return el('div.ai-row.ts-row', {}, [
      el('div.ai-row-main', { onclick: parts.open ?? null }, [parts.title, ...parts.lines]),
      el('div.ai-row-actions', {}, parts.actions)
    ]);
  }

  // ------------------------------------------------------------ "יש כבר משימה דומה"

  /**
   * לפני יצירת משימה מהדיאלוג. ‎payload‎ — מה שיישלח ל-‎POST /api/tasks‎.
   * @returns {Promise<{proceed: boolean, dupChecked?: number[], taskId?: number}>}
   *   ‎proceed‎ — ליצור (עם ‎dupChecked‎ — מה שהוצג, כדי שלא יוצע כמיזוג);
   *   אחרת — לא ליצור (‎taskId‎: המשימה שנפתחה במקום, אם נפתחה).
   */
  async function checkDuplicate(payload) {
    let matches = [];
    try {
      ({ matches } = await API.post('/api/tasks/similar', {
        title: payload.title, description: payload.description ?? '', projectId: payload.projectId ?? null,
        assigneeType: payload.assigneeType ?? null, assigneeId: payload.assigneeId ?? null
      }));
    } catch {
      // הבדיקה אינה תנאי ליצירה — תקלה בה לא חוסמת
      return { proceed: true };
    }
    if (!matches?.length) return { proceed: true, dupChecked: [] };

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        m.close();
      };
      const first = matches[0];
      const ownerFirst = (x) => String(x.owner ?? '').split(' ')[0] || x.owner;

      const items = matches.map((x) => {
        const join = x.involved ? null : el('button.btn.btn-sm.btn-primary', {}, [`להצטרף למשימה של ${ownerFirst(x)}`]);
        join?.addEventListener('click', async () => {
          join.disabled = true;
          try {
            await API.post(`/api/tasks/${x.id}/join`, {});
            UI.success(`הצטרפת למשימה "${x.title}" — היא מופיעה עכשיו גם אצלך`);
            done({ proceed: false, taskId: x.id, joined: true });
            TaskCardView.open(x.id);
          } catch (err) {
            join.disabled = false;
            UI.error(err);
          }
        });
        return el('div.ts-dup', {}, [
          el('div.ts-dup-main', {}, [
            el('b', { text: `"${x.title}"` }),
            el('div.mute-sm', {
              text: [`אצל ${x.owner}`, x.projectName ? `📁 ${x.projectName}` : null, x.dueDate ? `📅 ${UI.formatDate(x.dueDate)}` : null, x.involved ? 'את/ה כבר בתוכה' : null].filter(Boolean).join(' · ')
            })
          ]),
          join
        ]);
      });

      const anyway = el('button.btn', {}, ['לפתוח בכל זאת']);
      anyway.addEventListener('click', () => done({ proceed: true, dupChecked: matches.map((x) => x.id) }));
      const dont = el('button.btn', {}, ['לא לפתוח']);
      dont.addEventListener('click', () => {
        done({ proceed: false, taskId: first.id });
        if (first.visible || first.involved) TaskCardView.open(first.id);
        else UI.toast(`המשימה "${first.title}" אצל ${first.owner}`, 'info');
      });

      const m = UI.modal({
        title: '🔍 יש כבר משימה דומה',
        body: el('div', {}, [
          el('p', { style: { marginTop: 0 }, text: matches.length === 1
            ? `יש כבר משימה דומה: "${first.title}" אצל ${first.owner}.`
            : `יש כבר ${matches.length} משימות דומות פתוחות במחלקה:` }),
          el('div.ts-dups', {}, items),
          el('div.mute-sm', { style: { marginTop: '8px' }, text: 'להצטרף — לא תיפתח משימה חדשה: תתווסף/י כאחראי/ת נוסף/ת, ותראה/י אותה אצלך ותקבל/י עליה עדכונים.' })
        ]),
        footer: [anyway, dont, el('div.spacer')],
        // סגירה ב-✕ או ב-Esc — חוזרים לדיאלוג, בלי ליצור
        onClose: () => { if (!settled) { settled = true; resolve({ proceed: false, back: true }); } }
      });
    });
  }

  return { handles, row, rejectNow, approveDialog, attachOtherDialog, newTaskDialog, checkDuplicate, KINDS };
})();
