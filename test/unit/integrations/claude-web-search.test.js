'use strict';
// חיפוש ברשת (‎WEB_SEARCH‎): Anthropic דוחה את קוד המדינה IL ("Country code IL is not supported") — וכל השאלה נכשלת
// (סקירת הבוט 23.11: "כתוב לי סטטוס התחדשות עירונית" ← שגיאה 400). המיקום נשלח בלי מדינה, רק עם אזור הזמן.
const { test } = require('node:test');
const assert = require('node:assert');
const { WEB_SEARCH } = require('../../../server/integrations/claude');

test('WEB_SEARCH — בלי קוד מדינה שה-API לא תומך בו', () => {
  const tool = WEB_SEARCH();
  assert.equal(tool.type, 'web_search_20250305');
  assert.ok(!tool.user_location || !('country' in tool.user_location), 'country לא נשלח');
  assert.equal(tool.user_location?.timezone, 'Asia/Jerusalem');
  assert.equal(WEB_SEARCH(3).max_uses, 3);
});
