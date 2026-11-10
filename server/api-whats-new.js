'use strict';
/**
 * "מה חדש" — באנר הפיצ'רים החדשים ומייל העדכון לכל המשתמשים.
 *
 * גרסה = כותרת, תקציר ופריטים; כל פריט משויך למסך ולקהל (כולם / מנהלים /
 * מנהלי מערכת), ונושא סרטון הדמיה של החידוש. כל עוד היא טיוטה אף אחד אינו
 * רואה אותה. בפרסום היא נפתחת לכל משתמש פעם אחת, באמצע המסך, אחרי הכניסה —
 * וניתן לדלג עליה.
 *
 * הגרסאות אינן נכתבות במסך הניהול. כל גרסה מגיעה עם הקוד — קובץ ב-
 * ‎server/whats-new/‎ והסרטונים ב-‎public/whats-new/‎, שהופקו אוטומטית
 * (‎tools/whats-new-video‎) — ונוצרת כטיוטה בעלייה הראשונה של השרת אחריה.
 * למנהל נשאר: תצוגה מקדימה, תיקון ניסוח, פרסום ומייל.
 *
 * מה המשתמש כבר ראה נשמר בהעדפות שלו (‎whatsNewSeenAt‎) כחותמת הזמן של
 * הגרסה האחרונה שנסגרה, ולא כמזהה: טיוטה ישנה שפורסמה מאוחר יותר מקבלת
 * מזהה נמוך, אבל זמן פרסום מאוחר — והיא עדיין צריכה להופיע.
 *
 * כל פריט מצביע גם על המקום במסך שבו נמצא החידוש — "עוגן" מהקטלוג המשותף
 * (‎public/js/feature-anchors.js‎) — בשביל "הראו לי". פריטים של גרסאות
 * ישנות, בלי סרטון, מוצגים בזרקור החי או בצילום שצורף להם אז.
 *
 * משתמש שנוצר אחרי שגרסה פורסמה אינו רואה אותה לעולם: "מה חדש" מתאר שינוי
 * ממה שהיה, ולמי שלא הכיר את מה שהיה אין כאן חדש — רק עוד חלון בכניסה
 * הראשונה שלו. הוא מתחיל מהגרסה הבאה.
 */
const fs = require('node:fs');
const Paths = require('./paths');
const path = require('node:path');

const D = require('./db');
const P = require('./permissions');
const Mailer = require('./mailer');
const { shell, button, escape, BRAND } = require('./mail-templates');
const { badRequest, forbidden, notFound, readJson, sendJson } = require('./http-kit');
// אותו קובץ שהדפדפן טוען — רשימה אחת של עוגנים לשרת, ל-AI ולממשק
const ANCHORS = require('../public/js/feature-anchors.js');

/**
 * המסכים שאליהם ניתן לשייך פריט — רשימה קבועה, כדי שהבאנר יקבץ לפי מסכים
 * אמיתיים ולא לפי ניסוחים חופשיים. ‎route‎ — לאן "נסו עכשיו" מוביל בממשק.
 */
const SCREENS = [
  { key: 'general', label: 'כללי', icon: '✨', route: null },
  { key: 'home', label: 'דף הבית', icon: '🏠', route: 'home' },
  { key: 'today', label: 'Today', icon: '☀️', route: 'today' },
  { key: 'board', label: 'לוח המשימות', icon: '📋', route: 'board' },
  { key: 'task', label: 'כרטיס משימה', icon: '🗂️', route: null },
  { key: 'calendar', label: 'יומן ופגישות', icon: '📅', route: 'calendar' },
  { key: 'ai', label: 'משימות AI', icon: '🤖', route: null },
  { key: 'phonebook', label: 'אלפון', icon: '📇', route: 'phonebook' },
  { key: 'reports', label: 'דוחות', icon: '📊', route: 'reports' },
  { key: 'mobile', label: 'בטלפון', icon: '📱', route: null },
  { key: 'whatsapp', label: 'בוט וואטסאפ', icon: '💬', route: null },
  { key: 'admin', label: 'ניהול המערכת', icon: '⚙️', route: 'admin' }
];
const SCREEN_KEYS = new Set(SCREENS.map((s) => s.key));
const screenOf = (key) => SCREENS.find((s) => s.key === key) ?? SCREENS[0];

