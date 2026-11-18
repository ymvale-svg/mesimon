'use strict';
/**
 * אלפון — אנשי קשר של הארגון ושל Google.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../phonebook')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Phonebook() { return require('./phonebook'); },
  get GoogleContacts() { return require('./google-contacts'); }
};
