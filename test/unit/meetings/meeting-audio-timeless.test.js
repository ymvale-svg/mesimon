'use strict';
/**
 * 🎥 הקלטת פגישה ארוכה מוואטסאפ ← Timeless (הוחלט 18.11.26):
 *   • ארוכה (מ-‎meeting_audio_timeless_min‎, 20 דקות) — מועלית ל-Timeless, והתמליל רק משם; קצרה — התמלול שלנו.
 *   • כשהתמליל והסיכום של Timeless מוכנים — הסיכום, המשימה וההודעה לעובד (‎timelessReady‎ / ‎finishFromTimeless‎).
 *   • הסיכום שנשלח למשתתפים — הסיכום של Timeless.
 *   • במסך ההקלטות וביומן — תחילת הסיכום של Timeless (‎summary‎ ברשימה).
 * בלי רשת: ההעלאה, התמלול וה-AI מזויפים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, user, D } = require('../../helpers/db');
const Auth = require('../../../server/core/auth');
const Speech = require('../../../server/integrations/speech');
const Timeless = require('../../../server/integrations/timeless');
const Gmail = require('../../../server/integrations/gmail');
const Store = require('../../../server/meetings/timeless-store');
const MeetingAudio = require('../../../server/meetings/meeting-audio');
const Followup = require('../../../server/meetings/meeting-followup');
const Fakes = require('../../fakes');

boot();

const { oggCrc, durationSec } = MeetingAudio._internal;
const RATE = 48000;

function page(granule, seq, bodyLen) {
  const segs = [];
  for (let left = bodyLen; left > 0; left -= 255) segs.push(Math.min(255, left));
  const p = Buffer.alloc(27 + segs.length + bodyLen, 7);
  p.write('OggS', 0, 'latin1');
  p.writeBigInt64LE(BigInt(granule), 6);
  p.writeUInt32LE(99, 14);
  p.writeUInt32LE(seq, 18);
  p[26] = segs.length;
  segs.forEach((s, i) => { p[27 + i] = s; });
  p.writeUInt32LE(oggCrc(p), 22);
  return p;
}
const voiceNote = (seconds) => Buffer.concat([page(0, 0, 19), page(0, 1, 40), ...Array.from({ length: seconds }, (_, i) => page((i + 1) * RATE, i + 2, 60))]);

const DIGEST = { summary: ['דיברנו על לוח הזמנים'], decisions: ['ממשיכים'], items: [{ task: 'לשלוח הצעת מחיר', owner_name: '', owner_email: '', due: '' }] };
const TL_SUMMARY = '## סיכום\n- **הוחלט** להתקדם עם הספק\n- דנה שולחת הצעת מחיר';

let n = 0;
function setup(t, seconds) {
  n += 1;
  process.env.TIMELESS_ACCESS_TOKEN = `org-audio-${n}-${Math.random()}`;
  t.after(() => { delete process.env.TIMELESS_ACCESS_TOKEN; });
  const me = user({ role: 'employee', full_name: `עובד הקלטות${n}`, email: `rec${n}-${Date.now()}@corp.test`, phone: `9725${Date.now() % 1e7}${n}` });
  const dana = user({ role: 'employee', full_name: `דנה כהן${n}`, email: `dana${n}-${Date.now()}@corp.test` });
  const meeting = { source: 'free', ref: '', title: `פגישת ספקים ${n}`, start: new Date(Date.now() - 2 * 3600000).toISOString(), end: new Date(Date.now() - 3600000).toISOString(), taskId: null, people: [{ email: dana.email, name: dana.full_name }] };
  const dir = path.join(D.UPLOADS_DIR, 'meeting-audio');
  fs.mkdirSync(dir, { recursive: true });
  const stored = `tl-test-${n}-${Date.now()}.ogg`;
  const buf = voiceNote(seconds);
  fs.writeFileSync(path.join(dir, stored), buf);
  t.after(() => fs.rmSync(path.join(dir, stored), { force: true }));
  const audioId = Number(D.run("INSERT INTO meeting_audio (user_id, stored_name, filename, mime, size, status, meeting, created_at) VALUES (?,?,?,?,?, 'transcribing', ?, ?)",
    me.id, stored, 'a.ogg', 'audio/ogg; codecs=opus', buf.length, JSON.stringify(meeting), D.nowIso()).lastInsertRowid);
  const actor = Auth.loadActor('user', me.id);
  const tasks = [];
  const files = [];
  const deps = {
    actor,
    createTask: (a, body) => { const id = Number(D.run("INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at) VALUES (?,?,'new',0,0,?,?)", body.title, D.internalBoard().id, D.nowIso(), D.nowIso()).lastInsertRowid); tasks.push({ id, body }); return id; },
    getTask: (a, id) => ({ id }),
    saveAttachment: (task, a, f) => files.push(f.filename),
    actorRef: () => ({ type: 'user', id: me.id }),
    addComment: () => {},
    taskLink: () => null
  };
  Fakes.claude(t, () => DIGEST);
  const speech = t.mock.method(Speech, 'transcribeDetailed', async () => ({ text: 'תמלול שלנו', used: null, attempts: [], all: null }));
  return { me, dana, meeting, audioId, actor, deps, tasks, files, speech };
}

/** הפגישה ב-Timeless כפי שנשמרה (אחרי ה-webhook / הסבב) */
function storeMeeting(id, { title = 'פגישה', summary = TL_SUMMARY, transcript = true, emails = [] } = {}) {
  D.run(`INSERT OR REPLACE INTO timeless_meetings (id, title, status, start_at, end_at, duration_min, participants, emails, doc_refs, documents, transcript, synced_at)
         VALUES (?,?, 'completed', ?, ?, 45, '[]', ?, ?, ?, ?, ?)`,
  id, title, new Date(Date.now() - 3 * 3600000).toISOString(), new Date(Date.now() - 2 * 3600000).toISOString(), JSON.stringify(emails),
  JSON.stringify(summary ? [{ id: `doc_${id}`, title: 'סיכום' }] : []),
  summary ? JSON.stringify([{ id: `doc_${id}`, title: 'סיכום', markdown: summary }]) : null,
  transcript ? JSON.stringify({ language: 'he', speakers: [{ id: 's1', name: 'דנה' }], segments: [{ s: 65, e: 70, speaker: 's1', text: 'אני שולחת את הצעת המחיר מחר' }] }) : null,
  D.nowIso());
}

