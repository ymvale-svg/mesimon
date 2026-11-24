'use strict';
/**
 * ✍️ "ממתין לאישורך" — גילוי המסכים עם מאשרים, החותם הבא, הסבב, מה כל עובד רואה, החזרה מפריוריטי ומסך המנהלים.
 * האפיון: "אפיון — מסך אישורים במשימון פריוריטי.md". פריוריטי — זיוף בלבד.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Priority = require('../../../server/integrations/priority');
const W = require('../../../server/priority/priority-waiting');

boot();

const META = `<?xml version="1.0"?><edmx:Edmx><edmx:DataServices><Schema Namespace="Priority.OData">
<EntityType Name="PORDERS"><Key><PropertyRef Name="ORDNAME"/></Key><Property Name="ORDNAME" Type="Edm.String"/><Property Name="STATDES" Type="Edm.String"/>
  <Property Name="CDES" Type="Edm.String"/><Property Name="DISPRICE" Type="Edm.Decimal"/><Property Name="CURDATE" Type="Edm.DateTimeOffset"/><Property Name="OWNERLOGIN" Type="Edm.String"/>
  <Property Name="USERLOGIN" Type="Edm.String"/><NavigationProperty Name="PORDERITEMS_SUBFORM" Type="Collection(Priority.OData.PORDERITEMS)"/>
  <NavigationProperty Name="PORDERUSER_SUBFORM" Type="Collection(Priority.OData.PORDERUSER)"/></EntityType>
<EntityType Name="PORDERITEMS"><Key><PropertyRef Name="KLINE"/></Key><Property Name="KLINE" Type="Edm.Int64"/><Property Name="PARTNAME" Type="Edm.String"/></EntityType>
<EntityType Name="PORDERUSER"><Key><PropertyRef Name="USERLOGIN"/></Key><Property Name="USERLOGIN" Type="Edm.String"/><Property Name="ALTUSERLOGIN" Type="Edm.String"/>
  <Property Name="UFLAG" Type="Edm.String"/><Property Name="UDATE" Type="Edm.DateTimeOffset"/></EntityType>
<EntityType Name="DINVOICES"><Key><PropertyRef Name="IVNUM"/><PropertyRef Name="DEBIT"/></Key><Property Name="IVNUM" Type="Edm.String"/><Property Name="STATDES" Type="Edm.String"/>
  <Property Name="NEXTSIGNUSERLOGIN" Type="Edm.String"/><Property Name="SUPDES" Type="Edm.String"/></EntityType>
<EntityType Name="SUPPLIERS"><Key><PropertyRef Name="SUPNAME"/></Key><Property Name="SUPNAME" Type="Edm.String"/><Property Name="STATDES" Type="Edm.String"/></EntityType>
<EntityType Name="NOAPI"><Key><PropertyRef Name="DOCNO"/></Key><Property Name="DOCNO" Type="Edm.String"/><Property Name="STATDES" Type="Edm.String"/>
  <NavigationProperty Name="NOAPIUSER_SUBFORM" Type="Collection(Priority.OData.PORDERUSER)"/></EntityType>
<EntityContainer Name="C"><EntitySet Name="PORDERS" EntityType="Priority.OData.PORDERS"/><EntitySet Name="DINVOICES" EntityType="Priority.OData.DINVOICES"/>
  <EntitySet Name="SUPPLIERS" EntityType="Priority.OData.SUPPLIERS"/><EntitySet Name="NOAPI" EntityType="Priority.OData.NOAPI"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

const PR_USERS = [
  { USERLOGIN: 'GolanB', SNAME: 'גולן ב', EMAIL: 'golan@corp.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'GiladK', SNAME: 'גלעד כ', EMAIL: 'gilad@corp.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'Ghost', SNAME: 'רוח', EMAIL: 'ghost@nowhere.test', STATDES: 'עובד פעיל' },
  { USERLOGIN: 'RonitL', SNAME: 'רונית ל', EMAIL: 'ronit@corp.test', STATDES: 'עובד פעיל' }
];
const golan = user({ full_name: 'גולן ב', email: 'golan@corp.test', status: 'active' });
const gilad = user({ full_name: 'גלעד כ', email: 'gilad@corp.test', status: 'active' });
const other = user({ full_name: 'מישהו אחר', email: 'other@corp.test', status: 'active' });

const PO = (no, approvers, extra = {}) => ({ ORDNAME: no, STATDES: 'מחכה לאישור', CDES: 'ספק', DISPRICE: 1000, CURDATE: '2026-11-01T00:00:00Z', OWNERLOGIN: 'RonitL', PORDERUSER_SUBFORM: approvers, ...extra });

function reset() {
  D.run('DELETE FROM priority_waiting');
  for (const k of ['priority_waiting_found', 'priority_waiting_state', 'priority_waiting_types', 'priority_user_map']) D.setSetting(k, null);
}

/** זיוף פריוריטי: ‎docs[screen]‎ — מה שממתין בחברה הראשונה; ‎blocked‎ — מסכים סגורים ל-API */
function world(t, { docs = {}, blocked = ['NOAPI'], meta = META } = {}) {
  const first = require('../../../server/priority/priority-settings').companies().find((c) => !c.test).code;
  const blockErr = () => Object.assign(new Error('לא ניתן להפעיל API למסך זה.'), { status: 400 });
  const pr = Fakes.priority(t, {
    approvalScreens: async () => Priority.parseApprovalScreens(meta),
    waitingDoc: async (c, s, no) => {
      if (blocked.includes(s.screen)) throw blockErr();
      return (docs[s.screen] ?? []).find((d) => d[s.key] === no) ?? null;
    },
    waitingDocs: async (c, s) => {
      if (blocked.includes(s.screen)) throw blockErr();
      return c === first ? (docs[s.screen] ?? []) : [];
    },
    priorityUsers: async () => PR_USERS
  });
  return { pr, first, docs };
}

