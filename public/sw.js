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
const VERSION = 'mesimon-v5';

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
  '/js/views/tracker.js',
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

/**
 * התראה שנדחפה מהשרת.
 *
 * זה המסלול היחיד שעובד כשאין שום חלון פתוח: שירות הדחיפה של הדפדפן מעיר
 * את ה-Service Worker, והוא מציג את ההתראה. בטלפון זה המצב הרגיל — מערכת
 * ההפעלה הורגת אפליקציות ברקע — ולכן בלי זה לא הייתה מגיעה התראה לנייד.
 *
 * ‎userVisibleOnly‎ בהרשמה מחייב אותנו להציג התראה על כל דחיפה. דחיפה
 * שמטענה לא נקרא מוצגת בנוסח כללי ולא נבלעת בשקט, אחרת הדפדפן מציג במקומה
 * "הודעה ברקע" מטעמו.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* מטען שאינו JSON */ }

  const title = data.title || 'משימון';

  /*
   * תשובה מתוך ההתראה, כמו בוואטסאפ. ‎type: 'text'‎ הופך את הפעולה לשדה
   * הקלדה במקום כפתור, והטקסט מגיע ב-‎event.reply‎ ב-notificationclick.
   *
   * מוצע רק על הודעה בשרשור: התראה על איחור או על שינוי סטטוס אינה שיחה,
   * ושדה תשובה עליה מציע פעולה שאין לה למי לענות.
   *
   * דפדפן שאינו תומך בשדה הקלדה יציג את הפעולה ככפתור, ולחיצה עליו תיפול
   * למסלול הרגיל — פתיחת המשימה. לכן אין כאן זיהוי יכולות: הנפילה היא
   * בדיוק ההתנהגות הנכונה.
   */
  const actions = data.canReply
    ? [{ action: 'reply', type: 'text', title: 'תשובה', placeholder: 'כאן מקלידים תגובה' }]
    : [];

  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'יש עדכון חדש במשימון',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'he',
    dir: 'rtl',
    // נשארת עד שנוגעים בה — התראה שהגיעה כשלא הסתכלת ונעלמה אינה התראה
    requireInteraction: true,
    /*
     * אותה תגית שהדף משתמש בה להתראה מקומית, ולפי מזהה ההתראה. אם שני
     * המסלולים בכל זאת ירוצו על אותה התראה, השנייה תחליף את הראשונה במקום
     * להופיע לצדה — וזה בדיוק מה שגרם לכפילות.
     */
    tag: data.id ? `mesimon-${data.id}` : (data.taskId ? `mesimon-task-${data.taskId}` : 'mesimon-push'),
    actions,
    data: {
      taskId: data.taskId ?? null,
      canReply: !!data.canReply,
      internal: !!data.internal
    }
  }));
});

/**
 * שליחת תשובה שהוקלדה בהתראה.
 *
 * נשלחת מכאן ולא מהדף, וזו כל הנקודה: כשההתראה מגיעה בדרך כלל אין שום חלון
 * פתוח. בקשה מתוך ה-Service Worker לאותו מקור נושאת את קוקי הסשן, ולכן
 * התשובה נשלחת בשם המשתמש בלי לפתוח את האפליקציה.
 *
 * כשל אינו נבלע: אם הסשן פג או הרשת נפלה, מוצגת התראה שאומרת זאת ושומרת את
 * הטקסט לפתיחת המשימה — אחרת המשתמש חושב שענה, והתשובה נעלמה.
 */
async function sendReply(taskId, text, internal) {
  const body = String(text ?? '').trim();
  if (!taskId || !body) return;

  try {
    const res = await fetch(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ body, internal })
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'הסשן פג' : `שגיאה ${res.status}`);

    // אישור קצר שנעלם מעצמו — התראה שדורשת סגירה על "נשלח" היא טרחה
    await self.registration.showNotification('התשובה נשלחה', {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      lang: 'he', dir: 'rtl', tag: `mesimon-sent-${taskId}`,
      data: { taskId }
    });
    // חלון פתוח יראה את התגובה מיד, בלי להמתין למחזור הסקר
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.postMessage({ type: 'comment-added', taskId });
    }
  } catch (err) {
    await self.registration.showNotification('התשובה לא נשלחה', {
      body: `${err.message}. לחיצה כאן תפתח את המשימה.`,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      lang: 'he', dir: 'rtl', requireInteraction: true,
      tag: `mesimon-failed-${taskId}`,
      data: { taskId }
    });
  }
}

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

  /*
   * תשובה שהוקלדה בהתראה. נשלחת ונגמר — בלי לפתוח חלון, וזו כל התכלית:
   * לענות בשתי שניות מבלי לעזוב את מה שעושים.
   *
   * ‎event.reply‎ ריק פירושו שהדפדפן הציג את הפעולה ככפתור ולא כשדה הקלדה.
   * במקרה כזה נופלים למסלול הרגיל של פתיחת המשימה, שם יש תיבת תגובה.
   */
  if (event.action === 'reply' && event.reply) {
    event.waitUntil(sendReply(taskId, event.reply, !!event.notification.data?.internal));
    return;
  }

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