const ANCHOR_KEYS = new Set(ANCHORS.map((a) => a.key));
/**
 * עוגן שמור שכבר אינו בקטלוג (שונה שם בקוד) נקרא כ"אין עוגן": הבאנר נופל
 * לצילום או לאייקון במקום לחפש אלמנט שלא קיים.
 */
const validAnchor = (key) => (key && ANCHOR_KEYS.has(key) ? key : null);
/*
 * סרטון ההדמיה — רק קובץ שהגיע עם הקוד, תחת ‎public/whats-new/‎. כתובת
 * אחרת, או קובץ שאינו קיים, נקראים כ"אין סרטון".
 */
const PUBLIC_DIR = Paths.PUBLIC;
const MEDIA = /^\/whats-new\/[\w.-]+\/[\w.-]+\.(mp4|jpg)$/;
const mediaOk = (url) => Boolean(url && MEDIA.test(url) && fs.existsSync(path.join(PUBLIC_DIR, url)));
/** פריט שאפשר לפרסם — יש לו סרטון, או (בגרסאות ישנות) מקום במסך או צילום */
const showable = (i) => Boolean(mediaOk(i.video) || validAnchor(i.anchor) || i.image);

/**
 * קהל היעד של פריט. "מנהלים" — מנהל מחלקה ומעלה; "מנהלי מערכת" — מנהל
 * מערכת ואדמין על. ‎null‎ — כולם.
 */
const AUDIENCES = {
  all: { label: 'כולם', roles: null },
  managers: { label: 'מנהלים', roles: ['manager', 'executive', 'admin', 'superadmin'] },
  admins: { label: 'מנהלי מערכת', roles: ['admin', 'superadmin'] }
};
const audienceAllows = (audience, role) => {
  const roles = (AUDIENCES[audience] ?? AUDIENCES.all).roles;
  return !roles || roles.includes(role);
};

// כמה גרסאות לכל היותר מוצגות למשתמש שחזר אחרי היעדרות ארוכה
const MAX_PENDING = 3;
const SEEN_PREF = 'whatsNewSeenAt';

const parseItems = (raw) => {
  try { return JSON.parse(raw) ?? []; } catch { return []; }
};

/**
 * בעריכה משתנה רק הניסוח: כותרת ותיאור לכל פריט, לפי הסדר. המסך, הקהל,
 * הסרטון והעוגן הגיעו עם הגרסה ונשארים כמו שהם.
 */
function editText(stored, edits) {
  if (!Array.isArray(edits) || edits.length !== stored.length) throw badRequest('רשימת הפריטים אינה תואמת לגרסה');
  return stored.map((item, n) => {
    const title = String(edits[n]?.title ?? item.title).trim().slice(0, 160);
    if (!title) throw badRequest('לכל פריט נדרשת כותרת');
    return { ...item, title, body: String(edits[n]?.body ?? item.body ?? '').trim().slice(0, 2000) };
  });
}

/**
 * גרסה כפי שהיא נשלחת לממשק. ‎role‎ — מסנן את הפריטים לקהל של המשתמש;
 * בלעדיו (מסך הניהול) כל הפריטים חוזרים.
 */
function shape(row, { role = null, withImages = true } = {}) {
  const items = parseItems(row.items)
    .map((i) => ({
      ...i, audience: i.audience ?? 'all', anchor: validAnchor(i.anchor),
      video: mediaOk(i.video) ? i.video : null, poster: mediaOk(i.poster) ? i.poster : null
    }))
    .filter((i) => !role || audienceAllows(i.audience, role))
    .map((i) => ({ ...i, image: withImages ? i.image ?? null : undefined, hasImage: !!i.image }));
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    publishedAt: row.published_at,
    emailedAt: row.emailed_at,
    emailedCount: row.emailed_count,
    emailedTotal: row.emailed_total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items
  };
}

const mayManage = (actor) => actor.type === 'user' && P.can(actor, 'manage_release_notes');

function requireManager(ctx) {
  const actor = ctx.requireActor();
  if (!mayManage(actor)) throw forbidden('רק אדמין על מפרסם הודעות "מה חדש"');
  return actor;
}

function releaseOr404(id) {
  const row = D.get('SELECT * FROM release_notes WHERE id = ?', Number(id));
  if (!row) throw notFound('הגרסה לא נמצאה');
  return row;
}

const userCreatedAt = (userId) => D.get('SELECT created_at FROM users WHERE id = ?', userId)?.created_at ?? '';

