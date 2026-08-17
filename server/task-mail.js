'use strict';
/**
 * דואר על משימות — כרגע הודעה למי שהוגדר אחראי על משימה.
 *
 * ההתראה בתוך המערכת אינה מספיקה: מי שאינו מחובר באותו רגע אינו יודע שהוקצתה
 * לו משימה עד שייכנס, ובדיוק בשביל זה יש דואר.
 *
 * לעולם לא זורק. תקלת דואר אינה אמורה להפיל יצירת משימה או שינוי אחראי —
 * ההתראה בתוך המערכת ממילא נשמרה, והשגיאה נרשמת ליומן השרת.
 */
const D = require('./db');
const Mailer = require('./mailer');
const { BRAND, escape, shell, button } = require('./mail-templates');

/** כתובת המערכת כפי שמשתמשים מגיעים אליה — בלעדיה אין קישור לשלוח */
function baseUrl() {
  const configured = String(D.getSetting('public_url', '') ?? '').trim();
  return configured.replace(/\/+$/, '');
}

const PRIORITY_LABELS = { urgent: 'דחוף', high: 'גבוה', normal: 'רגיל', low: 'נמוך' };

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('he-IL');
}

function buildEmail({ recipientName, assignerName, orgName, task, projectName, statusLabel, link, replyTo }) {
  const title = `הוקצתה לך משימה: ${task.title}`;
  const due = formatDate(task.due_date);

  // שורות הפרטים נבנות רק כשיש להן תוכן — טבלה עם "—" בכל שורה אינה מוסיפה דבר
  const rows = [
    ['משימה', task.title],
    ['פרויקט', projectName],
    ['סטטוס', statusLabel],
    ['עדיפות', PRIORITY_LABELS[task.priority] ?? task.priority],
    ['תאריך יעד', due],
    ['הוקצתה על ידי', assignerName]
  ].filter(([, value]) => value);

  const detailsHtml = rows.map(([label, value]) => `
            <tr>
              <td style="padding:5px 0;color:${BRAND.mute};font-size:13px;white-space:nowrap;">${escape(label)}</td>
              <td style="padding:5px 0 5px 14px;color:${BRAND.ink};font-size:13.5px;font-weight:600;">${escape(value)}</td>
            </tr>`).join('');

  const description = task.description
    ? `          <div style="margin-top:18px;color:${BRAND.soft};white-space:pre-wrap;border-top:1px solid ${BRAND.border};padding-top:14px;">${escape(task.description)}</div>`
    : '';

  /**
   * בלי כתובת מערכת מוגדרת אין קישור אמיתי לשלוח, ולכן במקום כפתור שבור
   * נאמר לנמען איפה למצוא את המשימה. את הכתובת קובעים בהגדרות המערכת.
   */
  const action = link
    ? button(link, 'פתיחת המשימה')
    : `          <div style="margin:22px 0;color:${BRAND.mute};font-size:13px;">המשימה מחכה לך במערכת, תחת "המשימות שלי".</div>`;

  const replyNote = replyTo
    ? `בשאלות אפשר להשיב להודעה זו — התשובה תגיע ל${assignerName}.`
    : 'זו הודעה אוטומטית מכתובת שאינה מנוטרת. אין להשיב להודעה זו.';

  const html = shell({
    title,
    bodyHtml: `          <div style="font-size:20px;font-weight:700;margin-bottom:6px;">שלום ${escape(recipientName)},</div>
          <div style="color:${BRAND.soft};">${escape(assignerName)} הגדיר/ה אותך כאחראי/ת על משימה חדשה.</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;width:100%;">${detailsHtml}
          </table>
${description}
${action}`,
    footerHtml: `          ${escape(orgName)} · נשלח אוטומטית מ־MESIMON.<br>
          ${escape(replyNote)}`
  });

  const text = [
    'MESIMON — משימות שעובדות בשבילך',
    '',
    `שלום ${recipientName},`,
    `${assignerName} הגדיר/ה אותך כאחראי/ת על משימה חדשה.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(task.description ? ['', task.description] : []),
    ...(link ? ['', 'לפתיחת המשימה:', link] : ['', 'המשימה מחכה לך במערכת, תחת "המשימות שלי".']),
    '',
    replyNote
  ].join('\n');

  return { subject: title, html, text };
}

/**
 * שולח הודעה למי שהוגדר אחראי. מחזיר ‎true‎ אם הדואר יצא.
 * ‎assigner‎ הוא מי שביצע את ההקצאה — לא שולחים למי שהקצה לעצמו.
 */
async function sendAssignment({ task, assigneeType, assigneeId, assigner }) {
  if (!Mailer.isEnabled()) return false;

  // ספק מקבל דואר רק על משימות שהוקצו לו; שאר המיעון זהה
  const recipient = assigneeType === 'vendor'
    ? D.get('SELECT name AS full_name, email FROM vendors WHERE id = ? AND status = ?', assigneeId, 'active')
    : D.get('SELECT full_name, email FROM users WHERE id = ? AND status = ?', assigneeId, 'active');
  if (!recipient?.email) return false;

  // מי שהקצה לעצמו יודע — אין טעם לשלוח לו דואר על מה שהוא בדיוק עשה
  if (assigner && assigneeType !== 'vendor' && assigner.id === assigneeId) return false;

  try {
    const orgName = D.getSetting('org_name', 'הארגון');
    const root = baseUrl();
    const message = buildEmail({
      recipientName: recipient.full_name,
      assignerName: assigner?.name ?? 'המערכת',
      orgName,
      task,
      projectName: task.project_id
        ? D.get('SELECT name FROM projects WHERE id = ?', task.project_id)?.name ?? null
        : null,
      statusLabel: D.get('SELECT label FROM board_columns WHERE board_id = ? AND key = ?', task.board_id, task.status)?.label ?? null,
      link: root ? `${root}/?task=${task.id}` : null,
      replyTo: assigner?.email ?? null
    });
    await Mailer.send({
      to: recipient.email,
      toName: recipient.full_name,
      fromName: `MESIMON · ${orgName}`,
      // תשובה מגיעה למי שהקצה, ולא לכתובת noreply שאין מאחוריה תיבה
      replyTo: assigner?.email ?? null,
      replyToName: assigner?.name ?? null,
      ...message
    });
    return true;
  } catch (err) {
    console.error('[משימון] שליחת הודעת ההקצאה נכשלה:', err.message);
    return false;
  }
}

module.exports = { sendAssignment, buildEmail };
