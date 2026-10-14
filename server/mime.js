'use strict';
/**
 * פענוח הודעת דואר נכנסת (RFC 5322 / MIME) — ללא תלויות.
 *
 * מה שנדרש למעקב אחר תשובות, ולא יותר: הכותרות שמזהות שרשור, הטקסט של
 * ההודעה, והקבצים המצורפים. דואר בעברית מגיע בכמה קידודים — UTF-8,
 * windows-1255 ו-ISO-8859-8 — ו-TextDecoder של Node מכיר את כולם.
 */

function decodeBytes(buf, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'iso-8859-8-i' ? 'iso-8859-8' : cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function decodeQuotedPrintable(text, { header = false } = {}) {
  const src = header ? text.replace(/_/g, ' ') : text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // תו שאינו ASCII בטקסט QP אינו תקני, אבל קורה — שומרים אותו כ-UTF-8
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

/** כותרת מקודדת לפי RFC 2047: ‎=?charset?B|Q?...?=‎ */
function decodeWords(value) {
  return String(value ?? '')
    // רווח בין שתי מילים מקודדות אינו חלק מהטקסט
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : decodeQuotedPrintable(data, { header: true });
      return decodeBytes(buf, charset.split('*')[0]);
    });
}

function parseHeaders(text) {
  const headers = {};
  // שורת המשך מתחילה ברווח או בטאב
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

/** ‎text/plain; charset="utf-8"; name=a.pdf‎ → ‎{ value, params }‎, כולל RFC 2231 */
function parseParams(header) {
  const parts = String(header ?? '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const value = parts.shift().trim().toLowerCase();
  const params = {};
  const continued = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    let key = p.slice(0, idx).trim().toLowerCase();
    let val = p.slice(idx + 1).trim().replace(/^"|"$/g, '');
    const star = /\*(\d+)?\*?$/.exec(key);
    if (star) {
      const extended = key.endsWith('*');
      key = key.replace(/\*.*$/, '');
      if (extended && /^[^']*'[^']*'/.test(val)) {
        const [charset, , encoded] = val.split("'");
        continued[key] = { charset, chunks: [...(continued[key]?.chunks ?? []), encoded] };
      } else if (extended) {
        (continued[key] ??= { charset: 'utf-8', chunks: [] }).chunks.push(val);
      } else {
        (continued[key] ??= { charset: null, chunks: [] }).chunks.push(val);
      }
      continue;
    }
    params[key] = decodeWords(val);
  }
  for (const [key, { charset, chunks }] of Object.entries(continued)) {
    const joined = chunks.join('');
    params[key] = charset ? decodeBytes(unescapeBytes(joined), charset) : joined;
  }
  return { value, params };
}

/** ‎%D7%A9‎ → בתים, בלי לעבור דרך decodeURIComponent שמניח UTF-8 */
function unescapeBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function splitHeadBody(buf) {
  const text = buf.toString('latin1');
  let idx = text.indexOf('\r\n\r\n');
  let sep = 4;
  if (idx < 0) { idx = text.indexOf('\n\n'); sep = 2; }
  if (idx < 0) return { head: text, body: Buffer.alloc(0) };
  return { head: text.slice(0, idx), body: buf.subarray(idx + sep) };
}

function decodeBody(buf, encoding) {
  const enc = String(encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(buf.toString('latin1'));
  return buf;
}

/** מפרק חלק MIME (רקורסיבית) ומוסיף לרשימות הטקסט והקבצים */
function walk(buf, out, depth = 0) {
  if (depth > 8) return;
  const { head, body } = splitHeadBody(buf);
  const headers = parseHeaders(decodeBytes(Buffer.from(head, 'latin1'), 'utf-8'));
  const type = parseParams(headers['content-type'] ?? 'text/plain');
  const disposition = parseParams(headers['content-disposition'] ?? '');

  if (type.value.startsWith('multipart/') && type.params.boundary) {
    const boundary = `--${type.params.boundary}`;
    const raw = body.toString('latin1');
    const pieces = raw.split(boundary).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      walk(Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1'), out, depth + 1);
    }
    return;
  }

  if (type.value === 'message/rfc822') {
    walk(decodeBody(body, headers['content-transfer-encoding']), out, depth + 1);
    return;
  }

  const filename = disposition.params.filename ?? type.params.name ?? null;
  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  const isText = type.value === 'text/plain' || type.value === 'text/html';

  if (filename || (disposition.value === 'attachment') || !isText) {
    // תמונות מוטמעות בחתימה (לוגו) אינן מסמך שהתבקש
    const inlineImage = disposition.value === 'inline' && type.value.startsWith('image/') && decoded.length < 40 * 1024;
    if (!inlineImage && decoded.length) {
      out.attachments.push({
        filename: filename || `attachment.${(type.value.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '')}`,
        mime: type.value || 'application/octet-stream',
        data: decoded
      });
    }
    return;
  }

  const text = decodeBytes(decoded, type.params.charset);
  if (type.value === 'text/plain') out.plain.push(text);
  else out.html.push(text);
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * הטקסט החדש בלבד, בלי הציטוט של ההודעה הקודמת. התשובה של הנמען היא מה
 * שנמצא מעל "בתאריך ... נכתב:" או "On ... wrote:" — מה שמתחת הוא המייל שלנו.
 */
function stripQuoted(text) {
  const lines = String(text).split(/\r?\n/);
  const markers = [
    /^On .{4,200} wrote:\s*$/i,
    /^ב?תאריך .{4,200}(נכתב|כתב|כתבה)\s*:?\s*$/,
    /^-{2,}\s*(Original Message|הודעה מקורית)\s*-{2,}/i,
    /^(From|מאת)\s*:\s.+/i,
    /^_{8,}\s*$/
  ];
  const out = [];
  for (const line of lines) {
    if (markers.some((m) => m.test(line.trim()))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** כתובת דואר מתוך ‎"שם" <a@b.c>‎ */
function parseAddress(value) {
  const decoded = decodeWords(value ?? '');
  const m = /<([^>]+)>/.exec(decoded);
  const address = (m ? m[1] : decoded).trim().toLowerCase();
  const name = m ? decoded.slice(0, m.index).trim().replace(/^"|"$/g, '') : '';
  return { address, name };
}

const messageIds = (value) => (String(value ?? '').match(/<[^<>\s]+>/g) ?? []);

/**
 * @param {Buffer} raw  ההודעה כפי שהתקבלה מהשרת
 */
function parse(raw) {
  const { head } = splitHeadBody(raw);
  const headers = parseHeaders(decodeBytes(Buffer.from(head, 'latin1'), 'utf-8'));
  const out = { plain: [], html: [], attachments: [] };
  walk(raw, out);

  const fullText = out.plain.length ? out.plain.join('\n') : htmlToText(out.html.join('\n'));
  return {
    from: parseAddress(headers.from),
    to: String(headers.to ?? ''),
    cc: String(headers.cc ?? ''),
    subject: decodeWords(headers.subject ?? ''),
    date: headers.date ? new Date(headers.date) : null,
    messageId: messageIds(headers['message-id'])[0] ?? null,
    inReplyTo: messageIds(headers['in-reply-to']),
    references: messageIds(headers.references),
    // מענה אוטומטי מסמן את עצמו — RFC 3834, ובמערכות של מיקרוסופט כותרת משלהן
    autoSubmitted: /auto-replied|auto-generated/i.test(headers['auto-submitted'] ?? '')
      || Boolean(headers['x-autoreply'] || headers['x-autorespond'])
      || /^(auto|bulk|junk)/i.test(headers.precedence ?? ''),
    text: fullText.trim(),
    newText: stripQuoted(fullText),
    attachments: out.attachments
  };
}

module.exports = { parse, decodeWords, parseAddress, htmlToText, stripQuoted };
