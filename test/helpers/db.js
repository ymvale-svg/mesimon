'use strict';
/**
 * מסד נתונים לבדיקה: הקובץ הזמני שהוגדר ב-test/setup.js, אחרי bootstrap.
 * ‎fresh()‎ מוחק את נתוני הבדיקה הקודמת (משתמשים, משימות…) ומשאיר הגדרות וכללים מובנים.
 */
const D = require('../../server/db');

let booted = false;
function boot() {
  if (!booted) { D.bootstrap(); booted = true; }
  return D;
}

let seq = 0;
/** משתמש לבדיקה. ‎role‎: admin / manager / member … */
function user(overrides = {}) {
  boot();
  seq += 1;
  const now = new Date().toISOString();
  const row = {
    full_name: `משתמש ${seq}`,
    email: `user${seq}-${Date.now()}@test.local`,
    role: 'member',
    ...overrides
  };
  const cols = D.all('PRAGMA table_info(users)').map((c) => c.name);
  const data = { created_at: now, ...row };
  if (cols.includes('password_hash') && data.password_hash === undefined) data.password_hash = 'x';
  const keys = Object.keys(data).filter((k) => cols.includes(k));
  const info = D.run(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k]));
  return D.get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
}

module.exports = { boot, user, D };
