'use strict';
/**
 * היסטוריית השינויים של המערכת — המקור של סריקת ה-AI ב"מה חדש".
 *
 * שני מקורות, לפי מה שזמין:
 *   1. ‎git log‎ — כשהשרת רץ מתוך מאגר (מחשב פיתוח, או שרת שמושך מ-git).
 *   2. ‎changelog.json‎ בשורש — כשאין ‎.git‎ בשרת (פריסה בענן מעתיקה רק את
 *      הקבצים). הקובץ נבנה מאותה היסטוריה ב-‎npm run changelog‎ ונשמר במאגר,
 *      כך שהוא מגיע לשרת יחד עם הקוד שהוא מתאר.
 *
 * ‎git‎ רץ דרך ‎execFile‎ ולא דרך מעטפת: התאריך מועבר כארגומנט נפרד, ואין
 * מחרוזת שמעטפת תפרש. רק קומיטים שאינם מיזוג — המיזוג חוזר על הכותרות של
 * מה שכבר נכלל בו, ובמאגר הזה הוא בעיקר "Merge pull request #N".
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'changelog.json');

// הפרדה בתווי בקרה שלא יופיעו בהודעת קומיט: שדה (US) ורשומה (RS)
const FORMAT = '%H%x1f%cI%x1f%s%x1f%b%x1e';
const BODY_MAX = 1200;

const hasGit = () => fs.existsSync(path.join(ROOT, '.git'));

function parse(stdout) {
  return stdout.split('\x1e').map((rec) => rec.replace(/^\s+/, '')).filter(Boolean).map((rec) => {
    const [hash, date, subject, body] = rec.split('\x1f');
    return {
      hash: String(hash ?? '').slice(0, 12),
      date: String(date ?? '').trim(),
      subject: String(subject ?? '').trim(),
      // שורות הייחוס בסוף ההודעה אינן תוכן
      body: String(body ?? '')
        .split('\n').filter((l) => !/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l.trim()))
        .join('\n').trim().slice(0, BODY_MAX)
    };
  }).filter((c) => c.subject);
}

/**
 * הקומיטים מ-git, מהחדש לישן.
 * @param {{since?: string, limit?: number}} opts ‎since‎ — תאריך ISO
 */
function fromGit({ since = '', limit = 400 } = {}) {
  const args = ['log', '--no-merges', `--format=${FORMAT}`, '-n', String(limit)];
  if (since) args.push(`--since=${since}`);
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parse(stdout));
    });
  });
}

function fromFile({ since = '', limit = 400 } = {}) {
  const from = since ? new Date(since).getTime() : 0;
  return readFile()
    .filter((c) => c && c.subject && (!from || new Date(c.date).getTime() > from))
    .slice(0, limit);
}

function readFile() {
  let data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  return Array.isArray(data) ? data : Array.isArray(data?.commits) ? data.commits : [];
}

/**
 * מזהה לאיחוד בין שני המקורות — תאריך (מנורמל ל-UTC) וכותרת. לא ה-hash:
 * ברשומות ישנות בקובץ אין hash, ואותו קומיט היה נספר פעמיים.
 */
const keyOf = (c) => {
  const t = new Date(c.date);
  return `${Number.isNaN(t.getTime()) ? String(c.date) : t.toISOString().slice(0, 19)}|${String(c.subject).trim()}`;
};

/** איחוד רשימות קומיטים בלי כפילויות, מהחדש לישן */
function union(...lists) {
  const seen = new Map();
  for (const c of lists.flat()) if (c?.subject && !seen.has(keyOf(c))) seen.set(keyOf(c), c);
  return [...seen.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * מה השתנה מאז תאריך מסוים — משני המקורות יחד.
 *
 * לא "git, ואם אין — הקובץ": פריסה בענן משכפלת את המאגר שטוח (‎--depth 1‎),
 * ואז ‎git log‎ "מצליח" ומחזיר קומיט אחד בלבד — האחרון. כך בדיוק הסריקה
 * פספסה את כל החידושים של היום. האיחוד עם ‎changelog.json‎ (שנבנה מהיסטוריה
 * מלאה) משלים את מה שחסר, וה-git מוסיף את מה שנכנס אחרי שהקובץ נבנה.
 *
 * @returns {Promise<{source: string, commits: object[], latest: string|null, oldest: string|null}>}
 */
async function since(sinceIso, { limit = 400 } = {}) {
  let git = [];
  let gitOk = false;
  if (hasGit()) {
    try {
      git = await fromGit({ since: sinceIso, limit });
      gitOk = true;
    } catch (err) {
      // ‎git‎ לא מותקן בשרת, או שהמאגר שבור — הקובץ עדיין מתאר את הגרסה
      console.warn('[משימון] קריאת git נכשלה, נשענים על changelog.json:', err.message);
    }
  }
  const file = fromFile({ since: sinceIso, limit });
  const commits = union(git, file).slice(0, limit);
  const source = gitOk && file.length ? 'git+file' : gitOk ? 'git' : fs.existsSync(FILE) ? 'file' : 'none';
  return { source, commits, latest: commits[0]?.date ?? null, oldest: commits[commits.length - 1]?.date ?? null };
}

module.exports = { since, fromGit, fromFile, readFile, union, hasGit, FILE };
