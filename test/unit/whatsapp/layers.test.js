'use strict';
/**
 * שכבות בוט הוואטסאפ (‎CLAUDE.md‎ — "בוט הוואטסאפ — שכבות"): כל קובץ מייבא רק מהשכבות שמתחתיו.
 * כך אף זרימה לא "מושכת" את הניתוב, והניתוב לא נכנס שוב למעגל עם הזרימות.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../../../server/whatsapp');
const LAYERS = ['wa-base', 'wa-groups', 'wa-private', 'wa-tasks', 'wa-proactive', 'wa-mail', 'wa-menu', 'wa-meeting', 'wa-bot'];

for (const [i, name] of LAYERS.entries()) {
  test(`${name} — מייבא רק משכבות שמתחתיו`, () => {
    const src = fs.readFileSync(path.join(DIR, `${name}.js`), 'utf8');
    const used = [...src.matchAll(/require\('\.\/(wa-[a-z]+)'\)/g)].map((m) => m[1]).filter((x) => LAYERS.includes(x));
    const up = used.filter((x) => LAYERS.indexOf(x) >= i);
    assert.deepEqual(up, [], `${name} מייבא משכבה שמעליו או מעצמו: ${up.join(', ')}`);
  });
}

test('wa-bot.js — רק הניתוב והסבב (לא חוזר לגודל של פעם)', () => {
  const lines = fs.readFileSync(path.join(DIR, 'wa-bot.js'), 'utf8').split('\n').length;
  assert.ok(lines < 2600, `wa-bot.js — ${lines} שורות. זרימה חדשה — בקובץ השכבה שלה`);
});
