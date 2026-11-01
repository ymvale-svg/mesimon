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
  let data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray(data?.commits) ? data.commits : [];
  const from = since ? new Date(since).getTime() : 0;
  return list
    .filter((c) => c && c.subject && (!from || new Date(c.date).getTime() > from))
    .slice(0, limit);
}

/**
 * מה השתנה מאז תאריך מסוים — מ-git אם אפשר, אחרת מהקובץ.
 * @returns {Promise<{source: 'git'|'file'|'none', commits: object[]}>}
 */
async function since(sinceIso, { limit = 400 } = {}) {
  if (hasGit()) {
    try {
      return { source: 'git', commits: await fromGit({ since: sinceIso, limit }) };
    } catch (err) {
      // ‎git‎ לא מותקן בשרת, או שהמאגר שבור — הקובץ עדיין מתאר את הגרסה
      console.warn('[משימון] קריאת git נכשלה, עוברים ל-changelog.json:', err.message);
    }
  }
  const commits = fromFile({ since: sinceIso, limit });
  return { source: fs.existsSync(FILE) ? 'file' : 'none', commits };
}

module.exports = { since, fromGit, fromFile, hasGit, FILE };
