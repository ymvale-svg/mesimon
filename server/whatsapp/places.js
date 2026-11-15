'use strict';
/**
 * 📍 מקומות ומיקום — תזכורת לפי מיקום ("תזכיר לי כשאני מגיע למשרד לדבר עם ישראל"), הוחלט 15.11.26.
 *
 *   • נקודות ציון (‎places‎): המשרד והאתרים — שם, סוג (משרד / אתר), כינויים, נ"צ ורדיוס. מנהל מגדיר
 *     ב"⚙ ההגדרות שלי ← 📍 מיקום" ("המיקום הנוכחי שלי", או נ"צ / קישור מגוגל מפות).
 *   • המיקום של העובד (‎user_locations‎): רק האחרון, ורק ממי שבחר לשתף — מהאפליקציה (כשהיא פתוחה),
 *     ממיקום 📍 ששלח לבוט, או מקישור אישי לאפליקציית מעקב ברקע (OwnTracks / קיצורי דרך). אף אחד לא רואה אותו —
 *     הוא משמש רק לבדוק אם העובד הגיע לנקודת ציון או יצא ממנה.
 *   • הגעה / יציאה: ‎update‎ משווה למקום הקודם. מיקום ישן (יותר מ-‎STALE_MS‎) — כאילו לא היה, כך שמיקום 📍
 *     ששולחים מהמשרד בבוקר הוא "הגעה" גם אם אתמול שלחו מאותו מקום. יציאה — רק כשראינו אותה.
 *   • תזכורת מקום (‎reminders.status = 'place'‎) שהגיע המקום שלה הופכת לתזכורת רגילה שמועדה עכשיו —
 *     והסבב של הבוט (‎Reminders.tick‎) שולח אותה תוך שניות.
 */
const crypto = require('node:crypto');
const D = require('../core').Db;

const KINDS = Object.freeze({ office: 'משרד', site: 'אתר' });
const DEFAULT_RADIUS = Object.freeze({ office: 150, site: 300 });
const STALE_MS = 3 * 60 * 60 * 1000;
// מיקום גס מדי (רשת סלולרית) — לא מחליטים לפיו
const MAX_ACCURACY_M = 1000;
// יוצאים רק כשרחוקים מהרדיוס בעוד קצת — שקפיצה של ה-GPS ליד הגבול לא תיחשב יציאה וחזרה
const leaveMargin = (radius) => Math.max(50, radius * 0.3);

