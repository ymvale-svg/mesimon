'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const Bot = require('../../../server/ai/wa-bot');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });
const X = Bot._internal;

test('YES — כן, מאשר, 👍 ו-✅; לא — לא', () => {
  for (const t of ['כן', 'כן, תודה', 'מאשר', 'סבבה!', '👍', '✅', 'OK', 'תפתח']) assert.ok(X.YES.test(t), t);
  for (const t of ['לא', 'כנראה', 'אולי כן', '']) assert.ok(!X.YES.test(t), t);
});

test('splitMessage — קצרה נשארת אחת', () => {
  assert.deepEqual(X.splitMessage('שלום'), ['שלום']);
  assert.deepEqual(X.splitMessage(null), ['']);
});

test('splitMessage — מתפצלת בין פסקאות, כל חלק עד המקסימום', () => {
  const paras = Array.from({ length: 10 }, (_, i) => `פסקה ${i} `.repeat(10).trim());
  const text = paras.join('\n\n');
  const parts = X.splitMessage(text, 200);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 200, p.length);
  assert.equal(parts.join('\n\n'), text, 'שום פסקה לא אבדה');
});

test('splitMessage — פסקה ארוכה מתפצלת בין שורות', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `שורה מספר ${i}`);
  const parts = X.splitMessage(lines.join('\n'), 60);
  for (const p of parts) assert.ok(p.length <= 60);
  assert.deepEqual(parts.join('\n').split('\n'), lines);
});

test('parseSuggestionCommand — אשר ודחה עם אותיות', () => {
  assert.deepEqual(X.parseSuggestionCommand('אשר א'), { approve: true, letters: ['א'] });
  assert.deepEqual(X.parseSuggestionCommand('תאשרי את ב ו-ג'), { approve: true, letters: ['ב', 'ג'] });
  assert.deepEqual(X.parseSuggestionCommand('דחה א, ב'), { approve: false, letters: ['א', 'ב'] });
  assert.deepEqual(X.parseSuggestionCommand("דחי ג'"), { approve: false, letters: ['ג'] });
  assert.deepEqual(X.parseSuggestionCommand('אשר א וא'), { approve: true, letters: ['א'] }, 'בלי כפילויות');
});

test('parseSuggestionCommand — לא פקודה: null', () => {
  for (const t of ['אשר', 'אשר את המשימה', 'אשר ו', 'אשר 2', 'בבקשה אשר א', '', null]) assert.equal(X.parseSuggestionCommand(t), null, String(t));
});

test('sourceOf — מה שנכתב במפורש גובר על ה-AI', () => {
  assert.equal(X.sourceOf('google', 'מה הטלפון של דני מהאלפון'), 'phonebook');
  assert.equal(X.sourceOf('phonebook', 'דני מגוגל'), 'google');
  assert.equal(X.sourceOf('any', 'דני מאנשי הקשר בגוגל'), 'google');
  assert.equal(X.sourceOf('google', 'דני'), 'google');
  assert.equal(X.sourceOf('nope', 'דני'), 'any');
});

test('sanitizeGroup — רק עובדים מהרשימה, אינדקס בטווח, כותרת חובה', () => {
  const users = [{ id: 1, full_name: 'שושנה' }, { id: 2, full_name: 'אבי' }];
  const out = X.sanitizeGroup({ tasks: [
    { message_index: 1, title: ' לפנות ליועץ ', assignee_user_id: 1, co_assignee_ids: [1, 2, 2, 9], requester_user_id: 2, priority: 'x', due_date: '2026-11-12' },
    { message_index: 5, title: 'מחוץ לטווח' },
    { message_index: 2, title: '  ' },
    { message_index: 2, title: 'בלי אחראי', assignee_user_id: 9 }
  ], insights: [{ message_index: 1, insight: 'מידע' }, { message_index: 1, insight: ' ' }, { message_index: 0, insight: 'x' }] }, users, 2);
  assert.equal(out.tasks.length, 2);
  const [a, b] = out.tasks;
  assert.equal(a.title, 'לפנות ליועץ');
  assert.equal(a.assignee, 1);
  assert.deepEqual(a.people.map((p) => p.userId), [2]);
  assert.deepEqual(a.requester, { id: 2, name: 'אבי' });
  assert.equal(a.priority, 'normal');
  assert.equal(a.dueDate, '2026-11-12');
  assert.equal(b.assignee, 0);
  assert.equal(out.insights.length, 1);
  assert.equal(out.warning, '');
});

const emptyToday = () => ({ dateLabel: 'יום שלישי, 10.11', calendar: { events: [] }, tasks: { overdue: [], today: [] }, counts: { meetings: 0, overdue: 0 }, suggestions: { heading: 'הצעות', items: [] } });

