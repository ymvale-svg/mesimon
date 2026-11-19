'use strict';
/**
 * 🗂 קטלוג ההגדרות — המקום האחד שבו מוגדרת כל הגדרה (הוחלט 15.11.26, "תוכנית — חלוקת תפקידים בוט ומשימון.md" סעיף 5).
 *
 * שלושה סוגים, ולכל אחד מקום אחד:
 *   • ‎SYSTEM‎ — הגדרת מערכת: לשונית ב"ניהול המערכת ← הגדרות מערכת", שם והסבר. רק מנהל מערכת משנה.
 *     ‎screen‎ — נערכת במסך משלה (הבוט, הסוכנים, פריוריטי) ולא בטופס הכללי. ‎hidden‎ — בלי מסך, בכוונה (עם סיבה).
 *   • ‎INTERNAL‎ — מצב פנימי של הקוד (מתי רץ, מה כבר נשלח, מעבר גרסה). לא הגדרה — לא מוצג ולא נערך.
 *   • ‎PERSONAL‎ — הגדרה אישית של עובד: ב-‎user_prefs‎, לא כאן. מוצגת ב"ההגדרות שלי".
 * נתון של עובד אחד לא נשמר בטבלת ההגדרות של המערכת. מה שעוד שם מלפני הכלל — ‎LEGACY_PER_USER‎, רשימה שרק מצטמצמת.
 *
 * נאכף ב-‎test/unit/core/settings-catalog.test.js‎: מפתח שנקרא בקוד ואינו כאן — הבדיקה נכשלת.
 */

/** הלשוניות של "הגדרות מערכת", לפי הסדר */
const TABS = Object.freeze([
  { key: 'hours', label: "⏰ שעות וימים" },
  { key: 'mail', label: "📧 מייל" },
  { key: 'ai_tasks', label: "🤖 משימות AI" },
  { key: 'tasks', label: "📋 משימות ואוטומציות" },
  { key: 'meetings', label: "🎙 פגישות והקלטות" },
  { key: 'knowledge', label: "📚 ידע וסוכנים" },
  { key: 'models', label: "🧠 מודלים" },
  { key: 'org', label: "🏢 הארגון" }
]);

