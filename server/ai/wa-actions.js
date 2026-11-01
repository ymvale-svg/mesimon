'use strict';
/**
 * מה בוט הוואטסאפ יודע לעשות — קטלוג הפעולות, ומה מנהל המערכת הפעיל מהן.
 *
 * הקטלוג קבוע בקוד: כל פעולה היא קוד שרץ עם ההרשאות של העובד, כמו באפליקציה.
 * ה-AI רק מזהה מה העובד ביקש. במסך הניהול אפשר להפעיל ולכבות פעולה, לקבוע מי
 * רשאי להשתמש בה ולשנות את הדוגמאות — אלה מוצגות לעובד ב"עזרה" ומכוונות את
 * ה-AI. ההגדרות נשמרות ב-‎wa_actions‎.
 */
const D = require('../db');

const ACTIONS = [
  {
    key: 'group_tasks', icon: '👥', label: 'הצעות מהקבוצות', channel: 'group',
    description: 'קורא בקשות בקבוצות הפרויקטים ומציע אותן כמשימות ב"ממתין לאישורך" של מי שהבקשה מופנית אליו. ✅ על ההודעה כשהמשימה אושרה.',
    examples: ['שושנה בבקשה לפנות ליועץ הסניטרי ולבקש תסריט מעודכן'],
    enabled: true
  },
  {
    key: 'create_task', icon: '📝', label: 'פתיחת משימה', channel: 'private',
    description: 'ממלא טיוטה מההודעה, מציג אותה, ופותח את המשימה רק אחרי "כן".',
    examples: ['תפתח משימה לשושנה לפנות ליועץ הסניטרי, עד חמישי', 'תזכיר לי לשלוח הצעת מחיר לאלון מחר'],
    enabled: true
  },
  {
    key: 'today', icon: '☀️', label: 'היום שלי ותפריט', channel: 'private',
    description: 'על "היי", "מה נשמע" או הודעה ראשונה ביום: מה יש היום (פגישות, משימות להיום ובאיחור, מיילים שמחכים להחלטה) ותפריט ממוספר של מה אפשר לעשות. גם "שלח לי את Today במייל".',
    examples: ['מה יש לי היום?', 'שלח לי את Today במייל'],
    enabled: true
  },
  {
    key: 'send_email', icon: '✉️', label: 'שליחת מייל לאיש קשר', channel: 'private',
    description: 'מוצא את הנמען באנשי הקשר של Google (ושואל איזה, כשיש כמה באותו שם), קורא את ההתכתבות האחרונה איתו, מנסח מייל עם הצעות מה להוסיף — ושולח מתיבת ה-Gmail של הכותב רק אחרי "כן". נפתחת משימת AI שעוקבת אחרי התשובה. לעובד בארגון — במייל ("כן"), או "במשימון": משימה שמשויכת אליו במקום מייל.',
    examples: ['שלח מייל לאורן ממשרד עורכי הדין כהן שיעביר לי את טיוטת ההסכם', 'תכתוב לשושנה חן שחסר בתסריט לוח החשמל של קומה 2'],
    enabled: true
  },
  {
    key: 'mail_insights', icon: '📬', label: 'תובנות מהמיילים', channel: 'private',
    description: 'שורה אחת לכל מייל מ-24 השעות האחרונות (שנקראו ושלא נקראו): מי אמר מה — "בנק לאומי אישר…", "אורן מבקש…". מקובץ לפי "דורש ממך", "אישורים ועדכונים" ו"לידיעה". משם: "פרט על 2", "תענה ל-1 ש…" (נשלח רק אחרי "כן"), "תפתח משימה מ-3", "תעקוב אחרי 2". שורת סיכום גם בהודעה הראשונה של היום. רק למי שחיבר Gmail.',
    examples: ['מה חדש במייל?', 'תובנות מהמיילים', 'פרט על 2', 'תענה ל-1 שאשלח מחר'],
    enabled: true
  },
  {
    key: 'voice_notes', icon: '🎙', label: 'הודעות קוליות', channel: 'private',
    description: 'הודעה קולית לבוט מתומללת (OpenAI או Google) ומטופלת כמו הודעה כתובה — הבוט חוזר בשורה על מה ששמע. כמה בקשות בהודעה אחת — אחת-אחת. דורש בשרת OPENAI_API_KEY (מומלץ) או GOOGLE_SPEECH_API_KEY.',
    examples: [],
    enabled: true
  },
  {
    key: 'my_tasks', icon: '📋', label: 'המשימות שלי', channel: 'private',
    description: 'רשימת המשימות הפתוחות של הכותב: להיום, באיחור, לשבוע הקרוב או הכול.',
    examples: ['מה המשימות שלי היום?', 'מה באיחור?', 'מה יש לי השבוע?'],
    enabled: true
  },
  {
    key: 'complete', icon: '✅', label: 'סימון כבוצע', channel: 'private',
    description: 'סוגר משימה של הכותב, לפי מספר מהרשימה האחרונה או לפי השם. רק אחרי "כן".',
    examples: ['סיימתי את 2', 'סיימתי את היועץ הסניטרי'],
    enabled: true
  },
  {
    key: 'comment', icon: '💬', label: 'הערה למשימה', channel: 'private',
    description: 'מוסיף הערה פנימית למשימה, והאחראי מקבל התראה. רק אחרי "כן".',
    examples: ['תוסיף ל-3: היועץ ביקש עוד שבוע'],
    enabled: true
  },
  {
    key: 'project_tasks', icon: '📁', label: 'משימות פרויקט', channel: 'private',
    description: 'המשימות הפתוחות בפרויקט — רק מה שהכותב רשאי לראות באפליקציה.',
    examples: ['מה פתוח באלעד?'],
    enabled: true
  },
  {
    key: 'summary', icon: '☀️', label: 'סיכום בוקר', channel: 'proactive',
    description: 'בימים א׳–ה׳, בשעה שנקבעה בהגדרות: הודעה לכל עובד עם טלפון שיש לו משימות להיום או באיחור. מי שאין לו — לא מקבל.',
    examples: [],
    enabled: false
  },
  {
    key: 'meeting_reminder', icon: '📅', label: 'התראה לפני פגישה', channel: 'proactive',
    description: 'כמה דקות לפני פגישה שנקבעה ממשימון (ההגדרה "קביעת פגישות" בהגדרות): הודעה לבעל היומן, למי שקבע ולכל משתתף מהארגון שיש לו טלפון — עם קישור ה-Zoom. פגישה שבוטלה ביומן — בלי הודעה.',
    examples: [],
    enabled: true
  },
  {
    key: 'assignment_notice', icon: '📌', label: 'קיבלת משימה', channel: 'proactive',
    description: 'כשמישהו משייך משימה לעובד עם טלפון: הודעה ממנו בוואטסאפ עם הכותרת, היעד והקישור. כל עובד יכול לכבות לעצמו בהגדרות ההתראות (וגם את המייל). מחוץ לשעות הפעילות — נשלחת כשהחלון נפתח.',
    examples: [],
    enabled: true
  },
  {
    key: 'phonebook', icon: '📒', label: 'איש קשר מהאלפון', channel: 'private',
    description: 'מחזיר את הכרטיס המלא מהאלפון הארגוני: שם מלא, טלפונים, פקס, מייל והערות — רק מה שהוזן. מחפש לפי שם, טלפון או מילה מההערה; כמה התאמות — עד שלושה כרטיסים.',
    examples: ['מה הטלפון של דני כהן?', 'תן לי את איש הקשר של היועץ הסניטרי'],
    enabled: true
  },
  {
    key: 'help', icon: '❓', label: 'עזרה', channel: 'private',
    description: 'מה הבוט יודע לעשות — הפעולות שמופעלות לכותב, עם הדוגמאות שכאן.',
    examples: ['מה אתה יודע לעשות?'],
    enabled: true
  }
];

