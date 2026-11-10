'use strict';
/**
 * ↩️ מייל בהמשך לשרשור, ו"+שם" לשרשור קיים (הוחלט 10.11.26, ישראל):
 *
 *   1. "המייל צריך לצאת בהמשך לשרשור האחרון ולא כמייל חדש" — כשיש התכתבות עם הנמען על אותו עניין,
 *      הפנייה יוצאת כתשובה בשרשור (‎In-Reply-To‎, ‎References‎, ‎threadId‎, "Re:"), עם מי שכבר היה בה.
 *      ה-AI בוחר אם זה אותו עניין (‎recentThreads‎ ← ‎reply_thread‎ בטיוטה); מייל חדש — רק לנושא חדש,
 *      או כשהעובד ביקש "מייל חדש".
 *   2. "תוסיף להתכתבות גם את שרי" / "+שרי הרשקוביץ" — אחרי שהמייל כבר יצא: תשובה לכולם בשרשור האחרון,
 *      "+שרי הרשקוביץ" בגוף, והיא בהעתק — כך שהתשובה תגיע לשניים (‎addPeople‎).
 */
const D = require('../core').Db;
const Gmail = require('../integrations').Gmail;
const Mime = require('../core').Mime;
const Mailer = require('../integrations').Mailer;

const THREAD_DAYS = 30;
const addressesIn = (value) => String(value ?? '').split(',').map((x) => Mime.parseAddress(x)).filter((a) => a.address && a.address.includes('@'));
const cleanSubject = (s) => Mime.decodeWords(String(s ?? '')).replace(/^\s*((re|fw|fwd|תשובה|השב|העבר)\s*:\s*)+/i, '').trim();

/** כל הכתובות של העובד — המשתמש, מייל העבודה והתיבות המחוברות */
function mineOf(userId) {
  const u = D.get('SELECT email, work_email FROM users WHERE id = ?', userId) ?? {};
  return new Set([u.email, u.work_email, ...Gmail.emailsOf(userId)].filter(Boolean).map((e) => String(e).toLowerCase()));
}

/**
 * שרשור ב-Gmail ← מה שצריך כדי לענות בו: הנושא, המזהים, מי השתתף. ‎box‎ — מספר התיבה (0 הראשית).
 */
async function threadRef(who, threadId) {
  const msgs = await Gmail.threadMeta(who, threadId);
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  const ids = msgs.map((m) => m.headers['message-id']).filter(Boolean);
  const people = new Map();
  for (const m of msgs) {
    for (const a of [Mime.parseAddress(m.headers.from), ...addressesIn(m.headers.to), ...addressesIn(m.headers.cc)]) {
      if (a.address && !people.has(a.address.toLowerCase())) people.set(a.address.toLowerCase(), { name: Mime.decodeWords(a.name || ''), email: a.address.toLowerCase() });
    }
  }
  const lastFrom = Mime.parseAddress(last.headers.from);
  return {
    box: Gmail.boxOf(who),
    threadId,
    subject: cleanSubject(msgs[0].headers.subject) || cleanSubject(last.headers.subject),
    lastAt: last.at ? last.at.toISOString() : null,
    lastFrom: { name: Mime.decodeWords(lastFrom.name || ''), email: String(lastFrom.address ?? '').toLowerCase() },
    lastTo: addressesIn(last.headers.to).map((a) => ({ name: Mime.decodeWords(a.name || ''), email: a.address.toLowerCase() })),
    lastCc: addressesIn(last.headers.cc).map((a) => ({ name: Mime.decodeWords(a.name || ''), email: a.address.toLowerCase() })),
    inReplyTo: ids[ids.length - 1] ?? null,
    references: ids.slice(-10),
    count: msgs.length,
    people: [...people.values()]
  };
}

/** השרשורים האחרונים עם הנמען (‎THREAD_DAYS‎), מהחדש לישן — לבחירה "בהמשך לשרשור" */
async function recentThreads(userId, email, { max = 3 } = {}) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@"]+@[^\s@"]+$/.test(address)) return [];
  const out = [];
  try {
    for (const who of Gmail.boxesOf(userId, 'mail')) {
      const seen = new Set();
      for (const id of await Gmail.search(who, `{from:${address} to:${address} cc:${address}} newer_than:${THREAD_DAYS}d`, { max: 10 })) {
        const m = await Gmail.messageMeta(who, id);
        if (seen.has(m.threadId)) continue;
        seen.add(m.threadId);
        const ref = await threadRef(who, m.threadId);
        if (ref) out.push(ref);
        if (seen.size >= max) break;
      }
    }
  } catch (err) {
    console.error('[משימון] השרשורים עם הנמען לא נקראו:', err.message);
  }
  return out.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, max);
}