/** הגדרות שבטופס הכללי — לפי לשונית */
const FORM = {
  // ⏰ שעות וימים
  ai_send_window: { tab: 'hours', label: "משימות AI: שעות שליחה", hint: "שעון ישראל, בפורמט 08:30-18:00. תזכורת שמועדה נופל מחוץ לשעות תצא בתחילת החלון הבא" },
  ai_scan_time: { tab: 'hours', label: "סריקת מיילים: שעת ריצת הבוקר", hint: "שעון ישראל, בפורמט 07:00. באותה שעה נשלחת גם ההודעה \"היום יוצאים\"" },
  mail_memory_hours: { tab: 'hours', label: "🧠 זיכרון העבודה: שעות קריאת ההיסטוריה", hint: "שעון ישראל, בפורמט 19:00-07:00. ריק = כל שעה. עדכון הבוקר רץ בכל מקרה" },
  mail_memory_night_hours: { tab: 'hours', label: "🌙 שעות מצב הלילה", hint: "שעון ישראל, בפורמט 19:00-07:00" },
  meeting_hours: { tab: 'hours', label: "פגישות: שעות לפגישות", hint: "שעון ישראל, בפורמט 08:30-18:00. הצעת מועדים ושורת הזמינות — רק בתוך השעות האלה" },
  wa_hours: { tab: 'hours', label: "🤖 הבוט: שעות פעילות", hint: "שעון ישראל, למשל 07:00-22:00. ריק = כל היום. מחוץ לשעות הבוט לא שולח (הודעות שנכתבו לו נענות כשהחלון נפתח). שבת — בלשונית הבוט" },
  wa_proactive_hours: { tab: 'hours', label: "🕗 שעות הודעות יזומות", hint: "הבוט פונה מעצמו (הצעות תשובה, תזכורות, חשבוניות, טיפים) רק בשעות האלה, ובימי העבודה של העובד" },
  remind_hours: { tab: 'hours', label: "🐣 תזכורות \"זכרת?\" — שעות", hint: "בתוך שעות ההודעות היזומות" },
  digest_morning: { tab: 'hours', label: "☀️ סיכום הבוקר — שעה", hint: "ההודעה היזומה הראשונה של היום" },
  digest_evening: { tab: 'hours', label: "🌙 סיכום סוף היום — שעה", hint: "ההודעה היזומה האחרונה של היום" },
  bot_tip_time: { tab: 'hours', label: "💡 הטיפ היומי — משעה", hint: "\"ידעת שהבוט יודע…?\" — פעם ביום" },
  bot_tip_until: { tab: 'hours', label: "💡 הטיפ היומי — עד שעה", hint: "עובד שלא התפנה עד אז — לא מקבל טיפ באותו יום" },
  mail_digest_time: { tab: 'hours', label: "📬 \"N מיילים מחכים לך\" — משעה", hint: "ההודעה המרוכזת של הצהריים, פעם ביום" },
  // 📧 מייל
  ai_mail_scan_enabled: { tab: 'mail', label: "סריקת מיילים: פעילה", hint: "מיילים שלא נקראו בתיבת ה-Gmail של כל משתמש שחיבר אותה הופכים להצעות משימה" },
  ai_scan_daily_limit: { tab: 'mail', label: "סריקת מיילים: תקרה יומית למשתמש", hint: "כל מייל הוא קריאה ל-AI. מה שמעבר לתקרה נסרק למחרת" },
  mail_reply_suggest: { tab: 'mail', label: "📧 הצעת תשובה מוכנה למייל", hint: "למייל שאדם מחכה בו לתשובה — טיוטה ב\"ממתין לאישורך\", לפי תשובות קודמות, הזיכרון והידע הארגוני. נשלחת רק בלחיצה" },
  mail_memory_enabled: { tab: 'mail', label: "🧠 זיכרון העבודה: פעיל", hint: "סריקת כל היסטוריית המייל של המשתמש, אחרי שאישר את הערכת העלות" },
  mail_memory_auto: { tab: 'mail', label: "🧠 זיכרון העבודה: סריקה אוטומטית", hint: "דלוק: כל עובד שחיבר Gmail נסרק לבד, בלי הפעלה ובלי אישור עלות, והעובדים אינם רואים את זה. השליטה — \"ניהול ← 🤖 סוכנים וידע ארגוני ← 🧠 זיכרון\"" },
  mail_memory_users: { tab: 'mail', label: "🧠 זיכרון העבודה: מי משתתף", hint: "* = כל העובדים (ברירת המחדל) · ריק = מנהלי מערכת בלבד · או רשימת כתובות מייל מופרדות בפסיק" },
  mail_memory_nightly_threads: { tab: 'mail', label: "🧠 זיכרון העבודה: שרשורים ביום למשתמש", hint: "התקציב היומי של הקריאה — גם בלילה. כל שרשור הוא קריאה אחת ל-AI" },
  mail_memory_doc_mb: { tab: 'mail', label: "📎 זיכרון העבודה: גודל מרבי לפענוח קובץ (MB)", hint: "קובץ מצורף גדול מזה לא מפוענח בסריקה — רק נרשם. הסוכן מבקש לפענח אותו כשהוא נחוץ לשאלה, ומודיע כשהתשובה מוכנה" },
  mail_memory_night: { tab: 'mail', label: "🌙 זיכרון העבודה: מצב לילה", hint: "בשעות הלילה — עד 2 שרשורים במקביל וסבבים ברצף, עדיין עם התקרה היומית. עוצר כשהמעבד עמוס או כשמישהו שואל סוכן" },
  mail_memory_night_mem_mb: { tab: 'mail', label: "🌙 מצב לילה: תקרת זיכרון (MB)", hint: "בלילה נקראים עד 2 שרשורים במקביל — כל עוד זיכרון השרת מתחת לזה. 1400 מתאים לתוכנית של 2GB; בתוכנית של 512MB — 350" },
  mail_doc_expiry_days: { tab: 'mail', label: "📎 מסמכים: ימים לפני תום תוקף", hint: "חוזה, היתר או ביטוח שתוקפם מתקרב — הצעה לחדש ב\"ממתין לאישורך\"" },
  mail_ask_daily_limit: { tab: 'mail', label: "🔎 שאל את המיילים: שאלות ביום למשתמש", hint: "כל שאלה היא שתי קריאות ל-AI" },
  // 🤖 משימות AI
  ai_email_attempts: { tab: 'ai_tasks', label: "משימות AI: מיילים שלא נענו לפני מעבר לוואטסאפ", hint: "כולל הפנייה הראשונה. 2 = פנייה ותזכורת אחת" },
  ai_days_between_emails: { tab: 'ai_tasks', label: "משימות AI: ימי עבודה בין מיילים", hint: "" },
  ai_whatsapp_enabled: { tab: 'ai_tasks', label: "משימות AI: המשך מעקב בוואטסאפ", hint: "מהמספר האישי של מי שפתח את המשימה, אם חיבר את הוואטסאפ שלו" },
  ai_whatsapp_attempts: { tab: 'ai_tasks', label: "משימות AI: הודעות וואטסאפ שלא נענו לפני עצירה", hint: "אחרי זה המעקב נעצר ומי שפתח את המשימה מקבל התראה" },
  ai_days_between_whatsapp: { tab: 'ai_tasks', label: "משימות AI: ימי עבודה בין הודעות וואטסאפ", hint: "" },
  ai_work_days_only: { tab: 'ai_tasks', label: "משימות AI: שליחה בימי עבודה בלבד", hint: "בלי שישי ושבת" },
  ai_auto_thanks: { tab: 'ai_tasks', label: "משימות AI: הודעת תודה כשהבקשה התקבלה", hint: "שורה או שתיים, באותו ערוץ שבו הגיעה התשובה" },
  ai_poll_minutes: { tab: 'ai_tasks', label: "משימות AI: תדירות בדיקת תשובות (דקות)", hint: "" },
  ai_approve_reminders: { tab: 'ai_tasks', label: "משימות AI: כל תזכורת באישור", hint: "ברירת המחדל לכולם. כבוי = תזכורות יוצאות לבד לפי המדיניות. כל משתמש וכל משימה יכולים לשנות לעצמם" },
  ai_internal_attempts: { tab: 'ai_tasks', label: "משימות AI לעובד: תזכורות במערכת לפני עצירה", hint: "כשהנמען הוא עובד בארגון, המעקב הוא התראות במשימון — בלי מייל ובלי וואטסאפ" },
  // 📋 משימות ואוטומציות
  auto_done_on_checklist: { tab: 'tasks', label: "צ׳קליסט מלא סוגר את המשימה", hint: "סימון הסעיף האחרון מעביר את המשימה ל\"הושלם\" בלי לסמן אותה שוב בדף הבית, וסעיף שנפתח מחדש מחזיר אותה ל\"בטיפול\". חל על משימות פנימיות שיש בהן צ׳קליסט; זרימת הספקים נשארת ידנית" },
  archive_done_after_days: { tab: 'tasks', label: "ימים עד שמשימה שהושלמה עוברת לארכיון", hint: "עד אז היא נשארת בכרטיס \"הושלמו לאחרונה\" בדף הבית, כדי שאפשר יהיה לראות מה נסגר ולחזור אם צריך" },
  vendor_reminder_days_before: { tab: 'tasks', label: "X — ימים לפני היעד לתזכורת ראשונה לספק", hint: "הערך שמנוע הכללים משתמש בו לתזכורת האוטומטית לספק" },
  manager_alert_hours_before: { tab: 'tasks', label: "Y — שעות לפני היעד להתראה מקדימה למנהל", hint: "ההתראה נשלחת למנהל לפני שהמשימה חורגת מהיעד" },
  escalation_hours_urgent: { tab: 'tasks', label: "שעות ללא שינוי סטטוס עד להקפצת משימה דחופה", hint: "משימה דחופה שאינה זזה מוקפצת אוטומטית לתשומת לב המנהל" },
  scheduler_interval_minutes: { tab: 'tasks', label: "תדירות הרצת מנוע הכללים (דקות)", hint: "" },
  recurring_default_policy: { tab: 'tasks', label: "מדיניות ברירת מחדל למשימות חוזרות חופפות", hint: "קובע מה קורה כשמגיע מועד למופע חדש והמופע הקודם עדיין פתוח" },
  task_closure_enabled: { tab: 'tasks', label: "💡 איך לסגור: הצעה לכל משימה מהמייל", hint: "למי לפנות, באיזה ערוץ ומה לבקש — מזיכרון המייל, משימות AI קודמות, האלפון ואנשי הקשר. שום דבר לא נשלח בלי לחיצה" },
  task_closure_all: { tab: 'tasks', label: "💡 איך לסגור: גם למשימות שלא ממייל", hint: "משימה שנפתחה ידנית, מהבוט, מהקלטה או מוואטסאפ — ההצעה מופיעה בכרטיס המשימה של האחראי" },
  task_closure_agents: { tab: 'tasks', label: "💡 איך לסגור: עצה מסוכן המחלקה", hint: "כשיש סוכן מתאים (מס, שכר, נדל\"ן…) — ההמלצה שלו מצטרפת להצעה. עולה יותר: קריאה נוספת ל-AI עם כלים" },
  // 🎙 פגישות והקלטות
  meeting_default_minutes: { tab: 'meetings', label: "פגישות: משך ברירת מחדל (דקות)", hint: "" },
  meeting_buffer_minutes: { tab: 'meetings', label: "פגישות: מרווח מפגישה צמודה (דקות)", hint: "בהצעת מועדים — לא צמוד לפגישה אחרת" },
  meeting_reminder_minutes: { tab: 'meetings', label: "פגישות: התראה לפני (דקות)", hint: "במשימון ובבוט הוואטסאפ, עם קישור ה-Zoom — לבעל היומן, למי שקבע ולמוזמנים שהם משתמשי משימון" },
  meeting_ai_alternatives: { tab: 'meetings', label: "פגישות: הצעות AI להזזת פגישות חופפות", hint: "כבוי = החלופות מסודרות לפי כללים קבועים, בלי AI" },
  meeting_record_default: { tab: 'meetings', label: "פגישות: הקלטה אוטומטית לענן — מסומן מראש", hint: "בפגישת Zoom חדשה. בכל פגישה אפשר לשנות. ההקלטות — במסך \"🎥 הקלטות Zoom\" ובבוט" },
  meeting_office_address: { tab: 'meetings', label: "פגישות: כתובת המשרד", hint: "בקביעת פגישה \"🏢 במשרד\" — הכתובת נכנסת למיקום ביומן ובהזמנה למשתתפים" },
  meeting_summary_auto: { tab: 'meetings', label: "📝 סיכום פגישה אוטומטי", hint: "כשהסיכום של Timeless מוכן: נשלח במייל (מכתובת המערכת) ובבוט לכל המשתתפים מהארגון, ונכנס לידע הארגוני. משתתפים מבחוץ — רק באישור של מי שקבע את הפגישה" },
  timeless_unrecorded_alert: { tab: 'meetings', label: "🎥 Timeless: פגישה שלא מוקלטת — הודעה למזכירות", hint: "בתחילת כל פגישה מקוונת (Zoom / Meet / Teams) ביומני העובדים שלא מוקלטת ב-Timeless: וואטסאפ והתראה למזכירות, עם הקישור להכנסה ל-Timeless. גם פגישות שלא נקבעו במשימון" },
  timeless_unrecorded_delay: { tab: 'meetings', label: "🎥 Timeless: כמה דקות אחרי תחילת הפגישה לבדוק", hint: "הזמן ש-Timeless מקבל להצטרף לפגישה לפני ההודעה" },
  // 📚 ידע וסוכנים
  agents_daily_limit: { tab: 'knowledge', label: "✨ שאל: שאלות ביום למשתמש", hint: "כל שאלה: ניתוב זול, ואז הסוכן (ולפעמים גם המיילים)" },
  org_knowledge_enabled: { tab: 'knowledge', label: "📚 ידע ארגוני: פעיל", hint: "זיקוק כל בוקר מזיכרון העבודה של כל העובדים" },
  org_merge_days: { tab: 'knowledge', label: "📚 ידע ארגוני: כל כמה ימים מאחדים", hint: "לקחים חדשים מצטרפים לערכים קיימים או יוצרים ערכים חדשים" },
  org_refresh_hours: { tab: 'knowledge', label: "📚 ידע ארגוני: כל כמה שעות מתעדכן", hint: "זיקוק לקחים ממה שנוסף לזיכרון העבודה של כל העובדים. סבב בלי חדש — בלי עלות" },
  // 🧠 מודלים
  ai_model: { tab: 'models', label: "משימות AI: מודל", hint: "מזהה המודל של Claude. ברירת המחדל: claude-opus-5-5" },
  ai_bot_model: { tab: 'models', label: "בוט והקלטה: מודל", hint: "למה שמישהו מחכה לו (בוט הוואטסאפ, ההקלטה באפליקציה). ריק = המודל הראשי. claude-haiku-5-5 — המהיר ביותר, פחות מדויק בבקשות מורכבות" },
  ai_fast_mode: { tab: 'models', label: "בוט והקלטה: מצב מהיר", hint: "אותו מודל, תשובה מהירה עד פי 2.5, במחיר כפול לקריאות האלה. רק ב-Opus; כשאינו זמין — רגיל" },
  mail_memory_model: { tab: 'models', label: "🧠 זיכרון העבודה: מודל", hint: "ברירת המחדל claude-haiku-5-5 — זול, ומספיק לסיכום שרשורים" },
  // 🏢 הארגון
  max_upload_mb: { tab: 'org', label: "גודל מרבי לקובץ (MB)", hint: "נאכף בכל העלאת קובץ — הן במשימות והן בפורטל הספקים" },
  allowed_extensions: { tab: 'org', label: "סוגי קבצים מותרים (מופרדים בפסיק)", hint: "קובץ מסוג שאינו ברשימה יידחה בהעלאה" },
  org_name: { tab: 'org', label: "שם הארגון", hint: "מופיע בכותרות המערכת ובהזמנות שנשלחות במייל" },
  public_url: { tab: 'org', label: "כתובת המערכת באינטרנט", hint: "הכתובת שממנה משתמשים נכנסים — קישורי ההזמנות במייל נבנים ממנה. לדוגמה https://mesimon.co.il. אם משאירים ריק, הקישור נבנה מהכתובת שדרכה נכנסתם." },
};

