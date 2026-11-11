'use strict';
/**
 * ⚙️ הגדרות משימון פריוריטי — מקור אמת אחד לבוט ולמסך (‎/priority‎).
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md". מה שהיה מפוזר בין משתני סביבה, ‎wa_actions‎ וקבועים בקוד:
 *   • חיבור — שרת, קובץ הסביבה, משתמש API וסיסמה (מוצפנת, ‎core/secrets.js‎; לא נשלחת חזרה לדפדפן).
 *   • חברות — הרשימה (קוד, שם, ח.פ., עותק בדיקה), ולכל חברה: כתיבה, התראות הזמנות רכש, התראה לחותם הבא.
 *   • ברירות מחדל לקליטה — תנאי תשלום, מחסן, פריט כללי, תת פרק ומשאב, סוג דרישה, סטטוסים סופיים של הזמנה.
 *
 * **לכל ארגון בנפרד** (הוחלט 11.11.26): נשמר בהגדרה ‎priority_settings:<orgId>‎. היום יש ארגון אחד (1);
 * כשיהיו כמה — ארגון חדש מחבר פריוריטי משלו ולא רואה את האחר.
 *
 * **מעבר בלי הפתעות:** כל עוד לא נשמר כלום במסך, הערכים נגזרים ממה שהיה עד היום (משתני הסביבה,
 * ‎pd_notify_companies‎, הקבועים). השמירה הראשונה במסך מקבעת אותם.
 *
 * **בדיקות:** בריצת בדיקות (‎MESIMON_TEST=1‎) אף חברה אינה פתוחה לכתיבה, מה שלא יישמר — כך גם שרת
 * הבדיקה המלא לא יכול לכתוב לחברה אמיתית.
 */
const D = require('../core').Db;
const Secrets = require('../core').Secrets;
const Priority = require('../integrations').Priority;

const DEFAULT_ORG = 1;
const key = (org) => `priority_settings:${org}`;
const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const testLock = () => process.env.MESIMON_TEST === '1';

/** רשימת החברות המקורית (מהקוד) — לזריעה ראשונה. עותק, כי ‎Priority.COMPANIES‎ מתעדכן במקום */
const SEED_COMPANIES = Priority.COMPANIES.map((c) => ({ ...c }));

const DEFAULTS = Object.freeze({
  payCode: Priority.DEFAULT_PAY,
  warehouse: 'Main',
  generalPart: '000',
  chapter: Priority.GENERAL.chapter,
  topic: Priority.GENERAL.topic,
  pdType: '02',
  poFinalStatuses: ['אושרה', 'נשלחה לספק'],
  noVatCode: Priority.NO_VAT_CODE,
  draftTtlHours: 24
});

/** מה שהיה נכון עד היום — ממשתני הסביבה ומההגדרות הישנות */
function seed() {
  const envWrite = csv(process.env.PRIORITY_COMPANIES || 'test11');
  const envPo = csv(process.env.PO_NOTIFY_COMPANIES);
  const pd = D.getSetting('pd_notify_companies', null);
  const pdList = Array.isArray(pd) && pd.length ? pd : null;
  return {
    connection: { host: Priority.DEFAULT_HOST, ini: Priority.DEFAULT_INI, user: '', password: '' },
    companies: SEED_COMPANIES.map((c) => ({
      code: c.code, name: c.name, vat: c.vat ?? '', sandbox: c.sandbox ?? '', test: Boolean(c.test),
      write: envWrite.includes(c.code),
      poNotify: envPo.length ? envPo.includes(c.code) : true,
      pdNotify: pdList ? pdList.includes(c.code) : (!c.test || envWrite.includes(c.code))
    })),
    defaults: { ...DEFAULTS, poFinalStatuses: csv(process.env.PO_FINAL_STATUSES).length ? csv(process.env.PO_FINAL_STATUSES) : [...DEFAULTS.poFinalStatuses] },
    seeded: true
  };
}

const saved = (org) => D.getSetting(key(org), null);

/** ההגדרות המלאות (פנימי — כולל הסיסמה המוצפנת) */
function raw(org = DEFAULT_ORG) {
  const s = saved(org);
  if (!s) return seed();
  return {
    connection: { host: Priority.DEFAULT_HOST, ini: Priority.DEFAULT_INI, user: '', password: '', ...(s.connection ?? {}) },
    companies: Array.isArray(s.companies) && s.companies.length ? s.companies : seed().companies,
    defaults: { ...DEFAULTS, ...(s.defaults ?? {}) },
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null
  };
}

