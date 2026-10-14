'use strict';
/**
 * קריאת דואר נכנס — לקוח IMAP מינימלי, ללא תלויות.
 *
 * משמש את משימות ה-AI לזיהוי תשובות: המיילים יוצאים עם כתובת תשובה של
 * תיבת המערכת, והתיבה הזו נסרקת כאן. נדרש רק מה שמעקב צריך — כניסה,
 * בחירת תיבה, חיפוש לפי UID ומשיכת הודעה שלמה. ההודעה אינה מסומנת כנקראה
 * (‎BODY.PEEK‎) — מי שפותח את התיבה ביד לא יגלה שהמערכת "קראה" לו דואר.
 *
 * ההגדרות: ‎IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_MAILBOX‎.
 * כשאין ‎IMAP_USER/PASS‎ משתמשים בפרטי ה-SMTP — לרוב זו אותה תיבה.
 * כשאין ‎IMAP_HOST‎ הוא נגזר משרת ה-SMTP אצל הספקים המוכרים.
 */
const tls = require('node:tls');

const KNOWN_HOSTS = {
  'smtp.gmail.com': 'imap.gmail.com',
  'smtp.office365.com': 'outlook.office365.com',
  'smtp-mail.outlook.com': 'outlook.office365.com'
};

function config() {
  const smtpHost = process.env.SMTP_HOST ?? '';
  const derived = KNOWN_HOSTS[smtpHost] ?? (smtpHost.startsWith('smtp.') ? `imap.${smtpHost.slice(5)}` : '');
  return {
    host: process.env.IMAP_HOST || derived,
    hostDerived: !process.env.IMAP_HOST && Boolean(derived),
    port: Number(process.env.IMAP_PORT ?? 993),
    user: process.env.IMAP_USER || process.env.SMTP_USER || '',
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
    mailbox: process.env.IMAP_MAILBOX || 'INBOX'
  };
}

const isEnabled = () => {
  const c = config();
  return Boolean(c.host && c.user && c.pass);
};

const status = () => {
  const c = config();
  return { enabled: isEnabled(), host: c.host || null, hostDerived: c.hostDerived, user: c.user || null, mailbox: c.mailbox };
};

/** מחרוזת מצוטטת לפי התחביר של IMAP */
const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

