'use strict';
/**
 * מפיק את סרטוני ההדמיה של גרסת "מה חדש" — אוטומטית, בלי צילום ידני.
 *
 *   node tools/whats-new-video/make.js 2026-11            כל הפריטים
 *   node tools/whats-new-video/make.js 2026-11 dark-mode  פריט אחד
 *
 * מה קורה:
 *   1. מסד נתונים חדש עם נתוני דמו (‎server/seed-demo.js‎), ועוד הנתונים
 *      שהסצנות של הגרסה צריכות (‎prepare‎ בקובץ הסצנות) — לא נתונים אמיתיים.
 *   2. שרת משימון נפרד עולה על המסד הזה.
 *   3. כל סצנה מוקלטת בדפדפן נקי (‎director.js‎), המצלמה מתקרבת ומתרחקת
 *      (‎camera.py‎), והתוצאה מקודדת ל-MP4 ולתמונת פתיחה.
 *   4. הקבצים נכתבים ל-‎public/whats-new/<גרסה>/‎, והנתיבים נרשמים בקובץ
 *      הגרסה ‎server/whats-new/<גרסה>.json‎.
 *
 * צריך במחשב: Playwright עם Chromium, ‎ffmpeg‎, ו-Python 3 עם Pillow.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FPS = 25;
const LOGIN = { email: 'admin@eshel.co.il', password: '1234' };

const [release, ...only] = process.argv.slice(2);
if (!release) {
  console.error('שימוש: node tools/whats-new-video/make.js <גרסה> [פריט…]');
  process.exit(1);
}
const RELEASE_FILE = path.join(ROOT, 'server', 'whats-new', `${release}.json`);
const SCENES = require(path.join(__dirname, `${release}.js`));
const OUT_DIR = path.join(ROOT, 'public', 'whats-new', release);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimon-video-'));
const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), UPLOADS_DIR: path.join(tmp, 'uploads') };
delete env.ANTHROPIC_API_KEY; // הסצנות מביימות את תשובות ה-AI בעצמן — בלי פניות אמיתיות
fs.mkdirSync(env.DATA_DIR, { recursive: true });

/** נתוני הדמו: הבסיס, ואחריו מה שהגרסה צריכה — בתהליך נפרד, על אותו מסד */
function seed() {
  execFileSync(process.execPath, [path.join(ROOT, 'server', 'seed-demo.js')], { env, stdio: 'ignore' });
  if (SCENES.prepare) {
    execFileSync(process.execPath, ['-e', `
      const D = require(${JSON.stringify(path.join(ROOT, 'server', 'db'))});
      D.bootstrap();
      require(${JSON.stringify(path.join(__dirname, `${release}.js`))}).prepare(D);
    `], { env, stdio: 'inherit' });
  }
}

async function startServer() {
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/branding`)).ok) return { child, base }; } catch { /* עוד עולה */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('השרת לא עלה');
}

function encode(recFile, workDir, outBase, posterAt) {
  const cut = path.join(workDir, 'cut');
  const n = Number(execFileSync('python3', ['-I', path.join(__dirname, 'camera.py'), recFile, cut, String(FPS)]).toString().trim());
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(cut, '%05d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${outBase}.mp4`]);
  // תמונת הפתיחה — רגע מתוך הסצנה שבו החידוש כבר מודגש
  const frame = Math.min(n - 1, Math.max(0, Math.round(n * posterAt)));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(cut, `${String(frame).padStart(5, '0')}.png`),
    '-q:v', '4', `${outBase}.jpg`]);
  return n / FPS;
}

(async () => {
  const { chromium } = require('playwright');
  const rel = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'));
  const items = rel.items.filter((i) => !only.length || only.includes(i.id));
  if (!items.length) throw new Error('לא נמצאו פריטים להפקה');

  console.log(`מכין נתוני דמו…`);
  seed();
  const { child, base } = await startServer();
  const browser = await chromium.launch();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const failed = [];
  try {
    for (const item of items) {
      const scene = SCENES.scenes[item.id];
      if (!scene) throw new Error(`אין סצנה לפריט "${item.id}"`);
      process.stdout.write(`🎬 ${item.id} — ${item.title} … `);
      const work = path.join(tmp, item.id);
      let rec;
      try {
        rec = await require('./director').record(browser, {
          base, login: SCENES.login ?? LOGIN, framesDir: path.join(work, 'frames'),
          scene: scene.run ?? scene, setup: scene.setup
        });
      } catch (err) {
        // סצנה שנכשלה אינה עוצרת את השאר — מדווחים וממשיכים
        failed.push(item.id);
        console.log(`נכשל: ${err.message}`);
        continue;
      }
      const recFile = path.join(work, 'recording.json');
      fs.writeFileSync(recFile, JSON.stringify(rec));
      const secs = encode(recFile, work, path.join(OUT_DIR, item.id), scene.posterAt ?? 0.55);
      const size = fs.statSync(path.join(OUT_DIR, `${item.id}.mp4`)).size;
      item.video = `/whats-new/${release}/${item.id}.mp4`;
      item.poster = `/whats-new/${release}/${item.id}.jpg`;
      console.log(`${secs.toFixed(1)} שניות, ${(size / 1048576).toFixed(1)}MB`);
    }
  } finally {
    await browser.close();
    child.kill();
  }
  fs.writeFileSync(RELEASE_FILE, `${JSON.stringify(rel, null, 2)}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ הסרטונים ב-public/whats-new/${release}/, והנתיבים נרשמו ב-server/whats-new/${release}.json`);
  if (failed.length) {
    console.error(`✕ נכשלו: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('ההפקה נכשלה:', err.message);
  process.exit(1);
});
