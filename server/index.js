'use strict';
/**
 * משימון — נקודת הכניסה לשרת.
 * אשל הירדן / מחלקת שיווק ומכירות.
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
const { router } = require('./api');
const { HttpError, sendJson, serveStatic, parseUrl, unauthorized } = require('./http-kit');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

D.bootstrap();
Auth.purgeExpired();

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

    if (serveStatic(res, PUBLIC_DIR, url.pathname)) return;

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

server.listen(PORT, HOST, () => {
  Rules.start();
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   משימון — מערכת ניהול משימות ופרויקטים      │');
  console.log('  │   אשל הירדן · מחלקת שיווק ומכירות            │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  מקומי:   http://localhost:${PORT}`);
  if (lan) console.log(`  ברשת:    http://${lan.address}:${PORT}`);
  console.log(`  נתונים:  ${D.DB_PATH}`);
  console.log('');
});

const shutdown = () => {
  Rules.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
