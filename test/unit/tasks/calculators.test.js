'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../../server/agents/calculators');

const pay = (input) => C.run('calc_payroll', input);
const ptax = (input) => C.run('calc_purchase_tax', input);
const fine = (input) => C.run('calc_fine_deadlines', input);
const urban = (input) => C.run('calc_urban_renewal_majority', input);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ---------------------------------------------------------------------------
// TOOLS ו-run
// ---------------------------------------------------------------------------

test('TOOLS — ארבעה כלים בפורמט Anthropic', () => {
  assert.deepEqual(C.TOOLS.map((t) => t.name).sort(),
    ['calc_fine_deadlines', 'calc_payroll', 'calc_purchase_tax', 'calc_urban_renewal_majority']);
  for (const t of C.TOOLS) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.input_schema.type, 'object');
    assert.ok(Array.isArray(t.input_schema.required), t.name);
  }
});

test('TOOLS — כל שדה חובה מוגדר ב-properties', () => {
  for (const t of C.TOOLS) {
    for (const k of t.input_schema.required) assert.ok(k in t.input_schema.properties, `${t.name}.${k}`);
  }
});

test('run — מחשבון לא מוכר', () => {
  assert.throws(() => C.run('calc_nope', {}), /מחשבון לא מוכר: calc_nope/);
  assert.throws(() => C.run('toString', {}), /מחשבון לא מוכר/);
});

test('run — קלט שאינו אובייקט', () => {
  assert.throws(() => pay([1]), /הקלט חייב להיות אובייקט/);
  assert.throws(() => pay('10000'), /הקלט חייב להיות אובייקט/);
});

// ---------------------------------------------------------------------------
// שכר
// ---------------------------------------------------------------------------

test('שכר — 10,000 ברוטו, ברירות מחדל', () => {
  const r = pay({ gross_monthly: 10000 });
  // מס: 7010×10% + 2990×14% = 1119.6, פחות 2.25×242 נקודות ופחות זיכוי פנסיה 210
  assert.equal(r.pension_employee, 600);
  assert.equal(r.pension_credit, 210);
  assert.equal(r.income_tax, 365.1);
  // ב"ל: 7703×1.04% + 2297×7%; בריאות: 7703×3.23% + 2297×5.17%
  assert.equal(r.bituach_leumi, 240.9);
  assert.equal(r.health_tax, 367.56);
  assert.equal(r.net_salary, 8426.44);
  assert.equal(r.imputed_employer_deposits, 0);
  assert.equal(r.credit_points, 2.25);
  assert.equal(r.has_pension, true);
  assert.equal(r.ni_category, 'standard');
});

test('שכר — עלות מעסיק ל-10,000', () => {
  const e = pay({ gross_monthly: 10000 }).employer;
  assert.equal(e.employer_ni, 521.98); // 7703×4.51% + 2297×7.6%
  assert.equal(e.employer_pension, 650);
  assert.equal(e.employer_severance, 600);
  assert.equal(e.employer_keren, 0);
  assert.equal(e.total_employer_cost, 11771.98);
});

test('שכר — נטו = ברוטו פחות כל הניכויים', () => {
  const r = pay({ gross_monthly: 23456.78, credit_points: 2.75 });
  close(r.net_salary, r.gross_salary - r.income_tax - r.bituach_leumi - r.health_tax - r.pension_employee - r.keren_employee, 0.011);
});

test('שכר — שכר נמוך: אין מס הכנסה', () => {
  assert.equal(pay({ gross_monthly: 5000 }).income_tax, 0);
  assert.equal(pay({ gross_monthly: 0 }).net_salary, 0);
});

test('שכר — בלי פנסיה: אין ניכוי ואין זיכוי', () => {
  const r = pay({ gross_monthly: 10000, has_pension: false });
  assert.equal(r.pension_employee, 0);
  assert.equal(r.pension_credit, 0);
  assert.equal(r.employer.employer_pension, 0);
  assert.equal(r.employer.employer_severance, 0);
  // 1119.6 − 544.5
  assert.equal(r.income_tax, 575.1);
});

