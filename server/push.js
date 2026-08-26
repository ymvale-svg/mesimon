'use strict';
/**
 * Web Push — התראה שמגיעה לטלפון גם כשמשימון סגור לגמרי.
 *
 * למה זה נדרש: כל שאר ההתראות במערכת נשענות על כך שהדף פתוח וסוקר את השרת.
 * בטלפון זה כמעט לא קורה — מערכת ההפעלה הורגת אפליקציות ברקע — ולכן עובד
 * שקיבל משימה לא ידע עליה עד שנזכר להיכנס. כאן השרת הוא שדוחף: הוא שולח
 * את ההתראה לשירות הדחיפה של הדפדפן (Google, Mozilla, Apple), והוא מעיר את
 * ה-Service Worker במכשיר בלי שום חלון פתוח.
 *
 * הכול ממומש כאן מאפס מעל ‎node:crypto‎, בלי ספרייה חיצונית, כמו כל השאר
 * במערכת. שני התקנים:
 *
 * • VAPID (RFC 8292) — השרת מזדהה מול שירות הדחיפה בחתימת JWT בתקן ES256.
 *   בלעדיה שירות הדחיפה דוחה את הבקשה.
 *
 * • aes128gcm (RFC 8291) — המטען מוצפן בשביל המכשיר עצמו. שירות הדחיפה
 *   מעביר אותו ואינו יכול לקרוא אותו, וזה לא עניין של נימוס: תוכן המשימות
 *   של החברה עובר דרך שרת של צד שלישי.
 */

const crypto = require('crypto');
const D = require('./db');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------------------------------------------------------------------------
// מפתחות VAPID
// ---------------------------------------------------------------------------

/**
 * זוג המפתחות נוצר פעם אחת ונשמר בהגדרות, ולא נדרש ממשתמש להגדיר משתני
 * סביבה. החלפתו תבטל את כל ההרשמות הקיימות, ולכן הוא נוצר רק כשאין.
 */
function vapidKeys() {
  let pub = D.getSetting('vapid_public', '');
  let pem = D.getSetting('vapid_private_pem', '');

  if (!pub || !pem) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    /*
     * שירות הדחיפה מצפה לנקודה הלא-דחוסה: בית 0x04 ואחריו x ו-y באורך 32
     * כל אחד. ייצוא JWK נותן את x ו-y בנפרד, ולכן הם מחוברים כאן ביד.
     */
    pub = b64u(Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url')
    ]));
    pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    D.setSetting('vapid_public', pub);
    D.setSetting('vapid_private_pem', pem);
    console.log('[משימון] נוצרו מפתחות VAPID להתראות דחיפה');
  }
  return { publicKey: pub, privatePem: pem };
}

const publicKey = () => vapidKeys().publicKey;

/**
 * ‎sub‎ הוא איש קשר שאליו שירות הדחיפה יפנה אם משהו אצלנו מתנהג לא בסדר.
 * חייב להיות ‎mailto:‎ או כתובת https, ולכן יש נפילה לברירת מחדל תקנית.
 */
function vapidSubject() {
  const url = String(D.getSetting('public_url', '') ?? '').trim();
  if (/^https?:\/\//.test(url)) return url.replace(/\/+$/, '');
  const admin = D.get("SELECT email FROM users WHERE role IN ('superadmin','admin') AND status='active' ORDER BY id LIMIT 1");
  return admin?.email ? `mailto:${admin.email}` : 'mailto:admin@localhost';
}

/** JWT חתום ES256, תקף לשירות דחיפה אחד ולשעות הקרובות */
function vapidHeader(endpoint) {
  const { publicKey: pub, privatePem } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud,
    // שתים־עשרה שעות: מותר עד 24, ומרווח קצר יותר מקטין את החלון אם ידלוף
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapidSubject()
  }));
  /*
   * ‎ieee-p1363‎ ולא ברירת המחדל: Node חותם ב-DER, ו-JWS דורש את החתימה
   * כ-r‖s גולמי באורך 64. בלי זה שירות הדחיפה מחזיר 401 בלי הסבר.
   */
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: crypto.createPrivateKey(privatePem),
    dsaEncoding: 'ieee-p1363'
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${pub}`;
}

// ---------------------------------------------------------------------------
// הצפנת המטען — RFC 8291
// ---------------------------------------------------------------------------

const RECORD_SIZE = 4096;

/**
 * מצפין מטען עבור מכשיר יחיד.
 *
 * ‎p256dh‎ הוא המפתח הציבורי של המכשיר ו-‎auth‎ סוד בן 16 בתים — שניהם
 * מגיעים מההרשמה בדפדפן. התוצאה היא גוף הבקשה כולו, כולל הכותרת שממנה
 * המכשיר יודע לפענח.
 */
function encrypt(payload, p256dh, auth) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');

  // זוג מפתחות חד-פעמי לכל הודעה, כדרישת התקן
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);

  // שילוב סוד ה-ECDH עם סוד האימות של המכשיר
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // 0x02 הוא מפריד הריפוד של הרשומה האחרונה, וכאן יש רשומה אחת בלבד
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);

  return Buffer.concat([
    salt,                                 // 16
    recordSize,                           // 4
    Buffer.from([asPublic.length]),        // 1
    asPublic,                             // 65
    body
  ]);
}

// ---------------------------------------------------------------------------
// הרשמות
// ---------------------------------------------------------------------------

function saveSubscription(userId, sub) {
  const endpoint = String(sub?.endpoint ?? '').trim();
  const p256dh = String(sub?.keys?.p256dh ?? '').trim();
  const auth = String(sub?.keys?.auth ?? '').trim();
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return false;

  /*
   * המפתח הוא ה-endpoint ולא המשתמש: לאדם אחד יש מחשב וטלפון, וכל אחד מהם
   * הרשמה נפרדת. אותו endpoint שנרשם מחדש מתעדכן ולא מוכפל.
   */
  D.run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, created_at = excluded.created_at`,
    userId, endpoint, p256dh, auth, D.nowIso()
  );
  return true;
}

