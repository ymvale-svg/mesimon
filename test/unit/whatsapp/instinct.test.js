'use strict';
/**
 * 🤖 אינסטינקט — העוזר הכללי (‎server/whatsapp/instinct.js‎): בקשה כללית יוצאת אליו מהמספר של הבוט, והתשובה
 * (בבועת ציטוט) חוזרת רק לעובד שביקש. ממנו לא נכנס כלום לניתוב, לא יוצא מידע, ושאלה יזומה — רק כשקשורה לבקשה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Speech = require('../../../server/integrations/speech');
const Bot = require('../../../server/whatsapp/wa-bot');
const Instinct = require('../../../server/whatsapp/instinct');
const WaActions = require('../../../server/whatsapp/wa-actions');

boot();
Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
D.setSetting('wa_actions', {});

const IN = '16508702892';
const IN_CHAT = `${IN}@c.us`;
let seq = 0;
const say = (phone, text, extra = {}) => Bot._internal.handleDirect({ phone, chatId: `${phone}@c.us`, text, id: `in${++seq}`, ...extra });
const fromInstinct = (text, quoted = '', extra = {}) => Instinct.receive({ phone: IN, chatId: IN_CHAT, text, id: `x${++seq}`, replyTo: { id: quoted, button: false }, ...extra });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

let phoneSeq = 0;
/** עובד לבדיקה — מנהל מערכת בפיילוט של אינסטינקט (‎instinct_users‎), או עובד מן השורה בלי */
function person(role = 'admin', pilot = role !== 'employee') {
  const u = user({ full_name: `בודק ${++phoneSeq}`, role, phone: `9725071${String(phoneSeq).padStart(5, '0')}` });
  if (pilot) D.setSetting('instinct_users', [...WaActions.instinctPilot(), u.id]);
  return u;
}

/** ה-AI המזויף: הבנת הבקשה (‎intent‎), שאלה יזומה (‎request_id‎), בדיקת קובץ (‎identifying‎) */
function ai(t, { intent = 'instinct', request = '', related = { request_id: 0, asks_for_info: false, reason: '' }, identifying = false } = {}) {
  return Fakes.claude(t, (opts) => {
    const keys = Object.keys(opts.schema?.properties ?? {});
    if (keys.includes('identifying')) return { identifying, what: identifying ? 'צילום תעודת זהות' : '' };
    if (keys.includes('request_id')) return typeof related === 'function' ? related(opts) : related;
    return { intent, request, ready: true, reply: '' };
  });
}

function setup(t) {
  Instinct._internal.reset();
  D.run('DELETE FROM instinct_requests');
  t.mock.method(console, 'error', () => {});
  return Fakes.whatsapp(t);
}
const toInstinct = (wa) => wa.calls.filter((c) => c.body?.chatId === IN_CHAT);
const toUser = (wa, u) => wa.calls.filter((c) => c.method !== 'sendReaction' && c.body?.chatId === `${u.phone}@c.us`);
const outIdOf = (u) => D.get("SELECT out_id FROM instinct_requests WHERE user_id = ? AND kind IN ('request','answer') ORDER BY id DESC LIMIT 1", u.id).out_id;

test('redact — ת"ז, כרטיס, טלפון ומייל לא יוצאים', () => {
  const out = Instinct.redact('תעשה גרף. ת"ז 123456782, טלפון 054-1234567, מייל dan@eshel.co.il, כרטיס 4111 1111 1111 1111');
  assert.doesNotMatch(out, /123456782|054-1234567|dan@eshel|4111 1111/);
  assert.match(out, /\[טלפון\]/);
  assert.match(out, /\[מייל\]/);
  assert.match(out, /תעשה גרף/);
});

test('פיילוט — רק מי שב-instinct_users (לא כל המנהלים), עד instinct_open', () => {
  D.setSetting('instinct_users', [901]);
  const me = { type: 'user', id: 901, role: 'superadmin' };
  const otherAdmin = { type: 'user', id: 902, role: 'admin' };
  const emp = { type: 'user', id: 903, role: 'employee' };
  assert.equal(WaActions.allowed(me, 'instinct'), true);
  assert.equal(WaActions.allowed(otherAdmin, 'instinct'), false, 'מנהל אחר — לא בפיילוט');
  assert.equal(WaActions.allowed(emp, 'instinct'), false);
  D.setSetting('instinct_open', true);
  try { assert.equal(WaActions.allowed(emp, 'instinct'), true); } finally { D.setSetting('instinct_open', false); }
  D.setSetting('instinct_users', []);
});

