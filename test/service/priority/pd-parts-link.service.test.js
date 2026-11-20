'use strict';
/**
 * 🔒 הקישור לרכש (‎/parts.html?t=…‎, בלי התחברות): תוקף, הגבלת תשובות, ושמירת מידע (אבטחה 18.11.26).
 * הבקשות נבנות ישירות בטבלה — בלי שיחה עם הבוט.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers');
const Parts = require('../../../server/priority/pd-parts');

H.setup();
const { D } = H;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const ITEM = { n: 1, description: 'בטון', qty: 5, unit: 'קוב', known: [] };

function request(u, { status = 'open', created = D.nowIso(), missing = [ITEM] } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const id = Number(D.run('INSERT INTO pd_part_requests (user_id, company, header, items, missing, mode, status, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    u.id, 'test11', '{}', '[]', JSON.stringify(missing), 'wait', status, token, created).lastInsertRowid);
  return { id, token };
}

test('🔒 קישור לרכש: תקף לבקשה חדשה, גם אחרי שנסגרה', () => {
  const u = H.worker();
  const { token } = request(u);
  assert.equal(Parts.forBuyer(token).open, true);
  const done = request(u, { status: 'done' });
  assert.equal(Parts.forBuyer(done.token).open, false);
});

test('🔒 קישור לרכש: בקשה שפגה (‎expired‎) או ישנה מ-60 יום — הקישור לא מציג את פרטי העובד', () => {
  const u = H.worker();
  assert.equal(Parts.forBuyer(request(u, { status: 'expired' }).token), null);
  assert.equal(Parts.forBuyer(request(u, { status: 'done', created: daysAgo(61) }).token), null);
});

test('🔒 קישור לרכש: עד 20 תשובות לפריט — לא אפשר להציף את העובד בהודעות', async () => {
  const u = H.worker();
  const answers = Array.from({ length: 20 }, () => ({ code: '', note: 'x', at: D.nowIso() }));
  const { token } = request(u, { missing: [{ ...ITEM, answers }] });
  await assert.rejects(Parts.buyerAnswer(token, { n: 1, note: 'עוד אחת' }), (err) => err.status === 429);
});

test('🔒 שמירת מידע: בקשה פתוחה ישנה — expired והקישור מתאפס; בקשה סגורה בת יותר מ-90 יום — נמחקת', () => {
  const u = H.worker();
  const stale = request(u, { created: daysAgo(61) });
  const oldDone = request(u, { status: 'done', created: daysAgo(91) });
  const oldExpired = request(u, { status: 'expired', created: daysAgo(91) });
  const recentDone = request(u, { status: 'done', created: daysAgo(10) });
  const fresh = request(u);

  Parts.cleanup();

  const row = (id) => D.get('SELECT status, token FROM pd_part_requests WHERE id = ?', id);
  assert.deepEqual({ ...row(stale.id) }, { status: 'expired', token: null });
  assert.equal(row(oldDone.id), undefined);
  assert.equal(row(oldExpired.id), undefined);
  assert.equal(row(recentDone.id).status, 'done');
  assert.equal(row(fresh.id).token, fresh.token);
});
