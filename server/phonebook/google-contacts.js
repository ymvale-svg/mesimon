'use strict';
/**
 * אנשי הקשר של Google — לבחירת נמען במשימת AI בלי להקליד מייל וטלפון.
 *
 * שלושה מקורות (People API), כל אחד לפי ההרשאה שאושרה בחיבור Google:
 *   • ‎contacts‎  — אנשי הקשר השמורים שלי
 *   • ‎other‎     — "אנשי קשר אחרים": מי שהתכתבתי איתו ב-Gmail ולא שמרתי
 *   • ‎directory‎ — ספריית העובדים של הארגון ב-Google Workspace
 *
 * למה עותק מקומי ולא חיפוש חי ב-Google: החיפוש באשף רץ בכל הקלדה. מול Google
 * הוא היה איטי, מוגבל בקצב, ו-‎searchContacts‎ שלהם אינו מוצא חלקי מילים
 * ("מש" ← "משה"). העותק מסתנכרן מלא כל 6 שעות, וב"רענון" מההגדרות.
 *
 * פרטיות: אנשי הקשר של משתמש נראים רק לו, ונמחקים בניתוק החיבור.
 * כתיבה ל-Google: רק "שמור באנשי הקשר" שהמשתמש לחץ עליו. לא משנים ולא מוחקים.
 */
const D = require('../core').Db;
const Gmail = require('../integrations').Gmail;

const PEOPLE = 'https://people.googleapis.com/v1';
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_FAILED_MS = 30 * 60 * 1000;
const MAX_PER_SOURCE = 20000;

// ---------------------------------------------------------------------------
// נרמול
// ---------------------------------------------------------------------------

