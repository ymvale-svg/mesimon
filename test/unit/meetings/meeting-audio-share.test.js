'use strict';
/**
 * 🎙 הקלטת פגישה מוואטסאפ — אחרי הסיכום (באג 15.11.26: גולן קיבל רק טיוטה עם כותרות הנושאים,
 * וכל המשימות יצאו "בלי אחראי"):
 *   • "📤 לשלוח למשתתפים" — כל הסיכום (נושאים, החלטות, משימות לפי אחראי) במייל למשתתפים שבהקלטה.
 *   • הבוט לא מציע לפתוח משימות (16.11.26): המשימות — הצעות ב"ממתין לאישורך", כל אחת אצל האחראי שלה.
 *   • "שלח לגולן את הסיכום" — הסיכום המלא, לא נוסח שה-AI כותב מהמילים של הבקשה.
 *   • המשימות של השולח עצמו — "☑️ משימה + צ'קליסט" / "📌 משימות נפרדות" (26.11.26; שינוי אחראי — הוסר).
 * בלי רשת: Gmail מזויף, והסיכום כבר שמור (‎meeting_audio‎ / ‎meeting_digests‎).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Gmail = require('../../../server/integrations/gmail');
const Followup = require('../../../server/meetings/meeting-followup');
const MeetingAudio = require('../../../server/meetings/meeting-audio');
const Bot = require('../../../server/whatsapp/wa-bot');
const MailScan = require('../../../server/mail/mail-scan');

boot();

/** משימה אמיתית במסד (ל-‎task_id‎ של ההצעה) */
const realTask = (title = 'משימה') => Number(D.run("INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at) VALUES (?,?,'new',0,0,?,?)",
  title, D.internalBoard().id, D.nowIso(), D.nowIso()).lastInsertRowid);
const WaBase = require('../../../server/whatsapp/wa-base');

/** ‎hooks‎ של הבוט — מחליפים לבדיקה ומחזירים אחריה */
function withHook(name, fn) {
  const old = WaBase.hooks[name];
  WaBase.hooks[name] = fn;
  return () => { WaBase.hooks[name] = old; };
}

let seq = 0;
function setup(t, { owned = false } = {}) {
  seq += 1;
  const me = user({ role: 'employee', full_name: `ישראל וייל${seq}`, email: `israel${seq}@corp.test` });
  const golan = user({ role: 'employee', full_name: `גולן ברזילי${seq}`, email: `golan${seq}@corp.test` });
  const meeting = {
    source: 'calendar', ref: `ev${seq}`, title: 'פגישה שבועית גולן/ישראל', start: '2026-11-15T07:30:00.000Z', end: '2026-11-15T08:30:00.000Z',
    taskId: null, people: [{ email: golan.email, name: golan.full_name }, { email: me.email, name: me.full_name }]
  };
  const items = [
    { task: 'לבנות רשימת תיוג לפתיחת אתר', owner_name: '', owner_email: '', due: '' },
    { task: 'לקבוע ישיבת התארגנות אתר', owner_name: '', owner_email: '', due: '2026-11-18' },
    { task: 'לגייס מנהל לוגיסטיקה', owner_name: '', owner_email: '', due: '' }
  ].map((it) => (owned ? { ...it, owner_name: golan.full_name, owner_email: golan.email, _ownerId: golan.id, _ownerName: golan.full_name } : { ...it, _ownerId: null, _ownerName: '' }));
  const dig = {
    summary: ['התארגנות אתר: צריך תוכנית מסודרת', 'ציוד למשרדים: מקרר, בר מים ומיקרוגל'],
    decisions: ['מדפסת A3 אחת אצל מנהל הפרויקט'],
    items
  };
  const audioId = Number(D.run(
    "INSERT INTO meeting_audio (user_id, stored_name, filename, mime, size, status, meeting, digest, created_at) VALUES (?,?,?,?,?, 'ready', ?, ?, ?)",
    me.id, `x${seq}.ogg`, 'a.ogg', 'audio/ogg', 1, JSON.stringify(meeting), JSON.stringify(dig), D.nowIso()
  ).lastInsertRowid);
  D.run('INSERT OR REPLACE INTO meeting_digests (source, ref, data, created_at) VALUES (?,?,?,?)', 'wa', String(audioId), JSON.stringify(dig), D.nowIso());
  D.run('INSERT INTO meeting_followups (source, ref, user_id, title, start_at, end_at, data, sent_at) VALUES (?,?,?,?,?,?,?,?)',
    'wa', String(audioId), me.id, meeting.title, meeting.start, meeting.end, JSON.stringify({ taskId: null, audioId }), D.nowIso());
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(Gmail, 'connectionOf', () => ({ email: me.email, state: 'ok' }));
  t.mock.method(Gmail, 'signed', async (who, body) => body);
  const sent = [];
  t.mock.method(Gmail, 'send', async (who, raw) => { sent.push(raw); return { messageId: 'm1' }; });
  const draft = { kind: 'meeting_audio_tasks', audioId, title: meeting.title, taskId: null, n: items.length };
  return { me, golan, meeting, dig, audioId, draft, sent, actor: Auth.loadActor('user', me.id) };
}

