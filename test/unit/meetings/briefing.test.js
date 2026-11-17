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

test('שם ותואר — מהמשתמש במשימון (שם ומחלקה), לא מה ש-Claude ממציא', async (t) => {
  const Fakes = require('../../fakes');
  const me = user({ email: `me3-${Date.now()}@eshel.test` });
  const depName = `כספים-${Date.now()}`;
  const amit = user({ full_name: 'עמית לנג', email: `amit-${Date.now()}@eshel.test` });
  const dep = D.run("INSERT INTO departments (name, manager_user_id, created_at) VALUES (?,?,?)", depName, amit.id, ago(1)).lastInsertRowid;
  D.run('UPDATE users SET department_id = ? WHERE id = ?', dep, amit.id);
  D.run('INSERT INTO mail_people (user_id, email, name, company, role, updated_at) VALUES (?,?,?,?,?,?)', me.id, amit.email.toLowerCase(), 'לנג עמית', 'אשל', 'רו"ח, חשב החברה', ago(1));
  mail(me.id, amit.email.toLowerCase(), 'שלח טבלת בקרה תקציבית', 3);
  const fake = Fakes.claude(t, () => ({
    who: [{ email: amit.email.toLowerCase(), about: 'שלח את טבלת הבקרה' }],
    background: [], open_items: [], last_agreed: [], talking_points: []
  }));
  const text = await Briefing.build(me.id, { title: 'בקרה תקציבית', start: ago(-0.01), people: [{ email: amit.email, name: 'לנג עמית' }] });
  assert.match(text, new RegExp(`עמית לנג — מנהל/ת ${depName} — שלח את טבלת הבקרה`));
  assert.doesNotMatch(text, /חשב החברה|רו"ח|לנג עמית/);
  assert.doesNotMatch(fake.calls[0].opts.content[0].text, /חשב החברה/, 'התואר המנוחש מהמיילים לא נשלח ל-Claude');
});

test('תואר מהחתימה — גובר על המחלקה; מבחוץ — תואר וחברה', async (t) => {
  const Fakes = require('../../fakes');
  const me = user({ email: `me4-${Date.now()}@eshel.test` });
  const dana = user({ full_name: 'דנה כהן', email: `dana-${Date.now()}@eshel.test` });
  const ext = `ext-${Date.now()}@out.test`;
  const add = (email, name, company, title) => D.run('INSERT INTO mail_people (user_id, email, name, company, role, title, updated_at) VALUES (?,?,?,?,?,?,?)',
    me.id, email, name, company, 'ניחוש', title, ago(1));
  add(dana.email.toLowerCase(), 'כהן דנה', 'אשל', 'חשבת');
  add(ext, 'יוסי', 'רזבר', 'מנהל פרויקטים');
  mail(me.id, dana.email.toLowerCase(), 'בקרה תקציבית — נתונים', 2);
  mail(me.id, ext, 'בקרה תקציבית — הצעה', 2);
  Fakes.claude(t, () => ({ who: [], background: [], open_items: [], last_agreed: [], talking_points: [] }));
  const text = await Briefing.build(me.id, { title: 'בקרה תקציבית', start: ago(-0.01), people: [{ email: dana.email }, { email: ext, name: 'יוסי' }] });
  assert.match(text, /• דנה כהן — חשבת/);
  assert.match(text, /• יוסי — מנהל פרויקטים, רזבר/);
  assert.doesNotMatch(text, /ניחוש/);
});
