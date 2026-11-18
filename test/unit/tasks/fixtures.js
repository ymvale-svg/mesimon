'use strict';
/**
 * נתוני בדיקה למשימות: משתמשים, מחלקות, פרויקטים, ספקים ומשימות — ישירות במסד הזמני.
 * לא קובץ בדיקה (אין ‎.test.js‎), רק עזר לקבצים שבתיקייה.
 */
const { boot, D } = require('../../helpers/db');

let seq = 0;
const next = () => { seq += 1; return `${seq}-${Date.now()}`; };
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => iso(Date.now() - ms);
const ahead = (ms) => iso(Date.now() + ms);

function insert(table, data) {
  const keys = Object.keys(data);
  const info = D.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k]));
  return D.get(`SELECT * FROM ${table} WHERE rowid = ?`, Number(info.lastInsertRowid));
}

function mkUser(o = {}) {
  boot();
  const n = next();
  return insert('users', {
    full_name: `עובד ${n}`, email: `u${n}@test.local`, password_hash: 'x', role: 'member',
    status: 'active', created_at: D.nowIso(), ...o
  });
}

function mkDept(o = {}) {
  boot();
  return insert('departments', { name: `מחלקה ${next()}`, created_at: D.nowIso(), ...o });
}

function mkProject(o = {}) {
  boot();
  return insert('projects', { name: `פרויקט ${next()}`, created_at: D.nowIso(), ...o });
}

function mkVendor(o = {}) {
  boot();
  const n = next();
  return insert('vendors', { name: `ספק ${n}`, email: `v${n}@test.local`, password_hash: 'x', created_at: D.nowIso(), ...o });
}

function mkTask(o = {}) {
  boot();
  const now = D.nowIso();
  return insert('tasks', {
    title: `משימה ${next()}`, board_id: D.internalBoard().id, status: 'new',
    created_at: now, status_changed_at: now, ...o
  });
}

module.exports = { boot, D, mkUser, mkDept, mkProject, mkVendor, mkTask, HOUR, DAY, ago, ahead };
