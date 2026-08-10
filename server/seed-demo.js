'use strict';
/**
 * יוצר נתוני הדגמה — משתמשים, ספקים, פרויקטים ומשימות לדוגמה.
 * מיועד להתנסות מקומית בלבד. אין להריץ על מערכת שיש בה נתונים אמיתיים.
 *
 *   node server/seed-demo.js
 */
const D = require('./db');

D.bootstrap();

const users = D.get('SELECT COUNT(*) AS c FROM users').c;
const tasks = D.get('SELECT COUNT(*) AS c FROM tasks').c;

// חשבון המנהל היחיד שנוצר אוטומטית אינו נחשב "נתונים אמיתיים"
if (tasks > 0 || users > 1) {
  console.log('');
  console.log('  ⚠  המערכת אינה ריקה — יש בה כבר משתמשים או משימות.');
  console.log('     יצירת נתוני הדגמה תיצור כפילויות ובלבול.');
  console.log('     לאתחול מלא: node server/reset.js');
  console.log('');
  process.exit(1);
}

D.seedDemoData();
console.log('[משימון] נוצרו נתוני הדגמה. הסיסמה לכל המשתמשים: 1234');
