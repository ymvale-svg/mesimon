'use strict';
/**
 * 🔊 "תקריא לי את המשימות" — הרשימה נשלחת גם כהודעה קולית. פיילוט: רק למנהלי המערכת, ורק עם מפתח OpenAI.
 * בלי AI ובלי רשת: המשימות מ-‎hooks.tasks‎ מזויף, ההקראה מ-‎Speech.speak‎ מזויף, הוואטסאפ מזויף.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Speech = require('../../../server/integrations/speech');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

const TASKS = [
  { id: 1, title: 'לבדוק הצעת מחיר 🔥', overdue: true },
  { id: 2, title: 'לקחת את הרכב למוסך https://x.example/1' },
  { id: 3, title: 'לדבר עם הספק' }
];

let seq = 0;
function setup(t, { key = true } = {}) {
  const prevKey = process.env.OPENAI_API_KEY;
  if (key) process.env.OPENAI_API_KEY = 'sk-test'; else delete process.env.OPENAI_API_KEY;
  const hooks = Bot._internal.hooks;
  const prevTasks = hooks.tasks;
  hooks.tasks = { ...(prevTasks ?? {}), myTasks: () => TASKS };
  t.after(() => {
    hooks.tasks = prevTasks;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  });
  const spoken = [];
  t.mock.method(Speech, 'speak', async (text) => { spoken.push(text); return Buffer.from('OggS'); });
  const files = [];
  t.mock.method(WhatsApp, 'sendFile', async (ch, chatId, f) => { files.push(f); return {}; });
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  return { spoken, files, calls };
}
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `ra${++seq}` });

test('READ_ALOUD — "תקריא", "אני בנהיגה"; לא כל בקשה', () => {
  for (const s of ['תקריא לי את המשימות', 'אני בנהיגה, מה יש לי היום?', 'אפשר להקריא לי את הרשימה', 'תכירי לי תפסימות שיש לי פתוחות.', 'תגיד לי בקול מה פתוח']) assert.match(s, Bot._internal.READ_ALOUD);
  for (const s of ['המשימות שלי', 'מה באיחור?', 'תקרא את המייל של דני']) assert.doesNotMatch(s, Bot._internal.READ_ALOUD);
});

test('readAloudText — שם פרטי, מספרים במילים, בלי אימוג\'י וקישורים', () => {
  const txt = Bot._internal.readAloudText({ name: 'איציק הנדל' }, TASKS, 'פתוחות');
  assert.match(txt, /^איציק, יש לך 3 משימות פתוחות\./);
  assert.match(txt, /אחת\. לבדוק הצעת מחיר, באיחור\./);
  assert.match(txt, /שתיים\. לקחת את הרכב למוסך\./);
  assert.doesNotMatch(txt, /🔥|https?:/);
  const many = Array.from({ length: 11 }, (_, i) => ({ id: i, title: `משימה ${i}` }));
  assert.match(Bot._internal.readAloudText({ name: 'א' }, many, ''), /ועוד 3 באפליקציה\.$/);
});

test('מנהל מערכת: "תקריא לי את המשימות" — הודעה קולית ואחריה הרשימה בטקסט', async (t) => {
  const { spoken, files, calls } = setup(t);
  const u = user({ phone: '972507000001', role: 'admin', full_name: 'ישראל וייל' });
  await say('972507000001', 'תקריא לי את המשימות שלי');
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^ישראל, יש לך 3 משימות פתוחות\./);
  assert.equal(files.length, 1);
  assert.equal(files[0].mime, 'audio/ogg');
  assert.ok(files[0].fileName.endsWith('.ogg'));
  const text = calls.find((c) => c.method === 'sendMessage');
  assert.match(text.body.message, /📋 המשימות שלך/);
  const row = Bot.readLog({}).find((r) => r.userId === u.id);
  assert.equal(row.action, 'my_tasks');
  assert.match(row.result, /🔊 הוקרא/);
});

test('עובד (לא בפיילוט) — הרשימה בטקסט בלבד, בלי הקראה', async (t) => {
  const { spoken, files, calls } = setup(t);
  user({ phone: '972507000002', role: 'employee' });
  await say('972507000002', 'תקריא לי את המשימות שלי');
  assert.equal(spoken.length, 0);
  assert.equal(files.length, 0);
  assert.match(calls.find((c) => c.method === 'sendMessage').body.message, /📋 המשימות שלך/);
});

test('בלי מפתח OpenAI, או "המשימות שלי" רגיל — בלי הקראה', async (t) => {
  const { spoken, files } = setup(t, { key: false });
  user({ phone: '972507000003', role: 'admin' });
  await say('972507000003', 'תקריא לי את המשימות שלי');
  assert.equal(spoken.length, 0);
  assert.equal(files.length, 0);
});

test('"המשימות שלי" בלי בקשת הקראה — טקסט בלבד, גם למנהל', async (t) => {
  const { spoken, files } = setup(t);
  user({ phone: '972507000004', role: 'admin' });
  await say('972507000004', 'המשימות שלי');
  assert.equal(spoken.length, 0);
  assert.equal(files.length, 0);
});

test('ההקראה נכשלה — הרשימה בטקסט בכל זאת', async (t) => {
  const { files, calls } = setup(t);
  Speech.speak.mock.mockImplementation(async () => { throw new Error('429'); });
  t.mock.method(console, 'error', () => {});
  user({ phone: '972507000005', role: 'admin' });
  await say('972507000005', 'תקריא לי את המשימות');
  assert.equal(files.length, 0);
  assert.match(calls.find((c) => c.method === 'sendMessage').body.message, /📋 המשימות שלך/);
});
