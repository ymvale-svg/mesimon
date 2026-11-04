'use strict';
/**
 * משימון — נקודת הכניסה לשרת.
 */
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

// node:sqlite קיים רק מגרסה 22.5 ומעלה, וללא דגל מגרסה 23.4.
// בלי הבדיקה הזו נופלת שגיאה לא מובנת בהפעלה על שרת עם גרסה ישנה.
try {
  require('node:sqlite');
} catch {
  console.log('');
  console.log('  ⚠  גרסת Node.js המותקנת ישנה מדי עבור משימון.');
  console.log(`     מותקן: ${process.version} · נדרש: 24 ומעלה`);
  console.log('     להורדה: https://nodejs.org');
  console.log('');
  process.exit(1);
}

const D = require('./db');
const Auth = require('./auth');
const Rules = require('./rules-engine');
const Push = require('./push');
const LoadMonitor = require('./load-monitor');
const AiTasks = require('./ai-tasks');
const WaBot = require('./ai/wa-bot');
const { router } = require('./api');
const Today = require('./today');
const GContacts = require('./google-contacts');
const Meetings = require('./meetings');
const Dupes = require('./ai/task-dupes');
const { HttpError, sendJson, serveStatic, parseUrl, unauthorized } = require('./http-kit');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

D.bootstrap();
Auth.purgeExpired();
// ההודעה הראשונה של "מה חדש" — טיוטה אחת, פעם אחת, אחרי שהטבלה קיימת
require('./api-whats-new').seedFirstRelease();

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req);

  try {
    if (url.pathname.startsWith('/api/')) {
      const match = router.match(req.method, url.pathname);
      if (!match) return sendJson(res, 404, { error: 'נקודת קצה לא קיימת' });

      const actor = Auth.actorFromRequest(req);
      const ctx = {
        params: match.params,
        actor,
        requireActor() {
          if (!actor) throw unauthorized();
          return actor;
        }
      };
      await match.handler(req, res, ctx);
      return;
    }

    if (serveStatic(res, PUBLIC_DIR, url.pathname, req)) return;

    // כל נתיב אחר מוגש כאפליקציה (ניווט צד-לקוח)
    if (serveStatic(res, PUBLIC_DIR, '/index.html')) return;
    sendJson(res, 404, { error: 'לא נמצא' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      console.error('[משימון] שגיאת שרת:', err);
      sendJson(res, 500, { error: 'שגיאה פנימית בשרת' });
    }
  }
});

// הודעות שגיאה בעברית במקום קריסה עם קוד — החלון הזה נפתח על ידי מי שאינו מפתח
server.on('error', (err) => {
  console.log('');
  if (err.code === 'EADDRINUSE') {
    console.log('  ⚠  משימון כבר פועל על המחשב הזה.');
    console.log('');
    console.log('     אפשר פשוט לפתוח את הדפדפן בכתובת:  http://localhost:' + PORT);
    console.log('     או: לסגור את החלון השחור הקודם ולהריץ שוב.');
  } else if (err.code === 'EACCES') {
    console.log('  ⚠  אין הרשאה להשתמש בפורט ' + PORT + '. יש לפנות למחשוב.');
  } else {
    console.log('  ⚠  לא ניתן להפעיל את השרת: ' + err.message);
  }
  console.log('');
  process.exitCode = 1;
});

/*
 * מצב חירום (‎MESIMON_SAFE_MODE=1‎ במשתני הסביבה ב-Render): האתר עולה בלי שום
 * עבודת רקע — בלי סריקת מיילים וזיכרון, בוט, תזכורות וסנכרונים. לשימוש כשהשרת
 * תקוע (502) ואי אפשר להגיע למסך הניהול כדי לכבות משהו.
 * ‎MAIL_MEMORY_OFF=1‎ — מכבה רק את סריקת זיכרון המייל.
 */
const SAFE_MODE = /^(1|true|yes)$/i.test(String(process.env.MESIMON_SAFE_MODE ?? '').trim());

server.listen(PORT, HOST, () => {
  if (SAFE_MODE) {
    console.warn('[משימון] ⚠ מצב חירום (MESIMON_SAFE_MODE): עבודות הרקע כבויות — רק האתר פועל');
  } else {
    Rules.start();
    Push.start();
    AiTasks.start();
    Today.start();
    GContacts.start();
    Meetings.start();
    WaBot.start();
    // משימות כפולות במחלקה — סריקה פעם ביום (פרק 11ב)
    Dupes.start();
    // 📎 פענוח קבצים גדולים מהמייל לפי בקשה — קובץ אחד בכל פעם
    require('./ai/mail-doc-queue').start();
  }
  // התראה למנהלים כשתקרת המעבד מאטה את הסוכנים
  LoadMonitor.start();
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   משימון — מערכת ניהול משימות ופרויקטים      │');
  console.log('  │   משימות שעובדות בשבילך                      │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  מקומי:   http://localhost:${PORT}`);
  if (lan) console.log(`  ברשת:    http://${lan.address}:${PORT}`);
  console.log(`  נתונים:  ${D.DB_PATH}`);

  const source = {
    env: 'לפי משתני סביבה',
    detected: `דיסק קבוע שזוהה אוטומטית (${D.STORAGE.disk})`,
    local: 'תיקייה מקומית'
  }[D.STORAGE.source];
  console.log(`  אחסון:   ${source}`);
  console.log('');

  // בענן, כתיבה לתוך תיקיית הקוד נמחקת בכל פרסום גרסה — אזהרה בולטת ולא שורה שקטה
  if (D.STORAGE.ephemeralInCloud) {
    console.log('  ' + '='.repeat(64));
    console.log('  ⚠  אזהרה: הנתונים אינם נשמרים!');
    console.log('');
    console.log('     המערכת כותבת לתוך תיקיית הקוד, שנמחקת בכל פרסום גרסה.');
    console.log('     כל המשימות, המשתמשים והקבצים יימחקו בעדכון הבא.');
    console.log('');
    console.log('     לתיקון: יש לחבר דיסק קבוע (Disk) בנתיב /var/mesimon');
    console.log('     ולהגדיר את משתני הסביבה:');
    console.log('       DATA_DIR      = /var/mesimon/data');
    console.log('       UPLOADS_DIR   = /var/mesimon/uploads');
    console.log('  ' + '='.repeat(64));
    console.log('');
  }
});

const shutdown = () => {
  Rules.stop();
  AiTasks.stop();
  Today.stop();
  GContacts.stop();
  Meetings.stop();
  require('./ai/mail-doc-queue').stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
