'use strict';
/**
 * 📝 סיכום פגישה אוטומטי (ישראל, 18.11.26): "סיכום הפגישה נשלח אוטומטית בבוט ובמייל למשתתפים ביומן כשיהיה
 * מוכן ב-Timeless. הסיכום יהפוך לידע ארגוני וישמש להכנות לפגישות הבאות בנושא דומה."
 * החלטות: מהארגון — אוטומטית; מבחוץ — באישור מי שקבע; תמיד מכתובת המערכת; לידע הארגוני לפי הסיווג הקיים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Mailer = require('../../../server/integrations').Mailer;
const Store = require('../../../server/meetings/timeless-store');
const Auto = require('../../../server/meetings/meeting-summary-auto');
const Followup = require('../../../server/meetings/meeting-followup');
const Briefing = require('../../../server/meetings/briefing');
const Org = require('../../../server/agents/org-knowledge');

boot();
const HOUR = 3600000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SUMMARY = '## סיכום\n- הוחלט להזמין איטום מאבי לוי, 050-1234567\n- **לוח זמנים:** סיום עד סוף החודש';
let seq = 0;

/** פגישה שמורה מ-Timeless, עם סיכום (או בלי) */
function meeting({ host, people = [], title = 'פגישת איטום בפרויקט הרצל', endAgoMs = HOUR, summary = SUMMARY } = {}) {
  seq += 1;
  const id = `auto_${seq}_${NOW}`;
  Store._internal.upsert({
    id, title, status: 'completed', start_time: iso(NOW - endAgoMs - HOUR), end_time: iso(NOW - endAgoMs), duration: 3600,
    host: { name: host.name, email: host.email }, participants: people.map((p) => ({ name: p.name, email: p.email })),
    documents: summary ? [{ id: `doc_${id}`, title: 'סיכום' }] : []
  });
  if (summary) D.run('UPDATE timeless_meetings SET documents = ?, transcript = ? WHERE id = ?', JSON.stringify([{ markdown: summary }]), '[]', id);
  return id;
}

function mailer(t) {
  const sent = [];
  t.mock.method(Mailer, 'isEnabled', () => true);
  return { sent, send: async (m) => { sent.push(m); return 'mid'; } };
}

function clean() {
  D.run('DELETE FROM meeting_summary_auto');
  D.run('DELETE FROM timeless_meetings');
  D.run('DELETE FROM org_meeting_inbox');
  D.setSetting('meeting_summary_auto', true);
}