/** החיבור, עם הסיסמה גלויה — רק לשימוש השרת. שדה ריק — משתנה הסביבה (עד שממלאים במסך) */
function credentials(org = DEFAULT_ORG) {
  const c = raw(org).connection;
  const password = c.password ? Secrets.decrypt(c.password) ?? '' : '';
  return {
    host: c.host || Priority.DEFAULT_HOST,
    ini: c.ini || Priority.DEFAULT_INI,
    user: c.user || process.env.PRIORITY_USER || '',
    password: password || process.env.PRIORITY_PASSWORD || ''
  };
}

/** קודי החברות הפתוחות לכתיבה. בבדיקות — אף אחת */
function writable(org = DEFAULT_ORG, { ignoreTestLock = false } = {}) {
  if (testLock() && !ignoreTestLock) return [];
  return raw(org).companies.filter((c) => c.write).map((c) => c.code);
}

const poNotifyCompanies = (org = DEFAULT_ORG) => raw(org).companies.filter((c) => c.poNotify).map((c) => c.code);
const pdNotifyCompanies = (org = DEFAULT_ORG) => raw(org).companies.filter((c) => c.pdNotify).map((c) => c.code);
const defaults = (org = DEFAULT_ORG) => raw(org).defaults;
const companies = (org = DEFAULT_ORG) => raw(org).companies.map((c) => ({ code: c.code, name: c.name, vat: c.vat, sandbox: c.sandbox || '', test: Boolean(c.test) }));

