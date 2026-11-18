'use strict';
/**
 * 🩺 הבוט כשה-AI לא זמין: העובד מקבל "קיבלתי ✋" (ולא "נסו שוב"), הבקשה נשמרת, המנהלים מקבלים התראה,
 * וכשהשירות חוזר — הבקשה מטופלת לבד, עם שורת "↩️ השירות חזר".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');
const Claude = require('../../../server/integrations/claude');
const Bot = require('../../../server/whatsapp/wa-bot');
const AiOutage = require('../../../server/whatsapp/ai-outage');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});
const CREDIT = 'שירות ה-AI החזיר שגיאה 400: Your credit balance is too low to access the Anthropic API.';

let seq = 0;
function setup(t) {
  D.setSetting('ai_outage', null);
  D.setSetting('ai_retry', []);
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(console, 'error', () => {});
  const msgs = (phone) => calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${phone}@c.us`).map((c) => c.body.message ?? c.body.body);
  return { calls, msgs };
}
const say = (phone, text) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `ao${++seq}` });

test('AI לא זמין: "קיבלתי ✋", הבקשה נשמרת — ובלי "נסו שוב"', async (t) => {
  const { msgs } = setup(t);
  t.mock.method(Claude, 'json', async () => { throw new Claude.AiError(CREDIT); });
  const u = user({ phone: '972508100001', role: 'employee' });
  await say('972508100001', 'תעשה לי משימה לקחת חבילה מהדואר');
  const out = msgs('972508100001');
  assert.equal(out.length, 1);
  assert.match(out[0], /קיבלתי ✋/);
  assert.match(out[0], /שמרתי את הבקשה/);
  assert.doesNotMatch(out[0], /נסו שוב/);
  assert.deepEqual(AiOutage.pending().map((x) => [x.userId, x.text]), [[u.id, 'תעשה לי משימה לקחת חבילה מהדואר']]);
  const row = Bot.readLog({}).find((r) => r.userId === u.id);
  assert.equal(row.status, 'error');
  assert.match(row.reply, /קיבלתי ✋/);
});

test('שגיאה שאינה תקלת שירות — כמו קודם: "נסו שוב", בלי שמירה', async (t) => {
  const { msgs } = setup(t);
  t.mock.method(Claude, 'json', async () => { throw new Claude.AiError('שירות ה-AI החזיר שגיאה 400: messages: field required'); });
  user({ phone: '972508100002', role: 'employee' });
  await say('972508100002', 'תעשה לי משימה');
  assert.match(msgs('972508100002')[0], /נסו שוב בעוד רגע/);
  assert.equal(AiOutage.pending().length, 0);
});

test('השירות חזר: retryTick מטפל בבקשה, עם "↩️ השירות חזר", והיא יורדת מהרשימה', async (t) => {
  const { msgs } = setup(t);
  const u = user({ phone: '972508100003', role: 'employee' });
  AiOutage.save(u.id, 'מה המשימות שלי?', { voice: true }, Date.now() - 60000);
  t.mock.method(Claude, 'json', async () => ({ intent: 'my_tasks', range: 'all' }));
  await Bot._internal.retryTick();
  const out = msgs('972508100003');
  assert.equal(out.length, 1);
  assert.match(out[0], /^↩️ השירות חזר — מטפל בבקשה ששלחת בהקלטה: "מה המשימות שלי\?"/);
  assert.match(out[0], /אין לך משימות פתוחות/);
  assert.equal(AiOutage.pending().length, 0);
});

test('עדיין לא זמין: ניסיון חוזר נכשל בשקט — הבקשה נשארת, ולא שוב לפני 5 דקות', async (t) => {
  const { msgs } = setup(t);
  const u = user({ phone: '972508100004', role: 'employee' });
  AiOutage.noteFailure(CREDIT);
  AiOutage.save(u.id, 'תפתח משימה לדני', {}, Date.now() - 60000);
  let n = 0;
  t.mock.method(Claude, 'json', async () => { n += 1; throw new Claude.AiError(CREDIT); });
  await Bot._internal.retryTick();
  await Bot._internal.retryTick();
  assert.equal(n, 1, 'ניסיון אחד בלבד בתוך 5 דקות');
  assert.deepEqual(msgs('972508100004'), [], 'העובד לא מקבל הודעה על כל ניסיון שנכשל');
  assert.equal(AiOutage.pending()[0].tries >= 1, true);
});

test('התראה למנהלים: בתקלה — לכל מנהל עם טלפון; כשחוזר — "✅ חזר"; לעובדים — לא', async (t) => {
  const { msgs } = setup(t);
  user({ phone: '972508100005', role: 'admin' });
  user({ phone: '972508100006', role: 'employee' });
  Bot._internal.alertAdminsAi(AiOutage.noteFailure(CREDIT));
  Bot._internal.alertAdminsAi(AiOutage.noteFailure(CREDIT)); // תוך שעה — בלי התראה נוספת
  Bot._internal.alertAdminsAi(AiOutage.noteRecovery());
  await new Promise((r) => setImmediate(r));
  const admin = msgs('972508100005');
  assert.equal(admin.length, 2);
  assert.match(admin[0], /⚠️ \*שירות ה-AI לא זמין\*/);
  assert.match(admin[0], /נגמר הקרדיט/);
  assert.match(admin[1], /✅ \*שירות ה-AI חזר\*/);
  assert.deepEqual(msgs('972508100006'), []);
});
