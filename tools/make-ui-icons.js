'use strict';
/**
 * ממיר את האייקונים שסופקו (תיקיית ‎אייקונים/‎) לאייקוני ממשק שאפשר להשתמש בהם.
 *
 *   node tools/make-ui-icons.js
 *
 * למה נדרשת המרה ולא העתקה: הקבצים המקוריים הם 1254×1254 פיקסלים, כ-850KB
 * כל אחד, עם רקע לבן אטום. שלוש בעיות נובעות מכך, וכולן נפתרות כאן:
 *
 * 1. רקע לבן — האייקון היה מופיע כריבוע לבן על הסרגל העליון הירוק ובכל מצב
 *    ריחוף. כאן הרקע הלבן הופך לשקיפות: עוצמת הדיו נקראת מהבהירות והופכת
 *    לערך אלפא.
 * 2. משקל — שנים-עשר קבצים של 850KB לאייקונים שמוצגים בגודל 20 פיקסלים הם
 *    כעשרה מגה־בייט לטעינת עמוד. אחרי חיתוך והקטנה כל אייקון הוא כמה KB.
 * 3. צבע קבוע — האייקון צבוע ירוק, ולכן לא היה יכול להיות לבן על הסרגל
 *    הירוק או אדום כשהוא מסמן איחור. הפלט הוא מסכה: התמונה נושאת אלפא בלבד,
 *    והצבע נקבע ב-CSS דרך ‎currentColor‎. כך אותו קובץ משרת כל הקשר.
 *
 * הפלט: ‎public/icons/ui/<slug>.png‎ — אפור+אלפא, 96×96.
 * המקורות נשארים ב-‎אייקונים/‎, מחוץ ל-public, ולכן אינם מוגשים ואינם נטענים.
 */
const fs = require('node:fs');
const path = require('node:path');
const PNG = require('./png');

const SRC = path.join(__dirname, '..', 'אייקונים');
const OUT = path.join(__dirname, '..', 'public', 'icons', 'ui');

/**
 * שם הקובץ שסופק → המפתח שהקוד משתמש בו. המפתחות באנגלית כדי שייקראו בקוד,
 * והמפה כאן היא המקום היחיד שקושר בין השניים.
 */
const MAP = {
  'אייקון דף הבית': 'home',
  'אייקון לוח משימות': 'board',
  'אייקון המשימות שלי': 'my-tasks',
  'אייקון משימות ספקים': 'vendors',
  'אייקון ארכיון': 'archive',
  'אייקון דוחות': 'reports',
  'אייקון ניהול מערכת': 'admin',
  'אייקון התראה חדשה': 'bell',
  'אייקון נעץ': 'pin',
  'אייקון באיחור_1': 'overdue',
  'אייקון דחוף': 'urgent',
  'אייקון ממתין לאישור': 'waiting'
};

const SIZE = 96;      // גדול דיו למסך צפוף פי שלושה, וקטן דיו כדי לא להכביד
const MARGIN = 0.04;  // שוליים סביב הדיו, כדי שהקווים לא ייגעו בקצה

/**
 * עוצמת הדיו בכל פיקסל, כערך 0..1. הרקע הלבן הוא 0.
 * המקור עשוי להיות עם אלפא (הנעץ) או בלי (השאר) — ולכן קודם מרכיבים על לבן,
 * וכך שני המצבים מטופלים באותה נוסחה.
 */
function inkField({ width, height, rgba }) {
  const ink = new Float32Array(width * height);
  let darkest = 255;

  for (let p = 0; p < width * height; p++) {
    const a = rgba[p * 4 + 3] / 255;
    const r = rgba[p * 4] * a + 255 * (1 - a);
    const g = rgba[p * 4 + 1] * a + 255 * (1 - a);
    const b = rgba[p * 4 + 2] * a + 255 * (1 - a);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    ink[p] = lum;
    if (lum < darkest) darkest = lum;
  }

  /**
   * נירמול לפי הפיקסל הכהה ביותר בתמונה, ולא לפי שחור מוחלט: הדיו כאן הוא
   * ירוק כהה ולא שחור, ובלי הנירמול כל האייקונים היו יוצאים חיוורים בשליש.
   */
  const span = Math.max(1, 255 - darkest);
  for (let p = 0; p < ink.length; p++) {
    ink[p] = Math.min(1, Math.max(0, (255 - ink[p]) / span));
  }
  return ink;
}

/**
 * מסיר את הטבעת החיצונית, אם יש כזו.
 *
 * למה: רוב האייקונים שסופקו מצוירים בתוך עיגול. בגודל 22 פיקסלים העיגול
 * נראה מכובד, אבל בתגית בגודל 11 פיקסלים נותרים ממנו קו דק ובתוכו מקום
 * לשלושה פיקסלים — והסמל עצמו הופך לכתם. בלי הטבעת הסמל ממלא את כל השטח
 * וקריא גם קטן.
 *
 * הזיהוי אינו "העיגול הגדול ביותר": פעמון ונעץ צוירו בלי עיגול, וקו חיצוני
 * שלהם היה נמחק בטעות. לכן נדרשות שלוש תכונות יחד — הרכיב תופס כמעט את כל
 * התיבה, הוא דק ביחס לה, ומרחקי הפיקסלים שלו מהמרכז כמעט קבועים. התנאי
 * השלישי הוא שמבדיל טבעת מקו של פעמון.
 */
