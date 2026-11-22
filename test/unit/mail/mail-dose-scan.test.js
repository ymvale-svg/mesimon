'use strict';
/**
 * 📉 מינון לפי שימוש בסריקת המייל ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 3): ב-100% התשובה מוכנה מראש לכל מייל
 * שמחכה לתשובה; מתחת ל-100% — לא נכתבת (‎replyWanted‎), ונכתבת רק כשמבקשים ("💡 להכין הצעת תשובה").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Gmail = require('../../../server/integrations').Gmail;
const MailInsights = require('../../../server/mail/mail-insights');
const MailScan = require('../../../server/mail/mail-scan');

boot();

let seq = 0;
const RAW = (n) => Buffer.from([
  'From: Dani Cohen <dani@client.test>',
  'To: me@org.test',
  'Subject: Quote approval',
  `Message-ID: <dose${n}@client.test>`,
  'Date: Mon, 16 Nov 2026 08:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi, can you approve the attached quote by Thursday?'
].join('\r\n'));

const ANALYSIS = {
  for_me: true, reply_expected: true, addressed_to_email: 'me@org.test', department: '', skip_reason: '', warning: '',
  goods_document: null, blank_form: null,
  tasks: [{ title: 'לאשר הצעת מחיר', summary: 'דני מבקש אישור עד חמישי.', meeting: false, need: '', keywords: [], checklist: [], due_date: '', priority: 'normal', people: [], ambiguous: [], ai_request: { needed: false } }]
};

function setup(t) {
  const n = ++seq;
  const u = user({ email: `me${n}@org.test`, role: 'employee' });
  Fakes.claude(t, (opts) => (opts.feature === 'mail.scan' ? ANALYSIS : {}));
  t.mock.method(Gmail, 'raw', async () => ({ raw: RAW(n), internalDate: new Date() }));
  t.mock.method(Gmail, 'canSend', () => true);
  t.mock.method(Gmail, 'emailsOf', () => []);
  let drafted = 0;
  t.mock.method(MailInsights, 'suggestReply', async () => { drafted++; return { body: 'שלום דני, מאושר. בברכה', to: 'dani@client.test', toName: 'דני', subject: 'Re: Quote approval' }; });
  return { u, conn: { box: 0, email: u.email }, gmailId: `gm${n}`, drafted: () => drafted };
}
const dataOf = (u) => JSON.parse(D.get("SELECT data FROM ai_suggestions WHERE user_id = ? AND kind = 'task'", u.id).data);

test('100% — התשובה מוכנה מראש בסריקה', async (t) => {
  const { u, conn, gmailId, drafted } = setup(t);
  D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 0 });
  const outcome = await MailScan._internal.processMessage(u, conn, gmailId);
  assert.equal(outcome, 'suggested');
  assert.equal(drafted(), 1);
  assert.match(dataOf(u).reply.body, /מאושר/);
});

test('50% — בלי תשובה מראש: ‎replyWanted‎ ונכתבת רק ב"להכין הצעת תשובה"', async (t) => {
  const { u, conn, gmailId, drafted } = setup(t);
  D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 1 });
  await MailScan._internal.processMessage(u, conn, gmailId);
  assert.equal(drafted(), 0, 'לא נקרא ל-AI בשביל התשובה');
  const d = dataOf(u);
  assert.equal(d.reply, undefined);
  assert.equal(d.replyWanted, true);
  assert.equal(d.replyBox, 0);

  const id = D.get("SELECT id FROM ai_suggestions WHERE user_id = ? AND kind = 'task'", u.id).id;
  await MailScan.prepareReply(id, { type: 'user', id: u.id });
  assert.equal(drafted(), 1);
  assert.match(dataOf(u).reply.body, /מאושר/);
  await MailScan.prepareReply(id, { type: 'user', id: u.id });
  assert.equal(drafted(), 1, 'כבר מוכנה — לא שוב');
});

// ---------------------------------------------------------------- 💰 מודל המיון (סעיף 5.1)

test('המיון בסריקה — ב-Haiku (‎ai_scan_model‎); התשובה עצמה לא', async (t) => {
  const { u, conn, gmailId } = setup(t);
  const { calls } = Fakes.claude(t, (opts) => (opts.feature === 'mail.scan' ? ANALYSIS : {}));
  D.setUserPref(u.id, 'mailDose', { lastUse: new Date().toISOString(), drops: 0 });
  await MailScan._internal.processMessage(u, conn, gmailId);
  const scan = calls.filter((c) => c.opts.feature === 'mail.scan');
  assert.equal(scan.length, 1);
  assert.equal(scan[0].opts.model, 'claude-haiku-5-5');
});

test('Haiku נדחה (400) — אותו מייל במודל הראשי, ולא נופל', async (t) => {
  const { u, conn, gmailId } = setup(t);
  const models = [];
  Fakes.claude(t, (opts) => {
    if (opts.feature !== 'mail.scan') return {};
    models.push(opts.model ?? null);
    if (opts.model) { const err = new Error('model not available'); err.status = 400; throw err; }
    return ANALYSIS;
  });
  assert.equal(await MailScan._internal.processMessage(u, conn, gmailId), 'suggested');
  assert.deepEqual(models, ['claude-haiku-5-5', null]);
});

test('ריק ב-‎ai_scan_model‎ — המודל הראשי', async (t) => {
  const { u, conn, gmailId } = setup(t);
  const { calls } = Fakes.claude(t, (opts) => (opts.feature === 'mail.scan' ? ANALYSIS : {}));
  D.setSetting('ai_scan_model', '');
  t.after(() => D.setSetting('ai_scan_model', 'claude-haiku-5-5'));
  await MailScan._internal.processMessage(u, conn, gmailId);
  assert.equal(calls.find((c) => c.opts.feature === 'mail.scan').opts.model, null);
});
