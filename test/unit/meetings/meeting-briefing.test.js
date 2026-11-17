'use strict';
/**
 * 📋 תדריך לפני פגישה — רק מה שנוגע לנושא הפגישה.
 * באג 17.11.26: "הכנסת ערבויות לפריוריטי" עם עובדת — התדריך הביא את עזיבת עובדת אחרת, ביטול מספר לקוח ובדיקת תקבולים
 * (חמשת המיילים האחרונים איתה, בלי קשר לנושא), ו"לא ידוע" בסעיף ריק.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Briefing = require('../../../server/meetings/briefing');

boot();

const ev = (title, email, name = 'אורית') => ({ title, start: '2026-11-17T08:00:00Z', people: [{ email, name }] });
let n = 0;
function mail(userId, email, summary, daysAgo) {
  n += 1;
  D.run(`INSERT INTO mail_memory (user_id, thread_id, contact_email, summary, outcome, happened_at, created_at) VALUES (?,?,?,?,?,?,?)`,
    userId, `th-${n}`, email, summary, 'info', new Date(Date.now() - daysAgo * 86400000).toISOString(), D.nowIso());
}

test('מילות הנושא — בלי "פגישה" / "עם", ומתאים גם בלי אות שימוש וסיומת', () => {
  const { topicWords, onTopic } = Briefing._internal;
  assert.deepEqual(topicWords('פגישה עם רזבר'), ['רזבר']);
  const w = topicWords('הכנסת ערבויות לפריוריטי');
  assert.ok(onTopic('הוזנה ערבות מכר בפריוריטי', w));
  assert.ok(onTopic('סטטוס הערבויות של הפרויקט', w));
  assert.ok(!onTopic('עזיבת רבקי ומי מחליפה אותה', w));
});

test('המיילים על הנושא נאספים לפני מיילים אחרים, גם כשהם ישנים יותר', () => {
  const me = user();
  const email = `orit-${Date.now()}@example.test`;
  mail(me.id, email, 'שאלה על ערבות בנקאית לפרויקט', 60);
  for (let i = 1; i <= 7; i += 1) mail(me.id, email, `בדיקת תקבולים ${i}`, i);
  const c = Briefing._internal.collect(me.id, ev('הכנסת ערבויות לפריוריטי', email));
  const lines = c.text.split('\n').filter((l) => l.startsWith('•'));
  assert.match(lines[0], /ערבות בנקאית/);
});

test('נקודה שאינה על הנושא ו"לא ידוע" — לא נכנסות לתדריך; ההנחיה אומרת שהנושא קובע', async (t) => {
  const me = user();
  const email = `orit2-${Date.now()}@example.test`;
  mail(me.id, email, 'ערבות מכר מול הבנק — ממתין להזנה', 2);
  const ai = Fakes.claude(t, () => ({
    who: ['אורית — עובדת באשל, מזינה בפריוריטי'],
    background: [{ text: 'ערבות המכר ממתינה להזנה', on_topic: true }, { text: 'לאחר עזיבת רבקי — מי מדריך את המחליפה', on_topic: false }],
    open_items: [],
    last_agreed: [{ text: 'לא ידוע', on_topic: true }],
    talking_points: [{ text: 'מי אחראי להזנת הערבויות', on_topic: true }, { text: 'סטטוס זכויות החתימה בבנק', on_topic: false }]
  }));
  const text = await Briefing.build(me.id, ev('הכנסת ערבויות לפריוריטי', email));
  assert.match(text, /ערבות המכר ממתינה להזנה/);
  assert.match(text, /מי אחראי להזנת הערבויות/);
  assert.doesNotMatch(text, /רבקי/);
  assert.doesNotMatch(text, /זכויות החתימה/);
  assert.doesNotMatch(text, /לא ידוע/);
  assert.doesNotMatch(text, /מה סוכם בפעם הקודמת/);
  const { system, content } = ai.calls[0].opts;
  assert.match(system, /הנושא קובע/);
  assert.match(content[0].text, /נושא הפגישה: הכנסת ערבויות לפריוריטי/);
});

test('אין שום נקודה על הנושא — אין תדריך', async (t) => {
  const me = user();
  const email = `orit3-${Date.now()}@example.test`;
  mail(me.id, email, 'בדיקת תקבולים', 2);
  Fakes.claude(t, () => ({ who: ['אורית'], background: [{ text: 'בדיקת תקבולים', on_topic: false }], open_items: [], last_agreed: [], talking_points: [] }));
  assert.equal(await Briefing.build(me.id, ev('הכנסת ערבויות לפריוריטי', email)), null);
});

test('פגישה בלי נושא (רק שם) — מה שפתוח מול המשתתף נכנס', async (t) => {
  const me = user();
  const email = `raz-${Date.now()}@example.test`;
  mail(me.id, email, 'הצעת מחיר לשיפוץ', 2);
  Fakes.claude(t, () => ({ who: ['רזבר'], background: [{ text: 'הצעת מחיר לשיפוץ', on_topic: false }], open_items: [], last_agreed: [], talking_points: [] }));
  assert.match(await Briefing.build(me.id, ev('פגישה עם רזבר', email, 'רזבר שיפוצים')), /הצעת מחיר לשיפוץ/);
});