test('משך הודעה קולית — מהדף האחרון', () => {
  assert.equal(durationSec(voiceNote(1500)), 1500);
  assert.equal(durationSec(Buffer.from('not ogg')), null);
});

test('הקלטה ארוכה (25 דקות) — מועלית ל-Timeless, בלי תמלול שלנו; לעובד: "⏳ ב-Timeless"', async (t) => {
  const { audioId, deps, speech, meeting } = setup(t, 25 * 60);
  const uploads = [];
  t.mock.method(Timeless.org, 'upload', async (token, buf, mime, opts) => { uploads.push({ size: buf.length, mime, opts }); return 'mtg_up1'; });
  const r = await MeetingAudio.processAudio(audioId, deps);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].opts.title, meeting.title);
  assert.equal(uploads[0].opts.language, 'he');
  assert.equal(speech.mock.callCount(), 0, 'בלי תמלול שלנו');
  assert.equal(r.pending, true);
  assert.match(r.text, /Timeless/);
  assert.match(r.text, /25 דקות/);
  const row = D.get('SELECT * FROM meeting_audio WHERE id = ?', audioId);
  assert.equal(row.status, 'timeless');
  assert.equal(row.timeless_id, 'mtg_up1');
  assert.equal(row.duration_sec, 1500);
});