test('parseApprovalScreens — רק מסך עם סטטוס ומאשרים (או "החותם הבא"), עם המפתח והשדות שקיימים', () => {
  const l = Priority.parseApprovalScreens(META);
  assert.deepEqual(l.map((s) => s.screen), ['DINVOICES', 'NOAPI', 'PORDERS']);
  const po = l.find((s) => s.screen === 'PORDERS');
  assert.equal(po.key, 'ORDNAME');
  assert.equal(po.approvers, 'PORDERUSER_SUBFORM');
  assert.deepEqual(po.approverFields, ['USERLOGIN', 'ALTUSERLOGIN', 'UFLAG', 'UDATE']);
  assert.ok(po.fields.includes('CDES') && !po.fields.includes('SUPDES') && !po.fields.includes('ORDNAME'));
  const iv = l.find((s) => s.screen === 'DINVOICES');
  assert.equal(iv.approvers, null);
  assert.equal(iv.key, 'IVNUM');
});

test('docLink — המסך, המספר, החברה והסביבה בענן (tenant) בקישור של פריוריטי', () => {
  assert.equal(Priority.tenantOf('tabb2121.ini'), 'B2121');
  assert.equal(Priority.tenantOf('weird'), '');
  const link = Priority.docLink('a160226', 'MED_DOCUMENTS_P', 'PC260000236');
  assert.match(link, /^https:\/\/[^/]+\/webui\/openmail\.htm\?tenant=B2121&priority:priform@MED_DOCUMENTS_P:PC260000236:a160226:tabb2121\.ini:1$/);
});

test('docLink — בלי התוסף של פריוריטי, הדף של פריוריטי מעביר ל-/webui/B2121/ ולא לשורש (באג 404, 24.11.26)', () => {
  // הלוגיקה של openmail.htm בפריוריטי (OpenMail, בלי התוסף) — כפי שהיא בשרת
  const loc = Priority.docLink('a160226', 'MED_PORDERS', 'CO260000121');
  const i = loc.indexOf('?');
  const url = loc.slice(0, i);
  let par = loc.slice(i + 1);
  const m = /tenant=(.*?)&/.exec(par);
  const tenant = m ? m[1] : '';
  par = par.replace(/\+priority:/, 'priority:').replace(m ? m[0] : '', '');
  let noExt = par.replace('#', '&_disableplugin=1&_execute=');
  if (noExt === par) noExt = par.replace('@', '&_disableplugin=1&_execute=');
  const out = url.split('webui/openmail.htm')[0] + (tenant ? `webui/${tenant}/` : '') + '?' + noExt;
  assert.match(out, /^https:\/\/[^/]+\/webui\/B2121\/\?priority:priform&_disableplugin=1&_execute=MED_PORDERS:CO260000121:a160226:tabb2121\.ini:1$/);
});

