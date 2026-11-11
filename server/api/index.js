'use strict';
/**
 * נקודות הקצה של ה-HTTP — מחברות את התחומים לאתר.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../api')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Api() { return require('./api'); },
  get ApiAi() { return require('./api-ai'); },
  get ApiMeetings() { return require('./api-meetings'); },
  get ApiPhonebook() { return require('./api-phonebook'); },
  get ApiPriority() { return require('./api-priority'); },
  get ApiToday() { return require('./api-today'); },
  get ApiWhatsNew() { return require('./api-whats-new'); }
};
