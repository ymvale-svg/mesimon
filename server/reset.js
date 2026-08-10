'use strict';
/**
 * מוחק את מסד הנתונים ואת הקבצים שהועלו, ובונה מערכת ריקה מחדש.
 *
 *   node server/reset.js          — מערכת ריקה עם חשבון מנהל אחד
 *   node server/reset.js --demo   — כולל נתוני הדגמה
 */
const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(__dirname, '..', 'uploads');

for (const dir of [dataDir, uploadsDir]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file), { force: true, recursive: true });
}

const demo = process.argv.includes('--demo');
const D = require('./db');
D.bootstrap({ demo });

if (demo) {
  console.log('[משימון] המערכת אופסה ונוצרו נתוני הדגמה. הסיסמה לכל המשתמשים: 1234');
} else {
  console.log('[משימון] המערכת אופסה. נוצרה מערכת ריקה עם חשבון מנהל אחד.');
}
