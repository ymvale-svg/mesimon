'use strict';
/**
 * מסך הרשמה עצמית — הלינק שמופץ בחברה.
 *
 * הנרשם ממלא שם, אימייל וסיסמה, וההרשמה נכנסת כ"ממתינה לאישור". הוא אינו
 * נכנס למערכת בסוף התהליך אלא מקבל הודעה שהבקשה נשלחה: רק אחרי שמנהל אישר
 * וקבע לו רמת גישה ומחלקה, הכניסה נפתחת.
 *
 * המסך אינו חושף דבר על הארגון מלבד שמו — כל מי שיש לו את הקישור רואה אותו,
 * כולל מי שהקישור הגיע אליו בטעות.
 */

const SignupView = (() => {
  const { el } = UI;

  const tokenFromUrl = () => {
    const match = location.pathname.match(/^\/signup\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  const hero = () =>
    el('div.login-hero', {}, [
      el('div.hero-center', {}, [UI.logo({ size: 'lg', tagline: true, variant: 'light' })])
    ]);

  function showMessage(root, { title, body, tone = 'info' }) {
    UI.mount(root, el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: title }),
        el(`div.alert.alert-${tone}`, { style: { marginTop: '14px' } }, [el('div', { text: body })]),
        el('a.btn.btn-block.mt', { href: '/' }, ['למסך הכניסה'])
      ]),
      hero()
    ]));
  }

  async function render(root, token) {
    UI.mount(root, el('div.login-page', {}, [el('div.login-panel', {}, [UI.spinner()]), hero()]));

    let info;
    try {
      info = await API.get(`/api/signup/${encodeURIComponent(token)}`);
    } catch (err) {
      return showMessage(root, {
        title: 'הקישור אינו תקף',
        body: `${err.message}. ייתכן שהקישור הוחלף — כדאי לבקש קישור עדכני ממנהל המערכת.`,
        tone: 'danger'
      });
    }

    const nameInput = el('input', { type: 'text', autocomplete: 'name', placeholder: 'שם ושם משפחה' });
    const emailInput = el('input', { type: 'email', autocomplete: 'email', placeholder: 'האימייל שלך בעבודה' });
    const passInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'לפחות 6 תווים' });
    const repeatInput = el('input', { type: 'password', autocomplete: 'new-password' });
    const errorBox = el('div.alert.alert-danger', { style: { display: 'none' } });
    const button = el('button.btn.btn-primary.btn-block', { type: 'submit' }, ['שליחת בקשת הרשמה']);

    const fail = (message) => {
      UI.mount(errorBox, el('span', { text: '⚠️' }), el('div', { text: message }));
      errorBox.style.display = 'flex';
      button.disabled = false;
      button.textContent = 'שליחת בקשת הרשמה';
    };

    async function submit(e) {
      e?.preventDefault();
      errorBox.style.display = 'none';
      if (!nameInput.value.trim()) return fail('נדרש שם מלא');
      if (!emailInput.value.trim()) return fail('נדרשת כתובת אימייל');
      if (passInput.value.length < 6) return fail('הסיסמה חייבת להכיל לפחות 6 תווים');
      if (passInput.value !== repeatInput.value) return fail('שתי הסיסמאות אינן זהות');

      button.disabled = true;
      button.textContent = 'רגע…';
      try {
        await API.post(`/api/signup/${encodeURIComponent(token)}`, {
          name: nameInput.value.trim(),
          email: emailInput.value.trim(),
          password: passInput.value
        });
        /*
         * אותה הודעה גם כשהכתובת כבר קיימת — השרת אינו מבדיל, כדי שהלינק לא
         * יהפוך לכלי לבדוק מי עובד בחברה. ולכן גם הנוסח כאן אינו מבטיח
         * שנוצר חשבון חדש, אלא שהבקשה נשלחה.
         */
        showMessage(root, {
          title: 'הבקשה נשלחה',
          body: 'מנהל המערכת יאשר את החשבון ויקבע את ההרשאות. תקבל הודעה כשהחשבון ייפתח, ואז אפשר להיכנס עם האימייל והסיסמה שקבעת כאן.',
          tone: 'ok'
        });
      } catch (err) {
        fail(err.message);
      }
    }

    const form = el('form', { onsubmit: submit }, [
      UI.field('שם מלא', nameInput),
      UI.field('אימייל', emailInput, 'זו גם תהיה כתובת הכניסה שלך'),
      UI.field('סיסמה', passInput),
      UI.field('אימות הסיסמה', repeatInput),
      errorBox,
      button
    ]);

    UI.mount(root, el('div.login-page', {}, [
      el('div.login-panel', {}, [
        UI.companyLogo('on-panel'),
        el('h2', { text: `הרשמה למשימון — ${info.orgName}` }),
        el('p.muted', { text: 'מלא את הפרטים, והבקשה תועבר לאישור מנהל המערכת.' }),
        form,
        el('div.alert.alert-info.mt', {}, [
          el('span', { text: 'ℹ️' }),
          el('div', { text: 'החשבון אינו נפתח מיד: מנהל המערכת מאשר אותו וקובע את רמת הגישה והמחלקה. עד אז לא תראה נתונים במערכת.' })
        ])
      ]),
      hero()
    ]));
  }

  return { render, tokenFromUrl };
})();
