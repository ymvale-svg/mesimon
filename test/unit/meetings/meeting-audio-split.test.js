'use strict';
/**
 * 🎙 הקלטת פגישה — חלוקה לחלקים לפני התמלול.
 * באג 18.11.26: הודעה קולית של 45 דקות (‎~5MB‎ — מתחת לסף של ‎6MB‎) נשלחה לתמלול שלמה.
 * OpenAI דחה ("longer than 1400 seconds"), ו-RunPod לא סיים תוך 90 שניות — הפגישה לא תומללה.
 * מעכשיו מחלקים גם לפי משך (עד 10 דקות לחלק), לא רק לפי גודל.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, D } = require('../../helpers/db');
const Speech = require('../../../server/integrations/speech');
const MeetingAudio = require('../../../server/meetings/meeting-audio');

boot();

const { splitOgg, oggCrc, transcribeFile, CHUNK_SEC } = MeetingAudio._internal;
const RATE = 48000; // ‎opus‎ — המיקום (granule) תמיד ב-48kHz

/** דף ogg אחד: כותרת 27 בתים, טבלת מקטעים וגוף */
function page(granule, seq, bodyLen) {
  const segs = [];
  for (let left = bodyLen; left > 0; left -= 255) segs.push(Math.min(255, left));
  if (bodyLen % 255 === 0) segs.push(0);
  const p = Buffer.alloc(27 + segs.length + bodyLen, 7);
  p.write('OggS', 0, 'latin1');
  p[4] = 0; p[5] = 0;
  p.writeBigInt64LE(BigInt(granule), 6);
  p.writeUInt32LE(1234, 14);
  p.writeUInt32LE(seq, 18);
  p.writeUInt32LE(0, 22);
  p[26] = segs.length;
  segs.forEach((s, i) => { p[27 + i] = s; });
  p.writeUInt32LE(oggCrc(p), 22);
  return p;
}

/** הודעה קולית: שני דפי כותרת, ודף שמע לכל שנייה */
function voiceNote(seconds, bytesPerSec = 150) {
  const pages = [page(0, 0, 19), page(0, 1, 40)];
  for (let s = 1; s <= seconds; s++) pages.push(page(s * RATE, s + 1, bytesPerSec));
  return Buffer.concat(pages);
}

/** משך חלק — המיקום של הדף האחרון */
function secondsOf(chunk) {
  let last = 0n;
  for (let i = 0; i + 27 <= chunk.length;) {
    const segs = chunk[i + 26];
    let body = 0;
    for (let s = 0; s < segs; s++) body += chunk[i + 27 + s];
    last = chunk.readBigInt64LE(i + 6);
    i += 27 + segs + body;
  }
  return Number(last) / RATE;
}

test('הודעה קולית של 45 דקות וקטנה מ-6MB — מתחלקת לחלקים של עד 10 דקות', () => {
  const buf = voiceNote(45 * 60);
  assert.ok(buf.length < 6 * 1024 * 1024);
  const chunks = splitOgg(buf);
  assert.equal(chunks.length, 5);
  for (const c of chunks) assert.ok(secondsOf(c) <= CHUNK_SEC, `חלק של ${secondsOf(c)} שניות`);
  assert.equal(chunks.reduce((n, c) => n + secondsOf(c), 0), 45 * 60);
});

test('הודעה קצרה — חלק אחד, כמו שהיא', () => {
  const chunks = splitOgg(voiceNote(120));
  assert.equal(chunks.length, 1);
  assert.equal(secondsOf(chunks[0]), 120);
});

test('תמלול הקלטה של 45 דקות: כל חלק נשלח לבד, והתמליל מחובר', async (t) => {
  const dir = path.join(D.UPLOADS_DIR, 'meeting-audio');
  fs.mkdirSync(dir, { recursive: true });
  const stored = `split-test-${Date.now()}.ogg`;
  fs.writeFileSync(path.join(dir, stored), voiceNote(45 * 60));
  t.after(() => fs.rmSync(path.join(dir, stored), { force: true }));

  const sent = [];
  t.mock.method(Speech, 'transcribeDetailed', async (buf) => {
    sent.push(secondsOf(buf));
    return { text: `חלק ${sent.length}`, used: null, attempts: [], all: null };
  });
  const text = await transcribeFile({ stored_name: stored, mime: 'audio/ogg; codecs=opus' });
  assert.equal(sent.length, 5);
  assert.ok(sent.every((s) => s <= CHUNK_SEC));
  assert.equal(text, 'חלק 1\nחלק 2\nחלק 3\nחלק 4\nחלק 5');
});
