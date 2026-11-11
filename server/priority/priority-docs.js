'use strict';
/**
 * 🗂 תור המסמכים של משימון פריוריטי — טור המיילים והגרירה (‎/priority/<doc>‎).
 *
 * האפיון: "אפיון — משימון פריוריטי (דשבורד).md".
 *   • **טור המיילים:** מה שסריקת המייל כבר זיהתה בתיבה של העובד עצמו (הוחלט 11.11.26 — רק התיבה שלו) כחשבונית
 *     ספק או תעודת משלוח בקובץ מצורף (‎mail_goods_docs‎, ‎mail-actions.js‎). לכל מייל — ניחוש ("נראה כמו…")
 *     ושלוש תשובות: לקחת לעבודה בפעולה הזו, לקחת כפעולה אחרת, או "לא רלוונטי".
 *   • **גרירה:** PDF או תמונה מהמחשב — נשמר בתיקיית ההעלאות ונכנס לתור.
 *   • **לבוט:** קבלת סחורה ודרישת רכש עובדות היום בוואטסאפ — מסמך מהתור נשלח לבוט, כאילו העובד שלח אותו
 *     ("קבלת סחורה" + הקובץ), והשיחה ממשיכה שם. העבודה מתוך המסך עצמו — השלב הבא.
 *
 * הרשאות: רק מסמך שהעובד מורשה לו (‎priority-access.js‎), ורק המיילים והמסמכים שלו.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../core').Db;
const Access = require('./priority-access');
const MailActions = require('../mail').MailActions;
const WaBot = require('../whatsapp').WaBot;

const ORG = 1;
const MAX_BYTES = 15 * 1024 * 1024;
const INBOX_DAYS = 30;
const DOC_MIME = /^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/i;
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'image/tiff': '.tif', 'image/webp': '.webp' };
const MIME_BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp' };
const BOT_TEXT = { receipt: 'קבלת סחורה', demand: 'דרישת רכש' };
const STAGES = { new: 'התקבל', bot: 'בטיפול בבוט', done: 'הסתיים', rejected: 'נדחה' };

const dir = () => path.join(D.UPLOADS_DIR, 'priority-docs', String(ORG));
const fail = (status, message) => Object.assign(new Error(message), { status });
const actorOf = (user) => ({ type: 'user', id: user.id, role: user.role });

function assertDoc(user, doc) {
  if (!Access.DOC_KEYS.includes(doc)) throw fail(400, 'סוג מסמך לא מוכר');
  if (!Access.can(actorOf(user), doc)) throw fail(403, 'אין לך הרשאה למסמך הזה');
}

/** הניחוש מהסריקה: תעודת משלוח ← קבלת סחורה; חשבונית ← חשבונית ספק (ואפשר גם קבלת סחורה) */
const guessOf = (kind) => (kind === 'delivery_note' ? 'receipt' : 'invoice');
const KIND_LABEL = { invoice: 'חשבונית', delivery_note: 'תעודת משלוח' };

/** טור המיילים — מה שעוד לא טופל (לא נלקח ולא נדחה), מהחדש לישן */
function inbox(user, { limit = 60 } = {}) {
  const since = new Date(Date.now() - INBOX_DAYS * 86400000).toISOString();
  const rows = D.all(
    `SELECT * FROM mail_goods_docs WHERE user_id = ? AND status IN ('pending', 'asked', 'later') AND created_at >= ?
     ORDER BY created_at DESC LIMIT ?`, user.id, since, limit
  );
  return rows.map((r) => ({
    id: r.id, filename: r.filename, mime: r.mime, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? 'מסמך',
    guess: guessOf(r.kind), supplier: r.supplier, fromName: r.from_name, fromEmail: r.from_email, subject: r.subject, at: r.created_at
  }));
}

const shape = (r) => r && ({
  id: r.id, doc: r.doc, source: r.source, filename: r.filename, mime: r.mime, size: r.size,
  supplier: r.supplier, fromName: r.from_name, fromEmail: r.from_email, subject: r.subject,
  stage: r.stage, stageLabel: STAGES[r.stage] ?? r.stage, note: r.note, at: r.created_at, updatedAt: r.updated_at
});

