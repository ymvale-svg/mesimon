'use strict';
/**
 * "לסגור?" / "לעדכן?" כשהמערכת בחרה משימה לא נכונה (פרק 11א): 🔀 ההודעה למשימה אחרת
 * (‎POST /api/ai/suggestions/:id/attach‎) או ➕ משימה חדשה ממנה (‎…/new-task‎).
 * ההצעה עצמה נוצרת בסריקה — כאן היא נשתלת ישירות במסד של השרת.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const Server = require('./server');

let srv;
let admin;
const alice = { name: 'עובדת א', email: 'alice-sync@test.local', password: 'Alice-Pass-1' };
const bob = { name: 'עובד ב', email: 'bob-sync@test.local', password: 'Bob-Pass-1' };

before(async () => {
  srv = await Server.start();
  admin = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
  const dept = (await srv.api('POST', '/api/departments', { cookie: admin, body: { name: 'מחלקת סנכרון' } })).json.department;
  for (const u of [alice, bob]) {
    const r = await srv.api('POST', '/api/admin/users', {
      cookie: admin, body: { name: u.name, email: u.email, password: u.password, role: 'employee', departmentId: dept.id, invite: false }
    });
    assert.equal(r.status, 201, r.text);
    u.id = r.json.userId;
    u.cookie = await srv.login(u.email, u.password);
  }
});
after(async () => { await srv?.stop(); });

const as = (u) => (method, p, body) => srv.api(method, p, { cookie: u.cookie, body });

async function create(u, body) {
  const r = await as(u)('POST', '/api/tasks', { dupChecked: true, ...body });
  assert.equal(r.status, 201, r.text);
  return r.json.task;
}

/** הצעה ממתינה של ‎userId‎ על ‎taskId‎ — כמו שהסריקה שומרת (וואטסאפ אישי: בלי Gmail) */
function plantSuggestion(userId, taskId, { kind = 'task_update', taskTitle = '' } = {}) {
  const db = new DatabaseSync(path.join(srv.dataDir, 'mesimon.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const data = {
      channel: 'whatsapp', personal: true, fromName: 'לקוח', taskTitle,
      comment: 'ההצעה המעודכנת מצורפת, המחיר כולל הובלה', summary: 'הצעת מחיר מעודכנת כולל הובלה', proposed: {}
    };
    const now = new Date().toISOString();
    const r = db.prepare(`INSERT INTO ai_suggestions (user_id, kind, status, header_id, from_name, received_at, data, task_id, created_at)
      VALUES (?, ?, 'pending', ?, 'לקוח', ?, ?, ?, ?)`).run(userId, kind, `wa:test-${Date.now()}-${Math.random()}`, now, JSON.stringify(data), taskId, now);
    return Number(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

const pending = async (u) => (await as(u)('GET', '/api/ai/inbox')).json.suggestions.pending.map((s) => s.id);
const commentsOf = async (u, id) => (await as(u)('GET', `/api/tasks/${id}`)).json.task.comments.map((c) => c.body).join('\n');

test('🔀 לצרף למשימה אחרת: ההערה נכנסת למשימה שנבחרה, לא לזו שהוצעה, וההצעה יורדת', async () => {
  const wrong = await create(alice, { title: 'הזמנת ריהוט למשרד' });
  const right = await create(alice, { title: 'הצעת מחיר להובלה' });
  const id = plantSuggestion(alice.id, wrong.id, { taskTitle: wrong.title });
  assert.ok((await pending(alice)).includes(id));

  const r = await as(alice)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: right.id, comment: 'המחיר כולל הובלה (נערך)' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.taskId, right.id);

  assert.match(await commentsOf(alice, right.id), /המחיר כולל הובלה \(נערך\)[\s\S]*מוואטסאפ של לקוח/);
  assert.doesNotMatch(await commentsOf(alice, wrong.id), /המחיר כולל הובלה/, 'המשימה שהוצעה לא השתנתה');
  const w = (await as(alice)('GET', `/api/tasks/${wrong.id}`)).json.task;
  assert.equal(w.isFinal, false);
  assert.ok(!(await pending(alice)).includes(id), 'ההצעה כבר לא ממתינה');

  const again = await as(alice)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: right.id });
  assert.equal(again.status, 400, 'הצעה שטופלה — לא פעמיים');
});

test('🔀 לצרף למשימה שאין הרשאה לערוך — 403, וההצעה נשארת ממתינה', async () => {
  const wrong = await create(alice, { title: 'דוח חודשי' });
  const bobs = await create(bob, { title: 'משימה פרטית של עובד ב', assigneeType: 'user', assigneeId: bob.id });
  const id = plantSuggestion(alice.id, wrong.id, { taskTitle: wrong.title });

  const r = await as(alice)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: bobs.id });
  assert.equal(r.status, 403, r.text);
  assert.ok((await pending(alice)).includes(id), 'ההצעה עדיין ממתינה');
  assert.doesNotMatch(await commentsOf(bob, bobs.id), /המחיר כולל הובלה/);

  assert.equal((await as(alice)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: 999999 })).status, 404);
  assert.equal((await as(alice)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: wrong.id })).status, 400, 'אותה משימה — דרך האישור הרגיל');
  // הצעה של מישהו אחר — לא נמצאה
  assert.equal((await as(bob)('POST', `/api/ai/suggestions/${id}/attach`, { taskId: bobs.id })).status, 404);
});

test('➕ משימה חדשה מההודעה: נפתחת באחריות העובדת, ההודעה בה כהערה, וההצעה יורדת', async () => {
  const wrong = await create(alice, { title: 'חידוש ביטוח רכב', assigneeType: 'user', assigneeId: alice.id });
  const id = plantSuggestion(alice.id, wrong.id, { kind: 'task_close', taskTitle: wrong.title });

  const r = await as(alice)('POST', `/api/ai/suggestions/${id}/new-task`, { title: 'הובלה לאתר — הצעת מחיר', description: 'לבדוק מול ההזמנה' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.taskId && r.json.taskId !== wrong.id);

  const t = (await as(alice)('GET', `/api/tasks/${r.json.taskId}`)).json.task;
  assert.equal(t.title, 'הובלה לאתר — הצעת מחיר');
  assert.match(t.description, /לבדוק מול ההזמנה/);
  assert.match(t.comments.map((c) => c.body).join('\n'), /המחיר כולל הובלה[\s\S]*מוואטסאפ של לקוח/);

  const w = (await as(alice)('GET', `/api/tasks/${wrong.id}`)).json.task;
  assert.equal(w.isFinal, false, 'המשימה שהוצעה לא נסגרה');
  assert.doesNotMatch(await commentsOf(alice, wrong.id), /המחיר כולל הובלה/);
  assert.ok(!(await pending(alice)).includes(id));
});

test('➕ בלי כותרת — מהסיכום של ההודעה', async () => {
  const wrong = await create(alice, { title: 'תיאום פגישה עם ספק' });
  const id = plantSuggestion(alice.id, wrong.id, { taskTitle: wrong.title });
  const r = await as(alice)('POST', `/api/ai/suggestions/${id}/new-task`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal((await as(alice)('GET', `/api/tasks/${r.json.taskId}`)).json.task.title, 'הצעת מחיר מעודכנת כולל הובלה');
});