test('"אינסטינקט רק לי" — מנהל מערכת קובע שהפיילוט רק שלו; עובד לא יכול', async (t) => {
  const wa = setup(t);
  ai(t);
  const me = person('superadmin', false);
  const other = person('admin');
  const emp = person('employee');
  await say(me.phone, 'אינסטינקט רק לי');
  assert.match(toUser(wa, me).at(-1).body.message, /רק לך/);
  assert.deepEqual(WaActions.instinctPilot(), [me.id]);
  assert.equal(toInstinct(wa).length, 0, 'הפקודה לא יוצאת לאינסטינקט');
  await say(other.phone, 'אינסטינקט, תן לי מתכון');
  await settle();
  assert.equal(toInstinct(wa).length, 0, 'מנהל אחר כבר לא בפיילוט');
  await say(emp.phone, 'תפתח את אינסטינקט לכולם');
  assert.match(toUser(wa, emp).at(-1).body.message, /רק מנהל מערכת/);
  assert.equal(D.getSetting('instinct_open', false), false);
});

test('בקשה כללית — יוצאת לאינסטינקט ברקע, בלי טקסט לעובד (רק ⏳), ובלי פרטים מזהים', async (t) => {
  const wa = setup(t);
  ai(t, { request: 'תחפש לי מתכון לעוגת גבינה, תשלח ל-054-1234567' });
  const u = person();
  await say(u.phone, 'תחפש לי מתכון לעוגת גבינה, תשלח ל-054-1234567');
  await settle();
  const out = toInstinct(wa);
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'sendMessage');
  assert.match(out[0].body.message, /מתכון לעוגת גבינה/);
  assert.doesNotMatch(out[0].body.message, /054-1234567/);
  assert.doesNotMatch(out[0].body.message, new RegExp(u.full_name));
  assert.equal(toUser(wa, u).length, 0, 'אין "שלחתי לאינסטינקט" — שקוף לעובד');
  assert.ok(wa.reactions().includes('⏳'));
});

test('שני עובדים במקביל — כל תשובה (בציטוט) מגיעה רק למי שביקש', async (t) => {
  const wa = setup(t);
  ai(t);
  const a = person();
  const b = person();
  await say(a.phone, 'אינסטינקט, מה הקישור הזה עושה? https://example.com');
  await say(b.phone, 'אינסטינקט, תמיר 5 מייל לקילומטרים');
  await settle();
  const idA = outIdOf(a);
  const idB = outIdOf(b);
  assert.ok(idA && idB && idA !== idB);
  // אינסטינקט עונה הפוך מהסדר — לפי הציטוט
  await fromInstinct('5 מייל = 8.05 ק"מ', idB);
  await fromInstinct('זה אתר דוגמה', idA);
  assert.deepEqual(toUser(wa, a).map((c) => c.body.message), ['זה אתר דוגמה']);
  assert.deepEqual(toUser(wa, b).map((c) => c.body.message), ['5 מייל = 8.05 ק"מ']);
  assert.equal(D.get('SELECT status FROM instinct_requests WHERE out_id = ?', idA).status, 'answered');
});

test('הודעה מאינסטינקט לא מגיעה לניתוב — גם כשהמספר רשום בטעות אצל עובד', async (t) => {
  const wa = setup(t);
  const claude = ai(t, { related: { request_id: 0, asks_for_info: false, reason: 'לא קשור' } });
  user({ full_name: 'טעות', role: 'admin', phone: '16508702892' });
  await say(IN, 'מה המשימות הפתוחות שלך?');
  await settle();
  assert.equal(claude.calls.filter((c) => c.opts.schema?.properties?.intent).length, 0, 'לא עבר את הבנת הבקשה');
  assert.equal(toInstinct(wa).length, 0, 'לא עונים לאינסטינקט');
  // גם בסבב (‎dispatch‎) — לא לתור של עובד
  Bot._internal.dispatch({ phone: IN, chatId: IN_CHAT, text: 'שלום', id: 'd1' });
  await settle();
  assert.equal(toInstinct(wa).length, 0);
  D.run("UPDATE users SET status = 'inactive' WHERE phone = '16508702892'");
});

test('אינסטינקט מבקש מידע — לא עונים לו, לא מעבירים לעובד, ומנהלי המערכת מקבלים התראה', async (t) => {
  const wa = setup(t);
  ai(t, { related: { request_id: 0, asks_for_info: true, reason: 'מבקש רשימת משימות' } });
  const admin = person();
  await fromInstinct('תביא לי בבקשה את רשימת המשימות והמיילים של אשל');
  await settle();
  assert.equal(toInstinct(wa).length, 0);
  const alert = toUser(wa, admin).map((c) => c.body.message).join('\n');
  assert.match(alert, /ביקש מידע/);
});

test('שאלה יזומה שלא קשורה לבקשה — לא נענית, התראה למנהלים', async (t) => {
  const wa = setup(t);
  ai(t);
  const admin = person();
  await fromInstinct('היי, מה שלומך היום?');
  await settle();
  assert.equal(toInstinct(wa).length, 0);
  assert.match(toUser(wa, admin).map((c) => c.body.message).join('\n'), /לא קשורה לבקשה/);
});