test('בסוף הסיכום: לשלוח את כל הסיכום לגולן; בלי משימות שלי — בלי המרה, ובלי "לשנות אחראי"', (t) => {
  const { meeting, dig, actor, golan } = setup(t);
  const q = MeetingAudio.nextQuestion(meeting, dig, actor);
  assert.match(q, /לשלוח את כל הסיכום.*במייל ל/);
  assert.ok(q.includes(golan.full_name));
  assert.doesNotMatch(q, /לשנות אחראי|להמיר/);
  assert.deepEqual(MeetingAudio.nextButtons(meeting, dig, actor), ['📤 לשלוח למשתתפים']);
});

test('משימות שלי בהקלטה — "להמיר?" עם צ\'קליסט / נפרדות (רק שלי)', (t) => {
  const { me, meeting, dig, actor } = setup(t);
  dig.items[0] = { ...dig.items[0], _ownerId: me.id }; dig.items[2] = { ...dig.items[2], _ownerId: me.id };
  assert.match(MeetingAudio.nextQuestion(meeting, dig, actor), /להמיר את 2 המשימות שלך/);
  assert.deepEqual(MeetingAudio.nextButtons(meeting, dig, actor), ['📤 לשלוח למשתתפים', "☑️ משימה + צ'קליסט", '📌 משימות נפרדות']);
  dig.items[2] = { ...dig.items[2], _ownerId: null };
  assert.deepEqual(MeetingAudio.nextButtons(meeting, dig, actor), ['📤 לשלוח למשתתפים', 'לפתוח משימה ✅']);
});

