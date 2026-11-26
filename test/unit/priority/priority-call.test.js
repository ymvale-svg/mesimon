'use strict';
/**
 * הקריאות לפריוריטי — בלי רשת: ‎fetch‎ מוחלף ב-‎t.mock.method(globalThis, 'fetch')‎ לקריאה בלבד.
 * כתיבה לא מזויפת: בודקים רק שהיא נחסמת לפני שיוצאת פנייה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Priority = require('../../../server/integrations/priority');

const HOST = 'https://p.priority-connect.online/odata/Priority/tabb2121.ini';

function withCreds(t, companies = 'test11') {
  const prev = process.env.PRIORITY_COMPANIES;
  process.env.PRIORITY_USER = 'TOKEN123';
  process.env.PRIORITY_PASSWORD = 'PAT';
  process.env.PRIORITY_COMPANIES = companies;
  t.after(() => {
    delete process.env.PRIORITY_USER;
    delete process.env.PRIORITY_PASSWORD;
    process.env.PRIORITY_COMPANIES = prev;
  });
}

/** ‎fetch‎ מזויף: רושם את הפניות ומחזיר תשובה לפי ‎reply(url, init)‎ */
function fakeFetch(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const r = await reply(String(url), init);
    if (r instanceof Response) return r;
    return new Response(r === null ? '' : JSON.stringify(r), { status: 200 });
  });
  return calls;
}

test('בלי משתמש וסיסמה — שגיאה ברורה, בלי פנייה', async (t) => {
  const calls = fakeFetch(t, () => ({ value: [] }));
  await assert.rejects(Priority.supplierByCode('test11', '1'), (err) => err instanceof Priority.PriorityError && /אינו מוגדר/.test(err.message));
  await assert.rejects(Priority._call('test11', 'GET', 'SUPPLIERS'), Priority.PriorityError);
  assert.equal(calls.length, 0);
});

test('הרשת חסומה בבדיקות — שגיאת חיבור, לא הצלחה', async (t) => {
  withCreds(t);
  await assert.rejects(Priority.supplierByCode('test11', '1'), (err) => err instanceof Priority.PriorityError && /אין חיבור לפריוריטי/.test(err.message));
});

test('כתיבה לחברה שאינה ברשימה — נחסמת לפני הפנייה', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t, () => ({}));
  await assert.rejects(Priority.setHeader('a160226', 'GR001', { DETAILS: 'x' }), /אינה פתוחה לכתיבה/);
  await assert.rejects(Priority.finalizeReceipt('mordot', 'GR001'), /PRIORITY_COMPANIES/);
  await assert.rejects(Priority.submitDemand('raba', 'PD1'), /אינה פתוחה לכתיבה/);
  await assert.rejects(Priority._call('a160226', 'POST', 'DOCUMENTS_P', { SUPNAME: '1' }), /אינה פתוחה לכתיבה/);
  assert.equal(calls.length, 0);
});

test('קריאה מחברה מוכרת שאינה פתוחה לכתיבה — מותרת', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t, () => ({ value: [{ SUPNAME: '100', SUPDES: 'ספק' }] }));
  const s = await Priority.supplierByCode('mordot', '100');
  assert.equal(s.SUPNAME, '100');
  assert.ok(calls[0].url.startsWith(`${HOST}/mordot/SUPPLIERS?`));
});

test('קריאה מחברה לא מוכרת — נחסמת', async (t) => {
  withCreds(t, 'test11');
  const calls = fakeFetch(t, () => ({ value: [] }));
  await assert.rejects(Priority.supplierByCode('evil', '1'), /אינה פתוחה לבוט/);
  assert.equal(calls.length, 0);
});

test('קוד חברה מקודד בכתובת', async (t) => {
  withCreds(t, 'a/b');
  const calls = fakeFetch(t, () => ({ value: [] }));
  await Priority.supplierByCode('a/b', '1');
  assert.ok(calls[0].url.startsWith(`${HOST}/a%2Fb/`));
});

test('הזדהות Basic ו-JSON', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t, () => ({ value: [] }));
  await Priority.supplierByCode('test11', '1');
  const h = calls[0].init.headers;
  assert.equal(h.authorization, `Basic ${Buffer.from('TOKEN123:PAT').toString('base64')}`);
  assert.equal(h.accept, 'application/json');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('OData — גרש בערך מוכפל ומקודד', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t, () => ({ value: [] }));
  await Priority.supplierByCode('test11', "O'Neil");
  const filter = decodeURIComponent(calls[0].url.match(/\$filter=([^&]+)/)[1]);
  assert.equal(filter, "SUPNAME eq 'O''Neil'");
  assert.ok(!calls[0].url.includes(' '));
});

test('supplierByCode — אין תוצאה: null', async (t) => {
  withCreds(t);
  fakeFetch(t, () => ({ value: [] }));
  assert.equal(await Priority.supplierByCode('test11', '1'), null);
});

