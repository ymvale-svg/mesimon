'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D, mkUser, mkVendor, mkTask, DAY, ago, ahead } = require('./fixtures');
const Today = require('../../../server/today');
const Calendar = require('../../../server/calendar');
const Invites = require('../../../server/invites');

boot();

// ---------------------------------------------------------------------------
// Today — העדפות מייל הבוקר
// ---------------------------------------------------------------------------

test('cleanDigest — שעה מנורמלת לשתי ספרות', () => {
  assert.equal(Today.cleanDigest({ time: '7:05' }).time, '07:05');
  assert.equal(Today.cleanDigest({ time: '23:59' }).time, '23:59');
});

test('cleanDigest — שעה לא תקינה נדחית', () => {
  for (const time of ['24:00', '12:60', '7', 'abc', '07:5']) {
    assert.throws(() => Today.cleanDigest({ time }), /שעה לא תקינה/, time);
  }
});

test('cleanDigest — ימים: בלי שבת, בלי כפולים, ממוינים', () => {
  assert.deepEqual(Today.cleanDigest({ days: [4, 0, 6, 0, '2', 9, 1.5] }).days, [0, 2, 4]);
  assert.equal(Today.cleanDigest({ days: [6] }).days, null);
  assert.equal(Today.cleanDigest({ days: null }).days, null);
  assert.equal(Today.cleanDigest({ days: 'x' }).days, null);
});

test('cleanDigest — רק בוליאני אמיתי משנה', () => {
  const cur = { ...Today.DIGEST_DEFAULTS, enabled: true };
  assert.equal(Today.cleanDigest({ enabled: 'false' }, cur).enabled, true);
  assert.equal(Today.cleanDigest({ enabled: false }, cur).enabled, false);
  assert.equal(Today.cleanDigest({ skipEmpty: false }).skipEmpty, false);
});

test('cleanDigest — לא משנה את האובייקט הנוכחי', () => {
  const cur = { ...Today.DIGEST_DEFAULTS };
  Today.cleanDigest({ enabled: true, time: '09:00' }, cur);
  assert.deepEqual(cur, Today.DIGEST_DEFAULTS);
});

test('digestPrefs — ברירות מחדל ומיזוג עם השמור', () => {
  const u = mkUser();
  assert.deepEqual(Today.digestPrefs(u.id), Today.DIGEST_DEFAULTS);
  D.setUserPref(u.id, 'todayDigest', { enabled: true, time: '06:30' });
  assert.deepEqual(Today.digestPrefs(u.id), { ...Today.DIGEST_DEFAULTS, enabled: true, time: '06:30' });
  D.setUserPref(u.id, 'todayDigest', 'garbage');
  assert.deepEqual(Today.digestPrefs(u.id), Today.DIGEST_DEFAULTS);
});

test('digestDays — בחירה מפורשת, אחרת ימי העבודה', () => {
  const u = mkUser();
  assert.deepEqual(Today.digestDays(u.id, { days: [1, 3] }), [1, 3]);
  assert.deepEqual(Today.digestDays(u.id, { days: null }), [0, 1, 2, 3, 4]);
});

test('insightsWanted — דלוק, אלא אם כובה', () => {
  const u = mkUser();
  assert.equal(Today.insightsWanted(u.id), true);
  D.setUserPref(u.id, 'botPrefs', { insightsInToday: false });
  assert.equal(Today.insightsWanted(u.id), false);
});

test('SUGGESTION_KINDS — כולל מיזוג', () => {
  assert.deepEqual(Today.SUGGESTION_KINDS, ['task', 'task_close', 'task_update', 'task_merge']);
});