test('todayMessage — יום ריק', () => {
  const r = X.todayMessage(emptyToday());
  assert.match(r.text, /^☀️ \*היום — יום שלישי, 10\.11\*/);
  assert.ok(r.text.includes('אין לך משהו מתוכנן להיום'));
  assert.deepEqual(r.ids, []);
  assert.deepEqual(r.suggestions, []);
});

test('todayMessage — משימות ממוספרות, באיחור קודם, והצעות באותיות', () => {
  const t = emptyToday();
  t.tasks.today = [{ id: 11, title: 'להתקשר', projectName: 'מגדל' }];
  t.tasks.overdue = [{ id: 10, title: 'לשלוח הצעה', dueDate: '2026-11-01T15:00:00Z' }];
  t.counts.overdue = 1;
  t.suggestions.items = [
    { id: 100, data: { title: 'לבדוק חשבונית' }, origin: { icon: '📧', label: 'מייל' } },
    { id: 101, subject: 'פגישה', origin: { icon: '💬', label: 'וואטסאפ' } },
    { id: 102, older: true, origin: { icon: '📧', label: 'מייל' } }
  ];
  const r = X.todayMessage(t, new Date('2026-11-10T08:00:00Z'));
  assert.deepEqual(r.ids, [10, 11]);
  assert.deepEqual(r.suggestions, [100, 101]);
  assert.ok(r.text.includes('📋 *משימות* (2, מהן 1 באיחור):'));
  assert.ok(r.text.includes('1. לשלוח הצעה · ⚠️ 1.11'));
  assert.ok(r.text.includes('2. להתקשר · 📁 מגדל'));
  assert.ok(r.text.includes('א. לבדוק חשבונית — 📧 מייל'));
  assert.ok(r.text.includes('ב. פגישה — 💬 וואטסאפ'));
  assert.ok(r.text.includes('עוד הצעה ישנה אחת מחכה'));
  assert.ok(r.text.includes('לאשר: "אשר א" · לדחות: "דחה ב"'));
});

test('todayMessage — אירוע שהסתיים לא מוצג; יותר מ-15 משימות — "ועוד"', () => {
  const t = emptyToday();
  t.calendar.events = [
    { title: 'עבר', start: '2026-11-10T05:00:00Z', end: '2026-11-10T06:00:00Z' },
    { title: 'בהמשך', start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' },
    { title: 'חג', allDay: true }
  ];
  t.tasks.today = Array.from({ length: 18 }, (_, i) => ({ id: i + 1, title: `משימה ${i}` }));
  const r = X.todayMessage(t, new Date('2026-11-10T08:00:00Z'));
  assert.ok(!r.text.includes('עבר'));
  assert.ok(r.text.includes('📅 *ביומן* (2):'));
  assert.ok(r.text.includes('• 14:00 בהמשך'));
  assert.ok(r.text.includes('• כל היום חג'));
  assert.equal(r.ids.length, 15);
  assert.ok(r.text.includes('ועוד 3 — באפליקציה.'));
});

test('userByPhone ו-resolveMentions — תיוג מוחלף בשם העובד', () => {
  const u = user({ full_name: 'שושנה חן', phone: '972541234567' });
  assert.equal(Bot.userByPhone('054-1234567').id, u.id);
  assert.equal(Bot.userByPhone('abc'), null);
  assert.equal(X.resolveMentions('@972541234567 בבקשה, וגם @972500000000'), '@שושנה חן בבקשה, וגם @972500000000');
});

test('userByPhone — ספק ועובד לא פעיל לא מזוהים', () => {
  user({ phone: '972541110000', role: 'vendor' });
  user({ phone: '972541110001', status: 'inactive' });
  assert.equal(Bot.userByPhone('0541110000'), null);
  assert.equal(Bot.userByPhone('0541110001'), null);
});

test('chatOf / saveChat — שמירה וקריאה, היסטוריה מקוצרת ל-8', () => {
  const u = user();
  assert.deepEqual(X.chatOf(u.id), { draft: null, awaiting: false, history: [], lastList: [], greetedOn: '', insights: [], suggestions: [], queue: [] });
  const history = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: String(i) }));
  X.saveChat(u.id, { draft: { kind: 'x' }, awaiting: true, history, lastList: [5, 6], greetedOn: '2026-11-10', insights: ['g1'], queue: ['עוד'], suggestions: [1] });
  const c = X.chatOf(u.id);
  assert.deepEqual(c.draft, { kind: 'x' });
  assert.equal(c.awaiting, true);
  assert.equal(c.history.length, 8);
  assert.equal(c.history[0].text, '4');
  assert.deepEqual([c.lastList, c.insights, c.queue, c.suggestions, c.greetedOn], [[5, 6], ['g1'], ['עוד'], [1], '2026-11-10']);
});