test('שגיאת פריוריטי — הטקסט מ-InterfaceErrors, בלי "שורה N -"', async (t) => {
  withCreds(t);
  fakeFetch(t, () => new Response(JSON.stringify({ FORM: { InterfaceErrors: { text: 'שורה 1 - הספק אינו קיים' } } }), { status: 400 }));
  await assert.rejects(Priority.supplierByCode('test11', '1'), (err) => {
    assert.ok(err instanceof Priority.PriorityError);
    assert.equal(err.message, 'הספק אינו קיים');
    assert.equal(err.status, 400);
    return true;
  });
});

test('שגיאת פריוריטי — error.message, או הטקסט הגולמי', async (t) => {
  withCreds(t);
  let body = JSON.stringify({ error: { message: 'Not authorized' } });
  fakeFetch(t, () => new Response(body, { status: 401 }));
  await assert.rejects(Priority.supplierByCode('test11', '1'), { message: 'Not authorized', status: 401 });
  body = '<html>' + 'x'.repeat(500);
  await assert.rejects(Priority.supplierByCode('test11', '1'), (err) => err.message.length === 300 && err.message.startsWith('<html>'));
});

test('getOrder — 404: null; שגיאה אחרת נזרקת', async (t) => {
  withCreds(t);
  let status = 404;
  fakeFetch(t, () => new Response('{}', { status }));
  assert.equal(await Priority.getOrder('test11', 'PO1'), null);
  status = 500;
  await assert.rejects(Priority.getOrder('test11', 'PO1'), { status: 500 });
});

test('getOrder — כותרת בלי שדות @odata, ושורות', async (t) => {
  withCreds(t);
  fakeFetch(t, (url) => (url.includes('PORDERITEMS_SUBFORM')
    ? { value: [{ LINE: 1, PDES: 'מלט', TBALANCE: 5 }] }
    : { '@odata.context': 'x', ORDNAME: 'PO1', SUPNAME: '100' }));
  const o = await Priority.getOrder('test11', 'PO1');
  assert.equal(o.ORDNAME, 'PO1');
  assert.equal(o['@odata.context'], undefined);
  assert.equal(o.lines.length, 1);
});

test('findSuppliers — לפי ח.פ.: כל הצורות, בלי ספקים לא פעילים', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t, () => ({ value: [
    { SUPNAME: '1', SUPDES: 'ספק פעיל', STATDES: 'פעיל' },
    { SUPNAME: '2', SUPDES: 'ספק ישן', STATDES: 'לא פעיל' },
    { SUPNAME: '3', SUPDES: 'לא פעיל - ספק', STATDES: 'פעיל' }
  ] }));
  const r = await Priority.findSuppliers('test11', { vat: '23043854' });
  assert.equal(r.by, 'vat');
  assert.deepEqual(r.list.map((x) => x.SUPNAME), ['1']);
  const filter = decodeURIComponent(calls[0].url.match(/\$filter=([^&]+)/)[1]);
  assert.match(filter, /COMPNUM eq '23043854'/);
  assert.match(filter, /COMPNUM eq '023043854'/);
  assert.match(filter, /VATNUM eq '23043854'/);
});

test('findSuppliers — לפי השם: התאמה ברורה נבחרת', async (t) => {
  withCreds(t);
  fakeFetch(t, () => ({ value: [
    { SUPNAME: '10', SUPDES: 'זיו מערכות לניהול בניה בעמ' },
    { SUPNAME: '11', SUPDES: 'אלון מערכות מיזוג' }
  ] }));
  const r = await Priority.findSuppliers('test11', { name: 'זיו מערכות לניהול בניה' });
  assert.equal(r.by, 'name');
  assert.equal(r.weak, false);
  assert.deepEqual(r.list.map((x) => x.SUPNAME), ['10']);
});

test('findSuppliers — אין מילים משותפות: רשימה ריקה', async (t) => {
  withCreds(t);
  fakeFetch(t, () => ({ value: [] }));
  assert.deepEqual(await Priority.findSuppliers('test11', { name: 'ספק' }), { by: null, list: [] });
});

