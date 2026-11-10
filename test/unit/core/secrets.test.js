'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.TOKEN_ENCRYPTION_KEY; // מפתח מקובץ — כמו במחשב מקומי
const D = require('../../../server/core/db');
const S = require('../../../server/core/secrets');

test('encrypt/decrypt — הלוך ושוב, כולל עברית', () => {
  for (const plain of ['1//0abc-refresh-token', 'סוד בעברית 🔒', 'x'.repeat(5000)]) {
    assert.equal(S.decrypt(S.encrypt(plain)), plain);
  }
});

test('encrypt — פורמט v1 ו-IV אקראי', () => {
  const a = S.encrypt('same');
  const b = S.encrypt('same');
  assert.notEqual(a, b);
  const parts = a.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
  assert.ok(!a.includes('same'));
});

test('encrypt — ערך ריק נשמר כמחרוזת ריקה', () => {
  assert.equal(S.encrypt(''), '');
  assert.equal(S.encrypt(null), '');
  assert.equal(S.encrypt(undefined), '');
});

test('encrypt — מספר הופך למחרוזת', () => {
  assert.equal(S.decrypt(S.encrypt(12345)), '12345');
});

test('decrypt — קלט לא תקין מחזיר null', () => {
  for (const v of [null, undefined, '', 'plain-token', 'v2:a:b:c', 'v1:a:b', 'v1:a:b:c:d']) {
    assert.equal(S.decrypt(v), null, String(v));
  }
});

test('decrypt — שינוי בנתונים או בתג נכשל', () => {
  const enc = S.encrypt('token-value');
  const [v, iv, tag, data] = enc.split(':');
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 1;
    return buf.toString('base64');
  };
  assert.equal(S.decrypt([v, iv, tag, flip(data)].join(':')), null);
  assert.equal(S.decrypt([v, iv, flip(tag), data].join(':')), null);
  assert.equal(S.decrypt([v, flip(iv), tag, data].join(':')), null);
});

test('קובץ המפתח — נוצר ליד המסד, 32 בתים, הרשאות פרטיות', () => {
  S.encrypt('x');
  const file = path.join(D.STORAGE.dataDir, 'token.key');
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
