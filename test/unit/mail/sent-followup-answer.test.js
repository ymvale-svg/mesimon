'use strict';
// סקירה לילית 25.11: שאלה פתוחה "לשלוח תזכורת עדינה ל…?" — והעובדת כתבה בקשה חדשה שמתחילה ב"תשלח":
// "תשלח לנעמה מייל מרוכז של כל הפרוטוקולים…". זה נקרא "כן" — ויצאה תזכורת לנמען אחר, בלי שביקשה.
// "כן" רק כשכל ההודעה היא תשובה ("כן", "תשלח", "כן תשלח לו", הכפתור); בקשה חדשה — ‎null‎ (נושא חדש).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
boot();
const SentFollowup = require('../../../server/mail/sent-followup');

function row(u) {
  return D.run("INSERT INTO sent_followups (user_id, gmail_id, thread_id, to_email, to_name, subject, sent_at, nudge, status, created_at) VALUES (?, ?, 't', 'x@example.test', 'רפי', 'נושא', ?, 'תזכורת', 'asked', ?)",
    u.id, `g${Math.random()}`, D.nowIso(), D.nowIso()).lastInsertRowid;
}

test('בקשה חדשה שמתחילה ב"תשלח" / "לא" — לא תשובה לשאלת התזכורת', () => {
  const u = user({ phone: '972509300001', role: 'employee' });
  const id = row(u);
  for (const t of ['תשלח לנעמה מייל מרוכז של כל הפרוטוקולים שביקשנו לאשר', 'שלח מייל לדני על הפגישה', 'כן תפתח לי משימה לבדוק את החשבון', 'לא קיבלתי את החשבונית מהספק, תבדוק'])
    assert.equal(SentFollowup.answer(u.id, { kind: 'sent_followup', followupId: id }, t), null, t);
  assert.equal(D.get('SELECT status FROM sent_followups WHERE id = ?', id).status, 'asked');
});

test('תשובה — כמו קודם: "כן", "תשלח", "כן תשלח לו", "לשלוח תזכורת ✅", 👍 / "לא", "התעלם 🙈"', () => {
  const u = user({ phone: '972509300002', role: 'employee' });
  for (const t of ['כן', 'תשלח', 'כן תשלח לו', 'שלח את התזכורת', 'לשלוח תזכורת ✅', '👍', 'כן!']) {
    const r = SentFollowup.answer(u.id, { kind: 'sent_followup', followupId: row(u) }, t);
    assert.equal(r?.send, true, t);
  }
  for (const t of ['לא', 'התעלם 🙈', 'לא תודה', '👎']) {
    const id = row(u);
    const r = SentFollowup.answer(u.id, { kind: 'sent_followup', followupId: id }, t);
    assert.match(r?.text ?? '', /לא אזכיר/, t);
  }
});