test('quickCount — באיחור והיום, לא עתידיות ולא סגורות', () => {
  Today.init({
    shapeTask: (t) => ({
      ...t, dueDate: t.due_date, activateAt: t.activate_at,
      isFinal: !!D.get('SELECT is_final FROM board_columns WHERE board_id = ? AND key = ?', t.board_id, t.status)?.is_final
    })
  });
  const u = mkUser();
  const mine = { assignee_type: 'user', assignee_id: u.id };
  mkTask({ ...mine, due_date: ago(2 * DAY) });
  mkTask({ ...mine, due_date: ago(3 * DAY) });
  mkTask({ ...mine, due_date: ahead(5 * DAY) });
  mkTask({ ...mine, due_date: ago(DAY), status: 'done' });
  mkTask({ ...mine, due_date: ago(DAY), activate_at: ahead(3 * DAY) });
  mkTask({ due_date: ago(DAY) });
  assert.equal(Today.quickCount({ id: u.id }), 2);
  D.run("INSERT INTO ai_suggestions (user_id, kind, status, created_at) VALUES (?, 'task', 'pending', ?)", u.id, D.nowIso());
  D.run("INSERT INTO ai_suggestions (user_id, kind, status, created_at) VALUES (?, 'task', 'rejected', ?)", u.id, D.nowIso());
  assert.equal(Today.quickCount({ id: u.id }), 3);
});

const emptyDay = () => ({
  dateLabel: 'יום שלישי',
  calendar: { connected: false, events: [] },
  counts: { total: 0, events: 0, today: 0, overdue: 0, suggestions: 0, meetings: 0 },
  tasks: { overdue: [], today: [] },
  suggestions: { heading: 'הצעות', sources: {}, items: [] }
});

test('digestEmail — יום נקי', () => {
  const m = Today.digestEmail({ full_name: 'דנה כהן' }, emptyDay());
  assert.equal(m.subject, '☀ Today · יום שלישי — יום נקי');
  assert.match(m.html, /בוקר טוב דנה,/);
  assert.match(m.html, /היומן אינו מחובר/);
  assert.match(m.text, /^☀ Today — יום שלישי/);
});

test('digestEmail — נושא עם ספירות, ומשימות בטקסט', () => {
  const t = emptyDay();
  t.counts = { total: 3, events: 1, today: 1, overdue: 2, suggestions: 0, meetings: 0 };
  t.tasks.overdue = [{ id: 1, title: 'דוח <מס>', dueDate: '2026-11-01T10:00:00Z' }];
  t.tasks.today = [{ id: 2, title: 'לשלוח הצעה', priority: 'urgent' }];
  const m = Today.digestEmail({ full_name: 'רון' }, t);
  assert.equal(m.subject, '☀ Today · יום שלישי — 1 פגישות, 1 משימות, 2 באיחור');
  assert.match(m.text, /• דוח <מס> \(יעד 1\.11\)/);
  assert.ok(!m.html.includes('דוח <מס>'), 'כותרת לא מוברחת');
  assert.match(m.html, /דחוף/);
});

// ---------------------------------------------------------------------------
// היומן
// ---------------------------------------------------------------------------

const { shapeEvent } = Calendar._internal;
const primary = { id: 'primary', primary: true, name: 'ראשי' };

test('shapeEvent — אירוע יום שלם', () => {
  const e = shapeEvent({ id: 'e1', summary: ' חג ', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }, primary);
  assert.equal(e.allDay, true);
  assert.equal(e.start, '2026-11-10');
  assert.equal(e.end, '2026-11-11');
  assert.equal(e.title, 'חג');
  assert.equal(e.calendarName, null);
  assert.equal(e.uid, 'e1');
});

test('shapeEvent — בלי כותרת, ויומן משני עם שם', () => {
  const e = shapeEvent({ id: 'x', start: { dateTime: '2026-11-10T08:00:00Z' } }, { id: 'c2', primary: false, name: 'צוות' });
  assert.equal(e.title, '(ללא כותרת)');
  assert.equal(e.allDay, false);
  assert.equal(e.calendarName, 'צוות');
  assert.equal(e.location, '');
});

test('shapeEvent — קישור שאינו https נחסם', () => {
  const e = shapeEvent({ id: 'x', htmlLink: 'javascript:alert(1)', hangoutLink: 'http://meet.google.com/a', start: {} }, primary);
  assert.equal(e.link, null);
  assert.equal(e.meetLink, null);
  const ok = shapeEvent({ id: 'x', htmlLink: 'https://calendar.google.com/e', start: {} }, primary);
  assert.equal(ok.link, 'https://calendar.google.com/e');
});

