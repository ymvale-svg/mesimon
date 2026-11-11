'use strict';
/**
 * הכנת מסמך גדול לקריאה — בחוט נפרד (‎worker_threads‎), כדי שהחילוץ (Word,
 * Excel) והקידוד לא יתקעו את לולאת האירועים של השרת. השרת ממשיך לענות לאתר
 * ולבדיקת התקינות של Render בזמן שהמסמך מוכן.
 *
 * מקבל ‎{ att: {filename, mime, data} }‎ ומחזיר את התוצאה של ‎Docs.prepare‎.
 */
const { parentPort, workerData, isMainThread, Worker } = require('node:worker_threads');
const Docs = require('./doc-text');

if (!isMainThread && parentPort && workerData?.att) {
  const { att } = workerData;
  try {
    const out = Docs.prepare([{ filename: att.filename, mime: att.mime, data: Buffer.from(att.data) }], { limit: 1 });
    parentPort.postMessage({ ok: true, out });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

/** מריץ את ‎Docs.prepare‎ לקובץ אחד בחוט נפרד. נכשל החוט — זורק */
function prepareOff(att, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, {
      workerData: { att: { filename: att.filename, mime: att.mime, data: att.data } },
      // תקרת זיכרון לחוט — קובץ חריג מפיל את החוט, לא את השרת
      resourceLimits: { maxOldGenerationSizeMb: 384 }
    });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('הכנת המסמך ארכה יותר מדי')); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); m.ok ? resolve(m.out) : reject(new Error(m.error)); });
    w.once('error', (err) => { clearTimeout(timer); reject(err); });
    w.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`הכנת המסמך נעצרה (${code})`)); });
  });
}

module.exports = { prepareOff };
