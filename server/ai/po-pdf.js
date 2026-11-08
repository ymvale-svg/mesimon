'use strict';
/**
 * PDF של הזמנת רכש להתראה למנהל הפרויקט וליוזם הדרישה (‎ai/po-notify.js‎) — מהשדות שבפריוריטי
 * (‎Priority.orderForNotice‎). אינו טופס ההזמנה הרשמי של פריוריטי, ואומר זאת בתחתית העמוד.
 */
const { Pdf } = require('../pdf');

const money = (n) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const ymd = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');

/**
 * @param {object} po     ‎Priority.orderForNotice()‎
 * @param {object} info   ‎{ companyLabel, test, manager, initiators }‎ — שמות לתצוגה
 * @returns {Buffer}
 */
function orderPdf(po, { companyLabel = '', test = false, manager = '', initiators = [], updated = false } = {}) {
  const pdf = new Pdf();
  const M = 40;
  const R = pdf.width - M;
  const W = R - M;
  let y = M;
  const ensure = (need) => { if (y + need > pdf.height - M) { pdf.addPage(); y = M; } };

  if (test) {
    pdf.rect(M, y, W, 24, { fill: '#fde8e8', stroke: '#a33' });
    pdf.text('סביבת בדיקה — אינה הזמנה אמיתית', pdf.width / 2, y + 16, { size: 10, font: 'bold', align: 'center', color: '#a33' });
    y += 40;
  }

  pdf.text(`הזמנת רכש ${po.ORDNAME}${updated ? ' (עודכנה)' : ''}`, R, y, { size: 18, font: 'bold' });
  y += 18;
  pdf.text(`${companyLabel} · סטטוס: ${po.STATDES ?? ''}`, R, y, { size: 10, color: '#555' });
  y += 22;

  const ship = po.ship ?? {};
  // סימני כיוון בלתי נראים (מהעתקה מוואטסאפ) — הגופן מצייר אותם כריבועים
  const clean = (t) => String(t ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const contact = [ship.NAME, ship.PHONENUM, ship.CELLPHONE, ship.ADDRESS, ship.ADDRESS2, ship.ADDRESS3, ship.STATE].map(clean).filter(Boolean).join(' · ');
  const fields = [
    ['ספק', `${po.CDES ?? ''} (${po.SUPNAME ?? ''})`], ['תאריך', ymd(po.CURDATE)],
    ['פרויקט', `${po.PROJDOCNO ?? ''} ${po.PROJDES ?? ''}`.trim()], ['מחסן', po.WARHSNAME ?? ''],
    ['מנהל הפרויקט', manager], ['יוזם הדרישה', initiators.join(', ')],
    ['דרישת רכש', [...new Set([po.PRDNO, ...po.lines.map((l) => l.PRDNO)].filter(Boolean))].join(', ')], ['תנאי תשלום', po.PAYDES ?? ''],
    ...(contact ? [['איש קשר', contact]] : []),
    ...(po.DETAILS ? [['פרטים', po.DETAILS]] : [])
  ].filter(([, v]) => v);
  const colW = W / 2;
  for (let i = 0; i < fields.length; i += 2) {
    let rows = 1;
    for (let j = 0; j < 2 && i + j < fields.length; j++) {
      const [label, value] = fields[i + j];
      const x = R - j * colW;
      const lines = pdf.wrap(String(value), colW - 82, { size: 10 });
      pdf.text(label, x, y, { size: 9, color: '#666' });
      lines.forEach((t, k) => pdf.text(t, x - 74, y + k * 13, { size: 10 }));
      rows = Math.max(rows, lines.length);
    }
    y += 3 + rows * 13;
  }
  y += 8;

  const cols = [
    { key: 'n', title: '#', w: 18 },
    { key: 'part', title: 'פריט', w: 64 },
    { key: 'des', title: 'תיאור', w: 190 },
    { key: 'due', title: 'אספקה', w: 52 },
    { key: 'qty', title: 'כמות', w: 56, num: true },
    { key: 'price', title: 'מחיר', w: 58, num: true },
    { key: 'disc', title: 'הנחה', w: 34, num: true },
    { key: 'total', title: 'סה"כ', w: W - 472, num: true }
  ];
  const header = () => {
    pdf.rect(M, y - 12, W, 18, { fill: '#f0f0f0' });
    let x = R;
    for (const c of cols) { pdf.text(c.title, c.num ? x - c.w + 4 : x - 3, y, { size: 9, font: 'bold', align: c.num ? 'left' : 'right' }); x -= c.w; }
    y += 14;
  };
  header();
  po.lines.forEach((l, i) => {
    const desLines = pdf.wrap(l.PDES ?? '', cols[2].w - 6, { size: 9 });
    const extra = l.REMARK ? pdf.wrap(l.REMARK, cols[2].w - 6, { size: 8 }) : [];
    const h = Math.max(desLines.length + extra.length, 1) * 12 + 6;
    if (y + h > pdf.height - M) { pdf.addPage(); y = M; header(); }
    const cells = {
      n: [String(i + 1)], part: [l.PARTNAME ?? ''], des: [...desLines, ...extra], due: [ymd(l.DUEDATE || l.REQDATE)],
      qty: [`${qty(l.TQUANT)} ${l.TUNITNAME ?? ''}`.trim()], price: [money(l.PRICE)], disc: [l.PERCENT ? `${qty(l.PERCENT)}%` : ''], total: [money(l.QPRICE)]
    };
    let x = R;
    for (const c of cols) {
      cells[c.key].forEach((t, k) => pdf.text(t, c.num ? x - c.w + 4 : x - 3, y + k * 12, {
        size: 9, align: c.num ? 'left' : 'right', color: c.key === 'des' && k >= desLines.length ? '#777' : '#1a1a1a'
      }));
      x -= c.w;
    }
    y += h;
    pdf.line(M, y - 9, R, y - 9);
  });
  y += 6;

  const cur = po.CODE ?? '';
  const totals = [
    ['סה"כ שורות', money(po.QPRICE)],
    ...(po.PERCENT ? [[`הנחת מסמך ${qty(po.PERCENT)}%`, `-${money(po.QPRICE - po.DISPRICE)}`]] : []),
    ['לפני מע"מ', money(po.DISPRICE)],
    ['מע"מ', money(po.VAT)]
  ];
  ensure(totals.length * 15 + 60);
  const tx = M + 230;
  for (const [k, v] of totals) { pdf.text(k, tx, y, { size: 10 }); pdf.text(v, M, y, { size: 10, align: 'left' }); y += 15; }
  pdf.line(M, y - 9, tx, y - 9, { color: '#333', width: 1 });
  y += 4;
  pdf.text(`סה"כ כולל מע"מ ${cur}`.trim(), tx, y, { size: 12, font: 'bold' });
  pdf.text(money(po.TOTPRICE), M, y, { size: 12, font: 'bold', align: 'left' });
  y += 28;

  ensure(20);
  pdf.text('הופק ממשימון מהשדות שבפריוריטי, לידיעה. אינו טופס ההזמנה הרשמי שנשלח לספק.', R, y, { size: 8, color: '#777' });

  return pdf.toBuffer({ title: `הזמנת רכש ${po.ORDNAME}` });
}

module.exports = { orderPdf };
