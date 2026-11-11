'use strict';
/**
 * 📬 הבוט יוזם פעולות לפי המיילים שהעובד קיבל (הוחלט 09.11.26):
 *
 *   1. 🐣 תזכורת ממייל — "זכרת?" (הוחלט 09.11.26, ישראל): מייל עם דדליין או קריאה לפעולה, שלא
 *      טופל — יום אחרי שהגיע (או בבוקר יום הדדליין, אם הוא קודם), תזכורת אחת בלשון מנומסת:
 *        [לפתוח משימה ✅] [התעלם 🙈]
 *      המקור — ההצעות מסריקת המייל (‎ai_suggestions‎) שעדיין ממתינות. לא נשאלים: מייל שכבר ענית עליו
 *      ב-Gmail, הצעה שהוחלט עליה (משימה / לא), בקשה לפגישה (יש לה תיאום משלה). במקום השאלה
 *      "לפתוח משימה?" שהייתה נשלחת מיד כשהמייל הגיע — כדי שלא יהיו שתי שאלות על אותו מייל.
 *
 *   2. 📄 חשבונית / תעודת משלוח במייל ← קבלת סחורה. סריקת המייל מזהה מסמך כזה
 *      בקובץ המצורף (‎goodsDocFrom‎, שדה בניתוח הקיים — בלי קריאה נוספת ל-AI),
 *      והבוט מציע: "לבצע קבלת סחורה בפריוריטי?". "כן" — הבוט מוריד את הקובץ
 *      מ-Gmail ומתחיל את קבלת הסחורה הרגילה, כאילו העובד שלח אותו בעצמו.
 *      רק למי שמותרת לו קבלת סחורה בבוט. מייל עם דדליין ועם חשבונית —
 *      אחרי "בוצע" על הדדליין, ההצעה לקבלת סחורה באה מיד.
 *
 * לא קוטעים שיחה פתוחה מול הבוט; שאלה אחת בכל פעם, בשעות הפעילות.
 */
const D = require('../core').Db;
const W = require('../core').Workdays;
const Gmail = require('../integrations').Gmail;
const Mime = require('../core').Mime;
const WaUi = require('../whatsapp').WaUi;
const Calendar = require('../meetings').Calendar;
const FormFill = require('./form-fill');
const SentFollowup = require('./sent-followup');
const Ports = require('../core').Ports;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const REMIND_AFTER_MS = DAY;   // יום אחרי שהמייל הגיע
const MIN_WAIT_MS = 3 * HOUR;  // דדליין קרוב — לא פחות מ-3 שעות אחרי שהגיע
const KEEP_DAYS = 7;           // מייל ישן משבוע — כבר לא מזכירים

/*
 * 🌊 בלי הצפה (הוחלט 09.11.26 — "המנכ"ל מקבל 40–50 מיילים ביום, 30 מהם קריאה לפעולה"):
 *   • קצב לפי העובד (‎botPrefs.remindPace‎): רגיל — תזכורת אחת לכל היותר כל 30 דקות, עד 8 ביום;
 *     מעט — כל שעתיים, עד 3; רק בבוקר — אף אחת במהלך היום (רק הרשימה בסיכום הבוקר); כבוי.
 *   • רק בשעות התזכורות (‎remind_hours‎, ברירת מחדל 08:30–17:00; וממילא רק בשעות העבודה — ‎workHours‎ בבוט), ולא באמצע פגישה ביומן.
 *   • קודם החשוב: דדליין קרוב, עדיפות, שולח שעונים לו בדרך כלל, ואז הוותיק.
 * "טופל" (ולא מזכירים): ענית / העברת מ-Gmail, העברת לארכיון או מחקת, או החלטת במשימון. **קריאה
 * אינה טיפול** — מייל שנקרא ולא טופל עדיין מקבל תזכורת.
 */
// 10.11.26 (ישראל: "3 ביום, רק ראשי"): עד 3 תזכורות ביום. 11.11.26 (ישראל: "בוא נעלה את המינון לחמש
// תזכורות ביום"): עד 5 — תזכורות "זכרת?", "עוד אין תשובה" וההודעה המרוכזת יחד (‎mail-push.js‎); "מעט" — אחת.
// הצעת תשובה למייל חדש אינה תזכורת ואינה נספרת כאן (‎mayAlertNow‎)
const PACE = {
  normal: { gapMin: 30, max: 5 },
  light: { gapMin: 120, max: 1 },
  morning: { gapMin: 0, max: 0 },
  off: { gapMin: 0, max: 0 }
};
const paceOf = (userId) => PACE[D.userPrefs(userId)?.botPrefs?.remindPace] ?? PACE.normal;
const GOODS_DAYS = 3;          // חשבונית שלא נשאלה תוך 3 ימים — כבר לא מציעים
const DOC_MIME = /^(application\/pdf|image\/)/i;
const DOC_NAME = /\.(pdf|jpe?g|png|heic|tiff?)$/i;