test('signerOf — "החותם הבא", אחר כך הראשון שלא אישר; USERLOGIN בכותרת רק במסך בלי רשימה', () => {
  const s = { approvers: 'L' };
  assert.equal(W.signerOf({ NEXTSIGNUSERLOGIN: 'A', L: [{ USERLOGIN: 'B' }] }, s).signer, 'A');
  const g = W.signerOf({ USERLOGIN: 'AlexP', CURDATE: '2026-10-01', L: [{ USERLOGIN: 'X', UFLAG: 'Y', UDATE: '2026-11-02' }, { USERLOGIN: 'GolanB', ALTUSERLOGIN: 'GiladK' }, { USERLOGIN: 'Z' }] }, s);
  assert.deepEqual(g, { signer: 'GolanB', alt: 'GiladK', since: '2026-11-02' });
  // חשבון חלקי: USERLOGIN בכותרת אינו החותם — כשאין מאשר פתוח, אין חותם
  assert.equal(W.signerOf({ USERLOGIN: 'AlexP', L: [] }, s).signer, null);
  assert.equal(W.signerOf({ USERLOGIN: 'Solo', CURDATE: '2026-10-01' }, { approvers: null }).signer, 'Solo');
  assert.equal(W.signerOf({ USERLOGIN: 'Solo', CURDATE: '2026-10-01' }, { approvers: null }).since, '2026-10-01');
});

test('סבב: החותם רואה, המחליף רואה "כמחליף של", אחר — לא; הוותיק קודם; הקישור נבנה', async (t) => {
  reset();
  world(t, { docs: {
    PORDERS: [PO('PO1', [{ USERLOGIN: 'GolanB', ALTUSERLOGIN: 'GiladK' }]), PO('PO2', [{ USERLOGIN: 'GolanB' }], { CURDATE: '2026-09-01T00:00:00Z' })],
    DINVOICES: [{ IVNUM: 'T18', STATDES: 'מחכה לאישור', NEXTSIGNUSERLOGIN: 'GiladK', SUPDES: 'רז בר' }]
  } });
  await W.sweep({ force: true });
  const g = await W.forUser(golan.id);
  assert.deepEqual(g.items.map((x) => x.docno), ['PO2', 'PO1']);
  assert.equal(g.items[0].type, 'הזמנת רכש');
  assert.equal(g.items[0].owner, 'רונית ל');
  assert.equal(g.items[0].amount, 1000);
  assert.equal(g.items[0].level, 'late');
  assert.equal(g.items[0].altFor, null);
  assert.match(g.items[0].link, /priform@PORDERS:PO2:/);
  const k = await W.forUser(gilad.id);
  assert.deepEqual(k.items.map((x) => [x.docno, x.type, x.altFor]).sort(), [['PO1', 'הזמנת רכש', 'גולן ב'], ['T18', 'חשבון עסקה', null]]);
  assert.equal((await W.forUser(other.id)).items.length, 0);
  assert.ok(g.at);
});

test('סבב: מסמך שאושר בינתיים — יוצא; מסך שכובה — יוצא; מסך סגור ל-API — לא נקרא', async (t) => {
  reset();
  const w = world(t, { docs: { PORDERS: [PO('PO1', [{ USERLOGIN: 'GolanB' }]), PO('PO2', [{ USERLOGIN: 'GolanB' }])] } });
  await W.sweep({ force: true });
  assert.equal((await W.forUser(golan.id)).items.length, 2);
  w.docs.PORDERS = [w.docs.PORDERS[1]];
  await W.sweep({ force: true });
  assert.deepEqual((await W.forUser(golan.id)).items.map((x) => x.docno), ['PO2']);
  W.setType('PORDERS', { on: false });
  assert.equal((await W.forUser(golan.id)).items.length, 0);
  await W.sweep({ force: true });
  assert.equal((await W.forUser(golan.id)).items.length, 0);
  const v = await W.adminView();
  assert.equal(v.types.find((x) => x.screen === 'NOAPI').status, 'blocked');
  assert.equal(v.types.find((x) => x.screen === 'PORDERS').on, false);
});

test('סבב: לא רץ פעמיים בתוך 10 דקות (בלי force)', async (t) => {
  reset();
  world(t, { docs: { PORDERS: [PO('PO1', [{ USERLOGIN: 'GolanB' }])] } });
  assert.ok(await W.sweep());
  assert.equal(await W.sweep(), null);
});

