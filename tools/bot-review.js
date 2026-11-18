#!/usr/bin/env node
'use strict';
/**
 * הכלי של הסקירה הלילית (Claude Code) מול משימון — רק שתי פעולות, ורק מול
 * נקודות הקצה של הסקירה (‎server/bot-review.js‎):
 *
 *   node tools/bot-review.js export [--since ISO] [--out file.json]
 *       השיחות עם הבוט מאז ‎since‎ (ברירת מחדל: 24 שעות), מוסוות בשרת.
 *   node tools/bot-review.js report <file.json>
 *       שליחת הדו"ח: נשמר במסך הבוט ונשלח במייל לאדמינים.
 *
 * המפתח נקרא מ-‎BOT_REVIEW_KEY‎ ואינו מודפס לעולם. הכתובת: ‎MESIMON_URL‎, או
 * המערכת בענן. הכלי הזה בלבד מותר בהגדרות ההרשאות (‎.claude/settings.json‎),
 * במקום curl כללי עם המפתח.
 */
const fs = require('node:fs');

const BASE = String(process.env.MESIMON_URL || 'https://mesimon.co.il').replace(/\/+$/, '');
const KEY = String(process.env.BOT_REVIEW_KEY ?? '').trim();

function fail(message) {
  console.error(`bot-review: ${message}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function call(method, path, body) {
  let lastErr;
  // שרת שעולה מחדש (Render) מחזיר 502 לכמה שניות — שלושה ניסיונות
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000)
      });
      const text = await res.text();
      if (res.status >= 500 && attempt < 3) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        if (!res.ok) fail(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        return text;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, attempt * 20000));
  }
  fail(`השרת לא ענה: ${lastErr?.cause?.code || lastErr?.message}`);
}

async function main() {
  if (!KEY) fail('BOT_REVIEW_KEY אינו מוגדר בסביבה');
  const cmd = process.argv[2];
  if (cmd === 'export') {
    const since = arg('--since') || new Date(Date.now() - 86400000).toISOString();
    if (Number.isNaN(Date.parse(since))) fail('--since אינו תאריך תקין (ISO)');
    const text = await call('GET', `/api/integrations/bot-review/export?since=${encodeURIComponent(since)}`);
    const out = arg('--out');
    if (out) {
      fs.writeFileSync(out, text);
      const data = JSON.parse(text);
      console.log(`נשמר ב-${out}: ${data.conversations.length} שיחות, ${data.feedback?.length ?? 0} החלטות קודמות (${data.since} – ${data.until})`);
    } else {
      process.stdout.write(text);
    }
  } else if (cmd === 'report') {
    const file = process.argv[3];
    if (!file || !fs.existsSync(file)) fail('נדרש קובץ JSON של הדו"ח');
    let body;
    try {
      body = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`הקובץ אינו JSON תקין: ${err.message}`);
    }
    console.log(await call('POST', '/api/integrations/bot-review/report', body));
  } else {
    fail('שימוש: export [--since ISO] [--out file] | report <file.json>');
  }
}

main();