/**
 * הגדרות מערכת שנערכות במסך משלהן (לא בטופס הכללי). ‎screen‎ — איפה.
 */
const SCREEN = {
  wa_bot_enabled: { screen: 'bot', label: 'הבוט פעיל' },
  wa_quiet_minutes: { screen: 'bot', label: 'דקות שקט בקבוצות' },
  wa_actions: { screen: 'bot', label: 'פעולות הבוט ומי רואה אותן' },
  wa_summary_time: { screen: 'bot', label: 'סיכום הבוקר הישן — שעה (מוחלף ב"סיכום הבוקר")' },
  wa_shabbat: { screen: 'bot', label: 'שבת וחג — הבוט שותק' },
  wa_question_ttl_min: { screen: 'bot', label: 'דקות שבהן שאלה פתוחה עוצרת הודעות אחרות' },
  wa_topic_switch_cancels: { screen: 'bot', label: 'נושא חדש מבטל קליטה בפריוריטי' },
  speech_compare: { screen: 'bot', label: 'השוואת תמלול קולי' },
  bot_review_mailboxes: { screen: 'bot', label: 'הסקירה הלילית — תיבות המייל' },
  agents_config: { screen: 'agents', label: 'הסוכנים לפי מחלקה' },
  org_knowledge_blocklist: { screen: 'agents', label: 'ידע ארגוני — מה לא נכנס' },
  knowledge_topics: { screen: 'agents', label: 'ידע ארגוני — נושאים' },
  pd_notify_companies: { screen: 'priority', label: 'חברות שבהן מודיעים לחותם הבא' },
  priority_user_map: { screen: 'priority', label: 'שיוך משתמשי פריוריטי למשימון' }
};

