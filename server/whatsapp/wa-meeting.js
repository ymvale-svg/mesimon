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
  setImmediate(async () => {
    const u = D.get('SELECT id, full_name, phone FROM users WHERE id = ?', actor.id);
    const chatId = `${u.phone}@c.us`;
    try {
      const r = await MeetingAudio.processAudio(audioId, meetingAudioDeps(actor));
      const st = chatOf(actor.id);
      const busy = st.awaiting && st.draft;
      const text = r.draft && busy ? `${r.text.replace(/\n\*לפתוח את המשימות[\s\S]*$/, '')}\n\nכדי לפתוח את המשימות — כתבו *משימות מהפגישה*.` : r.text;
      const parts = splitMessage(text);
      for (let i = 0; i < parts.length; i++) {
        if (i === parts.length - 1 && r.draft && !busy) await sendButtons(chatId, parts[i], r.buttons);
        else await sendText(chatId, parts[i]);
      }
      rememberBot(actor.id, text);
      if (r.draft && !busy) saveChat(actor.id, { ...chatOf(actor.id), draft: r.draft, awaiting: true });
      log({ channel: 'summary', chatId, userId: actor.id, who: u.full_name, action: 'meeting_audio', status: 'ok', result: text.split('\n')[0].slice(0, 300) });
      void react(ref, '✅');
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
  });
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
    send: async (userId, text, buttons, m) => {
      const u = D.get("SELECT id, full_name, phone FROM users WHERE id = ?", userId);
      const chatId = `${u.phone}@c.us`;
      try {
        await sendButtons(chatId, text, buttons);
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
    const only = /^(?:רק\s+|לפתוח\s+(?:רק\s+)?)?([\d\s,ו\-]+)$/.exec(n);
    const yes = MeetingAudio.BTN.open && (WaUi.normalize(MeetingAudio.BTN.open) === n || /^לפתוח(\s+(אותן|משימות|את\s+המשימות))?$/.test(n) || WaUi.YES.test(n));
    if (yes || only) {
      const reply = MeetingAudio.openTasks(actor, d, {
        createTask: hooks.createTask, assignBlockReason: hooks.assignBlockReason, taskLink, dry,
        only: only ? [...new Set((only[1].match(/\d+/g) ?? []).map(Number))] : null
      });
      return out(reply, { draft: null }, { action: 'meeting_audio', status: 'ok', result: `משימות מהפגישה "${d.title}": ${reply.split('\n')[0]}`.slice(0, 300) });
    }
    if (WaUi.NO.test(n) || CANCEL.test(t)) return out('בסדר, לא נפתחו משימות. ההקלטה והסיכום נשארים במשימון 👍', { draft: null }, { action: 'meeting_audio', status: 'ok', result: `לא: משימות מ"${d.title}"`.slice(0, 300) });
  }
  return null;
}

module.exports = {
  flowReply, logoIntent, meetingAudioAllowed, meetingAudioTurn, meetingFollowups, processMeetingAudio, receiveMeetingAudio, TRANSLATE
};
