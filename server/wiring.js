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
 *   mailPush       — תזכורות המייל מסננות לפי "מותר להקפיץ", והקפצת המייל משתמשת בתזכורות
 * בבדיקות מחברים זיופים במקום: ‎Ports.provide('waBot', fake)‎.
 */
const Ports = require('./core').Ports;

Ports.provide('classification', require('./core').Classification);
Ports.provide('mailMemory', require('./mail').MailMemory);
Ports.provide('whatsappScan', require('./whatsapp').WhatsappScan);
Ports.provide('agents', require('./agents').Agents);
Ports.provide('waBot', require('./whatsapp').WaBot);
Ports.provide('mailPush', require('./mail').MailPush);

// החיבור לפריוריטי קורא את החיבור והחברות ממסך ההגדרות של משימון פריוריטי (‎priority-settings.js‎)
require('./priority').PrioritySettings.apply();

module.exports = Ports;
