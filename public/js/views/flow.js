'use strict';
/**
 * תרשים זרימה למשימה — העץ כולו במבט אחד: משימת-האב, המשימות שיוצאות
 * ממנה, ותתי-המשימות של כל אחת. נפתח מבקרת המשימות ומכרטיס המשימה, רק למי
 * שנפתח לו מסך הבקרה.
 *
 * כל צומת אומר שלושה דברים: איפה זה עומד (צבע), מי אחראי, ועד מתי.
 *
 * הצבע: סטטוס הבקרה של הפרויקט כשנקבע (אותם צבעים שבטבלת הבקרה), ואם לא —
 * צבע עמודת הלוח (פתוחה / בתהליך / הושלמה). כך התרשים ממשיך את מה שכבר
 * מסומן בבקרה, ולא ממציא שפת צבעים שנייה.
 *
 * הניתוח — מה מעכב את משימת-האב:
 *   • ⛔ חסומה — משימה פתוחה שתלויה ("תלויה ב") במשימה שעוד לא הושלמה.
 *   • 🧱 חוסמת — משימה פתוחה שמשימה פתוחה אחרת מחכה לה.
 *   • ⏰ באיחור, ו"חורגת מיעד האב" — היעד שלה אחרי היעד של מי שמעליה.
 *   • 🔥 הנתיב הקריטי — שרשרת המשימות הפתוחות שקובעת מתי האב ייגמר: מהאב
 *     יורדים בכל שלב לענף (תת-משימה או משימה שתלויים בה) שמסתיים הכי
 *     מאוחר. איחור בכל צומת על הנתיב מאחר את האב כולו.
 */

