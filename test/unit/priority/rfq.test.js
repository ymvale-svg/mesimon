'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const RFQ = require('../../../server/priority/rfq');

boot();
const { itemLine, reviewText } = RFQ._internal;

test('isRequest — בקשה לפנות לספקים', () => {
  for (const t of ['תפנה לספקים להצעת מחיר על 30 שקי מלט', 'צריך הצעות מחיר לפיגומים', 'תשלח פנייה לספקים על חול']) assert.ok(RFQ.isRequest(t), t);
});

test('isRequest — בלי פעולה או בלי הצעת מחיר: לא', () => {
  for (const t of ['הצעת מחיר', 'תשלח לי את הקובץ', 'מלט 30 שקים']) assert.ok(!RFQ.isRequest(t), t);
});

test('isRequest — שאלה אינה בקשה', () => {
  assert.ok(!RFQ.isRequest('מה עם הצעת המחיר שביקשתי לשלוח?'));
  assert.ok(!RFQ.isRequest('האם צריך הצעת מחיר?'));
});

test('itemLine — פריט, מפרט, כמות ומקום', () => {
  assert.equal(itemLine({ item: 'מלט', spec: 'CEM II', quantity: '30 שק', location: 'לחיפה' }), 'מלט · CEM II · 30 שק · אספקה לחיפה');
  assert.equal(itemLine({ item: 'חול', spec: '', quantity: '', location: '' }), 'חול');
  assert.equal(itemLine({ item: 'חצץ', location: 'נהריה' }), 'חצץ · אספקה לנהריה');
});

test('SUMMARY_ASK — בקשת הסיכום', () => {
  for (const t of ['טבלת הצעות', 'סיכום הצעות מחיר', 'מה עם ההצעות?', 'טבלת ההצעות']) assert.ok(RFQ.SUMMARY_ASK.test(t), t);
  for (const t of ['תשלח הצעות', 'סיכום הפגישה']) assert.ok(!RFQ.SUMMARY_ASK.test(t), t);
});

test('BTN — כיתובים ייחודיים, קפוא', () => {
  const v = Object.values(RFQ.BTN);
  assert.equal(new Set(v).size, v.length);
  assert.ok(Object.isFrozen(RFQ.BTN));
  assert.equal(RFQ.BTN.cancel, 'ביטול 🗑️');
  assert.equal(RFQ.BTN.done, 'סיום 🏁');
});

