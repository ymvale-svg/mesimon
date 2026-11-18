'use strict';
/**
 * סוכנים — הסוכנים לפי מחלקה, מחשבונים, ידע ארגוני, תובנות, סיכומי יום.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../agents')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Agents() { return require('./agents'); },
  get AgentsHealth() { return require('./agents-health'); },
  get Calculators() { return require('./calculators'); },
  get OrgKnowledge() { return require('./org-knowledge'); },
  get Insights() { return require('./insights'); },
  get DayDigest() { return require('./day-digest'); }
};