test('שכר — שווי רכב נכנס לבסיס המס ולא לנטו במזומן', () => {
  const base = pay({ gross_monthly: 10000 });
  const car = pay({ gross_monthly: 10000, shovi_rechev: 3000 });
  assert.equal(car.taxable_gross, 13000);
  assert.ok(car.income_tax > base.income_tax);
  assert.ok(car.net_salary < base.net_salary);
  assert.equal(car.pension_employee, base.pension_employee);
});

test('שכר — תקרת ביטוח לאומי', () => {
  const a = pay({ gross_monthly: 60000 });
  const b = pay({ gross_monthly: 90000 });
  assert.equal(a.bituach_leumi, b.bituach_leumi);
  assert.equal(a.health_tax, b.health_tax);
  assert.equal(a.rates.ni_full_ceiling, 51910);
});

test('שכר — מתחת ל-18: בלי פנסיה ובלי ב"ל לעובד', () => {
  const r = pay({ gross_monthly: 4000, ni_category: 'under-18' });
  assert.equal(r.has_pension, false);
  assert.equal(r.pension_employee, 0);
  assert.equal(r.bituach_leumi, 0);
  assert.equal(r.health_tax, 0);
  assert.ok(r.notes.some((n) => n.includes('3.25')));
  assert.ok(r.employer.employer_ni > 0);
});

test('שכר — חייל: בלי מס בריאות', () => {
  const r = pay({ gross_monthly: 10000, ni_category: 'soldier-organ-donor-treaty-resident' });
  assert.equal(r.health_tax, 0);
  assert.deepEqual(r.rates.health_employee, [0, 0]);
  assert.ok(r.bituach_leumi > 0);
});

test('שכר — קרן השתלמות עד תקרת הפטור', () => {
  const r = pay({ gross_monthly: 20000, keren_hishtalmut: true });
  assert.equal(r.keren_employee, 392.8); // 15712 × 2.5%
  assert.equal(r.employer.employer_keren, 1178.4); // 15712 × 7.5%
});

test('שכר — קרן על מלוא השכר: העודף נזקף כהכנסה', () => {
  const r = pay({ gross_monthly: 20000, keren_full_salary: true });
  assert.equal(r.keren_employee, 500);
  assert.equal(r.employer.employer_keren, 1500);
  // 1500 − 1178.4
  assert.equal(r.imputed_employer_deposits, 321.6);
});

test('שכר — פיצויים מעל 8.33%: זקיפה והערה', () => {
  const r = pay({ gross_monthly: 10000, severance_rate: 0.1 });
  // 10000×10% − 8.33%×10000
  assert.equal(r.imputed_employer_deposits, 167);
  assert.ok(r.notes.some((n) => n.includes('8.33%')));
});

test('שכר — שגיאות קלט', () => {
  assert.throws(() => pay({}), /חסר שדה חובה: gross_monthly/);
  assert.throws(() => pay(null), /חסר שדה חובה: gross_monthly/);
  assert.throws(() => pay({ gross_monthly: -1 }), /לפחות 0/);
  assert.throws(() => pay({ gross_monthly: '10000' }), /חייב להיות מספר/);
  assert.throws(() => pay({ gross_monthly: NaN }), /חייב להיות מספר/);
  assert.throws(() => pay({ gross_monthly: 1e8 }), /לכל היותר/);
  assert.throws(() => pay({ gross_monthly: 1, has_pension: 'yes' }), /true או false/);
  assert.throws(() => pay({ gross_monthly: 1, ni_category: 'martian' }), /ערך לא חוקי בשדה ni_category/);
  assert.throws(() => pay({ gross_monthly: 1, bonus: 5 }), /שדה לא מוכר: bonus/);
});

test('שכר — meta', () => {
  const r = pay({ gross_monthly: 1 });
  assert.equal(r.meta.taxYear, '2026');
  assert.equal(r.meta.source, 'israeli-payroll-calculator');
});