test('reviewText — ספקים, בלי מייל, נוסח ומועד', () => {
  const r = { item: { item: 'מלט' }, draft: { subject: 'בקשה להצעת מחיר', body: 'שלום,\n\nנבקש   הצעה' }, deadline_at: '2026-11-11T14:00:00Z' };
  const t = reviewText(r, [
    { name: 'א בע"מ', email: 'a@x.co', source: 'פריוריטי', reason: 'ספק קבוע' },
    { name: 'ב', email: '', phone: '050-1', source: 'רשת' }
  ]);
  assert.match(t, /\*הצעת מחיר: מלט\*/);
  assert.match(t, /\*הספקים \(2, 1 עם מייל\):\*/);
  assert.match(t, /1\. \*א בע"מ\* — a@x\.co · פריוריטי · _ספק קבוע_/);
  assert.match(t, /2\. \*ב\* — אין מייל, טל׳ 050-1 \(לפנות בטלפון\) · רשת/);
  assert.match(t, /_שלום, נבקש הצעה_/);
  assert.match(t, /⏰ סיכום וטבלת השוואה: .*16:00/);
});

test('reviewText — כולם עם מייל: בלי ספירה', () => {
  const t = reviewText({ item: { item: 'x' }, draft: { subject: 's', body: 'b' }, deadline_at: '2026-11-11T14:00:00Z' }, [{ name: 'א', email: 'a@x.co', source: 'רשת' }]);
  assert.match(t, /\*הספקים \(1\):\*/);
});

test('ownsReply — בלי מזהים או מזהה לא מוכר: לא', () => {
  assert.equal(RFQ.ownsReply({}), false);
  assert.equal(RFQ.ownsReply({ inReplyTo: ['<nope@x>'] }), false);
});

function seed() {
  const u = user({ full_name: 'קניין', email: `buyer-${Date.now()}-${Math.random()}@test.local` });
  const now = new Date().toISOString();
  const id = Number(D.run("INSERT INTO rfq (user_id, status, item, draft, deadline_at, sent_at, created_at) VALUES (?, 'sent', ?, '{}', ?, ?, ?)",
    u.id, JSON.stringify({ item: 'מלט/אפור' }), now, now, now).lastInsertRowid);
  const v = (name, status, offer = null, mid = null) => D.run('INSERT INTO rfq_vendors (rfq_id, name, email, status, offer, message_id) VALUES (?,?,?,?,?,?)',
    id, name, `${name}@v.test`, status, offer ? JSON.stringify(offer) : null, mid);
  return { u, id, v };
}

test('summaryOf — הזולה, השנייה, מי לא ענה, וקובץ', () => {
  const { id, v } = seed();
  v('יקר', 'replied', { total_number: 2000, total_price: '2,000 ₪', vat: 'לא כולל', delivery: '3 ימים' });
  v('זול', 'replied', { total_number: 1500, total_price: '1,500 ₪', vat: 'לא צוין' });
  v('שותק', 'sent');
  v('מסרב', 'declined', { declined: true });
  v('בלי מייל', 'no_email');
  const s = RFQ.summaryOf(id);
  assert.match(s.text, /\*סיכום הצעות מחיר: מלט\/אפור\*/);
  assert.match(s.text, /2 הצעות מתוך 4 פניות · ספק אחד לא ענה\./);
  assert.match(s.text, /💰 הזולה: \*זול\* — 1,500 ₪\n/);
  assert.match(s.text, /🥈 אחריה: יקר — 2,000 ₪/);
  assert.match(s.text, /🚚 אספקה: יקר — 3 ימים/);
  assert.match(s.text, /⏳ לא ענו: שותק/);
  assert.deepEqual(s.buttons, [RFQ.BTN.remind, RFQ.BTN.demand, RFQ.BTN.done]);
  assert.equal(s.files[0].fileName, 'הצעות מחיר — מלטאפור.xlsx');
  assert.ok(Buffer.isBuffer(s.files[0].buf));
  assert.deepEqual(s.draft, { kind: 'rfq_done', rfqId: id });
});

test('summaryOf — אין הצעות: רק סיום ותזכורת', () => {
  const { id, v } = seed();
  v('א', 'sent');
  const s = RFQ.summaryOf(id);
  assert.match(s.text, /0 הצעות מתוך 1 פניות/);
  assert.doesNotMatch(s.text, /הזולה/);
  assert.deepEqual(s.buttons, [RFQ.BTN.remind, RFQ.BTN.done]);
});

test('ownsReply — תשובה למייל שנשלח לספק', () => {
  const { v } = seed();
  v('א', 'sent', null, '<abc@mail.test>');
  assert.equal(RFQ.ownsReply({ references: ['<x@y>', '<abc@mail.test>'] }), true);
});

test('lastSummary — הפנייה האחרונה של המשתמש', () => {
  const { u, id, v } = seed();
  v('א', 'replied', { total_number: 10, total_price: '10', vat: 'כולל' });
  assert.equal(RFQ.lastSummary(u.id).draft.rfqId, id);
  assert.equal(RFQ.lastSummary(999999), null);
});

// סקירה 16.11: "צריך משימה למחר … ולפתוח קריאה אצל איציק על הצעת מחיר למחשבים" (בהקלטה) — נפתחה פנייה לספקים,
// וגם "תכתבי משימה…" / "אני רוצה שתפתח לי משימה" נבלעו בה ארבע פעמים
test('isRequest — בקשה למשימה שמזכירה הצעת מחיר: לא פנייה לספקים', () => {
  for (const t of ['צריך משימה בבקשה למחר בבוקר לשלוח לאמיר את הקבלה ולפתוח קריאה אצל איציק על הצעת מחיר למחשבים',
    'צריך למסימה בבקשה למחר בבוקר, לשלוח לאמיר את הקבלה, ולפתוח קריאה אצל איציק על הצעת מחיר למחשבים',
    'תפתח לי משימה לבקש הצעת מחיר על מזגן', 'תזכיר לי מחר לבקש הצעת מחיר'])
    assert.ok(!RFQ.isRequest(t), t);
  assert.ok(RFQ.isRequest('תפנה לספקים להצעת מחיר על מחשבים'), 'בקשה רגילה — כמו קודם');
});

test('answer — בקשה למשימה באמצע הפנייה: הפנייה מתבטלת, וההודעה ממשיכה הלאה (null)', async () => {
  const u = user({ role: 'employee' });
  const id = D.run("INSERT INTO rfq (user_id, item, status, draft, created_at) VALUES (?, '{}', 'draft', '{}', ?)", u.id, D.nowIso()).lastInsertRowid;
  const r = await RFQ.answer(u.id, { kind: 'rfq', rfqId: id, step: 'details' }, 'תכתבי בבקשה משימה להביא לאמיר את החשבונית');
  assert.equal(r, null);
  assert.equal(D.get('SELECT status FROM rfq WHERE id = ?', id).status, 'cancelled');
});

// ---------------------------------------------------------------------------
// 22.11.26, אמיר רון: "ספקי אלומיניום ברשת על בסיס הדמיה" — הבוט הציע ספקים מפריוריטי בלי מייל.
// רק מי שאפשר לפנות אליו (מייל / נייד לוואטסאפ); ברשת — במקביל גם דרך אינסטינקט; ההדמיה מצורפת למייל.
// ---------------------------------------------------------------------------
const Fakes = require('../../fakes');
const Gmail = require('../../../server/integrations/gmail');
const { mobileOf, mineFor, findVendors, waLink } = RFQ._internal;

test('mobileOf — נייד ישראלי בכל כתיב; קווי / זר — ריק', () => {
  assert.equal(mobileOf('050-1234567'), '972501234567');
  assert.equal(mobileOf('+972 52 123 4567'), '972521234567');
  assert.equal(mobileOf('00972541234567'), '972541234567');
  assert.equal(mobileOf('04-8123456'), '');
  assert.equal(mobileOf(''), '');
  assert.match(waLink('0501234567', 'שלום עולם'), /^https:\/\/wa\.me\/972501234567\?text=%D7%A9/);
});

/** ה-AI המזויף: בוחר את כל המועמדים; חיפוש ברשת ← ‎web‎; חילוץ מתשובת אינסטינקט ← ‎inst‎ */
function rfqAi(t, { web = [], inst = [] } = {}) {
  return Fakes.claude(t, (opts) => {
    if (opts.schema?.properties?.picks) {
      const n = (opts.content[0].text.match(/^\d+\./gm) ?? []).length;
      return { picks: Array.from({ length: n }, (_, i) => ({ n: i + 1, reason: 'מתאים' })) };
    }
    if (opts.serverTools) return { vendors: web };
    if (/חלץ/.test(opts.system)) return { vendors: inst };
    return {};
  });
}
const v = (name, email, phone) => ({ name, email, phone, website: '', source_url: '', reason: '' });

test('mineFor — ספק מפריוריטי בלי מייל ובלי נייד: לא מוצע; עם נייד בלבד — לוואטסאפ', async (t) => {
  const u = user();
  rfqAi(t);
  Fakes.priority(t, {
    suppliersByWords: async () => [
      { name: 'אלומיניום קווי בלבד', email: '', phone: '04-8123456' },
      { name: 'אלומיניום עם מייל', email: 'sales@alu.test', phone: '' },
      { name: 'אלומיניום נייד', email: '', phone: '052-1234567' }
    ]
  });
  const list = await mineFor(u.id, { item: 'פרופילי אלומיניום', terms: ['אלומיניום'] }, 10);
  assert.deepEqual(list.map((x) => x.name), ['אלומיניום עם מייל', 'אלומיניום נייד']);
  assert.equal(list[1].mobile, '972521234567');
});

test('findVendors — ברשת: גם דרך אינסטינקט, במקביל; בלי מייל ובלי נייד — בחוץ', async (t) => {
  const u = user({ full_name: 'אמיר בודק' });
  rfqAi(t, {
    web: [v('אלו-נט', 'info@alunet.test', '')],
    inst: [v('אלו-וואטסאפ', '', '054-7654321'), v('אלו-קווי', '', '03-5555555'), v('אלו-מייל', 'office@alumail.test', '')]
  });
  const asked = [];
  const ask = async (text) => { asked.push(text); return 'אלו-וואטסאפ | — | 054-7654321\nאלו-מייל | office@alumail.test'; };
  const list = await findVendors(u.id, { item: 'חלונות אלומיניום', spec: 'לפי הדמיה', count: 10 }, 'web', { ask });
  assert.deepEqual(list.map((x) => x.name), ['אלו-נט', 'אלו-מייל', 'אלו-וואטסאפ'], 'קודם מייל, אחריו וואטסאפ');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /חלונות אלומיניום/);
  assert.doesNotMatch(asked[0], /אמיר/, 'לאינסטינקט יוצא רק המבוקש');
});

