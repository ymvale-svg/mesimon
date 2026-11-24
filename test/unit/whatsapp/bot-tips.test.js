'use strict';
/**
 * 💡 הטיפ היומי — "ידעת שהבוט יודע…?" (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 4).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Tips = require('../../../server/whatsapp/bot-tips');
const WaActions = require('../../../server/whatsapp/wa-actions');
const Access = require('../../../server/priority/priority-access');

boot();
D.setSetting('wa_actions', {});
const actor = (u) => ({ type: 'user', id: u.id, role: u.role });
/** 09:00 בשעון ישראל — היום */
const at = (hhmm) => {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  // ישראל: UTC+2 / UTC+3 — מחשבים את ההפרש מהשעון עצמו
  const probe = new Date(`${ymd}T12:00:00Z`);
  const ilHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(probe));
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), h - (ilHour - 12), m));
};
function run(users, { now = at('09:05'), quiet = async () => true } = {}) {
  const pushed = [];
  return Tips.tick({ users: () => users, push: async (id, m) => { pushed.push({ id, ...m }); return true; }, quiet, now }).then(() => pushed);
}

test('הקטלוג — כל טיפ מצביע על פעולה קיימת; כפתור עד 20 תווים; 2–3 שורות', () => {
  for (const tip of Tips.catalog()) {
    assert.ok(WaActions.byKey(tip.action), `${tip.id}: פעולה ${tip.action} לא קיימת`);
    if (tip.button) assert.ok(tip.button.length <= 20, `${tip.id}: כפתור ארוך`);
    assert.ok(tip.lines.length >= 1 && tip.lines.length <= 3, tip.id);
    const lines = Tips.message(tip).text.split('\n').filter(Boolean).length;
    assert.ok(lines <= 5, `${tip.id}: ${lines} שורות`);
  }
});

test('ב-09:05 — טיפ אחד, עם "נסו עכשיו" וכפתור "מספיק טיפים"; פעם שנייה באותו יום — לא', async () => {
  const u = user({ role: 'employee' });
  let pushed = await run([u]);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].text, /^💡 \*ידעת\?\*/);
  assert.match(pushed[0].text, /נסו עכשיו/);
  assert.ok(pushed[0].buttons.includes(Tips.STOP_BTN));
  assert.ok(pushed[0].buttons.length <= 3);
  pushed = await run([u]);
  assert.equal(pushed.length, 0, 'אחד ביום');
});

test('לפני 09:00 ואחרי 10:00 — לא', async () => {
  const u = user({ role: 'employee' });
  assert.equal((await run([u], { now: at('08:50') })).length, 0);
  assert.equal((await run([u], { now: at('10:05') })).length, 0);
});

test('באמצע שיחה / בפגישה — מחכים (ובסבב הבא, כשהתפנה — נשלח)', async () => {
  const u = user({ role: 'employee' });
  assert.equal((await run([u], { quiet: async () => false })).length, 0);
  assert.equal((await run([u])).length, 1);
});

test('לא פיצ\'ר שכבר השתמש בו, ולא אותו טיפ פעמיים', () => {
  const u = user({ role: 'employee' });
  const first = Tips.nextFor(actor(u));
  D.run("INSERT INTO wa_log (at, channel, user_id, action, status) VALUES (?, 'private', ?, ?, 'ok')", D.nowIso(), u.id, first.used ?? first.action);
  const second = Tips.nextFor(actor(u));
  assert.notEqual(second.id, first.id);
  D.setUserPref(u.id, 'botPrefs', { tipsSent: [second.id] });
  assert.ok(![first.id, second.id].includes(Tips.nextFor(actor(u)).id));
});

test('פריוריטי — רק למורשה', () => {
  const none = user({ role: 'employee' });
  const ok = user({ role: 'employee' });
  D.setSetting('wa_actions', { goods_receipt: { enabled: true, audience: 'all' }, purchase_demand: { enabled: true, audience: 'all' } });
  Access.save([{ id: none.id, docs: [] }, { id: ok.id, docs: ['receipt', 'demand'] }]);
  const ids = (u) => {
    const out = [];
    D.setUserPref(u.id, 'botPrefs', {});
    for (let tip = Tips.nextFor(actor(u)); tip; tip = Tips.nextFor(actor(u))) {
      out.push(tip.id);
      D.setUserPref(u.id, 'botPrefs', { tipsSent: out });
    }
    return out;
  };
  assert.ok(!ids(none).some((id) => ['goods_receipt', 'purchase_demand'].includes(id)));
  assert.ok(ids(ok).includes('goods_receipt'));
  // טיפ על מסמך (‎doc‎) — רק למי שמורשה לסוג המסמך: חשבונית ספק מחשבון חלקי
  assert.ok(!ids(ok).includes('pc_invoice'), 'קבלת סחורה בלי "חשבונית ספק" — לא רואה את הטיפ');
  Access.save([{ id: ok.id, docs: ['receipt', 'demand', 'invoice'] }]);
  assert.ok(ids(ok).includes('pc_invoice'));
  D.setSetting('wa_actions', {});
});

test('"מספיק טיפים" — מפסיק; "תחזיר את הטיפים" — מחזיר', async () => {
  const u = user({ role: 'employee' });
  assert.match(Tips.command(u.id, Tips.STOP_BTN).text, /לא אשלח/);
  assert.equal((await run([u])).length, 0);
  assert.ok(Tips.command(u.id, 'תחזיר את הטיפים'));
  assert.equal((await run([u])).length, 1);
  assert.equal(Tips.command(u.id, 'מה שלומך'), null);
});
