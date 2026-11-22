'use strict';
/**
 * 📝📝 כמה משימות בהודעה אחת (באג 22.11.26): "תפתח משימות: אחד: … שתיים: … (19 סעיפים)" — הבוט ענה "אני יכול לפתוח
 * רק משימה אחת בכל פעם" והציע משימה אחת עם צ'קליסט. עכשיו: טיוטה אחת עם כל המשימות, ו"כן" אחד פותח כל אחת בנפרד.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const VoiceRouter = require('../../../server/whatsapp/voice-router');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

const created = [];
Bot.init({
  createTask: (actor, body) => { created.push(body); return 9100 + created.length; },
  listProjectsFor: () => [],
  newTaskProjects: () => [],
  assignableUserIds: () => [],
  assignBlockReason: () => '',
  taskTemplates: () => [],
  tasks: { myTasks: () => [], myOpen: () => [], projectTasks: () => [], canSee: () => true, complete: () => {}, comment: () => {} },
  mail: {}
});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `tb${++seq}` });
const base = { title: '', summary: '', assignee_user_id: 0, due_date: '2026-11-23', priority: 'normal', project_id: 0, project_suggested: false, checklist: [], template_id: 0 };
const TITLES = ['לטפל במטענים של אתר אלעד', 'להזמין פרחים לשושנה', 'לקבוע סיור עם מנהל פונוניקס', 'לברר אצל אייל מביגה מה המחיר'];
const tasks = TITLES.map((title, i) => ({ title, due_date: i === 3 ? '2026-11-25' : '', assignee_user_id: 0 }));
const greeted = (u) => Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) });

test('רשימה של כמה משימות — טיוטה אחת עם כולן, ו"כן" פותח כל אחת בנפרד, עם היעד המשותף או שלה', async (t) => {
  created.length = 0;
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'create_task', ready: true, reply: '', tasks, draft: base }));
  const u = user({ phone: '972507410001', role: 'employee' });
  greeted(u);
  await say(u.phone, 'תפתח משימות עם יעד למחר: אחד: לטפל במטענים. שתיים: להזמין פרחים. שלוש: לקבוע סיור. ארבע: לברר אצל אייל, עד יום רביעי');
  const shown = wa.texts().join('\n');
  assert.match(shown, /4 משימות/);
  for (const title of TITLES) assert.ok(shown.includes(title), title);
  assert.doesNotMatch(shown, /רק משימה אחת/);
  assert.equal(created.length, 0, 'לפני "כן" — כלום לא נפתח');
  wa.clear();
  await say(u.phone, 'כן');
  assert.match(wa.texts().join('\n'), /נפתחו 4 משימות/);
  assert.deepEqual(created.map((c) => c.title), TITLES);
  assert.equal(created[0].checklist.length, 0, 'משימות נפרדות, לא צ\'קליסט');
  assert.match(created[0].dueDate, /^2026-11-23/);
  assert.match(created[3].dueDate, /^2026-11-25/);
});

test('משימה אחת — כמו קודם (בלי tasks)', async (t) => {
  created.length = 0;
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'create_task', ready: true, reply: '', tasks: [], draft: { ...base, title: 'להזמין פרחים' } }));
  const u = user({ phone: '972507410002', role: 'employee' });
  greeted(u);
  await say(u.phone, 'תפתח משימה להזמין פרחים');
  assert.match(wa.texts().join('\n'), /📝 \*להזמין פרחים\*/);
  wa.clear();
  await say(u.phone, 'כן');
  assert.equal(created.length, 1);
});

test('הקלטה עם רשימה ממוספרת — לא מתפרקת לבקשות נפרדות (הפירוק עוצר ב-5)', async () => {
  const text = 'תזכיר לי את הדברים הבאים בשעה עשר וחצי. אחד: לטפל במטענים ותזכיר לי גם. שתיים: להזמין פרחים. שלוש: לקבוע ישיבה. ארבע: לברר אצל אייל. חמש: סידור חדרים. שש: לקדם גיוס';
  assert.equal(VoiceRouter.isNumberedList(text), true);
  const out = await VoiceRouter.split(text);
  assert.equal(out.length, 1);
  assert.equal(VoiceRouter.isNumberedList('תפתח משימה לשושנה ותשלח מייל לאורן'), false);
});
