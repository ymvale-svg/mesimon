'use strict';
/**
 * פגישות — יומן, תיאום, סיכום אחרי פגישה, הקלטות, תדריך.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../meetings')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get Meetings() { return require('./meetings'); },
  get MeetingCoord() { return require('./meeting-coord'); },
  get MeetingFollowup() { return require('./meeting-followup'); },
  get MeetingAudio() { return require('./meeting-audio'); },
  get Calendar() { return require('./calendar'); },
  get TimelessMedia() { return require('./timeless-media'); },
  get Briefing() { return require('./briefing'); }
};
