'use strict';
/**
 * 📭 סינון לפני AI ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 5.3): ניוזלטרים ומענים אוטומטיים לא נשלחים ל-Claude;
 * מייל עם קובץ, מהארגון, משולח מהימן או תשובה בשרשור — תמיד נבדק.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Mime = require('../../../server/core/mime');
const Gmail = require('../../../server/integrations').Gmail;
const MailBulk = require('../../../server/mail/mail-bulk');
const MailScan = require('../../../server/mail/mail-scan');

boot();

let seq = 0;
/** מייל גולמי. ‎headers‎ — כותרות נוספות; ‎attach‎ — עם קובץ מצורף */
function raw({ from = 'Shop <news@shop.example>', subject = 'Black Friday!', headers = [], attach = false } = {}) {
  const n = ++seq;
  const base = [`From: ${from}`, 'To: me@org.test', `Subject: ${subject}`, `Message-ID: <b${n}@x>`, 'Date: Thu, 19 Nov 2026 08:00:00 +0000', 'MIME-Version: 1.0', ...headers];
  if (!attach) return Buffer.from([...base, 'Content-Type: text/plain; charset=utf-8', '', 'Big sale, please read.'].join('\r\n'));
  return Buffer.from([...base,
    'Content-Type: multipart/mixed; boundary="XX"', '',
    '--XX', 'Content-Type: text/plain; charset=utf-8', '', 'Invoice attached.',
    '--XX', 'Content-Type: application/pdf; name="inv.pdf"', 'Content-Disposition: attachment; filename="inv.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 x').toString('base64'),
    '--XX--', ''].join('\r\n'));
}
const ORG = { emails: new Set(['me@org.test']), domains: new Set(['org.test']) };
const why = (opts, extra = {}) => MailBulk.reason(Mime.parse(raw(opts)), { orgInfo: ORG, ...extra });
const UNSUB = 'List-Unsubscribe: <mailto:unsub@shop.example>';

test('הכותרות נקראות: List-Unsubscribe, Precedence, מענה אוטומטי', () => {
  const m = Mime.parse(raw({ headers: [UNSUB, 'Precedence: bulk'] }));
  assert.equal(m.listUnsubscribe, true);
  assert.equal(m.precedence, 'bulk');
  assert.equal(m.autoSubmitted, true);
  assert.equal(Mime.parse(raw({ headers: ['Auto-Submitted: auto-replied'] })).autoReply, true);
  assert.equal(Mime.parse(raw()).listUnsubscribe, false);
});

test('ניוזלטר (List-Unsubscribe / Precedence: bulk / list) — מסונן', () => {
  assert.equal(why({ headers: [UNSUB] }), 'newsletter');
  assert.equal(why({ headers: ['Precedence: bulk'] }), 'newsletter');
  assert.equal(why({ headers: ['Precedence: list'] }), 'newsletter');
});

test('מענה אוטומטי — מסונן, גם בשרשור', () => {
  assert.equal(why({ headers: ['Auto-Submitted: auto-replied', 'In-Reply-To: <a@b>'] }), 'auto_reply');
  assert.equal(why({ headers: ['X-Autoreply: yes'] }), 'auto_reply');
  assert.equal(why({ subject: 'Automatic reply: הצעת מחיר' }), 'auto_reply');
  assert.equal(why({ subject: 'מענה אוטומטי: מחוץ למשרד עד יום ראשון' }), 'auto_reply');
});

test('לעולם לא מסוננים: קובץ מצורף, מהארגון, משולח מהימן, תשובה בשרשור', () => {
  assert.equal(why({ headers: [UNSUB], attach: true }), null, 'חשבונית מצורפת');
  assert.equal(why({ headers: [UNSUB], from: 'Team <team@org.test>' }), null, 'קבוצת תפוצה פנימית');
  assert.equal(why({ headers: [UNSUB] }, { trusted: true }), null);
  assert.equal(why({ headers: [UNSUB, 'In-Reply-To: <q1@client>'] }), null);
});

test('לא מסוננים בכוונה: noreply / auto-generated בלי סימן דיוור (בקשות אישור ממערכות)', () => {
  assert.equal(why({ from: 'Priority <noreply@erp.example>', headers: ['Auto-Submitted: auto-generated'], subject: 'הזמנה ממתינה לאישורך' }), null);
  assert.equal(why({ from: 'Dani <dani@client.example>' }), null);
});

test('דומיין ציבורי של עובד (gmail.com) אינו "הארגון"', () => {
  const u = user({ email: `worker${Date.now()}@gmail.com`, status: 'active' });
  const m = Mime.parse(raw({ headers: [UNSUB], from: 'Promo <promo@gmail.com>' }));
  assert.equal(MailBulk.reason(m), 'newsletter');
  const own = Mime.parse(raw({ headers: [UNSUB], from: `W <${u.email}>` }));
  assert.equal(MailBulk.reason(own), null, 'הכתובת של העובד עצמו — כן');
});

test('ההגדרה כבויה — שום דבר לא מסונן', (t) => {
  D.setSetting('ai_scan_skip_bulk', false);
  t.after(() => D.setSetting('ai_scan_skip_bulk', true));
  assert.equal(why({ headers: [UNSUB] }), null);
});

// ---------------------------------------------------------------- בסריקה

function scanWith(t, opts) {
  const u = user({ email: `me${++seq}@org.test`, role: 'employee' });
  const { calls } = Fakes.claude(t, () => ({ for_me: true, reply_expected: false, tasks: [] }));
  t.mock.method(Gmail, 'raw', async () => ({ raw: raw(opts), internalDate: new Date() }));
  t.mock.method(Gmail, 'emailsOf', () => []);
  return { u, calls, run: (id = `bg${seq}`) => MailScan._internal.processMessage(u, { box: 0, email: u.email }, id) };
}

test('בסריקה: ניוזלטר — בלי קריאה ל-AI, נרשם כ"סונן", ולא נספר בתקרה היומית', async (t) => {
  const { u, calls, run } = scanWith(t, { headers: [UNSUB] });
  assert.equal(await run('n1'), 'bulk');
  assert.equal(calls.length, 0);
  assert.equal(D.get('SELECT outcome FROM mail_scanned WHERE user_id = ? AND gmail_id = ?', u.id, 'n1').outcome, 'bulk:newsletter');
  assert.equal(MailBulk.countSince('2000-01-01T00:00:00Z').byReason.newsletter >= 1, true);
});

test('בסריקה: אותו ניוזלטר עם חשבונית מצורפת — נבדק', async (t) => {
  const { calls, run } = scanWith(t, { headers: [UNSUB], attach: true });
  await run();
  assert.equal(calls.filter((c) => c.opts.feature === 'mail.scan').length, 1);
});
