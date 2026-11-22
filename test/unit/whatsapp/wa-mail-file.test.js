'use strict';
/**
 * 📎 קובץ מהמייל (הוחלט 20.11.26). סקירה 18.11: "תמצא לי מצגת מלונאות רכסים" החזיר שמות קבצים ו"חפש את שמו במייל" —
 * בלי הקובץ. עכשיו הקובץ עצמו נשלח בוואטסאפ, ועוד קבצים מתאימים — בכפתורים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const MailFiles = require('../../../server/mail/mail-files');
const { Gmail } = require('../../../server/integrations');
const Instinct = require('../../../server/whatsapp/instinct');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', { mail_ask: { enabled: true, audience: 'all' } });

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `mf${++seq}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

const part = (filename, mimeType, id, size = 500000) => ({ partId: id, filename, mimeType, body: { attachmentId: `att-${id}`, size } });
const MSGS = {
  m1: { internalDate: String(Date.parse('2026-09-12T10:00:00Z')), payload: { headers: [{ name: 'From', value: 'אורל <o@x.test>' }, { name: 'Subject', value: 'מצגת מלון' }], parts: [{ partId: '0', mimeType: 'text/plain', body: {} }, part('845-מלון רכסים_10.pdf', 'application/pdf', '1'), part('image001.png', 'image/png', '2', 4000)] } },
  m2: { internalDate: String(Date.parse('2025-11-02T10:00:00Z')), payload: { headers: [{ name: 'From', value: 'משרד התיירות <t@x.test>' }, { name: 'Subject', value: 'מלון רכסים' }], parts: [part('845-מלון רכסים_משרד התיירות.pdf', 'application/pdf', '1')] } },
  m3: { internalDate: String(Date.parse('2026-10-01T10:00:00Z')), payload: { headers: [{ name: 'From', value: 'דני <d@x.test>' }, { name: 'Subject', value: 'חשבון' }], parts: [part('חשבון 7764.xlsx', 'application/vnd.ms-excel', '1')] } }
};

function gmail(t, ids = ['m1', 'm2', 'm3']) {
  t.mock.method(Gmail, 'boxesOf', () => ['me']);
  const q = [];
  t.mock.method(Gmail, 'search', async (who, query) => { q.push(query); return ids; });
  t.mock.method(Gmail, 'messageFull', async (who, id) => MSGS[id]);
  t.mock.method(Gmail, 'attachment', async (who, id, attId) => Buffer.from(`${id}:${attId}`));
  return q;
}
const files = (wa) => wa.calls.filter((c) => c.method === 'sendFile').map((c) => c.body[2]);

test('זיהוי: בקשה לקובץ — כן; מייל לאחר, משימה, שאלה — לא', () => {
  for (const t of ['תמצא לי מצגת מלונאות רכסים', 'תשלח לי את החוזה של רכסים מהמייל', '🎙 תביא לי בבקשה את האקסל של עלויות הבנייה', 'אפשר לקבל את השרטוט של מגרש 207?'])
    assert.ok(MailFiles.isRequest(t), t);
  for (const t of ['תשלח לדני את החוזה', 'תמצא לי את המייל של דני', 'תפתח משימה לשלוח לי את המצגת', 'מה עם המצגת?'])
    assert.ok(!MailFiles.isRequest(t), t);
  assert.deepEqual(MailFiles.parse('תמצא לי מצגת מלונאות רכסים').terms, ['מלונאות', 'רכסים']);
});

test('"תמצא לי מצגת מלונאות רכסים" — המצגת העדכנית נשלחת כקובץ, והגרסה הקודמת בכפתור', async (t) => {
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'mail_ask', request: 'x', reply: '', ready: false }));
  const q = gmail(t);
  const u = user({ phone: '972507800001', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  await say(u.phone, 'תמצא לי מצגת מלונאות רכסים');
  assert.match(q[0], /has:attachment מלונאות רכסים/);
  const sent = files(wa);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fileName, '845-מלון רכסים_10.pdf');
  assert.equal(String(sent[0].buf), 'm1:att-1');
  const text = wa.texts().join('\n');
  assert.match(text, /📎 \*845-מלון רכסים_10\.pdf\* · מאורל/);
  assert.match(text, /עוד במייל: 845-מלון רכסים_משרד התיירות\.pdf/);
  assert.doesNotMatch(text, /image001|חשבון 7764/, 'בלי תמונת חתימה ובלי קובץ שלא מתאים');
  assert.equal(wa.buttons().length, 1);
  assert.equal(ai.calls.filter((c) => c.kind === 'json' || c.kind === 'tools').length, 0, 'בלי AI');

  // לחיצה על הכפתור — הגרסה הקודמת נשלחת
  wa.clear();
  await say(u.phone, Bot._internal.chatOf(u.id).draft.buttons[0]);
  assert.equal(files(wa)[0]?.fileName, '845-מלון רכסים_משרד התיירות.pdf');
});

test('לא נמצא קובץ — אומרים, ומציעים לנסות מילה משם הקובץ', async (t) => {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: '', ready: false }));
  gmail(t, []);
  const u = user({ phone: '972507800002', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  await say(u.phone, 'תשלח לי את החוזה של נהריה');
  assert.equal(files(wa).length, 0);
  assert.match(wa.texts().join('\n'), /לא מצאתי במייל שלך קובץ מצורף על "נהריה"/);
});

test('בלי Gmail מחובר — לא שלנו (ממשיך לניתוב הרגיל)', async (t) => {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: 'אין לי גישה למייל שלך.', ready: false }));
  t.mock.method(Gmail, 'boxesOf', () => []);
  const u = user({ phone: '972507800003', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  await say(u.phone, 'תמצא לי מצגת מלונאות רכסים');
  assert.equal(files(wa).length, 0);
  assert.match(wa.texts().join('\n'), /אין לי גישה למייל/);
});

test('באמצע שיחה עם העוזר הכללי — "תן לי תמונה של …" הולך אליו, לא לחיפוש במייל (סקירה 22.11)', async (t) => {
  // "תן לי תמונה של הברבי בוקס" — זר שהעוזר הכללי הציע רגע לפני; החיפוש במייל ענה "לא מצאתי במייל שלך"
  Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'other', reply: '', ready: false }));
  const q = gmail(t);
  t.mock.method(Instinct, 'allowed', () => true);
  t.mock.method(Instinct, 'inConversation', () => true);
  const u = user({ phone: '972507800004', role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  await say(u.phone, 'תן לי תמונה של הברבי בוקס');
  assert.equal(q.length, 0, 'לא חיפש במייל');
  // אבל "…מהמייל" — כן, גם באמצע שיחה עם העוזר
  await say(u.phone, 'תשלח לי את המצגת של המלון מהמייל');
  assert.ok(q.length > 0);
});