/** לתצוגה במסך: בלי הסיסמה — רק אם יש */
function forDisplay(org = DEFAULT_ORG) {
  const r = raw(org);
  const envUser = Boolean(process.env.PRIORITY_USER);
  const envPass = Boolean(process.env.PRIORITY_PASSWORD);
  return {
    connection: {
      host: r.connection.host, ini: r.connection.ini, user: r.connection.user,
      hasPassword: Boolean(r.connection.password),
      fromServer: { user: !r.connection.user && envUser, password: !r.connection.password && envPass }
    },
    companies: r.companies,
    defaults: r.defaults,
    testLock: testLock(),
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null
  };
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const CODE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * שמירה מהמסך. ‎password‎ — רק כשהוקלדה סיסמה חדשה (ריק = להשאיר את הקיימת; ‎clearPassword‎ — למחוק).
 * זורק ‎Error‎ עם הודעה לעובד כשהקלט אינו תקין.
 */
function save(input, { org = DEFAULT_ORG, by = null } = {}) {
  const cur = raw(org);
  const b = input ?? {};
  const conn = { ...cur.connection };
  if (b.connection) {
    if ('host' in b.connection) conn.host = str(b.connection.host).replace(/^https?:\/\//, '').replace(/\/.*$/, '') || Priority.DEFAULT_HOST;
    if ('ini' in b.connection) conn.ini = str(b.connection.ini) || Priority.DEFAULT_INI;
    if ('user' in b.connection) conn.user = str(b.connection.user, 500);
    if (b.connection.clearPassword) conn.password = '';
    else if (b.connection.password) conn.password = Secrets.encrypt(String(b.connection.password));
  }
  let list = cur.companies;
  if (Array.isArray(b.companies)) {
    const seen = new Set();
    list = b.companies.map((c) => {
      const code = str(c?.code, 32);
      if (!CODE.test(code)) throw new Error(`קוד חברה לא תקין: "${code}"`);
      if (seen.has(code)) throw new Error(`החברה ${code} מופיעה פעמיים`);
      seen.add(code);
      return {
        code, name: str(c.name) || code, vat: str(c.vat, 20).replace(/\D/g, ''),
        sandbox: str(c.sandbox, 32), test: Boolean(c.test),
        write: Boolean(c.write), poNotify: Boolean(c.poNotify), pdNotify: Boolean(c.pdNotify)
      };
    });
    if (!list.length) throw new Error('צריך לפחות חברה אחת');
    for (const c of list) if (c.sandbox && !seen.has(c.sandbox)) throw new Error(`עותק הבדיקה של ${c.code} (${c.sandbox}) אינו ברשימה`);
  }
  const defs = { ...cur.defaults };
  if (b.defaults) {
    for (const k of ['payCode', 'warehouse', 'generalPart', 'chapter', 'topic', 'pdType', 'noVatCode']) if (k in b.defaults) defs[k] = str(b.defaults[k], 40) || DEFAULTS[k];
    if ('poFinalStatuses' in b.defaults) {
      const v = Array.isArray(b.defaults.poFinalStatuses) ? b.defaults.poFinalStatuses : csv(b.defaults.poFinalStatuses);
      defs.poFinalStatuses = v.map((x) => str(x, 40)).filter(Boolean);
      if (!defs.poFinalStatuses.length) defs.poFinalStatuses = [...DEFAULTS.poFinalStatuses];
    }
    if ('draftTtlHours' in b.defaults) defs.draftTtlHours = Math.min(168, Math.max(1, Number(b.defaults.draftTtlHours) || DEFAULTS.draftTtlHours));
  }
  const next = { connection: conn, companies: list, defaults: defs, updatedAt: D.nowIso(), updatedBy: by };
  D.setSetting(key(org), next);
  log(org, by, cur, next);
  apply(org);
  return forDisplay(org);
}

/** יומן שינויים — מה השתנה (בלי ערכי הסיסמה) */
function log(org, by, before, after) {
  const changes = [];
  for (const k of ['host', 'ini', 'user']) if (before.connection[k] !== after.connection[k]) changes.push(`חיבור: ${k}`);
  if (before.connection.password !== after.connection.password) changes.push(after.connection.password ? 'חיבור: סיסמה הוחלפה' : 'חיבור: סיסמה נמחקה');
  const bc = new Map(before.companies.map((c) => [c.code, c]));
  for (const c of after.companies) {
    const o = bc.get(c.code);
    if (!o) { changes.push(`חברה נוספה: ${c.code}`); continue; }
    for (const [f, label] of [['write', 'כתיבה'], ['poNotify', 'התראות הזמנות רכש'], ['pdNotify', 'התראה לחותם']]) {
      if (Boolean(o[f]) !== Boolean(c[f])) changes.push(`${c.code}: ${label} ${c[f] ? 'נפתחה' : 'נסגרה'}`);
    }
    if (o.name !== c.name || o.vat !== c.vat || (o.sandbox || '') !== (c.sandbox || '')) changes.push(`${c.code}: פרטי החברה עודכנו`);
  }
  for (const c of before.companies) if (!after.companies.some((x) => x.code === c.code)) changes.push(`חברה הוסרה: ${c.code}`);
  for (const k of Object.keys(after.defaults)) if (JSON.stringify(before.defaults[k]) !== JSON.stringify(after.defaults[k])) changes.push(`ברירת מחדל: ${k}`);
  if (!changes.length) return;
  const list = D.getSetting(logKey(org), []);
  const arr = Array.isArray(list) ? list : [];
  arr.unshift({ at: D.nowIso(), by: by ? { id: by.id, name: by.name } : null, changes });
  D.setSetting(logKey(org), arr.slice(0, 200));
}
const logKey = (org) => `priority_settings_log:${org}`;
const history = (org = DEFAULT_ORG) => { const v = D.getSetting(logKey(org), []); return Array.isArray(v) ? v : []; };

/** רשומה ביומן מבחוץ (למשל שינוי הרשאות) */
function note(org, by, changes) {
  if (!changes?.length) return;
  const arr = history(org);
  arr.unshift({ at: D.nowIso(), by: by ? { id: by.id, name: by.name } : null, changes });
  D.setSetting(logKey(org), arr.slice(0, 200));
}

/** מחבר את ההגדרות לחיבור לפריוריטי (‎integrations/priority.js‎) — נקרא ב-‎wiring.js‎ ואחרי כל שמירה */
function apply(org = DEFAULT_ORG) {
  Priority.syncCompanies(companies(org));
  Priority.configure({ credentials: () => credentials(org), writable: () => writable(org) });
}

module.exports = {
  DEFAULT_ORG, DEFAULTS,
  credentials, writable, poNotifyCompanies, pdNotifyCompanies, defaults, companies,
  forDisplay, save, history, note, apply,
  _raw: raw, _seed: seed, _key: key
};
