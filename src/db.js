import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const slidesDir = path.join(config.dataDir, 'slides');
fs.mkdirSync(slidesDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  teacher_id TEXT,
  title TEXT NOT NULL,
  presentation_id TEXT,
  status TEXT NOT NULL DEFAULT 'importing',
  status_message TEXT,
  slide_count INTEGER NOT NULL DEFAULT 0,
  current_slide INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slides (
  session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  object_id TEXT,
  title TEXT,
  image TEXT,
  PRIMARY KEY (session_code, idx)
);
CREATE TABLE IF NOT EXISTS votes (
  session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  slide_idx INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('great','confused','question')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_code, slide_idx, student_id, kind)
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  slide_idx INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  text TEXT NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS votes_session ON votes(session_code, slide_idx);
CREATE INDEX IF NOT EXISTS questions_session ON questions(session_code, slide_idx);
`);

const now = () => Date.now();

// Unambiguous alphabet for join codes (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// ---------- teachers ----------
const stmt = {
  getTeacher: db.prepare('SELECT * FROM teachers WHERE id = ?'),
  insertTeacher: db.prepare(
    'INSERT INTO teachers (id, email, access_token, refresh_token, token_expires, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  updateTokens: db.prepare(
    'UPDATE teachers SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires = ? WHERE id = ?'
  ),
  deleteTeacher: db.prepare('DELETE FROM teachers WHERE id = ?'),

  getSession: db.prepare('SELECT * FROM sessions WHERE code = ?'),
  listSessionsForTeacher: db.prepare('SELECT * FROM sessions WHERE teacher_id = ? ORDER BY created_at DESC'),
  insertSession: db.prepare(
    'INSERT INTO sessions (code, key, teacher_id, title, presentation_id, status, status_message, slide_count, current_slide, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)'
  ),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ?, status_message = ?, slide_count = ?, title = ? WHERE code = ?'),
  setCurrentSlide: db.prepare('UPDATE sessions SET current_slide = ? WHERE code = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE code = ?'),

  deleteSlides: db.prepare('DELETE FROM slides WHERE session_code = ?'),
  upsertSlide: db.prepare(
    'INSERT INTO slides (session_code, idx, object_id, title, image) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_code, idx) DO UPDATE SET object_id = excluded.object_id, title = excluded.title, image = excluded.image'
  ),
  listSlides: db.prepare('SELECT idx, object_id, title, image FROM slides WHERE session_code = ? ORDER BY idx'),

  insertVote: db.prepare(
    'INSERT OR IGNORE INTO votes (session_code, slide_idx, student_id, kind, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  deleteVote: db.prepare('DELETE FROM votes WHERE session_code = ? AND slide_idx = ? AND student_id = ? AND kind = ?'),
  studentVotes: db.prepare('SELECT slide_idx, kind FROM votes WHERE session_code = ? AND student_id = ?'),
  countsForSession: db.prepare(
    `SELECT slide_idx,
       SUM(kind = 'great') AS great,
       SUM(kind = 'confused') AS confused,
       SUM(kind = 'question') AS question
     FROM votes WHERE session_code = ? GROUP BY slide_idx`
  ),
  distinctStudents: db.prepare('SELECT COUNT(DISTINCT student_id) AS n FROM votes WHERE session_code = ?'),

  insertQuestion: db.prepare(
    'INSERT INTO questions (session_code, slide_idx, student_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  listQuestions: db.prepare(
    'SELECT id, slide_idx, text, answered, created_at FROM questions WHERE session_code = ? ORDER BY created_at DESC'
  ),
  setQuestionAnswered: db.prepare('UPDATE questions SET answered = ? WHERE id = ? AND session_code = ?'),
  studentQuestions: db.prepare(
    'SELECT id, slide_idx, text, answered, created_at FROM questions WHERE session_code = ? AND student_id = ? ORDER BY created_at DESC'
  ),
};

export const Teachers = {
  get: (id) => stmt.getTeacher.get(id),
  create({ email, accessToken, refreshToken, expiresAt }) {
    const id = crypto.randomBytes(16).toString('hex');
    stmt.insertTeacher.run(id, email || null, accessToken, refreshToken || null, expiresAt, now());
    return stmt.getTeacher.get(id);
  },
  updateTokens(id, { accessToken, refreshToken, expiresAt }) {
    stmt.updateTokens.run(accessToken, refreshToken || null, expiresAt, id);
  },
  remove: (id) => stmt.deleteTeacher.run(id),
};

export const Sessions = {
  get: (code) => stmt.getSession.get(code),
  listForTeacher: (teacherId) => stmt.listSessionsForTeacher.all(teacherId),
  create({ teacherId, title, presentationId, status = 'importing' }) {
    let code;
    do code = randomCode(6);
    while (stmt.getSession.get(code));
    const key = crypto.randomBytes(12).toString('base64url');
    stmt.insertSession.run(code, key, teacherId || null, title, presentationId || null, status, null, now());
    return stmt.getSession.get(code);
  },
  setStatus(code, { status, message = null, slideCount, title }) {
    const s = stmt.getSession.get(code);
    if (!s) return;
    stmt.updateSessionStatus.run(
      status,
      message,
      slideCount ?? s.slide_count,
      title ?? s.title,
      code
    );
  },
  setCurrentSlide(code, idx) {
    stmt.setCurrentSlide.run(idx, code);
  },
  remove: (code) => stmt.deleteSession.run(code),
  replaceSlides: db.transaction((code, slides) => {
    stmt.deleteSlides.run(code);
    for (const s of slides) stmt.upsertSlide.run(code, s.idx, s.objectId || null, s.title || null, s.image || null);
  }),
  upsertSlide(code, s) {
    stmt.upsertSlide.run(code, s.idx, s.objectId || null, s.title || null, s.image || null);
  },
  slides: (code) => stmt.listSlides.all(code),
};

export const Votes = {
  /** Toggle a vote. Returns the student's votes for that slide afterwards. */
  toggle(code, slideIdx, studentId, kind) {
    const removed = stmt.deleteVote.run(code, slideIdx, studentId, kind).changes > 0;
    if (!removed) {
      stmt.insertVote.run(code, slideIdx, studentId, kind, now());
      // "great" and "confused" are mutually exclusive.
      if (kind === 'great') stmt.deleteVote.run(code, slideIdx, studentId, 'confused');
      if (kind === 'confused') stmt.deleteVote.run(code, slideIdx, studentId, 'great');
    }
    return !removed;
  },
  ensure(code, slideIdx, studentId, kind) {
    stmt.insertVote.run(code, slideIdx, studentId, kind, now());
  },
  forStudent: (code, studentId) => stmt.studentVotes.all(code, studentId),
  counts(code) {
    const out = {};
    for (const row of stmt.countsForSession.all(code)) {
      out[row.slide_idx] = { great: row.great, confused: row.confused, question: row.question };
    }
    return out;
  },
  participants: (code) => stmt.distinctStudents.get(code).n,
};

export const Questions = {
  add(code, slideIdx, studentId, text) {
    const info = stmt.insertQuestion.run(code, slideIdx, studentId, text, now());
    return info.lastInsertRowid;
  },
  list: (code) => stmt.listQuestions.all(code),
  forStudent: (code, studentId) => stmt.studentQuestions.all(code, studentId),
  setAnswered: (code, id, answered) => stmt.setQuestionAnswered.run(answered ? 1 : 0, id, code),
};
