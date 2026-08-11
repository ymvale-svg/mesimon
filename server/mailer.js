'use strict';
/**
 * שליחת דואר אלקטרוני — לקוח SMTP מינימלי, ללא תלויות חיצוניות.
 *
 * מופעל רק אם הוגדרו משתני הסביבה:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  (ואופציונלי SMTP_FROM, SMTP_SECURE)
 *
 * אם לא הוגדרו — המערכת אינה שולחת דואר, אך ההזמנה עדיין נוצרת
 * והקישור אליה מוצג למנהל להעתקה ידנית. כלומר אף פעולה לא נכשלת בגלל דואר.
 */
const net = require('node:net');
const tls = require('node:tls');

const CONFIG = {
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 587),
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  // שם התצוגה של השולח. ברירת המחדל נגזרת מהארגון בזמן השליחה.
  fromName: process.env.SMTP_FROM_NAME ?? null,
  // 465 הוא TLS מלא מרגע החיבור; 587 מתחיל בטקסט ועובר ל-TLS דרך STARTTLS
  secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : Number(process.env.SMTP_PORT ?? 587) === 465
};

const isEnabled = () => Boolean(CONFIG.host && CONFIG.user && CONFIG.pass);

const status = () => ({
  enabled: isEnabled(),
  host: CONFIG.host || null,
  port: CONFIG.port,
  from: CONFIG.from || null,
  fromName: CONFIG.fromName
});

// ---------------------------------------------------------------------------
// שיחה עם שרת הדואר
// ---------------------------------------------------------------------------

/** עוטף שקע ברשת בממשק של "שלח פקודה, חכה לתשובה" */
function createConversation(socket, timeoutMs) {
  let buffer = '';
  let waiter = null;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    // תשובת SMTP מסתיימת בשורה שבה אחרי הקוד יש רווח ולא מקף
    const match = buffer.match(/^\d{3} [^\n]*\r?\n$|\n\d{3} [^\n]*\r?\n$/);
    if (!match || !waiter) return;
    const response = buffer;
    buffer = '';
    const { resolve } = waiter;
    waiter = null;
    resolve(response);
  });

  const read = () => new Promise((resolve, reject) => {
    waiter = { resolve, reject };
    setTimeout(() => {
      if (waiter?.reject === reject) {
        waiter = null;
        reject(new Error('שרת הדואר לא הגיב בזמן'));
      }
    }, timeoutMs).unref?.();
  });

  return {
    read,
    async send(command, { expect = 2 } = {}) {
      if (command !== null) socket.write(`${command}\r\n`);
      const response = await read();
      const code = Number(response.trim().slice(-response.trim().length).match(/(\d{3})[ -][^\n]*$/)?.[1]
        ?? response.trim().slice(0, 3));
      if (String(code)[0] !== String(expect)) {
        const safe = command && /^AUTH|^[A-Za-z0-9+/=]+$/.test(command) ? '<הושמט>' : command;
        throw new Error(`שרת הדואר דחה את "${safe}": ${response.trim().split('\n').pop()}`);
      }
      return response;
    }
  };
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = (options.secure ? tls : net).connect(options, () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(20000, () => {
      socket.destroy();
      reject(new Error('פסק זמן בחיבור לשרת הדואר'));
    });
  });
}

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

/** קידוד כותרת עם עברית לפי RFC 2047 */
const encodeHeader = (value) =>
  /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;

function formatAddress(address, name) {
  return name ? `${encodeHeader(name)} <${address}>` : address;
}

// ---------------------------------------------------------------------------
// שליחה
// ---------------------------------------------------------------------------

/**
 * @param {{to: string, toName?: string, subject: string, html: string, text: string, fromName?: string}} message
 */
async function send(message) {
  if (!isEnabled()) throw new Error('שליחת דואר אינה מוגדרת במערכת');

  let socket;
  try {
    socket = await connect({ host: CONFIG.host, port: CONFIG.port, secure: CONFIG.secure, servername: CONFIG.host });
    let chat = createConversation(socket, 20000);

    await chat.send(null);                       // ברכת השרת
    await chat.send(`EHLO ${CONFIG.host}`);

    if (!CONFIG.secure) {
      await chat.send('STARTTLS');
      socket = tls.connect({ socket, servername: CONFIG.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      chat = createConversation(socket, 20000);
      await chat.send(`EHLO ${CONFIG.host}`);
    }

    await chat.send('AUTH LOGIN', { expect: 3 });
    await chat.send(b64(CONFIG.user), { expect: 3 });
    await chat.send(b64(CONFIG.pass), { expect: 2 });

    await chat.send(`MAIL FROM:<${CONFIG.from}>`);
    await chat.send(`RCPT TO:<${message.to}>`);
    await chat.send('DATA', { expect: 3 });

    const boundary = `mesimon_${Date.now().toString(36)}`;
    const headers = [
      `From: ${formatAddress(CONFIG.from, CONFIG.fromName ?? message.fromName ?? 'MESIMON')}`,
      `To: ${formatAddress(message.to, message.toName)}`,
      `Subject: ${encodeHeader(message.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ''
    ].filter((line) => line !== null).join('\r\n');

    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(message.text).replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(message.html).replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}--`,
      ''
    ].join('\r\n');

    // נקודה בתחילת שורה היא סימן הסיום בפרוטוקול — חייבים להכפיל אותה
    const payload = `${headers}\r\n${body}`.replace(/\r\n\./g, '\r\n..');
    socket.write(`${payload}\r\n.\r\n`);
    await chat.read();

    await chat.send('QUIT', { expect: 2 }).catch(() => {});
    return true;
  } finally {
    socket?.destroy?.();
  }
}

module.exports = { send, isEnabled, status, CONFIG };
