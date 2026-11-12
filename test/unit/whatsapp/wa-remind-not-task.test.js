'use strict';
/**
 * סקירה לילית 12.11: עובד ביקש בהקלטה "תזכור לי מחר ב-7:50 להתקשר ל…" (התמלול: "…תזכור את מחר…") — נפתחה טיוטת משימה.
 * הוא ענה "אני לא רוצה משימה, אני רוצה שתזכיר לי מחר ב-7:50" — והבוט ענה "לתזכורת כתוב: …" במקום לרשום.
 * עכשיו: "תזכור" הוא גם בקשת תזכורת, ו"אני רוצה שתזכיר לי" כשטיוטת משימה מחכה — הטיוטה הופכת לתזכורת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Bot = require('../../../server/whatsapp/wa-bot');
const Reminders = require('../../../server/whatsapp/reminders');
const Fakes = require('../../fakes');

boot();
D.setSetting('bot_pilot', false);
D.setSetting('wa_actions', {});

test('"תזכור את מחר…" (כך התמלול שומע "תזכיר") — בקשת תזכורת', () => {
  assert.ok(Reminders.isRequest('תזכור לי מחר ב-8 להתקשר לאבי'));
  assert.ok(Reminders.isRequest('אני לא רוצה לעשות משימה, אני רוצה שאתה תזכיר לי מחר בעשרה לשמונה בבוקר.'));
  assert.ok(!Reminders.isRequest('תזכורת לפגישה עם הספק נשלחה?'.replace('תזכורת', 'הודעה')));
  assert.ok(!Reminders.isRequest('אני זוכר שדיברנו על זה'));
});

test('"אני רוצה שתזכיר לי" כשטיוטת משימה מחכה — נרשמת תזכורת על הטיוטה, והמשימה לא נפתחת', async (t) => {
  let asked = '';
  Fakes.claude(t, (opts) => { asked = opts.system + opts.content[0].text; return { text: '', date: '2026-11-13', time: '07:50' }; });
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const state = { ...Bot._internal.chatOf(u.id), draft: { kind: 'task', title: 'להתקשר לספק על השלט' }, awaiting: true };
  const r = await Bot._internal.converse(u, actor, 'אני לא רוצה לעשות משימה, אני רוצה שאתה תזכיר לי מחר בעשרה לשמונה בבוקר.', state);
  assert.match(r.reply, /⏰ אזכיר לך/);
  assert.match(r.reply, /להתקשר לספק על השלט/);
  assert.match(asked, /להתקשר לספק על השלט/, 'ה-AI יודע על מה התזכורת');
  assert.equal(r.next.draft, null);
  assert.equal(r.action, 'reminders');
  const rem = D.get('SELECT * FROM reminders WHERE user_id = ?', u.id);
  assert.equal(rem.text, 'להתקשר לספק על השלט');
});
