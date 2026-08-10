'use strict';
/** מסך ההתחברות. */

const LoginView = (() => {
  const { el } = UI;

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

    // כניסה עם Google מוצגת רק אם הוגדרה בשרת
    const googleSlot = el('div');
    fetch('/api/branding').then((r) => r.json()).then((b) => {
      if (!b.googleLogin) return;
      UI.mount(googleSlot,
        el('div.or-divider', {}, [el('span', { text: 'או' })]),
        el('a.btn.btn-block.google-btn', { href: '/api/auth/google/start' }, [
          el('span.google-mark', {
            html: `<svg viewBox="0 0 48 48" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
              <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3z"/>
              <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8 41.3 15.4 46 24 46z"/>
              <path fill="#FBBC05" d="M11.8 28.4c-.4-1.3-.7-2.7-.7-4.4s.3-3.1.7-4.4v-5.7H4.5C2.9 17.1 2 20.4 2 24s.9 6.9 2.5 10.1l7.3-5.7z"/>
              <path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 30 2 24 2 15.4 2 8 6.7 4.5 13.9l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z"/>
            </svg>`
          }),
          'כניסה עם חשבון Google'
        ])
      );
    }).catch(() => {});

    // הודעת שגיאה שחוזרת מזרימת Google
    const googleError = new URLSearchParams(location.search).get('googleError');
    if (googleError) {
      errorBox.textContent = googleError;
      errorBox.style.display = 'flex';
      history.replaceState(null, '', location.pathname);
    }

    const page = el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: 'ברוכים הבאים' }),
        el('p.muted', { text: 'התחברו כדי להמשיך לניהול המשימות והפרויקטים.' }),
        form,
        googleSlot
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