// ---------------------------------------------------------------------------
// מס רכישה
// ---------------------------------------------------------------------------

test('מס רכישה — דירה יחידה מתחת לסף הפטור', () => {
  const r = ptax({ price: 1500000 });
  assert.equal(r.track, 'first');
  assert.equal(r.total_tax, 0);
  assert.equal(r.breakdown.length, 1);
  assert.equal(r.effective_rate_pct, 0);
});

test('מס רכישה — דירה יחידה ב-3 מיליון', () => {
  const r = ptax({ price: 3000000 });
  // 368,295×3.5% + 652,960×5%
  close(r.total_tax, 45538.325);
  assert.equal(r.total_tax_rounded, 45538);
  assert.deepEqual(r.breakdown.map((b) => b.rate), [0, 0.035, 0.05]);
  assert.equal(r.breakdown.at(-1).to, 3000000);
  close(r.breakdown.reduce((s, b) => s + b.taxable_amount, 0), 3000000);
});

test('מס רכישה — דירה נוספת: 8% מהשקל הראשון', () => {
  const r = ptax({ price: 2000000, track: 'additional' });
  close(r.total_tax, 160000);
  assert.ok(r.note.includes('31.12.2026'));
});

test('מס רכישה — דירה נוספת מעל המדרגה', () => {
  const r = ptax({ price: 7000000, track: 'additional' });
  close(r.total_tax, 6055070 * 0.08 + (7000000 - 6055070) * 0.1);
});

test('מס רכישה — עולה חדש', () => {
  const r = ptax({ price: 3000000, track: 'oleh' });
  close(r.total_tax, (3000000 - 1978745) * 0.005);
});

test('מס רכישה — עולה מעל התקרה: מדרגות רגילות', () => {
  const big = 25000000;
  assert.equal(ptax({ price: big, track: 'oleh' }).total_tax, ptax({ price: big, track: 'first' }).total_tax);
});

test('מס רכישה — מסלול מופחת: מצוק ב-2.5 מיליון', () => {
  close(ptax({ price: 2400000, track: 'reduced-single' }).total_tax, (2400000 - 1978745) * 0.005);
  close(ptax({ price: 2600000, track: 'reduced-single' }).total_tax, 2600000 * 0.005);
  close(ptax({ price: 1000000, track: 'reduced-other' }).total_tax, 5000);
});

test('מס רכישה — עיגול לזוגי בחצי מדויק (כמו Python)', () => {
  assert.equal(ptax({ price: 100, track: 'reduced-other' }).total_tax_rounded, 0); // 0.5 → 0
  assert.equal(ptax({ price: 300, track: 'reduced-other' }).total_tax_rounded, 2); // 1.5 → 2
  assert.equal(ptax({ price: 500, track: 'reduced-other' }).total_tax_rounded, 2); // 2.5 → 2
});

test('מס רכישה — שגיאות קלט', () => {
  assert.throws(() => ptax({}), /חסר שדה חובה: price/);
  assert.throws(() => ptax({ price: 0 }), /המחיר חייב להיות חיובי/);
  assert.throws(() => ptax({ price: -5 }), /המחיר חייב להיות חיובי/);
  assert.throws(() => ptax({ price: 1e11 }), /לכל היותר/);
  assert.throws(() => ptax({ price: 1, track: 'castle' }), /ערך לא חוקי בשדה track/);
  assert.throws(() => ptax({ price: 1, city: 'x' }), /שדה לא מוכר: city/);
});

// ---------------------------------------------------------------------------
// מועדי דוחות
// ---------------------------------------------------------------------------