function insert(user, fields) {
  const now = D.nowIso();
  const info = D.run(
    `INSERT INTO priority_docs (org_id, user_id, doc, source, mail_goods_id, filename, mime, size, file_path, supplier, from_name, from_email, subject, stage, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)`,
    ORG, user.id, fields.doc, fields.source, fields.mailGoodsId ?? null, fields.filename ?? '', fields.mime ?? '', fields.size ?? 0, fields.filePath ?? '',
    fields.supplier ?? '', fields.fromName ?? '', fields.fromEmail ?? '', fields.subject ?? '', now, now
  );
  return get(user, Number(info.lastInsertRowid));
}

function rowOf(user, id) {
  const r = D.get('SELECT * FROM priority_docs WHERE id = ? AND org_id = ?', Number(id), ORG);
  if (!r || r.user_id !== user.id) throw fail(404, 'המסמך לא נמצא');
  return r;
}
const get = (user, id) => shape(rowOf(user, id));

/** לקחת מייל לעבודה בפעולה ‎doc‎. המייל יוצא מהטור, והבוט לא ישאל עליו שוב */
function take(user, mailId, doc) {
  assertDoc(user, doc);
  const m = D.get('SELECT * FROM mail_goods_docs WHERE id = ? AND user_id = ?', Number(mailId), user.id);
  if (!m) throw fail(404, 'המייל לא נמצא');
  const dup = D.get("SELECT id FROM priority_docs WHERE mail_goods_id = ? AND user_id = ? AND stage != 'rejected'", m.id, user.id);
  if (dup) return get(user, dup.id);
  D.run("UPDATE mail_goods_docs SET status = 'started', decided_at = ? WHERE id = ?", D.nowIso(), m.id);
  return insert(user, {
    doc, source: 'mail', mailGoodsId: m.id, filename: m.filename, mime: m.mime,
    supplier: m.supplier, fromName: m.from_name, fromEmail: m.from_email, subject: m.subject
  });
}

/** "לא רלוונטי" — המייל יוצא מהטור, והבוט לא ישאל עליו */
function dismiss(user, mailId) {
  const r = D.run("UPDATE mail_goods_docs SET status = 'declined', decided_at = ? WHERE id = ? AND user_id = ? AND status IN ('pending', 'asked', 'later')", D.nowIso(), Number(mailId), user.id);
  if (!r.changes) throw fail(404, 'המייל לא נמצא');
  return true;
}

