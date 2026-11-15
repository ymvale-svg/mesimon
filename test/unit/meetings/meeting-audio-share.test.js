'use strict';
/**
 * 🎙 הקלטת פגישה מוואטסאפ — אחרי הסיכום (באג 15.11.26: גולן קיבל רק טיוטה עם כותרות הנושאים,
 * וכל המשימות יצאו "בלי אחראי"):
 *   • "📤 לשלוח למשתתפים" — כל הסיכום (נושאים, החלטות, משימות לפי אחראי) במייל למשתתפים שבהקלטה,
 *     ואחר כך חוזרים לשאלה "לפתוח את המשימות?".
 *   • "שלח לגולן את הסיכום" — הסיכום המלא, לא נוסח שה-AI כותב מהמילים של הבקשה.
 *   • "2, 5 לגולן" — שינוי אחראי לפני שפותחים.
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

boot();

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

test('השאלה שבסוף: לפתוח / לשלוח את כל הסיכום לגולן / לשנות אחראי — והכפתורים', (t) => {
  const { meeting, dig, actor, golan } = setup(t);
  const q = MeetingAudio.nextQuestion(meeting, dig, actor);
  assert.match(q, /לשלוח את כל הסיכום.*במייל ל/);
  assert.ok(q.includes(golan.full_name));
  assert.match(q, /לשנות אחראי/);
  assert.deepEqual(MeetingAudio.nextButtons(meeting, dig, actor), ['לפתוח משימות ✅', '📤 לשלוח למשתתפים', 'לא ❌']);
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

test('"📤 לשלוח למשתתפים" — כל הסיכום לגולן (מהמשתתפים בהקלטה, בלי יומן), ואחרי "כן" — חוזרים ל"לפתוח את המשימות?"', async (t) => {
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
  assert.match(yes.reply, /לפתוח את המשימות/);
  assert.equal(yes.next.draft.kind, 'meeting_audio_tasks');
  assert.deepEqual(yes.buttons, ['לפתוח משימות ✅', 'לא ❌']);
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
