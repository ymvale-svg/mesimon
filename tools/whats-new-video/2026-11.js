'use strict';
/**
 * הסצנות של גרסת נובמבר 2026 — סרטון לכל פריט ב-‎server/whats-new/2026-11.json‎.
 *
 * ‎prepare(D)‎ רץ פעם אחת על מסד הדמו, לפני ההקלטות: משימות, הצעות ותובנות
 * בשביל "אבי כהן" (מנהל המערכת בדמו), כדי שלכל חידוש יהיה מה להראות. כל
 * השמות והמספרים מומצאים. המשתמשים נמצאים לפי המייל — המספר שלהם תלוי
 * באופן שבו המסד נוצר.
 *
 * סצנה מקבלת ‎d‎ (‎director.js‎) ומשתמשת בו כמו משתמש. מה שתלוי בשירות
 * חיצוני (Gmail, AI) מבוים ב-‎setup‎ — תשובה קבועה מהשרת, רק בסרטון.
 */
const W = require('../../server/workdays');

const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const day = (n) => W.addDays(W.todayIL(), n);
const due = (n) => W.dueIso(day(n));

function prepare(D) {
  const id = (email) => D.get('SELECT id FROM users WHERE email = ?', email).id;
  const ME = id('admin@eshel.co.il');       // אבי כהן — מי שמצולם
  const RONIT = id('manager@eshel.co.il');
  const DANA = id('dana@eshel.co.il');
  const YOSSI = id('yossi@eshel.co.il');
  const board = D.get("SELECT id FROM boards WHERE type = 'internal' LIMIT 1").id;
  const dept = D.get('SELECT department_id FROM users WHERE id = ?', ME).department_id;
  const project = D.get("SELECT id FROM projects WHERE name LIKE '%תערוכת%' LIMIT 1")?.id ?? null;

  const task = (title, { assignee = ME, by = ME, status = 'new', priority = 'normal', dueIn = 3, ageMin = 60, proj = null } = {}) => Number(D.run(
    `INSERT INTO tasks (title, description, project_id, board_id, assignee_type, assignee_id, status, priority, due_date,
       created_at, created_by, status_changed_at, department_id)
     VALUES (?, '', ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
    title, proj, board, assignee, status, priority, due(dueIn), iso(ageMin), by, iso(ageMin), dept
  ).lastInsertRowid);

  // ----- המשימות של אבי ("המשימות שלי", דחיית יעד, "לסגור?" / "לעדכן?")
  const certs = task('לקבל תעודות משלוח מהספק', { priority: 'high', dueIn: 2 });
  task('לתאם ביקור באתר עם המתכננת', { dueIn: 1 });
  const deck = task('להכין מצגת לתערוכה', { status: 'in_progress', dueIn: 4, proj: project });
  task('לאשר עיצוב לביתן', { dueIn: 6, proj: project });

  // ----- משימה דומה אצל דנה — "יש כבר משימה דומה" בפתיחת "להזמין בטון לשלב ב'"
  task("הזמנת בטון לשלב ב'", { assignee: DANA, by: RONIT, status: 'in_progress', dueIn: 4, ageMin: 2 * 24 * 60 });

  // ----- זוג כפול — "למזג?"
  const keep = task('הזמנת מנוף לאתר', { assignee: DANA, by: DANA, dueIn: 5, ageMin: 3 * 24 * 60 });
  const drop = task('להזמין מנוף לאתר', { dueIn: 5, ageMin: 24 * 60 });

  // ----- "ממתין לאישורך" ו-Today: הצעות מהמייל ומהוואטסאפ
  const suggestion = (kind, fields, data, taskId = null) => D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, task_id, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ME, kind, fields.gmail ?? '', fields.header, fields.from, fields.email ?? '', fields.subject ?? '',
    iso(fields.ago ?? 30), JSON.stringify({ receivedAt: iso(fields.ago ?? 30), ...data }), taskId, iso(5)
  );
  const plain = { people: [], ambiguous: [], aiRequest: null, warning: '', checklist: [] };
  suggestion('task', { gmail: 'demo-1', header: '<demo-1@x>', from: 'משה מבטון השרון', email: 'moshe@betonsharon.co.il', subject: 'הצעת מחיר מעודכנת', ago: 50 },
    { ...plain, title: 'לאשר הצעת מחיר בטון', summary: 'משה שלח הצעה מעודכנת ומבקש אישור עד מחר', dueDate: day(1), priority: 'high' });
  suggestion('task', { gmail: 'demo-2', header: '<demo-2@x>', from: 'ניוזלטר ספקים', email: 'news@suppliers.co.il', subject: 'מבצעי החודש', ago: 80 },
    { ...plain, title: 'לעבור על מבצעי הספקים', summary: 'ניוזלטר חודשי', dueDate: '', priority: 'normal' });
  suggestion('task', { header: 'wap:2:DEMO1', from: 'יוסי מנהל עבודה', subject: 'משאבה', ago: 35 },
    { ...plain, source: 'whatsapp', personal: true, groupName: 'שיחה פרטית עם יוסי', chatPhone: '972501112233',
      title: 'לתאם משאבת בטון ליום שלישי', summary: 'יוסי מבקש לתאם משאבה לשפיכה', dueDate: day(2), priority: 'normal' });

  suggestion('task_close', { gmail: 'demo-3', header: '<demo-3@x>', from: 'משה מבטון השרון', email: 'moshe@betonsharon.co.il', subject: 'Re: תעודות משלוח', ago: 25 },
    { sync: true, channel: 'mail', taskId: certs, taskTitle: 'לקבל תעודות משלוח מהספק', fromName: 'משה מבטון השרון',
      reason: 'המייל מצרף את תעודות המשלוח', summary: '', comment: 'מצורפות התעודות. משה', proposed: null, currentDue: day(2),
      files: ['תעודות משלוח.pdf'], title: 'נראה שהמייל של משה עונה על "לקבל תעודות משלוח מהספק" — לסגור?' }, certs);
  suggestion('task_update', { header: 'wap:2:DEMO2', from: 'רונית לוי', subject: 'מצגת', ago: 20 },
    { sync: true, channel: 'personal', source: 'whatsapp', personal: true, groupName: 'שיחה פרטית עם רונית',
      taskId: deck, taskTitle: 'להכין מצגת לתערוכה', fromName: 'רונית לוי', reason: 'רונית ביקשה לדחות ביומיים',
      summary: 'התערוכה נדחתה ביומיים', comment: '', proposed: { dueDate: day(6) }, currentDue: day(4), files: [],
      title: 'רונית כתבה על "להכין מצגת לתערוכה" — לעדכן?' }, deck);
  D.run(
    `INSERT INTO ai_suggestions (user_id, kind, status, gmail_id, header_id, from_name, from_email, subject, received_at, data, task_id, created_at)
     VALUES (?, 'task_merge', 'pending', '', ?, 'משימון', '', ?, ?, ?, ?, ?)`,
    ME, `merge:${keep}:${drop}`, 'הזמנת מנוף לאתר / להזמין מנוף לאתר', iso(10),
    JSON.stringify({ merge: true, title: '🔀 למזג?', keepId: keep, keepTitle: 'הזמנת מנוף לאתר', keepOwner: 'דנה שמש',
      dropId: drop, dropTitle: 'להזמין מנוף לאתר', dropOwner: 'אבי כהן', projectName: '', reason: 'אותה הזמנה, פעמיים', receivedAt: iso(10) }),
    drop, iso(5)
  );

  // ----- תובנות מהוואטסאפ (Today)
  const insight = (n, sender, kind, importance, text, ago, dueDate = '') => D.run(
    `INSERT INTO wa_insights (scope, owner_id, chat_id, message_id, sender_name, kind, importance, insight, due_date, at, created_at)
     VALUES ('personal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ME, `9725${n}`, `DEMO-${n}`, sender, kind, importance, text, dueDate, iso(ago), iso(5)
  );
  insight('01', 'יוסי מנהל עבודה', 'action', 3, 'מבקש אישור להזמנת משאבה ליום שלישי', 90, day(2));
  insight('02', 'משה מבטון השרון', 'money', 2, 'שלח חשבונית על סך 12,400 ₪ לתשלום', 150);
  insight('03', 'רונית לוי', 'deadline', 2, 'התערוכה נדחתה ביומיים — ההגשה ביום חמישי', 200, day(4));
  insight('04', 'דנה שמש', 'info', 1, 'עדכנה שהקטלוג נשלח לדפוס', 260);

  // ----- פיד העדכונים: פעולות של אחרים בארגון
  const tasks = D.all('SELECT id FROM tasks WHERE assignee_id <> ? ORDER BY id DESC LIMIT 6', ME);
  const feed = [
    ['דנה שמש', DANA, 'status_changed', 'חדש ← בטיפול', 12],
    ['רונית לוי', RONIT, 'comment', 'הספק אישר את המועד', 25],
    ['יוסי ברק', YOSSI, 'attachment', 'תוכנית ביתן.pdf', 40],
    ['דנה שמש', DANA, 'created', 'המשימה נוצרה', 55],
    ['רונית לוי', RONIT, 'status_changed', 'בטיפול ← הושלם', 80],
    ['יוסי ברק', YOSSI, 'comment', 'מחכה לאישור תקציב', 110]
  ];
  feed.forEach(([name, who, action, details, ago], n) => {
    const t = tasks[n % tasks.length];
    if (t) D.run("INSERT INTO audit_log (task_id, actor_type, actor_id, actor_name, action, details, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?)", t.id, who, name, action, details, iso(ago));
  });

  // ----- אלפון: טלפונים לעובדים, ואנשי קשר חיצוניים
  for (const [who, mobile, office] of [[ME, '050-2223344', '03-5551200'], [RONIT, '052-3334455', '03-5551201'], [DANA, '054-4445566', '03-5551202'], [YOSSI, '053-5556677', '']]) {
    D.run('UPDATE users SET phone = ?, office_phone = ? WHERE id = ?', mobile, office, who);
  }
  for (const [name, phone, email, note] of [
    ['שרון אלמוג', '052-7654321', 'sharon@plan.co.il', 'מתכננת — פרויקט הגפן'],
    ['משה מבטון השרון', '050-1234567', 'moshe@betonsharon.co.il', 'ספק בטון'],
    ['עו"ד אורן כהן', '03-6100100', 'oren@cohen-law.co.il', 'הסכמי ספקים']
  ]) {
    D.run(`INSERT INTO phonebook (name, phone, phone_digits, email, note, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, name, phone, phone.replace(/\D/g, ''), email, note, iso(), ME, iso(), ME);
  }
}

// ---------------------------------------------------------------------------
// הסצנות
// ---------------------------------------------------------------------------

/** תשובה קבועה לבקשה מסוימת — רק בסרטון, במקום שירות חיצוני */
const stub = (page, url, body) => page.route((u) => new URL(u).pathname === url, (route) => route.fulfill({
  status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body)
}));

const scenes = {
  // 1. דף הבית בסידור שלך
  'home-grid': {
    posterAt: 0.45,
    async run(d) {
      await d.goto('home');
      await d.hold(600);
      let box = await d.spot('.home-slot[data-key="calendar"] .card-head', 'גוררים חלון מהכותרת שלו');
      await d.focus({ cx: d.W / 2, cy: 420 }, { z: 1.15 });
      await d.drag('.home-slot[data-key="calendar"] .card-head', { dx: 560, dy: 0, fx: 0.3 });
      await d.hold(700);
      box = await d.spot('.home-slot[data-key="calendar"]', 'ומשנים גודל מכל צד או פינה');
      await d.drag('.home-slot[data-key="calendar"] .slot-rz.rz-be', { dx: -160, dy: 90, steps: 26 });
      await d.hold(900);
      await d.off();
      box = await d.spot('.home-add-btn', '＋ הוספת חלון — מחזיר חלונות מוסתרים');
      await d.focus(box, { z: 1.8 });
      await d.hold(1300);
      await d.off();
      await d.wide();
    }
  },

  // 2. מצב לילה
  'dark-mode': {
    posterAt: 0.8,
    async run(d) {
      await d.goto('home');
      await d.hold(500);
      await d.click('.user-chip');
      await d.wait(600);
      const box = await d.spot('.theme-switch', 'מצב לילה — ב"החשבון שלי"');
      await d.focus(box, { z: 1.7 });
      await d.click('.theme-switch button::text=לילה');
      await d.hold(1200);
      await d.off();
      await d.press('Escape');
      await d.wide({ ms: 1300 });
      await d.hold(1800);
    }
  },

  // 3. Today עם הצעות ותובנות
  'today-insights': {
    posterAt: 0.5,
    async run(d) {
      await d.goto('home');
      await d.click('.today-btn');
      await d.wait(1500);
      let box = await d.spot('.today-sec:has(.today-mail)', 'הצעות למשימות מהמייל ומהוואטסאפ');
      await d.focus(box);
      await d.hold(900);
      await d.click('.today-sec:has(.today-mail) .today-mail-actions .btn-primary');
      await d.hold(900);
      await d.off();
      await d.scroll('.today-sec:has(.today-insight)');
      box = await d.spot('.today-sec:has(.today-insight)', 'ותובנות — מה חשוב מהיממה האחרונה');
      await d.focus(box);
      await d.hold(1800);
      await d.off();
      await d.wide();
    }
  },

  // 4. דחיית יעד בלי לפתוח משימה
  'move-due': {
    posterAt: 0.45,
    async run(d) {
      await d.goto('home');
      let box = await d.spot('.home-slot[data-key="myTasks"]', '"המשימות שלי"');
      await d.focus(box, { z: 1.4 });
      await d.point('.home-slot[data-key="myTasks"] .task-line');
      await d.wait(400);
      box = await d.spot('.home-slot[data-key="myTasks"] .task-line button.tk-move', '📅 דחיית יעד — בלי לפתוח את המשימה');
      await d.click('.home-slot[data-key="myTasks"] .task-line button.tk-move');
      await d.wait(500);
      box = await d.spot('.modal .today-pick', 'מחר, עוד שבוע, או תאריך אחר');
      await d.focus(box, { z: 1.5 });
      await d.click('.modal .today-pick button::text=מחר');
      await d.wait(700);
      box = await d.spot('.home-slot[data-key="myTasks"] .task-line', 'היעד התעדכן במקום');
      await d.focus(box, { z: 1.6 });
      await d.hold(1500);
      await d.off();
      await d.wide();
    }
  },

  // 5. "לא משימה" בלחיצה אחת
  'not-task': {
    posterAt: 0.4,
    async run(d) {
      await d.goto('home');
      const row = '.home-slot[data-key="aiInbox"] .ai-row::text=מבצעי הספקים';
      let box = await d.spot(row, 'הצעה שאינה משימה?');
      await d.focus(box, { z: 1.6 });
      await d.hold(600);
      await d.click(`.home-slot[data-key="aiInbox"] .ai-row-actions button::text=לא משימה`);
      await d.wait(900);
      await d.off();
      box = await d.spot('.home-slot[data-key="aiInbox"]', 'ירדה מהרשימה — בלחיצה אחת, בלי חלון');
      await d.focus(box, { z: 1.25 });
      await d.hold(1600);
      await d.off();
      await d.wide();
    }
  },

  // 6. "יש כבר משימה דומה"
  'similar-task': {
    posterAt: 0.75,
    async run(d) {
      await d.goto('home');
      await d.click('.topbar .btn-primary');
      await d.wait(700);
      let box = await d.spot('.modal input[placeholder="מה צריך לעשות?"]', 'פותחים משימה חדשה');
      await d.focus(box, { z: 1.5 });
      await d.click('.modal input[placeholder="מה צריך לעשות?"]');
      await d.type("להזמין בטון לשלב ב'");
      await d.off();
      await d.click('.modal .modal-foot .btn-primary::text=שמירה');
      await d.wait(1200);
      box = await d.spot('.ts-dups', 'יש כבר משימה דומה במחלקה');
      await d.focus(box, { z: 1.5 });
      await d.hold(900);
      box = await d.spot('.ts-dup button.btn-primary', 'מצטרפים — במקום לפתוח עוד אחת');
      await d.click('.ts-dup button.btn-primary');
      await d.hold(1300);
      await d.off();
      await d.wide();
    }
  },

  // 7. משימות שמתעדכנות מהתשובות
  'sync-suggestions': {
    posterAt: 0.35,
    async run(d) {
      await d.goto('home');
      await d.scroll('.home-slot[data-key="aiInbox"] .ts-row');
      let box = await d.spot('.home-slot[data-key="aiInbox"] .ai-sec:has(.ts-row)', 'הגיעה תשובה? המערכת מציעה לסגור או לעדכן');
      await d.focus(box);
      await d.hold(1300);
      await d.click('.home-slot[data-key="aiInbox"] .ts-row .ai-row-actions button::text=לסגור');
      await d.wait(1200);
      await d.off();
      box = await d.spot('.home-slot[data-key="aiInbox"] .ts-row::text=למזג', 'ומשימות כפולות — "למזג?"');
      await d.focus(box, { z: 1.6 });
      await d.hold(1700);
      await d.off();
      await d.wide();
    }
  },

  // 8. האלפון: גם עובדים וספקים
  'phonebook-people': {
    posterAt: 0.5,
    async run(d) {
      await d.goto('phonebook');
      await d.wait(600);
      let box = await d.spot('.pb-filter', 'עובדים, ספקים ואנשי קשר — באלפון אחד');
      await d.focus(box, { z: 1.6 });
      await d.click('.pb-filter-btn::text=עובדים');
      await d.wait(700);
      await d.off();
      box = await d.spot('table.pb-table tbody tr.pb-person', 'עם טלפון במשרד ונייד');
      await d.focus(box, { z: 1.5 });
      await d.hold(700);
      await d.click('table.pb-table tbody tr.pb-person a.pb-act[aria-label^="חיוג או וואטסאפ"]');
      await d.wait(700);
      box = await d.spot('.pb-choose', 'חיוג או וואטסאפ בלחיצה');
      await d.focus(box, { z: 1.6 });
      await d.hold(1600);
      await d.off();
      await d.press('Escape');
      await d.wide();
    }
  },

  // 9. משימת AI: העתק וחתימה — בלי Gmail אמיתי: התשובות מבוימות
  'ai-cc-signature': {
    posterAt: 0.85,
    async setup(page) {
      await stub(page, '/api/ai/status', {
        enabled: true, mail: true, inbox: true, gmailEnabled: true,
        gmail: { email: 'avi@eshel.co.il', state: 'ok', canSend: true, scopes: {}, missing: [], error: '', scanning: false, progress: {}, lastScanAt: null, connectedAt: '2026-10-01T08:00:00Z' },
        whatsapp: null,
        defaults: { approveReminders: false, firstChannel: 'email', emailAttempts: 2, daysBetweenEmails: 2, whatsapp: true, whatsappAttempts: 3, daysBetweenWhatsapp: 1 },
        contacts: []
      });
      await stub(page, '/api/ai/draft', {
        draft: {
          title: 'הסכם ספק — טיוטה מעודכנת', subject: 'טיוטת הסכם הספק',
          body: 'שלום רב,\nאודה לקבלת טיוטת הסכם הספק המעודכנת בהקדם.\nתודה.',
          success_criteria: 'התקבלה טיוטת ההסכם המעודכנת', contact_name: 'עו"ד אורן כהן', contact_email: 'oren@cohen-law.co.il', contact_phone: '', cc_names: []
        },
        signature: '<div dir="rtl" style="font-family:Arial;font-size:13px;color:#334155"><b>אבי כהן</b><br>מנהל שיווק ומכירות · אשל הירדן<br>03-5551200</div>',
        signatureMissing: null
      });
    },
    async run(d) {
      await d.goto('home');
      await d.eval(() => AiTaskView.openDialog({ instruction: 'לבקש מעו"ד אורן את טיוטת הסכם הספק המעודכנת', contact: { name: 'עו"ד אורן כהן', email: 'oren@cohen-law.co.il', type: 'external' } }));
      await d.wait(900);
      let box = await d.spot('.ai-cc', 'בהעתק (CC) — מוסיפים מי שצריך');
      await d.focus(box, { z: 1.5 });
      await d.click('.ai-cc .cp input');
      await d.type('רונית');
      await d.wait(700);
      await d.click('.ai-cc .cp-list .cp-row');
      await d.hold(700);
      await d.off();
      await d.click('.modal .btn-primary::text=נסח לי');
      await d.wait(1200);
      await d.scroll('.ai-signature-box');
      box = await d.spot(['.ai-signature-box'], 'והמייל יוצא עם החתימה שלך מ-Gmail');
      await d.focus(box, { z: 1.5 });
      await d.hold(1800);
      await d.off();
      await d.wide();
    }
  },

  // 10. תובנות מהמייל לפי טווח זמן — העוזר במערכת, עם תשובה מבוימת
  'insights-range': {
    posterAt: 0.7,
    async setup(page) {
      await stub(page, '/api/assistant', {
        reply: '*📬 מה היה במייל ב-48 השעות האחרונות*\n\n*דורש ממך משהו (2)*\n1. משה מבטון השרון — מבקש אישור להצעת המחיר המעודכנת\n2. עו"ד אורן כהן — שלח הערות להסכם הספק\n\n*אישורים ועדכונים (2)*\n3. בנק הפועלים — ההעברה לספק בוצעה\n4. רונית לוי — התערוכה נדחתה ביומיים',
        choices: [{ label: 'פרט על 1', say: 'פרט על 1' }, { label: 'תענה ל-2', say: 'תענה ל-2' }]
      });
    },
    async run(d) {
      await d.goto('home');
      await d.eval(() => AssistantView.open({ text: 'מה היה במייל ב-48 השעות האחרונות?', voice: false }));
      await d.wait(1600);
      const box = await d.spot('.asst-log', 'אפשר לבקש כל טווח: 48 שעות, 3 ימי עבודה…');
      await d.focus(box, { z: 1.35 });
      await d.hold(2600);
      await d.off();
      await d.wide();
    }
  },

  // 11. פיד העדכונים של הארגון — למנהלי מערכת
  'org-feed': {
    posterAt: 0.5,
    async run(d) {
      await d.goto('home');
      await d.scroll('.home-slot[data-key="feed"]');
      const box = await d.spot('.home-slot[data-key="feed"]', 'מה קרה בכל הארגון — במקום אחד');
      await d.focus(box);
      await d.hold(2400);
      await d.off();
      await d.wide();
    }
  }
};

module.exports = { prepare, scenes };
