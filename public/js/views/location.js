'use strict';
/**
 * 📍 מיקום — לשונית ב"⚙ ההגדרות שלי": שיתוף המיקום שלי, ונקודות הציון (המשרד והאתרים) לתזכורות לפי מיקום.
 *
 *   • שיתוף מהאפליקציה: כשהשיתוף דלוק והאפליקציה פתוחה — המיקום נשלח לשרת (כל כמה דקות, או כשזזים),
 *     והשרת בודק אם הגעת לנקודת ציון. דפדפן לא מאפשר מיקום כשהאפליקציה סגורה — לכן גם:
 *   • קישור אישי לאפליקציית מעקב ברקע (OwnTracks, או אוטומציה בקיצורי הדרך של האייפון) — עובד גם כשמשימון סגור.
 *   • ובכל רגע — שליחת מיקום 📍 לבוט בוואטסאפ.
 * השרת: ‎server/api/api-places.js‎, ‎server/whatsapp/places.js‎.
 */
const LocationView = (() => {
  const { el } = UI;
  const SEND_EVERY_MS = 3 * 60 * 1000;
  const SEND_IF_MOVED_M = 75;
  let watchId = null;
  let last = null; // { lat, lng, at }

  const supported = () => 'geolocation' in navigator;

  function meters(a, b) {
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** מיקום אחד, עכשיו */
  const here = () => new Promise((resolve, reject) => {
    if (!supported()) return reject(new Error('הדפדפן הזה לא תומך במיקום'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(new Error(err.code === 1 ? 'אין הרשאת מיקום. מאשרים בהגדרות הדפדפן / הטלפון ומנסים שוב' : 'לא הצלחתי לקבל מיקום. נסו שוב')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  });

  async function send(pos, force = false) {
    const now = Date.now();
    if (!force && last && now - last.at < SEND_EVERY_MS && meters(last, pos) < SEND_IF_MOVED_M) return null;
    last = { lat: pos.lat, lng: pos.lng, at: now };
    return API.post('/api/me/location', pos).catch(() => null);
  }

  /** מעקב בזמן שהאפליקציה פתוחה. נקרא בכניסה (כשהשיתוף דלוק) ובהפעלה */
  function start(pref) {
    if (!pref?.share || !supported() || watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => { void send({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
      () => { /* בלי הרשאה / בלי אות — מנסים שוב בפעם הבאה שהאפליקציה נפתחת */ },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 60000 }
    );
    // חזרה לאפליקציה (מהרקע) — מיקום מיד, בלי לחכות לתזוזה
    document.addEventListener('visibilitychange', onVisible);
  }

  function onVisible() {
    if (document.visibilityState === 'visible' && watchId !== null) here().then((p) => send(p, true)).catch(() => {});
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    last = null;
    document.removeEventListener('visibilitychange', onVisible);
  }

  const ago = (iso) => {
    if (!iso) return '';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return min < 1 ? 'עכשיו' : min < 60 ? `לפני ${min} דק׳` : min < 24 * 60 ? `לפני ${Math.round(min / 60)} שע׳` : new Date(iso).toLocaleDateString('he-IL');
  };
  const SOURCE = { app: 'מהאפליקציה', whatsapp: 'ממיקום ששלחת לבוט', tracker: 'מאפליקציית המעקב' };

  // ---------------------------------------------------------------------------
  // הלשונית
  // ---------------------------------------------------------------------------

  async function openSettings({ into, onPref } = {}) {
    UI.mount(into, UI.spinner());
    let me;
    let data;
    try {
      [me, data] = await Promise.all([API.get('/api/me/location'), API.get('/api/places')]);
    } catch (err) {
      UI.mount(into, el('div.alert.alert-danger', { text: err.message }));
      return;
    }
    const draw = () => UI.mount(into, el('div', {}, [sharePane(me, redraw), placesPane(data, redraw)]));
    async function redraw() {
      [me, data] = await Promise.all([API.get('/api/me/location'), API.get('/api/places')]);
      onPref?.({ share: me.share });
      draw();
    }
    draw();
  }

  function sharePane(me, redraw) {
    const box = el('input', { type: 'checkbox', checked: me.share });
    box.addEventListener('change', async () => {
      try {
        if (box.checked) {
          // הרשאת המיקום של הדפדפן — לפני שמדליקים, כדי שהעובד יראה מיד אם חסר משהו
          const p = await here().catch((err) => { UI.error(err); return null; });
          await API.put('/api/me/location/share', { share: true });
          start({ share: true });
          if (p) await send(p, true);
          UI.success('שיתוף המיקום הופעל');
        } else {
          await API.put('/api/me/location/share', { share: false });
          stop();
          UI.success('שיתוף המיקום כובה, והמיקום האחרון נמחק');
        }
        await redraw();
      } catch (err) { UI.error(err); box.checked = !box.checked; }
    });
    const status = me.share
      ? (me.lastAt ? `מיקום אחרון ${ago(me.lastAt)} ${SOURCE[me.source] ?? ''}${me.place ? ` · נקודת ציון: ${me.place.name}` : ''}.` : 'עוד לא התקבל מיקום.')
      : 'כבוי. תזכורות לפי מיקום יעבדו רק כשתשלחו לבוט מיקום 📍 בוואטסאפ.';
    return el('div', {}, [
      el('div.mute-sm', { text: 'תזכורת לפי מיקום: כותבים לבוט "תזכיר לי כשאני מגיע למשרד לדבר עם ישראל" — וכשתגיעו, הבוט שולח וואטסאפ.' }),
      el('div.table-wrap.mt', {}, [el('table.data', { style: { whiteSpace: 'normal', width: '100%' } }, [el('tbody', {}, [
        el('tr', {}, [
          el('td', {}, [
            el('div', { text: '📍 לשתף את המיקום שלי' }),
            el('div.mute-sm', { text: 'רק לבדיקה אם הגעת לנקודת ציון (או יצאת ממנה). נשמר רק המיקום האחרון, ואף אחד לא רואה אותו — גם לא מנהלים. כיבוי מוחק אותו.' }),
            el('div.mute-sm', { style: { marginTop: '4px' }, text: status }),
            me.waiting ? el('div.mute-sm', { text: `⏰ ${me.waiting} תזכורות מחכות למיקום.` }) : null
          ]),
          el('td', { style: { textAlign: 'center', width: '110px' } }, [el('label.checkbox', {}, [box])])
        ]),
        me.share ? el('tr', {}, [el('td', { colSpan: 2 }, [trackerPane(me, redraw)])]) : null
      ])])])
    ]);
  }

  /** קישור אישי לאפליקציית מעקב ברקע */
  function trackerPane(me, redraw) {
    const out = el('div');
    const make = async () => {
      if (me.hasToken && !await UI.confirm('קישור חדש מבטל את הקודם — אפליקציית המעקב שמשתמשת בו תפסיק לעדכן. להמשיך?', { title: 'קישור חדש', okText: 'קישור חדש' })) return;
      try {
        const { token } = await API.post('/api/me/location/token');
        const url = `${location.origin}/api/location/ping/${token}`;
        const field = el('input', { type: 'text', readOnly: true, value: url, dir: 'ltr', style: { width: '100%' }, onclick: (e) => e.target.select() });
        UI.mount(out, el('div.alert.alert-info.mt', {}, [el('div', {}, [
          el('b', { text: 'הקישור שלך (מוצג פעם אחת בלבד — שמרו אותו):' }),
          field,
          el('div.flex.mt', { style: { gap: '8px' } }, [
            el('button.btn.btn-sm', { onclick: () => navigator.clipboard?.writeText(url).then(() => UI.success('הועתק')).catch(() => field.select()) }, ['📋 העתקה'])
          ]),
          el('div.mute-sm.mt', { text: 'OwnTracks (אנדרואיד / אייפון): הגדרות ← Connection ← Mode: HTTP, ובכתובת — הקישור. במצב "Significant" הסוללה כמעט לא מושפעת.' }),
          el('div.mute-sm', { text: 'אייפון בלי אפליקציה: קיצורים ← אוטומציה ← "כשאני מגיע/ה" למקום ← "קבל תוכן של כתובת URL" — הקישור, בשיטת POST, עם גוף JSON: lat ו-lng של המיקום הנוכחי.' })
        ])]));
      } catch (err) { UI.error(err); }
    };
    return el('div', {}, [
      el('div', { text: '🛰 גם כשמשימון סגור' }),
      el('div.mute-sm', { text: 'הדפדפן שולח מיקום רק כשהאפליקציה פתוחה. כדי שהבוט ידע שהגעת גם כשהיא סגורה — מחברים אפליקציית מעקב ברקע בקישור אישי.' }),
      el('div.flex.mt', { style: { gap: '8px' } }, [
        el('button.btn.btn-sm', { onclick: make }, [me.hasToken ? '🔄 קישור חדש' : '🔗 יצירת קישור אישי'])
      ]),
      out
    ]);
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
    const field = (label, input, hint) => el('div.field', {}, [el('label', { text: label }), input, hint ? el('div.hint', { text: hint }) : null]);
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

  return { openSettings, start, stop, supported };
})();