/**
 * הגדרות מערכת בלי מסך — בכוונה, עם הסיבה. נקבעות בבוט ("פתח את היכולות החדשות לכולם") או נשארות על ברירת המחדל.
 * מסך בשבילן — בסבב סידור ההגדרות (סעיף 5.3); עד אז — לפחות מתועדות כאן.
 */
const HIDDEN = {
  bot_pilot: 'נקבע בבוט: "תפתח את היכולות החדשות לכולם" / "תחזיר לפיילוט"',
  briefing_minutes: 'תדריך לפני פגישה — כמה דקות לפני (ברירת מחדל 20)',
  meeting_followup_minutes: 'אחרי פגישה מוקלטת — כמה דקות לחכות לסיכום',
  meeting_audio_min_kb: 'הקלטת פגישה — גודל מינימלי (קובץ קטן מזה הוא הודעה קולית רגילה)',
  meeting_audio_timeless_min: 'הקלטת פגישה — מכמה דקות מעלים ל-Timeless (ברירת מחדל 20)',
  rfq_daily_max: 'פנייה לספקים — תקרה יומית',
  rfq_optout: 'ספקים שביקשו לא לקבל פניות (נכתב מהמייל שלהם)',
  mail_ask_memory_first: 'שאל את המיילים — קודם בזיכרון העבודה',
  mail_ask_plan_model: 'שאל את המיילים — מודל התכנון',
  ai_mail_live_minutes: 'סריקת המייל השוטפת — כל כמה דקות',
  ai_mail_live_scope: 'סריקת המייל השוטפת — אילו תיבות',
  timeless_sweep_minutes: 'Timeless — כל כמה דקות סבב',
  dup_scan_enabled: 'סריקת משימות כפולות — פעילה',
  dup_scan_time: 'סריקת משימות כפולות — שעה',
  load_alert_enabled: 'התראה על עומס בשרת',
  load_alert_cooldown_min: 'התראה על עומס — מרווח',
  company_card: 'כרטיס החברה למילוי טפסים (נכתב מהבוט: "כרטיס חברה")',
  notice_color: 'מודעות ומכתבים — צבע (נקבע בבוט)',
  notice_logos: 'מודעות ומכתבים — לוגואים (נקבע בבוט)',
  org_logo_note: 'הערה על הלוגו',
  signup_token: 'קוד הרשמה',
  timezone: 'אזור הזמן (ברירת מחדל Asia/Jerusalem)',
  instinct_phone: 'אינסטינקט — המספר שלו (ברירת מחדל בקוד)',
  instinct_users: 'אינסטינקט — מי בפיילוט (נקבע בבוט: "אינסטינקט רק לי")',
  instinct_open: 'אינסטינקט — פתוח לכולם (נקבע בבוט: "תפתח את אינסטינקט לכולם")'
};

