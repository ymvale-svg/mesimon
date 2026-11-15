'use strict';
/**
 * תשובה בלי התפריט (באג 15.11.26, ישראל: "למה אני מקבל את כל התפריט עוד הפעם ועוד הפעם?").
 * בקשה שאין לה פעולה, וה-AI ענה עליה — רק התשובה. התפריט — רק כשאין מה לענות. ה-Today של הבוקר — רק על ברכה,
 * לא על "שעה 15.00" (שלוש מילים שנראו "שיחת חולין").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `om${++seq}` });
const other = (t, reply) => Fakes.claude(t, () => ({ intent: 'other', reply, ready: false }));

test('ה-AI ענה ("other") — רק התשובה, בלי התפריט ובלי כפתורים', async (t) => {
  const wa = Fakes.whatsapp(t);
  other(t, 'אין לי מידע על זה כרגע.');
  const u = user({ phone: '972507300001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });
  await say(u.phone, 'מה גובה הר החרמון?');
  const texts = wa.texts();
  assert.deepEqual(texts, ['אין לי מידע על זה כרגע.']);
  assert.equal(wa.buttons().length, 0);
});

test('הודעה ראשונה ביום שאינה ברכה ("שעה 15.00") — התשובה, בלי ה-Today', async (t) => {
  const wa = Fakes.whatsapp(t);
  other(t, 'רשמתי: 15:00.');
  const u = user({ phone: '972507300002', role: 'employee' });
  await say(u.phone, 'שעה 15.00');
  assert.deepEqual(wa.texts(), ['רשמתי: 15:00.']);
});

test('"היי" בבוקר — עדיין ה-Today', async (t) => {
  const wa = Fakes.whatsapp(t);
  other(t, 'היי!');
  const u = user({ phone: '972507300003', role: 'employee' });
  await say(u.phone, 'בוקר טוב');
  assert.match(wa.texts().join('\n'), /☀️ \*היום/);
});

test('בלי תשובה מה-AI — התפריט, כדי שיהיה מה לעשות', async (t) => {
  const wa = Fakes.whatsapp(t);
  other(t, '');
  const u = user({ phone: '972507300004', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });
  await say(u.phone, 'אממ');
  assert.ok(wa.buttons().length >= 1);
});
