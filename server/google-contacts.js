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
const D = require('./db');
const Gmail = require('./gmail');

const PEOPLE = 'https://people.googleapis.com/v1';
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
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

const canSync = (userId) => Object.values(SOURCES).some((s) => Gmail.has(userId, s.scope));

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
    for (const [source, def] of Object.entries(SOURCES)) {
      if (!Gmail.has(userId, def.scope)) {
        D.run('DELETE FROM google_contacts WHERE user_id = ? AND source = ?', userId, source);
        continue;
      }
      let people;
      try {
        people = await def.fetch(userId);
      } catch (err) {
        // ספרייה בחשבון שאינו של ארגון מחזירה 400 — זה לא תקלה שצריך להציג
        if (!(source === 'directory' && [400, 403].includes(err.status))) errors.push(`${source}: ${err.message.slice(0, 120)}`);
        continue;
      }
      const at = D.nowIso();
      D.db.exec('BEGIN');
      try {
        D.run('DELETE FROM google_contacts WHERE user_id = ? AND source = ?', userId, source);
        for (const p of people) {
          if (!p.resourceName || (!p.emails.length && !p.phones.length)) continue;
          D.run(
            `INSERT OR REPLACE INTO google_contacts (user_id, resource_name, source, name, emails, phones, organization, title, photo_url, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            userId, p.resourceName, source, p.name, JSON.stringify(p.emails), JSON.stringify(p.phones),
            p.organization, p.title, p.photoUrl, at
          );
        }
        D.db.exec('COMMIT');
      } catch (err) {
        D.db.exec('ROLLBACK');
        throw err;
      }
      counts[source] = people.length;
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

function status(userId) {
  const row = syncRow(userId);
  const total = D.get('SELECT COUNT(*) c FROM google_contacts WHERE user_id = ?', userId).c;
  let counts = {};
  try { counts = JSON.parse(row?.counts ?? '{}'); } catch { /* ריק */ }
  return {
    available: canSync(userId),
    canSave: Gmail.has(userId, 'contacts'),
    running: Boolean(row?.running),
    lastSyncAt: row?.last_sync_at ?? null,
    error: row?.error ?? '',
    counts,
    total
  };
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
      const last = syncRow(userId)?.last_sync_at;
      if (last && Date.now() - new Date(last).getTime() < SYNC_EVERY_MS) continue;
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
  sync, syncSoon, status, search, isSaved, lookup, save, dismiss, shouldSuggest, normalizePhone, phoneKey, fold, matcher, score,
  start, stop
};
