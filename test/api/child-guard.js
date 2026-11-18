'use strict';
/**
 * נטען לתוך תהליך השרת שבדיקות ה-API מריצות (‎--require‎): כל פנייה לרשת שאינה localhost נכשלת מיד.
 * אותה חסימה של test/setup.js — בלי שאר ההגדרות שלו (תיקיית נתונים, מחיקת ADMIN_*), שאותן קובע test/api/server.js.
 */
const http = require('node:http');
const https = require('node:https');

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const blocked = (host) => new Error(`שרת הבדיקה ניסה לפנות לרשת (${host})`);
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
