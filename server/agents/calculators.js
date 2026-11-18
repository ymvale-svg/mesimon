'use strict';
/**
 * מחשבונים דטרמיניסטיים לכלי ה-AI (tool use).
 *
 * ארבעה מחשבונים, כל אחד העתקה נאמנה של סקריפט Python מסקיל של skills-il:
 *   • calc_payroll                 — ברוטו לנטו (israeli-payroll-calculator, ‏calculate_payroll.py)
 *   • calc_purchase_tax            — מס רכישה (israeli-real-estate, ‏calculate_mas_rechisha.py)
 *   • calc_fine_deadlines          — מועדי ערעור על דוח (israeli-fines-fighter, ‏deadline-calculator.py)
 *   • calc_urban_renewal_majority  — רוב נדרש בהתחדשות עירונית (israeli-urban-renewal-owner-guide,
 *                                    ‏majority_threshold.py)
 *
 * אותם קבועים, מדרגות, עיגול ומקרי קצה כמו ב-Python. הקבועים מרוכזים בטבלאות
 * בראש הקובץ — שם מעדכנים אותם כל שנה.
 *
 * ממשק:
 *   TOOLS            — הגדרות כלים בפורמט Anthropic Messages API ‏({ name, description, input_schema }).
 *   run(name, input) — מחזיר אובייקט JSON פשוט עם התוצאה ושדה meta. קלט לא תקין → Error בעברית.
 */

// ===========================================================================
// שכר — קבועי 2026 (israeli-payroll-calculator 1.5.1)
// ===========================================================================

const PAYROLL_TAX_YEAR = '2026';

// מדרגות מס הכנסה חודשיות 2026 (תיקון 288, פורסם 31.3.2026, רטרואקטיבי ל-1.1.2026).
// [תקרה עליונה של המדרגה, שיעור]
const PAYROLL_TAX_BRACKETS = [
  [7010, 0.10],
  [10060, 0.14],
  [19000, 0.20],
  [25100, 0.31],
  [46690, 0.35],
  [60130, 0.47],
  [Infinity, 0.50],
];

// שווי נקודת זיכוי חודשית, 2026
const CREDIT_POINT_VALUE = 242;
const DEFAULT_CREDIT_POINTS = 2.25;

// זיכוי ממס על הפקדה לפנסיה (סעיף 45א), 2026
const PENSION_CREDIT_RATE = 0.35;
const PENSION_CREDIT_SALARY_CEILING = 9700;
const PENSION_CREDIT_CONTRIBUTION_RATE = 0.07;

// ביטוח לאומי — ספים 2026
const NI_REDUCED_CEILING = 7703; // סף השיעור המופחת
const NI_FULL_CEILING = 51910; // הכנסה מרבית חייבת

// מס בריאות (אותו שיעור לכל מי שמשלם מס בריאות)
const HEALTH_REDUCED_RATE = 0.0323;
const HEALTH_FULL_RATE = 0.0517;

// טבלת שיעורי ביטוח לאומי לפי סוג מבוטח (טופס 102, btl.gov.il, 2026).
// employeeReduced / employeeFull — שיעור העובד הכולל (ביטוח לאומי + בריאות).
// החלק של ביטוח לאומי בלבד נגזר בחיסור שיעור הבריאות, כמו ב-Python.
const NI_CATEGORIES = {
  'standard': { label: 'תושב ישראל מגיל 18 עד גיל פרישה', employeeReduced: 0.0427, employeeFull: 0.1217, employerReduced: 0.0451, employerFull: 0.0760, paysHealth: true },
  'controlling-shareholder': { label: 'בעל שליטה בחברת מעטים, מגיל 18 עד גיל פרישה', employeeReduced: 0.0425, employeeFull: 0.1196, employerReduced: 0.0446, employerFull: 0.0738, paysHealth: true },
  'under-18': { label: 'מתחת לגיל 18 (רק המעסיק משלם)', employeeReduced: 0.0, employeeFull: 0.0, employerReduced: 0.0061, employerFull: 0.0212, paysHealth: true },
  'under-18-shareholder': { label: 'מתחת לגיל 18, בעל שליטה בחברת מעטים', employeeReduced: 0.0, employeeFull: 0.0, employerReduced: 0.0060, employerFull: 0.0206, paysHealth: true },
  'old-age-pension': { label: 'מקבל קצבת אזרח ותיק, בכל גיל', employeeReduced: 0.0, employeeFull: 0.0, employerReduced: 0.0061, employerFull: 0.0212, paysHealth: true },
  'old-age-pension-shareholder': { label: 'מקבל קצבת אזרח ותיק, בעל שליטה בחברת מעטים', employeeReduced: 0.0, employeeFull: 0.0, employerReduced: 0.0060, employerFull: 0.0206, paysHealth: true },
  'age-67-70-no-pension': { label: 'בגיל 67 עד 70 שאינו מקבל קצבת אזרח ותיק', employeeReduced: 0.0393, employeeFull: 0.1003, employerReduced: 0.0413, employerFull: 0.0696, paysHealth: true },
  'age-67-70-no-pension-shareholder': { label: 'בגיל 67 עד 70 שאינו מקבל קצבת אזרח ותיק, בעל שליטה', employeeReduced: 0.0393, employeeFull: 0.1003, employerReduced: 0.0412, employerFull: 0.0690, paysHealth: true },
  'woman-retirement-to-67-no-pension': { label: 'אישה מגיל הפרישה שלה עד 67, שאינה מקבלת קצבת אזרח ותיק', employeeReduced: 0.0395, employeeFull: 0.1024, employerReduced: 0.0417, employerFull: 0.0712, paysHealth: true },
  'new-resident-over-62-under-retirement': { label: 'נעשה תושב לראשונה אחרי גיל 62, מתחת לגיל פרישה', employeeReduced: 0.0360, employeeFull: 0.0745, employerReduced: 0.0104, employerFull: 0.0295, paysHealth: true },
  'new-resident-over-62-woman-to-67': { label: 'אישה מגיל הפרישה שלה עד 67, נעשתה תושבת לראשונה אחרי גיל 62', employeeReduced: 0.0328, employeeFull: 0.0552, employerReduced: 0.0070, employerFull: 0.0247, paysHealth: true },
  'new-resident-over-62-67-to-70': { label: 'מגיל 67 עד 70, נעשה תושב לראשונה אחרי גיל 62', employeeReduced: 0.0326, employeeFull: 0.0531, employerReduced: 0.0066, employerFull: 0.0231, paysHealth: true },
  'new-resident-over-62-over-70': { label: 'מעל גיל 70, נעשה תושב לראשונה אחרי גיל 62', employeeReduced: 0.0323, employeeFull: 0.0517, employerReduced: 0.0061, employerFull: 0.0212, paysHealth: true },
  'new-resident-over-62-over-70-shareholder': { label: 'מעל גיל 70, נעשה תושב לראשונה אחרי גיל 62, בעל שליטה', employeeReduced: 0.0323, employeeFull: 0.0517, employerReduced: 0.0060, employerFull: 0.0206, paysHealth: true },
  'disability-pension': { label: 'מקבל קצבת נכות כללית או נכות מעבודה, עם אישור שנתי מביטוח לאומי', employeeReduced: 0.0323, employeeFull: 0.0517, employerReduced: 0.0061, employerFull: 0.0212, paysHealth: true },
  'disability-pension-shareholder': { label: 'מקבל קצבת נכות עם אישור שנתי, בעל שליטה', employeeReduced: 0.0323, employeeFull: 0.0517, employerReduced: 0.0060, employerFull: 0.0206, paysHealth: true },
  'soldier-organ-donor-treaty-resident': { label: 'חייל בשירות סדיר, תורם איבר, או תושב חוץ ממדינת אמנה (ביטוח לאומי בלבד, בלי מס בריאות)', employeeReduced: 0.0104, employeeFull: 0.0700, employerReduced: 0.0451, employerFull: 0.0760, paysHealth: false },
  'soldier-organ-donor-treaty-resident-shareholder': { label: 'חייל בשירות סדיר, תורם איבר או תושב מדינת אמנה, בעל שליטה (בלי מס בריאות)', employeeReduced: 0.0102, employeeFull: 0.0679, employerReduced: 0.0446, employerFull: 0.0738, paysHealth: false },
};
const DEFAULT_NI_CATEGORY = 'standard';

