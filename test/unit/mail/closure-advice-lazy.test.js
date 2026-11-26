'use strict';
/**
 * 🤖 עצת סוכן המחלקה — רק בלחיצה ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 9, שלב א'). בסריקה רץ רק הניתוב
 * הזול (‎adviseRoute‎) וההצעה נושאת ‎agentOffer‎; הסוכן עצמו (‎advise‎ — Opus, כלים, חיפוש ברשת) רץ רק
 * ב"🤖 לשאול את …", פעם אחת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Ports = require('../../../server/core').Ports;
const Gmail = require('../../../server/integrations').Gmail;
const MailScan = require('../../../server/mail/mail-scan');
const TaskClosure = require('../../../server/tasks/task-closure');

boot();

let seq = 0;
const RAW = (n) => Buffer.from([
  'From: Dani Cohen <dani@client.test>',
  'To: me@org.test',
  'Subject: Purchase tax',
  `Message-ID: <advice${n}@client.test>`,
  'Date: Mon, 16 Nov 2026 08:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'How much purchase tax do we pay on the new plot?'
].join('\r\n'));

const ANALYSIS = {
  for_me: true, reply_expected: false, addressed_to_email: 'me@org.test', department: '', skip_reason: '', warning: '',
  goods_document: null, blank_form: null,
  tasks: [{ title: 'לבדוק מס רכישה על המגרש', summary: 'דני שואל כמה מס רכישה.', meeting: false, need: '', keywords: [], checklist: [], due_date: '', priority: 'normal', people: [], ambiguous: [], ai_request: { needed: false } }]
};
const OFFER = { key: 'tax', title: 'סוכן המיסוי', icon: '🧾' };

/** סוכנים מזויפים: הניתוב תמיד מוצא את סוכן המיסוי; ‎advise‎ נספר */
function fakeAgents(t) {
  const advised = [];
  const routed = [];
  const restore = Ports.provide('agents', {
    adviseRoute: async (u, actor, task) => { routed.push(task.title); return OFFER; },
    advise: async (u, actor, task, opts) => { advised.push(opts); return { key: 'tax', title: 'סוכן המיסוי', icon: '🧾', text: 'מס רכישה על קרקע: 6%.', sources: [] }; }
  });
  t.after(restore);
  return { advised, routed };
}

function setup(t) {
  const n = ++seq;
  const u = user({ email: `adv${n}@org.test`, role: 'employee' });
  const ai = Fakes.claude(t, (opts) => (opts.feature === 'mail.scan' ? ANALYSIS : {}));
  t.mock.method(Gmail, 'raw', async () => ({ raw: RAW(n), internalDate: new Date() }));
  t.mock.method(Gmail, 'canSend', () => false);
  t.mock.method(Gmail, 'emailsOf', () => []);
  D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 0 });
  return { u, ai, conn: { box: 0, email: u.email }, gmailId: `adv${n}` };
}
const sugOf = (u) => D.get("SELECT id, data FROM ai_suggestions WHERE user_id = ? AND kind = 'task'", u.id);
const actorOf = (u) => ({ type: 'user', id: u.id, name: u.full_name });

test('סריקה: רק ניתוב — ההצעה נושאת ‎agentOffer‎, הסוכן לא רץ', async (t) => {
  const { advised, routed } = fakeAgents(t);
  const { u, ai, conn, gmailId } = setup(t);
  assert.equal(await MailScan._internal.processMessage(u, conn, gmailId), 'suggested');
  assert.deepEqual(routed, ['לבדוק מס רכישה על המגרש']);
  assert.equal(advised.length, 0, 'העצה לא נכתבת ברקע');
  assert.equal(ai.calls.filter((c) => c.kind === 'tools').length, 0, 'אין קריאה עם כלים');
  const c = JSON.parse(sugOf(u).data).closure;
  assert.deepEqual(c.agentOffer, OFFER);
  assert.equal(c.agent, undefined);
});

test('"🤖 לשאול את …" — הסוכן שנבחר רץ פעם אחת, והעצה נשמרת במקום ההצעה', async (t) => {
  const { advised } = fakeAgents(t);
  const { u, conn, gmailId } = setup(t);
  await MailScan._internal.processMessage(u, conn, gmailId);
  const id = sugOf(u).id;
  await MailScan.adviseClosure(id, actorOf(u));
  assert.deepEqual(advised, [{ key: 'tax' }], 'בלי ניתוב שני — הסוכן שכבר נבחר');
  const c = JSON.parse(sugOf(u).data).closure;
  assert.match(c.agent.text, /6%/);
  assert.equal(c.agentOffer, undefined);
  await MailScan.adviseClosure(id, actorOf(u));
  assert.equal(advised.length, 1, 'עצה שכבר נכתבה — לא נכתבת שוב');
});

test('בלי סוכן מתאים — "לשאול" נכשל בהודעה ברורה ולא קורא ל-AI', async (t) => {
  const advised = [];
  t.after(Ports.provide('agents', { adviseRoute: async () => null, advise: async () => { advised.push(1); return null; } }));
  const u = user({ email: `adv-none${++seq}@org.test` });
  await assert.rejects(() => TaskClosure.adviseNow(u, actorOf(u), { kind: 'self', steps: ['x'] }, { title: 'x' }), /אין סוכן/);
  assert.equal(advised.length, 0);
});

test('משימה שלא נולדה ממייל: ‎forTask‎ שומר רק הצעה, ‎adviseTask‎ כותב את העצה', async (t) => {
  const { advised } = fakeAgents(t);
  Fakes.claude(t, () => ({}));
  const u = user({ email: `adv-task${++seq}@org.test`, role: 'employee' });
  const taskId = Number(D.run("INSERT INTO tasks (title, description, board_id, created_by, assignee_type, assignee_id, status, archived, sens, created_at, status_changed_at) VALUES ('מס רכישה', '', ?, ?, 'user', ?, 'new', 0, 0, ?, ?)",
    D.internalBoard().id, u.id, u.id, D.nowIso(), D.nowIso()).lastInsertRowid);
  await TaskClosure.forTask(taskId);
  assert.equal(advised.length, 0);
  assert.deepEqual(TaskClosure.closureOfTask(taskId, u.id).agentOffer, OFFER);
  const c = await TaskClosure.adviseTask(taskId, actorOf(u));
  assert.match(c.agent.text, /6%/);
  assert.equal(advised.length, 1);
  assert.match(TaskClosure.closureOfTask(taskId, u.id).agent.text, /6%/);
});
