'use strict';
/**
 * עזרים לבדיקות השירות של פריוריטי: הבוט מקצה לקצה (‎handleDirect‎) מול עולם מזויף —
 * וואטסאפ, Claude ופריוריטי מ-test/fakes. כל "תור" של העובד מחזיר מה הבוט שלח בתגובה.
 */
const assert = require('node:assert/strict');
const { boot, user: rawUser, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const Bot = require('../../../server/whatsapp/wa-bot');

/** הבוט מוגדר, וקבלת סחורה ודרישת רכש מופעלות לכולם */
function setup() {
  boot();
  Bot.save({ apiUrl: 'http://localhost:9', instanceId: '1', apiToken: 'tok', phone: '0509999999' });
  const on = { enabled: true, audience: 'all', examples: [] };
  D.setSetting('wa_actions', { goods_receipt: on, purchase_demand: on });
}

let seq = 0;
/** עובד עם טלפון (משתמש משימון) */
function worker(o = {}) {
  seq += 1;
  return rawUser({ full_name: `עובד שטח ${seq}`, role: 'employee', phone: `97252${String(1000000 + seq)}`, ...o });
}

/**
 * שעון קבוע לבדיקה אחת — ברירת המחדל: יום שלישי 10:00 בישראל, בתוך שעות העבודה. הודעה יזומה לעובד מחוץ לשעות
 * נשמרת בתור (‎wa_outbox‎) ולא נשלחת מיד, ולכן בדיקה שמצפה לה בוואטסאפ לא תלויה בשעה שבה היא רצה (נכשלו בריצת הערב).
 */
function at(t, iso = '2026-11-10T08:00:00Z') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
}

/** ‎PRIORITY_COMPANIES‎ לבדיקה אחת — מוחזר בסוף הבדיקה */
function companies(t, value) {
  const prev = process.env.PRIORITY_COMPANIES;
  process.env.PRIORITY_COMPANIES = value;
  t.after(() => { process.env.PRIORITY_COMPANIES = prev; });
}

/** המשימה שה-AI התבקש לבצע: "task: extract" בטקסט, או ‎{"task": …}‎ ב-JSON */
function taskOf(opts) {
  const text = (opts?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  try { const j = JSON.parse(text); if (j?.task) return { task: j.task, input: j }; } catch { /* לא JSON */ }
  return { task: text.match(/task:\s*(\w+)/)?.[1] ?? null, input: text };
}

/**
 * Claude מזויף לפי משימה: ‎handlers[task](input, opts)‎. משימה בלי מטפל — הבדיקה נכשלת (לא מנחשים).
 */
function claude(t, handlers) {
  return Fakes.claude(t, (opts) => {
    const { task, input } = taskOf(opts);
    const h = handlers[task];
    if (!h) throw new Error(`AI: אין תשובה מזויפת למשימה ${task}`);
    return h(input, opts);
  });
}

let msgSeq = 0;
/**
 * שיחה עם הבוט בשם העובד. ‎say(text, { file, reaction, on })‎ ← מה הבוט שלח בתגובה לתור הזה:
 * ‎{ texts, text, buttons, last, files, questionId }‎ — ‎buttons‎: הכפתורים שעל ההודעה האחרונה ([] — ההודעה האחרונה בלי כפתורים).
 * תגובה (‎reaction‎) — על ההודעה האחרונה עם כפתורים (השאלה), או על ‎on‎ (מזהה הודעה אחרת). ‎press‎ — לחיצה על כפתור של הודעה מסוימת.
 */
function chat(t, u) {
  const wa = Fakes.whatsapp(t);
  let questionId = null;
  async function say(text, { file = null, reaction = false, on = undefined, press = undefined } = {}) {
    wa.clear();
    msgSeq += 1;
    // ‎press‎ — לחיצה על כפתור של הודעה מסוימת (המזהה שלה)
    const replyTo = press !== undefined ? { id: press, button: true } : reaction ? { id: on === undefined ? questionId ?? '' : on, button: false } : undefined;
    await Bot._internal.handleDirect({ phone: u.phone, chatId: `${u.phone}@c.us`, text, id: `svc${msgSeq}`, file, kind: reaction ? 'reactionMessage' : 'textMessage', replyTo, ...(press !== undefined ? { button: true } : {}) });
    const out = wa.calls.filter((c) => c.method !== 'sendReaction');
    const last = out.at(-1) ?? null;
    const asked = out.filter((c) => c.method === 'sendInteractiveButtonsReply').at(-1);
    if (asked) questionId = asked.id;
    const texts = out.map((c) => c.body?.message ?? c.body?.body ?? '').filter((x) => typeof x === 'string' && x);
    return {
      texts,
      text: texts.join('\n'),
      buttons: last?.method === 'sendInteractiveButtonsReply' ? last.body.buttons.map((b) => b.buttonText) : [],
      last,
      files: out.filter((c) => c.method === 'sendFile'),
      questionId
    };
  }
  return { say, wa };
}

/** צילום מזויף של מסמך */
const photo = (name = 'doc.jpg') => ({ buf: Buffer.from(`fake image ${name}`), mime: 'image/jpeg', name });

/** כללי הכפתורים: 1–3, כל כיתוב עד 20 תווים, בלי כפילויות */
function assertButtons(buttons, expected = null) {
  assert.ok(buttons.length >= 1 && buttons.length <= 3, `1–3 כפתורים, התקבלו ${buttons.length}: ${JSON.stringify(buttons)}`);
  for (const b of buttons) assert.ok(b.length <= 20, `כיתוב ארוך מ-20: ${b}`);
  assert.equal(new Set(buttons).size, buttons.length, `כיתובים כפולים: ${JSON.stringify(buttons)}`);
  if (expected) assert.deepEqual(buttons, expected);
}

module.exports = { setup, worker, companies, at, claude, chat, photo, assertButtons, taskOf, Fakes, D };