class Session {
  constructor(cfg) {
    this.cfg = cfg;
    this.buf = Buffer.alloc(0);
    this.partial = null;
    this.items = [];
    this.waiter = null;
    this.seq = 0;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host });
      this.socket.setTimeout(30000, () => this.socket.destroy(new Error('פסק זמן בחיבור לתיבת הדואר')));
      this.socket.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this.pump(); });
      this.socket.on('error', (err) => { this.fail(err); reject(err); });
      this.socket.on('close', () => this.fail(new Error('החיבור לתיבת הדואר נסגר')));
      // הברכה של השרת היא הפריט הראשון
      this.waiter = {
        done: (item) => /^\* (OK|PREAUTH)/i.test(item.text),
        resolve: () => resolve(),
        reject
      };
    });
  }

  fail(err) {
    if (!this.waiter) return;
    const { reject } = this.waiter;
    this.waiter = null;
    reject(err);
  }

  /** מפרק את הזרם לפריטים: שורה, ובתוכה אולי ליטרלים ‎{n}‎ של תוכן בינארי */
  pump() {
    for (;;) {
      const idx = this.buf.indexOf('\r\n');
      if (idx < 0) return;
      const line = this.buf.subarray(0, idx).toString('utf8');
      const item = this.partial ?? { text: '', literals: [] };
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const n = Number(lit[1]);
        if (this.buf.length < idx + 2 + n) return;          // הליטרל עוד לא הגיע במלואו
        item.text += `${line}\0`;
        item.literals.push(Buffer.from(this.buf.subarray(idx + 2, idx + 2 + n)));
        this.buf = this.buf.subarray(idx + 2 + n);
        this.partial = item;
        continue;
      }
      item.text += line;
      this.buf = this.buf.subarray(idx + 2);
      this.partial = null;
      this.items.push(item);
      if (this.waiter?.done(item)) {
        const { resolve } = this.waiter;
        this.waiter = null;
        const collected = this.items;
        this.items = [];
        resolve(collected);
      }
    }
  }

  command(cmd) {
    const tag = `M${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.items = [];
      this.waiter = {
        done: (item) => item.text.startsWith(`${tag} `),
        resolve: (items) => {
          const last = items[items.length - 1].text;
          if (!new RegExp(`^${tag} OK`, 'i').test(last)) {
            const safe = /^LOGIN/i.test(cmd) ? 'LOGIN' : cmd;
            reject(new Error(`תיבת הדואר דחתה את "${safe}": ${last.slice(tag.length + 1)}`));
          } else {
            resolve(items.slice(0, -1));
          }
        },
        reject
      };
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }

  close() {
    try { this.socket.write(`M${++this.seq} LOGOUT\r\n`); } catch { /* ממילא נסגר */ }
    setTimeout(() => this.socket?.destroy(), 500).unref?.();
  }
}

/**
 * מושך את ההודעות החדשות מאז הסריקה הקודמת.
 *
 * @param {{uidValidity?: number, lastUid?: number}} state  נשמר בין סריקות
 * @param {{max?: number}} opts
 * @returns {Promise<{state: object, messages: Array<{uid: number, raw: Buffer}>}>}
 */
async function fetchNew(state = {}, { max = 25 } = {}) {
  if (!isEnabled()) throw new Error('קריאת דואר נכנס אינה מוגדרת');
  const cfg = config();
  const session = new Session(cfg);
  await session.open();
  try {
    await session.command(`LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
    const selected = await session.command(`SELECT ${quote(cfg.mailbox)}`);
    const text = selected.map((i) => i.text).join('\n');
    const uidValidity = Number(/UIDVALIDITY (\d+)/i.exec(text)?.[1] ?? 0);
    const uidNext = Number(/UIDNEXT (\d+)/i.exec(text)?.[1] ?? 0);

    /*
     * סריקה ראשונה, או שהתיבה נבנתה מחדש (UIDVALIDITY השתנה): מתחילים מעכשיו.
     * עיבוד כל הארכיון היה מפעיל את ה-AI על אלפי הודעות ישנות שאינן תשובה לשום דבר.
     */
    if (!state.uidValidity || state.uidValidity !== uidValidity || !state.lastUid) {
      return { state: { uidValidity, lastUid: Math.max(0, uidNext - 1) }, messages: [] };
    }

    const found = await session.command(`UID SEARCH UID ${state.lastUid + 1}:*`);
    const uids = found
      .flatMap((i) => (/^\* SEARCH/i.test(i.text) ? i.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/) : []))
      .map(Number)
      // ‎n:*‎ מחזיר את ההודעה האחרונה גם כשאין חדשות — זה התחביר של IMAP
      .filter((u) => u > state.lastUid)
      .sort((a, b) => a - b)
      .slice(0, max);

    const messages = [];
    let lastUid = state.lastUid;
    for (const uid of uids) {
      const items = await session.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
      const hit = items.find((i) => i.literals.length);
      if (hit) messages.push({ uid, raw: hit.literals[0] });
      lastUid = uid;
    }
    return { state: { uidValidity, lastUid }, messages };
  } finally {
    session.close();
  }
}

/** בדיקת חיבור מהמסך — כניסה ובחירת תיבה, בלי למשוך כלום */
async function test() {
  const cfg = config();
  const session = new Session(cfg);
  await session.open();
  try {
    await session.command(`LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
    await session.command(`EXAMINE ${quote(cfg.mailbox)}`);
    return true;
  } finally {
    session.close();
  }
}

module.exports = { fetchNew, test, isEnabled, status, config };
