'use strict';
/**
 * PDF לבדיקה של קבלת סחורה — מהשדות כפי שנשמרו בפריוריטי (‎Priority.readReceipt‎).
 * אינו טופס ההדפסה הרשמי של פריוריטי, ואומר זאת בראש העמוד.
 */
const { Pdf } = require('../pdf');

const money = (n) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const ymd = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '');

/**
 * @param {object} gr      ‎Priority.readReceipt()‎
 * @param {object} info    ‎{ companyLabel, test, order, dialog: string[], docTotal }‎
 * @returns {Buffer}
 */
function receiptPdf(gr, { companyLabel = '', test = false, order = '', dialog = [], docTotal = null } = {}) {
  const pdf = new Pdf();
  const M = 40;
  const R = pdf.width - M;
  const W = R - M;
  let y = M;

  const ensure = (need) => { if (y + need > pdf.height - M) { pdf.addPage(); y = M; } };

  // פס עליון
  pdf.rect(M, y, W, 24, { fill: '#fff4d6', stroke: '#c98a00' });
  pdf.text('טיוטא לבדיקה — הופק ממשימון מהשדות שהוזנו בפריוריטי. אינו טופס רשמי.', pdf.width / 2, y + 16, { size: 10, font: 'bold', align: 'center', color: '#7a5200' });
  y += 44;

  pdf.text(`קבלת סחורה ${gr.DOCNO}`, R, y, { size: 18, font: 'bold' });
  y += 18;
  pdf.text(`${companyLabel}${test ? ' · סביבת בדיקה' : ''} · סטטוס: ${gr.STATDES ?? ''}`, R, y, { size: 10, color: test ? '#a33' : '#555' });
  y += 22;

  // פרטים — שתי עמודות
  const fields = [
    ['ספק', `${gr.CDES ?? ''} (${gr.SUPNAME ?? ''})`], ['תאריך', ymd(gr.CURDATE)],
    ['מס\' תעודה', gr.BOOKNUM ?? ''], ['הזמנה', order || 'ללא הזמנה'],
    ['פרויקט', `${gr.PROJDOCNO ?? ''} ${gr.PROJDES ?? ''}`.trim()], ['מחסן', gr.TOWARHSNAME ?? '']
  ];
  const colW = W / 2;
  for (let i = 0; i < fields.length; i += 2) {
    let rows = 1;
    for (let j = 0; j < 2 && i + j < fields.length; j++) {
      const [label, value] = fields[i + j];
      const x = R - j * colW;
      const warn = label === 'הזמנה' && !order;
      const lines = pdf.wrap(value, colW - 72, { size: 10 });
      pdf.text(label, x, y, { size: 9, color: '#666' });
      lines.forEach((t, k) => pdf.text(t, x - 62, y + k * 13, { size: 10, color: warn ? '#a33' : '#1a1a1a', font: warn ? 'bold' : 'regular' }));
      rows = Math.max(rows, lines.length);
    }
    y += 3 + rows * 13;
  }
  y += 8;

  // טבלת שורות — מימין לשמאל
  const cols = [
    { key: 'n', title: '#', w: 18 },
    { key: 'part', title: 'פריט', w: 62 },
    { key: 'des', title: 'תיאור', w: 170 },
    { key: 'chap', title: 'תת פרק', w: 70 },
    { key: 'qty', title: 'כמות', w: 50, num: true },
    { key: 'price', title: 'מחיר', w: 55, num: true },
    { key: 'disc', title: 'הנחה', w: 32, num: true },
    { key: 'total', title: 'סה"כ', w: W - 457, num: true }
  ];
  const header = () => {
    pdf.rect(M, y - 12, W, 18, { fill: '#f0f0f0' });
    let x = R;
    for (const c of cols) { pdf.text(c.title, c.num ? x - c.w + 4 : x - 3, y, { size: 9, font: 'bold', align: c.num ? 'left' : 'right' }); x -= c.w; }
    y += 14;
  };
  header();
  gr.lines.forEach((l, i) => {
    const desLines = pdf.wrap(l.PDES, cols[2].w - 6, { size: 9 });
    const chapLines = pdf.wrap(`${l.BUD_SUBCHAPTERNAME ?? ''} ${l.BUD_SUBCHAPTERDES ?? ''}`.trim(), cols[3].w - 6, { size: 9 });
    const chap = [...chapLines, l.BUD_SUBTOPICNAME ?? ''].filter(Boolean);
    const extra = l.ORDNAME ? [`${l.ORDNAME}/${l.OLINE}`] : [];
    const h = Math.max(desLines.length + extra.length, chap.length, 1) * 12 + 6;
    ensure(h + 10);
    if (y + h > pdf.height - M) { pdf.addPage(); y = M; header(); }
    const cells = {
      n: [String(i + 1)], part: [l.PARTNAME ?? ''], des: [...desLines, ...extra], chap,
      qty: [`${qty(l.TQUANT)} ${l.TUNITNAME ?? ''}`.trim()], price: [money(l.PRICE)], disc: [l.PERCENT ? `${qty(l.PERCENT)}%` : ''], total: [money(l.QPRICE)]
    };
    let x = R;
    for (const c of cols) {
      cells[c.key].forEach((t, k) => pdf.text(t, c.num ? x - c.w + 4 : x - 3, y + k * 12, {
        size: 9, align: c.num ? 'left' : 'right', color: (c.key === 'des' && k >= desLines.length) || (c.key === 'chap' && k >= chapLines.length) ? '#777' : '#1a1a1a'
      }));
      x -= c.w;
    }
    y += h;
    pdf.line(M, y - 9, R, y - 9);
  });
  y += 6;

  // סכומים — בצד שמאל
  const totals = [
    ['סה"כ שורות', money(gr.QPRICE)],
    ...(gr.PERCENT ? [[`הנחת מסמך ${qty(gr.PERCENT)}%`, `-${money(gr.QPRICE - gr.DISPRICE)}`]] : []),
    ['לפני מע"מ', money(gr.DISPRICE)],
    ['מע"מ', money(gr.VAT)]
  ];
  ensure(totals.length * 15 + 60);
  const tx = M + 230;
  for (const [k, v] of totals) { pdf.text(k, tx, y, { size: 10 }); pdf.text(v, M, y, { size: 10, align: 'left' }); y += 15; }
  pdf.line(M, y - 9, tx, y - 9, { color: '#333', width: 1 });
  y += 4;
  pdf.text('סה"כ כולל מע"מ', tx, y, { size: 12, font: 'bold' });
  pdf.text(money(gr.TOTPRICE), M, y, { size: 12, font: 'bold', align: 'left' });
  y += 16;
  if (docTotal) {
    const diff = Math.round((gr.TOTPRICE - docTotal) * 100) / 100;
    pdf.text(Math.abs(diff) < 0.01 ? `תואם לסה"כ במסמך (${money(docTotal)})` : `במסמך: ${money(docTotal)} — הפרש ${money(diff)}`, tx, y, { size: 9, color: Math.abs(diff) < 0.01 ? '#2a7a2a' : '#a33' });
    y += 14;
  }
  y += 10;

  // תיבות
  const box = (title, lines) => {
    const wrapped = lines.flatMap((t) => pdf.wrap(t, W - 20, { size: 9 }));
    const h = 28 + wrapped.length * 12;
    ensure(h + 10);
    pdf.rect(M, y, W, h, { stroke: '#cccccc' });
    pdf.text(title, R - 10, y + 15, { size: 10, font: 'bold' });
    wrapped.forEach((t, i) => pdf.text(t, R - 10, y + 29 + i * 12, { size: 9 }));
    y += h + 10;
  };
  if (dialog.length) box('דו-שיח פנימי', dialog);
  box(`נספחים (${gr.files.length})`, gr.files.length ? gr.files.map((f) => `${f.EXTFILENUM}. ${f.EXTFILEDES ?? ''} (${f.SUFFIX ?? ''})`) : ['—']);
  box('לבדיקת המקבל לפני אישור', ['☐ הכמויות הן מה שהתקבל בפועל   ☐ הספק והפרויקט נכונים   ☐ הסכומים תואמים למסמך']);

  ensure(40);
  y += 14;
  pdf.line(R - 220, y, R, y, { color: '#333' });
  pdf.line(M, y, M + 220, y, { color: '#333' });
  pdf.text('שם המאשר', R, y + 12, { size: 9, color: '#555' });
  pdf.text('תאריך ושעה', M + 220, y + 12, { size: 9, color: '#555' });
  pdf.text('אישור בוואטסאפ ("מאשר") הופך את ה-GR לסופי בפריוריטי.', R, y + 30, { size: 8, color: '#777' });

  return pdf.toBuffer({ title: `קבלת סחורה ${gr.DOCNO}` });
}

module.exports = { receiptPdf };