test('"☑️ משימה + צ\'קליסט" בהקלטה — משימה אחת עם המשימות שלי בלבד, תת-משימה של משימת הפגישה', async (t) => {
  const { me, golan, actor, draft, audioId } = setup(t);
  const row = D.get('SELECT digest FROM meeting_audio WHERE id = ?', audioId);
  const dig = JSON.parse(row.digest);
  dig.items = dig.items.map((it, i) => ({ ...it, _ownerId: i === 1 ? golan.id : me.id }));
  D.run('UPDATE meeting_audio SET digest = ? WHERE id = ?', JSON.stringify(dig), audioId);
  MeetingAudio.suggestFor(actor, audioId, 'פגישה שבועית', dig);
  const parent = realTask('פגישה');
  const created = [];
  t.after(withHook('createTask', (a, body) => { const id = realTask(body.title); created.push(body); return id; }));
  const state = { ...Bot._internal.chatOf(me.id), draft: { ...draft, taskId: parent }, awaiting: true };
  const r = await Bot._internal.converse(me, actor, "☑️ משימה + צ'קליסט", state);
  assert.match(r.reply, /צ'קליסט של 2 פריטים/);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].checklist, ['לבנות רשימת תיוג לפתיחת אתר', 'לגייס מנהל לוגיסטיקה']);
  assert.equal(created[0].parentTaskId, parent);
  // ההצעות שלי ירדו; של גולן — נשארת אצלו
  assert.equal(D.get("SELECT COUNT(*) AS n FROM ai_suggestions WHERE header_id LIKE ? AND status = 'pending'", `meeting:wa:${audioId}:%`).n, 1);
});

test('המשימות — הצעות ב"ממתין לאישורך" אצל האחראי (בלי אחראי — אצל השולח); אישור במשימון פותח אצל האחראי', (t) => {
  const { me, golan, actor, audioId, dig } = setup(t);
  dig.items[1] = { ...dig.items[1], _ownerId: golan.id, _ownerName: golan.full_name };
  const created = [];
  MailScan.init({ createTask: (a, body) => { created.push({ a, body }); return realTask(body.title); } });
  assert.equal(MeetingAudio.suggestFor(actor, audioId, 'פגישה שבועית', dig), 3);
  assert.equal(MeetingAudio.suggestFor(actor, audioId, 'פגישה שבועית', dig), 0, 'לא מציעים פעמיים');
  const golans = D.all("SELECT * FROM ai_suggestions WHERE user_id = ? AND header_id LIKE 'meeting:wa:%'", golan.id);
  const mine = D.all("SELECT * FROM ai_suggestions WHERE user_id = ? AND header_id LIKE 'meeting:wa:%'", me.id);
  assert.equal(golans.length, 1);
  assert.equal(mine.length, 2);
  assert.match(MeetingAudio.inboxLine(audioId), /3 הצעות משימה ב"ממתין לאישורך"/);
  const gActor = Auth.loadActor('user', golan.id);
  const taskId = MailScan.approve(golans[0].id, gActor, {});
  assert.ok(taskId > 0);
  assert.equal(created[0].body.assigneeId, golan.id);
  assert.equal(created[0].body.source, 'meeting');
  assert.match(created[0].body.description, /מהמשימות של הפגישה "פגישה שבועית"/);
  assert.equal(created[0].body.title, 'לקבוע ישיבת התארגנות אתר');
});

test('משימות בלי אחראי — בסוף, תחת "עוד בלי אחראי" (לא "👤 בלי אחראי" כאילו זה משתתף)', (t) => {
  const { dig } = setup(t);
  const text = MeetingAudio._internal.tasksText(dig);
  assert.match(text, /❓ \*עוד בלי אחראי\*/);
  assert.doesNotMatch(text, /👤 \*בלי אחראי\*/);
});

test('"📤 לשלוח למשתתפים" — כל הסיכום לגולן (מהמשתתפים בהקלטה, בלי יומן), ואחרי "כן" — בלי שאלה על פתיחת משימות', async (t) => {
  const { me, golan, actor, draft, sent } = setup(t, { owned: true });
  const state = { ...Bot._internal.chatOf(me.id), draft, awaiting: true };
  const r = await Bot._internal.converse(me, actor, '📤 לשלוח למשתתפים', state);
  assert.equal(r.next.draft.kind, 'meeting_summary_mail');
  assert.deepEqual(r.next.draft.to.map((p) => p.email), [golan.email]);
  assert.match(r.next.draft.text, /על מה דיברנו:\n• התארגנות אתר/);
  assert.match(r.next.draft.text, /הוחלט:\n• מדפסת A3/);
  assert.ok(r.next.draft.text.includes(`לקבוע ישיבת התארגנות אתר — ${golan.full_name} (עד 18.11)`));
  const yes = await Bot._internal.converse(me, actor, 'כן ✅', { ...state, draft: r.next.draft, awaiting: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`^To: ${golan.email.replace('.', '\\.')}$`, 'm'));
  assert.match(yes.reply, /הסיכום נשלח/);
  assert.doesNotMatch(yes.reply, /לפתוח/);
  assert.equal(yes.next.draft, null);
});

test('"שלח לגולן את סיכום הפגישה" — הסיכום המלא לגולן; בקשה אחרת — לא', async (t) => {
  const { golan, actor } = setup(t, { owned: true });
  const contact = { name: golan.full_name, email: golan.email, type: 'user' };
  const r = await Followup.summaryRequest(actor, 'סיכום הפגישה', contact);
  assert.equal(r.draft.kind, 'meeting_summary_mail');
  assert.deepEqual(r.draft.to.map((p) => p.email), [golan.email]);
  assert.match(r.draft.text, /הוחלט:/);
  assert.match(r.draft.text, /משימות להמשך:/);
  assert.ok(await Followup.summaryRequest(actor, 'תשלח לו את הסיכום', contact));
  assert.equal(await Followup.summaryRequest(actor, 'לבקש הצעת מחיר למקרר', contact), null);
  assert.equal(await Followup.summaryRequest(actor, 'סיכום חשבוניות של אוקטובר', contact), null);
});

test('"תפתח את המשימות" במילים — נפתחות, וההצעות במשימון יורדות', async (t) => {
  const { me, actor, draft, audioId, dig } = setup(t);
  MeetingAudio.suggestFor(actor, audioId, 'פגישה שבועית', dig);
  t.after(withHook('createTask', () => realTask()));
  const state = { ...Bot._internal.chatOf(me.id), draft, awaiting: true };
  const r = await Bot._internal.converse(me, actor, 'תפתח את המשימות', state);
  assert.match(r.reply, /נפתחו 3 משימות/);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM ai_suggestions WHERE header_id LIKE ? AND status = 'pending'", `meeting:wa:${audioId}:%`).n, 0);
});

test('"משימות מהפגישה" (מי ששלח את ההקלטה) — רשימה לקריאה והפניה למשימון, בלי "לפתוח"', async (t) => {
  const { actor } = setup(t);
  const r = await Followup.answer(actor, 'משימות מהפגישה', { createTask: () => 1 });
  assert.match(r.text, /ממתין לאישורך/);
  assert.ok(!r.buttons.includes('לפתוח משימות ✅'));
  assert.doesNotMatch(r.text, /לפתוח אותן/);
});