test('גילוי: מסך חדש עם מאשרים — מופיע מיד בשם "מסמך לאישור", מסומן "חדש", והמנהלים מקבלים התראה', async (t) => {
  reset();
  const admin = user({ full_name: 'מנהל', email: 'admin-w@corp.test', role: 'admin', status: 'active' });
  world(t, { docs: { PORDERS: [PO('PO1', [{ USERLOGIN: 'GolanB' }])] } });
  await W.discover({ force: true });
  t.mock.restoreAll();
  const meta2 = META.replace('<EntityContainer Name="C">', `<EntityType Name="FRAMES"><Key><PropertyRef Name="FNO"/></Key><Property Name="FNO" Type="Edm.String"/><Property Name="STATDES" Type="Edm.String"/>
    <Property Name="CODEDES" Type="Edm.String"/><NavigationProperty Name="FRAMEUSER_SUBFORM" Type="Collection(Priority.OData.PORDERUSER)"/></EntityType><EntityContainer Name="C">`)
    .replace('</EntityContainer>', '<EntitySet Name="FRAMES" EntityType="Priority.OData.FRAMES"/></EntityContainer>');
  world(t, { meta: meta2, docs: { FRAMES: [{ FNO: 'FO4', STATDES: 'ממתינה לאישור', CODEDES: '', FRAMEUSER_SUBFORM: [{ USERLOGIN: 'GolanB' }] }] } });
  await W.discover({ force: true });
  await W.sweep({ force: true });
  const f = (await W.forUser(golan.id)).items.find((x) => x.docno === 'FO4');
  assert.equal(f.type, W.FALLBACK_NAME);
  assert.equal(f.isNew, true);
  const n = D.all("SELECT title FROM notifications WHERE target_id = ? AND title LIKE '%FRAMES%'", admin.id);
  assert.equal(n.length, 1);
  W.setType('FRAMES', { name: 'הזמנת מסגרת' });
  assert.equal((await W.forUser(golan.id)).items.find((x) => x.docno === 'FO4').type, 'הזמנת מסגרת');
});

test('לא מקושר — ברשימת המנהלים; אחרי קישור הוא רואה מיד', async (t) => {
  reset();
  world(t, { docs: { PORDERS: [PO('PO9', [{ USERLOGIN: 'Ghost' }]), PO('PO10', [])] } });
  await W.sweep({ force: true });
  const v = await W.adminView();
  assert.deepEqual(v.unmapped.map((u) => [u.login, u.name, u.count]), [['Ghost', 'רוח', 1]]);
  assert.deepEqual(v.noSigner.map((d) => d.docno), ['PO10']);
  W.mapUser('Ghost', other.id);
  assert.deepEqual((await W.forUser(other.id)).items.map((x) => x.docno), ['PO9']);
  assert.equal((await W.adminView()).unmapped.length, 0);
  assert.throws(() => W.mapUser('Ghost', 999999), /משתמש משימון פעיל/);
});

test('חזרה מפריוריטי: אושר ועבר לחותם הבא — יוצא, עם השם של הבא; עוד אצלו — נשאר', async (t) => {
  reset();
  const w = world(t, { docs: { PORDERS: [PO('PO1', [{ USERLOGIN: 'GolanB' }, { USERLOGIN: 'GiladK' }])] } });
  await W.sweep({ force: true });
  const id = (await W.forUser(golan.id)).items[0].id;
  assert.equal((await W.check(golan.id, id)).gone, false);
  assert.equal((await W.check(other.id, id)).gone, true, 'מסמך של אחר — לא נחשף');
  w.docs.PORDERS = [PO('PO1', [{ USERLOGIN: 'GolanB', UFLAG: 'Y', UDATE: '2026-11-20' }, { USERLOGIN: 'GiladK' }])];
  assert.deepEqual(await W.check(golan.id, id), { gone: true, docno: 'PO1', status: 'מחכה לאישור', next: 'גלעד כ' });
  assert.equal((await W.forUser(golan.id)).items.length, 0);
});

test('בלי חיבור לפריוריטי — אין סבב, ורשימה ריקה', async (t) => {
  reset();
  Fakes.priority(t, {}, { enabled: false });
  assert.equal(await W.sweep({ force: true }), null);
  assert.deepEqual((await W.forUser(golan.id)).items, []);
});
