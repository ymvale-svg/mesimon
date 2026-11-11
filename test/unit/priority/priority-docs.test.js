'use strict';
/**
 * 🗂 תור המסמכים (‎server/priority/priority-docs.js‎): טור המיילים (מה שסריקת המייל זיהתה), לקיחה לעבודה,
 * "לא רלוונטי", גרירה, הקובץ (מהדיסק / מ-Gmail), הוצאה מהתור, ושליחה לבוט — לפי ההרשאות.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Docs = require('../../../server/priority/priority-docs');
const Access = require('../../../server/priority/priority-access');
const MailActions = require('../../../server/mail').MailActions;
const WaBot = require('../../../server/whatsapp').WaBot;

boot();
const PDF = Buffer.from('%PDF-1.4\n%test\n');
const b64 = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
let seq = 0;
function mail(u, over = {}) {
  seq += 1;
  const info = D.run(`INSERT INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, created_at)
    VALUES (?,?,0,?,?,?,?,?,?,?,?,?)`, u.id, `g${seq}`, over.kind ?? 'invoice', over.filename ?? `inv-${seq}.pdf`, 'application/pdf', over.supplier ?? 'דאר אלביאן',
  'דאר', 'bill@supplier.test', over.subject ?? `חשבונית ${seq}`, over.status ?? 'pending', over.at ?? new Date().toISOString());
  return Number(info.lastInsertRowid);
}
function worker(docs = ['receipt', 'invoice']) {
  const u = user({ role: 'employee' });
  Access.save([{ id: u.id, docs, companies: null }]);
  return u;
}

test('טור המיילים: רק של העובד, רק מה שלא טופל, ותעודת משלוח ← קבלת סחורה', () => {
  const a = worker();
  const b = worker();
  const m1 = mail(a, { kind: 'delivery_note' });
  mail(a, { status: 'declined' });
  mail(a, { at: new Date(Date.now() - 40 * 86400000).toISOString() });
  mail(b);
  const box = Docs.inbox(a);
  assert.deepEqual(box.map((x) => x.id), [m1]);
  assert.equal(box[0].guess, 'receipt');
  assert.equal(Docs._guessOf('invoice'), 'invoice');
});

test('לקיחה לעבודה: נכנס לתור, יוצא מהטור, ולא כפול', () => {
  const u = worker();
  const m = mail(u);
  const d = Docs.take(u, m, 'receipt');
  assert.equal(d.doc, 'receipt');
  assert.equal(d.source, 'mail');
  assert.equal(d.stage, 'new');
  assert.equal(Docs.inbox(u).length, 0);
  assert.equal(D.get('SELECT status FROM mail_goods_docs WHERE id = ?', m).status, 'started', 'הבוט לא ישאל עליו שוב');
  assert.equal(Docs.take(u, m, 'receipt').id, d.id);
  assert.equal(Docs.counts(u).receipt, 1);
});

test('לקיחה: בלי הרשאה למסמך — 403; מייל של אחר — 404', () => {
  const u = worker(['receipt']);
  const other = worker();
  assert.throws(() => Docs.take(u, mail(u), 'demand'), (e) => e.status === 403);
  assert.throws(() => Docs.take(u, mail(other), 'receipt'), (e) => e.status === 404);
  assert.throws(() => Docs.take(u, mail(u), 'nope'), (e) => e.status === 400);
});

test('"לא רלוונטי" — יוצא מהטור; פעם שנייה — 404', () => {
  const u = worker();
  const m = mail(u);
  Docs.dismiss(u, m);
  assert.equal(Docs.inbox(u).length, 0);
  assert.throws(() => Docs.dismiss(u, m), (e) => e.status === 404);
});

test('גרירה: PDF נשמר ונקרא חזרה; סוג אחר, ריק או גדול — נדחה', async () => {
  const u = worker();
  const d = Docs.upload(u, { doc: 'receipt', filename: 'תעודה.pdf', mime: 'application/pdf', data: b64(PDF) });
  assert.equal(d.source, 'upload');
  assert.equal(d.size, PDF.length);
  const f = await Docs.file(u, d.id);
  assert.deepEqual(f.buf, PDF);
  assert.equal(f.mime, 'application/pdf');
  assert.throws(() => Docs.upload(u, { doc: 'receipt', filename: 'x.html', mime: 'text/html', data: 'PGh0bWw+' }), /PDF או תמונה/);
  assert.throws(() => Docs.upload(u, { doc: 'receipt', filename: 'x.pdf', data: '' }), /לא נשלח/);
  assert.throws(() => Docs.upload(u, { doc: 'receipt', filename: 'x.pdf', data: Buffer.alloc(16 * 1024 * 1024).toString('base64') }), (e) => e.status === 413);
  assert.equal(Docs.upload(u, { doc: 'receipt', filename: 'scan.JPG', data: Buffer.from('jpg').toString('base64') }).mime, 'image/jpeg', 'סוג לפי הסיומת');
  const other = worker();
  await assert.rejects(Docs.file(other, d.id), (e) => e.status === 404, 'מסמך של אחר');
});

test('קובץ ממייל — יורד מ-Gmail בפעם הראשונה ונשמר', async (t) => {
  const u = worker();
  const d = Docs.take(u, mail(u), 'receipt');
  const fetch = t.mock.method(MailActions, 'goodsFile', async () => ({ buf: PDF, mime: 'application/pdf', name: 'x.pdf' }));
  assert.deepEqual((await Docs.file(u, d.id)).buf, PDF);
  assert.deepEqual((await Docs.file(u, d.id)).buf, PDF);
  assert.equal(fetch.mock.callCount(), 1);
});

test('הוצאה מהתור — מייל חוזר לטור', () => {
  const u = worker();
  const m = mail(u);
  const d = Docs.take(u, m, 'receipt');
  Docs.remove(u, d.id);
  assert.equal(Docs.list(u, { doc: 'receipt' }).length, 0);
  assert.deepEqual(Docs.inbox(u).map((x) => x.id), [m]);
});

test('לבוט: קבלת סחורה עם הקובץ, כאילו העובד שלח; פעולה שלא בבוט — נדחית', async (t) => {
  const u = worker(['receipt', 'invoice']);
  const sent = [];
  t.mock.method(WaBot, 'handOver', (userId, m) => { sent.push({ userId, ...m }); return true; });
  const d = Docs.upload(u, { doc: 'receipt', filename: 't.pdf', mime: 'application/pdf', data: b64(PDF) });
  const r = await Docs.toBot(u, d.id);
  assert.equal(r.stage, 'bot');
  assert.equal(sent[0].userId, u.id);
  assert.equal(sent[0].text, 'קבלת סחורה');
  assert.deepEqual(sent[0].file.buf, PDF);
  const inv = Docs.upload(u, { doc: 'invoice', filename: 'i.pdf', mime: 'application/pdf', data: b64(PDF) });
  await assert.rejects(Docs.toBot(u, inv.id), /עוד לא עובדת בבוט/);
});

test('לבוט בלי טלפון בפרופיל — הודעה ברורה, המסמך נשאר בתור', async (t) => {
  const u = worker(['receipt']);
  t.mock.method(WaBot, 'handOver', () => false);
  const d = Docs.upload(u, { doc: 'receipt', filename: 't.pdf', mime: 'application/pdf', data: b64(PDF) });
  await assert.rejects(Docs.toBot(u, d.id), /אין טלפון/);
  assert.equal(Docs.get(u, d.id).stage, 'new');
});
