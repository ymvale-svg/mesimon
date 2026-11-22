'use strict';
/**
 * בוט הוואטסאפ — הקלטת פגישה מוואטסאפ, לוגו, ושאלות אחרי פגישה מוקלטת.
 * פוצל מ-‎wa-bot.js‎ (11.11.26). מייבא רק מהשכבות שמתחתיו: wa-base ← wa-groups ← wa-private ← wa-tasks ← wa-proactive ← wa-mail ← wa-menu.
 */
const D = require('../core').Db;
const Auth = require('../core').Auth;
const Speech = require('../integrations').Speech;
const WaActions = require('./wa-actions');
const WaUi = require('./wa-ui');
const GoodsReceipt = require('../priority').GoodsReceipt;
const PurchaseDemand = require('../priority').PurchaseDemand;
const MeetingFollowup = require('../meetings').MeetingFollowup;
const MeetingAudio = require('../meetings').MeetingAudio;
const MailActions = require('../mail').MailActions;
const Notice = require('./notice');
const { HISTORY_TURNS, currentMsg, hooks, log, react, recentFiles, sendButtons, sendText, splitMessage, taskLink } = require('./wa-base');
const { CANCEL, chatOf, saveChat } = require('./wa-private');
const { rememberBot } = require('./wa-tasks');
const { busyFor } = require('./wa-proactive');


// ---------------------------------------------------------------------------
// 🎙 הקלטת פגישה מוואטסאפ ← משימון (‎meeting-audio.js‎)
// ---------------------------------------------------------------------------

const meetingAudioAllowed = (actor) => actor?.type === 'user' && Boolean(hooks.files) && Speech.isEnabled() && WaActions.allowed(actor, 'meeting_audio') && WaActions.allowed(actor, 'create_task');


/** ההקלטה התקבלה: שומרים, ושואלים לאיזו פגישה לשייך */
async function receiveMeetingAudio(user, msg, base, load) {
  try {
    const file = await load();
    const r = await MeetingAudio.receive(user.id, file);
    const st = chatOf(user.id);
    saveChat(user.id, { ...st, draft: r.draft, awaiting: true, history: [...st.history, { role: 'user', text: '[🎙 הקלטת פגישה]' }, { role: 'bot', text: r.text.slice(0, 500) }].slice(-HISTORY_TURNS) });
    await sendButtons(msg.chatId, r.text, r.buttons);
    log({ ...base, text: `[🎙 הקלטת פגישה · ${(file.buf.length / 1048576).toFixed(1)}MB]`, action: 'meeting_audio', status: 'ok', result: `לאיזו פגישה? ${r.draft.options.map((o) => o.title).join(' · ') || 'אין פגישות ביומן'}`.slice(0, 300) });
  } catch (err) {
    console.error('[משימון] קליטת הקלטת פגישה נכשלה:', err.message);
    log({ ...base, text: '[🎙 הקלטת פגישה]', action: 'meeting_audio', status: 'error', result: err.message });
    await sendText(msg.chatId, 'לא הצלחתי לקבל את ההקלטה. נסו לשלוח שוב 🙏');
  }
}


const meetingAudioDeps = (actor) => ({
  actor, createTask: hooks.createTask, saveAttachment: hooks.files.saveAttachment, actorRef: hooks.files.actorRef,
  getTask: hooks.files.getTask, addComment: (a, id, text) => hooks.tasks.comment(a, id, text), taskLink
});


/** ברקע: תמלול, סיכום ומשימת הפגישה — ובסוף הודעה לעובד */
function processMeetingAudio(actor, audioId) {
  const ref = currentMsg.get(actor.id);
  setImmediate(() => deliverMeetingAudio(actor, audioId, ref, () => MeetingAudio.processAudio(audioId, meetingAudioDeps(actor))));
}

/**
 * 🎥 הקלטות ארוכות שהועלו ל-Timeless: מה שמוכן (תמליל וסיכום) — ממשיך לסיכום, למשימה ולהודעה לעובד.
 * מהסבב של הבוט; לכל היותר פעם בדקה.
 */