test('דוחות — חנייה, בתוך חלון הביטול', () => {
  const r = fine({ receipt_date: '2026-01-01', fine_type: 'parking', today: '2026-01-10' });
  assert.equal(r.appeal_deadline, '2026-01-31');
  assert.equal(r.appeal_deadline_weekday, 'שבת');
  assert.equal(r.court_hearing_deadline, '2026-04-01');
  assert.equal(r.court_hearing_deadline_weekday, 'רביעי');
  assert.equal(r.days_remaining_appeal, 21);
  assert.equal(r.days_remaining_court, 81);
  assert.equal(r.can_appeal, true);
  assert.equal(r.surcharge_started, false);
  assert.match(r.status, /לבקשה לביטול/);
});

test('דוחות — חלון הביטול עבר, חלון ההישפטות פתוח', () => {
  const r = fine({ receipt_date: '2026-01-01', fine_type: 'traffic', today: '2026-02-15' });
  assert.equal(r.can_appeal, false);
  assert.equal(r.days_remaining_appeal, 0);
  assert.match(r.status, /חלון הבקשה להישפט עדיין פתוח/);
});

test('דוחות — ביום ה-90 מתחילה תוספת פיגור', () => {
  const r = fine({ receipt_date: '2026-01-01', fine_type: 'traffic', today: '2026-04-01' });
  assert.equal(r.surcharge_started, true);
  assert.equal(r.days_until_surcharge, 0);
  assert.match(r.status, /תוספת פיגור/);
});

test('דוחות — ביום ה-30 כבר אי אפשר לבקש ביטול', () => {
  assert.equal(fine({ receipt_date: '2026-01-01', fine_type: 'parking', today: '2026-01-31' }).can_appeal, false);
  assert.equal(fine({ receipt_date: '2026-01-01', fine_type: 'parking', today: '2026-01-30' }).can_appeal, true);
});

test('דוחות — מינהלי: השגה וערר', () => {
  const r = fine({ receipt_date: '2026-03-01', fine_type: 'administrative', today: '2026-03-02' });
  assert.match(r.status, /להשגה/);
  assert.match(r.windows.court, /ערר/);
});

test('דוחות — חודש ויום בספרה אחת ומעבר שנה', () => {
  const r = fine({ receipt_date: '2025-12-5', fine_type: 'parking', today: '2025-12-05' });
  assert.equal(r.receipt_date, '2025-12-05');
  assert.equal(r.appeal_deadline, '2026-01-04');
});

