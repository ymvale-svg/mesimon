'use strict';
/**
 * 🎥 "תנסה שוב" על הקלטת פגישה שהעיבוד שלה נכשל. באג 18.11.26: העובד כתב "תנסה שוב" שלוש פעמים, הבוט (מה-AI) ענה
 * "אין לי אפשרות להפעיל מחדש מכאן", והעובד שלח את אותה הקלטה מחדש פעמיים. הקובץ שמור — מריצים אותו שוב.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const MeetingAudio = require('../../../server/meetings/meeting-audio');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});
Bot.init({
  createTask: () => 1, listProjectsFor: () => [], newTaskProjects: () => [], assignableUserIds: () => [], assignBlockReason: () => '', taskTemplates: () => [],
  tasks: { myTasks: () => [], comment: () => {} }, mail: {},
  files: { saveAttachment: () => {}, actorRef: () => ({}), getTask: () => null }
});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `ar${++seq}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const tick = () => new Promise((r) => setImmediate(r));
const audio = (u, status, createdAt = D.nowIso()) => D.run('INSERT INTO meeting_audio (user_id, stored_name, status, meeting, created_at) VALUES (?,?,?,?,?)',
  u.id, 'a.ogg', status, JSON.stringify({ title: 'אלעד סנטר - התארגנות ובטיחות האתר' }), createdAt).lastInsertRowid;

test('"תנסה שוב" אחרי שהעיבוד נכשל — ההקלטה השמורה מעובדת שוב, בלי לבקש לשלוח אותה מחדש', async (t) => {
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'other', reply: 'אין לי אפשרות להפעיל מחדש את עיבוד ההקלטה מכאן.', ready: false }));
  const u = user({ phone: '972507600001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  const id = audio(u, 'error');
  const run = t.mock.method(MeetingAudio, 'processAudio', async () => ({ text: '🎥 הסיכום מוכן' }));
  await say(u.phone, 'תנסה שוב');
  await tick(); await tick();
  assert.equal(run.mock.callCount(), 1, 'העיבוד רץ שוב');
  assert.equal(run.mock.calls[0].arguments[0], Number(id));
  const text = wa.texts().join('\n');
  assert.match(text, /מנסה שוב .*אלעד סנטר/);
  assert.doesNotMatch(text, /אין לי אפשרות/);
  assert.equal(ai.calls.filter((c) => c.kind === 'json').length, 0, 'בלי AI');
});

test('"תנסה שוב" בלי הקלטה שנכשלה (או שנכשלה לפני יותר מיום) — לא שלנו', async (t) => {
  Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: 'מה לנסות שוב?', ready: false }));
  const u = user({ phone: '972507600002', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  audio(u, 'error', new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString());
  audio(u, 'ready');
  const run = t.mock.method(MeetingAudio, 'processAudio', async () => ({ text: 'x' }));
  await say(u.phone, 'תנסה שוב');
  await tick();
  assert.equal(run.mock.callCount(), 0);
});