let lastTimelessAudio = 0;
async function timelessAudioTick(now = Date.now()) {
  if (now - lastTimelessAudio < 60000) return 0;
  lastTimelessAudio = now;
  let n = 0;
  for (const r of await MeetingAudio.timelessReady(now)) {
    const actor = Auth.loadActor('user', r.user_id);
    if (!actor) continue;
    await deliverMeetingAudio(actor, r.id, null, () => MeetingAudio.finishFromTimeless(r.id, meetingAudioDeps(actor)));
    n++;
  }
  return n;
}

/*
 * "תבדוק" / "מה עם הסיכום?" — כשיש לעובד הקלטה שמחכה ל-Timeless: בודקים עכשיו. באג 18.11.26: הבוט ענה (מה-AI)
 * "אין לי דרך לבדוק את הסטטוס", והסיכום כבר היה מוכן ב-Timeless.
 */
const STATUS_ASK = /^(?:נו|תבדוק|תבדקי|בדוק|בדקי|תבדוק שוב|אפשר לבדוק|מה (?:עם|קורה עם|עם ה?|המצב (?:של|עם)) ?ה?(?:סיכום|הקלטה|תמליל)|ה?(?:סיכום|תמליל) (?:מוכן|הגיע)|יש (?:כבר )?(?:סיכום|תמליל)|(?:עדיין|עוד) לא (?:הגיע|קיבלתי)|למה (?:עוד )?לא (?:הגיע|קיבלתי)(?: את)? ?ה?(?:סיכום)?)(?: לי)?$/;

/*
 * "תנסה שוב" — באג 18.11.26: עיבוד ההקלטה נכשל, העובד כתב "תנסה שוב" שלוש פעמים, והבוט (מה-AI) ענה "אין לי אפשרות
 * להפעיל מחדש מכאן" — והעובד שלח את ההקלטה מחדש פעמיים. הקובץ של הקלטה שנכשלה שמור יומיים (‎prune‎): מריצים אותה שוב.
 * הקלטה שמחכה ל-Timeless — כמו "תבדוק".
 */
const RETRY_ASK = /^(?:ת?נס(?:ה|י|ו)|לנסות)(?: (?:את זה|אותה|אותו))? (?:שוב|מחדש)(?: לי)?$|^(?:תעבד|תריץ|תסכם)(?: (?:אותה|את ההקלטה))? (?:שוב|מחדש)$/;
const RETRY_WITHIN_MS = 24 * 60 * 60 * 1000;

/** ‎null‎ — לא בקשה כזו, או שאין הקלטה שמחכה. אחרת — הטקסט לעובד (ומה שמוכן נשלח מיד אחריו) */
async function timelessAudioCheck(actor, t) {
  const n = WaUi.normalize(t).replace(/[?!.…]+$/g, '').trim();
  const retry = RETRY_ASK.test(n);
  if (retry && !MeetingAudio.pendingTimeless(actor.id).length) {
    const since = new Date(Date.now() - RETRY_WITHIN_MS).toISOString();
    const row = D.get("SELECT id, meeting FROM meeting_audio WHERE user_id = ? AND status = 'error' AND created_at > ? ORDER BY id DESC LIMIT 1", actor.id, since);
    if (!row) return null;
    const title = (() => { try { return JSON.parse(row.meeting)?.title ?? ''; } catch { return ''; } })();
    processMeetingAudio(actor, row.id);
    return `🔁 מנסה שוב לתמלל ולסכם את ההקלטה${title ? ` של *${title}*` : ''} ⏳ — לא צריך לשלוח אותה מחדש. אשלח לך את הסיכום כשהוא מוכן.`;
  }
  if (!(STATUS_ASK.test(n) || retry) || !MeetingAudio.pendingTimeless(actor.id).length) return null;
  const r = await MeetingAudio.checkTimelessNow(actor.id);
  for (const id of r.ready) {
    setImmediate(() => deliverMeetingAudio(actor, id, null, () => MeetingAudio.finishFromTimeless(id, meetingAudioDeps(actor))));
  }
  const lines = r.ready.length ? ['✅ בדקתי ב-Timeless — הסיכום מוכן. שולח לך אותו עכשיו.'] : [];
  for (const w of r.waiting) {
    const where = w.status && w.status !== 'completed' ? 'עדיין בעיבוד' : w.transcript ? 'התמליל מוכן, הסיכום עוד לא' : !w.status ? 'עוד לא מופיעה שם' : 'עדיין בעיבוד';
    lines.push(`⏳ *${w.title}* — בדקתי עכשיו ב-Timeless: ${where}. אבדוק שוב בעצמי כל רבע שעה, ואשלח ברגע שמוכן.`);
  }
  return lines.join('\n');
}