/** טלפון לתצוגה בפורמט ישראלי: ‎+972 54-123-4567‎ ← ‎054-1234567‎ */
function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+972')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('972') && digits.length >= 11) digits = `0${digits.slice(3)}`;
  digits = digits.replace(/\+/g, '');
  if (/^05\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (/^0[2-9]\d{7}$/.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  if (/^07\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return raw;
}

const phoneKey = (value) => {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.startsWith('972') ? `0${d.slice(3)}` : d;
};

const FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
/** טקסט להשוואה: בלי ניקוד, בלי גרשיים, אותיות סופיות כרגילות */
const fold = (s) => String(s ?? '').toLowerCase()
  .replace(/[֑-ׇ]/g, '')
  .replace(/[׳״'"`]/g, '')
  .replace(/[םןץףך]/g, (c) => FINALS[c]);

const TYPE_LABEL = { mobile: 'נייד', work: 'עבודה', home: 'בית', main: 'ראשי', other: 'אחר', workMobile: 'נייד עבודה' };

function shapePerson(p) {
  const name = p.names?.[0]?.displayName ?? p.names?.[0]?.unstructuredName ?? '';
  const emails = (p.emailAddresses ?? [])
    .map((e) => ({ value: String(e.value ?? '').trim().toLowerCase(), label: TYPE_LABEL[e.type] ?? e.formattedType ?? '' }))
    .filter((e) => e.value);
  const phones = (p.phoneNumbers ?? [])
    .map((x) => ({ value: normalizePhone(x.canonicalForm ?? x.value), label: TYPE_LABEL[x.type] ?? x.formattedType ?? '' }))
    .filter((x) => x.value);
  return {
    resourceName: p.resourceName,
    name: String(name).trim(),
    emails,
    phones,
    organization: p.organizations?.[0]?.name ?? '',
    title: p.organizations?.[0]?.title ?? p.organizations?.[0]?.department ?? '',
    photoUrl: p.photos?.find((x) => !x.default)?.url ?? ''
  };
}

// ---------------------------------------------------------------------------
// סנכרון
// ---------------------------------------------------------------------------

async function fetchAll(userId, url, params, listKey) {
  const out = [];
  let pageToken;
  do {
    const page = await Gmail.googleCall(userId, url, { ...params, pageToken });
    for (const p of page[listKey] ?? []) out.push(shapePerson(p));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < MAX_PER_SOURCE);
  return out;
}

const SOURCES = {
  contacts: {
    scope: 'contacts',
    fetch: (userId) => fetchAll(userId, `${PEOPLE}/people/me/connections`,
      { personFields: 'names,emailAddresses,phoneNumbers,organizations,photos', pageSize: 1000, sortOrder: 'LAST_MODIFIED_DESCENDING' }, 'connections')
  },
  other: {
    scope: 'otherContacts',
    fetch: (userId) => fetchAll(userId, `${PEOPLE}/otherContacts`,
      { readMask: 'names,emailAddresses,phoneNumbers,photos', pageSize: 1000 }, 'otherContacts')
  },
  directory: {
    scope: 'directory',
    fetch: (userId) => fetchAll(userId, `${PEOPLE}/people:listDirectoryPeople`,
      { readMask: 'names,emailAddresses,phoneNumbers,organizations,photos', sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', pageSize: 1000 }, 'people')
  }
};

const memo = new Map(); // userId → שורות מוכנות לחיפוש

function syncRow(userId) {
  return D.get('SELECT * FROM google_contact_sync WHERE user_id = ?', userId);
}

function setSync(userId, fields) {
  D.run('INSERT OR IGNORE INTO google_contact_sync (user_id) VALUES (?)', userId);
  const keys = Object.keys(fields);
  D.run(`UPDATE google_contact_sync SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`, ...keys.map((k) => fields[k]), userId);
}

/** התיבות של העובד (ראשית ונוספות) — מכל אחת נטענים אנשי הקשר שאושרו בה */
const boxesFor = (userId) => Gmail.boxesOf(userId, null);
const canSync = (userId) => boxesFor(userId).some((who) => Object.values(SOURCES).some((s) => Gmail.has(who, s.scope)));

/**
 * סנכרון מלא: כל מקור מוחלף כולו בטרנזקציה. מקור שנכשל (למשל ספרייה בחשבון
 * פרטי, שאין לו כזו) — נשאר כפי שהיה, והתקלה נרשמת.
 */
async function sync(userId) {
  if (!canSync(userId)) return null;
  const row = syncRow(userId);
  if (row?.running) return row;
  setSync(userId, { running: 1 });
  const counts = {};
  const errors = [];
  try {
    for (const who of boxesFor(userId)) {
      const box = Gmail.boxOf(who);
      const tag = box ? `${Gmail.connectionOf(who)?.email ?? box} · ` : '';
      for (const [source, def] of Object.entries(SOURCES)) {
        if (!Gmail.has(who, def.scope)) {
          D.run('DELETE FROM google_contacts WHERE user_id = ? AND source = ? AND box = ?', userId, source, box);
          continue;
        }
        let people;
        try {
          people = await def.fetch(who);
        } catch (err) {
          // ספרייה בחשבון שאינו של ארגון מחזירה 400 — זה לא תקלה שצריך להציג
          if (!(source === 'directory' && [400, 403].includes(err.status))) errors.push(`${tag}${source}: ${err.message.slice(0, 120)}`);
          continue;
        }
        const at = D.nowIso();
        D.db.exec('BEGIN');
        try {
          D.run('DELETE FROM google_contacts WHERE user_id = ? AND source = ? AND box = ?', userId, source, box);
          for (const p of people) {
            if (!p.resourceName || (!p.emails.length && !p.phones.length)) continue;
            D.run(
              `INSERT OR REPLACE INTO google_contacts (user_id, resource_name, source, name, emails, phones, organization, title, photo_url, updated_at, box)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              userId, p.resourceName, source, p.name, JSON.stringify(p.emails), JSON.stringify(p.phones),
              p.organization, p.title, p.photoUrl, at, box
            );
          }
          D.db.exec('COMMIT');
        } catch (err) {
          D.db.exec('ROLLBACK');
          throw err;
        }
        counts[source] = (counts[source] ?? 0) + people.length;
      }
    }
  } finally {
    memo.delete(userId);
    setSync(userId, { running: 0, last_sync_at: D.nowIso(), counts: JSON.stringify(counts), error: errors.join(' · ') });
  }
  return syncRow(userId);
}

/** סנכרון ברקע, בלי להמתין — אחרי חיבור, או מכפתור הרענון */
function syncSoon(userId) {
  sync(userId).catch((err) => {
    setSync(userId, { running: 0, error: err.message.slice(0, 200) });
    console.error(`[משימון] סנכרון אנשי הקשר למשתמש ${userId} נכשל:`, err.message);
  });
}

/*
 * מצב החיבור, במדויק — ולא רק "מחובר / לא מחובר". ‎available‎ — יש מה לחפש:
 * ההרשאה בתוקף, או שיש עותק מקומי (החיפוש רץ עליו, גם כשהאסימון נפל לרגע).
 * ‎reason‎ — למה אין, או למה אין עדיין:
 *   not_connected · revoked · no_permission · not_synced · sync_error · ''
 */
function status(userId) {
  const row = syncRow(userId);
  const total = D.get('SELECT COUNT(*) c FROM google_contacts WHERE user_id = ?', userId).c;
  let counts = {};
  try { counts = JSON.parse(row?.counts ?? '{}'); } catch { /* ריק */ }
  const conn = D.get('SELECT state FROM mail_connections WHERE user_id = ?', userId);
  const permitted = canSync(userId);
  const error = row?.error ?? '';
  let reason = '';
  if (!conn) reason = 'not_connected';
  else if (conn.state !== 'ok') reason = 'revoked';
  else if (!permitted) reason = 'no_permission';
  else if (!total && error) reason = 'sync_error';
  else if (!total) reason = 'not_synced';
  return {
    available: permitted || total > 0,
    connected: Boolean(conn && conn.state === 'ok'),
    reason,
    canSave: Gmail.has(userId, 'contacts'),
    running: Boolean(row?.running),
    lastSyncAt: row?.last_sync_at ?? null,
    error,
    counts,
    total
  };
}

/** משפט לבוט: למה אנשי הקשר של Google לא נמצאו / לא זמינים. ריק — הכול תקין */
function reasonText(st) {
  return {
    not_connected: 'חשבון ה-Google שלך לא מחובר למשימון — מחברים באפליקציה: "החשבון שלי ← Gmail ועוזר ה-AI".',
    revoked: 'החיבור ל-Google פג או בוטל — צריך לחבר מחדש באפליקציה: "החשבון שלי ← Gmail ועוזר ה-AI".',
    no_permission: 'בחיבור ל-Google לא אושרה ההרשאה לאנשי הקשר — חברו מחדש באפליקציה וסמנו את כל התיבות.',
    not_synced: st.running ? 'אנשי הקשר מ-Google מסתנכרנים עכשיו — נסו שוב בעוד דקה.' : 'אנשי הקשר מ-Google עוד לא סונכרנו — התחלתי סנכרון, נסו שוב בעוד דקה.',
    sync_error: `הסנכרון של אנשי הקשר מ-Google נכשל: ${String(st.error).slice(0, 160)}`
  }[st.reason] ?? '';
}

/**
 * ההודעה למשתמש כשהוא פותח את משימון או כותב לבוט בפעם הראשונה ביום — מה
 * לעשות כדי שאנשי הקשר של Google יעבדו. ‎null‎ — הכול תקין, או ש-Google
 * אינו מוגדר בשרת בכלל.
 *   connect   — אין חיבור ל-Google
 *   reconnect — החיבור פג, או שלא אושרה בו ההרשאה לאנשי הקשר
 *   refresh   — מחובר, אבל אין אנשי קשר (הסנכרון נכשל או לא רץ). הסנכרון
 *               מתחיל כאן מעצמו; הכפתור "רענון" — למקרה שצריך שוב.
 */
function notice(userId) {
  if (!Gmail.isEnabled()) return null;
  const st = status(userId);
  if (!st.reason) return null;
  if (st.reason === 'not_connected') {
    return { kind: 'connect', title: 'חיבור אנשי הקשר מ-Google', text: 'כדי שמשימון והבוט ימצאו טלפונים ומיילים מאנשי הקשר שלך ב-Google — חברו את חשבון ה-Google שלך (במסך של Google: לסמן את כל התיבות).' };
  }
  if (st.reason === 'revoked' || st.reason === 'no_permission') {
    return { kind: 'reconnect', title: 'צריך לחבר מחדש את Google', text: st.reason === 'revoked'
      ? 'החיבור ל-Google פג או בוטל, ולכן אנשי הקשר שלך לא מתעדכנים. חברו מחדש — אותו מסך של Google, לסמן את כל התיבות.'
      : 'בחיבור ל-Google לא אושרה ההרשאה לאנשי הקשר. חברו מחדש ובמסך של Google סמנו את כל התיבות — כולל אנשי הקשר.' };
  }
  healIfEmpty(userId, []);
  return { kind: 'refresh', title: 'רענון אנשי הקשר מ-Google', text: 'אנשי הקשר שלך מ-Google עוד לא נטענו למשימון. התחלנו לטעון אותם — אפשר ללחוץ "רענון" כדי לנסות שוב.', error: st.error };
}

/**
 * שורה לבוט, בהודעה הראשונה של היום. ‎root‎ — כתובת משימון באינטרנט: עם
 * קישור ישיר למסך האישור של Google (‎?connect=google‎), או לחלון החיבור
 * לרענון (‎?open=google‎). בלי כתובת — ההסבר איפה זה באפליקציה.
 */
function noticeLine(userId, root = '') {
  const n = notice(userId);
  if (!n) return null;
  const connectLink = root ? `\n👉 לחיבור בלחיצה: ${root}/?connect=google` : '';
  const where = '"החשבון שלי ← Gmail ועוזר ה-AI"';
  return {
    connect: `👥 *אנשי הקשר מ-Google:* כדי שאמצא טלפונים ומיילים מאנשי הקשר שלך — חברו את Google${root ? '' : ` באפליקציה: ${where}`}. במסך של Google — לסמן את כל התיבות.${connectLink}`,
    reconnect: `👥 *אנשי הקשר מ-Google:* צריך לחבר מחדש את Google${root ? '' : ` באפליקציה (${where})`}, ובמסך של Google לסמן את כל התיבות.${connectLink}`,
    refresh: `👥 *אנשי הקשר מ-Google* עוד לא נטענו — התחלתי לטעון אותם. אם זה לא מסתדר — ${root ? `🔄 רענון: ${root}/?open=google` : `${where} ← 🔄 רענון`}`
  }[n.kind];
}

/*
 * חיבור תקין בלי עותק מקומי (הסנכרון הראשון נכשל, או עוד לא רץ) — סנכרון
 * ברקע מהחיפוש עצמו, ולא רק מהמתזמן. לכל היותר פעם ב-10 דקות למשתמש.
 */
const healedAt = new Map();
function healIfEmpty(userId, rows) {
  if (rows.length || !canSync(userId)) return;
  if (Date.now() - (healedAt.get(userId) ?? 0) < 10 * 60000) return;
  if (syncRow(userId)?.running) return;
  healedAt.set(userId, Date.now());
  syncSoon(userId);
}

// ---------------------------------------------------------------------------
// חיפוש
// ---------------------------------------------------------------------------

function rowsFor(userId) {
  const hit = memo.get(userId);
  if (hit) return hit;
  const rows = D.all('SELECT * FROM google_contacts WHERE user_id = ?', userId).map((r) => {
    const emails = JSON.parse(r.emails);
    const phones = JSON.parse(r.phones);
    return {
      resourceName: r.resource_name,
      source: r.source,
      name: r.name,
      emails,
      phones,
      organization: r.organization,
      title: r.title,
      photoUrl: r.photo_url,
      hay: fold([r.name, r.organization, r.title, ...emails.map((e) => e.value)].join(' ')),
      phoneDigits: phones.map((p) => phoneKey(p.value))
    };
  });
  memo.set(userId, rows);
  return rows;
}

const SOURCE_RANK = { contacts: 0, directory: 1, other: 2 };

/** ציון התאמה; ‎0‎ = לא מתאים. כל מילה בשאילתה חייבת להופיע */
function score(c, tokens, digits) {
  if (digits.length >= 3 && c.phoneDigits.some((p) => p.includes(digits))) return 50;
  let total = 0;
  const name = fold(c.name);
  for (const t of tokens) {
    if (!c.hay.includes(t)) return 0;
    if (name.startsWith(t)) total += 30;
    else if (name.split(/\s+/).some((w) => w.startsWith(t))) total += 20;
    else total += 5;
  }
  return total;
}

function matcher(q) {
  const tokens = fold(q).split(/\s+/).filter(Boolean);
  const digits = String(q ?? '').replace(/\D/g, '');
  return { tokens, digits };
}

/** חיפוש באנשי הקשר של המשתמש. שאילתה ריקה — אנשי הקשר השמורים, לפי הא״ב */
function search(userId, q, limit = 20) {
  const { tokens, digits } = matcher(q);
  const rows = rowsFor(userId);
  healIfEmpty(userId, rows);
  if (!tokens.length && !digits) {
    return rows.filter((c) => c.source === 'contacts').sort((a, b) => a.name.localeCompare(b.name, 'he')).slice(0, limit).map(publicOf);
  }
  return rows
    .map((c) => ({ c, s: score(c, tokens, digits) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source] || a.c.name.localeCompare(b.c.name, 'he'))
    .slice(0, limit)
    .map((x) => publicOf(x.c));
}

const SOURCE_TAG = { contacts: 'אנשי הקשר שלי ב-Google', directory: 'ספריית הארגון ב-Google', other: 'התכתבת איתו ב-Gmail' };

/** כרטיס לבוט — כמו כרטיס האלפון, רק השדות שיש */
function cardText(c) {
  const org = [c.title, c.organization].filter(Boolean).join(' · ');
  return [
    `👤 *${c.name || c.emails[0]?.value || c.phones[0]?.value}*${org ? ` · ${org}` : ''}`,
    ...c.phones.map((p) => `📞 ${p.label ? `${p.label}: ` : ''}${p.value}`),
    ...c.emails.map((e) => `✉️ ${e.value}`),
    `_מקור: ${SOURCE_TAG[c.source] ?? 'Google'}_`
  ].join('\n');
}

const publicOf = (c) => ({
  resourceName: c.resourceName,
  source: c.source,
  name: c.name || c.emails[0]?.value || c.phones[0]?.value || '',
  emails: c.emails,
  phones: c.phones,
  organization: c.organization,
  title: c.title,
  photoUrl: c.photoUrl
});

/** האם הכתובת או הטלפון כבר שמורים אצלי (אנשי קשר או ספריית הארגון) */
function isSaved(userId, { email, phone }) {
  const e = String(email ?? '').trim().toLowerCase();
  const p = phoneKey(phone);
  return rowsFor(userId).some((c) => c.source !== 'other'
    && ((e && c.emails.some((x) => x.value === e)) || (p.length >= 9 && c.phoneDigits.includes(p))));
}

/** אותו אדם ברשומות של Google — להשלמת טלפון לספק או לנמען קודם */
function lookup(userId, { email, phone }) {
  const e = String(email ?? '').trim().toLowerCase();
  const p = phoneKey(phone);
  const rows = rowsFor(userId);
  return rows.find((c) => (e && c.emails.some((x) => x.value === e)) || (p.length >= 9 && c.phoneDigits.includes(p))) ?? null;
}

// ---------------------------------------------------------------------------
// שמירה ל-Google
// ---------------------------------------------------------------------------

const addressKey = ({ email, phone }) => (String(email ?? '').trim().toLowerCase() || phoneKey(phone));

const isDismissed = (userId, contact) => {
  const key = addressKey(contact);
  return Boolean(key && D.get('SELECT 1 FROM contact_save_dismissed WHERE user_id = ? AND address = ?', userId, key));
};

function dismiss(userId, contact) {
  const key = addressKey(contact);
  if (!key) return;
  D.run('INSERT OR IGNORE INTO contact_save_dismissed (user_id, address, created_at) VALUES (?,?,?)', userId, key, D.nowIso());
}

/** האם להציע "שמור באנשי הקשר" לנמען הזה */
function shouldSuggest(userId, contact) {
  if (!Gmail.has(userId, 'contacts')) return false;
  if (!addressKey(contact)) return false;
  return !isSaved(userId, contact) && !isDismissed(userId, contact);
}

function storeLocal(userId, person, source = 'contacts') {
  const p = shapePerson(person);
  if (!p.resourceName) return;
  D.run(
    `INSERT OR REPLACE INTO google_contacts (user_id, resource_name, source, name, emails, phones, organization, title, photo_url, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId, p.resourceName, source, p.name, JSON.stringify(p.emails), JSON.stringify(p.phones), p.organization, p.title, p.photoUrl, D.nowIso()
  );
  memo.delete(userId);
  return publicOf({ ...p, source });
}

/**
 * שמירה באנשי הקשר של Google. ‎resourceName‎ של "איש קשר אחר" — מועתק לאנשי
 * הקשר שלי (ואז אפשר להשלים לו שם וטלפון). אחרת — נוצר איש קשר חדש.
 */
async function save(userId, { resourceName = null, name = '', email = '', phone = '' }) {
  if (!Gmail.has(userId, 'contacts')) {
    const err = new Error('כדי לשמור באנשי הקשר צריך לחבר מחדש את Google ולאשר את אנשי הקשר');
    err.status = 400;
    throw err;
  }
  const cleanName = String(name).trim().slice(0, 120);
  const cleanEmail = String(email).trim().toLowerCase().slice(0, 200);
  const cleanPhone = String(phone).trim().slice(0, 40);

  let person;
  if (resourceName && /^otherContacts\/[\w-]+$/.test(resourceName)) {
    person = await Gmail.googleCall(userId, `${PEOPLE}/${resourceName}:copyOtherContactToMyContactsGroup`, {}, {
      method: 'POST',
      body: { copyMask: 'names,emailAddresses,phoneNumbers', readMask: 'names,emailAddresses,phoneNumbers' }
    });
    D.run('DELETE FROM google_contacts WHERE user_id = ? AND resource_name = ?', userId, resourceName);
    // השם והטלפון שהמשתמש השלים — מתווספים לאיש הקשר שהועתק
    const missingName = cleanName && !person.names?.length;
    const missingPhone = cleanPhone && !(person.phoneNumbers ?? []).some((p) => phoneKey(p.value) === phoneKey(cleanPhone));
    if (missingName || missingPhone) {
      const fields = [missingName ? 'names' : null, missingPhone ? 'phoneNumbers' : null].filter(Boolean);
      person = await Gmail.googleCall(userId, `${PEOPLE}/${person.resourceName}:updateContact`, {
        updatePersonFields: fields.join(','), personFields: 'names,emailAddresses,phoneNumbers'
      }, {
        method: 'PATCH',
        body: {
          etag: person.etag,
          ...(missingName ? { names: [{ unstructuredName: cleanName }] } : {}),
          ...(missingPhone ? { phoneNumbers: [...(person.phoneNumbers ?? []), { value: cleanPhone, type: 'mobile' }] } : {})
        }
      });
    }
  } else {
    if (!cleanEmail && !cleanPhone) {
      const err = new Error('נדרש מייל או טלפון לשמירה');
      err.status = 400;
      throw err;
    }
    person = await Gmail.googleCall(userId, `${PEOPLE}/people:createContact`, { personFields: 'names,emailAddresses,phoneNumbers' }, {
      method: 'POST',
      body: {
        ...(cleanName ? { names: [{ unstructuredName: cleanName }] } : {}),
        ...(cleanEmail ? { emailAddresses: [{ value: cleanEmail }] } : {}),
        ...(cleanPhone ? { phoneNumbers: [{ value: cleanPhone, type: 'mobile' }] } : {})
      }
    });
  }
  return storeLocal(userId, person, 'contacts');
}

// ---------------------------------------------------------------------------
// מתזמן
// ---------------------------------------------------------------------------

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const users = D.all("SELECT c.user_id FROM mail_connections c JOIN users u ON u.id = c.user_id WHERE c.state = 'ok' AND u.status = 'active'")
      .map((r) => r.user_id).filter(canSync);
    for (const userId of users) {
      const row = syncRow(userId);
      const last = row?.last_sync_at;
      // סנכרון שנכשל, או שלא הביא כלום — שוב אחרי חצי שעה, ולא אחרי 6 שעות
      const empty = !D.get('SELECT 1 FROM google_contacts WHERE user_id = ? LIMIT 1', userId);
      const every = row?.error || empty ? RETRY_FAILED_MS : SYNC_EVERY_MS;
      if (last && Date.now() - new Date(last).getTime() < every) continue;
      await sync(userId).catch((err) => {
        setSync(userId, { running: 0, error: err.message.slice(0, 200) });
        console.error(`[משימון] סנכרון אנשי הקשר למשתמש ${userId} נכשל:`, err.message);
      });
    }
  } finally {
    running = false;
  }
}

function start() {
  // סנכרון שנקטע בהפעלה מחדש — משוחרר, אחרת הוא "רץ" לנצח
  D.run('UPDATE google_contact_sync SET running = 0 WHERE running = 1');
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 15 * 60000);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 60000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  sync, syncSoon, status, reasonText, notice, noticeLine, cardText, search, isSaved, lookup, save, dismiss, shouldSuggest, normalizePhone, phoneKey, fold, matcher, score,
  start, stop
};
