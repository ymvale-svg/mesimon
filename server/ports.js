'use strict';
/**
 * שקעים (ports) — הדרך של מודול "נמוך" לקרוא למודול "גבוה" ממנו בלי לייבא אותו.
 *
 * למה: כשסריקת המייל צריכה לשלוח בוואטסאפ, והבוט צריך את סריקת המייל — ייבוא הדדי יוצר מעגל
 * ("משיכה מפה ומשיכה משם"): אי אפשר לטעון, לבדוק או להחליף אחד בלי השני.
 * במקום זה המודול הנמוך מבקש שקע בשם (‎Ports.get('whatsapp').deliver(…)‎), ונקודת החיבור
 * (‎server/wiring.js‎) — המקום היחיד שמכיר את כולם — מחברת אליו את המימוש האמיתי בהפעלה.
 * בבדיקה מחברים זיוף: ‎Ports.provide('whatsapp', fake)‎.
 *
 * שקע שלא חובר זורק — כמו שגיאת טעינה של מודול. אין ברירת מחדל שקטה.
 */
const impls = new Map();

/** מחבר מימוש לשקע. מחזיר פונקציה שמחזירה את הקודם (לבדיקות) */
function provide(name, impl) {
  const prev = impls.get(name);
  impls.set(name, impl);
  return () => (prev === undefined ? impls.delete(name) : impls.set(name, prev));
}

function get(name) {
  const impl = impls.get(name);
  if (impl === undefined) throw new Error(`השקע "${name}" לא חובר (server/wiring.js)`);
  return impl;
}

const has = (name) => impls.has(name);

module.exports = { provide, get, has };
