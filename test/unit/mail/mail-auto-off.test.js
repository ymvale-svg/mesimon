'use strict';
/**
 * 🔕 יצירת משימות מהמייל בלי אישור — כובתה לכולם פעם אחת (22.11.26, ישראל: אחרי משימה ממייל של Google שנפתחה
 * לאיציק לבד). המתג "ליצור משימות מהמייל בלי אישור" כבה, וכל ⭐ "נוצר ישר" נמחק; 🚫 "לא מציעים" נשאר.
 * מי שירצה — מדליק שוב, וזה לא נדרס.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');

boot();

test('פעם אחת: המתג כבה וה-⭐ נמחקים; 🚫 נשאר; הדלקה מחדש אחר כך — נשמרת', () => {
  const u = user({ role: 'employee' });
  D.setUserPref(u.id, 'mailAutoCreate', true);
  D.run("INSERT INTO mail_trusted_senders (user_id, email, mode, created_at) VALUES (?, 'no-reply@accounts.google.com', 'trust', ?)", u.id, D.nowIso());
  D.run("INSERT INTO mail_trusted_senders (user_id, email, mode, created_at) VALUES (?, 'spam@x.test', 'ignore', ?)", u.id, D.nowIso());
  D.run("DELETE FROM settings WHERE key = 'migr_mail_auto_off'");

  D.mailAutoOff();
  assert.equal(D.userPrefs(u.id).mailAutoCreate, undefined);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM mail_trusted_senders WHERE user_id = ? AND mode = 'trust'", u.id).n, 0);
  assert.equal(D.get("SELECT COUNT(*) AS n FROM mail_trusted_senders WHERE user_id = ? AND mode = 'ignore'", u.id).n, 1);

  D.setUserPref(u.id, 'mailAutoCreate', true);
  D.mailAutoOff();
  assert.equal(D.userPrefs(u.id).mailAutoCreate, true, 'פעם אחת בלבד — בחירה חדשה לא נדרסת');
});

test('ברירת המחדל — כבוי: בלי הגדרה, אין יצירה לבד', () => {
  const u = user({ role: 'employee' });
  assert.notEqual(D.userPrefs(u.id).mailAutoCreate, true);
});
