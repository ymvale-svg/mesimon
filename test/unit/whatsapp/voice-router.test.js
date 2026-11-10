'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Claude = require('../../../server/ai/claude');
const V = require('../../../server/ai/voice-router');

const LONG = 'תפתח משימה לשושנה לבדוק את הלוח בקומה השנייה, ותשלח מייל לאורן שיביא את ההסכם עד מחר';

test('split — טקסט ריק: אין בקשות', async () => {
  assert.deepEqual(await V.split(''), []);
  assert.deepEqual(await V.split('   '), []);
  assert.deepEqual(await V.split(null), []);
});

test('split — בלי AI: בקשה אחת, רווחים מכווצים', async () => {
  assert.deepEqual(await V.split(`  ${LONG.replace(/ /g, '   ')}  `), [{ kind: null, text: LONG }]);
});

test('split — הודעה קצרה לא נשלחת ל-AI', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  const json = t.mock.method(Claude, 'json', async () => ({ requests: [] }));
  assert.deepEqual(await V.split('תפתח משימה לשושנה'), [{ kind: null, text: 'תפתח משימה לשושנה' }]);
  assert.equal(json.mock.callCount(), 0);
});

test('split — ארוכה בלי מילת חיבור לא נשלחת ל-AI', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  const json = t.mock.method(Claude, 'json', async () => ({ requests: [] }));
  const text = 'תפתח משימה לשושנה לבדוק את הלוח בקומה השנייה של הבניין עד יום חמישי הקרוב';
  assert.deepEqual(await V.split(text), [{ kind: null, text }]);
  assert.equal(json.mock.callCount(), 0);
});

test('split — כמה בקשות: מפורקות, ריקות נזרקות, סוג לא מוכר — other', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(Claude, 'json', async () => ({ requests: [
    { kind: 'task', text: ' משימה לשושנה ' }, { kind: 'email', text: 'מייל לאורן' }, { kind: 'task', text: '  ' }
  ] }));
  assert.deepEqual(await V.split(LONG), [{ kind: 'task', text: 'משימה לשושנה' }, { kind: 'other', text: 'מייל לאורן' }]);
});

test('split — עד 5 בקשות', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(Claude, 'json', async () => ({ requests: Array.from({ length: 9 }, (_, i) => ({ kind: 'task', text: `בקשה ${i}` })) }));
  assert.equal((await V.split(LONG)).length, 5);
});

test('split — AI נכשל או החזיר ריק: הכול כבקשה אחת', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(console, 'error', () => {});
  const json = t.mock.method(Claude, 'json', async () => { throw new Error('429'); });
  assert.deepEqual(await V.split(LONG), [{ kind: null, text: LONG }]);
  json.mock.mockImplementation(async () => ({}));
  assert.deepEqual(await V.split(LONG), [{ kind: null, text: LONG }]);
});

test('split — classify: גם בקשה קצרה מסווגת', async (t) => {
  t.mock.method(Claude, 'isEnabled', () => true);
  t.mock.method(Claude, 'json', async () => ({ requests: [{ kind: 'task', text: 'לבדוק לוח' }] }));
  assert.deepEqual(await V.split('לבדוק לוח', { classify: true }), [{ kind: 'task', text: 'לבדוק לוח' }]);
});
