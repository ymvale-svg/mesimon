'use strict';
/**
 * 📝 "שבסיום כל פגישה יצא מייל עם הסיכום" — זו כבר השגרה (הוחלט 23.11.26). סקירה 22.11: עובדת ביקשה שלוש פעמים,
 * והבוט ענה "אין לי אפשרות להגדיר שליחה אוטומטית" — בזמן שהסיכום כבר נשלח לבד לכל המשתתפים.
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
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `msr${++seq}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

function worker(t, n) {
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'other', reply: 'אין לי אפשרות להגדיר שליחה אוטומטית אחרי כל פגישה.', ready: false }));
  const u = user({ phone: `97250790010${n}`, role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  return { wa, ai, u };
}

test('בקשה לשלוח סיכום אחרי כל פגישה — "זו כבר השגרה", בלי AI', async (t) => {
  for (const [i, text] of ['אני רוצה שבסיום כל פגישה יצא מייל מסודר למזכירות עם סיכום משימות והקלטה',
    'איך מחברים את הסיכום להוצאת מייל', 'אז תשלח לי על פעם בסיום גם שאלה האם לשלוח אותו למזכירות'].entries()) {
    const { wa, ai, u } = worker(t, i);
    await say(u.phone, text);
    const out = wa.texts().join('\n');
    assert.match(out, /זו כבר השגרה של סיכומי הפגישות/, text);
    assert.match(out, /נשלח \*אוטומטית\* במייל ובבוט לכל המשתתפים/);
    assert.doesNotMatch(out, /אין לי אפשרות/);
    assert.equal(ai.calls.filter((c) => c.kind === 'json').length, 0, 'בלי AI');
    t.mock.restoreAll();
  }
});

test('הסיכום האוטומטי כבוי — אומרים, ומפנים למנהל', async (t) => {
  D.setSetting('meeting_summary_auto', false);
  t.after(() => D.setSetting('meeting_summary_auto', true));
  const { wa, u } = worker(t, 5);
  await say(u.phone, 'אני רוצה שבסיום כל פגישה יישלח הסיכום למשתתפים');
  assert.match(wa.texts().join('\n'), /כבויה כרגע/);
});

test('בקשה לשלוח סיכום מסוים עכשיו — לא נתפסת כאן', async (t) => {
  const { wa, u } = worker(t, 6);
  await say(u.phone, 'שלח לגולן את הסיכום של פגישת הסופרפוזיציה');
  assert.doesNotMatch(wa.texts().join('\n'), /זו כבר השגרה/);
});
