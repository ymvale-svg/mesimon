'use strict';
/**
 * ערכת עזר מינימלית ל-HTTP — נתב, קריאת גוף הבקשה, עוגיות, הגשת קבצים סטטיים.
 * מחליפה תלות ב-Express; אין שום חבילה חיצונית בפרויקט.
 */
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const unauthorized = (msg = 'נדרשת התחברות מחדש') => new HttpError(401, msg);
const forbidden = (msg = 'אין לך הרשאה לבצע פעולה זו') => new HttpError(403, msg);
const notFound = (msg = 'הפריט המבוקש לא נמצא') => new HttpError(404, msg);

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const MAX_BODY = 60 * 1024 * 1024; // 60MB — קבצים מועלים כ-base64 בתוך JSON

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'הקובץ גדול מדי'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('גוף הבקשה אינו JSON תקין');
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function serveStatic(res, rootDir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const target = path.resolve(rootDir, rel);
  const rootResolved = path.resolve(rootDir);
  if (!target.startsWith(rootResolved)) {
    res.writeHead(403).end();
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  const stat = fs.statSync(target);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache'
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
}

module.exports = {
  Router, HttpError, MIME,
  badRequest, unauthorized, forbidden, notFound,
  parseCookies, readBody, readJson,
  sendJson, sendText, serveStatic, parseUrl
};
