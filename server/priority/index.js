'use strict';
/**
 * פריוריטי — קבלת סחורה, דרישת רכש, אישורים, הזמנות רכש, בקשות להצעת מחיר.
 *
 * קובץ הכניסה של התחום — הדרך היחידה לגשת אליו מתחום אחר: ‎const { X } = require('../priority')‎.
 * כל מודול נטען רק כשמבקשים אותו (getter), כך שסדר הטעינה זהה לייבוא ישיר.
 * קבצים בתוך התחום מייבאים זה את זה ישירות.
 */
module.exports = {
  get GoodsReceipt() { return require('./goods-receipt'); },
  get GrPdf() { return require('./gr-pdf'); },
  get PurchaseDemand() { return require('./purchase-demand'); },
  get PriorityPrefs() { return require('./priority-prefs'); },
  get PrioritySettings() { return require('./priority-settings'); },
  get PriorityAccess() { return require('./priority-access'); },
  get PriorityDocs() { return require('./priority-docs'); },
  get PriorityChain() { return require('./priority-chain'); },
  get PriorityDesk() { return require('./priority-desk'); },
  get PriorityApprovals() { return require('./priority-approvals'); },
  get PoNotify() { return require('./po-notify'); },
  get PoPdf() { return require('./po-pdf'); },
  get Rfq() { return require('./rfq'); }
};