/** מצב פנימי של הקוד — לא הגדרה. מפתחות מדויקים */
const INTERNAL = new Set([
  'agents_health_last', 'ai_morning_last', 'boot_count', 'dup_scan_last', 'installed_at', 'mail_remind_since',
  'migr_bot_pilot_open', 'migr_memory_always_on', 'migr_memory_conservative', 'org_merge_last', 'org_merge_rounds', 'org_refresh_last',
  'org_topics_migrated', 'po_notify_baseline', 'sent_fu_scanned', 'vapid_private_pem', 'vapid_public', 'wa_mail_alert_since',
  'wa_summary_sent', 'whats_new_anchors_seeded', 'whats_new_files', 'whats_new_seeded', 'mail_rescan_multibox_v1', 'timeless_webhook',
  'pd_approval_notified', 'pd_approval_unmapped', 'ai_outage', 'ai_retry',
  'pd_openers', // מי פתח כל דרישת רכש מהבוט (לפי חברה ומספר) — להודעת "אושרה"
  'pd_returned', // דרישות שהוחזרו לבדיקה ומחכות לפותח (לפי חברה ומספר) — pd-return.js
  'pd_return_chats' // שיחות פתוחות של החזרה לבדיקה (המחזיר / המסביר), לפי עובד, 30 דקות — pd-return.js
]);

