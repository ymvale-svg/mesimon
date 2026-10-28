'use strict';
/**
 * הוואטסאפ האישי → הצעות למשימות ולפגישות.
 *
 * מי שחיבר את הוואטסאפ שלו (Green API) ובחר "להציע משימות מהוואטסאפ שלי":
 * הודעות נכנסות בשיחות **פרטיות** — לא קבוצות; קבוצות נסרקות רק דרך הבוט
 * הארגוני, כדי שאותה הודעה לא תיסרק פעמיים — הופכות להצעות ב"ממתין לאישורך",
 * כמו הצעות מהמייל. בקשה להיפגש — "📅 פגישה לקביעה".
 *
 * פרטיות: מופעל רק בבחירה. גוף ההודעות אינו נשמר — רק ההצעה, השולח והזמן.
 * מספרים ברשימת "לא לסרוק" מדולגים לפני שמשהו נשלח ל-AI.
 *
 * הקריאה עצמה — ב-‎ai-tasks.js‎ (‎pollWhatsApp‎): שם נקרא התור של Green API,
 * מה ששייך למשימת AI הולך למעקב, והשאר מגיע לכאן.
 */
const fs = require('node:fs');
const path = require('node:path');

const D = require('../db');
const W = require('../workdays');
const Claude = require('./claude');
const WhatsApp = require('../whatsapp');

const SKILL = path.join(__dirname, 'skills', 'whatsapp-personal-to-tasks.md');

const prefs = (userId) => {
  const p = D.userPrefs(userId).waScan;
  return { enabled: false, ignore: [], ...(p && typeof p === 'object' ? p : {}) };
};

function setPrefs(userId, { enabled, ignore }) {
  const cur = prefs(userId);
  const next = {
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    ignore: Array.isArray(ignore)
      ? [...new Set(ignore.map((x) => WhatsApp.normalizePhone(x)).filter(Boolean))].slice(0, 200)
      : cur.ignore
  };
  D.setUserPref(userId, 'waScan', next);
  return next;
}

/** מי סורק עכשיו — מחובר, ובחר בזה */
const scanningUsers = () => D.all("SELECT user_id FROM user_prefs WHERE key = 'waScan'")
  .map((r) => r.user_id)
  .filter((id) => prefs(id).enabled && WhatsApp.connectedUsers().includes(id));

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'summary', 'meeting', 'due_date', 'priority', 'checklist'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          meeting: { type: 'boolean' },
          due_date: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
          checklist: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

/**
 * ‎items‎ — הודעות נכנסות שאינן תשובה למשימת AI: ‎{ from, name, text, id, at }‎.
 * הודעות רצופות מאותו אדם נבחנות יחד — "היי" / "אפשר להיפגש?" / "ביום ג׳?".
 */
async function handle(userId, items) {
  const p = prefs(userId);
  if (!p.enabled || !Claude.isEnabled()) return 0;
  const ignore = new Set(p.ignore);
  const bySender = new Map();
  for (const m of items) {
    if (!m.text || ignore.has(m.from)) continue;
    if (!bySender.has(m.from)) bySender.set(m.from, []);
    bySender.get(m.from).push(m);
  }
  const owner = D.get('SELECT full_name FROM users WHERE id = ?', userId);
  let created = 0;
  for (const [from, msgs] of bySender) {
    const name = msgs.find((m) => m.name)?.name || from;
    const colleague = D.get("SELECT full_name FROM users WHERE phone = ? AND status = 'active'", from);
    const today = W.todayIL();
    const text = [
      `תאריך היום: ${today} (${W.hebrewDate(today)})`,
      `בעל הטלפון: ${owner?.full_name ?? ''}`,
      `השולח: ${name}${colleague ? ` (עובד בארגון: ${colleague.full_name})` : ''}`,
      '',
      'ההודעות (מהישנה לחדשה):',
      '<<<',
      ...msgs.map((m) => `${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}: ${String(m.text).slice(0, 2000)}`),
      '>>>'
    ].join('\n');
    let out;
    try {
      out = await Claude.json({ system: fs.readFileSync(SKILL, 'utf8'), content: [{ type: 'text', text }], schema: SCHEMA, effort: 'low' });
    } catch (err) {
      console.error('[משימון] ניתוח הודעת וואטסאפ נכשל:', err.message);
      continue;
    }
    const last = msgs[msgs.length - 1];
    for (const t of (out.tasks ?? []).slice(0, 3)) {
      const title = String(t.title ?? '').trim().slice(0, 120);
      if (!title) continue;
      const headerId = `wap:${userId}:${last.id}`;
      if (D.get('SELECT 1 FROM ai_suggestions WHERE header_id = ? AND user_id = ? AND subject = ?', headerId, userId, title)) continue;
      const data = {
        source: 'whatsapp',
        personal: true,
        title,
        summary: String(t.summary ?? '').trim().slice(0, 1500),
        meeting: t.meeting === true,
        checklist: (t.checklist ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
        dueDate: W.isDate(t.due_date) ? t.due_date : '',
        priority: ['normal', 'high', 'urgent'].includes(t.priority) ? t.priority : 'normal',
        people: [],
        ambiguous: [],
        aiRequest: null,
        warning: '',
        // חלון "מקבוצות הוואטסאפ" מציג את שם הקבוצה — כאן: שם השולח
        groupName: `שיחה פרטית עם ${name}`,
        chatPhone: from,
        receivedAt: new Date(last.at).toISOString()
      };
      D.run(
        `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, created_at)
         VALUES (?, 'task', 'pending', '', ?, ?, '', ?, ?, ?, ?)`,
        userId, headerId, name, title, data.receivedAt, JSON.stringify(data), D.nowIso()
      );
      created++;
    }
  }
  if (created) {
    D.notify({
      targetType: 'user', targetId: userId, kind: 'ai',
      title: `💬 מהוואטסאפ שלך: ${created === 1 ? 'הצעה ממתינה' : `${created} הצעות ממתינות`} לאישורך`,
      body: 'אישור, עריכה או דחייה — ב"ממתין לאישורך".'
    });
  }
  return created;
}

module.exports = { handle, prefs, setPrefs, scanningUsers };
