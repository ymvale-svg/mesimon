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
  t.mock.method(Priority, 'demandForNotice', async (c, prdno) => ({ PRDNO: prdno, INITUSERLOGIN: { PD1: 'Yossi', PD2: 'master', PD3: 'Dana' }[prdno], approvers: [], lines: [] }));
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
  t.mock.method(Priority, 'demandForNotice', async (c, prdno) => ({ PRDNO: prdno, INITUSERLOGIN: 'Vendor', approvers: [], lines: [] }));
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
  t.mock.method(Priority, 'demandForNotice', async () => null);
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

// ---------------------------------------------------------------------------
// דרישת רכש שאושרה והועברה לספק — פותח הדרישה והמאשר (באג 15.11: PD26000053 ← PO26000119, אף אחד מהם לא קיבל)
// ---------------------------------------------------------------------------

const { demandDiffs } = PO._internal;
const demand53 = (over = {}) => ({
  PRDNO: 'PD26000053', INITUSERLOGIN: 'API VPLANS', OWNERLOGIN: 'ShazarN', approvers: ['Eladh'], dialogLogin: 'ShazarN',
  lines: [{ PRDI: 172, PARTNAME: '000', PDES: 'יריעות איטום PRE-B · משטח', TQUANT: 4, TUNITNAME: "יח'" }],
  ...over
});
const order119 = (over = {}) => order({
  ORDNAME: 'PO26000119', PRDNO: 'PD26000053', PROJDOCNO: 'PR-50', PROJDES: 'אלעד סנטר מגרש 50', CDES: 'פזקר בע"מ', OWNERLOGIN: 'ShikmaB',
  lines: [{ LINE: 1, PRDI: 0, PARTNAME: '10-61-0069', PDES: 'יריעה ביטומנית בעובי 3 מ"מ - גליל', TQUANT: 4, TUNITNAME: 'גלי', PRICE: 175, QPRICE: 700 }],
  ...over
});
const people = {
  ShazarN: { login: 'ShazarN', name: 'שזר נחמיאס', email: 'shazarn@corp.test', active: true },
  Eladh: { login: 'Eladh', name: 'אלעד הוד', email: 'eladh@corp.test', active: true },
  Tengiz: { login: 'Tengiz', name: 'טנגיז', email: 'tengiz@corp.test', active: true }
};

test('recipientsOf — דרישה מהבוט: היוזם הוא משתמש ה-API, פותח הדרישה הוא הבעלים; המאשר שחתם — גם הוא', async (t) => {
  const shazar = user({ full_name: 'שזר נחמיאס', email: 'shazarn@corp.test', phone: '0559391365' });
  const elad = user({ full_name: 'אלעד הוד', email: 'eladh@corp.test', phone: '0500000001' });
  t.mock.method(Priority, 'projectManager', async () => 'Tengiz');
  t.mock.method(Priority, 'demandForNotice', async () => demand53());
  t.mock.method(Priority, 'priorityUser', async (c, login) => people[login] ?? null);
  const r = await recipientsOf('a160226', order119());
  const by = Object.fromEntries(r.recipients.map((x) => [x.userId ?? x.email, x.roles.sort()]));
  assert.deepEqual(by[shazar.id], ['initiator']);
  assert.deepEqual(by[elad.id], ['approver']);
  assert.deepEqual(r.initiators.map((x) => x.login), ['ShazarN']);
});

test('recipientsOf — דרישה ישנה מהבוט בלי בעלים: פותח הדרישה מהדו-שיח הפנימי, או מהרישום של הבוט', async (t) => {
  const shazar = user({ full_name: 'שזר נחמיאס ב', email: 'shazar2@corp.test', phone: '0559391366' });
  t.mock.method(Priority, 'projectManager', async () => null);
  t.mock.method(Priority, 'priorityUser', async (c, login) => people[login] ?? null);
  t.mock.method(Priority, 'demandForNotice', async () => demand53({ OWNERLOGIN: 'API VPLANS', dialogLogin: 'ShazarN', approvers: [] }));
  let r = await recipientsOf('a160226', order119());
  assert.deepEqual(r.initiators.map((x) => x.login), ['ShazarN']);
  // הבוט רשם מי פתח (גם כשבפריוריטי אין שום סימן) — משתמש משימון ישירות
  t.mock.method(Priority, 'demandForNotice', async () => demand53({ OWNERLOGIN: 'API VPLANS', dialogLogin: '', approvers: [] }));
  PO.rememberOpener('a160226', 'PD26000053', shazar.id);
  r = await recipientsOf('a160226', order119());
  assert.deepEqual(r.recipients.map((x) => [x.userId, x.roles]), [[shazar.id, ['initiator']]]);
});

