'use strict';
/**
 * אינסטינקט — שמירה מוגבלת: הבקשות והתשובות של העוזר החיצוני (‎instinct_requests‎) נמחקות בניקוי הלילי
 * אחרי LOG_DAYS, כמו יומן הבוט. בקשה שעוד בטיפול (queued / sent / open) לא נמחקת.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const { LOG_DAYS, DAY } = require('../../../server/whatsapp/wa-base');
const { prune } = require('../../../server/whatsapp/wa-groups');

boot();

test('ניקוי לילי: בקשות ישנות לאינסטינקט נמחקות, חדשות ובטיפול נשארות', () => {
  const u = user({ full_name: 'בודק שמירה', role: 'admin' });
  const old = new Date(Date.now() - (LOG_DAYS + 1) * DAY).toISOString();
  const add = (status, at) => D.run('INSERT INTO instinct_requests (user_id, status, text, reply, created_at) VALUES (?,?,?,?,?)', u.id, status, 'בקשה', 'תשובה', at).lastInsertRowid;
  const oldAnswered = add('answered', old);
  const oldTimeout = add('timeout', old);
  const oldSent = add('sent', old);
  const fresh = add('answered', D.nowIso());
  prune();
  const left = new Set(D.all('SELECT id FROM instinct_requests WHERE user_id = ?', u.id).map((r) => Number(r.id)));
  assert.equal(left.has(Number(oldAnswered)), false);
  assert.equal(left.has(Number(oldTimeout)), false);
  assert.equal(left.has(Number(oldSent)), true);
  assert.equal(left.has(Number(fresh)), true);
});
