'use strict';
/** משימות דרך ה-API — יצירה, קריאה, עדכון, רשימה, ארכיון ומחיקה. מנהל המערכת הראשון פועל. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Server = require('./server');

let srv;
let cookie;
before(async () => {
  srv = await Server.start();
  cookie = await srv.login(Server.ADMIN.email, Server.ADMIN.password);
});
after(async () => { await srv?.stop(); });

const call = (method, path, body) => srv.api(method, path, { cookie, body });
async function create(body) {
  const r = await call('POST', '/api/tasks', body);
  assert.equal(r.status, 201, r.text);
  return r.json.task;
}
const listIds = async (query = '') => (await call('GET', `/api/tasks${query}`)).json.tasks.map((t) => t.id);

test('יצירת משימה — 201 עם ברירות המחדל: בורד פנימי, סטטוס "חדש", עדיפות רגילה', async () => {
  const t = await create({ title: '  להכין מצגת  ', description: 'לישיבת צוות' });
  assert.ok(Number.isInteger(t.id));
  assert.equal(t.title, 'להכין מצגת', 'הכותרת נחתכת מרווחים');
  assert.equal(t.description, 'לישיבת צוות');
  assert.equal(t.boardType, 'internal');
  assert.equal(t.status, 'new');
  assert.equal(t.statusLabel, 'חדש');
  assert.equal(t.isFinal, false);
  assert.equal(t.priority, 'normal');
  assert.equal(t.archived, false);
  assert.equal(t.completedAt, null);
});

test('יצירה עם עדיפות, תאריך יעד וצ׳קליסט', async () => {
  const t = await create({ title: 'הזמנת ציוד', priority: 'urgent', dueDate: '2026-12-01', checklist: ['מסכים', '', { text: 'כבלים', note: 'HDMI' }] });
  assert.equal(t.priority, 'urgent');
  assert.equal(t.priorityLabel, 'דחוף');
  assert.equal(t.dueDate, '2026-12-01');
  assert.equal(t.checklistTotal, 2, 'סעיף ריק מדולג');
  assert.equal(t.checklistDone, 0);
});

test('יצירה בלי כותרת — 400', async () => {
  for (const body of [{}, { title: '' }, { title: '   ' }, { description: 'בלי כותרת' }]) {
    const r = await call('POST', '/api/tasks', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'נדרשת כותרת למשימה');
  }
});

test('יצירה עם סטטוס שאינו קיים בבורד — 400', async () => {
  const r = await call('POST', '/api/tasks', { title: 'x', status: 'waiting_forever' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'סטטוס לא קיים בבורד זה');
});

test('יצירה בבורד שאינו קיים — 400', async () => {
  const r = await call('POST', '/api/tasks', { title: 'x', boardId: 99999 });
  assert.equal(r.status, 400);
});

test('יצירה עם ספק שאין לו בורד — 400', async () => {
  const r = await call('POST', '/api/tasks', { title: 'x', assigneeType: 'vendor', assigneeId: 424242 });
  assert.equal(r.status, 400);
});

test('יצירה עם משימת-אב שאינה קיימת — 404', async () => {
  const r = await call('POST', '/api/tasks', { title: 'x', parentTaskId: 987654 });
  assert.equal(r.status, 404);
});

test('יצירה עם גוף שאינו JSON — 400', async () => {
  const r = await call('POST', '/api/tasks', 'title=abc');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'גוף הבקשה אינו JSON תקין');
});

test('יצירה, קריאה ועדכון בלי התחברות — 401', async () => {
  assert.equal((await srv.api('POST', '/api/tasks', { body: { title: 'x' } })).status, 401);
  assert.equal((await srv.api('GET', '/api/tasks')).status, 401);
  const t = await create({ title: 'מוגנת' });
  assert.equal((await srv.api('GET', `/api/tasks/${t.id}`)).status, 401);
  assert.equal((await srv.api('PATCH', `/api/tasks/${t.id}`, { body: { status: 'done' } })).status, 401);
  assert.equal((await srv.api('DELETE', `/api/tasks/${t.id}`)).status, 401);
});

test('קריאת משימה לפי מזהה מחזירה את הפרטים', async () => {
  const t = await create({ title: 'לקרוא אותי' });
  const r = await call('GET', `/api/tasks/${t.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.task.id, t.id);
  assert.equal(r.json.task.title, 'לקרוא אותי');
});

test('משימה שאינה קיימת — 404 בקריאה, בעדכון ובמחיקה', async () => {
  assert.equal((await call('GET', '/api/tasks/999999')).status, 404);
  assert.equal((await call('PATCH', '/api/tasks/999999', { status: 'done' })).status, 404);
  assert.equal((await call('DELETE', '/api/tasks/999999')).status, 404);
  assert.equal((await call('GET', '/api/tasks/not-a-number')).status, 404);
});

test('שינוי סטטוס: חדש ← בטיפול ← הושלם, עם מועד השלמה', async () => {
  const t = await create({ title: 'זרימת סטטוס' });
  const a = await call('PATCH', `/api/tasks/${t.id}`, { status: 'in_progress' });
  assert.equal(a.status, 200);
  assert.equal(a.json.task.status, 'in_progress');
  assert.equal(a.json.task.isFinal, false);
  assert.equal(a.json.task.completedAt, null);

  const b = await call('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
  assert.equal(b.status, 200);
  assert.equal(b.json.task.status, 'done');
  assert.equal(b.json.task.isFinal, true);
  assert.ok(b.json.task.completedAt, 'מועד ההשלמה נרשם');

  // פתיחה מחדש מנקה את מועד ההשלמה
  const c = await call('PATCH', `/api/tasks/${t.id}`, { status: 'in_progress' });
  assert.equal(c.json.task.completedAt, null);
});

test('שינוי לסטטוס שאינו קיים — 400, והמשימה לא משתנה', async () => {
  const t = await create({ title: 'סטטוס שגוי' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, { status: 'teleported' });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).json.task.status, 'new');
});

test('לא ניתן לסגור משימה שתלויה במשימה פתוחה — 400', async () => {
  const dep = await create({ title: 'קודם זו' });
  const t = await create({ title: 'ואחר כך זו', dependsOnTaskId: dep.id });
  assert.equal(t.dependency.id, dep.id);
  assert.equal(t.dependency.blocking, true);

  const blocked = await call('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, /תלויה/);

  await call('PATCH', `/api/tasks/${dep.id}`, { status: 'done' });
  const ok = await call('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.task.isFinal, true);
});

test('עריכת שדות: כותרת, תיאור, עדיפות ותאריך יעד', async () => {
  const t = await create({ title: 'לפני' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, { title: ' אחרי ', description: 'חדש', priority: 'high', dueDate: '2027-01-15', statusShort: 'ממתין לספק' });
  assert.equal(r.status, 200);
  assert.equal(r.json.task.title, 'אחרי');
  assert.equal(r.json.task.description, 'חדש');
  assert.equal(r.json.task.priority, 'high');
  assert.equal(r.json.task.dueDate, '2027-01-15');
  assert.equal(r.json.task.statusShort, 'ממתין לספק');

  // ניקוי תאריך היעד
  const cleared = await call('PATCH', `/api/tasks/${t.id}`, { dueDate: '' });
  assert.equal(cleared.json.task.dueDate, null);
});

test('עדכון עם גוף שאינו JSON — 400', async () => {
  const t = await create({ title: 'גוף שבור' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, '{status:');
  assert.equal(r.status, 400);
});

test('הרשימה מחזירה משימה חדשה, ומסננת לפי סטטוס, עדיפות וחיפוש', async () => {
  const marker = `סמן-${Date.now()}`;
  const a = await create({ title: `${marker} אלפא`, priority: 'low' });
  const b = await create({ title: `${marker} בטא`, priority: 'high' });
  await call('PATCH', `/api/tasks/${b.id}`, { status: 'in_progress' });

  const all = await call('GET', '/api/tasks');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.json.tasks));
  const ids = all.json.tasks.map((t) => t.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));

  const q = await listIds(`?q=${encodeURIComponent(marker)}`);
  assert.deepEqual(q.sort(), [a.id, b.id].sort());

  const inProgress = await listIds(`?q=${encodeURIComponent(marker)}&status=in_progress`);
  assert.deepEqual(inProgress, [b.id]);

  const low = await listIds(`?q=${encodeURIComponent(marker)}&priority=low`);
  assert.deepEqual(low, [a.id]);
});

test('סדר ברירת המחדל ברשימה: דחוף לפני רגילה לפני נמוכה', async () => {
  const marker = `סדר-${Date.now()}`;
  const low = await create({ title: `${marker} 1`, priority: 'low' });
  const urgent = await create({ title: `${marker} 2`, priority: 'urgent' });
  const normal = await create({ title: `${marker} 3`, priority: 'normal' });
  assert.deepEqual(await listIds(`?q=${encodeURIComponent(marker)}`), [urgent.id, normal.id, low.id]);
});

test('משימה מתוזמנת לעתיד אינה ברשימה הרגילה, ומופיעה עם includeScheduled=1', async () => {
  const t = await create({ title: 'בעתיד', activateAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(t.scheduled, true);
  assert.ok(!(await listIds()).includes(t.id));
  assert.ok((await listIds('?includeScheduled=1')).includes(t.id));
});

test('ארכיון: משימה בארכיון יוצאת מהרשימה ומופיעה ב-archived=1, וחוזרת', async () => {
  const t = await create({ title: 'לארכיון' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, { archived: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.task.archived, true);
  assert.ok(!(await listIds()).includes(t.id));
  assert.ok((await listIds('?archived=1')).includes(t.id));

  await call('PATCH', `/api/tasks/${t.id}`, { archived: false });
  assert.ok((await listIds()).includes(t.id));
});

test('מחיקה — 200, ואחריה המשימה לא קיימת', async () => {
  const t = await create({ title: 'למחיקה' });
  const r = await call('DELETE', `/api/tasks/${t.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/tasks/${t.id}`)).status, 404);
  assert.ok(!(await listIds('?archived=1')).includes(t.id));
});

test('פעולת אצווה: שינוי סטטוס לכמה משימות, ושגיאה למשימה שאינה קיימת', async () => {
  const a = await create({ title: 'אצווה 1' });
  const b = await create({ title: 'אצווה 2' });
  const r = await call('POST', '/api/tasks/bulk', { ids: [a.id, b.id, 777777], action: 'status', value: 'in_progress' });
  assert.equal(r.status, 200);
  assert.equal(r.json.affected, 2);
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].id, 777777);
  for (const id of [a.id, b.id]) assert.equal((await call('GET', `/api/tasks/${id}`)).json.task.status, 'in_progress');
});

test('פעולת אצווה בלי משימות — 400; פעולה לא מוכרת — שגיאה לכל משימה', async () => {
  assert.equal((await call('POST', '/api/tasks/bulk', { ids: [], action: 'status', value: 'done' })).status, 400);
  assert.equal((await call('POST', '/api/tasks/bulk', { action: 'status' })).status, 400);
  const t = await create({ title: 'אצווה מוזרה' });
  const r = await call('POST', '/api/tasks/bulk', { ids: [t.id], action: 'explode' });
  assert.equal(r.status, 200);
  assert.equal(r.json.affected, 0);
  assert.equal(r.json.errors[0].message, 'פעולת אצווה לא מוכרת');
});

test('פעולת אצווה: מחיקה', async () => {
  const t = await create({ title: 'אצווה למחיקה' });
  const r = await call('POST', '/api/tasks/bulk', { ids: [t.id], action: 'delete' });
  assert.equal(r.json.affected, 1);
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).status, 404);
});

test('תגובה ריקה — 400; תגובה עם טקסט נשמרת במשימה', async () => {
  const t = await create({ title: 'עם תגובות' });
  assert.equal((await call('POST', `/api/tasks/${t.id}/comments`, { body: '   ' })).status, 400);
  const r = await call('POST', `/api/tasks/${t.id}/comments`, { body: 'עדכון ראשון' });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  const details = (await call('GET', `/api/tasks/${t.id}`)).json.task;
  assert.ok(JSON.stringify(details).includes('עדכון ראשון'));
});

test('ייצוא CSV כולל את המשימות', async () => {
  const t = await create({ title: 'לייצוא CSV' });
  const r = await call('GET', '/api/export/tasks.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(r.text.includes('לייצוא CSV'));
  assert.ok(r.text.includes(`"${t.id}"`));
});

test('יצירה עם עדיפות לא מוכרת — 400 (לא 500 מאילוץ במסד)', async () => {
  const r = await call('POST', '/api/tasks', { title: 'x', priority: 'super-urgent' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, 'עדיפות לא מוכרת');
});

test('עדכון לעדיפות לא מוכרת — 400, והעדיפות לא משתנה', async () => {
  const t = await create({ title: 'עדיפות שגויה', priority: 'high' });
  for (const priority of ['bogus', '', null]) {
    const r = await call('PATCH', `/api/tasks/${t.id}`, { priority });
    assert.equal(r.status, 400, `${JSON.stringify(priority)}: ${r.text}`);
  }
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).json.task.priority, 'high');
});

test('עדכון לכותרת ריקה — 400, והכותרת לא משתנה', async () => {
  const t = await create({ title: 'כותרת קיימת' });
  for (const title of ['', '   ']) {
    const r = await call('PATCH', `/api/tasks/${t.id}`, { title });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, 'נדרשת כותרת למשימה');
  }
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).json.task.title, 'כותרת קיימת');
});

test('סוג אחראי לא מוכר — 400 ביצירה ובעדכון', async () => {
  const c = await call('POST', '/api/tasks', { title: 'x', assigneeType: 'robot', assigneeId: 1 });
  assert.equal(c.status, 400, c.text);
  assert.equal(c.json.error, 'סוג אחראי לא מוכר');
  const t = await create({ title: 'אחראי מוזר' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, { assigneeType: 'robot', assigneeId: 1 });
  assert.equal(r.status, 400, r.text);
});

test('סוג אחראי ריק — מותר (בלי אחראי)', async () => {
  const t = await create({ title: 'בלי אחראי', assigneeType: '' });
  assert.equal(t.assigneeId ?? null, null);
});

test('תאריך יעד לא תקין — 400 ביצירה ובעדכון, ולא נשמר', async () => {
  const c = await call('POST', '/api/tasks', { title: 'x', dueDate: 'מחר בבוקר' });
  assert.equal(c.status, 400, c.text);
  assert.equal(c.json.error, 'תאריך יעד לא תקין');
  const t = await create({ title: 'תאריך שגוי', dueDate: '2026-12-01' });
  const r = await call('PATCH', `/api/tasks/${t.id}`, { dueDate: 'not-a-date' });
  assert.equal(r.status, 400, r.text);
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).json.task.dueDate, '2026-12-01');
  const csv = await call('GET', '/api/export/tasks.csv');
  assert.doesNotMatch(csv.text, /NaN/);
});

test('פעולת אצווה: עדיפות לא מוכרת — 400, ושום משימה לא משתנה', async () => {
  const t = await create({ title: 'אצווה עדיפות', priority: 'low' });
  const r = await call('POST', '/api/tasks/bulk', { ids: [t.id], action: 'priority', value: 'bogus' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, 'עדיפות לא מוכרת');
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).json.task.priority, 'low');
  const ok = await call('POST', '/api/tasks/bulk', { ids: [t.id], action: 'priority', value: 'urgent' });
  assert.equal(ok.json.affected, 1);
});

test('גוף JSON שאינו אובייקט (null, מספר, מחרוזת) — 400 ביצירה ובעדכון', async () => {
  const t = await create({ title: 'גוף null' });
  for (const raw of ['null', '7', '"x"']) {
    assert.equal((await call('POST', '/api/tasks', raw)).status, 400, raw);
    assert.equal((await call('PATCH', `/api/tasks/${t.id}`, raw)).status, 400, raw);
  }
});

test('כתובת בקידוד אחוזים שבור — 400', async () => {
  assert.equal((await call('GET', '/api/tasks/%E0%A4%A')).status, 400);
});

test('השרת לא נפל, לא החזיר 500 ולא ניסה לפנות לרשת במהלך הבדיקות', () => {
  assert.equal(srv.exited(), null);
  assert.doesNotMatch(srv.output(), /שרת הבדיקה ניסה לפנות לרשת/);
  assert.doesNotMatch(srv.output(), /שגיאת שרת/);
});
