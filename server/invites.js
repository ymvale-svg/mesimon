'use strict';
/**
 * הזמנות למערכת.
 *
 * כשנוסף משתמש או ספק, נוצר קישור חד-פעמי שבו הוא קובע לעצמו סיסמה,
 * ונשלח אליו דואר. עדיף על שליחת סיסמה בדואר — הסיסמה לא עוברת בשום ערוץ.
 *
 * אם שליחת הדואר אינה מוגדרת או נכשלת, ההזמנה עדיין נוצרת והקישור מוצג
 * למנהל להעברה ידנית. הוספת משתמש לעולם לא נכשלת בגלל תקלת דואר.
 */
const crypto = require('node:crypto');
const D = require('./db');
const Mailer = require('./mailer');

const TTL_DAYS = 14;

const BRAND = {
  teal: '#0f766e',
  tealDark: '#115e59',
  ink: '#0f172a',
  soft: '#475569',
  mute: '#94a3b8',
  border: '#e2e8f0'
};

// ---------------------------------------------------------------------------
// יצירה ומימוש
// ---------------------------------------------------------------------------

function create(targetType, targetId, invitedBy) {
  // הזמנה חדשה מבטלת הזמנות קודמות שטרם מומשו לאותו חשבון
  D.run('DELETE FROM invites WHERE target_type = ? AND target_id = ? AND used_at IS NULL', targetType, targetId);

  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  D.run(
    'INSERT INTO invites (token, target_type, target_id, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    token, targetType, targetId, invitedBy ?? null, D.nowIso(), expires.toISOString()
  );
  return { token, expiresAt: expires.toISOString() };
}

function find(token) {
  const invite = D.get('SELECT * FROM invites WHERE token = ?', String(token ?? ''));
  if (!invite) return { error: 'ההזמנה אינה קיימת. ייתכן שכבר נעשה בה שימוש.' };
  if (invite.used_at) return { error: 'ההזמנה כבר מומשה. אפשר להתחבר עם הסיסמה שנקבעה.' };
  if (invite.expires_at < D.nowIso()) return { error: 'תוקף ההזמנה פג. יש לבקש הזמנה חדשה ממנהל המערכת.' };

  const account = invite.target_type === 'user'
    ? D.get('SELECT id, full_name AS name, email, status FROM users WHERE id = ?', invite.target_id)
    : D.get('SELECT id, name, email, status FROM vendors WHERE id = ?', invite.target_id);

  if (!account) return { error: 'החשבון המשויך להזמנה אינו קיים עוד.' };
  if (account.status !== 'active') return { error: 'החשבון אינו פעיל. פנה למנהל המערכת.' };

  const inviter = invite.invited_by
    ? D.get('SELECT full_name FROM users WHERE id = ?', invite.invited_by)?.full_name ?? null
    : null;

  return { invite, account, inviter };
}

/** קובע את הסיסמה ומסמן את ההזמנה כמומשה */
function redeem(token, password) {
  const found = find(token);
  if (found.error) return found;

  const { invite, account } = found;
  const table = invite.target_type === 'user' ? 'users' : 'vendors';
  D.run(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, D.hashPassword(password), account.id);
  D.run('UPDATE invites SET used_at = ? WHERE token = ?', D.nowIso(), invite.token);

  return { actorType: invite.target_type, id: account.id };
}

const url = (base, token) => `${String(base).replace(/\/+$/, '')}/invite/${token}`;

// ---------------------------------------------------------------------------
// תוכן ההזמנה
// ---------------------------------------------------------------------------

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * גוף ההזמנה. הלוגו של המערכת נבנה מ-HTML ולא מתמונה, כי לקוחות דואר
 * חוסמים תמונות כברירת מחדל — וכותרת חסומה היא כותרת שלא נראית.
 */
