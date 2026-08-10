'use strict';
/** מוחק את מסד הנתונים והקבצים שהועלו, ובונה מחדש נתוני דמו. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dataDir = path.join(ROOT, 'data');
const uploadsDir = path.join(ROOT, 'uploads');

for (const file of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
  fs.rmSync(path.join(dataDir, file), { force: true });
}
for (const file of fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []) {
  fs.rmSync(path.join(uploadsDir, file), { force: true });
}

require('./db').bootstrap();
console.log('[משימון] המערכת אופסה ונוצרו נתוני דמו חדשים.');
