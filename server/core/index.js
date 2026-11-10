'use strict';
/**
 * הליבה — מסד הנתונים, הרשאות, התחברות, תאריכים, HTTP, מסמכים. לא מייבאת אף תחום.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../core')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Db() { return require('./db'); },
  get Ports() { return require('./ports'); },
  get Paths() { return require('./paths'); },
  get Auth() { return require('./auth'); },
  get Permissions() { return require('./permissions'); },
  get Workdays() { return require('./workdays'); },
  get HttpKit() { return require('./http-kit'); },
  get Secrets() { return require('./secrets'); },
  get Mime() { return require('./mime'); },
  get DocText() { return require('./doc-text'); },
  get DocWorker() { return require('./doc-worker'); },
  get Pdf() { return require('./pdf'); },
  get PdfKit() { return require('./pdf-kit'); },
  get Spreadsheet() { return require('./spreadsheet'); },
  get XlsxWrite() { return require('./xlsx-write'); },
  get LoadMonitor() { return require('./load-monitor'); },
  get Invites() { return require('./invites'); },
  get Secretariat() { return require('./secretariat'); },
  get Classification() { return require('./classification'); },
  get MailTemplates() { return require('./mail-templates'); }
};
