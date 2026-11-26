'use strict';
/**
 * 📬 תובנות מראש רק למי שמסתכל ("תוכנית — חיסכון בקרדיטי AI.md", סעיף 9, שלב ב'): החישוב ברקע (כל 30 דק')
 * רץ רק לעובד שפתח את התובנות ב-‎ai_insights_warm_days‎ הימים האחרונים. לאחרים — כשהם מבקשים.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, user, D } = require('../../helpers/db');
const Fakes = require('../../fakes');
const MailInsights = require('../../../server/mail/mail-insights');
const Bot = require('../../../server/whatsapp/wa-bot');
const WaActions = require('../../../server/whatsapp/wa-actions');

boot();

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('‎warmWanted‎ — רק מי שהסתכל בימים האחרונים', (t) => {
  t.after(() => D.setSetting('ai_insights_warm_days', 7));
  const never = user();
  const recent = user();
  const old = user();
  D.setUserPref(recent.id, 'insightsSeenAt', daysAgo(2));
  D.setUserPref(old.id, 'insightsSeenAt', daysAgo(10));
  assert.equal(MailInsights.warmWanted(never.id), false, 'מעולם לא הסתכל');
  assert.equal(MailInsights.warmWanted(recent.id), true);
  assert.equal(MailInsights.warmWanted(old.id), false, 'לפני יותר מ-7 ימים');
  D.setSetting('ai_insights_warm_days', 0);
  assert.equal(MailInsights.warmWanted(recent.id), false, '0 — לאף אחד');
});

test('‎noteSeen‎ — מסמן שהעובד הסתכל עכשיו', () => {
  const u = user();
  MailInsights.noteSeen(u.id);
  assert.equal(MailInsights.warmWanted(u.id), true);
});

test('החישוב מראש — רק לעובד שהסתכל לאחרונה', async (t) => {
  Fakes.claude(t);
  const looking = user({ phone: '0501111111', status: 'active' });
  const away = user({ phone: '0502222222', status: 'active' });
  MailInsights.noteSeen(looking.id);
  t.mock.method(MailInsights, 'available', () => true);
  t.mock.method(WaActions, 'allowed', () => true);
  const warmed = [];
  t.mock.method(MailInsights, 'collect', async (userId) => { warmed.push(userId); return { items: [] }; });
  await Bot._internal.warmInsights();
  assert.ok(warmed.includes(looking.id), 'מי שהסתכל — מחושב מראש');
  assert.ok(!warmed.includes(away.id), 'מי שלא הסתכל — לא');
});