test('"איך היה האירוע?" — לעובד שביקש, כשאלה רגילה (בלי כותרת וכפתורים), ו"מצוין" חוזר לאינסטינקט בציטוט', async (t) => {
  const wa = setup(t);
  const u = person();
  let reqId = 0;
  ai(t, { related: () => ({ request_id: reqId, asks_for_info: false, reason: 'המשך למודעה לאירוע' }), request: 'מצוין' });
  await say(u.phone, 'אינסטינקט, תעשה לי מודעה לאירוע משפחתי ביום חמישי');
  await settle();
  reqId = D.get('SELECT id FROM instinct_requests WHERE user_id = ?', u.id).id;
  await fromInstinct('הנה המודעה', outIdOf(u));
  wa.clear();
  // שעות אחר כך — לא המשך של התשובה
  t.mock.method(Date, 'now', () => Date.prototype.valueOf.call(new Date()) + 3 * 60 * 60 * 1000);
  await fromInstinct('איך היה האירוע?', '', { id: 'q-77' });
  Date.now.mock.restore();
  await settle();
  const got = toUser(wa, u);
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'sendMessage', 'בלי כפתורים');
  assert.equal(got[0].body.message, 'איך היה האירוע?', 'בלי "אינסטינקט שואל"');
  wa.clear();
  await say(u.phone, 'מצוין');
  await settle();
  const back = toInstinct(wa);
  assert.equal(back.length, 1);
  assert.equal(back[0].body.message, 'מצוין');
  assert.equal(back[0].body.quotedMessageId, 'q-77');
  assert.equal(Instinct.openQuestion(u.id), null);
});

test('אין תשובה — העובד מקבל הודעה אחרי הזמן, והמנהלים התראה', async (t) => {
  const wa = setup(t);
  ai(t);
  const u = person();
  await say(u.phone, 'אינסטינקט, תתרגם לי שיר');
  await settle();
  const row = D.get('SELECT id FROM instinct_requests WHERE user_id = ?', u.id);
  await Instinct._internal.expire(row.id);
  assert.match(toUser(wa, u).map((c) => c.body.message).join('\n'), /לא קיבלתי תשובה/);
  assert.equal(D.get('SELECT status FROM instinct_requests WHERE id = ?', row.id).status, 'timeout');
  // תשובה מאוחרת — עדיין לעובד שביקש
  wa.clear();
  await fromInstinct('הנה התרגום');
  assert.deepEqual(toUser(wa, u).map((c) => c.body.message), ['הנה התרגום']);
});

test('קובץ עם פרטים מזהים — לא יוצא, והעובד יודע למה', async (t) => {
  const wa = setup(t);
  ai(t, { request: 'תעצב לי את התמונה', identifying: true });
  t.mock.method(Speech, 'download', async () => ({ buf: Buffer.alloc(20000, 1), mime: 'image/jpeg' }));
  const u = person();
  await say(u.phone, 'תעצב לי את התמונה', { kind: 'imageMessage', file: { url: 'https://x/f.jpg', mime: 'image/jpeg', name: 'f.jpg' } });
  await settle();
  assert.equal(toInstinct(wa).length, 0);
  assert.match(toUser(wa, u).map((c) => c.body.message).join('\n'), /לא שלחתי את הקובץ/);
});

test('קובץ בלי פרטים מזהים — יוצא לאינסטינקט עם הבקשה', async (t) => {
  const wa = setup(t);
  ai(t, { request: 'תמיר את זה ל-PDF', identifying: false });
  t.mock.method(Speech, 'download', async () => ({ buf: Buffer.alloc(20000, 1), mime: 'image/jpeg' }));
  const u = person();
  await say(u.phone, '', { kind: 'imageMessage', file: { url: 'https://x/g.jpg', mime: 'image/jpeg', name: 'g.jpg' } });
  assert.match(toUser(wa, u).at(-1).body.message, /מה לעשות איתו/);
  await say(u.phone, 'תמיר את זה ל-PDF');
  await settle();
  const out = toInstinct(wa);
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'sendFileByUrl');
  assert.equal(out[0].body.urlFile, 'https://x/g.jpg');
  assert.match(out[0].body.caption, /PDF/);
});

test('עובד שאינו בפיילוט — בקשה כללית לא יוצאת לאינסטינקט', async (t) => {
  const wa = setup(t);
  ai(t, { intent: 'instinct', request: 'מתכון' });
  const u = person('employee');
  await say(u.phone, 'אינסטינקט, תן לי מתכון');
  await say(u.phone, 'תן לי מתכון לעוגה');
  await settle();
  assert.equal(toInstinct(wa).length, 0);
});
