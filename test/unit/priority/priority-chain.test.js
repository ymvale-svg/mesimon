'use strict';
/**
 * 🔗 השרשרת (‎server/priority/priority-chain.js‎): דיווחי הבוט מקדמים את המסמך שנשלח מהמסך, קליטה שהתחילה
 * בוואטסאפ נרשמת כמסמך חדש, והלוח — עובד רואה את שלו, מנהל את כל הארגון, וסופי ישן יורד מהלוח.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Chain = require('../../../server/priority/priority-chain');
const Docs = require('../../../server/priority/priority-docs');
const Access = require('../../../server/priority/priority-access');
const WaBot = require('../../../server/whatsapp').WaBot;

boot();
const PDF = Buffer.from('%PDF-1.4\n%chain\n').toString('base64');
const actor = (u) => ({ type: 'user', id: u.id, role: u.role, name: u.full_name });
function worker() { const u = user({ role: 'employee' }); Access.save([{ id: u.id, docs: ['receipt', 'demand'], companies: null }]); return u; }
const stageOf = (id) => ({ ...D.get('SELECT stage, docno, company FROM priority_docs WHERE id = ?', id) });

test('מסמך מהמסך: לבוט ← טיוטא ← סופי, על אותה שורה', async (t) => {
  const u = worker();
  t.mock.method(WaBot, 'handOver', () => true);
  const d = Docs.upload(u, { doc: 'receipt', filename: 't.pdf', mime: 'application/pdf', data: PDF });
  await Docs.toBot(u, d.id);
  assert.equal(Chain.progress(u.id, 'receipt', { stage: 'draft', docno: 'GR26000190', company: 'elad1', supplier: 'טמבור' }), d.id);
  assert.deepEqual(stageOf(d.id), { stage: 'draft', docno: 'GR26000190', company: 'elad1' });
  assert.equal(Chain.progress(u.id, 'receipt', { stage: 'done', docno: 'GR26000190' }), d.id);
  assert.equal(stageOf(d.id).stage, 'done');
  assert.throws(() => Docs.remove(u, d.id), /כבר בפריוריטי/);
});

test('קליטה שהתחילה בוואטסאפ — נרשמת כמסמך חדש; ביטול לפני טיוטא — לא נרשם', () => {
  const u = worker();
  assert.equal(Chain.progress(u.id, 'receipt', { stage: 'cancelled' }), null);
  const id = Chain.progress(u.id, 'demand', { stage: 'draft', docno: 'PD26000091', company: 'a160226', supplier: 'אלעד סנטר' });
  assert.ok(id);
  assert.equal(D.get('SELECT source FROM priority_docs WHERE id = ?', id).source, 'whatsapp');
  assert.equal(Chain.progress(u.id, 'demand', { stage: 'waiting', docno: 'PD26000091' }), id);
  assert.equal(stageOf(id).stage, 'waiting');
});

test('ביטול בבוט בלי טיוטא — המסמך יוצא מ"בטיפול בבוט"', async (t) => {
  const u = worker();
  t.mock.method(WaBot, 'handOver', () => true);
  const d = Docs.upload(u, { doc: 'receipt', filename: 'c.pdf', mime: 'application/pdf', data: PDF });
  await Docs.toBot(u, d.id);
  Chain.progress(u.id, 'receipt', { stage: 'cancelled' });
  assert.equal(stageOf(d.id).stage, 'cancelled');
});

test('דיווח לא תקין — לא זורק', () => {
  assert.equal(Chain.progress(null, 'receipt', { stage: 'draft' }), null);
  assert.equal(Chain.progress(1, 'receipt', { stage: 'nope' }), null);
});

test('הלוח: עובד — שלו; מנהל עם all — כולם; סופי ישן יורד; בוטל לא מוצג', () => {
  const a = worker();
  const b = worker();
  const admin = user({ role: 'admin' });
  const ida = Chain.progress(a.id, 'receipt', { stage: 'draft', docno: 'GR-A' });
  Chain.progress(b.id, 'demand', { stage: 'waiting', docno: 'PD-B' });
  const old = Chain.progress(a.id, 'receipt', { stage: 'done', docno: 'GR-OLD' });
  D.run('UPDATE priority_docs SET updated_at = ? WHERE id = ?', new Date(Date.now() - 20 * 86400000).toISOString(), old);
  Chain.progress(a.id, 'receipt', { stage: 'cancelled', docno: 'GR-A2' });

  const mine = Chain.board(actor(a));
  assert.deepEqual(mine.stages.map((s) => s.key), ['new', 'bot', 'draft', 'waiting', 'done']);
  assert.deepEqual(mine.columns.draft.map((c) => c.id), [ida]);
  assert.equal(mine.columns.waiting.length, 0, 'לא של אחר');
  assert.equal(mine.columns.done.some((c) => c.docno === 'GR-OLD'), false, 'סופי ישן');
  const everyone = Chain.board(actor(admin), { all: true });
  assert.ok(everyone.columns.waiting.some((c) => c.docno === 'PD-B' && c.owner));
  assert.deepEqual(Chain.board(actor(a), { doc: 'demand' }).columns.draft, [], 'סינון לפי סוג');
});
