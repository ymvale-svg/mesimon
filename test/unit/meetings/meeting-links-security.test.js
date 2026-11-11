'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../../helpers/db');
const Calendar = require('../../../server/meetings/calendar');
const TimelessMedia = require('../../../server/meetings/timeless-media');
const Followup = require('../../../server/meetings/meeting-followup');
const { Timeless } = require('../../../server/integrations');

boot();

test('videoLink — רק host מדויק של ספק מוכר', () => {
  assert.equal(Calendar.videoLink('https://us02web.zoom.us/j/123'), 'https://us02web.zoom.us/j/123');
  assert.equal(Calendar.videoLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(Calendar.videoLink('https://secure-zoom.us/j/123'), null);
  assert.equal(Calendar.videoLink('https://evil.example/zoom.us/j/1'), null);
  assert.equal(Calendar.videoLink('https://zoom.us.evil.example/j/1'), null);
  assert.equal(Calendar.videoLink('javascript:alert(1)//zoom.us'), null);
  assert.equal(Calendar.videoLink('https://meet.google.com/x', ['zoom.us']), null);
});

test('shapeEvent — קישור Zoom מתחזה בתיאור לא עובר, אמיתי עובר', () => {
  const { shapeEvent } = Calendar._internal;
  const bad = shapeEvent({ id: 'a', summary: 'x', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T11:00:00Z' },
    description: 'הצטרפו: https://secure-zoom.us/j/999', hangoutLink: 'https://evil.example/meet' }, { id: 'primary' });
  assert.equal(bad.zoomLink, null);
  assert.equal(bad.meetLink, null);
  const good = shapeEvent({ id: 'b', summary: 'x', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T11:00:00Z' },
    description: 'קודם https://secure-zoom.us/j/1 ואז https://zoom.us/j/2' }, { id: 'primary' });
  assert.equal(good.zoomLink, 'https://zoom.us/j/2');
});

test('meetingLink (התראה למזכירות) — מדלג על דומיין מתחזה', () => {
  const { meetingLink } = TimelessMedia._internal;
  assert.equal(meetingLink({ description: 'https://teams.microsoft.com.evil.example/x' }), '');
  assert.equal(meetingLink({ description: 'https://evil.example/?u=zoom.us https://teams.microsoft.com/l/meetup/1' }), 'https://teams.microsoft.com/l/meetup/1');
  assert.equal(meetingLink({ conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://zoom-us.example/j/1' }] } }), '');
});

test('timelessMatch — רק פגישה עם משתתף משותף, לא הקרובה בזמן בארגון (מהשמירה המקומית)', async (t) => {
  const { timelessMatch } = Followup._internal;
  const Store = require('../../../server/meetings').TimelessStore;
  require('../../helpers/db').boot();
  t.mock.method(Timeless, 'isConnected', () => true);
  t.mock.method(Timeless, 'scopeOf', () => ({ all: true }));
  Store._internal.upsert({ id: 'mtg_m1', status: 'completed', start_time: '2026-11-11T10:01:00Z', host: { name: 'הנהלה', email: 'ceo@corp.test' }, participants: [] });
  Store._internal.upsert({ id: 'mtg_m2', status: 'completed', start_time: '2026-11-11T10:10:00Z', participants: [{ name: 'Dana', email: 'dana@corp.test' }] });
  const start = '2026-11-11T10:00:00Z';
  assert.equal((await timelessMatch(7, start, new Set(['dana@corp.test'])))?.id, 'mtg_m2');
  assert.equal(await timelessMatch(7, start, new Set(['other@corp.test'])), null);
  assert.equal(await timelessMatch(7, start, new Set()), null);
});
