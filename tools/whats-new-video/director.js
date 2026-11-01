'use strict';
/**
 * הבמאי של סרטוני "מה חדש" — מה שקורה על המסך בזמן ההקלטה.
 *
 * כל סצנה מקבלת ‎d‎ ומשתמשת בו כמו משתמש: ‎d.click‎, ‎d.type‎, ‎d.goto‎. על
 * המסך נראים סמן עכבר שזז, עמעום עם "חור" וטבעת זוהרת סביב החידוש
 * (‎d.spot‎), ותווית מה חדש. ‎d.focus‎ ו-‎d.hold‎ רושמים נקודות מפתח למצלמה —
 * ההתקרבות עצמה נעשית אחר כך, בעיבוד (‎camera.py‎): הגדלה בתוך הדף הייתה
 * מזיזה חלונות צפים ממקומם.
 *
 * הקלטה בהילוך איטי: צילום מסך ברזולוציה כפולה מגיע לכ-8 פריימים בשנייה.
 * כל ההדמיה מתבצעת לאט פי ‎SLOW‎ (המתנות, הקלדה ומעברי CSS), ובעיבוד
 * מאיצים בחזרה — ובסרטון יוצאים כ-20 פריימים בשנייה, חדים.
 */
const fs = require('node:fs');
const path = require('node:path');

const W = 1280;
const H = 800;
const SLOW = 2.5;

