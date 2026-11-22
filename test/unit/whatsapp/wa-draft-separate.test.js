'use strict';
/**
 * ✍️ נוסח מוכן בבוט — הודעה נפרדת. באג (03.11.26, ישראל): ביקש "תנסח הודעה… ותן לי אותה בנפרד",
 * וקיבל הודעה אחת: כותרת הסוכן, הנוסח, ובסוף שני ערכים לא קשורים מהידע הארגוני.
 * עכשיו: שורה קצרה, ואחריה הנוסח לבדו — אפשר להעביר אותו כמו שהוא.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');
const { Agents } = require('../../../server/agents');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

let seq = 0;
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `dr${++seq}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const DRAFT = 'היי לכולם 👋\n\nמחר, *יום רביעי 4.11*, בשעה *14:00*, תתקיים *הדרכת AI למתחילים* בחדר הישיבות.\n\nנתראה!';

function setup(t, phone, agent) {
  const wa = Fakes.whatsapp(t);
  Fakes.claude(t, () => ({ intent: 'mail_ask', request: 'תנסח הודעה על הדרכת AI מחר ב-14:00', ready: true }));
  t.mock.method(Agents, 'ask', async () => ({ merged: false, agent, failed: [],
    org: [{ domain: 'הודעה על התחלת עבודות', text: 'טופס מול משרד העבודה', source: 'מחלקת תכנון, אוקטובר 2026' }] }));
  const u = user({ phone, role: 'employee' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today() });
  return { wa, u };
}

test('בקשת ניסוח — שתי הודעות: שורה קצרה, ואז הנוסח לבדו, בלי כותרת ובלי ידע ארגוני', async (t) => {
  const { wa, u } = setup(t, '972507400001', { icon: '🗓', title: 'עוזר אישי — לוח ישראלי וניסוח', text: '✍️ הנוסח מוכן.', draft: DRAFT, sources: [] });
  await say(u.phone, 'תנסח הודעה על הדרכת AI מחר ב-14:00, ותן לי אותה בנפרד');
  const texts = wa.texts();
  assert.equal(texts.length, 2, JSON.stringify(texts));
  assert.match(texts[0], /הנה הנוסח/);
  assert.equal(texts[1], DRAFT);
  assert.doesNotMatch(texts.join('\n'), /עוזר אישי|הידע הארגוני|משרד העבודה/);
  // הנוסח נכנס להיסטוריה — "תקצר אותו" יודע על מה מדובר
  assert.match(Bot._internal.chatOf(u.id).history.at(-1).text, /הדרכת AI למתחילים/);
});

test('שאלה רגילה — הודעה אחת, והידע הארגוני לא מודבק בסופה', async (t) => {
  const { wa, u } = setup(t, '972507400002', { icon: '💰', title: 'מיסוי', text: 'מס רכישה: 85,000 ₪', sources: ['מחשבון'] });
  await say(u.phone, 'כמה מס רכישה על 2.4 מיליון?');
  const texts = wa.texts();
  assert.equal(texts.length, 1, JSON.stringify(texts));
  assert.match(texts[0], /מס רכישה: 85,000/);
  assert.doesNotMatch(texts[0], /משרד העבודה/);
});
