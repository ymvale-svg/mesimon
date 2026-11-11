'use strict';
/**
 * ⚙️ הגדרות משימון פריוריטי (‎server/priority/priority-settings.js‎): זריעה מההגדרות הישנות, שמירה,
 * סיסמה מוצפנת שלא חוזרת לתצוגה, נעילת בדיקות, והחיבור ל-‎integrations/priority.js‎.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, D } = require('../../helpers/db');
const Settings = require('../../../server/priority/priority-settings');
const Priority = require('../../../server/integrations/priority');
const Secrets = require('../../../server/core/secrets');

boot();
const reset = () => { D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_settings%'); D.run("DELETE FROM settings WHERE key = 'pd_notify_companies'"); };
const withEnv = (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
test.afterEach(() => { reset(); Priority.configure(null); });

test('זריעה: כל עוד לא נשמר כלום — מה שהיה עד היום (PRIORITY_COMPANIES, PO_NOTIFY_COMPANIES, pd_notify_companies)', () => {
  reset();
  withEnv({ PRIORITY_COMPANIES: 'a160226,elad1', PO_NOTIFY_COMPANIES: 'elad1' }, () => {
    D.setSetting('pd_notify_companies', ['mordot']);
    assert.deepEqual(Settings.writable(1, { ignoreTestLock: true }).sort(), ['a160226', 'elad1']);
    assert.deepEqual(Settings.poNotifyCompanies(), ['elad1']);
    assert.deepEqual(Settings.pdNotifyCompanies(), ['mordot']);
    assert.ok(Settings.companies().some((c) => c.code === 'test11' && c.test));
  });
});

test('זריעה בלי PO_NOTIFY_COMPANIES — התראות הזמנות בכל החברות', () => {
  reset();
  withEnv({ PO_NOTIFY_COMPANIES: undefined }, () => {
    assert.equal(Settings.poNotifyCompanies().length, Settings.companies().length);
  });
});

test('בריצת בדיקות אף חברה אינה פתוחה לכתיבה — גם אם נשמרה פתוחה', () => {
  reset();
  Settings.save({ companies: [{ code: 'elad1', name: 'אלעד סנטר', write: true }] });
  assert.deepEqual(Settings.writable(), []);
  assert.deepEqual(Settings.writable(1, { ignoreTestLock: true }), ['elad1']);
});

test('סיסמה: נשמרת מוצפנת, לא חוזרת לתצוגה, וריק = להשאיר את הקיימת', () => {
  reset();
  const shown = Settings.save({ connection: { user: 'API-USER', password: 'S3cret!' } });
  assert.equal(shown.connection.hasPassword, true);
  assert.equal(JSON.stringify(shown).includes('S3cret'), false);
  const stored = Settings._raw().connection.password;
  assert.notEqual(stored, 'S3cret!');
  assert.equal(Secrets.decrypt(stored), 'S3cret!');
  Settings.save({ connection: { user: 'API-USER', password: '' } });
  assert.equal(Settings.credentials().password, 'S3cret!');
  Settings.save({ connection: { clearPassword: true } });
  assert.equal(Settings._raw().connection.password, '');
});

test('חיבור: שדה ריק במסך — משתנה הסביבה; מלא — המסך גובר', () => {
  reset();
  withEnv({ PRIORITY_USER: 'env-user', PRIORITY_PASSWORD: 'env-pass' }, () => {
    assert.deepEqual([Settings.credentials().user, Settings.credentials().password], ['env-user', 'env-pass']);
    Settings.save({ connection: { user: 'screen-user', password: 'screen-pass', host: 'https://other.example/odata/x' } });
    const c = Settings.credentials();
    assert.deepEqual([c.user, c.password, c.host], ['screen-user', 'screen-pass', 'other.example']);
  });
});

test('חברות: קוד לא תקין, כפילות ועותק בדיקה שאינו ברשימה — נדחים', () => {
  reset();
  assert.throws(() => Settings.save({ companies: [{ code: 'a b' }] }), /קוד חברה לא תקין/);
  assert.throws(() => Settings.save({ companies: [{ code: 'x1' }, { code: 'x1' }] }), /פעמיים/);
  assert.throws(() => Settings.save({ companies: [{ code: 'x1', sandbox: 'nope' }] }), /עותק הבדיקה/);
  assert.throws(() => Settings.save({ companies: [] }), /לפחות חברה אחת/);
});

test('apply: החיבור לפריוריטי קורא מההגדרות — חברות, חיבור וכתיבה', () => {
  reset();
  const before = Priority.COMPANIES.map((c) => ({ ...c }));
  try {
    Settings.save({ connection: { user: 'u1', password: 'p1' }, companies: [{ code: 'zz1', name: 'חברת בדיקה', vat: '51-000000-1', write: true }] });
    assert.deepEqual(Priority.COMPANIES.map((c) => c.code), ['zz1']);
    assert.equal(Priority.COMPANIES[0].vat, '510000001');
    assert.equal(Priority.isEnabled(), true);
    assert.deepEqual(Priority.allowed(), [], 'נעילת הבדיקות עוברת גם לחיבור');
  } finally {
    Priority.syncCompanies(before);
  }
});

test('יומן: כל שינוי נרשם, בלי ערך הסיסמה', () => {
  reset();
  D.run('DELETE FROM settings WHERE key LIKE ?', 'priority_settings_log%');
  Settings.save({ connection: { password: 'Top-Secret' }, companies: [{ code: 'elad1', name: 'אלעד', write: true }] }, { by: { id: 1, name: 'מנהל' } });
  const h = Settings.history();
  assert.equal(h[0].by.name, 'מנהל');
  assert.ok(h[0].changes.some((c) => c.includes('סיסמה הוחלפה')));
  assert.equal(JSON.stringify(h).includes('Top-Secret'), false);
});