/** שכבת הבימוי בתוך הדף: SVG לעמעום ולטבעות, תווית, וסמן */
function stageScript(SLOW) {
  const css = document.createElement('style');
  css.textContent = `
    #dv-svg{position:fixed;inset:0;z-index:2147483600;pointer-events:none;opacity:0;transition:opacity ${0.5 * SLOW}s}
    #dv-tag{position:fixed;z-index:2147483601;transform:translate(-50%,8px);opacity:0;pointer-events:none;
      transition:opacity ${0.35 * SLOW}s,transform ${0.35 * SLOW}s,left ${0.6 * SLOW}s,top ${0.6 * SLOW}s;
      background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;font:800 15px system-ui,sans-serif;padding:8px 16px;
      border-radius:999px;white-space:nowrap;box-shadow:0 8px 22px rgba(15,118,110,.45);direction:rtl}
    #dv-tag.on{opacity:1;transform:translate(-50%,0)}
    #dv-cur{position:fixed;z-index:2147483602;width:22px;height:22px;left:${1280 / 2}px;top:${800 / 2}px;pointer-events:none;
      transition:left ${0.9 * SLOW}s cubic-bezier(.4,0,.2,1),top ${0.9 * SLOW}s cubic-bezier(.4,0,.2,1)}
    #dv-cur::after{content:'';position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;
      background:rgba(20,184,166,.45);transform:scale(0);opacity:0}
    #dv-cur.click::after{animation:dv-click ${0.45 * SLOW}s ease-out}
    @keyframes dv-click{from{transform:scale(.2);opacity:1}to{transform:scale(1.6);opacity:0}}
    * { caret-color: #0f766e; }`;
  document.head.appendChild(css);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'dv-svg';
  document.documentElement.appendChild(svg);
  const tag = document.createElement('div');
  tag.id = 'dv-tag';
  document.documentElement.appendChild(tag);
  const cur = document.createElement('div');
  cur.id = 'dv-cur';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#0f172a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cur);

  const rectOf = (sel) => {
    const n = [...document.querySelectorAll(sel)].find((x) => { const r = x.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    return n ? n.getBoundingClientRect() : null;
  };
  window.__dv = {
    spot(selectors, label) {
      const pad = 8;
      const Wd = innerWidth;
      const Hd = innerHeight;
      const rs = selectors.map(rectOf).filter(Boolean)
        .map((r) => ({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }));
      if (!rs.length) return null;
      svg.setAttribute('width', Wd);
      svg.setAttribute('height', Hd);
      svg.innerHTML = `<defs><filter id="dvg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <mask id="dvm"><rect width="${Wd}" height="${Hd}" fill="white"/>${rs.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="14" fill="black"/>`).join('')}</mask></defs>
        <rect width="${Wd}" height="${Hd}" fill="rgba(15,23,42,.55)" mask="url(#dvm)"/>
        ${rs.map((r) => `<rect x="${r.x - 3}" y="${r.y - 3}" width="${r.w + 6}" height="${r.h + 6}" rx="16" fill="none" stroke="#2dd4bf" stroke-width="3" filter="url(#dvg)"/>`).join('')}`;
      svg.style.opacity = '1';
      const box = { x: Math.min(...rs.map((r) => r.x)), y: Math.min(...rs.map((r) => r.y)), r: Math.max(...rs.map((r) => r.x + r.w)), b: Math.max(...rs.map((r) => r.y + r.h)) };
      if (label) {
        tag.textContent = label;
        // התווית מעל החידוש, ואם אין שם מקום — מתחתיו
        const above = box.y - 50 > 6;
        tag.style.left = `${Math.min(Math.max((box.x + box.r) / 2, 220), Wd - 220)}px`;
        tag.style.top = `${above ? box.y - 50 : box.b + 12}px`;
        tag.classList.add('on');
      } else tag.classList.remove('on');
      return { cx: (box.x + box.r) / 2, cy: (box.y + box.b) / 2, w: box.r - box.x, h: box.b - box.y };
    },
    off() { svg.style.opacity = '0'; tag.classList.remove('on'); },
    move(sel, fx = 0.5, fy = 0.5) {
      const r = rectOf(sel);
      if (!r) return null;
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      cur.style.left = `${x}px`;
      cur.style.top = `${y}px`;
      return { x, y };
    },
    moveTo(x, y) { cur.style.left = `${x}px`; cur.style.top = `${y}px`; },
    click() { cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); },
    box(selectors) {
      const rs = selectors.map(rectOf).filter(Boolean);
      if (!rs.length) return null;
      const b = { x: Math.min(...rs.map((r) => r.left)), y: Math.min(...rs.map((r) => r.top)), r: Math.max(...rs.map((r) => r.right)), b: Math.max(...rs.map((r) => r.bottom)) };
      return { cx: (b.x + b.r) / 2, cy: (b.y + b.b) / 2, w: b.r - b.x, h: b.b - b.y };
    }
  };
}

/**
 * מקליט סצנה אחת. ‎scene(d)‎ — הפונקציה שמביימת. מחזיר את מה שצריך לעיבוד:
 * הפריימים עם חותמות זמן, ונקודות המפתח של המצלמה — כבר "מואצים" בחזרה.
 */
async function record(browser, { base, login, framesDir, scene, setup }) {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('   ⚠ שגיאה בדף:', e.message));
  if (setup) await setup(page);

  await page.goto(base);
  await page.fill('input[type=email]', login.email);
  await page.fill('input[type=password]', login.password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(2000);
  // חלונות שנפתחים בכניסה (מה חדש, הזמנה להתראות) אינם חלק מההדמיה
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove()));
  await page.evaluate(stageScript, SLOW);

  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let recording = true;
  const loop = (async () => {
    while (recording) {
      const a = Date.now();
      try {
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality: 90, optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale: 2 }
        });
        const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ t: (a + Date.now()) / 2000, file });
      } catch { /* הדף התחלף באמצע צילום — ממשיכים */ }
    }
  })();

  // ----- ה-API של הבמאי
  const cam = [];
  let view = { cx: W / 2, cy: H / 2, z: 1 };
  const now = () => Date.now() / 1000;
  const key = () => cam.push({ t: now(), ...view });
  const wait = (ms) => page.waitForTimeout(ms * SLOW);

  const d = {
    page, W, H,
    wait,
    /** ניווט במערכת, כמו לחיצה בתפריט */
    async goto(route, params = {}) {
      await page.evaluate(([r, p]) => App.navigate(r, p), [route, params]);
      await wait(900);
    },
    async eval(fn, arg) { return page.evaluate(fn, arg); },
    /** הסמן זז אל אלמנט (בלי לחיצה). גם העכבר האמיתי — לריחוף */
    async point(sel, { fx = 0.5, fy = 0.5, hover = true } = {}) {
      const p = await page.evaluate(([s, x, y]) => __dv.move(s, x, y), [sel, fx, fy]);
      if (!p) throw new Error(`לא נמצא על המסך: ${sel}`);
      await wait(950);
      if (hover) await page.mouse.move(p.x, p.y);
      return p;
    },
    /** הסמן זז ולוחץ — לחיצה אמיתית על האלמנט */
    async click(sel, opts = {}) {
      const p = await d.point(sel, opts);
      await page.evaluate(() => __dv.click());
      await page.mouse.click(p.x, p.y);
      await wait(450);
    },
    async type(text, { delay = 110 } = {}) {
      await page.keyboard.type(text, { delay: delay * SLOW });
      await wait(300);
    },
    async press(k) { await page.keyboard.press(k); await wait(350); },
    /** עמעום וטבעת סביב האלמנטים, עם תווית. מחזיר את המרכז והגודל */
    async spot(selectors, label = '') {
      const box = await page.evaluate(([s, l]) => __dv.spot(s, l), [[].concat(selectors), label]);
      if (!box) throw new Error(`לא נמצא על המסך: ${[].concat(selectors).join(', ')}`);
      await wait(450);
      return box;
    },
    async off() { await page.evaluate(() => __dv.off()); await wait(400); },
    async box(selectors) { return page.evaluate((s) => __dv.box(s), [].concat(selectors)); },
    /**
     * המצלמה עוברת אל ‎target‎ (מרכז, או תיבה מ-‎spot‎/‎box‎) בהגדלה ‎z‎, במשך
     * ‎ms‎. ‎z‎ אוטומטי — כך שהתיבה תמלא כ-70% מהמסך, בין 1 ל-2.2.
     */
    async focus(target, { z = null, ms = 1100 } = {}) {
      const zoom = z ?? Math.max(1, Math.min(2.2, Math.min((W * 0.7) / Math.max(target.w ?? W, 1), (H * 0.7) / Math.max(target.h ?? H, 1))));
      key();
      view = { cx: target.cx, cy: target.cy, z: zoom };
      await wait(ms);
      key();
    },
    async wide({ ms = 1000 } = {}) { await d.focus({ cx: W / 2, cy: H / 2 }, { z: 1, ms }); },
    async hold(ms = 1200) { key(); await wait(ms); key(); }
  };

  const begin = now();
  key();
  await wait(500);
  try {
    await scene(d);
  } finally {
    key();
    await wait(600);
    key();
  }
  const end = now();
  recording = false;
  await loop;
  await ctx.close();

  // מאיצים בחזרה: כל הזמנים נדחסים פי ‎SLOW‎ סביב תחילת הסצנה
  const fast = (t) => begin + (t - begin) / SLOW;
  return {
    W, H, begin, end: fast(end),
    frames: frames.map((f) => ({ ...f, t: fast(f.t) })),
    cam: cam.map((k) => ({ ...k, t: fast(k.t) }))
  };
}

module.exports = { record, W, H, SLOW };
