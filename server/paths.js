'use strict';
/**
 * נתיבים לקבצי נתונים של הקוד (מיומנויות, גופנים, הגדרות סוכנים, "מה חדש"…) — במקום אחד.
 * מודול שמשתמש ב-‎__dirname‎ נשבר כשמעבירים אותו לתיקייה אחרת; מכאן — לא.
 * (מסד הנתונים והקבצים שהועלו — ב-‎db.js‎, לפי ‎DATA_DIR‎ / ‎UPLOADS_DIR‎.)
 */
const path = require('node:path');

const SERVER = __dirname;
const ROOT = path.join(SERVER, '..');
const AI = path.join(SERVER, 'ai');

module.exports = {
  ROOT,
  SERVER,
  PUBLIC: path.join(ROOT, 'public'),
  FONTS: path.join(SERVER, 'fonts'),
  WHATS_NEW: path.join(SERVER, 'whats-new'),
  /** הנחיות ה-AI (‎*.md‎) */
  SKILLS: path.join(AI, 'skills'),
  /** הסוכנים לפי מחלקה */
  AGENTS: path.join(AI, 'agents'),
  AGENTS_MANIFEST: path.join(AI, 'agents.json'),
  AGENTS_MCP: path.join(SERVER, 'agents-mcp.json'),
  TOPICS: path.join(AI, 'topics.json'),
  /** קובץ הנחיה לפי שם */
  skill: (name) => path.join(AI, 'skills', name)
};