/**
 * הגרסאות שפורסמו ועוד לא נסגרו אצל המשתמש — מהחדשה לישנה, כבר מסוננות
 * לקהל שלו. גרסה שאין בה אף פריט בשבילו אינה פותחת באנר.
 *
 * הרצפה היא המאוחר מבין "מה שכבר ראה" ו"מתי נוצר": משתמש חדש מתחיל נקי.
 */
function pendingFor(actor) {
  const seenAt = String(D.userPrefs(actor.id)[SEEN_PREF] ?? '');
  const createdAt = userCreatedAt(actor.id);
  const floor = seenAt > createdAt ? seenAt : createdAt;
  return D.all(
    `SELECT * FROM release_notes WHERE status = 'published' AND published_at > ?
     ORDER BY published_at DESC LIMIT 20`,
    floor
  ).map((r) => shape(r, { role: actor.role })).filter((r) => r.items.length).slice(0, MAX_PENDING);
}

/** כמה גרסאות מחכות — נשלח בטעינה, כדי שהלקוח יידע אם לפתוח את הבאנר */
function pendingCount(actor) {
  if (!actor || actor.type !== 'user') return 0;
  return pendingFor(actor).length;
}

/**
 * פתיחה יזומה (מ"החשבון שלי" או מקישור במייל): הגרסה האחרונה שיש בה משהו
 * בשבילו, גם אם כבר נראתה — אבל לא גרסה שפורסמה לפני שהחשבון נוצר.
 */
function latestFor(actor) {
  return D.all(
    `SELECT * FROM release_notes WHERE status = 'published' AND published_at > ?
     ORDER BY published_at DESC LIMIT 20`,
    userCreatedAt(actor.id)
  ).map((r) => shape(r, { role: actor.role })).find((r) => r.items.length) ?? null;
}

// ---------------------------------------------------------------------------
// המייל
// ---------------------------------------------------------------------------

function baseUrl() {
  const configured = String(D.getSetting('public_url', '') ?? '').trim() || String(process.env.PUBLIC_URL ?? '').trim();
  return configured.replace(/\/+$/, '');
}

/**
 * מי מקבל את המייל של גרסה: משתמשים פעילים (לא הרשמה שממתינה), שהיו קיימים
 * כשהגרסה פורסמה, ושיש בגרסה לפחות פריט אחד בשבילם. אותם כללים כמו הבאנר —
 * מייל שהקישור שבו פותח "אין חידושים" היה רק מבלבל.
 */
function recipientsFor(row) {
  const items = parseItems(row.items);
  return D.all(
    "SELECT id, full_name, email, role, created_at FROM users WHERE status = 'active' AND signup_at IS NULL ORDER BY id"
  ).filter((u) => u.email
    && (!row.published_at || u.created_at < row.published_at)
    && items.some((i) => audienceAllows(i.audience ?? 'all', u.role)));
}

/**
 * המייל מקבץ לפי מסך, כמו הבאנר, ומכיל רק את הפריטים שמיועדים לנמען.
 * צילומי המסך אינם נכללים: לקוחות דואר חוסמים תמונות מוטמעות, ותמונה
 * שמוגשת מהשרת הייתה דורשת לחשוף אותה בלי כניסה — וצילום מסך פנימי עלול
 * להכיל נתונים. הכפתור מוביל לבאנר עצמו.
 */