test('demandDiffs — שורות מקושרות: כמות ויחידה; שורה שלא הוזמנה; שורה שנוספה', async () => {
  const d = demand53({ lines: [
    { PRDI: 1, PARTNAME: 'M-1', PDES: 'מלט', TQUANT: 10, TUNITNAME: 'שק' },
    { PRDI: 2, PARTNAME: 'B-2', PDES: 'בלוק 20', TQUANT: 3, TUNITNAME: 'משטח' },
    { PRDI: 3, PARTNAME: 'H-3', PDES: 'פטיש', TQUANT: 1, TUNITNAME: 'יח' }
  ] });
  const po = order({ lines: [
    { PRDI: 1, PARTNAME: 'M-1', PDES: 'מלט', TQUANT: 10, TUNITNAME: 'שק' },
    { PRDI: 2, PARTNAME: 'B-2', PDES: 'בלוק 20', TQUANT: 2, TUNITNAME: 'משטח' },
    { PRDI: 0, PARTNAME: 'X-9', PDES: 'דבק', TQUANT: 5, TUNITNAME: 'שק' }
  ] });
  const out = await demandDiffs(d, po);
  assert.equal(out.length, 3);
  assert.match(out.join('\n'), /בלוק 20 — 3 משטח ← הוזמן: 2 משטח/);
  assert.match(out.join('\n'), /פטיש — 1 יח — לא הוזמן/);
  assert.match(out.join('\n'), /נוסף בהזמנה: דבק — 5 שק/);
});

test('demandDiffs — בלי קישור בין השורות: ה-AI משווה (יריעות PRE-B ← יריעה ביטומנית)', async (t) => {
  const Claude = require('../../../server/integrations/claude');
  t.mock.method(Claude, 'isEnabled', () => true);
  const ai = t.mock.method(Claude, 'json', async () => ({ diffs: ['ביקשת: יריעות איטום PRE-B — 4 משטח ← הוזמן: יריעה ביטומנית 3 מ"מ — 4 גליל'] }));
  const out = await demandDiffs(demand53(), order119());
  assert.equal(ai.mock.callCount(), 1);
  assert.deepEqual(out, ['ביקשת: יריעות איטום PRE-B — 4 משטח ← הוזמן: יריעה ביטומנית 3 מ"מ — 4 גליל']);
});

