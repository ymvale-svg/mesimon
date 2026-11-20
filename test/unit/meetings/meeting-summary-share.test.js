'use strict';
/**
 * 📤 "לשלוח למשתתפים" — סיכום הפגישה נשלח מהמייל של העובד לכל מי שבזימון ביומן שלו.
 * בלי רשת: היומן, Gmail והתקציר (‎meeting_digests‎) מזויפים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Calendar = require('../../../server/meetings/calendar');
const Gmail = require('../../../server/integrations/gmail');
const Followup = require('../../../server/meetings/meeting-followup');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
const START = '2026-11-11T09:31:00.000Z';
const DIGEST = {
  summary: ['תיאום יועצים לפרויקט', 'החסם: מפלסי אפס-אפס'],
  decisions: ['פגישת המשך ביום ראשון'],
  items: [{ task: 'לתאם פגישת זום לסגירת מפלסים', owner_name: 'מלכה', owner_email: 'malka@corp.test', due: '2026-11-15' }]
};

let seq = 0;
function setup(t, { gmail = true, calendar = true, event = true } = {}) {
  const u = user({ role: 'employee', full_name: 'מלכה קוגלמן', email: `malka${++seq}@corp.test` });
  const ref = `z${seq}`;
  D.run('INSERT INTO meeting_followups (source, ref, user_id, title, start_at, end_at, data, sent_at) VALUES (?,?,?,?,?,?,?,?)',
    'zoom', ref, u.id, 'פרויקט אלעד', START, '2026-11-11T10:31:00.000Z', '{}', D.nowIso());
  D.run('INSERT OR REPLACE INTO meeting_digests (source, ref, data, created_at) VALUES (?,?,?,?)', 'zoom', ref, JSON.stringify(DIGEST), D.nowIso());
  t.mock.method(Gmail, 'canSend', () => gmail);
  t.mock.method(Gmail, 'connectionOf', () => ({ email: u.email, state: 'ok' }));
  t.mock.method(Gmail, 'signed', async (who, body) => body);
  const sent = [];
  t.mock.method(Gmail, 'send', async (who, raw) => { sent.push(raw); return { messageId: 'm1' }; });
  t.mock.method(Calendar, 'isConnected', () => calendar);
  t.mock.method(Calendar, 'eventsForDay', async () => ({ events: event ? [{
    title: 'פרויקט אלעד', start: '2026-11-11T09:30:00.000Z', allDay: false,
    people: [{ email: u.email, name: 'מלכה' }, { email: 'william@corp.test', name: 'ויליאם' }, { email: 'secretary@corp.test', name: '' }],
    organizer: { email: 'william@corp.test', name: 'ויליאם' }
  }] : [] }));
  return { u, actor: Auth.loadActor('user', u.id), sent };
}

test('ASK.share — הכפתור וניסוחים חופשיים', () => {
  const { ASK, norm } = Followup._internal;
  for (const s of ['📤 לשלוח למשתתפים', 'תשלח את הסיכום לכל המשתתפים', 'לשלוח את סיכום הפגישה למשתתפים', 'שלח למשתתפים']) assert.match(norm(s), ASK.share, s);
  for (const s of ['אתה שולח סיכום פגישה למשתתפים?', 'משתתפים']) assert.doesNotMatch(norm(s), ASK.share, s);
});

test('הסיכום מציע "📤 לשלוח למשתתפים"', async (t) => {
  const { actor } = setup(t);
  const r = await Followup.answer(actor, '📝 סיכום הפגישה');
  assert.ok(r.buttons.includes('📤 לשלוח למשתתפים'));
});

test('"לשלוח למשתתפים" — טיוטה לאישור: כל מי שבזימון חוץ ממני, פעם אחת כל אחד', async (t) => {
  const { actor } = setup(t);
  const r = await Followup.answer(actor, '📤 לשלוח למשתתפים');
  assert.equal(r.draft.kind, 'meeting_summary_mail');
  assert.deepEqual(r.draft.to.map((p) => p.email), ['william@corp.test', 'secretary@corp.test']);
  assert.match(r.draft.subject, /^סיכום פגישה: פרויקט אלעד · 11\.11/);
  assert.match(r.draft.text, /על מה דיברנו:\n• תיאום יועצים/);
  assert.match(r.draft.text, /הוחלט:\n• פגישת המשך/);
  assert.match(r.draft.text, /לתאם פגישת זום לסגירת מפלסים — מלכה \(עד 15\.11\)/);
  assert.match(r.text, /לשלוח את הסיכום מהמייל שלך ל-2 משתתפים\?/);
  assert.deepEqual(r.buttons, ['כן ✅', 'לא ❌']);
});

test('בלי Gmail לשליחה / בלי יומן / בלי הזימון — הסבר, בלי טיוטה', async (t) => {
  let r = await Followup.answer(setup(t, { gmail: false }).actor, 'לשלוח למשתתפים');
  assert.match(r.text, /לחבר את תיבת ה-Gmail/); assert.equal(r.draft, undefined);
  t.mock.restoreAll();
  r = await Followup.answer(setup(t, { calendar: false }).actor, 'לשלוח למשתתפים');
  assert.match(r.text, /לחבר את היומן/); assert.equal(r.draft, undefined);
  t.mock.restoreAll();
  r = await Followup.answer(setup(t, { event: false }).actor, 'לשלוח למשתתפים');
  assert.match(r.text, /לא מצאתי את הזימון/); assert.equal(r.draft, undefined);
});

test('בבוט: "כן ✅" — נשלח מהמייל של העובד לכל המשתתפים יחד; "לא" — לא נשלח', async (t) => {
  const { u, actor, sent } = setup(t);
  const r = await Followup.answer(actor, 'לשלוח למשתתפים');
  const state = { ...Bot._internal.chatOf(u.id), draft: r.draft, awaiting: true };
  const yes = await Bot._internal.converse(u, actor, 'כן ✅', state);
  assert.match(yes.reply, /הסיכום נשלח מהמייל שלך ל-2 משתתפים/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^To: william@corp\.test, secretary@corp\.test$/m);
  assert.match(sent[0], new RegExp(`^From: .*${u.email.replace('.', '\\.')}`, 'm'));
  const no = await Bot._internal.converse(u, actor, 'לא ❌', state);
  assert.match(no.reply, /הסיכום לא נשלח/);
  assert.equal(sent.length, 1);
});