function buildEmail(release, recipient) {
  const r = shape(release, { role: recipient.role, withImages: false });
  const root = baseUrl();
  const groups = [];
  for (const item of r.items) {
    let g = groups.find((x) => x.screen === item.screen);
    if (!g) groups.push(g = { screen: item.screen, items: [] });
    g.items.push(item);
  }
  const order = SCREENS.map((s) => s.key);
  groups.sort((a, b) => order.indexOf(a.screen) - order.indexOf(b.screen));

  const groupsHtml = groups.map((g) => {
    const s = screenOf(g.screen);
    const rows = g.items.map((i) => `
            <div style="margin:0 0 12px;padding:12px 14px;border:1px solid ${BRAND.border};border-radius:10px;background:#ffffff;">
              <div style="font-weight:700;color:${BRAND.ink};font-size:15px;">${escape(i.title)}</div>
              ${i.body ? `<div style="color:${BRAND.soft};font-size:14px;margin-top:4px;white-space:pre-line;">${escape(i.body)}</div>` : ''}
            </div>`).join('');
    return `
          <div style="margin:22px 0 8px;font-size:13px;font-weight:700;color:${BRAND.teal};letter-spacing:.3px;">${s.icon} ${escape(s.label)}</div>${rows}`;
  }).join('');

  const orgName = D.getSetting('org_name', 'MESIMON');
  const bodyHtml = `
          <div style="font-size:13px;color:${BRAND.teal};font-weight:700;">מה חדש במשימון</div>
          <h1 style="margin:6px 0 10px;font-size:22px;color:${BRAND.ink};">${escape(r.title)}</h1>
          <p style="margin:0 0 6px;">שלום ${escape(recipient.full_name || '')},</p>
          ${r.summary ? `<p style="margin:0;color:${BRAND.soft};white-space:pre-line;">${escape(r.summary)}</p>` : ''}
          ${groupsHtml}
          ${root ? button(`${root}/?whatsnew=1`, 'לצפייה בחידושים') : ''}`;

  const text = [
    `מה חדש במשימון — ${r.title}`,
    r.summary,
    '',
    ...groups.flatMap((g) => [
      `【${screenOf(g.screen).label}】`,
      ...g.items.map((i) => `• ${i.title}${i.body ? ` — ${i.body}` : ''}`),
      ''
    ]),
    root ? `לצפייה בחידושים: ${root}/?whatsnew=1` : ''
  ].join('\n');

  return {
    subject: `✨ מה חדש במשימון: ${r.title}`,
    html: shell({ title: r.title, bodyHtml, footerHtml: `הודעה זו נשלחה למשתמשי ${escape(orgName)} ממנהל המערכת.` }),
    text,
    fromName: `MESIMON · ${orgName}`
  };
}

// משלוח אחד בכל פעם לכל גרסה — לחיצה כפולה לא תשלח לכולם פעמיים
const sending = new Set();

async function sendToAll(release, users) {
  let sent = 0;
  for (const u of users) {
    try {
      await Mailer.send({ to: u.email, toName: u.full_name, ...buildEmail(release, u) });
      sent += 1;
      D.run('UPDATE release_notes SET emailed_count = ? WHERE id = ?', sent, release.id);
    } catch (err) {
      console.error(`[משימון] מייל "מה חדש" ל-${u.email} נכשל:`, err.message);
    }
  }
  return { sent, total: users.length };
}

// ---------------------------------------------------------------------------
// ההודעה הראשונה — "עדכון אוקטובר"
// ---------------------------------------------------------------------------

/**
 * טיוטה ראשונה שנוצרת פעם אחת, מסיכום השינויים של אוקטובר. היא נשארת טיוטה:
 * אדמין העל עובר עליה, מסיר מה שלא פעיל אצלו (Zoom, Gmail, בוט הוואטסאפ),
 * מוסיף צילומי מסך ומפרסם. הדגל בהגדרות מונע ממנה לחזור אחרי שנמחקה.
 */
