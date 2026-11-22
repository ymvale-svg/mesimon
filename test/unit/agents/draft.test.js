'use strict';
/**
 * ✍️ נוסח מוכן. באג: "תנסח הודעה על הדרכת AI" החזיר הודעה אחת — כותרת הסוכן מעל
 * הנוסח, ושני ערכים לא קשורים מהידע הארגוני (נמשכו לפי המילה "הודעה") מודבקים
 * אחריו וחתוכים באמצע מילה. ובקשה לקבל את הנוסח בנפרד לא יכלה להתבצע.
 * עכשיו: הסוכן מסמן את הנוסח, והבוט שולח אותו לבדו כהודעה שנייה.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Fakes = require('../../fakes');
const Agents = require('../../../server/agents/agents');

const { splitDraft, combine } = Agents._internal;
const NOTE_ONLY = '✍️ הנוסח מוכן.';

test('splitDraft — הנוסח שבין הסימונים יוצא לבד, ושאר התשובה בלעדיו', () => {
  assert.deepEqual(splitDraft('הנחתי שזה בחדר הישיבות.\n<<<טיוטה>>>\nהיי לכולם 👋\nנתראה!\n<<<סוף טיוטה>>>'),
    { text: 'הנחתי שזה בחדר הישיבות.', draft: 'היי לכולם 👋\nנתראה!' });
});

test('splitDraft — בלי סימונים: התשובה כמו שהיא, בלי נוסח', () => {
  assert.deepEqual(splitDraft('שער הדולר היום: 3.70'), { text: 'שער הדולר היום: 3.70', draft: '' });
});

test('splitDraft — נוסח עטוף בבלוק קוד, או בלי סימון סוגר', () => {
  assert.equal(splitDraft('<<<טיוטה>>>\n```\nשלום\n```\n<<<סוף טיוטה>>>').draft, 'שלום');
  assert.deepEqual(splitDraft('<<<טיוטה>>>\nשלום לכולם'), { text: '', draft: 'שלום לכולם' });
});

test('asMessages — ניסוח: שורה קצרה, ואחריה הנוסח לבדו — בלי כותרת הסוכן ובלי ידע ארגוני', () => {
  const r = {
    agent: { icon: '🗓', title: 'עוזר אישי — לוח ישראלי וניסוח', text: NOTE_ONLY, draft: 'היי לכולם 👋\nנתראה!', sources: ['📚 הידע הארגוני'] },
    org: [{ domain: 'הודעה על התחלת עבודות', text: 'טופס מול משרד העבודה', source: 'מחלקת תכנון, אוקטובר 2026' }],
    failed: []
  };
  const [first, draft, ...rest] = Agents.asMessages(r);
  assert.equal(draft, 'היי לכולם 👋\nנתראה!');
  assert.deepEqual(rest, []);
  assert.match(first, /הנה הנוסח/);
  assert.doesNotMatch(first, /עוזר אישי|מקורות|הידע הארגוני|משרד העבודה/);
});

test('asMessages — ניסוח עם הערה: ההערה בהודעה הראשונה, לא בנוסח', () => {
  const [first, draft] = Agents.asMessages({ agent: { title: 'x', text: 'הנחתי שזה בחדר הישיבות.', draft: 'היי' } });
  assert.match(first, /הנחתי שזה בחדר הישיבות/);
  assert.equal(draft, 'היי');
});

test('asMessages — תשובה רגילה: הודעה אחת, והידע הארגוני כבר לא מודבק בסוף', () => {
  const msgs = Agents.asMessages({
    agent: { icon: '💰', title: 'מיסוי', text: 'מס רכישה: 85,000 ₪', sources: ['מחשבון'] },
    org: [{ domain: 'הודעת וולקאם בוואטסאפ', text: 'לשלוח את ההודעה למטא' }]
  });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /💰 \*מיסוי:\*/);
  assert.doesNotMatch(msgs[0], /וולקאם/);
});

test('asText — שתי ההודעות יחד, למי שלא שולח כמה הודעות', () => {
  assert.equal(Agents.asText({ agent: { title: 'x', text: NOTE_ONLY, draft: 'היי' } }), `${Agents.asMessages({ agent: { title: 'x', text: NOTE_ONLY, draft: 'היי' } })[0]}\n\nהיי`);
});

test('האיחוד מעביר את הנוסח בשדה נפרד, ואם העורך השמיט אותו — לוקח את של הסוכן', async (t) => {
  const parts = [{ key: 'office', title: 'עוזר אישי', icon: '🗓', text: NOTE_ONLY, draft: 'היי לכולם', sources: [] },
    { key: 'general', title: 'הסוכן של הארגון', icon: '🏢', text: 'אין לי מידע רלוונטי', sources: [] }];
  const fake = Fakes.claude(t, () => ({ answer: '', draft: '' }));
  const out = await combine({ full_name: 'בודק' }, 'תנסח הודעה', { parts, mail: null, org: [], history: [] });
  assert.equal(out.draft, 'היי לכולם');
  assert.equal(out.text, NOTE_ONLY);
  // העורך ראה את הנוסח כבלוק משלו
  assert.match(fake.calls[0].opts.content[0].text, /✍️ נוסח מוכן — מעוזר אישי\nהיי לכולם/);
});

test('הנחיות הסוכן כוללות את כלל הניסוח עם הסימונים', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../../server/agents/agents.js'), 'utf8');
  assert.match(src, /const DRAFT_OPEN = '<<<טיוטה>>>'/);
  assert.equal((src.match(/^\s+DRAFT_RULE,$/gm) ?? []).length, 2, 'בסוכני המחלקות ובעוזר הכללי');
});