/** מצב פנימי — לפי תחילית (‎digest_sent_morning‎, ‎priority_settings:1‎) */
const INTERNAL_PREFIXES = Object.freeze(['digest_sent_', 'priority_settings:', 'priority_settings_log:', 'priority_access:', 'priority_desk_doc:']);

/**
 * ⚠️ נתונים של עובד אחד שעוד יושבים בטבלת ההגדרות של המערכת, מלפני הכלל. הרשימה רק מצטמצמת:
 * כל מפתח חדש לעובד — ב-‎user_prefs‎ (העדפה) או בטבלה משלו (מצב של זרימה).
 */
const LEGACY_PER_USER = Object.freeze(['goods_receipt:', 'goods_receipt_done:', 'goods_receipt_opened:', 'purchase_demand:', 'priority_desk:', 'org_distill_', 'wa_questions:']);

/**
 * קבצים שקוראים לטבלת ההגדרות עם מפתח מחושב (לא מחרוזת קבועה). רשימה שרק מצטמצמת — מפתח חדש: מחרוזת קבועה כאן בקטלוג.
 */
const COMPUTED_KEY_FILES = Object.freeze([
  'server/api/api.js',              // שמירת הטופס — רק מפתחות מ-DEFAULT_SETTINGS
  'server/mail/mail-scan.js',
  'server/tasks/rules-engine.js',   // ‎settingKey‎ של כלל — מפתח מ-FORM
  'server/priority/goods-receipt.js',
  'server/priority/purchase-demand.js'
]);

