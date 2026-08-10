'use strict';
/** מסך ההתחברות. */

const LoginView = (() => {
  const { el } = UI;

  const DEMO = [
    { email: 'admin@eshel.co.il', name: 'אבי כהן', role: 'מנהל מערכת', icon: '⚙️' },
    { email: 'manager@eshel.co.il', name: 'רונית לוי', role: 'מנהלת מחלקה', icon: '📊' },
    { email: 'dana@eshel.co.il', name: 'דנה שמש', role: 'עובדת פנימית', icon: '👤' },
    { email: 'pixel@vendor.co.il', name: 'סטודיו גרפי "פיקסל"', role: 'ספק חיצוני', icon: '🏢' }
  ];

  function render(root, onSuccess) {
    const emailInput = el('input', { type: 'email', placeholder: 'name@eshel.co.il', autocomplete: 'username' });
    const passInput = el('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
    const errorBox = el('div.alert.alert-danger', { style: { display: 'none' } });
    const button = el('button.btn.btn-primary.btn-block', { type: 'submit' }, ['כניסה למערכת']);

    async function submit(e) {
      e?.preventDefault();
      errorBox.style.display = 'none';
      button.disabled = true;
      button.textContent = 'מתחבר…';
      try {
        await API.login(emailInput.value.trim(), passInput.value);
        await onSuccess();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.style.display = 'flex';
        button.disabled = false;
        button.textContent = 'כניסה למערכת';
      }
    }

    const form = el('form', { onsubmit: submit }, [
      UI.field('כתובת אימייל', emailInput),
      UI.field('סיסמה', passInput),
      errorBox,
      button
    ]);

    const page = el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: 'ברוכים הבאים' }),
        el('p.muted', { text: 'התחברו כדי להמשיך לניהול המשימות והפרויקטים.' }),
        form,
        el('div.demo-users', {}, [
          el('h4', { text: 'כניסה מהירה לצורכי הדגמה (סיסמה: 1234)' }),
          ...DEMO.map((d) =>
            el('button.demo-user', {
              type: 'button',
              onclick: () => {
                emailInput.value = d.email;
                passInput.value = '1234';
                submit();
              }
            }, [
              el('span', { text: d.icon, style: { fontSize: '18px' } }),
              el('span.who', {}, [el('b', { text: d.name }), el('small', { text: `${d.role} · ${d.email}` })])
            ])
          )
        ])
      ]),
      el('div.login-hero', {}, [
        el('div.hero-center', {}, [
          UI.logo({ size: 'lg', tagline: true, variant: 'light' })
        ])
      ])
    ]);

    UI.mount(root, page);
    UI.refitLogos();
    emailInput.focus();
  }

  return { render };
})();