/** מריץ את העיבוד ושולח לעובד את התוצאה (או הודעת שגיאה) */
async function deliverMeetingAudio(actor, audioId, ref, run) {
  const u = D.get('SELECT id, full_name, phone FROM users WHERE id = ?', actor.id);
  const chatId = `${u.phone}@c.us`;
  try {
    const r = await run();
    if (!r) return;
    const st = chatOf(actor.id);
    const busy = st.awaiting && st.draft;
    // באמצע שאלה אחרת — בלי השאלה בסוף (היא תופסת תשובות); אפשר לחזור אליה: "משימות מהפגישה" / "לשלוח למשתתפים"
    const text = r.draft && busy ? `${r.text.replace(/\n(?:📤 \*לשלוח את כל הסיכום|✏️ \*לשנות אחראי)[\s\S]*$/, '')}\n\nלשלוח את הסיכום — כתבו *לשלוח למשתתפים*; לשנות אחראי — *משימות מהפגישה*.` : r.text;
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1 && r.draft && !busy) await sendButtons(chatId, parts[i], r.buttons);
      else await sendText(chatId, parts[i]);
    }
    rememberBot(actor.id, text);
    if (r.draft && !busy) saveChat(actor.id, { ...chatOf(actor.id), draft: r.draft, awaiting: true });
    log({ channel: 'summary', chatId, userId: actor.id, who: u.full_name, action: 'meeting_audio', status: 'ok', result: text.split('\n')[0].slice(0, 300) });
    void react(ref, r.pending ? '⏳' : '✅');
  } catch (err) {
    void react(ref, '⚠️');
    console.error('[משימון] עיבוד הקלטת פגישה נכשל:', err.message);
    D.run("UPDATE meeting_audio SET status = 'error', error = ? WHERE id = ?", String(err.message).slice(0, 500), audioId);
    log({ channel: 'summary', chatId, userId: actor.id, who: u.full_name, action: 'meeting_audio', status: 'error', result: err.message.slice(0, 300) });
    // לעובד — רק מה שהוא יכול לעשות; הפרטים — ליומן ולמנהלי המערכת
    for (const a of D.all("SELECT id FROM users WHERE status = 'active' AND role IN ('superadmin','admin')")) {
      D.notify({ targetType: 'user', targetId: a.id, kind: 'ai', title: '🎙 הקלטת פגישה מוואטסאפ נכשלה', body: `${u.full_name}: ${err.message}`.slice(0, 500) });
    }
    await sendText(chatId, 'לא הצלחתי לתמלל ולסכם את ההקלטה 😕 מנהלי המערכת קיבלו הודעה. אפשר לנסות לשלוח אותה שוב מאוחר יותר.').catch(() => {});
  }
}


// 🎨 לוגו: הודעות "לוגו" ותמונה יכולות להגיע בכל סדר (וגם בסדר הפוך מזה שנשלחו — וואטסאפ לא מבטיח)
const logoArmed = new Map(); // ‎userId‎ → { name, at }

const LOGO_ARM_MS = 10 * 60 * 1000;