const removeSubscription = (endpoint) =>
  D.run('DELETE FROM push_subscriptions WHERE endpoint = ?', String(endpoint ?? ''));

// ---------------------------------------------------------------------------
// שליחה
// ---------------------------------------------------------------------------

/**
 * ברירות המחדל של מה קופץ, זהות לקטלוג שבצד הלקוח. המשתמש בוחר במסך ניהול
 * ההתראות, והבחירה נשמרת ב-user_prefs — ולכן השרת קורא את אותה העדפה בדיוק
 * ואינו דוחף מה שהמשתמש כיבה.
 */
const KIND_DEFAULTS = {
  assignment: true, comment: true, mention: true, completed: true,
  status_change: true, overdue: true,
  escalation: false, manager_alert: false, vendor_reminder: false
};

function kindEnabled(userId, kind) {
  const chosen = D.userPrefs(userId)?.notifyKinds ?? {};
  return chosen[kind] ?? KIND_DEFAULTS[kind] ?? false;
}

/**
 * דחיפה לכל המכשירים של משתמש.
 *
 * ‎404‎ ו-‎410‎ פירושם שההרשמה מתה — הדפדפן הוסר, המשתמש ניקה נתונים, או
 * שהמכשיר לא קיים. במקרה כזה השורה נמחקת, אחרת הטבלה מתמלאת בהרשמות מתות
 * שכל התראה מנסה לפנות אליהן שוב.
 */
async function deliver({ targetType, targetId, kind, title, body, taskId }) {
  if (targetType !== 'user') return;                 // לספק אין אפליקציה מותקנת
  if (!kindEnabled(targetId, kind)) return;

  const rows = D.all('SELECT * FROM push_subscriptions WHERE user_id = ?', targetId);
  if (!rows.length) return;

  const payload = JSON.stringify({
    title: title ?? 'משימון',
    body: body ?? '',
    taskId: taskId ?? null,
    kind: kind ?? null
  });

  await Promise.all(rows.map(async (row) => {
    try {
      const res = await fetch(row.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          // כמה זמן שירות הדחיפה ישמור את ההודעה אם המכשיר כרגע כבוי
          TTL: '86400',
          Urgency: 'normal',
          Authorization: vapidHeader(row.endpoint)
        },
        body: encrypt(payload, row.p256dh, row.auth)
      });

      if (res.status === 404 || res.status === 410) {
        removeSubscription(row.endpoint);
        return;
      }
      if (!res.ok) {
        console.error(`[משימון] דחיפת התראה נכשלה (${res.status}) אל ${new URL(row.endpoint).host}`);
      }
    } catch (err) {
      // כשל רשת אינו אמור להפיל את הפעולה שיצרה את ההתראה
      console.error('[משימון] דחיפת התראה נכשלה:', err.message);
    }
  }));
}

/**
 * נרשם כמאזין ל-‎D.notify‎, כדי שכל התראה במערכת תידחף בלי שכל נקודת קצה
 * תצטרך לזכור זאת בנפרד. ‎void‎ במכוון: יצירת ההתראה אינה ממתינה לרשת.
 */
function start() {
  vapidKeys();     // יצירה מוקדמת, כדי שהמפתח יהיה זמין לבקשה הראשונה
  D.onNotify((payload) => { void deliver(payload); });
  console.log('[משימון] התראות דחיפה פעילות (Web Push)');
}

module.exports = {
  start, deliver, publicKey, saveSubscription, removeSubscription,
  // נחשפים לבדיקות
  encrypt, vapidHeader, KIND_DEFAULTS
};
