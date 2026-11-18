'use strict';
/**
 * החיבורים לשירותים חיצוניים — Claude, פריוריטי, וואטסאפ, Gmail, Google, Zoom, Timeless, SMTP, Push. רק כאן פונים לרשת.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../integrations')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Claude() { return require('./claude'); },
  get Priority() { return require('./priority'); },
  get Whatsapp() { return require('./whatsapp'); },
  get Gmail() { return require('./gmail'); },
  get GoogleAuth() { return require('./google-auth'); },
  get Push() { return require('./push'); },
  get Speech() { return require('./speech'); },
  get Zoom() { return require('./zoom'); },
  get Timeless() { return require('./timeless'); },
  get Tiful360() { return require('./tiful360'); },
  get Mailer() { return require('./mailer'); },
  get McpClient() { return require('./mcp-client'); }
};
