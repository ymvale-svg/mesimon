'use strict';
/**
 * בונה את ‎changelog.json‎ מהיסטוריית git — ‎npm run changelog‎.
 *
 * הקובץ נועד לשרתים שאין בהם ‎.git‎ (פריסה בענן): סריקת ה-AI של "מה חדש"
 * קוראת ממנו מה השתנה מאז ההודעה האחרונה. מריצים אותו בכל עדכון גרסה,
 * ומעלים אותו יחד עם הקוד.
 *
 * רק קומיטים שאינם מיזוג: תאריך, כותרת ופירוט. מהחדש לישן.
 */
const fs = require('node:fs');
const Changelog = require('../server/changelog');

(async () => {
  if (!Changelog.hasGit()) {
    console.error('אין כאן מאגר git — אין ממה לבנות את היסטוריית השינויים.');
    process.exit(1);
  }
  // 1000 — הרבה מעבר לטווח שבין שתי הודעות "מה חדש", בלי לנפח את הקובץ
  /*
   * איחוד עם הקובץ הקיים, לא דריסה: בשכפול שטוח (כמו בבנייה בענן) git רואה
   * רק את הקומיט האחרון, ודריסה הייתה מוחקת את כל ההיסטוריה שכבר בקובץ.
   */
  const commits = Changelog.union(await Changelog.fromGit({ limit: 1000 }), Changelog.readFile()).slice(0, 1500);
  const out = {
    generatedAt: new Date().toISOString(),
    commits: commits.map(({ hash, date, subject, body }) => ({ hash, date, subject, body }))
  };
  fs.writeFileSync(Changelog.FILE, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`changelog.json נכתב: ${commits.length} שינויים.`);
})().catch((err) => {
  console.error('בניית changelog.json נכשלה:', err.message);
  process.exit(1);
});