function stripOuterRing(ink, width, height) {
  /*
   * סף נמוך בכוונה. בסף גבוה נתפס רק ליבת הקו, ושפת ההחלקה שסביבו — ערכי
   * אלפא חלשים — נשארה במקומה; העיבוי שאחר כך הגביר אותה בחזרה לטבעת חיוורת
   * אך נראית. בסף הזה הרכיב כולל גם את השפה, ולכן הוא נמחק שלם.
   */
  const THRESHOLD = 0.04;
  const labels = new Int32Array(width * height).fill(-1);
  const comps = [];

  // סימון רכיבי קשירות (8 שכנים), בסריקה איטרטיבית ולא רקורסיבית
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] < THRESHOLD || labels[start] !== -1) continue;
    const id = comps.length;
    const pixels = [];
    let minX = width; let maxX = -1; let minY = height; let maxY = -1;
    const stack = [start];
    labels[start] = id;

    while (stack.length) {
      const at = stack.pop();
      const x = at % width;
      const y = (at - x) / width;
      pixels.push(at);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (labels[n] !== -1 || ink[n] < THRESHOLD) continue;
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    comps.push({ id, pixels, minX, maxX, minY, maxY });
  }

  if (comps.length < 2) return { ink, ringRemoved: false };

  // המועמד: הרכיב שתיבתו הגדולה ביותר
  const candidate = comps.reduce((a, b) =>
    ((b.maxX - b.minX) * (b.maxY - b.minY) > (a.maxX - a.minX) * (a.maxY - a.minY) ? b : a));

  const boxW = candidate.maxX - candidate.minX;
  const boxH = candidate.maxY - candidate.minY;
  const fills = boxW > width * 0.8 && boxH > height * 0.8;
  const thin = candidate.pixels.length < boxW * boxH * 0.2;
  const square = Math.abs(boxW - boxH) < Math.max(boxW, boxH) * 0.1;

  let circular = false;
  if (fills && thin && square) {
    const cx = (candidate.minX + candidate.maxX) / 2;
    const cy = (candidate.minY + candidate.maxY) / 2;
    let sum = 0;
    for (const at of candidate.pixels) {
      const x = at % width;
      sum += Math.hypot(x - cx, ((at - x) / width) - cy);
    }
    const mean = sum / candidate.pixels.length;
    let varSum = 0;
    for (const at of candidate.pixels) {
      const x = at % width;
      varSum += (Math.hypot(x - cx, ((at - x) / width) - cy) - mean) ** 2;
    }
    // מרחק כמעט קבוע מהמרכז = טבעת. קו של פעמון ייתן פיזור גדול בהרבה.
    circular = Math.sqrt(varSum / candidate.pixels.length) / (mean || 1) < 0.12;
  }

  if (!circular) return { ink, ringRemoved: false };

  /*
   * לא רק מחיקת הרכיב עצמו, אלא כל דיו שמחוץ לרדיוס הטבעת. מחיקת הרכיב לבדה
   * הותירה בשני אייקונים קשת חיוורת — שפת ההחלקה שנפלה מתחת לסף, או קטע
   * שנקשר לסמל דרך גשר חלש ולכן נחשב לחלק ממנו. חיתוך לפי רדיוס אינו תלוי
   * בספים ומנקה את השאריות בוודאות.
   */
  const cx = (candidate.minX + candidate.maxX) / 2;
  const cy = (candidate.minY + candidate.maxY) / 2;
  let radiusSum = 0;
  for (const at of candidate.pixels) {
    const x = at % width;
    radiusSum += Math.hypot(x - cx, ((at - x) / width) - cy);
  }
  const cutoff = (radiusSum / candidate.pixels.length) * 0.9;

  const out = Float32Array.from(ink);
  for (let at = 0; at < out.length; at++) {
    if (out[at] === 0) continue;
    const x = at % width;
    if (Math.hypot(x - cx, ((at - x) / width) - cy) > cutoff) out[at] = 0;
  }
  return { ink: out, ringRemoved: true };
}

/**
 * מעבה את הקווים. האיור שסופק מצויר בקו דק, ואחרי הקטנה לגודל של תגית הוא
 * נראה חיוור. הרחבה של הדיו בכמה פיקסלים במקור מתורגמת לקו מלא יותר בפלט,
 * בלי לשנות את צורת הסמל.
 *
 * מסננת מקסימום מופרדת — קודם אופקית ואז אנכית. כך העלות היא ‎O(n)‎ לכל ציר
 * ולא ריבוע הרדיוס, וזה מה שמאפשר להריץ אותה על תמונה של מיליון וחצי פיקסלים.
 */
