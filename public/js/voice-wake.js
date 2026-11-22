'use strict';
/**
 * 👂 הפעלה בקול — אומרים "משימון", והמערכת שואלת "במה אפשר לעזור?"
 * ומאזינה, כאילו נלחץ 🎙.
 *
 * המגבלה, ולמה היא כאן בקוד ולא רק בהסבר: אפליקציית רשת יכולה להאזין רק
 * כשהיא פתוחה על המסך והמסך דולק. לכן:
 *   • המתג נדלק רק בלחיצה — ואחריה אין צורך ללחוץ שוב.
 *   • המסך נשאר דולק (Screen Wake Lock) כל עוד מאזינים.
 *   • כיבוי אוטומטי: אחרי זמן בלי שימוש, במעבר לאפליקציה אחרת, ובסוללה חלשה.
 *   • פס בראש המסך כל עוד מאזינים — האזנה לא נעשית בלי שרואים אותה.
 *
 * כל מה שנאמר לפני "משימון" — מושלך מיד. לשרת מגיע רק מה שאחריו.
 * כשהטלפון נעול: Siri / Google פותחים את ‎/?voice=1‎ (‎VoiceView.shortcutHelp‎).
 */

const VoiceWake = (() => {
  const { el } = UI;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  // "משימון", גם בשיבושי זיהוי נפוצים, ומה שנאמר אחריו באותו משפט
  const WAKE = /(?:היי\s+|הי\s+)?(?:משימון|משימונ|מישימון|משמון|מסימון)[\s,.!?]*(.*)$/;
  const BATTERY_MIN = 0.2;

  let on = false;
  let paused = false;     // מסך ההקלטה פתוח — זיהוי אחד בכל רגע
  let rec = null;
  let wakeLock = null;
  let lastActivity = 0;
  let idleTimer = null;
  let banner = null;

  const supported = () => Boolean(Recognition);
  const enabledInPrefs = () => Boolean(App.state.prefs?.voice?.wake);
  const minutes = () => Number(App.state.prefs?.voice?.wakeMinutes) || 30;
  const isOn = () => on;

  // ------------------------------------------------------------- מסך דולק

  async function holdScreen() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener?.('release', () => { wakeLock = null; });
      }
    } catch { /* לא נתמך — ההאזנה עדיין עובדת כל עוד המסך דולק */ }
  }

  function releaseScreen() {
    try { wakeLock?.release(); } catch { /* כבר שוחרר */ }
    wakeLock = null;
  }

  // ------------------------------------------------------------- האזנה

  function listen() {
    if (!on || paused || rec) return;
    try {
      rec = new Recognition();
      rec.lang = 'he-IL';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const said = e.results[i][0].transcript;
          const m = WAKE.exec(said);
          if (!m) continue;
          // משפט שלם אחרי "משימון" — "משימון, פתח משימה לסדר את המעליות"
          const rest = e.results[i].isFinal ? m[1].trim() : '';
          if (e.results[i].isFinal || said.trim().split(/\s+/).length <= 3) {
            wake(rest);
            return;
          }
        }
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          stop();
          UI.toast('אין הרשאה למיקרופון — ההאזנה כבתה. לפתיחה: סמל המנעול שליד הכתובת ← מיקרופון ← אפשר', 'error');
        }
      };
      // הדפדפן עוצר אחרי שתיקה או אחרי דקה — כל עוד המתג דולק, מתחילים מחדש
      rec.onend = () => {
        rec = null;
        if (on && !paused) setTimeout(listen, 250);
      };
      rec.start();
    } catch {
      rec = null;
      if (on && !paused) setTimeout(listen, 1000);
    }
  }

  function quiet() {
    const r = rec;
    rec = null;
    try { r?.abort(); } catch { /* כבר עצר */ }
  }

  /** "משימון" נשמע — שאלה בקול, ומסך ההקלטה כאילו נלחץ 🎙 */
  async function wake(rest) {
    if (paused) return;
    paused = true;
    lastActivity = Date.now();
    quiet();
    VoiceView.chime();
    drawBanner();
    const resume = () => {
      paused = false;
      lastActivity = Date.now();
      drawBanner();
      // לחזור להאזין ל"משימון" — אחרי שהדיאלוג שנפתח (אם נפתח) כבר על המסך
      setTimeout(listen, 600);
    };
    // נאמרה המשימה כבר באותו משפט — ישר לשליחה, בלי לשאול
    if (rest && rest.split(/\s+/).length >= 2) {
      VoiceView.open({ handsFree: true, initialText: rest, autoSend: true, autoStart: false, onClose: resume });
      return;
    }
    VoiceView.open({ handsFree: true, ask: true, onClose: resume });
  }

  // ------------------------------------------------------------- הפעלה וכיבוי

  async function start() {
    if (on) return;
    if (!supported()) return UI.toast('הדפדפן הזה אינו תומך בזיהוי דיבור. בכרום או בספארי זה עובד.', 'error');
    on = true;
    paused = false;
    lastActivity = Date.now();
    await holdScreen();
    listen();
    drawBanner();
    clearInterval(idleTimer);
    idleTimer = setInterval(checkIdle, 30000);
    App.refreshChrome();
    UI.toast('👂 מאזין — אמרו "משימון"');
  }

  function stop(reason = '') {
    if (!on) return;
    on = false;
    paused = false;
    quiet();
    releaseScreen();
    clearInterval(idleTimer);
    banner?.remove();
    banner = null;
    App.refreshChrome();
    if (reason) UI.toast(reason);
  }

  const toggle = () => (on ? stop() : start());

  async function checkIdle() {
    if (!on) return;
    if (!paused && Date.now() - lastActivity > minutes() * 60000) {
      return stop(`ההאזנה כבתה אחרי ${minutes()} דקות בלי שימוש`);
    }
    try {
      const b = await navigator.getBattery?.();
      if (b && !b.charging && b.level < BATTERY_MIN) stop('ההאזנה כבתה — הסוללה מתחת ל-20%');
    } catch { /* אין מידע על הסוללה */ }
  }

  // מעבר לאפליקציה אחרת — הדפדפן ממילא מפסיק לשמוע; מכבים במפורש
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && on) stop();
  });

  /** ההעדפה כובתה בהגדרות — מכבים גם את מה שרץ */
  function sync() {
    if (!enabledInPrefs() && on) stop();
  }

  // ------------------------------------------------------------- הפס העליון

  function drawBanner() {
    if (!on) return;
    const node = el(`div.wake-banner${paused ? '.is-paused' : ''}`, {}, [
      el('span.wake-dot'),
      el('span', { text: paused ? 'מקשיב למשימה…' : '👂 משימון מאזין — אמרו "משימון"' }),
      el('div.spacer'),
      el('button.wake-off', { type: 'button', title: 'כיבוי ההאזנה', onclick: () => stop() }, ['כיבוי'])
    ]);
    if (banner) banner.replaceWith(node);
    else document.body.appendChild(node);
    banner = node;
  }

  return { start, stop, toggle, isOn, supported, sync, enabledInPrefs };
})();