const FIRST_RELEASE = {
  title: 'עדכון אוקטובר',
  summary: 'הרבה דברים חדשים נכנסו למשימון החודש. הנה החשובים שבהם — לפי המסך שבו תפגשו אותם.',
  items: [
    { screen: 'today', audience: 'all', anchor: 'today.head', title: 'Today — כל היום שלך במסך אחד',
      body: 'היומן, המשימות להיום, מה שבאיחור ומיילים שממתינים לך — יחד, ובבוקר גם במייל. אפשר גם להקליט: ההקלטה הופכת למשימה, ואפשר להפעיל אותה בקול עם המילה "משימון".' },
    { screen: 'calendar', audience: 'all', anchor: 'task.meeting', title: 'קביעת פגישה ישר מתוך משימה',
      body: 'מתוך כרטיס המשימה קובעים פגישה, עם קישור Zoom שנוצר אוטומטית ובדיקת התנגשויות ביומן. מזכירות יכולות לנהל יומן בשביל מנהלים.' },
    { screen: 'home', audience: 'all', anchor: 'home.add-window', title: 'דף הבית שלך, בסידור שלך',
      body: '"סידור הלוח" מאפשר להזיז, להגדיל ולהסתיר חלונות. משימה חדשה נפתחת מהר מהדף, ו-Ctrl+K מחפש בכל המערכת.' },
    { screen: 'board', audience: 'all', anchor: 'board.filters', title: 'לוח המשימות: גרירה, מסננים וציר זמן',
      body: 'גוררים משימות גם במגע וגם במקלדת, המסננים מוצגים כתגיות, ובציר הזמן אפשר לעשות זום. פעולה שנעשתה בטעות — "ביטול" מחזיר אותה.' },
    { screen: 'task', audience: 'all', anchor: 'task.assignees', title: 'בחירת אחראי בעיגולים וצירוף מייל',
      body: 'בוחרים אחראים בלחיצה על העיגולים שלהם, ומצרפים למשימה מייל שלם (קובצי eml ו-msg).' },
    { screen: 'ai', audience: 'all', anchor: 'ai.dialog', title: 'משימות AI: ניסוח, שליחה באישור ומעקב',
      body: 'ה-AI מנסח את הבקשה, שולח רק אחרי שאישרתם, ועוקב עד שהיא מטופלת — עם שליטה בתזכורות. הוא גם סורק את המייל ומציע משימות ב"ממתין לאישורך".' },
    { screen: 'whatsapp', audience: 'all', anchor: 'account.phone', title: 'משימות מוואטסאפ',
      body: 'הבוט יוצר משימות מקבוצות ומשיחה פרטית, מסמן ✅ על הודעה שהפכה למשימה ומתמלל הודעות קוליות.' },
    { screen: 'phonebook', audience: 'all', anchor: 'phonebook.sidebar', title: 'אלפון ארגוני',
      body: 'כל אנשי הקשר של הארגון במקום אחד, עם חיפוש מהיר, טלפון נוסף ופקס. האלפון משולב בכל שדה של איש קשר במערכת.' },
    { screen: 'admin', audience: 'managers', anchor: 'admin.departments', title: 'תתי-מחלקות ו"משימות שנתתי"',
      body: 'מחלקה יכולה להתחלק לצוותים, ובמסך "משימות שנתתי" רואים במקום אחד כל מה שהעברתם לאחרים ואיפה זה עומד.' },
    { screen: 'admin', audience: 'admins', anchor: 'admin.users-tools', title: 'כלים חדשים לניהול המערכת',
      body: 'ייבוא משתמשים עם מספר טלפון, סינון ברשימת המשתמשים, ניהול בוט הוואטסאפ, וחיבור לתפעול 360.' }
  ]
};

function seedFirstRelease() {
  fillFirstReleaseAnchors();
  seedReleaseFiles();
  if (D.getSetting('whats_new_seeded', false)) return;
  const exists = D.get('SELECT 1 AS x FROM release_notes LIMIT 1');
  if (!exists) {
    const now = D.nowIso();
    D.run(
      `INSERT INTO release_notes (title, summary, items, status, created_by, created_at, updated_at)
       VALUES (?,?,?,'draft',NULL,?,?)`,
      FIRST_RELEASE.title, FIRST_RELEASE.summary,
      JSON.stringify(FIRST_RELEASE.items.map((i) => ({ ...i, image: null }))), now, now
    );
  }
  D.setSetting('whats_new_seeded', true);
}

/**
 * טיוטת "עדכון אוקטובר" שנוצרה לפני שהיו עוגנים: משלימים עוגן לפריטים
 * שמעולם לא היה להם שדה כזה, לפי הכותרת המקורית. פריט שהכותרת שלו נערכה,
 * שיש לו צילום, או שהעוגן שלו נמחק במפורש (‎null‎ — אחרי שמירה בעורך) — לא
 * נוגעים בו: זו החלטה של המנהל. רץ פעם אחת, ורק על טיוטה.
 */
function fillFirstReleaseAnchors() {
  if (D.getSetting('whats_new_anchors_seeded', false)) return;
  D.setSetting('whats_new_anchors_seeded', true);
  const row = D.get("SELECT * FROM release_notes WHERE status = 'draft' AND title = ? ORDER BY id LIMIT 1", FIRST_RELEASE.title);
  if (!row) return;
  const byTitle = new Map(FIRST_RELEASE.items.map((i) => [i.title, i.anchor]));
  let changed = 0;
  const items = parseItems(row.items).map((i) => {
    if ('anchor' in i || i.image || !byTitle.has(i.title)) return i;
    changed += 1;
    return { ...i, anchor: byTitle.get(i.title) };
  });
  if (changed) D.run('UPDATE release_notes SET items = ? WHERE id = ?', JSON.stringify(items), row.id);
}