function thicken(ink, width, height, radius) {
  if (radius < 1) return ink;
  const pass = (src, w, h, horizontal) => {
    const out = new Float32Array(src.length);
    for (let a = 0; a < (horizontal ? h : w); a++) {
      const len = horizontal ? w : h;
      for (let b = 0; b < len; b++) {
        let max = 0;
        for (let d = -radius; d <= radius; d++) {
          const c = b + d;
          if (c < 0 || c >= len) continue;
          const at = horizontal ? a * w + c : c * w + a;
          if (src[at] > max) max = src[at];
        }
        out[horizontal ? a * w + b : b * w + a] = max;
      }
    }
    return out;
  };
  return pass(pass(ink, width, height, true), width, height, false);
}

/** תיבת התוכן: הפיקסלים שיש בהם דיו, בתוספת שוליים, ומרובעת סביב מרכזה */
function contentBox(ink, width, height, threshold = 0.06) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ink[y * width + x] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('לא נמצא תוכן בתמונה');

  // ריבוע סביב מרכז התוכן — כדי שהיחס לא יעוות בהקטנה
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 * (1 + MARGIN * 2);
  return { x0: cx - half, y0: cy - half, side: half * 2 };
}

/**
 * הקטנה בממוצע על התיבה שממנה כל פיקסל יעד נדגם. זו הדרך הנכונה בהקטנה כה
 * גדולה (1254 → 96): דגימה נקודתית הייתה מפילה קווים דקים לגמרי.
 */
function downscale(ink, width, height, box, size) {
  const out = new Uint8Array(size * size * 2);   // אפור + אלפא
  const step = box.side / size;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const sx0 = box.x0 + tx * step;
      const sy0 = box.y0 + ty * step;
      let sum = 0;
      let n = 0;

      for (let y = Math.floor(sy0); y < Math.ceil(sy0 + step); y++) {
        if (y < 0 || y >= height) continue;
        for (let x = Math.floor(sx0); x < Math.ceil(sx0 + step); x++) {
          if (x < 0 || x >= width) continue;
          sum += ink[y * width + x];
          n++;
        }
      }

      const at = (ty * size + tx) * 2;
      out[at] = 255;                                        // הצבע יבוא מ-CSS
      out[at + 1] = Math.round((n ? sum / n : 0) * 255);     // האלפא היא הצורה
    }
  }

  /**
   * מיתוח האלפא כך שהפיקסל הכהה ביותר יגיע לאטימות מלאה. אחרי הקטנה של
   * פי שלושה־עשר קו בעובי פיקסל אחד מתפרש על יותר מפיקסל יעד, ולכן שיא
   * האטימות יורד לכ-89% — ובנעץ, שקווהו דק יותר, ל-78%. בגודל 20 פיקסלים
   * זה נראה חיוור, והפער בין האייקונים נראה כאי-אחידות בתפריט.
   */
  let peak = 0;
  for (let i = 1; i < out.length; i += 2) if (out[i] > peak) peak = out[i];
  if (peak > 0 && peak < 255) {
    const gain = 255 / peak;
    for (let i = 1; i < out.length; i += 2) out[i] = Math.min(255, Math.round(out[i] * gain));
  }

  return out;
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error(`לא נמצאה תיקיית המקור: ${SRC}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.png'));
const unmapped = [];
let done = 0;

for (const file of files) {
  const base = path.basename(file, path.extname(file));
  const slug = MAP[base];
  if (!slug) { unmapped.push(file); continue; }

  const src = PNG.decode(fs.readFileSync(path.join(SRC, file)));
  const raw = inkField(src);
  const { ink: unringed, ringRemoved } = stripOuterRing(raw, src.width, src.height);
  // עיבוי יחסי לרוחב המקור, כדי שכל האייקונים ייצאו באותו משקל קו
  const ink = thicken(unringed, src.width, src.height, Math.round(src.width * 0.005));
  const box = contentBox(ink, src.width, src.height);
  const scaled = downscale(ink, src.width, src.height, box, SIZE);
  const buf = PNG.encode(SIZE, SIZE, scaled, 4);

  fs.writeFileSync(path.join(OUT, `${slug}.png`), buf);
  const before = fs.statSync(path.join(SRC, file)).size;
  console.log(
    `  ${slug.padEnd(9)} ${String(src.width).padStart(4)}px → ${SIZE}px   ` +
    `${(before / 1024).toFixed(0).padStart(4)}KB → ${(buf.length / 1024).toFixed(1).padStart(5)}KB   ` +
    `${ringRemoved ? 'הטבעת הוסרה' : 'בלי טבעת'}   ${base}`
  );
  done++;
}

if (unmapped.length) {
  console.log(`\n  ⚠ קבצים שאין להם מפתח ב-MAP ולכן דולגו:`);
  for (const f of unmapped) console.log(`     ${f}`);
}

const missing = Object.entries(MAP).filter(([base]) => !files.includes(`${base}.png`));
if (missing.length) {
  console.log(`\n  ⚠ מפתחות שאין להם קובץ מקור:`);
  for (const [base, slug] of missing) console.log(`     ${slug} ← ${base}.png`);
}

console.log(`\n  ${done} אייקונים נוצרו ב-public/icons/ui.`);