test('shapeEvent — קישור Zoom מהתוסף או מהתיאור', () => {
  const conf = shapeEvent({
    id: 'x', start: {},
    conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:1' }, { entryPointType: 'video', uri: 'https://us02web.zoom.us/j/123' }] }
  }, primary);
  assert.equal(conf.zoomLink, 'https://us02web.zoom.us/j/123');
  const desc = shapeEvent({ id: 'x', start: {}, description: 'הצטרפו: https://zoom.us/j/999?pwd=a" עוד' }, primary);
  assert.equal(desc.zoomLink, 'https://zoom.us/j/999?pwd=a');
  assert.equal(shapeEvent({ id: 'x', start: {} }, primary).zoomLink, null);
});

test('shapeEvent — משתתפים: בלי חדרים, באותיות קטנות ובלי כפילות', () => {
  const e = shapeEvent({
    id: 'x', start: {},
    organizer: { email: 'Boss@X.com', displayName: 'בוס' },
    attendees: [
      { email: 'boss@x.com', organizer: true, responseStatus: 'accepted' },
      { email: 'Me@X.com', self: true, responseStatus: 'declined' },
      { email: 'room@resource.calendar.google.com', resource: true }
    ]
  }, primary);
  assert.deepEqual(e.participants, ['boss@x.com', 'me@x.com']);
  assert.equal(e.people.length, 2);
  assert.equal(e.people[1].response, 'declined');
  assert.equal(e.declined, true);
  assert.deepEqual(e.organizer, { email: 'boss@x.com', name: 'בוס' });
});

test('shapeEvent — סימון אירוע של משימון', () => {
  const e = shapeEvent({ id: 'x', iCalUID: 'u@google', start: {}, extendedProperties: { private: { mesimon: '1' } } }, primary);
  assert.equal(e.mesimon, true);
  assert.equal(e.uid, 'u@google');
});

test('selectedCalendars — ברירת מחדל הראשי, ועד עשרה', () => {
  const u = mkUser();
  assert.deepEqual(Calendar.selectedCalendars(u.id), ['primary']);
  D.setUserPref(u.id, 'todayCalendars', Array.from({ length: 12 }, (_, i) => i));
  const list = Calendar.selectedCalendars(u.id);
  assert.equal(list.length, 10);
  assert.equal(list[0], '0');
  D.setUserPref(u.id, 'todayCalendars', []);
  assert.deepEqual(Calendar.selectedCalendars(u.id), ['primary']);
});

test('isConnected / eventsForDay — בלי חיבור Google', async () => {
  const u = mkUser();
  assert.equal(Calendar.isConnected(u.id), false);
  assert.deepEqual(await Calendar.eventsForDay(u.id, '2026-11-10'), { connected: false, events: [] });
  assert.doesNotThrow(() => Calendar.forget(u.id));
});

// ---------------------------------------------------------------------------
// הזמנות
// ---------------------------------------------------------------------------

test('url — בלי לוכסנים כפולים', () => {
  assert.equal(Invites.url('https://m.example/', 'abc'), 'https://m.example/invite/abc');
  assert.equal(Invites.url('https://m.example///', 'abc'), 'https://m.example/invite/abc');
  assert.equal(Invites.url('https://m.example', 'abc'), 'https://m.example/invite/abc');
});

test('create — אסימון ותוקף של 14 יום', () => {
  const u = mkUser();
  const { token, expiresAt } = Invites.create('user', u.id, null);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const days = (new Date(expiresAt) - Date.now()) / DAY;
  assert.ok(days > 13.99 && days <= 14, String(days));
  assert.equal(Invites.TTL_DAYS, 14);
});

test('create — הזמנה חדשה מבטלת את הקודמת', () => {
  const u = mkUser();
  const first = Invites.create('user', u.id, null);
  const second = Invites.create('user', u.id, null);
  assert.match(Invites.find(first.token).error, /אינה קיימת/);
  assert.equal(Invites.find(second.token).account.id, u.id);
});

test('find — פרטי החשבון ומי הזמין', () => {
  const boss = mkUser({ full_name: 'יעל המנהלת' });
  const u = mkUser({ full_name: 'נועם' });
  const { token } = Invites.create('user', u.id, boss.id);
  const f = Invites.find(token);
  assert.equal(f.account.name, 'נועם');
  assert.equal(f.inviter, 'יעל המנהלת');
});

