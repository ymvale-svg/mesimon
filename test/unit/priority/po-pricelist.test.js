'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../../helpers/db');
const PL = require('../../../server/priority/po-pricelist');

boot();
const { candidates, applicable, net, edit } = PL._internal;

const line = (o) => ({ PARTNAME: 'P-1', PDES: 'פריט', TUNITNAME: "יח'", PRICE: 10, PERCENT: 0, ...o });

test('net — המחיר אחרי הנחת השורה', () => {
  assert.equal(net(line({ PRICE: 100, PERCENT: 10 })), 90);
  assert.equal(net(line({ PRICE: 32.5 })), 32.5);
});

test('candidates — בלי 000, בלי מחיר 0; אותו מק"ט פעמיים — פעם אחת במחיר הנמוך', () => {
  const c = candidates({ lines: [
    line({ PARTNAME: '000', PDES: 'מוצר כללי', PRICE: 0 }),
    line({ PARTNAME: '000', PDES: 'משהו', PRICE: 50 }),
    line({ PARTNAME: 'A', PDES: 'צינור', PRICE: 40 }),
    line({ PARTNAME: 'A', PDES: 'צינור', PRICE: 30 }),
    line({ PARTNAME: 'B', PDES: 'דבק', PRICE: 0 }),
    line({ PARTNAME: 'C', PDES: 'זווית', PRICE: 10, PERCENT: 50 })
  ] });
  assert.deepEqual(c.map((x) => [x.part, x.price, x.prices]), [['A', 30, 2], ['C', 5, 1]]);
});

test('applicable — מחירון הפרויקט קודם, אחריו הכלליים (החדש קודם); מחירון של פרויקט אחר — לא', () => {
  const lists = [
    { name: 'G1', date: '2026-01-01T00:00:00Z', projects: [] },
    { name: 'G2', date: '2026-09-01T00:00:00Z', projects: [] },
    { name: 'P7', date: '2026-02-01T00:00:00Z', projects: ['PR7'] },
    { name: 'P8', date: '2026-10-01T00:00:00Z', projects: ['PR8'] }
  ];
  assert.deepEqual(applicable(lists, 'PR7').map((l) => l.name), ['P7', 'G2', 'G1']);
  assert.deepEqual(applicable(lists, null).map((l) => l.name), ['G2', 'G1']);
  assert.deepEqual(applicable(lists.filter((l) => l.projects.length), 'PR9'), []);
});

const offer = () => ({
  items: [
    { n: 1, part: 'A', des: 'צינור PVC 110', price: 32.5, pick: true },
    { n: 2, part: 'B', des: 'זווית PVC', price: 8.9, pick: true },
    { n: 3, part: 'C', des: 'דבק PVC', price: 41, pick: true }
  ],
  list: { name: 'P7', general: false },
  lists: [{ name: 'P7', des: 'ברזל-רכסים', general: false }, { name: '0004', des: 'טובול-כללי', general: true }]
});
const picks = (r) => r.items.filter((x) => x.pick !== false).map((x) => x.n);

test('edit — "רק 1 ו-3", "1, 3", "בלי 2", "חוץ מ-2"', () => {
  for (const [text, want] of [['רק 1 ו-3', [1, 3]], ['1, 3', [1, 3]], ['בלי 2', [1, 3]], ['חוץ מ-2', [1, 3]], ['רק 2', [2]]]) {
    const r = offer();
    assert.equal(edit(r, text), true, text);
    assert.deepEqual(picks(r), want, text);
  }
});

test('edit — לפי מילה מהתיאור: "בלי הדבק", "רק הצינור"', () => {
  let r = offer();
  assert.equal(edit(r, 'בלי הדבק'), true);
  assert.deepEqual(picks(r), [1, 2]);
  r = offer();
  assert.equal(edit(r, 'רק הצינור'), true);
  assert.deepEqual(picks(r), [1]);
});

test('edit — "שורה 2 במחיר 7.5" משנה מחיר; "מחירון 0004" / "כללי" מחליף מחירון', () => {
  let r = offer();
  assert.equal(edit(r, 'שורה 2 במחיר 7.5'), true);
  assert.equal(r.items[1].price, 7.5);
  r = offer();
  assert.equal(edit(r, 'מחירון 0004'), true);
  assert.equal(r.list.name, '0004');
  r = offer();
  assert.equal(edit(r, 'כללי'), true);
  assert.equal(r.list.name, '0004');
});

test('edit — לא הבין: מספר שאין, מילה שאין, מחירון שאין', () => {
  for (const text of ['רק 9', 'בלי מסמרים', 'מחירון 999', 'מה קורה']) assert.equal(edit(offer(), text), false, text);
});

test('isRequest — "מחירון PO26000123", "לבטל את ההוספה למחירון"; משפט רגיל — לא', () => {
  assert.equal(PL.isRequest('מחירון PO26000123'), true);
  assert.equal(PL.isRequest('להוסיף למחירון מהזמנה po26000123'), true);
  assert.equal(PL.isRequest('לבטל את ההוספה למחירון'), true);
  assert.equal(PL.isRequest('מה המחירון של טובול?'), false);
});
