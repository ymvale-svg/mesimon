'use strict';
/**
 * המסגרת החזותית של הדואר היוצא מהמערכת.
 *
 * כאן ולא בכל מודול שולח בנפרד, כדי שההזמנה, ההקצאה וכל הודעה עתידית ייראו
 * אותו דבר — ולא ייווצרו שתי גרסאות של אותו לוגו שמתפצלות עם הזמן.
 *
 * הלוגו נבנה מ-HTML ולא מתמונה: לקוחות דואר חוסמים תמונות כברירת מחדל,
 * וכותרת חסומה היא כותרת שלא נראית.
 */

const BRAND = {
  teal: '#0f766e',
  tealDark: '#115e59',
  ink: '#0f172a',
  soft: '#475569',
  mute: '#94a3b8',
  border: '#e2e8f0'
};

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * ‎bodyHtml‎ ו-‎footerHtml‎ נכנסים כ-HTML ולא כטקסט, ולכן על הקורא לברוח
 * מכל ערך שמגיע ממשתמש באמצעות ‎escape‎ שכאן.
 */
function shell({ title, bodyHtml, footerHtml }) {
  return `<!DOCTYPE html>
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
${bodyHtml}
        </td></tr>

        <tr><td style="background:#f8fafc;padding:16px 30px;text-align:center;color:${BRAND.mute};font-size:12px;border-top:1px solid ${BRAND.border};line-height:1.6;">
${footerHtml}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** כפתור הפעולה המרכזי בהודעה */
const button = (href, label) =>
  `          <div style="margin:26px 0;text-align:center;">
            <a href="${escape(href)}" style="display:inline-block;background:${BRAND.teal};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 34px;border-radius:10px;">${escape(label)}</a>
          </div>`;

module.exports = { BRAND, escape, shell, button };
