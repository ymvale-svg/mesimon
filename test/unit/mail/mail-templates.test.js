'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../../server/core/mail-templates');

test('escape — תווים מיוחדים ב-HTML', () => {
  assert.equal(T.escape(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('escape — null ו-undefined הופכים לריק, מספר למחרוזת', () => {
  assert.equal(T.escape(null), '');
  assert.equal(T.escape(undefined), '');
  assert.equal(T.escape(42), '42');
});

test('shell — מסמך RTL בעברית עם הכותרת בורחת', () => {
  const html = T.shell({ title: 'משימה <חדשה>', bodyHtml: '<p>גוף</p>', footerHtml: '<i>תחתית</i>' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /<title>משימה &lt;חדשה&gt;<\/title>/);
  assert.ok(html.includes('<p>גוף</p>'), 'הגוף נכנס כ-HTML');
  assert.ok(html.includes('<i>תחתית</i>'));
  assert.ok(html.includes('MESIMON'));
  assert.ok(html.includes(T.BRAND.teal));
});

test('button — קישור ותווית בורחים', () => {
  const b = T.button('https://x.test/?a=1&b="2"', 'פתיחה <עכשיו>');
  assert.ok(b.includes('href="https://x.test/?a=1&amp;b=&quot;2&quot;"'));
  assert.ok(b.includes('>פתיחה &lt;עכשיו&gt;</a>'));
});