test('find — ספק', () => {
  const v = mkVendor({ name: 'דפוס הצפון' });
  const f = Invites.find(Invites.create('vendor', v.id).token);
  assert.equal(f.account.name, 'דפוס הצפון');
  assert.equal(f.inviter, null);
});

test('find — שגיאות: לא קיים, פג תוקף, חשבון לא פעיל או נמחק', () => {
  assert.match(Invites.find('nope').error, /אינה קיימת/);
  assert.match(Invites.find(undefined).error, /אינה קיימת/);

  const u1 = mkUser();
  const t1 = Invites.create('user', u1.id).token;
  D.run('UPDATE invites SET expires_at = ? WHERE token = ?', ago(DAY), t1);
  assert.match(Invites.find(t1).error, /תוקף ההזמנה פג/);

  const u2 = mkUser({ status: 'inactive' });
  assert.match(Invites.find(Invites.create('user', u2.id).token).error, /אינו פעיל/);

  const t3 = Invites.create('user', 999999).token;
  assert.match(Invites.find(t3).error, /אינו קיים עוד/);
});

test('redeem — קובע סיסמה, וההזמנה לא נפתחת שוב', () => {
  const u = mkUser();
  const { token } = Invites.create('user', u.id);
  assert.deepEqual(Invites.redeem(token, 'סיסמה-חדשה'), { actorType: 'user', id: u.id });
  const hash = D.get('SELECT password_hash FROM users WHERE id = ?', u.id).password_hash;
  assert.equal(D.verifyPassword('סיסמה-חדשה', hash), true);
  assert.match(Invites.redeem(token, 'אחרת').error, /כבר מומשה/);
});

test('redeem — ספק', () => {
  const v = mkVendor();
  const { token } = Invites.create('vendor', v.id);
  assert.deepEqual(Invites.redeem(token, 'pw'), { actorType: 'vendor', id: v.id });
  assert.equal(D.verifyPassword('pw', D.get('SELECT password_hash FROM vendors WHERE id = ?', v.id).password_hash), true);
});

test('buildEmail — עובד, בלי כתובת לתשובה', () => {
  const m = Invites.buildEmail({ recipientName: 'דנה', inviterName: 'רון', orgName: 'אשל', link: 'https://x/invite/t', isVendor: false });
  assert.equal(m.subject, 'הוזמנת ל־MESIMON — אשל');
  assert.match(m.text, /רון הזמין\/ה אותך למערכת ניהול המשימות של אשל/);
  assert.match(m.text, /אין להשיב להודעה זו/);
  assert.match(m.text, /https:\/\/x\/invite\/t/);
  assert.match(m.text, /14 ימים/);
});

test('buildEmail — ספק, עם כתובת לתשובה', () => {
  const m = Invites.buildEmail({ recipientName: 'דפוס', inviterName: 'רון', orgName: 'אשל', link: 'https://x', isVendor: true, replyTo: 'ron@x' });
  assert.match(m.text, /לפורטל הספקים של אשל/);
  assert.match(m.text, /התשובה תגיע לרון/);
});

test('buildEmail — שמות מוברחים ב-HTML', () => {
  const m = Invites.buildEmail({ recipientName: '<b>x</b>', inviterName: 'a&b', orgName: 'o', link: 'https://x', isVendor: false });
  assert.ok(!m.html.includes('<b>x</b>'));
  assert.ok(m.html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('createAndSend — בלי דואר מוגדר: קישור, בלי שליחה', async () => {
  const u = mkUser();
  const r = await Invites.createAndSend({ targetType: 'user', targetId: u.id, email: u.email, recipientName: 'x', inviter: null, baseUrl: 'https://m.example/' });
  assert.equal(r.emailSent, false);
  assert.equal(r.emailError, 'שליחת דואר אינה מוגדרת במערכת');
  assert.match(r.link, /^https:\/\/m\.example\/invite\/[A-Za-z0-9_-]+$/);
  assert.ok(Invites.find(r.link.split('/').pop()).account);
});
