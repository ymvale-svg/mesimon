'use strict';
/**
 * 🔐 "דרישת רכש" ממי שאין לו הרשאה (סקירה 19.11, הוחלט 20.11): העובד קיבל מה-AI "דרישת רכש עוד לא זמינה אצלי כאן"
 * עם הצעה לבקש הצעות מחיר. עכשיו — תשובה ברורה, והבקשה עוברת למנהל המערכת בבוט, בשם העובד.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
// קבלת סחורה — לכולם; דרישת רכש — רק למנהלים
D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'managers' } });

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `pdd${++seq}` });
/** מה נשלח לשיחה מסוימת */
const to = (wa, chatId) => wa.calls.filter((c) => c.body?.chatId === chatId).map((c) => c.body?.message ?? '').filter(Boolean);
const tick = () => new Promise((r) => setImmediate(r));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const admin = user({ full_name: 'מנהל המערכת', role: 'admin', phone: '972507700000' });

test('"דרישת רכש" בלי הרשאה — "אין לך הרשאה", ומנהל המערכת מקבל בבוט את הבקשה בשם העובד', async (t) => {
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'other', reply: 'דרישת רכש עוד לא זמינה אצלי כאן.', ready: false }));
  const u = user({ full_name: 'מדיין העובד', phone: '972507700001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  await say(u.phone, 'דרישת רכש');
  await tick();
  const toWorker = to(wa, `${u.phone}@c.us`).join('\n');
  assert.match(toWorker, /אין לך הרשאה ליצור דרישת רכש/);
  assert.match(toWorker, /מנהל המערכת/);
  assert.doesNotMatch(toWorker, /עוד לא זמינה/);
  const toAdmin = to(wa, `${admin.phone}@c.us`).join('\n');
  assert.match(toAdmin, /מדיין העובד/);
  assert.match(toAdmin, /דרישת רכש/);
  assert.equal(ai.calls.filter((c) => c.kind === 'json').length, 0, 'בלי AI');
  // פעם ביום — לא מציפים את המנהל
  await say(u.phone, 'דרישה');
  await tick();
  assert.equal(to(wa, `${admin.phone}@c.us`).length, 1);
  assert.match(to(wa, `${u.phone}@c.us`).at(-1), /אין לך הרשאה ליצור דרישת רכש/);
});

test('מנהל (מורשה) — "דרישת רכש" פותח דרישה כרגיל, בלי הודעה על הרשאה', async (t) => {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: '', ready: false }));
  const m = user({ full_name: 'מנהלת פרויקט', phone: '972507700002', role: 'manager' });
  Bot._internal.saveChat(m.id, { ...Bot._internal.chatOf(m.id), greetedOn: today() });
  await say(m.phone, 'דרישת רכש');
  assert.doesNotMatch(to(wa, `${m.phone}@c.us`).join('\n'), /אין לך הרשאה/);
});
