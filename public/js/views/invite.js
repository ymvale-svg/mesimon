'use strict';
/** מסך מימוש הזמנה — המוזמן קובע לעצמו סיסמה ונכנס ישירות. */

const InviteView = (() => {
  const { el } = UI;

  const tokenFromUrl = () => {
    const match = location.pathname.match(/^\/invite\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  async function render(root, token, onSuccess) {
    UI.mount(root, el('div.login-page', {}, [
      el('div.login-panel', {}, [UI.spinner()]),
      hero()
    ]));

    let info;
    try {
      info = await API.get(`/api/invite/${encodeURIComponent(token)}`);
    } catch (err) {
      return showError(root, err.message);
    }
    if (!info.valid) return showError(root, info.error);

    const passInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'לפחות 8 תווים' });
    const repeatInput = el('input', { type: 'password', autocomplete: 'new-password' });
    const errorBox = el('div.alert.alert-danger', { style: { display: 'none' } });
    const button = el('button.btn.btn-primary.btn-block', { type: 'submit' }, ['קביעת סיסמה וכניסה']);

    async function submit(e) {
      e?.preventDefault();
      errorBox.style.display = 'none';
      if (passInput.value.length < 8) return fail('הסיסמה חייבת להכיל לפחות 8 תווים');
      if (passInput.value !== repeatInput.value) return fail('שתי הסיסמאות אינן זהות');

      button.disabled = true;
      button.textContent = 'רגע…';
      try {
        await API.post(`/api/invite/${encodeURIComponent(token)}`, { password: passInput.value });
        history.replaceState(null, '', '/');
        await onSuccess();
      } catch (err) {
        button.disabled = false;
        button.textContent = 'קביעת סיסמה וכניסה';
        fail(err.message);
      }
    }

    function fail(message) {
      errorBox.textContent = message;
      errorBox.style.display = 'flex';
    }

    const invitedBy = info.inviter
      ? `${info.inviter} הזמין/ה אותך ל${info.isVendor ? 'פורטל הספקים' : 'מערכת ניהול המשימות'} של ${info.orgName}.`
      : `הוזמנת ל${info.isVendor ? 'פורטל הספקים' : 'מערכת ניהול המשימות'} של ${info.orgName}.`;

    UI.mount(root, el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: `שלום ${info.name}` }),
        el('p.muted', { text: invitedBy }),
        el('div.alert.alert-info', {}, [
          el('span', { text: '✉️' }),
          el('div', {}, [
            el('div', { text: 'החשבון שלך:' }),
            el('b', { text: info.email })
          ])
        ]),
        el('form', { onsubmit: submit }, [
          UI.field('בחירת סיסמה', passInput),
          UI.field('אימות הסיסמה', repeatInput),
          errorBox,
          button
        ])
      ]),
      hero()
    ]));
    passInput.focus();
  }

  const hero = () => el('div.login-hero', {}, [
    el('div.hero-center', {}, [UI.logo({ size: 'lg', tagline: true, variant: 'light' })])
  ]);

  function showError(root, message) {
    UI.mount(root, el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: 'ההזמנה אינה זמינה' }),
        el('div.alert.alert-danger.mt', {}, [el('span', { text: '⚠️' }), el('div', { text: message })]),
        el('a.btn.btn-block.mt', { href: '/' }, ['למסך הכניסה'])
      ]),
      hero()
    ]));
  }

  return { render, tokenFromUrl };
})();