test('draftText — טיוטה עם אחראי, פרויקט, עדיפות ואזהרות', () => {
  const me = user({ full_name: 'אני' });
  const other = user({ full_name: 'דנה לוי' });
  const txt = X.draftText({ title: 'לבדוק לוח', summary: 'בקומה 2', assigneeId: other.id, dueDate: '', projectId: 0, priority: 'urgent', checklist: ['א', 'ב'], warnings: ['שימו לב'] }, me);
  assert.ok(txt.startsWith('📝 *לבדוק לוח*\nבקומה 2'));
  assert.ok(txt.includes('👤 אחראי/ת: דנה לוי'));
  assert.ok(txt.includes('📅 יעד: ללא'));
  assert.ok(txt.includes('📁 פרויקט: ללא'));
  assert.ok(txt.includes('⚡ עדיפות: דחוף'));
  assert.ok(txt.includes('☑ 1. א\n2. ב'));
  assert.ok(txt.includes('⚠️ שימו לב'));
  assert.ok(txt.endsWith('לפתוח? השיבו *כן*, או כתבו מה לתקן.'));
  const mine = X.draftText({ title: 'x', assigneeId: me.id, priority: 'normal' }, me);
  assert.ok(mine.includes('👤 אחראי/ת: את/ה'));
  assert.ok(!mine.includes('עדיפות'));
});

test('draftText — סעיפי תבנית קודם, בלי כפילויות', () => {
  const me = user();
  const txt = X.draftText({ title: 'x', priority: 'normal', templateId: 3, templateName: 'קבלת דירה', templateChecklist: ['מפתחות', 'מונים'], checklist: ['מונים', 'צילום'] }, me);
  assert.ok(txt.includes('📋 תבנית: קבלת דירה'));
  assert.ok(txt.includes('☑ 1. מפתחות\n2. מונים\n3. צילום'));
});

test('inHours — שבת: משישי 15:00 עד מוצאי שבת 20:30', () => {
  D.setSetting('wa_shabbat', true);
  D.setSetting('wa_hours', '');
  assert.equal(Bot.inHours(new Date('2026-11-13T12:00:00Z')), true, 'שישי 14:00');
  assert.equal(Bot.inHours(new Date('2026-11-13T14:00:00Z')), false, 'שישי 16:00');
  assert.equal(Bot.inHours(new Date('2026-11-14T17:00:00Z')), false, 'שבת 19:00');
  assert.equal(Bot.inHours(new Date('2026-11-14T19:00:00Z')), true, 'מוצ"ש 21:00');
  D.setSetting('wa_shabbat', false);
  assert.equal(Bot.inHours(new Date('2026-11-14T17:00:00Z')), true);
  D.setSetting('wa_shabbat', true);
});

test('inHours — חלון שעות, גם כזה שחוצה חצות', () => {
  D.setSetting('wa_hours', '08:00-18:00');
  assert.equal(Bot.inHours(new Date('2026-11-10T05:00:00Z')), false, '07:00');
  assert.equal(Bot.inHours(new Date('2026-11-10T08:00:00Z')), true, '10:00');
  D.setSetting('wa_hours', '22:00-06:00');
  assert.equal(Bot.inHours(new Date('2026-11-10T21:00:00Z')), true, '23:00');
  assert.equal(Bot.inHours(new Date('2026-11-10T10:00:00Z')), false, '12:00');
  D.setSetting('wa_hours', '');
});

test('logoIntent — "לוגו" בלי קובץ: מחכים לקובץ; הודעה רגילה — null', () => {
  const u = user();
  assert.equal(X.logoIntent(u.id, {}, 'שלום'), null);
  assert.deepEqual(X.logoIntent(u.id, {}, 'לוגו של אשל'), { arm: true });
  const next = X.logoIntent(u.id, { file: { mime: 'image/png', buf: Buffer.from([0x89, 0x50]) } }, '');
  assert.equal(next.name, 'אשל');
  assert.equal(typeof next.load, 'function');
});

test('businessCommand — בלי סריקה אישית ובלי שאלה פתוחה: null', () => {
  const u = user();
  assert.equal(X.businessCommand({ id: u.id }, 'דני עסקי', { dry: true, out: () => 'x' }), null);
});

test('isConfigured — בלי חיבור לבוט: לא', () => {
  Bot.remove();
  assert.equal(Bot.isConfigured(), false);
});
