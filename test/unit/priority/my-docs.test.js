'use strict';
/**
 * 🔎 "מה קרה עם המסמך שלי?" (‎server/priority/my-docs.js‎; "תוכנית — סטטוס אישור ותשלום בבוט.md"):
 * הבנת השאלה, כן / לא ואז הפרטים (שולם, ישולם ב-15, באיחור, מחכה לאישור של…, הפכה להזמנה, כמה שולם מהחוזה),
 * מי רואה מה (שלי · מנהל מחלקה — גם של העובדים שלו · עובד אחר — לא), בחירה בכפתורים, "התשלומים שלי", ובבוט עצמו.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const MyDocs = require('../../../server/priority/my-docs');
const Chain = require('../../../server/priority/priority-chain');
const { notOpening } = require('../../../server/priority/opens-guard');

boot();
const TODAY = '2026-11-26';      // ה-15 הקרוב: 15.12.26
const actor = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
const now = () => new Date().toISOString();
const ask = (u, text) => MyDocs.request(actor(u), text, { today: TODAY });

function reset() {
  for (const t of ['payment_items', 'priority_docs', 'priority_waiting']) D.run(`DELETE FROM ${t}`);
  D.setSetting('priority_user_map', {});
  MyDocs._reset();
}

/** חוב ברשימת התשלומים. ‎o‎ — עמודות (‎stage‎, ‎paid_at‎…); ‎d‎ — הנתונים (‎owners‎, ‎supplier‎…) */
function pay(type, docno, owners, o = {}, d = {}) {
  const company = o.company ?? 'a160226';
  const data = { ref: `${company}:${type}:${docno}`, company, type, docno, supplier: { code: 'S1', name: 'ברזל הצפון' }, project: { code: 'PR1', name: 'הגפן' },
    date: '2026-10-06', payDay: o.pay_day ?? '2026-12-15', amount: 1180, currency: 'ש"ח', terms: 'שוטף + 30', owners, invoices: [], ...d };
  D.run(`INSERT INTO payment_items (ref, org_id, company, type, docno, stage, amount, pay_day, first_pay_day, invoices, data, first_seen, last_seen, stage_at, paid_at, payment_ref, paid_how)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, data.ref, company, type, docno, o.stage ?? 'open', data.amount, data.payDay, data.payDay,
  JSON.stringify(o.invoices ?? []), JSON.stringify(data), now(), now(), now(), o.paid_at ?? '', o.payment_ref ?? '', o.paid_how ?? '');
}
/** מסמך שנקלט / נפתח בבוט */
function botDoc(u, doc, docno, o = {}) {
  D.run(`INSERT INTO priority_docs (org_id, user_id, doc, source, supplier, stage, docno, company, note, created_at, updated_at)
    VALUES (1, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?)`, u.id, doc, o.supplier ?? '', o.stage ?? 'waiting', docno, o.company ?? 'a160226', o.note ?? '', now(), now());
}
function waiting(screen, docno, o = {}) {
  D.run(`INSERT INTO priority_waiting (org_id, company, screen, docno, status, signer, signer_user_id, party, project, amount, owner, since, first_seen, seen_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, o.company ?? 'a160226', screen, docno, o.status ?? 'מחכה לאישור', o.signer ?? 'EladH', o.signerId ?? null,
  o.party ?? '', o.project ?? '', o.amount ?? null, o.owner ?? '', o.since ?? '2026-11-24', now(), now());
}
function dept(name, manager) {
  D.run('INSERT OR IGNORE INTO departments (name, created_at) VALUES (?, ?)', name, now());
  const id = D.get('SELECT id FROM departments WHERE name = ?', name).id;
  D.run('UPDATE departments SET manager_user_id = ? WHERE id = ?', manager.id, id);
  return id;
}
const fake = (t, reads = {}) => Fakes.priority(t, { priorityUsers: async () => [{ USERLOGIN: 'EladH', SNAME: 'אלעד ה' }], ...reads });

// ---------------------------------------------------------------- הבנת השאלה

test('שאלה על מצב מסמך — כן; בקשה אחרת או פתיחת קבלה / דרישה — לא', () => {
  for (const t of ['שולמה קבלת הסחורה שעשיתי לברזל הצפון?', 'האם דרישת הרכש ששלחתי על פטישים אושרה', 'שולמה קבלת הסחורה של ברזל הצפון',
    'החשבון החלקי של החוזה בהגפן אושר? מתי ישולם?', 'כמה שולם מהחוזה בהגפן', 'מה המצב עם GR26000123', 'התשלומים שלי 💰', 'מתי ישולם החשבון העסקה של פולק']) {
    assert.equal(MyDocs.isRequest(t), true, t);
  }
  for (const t of ['קבלת סחורה', 'דרישת רכש: 10 שקי מלט', 'שלח מייל לספק שהתשלום יצא', 'תזכיר לי לשלם לספק', 'שולם']) {
    assert.equal(MyDocs.isRequest(t), false, t);
  }
  // לא פותחת קבלת סחורה / דרישת רכש חדשה, גם בלי סימן שאלה
  assert.equal(notOpening('שולמה קבלת הסחורה של ברזל הצפון'), true);
  assert.equal(notOpening('דרישת רכש אושרה על הפטישים'), true);
  assert.equal(notOpening('קבלת סחורה'), false);

  const q = MyDocs.parse('האם דרישת הרכש ששלחתי על פטישים אושרה');
  assert.deepEqual(q.kinds, ['demand']);
  assert.deepEqual(q.words, ['פטישימ']);
  assert.equal(q.wants.approved, true);
  assert.equal(q.mineOnly, true);
  assert.deepEqual(MyDocs.parse('החשבון החלקי של החוזה בהגפן').kinds, ['partial'], 'חשבון חלקי — לא החוזה');
  assert.equal(MyDocs.parse('שולמה הקבלה של יוסי').personWord, 'יוסי');
  assert.equal(MyDocs.parse('מה המצב עם GR26000123').number, '26000123');
});

test('תקציר הפריטים — שלושה ראשונים ו"ועוד"', () => {
  assert.equal(MyDocs.itemsNote([{ description: 'פטישים' }, { description: 'מסמרים' }]), 'פטישים, מסמרים');
  assert.equal(MyDocs.itemsNote([1, 2, 3, 4, 5].map((n) => ({ description: `פריט ${n}` }))), 'פריט 1, פריט 2, פריט 3 ועוד 2');
  assert.equal(MyDocs.itemsNote([]), '');
});

test('השרשרת שומרת את תקציר הפריטים — ולא מוחקת אותו בעדכון בלי תקציר', () => {
  reset();
  const u = user({ role: 'employee' });
  Chain.progress(u.id, 'demand', { stage: 'draft', docno: 'PR26000777', company: 'a160226', supplier: 'הגפן', note: 'פטישים, מסמרים' });
  Chain.progress(u.id, 'demand', { stage: 'waiting', docno: 'PR26000777', company: 'a160226' });
  const r = D.get("SELECT stage, note FROM priority_docs WHERE docno = 'PR26000777'");
  assert.deepEqual({ ...r }, { stage: 'waiting', note: 'פטישים, מסמרים' });
});

// ---------------------------------------------------------------- תשלום

test('קבלת סחורה ששולמה — "כן, שולם", התאריך ומספר ההעברה', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('receipt', 'GR26000100', [u.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT26000044', paid_how: 'recon' });
  const r = await ask(u, 'שולמה קבלת הסחורה שעשיתי לברזל הצפון?');
  assert.match(r.text, /^✅ \*כן, שולם\*/);
  assert.match(r.text, /קבלת סחורה GR26000100/);
  assert.match(r.text, /שולם ב-\*15\.11\.26\* \(BT26000044\)/);
  assert.deepEqual(r.buttons, [MyDocs.MINE_BTN]);
});

test('לא שולם: ישולם ב-15 · בחשבונית · באיחור · "נראה ששולם" (לפי סכום — לא ודאי)', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('receipt', 'GR1', [u.id], {}, { supplier: { name: 'אפקון' } });
  pay('receipt', 'GR2', [u.id], { stage: 'invoiced', invoices: ['GI26000300'] }, { supplier: { name: 'כלי עבודה' } });
  pay('receipt', 'GR3', [u.id], { pay_day: '2026-11-15' }, { supplier: { name: 'מלט ישראל' } });
  pay('receipt', 'GR4', [u.id], { paid_at: '2026-11-15', payment_ref: 'BT9', paid_how: 'guess' }, { supplier: { name: 'בטון הגליל' } });

  let r = await ask(u, 'שולמה הקבלה של אפקון?');
  assert.match(r.text, /^❌ \*עוד לא שולם\*/);
  assert.match(r.text, /ישולם ב-\*15\.12\.26\*.*₪1,180.*שוטף \+ 30/);
  r = await ask(u, 'שולמה הקבלה של כלי עבודה?');
  assert.match(r.text, /בחשבונית GI26000300/);
  r = await ask(u, 'שולמה הקבלה של מלט ישראל?');
  assert.match(r.text, /באיחור/);
  assert.match(r.text, /היה אמור להיות משולם ב-15\.11\.26/);
  r = await ask(u, 'שולמה הקבלה של בטון הגליל?');
  assert.match(r.text, /נראה שכן/);
  assert.match(r.text, /עוד לא ודאי/);
});

test('חשבון עסקה — מתי ישולם', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('deal', 'T1012', [u.id], { pay_day: '2027-01-15' }, { supplier: { name: 'עו"ד פולק' } });
  const r = await ask(u, 'מתי ישולם חשבון העסקה של פולק?');
  assert.match(r.text, /חשבון עסקה T1012/);
  assert.match(r.text, /ישולם ב-\*15\.01\.27\*/);
});