// ---------------------------------------------------------------------------
// גרסאות שמגיעות עם הקוד
// ---------------------------------------------------------------------------

const RELEASES_DIR = Paths.WHATS_NEW;

/**
 * כל קובץ ב-‎server/whats-new/‎ הוא גרסה מוכנה — מלל וסרטון לכל פריט. בעלייה
 * הראשונה של השרת אחרי שהקובץ הגיע הוא נוצר כטיוטה, פעם אחת: רשימת
 * הקבצים שכבר נוצרו נשמרת בהגדרות, ולכן טיוטה שנמחקה אינה חוזרת.
 */
function seedReleaseFiles() {
  let files = [];
  try { files = fs.readdirSync(RELEASES_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  const done = new Set(D.getSetting('whats_new_files', []) ?? []);
  for (const file of files) {
    if (done.has(file)) continue;
    let rel;
    try { rel = JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, file), 'utf8')); } catch (err) {
      console.error(`[משימון] "מה חדש": הקובץ ${file} אינו תקין —`, err.message);
      continue;
    }
    const items = (rel.items ?? []).map((i) => ({
      screen: SCREEN_KEYS.has(i.screen) ? i.screen : 'general',
      audience: AUDIENCES[i.audience] ? i.audience : 'all',
      anchor: validAnchor(i.anchor),
      title: String(i.title ?? '').trim().slice(0, 160),
      body: String(i.body ?? '').trim().slice(0, 2000),
      video: i.video ?? null,
      poster: i.poster ?? null
    })).filter((i) => i.title);
    const now = D.nowIso();
    D.run(
      `INSERT INTO release_notes (title, summary, items, status, created_by, created_at, updated_at)
       VALUES (?,?,?,'draft',NULL,?,?)`,
      String(rel.title ?? file).slice(0, 160), String(rel.summary ?? '').slice(0, 2000), JSON.stringify(items), now, now
    );
    done.add(file);
    D.setSetting('whats_new_files', [...done]);
  }
}

// ---------------------------------------------------------------------------
// נקודות הקצה
// ---------------------------------------------------------------------------

