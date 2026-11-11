'use strict';
/**
 * 🩺 שירות ה-AI לא זמין — זיהוי התקלה, התראות למנהלים (פעם בשעה), ובקשות שנשמרו לניסיון חוזר.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const O = require('../../../server/whatsapp/ai-outage');

boot();
const reset = () => { D.setSetting('ai_outage', null); D.setSetting('ai_retry', []); };
const CREDIT = 'שירות ה-AI החזיר שגיאה 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-07T16:51:00Z');

test('reasonOf — קרדיט, מפתח, עומס, ספק, רשת; שגיאה אחרת אינה תקלת שירות', () => {
  assert.equal(O.reasonOf(CREDIT).kind, 'credit');
  assert.equal(O.reasonOf('שירות ה-AI החזיר שגיאה 401: invalid x-api-key').kind, 'key');
  assert.equal(O.reasonOf('שירות ה-AI החזיר שגיאה 429: rate limit').kind, 'rate');
  assert.equal(O.reasonOf('שירות ה-AI החזיר שגיאה 529: overloaded').kind, 'provider');
  assert.equal(O.reasonOf('אין חיבור לשירות ה-AI: fetch failed').kind, 'network');
  for (const m of ['שירות ה-AI החזיר שגיאה 400: messages: field required', 'ה-AI סירב לטפל בבקשה הזו', '', null]) assert.equal(O.isOutage(m), false, String(m));
});

test('noteFailure — התראה בתחילת התקלה, שקט עד שעה, ואז "עדיין"', () => {
  reset();
  const first = O.noteFailure(CREDIT, T0);
  assert.match(first, /⚠️ \*שירות ה-AI לא זמין\*/);
  assert.match(first, /נגמר הקרדיט/);
  assert.match(first, /Plans & Billing/);
  assert.equal(O.active(), true);
  assert.equal(O.noteFailure(CREDIT, T0 + 10 * 60 * 1000), null, 'אותה תקלה, 10 דקות אחר כך — בלי התראה');
  const again = O.noteFailure(CREDIT, T0 + HOUR);
  assert.match(again, /עדיין, מ-18:51/);
  assert.equal(O.noteFailure('שירות ה-AI החזיר שגיאה 400: bad request', T0 + 2 * HOUR), null, 'שגיאה שאינה תקלה — מתעלמים');
});

test('noteRecovery — הודעה אחת כשהשירות חוזר, ורק אחרי תקלה', () => {
  reset();
  assert.equal(O.noteRecovery(T0), null);
  O.noteFailure(CREDIT, T0);
  O.save(7, 'תפתח משימה לקחת חבילה', {}, T0);
  const back = O.noteRecovery(T0 + 25 * 60 * 1000);
  assert.match(back, /✅ \*שירות ה-AI חזר\* \(לא היה זמין 25 דקות, מ-18:51\)/);
  assert.match(back, /1 בקשות שנשמרו/);
  assert.equal(O.active(), false);
  assert.equal(O.noteRecovery(T0 + HOUR), null);
});

test('save — אותה בקשה פעם אחת; עד 5 לעובד (הישנה יורדת)', () => {
  reset();
  const a = O.save(7, 'תפתח משימה', { voice: true }, T0);
  assert.equal(O.save(7, ' תפתח משימה ', {}, T0 + 1).id, a.id);
  assert.equal(a.voice, true);
  for (let i = 0; i < 6; i++) O.save(8, `בקשה ${i}`, {}, T0 + i);
  const mine = O.pending().filter((x) => x.userId === 8);
  assert.equal(mine.length, 5);
  assert.equal(mine[0].text, 'בקשה 1');
  assert.equal(O.save(7, '   '), null);
});

test('due — הוותיקה קודם; בזמן תקלה ניסיון אחד כל 5 דקות; אחרי 12 שעות — יורדת', () => {
  reset();
  O.save(7, 'ראשונה', {}, T0);
  O.save(8, 'שנייה', {}, T0 + 1000);
  O.noteFailure(CREDIT, T0);
  let d = O.due(T0 + 2000);
  assert.equal(d.next.text, 'ראשונה');
  O.failed(d.next.id, T0 + 2000);
  assert.equal(O.due(T0 + 60 * 1000).next, null, 'בזמן תקלה — לא שוב תוך 5 דקות');
  assert.equal(O.due(T0 + 2000 + O.RETRY_EVERY_MS).next.text, 'ראשונה');
  O.noteRecovery(T0 + 3000);
  assert.equal(O.due(T0 + 4000).next.text, 'שנייה', 'אחרי שחזר — הבאה שלא נוסתה, מיד');
  d = O.due(T0 + O.KEEP_MS + 5000);
  assert.equal(d.expired.length, 2);
  assert.equal(O.pending().length, 0);
});
