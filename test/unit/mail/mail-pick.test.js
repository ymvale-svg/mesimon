'use strict';
/**
 * 📧 משימה ממייל שהעובד בוחר — רשימת המיילים מהתיבה שלו, והצעה ממתינה מהמייל שנבחר (או מה שכבר קיים).
 * Gmail ו-Claude מזויפים — בלי רשת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Gmail = require('../../../server/integrations/gmail');
const Pick = require('../../../server/mail/mail-pick');

boot();

const b64 = (s) => Buffer.from(s).toString('base64');
let seq = 0;
/** מייל גולמי עם Message-ID ייחודי */
function rawMail({ subject = 'הצעת מחיר לשיפוץ', body = 'שלום,\nמצ"ב הצעת המחיר.\nנשמח לתשובה עד יום חמישי.\n\nבברכה' } = {}) {
  seq += 1;
  return [
    'From: =?UTF-8?B?' + b64('ספק בדיקה') + '?= <vendor@example.test>',
    'To: me@example.test',
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'Date: Mon, 16 Nov 2026 09:00:00 +0200',
    `Message-ID: <pick-${seq}-${Date.now()}@example.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body)
  ].join('\r\n');
}

/**
 * Gmail מזויף: ‎boxes‎ — התיבות של כל משתמש; ‎mails‎ — ‎{ gmailId: raw }‎. ‎asked‎ — מאיזו תיבה נקרא מה.
 */
function fakeGmail(t, { boxes = {}, mails = {}, metas = [] } = {}) {
  const asked = [];
  t.mock.method(Gmail, 'boxesOf', (userId) => boxes[userId] ?? []);
  t.mock.method(Gmail, 'connectionOf', (who) => ({ email: `box-${who}@example.test`, state: 'ok', box: Gmail.boxOf(who) }));
  t.mock.method(Gmail, 'search', async (who, q) => { asked.push(['search', who, q]); return metas.map((m) => m.id); });
  t.mock.method(Gmail, 'messageMeta', async (who, id) => { asked.push(['meta', who, id]); return metas.find((m) => m.id === id); });
  t.mock.method(Gmail, 'raw', async (who, id) => {
    asked.push(['raw', who, id]);
    if (!mails[id]) throw new Error('Gmail החזיר 404');
    return { id, raw: Buffer.from(mails[id]), internalDate: new Date('2026-11-16T07:00:00Z') };
  });
  t.mock.method(Gmail, 'canSend', () => false);
  return { asked };
}

const aiTask = (title) => ({
  for_me: true, reply_expected: false, addressed_to_email: '', skip_reason: '', warning: '', department: '',
  goods_document: null, blank_form: null,
  tasks: [{ title, summary: 'לבדוק את ההצעה ולהשיב', checklist: [], people: [], priority: 'high', due_date: '2026-11-19' }]
});
const noTask = { for_me: true, reply_expected: false, addressed_to_email: '', skip_reason: 'עדכון בלבד', warning: '', department: '', goods_document: null, blank_form: null, tasks: [] };

test('רשימה — המיילים מהתיבה של העובד, החדשים קודם; ברירת מחדל: הדואר הנכנס של השבוע', async (t) => {
  const me = user();
  const { asked } = fakeGmail(t, {
    boxes: { [me.id]: [me.id] },
    metas: [
      { id: 'old1', at: new Date('2026-11-10T08:00:00Z'), labels: [], headers: { from: '"ספק" <a@example.test>', subject: 'ישן' } },
      { id: 'new1', at: new Date('2026-11-15T08:00:00Z'), labels: ['UNREAD'], headers: { from: 'b@example.test', subject: 'חדש' } }
    ]
  });
  const r = await Pick.list(me.id);
  assert.equal(r.query, Pick.DEFAULT_QUERY);
  assert.deepEqual(r.mails.map((m) => m.gmailId), ['new1', 'old1']);
  assert.equal(r.mails[1].from.name, 'ספק');
  assert.equal(r.mails[1].from.email, 'a@example.test');
  assert.equal(r.mails[0].subject, 'חדש');
  assert.equal(r.mails[0].unread, true);
  assert.equal(r.mails[0].state, null);
  assert.deepEqual(asked.filter((a) => a[0] === 'search'), [['search', me.id, Pick.DEFAULT_QUERY]]);

  await Pick.list(me.id, { q: 'from:ספק שיפוץ' });
  assert.equal(asked.filter((a) => a[0] === 'search').at(-1)[2], 'from:ספק שיפוץ', 'חיפוש חופשי עובר כמו שהוא ל-Gmail');
});

test('בלי Gmail מחובר — הודעה ברורה שמפנה ל"החשבון שלי"', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: {} });
  await assert.rejects(Pick.list(me.id), (err) => err.status === 400 && /החשבון שלי/.test(err.message));
  await assert.rejects(Pick.pick(me.id, 'abcdef123'), /החשבון שלי/);
});

test('בחירת מייל — נוצרת הצעה ממתינה של העובד, עם מה שה-AI הציע', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: { mail001: rawMail() } });
  const ai = Fakes.claude(t, () => aiTask('לבדוק הצעת מחיר לשיפוץ'));
  const r = await Pick.pick(me.id, 'mail001');
  assert.equal(r.existing, false);
  assert.equal(r.created, 1);
  assert.equal(ai.calls.length, 1, 'אותו ניתוח של הסריקה');
  const s = D.get('SELECT * FROM ai_suggestions WHERE id = ?', r.suggestion.id);
  assert.equal(s.user_id, me.id);
  assert.equal(s.status, 'pending');
  assert.equal(s.kind, 'task');
  assert.equal(s.gmail_id, 'mail001');
  assert.equal(r.suggestion.data.title, 'לבדוק הצעת מחיר לשיפוץ');
  assert.equal(r.suggestion.data.priority, 'high');
  assert.equal(r.suggestion.data.toMe, false, 'לא קופץ בבוט — העובד מטפל בזה עכשיו באתר');
  assert.equal(r.suggestion.from.email, 'vendor@example.test');
  assert.ok(D.get("SELECT 1 FROM mail_scanned WHERE user_id = ? AND gmail_id = 'mail001'", me.id), 'הסריקה לא תציע אותו שוב');
});

test('מייל שכבר יש לו הצעה — אותה הצעה חוזרת, בלי כפילות ובלי AI נוסף', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: { mail002: rawMail() } });
  const ai = Fakes.claude(t, () => aiTask('משימה'));
  const first = await Pick.pick(me.id, 'mail002');
  const again = await Pick.pick(me.id, 'mail002');
  assert.equal(again.existing, true);
  assert.equal(again.suggestion.id, first.suggestion.id);
  assert.equal(ai.calls.length, 1);
  assert.equal(D.get("SELECT COUNT(*) c FROM ai_suggestions WHERE user_id = ? AND gmail_id = 'mail002'", me.id).c, 1);

  // ברשימה — מסומן "יש כבר הצעה"
  t.mock.method(Gmail, 'search', async () => ['mail002']);
  t.mock.method(Gmail, 'messageMeta', async (who, id) => ({ id, at: new Date(), labels: [], headers: { from: 'x@example.test', subject: 's' } }));
  assert.equal((await Pick.list(me.id)).mails[0].state, 'pending');
});

test('מייל שכבר הפך למשימה — המשימה חוזרת, לא הצעה חדשה', async (t) => {
  const me = user();
  const raw = rawMail();
  const headerId = /Message-ID: (<[^>]+>)/.exec(raw)[1];
  const board = D.get('SELECT id FROM boards ORDER BY id LIMIT 1').id;
  const ts = new Date().toISOString();
  const taskId = Number(D.run(
    "INSERT INTO tasks (title, board_id, status, archived, sens, created_at, status_changed_at, source, source_ref, created_by) VALUES (?,?,'new',0,0,?,?,'email',?,?)",
    'משימה קיימת', board, ts, ts, headerId, me.id
  ).lastInsertRowid);
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: { mail003: raw } });
  const ai = Fakes.claude(t, () => aiTask('לא אמור להיקרא'));
  const r = await Pick.pick(me.id, 'mail003');
  assert.equal(r.task.id, taskId);
  assert.equal(r.task.mine, true);
  assert.equal(r.suggestion, undefined);
  assert.equal(ai.calls.length, 0);
});

test('ה-AI אומר "אין כאן משימה" — בכל זאת הצעה: הכותרת = הנושא, התקציר = תחילת המייל', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: { mail004: rawMail({ subject: 'עדכון מהספק' }) } });
  Fakes.claude(t, () => noTask);
  const r = await Pick.pick(me.id, 'mail004');
  assert.equal(r.suggestion.status, 'pending');
  assert.equal(r.suggestion.data.title, 'עדכון מהספק');
  assert.match(r.suggestion.data.summary, /מצ"ב הצעת המחיר/);
  assert.equal(r.suggestion.data.manual, true);
  assert.deepEqual(r.suggestion.data.people, []);
});

test('ה-AI נכשל — גם אז הצעה ידנית, לא שגיאה', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: { mail005: rawMail({ subject: 'בקשה' }) } });
  Fakes.claude(t, () => { throw new Error('תקלה בזיוף'); });
  t.mock.method(console, 'error', () => {});
  const r = await Pick.pick(me.id, 'mail005');
  assert.equal(r.suggestion.data.title, 'בקשה');
});

test('תיבה של עובד אחר — לא נגישה: לא נקרא ממנה דבר ולא נוצרת הצעה', async (t) => {
  const me = user();
  const other = user();
  const { asked } = fakeGmail(t, {
    boxes: { [me.id]: [me.id], [other.id]: [other.id, `${other.id}:4`] },
    mails: { mail006: rawMail() }
  });
  Fakes.claude(t, () => aiTask('x'));
  // התיבה הנוספת של העמית (‎box: 4‎) — לא ברשימת התיבות שלי
  await assert.rejects(Pick.pick(me.id, 'mail006', { box: 4 }), (err) => err.status === 404);
  assert.equal(asked.length, 0, 'לא פנינו ל-Gmail בכלל');
  assert.equal(D.get("SELECT COUNT(*) c FROM ai_suggestions WHERE gmail_id = 'mail006'").c, 0);

  // הרשימה — רק מהתיבות שלי
  await Pick.list(me.id);
  assert.deepEqual(asked.filter((a) => a[0] === 'search').map((a) => a[1]), [me.id]);
});

test('מזהה מייל לא תקין — נדחה לפני Gmail', async (t) => {
  const me = user();
  const { asked } = fakeGmail(t, { boxes: { [me.id]: [me.id] } });
  await assert.rejects(Pick.pick(me.id, '../x'), /אינו תקין/);
  assert.equal(asked.length, 0);
});

test('תקלה ב-Gmail — הודעה לעובד בלי הפרטים הטכניים', async (t) => {
  const me = user();
  fakeGmail(t, { boxes: { [me.id]: [me.id] }, mails: {} });
  Fakes.claude(t, () => aiTask('x'));
  const log = t.mock.method(console, 'error', () => {});
  await assert.rejects(Pick.pick(me.id, 'missing1'), (err) => /נסו שוב/.test(err.message) && !/404/.test(err.message));
  assert.ok(log.mock.calls.length >= 1, 'הפרטים — ליומן');
});
