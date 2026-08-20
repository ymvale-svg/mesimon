'use strict';
/**
 * מסך סעיף בצ'קליסט.
 *
 * סעיף אינו תמיד שורה אחת שמסמנים: לפעמים יש בו תהליך משל עצמו, שצריך
 * הערה שמתעדת אותו ושיחה שמנהלת אותו. לכן לסעיף יש מסך משלו — עם אותו
 * שרשור תגובות של המשימה, כולל תיוגים, קבצים והערות פנימיות.
 */

const ChecklistItemView = (() => {
  const { el } = UI;

  let modalRef = null;
  let data = null;        // { item, taskTitle, permissions }
  let onClosed = null;    // מה לרענן כשהחלון נסגר

  async function open(itemId, afterChange = null) {
    onClosed = afterChange;
    try {
      data = await API.checklistItem(itemId);
    } catch (err) {
      return UI.error(err);
    }
    const body = el('div');
    modalRef = UI.modal({
      title: `סעיף בצ'קליסט — ${data.taskTitle}`,
      body,
      size: 'wide',
      onClose: () => { modalRef = null; onClosed?.(); }
    });
    draw(body);
  }

  const bodyNode = () => modalRef?.box.querySelector('.modal-body > div');

  /** טעינה מחדש של הסעיף בלבד, בלי לסגור את החלון */
  function refresh(fresh) {
    data = { ...data, item: fresh };
    const node = bodyNode();
    if (node) draw(node);
  }

  function draw(container) {
    const { item, permissions } = data;

    // ---- כותרת הסעיף, וסימון "בוצע" ----

    /**
     * התיבה עומדת בפני עצמה ואינה עטופה ב-‎label‎: תווית בלי ‎for‎ מעבירה
     * את הלחיצה שוב לפקד שבתוכה, וכך לחיצה אחת הייתה מסמנת ומבטלת מיד.
     */
    const doneBox = el('input.item-done-box', {
      type: 'checkbox',
      checked: item.done,
      disabled: !permissions.changeStatus,
      title: permissions.changeStatus ? 'סימון הסעיף כבוצע' : 'אין לך הרשאה לשנות את הסימון'
    });
    doneBox.addEventListener('change', async () => {
      try {
        const r = await API.updateChecklist(item.id, { done: doneBox.checked });
        refresh(r.item);
      } catch (err) {
        doneBox.checked = item.done;
        UI.error(err);
      }
    });

    const titleNode = el('h3', {
      text: item.text,
      style: { fontSize: '17px', textDecoration: item.done ? 'line-through' : 'none' }
    });
    const renameBtn = permissions.edit
      ? el('button.btn.btn-sm', { title: 'שינוי שם הסעיף' }, ['✎ שינוי שם'])
      : null;
    renameBtn?.addEventListener('click', () => {
      const input = el('input', { type: 'text', value: item.text });
      renameBtn.style.display = 'none';
      titleNode.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const commit = async (save) => {
        if (settled) return;
        settled = true;
        const value = input.value.trim();
        if (!save || !value || value === item.text) return draw(container);
        try {
          const r = await API.updateChecklist(item.id, { text: value });
          refresh(r.item);
        } catch (err) { UI.error(err); draw(container); }
      };
      input.addEventListener('blur', () => commit(true));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
    });

    // ---- ההערה ----

    const noteInput = el('textarea', {
      placeholder: 'מה צריך לעשות בסעיף הזה, מה כבר נעשה, מה תלוי במה…',
      style: { minHeight: '96px' }
    });
    noteInput.value = item.note;
    const saveNote = el('button.btn.btn-sm.btn-primary', {}, ['שמירת ההערה']);
    // "נשמר" מופיע ליד הכפתור ולא כהודעה מוקפצת — המשתמש עדיין בתוך השדה
    const noteState = el('span.mute-sm');
    saveNote.addEventListener('click', async () => {
      saveNote.disabled = true;
      try {
        const r = await API.updateChecklist(item.id, { note: noteInput.value });
        data = { ...data, item: r.item };
        noteState.textContent = 'נשמר';
      } catch (err) { UI.error(err); }
      saveNote.disabled = false;
    });
    noteInput.addEventListener('input', () => { noteState.textContent = ''; });

    const noteBlock = permissions.edit
      ? el('div.field', {}, [
          el('label', { text: 'הערה' }),
          noteInput,
          el('div.flex', { style: { marginTop: '6px' } }, [saveNote, noteState])
        ])
      : el('div.field', {}, [
          el('label', { text: 'הערה' }),
          el('p', {
            text: item.note || 'ללא הערה',
            style: { whiteSpace: 'pre-wrap', color: item.note ? 'var(--text)' : 'var(--text-mute)', margin: '0' }
          })
        ]);

    UI.mount(container,
      el('div.flex', { style: { gap: '9px', marginBottom: '10px' } }, [
        doneBox,
        titleNode,
        el('div.spacer'),
        renameBtn
      ]),
      noteBlock,
      el('h4', { text: `תגובות בסעיף (${item.comments.length})`, style: { fontSize: '13.5px', margin: '16px 0 8px' } }),
      UI.commentThread({
        comments: item.comments,
        canComment: permissions.comment,
        seeInternal: permissions.seeInternal,
        onSend: async (body, internal, files) => {
          const r = await API.addChecklistComment(item.id, { body, internal, files });
          refresh(r.item);
        },
        onDelete: async (comment) => {
          const r = await API.deleteComment(comment.id);
          if (r.item) refresh(r.item);
          onClosed?.();
          UI.success('ההודעה נמחקה');
        }
      })
    );
  }

  return { open };
})();