test('הקלטה קצרה (5 דקות) — התמלול שלנו, בלי Timeless', async (t) => {
  const { audioId, deps, speech, tasks } = setup(t, 5 * 60);
  const upload = t.mock.method(Timeless.org, 'upload', async () => 'mtg_x');
  const r = await MeetingAudio.processAudio(audioId, deps);
  assert.equal(upload.mock.callCount(), 0);
  assert.ok(speech.mock.callCount() >= 1);
  assert.ok(!r.pending);
  assert.equal(tasks.length, 1);
  assert.equal(D.get('SELECT status FROM meeting_audio WHERE id = ?', audioId).status, 'ready');
});

test('ההעלאה ל-Timeless נכשלה — לא נתקעים: התמלול שלנו', async (t) => {
  const { audioId, deps, speech } = setup(t, 25 * 60);
  t.mock.method(Timeless.org, 'upload', async () => { throw new Error('Timeless לא קיבל את ההקלטה (500)'); });
  const r = await MeetingAudio.processAudio(audioId, deps);
  assert.ok(speech.mock.callCount() >= 1);
  assert.ok(!r.pending);
  assert.equal(D.get('SELECT status FROM meeting_audio WHERE id = ?', audioId).status, 'ready');
});

test('התמליל והסיכום מוכנים ב-Timeless — ממשיכים: תמליל רק מ-Timeless, הסיכום מצורף למשימה', async (t) => {
  const { audioId, deps, speech, tasks, files, me } = setup(t, 25 * 60);
  t.mock.method(Timeless.org, 'upload', async () => `mtg_up_ready${audioId}`);
  await MeetingAudio.processAudio(audioId, deps);
  const pull = t.mock.method(Store, 'syncMeeting', async () => null);
  const mine = () => pull.mock.calls.filter((c) => c.arguments[0] === `mtg_up_ready${audioId}`).length;

  // עוד לא מוכן — לא ממשיכים. באג 18.11.26: ההקלטה לא הגיעה לשמירה המקומית (ה-webhook והסבב לא הביאו אותה),
  // ולכן שואלים עליה את Timeless ישירות — פעם אחת, ושוב רק אחרי רבע שעה
  let ready = await MeetingAudio.timelessReady();
  assert.ok(!ready.some((r) => r.id === audioId));
  assert.equal(mine(), 1);
  await MeetingAudio.timelessReady();
  assert.equal(mine(), 1, 'לא שוב מיד');
  await MeetingAudio.timelessReady(Date.now() + 16 * 60000);
  assert.equal(mine(), 2, 'אחרי רבע שעה — שוב');

  storeMeeting(`mtg_up_ready${audioId}`);
  ready = await MeetingAudio.timelessReady();
  assert.deepEqual(ready.find((r) => r.id === audioId), { id: audioId, user_id: me.id, fallback: false });

  const r = await MeetingAudio.finishFromTimeless(audioId, deps);
  assert.equal(speech.mock.callCount(), 0, 'התמליל רק מ-Timeless');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].body.description, /התמליל מ-Timeless/);
  assert.ok(files.some((f) => /סיכום Timeless/.test(f)), files.join(' · '));
  assert.ok(files.some((f) => /תמליל/.test(f)));
  assert.match(r.text, /פגישת ספקים/);
  assert.equal(D.get('SELECT status FROM meeting_audio WHERE id = ?', audioId).status, 'ready');
  assert.equal(await MeetingAudio.finishFromTimeless(audioId, deps), null, 'פעם אחת בלבד');
});