const FlowView = (() => {
  const { el } = UI;
  const NS = 'http://www.w3.org/2000/svg';

  const NODE_W = 220;
  const NODE_H = 104;
  const GAP_X = 26;
  const GAP_Y = 64;
  const PAD = 24;

  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
    return n;
  };

  const time = (iso) => (iso ? new Date(iso).getTime() : null);

  /** טקסט כהה או בהיר, לפי בהירות הרקע — תווית צבעונית שנשארת קריאה */
  function inkFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m) return '#0f172a';
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0f172a' : '#ffffff';
  }

  const colorOf = (n) => n.trackColor || n.statusColor || '#94a3b8';
  const labelOf = (n) => n.trackLabel || n.statusLabel || '';

  // ------------------------------------------------------------- ניתוח

  function analyze(nodes, rootId) {
    const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
    for (const n of byId.values()) if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId).children.push(n);
    const open = (n) => n && !n.isFinal;

    // מי מחכה למי — רק בתוך העץ, ורק כשהממתינה עוד פתוחה
    const waiters = new Map();
    for (const n of byId.values()) {
      if (!open(n) || !n.dependsOn) continue;
      n.blocked = !n.dependsOn.isFinal;
      if (byId.has(n.dependsOn.id) && n.blocked) {
        if (!waiters.has(n.dependsOn.id)) waiters.set(n.dependsOn.id, []);
        waiters.get(n.dependsOn.id).push(n.id);
      }
    }
    for (const [id, list] of waiters) {
      const n = byId.get(id);
      if (open(n)) { n.blocking = true; n.waiters = list; }
    }
    for (const n of byId.values()) {
      const parent = byId.get(n.parentId);
      n.lateVsParent = open(n) && open(parent) && n.dueDate && parent.dueDate
        && time(n.dueDate) > time(parent.dueDate);
    }

    /*
     * מועד הסיום האפקטיבי: היעד של הצומת עצמו, או מאוחר ממנו — אם ענף
     * תחתיו או משימה שהוא תלוי בה מסתיימים אחריו. ‎visiting‎ עוצר מעגל
     * תלויות שנוצר בטעות.
     */
    const memo = new Map();
    const visiting = new Set();
    const finish = (n) => {
      if (!open(n)) return null;
      if (memo.has(n.id)) return memo.get(n.id);
      if (visiting.has(n.id)) return time(n.dueDate);
      visiting.add(n.id);
      let best = time(n.dueDate);
      const drivers = [...n.children.filter(open)];
      if (n.blocked && byId.has(n.dependsOn.id)) drivers.push(byId.get(n.dependsOn.id));
      for (const d of drivers) {
        const f = finish(d);
        if (f !== null && (best === null || f > best)) best = f;
      }
      visiting.delete(n.id);
      memo.set(n.id, best);
      return best;
    };

    const critical = new Set();
    const criticalEdges = new Set();   // "from>to"
    const root = byId.get(rootId);
    if (open(root)) {
      critical.add(root.id);
      let cur = root;
      for (let guard = 0; guard < byId.size; guard += 1) {
        const cands = cur.children.filter(open).map((c) => ({ n: c, kind: 'tree' }));
        if (cur.blocked && byId.has(cur.dependsOn.id) && !critical.has(cur.dependsOn.id)) {
          cands.push({ n: byId.get(cur.dependsOn.id), kind: 'dep' });
        }
        let pick = null;
        for (const c of cands) {
          const f = finish(c.n);
          if (f === null) continue;
          const pf = pick ? finish(pick.n) : null;
          if (!pick || f > pf || (f === pf && c.n.overdue && !pick.n.overdue)) pick = c;
        }
        if (!pick || critical.has(pick.n.id)) break;
        critical.add(pick.n.id);
        criticalEdges.add(pick.kind === 'dep' ? `${pick.n.id}>${cur.id}` : `${cur.id}>${pick.n.id}`);
        cur = pick.n;
      }
      // נתיב של צומת אחד אינו נתיב — אין מה להדגיש
      if (critical.size < 2) critical.clear();
    }
    for (const id of critical) byId.get(id).critical = true;

    return { byId, root, critical, criticalEdges };
  }

  // ------------------------------------------------------------- פריסה

  /**
   * פריסת עץ מלמעלה למטה: העלים מקבלים משבצות ברצף, וכל הורה ממורכז מעל
   * ילדיו. מימין לשמאל — הילד הראשון (היעד הקרוב) מימין.
   */
  function layout(root, hideDone) {
    const shown = (n) => !hideDone || !n.isFinal || n.id === root.id || n.children.some((c) => shown(c));
    let slot = 0;
    const pos = new Map();
    let maxDepth = 0;
    const place = (n, depth) => {
      maxDepth = Math.max(maxDepth, depth);
      const kids = n.children.filter(shown);
      let x;
      if (!kids.length) x = slot++;
      else {
        const xs = kids.map((k) => place(k, depth + 1));
        x = (xs[0] + xs[xs.length - 1]) / 2;
      }
      pos.set(n.id, { x, depth });
      return x;
    };
    place(root, 0);
    const width = PAD * 2 + Math.max(1, slot) * NODE_W + Math.max(0, slot - 1) * GAP_X;
    const height = PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * GAP_Y;
    for (const p of pos.values()) {
      const ltr = PAD + p.x * (NODE_W + GAP_X);
      p.left = width - ltr - NODE_W;           // מימין לשמאל
      p.top = PAD + p.depth * (NODE_H + GAP_Y);
    }
    return { pos, width, height };
  }

  // ------------------------------------------------------------- ציור

  function nodeBox(n, focusId) {
    const color = colorOf(n);
    const due = n.dueDate ? UI.dueLabel(n.dueDate) : null;
    const flags = [
      n.critical ? el('span.fl-flag.is-critical', { title: 'על הנתיב הקריטי — איחור כאן מאחר את משימת-האב' }, ['🔥']) : null,
      n.blocked ? el('span.fl-flag.is-blocked', { title: `חסומה — מחכה ל"${n.dependsOn.title}"` }, ['⛔']) : null,
      n.blocking ? el('span.fl-flag.is-blocking', { title: `חוסמת ${n.waiters.length} משימות` }, ['🧱']) : null,
      n.lateVsParent ? el('span.fl-flag.is-late', { title: 'היעד שלה אחרי היעד של המשימה שמעליה' }, ['↧']) : null
    ].filter(Boolean);
    const people = [n.assigneeName, ...(n.extraAssignees ?? [])].filter(Boolean);

    return el(`button.fl-node${n.isFinal ? '.is-done' : ''}${n.critical ? '.is-critical' : ''}${n.blocked ? '.is-blocked' : ''}${n.overdue ? '.is-overdue' : ''}${n.id === focusId ? '.is-focus' : ''}`, {
      type: 'button',
      'data-id': String(n.id),
      style: `--node-color: ${color}`,
      title: [n.title, labelOf(n), n.statusShort].filter(Boolean).join('\n'),
      onclick: () => TaskCardView.open(n.id)
    }, [
      el('div.fl-top', {}, [
        el('span.fl-status', { style: `background: ${color}; color: ${inkFor(color)}` }, [n.isFinal ? `✓ ${labelOf(n)}` : labelOf(n)]),
        el('div.spacer'),
        ...flags
      ]),
      el('div.fl-title', { text: n.title }),
      n.statusShort ? el('div.fl-short', { text: n.statusShort }) : null,
      el('div.fl-meta', {}, [
        people.length
          ? el('span.fl-who', { title: people.join(', ') }, [UI.avatar(people[0], { small: true }), el('span', { text: people.length > 1 ? `${people[0]} +${people.length - 1}` : people[0] })])
          : el('span.fl-who.is-none', { text: '👤 ללא אחראי' }),
        el('div.spacer'),
        due ? el(`span.fl-due.tone-${n.isFinal ? 'mute' : due.tone}`, { text: due.text }) : el('span.fl-due.tone-mute', { text: 'ללא יעד' })
      ])
    ]);
  }

  function edges(model, lay) {
    const { byId, criticalEdges } = model;
    const layer = svg('svg', { class: 'fl-edges', width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}` });
    const defs = svg('defs');
    for (const [id, color] of [['fl-arrow', '#f59e0b'], ['fl-arrow-red', '#dc2626']]) {
      const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      m.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
      defs.appendChild(m);
    }
    layer.appendChild(defs);

    // קווי העץ — מהאב למטה לכל ילד
    for (const n of byId.values()) {
      const a = lay.pos.get(n.parentId);
      const b = lay.pos.get(n.id);
      if (!a || !b) continue;
      const x1 = a.left + NODE_W / 2;
      const y1 = a.top + NODE_H;
      const x2 = b.left + NODE_W / 2;
      const y2 = b.top;
      const mid = y1 + GAP_Y / 2;
      const hot = criticalEdges.has(`${n.parentId}>${n.id}`);
      layer.appendChild(svg('path', {
        d: `M${x1},${y1} V${mid} H${x2} V${y2}`,
        class: `fl-edge${hot ? ' is-critical' : ''}${n.isFinal ? ' is-done' : ''}`
      }));
    }

    // תלויות — קו מקווקו מהמשימה שמחכים לה אל המשימה שמחכה
    for (const n of byId.values()) {
      if (!n.dependsOn || !byId.has(n.dependsOn.id)) continue;
      const a = lay.pos.get(n.dependsOn.id);
      const b = lay.pos.get(n.id);
      if (!a || !b) continue;
      const x1 = a.left + NODE_W / 2;
      const y1 = a.top + NODE_H / 2;
      const x2 = b.left + NODE_W / 2;
      const y2 = b.top + NODE_H / 2;
      // באותה שורה — קשת מעל הצמתים, כדי שלא תעבור דרך מי שביניהם
      const sameRow = Math.abs(y1 - y2) < 1;
      const lift = a.top - 26;
      const d = sameRow
        ? `M${x1},${a.top} C${x1},${lift} ${x2},${lift} ${x2},${b.top}`
        : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
      const blocking = n.blocked;
      const hot = criticalEdges.has(`${n.dependsOn.id}>${n.id}`);
      layer.appendChild(svg('path', {
        d,
        class: `fl-dep${blocking ? ' is-blocking' : ''}${hot ? ' is-critical' : ''}`,
        'marker-end': `url(#${blocking ? 'fl-arrow-red' : 'fl-arrow'})`
      }));
    }
    return layer;
  }

  /** מקרא — רק הצבעים שבאמת מופיעים בתרשים, בסדר שבו הם מופיעים */
  function legend(byId) {
    const seen = new Map();
    for (const n of byId.values()) {
      const key = `${colorOf(n)}|${labelOf(n)}`;
      if (!seen.has(key)) seen.set(key, { color: colorOf(n), label: labelOf(n), count: 0 });
      seen.get(key).count += 1;
    }
    return el('div.fl-legend', {}, [
      ...[...seen.values()].map((s) => el('span.fl-leg', {}, [
        el('span.fl-swatch', { style: `background: ${s.color}` }), `${s.label} (${s.count})`
      ])),
      el('span.fl-leg-sep'),
      el('span.fl-leg', {}, ['🔥 נתיב קריטי']),
      el('span.fl-leg', {}, ['⛔ חסומה']),
      el('span.fl-leg', {}, ['🧱 חוסמת']),
      el('span.fl-leg', {}, ['↧ חורגת מיעד האב']),
      el('span.fl-leg', {}, [el('span.fl-dash'), ' תלויה ב…'])
    ]);
  }

  /** רשימת החסמים — מה צריך לזוז כדי שמשימת-האב תתקדם, החמור קודם */
  function blockersPanel(model, focus) {
    const items = [];
    for (const n of model.byId.values()) {
      if (n.isFinal) continue;
      const reasons = [];
      if (n.blocking) reasons.push(`🧱 ${n.waiters.length === 1 ? `"${model.byId.get(n.waiters[0])?.title}" מחכה לה` : `${n.waiters.length} משימות מחכות לה`}`);
      if (n.blocked) reasons.push(`⛔ מחכה ל"${n.dependsOn.title}"`);
      if (n.overdue) reasons.push(`⏰ ${UI.dueLabel(n.dueDate).text}`);
      if (n.lateVsParent) reasons.push('↧ היעד אחרי היעד של המשימה שמעליה');
      if (!reasons.length) continue;
      const score = (n.critical ? 100 : 0) + (n.blocking ? 30 : 0) + (n.overdue ? 20 : 0) + (n.blocked ? 10 : 0) + (n.lateVsParent ? 5 : 0);
      items.push({ n, reasons, score });
    }
    items.sort((a, b) => b.score - a.score);

    const crit = [...model.critical].map((id) => model.byId.get(id));
    return el('div.fl-side', {}, [
      el('h4', { text: '🔥 הנתיב הקריטי' }),
      crit.length
        ? el('ol.fl-path', {}, crit.map((n) => el('li', {}, [
            el('button.txt.txt-open', { onclick: () => focus(n.id) }, [n.title]),
            el('span.mute-sm', { text: ` · ${n.assigneeName || 'ללא אחראי'}${n.dueDate ? ` · ${UI.formatDate(n.dueDate)}` : ''}` })
          ])))
        : el('div.mute-sm', { text: model.root?.isFinal ? 'משימת-האב הושלמה' : 'אין עדיין תאריכי יעד שמהם אפשר לחשב נתיב' }),
      el('h4', { text: `🚧 חסמים (${items.length})`, style: { marginTop: '14px' } }),
      items.length
        ? el('div.fl-blockers', {}, items.map(({ n, reasons }) => el('button.fl-blocker', {
            type: 'button', onclick: () => focus(n.id)
          }, [
            el('div.fl-b-title', {}, [n.critical ? '🔥 ' : '', n.title]),
            el('div.mute-sm', { text: `${n.assigneeName || 'ללא אחראי'}` }),
            ...reasons.map((r) => el('div.fl-b-reason', { text: r }))
          ])))
        : el('div.mute-sm', { text: 'אין חסמים — הכול זורם 👍' })
    ]);
  }

  // ------------------------------------------------------------- חלון

  async function open(taskId) {
    let data;
    try { data = await API.get(`/api/tasks/${taskId}/flow`); } catch (err) { return UI.error(err); }

    let hideDone = false;
    let zoom = 1;
    const model = analyze(data.nodes, data.rootId);
    const root = model.root;
    if (!root) return UI.error(new Error('המשימה לא נמצאה'));

    const stage = el('div.fl-stage');
    const canvasWrap = el('div.fl-canvas');
    const zoomLabel = el('span.mute-sm', { text: '100%' });

    const draw = () => {
      const lay = layout(root, hideDone);
      const inner = el('div.fl-inner', { style: { width: `${lay.width}px`, height: `${lay.height}px`, transform: `scale(${zoom})` } });
      inner.appendChild(edges(model, lay));
      for (const n of model.byId.values()) {
        const p = lay.pos.get(n.id);
        if (!p) continue;
        const box = nodeBox(n, data.focusId);
        box.style.left = `${p.left}px`;
        box.style.top = `${p.top}px`;
        inner.appendChild(box);
      }
      const sizer = el('div.fl-sizer', { style: { width: `${lay.width * zoom}px`, height: `${lay.height * zoom}px` } }, [inner]);
      UI.mount(canvasWrap, sizer);
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };

    const focus = (id) => {
      const node = canvasWrap.querySelector(`.fl-node[data-id="${id}"]`);
      if (!node) {
        if (hideDone) { hideDone = false; hideToggle.checked = false; draw(); return focus(id); }
        return;
      }
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      node.classList.remove('is-flash');
      void node.offsetWidth;
      node.classList.add('is-flash');
    };

    const hideToggle = el('input', { type: 'checkbox' });
    hideToggle.addEventListener('change', () => { hideDone = hideToggle.checked; draw(); });
    const setZoom = (z) => { zoom = Math.min(1.5, Math.max(0.35, Math.round(z * 100) / 100)); draw(); };
    const fit = () => {
      const lay = layout(root, hideDone);
      const w = canvasWrap.clientWidth - 8;
      setZoom(Math.min(1, w / lay.width));
    };

    const counts = [...model.byId.values()];
    const done = counts.filter((n) => n.isFinal).length;

    UI.mount(stage,
      el('div.fl-toolbar', {}, [
        data.project ? el('span.fl-project', {}, [el('span.project-dot', { style: { background: data.project.color, margin: '0' } }), data.project.name]) : null,
        el('span.mute-sm', { text: `${counts.length} משימות · ${done} הושלמו` }),
        el('div.fl-progress', { title: `${done}/${counts.length}` }, [el('span', { style: { width: `${counts.length ? (done / counts.length) * 100 : 0}%` } })]),
        el('div.spacer'),
        el('label.checkbox', {}, [hideToggle, ' הסתרת מה שהושלם']),
        el('div.seg', {}, [
          el('button', { type: 'button', title: 'הקטנה', onclick: () => setZoom(zoom - 0.1) }, ['−']),
          el('button', { type: 'button', title: 'התאמה לחלון', onclick: fit }, [zoomLabel]),
          el('button', { type: 'button', title: 'הגדלה', onclick: () => setZoom(zoom + 0.1) }, ['＋'])
        ])
      ]),
      legend(model.byId),
      el('div.fl-body', {}, [canvasWrap, blockersPanel(model, focus)])
    );

    UI.modal({ title: `🔀 תרשים זרימה — ${root.title}`, body: stage, size: 'flow' });
    draw();
    // תרשים רחב מהחלון — מוקטן כדי שייראה כולו; ואחר כך אל המשימה שממנה נפתח
    requestAnimationFrame(() => {
      const lay = layout(root, hideDone);
      if (lay.width > canvasWrap.clientWidth) fit();
      if (data.focusId !== data.rootId) focus(data.focusId);
      else canvasWrap.querySelector(`.fl-node[data-id="${data.rootId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }

  return { open };
})();