const isImageFile = (f) => Boolean(f) && (/^image\//i.test(f.mime ?? '') || /\.(png|jpe?g)$/i.test(f.name ?? ''));


/**
 * ‎{ name, load, fromGoods }‎ — לשמור לוגו; ‎{ arm: true }‎ — "לוגו" בלי קובץ: מחכים לקובץ; ‎null‎ — לא לוגו.
 */
function logoIntent(userId, msg, text) {
  const cap = Notice.logoCaption(text);
  const download = (f) => () => (f.buf ? Promise.resolve({ buf: f.buf, mime: f.mime }) : Speech.download(f.url, f.mime));
  if (msg.file && isImageFile(msg.file)) {
    if (cap) return { name: cap.name, load: download(msg.file) };
    const armed = logoArmed.get(userId);
    if (armed && Date.now() - armed.at < LOGO_ARM_MS && !String(text ?? '').trim()) {
      logoArmed.delete(userId);
      return { name: armed.name, load: download(msg.file) };
    }
    return null;
  }
  if (!cap || msg.file) return null;
  // הקובץ שנשלח רגע לפני: מחכה לשאלה "לקלוט כקבלת סחורה?", או שנשמר כקובץ אחרון
  const gr = GoodsReceipt._load(userId);
  const grFile = gr?.step === 'offer' && Date.now() - (gr.startedAt ?? 0) < LOGO_ARM_MS ? gr.files?.[0] : null;
  if (grFile && /png|jpe?g/i.test(grFile.mime ?? '')) {
    return { name: cap.name, fromGoods: true, load: async () => ({ buf: require('node:fs').readFileSync(grFile.path), mime: grFile.mime }) };
  }
  const recent = recentFiles.get(userId);
  if (recent && Date.now() - recent.at < LOGO_ARM_MS && isImageFile(recent.file)) {
    recentFiles.delete(userId);
    return { name: cap.name, load: download(recent.file) };
  }
  logoArmed.set(userId, { name: cap.name, at: Date.now() });
  return { arm: true };
}


const TRANSLATE = /^(?:תתרגם|תרגם|תתרגמי|תרגמי|תרגום)\s+(?:את\s+(?:זה|ה(?:הודעה|טקסט))\s+)?(?:ל|לשפה\s+ה?)(אנגלית|ערבית|רוסית|צרפתית|ספרדית|גרמנית|אמהרית|תאילנדית|רומנית|סינית|טורקית|עברית)\s*[:\-–]?\s*([\s\S]*)$/;


/**
 * מה שזרימה של פריוריטי (קבלת סחורה, דרישת רכש) ענתה — ליומן, כמו בשאר הבוט: הטקסט, הקבצים והכפתורים.
 * בלי זה הסקירה הלילית לא רואה מה העובד קיבל, בדיוק בזרימות העמוסות. ‎pass‎ — לא נענה כאן (עבר לבוט הרגיל)
 */
function flowReply(r, pre = '') {
  if (!r || r.pass) return '';
  const texts = (r.replies ?? []).map((x, i) => (i === 0 && pre ? `${pre}\n\n${x}` : x)).filter((x) => String(x ?? '').trim());
  return [
    ...(r.files ?? []).map((f) => `[📄 ${f.fileName}]`),
    ...texts,
    r.buttons?.length ? `[${r.buttons.join(' · ')}]` : null
  ].filter(Boolean).join('\n\n');
}


// ---------------------------------------------------------------------------
// 🎥 אחרי פגישה מוקלטת — הבוט שואל את המשתתפים מה לשלוח (‎meeting-followup.js‎)
// ---------------------------------------------------------------------------

let followupsAt = 0;

async function meetingFollowups() {
  if (!WaActions.byKey('meeting_followup')?.enabled || Date.now() - followupsAt < 2 * 60 * 1000) return;
  followupsAt = Date.now();
  await MeetingFollowup.sweep({
    eligible: (userId) => {
      if (D.userPrefs(userId)?.botPrefs?.meetingFollowup === false) return false;
      const actor = Auth.loadActor('user', userId);
      return Boolean(actor && WaActions.allowed(actor, 'meeting_followup'));
    },
    // באמצע שיחה מול הבוט — לא קוטעים; הפנייה מחכה לסבב הבא
    busy: (userId) => busyFor(userId) || GoodsReceipt.active(userId) || PurchaseDemand.active(userId),
    // ‎draft‎ — 📝 "לשלוח את הסיכום גם למשתתפים מבחוץ?" למי שקבע: נשמר כשאלה שמחכה ל"כן" / "לא"
    send: async (userId, text, buttons, m, { draft = null } = {}) => {
      const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ?", userId);
      const chatId = `${u.phone}@c.us`;
      try {
        await sendButtons(chatId, text, buttons, draft ? { owner: 'chat', draft, awaiting: true } : null);
        if (draft) saveChat(userId, { ...chatOf(userId), draft: { ...draft, askedAt: D.nowIso() }, awaiting: true });
        rememberBot(userId, text);
        MailActions.noteProactive(userId);
        log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'meeting_followup', status: 'ok', result: `🎥 ${m.title} (${m.source})`.slice(0, 300), taskId: m.data?.taskId ?? null });
      } catch (err) {
        log({ channel: 'summary', chatId, userId, who: u.full_name, action: 'meeting_followup', status: 'error', result: err.message });
      }
    }
  }).catch((err) => console.error('[משימון] פנייה אחרי פגישה נכשלה:', err.message));
  MeetingFollowup.prune();
  MeetingAudio.prune();
}


