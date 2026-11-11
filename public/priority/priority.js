'use strict';
/**
 * משימון פריוריטי — תוכנה נפרדת בתוך משימון (‎/priority‎). לא טוען שום קוד של האתר הראשי.
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md".
 *
 * מסכים: הבית (‎/priority‎) · הגדרות (‎/priority/settings‎) · הרשאות (‎/priority/access‎). הגדרות והרשאות — מנהלי מערכת.
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
    if (!res.ok) { const e = new Error(data?.error ?? `שגיאה ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  let toastTimer = null;
  function toast(text, bad = false) {
    const t = $('#toast');
    t.textContent = text; t.className = bad ? 'toast bad' : 'toast'; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  const ICONS = {
    demand: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="M9 12h6M9 16h4"/>',
    order: '<path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2"/><circle cx="9" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
    receipt: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    partial: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    invoice: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    income: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'
  };
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
  const ROUTES = { '': home, settings, access };
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
    const tabs = [['/priority', 'בית', '']];
    if (me.admin) tabs.push(['/priority/settings', 'הגדרות', 'settings'], ['/priority/access', 'הרשאות', 'access']);
    $('#tabs').innerHTML = tabs.map(([href, label, key]) => `<a href="${href}" data-nav ${r === key ? 'aria-current="page"' : ''}>${label}</a>`).join('');
    $('#who').innerHTML = `${me.connected ? '' : '<span class="pill p-warn">החיבור לפריוריטי לא הוגדר</span>'} ${esc(me.name)} · <a href="/" style="color:inherit">משימון</a>`;
  }

  async function render() {
    try {
      me = await api('GET', '/api/priority/me');
    } catch (e) {
      if (e.status === 401) { main.innerHTML = '<div class="note">צריך להתחבר למשימון קודם. <a href="/">להתחברות</a>, ואחר כך לחזור לכאן.</div>'; return; }
      main.innerHTML = `<div class="note">${esc(e.message)}</div>`; return;
    }
    header();
    const view = ROUTES[routeOf()] ?? home;
    if ((view === settings || view === access) && !me.admin) { main.innerHTML = '<div class="note">רק מנהלי מערכת נכנסים למסך הזה.</div>'; return; }
    main.innerHTML = '<p class="muted pad">טוען…</p>';
    try { await view(); } catch (e) { main.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  }

  // ---------------------------------------------------------------- בית
  async function home() {
    const cos = me.allCompanies ? 'כל החברות' : me.companies.map((c) => c.name).join(' · ') || 'אף חברה';
    main.innerHTML = `
      <div class="greet"><h1>שלום, ${esc(me.name)}</h1><p>החברות שלך: ${esc(cos)}</p></div>
      <div class="tiles">${me.docs.map((d) => {
        const status = !d.allowed ? '<span class="pill p-mute">אין לך הרשאה</span>'
          : d.ready ? '<span class="pill p-ok">עובד בבוט</span><span class="pill p-mute">המסך — בבנייה</span>'
            : `<span class="pill p-mute">בקרוב · ${NEXT[d.key]} בתור</span>`;
        return `<div class="tile${d.allowed && d.ready ? '' : ' off'}"><span class="ic">${icon(d.key)}</span><h3>${esc(d.label)}</h3><span class="sub">${SUB[d.key] ?? ''}</span><span class="foot">${status}</span></div>`;
      }).join('')}</div>
      <p class="note">דרישת רכש וקבלת סחורה עובדות היום בוואטסאפ: כתבו לבוט "דרישת רכש" או "קבלת סחורה". העבודה עליהן מתוך המסך הזה — השלב הבא.</p>`;
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

    const tg = (on, f, i) => `<button class="tg" aria-pressed="${Boolean(on)}" data-f="${f}" data-i="${i}" aria-label="${f}"></button>`;
    function drawCompanies() {
      const codes = companies.map((c) => c.code);
      $('#co').innerHTML = '<tr><th>קוד</th><th>שם</th><th>ח.פ.</th><th>עותק בדיקה</th><th>סביבת בדיקה</th><th>כתיבה</th><th>התראות הזמנות</th><th>התראה לחותם</th><th></th></tr>' +
        companies.map((c, i) => `<tr>
          <td><input type="text" class="ltr" data-k="code" data-i="${i}" value="${esc(c.code)}" aria-label="קוד"></td>
          <td><input type="text" data-k="name" data-i="${i}" value="${esc(c.name)}" aria-label="שם" style="min-width:180px"></td>
          <td><input type="text" class="ltr num" data-k="vat" data-i="${i}" value="${esc(c.vat)}" aria-label="ח.פ."></td>
          <td><select data-k="sandbox" data-i="${i}" aria-label="עותק בדיקה"><option value="">—</option>${codes.filter((x) => x !== c.code).map((x) => `<option ${x === c.sandbox ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
          <td>${tg(c.test, 'test', i)}</td><td>${tg(c.write, 'write', i)}</td><td>${tg(c.poNotify, 'poNotify', i)}</td><td>${tg(c.pdNotify, 'pdNotify', i)}</td>
          <td><button class="btn small" data-del="${i}" aria-label="הסרה">✕</button></td></tr>`).join('');
    }
    drawCompanies();
    $('#co').addEventListener('input', (e) => { const el = e.target.closest('[data-k]'); if (el) companies[+el.dataset.i][el.dataset.k] = el.value; });
    $('#co').addEventListener('change', (e) => { const el = e.target.closest('select[data-k]'); if (el) companies[+el.dataset.i][el.dataset.k] = el.value; });
    $('#co').addEventListener('click', (e) => {
      const t = e.target.closest('.tg');
      if (t) { const c = companies[+t.dataset.i]; c[t.dataset.f] = !c[t.dataset.f]; t.setAttribute('aria-pressed', String(c[t.dataset.f])); return; }
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
      $('#mtx').innerHTML = `<thead><tr><th>משתמש</th>${m.docs.map((d) => `<th>${esc(d.label)}${d.ready ? '' : '<br><span class="pill p-mute">בקרוב</span>'}</th>`).join('')}<th>חברות</th></tr></thead><tbody>` +
        users.map((u, i) => `<tr><td><b>${esc(u.name)}</b><span>${esc([u.department, ROLE[u.role] ?? u.role].filter(Boolean).join(' · '))}</span></td>
          ${m.docs.map((d) => `<td><button class="ck" aria-pressed="${u.docs.includes(d.key)}" aria-label="${esc(u.name)} — ${esc(d.label)}" data-u="${i}" data-d="${d.key}" ${u.admin ? 'disabled' : ''}>✓</button></td>`).join('')}
          <td><button class="cobtn" data-pick="${i}" ${u.admin ? 'disabled' : ''} aria-label="החברות של ${esc(u.name)}">${u.companies === null ? '<span class="pill p-ok">כל החברות</span>' : u.companies.length ? u.companies.map((c) => `<span class="pill p-brand">${esc(coName(c))}</span>`).join('') : '<span class="pill p-warn">אף חברה</span>'}</button></td></tr>
          ${picking === i ? `<tr class="copick"><td colspan="${m.docs.length + 2}"><div class="pk"><button data-co="*" data-u="${i}" aria-pressed="${u.companies === null}">כל החברות</button>${m.companies.map((c) => `<button data-co="${esc(c.code)}" data-u="${i}" aria-pressed="${Boolean(u.companies?.includes(c.code))}">${esc(c.name)}</button>`).join('')}</div><span class="hint">חברה חדשה בפריוריטי נוספת אוטומטית רק למי שמסומן "כל החברות".</span></td></tr>` : ''}`).join('') + '</tbody>';
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
