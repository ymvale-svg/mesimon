'use strict';
/**
 * 🔒 בורר סיווג למשימה ולפרויקט — נושא ורמת רגישות (‎server/ai/classification.js‎).
 * בלי נושא — רגיל: ההרשאות הרגילות בלבד. משימה בלי סיווג משלה יורשת את הפרויקט.
 * מי רואה משימה מסווגת: המשתתפים בה, ומי שטבלת הרגישות מתירה לו.
 */
const ClassPicker = (() => {
  const { el } = UI;
  const LEVELS = {
    1: '🟢 כללי',
    2: '🔵 מקצועי — מחלקות הנושא',
    3: '🟠 רגיש — מנהלים והנהלה',
    4: '🔴 סודי — הנהלה בלבד'
  };
  const topics = () => App.state.classTopics ?? [];

  /** ‎{node, value(): {topic, sens}}‎ */
  function create(current = null, { inherited = null } = {}) {
    const topicSel = el('select', {}, [
      el('option', { value: '' }, [inherited ? `כמו הפרויקט (${inherited.label})` : 'רגיל — בלי סיווג']),
      ...topics().map((t) => el('option', { value: t.key }, [t.label]))
    ]);
    topicSel.value = current?.topic ?? '';
    const sensSel = el('select');
    const fill = () => {
      const t = topics().find((x) => x.key === topicSel.value);
      sensSel.hidden = !t;
      if (!t) return;
      const prev = Number(sensSel.value) || current?.sens || 3;
      UI.mount(sensSel, ...[1, 2, 3, 4].filter((l) => l >= t.floor).map((l) => el('option', { value: String(l) }, [LEVELS[l]])));
      sensSel.value = String(Math.max(prev, t.floor));
    };
    topicSel.addEventListener('change', fill);
    fill();
    const node = el('div.row', {}, [topicSel, sensSel]);
    return {
      node,
      value: () => (topicSel.value ? { topic: topicSel.value, sens: Number(sensSel.value) } : { topic: '', sens: 0 })
    };
  }

  /** תג קטן לכרטיס ולשורה — ‎null‎ כשאין סיווג */
  function badge(cls, { inherited = false } = {}) {
    if (!cls) return null;
    return el(`span.ai-chip${cls.sens >= 3 ? '.ai-chip-warn' : ''}`, {
      text: `🔒 ${cls.label}${inherited ? ' (מהפרויקט)' : ''}`,
      title: 'משימה מסווגת: רואים אותה המשתתפים בה, ומי שטבלת הרגישות מתירה לו'
    });
  }

  const HINT = 'רגיש או סודי — רק המשתתפים, מנהלי המחלקות של הנושא וההנהלה רואים. מנהל מערכת לא רואה, וההתראות לאחרים יוצאות בלי כותרת.';

  return { create, badge, HINT };
})();
