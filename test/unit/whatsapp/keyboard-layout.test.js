'use strict';
// ⌨️ רעיון מסקירה 25.11: "KHMR EUC. TEXK" (מקלדת באנגלית) = "ליצר קובץ אקסל" — הבוט לא הבין
const test = require('node:test');
const assert = require('node:assert/strict');
const Keyboard = require('../../../server/whatsapp/keyboard-layout');

test('מקלדת באנגלית ← עברית', () => {
  assert.equal(Keyboard.fix('KHMR EUC. TEXK'), 'ליצר קובץ אקסל');
  assert.equal(Keyboard.fix('nv ha kh vhuo'), 'מה יש לי היום');
  assert.equal(Keyboard.fix('eck, xjurv'), 'קבלת סחורה');
});

test('אנגלית, קוד, מספר או קישור — לא ממירים', () => {
  for (const t of ['ok', 'Thanks', 'send the pdf please', 'PO26000134', 'GR26000123', 'https://x.test', 'a@b.test', 'hi', 'Hello there', 'Zoom meeting', 'שלום', 'mesimon'])
    assert.equal(Keyboard.fix(t), null, t);
});

test('בבוט: "KHMR EUC. TEXK" — הבוט אומר מה הבין ("ליצר קובץ אקסל") וממשיך עם הטקסט בעברית', async (t) => {
  const { boot, user, D } = require('../../helpers/db');
  const WhatsApp = require('../../../server/integrations/whatsapp');
  const Bot = require('../../../server/whatsapp/wa-bot');
  boot();
  Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
  const calls = [];
  t.mock.method(WhatsApp, 'call', async (ch, method, opts) => { calls.push({ method, body: opts?.body }); return {}; });
  const u = user({ phone: '972509400001', role: 'employee' });
  await Bot._internal.handleDirect({ phone: '972509400001', chatId: '972509400001@c.us', text: 'KHMR EUC. TEXK', id: 'kb1' });
  const texts = calls.filter((c) => c.method !== 'sendReaction').map((c) => c.body?.message ?? c.body?.body ?? '');
  assert.match(texts[0], /⌨️ נראה שהמקלדת הייתה באנגלית — הבנתי: "ליצר קובץ אקסל"/);
  assert.equal(D.get("SELECT result FROM wa_log WHERE user_id = ? AND action = 'keyboard'", u.id).result, 'מקלדת באנגלית ← "ליצר קובץ אקסל"');
});
