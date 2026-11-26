'use strict';
// סקירה לילית 26.11: "האם גולן נמצא בישיבת המשך ב 14.30?" — הבוט ענה "אין לי גישה לרשימת המשתתפים", למרות שיש "מי משתתף?".
// עכשיו: שאלה על אדם מסוים בפגישה (לפי שעה או שם) — תשובה עליו, ואחריה הרשימה.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user } = require('../../helpers/db');
boot();
const Calendar = require('../../../server/meetings/calendar');
const Meetings = require('../../../server/meetings/meetings');

function day(t) {
  const at = (h, m) => { const d = new Date(); d.setUTCHours(h - 2, m, 0, 0); return d.toISOString(); };
  t.mock.method(Calendar, 'isConnected', () => true);
  t.mock.method(Calendar, 'eventsForDay', async () => ({ events: [
    { title: 'פגישת בוקר', start: at(9, 0), end: at(10, 0), people: [{ email: 'dani@example.test', name: 'דני', response: 'accepted' }] },
    { title: 'פגישת המשך- סיכום ישיבה - ZOOM', start: at(14, 30), end: at(15, 30), organizer: { email: 'me@example.test', name: 'ישראל' },
      people: [{ email: 'golan@example.test', name: 'גולן ברזילי', response: 'needsAction' }, { email: 'rina@example.test', name: 'רינה', response: 'accepted' }] }
  ] }));
}

test('"האם גולן נמצא בישיבת המשך ב 14.30?" — עונה על גולן, לפי השעה', async (t) => {
  day(t);
  const u = user({ role: 'employee' });
  const r = await Meetings.participantsAnswer(u.id, 'האם גולן נמצא בישיבת המשך ב 14.30?');
  assert.match(r, /גולן ברזילי.*מוזמן/);
  assert.match(r, /פגישת המשך- סיכום ישיבה/);
  assert.match(r, /לא ענה/);
});

test('אדם שאינו ברשימה — "לא ברשימת המוזמנים"', async (t) => {
  day(t);
  const u = user({ role: 'employee' });
  const r = await Meetings.participantsAnswer(u.id, 'האם משה מגיע לפגישת המשך?');
  assert.match(r, /משה לא ברשימת המוזמנים/);
  assert.match(r, /פגישת המשך/);
});

test('"מי משתתף?" — כמו קודם; שאלה אחרת — ‎null‎', async (t) => {
  day(t);
  const u = user({ role: 'employee' });
  assert.match(await Meetings.participantsAnswer(u.id, 'מי משתתף בפגישת בוקר?'), /פגישת בוקר/);
  assert.equal(await Meetings.participantsAnswer(u.id, 'האם יש לי משימות להיום?'), null);
});