/** מרחק במטרים בין שתי נקודות (נוסחת האברסין) */
function distance(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/**
 * נ"צ מטקסט חופשי: "32.0853, 34.7818", קישור מגוגל מפות ("…/@32.08,34.78,17z", "?q=32.08,34.78", "!3d32.08!4d34.78").
 * ‎null‎ — לא נמצא.
 */
function parseCoords(text) {
  const s = decodeURIComponent(String(text ?? '')).replace(/\s+/g, ' ');
  const pats = [/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d{1,2}\.\d+),\s?(-?\d{1,3}\.\d+)/, /(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/];
  for (const p of pats) {
    const m = p.exec(s);
    if (m && validCoord(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

const aliasesOf = (row) => { try { return JSON.parse(row.aliases || '[]'); } catch { return []; } };
const shape = (row) => row && ({ id: row.id, name: row.name, kind: row.kind, kindLabel: KINDS[row.kind] ?? row.kind, lat: row.lat, lng: row.lng, radius: row.radius_m, aliases: aliasesOf(row), active: Boolean(row.active) });

const list = ({ all = false } = {}) => D.all(`SELECT * FROM places ${all ? '' : 'WHERE active = 1'} ORDER BY kind = 'office' DESC, name`).map(shape);
const get = (id) => shape(D.get('SELECT * FROM places WHERE id = ?', id));

function clean(input, prev = {}) {
  const name = String(input.name ?? prev.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('חסר שם למקום');
  const kind = Object.hasOwn(KINDS, input.kind) ? input.kind : prev.kind ?? 'site';
  const fromText = input.coords ? parseCoords(input.coords) : null;
  if (input.coords && !fromText) throw new Error('לא הצלחתי לקרוא נ"צ. הדביקו למשל "32.0853, 34.7818" או קישור מגוגל מפות');
  const lat = fromText?.lat ?? (input.lat !== undefined ? Number(input.lat) : prev.lat);
  const lng = fromText?.lng ?? (input.lng !== undefined ? Number(input.lng) : prev.lng);
  if (!validCoord(lat, lng)) throw new Error('חסר נ"צ תקין למקום');
  const radius = Math.round(Math.min(5000, Math.max(50, Number(input.radius ?? prev.radius) || DEFAULT_RADIUS[kind])));
  const raw = input.aliases ?? prev.aliases ?? [];
  const aliases = (Array.isArray(raw) ? raw : String(raw).split(/[,\n]/)).map((a) => String(a).trim()).filter(Boolean).slice(0, 10);
  return { name, kind, lat, lng, radius, aliases };
}

function create(actor, input) {
  const p = clean(input);
  const r = D.run('INSERT INTO places (name, kind, lat, lng, radius_m, aliases, active, created_by, created_at) VALUES (?,?,?,?,?,?,1,?,?)',
    p.name, p.kind, p.lat, p.lng, p.radius, JSON.stringify(p.aliases), actor?.id ?? null, D.nowIso());
  return get(Number(r.lastInsertRowid));
}

function update(id, input) {
  const prev = get(id);
  if (!prev) return null;
  const p = clean(input, prev);
  D.run('UPDATE places SET name = ?, kind = ?, lat = ?, lng = ?, radius_m = ?, aliases = ?, updated_at = ? WHERE id = ?',
    p.name, p.kind, p.lat, p.lng, p.radius, JSON.stringify(p.aliases), D.nowIso(), id);
  return get(id);
}

/** מחיקה — המקום יורד מהרשימה; תזכורות שחיכו לו מתבטלות */
function remove(id) {
  const ok = D.run('UPDATE places SET active = 0, updated_at = ? WHERE id = ? AND active = 1', D.nowIso(), id).changes > 0;
  if (ok) D.run("UPDATE reminders SET status = 'cancelled', done_at = ? WHERE status = 'place' AND place_id = ?", D.nowIso(), id);
  return ok;
}

/** המקום שבו הנקודה נמצאת (הקרוב מבין אלה שהיא בתוך הרדיוס שלהם). ‎stay‎ — המקום הנוכחי, שיוצאים ממנו רק אחרי מרווח */
function placeAt(point, stay = null) {
  let best = null;
  for (const p of list()) {
    const d = distance(point, p);
    const r = p.radius + (p.id === stay ? leaveMargin(p.radius) : 0);
    if (d <= r && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// שיתוף המיקום (‎user_prefs.location‎ — ‎{ share, tokenHash }‎)
// ---------------------------------------------------------------------------

const prefsOf = (userId) => D.userPrefs(userId)?.location ?? {};
const sharing = (userId) => prefsOf(userId).share === true;
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** הפעלה / כיבוי. כיבוי מוחק את המיקום האחרון ואת הקישור האישי */
function setSharing(userId, on) {
  const prev = prefsOf(userId);
  D.setUserPref(userId, 'location', on ? { ...prev, share: true } : { share: false });
  if (!on) D.run('DELETE FROM user_locations WHERE user_id = ?', userId);
  return status(userId);
}

/** קישור אישי לאפליקציית מעקב ברקע. האסימון מוצג פעם אחת; נשמר רק הגיבוב שלו. קישור חדש מבטל את הקודם */
function newToken(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  D.setUserPref(userId, 'location', { ...prefsOf(userId), share: true, tokenHash: hashToken(token) });
  return token;
}

/** מי בעל האסימון (רק כשהשיתוף דלוק) */
function userByToken(token) {
  if (!/^[\w-]{20,64}$/.test(String(token ?? ''))) return null;
  const h = hashToken(token);
  const row = D.all("SELECT user_id, value FROM user_prefs WHERE key = 'location'").find((r) => { try { const v = JSON.parse(r.value); return v.share === true && v.tokenHash === h; } catch { return false; } });
  return row ? row.user_id : null;
}

function status(userId) {
  const loc = D.get('SELECT * FROM user_locations WHERE user_id = ?', userId);
  const fresh = loc && Date.now() - Date.parse(loc.at) < STALE_MS;
  const place = fresh && loc.place_id ? get(loc.place_id) : null;
  return {
    share: sharing(userId),
    hasToken: Boolean(prefsOf(userId).tokenHash),
    lastAt: loc?.at ?? null,
    source: loc?.source ?? null,
    place: place ? { id: place.id, name: place.name } : null,
    waiting: D.get("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND status = 'place'", userId).n
  };
}

/** המקום הנוכחי של העובד — רק כשהמיקום עדכני */
function currentPlace(userId) {
  const loc = D.get('SELECT place_id, at FROM user_locations WHERE user_id = ?', userId);
  return loc?.place_id && Date.now() - Date.parse(loc.at) < STALE_MS ? get(loc.place_id) : null;
}

// ---------------------------------------------------------------------------
// עדכון מיקום ← הגעה / יציאה ← תזכורות
// ---------------------------------------------------------------------------

const matches = (place) => `(place_id = ${Number(place.id)} OR (place_id IS NULL AND place_kind = '${place.kind === 'office' ? 'office' : 'site'}'))`;

/** תזכורות המקום שהגיע זמנן — הופכות לתזכורת רגילה שמועדה עכשיו. מחזיר אותן */
function fire(userId, place, on) {
  const due = D.all(`SELECT * FROM reminders WHERE user_id = ? AND status = 'place' AND place_on = ? AND ${matches(place)}`, userId, on);
  const now = D.nowIso();
  for (const r of due) D.run("UPDATE reminders SET status = 'active', due_at = ?, ref = ? WHERE id = ?", now, `place:${on}:${place.id}`, r.id);
  return due.map((r) => ({ id: r.id, text: r.text }));
}

/**
 * מיקום חדש של העובד. ‎source‎: ‎app‎ / ‎whatsapp‎ / ‎tracker‎. ‎explicit‎ — העובד שלח אותו בעצמו (מיקום 📍 בבוט),
 * ואז נקלט גם בלי שהשיתוף דלוק (רק לרגע הזה — לא נשמר).
 * @returns {{ok: boolean, place: object|null, arrived: object|null, left: object|null, fired: object[], reason?: string}}
 */
function report(userId, { lat, lng, accuracy = null, source = 'app', explicit = false, at = null } = {}) {
  lat = Number(lat); lng = Number(lng);
  if (!validCoord(lat, lng)) return { ok: false, reason: 'bad', place: null, arrived: null, left: null, fired: [] };
  if (!explicit && !sharing(userId)) return { ok: false, reason: 'off', place: null, arrived: null, left: null, fired: [] };
  const acc = Number(accuracy);
  if (Number.isFinite(acc) && acc > MAX_ACCURACY_M) return { ok: false, reason: 'inaccurate', place: null, arrived: null, left: null, fired: [] };
  const when = at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now() ? new Date(at).toISOString() : D.nowIso();
  const prev = D.get('SELECT * FROM user_locations WHERE user_id = ?', userId);
  // מיקום ישן יותר ממה שכבר יש (אפליקציית מעקב ששולחת באיחור) — לא מחזיר אחורה
  if (prev && Date.parse(when) < Date.parse(prev.at)) return { ok: true, reason: 'old', place: currentPlace(userId), arrived: null, left: null, fired: [] };
  const prevPlace = prev?.place_id && Date.parse(when) - Date.parse(prev.at) < STALE_MS ? get(prev.place_id) : null;
  const here = placeAt({ lat, lng }, prevPlace?.id ?? null);
  const fired = [];
  let arrived = null;
  let left = null;
  if (prevPlace && prevPlace.id !== here?.id) { left = prevPlace; fired.push(...fire(userId, prevPlace, 'leave')); }
  if (here && here.id !== prevPlace?.id) { arrived = here; fired.push(...fire(userId, here, 'arrive')); }
  if (explicit && !sharing(userId)) {
    // מיקום חד-פעמי ממי שלא משתף: זוכרים רק באיזה מקום הוא (בלי הנקודה עצמה) — כדי שהמיקום הבא לא ייחשב שוב "הגעה"
    D.run(`INSERT INTO user_locations (user_id, lat, lng, accuracy, source, place_id, at) VALUES (?,NULL,NULL,NULL,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET lat = NULL, lng = NULL, accuracy = NULL, source = excluded.source, place_id = excluded.place_id, at = excluded.at`, userId, source, here?.id ?? null, when);
  } else {
    D.run(`INSERT INTO user_locations (user_id, lat, lng, accuracy, source, place_id, at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, source = excluded.source, place_id = excluded.place_id, at = excluded.at`,
    userId, lat, lng, Number.isFinite(acc) ? acc : null, source, here?.id ?? null, when);
  }
  return { ok: true, place: here ? get(here.id) : null, arrived, left, fired };
}

/**
 * המקום שהעובד התכוון אליו ("משרד", "העבודה", "אתר אלעד"). ‎{ place }‎ — מקום אחד; ‎{ kind }‎ — כל מקום מהסוג ("כשאגיע לאתר");
 * ‎null‎ — לא נמצא.
 */
function resolve(name) {
  const n = String(name ?? '').trim().replace(/^ה(?=\S{3,})/, '').replace(/["'״׳]/g, '');
  if (!n) return null;
  const all = list();
  const norm = (s) => String(s).trim().replace(/^ה(?=\S{3,})/, '').replace(/["'״׳]/g, '');
  const exact = all.find((p) => [p.name, ...p.aliases].some((a) => norm(a) === n));
  if (exact) return { place: exact };
  // מילה כללית — כל מקום מהסוג ("כשאגיע לאתר"), ולא האתר הראשון ששמו מתחיל ב"אתר"
  if (/^(?:משרד|עבודה|מקום\s+העבודה|משרדים)$/.test(n)) {
    const offices = all.filter((p) => p.kind === 'office');
    return offices.length === 1 ? { place: offices[0] } : offices.length ? { kind: 'office' } : null;
  }
  if (/^(?:אתר|אתר\s+בנייה|אתר\s+כלשהו|שטח|אתרים)$/.test(n)) return all.some((p) => p.kind === 'site') ? { kind: 'site' } : null;
  const partial = all.filter((p) => [p.name, ...p.aliases].some((a) => norm(a).includes(n) || n.includes(norm(a))));
  return partial.length === 1 ? { place: partial[0] } : null;
}

/*
 * "ל" לפני שם מקום: "המשרד" ← "למשרד" (ה' הידיעה נבלעת), אבל "הרצליה" ← "להרצליה". לא אפשר לדעת תמיד —
 * בולעים רק כשהמילה הראשונה היא שם עצם מוכר של מקום.
 */
const ARTICLE_NOUNS = /^ה(?=(?:משרד|משרדים|אתר|מחסן|מפעל|פרויקט|סניף|מטה|מרכז|בית|מגרש|שטח|חברה|עבודה|מעבדה|אולם)(?:\s|$))/;
const toPlace = (name) => `ל${String(name).replace(ARTICLE_NOUNS, '')}`;

/** "כשתגיע למשרד" / "כשתצא מאתר אלעד" / "כשתגיע לאחד האתרים" */
function phrase(r) {
  const p = r.place_id ? get(r.place_id) : null;
  const where = p ? p.name : r.place_kind === 'office' ? 'המשרד' : 'אחד האתרים';
  return r.place_on === 'leave' ? `כשתצא מ${where}` : `כשתגיע ${toPlace(where)}`;
}

module.exports = {
  KINDS, DEFAULT_RADIUS, STALE_MS,
  distance, parseCoords, toPlace, list, get, create, update, remove, placeAt, resolve, phrase,
  sharing, setSharing, newToken, userByToken, status, currentPlace, report
};
