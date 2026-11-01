'use strict';
/**
 * "מה חדש" — באנר הפיצ'רים החדשים ומייל העדכון לכל המשתמשים.
 *
 * מנהל המערכת כותב גרסה: כותרת, תקציר ופריטים, כשכל פריט משויך למסך ויכול
 * לשאת צילום מסך להמחשה. כל עוד היא טיוטה אף אחד אינו רואה אותה. בפרסום היא
 * נפתחת לכל משתמש פעם אחת, באמצע המסך, אחרי הכניסה — וניתן לדלג עליה.
 *
 * מה המשתמש כבר ראה נשמר בהעדפות שלו (‎whatsNewSeenAt‎) כחותמת הזמן של
 * הגרסה האחרונה שנסגרה, ולא כמזהה: טיוטה ישנה שפורסמה מאוחר יותר מקבלת
 * מזהה נמוך, אבל זמן פרסום מאוחר — והיא עדיין צריכה להופיע.
 */
const D = require('./db');
const P = require('./permissions');
const Mailer = require('./mailer');
const { shell, button, escape, BRAND } = require('./mail-templates');
const { badRequest, forbidden, notFound, readJson, sendJson } = require('./http-kit');

/** המסכים שאליהם ניתן לשייך פריט. ‎route‎ — לאן "לנסות עכשיו" מוביל בממשק */
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
  { key: 'admin', label: 'ניהול המערכת', icon: '⚙️', route: 'admin' }
];
const SCREEN_KEYS = new Set(SCREENS.map((s) => s.key));
const screenOf = (key) => SCREENS.find((s) => s.key === key) ?? SCREENS[0];

const MAX_ITEMS = 20;
// צילום מסך דחוס בדפדפן שוקל לרוב 100–300KB; התקרה רק שומרת על המסד
const MAX_IMAGE_CHARS = 2_500_000;
// כמה גרסאות לכל היותר מוצגות במשתמש שחזר אחרי היעדרות ארוכה
const MAX_PENDING = 3;
const SEEN_PREF = 'whatsNewSeenAt';

const parseItems = (raw) => {
  try { return JSON.parse(raw); } catch { return []; }
};

function cleanItems(items) {
  if (!Array.isArray(items)) throw badRequest('רשימת הפריטים אינה תקינה');
  if (items.length > MAX_ITEMS) throw badRequest(`עד ${MAX_ITEMS} פריטים בגרסה אחת`);
  return items.map((i) => {
    const title = String(i?.title ?? '').trim().slice(0, 160);
    if (!title) throw badRequest('לכל פריט נדרשת כותרת');
    let image = i?.image ? String(i.image) : null;
    if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw badRequest('התמונה אינה בפורמט נתמך');
    }
    if (image && image.length > MAX_IMAGE_CHARS) throw badRequest(`התמונה של "${title}" גדולה מדי`);
    return {
      screen: SCREEN_KEYS.has(i?.screen) ? i.screen : 'general',
      title,
      body: String(i?.body ?? '').trim().slice(0, 2000),
      image: image || null
    };
  });
}

function shape(row, { withImages = true } = {}) {
  const items = parseItems(row.items).map((i) => ({
    ...i,
    image: withImages ? i.image ?? null : undefined,
    hasImage: !!i.image
  }));
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    publishedAt: row.published_at,
    emailedAt: row.emailed_at,
    emailedCount: row.emailed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items
  };
}

const isAdmin = (actor) => actor.type === 'user' && P.can(actor, 'manage_automations');

function requireAdmin(ctx) {
  const actor = ctx.requireActor();
  if (!isAdmin(actor)) throw forbidden();
  return actor;
}

function releaseOr404(id) {
  const row = D.get('SELECT * FROM release_notes WHERE id = ?', Number(id));
  if (!row) throw notFound('הגרסה לא נמצאה');
  return row;
}

/** הגרסות שפורסמו ועוד לא נסגרו אצל המשתמש — מהחדשה לישנה */
function pendingFor(userId) {
  const seenAt = D.userPrefs(userId)[SEEN_PREF] ?? '';
  return D.all(
    `SELECT * FROM release_notes WHERE status = 'published' AND published_at > ?
     ORDER BY published_at DESC LIMIT ?`,
    String(seenAt), MAX_PENDING
  );
}

/** כמה גרסאות מחכות — נשלח בטעינה, כדי שהלקוח יידע אם לפתוח את הבאנר */
function pendingCount(actor) {
  if (!actor || actor.type !== 'user') return 0;
  return pendingFor(actor.id).length;
}

// ---------------------------------------------------------------------------
// המייל
// ---------------------------------------------------------------------------

