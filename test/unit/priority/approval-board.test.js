'use strict';
/**
 * ✍️ לוח האישורים (‎server/priority/approval-board.js‎; "אפיון — מעקב אישורים ותשלומים.md" סעיפים 3–4):
 * ממתי, כמה ימים, צבע, שתי הרשימות לעובד, הקישור לפריוריטי, ומיילי הבוקר (למאשר ולשולח; תקוע 3 ימים — בראש).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Priority = require('../../../server/integrations/priority');
const Settings = require('../../../server/priority/priority-settings');
const B = require('../../../server/priority/approval-board');

boot();
const TODAY = '2026-11-26';

// ---------------------------------------------------------------- צבע וממתי
test('colorOf — ירוק 0–2, צהוב 3–4, כתום 5–6, אדום מ-7', () => {
  assert.deepEqual([0, 2, 3, 4, 5, 6, 7, 30].map((d) => B.colorOf(d)), ['green', 'green', 'yellow', 'yellow', 'orange', 'orange', 'red', 'red']);
});

test('colorOf — מסמך תשלום כשה-15 בעוד 3 ימים או פחות: לפחות כתום', () => {
  assert.equal(B.colorOf(0, { kind: 'partial', today: '2026-12-13' }), 'orange');
  assert.equal(B.colorOf(0, { kind: 'contract', today: '2026-12-13' }), 'green', 'חוזה — לא מסמך תשלום');
  assert.equal(B.colorOf(0, { kind: 'deal', today: '2026-12-05' }), 'green', 'ה-15 רחוק');
  assert.equal(B.colorOf(8, { kind: 'deal', today: '2026-12-14' }), 'red');
  assert.equal(B.next15('2026-12-16'), '2027-01-15');
});

test('sinceOf — החתימה האחרונה; אף אחד לא חתם — תאריך המסמך', () => {
  const d = { CURDATE: '2026-11-10T00:00:00Z', PORDERUSER_SUBFORM: [{ USERLOGIN: 'a', UFLAG: 'Y', UDATE: '2026-11-20T10:57:00Z' }, { USERLOGIN: 'b' }] };
  assert.equal(B.sinceOf('contract', d), '2026-11-20');
  assert.equal(B.sinceOf('contract', { CURDATE: '2026-11-10T00:00:00Z', PORDERUSER_SUBFORM: [{ USERLOGIN: 'a' }] }), '2026-11-10');
  assert.equal(B.sinceOf('deal', { IVDATE: '2026-09-24T00:00:00Z', PYINVUSER_SUBFORM: [] }), '2026-09-24');
});

test('rowOf — חוזה: מספר, ספק, חותם, ימים וצבע', () => {
  const r = B.rowOf('a160226', 'contract', { ORDNAME: 'CO1', MED_TYPE: 'CO', CDES: 'סער', TOTPRICE: 126024, USERLOGIN: 'GolanB', OWNERLOGIN: 'AlexP',
    CURDATE: '2026-11-01T00:00:00Z', PORDERUSER_SUBFORM: [{ USERLOGIN: 'TengizG', UFLAG: 'Y', UDATE: '2026-11-20T00:00:00Z' }, { USERLOGIN: 'GolanB' }] }, TODAY);
  assert.equal(r.key, 'a160226:contract:CO1');
  assert.equal(r.label, 'חוזה');
  assert.equal(r.signer, 'GolanB');
  assert.equal(r.owner, 'AlexP');
  assert.equal(r.days, 6);
  assert.equal(r.color, 'orange');
  assert.deepEqual(r.approvers.map((a) => a.signed), [true, false]);
});

test('linkOf — לפי התבנית; בלי תבנית — ריק', () => {
  const row = { kind: 'partial', no: 'PC260000236', company: 'a160226' };
  assert.equal(B.linkOf(row, 'https://prio.test/open?f={form}&d={doc}&c={company}'), 'https://prio.test/open?f=MED_DOCUMENTS_P&d=PC260000236&c=a160226');
  assert.equal(B.linkOf(row, ''), '');
});

// ---------------------------------------------------------------- הרשימות לעובד
function fake(t, docs) {
  t.mock.method(Priority, 'isEnabled', () => true);
  t.mock.method(Settings, 'pdNotifyCompanies', () => ['a160226']);
  t.mock.method(Settings, 'defaults', () => ({ docLink: 'https://prio.test/{form}/{doc}' }));
  t.mock.method(Priority, 'waitingDemands', async () => docs.demand ?? []);
  t.mock.method(Priority, 'waitingForApproval', async (c, kind) => docs[kind] ?? []);
  B._reset();
}

const eli = user({ full_name: 'אלעד חדד', email: 'elad.b@corp.test' });
const hana = user({ full_name: 'חנה גנוט', email: 'hana.b@corp.test' });
const PR_USERS = [
  { USERLOGIN: 'Eladh', SNAME: 'אלעד חדד', EMAIL: 'elad.b@corp.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'HanaG', SNAME: 'חנה גנוט', EMAIL: 'hana.b@corp.test', STATDES: 'עובד פעיל' }
];
const DOCS = {
  contract: [
    // חנה שלחה (היוזם רשום בשם מלא, כמו בפריוריטי), תקוע אצל אלעד 8 ימים
    { ORDNAME: 'CO-A', CDES: 'ספק א', USERLOGIN: 'Eladh', OWNERLOGIN: 'חנה (חני) גנוט', CURDATE: '2026-11-18T00:00:00Z', PORDERUSER_SUBFORM: [{ USERLOGIN: 'Eladh' }] },
    // אלעד שלח, תקוע אצל מישהו אחר
    { ORDNAME: 'CO-B', CDES: 'ספק ב', USERLOGIN: 'GiladK', OWNERLOGIN: 'Eladh', CURDATE: '2026-11-25T00:00:00Z', PORDERUSER_SUBFORM: [{ USERLOGIN: 'GiladK' }] }
  ],
  partial: [{ DOCNO: 'PC-A', CDES: 'ספק ג', MED_USERLOGIN: 'Eladh', OWNERLOGIN: 'HanaG', CURDATE: '2026-11-25T00:00:00Z', MED_PDOCUSER_SUBFORM: [{ USERLOGIN: 'Eladh' }] }]
};

test('forUser — מי שגם שולח וגם מאשר: שתי רשימות נפרדות; הוותיק קודם; קישור לפריוריטי', async (t) => {
  fake(t, DOCS);
  t.mock.method(Priority, 'priorityUsers', async () => PR_USERS);
  const r = await B.forUser({ id: eli.id }, { today: TODAY });
  assert.equal(r.login, 'Eladh');
  assert.deepEqual(r.waiting.map((x) => x.no), ['CO-A', 'PC-A']);
  assert.equal(r.waiting[0].days, 8);
  assert.equal(r.waiting[0].color, 'red');
  assert.equal(r.waiting[0].link, 'https://prio.test/MED_PORDERS/CO-A');
  assert.deepEqual(r.sent.map((x) => x.no), ['CO-B']);
  assert.equal(r.sent[0].signerName, 'GiladK', 'לא במשתמשי פריוריטי — שם המשתמש');
});

test('forUser — היוזם בשם מלא ("חנה (חני) גנוט") מזוהה לפי השם', async (t) => {
  fake(t, DOCS);
  t.mock.method(Priority, 'priorityUsers', async () => PR_USERS);
  const r = await B.forUser({ id: hana.id }, { today: TODAY });
  assert.deepEqual(r.sent.map((x) => x.no), ['CO-A', 'PC-A']);
  assert.equal(r.sent[0].signerName, 'אלעד חדד');
  assert.deepEqual(r.waiting, []);
});

// ---------------------------------------------------------------- המיילים
test('approverMail — קישור לכל מסמך, ונושא עם "7 ימים ומעלה" כשיש אדום', () => {
  const rows = [{ label: 'חוזה', no: 'CO-A', company: 'a160226', supplier: 'ספק א', amount: 1000, ownerName: 'חנה', days: 8, since: '2026-11-18', color: 'red', link: 'https://prio.test/x' }];
  const m = B.approverMail(rows);
  assert.match(m.subject, /ממתינים לאישורך בפריוריטי: 1 מסמך \(חלקם 7 ימים ומעלה\)/);
  assert.match(m.html, /<a href="https:\/\/prio\.test\/x">חוזה CO-A<\/a>/);
  assert.match(m.text, /לחיצה על מסמך פותחת אותו בפריוריטי/);
  assert.equal(B.approverMail([]), null);
});

test('senderMail — תקוע 3 ימים ומעלה: בראש, בדגל אדום ובנושא; בלי קישורים', () => {
  const rows = [
    { label: 'חשבון חלקי', no: 'PC-NEW', company: 'a160226', signerName: 'גולן', days: 1, since: '2026-11-25', color: 'green', link: 'https://x' },
    { label: 'חוזה', no: 'CO-OLD', company: 'a160226', signerName: 'אלעד', days: 4, since: '2026-11-22', color: 'yellow', link: 'https://x' }
  ];
  const m = B.senderMail(rows);
  assert.match(m.subject, /🚩 1 מסמך ששלחת עדיין לא אושר \(3 ימים ומעלה\)/);
  assert.ok(m.text.indexOf('CO-OLD') < m.text.indexOf('PC-NEW'), 'התקוע בראש');
  assert.match(m.text, /🚩 חוזה CO-OLD .* תקוע אצל אלעד · 4 ימים/);
  assert.doesNotMatch(m.html, /https:\/\/x/);
  assert.match(B.senderMail([rows[0]]).subject, /⏳ ממתינים לאישור: 1 מסמכים ששלחת/);
});

test('morning — פעם ביום, מ-08:00: למאשר ולשולח; לפני 08:00 — כלום', async (t) => {
  fake(t, DOCS);
  t.mock.method(Priority, 'priorityUsers', async () => PR_USERS);
  D.setSetting('approval_digest_sent', {});
  const sent = [];
  const deliver = async (u, m) => { if (m) sent.push({ id: u.id, subject: m.subject }); return Boolean(m); };
  assert.deepEqual(await B.morning(new Date('2026-11-26T05:00:00Z'), { deliver }), [], '07:00 בישראל');
  const out = await B.morning(new Date('2026-11-26T07:30:00Z'), { deliver });   // 09:30
  const me = out.find((x) => x.user.id === eli.id);
  assert.deepEqual({ a: me.approver, s: me.sender }, { a: true, s: true });
  const hanaOut = out.find((x) => x.user.id === hana.id);
  assert.deepEqual({ a: hanaOut.approver, s: hanaOut.sender }, { a: false, s: true });
  assert.ok(sent.some((x) => x.id === hana.id && /🚩 1 מסמך ששלחת עדיין לא אושר/.test(x.subject)), 'CO-A תקוע 8 ימים');
  const n = sent.length;
  assert.deepEqual(await B.morning(new Date('2026-11-26T08:30:00Z'), { deliver }), [], 'פעם אחת ביום');
  assert.equal(sent.length, n);
});

test('settings — docLink: חייב {doc} ו-https', () => {
  assert.throws(() => Settings.save({ defaults: { docLink: 'https://prio.test/x' } }), /חסר \{doc\}/);
  assert.throws(() => Settings.save({ defaults: { docLink: 'ftp://x/{doc}' } }), /https/);
  assert.equal(Settings.save({ defaults: { docLink: 'https://prio.test/{form}/{doc}' } }).defaults.docLink, 'https://prio.test/{form}/{doc}');
  Settings.save({ defaults: { docLink: '' } });
});