const BTN = Object.freeze({
  open: 'לפתוח משימה ✅',
  ignore: 'התעלם 🙈',
  receive: 'קבלת סחורה 📦',
  later: 'אחר כך ⏰'
});

const parseJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };
const ddmm = (ymd) => String(ymd ?? '').split('-').reverse().slice(0, 2).join('.');
const oneLine = (x, n) => { const v = String(x ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

// ---------------------------------------------------------------------------
// סריקת המייל: חשבונית / תעודת משלוח בקובץ המצורף
// ---------------------------------------------------------------------------

/** השדה שנוסף לניתוח של סריקת המייל (‎mail-scan.js‎, ‎ANALYSIS_SCHEMA‎) */
const GOODS_SCHEMA = {
  type: 'object',
  description: 'חשבונית ספק או תעודת משלוח — על סחורה או שירות שהארגון הזמין — בקובץ מצורף למייל. לא קבלה על תשלום, לא הצעת מחיר, ולא חשבונית שהארגון עצמו שולח ללקוח',
  properties: {
    kind: { type: 'string', enum: ['none', 'invoice', 'delivery_note'] },
    filename: { type: 'string', description: 'שם הקובץ המצורף, בדיוק כמו ברשימת הקבצים. אין — ריק' },
    supplier: { type: 'string', description: 'שם הספק כפי שמופיע במייל או במסמך. לא ידוע — ריק' }
  },
  required: ['kind', 'filename', 'supplier'],
  additionalProperties: false
};

/**
 * אחרי הניתוח של מייל — חשבונית או תעודת משלוח שמצורפת אליו נרשמת להצעה בבוט.
 * רק כשהקובץ באמת מצורף (שם זהה) והוא PDF או תמונה.
 */
function goodsDocFrom(user, meta, mail, goods) {
  if (!goods || !['invoice', 'delivery_note'].includes(goods.kind)) return false;
  const name = String(goods.filename ?? '').trim();
  const att = (mail.attachments ?? []).find((a) => a.filename === name)
    ?? ((mail.attachments ?? []).filter((a) => DOC_MIME.test(a.mime ?? '') || DOC_NAME.test(a.filename ?? '')).length === 1
      ? mail.attachments.find((a) => DOC_MIME.test(a.mime ?? '') || DOC_NAME.test(a.filename ?? ''))
      : null);
  if (!att || !(DOC_MIME.test(att.mime ?? '') || DOC_NAME.test(att.filename ?? ''))) return false;
  D.run(
    `INSERT OR IGNORE INTO mail_goods_docs (user_id, gmail_id, box, kind, filename, mime, supplier, from_name, from_email, subject, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
    user.id, meta.gmailId, meta.box ?? 0, goods.kind, att.filename, att.mime ?? '', String(goods.supplier ?? '').slice(0, 120),
    meta.fromName ?? '', meta.fromEmail ?? '', String(meta.subject ?? '').slice(0, 300), D.nowIso()
  );
  return true;
}

/** הקובץ עצמו — מ-Gmail, ברגע שהעובד אמר "כן" */
async function goodsFile(row) {
  const msg = await Gmail.raw(Gmail.handle(row.user_id, row.box ?? 0), row.gmail_id);
  const mail = Mime.parse(msg.raw);
  const att = mail.attachments.find((a) => a.filename === row.filename);
  if (!att?.data) throw new Error(`הקובץ "${row.filename}" לא נמצא במייל`);
  return { buf: Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data), mime: att.mime || row.mime, name: row.filename };
}

// ---------------------------------------------------------------------------
// מה לשאול עכשיו
// ---------------------------------------------------------------------------

/** מתי להזכיר: יום אחרי שהגיע; דדליין מוקדם יותר — בבוקר יום הדדליין (ולא לפני 3 שעות מההגעה) */
function remindAt(row) {
  const got = new Date(row.received_at || row.created_at).getTime();
  let at = got + REMIND_AFTER_MS;
  const due = parseJson(row.data, {}).dueDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due ?? '')) at = Math.min(at, Math.max(got + MIN_WAIT_MS, W.ilWallToUtc(due, 8, 30).getTime()));
  return at;
}

/**
 * טופל ב-Gmail? ‎'answered'‎ — הודעה שלך בשרשור אחרי שהגיע (תשובה / העברה); ‎'archived'‎ — המייל כבר
 * לא בתיבת הדואר הנכנס (ארכיון / נמחק); ‎null‎ — לא טופל. קריאה בלבד — לא טיפול.
 */
async function handledInGmail(row) {
  try {
    const box = D.get('SELECT box FROM mail_scanned WHERE user_id = ? AND gmail_id = ?', row.user_id, row.gmail_id)?.box ?? 0;
    const got = new Date(row.received_at || row.created_at).getTime();
    const thread = await Gmail.threadOf(Gmail.handle(row.user_id, box), row.gmail_id);
    if (thread.some((m) => m.id !== row.gmail_id && m.labels.includes('SENT') && m.at && m.at.getTime() > got - 60000)) return 'answered';
    const src = thread.find((m) => m.id === row.gmail_id);
    if (src && (!src.labels.includes('INBOX') || src.labels.includes('TRASH'))) return 'archived';
    return null;
  } catch (err) {
    return / 404/.test(err.message) ? 'archived' : null;
  }
}

/** כמה תזכורות נשלחו היום, ומתי האחרונה — לקצב */
function paceState(userId) {
  const today = W.todayIL();
  const r = D.get('SELECT * FROM reminder_pace WHERE user_id = ?', userId);
  return r && r.day === today ? { count: r.count, lastAt: r.last_at } : { count: 0, lastAt: null };
}
function paceTick(userId) {
  const today = W.todayIL();
  const cur = paceState(userId);
  D.run(`INSERT INTO reminder_pace (user_id, day, count, last_at) VALUES (?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, count = excluded.count, last_at = excluded.last_at`,
  userId, today, cur.count + 1, D.nowIso());
}

/*
 * "לא על חשבון שום דבר אחר" (הוחלט 10.11.26): התזכורות הן בעדיפות האחרונה. הבוט רושם כל הודעה יזומה
 * אחרת (תדריך, "איך היה?", חשבונית, טופס, סיכום, התראה לפני פגישה) וכל הודעה של העובד — ותזכורת מחכה:
 *   • חצי שעה (לפי הקצב) אחרי כל הודעה יזומה — לא רק אחרי תזכורת קודמת;
 *   • 5 דקות אחרי שהעובד כתב לבוט — לא נכנסים באמצע שיחה;
 *   • לא בפגישה, וגם לא ב-15 הדקות שלפני פגישה (שם מגיעים התדריך וההתראה).
 */
const lastAny = new Map();   // ‎userId‎ → מתי נשלחה אליו הודעה יזומה כלשהי
const lastUser = new Map();  // ‎userId‎ → מתי כתב לבוט
const noteProactive = (userId) => lastAny.set(Number(userId), Date.now());
const noteUser = (userId) => lastUser.set(Number(userId), Date.now());
const USER_QUIET_MS = 5 * 60 * 1000;
const BEFORE_MEETING_MS = 15 * 60 * 1000;

/*
 * 📧 הצעת תשובה למייל חדש (הוחלט 11.11.26, ישראל: "על כל מייל ... שיש לך הצעה קונקרטית לתשובה — תביא את זה")
 * אינה תזכורת: לא נספרת בתקרה היומית. כן שומרים על השקט — שעות התזכורות, לא באמצע שיחה ולא בפגישה,
 * ‎ALERT_GAP_MIN‎ דקות אחרי הודעה יזומה אחרת, ולא למי שבחר "רק בבוקר" / כיבה / השתיק להיום.
 */
const ALERT_GAP_MIN = 10;

/** אפשר לשלוח עכשיו הצעת תשובה למייל חדש? */
async function mayAlertNow(userId) {
  if (!paceOf(userId).max) return false;
  return quietOk(userId, ALERT_GAP_MIN);
}

/** אפשר לשלוח עכשיו תזכורת לעובד הזה? (השתקה, שעות, קצב, תקרה, הודעות אחרות, פגישה ביומן) */
async function mayRemindNow(userId) {
  const pace = paceOf(userId);
  if (!pace.max) return false;
  const st = paceState(userId);
  if (st.count >= pace.max) return false;
  if (st.lastAt && Date.now() - new Date(st.lastAt).getTime() < pace.gapMin * 60000) return false;
  return quietOk(userId, pace.gapMin);
}

/** השתקה, שעות, שיחה פעילה, הודעה יזומה אחרונה ופגישה ביומן — משותף לתזכורות ולהצעות תשובה */
async function quietOk(userId, gapMin) {
  if (Date.now() - (lastUser.get(Number(userId)) ?? 0) < USER_QUIET_MS) return false;
  if (Date.now() - (lastAny.get(Number(userId)) ?? 0) < gapMin * 60000) return false;
  const mute = D.userPrefs(userId)?.botPrefs?.remindMuteUntil;
  if (mute && W.todayIL() < mute) return false;
  const now = new Date();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(String(D.getSetting('remind_hours', '08:30-17:00') ?? ''));
  if (m && !(hm >= m[1] && hm < m[2])) return false;
  // באמצע פגישה ביומן — מחכים שתסתיים
  try {
    if (Calendar.isConnected(userId)) {
      const day = await Calendar.eventsForDay(userId);
      // בפגישה, או שהיא מתחילה בעוד פחות מ-15 דקות
      // רק פגישות של העובד עצמו — לא "במשרד" / "יום ארוך" ולא יומנים של אחרים שהוא עוקב אחריהם
      const me = D.get('SELECT email FROM users WHERE id = ?', userId)?.email ?? '';
      if ((day.events ?? []).some((e) => Calendar.isRealMeeting(e, me) && Calendar.isOwnEvent(e, me) && new Date(e.start).getTime() - BEFORE_MEETING_MS <= now.getTime() && new Date(e.end) > now)) return false;
    }
  } catch { /* בלי יומן */ }
  return true;
}

/** כמה חשוב: דדליין קרוב, עדיפות, שולח שעונים לו, ותק */
function scoreOf(row) {
  const d = parseJson(row.data, {});
  const today = W.todayIL();
  let s = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate ?? '')) s += d.dueDate <= today ? 6 : d.dueDate <= W.addDays(today, 1) ? 4 : d.dueDate <= W.addDays(today, 3) ? 2 : 0;
  s += { urgent: 4, high: 2 }[d.priority] ?? 0;
  const p = D.get('SELECT mails_out FROM mail_people WHERE user_id = ? AND email = ?', row.user_id, String(row.from_email ?? '').toLowerCase());
  if ((p?.mails_out ?? 0) >= 3) s += 2;
  s += Math.min(3, Math.floor((Date.now() - new Date(row.received_at || row.created_at).getTime()) / DAY));
  return s;
}

// ---------------------------------------------------------------------------
// 🔕 השתקה והפעלה מהבוט (הוחלט 09.11.26): פתוח לכולם, וכל אחד מכבה / מחזיר / משנה קצב במילים שלו
// ---------------------------------------------------------------------------

/*
 * צריך גם "תזכורת/להזכיר" וגם "מייל" — כדי ש"תזכיר לי מחר להתקשר לאבי" (‎reminders.js‎) לא ייתפס כאן.
 *   🔕 כיבוי:   "תפסיק להזכיר לי מהמייל", "בלי תזכורות מהמייל", "די עם התזכורות מהמיילים", "השתק תזכורות מייל"
 *   🔕 להיום:   כיבוי + "היום" / "להיום" — חוזר לבד מחר
 *   🔔 הפעלה:   "תחזיר את התזכורות מהמייל", "תזכיר לי מהמייל", "תפעיל תזכורות מהמייל"
 *   🌊 קצב:     "תזכורות מהמייל רק בבוקר", "פחות תזכורות מהמייל", "תזכורות מהמייל כרגיל"
 */
const ABOUT = /(תזכורות|תזכורת|להזכיר|תזכיר|תזכירי|התזכורות)/;
const MAIL = /מייל|מיילים|דואר/;
// מילים שלמות בלבד — "די" לא בתוך "לדני"
const word = (list) => new RegExp(`(^|\\s)(?:${list})(?=\\s|$|[.,!?])`);
const OFF = word('תפסיק|הפסק|תפסיקי|די|בלי|עצור|תעצור|השתק|תשתיק|כבה|תכבה|לא\\s+צריך|אל\\s+תזכיר|אל\\s+תזכירי');
const ON = new RegExp(`${word('תחזיר|החזר|תחזירי|תפעיל|הפעל|תפתח|פתח|תמשיך|המשך|כן\\s+להזכיר').source}|^תזכיר(\\s+לי)?\\s+מה?מייל[.!]?$`);
const PACE_WORDS = [[/רק\s+(?:ב)?בוקר|בסיכום\s+הבוקר/, 'morning'], [/פחות|מעט|לא\s+הרבה/, 'light'], [/כרגיל|רגיל|כמו\s+קודם|יותר/, 'normal']];
const PACE_LABEL = { normal: 'רגיל — רק החשובים, עד 5 ביום', light: 'מעט — רק החשוב ביותר, אחת ביום', morning: 'רק ברשימה של סיכום הבוקר', off: 'כבויות' };

/** פקודת השתקה / הפעלה / קצב. ‎null‎ — לא פקודה כזו */
function paceCommand(userId, text) {
  const t = String(text ?? '').trim();
  if (t.length > 80 || !ABOUT.test(t) || !MAIL.test(t)) return null;
  const prefs = D.userPrefs(userId)?.botPrefs ?? {};
  const save = (patch) => D.setUserPref(userId, 'botPrefs', { ...prefs, ...patch });
  const pace = PACE_WORDS.find(([re]) => re.test(t))?.[1];
  if (OFF.test(t) && !pace) {
    if (/(^|\s)ל?היום(\s|$|[.!])/.test(t)) {
      const until = W.addDays(W.todayIL(), 1);
      save({ remindMuteUntil: until });
      return { text: '🔕 בסדר, היום בלי תזכורות מהמייל. מחר הן חוזרות לבד 🌼', result: 'השתקה להיום' };
    }
    save({ remindPace: 'off', remindMuteUntil: null, remindPaceSetAt: D.nowIso() });
    return { text: '🔕 הפסקתי את התזכורות מהמייל.\nלהחזיר — "תחזיר את התזכורות מהמייל". רק בבוקר — "תזכורות מהמייל רק בבוקר".', result: 'תזכורות מהמייל — כבוי' };
  }
  if (pace) {
    save({ remindPace: pace, remindMuteUntil: null, remindPaceSetAt: D.nowIso() });
    return { text: `🌊 התזכורות מהמייל: *${PACE_LABEL[pace]}*.`, result: `קצב: ${pace}` };
  }
  if (ON.test(t)) {
    const was = prefs.remindPace;
    save({ remindPace: was && was !== 'off' ? was : 'normal', remindMuteUntil: null, mailDeadline: true, remindPaceSetAt: D.nowIso() });
    return { text: `🔔 התזכורות מהמייל חזרו (${PACE_LABEL[was && was !== 'off' ? was : 'normal']}).\nלהפסיק — "תפסיק להזכיר לי מהמייל".`, result: 'תזכורות מהמייל — פועל' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 🌊 קצב מותאם (הוחלט 10.11.26, ישראל: "תבנה את ההצעה האוטומטית לעובדים עמוסים")
// ---------------------------------------------------------------------------

/*
 * עובד עמוס לא עונה לתזכורות — והן ממשיכות להגיע. הבוט שם לב ומציע פעם אחת להוריד קצב:
 *   • ב-3 ימי העבודה האחרונים נשאלו לפחות ‎OFFER_MIN_ASKED‎ תזכורות "זכרת?", ו-70% ומעלה מהן לא נענו
 *     (לא "לפתוח משימה" ולא טיפול ב-Gmail) או נענו ב"התעלם".
 *   • רק בקצב "רגיל"; לא למי שבחר קצב בעצמו בשבועיים האחרונים; הצעה אחת לכל ‎OFFER_EVERY_DAYS‎ ימים.
 *   • במקום התזכורת הבאה (לא הודעה נוספת): [רק בבוקר ☀️] [פחות 🌊] [להשאיר 👍]. "להשאיר" — לא מציעים שוב חודש.
 */
const OFFER_MIN_ASKED = 4;
const OFFER_RATIO = 0.7;
const OFFER_EVERY_DAYS = 14;
const PACE_BTN = Object.freeze({ morning: 'רק בבוקר ☀️', light: 'פחות 🌊', keep: 'להשאיר 👍' });

/** כמה תזכורות נשאלו בימים האחרונים, וכמה מהן לא קיבלו מענה של ממש */
async function engagement(userId, days = 3) {
  const since = W.ilWallToUtc(W.addDays(W.todayIL(), -days), 0, 0).toISOString();
  const rows = D.all(
    `SELECT id, user_id, gmail_id, received_at, created_at, data FROM ai_suggestions
      WHERE user_id = ? AND json_extract(data, '$.remind.askedAt') >= ?`, userId, since
  ).map((x) => ({ row: x, r: parseJson(x.data, {}).remind ?? {} }));
  // נשאלה בשעתיים האחרונות — עוד מוקדם לדעת
  const asked = rows.filter(({ r }) => Date.now() - Date.parse(r.askedAt) > 2 * HOUR);
  let engaged = 0;
  for (const { row, r } of asked) {
    if (['task', 'answered', 'archived'].includes(r.closed)) { engaged++; continue; }
    if (r.closed) continue;
    // טיפל ב-Gmail אחרי התזכורת (ענה / ארכב) — זה מענה, לא התעלמות
    const handled = await handledInGmail(row);
    if (handled) { setRemind(row.id, { closed: handled, at: D.nowIso() }); engaged++; }
  }
  return { asked: asked.length, engaged, cold: asked.length - engaged };
}

/** להציע עכשיו להוריד קצב? ‎null‎ — לא */
async function paceOffer(userId) {
  const p = D.userPrefs(userId)?.botPrefs ?? {};
  if ((p.remindPace ?? 'normal') !== 'normal') return null;
  const recent = (iso, d) => iso && Date.now() - Date.parse(iso) < d * DAY;
  if (recent(p.remindPaceSetAt, 14) || recent(p.paceOfferAt, p.paceOfferKept ? 30 : OFFER_EVERY_DAYS)) return null;
  const e = await engagement(userId);
  if (e.asked < OFFER_MIN_ASKED || e.cold / e.asked < OFFER_RATIO) return null;
  D.setUserPref(userId, 'botPrefs', { ...p, paceOfferAt: D.nowIso(), paceOfferKept: false });
  const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  return {
    text: [
      `${firstName(u?.full_name) ? `${firstName(u.full_name)}, ` : ''}נראה שאת/ה בעומס 🙂`,
      `מ-${e.asked} התזכורות מהמייל בימים האחרונים, ${e.cold} נשארו בלי טיפול. אולי פחות מדי מועיל, ויותר מדי רעש?`,
      '',
      '*להוריד קצב?*',
      `• *${PACE_BTN.morning}* — רק רשימה אחת בסיכום הבוקר`,
      `• *${PACE_BTN.light}* — רק החשוב ביותר, אחת ביום`
    ].join('\n'),
    buttons: [PACE_BTN.morning, PACE_BTN.light, PACE_BTN.keep],
    draft: { kind: 'pace_offer' },
    action: 'mail_deadline',
    log: `🌊 הצעה להוריד קצב: ${e.cold}/${e.asked} תזכורות בלי מענה`
  };
}

/** תשובה להצעה. ‎null‎ — לא שייך */
function answerPaceOffer(userId, text) {
  const t = String(text ?? '').trim();
  const n = WaUi.normalize(t);
  const p = D.userPrefs(userId)?.botPrefs ?? {};
  const set = (pace) => D.setUserPref(userId, 'botPrefs', { ...p, remindPace: pace, remindMuteUntil: null, remindPaceSetAt: D.nowIso() });
  if (WaUi.sameLabel(t, PACE_BTN.morning) || /^(רק\s+(?:ב)?בוקר|בבוקר|בוקר)([\s,.!]|$)/.test(n)) {
    set('morning');
    return { text: '☀️ סגור — מעכשיו המיילים רק ברשימה של סיכום הבוקר, ובמהלך היום שקט.\nלחזור: "תזכורות מהמייל כרגיל".', result: 'קצב: רק בבוקר' };
  }
  if (WaUi.sameLabel(t, PACE_BTN.light) || /^(פחות|מעט|כן)([\s,.!]|$)/.test(n)) {
    set('light');
    return { text: '🌊 סגור — רק המייל החשוב ביותר, אחד ביום.\nלחזור: "תזכורות מהמייל כרגיל".', result: 'קצב: מעט' };
  }
  if (WaUi.sameLabel(t, PACE_BTN.keep) || /^(להשאיר|תשאיר|לא|כרגיל|זה\s+בסדר)([\s,.!]|$)/.test(n)) {
    D.setUserPref(userId, 'botPrefs', { ...p, paceOfferKept: true });
    return { text: '👍 בסדר, ממשיכים כרגיל.', result: 'קצב: נשאר רגיל' };
  }
  return null;
}

/** התזכורות שהגיע זמנן — מיילים שלא טופלו (גם כאלה שנקראו), החשוב קודם */
async function dueReminders(userId, { limit = 20, pushOnly = true } = {}) {
  const MailPush = Ports.get('mailPush'); // שקע: mail-push משתמש בתזכורות של המודול הזה
  let since = D.getSetting('mail_remind_since', '');
  if (!since) { since = D.nowIso(); D.setSetting('mail_remind_since', since); }
  const rows = D.all(
    `SELECT * FROM ai_suggestions
      WHERE user_id = ? AND kind = 'task' AND status IN ('pending', 'read') AND gmail_id <> ''
        AND header_id NOT LIKE 'doc:%' AND json_extract(data, '$.expiry') IS NULL
        AND COALESCE(json_extract(data, '$.source'), 'email') = 'email'
        AND COALESCE(json_extract(data, '$.meeting'), 0) = 0
        AND json_extract(data, '$.remind') IS NULL
        AND created_at >= ? AND COALESCE(received_at, created_at) >= ?
      ORDER BY received_at, id LIMIT 80`,
    userId, since, new Date(Date.now() - KEEP_DAYS * DAY).toISOString()
  );
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.gmail_id) || remindAt(row) > Date.now()) continue;
    // רק ראשי, לא אוטומטי, לא משולח מושתק, ומעל סף החשיבות — השאר ב"היום" (‎mail-push.js‎)
    if (pushOnly && !MailPush.pushable(row)) continue;
    seen.add(row.gmail_id);
    out.push({ row, score: scoreOf(row) });
  }
  out.sort((a, b) => b.score - a.score || String(a.row.received_at).localeCompare(String(b.row.received_at)));
  const result = [];
  for (const { row } of out) {
    if (result.length >= limit) break;
    const handled = await handledInGmail(row);
    if (handled) { setRemind(row.id, { closed: handled, at: D.nowIso() }); continue; }
    result.push(row);
  }
  return result;
}

/** התזכורת הבאה לשלוח עכשיו — רק כשהקצב מרשה */
async function nextReminder(userId) {
  if (!(await mayRemindNow(userId))) return null;
  return (await dueReminders(userId, { limit: 1 }))[0] ?? null;
}

function nextGoods(userId) {
  const today = W.todayIL();
  return D.get(
    `SELECT * FROM mail_goods_docs WHERE user_id = ? AND (status = 'pending' OR (status = 'later' AND COALESCE(snooze_until, '') <= ?))
       AND created_at >= ? ORDER BY created_at, id LIMIT 1`,
    userId, today, new Date(Date.now() - GOODS_DAYS * DAY).toISOString()
  ) ?? null;
}

function setRemind(id, patch) {
  const row = D.get('SELECT data FROM ai_suggestions WHERE id = ?', id);
  if (!row) return;
  const d = parseJson(row.data, {});
  d.remind = { ...(d.remind ?? {}), ...patch };
  D.run('UPDATE ai_suggestions SET data = ? WHERE id = ?', JSON.stringify(d), id);
}

const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const whenGot = (iso) => {
  const day = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x);
  const got = new Date(iso);
  if (day(got) === day(new Date())) return 'היום';
  if (day(got) === day(new Date(Date.now() - DAY))) return 'אתמול';
  return `ב-${ddmm(day(got))}`;
};

function reminderQuestion(row, userName = '') {
  const d = parseJson(row.data, {});
  const due = /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate ?? '') ? d.dueDate : '';
  return {
    text: [
      `שלום${firstName(userName) ? ` ${firstName(userName)}` : ''} 🌼`,
      `תזכורת קטנה ועדינה: ${whenGot(row.received_at || row.created_at)} הגיע אליך מייל מ*${row.from_name || row.from_email}*`,
      `*${oneLine(d.title, 120)}*${due ? `\n⏳ עד ${ddmm(due)}${due === W.todayIL() ? ' (היום)' : ''}` : ''}`,
      '',
      'זכרת? 🐣',
      '_להשתיק: "תפסיק להזכיר לי מהמייל" · להיום: "בלי תזכורות מהמייל היום"_'
    ].join('\n'),
    buttons: [BTN.open, BTN.ignore],
    draft: { kind: 'mail_remind', suggestionId: row.id, title: d.title, gmailId: row.gmail_id }
  };
}

function goodsQuestion(row, { after = false } = {}) {
  const what = row.kind === 'delivery_note' ? 'תעודת משלוח' : 'חשבונית';
  const from = row.supplier || row.from_name || row.from_email;
  return {
    text: [
      after ? `📄 במייל הזה יש גם ${what}.` : `📄 הגיעה ${what} מ*${from}*`,
      `📎 ${row.filename}${row.subject && !after ? ` · ${oneLine(row.subject, 80)}` : ''}`,
      '',
      '*לבצע עכשיו קבלת סחורה בפריוריטי?* אוריד את הקובץ מהמייל ונתחיל.'
    ].join('\n'),
    buttons: [BTN.receive, BTN.later, WaUi.BTN.no],
    draft: { kind: 'goods_offer', goodsId: row.id, filename: row.filename }
  };
}

/**
 * השאלה הבאה לעובד — תזכורת ממייל קודם, אחר כך טופס, ואז חשבונית.
 * @param {{deadline: boolean, followup: boolean, goods: boolean, form: boolean}} allow
 */
async function nextQuestion(userId, allow) {
  // קודם שאלות על פעולה (טופס, חשבונית) — התזכורות בעדיפות האחרונה, "לא על חשבון שום דבר אחר"
  if (allow.form) {
    const row = FormFill.nextForm(userId);
    if (row) return FormFill.question(row);
  }
  if (allow.goods) {
    const row = nextGoods(userId);
    if (row) { D.run("UPDATE mail_goods_docs SET status = 'asked', asked_at = ? WHERE id = ?", D.nowIso(), row.id); return { ...goodsQuestion(row), action: 'goods_offer', log: `📄 ${row.supplier || row.from_name}: ${row.filename}` }; }
  }
  // תזכורות (מייל שלא טופל, שאלה ששלחת ולא נענתה) — בקצב אחד משותף, בלי הצפה
  const paced = (allow.deadline || allow.followup) && await mayRemindNow(userId);
  if (paced && allow.deadline) {
    const row = (await dueReminders(userId, { limit: 1 }))[0];
    // 🌊 עובד שלא עונה לתזכורות — במקום התזכורת הבאה, הצעה להוריד קצב (פעם אחת)
    const offer = row ? await paceOffer(userId) : null;
    if (offer) { paceTick(userId); return offer; }
    if (row) {
      setRemind(row.id, { askedAt: D.nowIso() });
      paceTick(userId);
      const u = D.get('SELECT full_name FROM users WHERE id = ?', userId);
      return { ...reminderQuestion(row, u?.full_name), action: 'mail_deadline', log: `🐣 זכרת? ${parseJson(row.data, {}).title}` };
    }
  }
  if (paced && allow.followup) {
    const q = await SentFollowup.next(userId);
    if (q) { paceTick(userId); return q; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// התשובות
// ---------------------------------------------------------------------------

const is = (t, btn, re) => WaUi.sameLabel(t, btn) || re.test(WaUi.normalize(t));
const OPEN = /^(לפתוח(\s+משימה)?|תפתח(\s+משימה)?|פתח|כן|משימה|👍)([\s,.!?]|$)/;
const IGNORE = /^(התעלם|תתעלם|לא\s+צריך|לא|עזוב|👎|🙈)([\s,.!]|$)/;
const TOMORROW = /^(תזכיר(\s+לי)?\s+מחר|מחר|אחר\s+כך|אח"כ|לא\s+עכשיו|תזכיר)([\s,.!]|$)/;
const RECEIVE = /^(קבלת\s+סחורה|כן|לבצע|יאללה|קדימה|👍)([\s,.!]|$)/;

/**
 * תשובה ל"זכרת?". ‎openTask: true‎ — לפתוח משימה מההצעה (‎confirmPending‎ בבוט). ‎null‎ — נושא חדש.
 */
function answerReminder(userId, draft, text, { closeAlerted } = {}) {
  const t = String(text ?? '').trim();
  if (is(t, BTN.open, OPEN)) {
    setRemind(draft.suggestionId, { closed: 'task', at: D.nowIso() });
    return { openTask: true, result: `לפתוח משימה: ${draft.title}` };
  }
  if (is(t, BTN.ignore, IGNORE)) {
    setRemind(draft.suggestionId, { closed: 'ignored', at: D.nowIso() });
    closeAlerted?.(userId, [draft.suggestionId], 'skipped');
    return { text: 'בסדר גמור, לא אזכיר על זה שוב 🙂', result: `התעלם: ${draft.title}` };
  }
  return null;
}

/**
 * תשובה להצעת קבלת סחורה. ‎start: true‎ — להוריד את הקובץ ולהתחיל.
 * @returns {{text?: string, start?: boolean, result: string}|null}
 */
function answerGoods(draft, text) {
  const t = String(text ?? '').trim();
  if (is(t, BTN.receive, RECEIVE) || WaUi.YES.test(WaUi.normalize(t))) {
    D.run("UPDATE mail_goods_docs SET status = 'started', decided_at = ? WHERE id = ?", D.nowIso(), draft.goodsId);
    return { start: true, text: '', react: '🧐', result: `קבלת סחורה מהמייל: ${draft.filename}` };
  }
  if (is(t, BTN.later, TOMORROW)) {
    const next = W.addDays(W.todayIL(), 1);
    D.run("UPDATE mail_goods_docs SET status = 'later', snooze_until = ? WHERE id = ?", next, draft.goodsId);
    return { text: `⏰ בסדר, אשאל שוב מחר (${ddmm(next)}). אפשר גם לשלוח לי את הקובץ מתי שנוח.`, result: `אחר כך: ${draft.filename}` };
  }
  if (WaUi.NO.test(WaUi.normalize(t)) || WaUi.CANCEL.test(WaUi.normalize(t))) {
    D.run("UPDATE mail_goods_docs SET status = 'declined', decided_at = ? WHERE id = ?", D.nowIso(), draft.goodsId);
    return { text: 'בסדר, לא נקלט 👍', result: `לא: ${draft.filename}` };
  }
  return null;
}

/** ניקוי — רשומות חשבוניות בנות יותר מחודש */
function prune() {
  D.run('DELETE FROM mail_goods_docs WHERE created_at < ?', new Date(Date.now() - 30 * DAY).toISOString());
}

module.exports = {
  GOODS_SCHEMA, BTN, PACE_BTN, answerPaceOffer, goodsDocFrom, goodsFile, nextQuestion, answerReminder, answerGoods, prune, dueReminders, mayRemindNow, mayAlertNow, paceTick, PACE, paceCommand, noteProactive, noteUser,
  _internal: { engagement, paceOffer, nextReminder, nextGoods, reminderQuestion, goodsQuestion, setRemind, remindAt, scoreOf, handledInGmail, paceState }
};
