'use strict';
/**
 * נקודת החיבור (composition root) — המקום היחיד שמכיר את כל המודולים ומחבר ביניהם את השקעים
 * (‎ports.js‎). נטען פעם אחת ב-‎index.js‎, לפני שהשרת מתחיל לעבוד.
 *
 * כל שורה כאן היא קריאה "כלפי מעלה" שהייתה פעם ‎require‎ בתוך פונקציה ויצרה מעגל:
 *   classification — המסד (התראות) צריך את סיווג המידע הרגיש, והסיווג קורא מהמסד
 *   mailMemory     — מד העומס מציג את מצב סריקת זיכרון המייל, והיא שואלת את מד העומס
 *   whatsappScan   — משימות AI מסמנות שיחות וואטסאפ שנענו
 *   agents         — תור מסמכי המייל והצעת סגירת משימה קוראים לסוכנים, והסוכנים לתור
 *   waBot          — סריקת המייל ותור המסמכים שולחים בוואטסאפ, והבוט קורא לסריקת המייל
 * בבדיקות מחברים זיופים במקום: ‎Ports.provide('waBot', fake)‎.
 */
const Ports = require('./ports');

Ports.provide('classification', require('./ai/classification'));
Ports.provide('mailMemory', require('./ai/mail-memory'));
Ports.provide('whatsappScan', require('./ai/whatsapp-scan'));
Ports.provide('agents', require('./ai/agents'));
Ports.provide('waBot', require('./ai/wa-bot'));

module.exports = Ports;