function baseUrl() {
  const configured = String(D.getSetting('public_url', '') ?? '').trim() || String(process.env.PUBLIC_URL ?? '').trim();
  return configured.replace(/\/+$/, '');
}

/**
 * המייל מקבץ לפי מסך, כמו הבאנר. צילומי המסך אינם נכללים: לקוחות דואר
 * חוסמים תמונות מוטמעות, ותמונה שמוגשת מהשרת הייתה דורשת לחשוף אותה בלי
 * כניסה — וצילום מסך פנימי עלול להכיל נתונים. הכפתור מוביל לבאנר עצמו.
 */
function buildEmail(release, recipientName) {
  const r = shape(release, { withImages: false });
  const root = baseUrl();
  const groups = [];
  for (const item of r.items) {
    let g = groups.find((x) => x.screen === item.screen);
    if (!g) groups.push(g = { screen: item.screen, items: [] });
    g.items.push(item);
  }

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
          <p style="margin:0 0 6px;">שלום ${escape(recipientName || '')},</p>
          ${r.summary ? `<p style="margin:0;color:${BRAND.soft};white-space:pre-line;">${escape(r.summary)}</p>` : ''}
          ${groupsHtml}
          ${root ? button(`${root}/?whatsnew=1`, 'לצפייה בחידושים במערכת') : ''}`;

  const text = [
    `מה חדש במשימון — ${r.title}`,
    r.summary,
    '',
    ...groups.flatMap((g) => [
      `【${screenOf(g.screen).label}】`,
      ...g.items.map((i) => `• ${i.title}${i.body ? ` — ${i.body}` : ''}`),
      ''
    ]),
    root ? `${root}/?whatsnew=1` : ''
  ].filter((l) => l !== null && l !== undefined).join('\n');

  return {
    subject: `✨ מה חדש במשימון: ${r.title}`,
    html: shell({ title: r.title, bodyHtml, footerHtml: `הודעה זו נשלחה לכל משתמשי ${escape(orgName)} ממנהל המערכת.` }),
    text,
    fromName: `MESIMON · ${orgName}`
  };
}

// משלוח אחד בכל פעם בתהליך — לחיצה כפולה לא תשלח לכולם פעמיים
const sending = new Set();

async function sendToAll(release) {
  const users = D.all("SELECT id, full_name, email FROM users WHERE status = 'active' AND signup_at IS NULL ORDER BY id");
  let sent = 0;
  for (const u of users) {
    try {
      await Mailer.send({ to: u.email, toName: u.full_name, ...buildEmail(release, u.full_name) });
      sent += 1;
      D.run('UPDATE release_notes SET emailed_count = ? WHERE id = ?', sent, release.id);
    } catch (err) {
      console.error(`[משימון] מייל "מה חדש" ל-${u.email} נכשל:`, err.message);
    }
  }
  return { sent, total: users.length };
}

// ---------------------------------------------------------------------------
// נקודות הקצה
// ---------------------------------------------------------------------------

function register(router) {
  // ----- משתמש: הבאנר

  router.get('/api/whats-new', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') return sendJson(res, 200, { releases: [], screens: SCREENS });
    const all = new URL(req.url, 'http://x').searchParams.get('all') === '1';
    // ‎all‎ — פתיחה יזומה מהתפריט: הגרסה האחרונה גם אם כבר נראתה
    const rows = all
      ? D.all("SELECT * FROM release_notes WHERE status = 'published' ORDER BY published_at DESC LIMIT ?", MAX_PENDING)
      : pendingFor(actor.id);
    sendJson(res, 200, { releases: rows.map((r) => shape(r)), screens: SCREENS });
  });

  router.post('/api/whats-new/seen', async (req, res, ctx) => {
    const actor = ctx.requireActor();
    if (actor.type !== 'user') return sendJson(res, 200, { ok: true });
    const latest = D.get("SELECT MAX(published_at) AS at FROM release_notes WHERE status = 'published'")?.at;
    if (latest) D.setUserPref(actor.id, SEEN_PREF, latest);
    sendJson(res, 200, { ok: true });
  });

  // ----- מנהל המערכת: עריכה, פרסום ומייל

  router.get('/api/admin/releases', async (req, res, ctx) => {
    requireAdmin(ctx);
    const rows = D.all('SELECT * FROM release_notes ORDER BY COALESCE(published_at, created_at) DESC, id DESC');
    sendJson(res, 200, {
      releases: rows.map((r) => shape(r)),
      screens: SCREENS,
      mailEnabled: Mailer.isEnabled(),
      recipients: D.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND signup_at IS NULL")?.n ?? 0
    });
  });

  router.post('/api/admin/releases', async (req, res, ctx) => {
    const actor = requireAdmin(ctx);
    const b = await readJson(req);
    const title = String(b.title ?? '').trim().slice(0, 160);
    if (!title) throw badRequest('נדרשת כותרת לגרסה');
    const items = cleanItems(b.items ?? []);
    const now = D.nowIso();
    const info = D.run(
      `INSERT INTO release_notes (title, summary, items, status, created_by, created_at, updated_at)
       VALUES (?,?,?,'draft',?,?,?)`,
      title, String(b.summary ?? '').trim().slice(0, 2000), JSON.stringify(items), actor.id, now, now
    );
    sendJson(res, 201, { release: shape(releaseOr404(info.lastInsertRowid)) });
  });

  router.put('/api/admin/releases/:id', async (req, res, ctx) => {
    requireAdmin(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    const title = String(b.title ?? row.title).trim().slice(0, 160);
    if (!title) throw badRequest('נדרשת כותרת לגרסה');
    const items = b.items !== undefined ? cleanItems(b.items) : parseItems(row.items);
    D.run(
      'UPDATE release_notes SET title = ?, summary = ?, items = ?, updated_at = ? WHERE id = ?',
      title, String(b.summary ?? row.summary).trim().slice(0, 2000), JSON.stringify(items), D.nowIso(), row.id
    );
    sendJson(res, 200, { release: shape(releaseOr404(row.id)) });
  });

  router.delete('/api/admin/releases/:id', async (req, res, ctx) => {
    requireAdmin(ctx);
    const row = releaseOr404(ctx.params.id);
    D.run('DELETE FROM release_notes WHERE id = ?', row.id);
    sendJson(res, 200, { ok: true });
  });

  /**
   * פרסום — מכאן הגרסה מוצגת לכולם. ‎publish: false‎ מחזיר לטיוטה (למשל
   * אחרי טעות), ופרסום חוזר מקבל זמן חדש ולכן יוצג שוב גם למי שכבר ראה.
   */
  router.post('/api/admin/releases/:id/publish', async (req, res, ctx) => {
    requireAdmin(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    if (b.publish === false) {
      D.run("UPDATE release_notes SET status = 'draft', published_at = NULL WHERE id = ?", row.id);
    } else {
      if (!parseItems(row.items).length) throw badRequest('אין מה לפרסם — הוסיפו לפחות פריט אחד');
      D.run("UPDATE release_notes SET status = 'published', published_at = ? WHERE id = ?", D.nowIso(), row.id);
    }
    sendJson(res, 200, { release: shape(releaseOr404(row.id)) });
  });

  /**
   * מייל לכל המשתמשים הפעילים. ‎test: true‎ שולח רק למנהל עצמו, כדי לראות
   * איך זה נראה בתיבה לפני שזה יוצא לכולם.
   *
   * המשלוח לכולם רץ ברקע: עשרות הודעות SMTP ברצף לוקחות יותר זמן ממה
   * שבקשת HTTP אמורה להחזיק. המונה בשורה מתעדכן תוך כדי.
   */
  router.post('/api/admin/releases/:id/email', async (req, res, ctx) => {
    const actor = requireAdmin(ctx);
    const row = releaseOr404(ctx.params.id);
    const b = await readJson(req);
    if (!Mailer.isEnabled()) throw badRequest('שליחת דואר אינה מוגדרת במערכת (SMTP)');
    if (!parseItems(row.items).length) throw badRequest('אין פריטים בגרסה');

    if (b.test) {
      const me = D.get('SELECT full_name, email FROM users WHERE id = ?', actor.id);
      if (!me?.email) throw badRequest('לא נמצאה כתובת מייל לחשבון שלך');
      try {
        await Mailer.send({ to: me.email, toName: me.full_name, ...buildEmail(row, me.full_name) });
      } catch (err) {
        throw badRequest(`השליחה נכשלה: ${err.message}`);
      }
      return sendJson(res, 200, { ok: true, test: true, to: me.email });
    }

    if (row.status !== 'published') throw badRequest('יש לפרסם את הגרסה לפני שליחה לכולם');
    if (sending.has(row.id)) throw badRequest('המשלוח של הגרסה הזו כבר רץ');

    const total = D.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND signup_at IS NULL")?.n ?? 0;
    D.run('UPDATE release_notes SET emailed_at = ?, emailed_count = 0 WHERE id = ?', D.nowIso(), row.id);
    sending.add(row.id);
    sendToAll(row)
      .then(({ sent, total: t }) => console.log(`[משימון] מייל "מה חדש" נשלח ל-${sent} מתוך ${t}`))
      .catch((err) => console.error('[משימון] משלוח "מה חדש" נכשל:', err.message))
      .finally(() => sending.delete(row.id));
    sendJson(res, 202, { ok: true, total });
  });
}

module.exports = { register, pendingCount, buildEmail, SCREENS };