test('הסיכום מוכן — מייל מכתובת המערכת לכל משתתף מהארגון, לא למשתתף מבחוץ; ולתור של הידע הארגוני', async (t) => {
  clean();
  const host = user({ full_name: 'רונית מארחת', email: `host${NOW}@eshel.test` });
  const dana = user({ full_name: 'דנה', email: `dana${NOW}@eshel.test` });
  const id = meeting({ host: { name: host.full_name, email: host.email }, people: [{ name: 'דנה', email: dana.email }, { name: 'אבי לוי', email: `avi${NOW}@itum.test` }] });
  const m = mailer(t);
  const done = await Auto.sweep(NOW, { send: m.send });
  const mine = done.find((d) => d.ref === id);
  assert.ok(mine);
  assert.deepEqual(m.sent.map((x) => x.to).sort(), [dana.email, host.email].sort());
  assert.match(m.sent[0].subject, /^סיכום פגישה: פגישת איטום בפרויקט הרצל/);
  assert.match(m.sent[0].text, /הוחלט להזמין איטום מאבי לוי/);
  assert.doesNotMatch(m.sent[0].text, /\*\*|##/, 'טקסט פשוט, בלי Markdown');
  assert.equal(mine.organizer, host.id);
  assert.deepEqual(mine.external.map((p) => p.email), [`avi${NOW}@itum.test`]);
  const inbox = D.get('SELECT * FROM org_meeting_inbox WHERE ref = ?', `timeless:${id}`);
  assert.ok(inbox, 'נכנס לתור של הידע הארגוני');
  assert.equal(inbox.user_id, host.id);
  // פעם אחת לפגישה
  assert.equal((await Auto.sweep(NOW + 60000, { send: m.send })).filter((d) => d.ref === id).length, 0);
  assert.equal(m.sent.length, 2);
});

test('הסיכום עוד לא נשמר / כבוי בהגדרות / הקלטה ששלחו לבוט — לא נשלח', async (t) => {
  clean();
  const host = user({ email: `h2${NOW}@eshel.test` });
  const noSummary = meeting({ host: { name: 'מ', email: host.email }, summary: '' });
  const m = mailer(t);
  assert.equal((await Auto.sweep(NOW, { send: m.send })).some((d) => d.ref === noSummary), false);
  const off = meeting({ host: { name: 'מ', email: host.email } });
  D.setSetting('meeting_summary_auto', false);
  assert.deepEqual(await Auto.sweep(NOW, { send: m.send }), []);
  D.setSetting('meeting_summary_auto', true);
  D.run('INSERT INTO meeting_audio (user_id, stored_name, timeless_id, created_at) VALUES (?,?,?,?)', host.id, 'a.ogg', off, D.nowIso());
  assert.equal((await Auto.sweep(NOW, { send: m.send })).some((d) => d.ref === off), false, 'הקלטה מהבוט — למי ששלח אותה');
  assert.equal(m.sent.length, 0);
});

test('בבוט: הסיכום עצמו לכל משתתף; למי שקבע — גם "לשלוח למשתתפים מבחוץ?" שיוצא מכתובת המערכת', async (t) => {
  clean();
  const host = user({ full_name: 'רונית', email: `h3${NOW}@eshel.test`, phone: '972501110001' });
  const dana = user({ full_name: 'דנה', email: `d3${NOW}@eshel.test`, phone: '972501110002' });
  const id = meeting({ host: { name: 'רונית', email: host.email }, people: [{ name: 'דנה', email: dana.email }, { name: 'אבי לוי', email: `avi3${NOW}@itum.test` }] });
  const m = mailer(t);
  await Auto.sweep(NOW, { send: m.send });

  const c = Followup._internal.timelessCandidates(NOW).find((x) => x.ref === id);
  assert.deepEqual(c.users.sort(), [host.id, dana.id].sort(), 'כל המשתתפים מהארגון, גם בלי חיבור ל-Timeless');
  assert.ok(c.summary);

  const forDana = Followup._internal.summaryMessage(dana, c);
  assert.match(forDana.text, /📝 \*סיכום הפגישה: פגישת איטום/);
  assert.match(forDana.text, /הוחלט להזמין איטום/);
  assert.match(forDana.text, /נשלח במייל/);
  assert.equal(forDana.draft, null);
  assert.doesNotMatch(forDana.text, /מבחוץ/);

  const forHost = Followup._internal.summaryMessage(host, c);
  assert.match(forHost.text, /לשלוח את הסיכום גם ל-1 משתתף מבחוץ\?/);
  assert.match(forHost.text, /אבי לוי/);
  assert.equal(forHost.draft.via, 'system');
  assert.deepEqual(forHost.buttons.length, 2);

  // "כן" — מכתובת המערכת, רק למי שמבחוץ
  const sent = [];
  t.mock.method(Mailer, 'send', async (msg) => { sent.push(msg); return 'mid'; });
  const reply = await Followup.sendSummaryMail({ type: 'user', id: host.id }, forHost.draft);
  assert.match(reply, /נשלח ל-1 משתתף מבחוץ/);
  assert.deepEqual(sent.map((x) => x.to), [`avi3${NOW}@itum.test`]);
});

test('הסבב של הבוט: הסיכום עוד לא הגיע — מחכים (עד שעתיים), בלי "מה לשלוח לך?"', () => {
  clean();
  const host = user({ email: `h4${NOW}@eshel.test`, phone: '972501110004' });
  const id = meeting({ host: { name: 'מ', email: host.email }, endAgoMs: 30 * 60000 });
  assert.equal(Followup._internal.timelessCandidates(NOW).some((x) => x.ref === id), false);
});

test('ידע ארגוני: סיכום הפגישה מזוקק ללקח, והמקור של הערך הוא הפגישה', async (t) => {
  clean();
  D.run('DELETE FROM org_lessons WHERE knowledge_id IS NULL');
  const host = user({ email: `h5${NOW}@eshel.test` });
  Org.queueMeeting({ ref: `timeless:k${NOW}`, title: 'פגישת איטום בפרויקט הרצל', startAt: '2026-11-10T08:00:00Z', text: 'הוחלט להזמין איטום מאבי לוי', userId: host.id });
  assert.equal(Org.queueMeeting({ ref: `timeless:k${NOW}`, text: 'שוב' }), false, 'פעם אחת לפגישה');
  const ai = Fakes.claude(t, (opts) => (opts.schema?.properties?.lessons
    ? { lessons: [{ domain: 'איטום', dept: 'other', project: '', text: 'איטום — אבי לוי, 050-1234567', record_numbers: [1], topic: Object.keys(require('../../../server/core').Classification.topics())[0], sens: 2, skip: false }] }
    : { domain: 'איטום', dept: 'other', topic: Object.keys(require('../../../server/core').Classification.topics())[0], sens: 2, text: 'איטום — אבי לוי, 050-1234567' }));
  assert.equal(await Org.distillMeetings(), 1);
  assert.match(ai.calls[0].opts.content[0].text, /פגישה: פגישת איטום בפרויקט הרצל/);
  const lesson = D.get("SELECT * FROM org_lessons WHERE source LIKE '%\"kind\":\"meeting\"%' ORDER BY id DESC LIMIT 1");
  assert.ok(lesson);
  assert.equal(D.get('SELECT done FROM org_meeting_inbox WHERE ref = ?', `timeless:k${NOW}`).done, 1);
  await Org.mergeAll();
  const kid = D.get('SELECT knowledge_id FROM org_lessons WHERE id = ?', lesson.id).knowledge_id;
  assert.ok(kid);
  assert.match(D.get('SELECT summary FROM org_knowledge_sources WHERE knowledge_id = ? ORDER BY rowid DESC LIMIT 1', kid).summary, /🎥 פגישה: פגישת איטום/);
});

test('תדריך: פגישה קודמת בנושא דומה שהעובד היה בה — נכנסת, גם עם אנשים אחרים; פגישה שלא היה בה — לא', () => {
  clean();
  const me = user({ email: `me6${NOW}@eshel.test` });
  const other = user({ email: `o6${NOW}@eshel.test` });
  meeting({ host: { name: 'אני', email: me.email }, title: 'איטום גגות בפרויקט הרצל', endAgoMs: 5 * 24 * HOUR, summary: '- סוכם על איטום עם אבי לוי' });
  meeting({ host: { name: 'אחר', email: other.email }, title: 'איטום גגות — סודי', endAgoMs: 4 * 24 * HOUR, summary: '- לא אמור להגיע' });
  meeting({ host: { name: 'אני', email: me.email }, title: 'תקציב שיווק', endAgoMs: 3 * 24 * HOUR, summary: '- קמפיין' });
  const c = Briefing._internal.collect(me.id, { title: 'איטום גגות', start: iso(NOW + HOUR), people: [{ email: `new${NOW}@x.test`, name: 'קבלן חדש' }] });
  assert.match(c.text, /פגישה קודמת בנושא דומה: איטום גגות בפרויקט הרצל/);
  assert.match(c.text, /סוכם על איטום עם אבי לוי/);
  assert.doesNotMatch(c.text, /לא אמור להגיע/);
  assert.doesNotMatch(c.text, /קמפיין/);
});