test('ההקלטה שהועלתה — מי ששלח אותה (עובד) רואה אותה ב-Timeless; ובמסך — תחילת הסיכום של Timeless', async (t) => {
  const { audioId, me, dana } = setup(t, 25 * 60);
  const id = `mtg_seen${audioId}`;
  D.run("UPDATE meeting_audio SET status = 'timeless', timeless_id = ? WHERE id = ?", id, audioId);
  Store._internal.upsert({ id, title: 'פגישת ספקים', status: 'completed', start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date().toISOString(), host: { email: 'org-account@corp.test' }, participants: [] });
  D.run('UPDATE timeless_meetings SET documents = ? WHERE id = ?', JSON.stringify([{ id: 'd1', markdown: TL_SUMMARY }]), id);
  const m = await Store.get(me.id, id);
  assert.ok(m, 'השולח רואה את ההקלטה');
  assert.ok(await Store.get(dana.id, id), 'וגם מי ששויכה לפגישה');
  assert.match(m.summary, /הוחלט להתקדם עם הספק · דנה שולחת הצעת מחיר/);
  assert.doesNotMatch(m.summary, /[#*]/);
});

test('"לשלוח למשתתפים" — הסיכום במייל הוא הסיכום של Timeless', async (t) => {
  const { audioId, me, dana, meeting } = setup(t, 25 * 60);
  const id = `mtg_mail${audioId}`;
  storeMeeting(id, { emails: [me.email] });
  D.run("UPDATE meeting_audio SET status = 'ready', timeless_id = ? WHERE id = ?", id, audioId);
  D.run('INSERT OR REPLACE INTO meeting_digests (source, ref, data, created_at) VALUES (?,?,?,?)', 'wa', String(audioId), JSON.stringify(DIGEST), D.nowIso());
  D.run('INSERT INTO meeting_followups (source, ref, user_id, title, start_at, end_at, data, sent_at) VALUES (?,?,?,?,?,?,?,?)',
    'wa', String(audioId), me.id, meeting.title, meeting.start, meeting.end, '{}', D.nowIso());
  t.mock.method(Gmail, 'canSend', () => true);
  const r = await Followup.shareFor(Auth.loadActor('user', me.id), { source: 'wa', ref: audioId });
  assert.equal(r.draft.kind, 'meeting_summary_mail');
  assert.deepEqual(r.draft.to.map((p) => p.email), [dana.email]);
  assert.match(r.draft.text, /• הוחלט להתקדם עם הספק/);
  assert.doesNotMatch(r.draft.text, /על מה דיברנו|דיברנו על לוח הזמנים/, 'לא הסיכום שלנו');
  assert.doesNotMatch(r.draft.text, /##|\*\*/);
});

test('בלי סיכום של Timeless — המייל מהסיכום שלנו, כמו קודם', () => {
  const row = { title: 'פגישה', start_at: new Date().toISOString() };
  const text = Followup._internal.summaryMailText(row, DIGEST, '');
  assert.match(text, /על מה דיברנו:\n• דיברנו על לוח הזמנים/);
});

test('פגישת Timeless שהיא הקלטה מוואטסאפ — בלי "איך היה?" נוסף (השולח כבר קיבל סיכום)', (t) => {
  const { audioId, me } = setup(t, 60);
  const id = `mtg_nofollow${audioId}`;
  storeMeeting(id, { emails: [me.email] });
  D.run("UPDATE meeting_audio SET timeless_id = ? WHERE id = ?", id, audioId);
  const ids = Followup._internal.timelessCandidates(Date.now()).map((c) => c.ref);
  assert.ok(!ids.includes(id));
});

test('"תבדוק" על הקלטה שמחכה — בודקים עכשיו ב-Timeless (באג 18.11.26: הבוט ענה "אין לי דרך לבדוק")', async (t) => {
  const { audioId, me } = setup(t, 25 * 60);
  const id = `mtg_check${audioId}`;
  D.run("UPDATE meeting_audio SET status = 'timeless', timeless_id = ?, timeless_at = ? WHERE id = ?", id, D.nowIso(), audioId);
  assert.ok(MeetingAudio.pendingTimeless(me.id).some((r) => r.id === audioId));
  // Timeless עוד מעבד
  t.mock.method(Store, 'syncMeeting', async (mid) => { Store._internal.upsert({ id: mid, title: 'פגישת ספקים', status: 'processing', start_time: new Date().toISOString(), end_time: new Date().toISOString(), host: { email: me.email }, participants: [] }); return null; });
  let r = await MeetingAudio.checkTimelessNow(me.id);
  assert.deepEqual(r.ready, []);
  assert.equal(r.waiting[0].status, 'processing');
  // מוכן — הסיכום והתמליל נשמרו
  Store.syncMeeting.mock.mockImplementation(async (mid) => { storeMeeting(mid); return null; });
  r = await MeetingAudio.checkTimelessNow(me.id);
  assert.deepEqual(r.ready, [audioId]);
});

test('webhook על הקלטה שהועלתה — גם כשהמזהה שלה אינו mtg_…', async (t) => {
  const { audioId } = setup(t, 25 * 60);
  const id = `upl-${audioId}-abcdef`;
  D.run("UPDATE meeting_audio SET status = 'timeless', timeless_id = ? WHERE id = ?", id, audioId);
  const synced = [];
  process.env.TIMELESS_WEBHOOK_SECRET = 'whsec-test';
  t.after(() => { delete process.env.TIMELESS_WEBHOOK_SECRET; });
  t.mock.method(Timeless, 'background', async (fn) => fn());
  // ‎handleWebhook‎ קורא ל-‎syncMeeting‎ מתוך המודול — בודקים דרך הפנייה ל-Timeless
  t.mock.method(Timeless.org, 'meeting', async (_tok, mid) => { synced.push(mid); return null; });
  const raw = Buffer.from(JSON.stringify({ event: 'meeting.initial_summary_ready', data: { meeting_id: id } }));
  const sig = `sha256=${require('node:crypto').createHmac('sha256', 'whsec-test').update(raw).digest('hex')}`;
  const out = await Store.handleWebhook(raw, sig);
  assert.equal(out.meetings, 1);
  assert.deepEqual(synced, [id]);
});

// אבטחה 19.11.26: בלי אסימון ארגוני — ההקלטה עולה רק לחשבון ה-Timeless של מי ששלח אותה, לא של עובד אחר
function personalToken(userId, token) {
  const Secrets = require('../../../server/core').Secrets;
  D.run("INSERT INTO user_channels (user_id, provider, api_token, state, checked_at, created_at) VALUES (?, 'timeless', ?, 'connected', ?, ?)",
    userId, Secrets.encrypt(token), D.nowIso(), D.nowIso());
}

test('אבטחה: בלי אסימון ארגוני — לא מעלים לחשבון Timeless של עובד אחר; התמלול שלנו', async (t) => {
  const { audioId, deps, speech, dana } = setup(t, 25 * 60);
  delete process.env.TIMELESS_ACCESS_TOKEN;
  personalToken(dana.id, `dana-personal-${audioId}`);
  t.after(() => D.run("DELETE FROM user_channels WHERE user_id = ? AND provider = 'timeless'", dana.id));
  const tokens = [];
  t.mock.method(Timeless.org, 'upload', async (token) => { tokens.push(token); return `mtg_other${audioId}`; });
  const r = await MeetingAudio.processAudio(audioId, deps);
  assert.equal(tokens.length, 0, 'לא הועלתה לחשבון של דנה');
  assert.ok(speech.mock.callCount() >= 1);
  assert.ok(!r.pending);
});

test('אבטחה: בלי אסימון ארגוני — מעלים עם האסימון האישי של השולח', async (t) => {
  const { audioId, deps, me, dana } = setup(t, 25 * 60);
  delete process.env.TIMELESS_ACCESS_TOKEN;
  personalToken(dana.id, `dana-personal2-${audioId}`);
  personalToken(me.id, `me-personal-${audioId}`);
  t.after(() => D.run("DELETE FROM user_channels WHERE user_id IN (?, ?) AND provider = 'timeless'", dana.id, me.id));
  const tokens = [];
  t.mock.method(Timeless.org, 'upload', async (token) => { tokens.push(token); return `mtg_mine${audioId}`; });
  const r = await MeetingAudio.processAudio(audioId, deps);
  assert.deepEqual(tokens, [`me-personal-${audioId}`]);
  assert.equal(r.pending, true);
});
