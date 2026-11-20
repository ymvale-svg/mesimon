'use strict';
/**
 * "לפתוח בלי פרויקט?" ← "כן" פותח את המשימה (באג 18.11.26, מהסקירה הלילית): הפרויקט שנאמר לא נמצא, הבוט שאל
 * "לפתוח בלי פרויקט?", העובדת ענתה "כן" — וקיבלה שוב את הטיוטה עם "לפתוח? השיבו כן". השיחה נגמרה בלי משימה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

const created = [];
Bot.init({
  createTask: (actor, body) => { created.push(body); return 9001; },
  listProjectsFor: () => [],
  newTaskProjects: () => [],
  assignableUserIds: () => [],
  assignBlockReason: () => '',
  taskTemplates: () => [],
  tasks: { myTasks: () => [], myOpen: () => [], projectTasks: () => [], canSee: () => true, complete: () => {}, comment: () => {} },
  mail: {}
});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `np${++seq}` });
const draft = { title: 'להשיג את תום', summary: '', assignee_user_id: 0, due_date: '', priority: 'urgent', project_id: 0, project_suggested: false, checklist: [], template_id: 0 };

test('"לפתוח בלי פרויקט?" ← "כן": המשימה נפתחת, בלי לשאול שוב', async (t) => {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'create_task', ready: false, reply: 'לא מצאתי פרויקט בשם "מגרש 503" בפרויקטים שלך. לפתוח בלי פרויקט?', draft }));
  const u = user({ phone: '972507400001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });
  await say(u.phone, 'להשיג דחוף את תום, פרויקט מגרש 503');
  assert.match(wa.texts().join('\n'), /לפתוח בלי פרויקט\?/);
  wa.clear();
  await say(u.phone, 'כן');
  assert.match(wa.texts().join('\n'), /נפתחה משימה: להשיג את תום/);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'להשיג את תום');
});

test('שאלה אחרת של ה-AI ("למי לשייך?") — לא נעשית אישור: "כן" לא פותח', async (t) => {
  created.length = 0;
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'create_task', ready: false, reply: 'יש שתי שושנה — למי הכוונה?', draft }));
  const u = user({ phone: '972507400002', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });
  await say(u.phone, 'משימה לשושנה להשיג את תום');
  wa.clear();
  await say(u.phone, 'כן');
  assert.equal(created.length, 0);
});
