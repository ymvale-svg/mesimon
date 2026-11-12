'use strict';
/**
 * סקירה לילית 12.11: עובד ביקש בהקלטה "תזכור לי מחר ב-7:50 להתקשר ל…" (התמלול: "…תזכור את מחר…") — נפתחה טיוטת משימה.
 * הוא ענה "אני לא רוצה משימה, אני רוצה שתזכיר לי מחר ב-7:50" — והבוט ענה "לתזכורת כתוב: …" במקום לרשום.
 * עכשיו (הוחלט 12.11.26): מי שאומר "תזכיר לי" — מקבל תזכורת, בכל מקום בהודעה וגם כשמשהו אחר מחכה.
 * כשטיוטת משימה מחכה — היא הופכת לתזכורת.
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

test('"תזכיר לי" בכל מקום בהודעה — תזכורת; שאלה, "תזכיר לו" ו"תזכור את זה" — לא', () => {
  for (const t of ['תזכיר לי מחר ב-8 ללכת לדואר', 'בשעה 5 תזכיר לי ללכת לדואר', 'תזכור לי לקנות חלב', 'תזכורת מחר לשלם חשמל',
    'טלית תזכור את מחר בבוקר בשעה עשרה לשמונה להתקשר לשזר', 'שלח לי תזכורת בעוד שעה',
    'אני לא רוצה לעשות משימה, אני רוצה שאתה תזכיר לי מחר בעשרה לשמונה בבוקר.']) assert.ok(Reminders.isRequest(t), t);
  for (const t of ['תזכיר לי מה סיכמנו', 'תזכיר לי מה סיכמנו עם העירייה?', 'תזכור את זה', 'תזכיר לו אם לא עונה', 'אני זוכר שדיברנו', 'התזכורות שלי'])
    assert.ok(!Reminders.isRequest(t), t);
});

test('"תזכיר לי בחמש ללכת לדואר" (גם אחרי מילה שהתמלול הוסיף) — תזכורת, לא משימה', async (t) => {
  Fakes.claude(t, () => ({ text: 'ללכת לדואר', date: '2026-11-13', time: '17:00' }));
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const r = await Bot._internal.converse(u, actor, 'טוב אז תזכיר לי מחר בחמש ללכת לדואר', Bot._internal.chatOf(u.id));
  assert.equal(r.action, 'reminders');
  assert.match(r.reply, /⏰ אזכיר לך/);
  assert.equal(D.get('SELECT text FROM reminders WHERE user_id = ?', u.id).text, 'ללכת לדואר');
});

test('"תזכיר לי" כשטיוטת מייל מחכה — נרשמת תזכורת, והטיוטה ממשיכה לחכות', async (t) => {
  Fakes.claude(t, () => ({ text: 'לבדוק אם רחל ענתה', date: '2026-11-13', time: '09:00' }));
  const u = user({ role: 'employee' });
  const actor = Auth.loadActor('user', u.id);
  const email = { kind: 'email', contact: { name: 'רחל', email: 'r@example.test' }, draft: { subject: 'ש', body: 'ב' } };
  const r = await Bot._internal.converse(u, actor, 'תזכיר לי מחר ב-9 לבדוק אם רחל ענתה', { ...Bot._internal.chatOf(u.id), draft: email, awaiting: true });
  assert.equal(r.action, 'reminders');
  assert.equal(r.next.draft?.kind, 'email');
  assert.equal(r.next.awaiting, true);
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