function buildEmail({ recipientName, inviterName, orgName, link, isVendor, replyTo }) {
  const title = `הוזמנת ל־MESIMON — ${orgName}`;

  // כתובת השולח היא noreply שאין מאחוריה תיבת דואר. אם הוגדרה כתובת לתשובה,
  // תשובה של הנמען מגיעה לאדם ולכן מזמינים אותו להשיב; ואם לא — חייבים לומר
  // לו שאין להשיב, אחרת הוא יכתוב לתהום ויניח שקיבלנו.
  const replyNote = replyTo
    ? `בשאלות אפשר להשיב להודעה זו — התשובה תגיע ל${inviterName}.`
    : 'זו הודעה אוטומטית מכתובת שאינה מנוטרת. אין להשיב להודעה זו.';

  const intro = isVendor
    ? `${escape(inviterName)} הזמין/ה אותך לפורטל הספקים של ${escape(orgName)}. דרכו תקבל/י את המשימות שהוקצו לך, תוכל/י להעלות תוצרים ולעקוב אחר הסטטוס.`
    : `${escape(inviterName)} הזמין/ה אותך למערכת ניהול המשימות והפרויקטים של ${escape(orgName)}.`;

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.border};">

        <tr><td style="background:${BRAND.tealDark};background-image:linear-gradient(135deg,${BRAND.tealDark},${BRAND.teal});padding:34px 30px;text-align:center;">
          <div style="display:inline-block;width:54px;height:54px;line-height:54px;border-radius:15px;background:#ffffff;color:${BRAND.teal};font-size:28px;font-weight:800;">&#10003;</div>
          <div style="margin-top:14px;color:#ffffff;font-size:30px;font-weight:800;letter-spacing:6px;">MESIMON</div>
          <div style="margin-top:6px;color:#ffffff;opacity:.9;font-size:14px;">משימות שעובדות בשבילך</div>
        </td></tr>

        <tr><td style="padding:32px 34px;color:${BRAND.ink};font-size:15px;line-height:1.75;" dir="rtl">
          <div style="font-size:20px;font-weight:700;margin-bottom:14px;">שלום ${escape(recipientName)},</div>
          <div style="color:${BRAND.soft};">${intro}</div>

          <div style="margin:26px 0;text-align:center;">
            <a href="${escape(link)}" style="display:inline-block;background:${BRAND.teal};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 34px;border-radius:10px;">כניסה וקביעת סיסמה</a>
          </div>

          <div style="color:${BRAND.mute};font-size:12.5px;border-top:1px solid ${BRAND.border};padding-top:16px;">
            הקישור אישי ותקף ל־${TTL_DAYS} ימים. אם הכפתור אינו עובד, אפשר להעתיק את הכתובת:
            <div style="direction:ltr;text-align:left;word-break:break-all;color:${BRAND.soft};margin-top:6px;">${escape(link)}</div>
          </div>
        </td></tr>

        <tr><td style="background:#f8fafc;padding:16px 30px;text-align:center;color:${BRAND.mute};font-size:12px;border-top:1px solid ${BRAND.border};line-height:1.6;">
          ${escape(orgName)} · נשלח אוטומטית מ־MESIMON.<br>
          ${escape(replyNote)}<br>
          אם ההזמנה אינה מיועדת לך, אפשר להתעלם מהודעה זו.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `MESIMON — משימות שעובדות בשבילך`,
    '',
    `שלום ${recipientName},`,
    isVendor
      ? `${inviterName} הזמין/ה אותך לפורטל הספקים של ${orgName}.`
      : `${inviterName} הזמין/ה אותך למערכת ניהול המשימות של ${orgName}.`,
    '',
    'לכניסה ולקביעת סיסמה:',
    link,
    '',
    `הקישור אישי ותקף ל־${TTL_DAYS} ימים.`,
    '',
    replyNote
  ].join('\n');

  return { subject: title, html, text };
}

/**
 * יוצר הזמנה ומנסה לשלוח אותה בדואר.
 * לעולם לא זורק — כישלון בדואר אינו אמור להפיל הוספת משתמש.
 */
async function createAndSend({ targetType, targetId, email, recipientName, inviter, baseUrl }) {
  const { token, expiresAt } = create(targetType, targetId, inviter?.id);
  const link = url(baseUrl, token);
  const orgName = D.getSetting('org_name', 'הארגון');

  const result = { link, expiresAt, emailSent: false, emailError: null };

  if (!Mailer.isEnabled()) {
    result.emailError = 'שליחת דואר אינה מוגדרת במערכת';
    return result;
  }

  try {
    const message = buildEmail({
      recipientName,
      inviterName: inviter?.name ?? 'מנהל המערכת',
      orgName,
      link,
      isVendor: targetType === 'vendor',
      // אותה כתובת שנכנסת לכותרת Reply-To, כדי שהטקסט לא יסתור את ההתנהגות
      replyTo: inviter?.email ?? process.env.SMTP_REPLY_TO ?? null
    });
    await Mailer.send({
      to: email,
      toName: recipientName,
      fromName: `MESIMON · ${orgName}`,
      // תשובה תגיע למי שהזמין, ולא לכתובת noreply שאין מאחוריה תיבה
      replyTo: inviter?.email ?? null,
      replyToName: inviter?.name ?? null,
      ...message
    });
    result.emailSent = true;
  } catch (err) {
    result.emailError = err.message;
    console.error('[משימון] שליחת ההזמנה נכשלה:', err.message);
  }

  return result;
}

module.exports = { create, find, redeem, url, buildEmail, createAndSend, TTL_DAYS };