test('דוחות — בלי today: לפי היום בישראל', () => {
  const r = fine({ receipt_date: '2026-01-01', fine_type: 'parking' });
  assert.match(r.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('דוחות — שגיאות קלט', () => {
  assert.throws(() => fine({ fine_type: 'parking' }), /חסר שדה חובה: receipt_date/);
  assert.throws(() => fine({ receipt_date: '2026-01-01' }), /חסר שדה חובה: fine_type/);
  assert.throws(() => fine({ receipt_date: '01/02/2026', fine_type: 'parking' }), /תאריך לא תקין/);
  assert.throws(() => fine({ receipt_date: '2026-02-30', fine_type: 'parking' }), /תאריך לא קיים/);
  assert.throws(() => fine({ receipt_date: 20260101, fine_type: 'parking' }), /פורמט YYYY-MM-DD/);
  assert.throws(() => fine({ receipt_date: '2026-01-01', fine_type: 'speeding' }), /ערך לא חוקי בשדה fine_type/);
  assert.throws(() => fine({ receipt_date: '2026-01-01', fine_type: 'parking', today: '2026-13-01' }), /תאריך לא קיים בשדה today/);
});

// ---------------------------------------------------------------------------
// רוב בהתחדשות עירונית
// ---------------------------------------------------------------------------

test('התחדשות — פינוי בינוי: שלושה חמישיות ושני שלישים במתחם', () => {
  const r = urban({ track: 'pinui-binui', apartments: 10, complex_apartments: 20 });
  assert.equal(r.threshold, 6);
  assert.equal(r.limbs[0].required, 14);
  assert.equal(r.limbs[1].required, 6);
  assert.equal(r.limbs.length, 3);
});

test('התחדשות — פינוי בינוי בלי מתחם: תנאי 1 לא מחושב', () => {
  const r = urban({ track: 'pinui-binui', apartments: 10 });
  assert.equal(r.limbs[0].required, null);
  assert.match(r.limbs[0].note, /complex_apartments/);
});

test('התחדשות — פינוי בינוי, 4 או 5 דירות: לפחות שלוש', () => {
  assert.equal(urban({ track: 'pinui-binui', apartments: 4 }).threshold, 3);
  assert.equal(urban({ track: 'pinui-binui', apartments: 5 }).threshold, 3);
  assert.equal(urban({ track: 'pinui-binui', apartments: 7 }).threshold, 5);
});

test('התחדשות — חיזוק, דירה חדשה: שני שלישים', () => {
  const r = urban({ track: 'chizuk', work: 'new-apartment', apartments: 9 });
  assert.equal(r.threshold, 6);
  assert.equal(r.work, 'new-apartment');
});

test('התחדשות — הריסה: פחות מ-4 דירות אינו זמין', () => {
  const r = urban({ track: 'chizuk', work: 'demolition', apartments: 3, signed: 2 });
  assert.equal(r.threshold, null);
  assert.equal(r.route_available, false);
  assert.equal(r.signed_check.valid, true);
  assert.equal(r.signed_check.threshold, undefined);
});

test('התחדשות — הריסה: שני שלישים, ולפני תיקון 8 ארבע חמישיות', () => {
  const r = urban({ track: 'chizuk', work: 'demolition', apartments: 10 });
  assert.equal(r.threshold, 7);
  assert.equal(r.route_available, true);
  assert.equal(r.pre_tikkun8.required, 8);
  assert.ok(r.notes.some((n) => n.includes('סעיף 4')));
});

test('התחדשות — סעיף 4: בעלים גדול נספר 30% ועוד שליש מהעודף', () => {
  const s = urban({ track: 'pinui-binui', apartments: 10, largest_owner_apartments: 6 }).section4;
  assert.equal(s.applies, true);
  close(s.raw_pct, 60);
  close(s.counted_pct, 40);
  assert.equal(s.reduced, true);
  const small = urban({ track: 'pinui-binui', apartments: 10, largest_owner_apartments: 2 }).section4;
  assert.equal(small.reduced, false);
  close(small.counted_pct, 20);
});

test('התחדשות — סעיף 4 לא חל מתחת לשש דירות', () => {
  const s = urban({ track: 'pinui-binui', apartments: 5, largest_owner_apartments: 3 }).section4;
  assert.equal(s.applies, false);
});

test('התחדשות — בדיקת חותמים', () => {
  const r = urban({ track: 'pinui-binui', apartments: 10, signed: 4 });
  assert.equal(r.signed_check.shortfall, 2);
  assert.equal(r.signed_check.limb_met_on_count, false);
  const ok = urban({ track: 'pinui-binui', apartments: 10, signed: 8 });
  assert.equal(ok.signed_check.shortfall, 0);
  assert.equal(ok.signed_check.limb_met_on_count, true);
  const bad = urban({ track: 'pinui-binui', apartments: 10, signed: 11 });
  assert.equal(bad.signed_check.valid, false);
});

test('התחדשות — שגיאות קלט', () => {
  assert.throws(() => urban({ apartments: 10 }), /חסר שדה חובה: track/);
  assert.throws(() => urban({ track: 'pinui-binui' }), /חסר שדה חובה: apartments/);
  assert.throws(() => urban({ track: 'chizuk', apartments: 10 }), /חובה לציין work/);
  assert.throws(() => urban({ track: 'pinui-binui', apartments: 10.5 }), /מספר שלם/);
  assert.throws(() => urban({ track: 'pinui-binui', apartments: 0 }), /לפחות 1/);
  assert.throws(() => urban({ track: 'pinui-binui', apartments: 10, largest_owner_apartments: 11 }), /לכל היותר 10/);
  assert.throws(() => urban({ track: 'tama38', apartments: 10 }), /ערך לא חוקי בשדה track/);
});
