'use strict';
/**
 * 🎥 "תבדוק" על הקלטה שהועלתה ל-Timeless. באג 18.11.26 (אלעד סנטר, 79 דקות): הסיכום היה מוכן ב-Timeless,
 * והבוט ענה (מה-AI) "אין לי דרך לבדוק את הסטטוס מכאן". עכשיו — בודקים ב-Timeless מיד ועונים מה המצב.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const Store = require('../../../server/meetings/timeless-store');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `tc${++seq}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

test('"תבדוק" — הבוט בודק ב-Timeless עכשיו ועונה מה המצב, לא "אין לי דרך לבדוק"', async (t) => {
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'other', reply: 'אין לי דרך לבדוק את הסטטוס מכאן.', ready: false }));
  const u = user({ phone: '972507500001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  const tid = `mtg_check_bot_${Date.now()}`;
  D.run("INSERT INTO meeting_audio (user_id, stored_name, status, timeless_id, timeless_at, meeting, created_at) VALUES (?,?,?,?,?,?,?)",
    u.id, 'a.ogg', 'timeless', tid, D.nowIso(), JSON.stringify({ title: 'אלעד סנטר - התארגנות ובטיחות האתר' }), D.nowIso());
  const sync = t.mock.method(Store, 'syncMeeting', async (id) => {
    Store._internal.upsert({ id, title: 'אלעד סנטר', status: 'processing', start_time: new Date().toISOString(), end_time: new Date().toISOString(), host: { email: u.email }, participants: [] });
    return null;
  });
  await say(u.phone, 'תבדוק');
  assert.equal(sync.mock.callCount(), 1, 'נבדק ב-Timeless');
  const text = wa.texts().join('\n');
  assert.match(text, /אלעד סנטר - התארגנות ובטיחות האתר/);
  assert.match(text, /בדקתי עכשיו ב-Timeless: עדיין בעיבוד/);
  assert.doesNotMatch(text, /אין לי דרך לבדוק/);
  assert.equal(ai.calls.filter((c) => c.kind === 'json').length, 0, 'בלי AI');
});

test('"תבדוק" בלי הקלטה שמחכה — לא שלנו (ממשיך לניתוב הרגיל)', async (t) => {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: 'מה לבדוק?', ready: false }));
  const u = user({ phone: '972507500002', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  const sync = t.mock.method(Store, 'syncMeeting', async () => null);
  await say(u.phone, 'תבדוק');
  assert.equal(sync.mock.callCount(), 0);
  assert.doesNotMatch(wa.texts().join('\n'), /Timeless/);
});