// פנסיה חובה
const PENSION_EMPLOYEE = 0.06;
const PENSION_EMPLOYER = 0.065;
const PENSION_SEVERANCE = 0.06;

// תקרות פטור על הפקדות מעסיק (2026). העודף נזקף לעובד כהכנסה חייבת.
const EMPLOYER_TAGMULIM_EXEMPT_RATE = 0.075;
const EMPLOYER_TAGMULIM_EXEMPT_SALARY = 34423;
const SEVERANCE_EXEMPT_RATE = 0.0833;
const SEVERANCE_EXEMPT_SALARY = 45600;

// קרן השתלמות (לא חובה)
const KEREN_EMPLOYEE = 0.025;
const KEREN_EMPLOYER = 0.075;
const KEREN_EXEMPT_SALARY = 15712;

// ===========================================================================
// מס רכישה — מדרגות 2026 (israeli-real-estate 1.8.0)
// ===========================================================================

const PURCHASE_TAX_YEAR = '2026';

// דירה יחידה — מוקפאות 16.1.2025 עד 15.1.2028 (חוק ההסדרים 2025, חוזר רשות המסים 1/2026)
const FIRST_APARTMENT_BRACKETS = [
  [1978745, 0.00],
  [2347040, 0.035],
  [6055070, 0.05],
  [20183565, 0.08],
  [Infinity, 0.10],
];

// דירה נוספת — הוראת שעה לפי סעיף 9(ג1ו), בתוקף עד 31.12.2026 בלבד
const NON_FIRST_APARTMENT_BRACKETS = [
  [6055070, 0.08],
  [Infinity, 0.10],
];

// עולה חדש, דירה יחידה (תקנה 12א)
const OLEH_SINGLE_HOME_BRACKETS = [
  [1978745, 0.00],
  [6055070, 0.005],
  [20183565, 0.08],
];
// מעל זה תקנה 12א לא חלה כלל — מדרגות דירה יחידה על כל המחיר
const OLEH_RELIEF_CEILING = 20183565;

// מסלול מופחת (תקנה 11): נכה, עיוור, נפגע פעולת איבה, משפחת חלל
const REDUCED_SINGLE_HOME_BRACKETS = [
  [1978745, 0.00],
  [Infinity, 0.005],
];
const REDUCED_FLAT_RATE = 0.005;
// מעל זה — 0.5% על כל השווי מהשקל הראשון (מצוק, לא מדרגה)
const REDUCED_SINGLE_HOME_CEILING = 2500000;

const PURCHASE_TRACKS = {
  'first': 'דירה יחידה',
  'additional': 'דירה נוספת (השקעה)',
  'oleh': 'עולה חדש, דירה יחידה (תקנה 12א)',
  'reduced-single': 'מסלול מופחת, דירה יחידה (תקנה 11)',
  'reduced-other': 'מסלול מופחת, מקרים אחרים (תקנה 11)',
};

// ===========================================================================
// מועדי דוחות (israeli-fines-fighter 1.6.3)
// ===========================================================================

const FINES_RULES_AS_OF = '2026-08';

const PARKING_CANCEL_DAYS = 30;
const TRAFFIC_CANCEL_DAYS = 30;
const COURT_HEARING_DAYS = 90;
const SURCHARGE_STARTS_DAYS = 90; // ממנו יכולה להתחיל תוספת פיגור

const FINE_TYPES = {
  'parking': 'דוח חנייה (עירוני) — מסלול פלילי',
  'traffic': 'דוח תנועה (משטרה/מצלמה) — מסלול פלילי',
  'administrative': 'הפרת תעבורה מינהלית (חוק הפרות תעבורה מינהליות)',
};

const ISRAEL_TZ = 'Asia/Jerusalem';
const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ===========================================================================
// רוב בהתחדשות עירונית (israeli-urban-renewal-owner-guide 1.1.1)
// ===========================================================================

