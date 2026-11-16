'use strict';
/**
 * 🎙 הקלטת פגישה מוואטסאפ — אחרי הסיכום (באג 15.11.26: גולן קיבל רק טיוטה עם כותרות הנושאים,
 * וכל המשימות יצאו "בלי אחראי"):
 *   • "📤 לשלוח למשתתפים" — כל הסיכום (נושאים, החלטות, משימות לפי אחראי) במייל למשתתפים שבהקלטה.
 *   • הבוט לא מציע לפתוח משימות (16.11.26): המשימות — הצעות ב"ממתין לאישורך", כל אחת אצל האחראי שלה.
 *   • "שלח לגולן את הסיכום" — הסיכום המלא, לא נוסח שה-AI כותב מהמילים של הבקשה.
 *   • "2, 5 לגולן" — שינוי אחראי; ההצעה במשימון עוברת אליו.
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
const Suggestions = require('../../../server/meetings/meeting-suggestions');
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

test('parseReassign — "2, 5 לגולן", "1-3 לי", "1 ו-3 אצל גולן", "השאר לישראל"; לא: "רק 1 ו-3", "כן"', () => {
  const p = MeetingAudio.parseReassign;
  assert.deepEqual(p('2, 5 לגולן'), { nums: [2, 5], name: 'גולן' });
  assert.deepEqual(p('1-3 לי'), { nums: [1, 2, 3], name: 'י' });
  assert.deepEqual(p('1 ו-3 אצל גולן'), { nums: [1, 3], name: 'גולן' });
  assert.deepEqual(p('משימה 4 לישראל'), { nums: [4], name: 'ישראל' });
  assert.deepEqual(p('השאר לישראל'), { nums: null, name: 'ישראל' });
  assert.deepEqual(p('כל השאר לי'), { nums: null, name: 'י' });
  for (const s of ['רק 1 ו-3', 'כן', '1 ו-3', 'לפתוח משימות ✅']) assert.equal(p(s), null, s);
});

test('בסוף הסיכום: לשלוח את כל הסיכום לגולן / לשנות אחראי — בלי "לפתוח משימות"', (t) => {
  const { meeting, dig, actor, golan } = setup(t);
  const q = MeetingAudio.nextQuestion(meeting, dig, actor);
  assert.match(q, /לשלוח את כל הסיכום.*במייל ל/);
  assert.ok(q.includes(golan.full_name));
  assert.match(q, /לשנות אחראי/);
  assert.doesNotMatch(q, /לפתוח/);
  assert.deepEqual(MeetingAudio.nextButtons(meeting, dig, actor), ['📤 לשלוח למשתתפים', '✏️ לשנות אחראי']);
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

test('"2 לגולן" — ההצעה שממתינה עוברת לגולן; "כן" לבד לא פותח משימות', async (t) => {
  const { me, golan, actor, draft, audioId, dig } = setup(t);
  MeetingAudio.suggestFor(actor, audioId, 'פגישה שבועית', dig);
  const state = { ...Bot._internal.chatOf(me.id), draft, awaiting: true };
  const r = await Bot._internal.converse(me, actor, '2 לגולן', state);
  assert.match(r.reply, /משימה 2 עברה/);
  assert.equal(D.get('SELECT user_id FROM ai_suggestions WHERE header_id = ?', Suggestions.headerOf('wa', audioId, 2)).user_id, golan.id);
  assert.deepEqual(r.buttons, ['📤 לשלוח למשתתפים', '✏️ לשנות אחראי']);
  let opened = 0;
  t.after(withHook('createTask', () => ++opened));
  await Bot._internal.converse(me, actor, 'כן', { ...state, draft: r.next.draft, awaiting: true });
  assert.equal(opened, 0);
});

test('משימות בלי אחראי — בסוף, תחת "עוד בלי אחראי" (לא "👤 בלי אחראי" כאילו זה משתתף)', (t) => {
  const { dig } = setup(t);
  const text = MeetingAudio._internal.tasksText(dig);
  assert.match(text, /❓ \*עוד בלי אחראי\*/);
  assert.doesNotMatch(text, /👤 \*בלי אחראי\*/);
});

test('"2, 3 לגולן" ו"השאר לי" — האחראי נשמר בסיכום, והמשימות מוצגות לפי אחראי', async (t) => {
  const { me, golan, actor, draft, audioId } = setup(t);
  const state = { ...Bot._internal.chatOf(me.id), draft, awaiting: true };
  const r1 = await Bot._internal.converse(me, actor, '2, 3 לגולן', state);
  assert.match(r1.reply, /משימות 2, 3 עברו/);
  assert.ok(r1.reply.includes(`👤 *${golan.full_name}*`));
  assert.equal(r1.next.draft.kind, 'meeting_audio_tasks');
  const r2 = await Bot._internal.converse(me, actor, 'השאר לי', { ...state, draft: r1.next.draft });
  assert.match(r2.reply, /משימה 1 עברה/);
  const dig = JSON.parse(D.get('SELECT digest FROM meeting_audio WHERE id = ?', audioId).digest);
  assert.deepEqual(dig.items.map((it) => it._ownerId), [me.id, golan.id, golan.id]);
  const shared = JSON.parse(D.get("SELECT data FROM meeting_digests WHERE source = 'wa' AND ref = ?", String(audioId)).data);
  assert.equal(shared.items[1].owner_name, golan.full_name);
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
