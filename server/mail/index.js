'use strict';
/**
 * מייל — סריקה למשימות, זיכרון המייל, תובנות, שאלות, מסמכים מצורפים, טפסים.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../mail')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get MailScan() { return require('./mail-scan'); },
  get MailMemory() { return require('./mail-memory'); },
  get MailInsights() { return require('./mail-insights'); },
  get MailAsk() { return require('./mail-ask'); },
  get MailActions() { return require('./mail-actions'); },
  get MailDocQueue() { return require('./mail-doc-queue'); },
  get TaskMail() { return require('./task-mail'); },
  get SentFollowup() { return require('./sent-followup'); },
  get ReplyMemory() { return require('./reply-memory'); },
  get InsightWindow() { return require('./insight-window'); },
  get FormFill() { return require('./form-fill'); }
};
