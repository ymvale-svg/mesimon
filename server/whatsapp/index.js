'use strict';
/**
 * בוט הוואטסאפ — שיחה, תפריט, כפתורים, סריקת שיחות, תזכורות, מכתבים.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../whatsapp')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get WaBot() { return require('./wa-bot'); },
  get WaUi() { return require('./wa-ui'); },
  get WaActions() { return require('./wa-actions'); },
  get WaBusiness() { return require('./wa-business'); },
  get WhatsappScan() { return require('./whatsapp-scan'); },
  get VoiceRouter() { return require('./voice-router'); },
  get BotReview() { return require('./bot-review'); },
  get Reminders() { return require('./reminders'); },
  get Notice() { return require('./notice'); },
  get NoticeDesign() { return require('./notice-design'); },
  get Solve() { return require('./solve'); },
  get AiOutage() { return require('./ai-outage'); }
};
