'use strict';
/**
 * 📋 סיכום פגישה ← משימות (הוחלט 26.11.26, ישראל): "משימות מהפגישה" מציג רק מה שהוטל על העובד, ומציע להמיר:
 *   ☑️ משימה אחת עם צ'קליסט — כל הפריטים שלו במשימה אחת;  📌 משימות נפרדות — משימה לכל פריט.
 * ההצעות ב"ממתין לאישורך" יורדות אחרי ההמרה. בלי רשת: התקציר (‎meeting_digests‎) שמור.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Followup = require('../../../server/meetings/meeting-followup');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaBase = require('../../../server/whatsapp/wa-base');

boot();

const realTask = (title) => Number(D.run("INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at) VALUES (?,?,'new',0,0,?,?)",
  title, D.internalBoard().id, D.nowIso(), D.nowIso()).lastInsertRowid);

function withHook(name, fn) {
  const old = WaBase.hooks[name];
  WaBase.hooks[name] = fn;
  return () => { WaBase.hooks[name] = old; };
}

let seq = 0;
function setup(t, items) {
  seq += 1;
  const u = user({ role: 'employee', full_name: `מלכה קוגלמן${seq}`, email: `conv-malka${seq}@corp.test` });
  const ref = `conv${seq}`;
  D.run('INSERT INTO meeting_followups (source, ref, user_id, title, start_at, end_at, data, sent_at) VALUES (?,?,?,?,?,?,?,?)',
    'zoom', ref, u.id, 'פרויקט אלעד', '2026-11-11T09:31:00.000Z', '2026-11-11T10:31:00.000Z', '{}', D.nowIso());
  const dig = { summary: ['תיאום יועצים'], decisions: [], items: items(u) };
  D.run('INSERT OR REPLACE INTO meeting_digests (source, ref, data, created_at) VALUES (?,?,?,?)', 'zoom', ref, JSON.stringify(dig), D.nowIso());
  const created = [];
  t.after(withHook('createTask', (a, body) => { const id = realTask(body.title); created.push({ id, body }); return id; }));
  return { u, ref, actor: Auth.loadActor('user', u.id), created };
}

const three = (u) => [
  { task: 'לתאם פגישת זום', owner_name: 'מלכה', owner_email: u.email, due: '2026-11-20' },
  { task: 'לשלוח תוכניות ליועץ', owner_name: 'ויליאם', owner_email: 'william@corp.test', due: '' },
  { task: 'לבדוק מפלסים', owner_name: 'מלכה', owner_email: u.email, due: '2026-11-15' }
];

test('"משימות מהפגישה" — רק שלי, ושני כפתורי המרה', async (t) => {
  const { actor } = setup(t, three);
  const r = await Followup.answer(actor, '📋 משימות מהפגישה', { createTask: () => 1 });
  assert.match(r.text, /המשימות שלך מהפגישה \(2\)/);
  assert.doesNotMatch(r.text, /לשלוח תוכניות ליועץ/);
  assert.match(r.text, /להמיר למשימות\?/);
  assert.deepEqual(r.buttons, ["☑️ משימה + צ'קליסט", '📌 משימות נפרדות', '📝 סיכום הפגישה']);
  assert.ok(r.buttons.every((b) => b.length <= 20));
  assert.equal(r.draft.kind, 'meeting_tasks');
  assert.equal(r.awaiting, true);
});

test('פריט אחד — "לפתוח משימה ✅"', async (t) => {
  const { actor } = setup(t, (u) => [three(u)[0]]);
  const r = await Followup.answer(actor, 'משימות מהפגישה', { createTask: () => 1 });
  assert.equal(r.buttons[0], 'לפתוח משימה ✅');
});

test("☑️ משימה + צ'קליסט — משימה אחת אצלי, פריט לכל משימה, היעד המוקדם; ההצעות יורדות", async (t) => {
  const { u, ref, actor, created } = setup(t, three);
  const r = await Followup.answer(actor, 'משימות מהפגישה', { createTask: () => 1 });
  assert.equal(D.get("SELECT COUNT(*) AS n FROM ai_suggestions WHERE header_id LIKE ? AND status = 'pending'", `meeting:zoom:${ref}:%`).n, 2);
  const state = { ...Bot._internal.chatOf(u.id), draft: r.draft, awaiting: true };
  const res = await Bot._internal.converse(u, actor, "☑️ משימה + צ'קליסט", state);
  assert.match(res.reply, /נפתחה משימה אחת עם צ'קליסט של 2 פריטים/);
  assert.equal(created.length, 1);
  const body = created[0].body;
  assert.equal(body.title, 'משימות מהפגישה "פרויקט אלעד"');
  assert.deepEqual(body.checklist, ['לתאם פגישת זום (עד 20.11)', 'לבדוק מפלסים (עד 15.11)']);
  assert.equal(body.assigneeId, u.id);
  assert.equal(body.dueDate, new Date('2026-11-15T17:00:00+03:00').toISOString());
  assert.equal(D.get("SELECT COUNT(*) AS n FROM ai_suggestions WHERE header_id LIKE ? AND status = 'pending'", `meeting:zoom:${ref}:%`).n, 0);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM ai_suggestions WHERE header_id LIKE ? AND task_id = ?", `meeting:zoom:${ref}:%`, created[0].id).n, 2);
});

test('📌 משימות נפרדות — משימה לכל פריט שלי', async (t) => {
  const { u, actor, created } = setup(t, three);
  const r = await Followup.answer(actor, 'משימות מהפגישה', { createTask: () => 1 });
  const state = { ...Bot._internal.chatOf(u.id), draft: r.draft, awaiting: true };
  const res = await Bot._internal.converse(u, actor, '📌 משימות נפרדות', state);
  assert.match(res.reply, /נפתחו 2 משימות/);
  assert.deepEqual(created.map((c) => c.body.title), ['לתאם פגישת זום', 'לבדוק מפלסים']);
});

test('שפה חופשית', () => {
  const c = Followup.convertChoice;
  for (const s of ["הכול במשימה אחת", "עם צ'קליסט", 'משימה אחת', "☑️ משימה + צ'קליסט"]) assert.equal(c(s), 'checklist', s);
  for (const s of ['נפרדות', 'כל אחת בנפרד', 'תפתח אותן', '📌 משימות נפרדות', 'לפתוח משימה ✅']) assert.equal(c(s), 'separate', s);
  for (const s of ['לא', 'סיכום הפגישה', 'מה המשימות שלי היום']) assert.equal(c(s), null, s);
});
