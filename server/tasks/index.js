'use strict';
/**
 * משימות — משימות AI, כללים אוטומטיים, סגירה, כפילויות, סנכרון, הקלטה למשימה.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../tasks')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get AiTasks() { return require('./ai-tasks'); },
  get RulesEngine() { return require('./rules-engine'); },
  get TaskClosure() { return require('./task-closure'); },
  get TaskDupes() { return require('./task-dupes'); },
  get TaskMatch() { return require('./task-match'); },
  get TaskOutreach() { return require('./task-outreach'); },
  get TaskSync() { return require('./task-sync'); },
  get Voice() { return require('./voice'); },
  get VoiceDialog() { return require('./voice-dialog'); },
  get ProjectHints() { return require('./project-hints'); }
};
