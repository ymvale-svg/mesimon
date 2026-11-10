'use strict';
/**
 * נטען לפני כל קובץ בדיקה (‎node --test --require ./test/setup.js‎). כל קובץ רץ בתהליך נפרד, ולכן:
 *   • מסד נתונים ותיקיית קבצים זמניים וחדשים לכל קובץ — לא נוגעים ב-data/ האמיתי.
 *   • בלי מפתחות לשירותים חיצוניים — אף זרימה לא "מופעלת" בטעות.
 *   • חסימת רשת: כל פנייה החוצה (לא localhost) נכשלת מיד. בדיקה שצריכה שירות חיצוני מקבלת זיוף מ-test/fakes.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimon-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.TZ = process.env.TZ || 'UTC';
process.env.MESIMON_TEST = '1';

// מפתחות שמפעילים חיבורים חיצוניים — לעולם לא בבדיקה
const SECRET_VARS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_SPEECH_API_KEY', 'RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_LOGIN_CLIENT_ID', 'GOOGLE_LOGIN_CLIENT_SECRET',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME', 'SMTP_REPLY_TO',
  'PRIORITY_USER', 'PRIORITY_PASSWORD', 'PO_NOTIFY_COMPANIES', 'TIMELESS_ACCESS_TOKEN',
  'ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM2_ACCOUNT_ID', 'ZOOM2_CLIENT_ID', 'ZOOM2_CLIENT_SECRET',
  'TIFUL360_INBOUND_KEY', 'TIFUL360_API_URL', 'TIFUL360_API_KEY', 'BOT_REVIEW_KEY', 'RENDER',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'PUBLIC_URL'
];
for (const k of SECRET_VARS) delete process.env[k];
// אף חברה של פריוריטי לא פתוחה לכתיבה — גם לא test11
process.env.PRIORITY_COMPANIES = '';
process.env.MAIL_MEMORY_OFF = '1';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const blocked = (host) => new Error(`בדיקה ניסתה לפנות לרשת (${host}). השתמשו בזיוף מ-test/fakes.`);
const hostOf = (target) => {
  try {
    if (target instanceof URL) return target.hostname;
    if (typeof target === 'string') return new URL(target).hostname;
    if (target && typeof target === 'object') return target.hostname || target.host || 'localhost';
  } catch { /* כתובת לא תקינה */ }
  return String(target);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const host = hostOf(input instanceof Request ? input.url : input);
  if (!LOCAL.has(host)) throw blocked(host);
  return realFetch(input, init);
};

for (const mod of [http, https]) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn];
    mod[fn] = function guarded(target, ...rest) {
      const host = hostOf(target).replace(/:\d+$/, '');
      if (!LOCAL.has(host)) throw blocked(host);
      return real.call(this, target, ...rest);
    };
  }
}