const URBAN_RULES_AS_OF = '2026-08';
const TIKKUN_8_DATE = '1.7.2023';
// סעיף 4 לחוק פינוי ובינוי: בעלים של יותר מ-30% נספר כ-30% ועוד שליש מהעודף
const SECTION4_MIN_APARTMENTS = 6;
const SECTION4_CAP_PCT = 30.0;

const NOTE = (year) => `חישוב לפי הכללים שבסקיל, נכון ל-${year}; יש לאמת מול המקור הרשמי`;

// ===========================================================================
// עזרים
// ===========================================================================

/**
 * עיגול כמו round(x, nd) של Python: לפי הערך העשרוני המדויק של ה-double,
 * ובחצי מדויק — לזוגי (banker's rounding). Math.round לא מתנהג כך.
 */
function pyRound(x, nd) {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100); // הייצוג העשרוני המדויק (מספיק לסכומי כסף)
  const [ip, fp] = s.split('.');
  const kept = ip + fp.slice(0, nd);
  const rest = fp.slice(nd);
  let up;
  if (rest[0] > '5') up = true;
  else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(kept[kept.length - 1]) % 2 === 1; // חצי מדויק — לזוגי
  let digits = (BigInt(kept) + (up ? 1n : 0n)).toString();
  if (nd > 0) {
    digits = digits.padStart(nd + 1, '0');
    digits = digits.slice(0, digits.length - nd) + '.' + digits.slice(digits.length - nd);
  }
  const r = parseFloat(digits);
  return neg ? -r : r;
}

function fail(msg) {
  throw new Error(msg);
}

function checkObject(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('הקלט חייב להיות אובייקט');
  return input;
}

function checkUnknownKeys(input, allowed) {
  for (const k of Object.keys(input)) {
    if (!allowed.includes(k)) fail(`שדה לא מוכר: ${k}`);
  }
}

function num(input, key, { def, min, max, required = false }) {
  const v = input[key];
  if (v === undefined || v === null) {
    if (required) fail(`חסר שדה חובה: ${key}`);
    return def;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`השדה ${key} חייב להיות מספר`);
  if (min !== undefined && v < min) fail(`השדה ${key} חייב להיות לפחות ${min}`);
  if (max !== undefined && v > max) fail(`השדה ${key} חייב להיות לכל היותר ${max}`);
  return v;
}

function int(input, key, opts) {
  const v = num(input, key, opts);
  if (v !== undefined && !Number.isInteger(v)) fail(`השדה ${key} חייב להיות מספר שלם`);
  return v;
}