/**
 * ⚙️ הגדרות אישיות (‎user_prefs‎) — מה העובד עצמו קובע, ובאיזו לשונית של "ההגדרות שלי".
 * ‎ui: false‎ — נשמר לבד מהשימוש במסכים (מסננים, פריסה), לא מוצג.
 */
const PERSONAL = {
  theme: { tab: 'view', label: 'מראה — בהיר / כהה / לפי המכשיר' },
  notifyKinds: { tab: 'notify', label: 'אילו התראות קופצות' },
  assignChannels: { tab: 'notify', label: 'משימה ששויכה אליי — גם במייל / בוואטסאפ' },
  botPrefs: { tab: 'bot', label: 'מה הבוט שולח לי' },
  todayDigest: { tab: 'today', label: 'Today במייל — שעה וימים' },
  todayCalendars: { tab: 'today', label: 'אילו יומנים ב-Today' },
  voice: { tab: 'today', label: 'הקלטה ומילת הפעלה' },
  aiApproveReminders: { tab: 'google', label: 'משימות AI — כל תזכורת באישורי' },
  mailAutoCreate: { tab: 'google', label: 'מייל ← משימה בלי אישור' },
  waScan: { tab: 'whatsapp', label: 'סריקת הוואטסאפ האישי' },
  mailClient: { tab: 'view', label: 'פתיחת מייל מהאלפון — Gmail / Outlook' },
  priorityPrefs: { label: 'פריוריטי — הבחירה האחרונה (סביבה, פרויקט, מחסן)', ui: false },
  boardFilters: { ui: false }, boardView: { ui: false }, projectScope: { ui: false }, sidebar: { ui: false }, mobileFilter: { ui: false },
  projectOrder: { ui: false }, trackerProject: { ui: false }, trackerScope: { ui: false }, trackerColumns: { ui: false },
  trackerCollapsed: { ui: false }, homeLayout: { ui: false }, homeProject: { ui: false }, calendarUsers: { ui: false }, calendarDock: { ui: false },
  whatsNewSeenAt: { ui: false }
};

/** הלשוניות של "ההגדרות שלי" */
const PERSONAL_TABS = Object.freeze([
  { key: 'profile', label: '👤 פרטים' }, { key: 'bot', label: '🤖 הבוט' }, { key: 'google', label: '🔗 Google ומייל' },
  { key: 'whatsapp', label: '💬 הוואטסאפ שלי' }, { key: 'today', label: '☀️ Today והקלטה' }, { key: 'location', label: '📍 מיקום' },
  { key: 'notify', label: '🔔 התראות' }, { key: 'view', label: '🎨 תצוגה' }
]);

const SYSTEM_KEYS = new Set([...Object.keys(FORM), ...Object.keys(SCREEN), ...Object.keys(HIDDEN)]);

/** המפתח מוכר? ‎'system'‎ / ‎'internal'‎ / ‎'legacy_user'‎ / ‎null‎ */
function kindOf(key) {
  const k = String(key);
  if (SYSTEM_KEYS.has(k)) return 'system';
  if (INTERNAL.has(k) || INTERNAL_PREFIXES.some((p) => k.startsWith(p))) return 'internal';
  if (LEGACY_PER_USER.some((p) => k.startsWith(p))) return 'legacy_user';
  return null;
}

/** הטופס של "הגדרות מערכת", לפי לשוניות: ‎[{ key, label, fields: [{ key, label, hint }] }]‎ */
function formTabs() {
  return TABS.map((t) => ({ ...t, fields: Object.entries(FORM).filter(([, f]) => f.tab === t.key).map(([key, f]) => ({ key, label: f.label, hint: f.hint })) }))
    .filter((t) => t.fields.length);
}

module.exports = { TABS, FORM, SCREEN, HIDDEN, INTERNAL, INTERNAL_PREFIXES, LEGACY_PER_USER, COMPUTED_KEY_FILES, PERSONAL, PERSONAL_TABS, kindOf, formTabs };