// "תפתח את המשימות", "לפתוח אותן", "תפתח רק 1 ו-3" — ‎[1]‎ המשימות, ‎[2]‎ המספרים
const OPEN_WORDS = /^(?:תפתח|פתח|לפתוח|תפתחי)(?:\s+לי)?(?:\s+(אותן|את\s+(?:כל\s+)?ה?משימות|(?:כל\s+)?ה?משימות)(?:\s+מה?פגישה)?)?(?:\s+(?:רק\s+)?(\d[\d\s,ו\-]*))?$/;

/**
 * תשובה לשאלות של הקלטת הפגישה — "לאיזו פגישה?" ו"לפתוח את המשימות?". ‎null‎ — לא שלנו.
 * ‎converse‎ — מהניתוב (‎wa-bot.js‎): הודעה קולית רגילה מתומללת ומטופלת כמו כל הודעה.
 */
async function meetingAudioTurn(user, actor, t, state, { dry, out, converse }) {
  const d = state.draft;
  if (!d || !state.awaiting) return null;
  const n = WaUi.normalize(t);
  if (d.kind === 'meeting_audio_pick') {
    if (CANCEL.test(t) || WaUi.CANCEL.test(n)) {
      return out('בסדר, ההקלטה לא שויכה 👍', { draft: null }, { action: 'meeting_audio', status: 'ok', result: 'בוטל' });
    }
    const pick = MeetingAudio.resolvePick(d, t);
    if (!pick) {
      return out('לא הבנתי לאיזו פגישה 🤔 בחרו בכפתור, או כתבו נושא ומשתתפים.', { draft: d, awaiting: true },
        { action: 'meeting_audio', status: 'unclear', result: `לא זוהתה פגישה: ${t}`.slice(0, 300), buttons: [...d.options.map((o) => o.label), MeetingAudio.BTN.other] });
    }
    if (pick.ask) return out(pick.ask, { draft: d, awaiting: true }, { action: 'meeting_audio', status: 'ok', result: 'פגישה אחרת' });
    if (pick.voice) {
      // בכל זאת הודעה קולית רגילה — מתמללים ומטפלים בה כמו בכל הודעה
      const row = D.get('SELECT * FROM meeting_audio WHERE id = ? AND user_id = ?', d.audioId, actor.id);
      const file = row ? require('node:path').join(D.UPLOADS_DIR, 'meeting-audio', row.stored_name) : null;
      let said = '';
      try { said = file ? await Speech.transcribe(require('node:fs').readFileSync(file), row.mime) : ''; } catch { /* ריק */ }
      if (row) { D.run("UPDATE meeting_audio SET status = 'expired' WHERE id = ?", row.id); try { require('node:fs').unlinkSync(file); } catch { /* */ } }
      if (!said) return out('לא שמעתי דיבור בהודעה. נסו שוב, או כתבו לי.', { draft: null }, { action: 'voice', status: 'unclear', result: 'לא נשמע דיבור' });
      const r = await converse(user, actor, said, { ...state, draft: null, awaiting: false }, { dry });
      return { ...r, reply: `🎙 _${said.slice(0, 300)}_\n\n${r.reply}` };
    }
    const m = pick.meeting;
    if (dry) return out(`(בדיקה) הייתי משייך את ההקלטה ל"${m.title}" ומתמלל.`, { draft: null }, { action: 'meeting_audio', status: 'ok', result: 'בדיקה' });
    D.run("UPDATE meeting_audio SET meeting = ?, status = 'transcribing' WHERE id = ? AND user_id = ?", JSON.stringify(m), d.audioId, actor.id);
    processMeetingAudio(actor, d.audioId);
    const who = m.people.length ? `\n👥 ${m.people.map((p) => p.name || p.email).slice(0, 8).join(', ')}` : '\n_לא זיהיתי משתתפים מהארגון — המשימות ייפתחו אצלך, עם השם שנאמר._';
    // ⏳ על ההודעה עד שהסיכום מוכן — בלי הודעת "מתמלל ומסכם"
    return out(`📎 שייכתי ל*${m.title}*.${who}`, { draft: null },
      { action: 'meeting_audio', status: 'ok', result: `שויכה ל"${m.title}" (${m.source})`.slice(0, 300), react: '⏳' });
  }
  if (d.kind === 'meeting_audio_tasks') {
    const log = (result, extra = {}) => ({ action: 'meeting_audio', status: 'ok', result: String(result).slice(0, 300), ...extra });
    // 📤 כל הסיכום במייל למשתתפים (מהמייל של העובד, אחרי אישור)
    const share = WaUi.sameLabel(n, MeetingAudio.BTN.share)
      || /^(?:לשלוח|תשלח|שלח)(?:\s+את)?(?:\s+ה?סיכום)?(?:\s+(?:ל|אל\s+)(?:כל\s+)?ה?משתתפים)?$/.test(n);
    if (share) {
      const r = await MeetingFollowup.shareFor(actor, { source: 'wa', ref: d.audioId });
      if (!r) return out('לא מצאתי את הסיכום של הפגישה הזו.', { draft: null }, log(`אין סיכום לשליחה: ${d.title}`));
      return out(r.text, r.draft ? { draft: r.draft, awaiting: true } : { draft: d, awaiting: true }, log(r.result, { buttons: r.buttons }));
    }
    if (WaUi.sameLabel(n, MeetingAudio.BTN.reassign)) {
      return out('למי להעביר? כתבו את מספרי המשימות ואת השם, למשל: *"2, 5 לגולן"*, *"1 לי"*, *"השאר לישראל"*.', { draft: d, awaiting: true }, log('לשנות אחראי — שאלה'));
    }
    // ✏️ "2, 5 לגולן" — האחראי משתנה בסיכום, וההצעה במשימון עוברת אליו
    const re = MeetingAudio.parseReassign(t);
    if (re) {
      const r = MeetingAudio.reassign(actor, d, re);
      const row = D.get('SELECT meeting, digest FROM meeting_audio WHERE id = ?', d.audioId);
      const buttons = row ? MeetingAudio.nextButtons(JSON.parse(row.meeting || '{}'), JSON.parse(row.digest || '{"items":[]}'), actor) : [];
      return out(r.text, { draft: d, awaiting: true }, log(`שינוי אחראי (${r.changed}): ${t}`, { buttons }));
    }
    // "תפתח את המשימות" / "לפתוח רק 1 ו-3" — רק כשהעובד מבקש במילים; הבוט לא מציע (16.11.26)
    const open = OPEN_WORDS.exec(n);
    if (open && (open[1] || open[2])) {
      const reply = MeetingAudio.openTasks(actor, d, {
        createTask: hooks.createTask, assignBlockReason: hooks.assignBlockReason, taskLink, dry,
        only: open[2] ? [...new Set((open[2].match(/\d+/g) ?? []).map(Number))] : null
      });
      return out(reply, { draft: null }, log(`משימות מהפגישה "${d.title}": ${reply.split('\n')[0]}`));
    }
    if (WaUi.NO.test(n) || CANCEL.test(t)) {
      return out('בסדר 👍 ההצעות מהפגישה מחכות לך במשימון.', { draft: null }, log(`לא: שליחת סיכום / שינוי אחראי מ"${d.title}"`));
    }
  }
  return null;
}

module.exports = {
  flowReply, logoIntent, meetingAudioAllowed, meetingAudioTurn, meetingFollowups, processMeetingAudio, receiveMeetingAudio, timelessAudioCheck, timelessAudioTick, TRANSLATE
};