function bool(input, key, def) {
  const v = input[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') fail(`השדה ${key} חייב להיות true או false`);
  return v;
}

function oneOf(input, key, choices, { def, required = false }) {
  const v = input[key];
  if (v === undefined || v === null) {
    if (required) fail(`חסר שדה חובה: ${key}`);
    return def;
  }
  if (typeof v !== 'string' || !choices.includes(v)) {
    fail(`ערך לא חוקי בשדה ${key}. אפשרויות: ${choices.join(', ')}`);
  }
  return v;
}

// ===========================================================================
// שכר
// ===========================================================================

function niRates(cat) {
  const healthReduced = cat.paysHealth && cat.employeeReduced ? HEALTH_REDUCED_RATE : 0.0;
  const healthFull = cat.paysHealth && cat.employeeFull ? HEALTH_FULL_RATE : 0.0;
  return {
    healthReduced,
    healthFull,
    niReduced: pyRound(cat.employeeReduced - healthReduced, 6),
    niFull: pyRound(cat.employeeFull - healthFull, 6),
  };
}

function pensionCredit(insuredSalary, employeeContribution) {
  const cappedSalary = Math.min(insuredSalary, PENSION_CREDIT_SALARY_CEILING);
  const maxQualifying = cappedSalary * PENSION_CREDIT_CONTRIBUTION_RATE;
  const eligible = Math.min(employeeContribution, maxQualifying);
  return pyRound(eligible * PENSION_CREDIT_RATE, 2);
}

function imputedEmployerDeposits(pensionSalary, employerPensionRate, severanceRate) {
  const tagmulim = pensionSalary * employerPensionRate;
  const tagmulimExempt = EMPLOYER_TAGMULIM_EXEMPT_RATE * Math.min(pensionSalary, EMPLOYER_TAGMULIM_EXEMPT_SALARY);
  const severance = pensionSalary * severanceRate;
  const severanceExempt = SEVERANCE_EXEMPT_RATE * Math.min(pensionSalary, SEVERANCE_EXEMPT_SALARY);
  const excess = Math.max(0.0, tagmulim - tagmulimExempt) + Math.max(0.0, severance - severanceExempt);
  return pyRound(excess, 2);
}

function incomeTax(taxableMonthly, creditPoints, pensionCreditAmount) {
  let tax = 0.0;
  let prevCeiling = 0;
  for (const [ceiling, rate] of PAYROLL_TAX_BRACKETS) {
    if (taxableMonthly <= prevCeiling) break;
    const taxable = Math.min(taxableMonthly, ceiling) - prevCeiling;
    tax += taxable * rate;
    prevCeiling = ceiling;
  }
  const creditValue = creditPoints * CREDIT_POINT_VALUE;
  tax = Math.max(0, tax - creditValue - pensionCreditAmount);
  return pyRound(tax, 2);
}

function bituachLeumi(taxableMonthly, rates) {
  const insurable = Math.min(taxableMonthly, NI_FULL_CEILING);
  const reducedPortion = Math.min(insurable, NI_REDUCED_CEILING);
  let ni = reducedPortion * rates.niReduced;
  let health = reducedPortion * rates.healthReduced;
  if (insurable > NI_REDUCED_CEILING) {
    const fullPortion = insurable - NI_REDUCED_CEILING;
    ni += fullPortion * rates.niFull;
    health += fullPortion * rates.healthFull;
  }
  return [pyRound(ni, 2), pyRound(health, 2)];
}

function employerNi(taxableMonthly, cat) {
  const insurable = Math.min(taxableMonthly, NI_FULL_CEILING);
  const reducedPortion = Math.min(insurable, NI_REDUCED_CEILING);
  let ni = reducedPortion * cat.employerReduced;
  if (insurable > NI_REDUCED_CEILING) {
    const fullPortion = insurable - NI_REDUCED_CEILING;
    ni += fullPortion * cat.employerFull;
  }
  return pyRound(ni, 2);
}

function calcPayroll(raw) {
  const input = checkObject(raw);
  checkUnknownKeys(input, ['gross_monthly', 'credit_points', 'has_pension', 'shovi_rechev', 'ni_category',
    'severance_rate', 'keren_hishtalmut', 'keren_full_salary']);
  const gross = num(input, 'gross_monthly', { required: true, min: 0, max: 10000000 });
  const creditPoints = num(input, 'credit_points', { def: DEFAULT_CREDIT_POINTS, min: 0, max: 50 });
  let hasPension = bool(input, 'has_pension', true);
  const shoviRechev = num(input, 'shovi_rechev', { def: 0.0, min: 0, max: 1000000 });
  const niCategory = oneOf(input, 'ni_category', Object.keys(NI_CATEGORIES), { def: DEFAULT_NI_CATEGORY });
  const severanceRate = num(input, 'severance_rate', { def: PENSION_SEVERANCE, min: 0, max: 1 });
  let keren = bool(input, 'keren_hishtalmut', false);
  const kerenFullSalary = bool(input, 'keren_full_salary', false);

  const cat = NI_CATEGORIES[niCategory];
  const rates = niRates(cat);
  const taxableGross = gross + shoviRechev;
  const notes = [];

  // פנסיה חובה מגיל 21 לגבר ו-20 לאישה: לקטין אין הפרשה, זיכוי או זקיפה
  if (niCategory.startsWith('under-18')) hasPension = false;

  // הפנסיה מחושבת על השכר במזומן בלבד, בלי שווי רכב
  const pensionEmployee = hasPension ? pyRound(gross * PENSION_EMPLOYEE, 2) : 0.0;
  const pensionCreditAmount = hasPension ? pensionCredit(gross, pensionEmployee) : 0.0;
  let imputed = hasPension ? imputedEmployerDeposits(gross, PENSION_EMPLOYER, severanceRate) : 0.0;

  keren = keren || kerenFullSalary; // הפקדה על מלוא השכר מחייבת קרן
  const kerenBase = kerenFullSalary ? gross : Math.min(gross, KEREN_EXEMPT_SALARY);
  const kerenEmployee = keren ? pyRound(kerenBase * KEREN_EMPLOYEE, 2) : 0.0;
  const employerKeren = keren ? pyRound(kerenBase * KEREN_EMPLOYER, 2) : 0.0;
  if (keren && kerenFullSalary) {
    imputed = pyRound(imputed + Math.max(0.0, employerKeren - KEREN_EMPLOYER * Math.min(gross, KEREN_EXEMPT_SALARY)), 2);
  }

  const tax = incomeTax(taxableGross + imputed, creditPoints, pensionCreditAmount);
  const [ni, health] = bituachLeumi(taxableGross + imputed, rates);

  // נטו במזומן: שווי הרכב לא משולם במזומן ולכן לא מתווסף
  const net = pyRound(gross - tax - ni - health - pensionEmployee - kerenEmployee, 2);

  // עלות מעסיק (ב-Python רק עם ‎--employer-cost‎; כאן תמיד, החישוב זהה)
  const empNi = employerNi(taxableGross + imputed, cat);
  const empPension = hasPension ? pyRound(gross * PENSION_EMPLOYER, 2) : 0.0;
  const empSeverance = hasPension ? pyRound(gross * severanceRate, 2) : 0.0;
  const totalEmployerCost = pyRound(gross + empNi + empPension + empSeverance + employerKeren, 2);

  if (severanceRate > 0.0833) {
    notes.push('שיעור פיצויים מעל 8.33% אינו רגיל; החלק שמעל תקרת הפטור נחשב הכנסה חייבת.');
  }
  if (niCategory.startsWith('under-18') && (creditPoints === 2.25 || creditPoints === 2.75)) {
    notes.push('עובד בגיל 16 או 17 זכאי לנקודת זיכוי נוספת (סעיף 40ב): 3.25 נקודות (3.75 לנערה).');
  }
  if (niCategory.startsWith('under-18')) {
    notes.push('לעובד מתחת לגיל 18 לא מנוכה פנסיה: פנסיה חובה מתחילה בגיל 21 לגבר ו-20 לאישה.');
  } else if (hasPension) {
    notes.push('הונחה הפרשה של 6% לפנסיה. גבר מתחת ל-21, אישה מתחת ל-20, או עובד חדש ב-6 החודשים הראשונים בלי קרן פנסיה פעילה — בדרך כלל בלי ניכוי פנסיה: יש לחשב שוב עם has_pension=false.');
  }
  notes.push('הערכה בלבד; אינה מחליפה תלוש שכר או רואה חשבון. נקודות זיכוי נוספות (ילדים, תואר, עולה וכו\') יש להעביר ב-credit_points.');

  return {
    gross_salary: gross,
    shovi_rechev: shoviRechev,
    taxable_gross: taxableGross,
    imputed_employer_deposits: imputed,
    income_tax: tax,
    pension_credit: pensionCreditAmount,
    bituach_leumi: ni,
    health_tax: health,
    pension_employee: pensionEmployee,
    keren_employee: kerenEmployee,
    net_salary: net,
    credit_points: creditPoints,
    has_pension: hasPension,
    ni_category: niCategory,
    ni_category_label: cat.label,
    rates: {
      ni_employee: [rates.niReduced, rates.niFull],
      health_employee: [rates.healthReduced, rates.healthFull],
      employer_ni: [cat.employerReduced, cat.employerFull],
      ni_reduced_ceiling: NI_REDUCED_CEILING,
      ni_full_ceiling: NI_FULL_CEILING,
      credit_point_value: CREDIT_POINT_VALUE,
    },
    employer: {
      employer_ni: empNi,
      employer_pension: empPension,
      employer_severance: empSeverance,
      employer_keren: employerKeren,
      total_employer_cost: totalEmployerCost,
    },
    notes,
    meta: {
      taxYear: PAYROLL_TAX_YEAR,
      source: 'israeli-payroll-calculator',
      note: NOTE(PAYROLL_TAX_YEAR),
    },
  };
}

// ===========================================================================
// מס רכישה
// ===========================================================================

function purchaseBrackets(price, track) {
  if (track === 'first') return [FIRST_APARTMENT_BRACKETS, ''];
  if (track === 'additional') {
    return [NON_FIRST_APARTMENT_BRACKETS, 'שיעורי 8%/10% הם הוראת שעה בתוקף עד 31.12.2026 בלבד.'];
  }
  if (track === 'oleh') {
    if (price > OLEH_RELIEF_CEILING) {
      return [FIRST_APARTMENT_BRACKETS,
        `מעל ${OLEH_RELIEF_CEILING.toLocaleString('en-US')} ש"ח תקנה 12א לא חלה כלל: מדרגות דירה יחידה הרגילות חלות על כל המחיר.`];
    }
    return [OLEH_SINGLE_HOME_BRACKETS, 'ניתנת פעם אחת בלבד, משנה לפני העלייה ועד שבע שנים אחריה.'];
  }
  if (track === 'reduced-single') {
    if (price > REDUCED_SINGLE_HOME_CEILING) {
      return [[[Infinity, REDUCED_FLAT_RATE]],
        `מעל ${REDUCED_SINGLE_HOME_CEILING.toLocaleString('en-US')} ש"ח השיעור המופחת הוא 0.5% מכל השווי, מהשקל הראשון.`];
    }
    return [REDUCED_SINGLE_HOME_BRACKETS, 'ניתן לאדם אחד לכל היותר פעמיים בחייו, בבקשה לרשות המסים.'];
  }
  // reduced-other
  return [[[Infinity, REDUCED_FLAT_RATE]], '0.5% מכל השווי. ניתן לכל היותר פעמיים בחיים.'];
}

function calcPurchaseTax(raw) {
  const input = checkObject(raw);
  checkUnknownKeys(input, ['price', 'track']);
  const price = num(input, 'price', { required: true, max: 10000000000 });
  if (price <= 0) fail('המחיר חייב להיות חיובי');
  const track = oneOf(input, 'track', Object.keys(PURCHASE_TRACKS), { def: 'first' });

  const [brackets, trackNote] = purchaseBrackets(price, track);

  let totalTax = 0.0;
  const breakdown = [];
  let remaining = price;
  let prevLimit = 0;
  for (const [limit, rate] of brackets) {
    if (remaining <= 0) break;
    const bracketAmount = Math.min(remaining, limit - prevLimit);
    const bracketTax = bracketAmount * rate;
    if (bracketAmount > 0) {
      breakdown.push({
        from: prevLimit,
        to: Math.min(price, limit),
        rate,
        taxable_amount: bracketAmount,
        tax: bracketTax,
      });
    }
    totalTax += bracketTax;
    remaining -= bracketAmount;
    prevLimit = limit;
  }
  const effectiveRate = price > 0 ? (totalTax / price) * 100 : 0;

  let note = 'הסכומים מוקפאים מ-16.1.2025 עד 15.1.2028 (חוזר רשות המסים 1/2026). יש לאמת בסימולטור של רשות המסים.';
  if (trackNote) note = `${trackNote} ${note}`;

  return {
    price,
    track,
    buyer_type: PURCHASE_TRACKS[track],
    total_tax: totalTax,
    total_tax_rounded: pyRound(totalTax, 0),
    effective_rate_pct: effectiveRate,
    breakdown,
    filing: 'הצהרה תוך 30 יום מהחתימה; תשלום תוך 60 יום.',
    note,
    meta: {
      taxYear: PURCHASE_TAX_YEAR,
      source: 'israeli-real-estate',
      note: NOTE(PURCHASE_TAX_YEAR),
    },
  };
}

// ===========================================================================
// מועדי דוחות
// ===========================================================================

// תאריך כ-‎YYYY-MM-DD‎ (חודש/יום של ספרה אחת מותרים, כמו strptime) → מספר יום מאז 1970, ב-UTC
function parseDay(s, key) {
  if (typeof s !== 'string') fail(`השדה ${key} חייב להיות תאריך בפורמט YYYY-MM-DD`);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) fail(`תאריך לא תקין בשדה ${key}: "${s}". יש להשתמש בפורמט YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (y < 1900 || y > 2200 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    fail(`תאריך לא קיים בשדה ${key}: "${s}"`);
  }
  return t / 86400000;
}

function dayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function dayToWeekday(day) {
  return WEEKDAYS_HE[new Date(day * 86400000).getUTCDay()];
}

function todayInIsrael() {
  // en-CA נותן YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: ISRAEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function calcFineDeadlines(raw) {
  const input = checkObject(raw);
  checkUnknownKeys(input, ['receipt_date', 'fine_type', 'today']);
  if (input.receipt_date === undefined || input.receipt_date === null) fail('חסר שדה חובה: receipt_date');
  const date = parseDay(input.receipt_date, 'receipt_date');
  const fineType = oneOf(input, 'fine_type', Object.keys(FINE_TYPES), { required: true });
  const today = parseDay(input.today == null ? todayInIsrael() : input.today, 'today');

  const cancelWindow = fineType === 'parking' ? PARKING_CANCEL_DAYS : TRAFFIC_CANCEL_DAYS;
  const appealDeadline = date + cancelWindow;
  const courtDeadline = date + COURT_HEARING_DAYS;
  const surchargeDeadline = date + SURCHARGE_STARTS_DAYS;

  const daysToAppeal = appealDeadline - today;
  const daysToCourt = courtDeadline - today;
  const daysToSurcharge = surchargeDeadline - today;

  const admin = fineType === 'administrative';
  let status;
  if (daysToAppeal > 0) {
    status = admin ? 'בתוך חלון 30 הימים להשגה' : 'בתוך חלון 30 הימים לבקשה לביטול';
  } else if (!(daysToSurcharge <= 0)) {
    status = admin ? 'חלון ההשגה עבר; חלון הערר עדיין פתוח' : 'חלון הבקשה לביטול עבר; חלון הבקשה להישפט עדיין פתוח';
  } else {
    status = 'ייתכן שהתחילה תוספת פיגור. יש לבדוק את היתרה במרכז לגביית קנסות, או לתעד סיבה מוצדקת לאיחור.';
  }

  const windows = admin
    ? {
      appeal: 'השגה: 30 יום (90 יום אם לא אתם נהגתם, סעיף 8(א))',
      court: 'ערר לבית הדין לתעבורה: 90 יום (סעיף 19(ב)), או 30 יום מההחלטה בהשגה. אין בקשה להישפט במסלול הזה.',
    }
    : {
      appeal: 'בקשה לביטול: 30 יום',
      court: 'בקשה להישפט: 90 יום',
    };

  return {
    receipt_date: dayToIso(date),
    today: dayToIso(today),
    fine_type: fineType,
    fine_type_label: FINE_TYPES[fineType],
    appeal_deadline: dayToIso(appealDeadline),
    appeal_deadline_weekday: dayToWeekday(appealDeadline),
    days_remaining_appeal: Math.max(daysToAppeal, 0),
    can_appeal: daysToAppeal > 0,
    court_hearing_deadline: dayToIso(courtDeadline),
    court_hearing_deadline_weekday: dayToWeekday(courtDeadline),
    days_remaining_court: Math.max(daysToCourt, 0),
    surcharge_deadline: dayToIso(surchargeDeadline),
    days_until_surcharge: Math.max(daysToSurcharge, 0),
    surcharge_started: daysToSurcharge <= 0,
    windows,
    status,
    notes: [
      'המועדים נספרים מיום קבלת הדוח, בימים קלנדריים. המחשבון אינו דוחה מועד שחל בסוף שבוע או בחג.',
      'שיעור תוספת הפיגור תלוי במסלול (במסלול המינהלי 30% לפי סעיף 10(ב)(1), ועוד ריבית); המחשבון מציין רק את התאריך שממנו היא יכולה להתחיל.',
      'איזה מסלול חל נקבע לפי תאריך העבירה, לא לפי התאריך היום.',
      'בדוחות חנייה יש עיריות עם נוהלי "עיון חוזר" משלהן; יש לאמת מול העירייה.',
    ],
    meta: {
      rulesAsOf: FINES_RULES_AS_OF,
      source: 'israeli-fines-fighter',
      note: NOTE('2026'),
    },
  };
}

// ===========================================================================
// רוב בהתחדשות עירונית
// ===========================================================================

// המספר השלם הקטן ביותר של דירות שהוא לפחות השבר הנתון מהסך
function ceilFraction(total, numerator, denominator) {
  return Math.ceil((total * numerator) / denominator);
}

function section4Discount(apartments, owned) {
  if (apartments < SECTION4_MIN_APARTMENTS) return null;
  const raw = (owned / apartments) * 100.0;
  if (raw <= SECTION4_CAP_PCT) return [raw, raw];
  const excess = raw - SECTION4_CAP_PCT;
  return [raw, SECTION4_CAP_PCT + excess / 3.0];
}

function calcUrbanRenewalMajority(raw) {
  const input = checkObject(raw);
  checkUnknownKeys(input, ['track', 'work', 'apartments', 'complex_apartments', 'signed', 'largest_owner_apartments']);
  const track = oneOf(input, 'track', ['pinui-binui', 'chizuk'], { required: true });
  const apartments = int(input, 'apartments', { required: true, min: 1, max: 100000 });
  const work = oneOf(input, 'work', ['new-apartment', 'demolition'], { def: undefined });
  if (track === 'chizuk' && !work) fail('במסלול החיזוק חובה לציין work: new-apartment או demolition');
  const complexApartments = int(input, 'complex_apartments', { def: undefined, min: 1, max: 1000000 });
  const signed = int(input, 'signed', { def: undefined, min: 0, max: 100000 });
  const largestOwner = int(input, 'largest_owner_apartments', { def: undefined, min: 0, max: apartments });

  const result = { track, apartments };
  const limbs = [];
  const notes = [];
  let threshold;

  if (track === 'pinui-binui') {
    result.statute = 'חוק פינוי ובינוי (עידוד מיזמי פינוי ובינוי), התשס"ו-2006, סעיף 1 — הגדרת "רוב מיוחס מבין בעלי הדירות"';
    notes.push('הרוב המיוחס מורכב: שלושת התנאים צריכים להתקיים יחד.');
    if (complexApartments) {
      const need = ceilFraction(complexApartments, 2, 3);
      limbs.push({ limb: 1, rule: 'לפחות שני שלישים מכל הדירות במתחם', required: need, of: complexApartments });
    } else {
      limbs.push({ limb: 1, rule: 'לפחות שני שלישים מכל הדירות במתחם', required: null, of: null,
        note: 'כדי לחשב תנאי זה יש להעביר complex_apartments' });
    }
    if (apartments === 4 || apartments === 5) {
      threshold = 3;
      limbs.push({ limb: 2, rule: 'בבית משותף של 4 או 5 דירות: לפחות שלוש דירות, ובבניין יותר משני בעלים (כלל שלושה חמישיות לא חל בגודל זה)',
        required: 3, of: apartments });
    } else {
      threshold = ceilFraction(apartments, 3, 5);
      limbs.push({ limb: 2, rule: 'לפחות שלושה חמישיות מהדירות בבית המשותף הזה', required: threshold, of: apartments });
    }
    limbs.push({ limb: 3, rule: 'יותר ממחצית הרכוש המשותף בבית המשותף צמוד לדירותיהם — חלק ברכוש, לא מספר דירות; נקרא מפנקס הבתים המשותפים',
      required: null, of: null });
  } else {
    result.work = work;
    result.statute = 'חוק המקרקעין (חיזוק בתים משותפים מפני רעידות אדמה), התשס"ח-2008. הפורום: המפקח על הבתים המשותפים';
    if (work === 'new-apartment') {
      threshold = ceilFraction(apartments, 2, 3);
      limbs.push({ limb: 1, rule: 'בניית דירה חדשה אחת או יותר ברכוש המשותף (סעיף 5(א)): שני שלישים מהדירות',
        required: threshold, of: apartments });
      limbs.push({ limb: 2, rule: 'ועוד שני שלישים מהרכוש המשותף הצמוד לדירותיהם', required: null, of: null });
      notes.push('המפקח חייב לתת לכל בעל דירה הזדמנות לטעון את טענותיו.');
    } else if (apartments < 4) {
      threshold = null;
      result.route_available = false;
      notes.push(`לבניין ${apartments} דירות. מסלול סעיף 5א(א) (הריסה ובנייה מחדש) דורש בניין של לפחות ארבע דירות ויותר משני בעלים, ולכן אינו זמין בגודל זה.`);
    } else {
      threshold = ceilFraction(apartments, 2, 3);
      result.route_available = true;
      limbs.push({ limb: 1, rule: 'הריסת הבניין ובנייתו מחדש (סעיף 5א): שני שלישים מהדירות, בבניין של לפחות ארבע דירות ויותר משני בעלים',
        required: threshold, of: apartments });
      limbs.push({ limb: 2, rule: 'ועוד שני שלישים מהרכוש המשותף', required: null, of: null });
      result.pre_tikkun8 = {
        in_force_from: TIKKUN_8_DATE,
        required: ceilFraction(apartments, 4, 5),
        of: apartments,
        note: `לפני תיקון 8 (בתוקף מ-${TIKKUN_8_DATE}) הרוב היה ארבע חמישיות מהדירות ומהרכוש המשותף. הנתון הישן עדיין חל על עניינים שנמדדים לפי המשטר הקודם, וממנו מקור "80 האחוז" שעדיין מתפרסם כאילו הוא בתוקף.`,
      };
      if (apartments >= 6) {
        notes.push('בשש דירות ומעלה, סעיף 5א(א1) מחיל את סעיף 4 לחוק פינוי ובינוי על חישוב הרוב. זה לא משנה את סף שני השלישים: בעלים של יותר מ-30% מהדירות נספר כ-30% ועוד שליש מהעודף (largest_owner_apartments).');
      }
    }
  }
  result.threshold = threshold;
  result.limbs = limbs;

  if (largestOwner !== undefined) {
    const d = section4Discount(apartments, largestOwner);
    if (d === null) {
      result.section4 = { applies: false, note: 'הנחת סעיף 4 לא חלה: היא חלה רק משש דירות ומעלה.' };
    } else {
      const [rawPct, countedPct] = d;
      const reduced = !(Math.abs(rawPct - countedPct) < 1e-9);
      result.section4 = {
        applies: true,
        largest_owner_apartments: largestOwner,
        raw_pct: rawPct,
        counted_pct: countedPct,
        reduced,
        note: reduced
          ? `הבעלים הגדול מחזיק ${largestOwner} מתוך ${apartments} (${rawPct.toFixed(2)}%), אך נספר כ-${countedPct.toFixed(2)}% (30% ועוד שליש מהעודף של ${(rawPct - 30.0).toFixed(2)}%).`
          : `הבעלים הגדול מחזיק ${largestOwner} מתוך ${apartments} (${rawPct.toFixed(2)}%), עד 30% — ההנחה לא מקטינה את משקלו.`,
      };
    }
  }

  if (signed !== undefined) {
    if (signed > apartments) {
      result.signed_check = { signed, valid: false, note: `נמסר שחתמו ${signed} בבניין של ${apartments} דירות. יש לבדוק את המספרים.` };
    } else if (threshold === null) {
      result.signed_check = { signed, valid: true, note: 'אין חישוב, כי הסף במקרה זה מפנה לחוק אחר. ראו ההערה.' };
    } else {
      const gap = threshold - signed;
      result.signed_check = {
        signed,
        valid: true,
        threshold,
        shortfall: gap > 0 ? gap : 0,
        limb_met_on_count: !(gap > 0),
        note: 'נבדק רק התנאי של מספר הדירות; שאר התנאים, כולל כל תנאי הרכוש המשותף, לא נבדקו.',
      };
    }
  }

  notes.push('זו הצגה כללית של ספים שפורסמו בחוק, לא ייעוץ משפטי ולא קביעה לגבי אדם. הגעה לסף לא מחייבת בעצמה בעלים מתנגד: היא מאפשרת לבעלים המסכימים לפנות לבית המשפט (פינוי בינוי) או למפקח (מסלול החיזוק), שמכריע. המחשבון לא קובע אם סירוב סביר ולא מי "דייר סרבן".');
  result.notes = notes;
  result.meta = {
    rulesAsOf: URBAN_RULES_AS_OF,
    source: 'israeli-urban-renewal-owner-guide',
    note: NOTE('2026'),
  };
  return result;
}

// ===========================================================================
// הגדרות הכלים
// ===========================================================================

const TOOLS = [
  {
    name: 'calc_payroll',
    description:
      'מחשב שכר נטו מברוטו לעובד שכיר בישראל, לפי שיעורי שנת המס 2026 (מדרגות מס הכנסה לפי תיקון 288, ' +
      'נקודת זיכוי 242 ש"ח לחודש, ספי ביטוח לאומי 7,703 / 51,910 ש"ח). מחזיר מס הכנסה (כולל זיכוי פנסיה לפי סעיף 45א), ' +
      'ביטוח לאומי, מס בריאות, ניכוי פנסיה וקרן השתלמות, נטו במזומן, ועלות מעסיק. ' +
      'כל הסכומים בש"ח לחודש. מתחיל מברוטו מוסכם — לא מחשב שעות נוספות. הערכה בלבד.',
    input_schema: {
      type: 'object',
      properties: {
        gross_monthly: { type: 'number', minimum: 0, description: 'שכר ברוטו חודשי במזומן, בש"ח (בלי שווי רכב)' },
        credit_points: { type: 'number', minimum: 0, description: 'מספר נקודות הזיכוי. ברירת מחדל 2.25 (גבר תושב); 2.75 לאישה; יותר לילדים, עולה, תואר וכו\'' },
        has_pension: { type: 'boolean', description: 'האם מנוכה פנסיה חובה (6% עובד). ברירת מחדל true. false לגבר מתחת ל-21, אישה מתחת ל-20 או עובד חדש ב-6 החודשים הראשונים בלי קרן פעילה' },
        shovi_rechev: { type: 'number', minimum: 0, description: 'שווי שימוש ברכב צמוד, בש"ח לחודש. נוסף לבסיס המס והביטוח הלאומי, לא לפנסיה ולא לנטו. ברירת מחדל 0' },
        ni_category: {
          type: 'string',
          enum: Object.keys(NI_CATEGORIES),
          description: 'סוג מבוטח בביטוח לאומי. ברירת מחדל standard (תושב מגיל 18 עד גיל פרישה). אפשרויות: ' +
            Object.entries(NI_CATEGORIES).map(([k, c]) => `${k} = ${c.label}`).join('; '),
        },
        severance_rate: { type: 'number', minimum: 0, maximum: 1, description: 'שיעור הפקדת המעסיק לפיצויים, כשבר עשרוני. ברירת מחדל 0.06; ‏0.0833 להסדר סעיף 14 מלא' },
        keren_hishtalmut: { type: 'boolean', description: 'האם יש קרן השתלמות (2.5% עובד / 7.5% מעסיק עד תקרת 15,712 ש"ח). ברירת מחדל false' },
        keren_full_salary: { type: 'boolean', description: 'קרן השתלמות על מלוא השכר, מעל התקרה (העודף של המעסיק חייב במס). ברירת מחדל false' },
      },
      required: ['gross_monthly'],
      additionalProperties: false,
    },
  },
  {
    name: 'calc_purchase_tax',
    description:
      'מחשב מס רכישה על דירת מגורים בישראל לפי מדרגות 2026 (מוקפאות 16.1.2025–15.1.2028, חוזר רשות המסים 1/2026; ' +
      'מדרגות דירה נוספת 8%/10% הן הוראת שעה עד 31.12.2026). מחזיר את המס הכולל בש"ח, שיעור אפקטיבי ופירוט לפי מדרגות. ' +
      'מסלולים: דירה יחידה, דירה נוספת, עולה חדש (תקנה 12א), מסלול מופחת לנכה/נפגע איבה/משפחת חלל (תקנה 11).',
    input_schema: {
      type: 'object',
      properties: {
        price: { type: 'number', exclusiveMinimum: 0, description: 'מחיר הנכס בש"ח' },
        track: {
          type: 'string',
          enum: Object.keys(PURCHASE_TRACKS),
          description: 'מסלול הקונה. ברירת מחדל first. ' +
            Object.entries(PURCHASE_TRACKS).map(([k, l]) => `${k} = ${l}`).join('; '),
        },
      },
      required: ['price'],
      additionalProperties: false,
    },
  },
  {
    name: 'calc_fine_deadlines',
    description:
      'מחשב את מועדי ההשגה/הערעור על דוח חנייה, דוח תנועה או הפרת תעבורה מינהלית, מיום קבלת הדוח, ' +
      'לפי הכללים שבתוקף באוגוסט 2026: 30 יום לבקשה לביטול (או להשגה במסלול המינהלי), 90 יום לבקשה להישפט ' +
      '(או לערר לבית הדין לתעבורה), ותאריך שממנו יכולה להתחיל תוספת פיגור. מחזיר תאריכים (YYYY-MM-DD), יום בשבוע, ' +
      'וכמה ימים נותרו מהיום (לפי שעון ישראל). ימים קלנדריים, בלי דחייה בסופי שבוע וחגים.',
    input_schema: {
      type: 'object',
      properties: {
        receipt_date: { type: 'string', description: 'תאריך קבלת הדוח, בפורמט YYYY-MM-DD' },
        fine_type: {
          type: 'string',
          enum: Object.keys(FINE_TYPES),
          description: Object.entries(FINE_TYPES).map(([k, l]) => `${k} = ${l}`).join('; '),
        },
        today: { type: 'string', description: 'אופציונלי: התאריך שממנו סופרים ימים שנותרו, YYYY-MM-DD. ברירת מחדל: היום לפי שעון ישראל' },
      },
      required: ['receipt_date', 'fine_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'calc_urban_renewal_majority',
    description:
      'מחשב את הרוב הסטטוטורי הנדרש (מספר דירות) בהתחדשות עירונית, לפי החוק כפי שהוא באוגוסט 2026: ' +
      'פינוי בינוי (חוק פינוי ובינוי 2006, סעיף 1 — שלושה תנאים מצטברים) או מסלול החיזוק/תמ"א 38 ' +
      '(חוק החיזוק 2008, סעיפים 5 ו-5א, כולל תיקון 8 מ-1.7.2023). אופציונלית: כמה חסרים לפי מספר החותמים, ' +
      'והנחת סעיף 4 לבעלים של יותר מ-30% מהדירות. כל הקלטים הם מספרי דירות שלמים. ' +
      'לא קובע אם סירוב סביר ולא מעריך שווי.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['pinui-binui', 'chizuk'], description: 'pinui-binui = פינוי בינוי; chizuk = מסלול החיזוק (תמ"א 38)' },
        work: { type: 'string', enum: ['new-apartment', 'demolition'], description: 'חובה במסלול החיזוק: new-apartment = תוספת דירות ברכוש המשותף (סעיף 5(א)); demolition = הריסה ובנייה מחדש (סעיף 5א)' },
        apartments: { type: 'integer', minimum: 1, description: 'מספר הדירות בבית המשותף' },
        complex_apartments: { type: 'integer', minimum: 1, description: 'פינוי בינוי בלבד: סך הדירות בכל המתחם' },
        signed: { type: 'integer', minimum: 0, description: 'כמה דירות כבר חתמו (לחישוב בלבד)' },
        largest_owner_apartments: { type: 'integer', minimum: 0, description: 'כמה דירות מחזיק הבעלים הגדול ביותר (להנחת סעיף 4, משש דירות ומעלה)' },
      },
      required: ['track', 'apartments'],
      additionalProperties: false,
    },
  },
];

const RUNNERS = {
  calc_payroll: calcPayroll,
  calc_purchase_tax: calcPurchaseTax,
  calc_fine_deadlines: calcFineDeadlines,
  calc_urban_renewal_majority: calcUrbanRenewalMajority,
};

function run(name, input) {
  const fn = Object.prototype.hasOwnProperty.call(RUNNERS, name) ? RUNNERS[name] : null;
  if (!fn) fail(`מחשבון לא מוכר: ${name}`);
  return fn(input);
}

module.exports = { TOOLS, run };
