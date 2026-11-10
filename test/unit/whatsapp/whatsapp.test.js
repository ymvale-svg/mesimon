'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const WhatsApp = require('../../../server/integrations/whatsapp');

boot();
const user = (o = {}) => rawUser({ full_name: 'עובד', ...o });
const json = (body, status = 200) => new Response(body == null ? '' : JSON.stringify(body), { status });

test('normalizePhone — מספר ישראלי מקומי', () => {
  assert.equal(WhatsApp.normalizePhone('054-123-4567'), '972541234567');
  assert.equal(WhatsApp.normalizePhone('054 1234567'), '972541234567');
});

test('normalizePhone — קידומת בינלאומית עם + או 00', () => {
  assert.equal(WhatsApp.normalizePhone('+972 54-123-4567'), '972541234567');
  assert.equal(WhatsApp.normalizePhone('00972541234567'), '972541234567');
  assert.equal(WhatsApp.normalizePhone('+1 (212) 555-0100'), '12125550100');
  assert.equal(WhatsApp.normalizePhone('972541234567'), '972541234567');
});

test('normalizePhone — ריק, קצר מדי או ארוך מדי: null', () => {
  for (const p of [null, undefined, '', 'אין', '1234', '+1234567890123456']) assert.equal(WhatsApp.normalizePhone(p), null, String(p));
});

test('chatIdOf — מזהה שיחה, או null', () => {
  assert.equal(WhatsApp.chatIdOf('0541234567'), '972541234567@c.us');
  assert.equal(WhatsApp.chatIdOf('abc'), null);
});

test('save ו-publicChannel — בלי האסימון', () => {
  const u = user();
  assert.equal(WhatsApp.publicChannel(u.id), null);
  WhatsApp.save(u.id, { instanceId: ' 1101 ', apiToken: ' secret ', phone: '0501234567' });
  const pub = WhatsApp.publicChannel(u.id);
  assert.equal(pub.apiUrl, WhatsApp.DEFAULT_API_URL);
  assert.equal(pub.instanceId, '1101');
  assert.equal(pub.hasToken, true);
  assert.ok(!JSON.stringify(pub).includes('secret'));
  assert.ok(WhatsApp.connectedUsers().includes(u.id));
});

test('save — בלי אסימון חדש שומר את הקודם; remove מנתק', () => {
  const u = user();
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 'tok1' });
  WhatsApp.save(u.id, { instanceId: '2' });
  assert.equal(D.get("SELECT api_token FROM user_channels WHERE user_id = ?", u.id).api_token, 'tok1');
  WhatsApp.remove(u.id);
  assert.equal(WhatsApp.publicChannel(u.id), null);
  assert.ok(!WhatsApp.connectedUsers().includes(u.id));
});

test('isReady — רק במצב authorized', () => {
  const u = user();
  assert.equal(WhatsApp.isReady(u.id), false);
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 't' });
  assert.equal(WhatsApp.isReady(u.id), false);
  D.run("UPDATE user_channels SET state = 'authorized' WHERE user_id = ?", u.id);
  assert.equal(WhatsApp.isReady(u.id), true);
});

test('send — בלי חיבור או מספר לא תקין: שגיאה בלי רשת', async () => {
  const u = user();
  await assert.rejects(WhatsApp.send(u.id, '0501234567', 'היי'), /לא חובר/);
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 't' });
  await assert.rejects(WhatsApp.send(u.id, 'abc', 'היי'), /אינו תקין/);
});

test('send — הכתובת והגוף שנשלחים ל-Green API (fetch מזויף)', async (t) => {
  const u = user();
  WhatsApp.save(u.id, { apiUrl: 'https://1103.api.green-api.com/', instanceId: '77', apiToken: 'tk' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ idMessage: 'ABC' }));
  const r = await WhatsApp.send(u.id, '050-1234567', 'שלום');
  assert.deepEqual(r, { externalId: 'ABC' });
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://1103.api.green-api.com/waInstance77/sendMessage/tk');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { chatId: '972501234567@c.us', message: 'שלום' });
});

test('call — שגיאת שירות נזרקת עם הסטטוס; תשובה שאינה JSON — null', async (t) => {
  const ch = { api_url: 'https://x.test', instance_id: '1', api_token: 't' };
  t.mock.method(globalThis, 'fetch', async () => new Response('bad', { status: 466 }));
  await assert.rejects(WhatsApp.call(ch, 'getStateInstance'), /466/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('not json'));
  assert.equal(await WhatsApp.call(ch, 'x'), null);
});

test('checkState — תקלה נרשמת כמצב error', async (t) => {
  const u = user();
  assert.deepEqual(await WhatsApp.checkState(u.id), { state: 'not_configured' });
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 't' });
  t.mock.method(globalThis, 'fetch', async () => json({ stateInstance: 'authorized' }));
  assert.deepEqual(await WhatsApp.checkState(u.id), { state: 'authorized' });
  assert.equal(WhatsApp.isReady(u.id), true);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('נפל'); });
  const r = await WhatsApp.checkState(u.id);
  assert.equal(r.state, 'error');
  assert.equal(WhatsApp.isReady(u.id), false);
});

test('receive — הודעות נכנסות ויוצאות, דילוג על קבוצות, ומחיקה של כל התראה', async (t) => {
  const u = user();
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 't' });
  const queue = [
    { receiptId: 1, body: { typeWebhook: 'incomingMessageReceived', idMessage: 'm1', timestamp: 1700000000, senderData: { chatId: '972501234567@c.us', senderName: 'דני' }, messageData: { textMessageData: { textMessage: 'שלום' } } } },
    { receiptId: 2, body: { typeWebhook: 'incomingMessageReceived', senderData: { chatId: '123@g.us' }, messageData: {} } },
    { receiptId: 3, body: { typeWebhook: 'outgoingMessageReceived', idMessage: 'm3', senderData: { chatId: '972509999999@c.us', chatName: 'רותי' }, messageData: { fileMessageData: { downloadUrl: 'https://f.test/a', caption: 'הקובץ' } } } },
    { receiptId: 4, body: { typeWebhook: 'stateInstanceChanged', stateInstance: 'notAuthorized' } },
    null
  ];
  const deleted = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (/deleteNotification/.test(url)) { deleted.push(url.split('/').pop()); return json(null); }
    return json(queue.shift());
  });
  const out = await WhatsApp.receive(u.id);
  assert.equal(out.length, 2);
  assert.deepEqual({ ...out[0], at: out[0].at.toISOString() }, { from: '972501234567', text: 'שלום', file: null, id: 'm1', name: 'דני', at: '2023-11-14T22:13:20.000Z', outgoing: false });
  assert.equal(out[1].outgoing, true);
  assert.equal(out[1].text, 'הקובץ');
  assert.deepEqual(out[1].file, { url: 'https://f.test/a', filename: 'whatsapp-file', mime: 'application/octet-stream' });
  assert.deepEqual(deleted, ['1', '2', '3', '4']);
  assert.equal(WhatsApp.publicChannel(u.id).state, 'notAuthorized');
});

test('receive — בלי חיבור: רשימה ריקה', async () => {
  assert.deepEqual(await WhatsApp.receive(user().id), []);
});

test('הרשת חסומה בבדיקות — בלי זיוף, שליחה נכשלת', async () => {
  const u = user();
  WhatsApp.save(u.id, { instanceId: '1', apiToken: 't' });
  await assert.rejects(WhatsApp.send(u.id, '0501234567', 'x'), /לרשת/);
});