test('findVendors — "מהספקים שלי": בלי חיפוש ברשת ובלי אינסטינקט', async (t) => {
  const u = user();
  rfqAi(t);
  Fakes.priority(t, { suppliersByWords: async () => [] });
  let asked = 0;
  await findVendors(u.id, { item: 'מלט', count: 5 }, 'mine', { ask: async () => { asked++; return ''; } });
  assert.equal(asked, 0);
});

test('send — המייל יוצא עם ההדמיה מצורפת, וספק עם נייד בלבד מקבל קישור וואטסאפ', async (t) => {
  const u = user({ full_name: 'אמיר בודק' });
  const img = Buffer.from('fake-png');
  const id = Number(D.run("INSERT INTO rfq (user_id, status, item, draft, deadline_at, file, created_at) VALUES (?, 'review', ?, ?, ?, ?, ?)",
    u.id, JSON.stringify({ item: 'חלונות אלומיניום' }), JSON.stringify({ subject: 'בקשה להצעת מחיר', body: 'שלום, מצורפת הדמיה' }),
    new Date().toISOString(), JSON.stringify({ name: 'הדמיה.png', mime: 'image/png', b64: img.toString('base64') }), D.nowIso()).lastInsertRowid);
  D.run("INSERT INTO rfq_vendors (rfq_id, name, email, phone, status) VALUES (?, 'אלו-מייל', 'a@alu.test', '', 'pending')", id);
  D.run("INSERT INTO rfq_vendors (rfq_id, name, email, phone, status) VALUES (?, 'אלו-וואטסאפ', '', '054-7654321', 'whatsapp')", id);
  const raws = [];
  t.mock.method(Gmail, 'connectionOf', () => ({ email: 'amir@co.test' }));
  t.mock.method(Gmail, 'signed', async (_, b) => b);
  t.mock.method(Gmail, 'send', async (_, raw) => { raws.push(raw); return { messageId: '<m1@x>', threadId: 't1' }; });
  const text = await RFQ.send(u.id, id);
  assert.equal(raws.length, 1);
  const mail = Buffer.from(String(raws[0]), /^[A-Za-z0-9_-]+=*$/.test(raws[0]) ? 'base64url' : 'utf8').toString('utf8');
  assert.match(mail, /image\/png/);
  assert.match(mail, new RegExp(img.toString('base64')));
  assert.match(text, /✅ נשלח לספק אחד/);
  assert.match(text, /📱 \*בוואטסאפ\*.*\n• אלו-וואטסאפ: https:\/\/wa\.me\/972547654321\?text=/);
  assert.equal(D.get("SELECT status FROM rfq_vendors WHERE rfq_id = ? AND name = 'אלו-וואטסאפ'", id).status, 'wa_link');
});

test('reviewText — נייד בלבד: "📱 וואטסאפ", וההדמיה ליד הנוסח', () => {
  const t = reviewText({ item: { item: 'x' }, draft: { subject: 's', body: 'b' }, deadline_at: '2026-11-11T14:00:00Z', file: { name: 'הדמיה.jpg' } },
    [{ name: 'ב', email: '', phone: '0547654321', source: '🌐 ברשת' }]);
  assert.match(t, /1\. \*ב\* — 📱 וואטסאפ 0547654321/);
  assert.match(t, /\*הנוסח:\* s · 📎 הדמיה\.jpg/);
});