test('demandDiffs — בלי קישור ובלי AI: הרשימות זו מול זו, רק כשהן שונות', async (t) => {
  const Claude = require('../../../server/integrations/claude');
  t.mock.method(Claude, 'isEnabled', () => false);
  const out = await demandDiffs(demand53(), order119());
  assert.match(out.join('\n'), /ביקשת: יריעות איטום PRE-B · משטח — 4 יח'/);
  assert.match(out.join('\n'), /הוזמן: יריעה ביטומנית/);
  const same = demand53({ lines: [{ PRDI: 9, PARTNAME: 'Z', PDES: 'זהה', TQUANT: 1, TUNITNAME: 'יח' }] });
  assert.deepEqual(await demandDiffs(same, order({ lines: [{ PRDI: 0, PARTNAME: 'Z', PDES: 'זהה', TQUANT: 1, TUNITNAME: 'יח' }] })), []);
});

test('waText — לפותח הדרישה: "אושרה והועברה לספק", וההבדלים מהדרישה', () => {
  const t = waText(order119(), { roles: ['initiator'] }, { prdno: 'PD26000053', approvedBy: 'אלעד הוד', buyer: 'שקמה בסר', diffs: ['ביקשת: X ← הוזמן: Y'] });
  assert.match(t, /✅ \*דרישת הרכש שלך PD26000053 אושרה והועברה לספק\*/);
  assert.match(t, /אישר: אלעד הוד/);
  assert.match(t, /⚠️ \*ההזמנה שונה מהדרישה:\*\n• ביקשת: X ← הוזמן: Y/);
  assert.match(t, /לשאלות — שקמה בסר \(רכש\)/);
});

test('waText — למאשר: "שאישרת", בלי ההבדלים', () => {
  const t = waText(order119(), { roles: ['approver'] }, { prdno: 'PD26000053', diffs: ['ביקשת: X ← הוזמן: Y'] });
  assert.match(t, /✅ \*דרישת הרכש שאישרת PD26000053 הועברה לספק\*/);
  assert.doesNotMatch(t, /שונה מהדרישה/);
});

test('scanCompany — סריקה ראשונה: הזמנה מדרישה מהימים האחרונים לא נרשמת בשקט (פותח הדרישה מחכה)', async (t) => {
  const recent = new Date(Date.now() - 86400000).toISOString();
  t.mock.method(Priority, 'finalOrders', async () => [
    { ORDNAME: 'PO-NEW', PRDNO: 'PD9', CURDATE: recent },
    { ORDNAME: 'PO-OLD', PRDNO: 'PD8', CURDATE: '2026-01-01T00:00:00Z' },
    { ORDNAME: 'PO-NOPD', CURDATE: recent }
  ]);
  await scanCompany('kedma1');
  const rows = D.all("SELECT ordname FROM po_notices WHERE company = 'kedma1' ORDER BY ordname").map((r) => r.ordname);
  assert.deepEqual(rows, ['PO-NOPD', 'PO-OLD']);
});

test('prepare — ההזמנה לשטח: טלפון הספק, כתובת האספקה מכרטיס המחסן, ויוזם הדרישה כאיש קשר באתר (23.11.26)', async (t) => {
  user({ full_name: 'מדיין אבו סלאח', email: 'madian@corp.test', phone: '0521234567' });
  t.mock.method(Priority, 'orderForNotice', async () => order({ WARHSNAME: 'W1', OWNERLOGIN: '' }));
  t.mock.method(Priority, 'projectManager', async () => null);
  t.mock.method(Priority, 'demandForNotice', async (c, prdno) => ({ PRDNO: prdno, INITUSERLOGIN: 'Madian', approvers: [], lines: [] }));
  t.mock.method(Priority, 'priorityUser', async () => ({ login: 'Madian', name: 'מדיין', email: 'madian@corp.test', active: true }));
  const sup = t.mock.method(Priority, 'supplierContact', async () => ({ email: 'o@s.co.il', phone: '04-8888888', contact: null }));
  const wh = t.mock.method(Priority, 'warehouseAddress', async (c, code) => (code === 'W1' ? 'הרב קוק 12, אלעד' : ''));
  const p = await PO.prepare('mordot', 'PO26000045');
  assert.equal(sup.mock.calls[0].arguments[1], '1001');
  assert.equal(wh.mock.calls[0].arguments[1], 'W1');
  assert.equal(p.ctx.supplierPhone, '04-8888888');
  assert.equal(p.ctx.address, 'הרב קוק 12, אלעד');
  assert.equal(p.file.buf.subarray(0, 5).toString(), '%PDF-');
});

test('prepare — כרטיס הספק או המחסן לא נקראים: ההזמנה נשלחת בלעדיהם', async (t) => {
  t.mock.method(Priority, 'orderForNotice', async () => order({ OWNERLOGIN: '' }));
  t.mock.method(Priority, 'projectManager', async () => null);
  t.mock.method(Priority, 'demandForNotice', async () => null);
  t.mock.method(Priority, 'supplierContact', async () => { throw new Error('סגור'); });
  t.mock.method(Priority, 'warehouseAddress', async () => { throw new Error('סגור'); });
  const p = await PO.prepare('mordot', 'PO26000045');
  assert.equal(p.ctx.supplierPhone, '');
  assert.equal(p.ctx.address, '');
  assert.ok(p.file.buf.length > 0);
});
