'use strict';
/**
 * 📋 תדריך לפני פגישה — מה נאסף (16.11.26: תדריך שהלך שנה אחורה והביא מיילים לא קשורים לנושא).
 * מייל עם משתתף — רק מהשבועות האחרונים, או כשהוא נוגע לנושא הפגישה; פגישה קודמת — רק מהחודשים האחרונים;
 * משתתף שאין עליו מידע — לא נכנס.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { user, D } = require('../../helpers/db');
const Briefing = require('../../../server/meetings/briefing');

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const mail = (userId, email, summary, days, keywords = '') => D.run(
  'INSERT INTO mail_memory (user_id, thread_id, contact_email, summary, keywords, outcome, happened_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
  userId, `th-${Math.random()}`, email, summary, keywords, 'info', ago(days), ago(days));

test('מילות הנושא — בלי מילים כלליות ובלי שם הארגון', () => {
  D.setSetting('org_name', 'אשל');
  const w = Briefing._internal.topicWords("הצגת מערכת בקרה תקציבית 'אשל-project'");
  assert.ok(w.includes('בקרה') && w.includes('תקציבית'));
  for (const x of ['הצגת', 'מערכת', 'project']) assert.ok(!w.includes(x), x);
});

test('מייל ישן ולא קשור לנושא — לא נכנס; קשור לנושא או מהשבועות האחרונים — כן', () => {
  const me = user({ email: `me-${Date.now()}@eshel.test` });
  const lev = `lev-${Date.now()}@eshel.test`;
  const benny = `benny-${Date.now()}@eshel.test`;
  mail(me.id, lev, 'אפיון גרסה 0.5 לאלכס', 300);                    // ישן ולא קשור
  mail(me.id, lev, 'הוזמנו חומרים לאתר חיפה', 60);                   // לא קשור, לא מהשבועות האחרונים
  mail(me.id, lev, 'טבלת בקרה תקציבית לפרויקט רזבר', 70);            // קשור לנושא
  mail(me.id, lev, 'אישור חשבונית ספק', 5);                           // מהימים האחרונים
  mail(me.id, lev, 'בקרה תקציבית של 2025', 330);                     // קשור אבל ישן מדי
  const ev = { title: "הצגת מערכת בקרה תקציבית 'אשל-project'", start: ago(-0.01), people: [{ email: lev, name: 'לב' }, { email: benny }] };
  const { text } = Briefing._internal.collect(me.id, ev);
  assert.match(text, /טבלת בקרה תקציבית/);
  assert.match(text, /אישור חשבונית ספק/);
  assert.doesNotMatch(text, /אפיון גרסה/);
  assert.doesNotMatch(text, /חיפה/);
  assert.doesNotMatch(text, /2025/);
  assert.doesNotMatch(text, /benny/, 'משתתף בלי מידע — לא נכנס');
});

test('פגישה קודמת מלפני חצי שנה — לא נכנסת לתדריך', () => {
  const me = user({ email: `me2-${Date.now()}@eshel.test` });
  const x = `x-${Date.now()}@eshel.test`;
  const ref = `r-${Date.now()}`;
  D.run('INSERT INTO meeting_followups (source, ref, user_id, title, start_at, end_at, data, sent_at) VALUES (?,?,?,?,?,?,?,?)',
    'test', ref, me.id, 'ישיבה ישנה', ago(200), ago(200), JSON.stringify({ participants: [x] }), ago(200));
  D.run('INSERT OR REPLACE INTO meeting_digests (source, ref, data, created_at) VALUES (?,?,?,?)', 'test', ref, JSON.stringify({ summary: ['סוכם משהו ישן'] }), ago(200));
  const { text } = Briefing._internal.collect(me.id, { title: 'פגישת המשך', start: ago(-0.01), people: [{ email: x }] });
  assert.doesNotMatch(text, /סוכם משהו ישן/);
});
