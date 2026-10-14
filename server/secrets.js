'use strict';
/**
 * הצפנת סודות שנשמרים במסד הנתונים — כרגע אסימוני הרענון של Gmail.
 *
 * אסימון רענון הוא גישת קריאה לתיבת הדואר של אדם, בלי תפוגה. אם קובץ מסד
 * הנתונים דולף (גיבוי, העתקה למחשב אחר), האסימונים לא יהיו קריאים בלי המפתח.
 *
 * המפתח: משתנה הסביבה ‎TOKEN_ENCRYPTION_KEY‎ אם הוגדר (מומלץ בענן), ואחרת
 * קובץ אקראי שנוצר פעם אחת ליד מסד הנתונים — לא בתוכו. AES-256-GCM.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const D = require('./db');

const KEY_FILE = path.join(D.STORAGE.dataDir, 'token.key');

let cached = null;
function key() {
  if (cached) return cached;
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY;
  if (fromEnv) {
    cached = crypto.createHash('sha256').update(fromEnv).digest();
    return cached;
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cached = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  return cached;
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** מחזיר ‎null‎ כשאי אפשר לפענח — למשל אחרי שהמפתח הוחלף */
function decrypt(stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