const AUDIENCES = ['all', 'managers'];

/** הקטלוג עם מה שנשמר במסך הניהול */
function list() {
  const saved = D.getSetting('wa_actions', {}) ?? {};
  return ACTIONS.map((a) => {
    const s = saved[a.key] ?? {};
    return {
      ...a,
      enabled: typeof s.enabled === 'boolean' ? s.enabled : a.enabled,
      audience: AUDIENCES.includes(s.audience) ? s.audience : 'all',
      examples: Array.isArray(s.examples) ? s.examples : a.examples,
      defaultExamples: a.examples
    };
  });
}

const byKey = (key) => list().find((a) => a.key === key) ?? null;

/** מנהל = מי שאינו עובד מן השורה. הנהלה ומנהלי מחלקות */
const isManager = (actor) => actor?.type === 'user' && actor.role !== 'employee';

function allowed(actor, key) {
  const a = byKey(key);
  return Boolean(a?.enabled && (a.audience === 'all' || isManager(actor)));
}

const forActor = (actor) => list().filter((a) => a.channel === 'private' && allowed(actor, a.key));

function save(input) {
  const saved = {};
  for (const a of ACTIONS) {
    const x = (Array.isArray(input) ? input : []).find((i) => i?.key === a.key);
    if (!x) continue;
    saved[a.key] = {
      enabled: Boolean(x.enabled),
      audience: AUDIENCES.includes(x.audience) ? x.audience : 'all',
      examples: (Array.isArray(x.examples) ? x.examples : []).map((e) => String(e).trim().slice(0, 200)).filter(Boolean).slice(0, 6)
    };
  }
  D.setSetting('wa_actions', saved);
}

module.exports = { list, byKey, allowed, forActor, save, isManager };