const safeName = (n) => String(n ?? '').replace(/[\\/\0]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'מסמך';

/** קובץ שנגרר למסך. ‎data‎ — base64 (אפשר עם ‎data:…;base64,‎ בתחילה) */
function upload(user, { doc, filename, mime, data }) {
  assertDoc(user, doc);
  const name = safeName(filename);
  const raw = String(data ?? '');
  const buf = Buffer.from(raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64');
  if (!buf.length) throw fail(400, 'לא נשלח קובץ');
  if (buf.length > MAX_BYTES) throw fail(413, 'הקובץ גדול מ-15MB');
  const type = String(mime || MIME_BY_EXT[path.extname(name).toLowerCase()] || '').toLowerCase();
  if (!DOC_MIME.test(type)) throw fail(400, 'אפשר להעלות PDF או תמונה בלבד');
  fs.mkdirSync(dir(), { recursive: true });
  const file = `${crypto.randomUUID()}${EXT[type] ?? ''}`;
  fs.writeFileSync(path.join(dir(), file), buf);
  return insert(user, { doc, source: 'upload', filename: name, mime: type, size: buf.length, filePath: path.join('priority-docs', String(ORG), file) });
}

/** המסמכים שלי בתור, לפעולה ‎doc‎ (בלי מה שנדחה) */
function list(user, { doc = null } = {}) {
  const rows = doc
    ? D.all("SELECT * FROM priority_docs WHERE org_id = ? AND user_id = ? AND doc = ? AND stage != 'rejected' ORDER BY created_at DESC LIMIT 200", ORG, user.id, doc)
    : D.all("SELECT * FROM priority_docs WHERE org_id = ? AND user_id = ? AND stage != 'rejected' ORDER BY created_at DESC LIMIT 200", ORG, user.id);
  return rows.map(shape);
}

/** כמה מחכים לכל פעולה — לכרטיסים בבית */
function counts(user) {
  const out = Object.fromEntries(Access.DOC_KEYS.map((k) => [k, 0]));
  for (const r of D.all("SELECT doc, COUNT(*) AS n FROM priority_docs WHERE org_id = ? AND user_id = ? AND stage = 'new' GROUP BY doc", ORG, user.id)) out[r.doc] = r.n;
  return out;
}

/** הקובץ עצמו: מהדיסק, ובמסמך ממייל — מ-Gmail בפעם הראשונה (ונשמר לפעמים הבאות) */
async function file(user, id) {
  const r = rowOf(user, id);
  if (r.file_path) {
    const p = path.join(D.UPLOADS_DIR, r.file_path);
    if (fs.existsSync(p)) return { buf: fs.readFileSync(p), mime: r.mime || 'application/octet-stream', name: r.filename };
  }
  if (r.source !== 'mail' || !r.mail_goods_id) throw fail(404, 'הקובץ לא נמצא');
  const m = D.get('SELECT * FROM mail_goods_docs WHERE id = ?', r.mail_goods_id);
  if (!m) throw fail(404, 'המייל כבר לא שמור');
  let f;
  try { f = await MailActions.goodsFile(m); } catch (err) { throw fail(502, `לא הצלחתי להוריד את הקובץ מהמייל: ${err.message}`); }
  fs.mkdirSync(dir(), { recursive: true });
  const type = String(f.mime || r.mime || '').toLowerCase();
  const name = `${crypto.randomUUID()}${EXT[type] ?? path.extname(r.filename)}`;
  fs.writeFileSync(path.join(dir(), name), f.buf);
  D.run('UPDATE priority_docs SET file_path = ?, mime = ?, size = ?, updated_at = ? WHERE id = ?', path.join('priority-docs', String(ORG), name), type, f.buf.length, D.nowIso(), r.id);
  return { buf: f.buf, mime: type || 'application/octet-stream', name: r.filename };
}

/** הוצאה מהתור (לא נוגע בפריוריטי). מייל שהגיע ממנו חוזר לטור */
function remove(user, id) {
  const r = rowOf(user, id);
  if (r.stage === 'done') throw fail(400, 'מסמך שהסתיים לא נמחק מהתור');
  if (r.file_path) { try { fs.unlinkSync(path.join(D.UPLOADS_DIR, r.file_path)); } catch { /* כבר נמחק */ } }
  D.run('DELETE FROM priority_docs WHERE id = ?', r.id);
  if (r.mail_goods_id) D.run("UPDATE mail_goods_docs SET status = 'pending' WHERE id = ? AND status = 'started'", r.mail_goods_id);
  return true;
}

/** שליחה לבוט — קבלת סחורה ודרישת רכש, כאילו העובד שלח את הקובץ בוואטסאפ */
async function toBot(user, id) {
  const r = rowOf(user, id);
  assertDoc(user, r.doc);
  if (!BOT_TEXT[r.doc]) throw fail(400, 'הפעולה הזו עוד לא עובדת בבוט');
  const f = await file(user, id);
  const sent = WaBot.handOver(user.id, { text: BOT_TEXT[r.doc], file: f, id: `priority-doc-${r.id}` });
  if (!sent) throw fail(400, 'אין טלפון בפרופיל שלך במשימון — הבוט לא יודע לאן לענות');
  D.run("UPDATE priority_docs SET stage = 'bot', updated_at = ? WHERE id = ?", D.nowIso(), r.id);
  return get(user, id);
}

module.exports = { STAGES, BOT_TEXT, inbox, take, dismiss, upload, list, counts, get, file, remove, toBot, _guessOf: guessOf };
