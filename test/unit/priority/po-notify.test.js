'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Priority = require('../../../server/integrations/priority');
const PO = require('../../../server/priority/po-notify');

boot();
const { waText, mailOf, recipientsOf, scanCompany, subjectOf } = PO._internal;

const order = (over = {}) => ({
  ORDNAME: 'PO26000045', CDES: 'חומרי בניין בע"מ', SUPNAME: '1001', STATDES: 'אושרה', PROJDES: 'מבואות חיפה', PROJDOCNO: 'PR-7',
  CODE: 'ש"ח', QPRICE: 1000, PERCENT: 0, DISPRICE: 1000, VAT: 180, TOTPRICE: 1180, PRDNO: 'PD1',
  lines: [
    { LINE: 1, PARTNAME: 'M-1', PDES: 'מלט אפור', TQUANT: 10, TUNITNAME: 'שק', PRICE: 50, QPRICE: 500, DUEDATE: '2026-11-20T00:00:00Z' },
    { LINE: 2, PARTNAME: 'B-2', PDES: 'בלוק 20', TQUANT: 2.5, TUNITNAME: 'משטח', PRICE: 200, QPRICE: 500, REQDATE: '2026-11-21T00:00:00Z' }
  ],
  ...over
});
const R = { name: 'דנה', roles: ['manager'] };

test('subjectOf — הועברה / עודכנה / בדיקה', () => {
  assert.equal(subjectOf(order(), {}), 'הזמנת הרכש בפרויקט שלך הועברה לספק — PO26000045 · מבואות חיפה');
  assert.match(subjectOf(order(), { updated: true }), /עודכנה והועברה/);
  assert.match(subjectOf(order({ PROJDES: '' }), { test: true }), /^\[בדיקה\] .* — PO26000045$/);
});

