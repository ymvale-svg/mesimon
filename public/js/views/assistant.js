'use strict';
/**
 * 🎙 העוזר — מה שנאמר בהקלטה ואינו "פתח משימה": מייל לאיש קשר, מה יש היום,
 * תובנות מהמיילים, תשובה למייל, כמה בקשות יחד.
 *
 * זו אותה שיחה של בוט הוואטסאפ (‎POST /api/assistant‎): אותן פעולות, אותן
 * הרשאות, ואותו "כן" לפני כל דבר שיוצא. כאן ה"כן" הוא כפתור — וכל כפתור
 * "אומר" את מה שהיה נכתב בוואטסאפ. אפשר גם להקליד או לענות בקול.
 */

const AssistantView = (() => {
  const { el } = UI;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let current = null;

  /** ‎*מודגש*‎, שורות וקישורים — בלי HTML מהשרת */
  function richText(text) {
    const box = el('div.asst-text');
    for (const line of String(text ?? '').split('\n')) {
      const row = el('div', { class: line.trim() ? '' : 'asst-gap' });
      for (const part of line.split(/(\*[^*\n]+\*|https?:\/\/\S+)/g)) {
        if (!part) continue;
        if (/^\*[^*]+\*$/.test(part)) row.appendChild(el('b', { text: part.slice(1, -1) }));
        else if (/^https?:\/\//.test(part)) row.appendChild(el('a', { href: part, target: '_blank', rel: 'noopener', text: part.length > 60 ? `${part.slice(0, 57)}…` : part }));
        else row.appendChild(document.createTextNode(part));
      }
      box.appendChild(row);
    }
    return box;
  }

  /** לקול: בלי סמלים, כוכביות וקישורים — רק השורות הראשונות */
  const spoken = (text) => String(text ?? '').split('\n').filter((l) => l.trim() && !/https?:\/\//.test(l)).slice(0, 3).join('. ')
    .replace(/[*_]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/gu, '').slice(0, 300);

  /**
   * @param {object} opts
   * @param {string} opts.text            מה שנאמר
   * @param {Array}  [opts.requests]      הבקשות, אם כבר פורקו
   * @param {boolean} [opts.voice=true]   הגיע מהקלטה
   * @param {boolean} [opts.handsFree]    נפתח מ"משימון!" — התשובה נאמרת בקול
   */
  function open({ text, requests = null, voice = true, handsFree = false } = {}) {
    if (current) current.close();
    const log = el('div.asst-log');
    const choices = el('div.asst-choices');
    const input = el('input.asst-input', { type: 'text', placeholder: 'לכתוב לעוזר — או לענות בקול 🎙' });
    const send = el('button.btn.btn-primary', { type: 'button' }, ['שליחה']);
    const mic = Recognition ? el('button.btn', { type: 'button', title: 'לענות בקול' }, ['🎙']) : null;
    let busy = false;

    const bubble = (who, content) => {
      const node = el(`div.asst-msg.asst-${who}`, {}, [typeof content === 'string' ? richText(content) : content]);
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    };

    const extras = (res) => [
      res.open === 'today' ? el('button.btn.btn-sm', { onclick: () => { m.close(); App.navigate('today'); } }, ['☀ פתיחת Today']) : null,
      res.taskId ? el('button.btn.btn-sm', { onclick: () => { m.close(); TaskCardView.open(res.taskId); } }, ['פתיחת המשימה']) : null
    ].filter(Boolean);

    async function say(said, { first = false } = {}) {
      if (busy || !said.trim()) return;
      busy = true;
      send.disabled = true;
      if (!first) bubble('me', said);
      const wait = bubble('bot', el('span.mute-sm', { text: 'רגע…' }));
      UI.mount(choices);
      try {
        const res = await API.post('/api/assistant', {
          text: said,
          voice: first && voice,
          reset: first,
          requests: first ? requests : null
        });
        wait.remove();
        bubble('bot', el('div', {}, [richText(res.reply), el('div.asst-extras', {}, extras(res))]));
        UI.mount(choices, ...(res.choices ?? []).map((c) =>
          el(`button.btn.btn-sm${c.primary ? '.btn-primary' : ''}`, { type: 'button', onclick: () => say(c.say) }, [c.label])));
        if (handsFree) VoiceView.speak(spoken(res.reply));
        if (res.taskId) {
          App.refreshNotifications();
          App.reloadReference?.().then(() => App.refreshView?.()).catch(() => {});
        }
      } catch (err) {
        wait.remove();
        bubble('bot', `⚠️ ${err.message}`);
      } finally {
        busy = false;
        send.disabled = false;
        input.focus();
      }
    }

    const submit = () => {
      const v = input.value.trim();
      input.value = '';
      say(v);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // תשובה בקול: משפט אחד, ונשלח כשהדובר עוצר
    mic?.addEventListener('click', () => {
      const rec = new Recognition();
      rec.lang = 'he-IL';
      rec.interimResults = true;
      mic.classList.add('is-live');
      rec.onresult = (e) => {
        input.value = Array.from(e.results).map((r) => r[0].transcript).join(' ');
        if (e.results[e.results.length - 1].isFinal) { rec.stop(); submit(); }
      };
      rec.onend = () => mic.classList.remove('is-live');
      rec.onerror = () => mic.classList.remove('is-live');
      try { rec.start(); } catch { mic.classList.remove('is-live'); }
    });

    const m = UI.modal({
      title: 'העוזר של משימון',
      size: 'wide',
      body: el('div.asst', {}, [
        el('div.asst-said', {}, [
          el('img.asst-logo', { src: '/icons/bot.svg', alt: '' }),
          el('span.mute-sm', { text: voice ? 'אמרת: ' : 'כתבת: ' }), text
        ]),
        log,
        choices,
        el('div.asst-foot', {}, [input, mic, send].filter(Boolean))
      ]),
      onClose: () => { if (current?.m === m) current = null; }
    });
    current = { close: () => m.close(), m };
    say(text, { first: true });
    return current;
  }

  return { open };
})();
