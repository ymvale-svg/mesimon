'use strict';
/**
 * הרצה מקומית על נתוני בדיקה, לא על מסד הנתונים האמיתי.
 *
 * הבדיקות פותחות משתמשים, מוחקות משימות ומאפסות הגדרות — כל אלה על
 * ‎data/mesimon.db‎ היו הרס של נתוני עבודה. הקובץ מפנה את ‎DATA_DIR‎ לתיקיית
 * בדיקות לפני שהשרת נטען, ולכן אין צורך לזכור להגדיר משתנה סביבה בכל הרצה.
 *
 * לשימוש בפיתוח בלבד. בהרצה אמיתית ‎npm start‎.
 */

const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR
  || path.join(__dirname, '..', 'data', 'dev');

console.log(`[משימון] שרת פיתוח — נתונים ב-${process.env.DATA_DIR}`);
require('../server/index.js');