function register(router) {
  // ----- משתמש: הבאנר

  router.get('/api/whats-new', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') return sendJson(res, 200, { releases: [], screens: SCREENS, audiences: AUDIENCES });
    // ‎all‎ — פתיחה יזומה מהתפריט או מהמייל: האחרונה, גם אם כבר נראתה
    const all = new URL(req.url, 'http://x').searchParams.get('all') === '1';
    const releases = all ? [latestFor(actor)].filter(Boolean) : pendingFor(actor);
    sendJson(res, 200, { releases, screens: SCREENS, audiences: AUDIENCES });
  });

  router.post('/api/whats-new/seen', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') return sendJson(res, 200, { ok: true });
    const latest = D.get("SELECT MAX(published_at) AS at FROM release_notes WHERE status = 'published'")?.at;
    if (latest) D.setUserPref(actor.id, SEEN_PREF, latest);
    sendJson(res, 200, { ok: true });
  });

  // ----- אדמין על: עריכה, פרסום ומייל

  router.get('/api/admin/releases', async (req, res, ctx) => {
    requireManager(ctx);
    const rows = D.all('SELECT * FROM release_notes ORDER BY COALESCE(published_at, created_at) DESC, id DESC');
    sendJson(res, 200, {
      releases: rows.map((r) => ({ ...shape(r), recipients: recipientsFor(r).length, sending: sending.has(r.id) })),
      screens: SCREENS,
      audiences: AUDIENCES,
      mailEnabled: Mailer.isEnabled()
    });
  });

  /** תיקון ניסוח — כותרת ותקציר הגרסה, וכותרת ותיאור לכל פריט. שום דבר אחר */
  router.put('/api/admin/releases/:id', async (req, res, ctx) => {
    requireManager(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    const title = String(b.title ?? row.title).trim().slice(0, 160);
    if (!title) throw badRequest('נדרשת כותרת לגרסה');
    const items = b.items !== undefined ? editText(parseItems(row.items), b.items) : parseItems(row.items);
    D.run(
      'UPDATE release_notes SET title = ?, summary = ?, items = ?, updated_at = ? WHERE id = ?',
      title, String(b.summary ?? row.summary).trim().slice(0, 2000), JSON.stringify(items), D.nowIso(), row.id
    );
    sendJson(res, 200, { release: shape(releaseOr404(row.id)) });
  });

  router.delete('/api/admin/releases/:id', async (req, res, ctx) => {
    requireManager(ctx);
    const row = releaseOr404(ctx.params.id);
    if (sending.has(row.id)) throw badRequest('המשלוח של הגרסה הזו עדיין רץ');
    D.run('DELETE FROM release_notes WHERE id = ?', row.id);
    sendJson(res, 200, { ok: true });
  });

  /**
   * פרסום — מכאן הגרסה מוצגת לכולם. ‎publish: false‎ מחזיר לטיוטה (למשל
   * אחרי טעות), ופרסום חוזר מקבל זמן חדש ולכן יוצג שוב גם למי שכבר ראה.
   */
  router.post('/api/admin/releases/:id/publish', async (req, res, ctx) => {
    requireManager(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    if (b.publish === false) {
      D.run("UPDATE release_notes SET status = 'draft', published_at = NULL WHERE id = ?", row.id);
    } else {
      const items = parseItems(row.items);
      if (!items.length) throw badRequest('אין מה לפרסם — הוסיפו לפחות פריט אחד');
      // כל פריט צריך הדמיה — אחרת הבאנר היה מציג רק אייקון
      const bare = items.filter((i) => !showable(i));
      if (bare.length) {
        const names = bare.slice(0, 3).map((i) => `"${i.title}"`).join(', ');
        throw badRequest(`לא ניתן לפרסם: ${bare.length === 1 ? `לפריט ${names} חסר` : `ל-${bare.length} פריטים (${names}${bare.length > 3 ? '…' : ''}) חסר`} סרטון ההדמיה.`);
      }
      D.run("UPDATE release_notes SET status = 'published', published_at = ? WHERE id = ?", D.nowIso(), row.id);
    }
    sendJson(res, 200, { release: shape(releaseOr404(row.id)) });
  });

  /**
   * מייל לכל המשתמשים הפעילים. ‎test: true‎ שולח רק לאדמין עצמו — כל
   * הפריטים, כדי לראות איך זה נראה בתיבה לפני שזה יוצא לכולם.
   *
   * המשלוח לכולם רץ ברקע: עשרות הודעות SMTP ברצף לוקחות יותר זמן ממה
   * שבקשת HTTP אמורה להחזיק. המונה בכרטיס מתעדכן תוך כדי.
   */
  router.post('/api/admin/releases/:id/email', async (req, res, ctx) => {
    const actor = requireManager(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    if (!Mailer.isEnabled()) throw badRequest('שליחת דואר אינה מוגדרת במערכת (SMTP)');
    if (!parseItems(row.items).length) throw badRequest('אין פריטים בגרסה');

    if (b.test) {
      const me = D.get('SELECT full_name, email, role FROM users WHERE id = ?', actor.id);
      if (!me?.email) throw badRequest('לא נמצאה כתובת מייל לחשבון שלך');
      try {
        await Mailer.send({ to: me.email, toName: me.full_name, ...buildEmail(row, me) });
      } catch (err) {
        throw badRequest(`השליחה נכשלה: ${err.message}`);
      }
      return sendJson(res, 200, { ok: true, test: true, to: me.email });
    }

    if (row.status !== 'published') throw badRequest('יש לפרסם את הגרסה לפני שליחה לכולם');
    if (sending.has(row.id)) throw badRequest('המשלוח של הגרסה הזו כבר רץ');

    const users = recipientsFor(row);
    if (!users.length) throw badRequest('אין נמענים לגרסה הזו');
    D.run('UPDATE release_notes SET emailed_at = ?, emailed_count = 0, emailed_total = ? WHERE id = ?',
      D.nowIso(), users.length, row.id);
    sending.add(row.id);
    sendToAll(row, users)
      .then(({ sent, total }) => console.log(`[משימון] מייל "מה חדש" נשלח ל-${sent} מתוך ${total}`))
      .catch((err) => console.error('[משימון] משלוח "מה חדש" נכשל:', err.message))
      .finally(() => sending.delete(row.id));
    sendJson(res, 202, { ok: true, total: users.length });
  });
}

module.exports = { register, pendingCount, seedFirstRelease, buildEmail, SCREENS, AUDIENCES };
