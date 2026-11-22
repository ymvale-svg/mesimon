'use strict';
/**
 * 📍 מיקום — לשונית ב"⚙ ההגדרות שלי": נקודות הציון (המשרד והאתרים) לתזכורות לפי מיקום, והמצב שלי.
 * המיקום עצמו מגיע רק מוואטסאפ: כשנרשמת תזכורת מקום, הבוט מבקש לשתף איתו מיקום בזמן אמת (הוחלט 16.11.26 —
 * משימון לא פתוח אצל העובדים כל הזמן, אז שיתוף מהאפליקציה הוסר). "המיקום הנוכחי שלי" — רק כדי לסמן נקודת ציון.
 * השרת: ‎server/api/api-places.js‎, ‎server/whatsapp/places.js‎.
 */
const LocationView = (() => {
  const { el } = UI;
  const supported = () => 'geolocation' in navigator;

  /** מיקום אחד, עכשיו */
  const here = () => new Promise((resolve, reject) => {
    if (!supported()) return reject(new Error('הדפדפן הזה לא תומך במיקום'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(new Error(err.code === 1 ? 'אין הרשאת מיקום. מאשרים בהגדרות הדפדפן / הטלפון ומנסים שוב' : 'לא הצלחתי לקבל מיקום. נסו שוב')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  });

  const ago = (iso) => {
    if (!iso) return '';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return min < 1 ? 'עכשיו' : min < 60 ? `לפני ${min} דק׳` : min < 24 * 60 ? `לפני ${Math.round(min / 60)} שע׳` : new Date(iso).toLocaleDateString('he-IL');
  };

  // ---------------------------------------------------------------------------
  // הלשונית
  // ---------------------------------------------------------------------------

  async function openSettings({ into } = {}) {
    UI.mount(into, UI.spinner());
    let me;
    let data;
    try {
      [me, data] = await Promise.all([API.get('/api/me/location'), API.get('/api/places')]);
    } catch (err) {
      UI.mount(into, el('div.alert.alert-danger', { text: err.message }));
      return;
    }
    const draw = () => UI.mount(into, el('div', {}, [statusPane(me), placesPane(data, redraw)]));
    async function redraw() {
      [me, data] = await Promise.all([API.get('/api/me/location'), API.get('/api/places')]);
      draw();
    }
    draw();
  }

  function statusPane(me) {
    const now = me.live
      ? `🟢 יש כרגע שיתוף מיקום בזמן אמת עם הבוט${me.place ? ` · נקודת ציון: ${me.place.name}` : ''}.`
      : `אין כרגע שיתוף מיקום בזמן אמת${me.lastAt ? ` · מיקום אחרון ${ago(me.lastAt)}` : ''}.`;
    return el('div.alert.alert-info', {}, [el('div', {}, [
      el('b', { text: '📍 תזכורת לפי מיקום' }),
      el('div', { text: 'כותבים לבוט: "תזכיר לי כשאני מגיע למשרד לדבר עם ישראל". הבוט מבקש לשתף איתו מיקום בזמן אמת בוואטסאפ (📎 ← מיקום ← שיתוף מיקום בזמן אמת), וברגע שמגיעים — שולח את התזכורת.' }),
      el('div.mute-sm', { style: { marginTop: '4px' }, text: 'הבוט שומר רק באיזו נקודת ציון העובד נמצא — לא את המסלול, ואף אחד לא רואה את זה.' }),
      el('div.mute-sm', { style: { marginTop: '4px' }, text: now }),
      me.waiting ? el('div.mute-sm', { text: `⏰ ${me.waiting} תזכורות מחכות למקום.` }) : null
    ])]);
  }

  function placesPane(data, redraw) {
    const rows = data.places.map((p) => el('tr', {}, [
      el('td', {}, [
        el('div', {}, [el('b', { text: p.name }), el('span.mute-sm', { text: ` · ${p.kindLabel} · ${p.radius} מ׳` })]),
        p.aliases.length ? el('div.mute-sm', { text: `גם: ${p.aliases.join(', ')}` }) : null
      ]),
      el('td', { style: { whiteSpace: 'nowrap', textAlign: 'left' } }, [
        el('a.btn.btn-sm', { href: `https://www.google.com/maps?q=${p.lat},${p.lng}`, target: '_blank', rel: 'noopener', title: 'במפה' }, ['🗺']),
        data.canEdit ? el('button.btn.btn-sm', { onclick: () => editPlace(data, p, redraw) }, ['עריכה']) : null,
        data.canEdit ? el('button.btn.btn-sm.btn-danger', {
          onclick: async () => {
            if (!await UI.confirm(`למחוק את "${p.name}"? תזכורות שמחכות לו יבוטלו.`, { title: 'מחיקת נקודת ציון', danger: true, okText: 'מחיקה' })) return;
            try { await API.del(`/api/places/${p.id}`); await redraw(); } catch (err) { UI.error(err); }
          }
        }, ['מחיקה']) : null
      ])
    ]));
    return el('div', {}, [
      el('h4', { text: '📌 נקודות ציון — המשרד והאתרים', style: { margin: '18px 0 8px', fontSize: '13px' } }),
      rows.length
        ? el('div.table-wrap', {}, [el('table.data', { style: { whiteSpace: 'normal', width: '100%' } }, [el('tbody', {}, rows)])])
        : el('div.mute-sm', { text: data.canEdit ? 'עוד אין נקודות ציון. הוסיפו את המשרד ואת האתרים.' : 'עוד אין נקודות ציון. מנהל המחלקה מוסיף אותן.' }),
      data.canEdit ? el('div.flex.mt', { style: { gap: '8px' } }, [
        el('button.btn.btn-sm.btn-primary', { onclick: () => editPlace(data, null, redraw) }, ['➕ נקודת ציון'])
      ]) : null
    ]);
  }

  function editPlace(data, place, redraw) {
    const name = el('input', { type: 'text', value: place?.name ?? '', placeholder: 'למשל: המשרד הראשי / אתר אלעד' });
    const kind = el('select', {}, Object.entries(data.kinds).map(([k, label]) => el('option', { value: k, text: label, selected: (place?.kind ?? 'site') === k })));
    const coords = el('input', { type: 'text', dir: 'ltr', value: place ? `${place.lat}, ${place.lng}` : '', placeholder: '32.0853, 34.7818 או קישור מגוגל מפות' });
    const radius = el('input', { type: 'number', min: 50, max: 5000, step: 50, value: place?.radius ?? data.radius[place?.kind ?? 'site'] });
    const aliases = el('input', { type: 'text', value: (place?.aliases ?? []).join(', '), placeholder: 'למשל: העבודה, המשרד' });
    kind.addEventListener('change', () => { if (!place) radius.value = data.radius[kind.value]; });
    const useHere = el('button.btn.btn-sm', {
      type: 'button',
      onclick: async () => {
        useHere.disabled = true;
        try {
          const p = await here();
          coords.value = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
          if (p.accuracy > 100) UI.error(new Error(`המיקום לא מדויק (±${Math.round(p.accuracy)} מ׳). אפשר לנסות שוב בחוץ, או להדביק נ"צ`));
        } catch (err) { UI.error(err); }
        useHere.disabled = false;
      }
    }, ['📍 המיקום הנוכחי שלי']);
    // התווית מקושרת לשדה (for/id) — סקירת הממשק 22.11.26
    const field = (label, input, hint) => UI.field(label, input, hint);
    const m = UI.modal({
      title: place ? `עריכת ${place.name}` : '➕ נקודת ציון חדשה',
      body: el('div', {}, [
        field('שם', name),
        field('סוג', kind),
        field('נ"צ', coords, 'עומדים במקום ולוחצים "המיקום הנוכחי שלי", או מדביקים נ"צ / קישור מגוגל מפות.'),
        el('div.flex', { style: { gap: '8px', marginBottom: '10px' } }, [useHere]),
        field('רדיוס (מטרים)', radius, 'מאיזה מרחק נחשב "הגיע". משרד — 150; אתר — 300.'),
        field('כינויים', aliases, 'מילים נוספות שהעובדים אומרים, מופרדות בפסיק. כך "כשאגיע לעבודה" ימצא את המשרד.')
      ]),
      footer: [
        el('button.btn', { 'data-close': '1', onclick: () => m.close() }, ['ביטול']),
        el('div.spacer'),
        el('button.btn.btn-primary', {
          onclick: async () => {
            const body = { name: name.value, kind: kind.value, coords: coords.value, radius: Number(radius.value), aliases: aliases.value };
            try {
              if (place) await API.put(`/api/places/${place.id}`, body);
              else await API.post('/api/places', body);
              m.close();
              UI.success('נשמר');
              await redraw();
            } catch (err) { UI.error(err); }
          }
        }, ['שמירה'])
      ]
    });
  }

  return { openSettings };
})();