// ---------------------------------------------------------------- אישור

test('דרישה מהבוט שמחכה לאישור — "עוד לא אושרה", ואצל מי מאז מתי (לפי הפריטים — "פטישים")', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  const elad = user({ role: 'manager', full_name: 'אלעד המאשר' });
  botDoc(u, 'demand', 'PR26000500', { supplier: 'הגפן', note: 'פטישים, מסמרים' });
  botDoc(u, 'demand', 'PR26000501', { supplier: 'הגפן', note: 'מלט' });
  waiting('PURDEMANDS', 'PR26000500', { signerId: elad.id, since: '2026-11-24' });
  const r = await ask(u, 'האם דרישת הרכש ששלחתי על פטישים אושרה');
  assert.match(r.text, /^⏳ \*עוד לא אושרה\*/);
  assert.match(r.text, /דרישת רכש PR26000500/);
  assert.match(r.text, /פטישים, מסמרים/);
  assert.match(r.text, /מחכה לאישור של \*אלעד המאשר\* מ-24\.11\.26/);
});

test('דרישה שאושרה — "כן, אושרה" והזמנה לספק (מפריוריטי, קריאה בלבד)', async (t) => {
  reset();
  const pr = fake(t, {
    readDemand: async () => ({ PRDNO: 'PR26000600', STATDES: 'אושרה', PROJDES: 'הגפן', PDUSER_SUBFORM: [] }),
    ordersOfDemand: async () => [{ ORDNAME: 'PO26000900', STATDES: 'נשלחה לספק', CDES: 'כלי עבודה בע"מ' }],
    myDemands: async () => []
  });
  const u = user({ role: 'employee' });
  botDoc(u, 'demand', 'PR26000600', { supplier: 'הגפן', note: 'פטישים' });
  const r = await ask(u, 'אושרה הדרישה על הפטישים?');
  assert.match(r.text, /^✅ \*כן, אושרה\*/);
  assert.match(r.text, /הפכה להזמנה \*PO26000900\* לספק כלי עבודה בע"מ \(נשלחה לספק\)/);
  assert.equal(pr.writes.length, 0, 'קריאה בלבד');
});

test('דרישה שנפתחה ישר בפריוריטי — נמצאת לפי שם המשתמש של העובד', async (t) => {
  reset();
  const u = user({ role: 'employee' });
  D.setSetting('priority_user_map', { RavivK: u.id });
  let asked = null;
  fake(t, {
    myDemands: async (c, logins) => { asked = logins; return c === 'a160226' ? [{ PRDNO: 'PR26000700', STATDES: 'מחכה לאישור', CURDATE: '2026-11-20T00:00:00Z', PROJDES: 'יוקנעם',
      USERLOGIN: 'EladH', PDUSER_SUBFORM: [{ USERLOGIN: 'EladH', UFLAG: '' }], PRDITEMS_SUBFORM: [{ PDES: 'פטיש 500 גרם' }] }] : []; }
  });
  const r = await ask(u, 'אושרה הדרישה על הפטיש?');
  assert.deepEqual(asked, ['RavivK']);
  assert.match(r.text, /עוד לא אושרה/);
  assert.match(r.text, /PR26000700/);
  assert.match(r.text, /מחכה לאישור של \*אלעד ה\*/);
});

// ---------------------------------------------------------------- חוזה

test('חוזה — כמה שולם ממנו עד היום ומה ממתין (מהחשבונות החלקיים שלו)', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('partial', 'PC1', [u.id], { stage: 'paid', paid_at: '2026-10-15', payment_ref: 'BT1' }, { contract: 'CO26000010', amount: 1000 });
  pay('partial', 'PC2', [u.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT2' }, { contract: 'CO26000010', amount: 2000 });
  pay('partial', 'PC3', [u.id], { pay_day: '2026-12-15' }, { contract: 'CO26000010', amount: 500 });
  D.run("UPDATE payment_items SET amount = json_extract(data, '$.amount')");
  const r = await ask(u, 'כמה שולם מהחוזה בהגפן?');
  assert.match(r.text, /^💰 \*שולמו ₪3,000\* מהחוזה \(2 חשבונות חלקיים\)/);
  assert.match(r.text, /חוזה CO26000010/);
  assert.match(r.text, /ממתין לתשלום: ₪500 · הקרוב ב-\*15\.12\.26\*/);
});

test('חוזה שמחכה לאישור — "עוד לא אושר", ואצל מי', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('partial', 'PC9', [u.id], {}, { contract: 'CO26000020' });
  waiting('MED_PORDERS', 'CO26000020', { party: 'קום אדריכלים' });
  const r = await ask(u, 'אושר החוזה CO26000020?');
  assert.match(r.text, /^⏳ \*עוד לא אושר\*/);
  assert.match(r.text, /מחכה לאישור של \*אלעד ה\*/);
});

// ---------------------------------------------------------------- מי רואה מה

test('עובד אחר לא רואה; מנהל מחלקה — גם של העובדים שלו ("של יוסי"); "שלי" — רק של השואל', async (t) => {
  reset(); fake(t);
  const boss = user({ role: 'manager', full_name: 'דנה המנהלת' });
  const yossi = user({ role: 'employee', full_name: 'יוסי כהן', department_id: dept('ביצוע', boss) });
  const other = user({ role: 'employee', full_name: 'רונית לוי' });
  pay('receipt', 'GR50', [yossi.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT5' });

  let r = await ask(other, 'שולמה הקבלה של ברזל הצפון?');
  assert.match(r.text, /לא מצאתי/);
  r = await ask(other, 'שולמה הקבלה של יוסי?');
  assert.match(r.text, /לא מצאתי/, 'יוסי לא בצוות שלה');

  r = await ask(boss, 'שולמה הקבלה של יוסי?');
  assert.match(r.text, /כן, שולם/);
  assert.match(r.text, /של יוסי כהן/);
  r = await ask(boss, 'שולמה הקבלה של ברזל הצפון?');
  assert.match(r.text, /כן, שולם/, 'בלי שם — גם של הצוות');
  r = await ask(boss, 'שולמה הקבלה שלי לברזל הצפון?');
  assert.match(r.text, /לא מצאתי/, '"שלי" — רק של השואל');
});

// ---------------------------------------------------------------- כמה מסמכים

test('כמה מתאימים — "על איזו?" עם כפתור לכל אחת, והכפתור עונה על המסמך', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('receipt', 'GR61', [u.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT61' });
  pay('receipt', 'GR62', [u.id]);
  const r = await ask(u, 'שולמה הקבלה של ברזל הצפון?');
  assert.match(r.text, /מצאתי 2 — על איזו\?/);
  assert.deepEqual([...r.buttons].sort(), ['קבלה GR61', 'קבלה GR62']);
  assert.equal(r.draft.kind, MyDocs.KIND);
  const a = await MyDocs.answer(actor(u), r.draft, 'קבלה GR61', { today: TODAY });
  assert.match(a.text, /כן, שולם/);
  assert.match(a.text, /BT61/);
  const b = await MyDocs.answer(actor(u), r.draft, 'GR62', { today: TODAY });
  assert.match(b.text, /עוד לא שולם/);
  assert.equal(await MyDocs.answer(actor(u), r.draft, 'תזכיר לי מחר להתקשר לספק', { today: TODAY }), null, 'משהו אחר — לא תשובה');
});

test('"התשלומים שלי" — מה שממתין לפי המועד, ומה ששולם בחודש האחרון', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  pay('receipt', 'GR71', [u.id], { pay_day: '2027-01-15' });
  pay('partial', 'PC71', [u.id], { pay_day: '2026-11-15' });
  pay('receipt', 'GR72', [u.id], { stage: 'paid', paid_at: new Date().toISOString().slice(0, 10), payment_ref: 'BT7' });
  pay('receipt', 'GR73', [999999]);   // של מישהו אחר
  const r = await ask(u, 'התשלומים שלי');
  assert.match(r.text, /התשלומים שלך\* — 2 ממתינים/);
  const lines = r.text.split('\n');
  assert.ok(lines.findIndex((l) => l.includes('PC71')) < lines.findIndex((l) => l.includes('GR71')), 'המוקדם קודם');
  assert.match(r.text, /PC71.*באיחור/);
  assert.match(r.text, /שולמו בחודש האחרון: 1/);
  assert.doesNotMatch(r.text, /GR73/);
});

test('לא נמצא — אומר מה חיפש, בלי פרטים טכניים', async (t) => {
  reset(); fake(t);
  const u = user({ role: 'employee' });
  const r = await ask(u, 'שולמה הקבלה של אפקון?');
  assert.match(r.text, /לא מצאתי קבלת סחורה שלך שמתאים ל"אפקונ"|לא מצאתי קבלת סחורה/);
  assert.doesNotMatch(r.text, /Error|undefined|null/);
});

// ---------------------------------------------------------------- בבוט

test('בבוט: "שולמה קבלת הסחורה של ברזל הצפון" — תשובה, ולא נפתחת קבלת סחורה', async (t) => {
  reset();
  const Bot = require('../../../server/whatsapp/wa-bot');
  Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
  D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'all' }, doc_status: { enabled: true, audience: 'all' } });
  const wa = Fakes.whatsapp(t);
  const ai = Fakes.claude(t, () => ({ intent: 'other', reply: '', ready: false }));
  fake(t);
  const u = user({ role: 'admin', phone: '972507711001' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  Bot._internal.saveChat(u.id, { ...Bot._internal.chatOf(u.id), greetedOn: today });
  pay('receipt', 'GR80', [u.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT80' });
  pay('receipt', 'GR81', [u.id], {}, { supplier: { name: 'אפקון' } });
  await Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text: 'שולמה קבלת הסחורה של ברזל הצפון', id: 'md1' });
  const sent = wa.texts().join('\n');
  assert.match(sent, /כן, שולם/);
  assert.match(sent, /GR80/);
  assert.doesNotMatch(sent, /צלמו|תעודת משלוח או חשבונית/, 'לא נפתחה קבלת סחורה');
  assert.equal(ai.calls.filter((c) => c.kind === 'json').length, 0, 'בלי AI');
});

test('הסוכן "🗂 רכש ופריוריטי" — כלי priority_my_docs עונה מאותו מקור, ורק למורשה לרכש', async (t) => {
  reset(); fake(t);
  const Agents = require('../../../server/agents/agents');
  const { toolsFor, manifest } = Agents._internal;
  const def = manifest().agents['priority-data'];
  const u = user({ role: 'admin' });
  pay('receipt', 'GR90', [u.id], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT90' });
  const state = { sources: new Set(), proposed: [], question: '' };
  const { tools, run } = await toolsFor(def, 'priority-data', u, actor(u), state);
  assert.ok(tools.some((x) => x.name === 'priority_my_docs'));
  const r = await run('priority_my_docs', { question: 'שולמה הקבלה של ברזל הצפון?' });
  assert.match(r.answer, /כן, שולם/);
  assert.ok(state.sources.has('🗂 פריוריטי'));
  assert.match((await run('priority_my_docs', { question: 'שלום' })).error, /צריך שאלה/);
  D.setSetting('wa_actions', { goods_receipt: { enabled: false }, purchase_demand: { enabled: false } });
  const emp = user({ role: 'employee' });
  const other = await toolsFor(def, 'priority-data', emp, actor(emp), { sources: new Set(), proposed: [], question: '' });
  assert.ok(!other.tools.some((x) => x.name === 'priority_my_docs'), 'בלי הרשאה לרכש — אין כלי');
});

// ---------------------------------------------------------------- כלל אחד: עובד — מה שפתח · מנהל — מה שהמחלקה שלו פתחה (הוחלט 26.11.26)

const CONTRACTS = { screens: [{ screen: 'MED_PORDERS', key: 'ORDNAME', status: 'ok', approvers: null, approverFields: [],
  fields: ['STATDES', 'NEXTSIGNUSERLOGIN', 'CDES', 'PROJDES', 'TOTPRICE', 'CURDATE', 'OWNERLOGIN'] }] };
const CO = [
  { ORDNAME: 'CO26000031', STATDES: 'מאושר', CDES: 'קום אדריכלים', PROJDES: 'הגפן', TOTPRICE: 50000, OWNERLOGIN: 'YossiC' },
  { ORDNAME: 'CO26000032', STATDES: 'מחכה לאישור', NEXTSIGNUSERLOGIN: 'EladH', CDES: 'אלקטרה', PROJDES: 'יוקנעם', TOTPRICE: 9000, OWNERLOGIN: 'Stranger' }
];
/** מסך החוזים מזויף: מחזיר את החוזים שהבעלים שלהם בסינון, ורושם את הסינונים */
function contractsFake(t, reads = {}) {
  D.setSetting('priority_waiting_found', CONTRACTS);
  const filters = [];
  fake(t, {
    screenDocs: async (c, s, filter) => { filters.push(filter); return c === 'a160226' ? CO.filter((d) => filter.includes(`'${d.OWNERLOGIN}'`) || filter.includes(d.ORDNAME.slice(2))) : []; },
    ...reads
  });
  return filters;
}

test('חוזים: מנהל — מה שהמחלקה שלו פתחה (וכמה שולם, מכל החשבונות החלקיים); עובד — רק שלו', async (t) => {
  reset();
  const filters = contractsFake(t);
  const boss = user({ role: 'manager', full_name: 'דנה המנהלת' });
  const yossi = user({ role: 'employee', full_name: 'יוסי כהן', department_id: dept('תכנון', boss) });
  const other = user({ role: 'employee', full_name: 'רונית לוי' });
  D.setSetting('priority_user_map', { YossiC: yossi.id, DanaM: boss.id, RonitL: other.id });
  pay('partial', 'PC31', [999999], { stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT31' }, { contract: 'CO26000031' });
  D.run("UPDATE payment_items SET amount = 7000 WHERE docno = 'PC31'");

  let r = await ask(boss, 'כמה שולם מהחוזה בהגפן?');
  assert.match(r.text, /חוזה CO26000031/);
  assert.match(r.text, /שולמו ₪7,000/);
  assert.match(r.text, /מתוך ₪50,000/);
  assert.ok(filters.some((f) => f.includes("OWNERLOGIN eq 'YossiC'") && f.includes("OWNERLOGIN eq 'DanaM'")), 'העובדים במחלקה — בקריאה אחת');

  r = await ask(yossi, 'אושר החוזה בהגפן?');
  assert.match(r.text, /כן, אושר/, 'יוסי פתח אותו');
  r = await ask(other, 'אושר החוזה בהגפן?');
  assert.match(r.text, /לא מצאתי/, 'עובד ממחלקה אחרת');
  r = await ask(boss, 'אושר החוזה CO26000032?');
  assert.match(r.text, /לא מצאתי/, 'לפי מספר — רק אם המחלקה פתחה אותו');
});

test('דרישות שנפתחו בפריוריטי: מנהל — של כל המחלקה, משויכות לעובד שפתח', async (t) => {
  reset();
  const boss = user({ role: 'manager', full_name: 'מנהל הרכש' });
  const yossi = user({ role: 'employee', full_name: 'יוסי לוי', department_id: dept('אתרים', boss) });
  D.setSetting('priority_user_map', { YossiL: yossi.id, BossR: boss.id });
  let asked = [];
  fake(t, {
    myDemands: async (c, logins) => { asked = logins; return c === 'a160226' ? [{ PRDNO: 'PR26000900', STATDES: 'אושרה', INITUSERLOGIN: 'YossiL', PROJDES: 'הגפן', PRDITEMS_SUBFORM: [{ PDES: 'פטישים' }] }] : []; },
    ordersOfDemand: async () => []
  });
  const r = await ask(boss, 'אושרה הדרישה על הפטישים?');
  assert.deepEqual([...asked].sort(), ['BossR', 'YossiL']);
  assert.match(r.text, /כן, אושרה/);
  assert.match(r.text, /של יוסי לוי/);
});

test('הנהלה וכספים — הכל, אבל רק בחברות שלהם לפי המטריצה של משימון פריוריטי', async (t) => {
  reset(); fake(t);
  const Access = require('../../../server/priority/priority-access');
  const acct = user({ role: 'employee' });
  Access.save([{ id: acct.id, docs: ['payments'], companies: ['elad1'] }]);
  pay('receipt', 'GR95', [999999], { company: 'elad1', stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT95' });
  pay('receipt', 'GR96', [999999], { company: 'a160226', stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT96' });
  const r = await ask(acct, 'שולמה הקבלה של ברזל הצפון?');
  assert.match(r.text, /GR95/);
  assert.doesNotMatch(r.text, /GR96/, 'חברה שאינה שלו במטריצה');
  Access.save([]);
});

test('כספים ששואלים "של <שם>" — גם אז רק בחברות שלהם לפי המטריצה (אבטחה, 27.11.26)', async (t) => {
  reset(); fake(t);
  const Access = require('../../../server/priority/priority-access');
  const acct = user({ role: 'employee', full_name: 'מירב הכספים' });
  const yossi = user({ role: 'employee', full_name: 'יוסף אברהמי' });
  Access.save([{ id: acct.id, docs: ['payments'], companies: ['elad1'] }]);
  pay('receipt', 'GR97', [yossi.id], { company: 'elad1', stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT97' });
  pay('receipt', 'GR98', [yossi.id], { company: 'a160226', stage: 'paid', paid_at: '2026-11-15', payment_ref: 'BT98' });
  const r = await ask(acct, 'שולמה הקבלה של יוסף?');
  assert.match(r.text, /GR97/);
  assert.doesNotMatch(r.text, /GR98/, 'חברה שאינה שלו במטריצה — גם כשמבקשים בשם');
  assert.doesNotMatch(r.text, /BT98/);
  Access.save([]);
});

test('מדרישה אחת נפתחו כמה הזמנות — כולן', async (t) => {
  reset();
  fake(t, {
    readDemand: async () => ({ PRDNO: 'PR26000800', STATDES: 'אושרה', PDUSER_SUBFORM: [] }),
    ordersOfDemand: async () => [{ ORDNAME: 'PO1', STATDES: 'נשלחה לספק', CDES: 'כלי עבודה' }, { ORDNAME: 'PO2', STATDES: 'אושרה', CDES: 'ברזל הצפון' }],
    myDemands: async () => []
  });
  const u = user({ role: 'employee' });
  botDoc(u, 'demand', 'PR26000800', { supplier: 'הגפן', note: 'פטישים, ברזל' });
  const r = await ask(u, 'אושרה הדרישה על הפטישים?');
  assert.match(r.text, /נפתחו ממנה 2 הזמנות/);
  assert.match(r.text, /• \*PO1\* לספק כלי עבודה/);
  assert.match(r.text, /• \*PO2\* לספק ברזל הצפון/);
});

// ---------------------------------------------------------------- "הוזמן?" — הזמנות הפרויקט לפי הפריט (נבדק מול פריוריטי 26.11.26)

const ORDERS = [
  { ORDNAME: 'PO26000107', STATDES: 'נשלחה לספק', CURDATE: '2026-10-29T00:00:00Z', CDES: 'גואטה הובלות', PROJDES: 'אלעד סנטר מגרש 50',
    PORDERITEMS_SUBFORM: [{ PDES: 'מכולה ימית מוסבת למשרד', TQUANT: 1, TUNITNAME: "יח'", DUEDATE: '2026-11-01T00:00:00Z' }] },
  { ORDNAME: 'PO26000130', STATDES: 'מחכה לאישור', CURDATE: '2026-11-19T00:00:00Z', CDES: 'א. נדב', PROJDES: 'אלעד סנטר מגרש 50',
    PORDERITEMS_SUBFORM: [{ PDES: 'משאבה בטון עד 28 מטר', TQUANT: 1, TUNITNAME: "יח'" }] },
  { ORDNAME: 'PO26000082', STATDES: 'אושרה', CURDATE: '2026-09-23T00:00:00Z', CDES: 'רדימיקס', PROJDES: 'אלעד סנטר מגרש 50',
    PORDERITEMS_SUBFORM: [{ PDES: 'בטון ב-30', TQUANT: 100, TUNITNAME: 'קוב' }] },
  { ORDNAME: 'PO26000099', STATDES: 'מבוטלת', CURDATE: '2026-09-01T00:00:00Z', CDES: 'X', PROJDES: 'אלעד סנטר מגרש 50',
    PORDERITEMS_SUBFORM: [{ PDES: 'מכולה', TQUANT: 1, TUNITNAME: "יח'" }] }
];
function ordersFake(t) {
  const asked = [];
  fake(t, {
    projects: async (c) => (c === 'a160226' ? [{ code: 'PR4', des: 'אלעד סנטר מגרש 50' }, { code: 'PR5', des: 'כרמיאל טרסה' }, { code: 'PR6', des: 'מבואות מגרש 500' }] : []),
    projectOrders: async (c, code) => { asked.push(code); return code === 'PR4' ? ORDERS : []; }
  });
  return asked;
}

test('"הוזמנה מכולה 6 מטר למגרש 50?" — כן, הזמנה לספק עם השורה ותאריך האספקה; מבוטלת — לא', async (t) => {
  reset();
  const asked = ordersFake(t);
  const u = user({ role: 'admin' });
  assert.equal(MyDocs.isRequest('האם הוזמן מכולה 6 מטר למגרש 50'), true);
  assert.deepEqual(MyDocs.parse('האם הוזמן מכולה 6 מטר למגרש 50').kinds, ['order']);
  const r = await ask(u, 'האם הוזמן מכולה 6 מטר למגרש 50');
  assert.deepEqual(asked, ['PR4'], 'רק הפרויקט שהמספר שלו בשאלה (לא "מגרש 500")');
  assert.match(r.text, /^✅ \*כן, הוזמן\* — "מכולה" באלעד סנטר מגרש 50/);
  assert.match(r.text, /PO26000107\* · גואטה הובלות · נשלחה לספק · 29\.10\.26/);
  assert.match(r.text, /מכולה ימית מוסבת למשרד 1 יח' · אספקה 01\.11\.26/);
  assert.doesNotMatch(r.text, /PO26000099/, 'מבוטלת');
});

test('"הוזמן?" — רק בחברות שהעובד מורשה בהן במטריצה (אבטחה, 27.11.26)', async (t) => {
  reset();
  const asked = ordersFake(t);
  const Access = require('../../../server/priority/priority-access');
  const u = user({ role: 'employee' });
  Access.save([{ id: u.id, docs: ['receipt'], companies: ['elad1'] }]);
  try {
    const r = await ask(u, 'האם הוזמן מכולה 6 מטר למגרש 50');
    assert.deepEqual(asked, [], 'הפרויקט בחברה שאינה שלו — לא נבדק');
    assert.doesNotMatch(r.text, /PO26000107/);
  } finally { Access.save([]); }
});

test('"הוזמנה משאבת בטון?" — רק ההזמנות עם הכי הרבה מילים מהפריט; מחכה לאישור — "עוד לא אושרה"', async (t) => {
  reset(); ordersFake(t);
  const u = user({ role: 'admin' });
  const r = await ask(u, 'הוזמנה משאבת בטון למגרש 50?');
  assert.match(r.text, /^⏳ \*יש הזמנה — עוד לא אושרה\* — "משאבת בטון"/);
  assert.match(r.text, /PO26000130/);
  assert.doesNotMatch(r.text, /PO26000082/, 'בטון בלי משאבה');
});

test('"הוזמן?" — לא נמצא · בלי פרויקט — שואל לאיזה · בלי פריוריטי בבוט — לא', async (t) => {
  reset(); ordersFake(t);
  const u = user({ role: 'admin' });
  assert.match((await ask(u, 'הוזמנו כפפות למגרש 50?')).text, /❌ \*לא מצאתי הזמנה\* של "כפפות" באלעד סנטר מגרש 50/);
  assert.match((await ask(u, 'הוזמנה מכולה?')).text, /לאיזה פרויקט\?/);
  // בלי שום מסמך במטריצה של משימון פריוריטי — לא מחפש בהזמנות
  const Access = require('../../../server/priority/priority-access');
  const emp = user({ role: 'employee' });
  Access.save([{ id: emp.id, docs: [], companies: null }]);
  assert.match((await ask(emp, 'הוזמנה מכולה למגרש 50?')).text, /פתוח רק למי שעובד עם פריוריטי בבוט/);
  Access.save([]);
});

test('"הדרישה על הפטישים הפכה להזמנה?" — שאלה על הדרישה; ההזמנות לפי הפרויקט ותאריך הדרישה', async (t) => {
  reset();
  let args = null;
  fake(t, {
    readDemand: async () => ({ PRDNO: 'PR26000066', STATDES: 'סגורה', PROJDOCNO: 'PR4', CURDATE: '2026-11-23T00:00:00Z', PDUSER_SUBFORM: [] }),
    ordersOfDemand: async (c, prdno, o) => { args = o; return [{ ORDNAME: 'PO26000138', STATDES: 'נשלחה לספק', CDES: 'טובול' }]; },
    myDemands: async () => []
  });
  const u = user({ role: 'employee' });
  botDoc(u, 'demand', 'PR26000066', { supplier: 'אלעד סנטר מגרש 50', note: 'פטישים' });
  assert.deepEqual(MyDocs.parse('הדרישה על הפטישים הפכה להזמנה?').kinds, ['demand']);
  const r = await ask(u, 'הדרישה על הפטישים הפכה להזמנה?');
  assert.deepEqual(args, { project: 'PR4', since: '2026-11-23' });
  assert.match(r.text, /✅ \*כן, אושרה\*/, '"סגורה" — אושרה והפכה להזמנה');
  assert.match(r.text, /הפכה להזמנה \*PO26000138\* לספק טובול/);
});