test('nextSigner לא פונה לרשת', (t) => {
  const calls = fakeFetch(t, () => ({}));
  Priority.nextSigner({ USERLOGIN: 'a' });
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// כרטיס ספק, כתובת מחסן, בניינים בכרטיס הפרויקט (23.11.26) — קריאה בלבד
// ---------------------------------------------------------------------------

test('supplierContact — מייל, טלפון ואיש קשר מכרטיס הספק, לפי שם השדה', async (t) => {
  withCreds(t);
  fakeFetch(t, (url) => (/SUPPERSONNEL_SUBFORM/.test(url)
    ? { value: [{ NAME: 'יוסי לוי', CELLPHONE: '050-1111111', EMAIL: 'Yossi@Sup.co.il' }] }
    : { value: [{ SUPNAME: 'S1', SUPDES: 'ספק', EMAIL: 'Orders@Sup.co.il ', PHONE: '04-8888888', VATNUM: '5' }] }));
  const c = await Priority.supplierContact('test11', 'S1');
  assert.deepEqual(c, { email: 'orders@sup.co.il', phone: '04-8888888', contact: { name: 'יוסי לוי', phone: '050-1111111', email: 'yossi@sup.co.il' } });
});

test('supplierContact — טבלת אנשי הקשר סגורה: בלי איש קשר, בלי שגיאה', async (t) => {
  withCreds(t);
  fakeFetch(t, (url) => (/SUPPERSONNEL_SUBFORM/.test(url) ? new Response('{"error":{"message":"no"}}', { status: 403 }) : { value: [{ SUPNAME: 'S2', EMAIL: '' }] }));
  assert.deepEqual(await Priority.supplierContact('test11', 'S2'), { email: '', phone: '', contact: null });
});

test('warehouseAddress — כל שדות הכתובת בכרטיס המחסן', async (t) => {
  withCreds(t);
  fakeFetch(t, () => ({ value: [{ WARHSNAME: 'W1', WARHSDES: 'מחסן אלעד', ADDRESS: 'הרב קוק 12', STATEA: 'אלעד', ZIPCODE: '' }] }));
  assert.equal(await Priority.warehouseAddress('test11', 'W1'), 'הרב קוק 12, אלעד');
  assert.equal(await Priority.warehouseAddress('test11', ''), '');
});

test('projectChapters — מוצא לבד את טבלת תתי הפרקים בכרטיס הפרויקט; בניין ← המשאבים שמתחתיו', async (t) => {
  withCreds(t, 'tabb21');
  const META = '<Edmx><EntityType Name="DOCUMENTS_p"><Property Name="DOCNO"/><NavigationProperty Name="PROJMANAGERS_SUBFORM" Type="x"/><NavigationProperty Name="BUD_BUDGET_SUBFORM" Type="y"/></EntityType><EntityType Name="OTHER"><NavigationProperty Name="NOPE_SUBFORM"/></EntityType></Edmx>';
  const calls = fakeFetch(t, (url) => {
    if (/\$metadata/.test(url)) return new Response(META, { status: 200 });
    if (/PROJMANAGERS_SUBFORM/.test(url)) return { value: [{ USERLOGIN: 'x' }] };
    if (/BUD_BUDGET_SUBFORM/.test(url)) {
      return { value: [
        { BUD_SUBCHAPTERNAME: '210', BUD_SUBCHAPTERDES: 'מבנה A', BUD_SUBTOPICNAME: '210-10', BUD_SUBTOPICDES: 'בטון' },
        { BUD_SUBCHAPTERNAME: '210', BUD_SUBCHAPTERDES: 'מבנה A', BUD_SUBTOPICNAME: '210-20', BUD_SUBTOPICDES: 'בלוקים' },
        { BUD_SUBCHAPTERNAME: '220', BUD_SUBCHAPTERDES: 'מבנה B', BUD_SUBTOPICNAME: '220-10', BUD_SUBTOPICDES: 'בטון' }
      ] };
    }
    return { value: [] };
  });
  const list = await Priority.projectChapters('tabb21', 'PR1');
  assert.deepEqual(list, [
    { chapter: '210', chapterDes: 'מבנה A', topics: [{ topic: '210-10', topicDes: 'בטון' }, { topic: '210-20', topicDes: 'בלוקים' }] },
    { chapter: '220', chapterDes: 'מבנה B', topics: [{ topic: '220-10', topicDes: 'בטון' }] }
  ]);
  assert.ok(calls.every((c) => (c.init?.method ?? 'GET') === 'GET'), 'קריאה בלבד');
  // הטבלה נזכרת — פרויקט נוסף בלי חיפוש מחדש
  const before = calls.length;
  await Priority.projectChapters('tabb21', 'PR2');
  assert.equal(calls.length - before, 1);
  assert.match(calls.at(-1).url, /DOCUMENTS_p\('PR2'\)\/BUD_BUDGET_SUBFORM/);
});

test('projectChapters — אין טבלה עם תתי פרקים: null (הבוט לא שואל על בניין)', async (t) => {
  withCreds(t, 'tabb22');
  fakeFetch(t, (url) => (/\$metadata/.test(url) ? new Response('<EntityType Name="DOCUMENTS_p"><NavigationProperty Name="X_SUBFORM"/></EntityType>', { status: 200 }) : { value: [{ A: 1 }] }));
  assert.equal(await Priority.projectChapters('tabb22', 'PR1'), null);
});

test('דרישות של עובד — לפי מי שפתח (INITUSERLOGIN), לא לפי הבעלים (הוחלט 26.11.26)', async (t) => {
  withCreds(t);
  const calls = fakeFetch(t, () => ({ value: [{ PRDNO: 'PR1' }] }));
  const r = await Priority.myDemands('test11', ['RavivK'], '2026-06-01');
  assert.equal(r[0].PRDNO, 'PR1');
  const url = decodeURIComponent(calls[0].url);
  assert.match(url, /PURDEMANDS\?\$filter=\(INITUSERLOGIN eq 'RavivK'\) and CURDATE ge 2026-06-01T00:00:00Z/);
  assert.doesNotMatch(url, /OWNERLOGIN eq/);
  assert.deepEqual(await Priority.myDemands('test11', [], '2026-06-01'), [], 'בלי שם משתמש — בלי פנייה');
  assert.equal(calls.length, 1);
});