/** לטיוטה: "1. "נושא" · 9.11 · אחרון: מהנמען" — שה-AI יבחר אם זה אותו עניין */
function threadsText(threads) {
  if (!threads.length) return '';
  const dmy = (iso) => (iso ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' }).format(new Date(iso)) : '');
  return [
    'השרשורים האחרונים עם הנמען (לבחירת reply_thread):',
    ...threads.map((t, i) => `${i + 1}. "${t.subject}" · ${t.count} הודעות · אחרונה ${dmy(t.lastAt)} מ-${t.lastFrom.name || t.lastFrom.email}`)
  ].join('\n');
}

/** מי בהעתק כשעונים בשרשור — מי שכבר היה בו, בלי העובד ובלי הנמען (עד 6) */
function threadCc(userId, thread, contactEmail) {
  const skip = new Set([...mineOf(userId), String(contactEmail ?? '').toLowerCase()]);
  return (thread?.people ?? []).filter((p) => !skip.has(p.email)).slice(0, 6);
}

/**
 * המייל האחרון שהעובד שלח (3 ימים), מכל התיבות — לשרשור שאליו מוסיפים אנשים. ‎null‎ — אין
 */
async function latestSent(userId) {
  let best = null;
  for (const who of Gmail.boxesOf(userId, 'mail')) {
    try {
      const [id] = await Gmail.search(who, 'in:sent newer_than:3d', { max: 1 });
      if (!id) continue;
      const m = await Gmail.messageMeta(who, id);
      if (!best || (m.at && m.at > best.at)) best = { who, threadId: m.threadId, at: m.at };
    } catch (err) {
      console.error('[משימון] המייל האחרון שנשלח לא נקרא:', err.message);
    }
  }
  if (!best) return null;
  const ref = await threadRef(best.who, best.threadId);
  return ref ? { ...ref, who: best.who } : null;
}

/**
 * "+שרי הרשקוביץ" — תשובה לכולם בשרשור, והאנשים החדשים בהעתק. אם השרשור שייך למשימת AI — הם נכנסים
 * להעתק שלה (גם לתזכורות), וההודעה נרשמת בה כדי שהתשובות יזוהו.
 */
async function addPeople(userId, thread, people, { note = '' } = {}) {
  const who = Gmail.handle(userId, thread.box ?? 0);
  if (!Gmail.canSend(who)) throw new Error('התיבה שממנה יצא המייל אינה מחוברת עם הרשאת שליחה');
  const fresh = await threadRef(who, thread.threadId) ?? thread;
  const mine = mineOf(userId);
  const sender = Gmail.connectionOf(who);
  const owner = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  // תשובה לכולם: לשולח האחרון, ואם הוא אני — למי שאליו נשלח
  const fromMe = mine.has(fresh.lastFrom.email);
  const to = fromMe ? fresh.lastTo.find((a) => !mine.has(a.email)) : fresh.lastFrom;
  if (!to) throw new Error('לא מצאתי למי לענות בשרשור');
  const ccSet = new Map();
  for (const a of [...(fromMe ? fresh.lastTo : [...fresh.lastTo]), ...fresh.lastCc, ...people]) {
    const e = String(a.email ?? '').toLowerCase();
    if (!e || mine.has(e) || e === to.email) continue;
    ccSet.set(e, { name: a.name ?? '', email: e });
  }
  const cc = [...ccSet.values()].slice(0, 10);
  const text = [`+${people.map((p) => p.name || p.email).join(', +')}`, note].filter(Boolean).join('\n\n');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = await Gmail.signed(who, { text, html: `<div dir="rtl">${esc(text).replace(/\n/g, '<br>')}</div>` });
  const subject = `Re: ${fresh.subject}`;
  const built = Mailer.buildMessage({
    from: sender.email, fromName: owner?.full_name, to: to.email, toName: to.name || undefined,
    cc: cc.map((c) => c.email), inReplyTo: fresh.inReplyTo, references: fresh.references, subject, text: body.text, html: body.html
  });
  const out = await Gmail.send(who, built.raw, { threadId: fresh.threadId });

  // משימת AI על אותו שרשור — האנשים בהעתק שלה, וההודעה ברשימה (התשובות אליה יזוהו)
  const req = D.get(
    `SELECT r.* FROM ai_requests r JOIN ai_messages m ON m.request_id = r.id
      WHERE r.owner_id = ? AND m.channel = 'email' AND m.external_id = ? ORDER BY r.id DESC LIMIT 1`, userId, fresh.threadId);
  if (req) {
    let old = [];
    try { old = JSON.parse(req.cc || '[]'); } catch { /* ריק */ }
    const merged = [...old, ...people.filter((p) => !old.some((o) => o.email === p.email))]
      .filter((c) => c.email && c.email !== req.contact_email && !mine.has(c.email)).slice(0, 10);
    D.run('UPDATE ai_requests SET cc = ?, updated_at = ? WHERE id = ?', JSON.stringify(merged), D.nowIso(), req.id);
    D.run(
      `INSERT INTO ai_messages (request_id, direction, channel, kind, status, subject, body, message_id, external_id, gmail_id, created_at, sent_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.id, 'out', 'email', 'cc_added', 'sent', subject, text, out.messageId ?? built.messageId, out.threadId ?? fresh.threadId, out.gmailId ?? null, D.nowIso(), D.nowIso());
    D.audit(req.task_id, null, 'ai_sent', `נוספו לשרשור: ${people.map((p) => p.name || p.email).join(', ')}`);
  }
  return { to, cc, subject, requestId: req?.id ?? null };
}

module.exports = { recentThreads, threadsText, threadCc, latestSent, addPeople, threadRef, mineOf, cleanSubject };
