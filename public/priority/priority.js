'use strict';
/**
 * משימון פריוריטי — תוכנה נפרדת בתוך משימון (‎/priority‎). לא טוען שום קוד של האתר הראשי.
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md".
 *
 * מסכים: הבית (‎/priority‎) · השרשרת (‎/priority/chain‎) · עבודה על פעולה (‎/priority/receipt‎ וכו' — התור, טור המיילים והגרירה)
 *        · הגדרות (‎/priority/settings‎) · הרשאות (‎/priority/access‎). הגדרות והרשאות — מנהלי מערכת.
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const main = $('#main');

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) { const e = new Error(data?.error ?? `שגיאה ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  let toastTimer = null;
  function toast(text, bad = false) {
    const t = $('#toast');
    t.className = bad ? 'toast bad' : 'toast'; t.textContent = text;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.textContent = ''; }, bad ? 6000 : 3500);
  }

  const ICONS = {
    demand: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="M9 12h6M9 16h4"/>',
    order: '<path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2"/><circle cx="9" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
    receipt: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    partial: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    invoice: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    income: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'
  };
  const UI = {
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>'
  };
  const ui = (k) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI[k]}</svg>`;
  const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] ?? ''}</svg>`;
  const SUB = {
    demand: 'רשימה מהשטח ← דרישה לחתימה',
    order: 'דרישה מאושרת ← השוואת מחירונים ← הזמנות',
    receipt: 'תעודת משלוח ← השוואה להזמנה ← GR',
    partial: 'חוזה ← כתב הכמויות שנוצל ← לתשלום',
    invoice: 'חשבונית ← משיכת GR ← פערים',
    income: 'שובר ← דירה ובניין ← קבלה'
  };
  // סדר הבנייה (הוחלט 11.11.26): קודם מה שעובד, אחר כך חשבון חלקי, חשבונית ספק, קבלה, והזמנות רכש בסוף
  const NEXT = { partial: 1, invoice: 2, income: 3, order: 4 };

  const ROLE = { superadmin: 'אדמין על', admin: 'מנהל מערכת', executive: 'הנהלה', manager: 'מנהל מחלקה', employee: 'עובד' };
  let me = null;

  // ---------------------------------------------------------------- ניווט
  const ROUTES = { '': home, chain, settings, access };
  const routeOf = () => location.pathname.replace(/^\/priority\/?/, '').split('/')[0];
  function go(path) { history.pushState(null, '', path); render(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); go(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  function header() {
    const r = routeOf();
    const tabs = [['/priority', 'בית', ''], ['/priority/chain', 'השרשרת', 'chain']];
    if (me.admin) tabs.push(['/priority/settings', 'הגדרות', 'settings'], ['/priority/access', 'הרשאות', 'access']);
    $('#tabs').innerHTML = tabs.map(([href, label, key]) => `<a href="${href}" data-nav ${r === key ? 'aria-current="page"' : ''}>${label}</a>`).join('');
    $('#who').innerHTML = `${me.connected ? '' : '<span class="pill p-warn">החיבור לפריוריטי לא הוגדר</span>'} ${esc(me.name)} · <a href="/" class="back-link">משימון</a>`;
  }

  async function render() {
    try {
      me = await api('GET', '/api/priority/me');
    } catch (e) {
      if (e.status === 401) { main.innerHTML = '<div class="note">צריך להתחבר למשימון קודם. <a href="/">להתחברות</a>, ואחר כך לחזור לכאן.</div>'; return; }
      main.innerHTML = `<div class="note">${esc(e.message)}</div>`; return;
    }
    header();
    const r = routeOf();
    const docRoute = me.docs.find((d) => d.key === r);
    const view = docRoute ? () => workspace(docRoute) : ROUTES[r] ?? home;
    if ((view === settings || view === access) && !me.admin) { main.innerHTML = '<div class="note">רק מנהלי מערכת נכנסים למסך הזה.</div>'; return; }
    main.classList.remove('wide');
    main.innerHTML = '<p class="muted pad">טוען…</p>';
    try { await view(); } catch (e) { main.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  }

  // ---------------------------------------------------------------- בית
  async function home() {
    const cos = me.allCompanies ? 'כל החברות' : me.companies.map((c) => c.name).join(' · ') || 'אף חברה';
    const [q, inbox] = await Promise.all([api('GET', '/api/priority/docs'), api('GET', '/api/priority/inbox')]);
    const fromMail = (k) => inbox.items.filter((m) => m.guess === k || (k === 'receipt' && m.guess === 'invoice')).length;
    main.innerHTML = `
      <div class="greet"><h1>שלום, ${esc(me.name)}</h1><p>החברות שלך: ${esc(cos)}${inbox.items.length ? ` · <b>${inbox.items.length}</b> מסמכים חדשים במייל` : ''}</p></div>
      <div class="tiles">${me.docs.map((d) => {
        const status = !d.allowed ? '<span class="pill p-mute">אין לך הרשאה</span>'
          : d.ready ? '<span class="pill p-ok">עובד דרך הבוט</span>'
            : `<span class="pill p-mute">איסוף בלבד · ${NEXT[d.key]} בתור לבנייה</span>`;
        const n = q.counts[d.key] ?? 0;
        const m = d.allowed ? fromMail(d.key) : 0;
        const counts = d.allowed ? `<span class="count num">${n}<small>בתור</small></span>${m ? `<span class="pill p-warn">${m} במייל</span>` : ''}` : '';
        const body = `<span class="ic">${icon(d.key)}</span><h2>${esc(d.label)}</h2><span class="sub">${SUB[d.key] ?? ''}</span><span class="foot">${counts}${status}</span>`;
        return d.allowed ? `<a class="tile" href="/priority/${d.key}" data-nav>${body}</a>` : `<div class="tile off">${body}</div>`;
      }).join('')}</div>
      <p class="note">לחצו על פעולה: בצד שמאל המיילים שהגיעו אליכם עם חשבונית או תעודת משלוח, ואפשר לגרור לשם קבצים. דרישת רכש וקבלת סחורה — המסמך נשלח לבוט, והשיחה ממשיכה בוואטסאפ.</p>`;
  }

  // ---------------------------------------------------------------- עבודה על פעולה: התור, המיילים והגרירה
  const fmtAt = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  };
  const STAGE_CLS = { new: 'p-warn', bot: 'p-brand', draft: 'p-warn', waiting: 'p-brand', done: 'p-ok', cancelled: 'p-mute', rejected: 'p-mute' };
  const readAsDataUrl = (f) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(f); });

  async function workspace(d) {
    const label = (k) => me.docs.find((x) => x.key === k)?.label ?? k;
    const allowed = (k) => Boolean(me.docs.find((x) => x.key === k)?.allowed);
    if (!d.allowed) { main.innerHTML = '<div class="note">אין לך הרשאה לפעולה הזו. פנו למנהל המערכת.</div>'; return; }
    let items = [];
    let mails = [];
    let selected = null;
    let confirmDel = null;   // ui-ux-pro-max: פעולה הרסנית — לחיצה שנייה לאישור (קובץ שהועלה נמחק)
    let previewTicket = 0;
    let previewUrl = null;
    let desk = null;         // המצב של המנוע (‎/api/priority/desk/<flow>‎) — אותו מנוע כמו בבוט
    let deskBusy = false;
    let deskConflict = null; // קליטה אחרת פתוחה — מה לעשות איתה

    main.classList.add('wide');
    main.innerHTML = `
      <div class="ws">
        <nav class="rail" aria-label="פעולות">
          <a href="/priority" data-nav title="בית" aria-label="בית">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>'}</a>
          ${me.docs.filter((x) => x.allowed).map((x) => `<a href="/priority/${x.key}" data-nav title="${esc(x.label)}" aria-label="${esc(x.label)}" ${x.key === d.key ? 'aria-current="page"' : ''}>${icon(x.key)}</a>`).join('')}
        </nav>
        <section class="center">
          <div class="ctx"><div><h1>${esc(d.label)}</h1><span class="muted" id="ws-meta"></span></div>
            ${d.ready ? `<span class="pill p-ok ctx-note">"להתחיל כאן" — עובדים על המסמך במסך · "לבוט" — ממשיכים בוואטסאפ</span>` : `<span class="pill p-mute ctx-note">איסוף בלבד — הקליטה תיבנה בהמשך (${NEXT[d.key]} בתור)</span>`}</div>
          <div class="split" id="split">
            <div class="queue" id="queue"></div>
            ${d.ready ? '<section class="desk" id="desk" aria-label="עבודה על המסמך" hidden></section>' : ''}
            <div class="preview" id="preview"><p class="muted">בחרו מסמך מהתור כדי לראות אותו כאן.</p></div>
          </div>
        </section>
        <aside class="inbox">
          <button type="button" class="drop" id="drop" aria-describedby="drop-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
            <b>גררו לכאן PDF או תמונה</b><span id="drop-hint">או לחצו לבחירת קובץ · עד 15MB</span><span class="prog" id="drop-prog"></span>
          </button>
          <input type="file" id="file-in" accept="application/pdf,image/*" multiple hidden>
          <div class="inbox-h"><h2>מהמייל שלך</h2><span class="pill p-warn num" id="mail-n"></span></div>
          <div class="mails" id="mails"></div>
        </aside>
      </div>`;

    function drawQueue() {
      $('#ws-meta').textContent = items.length ? `${items.length} מסמכים בתור` : '';
      $('#queue').innerHTML = items.length ? items.map((x) => `
        <article class="qcard${selected === x.id ? ' sel' : ''}" data-id="${x.id}">
          <button class="qmain" data-view="${x.id}">
            <span class="qt"><b>${esc(x.supplier || x.fromName || x.filename)}</b><span class="pill ${STAGE_CLS[x.stage] ?? 'p-mute'}">${esc(x.stageLabel)}</span></span>
            <span class="qs">${ui(x.source === 'mail' ? 'mail' : 'upload')} ${esc(x.filename)}</span>
            <span class="qs muted">${x.docno ? `<b class="ltr-inline">${esc(x.docno)}</b> · ` : ''}${x.source === 'mail' ? esc(x.subject || x.fromEmail) : x.source === 'whatsapp' ? 'נפתח בוואטסאפ' : 'הועלה במסך'} · ${fmtAt(x.at)}</span>
          </button>
          <span class="qa">
            ${d.ready && ['new', 'bot'].includes(x.stage) && desk?.docId !== x.id ? `<button type="button" class="btn small pri" data-start="${x.id}" aria-label="להתחיל כאן: ${esc(x.filename)}">להתחיל כאן</button>` : ''}
            ${d.ready && x.stage === 'new' ? `<button type="button" class="btn small" data-bot="${x.id}" aria-label="לשלוח לבוט: ${esc(x.filename)}">${ui('bot')} לבוט</button>` : ''}
            ${['new', 'bot'].includes(x.stage) ? (confirmDel === x.id
              ? `<button type="button" class="btn small confirm" data-del="${x.id}">${x.source === 'upload' ? 'למחוק?' : 'להוציא?'}</button>`
              : `<button type="button" class="btn small" data-del="${x.id}" aria-label="הוצאה מהתור: ${esc(x.filename)}">${ui('x')}</button>`) : ''}
          </span>
        </article>`).join('')
        : '<p class="muted empty">התור ריק. קחו מסמך מהמייל, או גררו קובץ לאזור שבצד.</p>';
    }

    function drawMails() {
      $('#mail-n').textContent = mails.length || '';
      $('#mails').innerHTML = mails.length ? mails.map((m) => {
        const who = `<span class="sr-only"> — ${esc(m.supplier || m.fromName || m.fromEmail)}, ${esc(m.filename)}</span>`;
        const btns = [`<button type="button" class="btn small pri" data-take="${m.id}" data-doc="${d.key}">${esc(d.label)}${who}</button>`];
        if (m.guess !== d.key && allowed(m.guess)) btns.push(`<button type="button" class="btn small" data-take="${m.id}" data-doc="${m.guess}">${esc(label(m.guess))}${who}</button>`);
        btns.push(`<button type="button" class="btn small" data-dismiss="${m.id}">לא רלוונטי${who}</button>`);
        return `<div class="mail">
          <span class="mfrom"><b>${esc(m.supplier || m.fromName || m.fromEmail)}</b><time>${fmtAt(m.at)}</time></span>
          <span class="msubj">${esc(m.subject)}</span>
          <span class="matt">${ui('clip')} ${esc(m.filename)} <span class="pill ${m.guess === d.key ? 'p-brand' : 'p-mute'}">${esc(m.kindLabel)} · נראה כמו ${esc(label(m.guess))}</span></span>
          <span class="mbtns">${btns.join('')}</span>
        </div>`;
      }).join('') : '<p class="muted empty">אין מיילים חדשים עם חשבונית או תעודת משלוח. מה שסריקת המייל מזהה יופיע כאן.</p>';
    }

    function preview(id) {
      selected = id;
      const x = items.find((i) => i.id === id);
      drawQueue();
      if (!x) { $('#preview').innerHTML = '<p class="muted">בחרו מסמך מהתור כדי לראות אותו כאן.</p>'; return; }
      const src = `/api/priority/docs/${x.id}/file`;
      if (!x.filename) { $('#preview').innerHTML = '<p class="muted">למסמך הזה אין קובץ במשימון — הוא נפתח ישר בוואטסאפ.</p>'; return; }
      $('#preview').innerHTML = `<div class="pv-h"><span>${esc(x.filename)}</span><a class="pv-open" href="${src}" target="_blank" rel="noopener">פתיחה בחלון<span class="sr-only"> (חלון חדש)</span></a></div><p class="muted" aria-busy="true">טוען את המסמך…</p>`;
      // טעינה קודם: קובץ שלא ירד (Gmail) — הודעה ברורה, לא שגיאה גולמית בתוך המסגרת
      const ticket = (previewTicket = (previewTicket || 0) + 1);
      fetch(src, { credentials: 'same-origin' }).then(async (r) => {
        if (ticket !== previewTicket) return;
        if (!r.ok) { const j = await r.json().catch(() => null); throw new Error(j?.error ?? `שגיאה ${r.status}`); }
        const url = URL.createObjectURL(await r.blob());
        if (ticket !== previewTicket) return URL.revokeObjectURL(url);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url;
        $('#preview').lastElementChild.outerHTML = /^image\//.test(x.mime) ? `<img src="${url}" alt="${esc(x.filename)}">` : `<iframe src="${url}" title="${esc(x.filename)}"></iframe>`;
      }).catch((e) => { if (ticket === previewTicket) $('#preview').lastElementChild.outerHTML = `<p class="note" role="alert">לא הצלחתי להציג את הקובץ: ${esc(e.message)}</p>`; });
    }

    // ---------------- עבודה על המסמך מתוך המסך
    const fmtWa = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>').replace(/\n/g, '<br>');
    const num = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('he-IL', { maximumFractionDigits: 2 }));
    function drawDesk() {
      const box = $('#desk');
      if (!box) return;
      $('#split').classList.toggle('desk-on', Boolean(desk?.active || deskConflict));
      box.hidden = !(desk?.active || deskConflict);
      if (box.hidden) return;
      if (deskConflict) {
        const o = deskConflict.open;
        box.innerHTML = `<div class="desk-conflict" role="alert"><b>יש ${esc(d.label)} פתוחה</b>
          <p>${esc(o?.stepLabel ?? '')}${o?.supplier?.name ? ` · ${esc(o.supplier.name)}` : ''}${o?.docno ? ` · ${esc(o.docno)}` : ''} — התחילה בוואטסאפ או ממסמך אחר.</p>
          <div class="row-actions"><button type="button" class="btn pri" data-continue>להמשיך אותה כאן</button>
          <button type="button" class="btn" data-force="${deskConflict.id}">לבטל אותה ולהתחיל את זו</button></div></div>`;
        return;
      }
      const v = desk.view;
      const field = (k, val, cls = '') => (val ? `<div class="field ${cls}"><span class="fl">${k}</span><span class="fv">${val}</span></div>` : '');
      const company = v.company ? `${esc(v.company.name)}${v.company.test ? ' <span class="pill p-warn">סביבת בדיקה</span>' : ''}` : '';
      const fields = d.key === 'receipt'
        ? [field('מסמך', esc([v.docType, v.docNumber].filter(Boolean).join(' '))), field('תאריך', esc(v.date)), field('חברה', company), field('ספק', v.supplier ? `${esc(v.supplier.name)}${v.supplier.guess ? ' <span class="pill p-warn">מהמסמך — לא אושר</span>' : ''}` : ''),
           field('הזמנה', esc(v.order), 'ltr-f'), field('פרויקט', esc(v.project)), field('מחסן', esc(v.warehouse), 'ltr-f'), field('תנאי תשלום', esc(v.pay)), field('GR בפריוריטי', esc(v.docno), 'ltr-f strong')]
        : [field('חברה', company), field('תאריך', esc(v.date)), field('פרויקט', esc(v.project)), field('מחסן', esc(v.warehouse), 'ltr-f'), field('דרישה בפריוריטי', esc(v.docno), 'ltr-f strong')];
      const lines = v.lines?.length ? `<div class="scroll"><table class="t lines"><thead><tr><th>#</th><th>פריט</th><th>כמות</th>${d.key === 'receipt' ? '<th>מחיר</th>' : '<th>מק"ט</th>'}</tr></thead><tbody>
        ${v.lines.map((l) => `<tr${l.unclear || l.open ? ' class="unclear"' : ''}><td class="num">${l.n}</td><td class="wrap">${esc(l.description)}${l.unclear ? ' <span class="pill p-warn">לא ברור</span>' : ''}${l.open ? ' <span class="pill p-warn">לבחור</span>' : ''}</td><td class="num">${num(l.qty)} ${esc(l.unit ?? '')}</td><td class="num">${d.key === 'receipt' ? num(l.price) : esc(l.part ?? '')}</td></tr>`).join('')}
        </tbody></table></div>` : '';
      const totals = v.totals && v.totals.total !== null ? `<p class="totals num">לפני מע"מ ${num(v.totals.beforeVat)} · מע"מ ${num(v.totals.vat)} · <b>סה"כ ${num(v.totals.total)} ₪</b></p>` : '';
      const last = [...desk.messages].reverse().find((m) => m.from === 'bot');
      box.innerHTML = `
        <div class="desk-h"><span class="pill p-brand">${esc(v.stepLabel)}</span>${v.paused ? '<span class="pill p-warn">מושהה</span>' : ''}</div>
        <div class="fields">${fields.join('')}</div>
        ${lines}${totals}
        <ol class="talk" id="talk" aria-label="השיחה עם המערכת">
          ${desk.messages.map((m) => `<li class="msg ${m.from}">${m.texts.map((t) => `<p>${fmtWa(t)}</p>`).join('')}${(m.files ?? []).map((f) => `<a class="msg-file" href="/api/priority/desk/file/${encodeURIComponent(f.id)}" target="_blank" rel="noopener">${ui('clip')} ${esc(f.caption || f.name)}</a>`).join('')}</li>`).join('')}
        </ol>
        <form class="say" id="say-form">
          ${last?.buttons?.length ? `<div class="answers" role="group" aria-label="תשובות מהירות">${last.buttons.map((b) => `<button type="button" class="btn ${/✅/.test(b) ? 'pri' : ''}" data-say="${esc(b)}">${esc(b)}</button>`).join('')}</div>` : ''}
          <div class="say-row"><label class="sr-only" for="say-in">תשובה או תיקון</label>
            <input id="say-in" autocomplete="off" placeholder="לענות או לתקן בשפה חופשית: ״מלט קיבלתי רק 100״, ״ספק אחר: …״" ${deskBusy ? 'disabled' : ''}>
            <button type="submit" class="btn pri" ${deskBusy ? 'disabled' : ''}>שליחה</button></div>
          <p class="hint" id="desk-busy" role="status">${deskBusy ? 'המערכת עובדת על זה… קריאת מסמך יכולה לקחת עד דקה.' : ''}</p>
        </form>`;
      const talk = $('#talk'); talk.scrollTop = talk.scrollHeight;
    }

    async function deskLoad() {
      if (!d.ready) return;
      try { desk = await api('GET', `/api/priority/desk/${d.key}`); } catch { desk = null; }
      drawDesk();
    }

    async function deskSend(text) {
      if (deskBusy || !text) return;
      deskBusy = true;
      desk.messages = [...desk.messages, { from: 'user', texts: [text] }];
      drawDesk();
      try { desk = await api('POST', `/api/priority/desk/${d.key}/say`, { text }); } catch (e) { toast(e.message, true); }
      deskBusy = false;
      drawDesk();
      $('#say-in')?.focus();
      load();
    }

    async function deskStart(id, force = false) {
      if (deskBusy) return;
      deskBusy = true; deskConflict = null;
      desk = { active: true, docId: id, messages: [{ from: 'bot', texts: ['קורא את המסמך…'] }], view: { stepLabel: 'קריאת המסמך', lines: [] } };
      drawDesk(); drawQueue();
      try {
        desk = await api('POST', '/api/priority/desk/start', { id, force });
      } catch (e) {
        if (e.status === 409) { deskConflict = { id, open: e.data?.open }; desk = null; } else { toast(e.message, true); desk = null; }
      }
      deskBusy = false;
      drawDesk(); load();
    }

    async function load() {
      const [q, inbox] = await Promise.all([api('GET', `/api/priority/docs?doc=${d.key}`), api('GET', '/api/priority/inbox')]);
      items = q.items;
      // המיילים: קודם מה שנראה כמו הפעולה הזו
      mails = inbox.items.sort((a, b) => Number(b.guess === d.key) - Number(a.guess === d.key));
      drawQueue(); drawMails();
    }

    async function uploadFiles(files) {
      const dz = $('#drop');
      dz.setAttribute('aria-busy', 'true');
      let n = 0;
      for (const f of files) {
        n += 1;
        $('#drop-prog').textContent = files.length > 1 ? `מעלה ${n} מתוך ${files.length}…` : `מעלה את ${f.name}…`;
        try {
          const data = await readAsDataUrl(f);
          const r = await api('POST', '/api/priority/docs', { doc: d.key, filename: f.name, mime: f.type, data });
          items.unshift(r.doc); drawQueue(); preview(r.doc.id);
          toast(`נוסף לתור: ${f.name}`);
        } catch (e) { toast(`${f.name}: ${e.message}`, true); }
      }
      dz.removeAttribute('aria-busy');
      $('#drop-prog').textContent = '';
    }

    // גרירה לכל המסך (לא רק לאזור) — המאזינים מתחלפים בכל כניסה לפעולה
    const drop = $('#drop');
    const ws = main.querySelector('.ws');
    ['dragenter', 'dragover'].forEach((ev) => ws.addEventListener(ev, (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
    ['dragleave', 'drop'].forEach((ev) => ws.addEventListener(ev, (e) => { if (ev === 'dragleave' && ws.contains(e.relatedTarget)) return; drop.classList.remove('over'); }));
    ws.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); uploadFiles([...e.dataTransfer.files]); });
    drop.addEventListener('click', () => { if (drop.getAttribute('aria-busy') !== 'true') $('#file-in').click(); });
    $('#file-in').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });

    main.querySelector('.ws').addEventListener('submit', (e) => {
      if (e.target.id !== 'say-form') return;
      e.preventDefault();
      const t = $('#say-in').value.trim();
      if (t) deskSend(t);
    });
    main.querySelector('.ws').addEventListener('click', async (e) => {
      const st = e.target.closest('[data-start]');
      if (st) { preview(Number(st.dataset.start)); return deskStart(Number(st.dataset.start)); }
      const fo = e.target.closest('[data-force]');
      if (fo) return deskStart(Number(fo.dataset.force), true);
      if (e.target.closest('[data-continue]')) { deskConflict = null; return deskLoad(); }
      const sy = e.target.closest('[data-say]');
      if (sy) return deskSend(sy.dataset.say);
      const v = e.target.closest('[data-view]');
      if (v) return preview(Number(v.dataset.view));
      const t = e.target.closest('[data-take]');
      if (t) {
        t.disabled = true;
        try {
          const r = await api('POST', `/api/priority/inbox/${t.dataset.take}/take`, { doc: t.dataset.doc });
          mails = mails.filter((m) => m.id !== Number(t.dataset.take)); drawMails();
          if (r.doc.doc === d.key) { items.unshift(r.doc); preview(r.doc.id); toast('נוסף לתור'); } else toast(`נוסף לתור של ${label(r.doc.doc)}`);
        } catch (err) { t.disabled = false; toast(err.message, true); }
        return;
      }
      const x = e.target.closest('[data-dismiss]');
      if (x) {
        try { await api('POST', `/api/priority/inbox/${x.dataset.dismiss}/dismiss`); mails = mails.filter((m) => m.id !== Number(x.dataset.dismiss)); drawMails(); } catch (err) { toast(err.message, true); }
        return;
      }
      const b = e.target.closest('[data-bot]');
      if (b) {
        b.disabled = true;
        try {
          const r = await api('POST', `/api/priority/docs/${b.dataset.bot}/bot`);
          items = items.map((i) => (i.id === r.doc.id ? r.doc : i)); drawQueue();
          toast('נשלח לבוט — המשך בוואטסאפ');
        } catch (err) { b.disabled = false; toast(err.message, true); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del && confirmDel !== Number(del.dataset.del)) {
        confirmDel = Number(del.dataset.del); drawQueue();
        main.querySelector(`[data-del="${confirmDel}"]`)?.focus();
        return;
      }
      if (del) {
        confirmDel = null;
        try {
          await api('DELETE', `/api/priority/docs/${del.dataset.del}`);
          items = items.filter((i) => i.id !== Number(del.dataset.del));
          if (selected === Number(del.dataset.del)) preview(null); else drawQueue();
          load();
        } catch (err) { toast(err.message, true); }
      }
    });

    await load();
    await deskLoad();
    // מהשרשרת: ‎?id=‎ — המסמך הזה פתוח; אחרת — המסמך שבעבודה
    const want = Number(new URLSearchParams(location.search).get('id'));
    if (want && items.some((i) => i.id === want)) preview(want);
    else if (desk?.active && desk.docId && items.some((i) => i.id === desk.docId)) preview(desk.docId);
    else if (items[0]) preview(items[0].id);
  }

  // ---------------------------------------------------------------- השרשרת
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (m < 60) return m <= 1 ? 'עכשיו' : `לפני ${m} דק׳`;
    const h = Math.round(m / 60);
    if (h < 24) return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`;
    const d = Math.round(h / 24);
    return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
  };
  // השלבים שבהם העובד צריך לעשות משהו — "התקבל" (לקחת לעבודה) ו"טיוטא" ("מאשר" בבוט)
  const MINE = new Set(['new', 'draft']);
  const SOURCE = { mail: ['mail', 'מהמייל'], upload: ['upload', 'הועלה במסך'], whatsapp: ['bot', 'נפתח בוואטסאפ'] };
  let chainFilter = { doc: '', all: false };

  async function chain() {
    const docs = me.docs.filter((d) => d.allowed);
    const q = new URLSearchParams();
    if (chainFilter.doc) q.set('doc', chainFilter.doc);
    if (chainFilter.all) q.set('all', '1');
    const b = await api('GET', `/api/priority/chain?${q}`);
    const label = (k) => me.docs.find((x) => x.key === k)?.label ?? k;
    const company = (c) => me.companies.find((x) => x.code === c)?.name ?? c;
    const total = Object.values(b.columns).reduce((n, c) => n + c.length, 0);

    main.innerHTML = `
      <div class="chain-h">
        <div><h1>השרשרת</h1><p class="muted">${total ? `${total} מסמכים` : 'אין מסמכים פעילים'} · מסמך סופי נשאר כאן 14 יום</p></div>
        <div class="filters" role="group" aria-label="סינון לפי סוג מסמך">
          <button type="button" class="chip" aria-pressed="${!chainFilter.doc}" data-doc="">הכל</button>
          ${docs.map((d) => `<button type="button" class="chip" aria-pressed="${chainFilter.doc === d.key}" data-doc="${d.key}">${esc(d.label)}</button>`).join('')}
          ${me.admin ? `<span class="sep" aria-hidden="true"></span><button type="button" class="chip" aria-pressed="${chainFilter.all}" data-all>כל הארגון</button>` : ''}
        </div>
      </div>
      <div class="board" role="region" aria-label="השרשרת לפי שלבים" tabindex="0">
        ${b.stages.map((st) => {
          const cards = b.columns[st.key];
          return `<section class="col${MINE.has(st.key) ? ' mine' : ''}" aria-labelledby="col-${st.key}">
            <div class="col-h"><h2 id="col-${st.key}">${esc(st.label)}</h2><span class="pill ${MINE.has(st.key) && cards.length ? 'p-warn' : 'p-mute'} num" aria-label="${cards.length} מסמכים">${cards.length}</span></div>
            <p class="col-hint">${esc(st.hint)}${MINE.has(st.key) ? ' · <b>אצלך</b>' : ''}</p>
            <ul class="cards">${cards.map((c) => {
              const [ic, src] = SOURCE[c.source] ?? ['upload', ''];
              return `<li><a class="ccard" href="/priority/${c.doc}?id=${c.id}" data-nav>
                <span class="cc-top"><span class="pill p-brand">${esc(label(c.doc))}</span><span class="muted cc-at">${ago(c.updatedAt)}</span></span>
                <b class="cc-title">${esc(c.title)}</b>
                ${c.docno ? `<span class="cc-docno ltr-inline">${esc(c.docno)}</span>` : ''}
                <span class="cc-meta">${ui(ic)} ${esc(src)}${c.company ? ` · ${esc(company(c.company))}` : ''}${b.all && c.owner ? ` · ${esc(c.owner)}` : ''}</span>
              </a></li>`;
            }).join('') || '<li class="empty muted">—</li>'}</ul>
          </section>`;
        }).join('')}
      </div>`;
    main.querySelector('.filters').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      if (c.hasAttribute('data-all')) chainFilter.all = !chainFilter.all; else chainFilter.doc = c.dataset.doc;
      chain().then(() => main.querySelector(c.hasAttribute('data-all') ? '[data-all]' : `.chip[data-doc="${c.dataset.doc}"]`)?.focus());
    });
  }

  // ---------------------------------------------------------------- הגדרות
  async function settings() {
    const [s, log] = await Promise.all([api('GET', '/api/priority/settings'), api('GET', '/api/priority/log')]);
    let companies = s.companies.map((c) => ({ ...c }));
    const initialWrite = new Set(s.companies.filter((c) => c.write).map((c) => c.code));
    const pay = (code) => s.payTerms.find((p) => p.code === code)?.name ?? code;
    const conn = s.connection;

    main.innerHTML = `
      ${s.testLock ? '<p class="note">⚠ סביבת בדיקות: אף חברה אינה פתוחה לכתיבה, מה שלא יישמר כאן.</p>' : ''}
      <section class="panel">
        <div class="panel-h"><h2>חיבור לפריוריטי</h2><p>משתמש ה-API של הארגון. הסיסמה נשמרת מוצפנת ולא מוצגת שוב — כדי להחליף, מקלידים חדשה.</p></div>
        <div class="grid-form">
          <label for="c-host">כתובת השרת<input id="c-host" class="ltr" value="${esc(conn.host)}"></label>
          <label for="c-ini">קובץ הסביבה<input id="c-ini" class="ltr" value="${esc(conn.ini)}"></label>
          <label for="c-user">שם משתמש API<input id="c-user" class="ltr" value="${esc(conn.user)}" placeholder="${conn.fromServer.user ? 'מוגדר בשרת (PRIORITY_USER)' : ''}" autocomplete="off"></label>
          <label for="c-pass">סיסמת API<input id="c-pass" class="ltr" type="password" autocomplete="new-password" placeholder="${conn.hasPassword ? '•••••••• שמורה' : conn.fromServer.password ? 'מוגדרת בשרת (PRIORITY_PASSWORD)' : 'לא הוגדרה'}"></label>
        </div>
        <div class="row-actions"><button class="btn" id="c-test">בדיקת חיבור</button><span class="status" id="c-status"></span></div>
      </section>

      <section class="panel">
        <div class="panel-h"><h2>חברות</h2><p>כל החברות בפריוריטי. כתיבה — לאן מותר לקלוט מהבוט ומהמסך. התראות — באילו חברות שולחים "הזמנה הועברה לספק" והודעה לחותם הבא על דרישה.</p></div>
        <div class="scroll"><table class="t" id="co"></table></div>
        <div class="row-actions"><button class="btn small" id="co-add">+ חברה</button></div>
      </section>

      <section class="panel">
        <div class="panel-h"><h2>ברירות מחדל לקליטה</h2><p>מה שהמערכת ממלאת כשהמסמך לא אומר. כרגע לקריאה בלבד; יהיו ניתנות לעריכה כשקבלת הסחורה ודרישת הרכש יעברו למסך.</p></div>
        <div class="scroll"><table class="t">
          <tr><td>תנאי תשלום</td><td>${esc(pay(s.defaults.payCode))}</td></tr>
          <tr><td>מחסן, כשלפרויקט אין</td><td class="ltr">${esc(s.defaults.warehouse)}</td></tr>
          <tr><td>פריט כללי לשורה בלי מק"ט</td><td class="ltr">${esc(s.defaults.generalPart)}</td></tr>
          <tr><td>תת פרק · משאב לשורה כללית</td><td class="ltr">${esc(s.defaults.chapter)} · ${esc(s.defaults.topic)}</td></tr>
          <tr><td>סוג דרישת רכש</td><td class="ltr">${esc(s.defaults.pdType)}</td></tr>
          <tr><td>הזמנה נחשבת סופית כשהיא</td><td>${esc(s.defaults.poFinalStatuses.join(' · '))}</td></tr>
          <tr><td>קוד מע"מ למסמך בלי מע"מ</td><td class="ltr">${esc(s.defaults.noVatCode)}</td></tr>
          <tr><td>טיוטא שלא אושרה מתבטלת אחרי</td><td>${esc(s.defaults.draftTtlHours)} שעות</td></tr>
        </table></div>
      </section>

      <div class="row-actions" style="position:sticky;bottom:0;background:var(--bg);padding:10px 0">
        <button class="btn pri" id="save">שמירה</button><span id="confirm"></span>
        <span class="hint">${s.updatedAt ? `נשמר לאחרונה ${new Date(s.updatedAt).toLocaleString('he-IL')}${s.updatedBy ? ` · ${esc(s.updatedBy.name)}` : ''}` : 'עוד לא נשמר במסך — הערכים נגזרים מההגדרות הקודמות'}</span>
      </div>

      <section class="panel">
        <div class="panel-h"><h2>יומן שינויים</h2></div>
        ${log.items.length ? `<ul class="log">${log.items.map((x) => `<li><span class="num muted">${new Date(x.at).toLocaleString('he-IL')}</span> · ${esc(x.by?.name ?? '—')}: ${x.changes.map(esc).join(' · ')}</li>`).join('')}</ul>` : '<p class="muted">אין שינויים עדיין.</p>'}
      </section>`;

    const F = { test: 'סביבת בדיקה', write: 'כתיבה', poNotify: 'התראות הזמנות רכש', pdNotify: 'התראה לחותם' };
    const tg = (on, f, i) => `<button type="button" class="tg" role="switch" aria-checked="${Boolean(on)}" data-f="${f}" data-i="${i}" aria-label="${F[f]} — ${esc(companies[i].name || companies[i].code || 'חברה חדשה')}"></button>`;
    function drawCompanies() {
      const codes = companies.map((c) => c.code);
      $('#co').innerHTML = '<tr><th>קוד</th><th>שם</th><th>ח.פ.</th><th>עותק בדיקה</th><th>סביבת בדיקה</th><th>כתיבה</th><th>התראות הזמנות</th><th>התראה לחותם</th><th></th></tr>' +
        companies.map((c, i) => `<tr>
          <td><input type="text" class="ltr" data-k="code" data-i="${i}" value="${esc(c.code)}" aria-label="קוד"></td>
          <td><input type="text" data-k="name" data-i="${i}" value="${esc(c.name)}" aria-label="שם" style="min-width:180px"></td>
          <td><input type="text" class="ltr num" data-k="vat" data-i="${i}" value="${esc(c.vat)}" aria-label="ח.פ."></td>
          <td><select data-k="sandbox" data-i="${i}" aria-label="עותק בדיקה"><option value="">—</option>${codes.filter((x) => x !== c.code).map((x) => `<option ${x === c.sandbox ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
          <td>${tg(c.test, 'test', i)}</td><td>${tg(c.write, 'write', i)}</td><td>${tg(c.poNotify, 'poNotify', i)}</td><td>${tg(c.pdNotify, 'pdNotify', i)}</td>
          <td><button class="btn small" data-del="${i}" aria-label="הסרת ${esc(c.name || c.code || 'השורה')}">${ui('x')}</button></td></tr>`).join('');
    }
    drawCompanies();
    $('#co').addEventListener('input', (e) => { const el = e.target.closest('[data-k]'); if (el) companies[+el.dataset.i][el.dataset.k] = el.value; });
    $('#co').addEventListener('change', (e) => { const el = e.target.closest('select[data-k]'); if (el) companies[+el.dataset.i][el.dataset.k] = el.value; });
    $('#co').addEventListener('click', (e) => {
      const t = e.target.closest('.tg');
      if (t) { const c = companies[+t.dataset.i]; c[t.dataset.f] = !c[t.dataset.f]; t.setAttribute('aria-checked', String(c[t.dataset.f])); return; }
      const d = e.target.closest('[data-del]');
      if (d) { companies.splice(+d.dataset.del, 1); drawCompanies(); }
    });
    $('#co-add').addEventListener('click', () => { companies.push({ code: '', name: '', vat: '', sandbox: '', test: false, write: false, poNotify: true, pdNotify: true }); drawCompanies(); });

    $('#c-test').addEventListener('click', async () => {
      const st = $('#c-status'); st.innerHTML = '<span class="muted">בודק…</span>';
      try {
        const r = await api('POST', '/api/priority/settings/test', {});
        st.innerHTML = r.ok ? `<span class="pill p-ok">מחובר ✓</span> <span class="muted">נבדק מול ${esc(r.company)}</span>` : `<span class="pill p-bad">לא מחובר</span> ${esc(r.error)}`;
      } catch (e) { st.innerHTML = `<span class="pill p-bad">שגיאה</span> ${esc(e.message)}`; }
    });

    let confirmed = false;
    $('#save').addEventListener('click', async () => {
      const opened = companies.filter((c) => c.write && !c.test && !initialWrite.has(c.code)).map((c) => c.code);
      if (opened.length && !confirmed) {
        $('#confirm').innerHTML = `<span class="dirty">פותחים כתיבה לחברה אמיתית: ${esc(opened.join(', '))}. ללחוץ שוב על "שמירה" כדי לאשר.</span>`;
        confirmed = true; return;
      }
      const body = { connection: { host: $('#c-host').value, ini: $('#c-ini').value, user: $('#c-user').value }, companies };
      if ($('#c-pass').value) body.connection.password = $('#c-pass').value;
      try {
        await api('PUT', '/api/priority/settings', body);
        toast('נשמר'); render();
      } catch (e) { confirmed = false; $('#confirm').textContent = ''; toast(e.message, true); }
    });
  }

  // ---------------------------------------------------------------- הרשאות
  async function access() {
    const m = await api('GET', '/api/priority/access');
    const users = m.users.map((u) => ({ ...u, docs: [...u.docs], companies: u.companies ? [...u.companies] : null }));
    const coName = (c) => m.companies.find((x) => x.code === c)?.name ?? c;
    const dirty = new Set();
    let picking = -1;

    main.innerHTML = `
      <section class="panel">
        <div class="panel-h"><h2>מי יכול מה בפריוריטי</h2>
          <p>לכל משתמש: סוגי המסמכים (כן או לא — מי שמורשה למסמך מורשה לכל מה שבו, בבוט ובמסך), והחברות שהוא שייך אליהן. מנהלי מערכת מורשים תמיד לכל דבר.</p></div>
        <div class="scroll"><table class="mtx" id="mtx"></table></div>
        <div class="row-actions"><button class="btn pri" id="save" disabled>שמירה</button><span class="dirty" id="dirty"></span></div>
      </section>`;

    function draw() {
      // שמירת המיקום של המקלדת אחרי ציור מחדש (ui-ux-pro-max: focus management)
      const f = document.activeElement;
      const keep = f && $('#mtx')?.contains(f) ? ['data-u', 'data-d', 'data-co', 'data-pick'].filter((k) => f.hasAttribute(k)).map((k) => `[${k}="${CSS.escape(f.getAttribute(k))}"]`).join('') : '';
      $('#mtx').innerHTML = `<thead><tr><th>משתמש</th>${m.docs.map((d) => `<th>${esc(d.label)}${d.ready ? '' : '<br><span class="pill p-mute">בקרוב</span>'}</th>`).join('')}<th>חברות</th></tr></thead><tbody>` +
        users.map((u, i) => `<tr><td><b>${esc(u.name)}</b><span>${esc([u.department, ROLE[u.role] ?? u.role].filter(Boolean).join(' · '))}</span></td>
          ${m.docs.map((d) => `<td><button type="button" class="ck" role="checkbox" aria-checked="${u.docs.includes(d.key)}" aria-label="${esc(u.name)} — ${esc(d.label)}" data-u="${i}" data-d="${d.key}" ${u.admin ? 'disabled' : ''}>✓</button></td>`).join('')}
          <td><button type="button" class="cobtn" data-pick="${i}" ${u.admin ? 'disabled' : ''} aria-expanded="${picking === i}" aria-label="החברות של ${esc(u.name)}: ${u.companies === null ? 'כל החברות' : u.companies.length ? esc(u.companies.map(coName).join(', ')) : 'אף חברה'}">${u.companies === null ? '<span class="pill p-ok">כל החברות</span>' : u.companies.length ? u.companies.map((c) => `<span class="pill p-brand">${esc(coName(c))}</span>`).join('') : '<span class="pill p-warn">אף חברה</span>'}</button></td></tr>
          ${picking === i ? `<tr class="copick"><td colspan="${m.docs.length + 2}"><div class="pk"><button data-co="*" data-u="${i}" aria-pressed="${u.companies === null}">כל החברות</button>${m.companies.map((c) => `<button data-co="${esc(c.code)}" data-u="${i}" aria-pressed="${Boolean(u.companies?.includes(c.code))}">${esc(c.name)}</button>`).join('')}</div><span class="hint">חברה חדשה בפריוריטי נוספת אוטומטית רק למי שמסומן "כל החברות".</span></td></tr>` : ''}`).join('') + '</tbody>';
      if (keep) $('#mtx').querySelector(keep)?.focus();
      $('#save').disabled = !dirty.size;
      $('#dirty').textContent = dirty.size ? `${dirty.size} שינויים שלא נשמרו` : '';
    }
    draw();
    $('#mtx').addEventListener('click', (e) => {
      const p = e.target.closest('[data-pick]');
      if (p) { picking = picking === +p.dataset.pick ? -1 : +p.dataset.pick; return draw(); }
      const c = e.target.closest('[data-co]');
      if (c) {
        const u = users[+c.dataset.u];
        if (c.dataset.co === '*') u.companies = u.companies === null ? [] : null;
        else {
          const s = new Set(u.companies ?? m.companies.map((x) => x.code));
          if (s.has(c.dataset.co)) s.delete(c.dataset.co); else s.add(c.dataset.co);
          u.companies = [...s];
        }
        dirty.add(u.id); return draw();
      }
      const b = e.target.closest('.ck');
      if (b && !b.disabled) {
        const u = users[+b.dataset.u];
        u.docs = u.docs.includes(b.dataset.d) ? u.docs.filter((x) => x !== b.dataset.d) : [...u.docs, b.dataset.d];
        dirty.add(u.id); draw();
      }
    });
    $('#save').addEventListener('click', async () => {
      const rows = users.filter((u) => dirty.has(u.id)).map((u) => ({ id: u.id, docs: u.docs, companies: u.companies }));
      try {
        const r = await api('PUT', '/api/priority/access', { rows });
        toast(r.changes.length ? `נשמר: ${r.changes.length} שינויים` : 'נשמר');
        render();
      } catch (e) { toast(e.message, true); }
    });
  }

  render();
})();
