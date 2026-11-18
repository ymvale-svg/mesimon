'use strict';
/**
 * 🎨 בקשה למודעה / מכתב בשפה חופשית (‎Notice.parseRequest‎). באג 15.11.26: "תן לי מודעה לכנס דיירים…" לא זוהה,
 * והבוט ענה "כדי לעצב מודעה כתוב: 'תעצב לי מודעה…'" — במקום לעצב.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../helpers/db').boot();
const Notice = require('../../../server/whatsapp/notice');

test('"תן לי מודעה לכנס דיירים…" — בקשה למודעה, עם התוכן', () => {
  const r = Notice.parseRequest("תן לי מודעה לכנס דיירים היום ביוקנעם בבית החייל רח' האזוב 3");
  assert.equal(r?.kind, 'notice');
  assert.match(r.request, /כנס דיירים/);
});

for (const t of ['תני לי מודעה על סגירת המשרד', 'אפשר מודעה לאירוע ביום חמישי', 'אני רוצה מודעה לכנס דיירים', 'תביא לי פלאייר לאירוע', 'מודעה לכנס דיירים ביום שני', 'תפיק לי מודעה לאסיפה']) {
  test(`"${t}" — בקשה למודעה`, () => assert.equal(Notice.parseRequest(t)?.kind, 'notice'));
}

for (const t of ['תן לי מכתב רשמי לעירייה', 'אני רוצה מכתב לבנק']) {
  test(`"${t}" — בקשה למכתב`, () => assert.equal(Notice.parseRequest(t)?.kind, 'letter'));
}

for (const t of ['ראיתי את המודעה בלובי', 'מה המודעה שפרסמנו?', 'תן לי את המשימות', 'שלט בכניסה נשבר', 'המודעה שפרסמנו לא עבדה', 'מודעה זה לא מה שביקשתי']) {
  test(`"${t}" — לא בקשה`, () => assert.equal(Notice.parseRequest(t), null));
}
