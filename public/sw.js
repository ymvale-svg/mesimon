'use strict';
/*
 * ה-Service Worker של משימון.
 *
 * תפקידו אחד: שהאפליקציה תיפתח מיד, וגם ללא רשת. הוא שומר במכשיר את קבצי
 * המערכת — HTML, CSS, JS, סמלים — ומגיש אותם מהמטמון.
 *
 * מה הוא *אינו* עושה, ובכוונה: הוא אינו נוגע בשום בקשה ל-‎/api/‎. נתוני המערכת
 * הם נתונים של משתמש מזוהה, ומטמון שלהם היה עלול להציג למשתמש אחד את מה
 * שנשמר עבור אחר, או להציג נתון שכבר שונה בשרת כאילו הוא נכון. תשובות ה-API
 * עוברות ישר לרשת, תמיד.
 */

// שינוי המספר מפסל את המטמון הקודם ומאלץ טעינה מחדש של קבצי המערכת
const VERSION = 'mesimon-v2';

/**
 * מה נשמר מראש. רק מה שנדרש כדי שהמסך ייבנה: אם אחד מהם חסר, האפליקציה לא
 * תעלה בכלל ללא רשת. כל היתר נשמר בהזדמנות, כשהוא נטען בפעם הראשונה.
 */
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/css/mobile.css',
  '/js/api.js',
  '/js/ui.js',
  '/js/app.js',
  '/js/views/login.js',
  '/js/views/invite.js',
  '/js/views/signup.js',
  '/js/views/home.js',
  '/js/views/mobile.js',
  '/js/views/grid.js',
  '/js/views/board.js',
  '/js/views/task-card.js',
  '/js/views/checklist-item.js',
  '/js/views/vendor-portal.js',
  '/js/views/reports.js',
  '/js/views/admin.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /*
     * ‎addAll‎ נכשל כולו אם קובץ אחד נכשל, ואז לא נשמר דבר. לכן כל קובץ
     * נשמר בנפרד: גרסה חדשה שהוסיפה קובץ ששמו שגוי לא תשבית את המטמון כולו.
     */
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    // הגרסה החדשה נכנסת לתוקף מיד ולא ממתינה לסגירת כל הלשוניות
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // ניקוי מטמונים של גרסאות קודמות, אחרת הם נצברים בלי גבול
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/*
 * לחיצה על התראת מערכת ההפעלה.
 *
 * ההתראה מוצגת דרך ה-Service Worker ולא דרך ‎new Notification‎ מהדף, וזו
 * הסיבה שהמטפל יושב כאן: כך היא מגיעה למרכז ההתראות של Windows, נשארת בו
 * אחרי שנעלמה מהמסך, ועובדת גם כשהאפליקציה מותקנת ואין לשונית פתוחה.
 *
 * הלחיצה אינה פותחת לשונית חדשה כשיש כבר אחת: ממקדים את הקיימת ושולחים לה
 * הודעה לפתוח את המשימה. פתיחת לשונית שנייה לאותה מערכת היא בדיוק מה
 * שמעצבן ב"התראה שלחצתי עליה".
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId ?? null;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      // הדף פתוח וטעון — אין צורך לנווט, רק לפתוח את הכרטיס
      client.postMessage({ type: 'open-task', taskId });
      return;
    }
    // אין לשונית פתוחה: נפתחת אחת, והפרמטר ‎?task=‎ הוא זה שפותח את הכרטיס
    await self.clients.openWindow(taskId ? `/?task=${taskId}` : '/');
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // בקשות שאינן GET, מקור אחר, או ה-API — ישר לרשת, בלי מטמון
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  /**
   * ניווט (פתיחת האפליקציה): קודם רשת, ואם אין — ה-HTML מהמטמון. הסדר הזה
   * ולא ההפוך, כדי שגרסה חדשה של האתר תיראה מיד ולא רק אחרי רענון שני.
   */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(VERSION);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('/index.html')) ?? Response.error();
      }
    })());
    return;
  }

  /**
   * נכסים: קודם מטמון — כך הפתיחה מיידית — ובמקביל הבאה מהרשת שמעדכנת את
   * המטמון לפעם הבאה. קובץ חדש מגיע בטעינה הבאה, וזה מקובל לקבצי מערכת.
   */
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async (res) => {
      if (res && res.ok) (await caches.open(VERSION)).put(request, res.clone());
      return res;
    }).catch(() => null);

    return cached ?? (await network) ?? Response.error();
  })());
});