test('waText — ספק, שורות, אספקה וסכומים', () => {
  const t = waText(order(), R, {});
  assert.match(t, /🏪 ספק: \*חומרי בניין בע"מ\*/);
  assert.match(t, /📅 אספקה: 20\.11\.2026, 21\.11\.2026/);
  assert.match(t, /• 10 שק — מלט אפור · 50\.00 ₪ = 500\.00 ₪/);
  assert.match(t, /• 2\.5 משטח — בלוק 20/);
  assert.match(t, /לפני מע"מ: \*1,000\.00 ₪\* · כולל מע"מ: 1,180\.00 ₪/);
  assert.match(t, /קיבלת את ההודעה כמנהל הפרויקט\./);
});

test('waText — שני תפקידים', () => {
  assert.match(waText(order(), { roles: ['manager', 'initiator'] }, {}), /כמנהל הפרויקט וכיוזם דרישת הרכש/);
});

test('waText — מטבע זר ושורות רבות', () => {
  const lines = Array.from({ length: 18 }, (_, i) => ({ PDES: `פריט ${i + 1}`, TQUANT: 1, TUNITNAME: 'יח', PRICE: 1, QPRICE: 1 }));
  const t = waText(order({ CODE: '$', lines }), R, {});
  assert.match(t, /1\.00 \$/);
  assert.match(t, /פריט 15/);
  assert.doesNotMatch(t, /פריט 16/);
  assert.match(t, /…ועוד 3 שורות — בקובץ/);
});

test('waText — סביבת בדיקה: "במקום"', () => {
  const t = waText(order(), { roles: ['test'] }, { test: true, realNames: 'דנה (מנהל הפרויקט)' });
  assert.match(t, /\(סביבת בדיקה\)/);
  assert.match(t, /👥 במקום: דנה \(מנהל הפרויקט\)/);
  assert.match(waText(order(), { roles: ['test'] }, { test: true }), /במקום: אין נמענים/);
});

test('mailOf — נושא, HTML מוגן וטקסט', () => {
  const po = order({ lines: [{ PDES: '<script>x</script>', PARTNAME: 'P', TQUANT: 1, PRICE: 1, QPRICE: 1 }] });
  const m = mailOf(po, R, { managerName: 'דנה', companyLabel: 'מורדות' });
  assert.equal(m.subject, subjectOf(po, {}));
  assert.ok(!m.html.includes('<script>x'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.match(m.text, /הזמנה: PO26000045 · פרויקט: מבואות חיפה/);
  assert.match(m.text, /לפני מע"מ: 1,000\.00 ₪/);
});

test('mailOf — הנחת מסמך', () => {
  const m = mailOf(order({ PERCENT: 10, QPRICE: 1000, DISPRICE: 900 }), R, {});
  assert.match(m.html, /הנחת מסמך 10%/);
  assert.match(m.html, /-100\.00 ₪/);
});

test('recipientsOf — מנהל ויוזם, בלי משתמשי מערכת ומיילים לא תקינים', async (t) => {
  const u = user({ full_name: 'דנה מנהלת', email: 'dana@corp.test', phone: '0501234567' });
  t.mock.method(Priority, 'projectManager', async () => 'Dana');
  t.mock.method(Priority, 'demandInitiator', async (c, prdno) => ({ PD1: 'Yossi', PD2: 'master', PD3: 'Dana' }[prdno]));
  t.mock.method(Priority, 'priorityUser', async (c, login) => ({
    Dana: { login: 'Dana', name: 'דנה', email: 'DANA@corp.test', active: true },
    Yossi: { login: 'Yossi', name: 'יוסי', email: 'not-an-email', active: true }
  }[login] ?? null));
  const po = order({ PRDNO: 'PD1', lines: [{ PRDNO: 'PD2' }, { PRDNO: 'PD3' }, { PRDNO: 'PD1' }] });
  const r = await recipientsOf('mordot', po);
  assert.equal(r.manager.login, 'Dana');
  assert.deepEqual(r.initiators.map((x) => x.login).sort(), ['Dana', 'Yossi']);
  assert.equal(r.recipients.length, 1);
  assert.equal(r.recipients[0].userId, u.id);
  assert.equal(r.recipients[0].phone, '0501234567');
  assert.deepEqual(r.recipients[0].roles.sort(), ['initiator', 'manager']);
});

test('recipientsOf — עובד לא פעיל או מייל של ספק התוכנה: לא נמען', async (t) => {
  t.mock.method(Priority, 'projectManager', async () => 'Ex');
  t.mock.method(Priority, 'demandInitiator', async () => 'Vendor');
  t.mock.method(Priority, 'priorityUser', async (c, login) => ({
    Ex: { login: 'Ex', name: 'לשעבר', email: 'ex@corp.test', active: false },
    Vendor: { login: 'Vendor', name: 'ספק התוכנה', email: 'x@medatech.com', active: true }
  }[login]));
  const r = await recipientsOf('mordot', order());
  assert.equal(r.manager.login, 'Ex');
  assert.equal(r.recipients.length, 0);
});

test('recipientsOf — משתמש לא קיים בפריוריטי: השם הוא שם המשתמש', async (t) => {
  t.mock.method(Priority, 'projectManager', async () => 'Unknown');
  t.mock.method(Priority, 'demandInitiator', async () => null);
  t.mock.method(Priority, 'priorityUser', async () => null);
  const r = await recipientsOf('mordot', order({ PRDNO: null, lines: [] }));
  assert.deepEqual(r.manager, { login: 'Unknown', name: 'Unknown' });
  assert.deepEqual(r.initiators, []);
});

test('scanCompany — סריקה ראשונה רק רושמת, בלי לשלוח', async (t) => {
  const fo = t.mock.method(Priority, 'finalOrders', async () => [{ ORDNAME: 'PO-1', CURVERSION: 2 }, { ORDNAME: 'PO-2' }]);
  const notice = t.mock.method(Priority, 'orderForNotice', async () => { throw new Error('לא אמור להיקרא'); });
  await scanCompany('raba');
  assert.equal(fo.mock.callCount(), 1);
  assert.equal(notice.mock.callCount(), 0);
  const rows = D.all("SELECT ordname, version, status FROM po_notices WHERE company = 'raba' ORDER BY ordname");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ ordname: 'PO-1', version: 2, status: 'baseline' }, { ordname: 'PO-2', version: 1, status: 'baseline' }]);
  assert.ok(D.getSetting('po_notify_baseline', {}).raba);
});

test('scanCompany — הזמנה חדשה אחרי הסריקה הראשונה: מטופלת; כשל נרשם כשגיאה', async (t) => {
  t.mock.method(Priority, 'finalOrders', async () => [{ ORDNAME: 'PO-1', CURVERSION: 2 }, { ORDNAME: 'PO-3' }]);
  const notice = t.mock.method(Priority, 'orderForNotice', async () => { throw new Error('אין גישה'); });
  await scanCompany('raba');
  assert.equal(notice.mock.callCount(), 1);
  assert.equal(notice.mock.calls[0].arguments[1], 'PO-3');
  const row = D.get("SELECT status, attempts, error FROM po_notices WHERE company = 'raba' AND ordname = 'PO-3'");
  assert.equal(row.status, 'error');
  assert.equal(row.attempts, 1);
  assert.match(row.error, /אין גישה/);
});

test('scanCompany — גרסה חדשה של הזמנה מוכרת: מטופלת שוב', async (t) => {
  t.mock.method(Priority, 'finalOrders', async () => [{ ORDNAME: 'PO-1', CURVERSION: 3 }]);
  const notice = t.mock.method(Priority, 'orderForNotice', async () => { throw new Error('x'); });
  await scanCompany('raba');
  assert.equal(notice.mock.callCount(), 1);
});

test('scanCompany — קריאה נכשלה: החברה נדחית', async (t) => {
  const fo = t.mock.method(Priority, 'finalOrders', async () => { throw new Error('API סגור'); });
  t.mock.method(console, 'error', () => {});
  await scanCompany('elad1');
  await scanCompany('elad1');
  assert.equal(fo.mock.callCount(), 1);
});

test('tick — כבוי בלי חיבור: מאפס את הסריקה הראשונה', async (t) => {
  D.setSetting('po_notify_baseline', { raba: 'x' });
  const fo = t.mock.method(Priority, 'finalOrders', async () => []);
  await PO.tick();
  assert.equal(fo.mock.callCount(), 0);
  assert.deepEqual(D.getSetting('po_notify_baseline', null), {});
});
