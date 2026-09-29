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
CREATE TABLE IF NOT EXISTS translations (
  session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  slide_idx INTEGER NOT NULL,
  lang TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_code, slide_idx, lang)
);
CREATE TABLE IF NOT EXISTS text_cache (
  hash TEXT NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hash, lang)
);
CREATE TABLE IF NOT EXISTS session_members (
  session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','cohost')),
  PRIMARY KEY (session_code, teacher_id)
);
CREATE INDEX IF NOT EXISTS votes_session ON votes(session_code, slide_idx);
CREATE INDEX IF NOT EXISTS questions_session ON questions(session_code, slide_idx);
`);

// Additive migrations for databases created by earlier versions.
const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
if (!sessionCols.has('cohost_key')) db.exec('ALTER TABLE sessions ADD COLUMN cohost_key TEXT');
if (!sessionCols.has('changed_by')) db.exec('ALTER TABLE sessions ADD COLUMN changed_by TEXT');
if (!sessionCols.has('changed_at')) db.exec('ALTER TABLE sessions ADD COLUMN changed_at INTEGER');
const questionCols = new Set(db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name));
for (const [col, type] of [['lang', 'TEXT'], ['text_source', 'TEXT'], ['reply', 'TEXT'], ['reply_by', 'TEXT'], ['replied_at', 'INTEGER']]) {
  if (!questionCols.has(col)) db.exec(`ALTER TABLE questions ADD COLUMN ${col} ${type}`);
}
const slideCols = new Set(db.prepare('PRAGMA table_info(slides)').all().map((c) => c.name));
if (!slideCols.has('notes')) db.exec('ALTER TABLE slides ADD COLUMN notes TEXT');
if (!slideCols.has('number')) db.exec('ALTER TABLE slides ADD COLUMN number INTEGER');

const now = () => Date.now();
const newKey = () => crypto.randomBytes(12).toString('base64url');

// Unambiguous alphabet for join codes (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

for (const row of db.prepare('SELECT code FROM sessions WHERE cohost_key IS NULL').all()) {
  db.prepare('UPDATE sessions SET cohost_key = ? WHERE code = ?').run(newKey(), row.code);
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
  listSessionsForTeacher: db.prepare(
    `SELECT s.*, COALESCE(m.role, 'owner') AS role FROM sessions s
     LEFT JOIN session_members m ON m.session_code = s.code AND m.teacher_id = ?
     WHERE s.teacher_id = ? OR m.teacher_id IS NOT NULL
     ORDER BY s.created_at DESC`
  ),
  insertSession: db.prepare(
    'INSERT INTO sessions (code, key, cohost_key, teacher_id, title, presentation_id, status, status_message, slide_count, current_slide, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)'
  ),
  upsertMember: db.prepare(
    'INSERT INTO session_members (session_code, teacher_id, role) VALUES (?, ?, ?) ON CONFLICT(session_code, teacher_id) DO UPDATE SET role = excluded.role'
  ),
  getMember: db.prepare('SELECT role FROM session_members WHERE session_code = ? AND teacher_id = ?'),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ?, status_message = ?, slide_count = ?, title = ? WHERE code = ?'),
  setCurrentSlide: db.prepare('UPDATE sessions SET current_slide = ?, changed_by = ?, changed_at = ? WHERE code = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE code = ?'),

  deleteSlides: db.prepare('DELETE FROM slides WHERE session_code = ?'),
  upsertSlide: db.prepare(
    'INSERT INTO slides (session_code, idx, object_id, title, image, notes, number) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_code, idx) DO UPDATE SET object_id = excluded.object_id, title = excluded.title, image = excluded.image, notes = excluded.notes, number = excluded.number'
  ),
  listSlides: db.prepare('SELECT idx, object_id, title, image, notes, number FROM slides WHERE session_code = ? ORDER BY idx'),
  getSlide: db.prepare('SELECT idx, object_id, title, image, notes, number FROM slides WHERE session_code = ? AND idx = ?'),
  getTranslation: db.prepare('SELECT text, source_hash FROM translations WHERE session_code = ? AND slide_idx = ? AND lang = ?'),
  putTranslation: db.prepare(
    'INSERT INTO translations (session_code, slide_idx, lang, source_hash, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_code, slide_idx, lang) DO UPDATE SET source_hash = excluded.source_hash, text = excluded.text, created_at = excluded.created_at'
  ),

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
  // Open questions per slide: typed questions not yet answered, plus "I have a question" taps
  // from students who never typed one (there is nothing for the instructor to mark answered).
  openQuestions: db.prepare(
    `SELECT slide_idx, SUM(n) AS open FROM (
       SELECT slide_idx, COUNT(*) AS n FROM questions WHERE session_code = ? AND answered = 0 GROUP BY slide_idx
       UNION ALL
       SELECT v.slide_idx, COUNT(*) AS n FROM votes v
        WHERE v.session_code = ? AND v.kind = 'question'
          AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.session_code = v.session_code AND q.slide_idx = v.slide_idx AND q.student_id = v.student_id)
        GROUP BY v.slide_idx
     ) GROUP BY slide_idx`
  ),

  insertQuestion: db.prepare(
    'INSERT INTO questions (session_code, slide_idx, student_id, text, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  listQuestions: db.prepare(
    'SELECT id, slide_idx, text, lang, text_source, answered, reply, reply_by, replied_at, created_at FROM questions WHERE session_code = ? ORDER BY created_at DESC'
  ),
  getQuestion: db.prepare('SELECT * FROM questions WHERE id = ? AND session_code = ?'),
  setQuestionAnswered: db.prepare('UPDATE questions SET answered = ? WHERE id = ? AND session_code = ?'),
  setQuestionSourceText: db.prepare('UPDATE questions SET text_source = ? WHERE id = ? AND session_code = ?'),
  setQuestionReply: db.prepare('UPDATE questions SET reply = ?, reply_by = ?, replied_at = ?, answered = 1 WHERE id = ? AND session_code = ?'),
  studentQuestions: db.prepare(
    'SELECT id, slide_idx, text, lang, answered, reply, reply_by, replied_at, created_at FROM questions WHERE session_code = ? AND student_id = ? ORDER BY created_at DESC'
  ),
  getCachedText: db.prepare('SELECT text FROM text_cache WHERE hash = ? AND lang = ?'),
  putCachedText: db.prepare('INSERT OR REPLACE INTO text_cache (hash, lang, text, created_at) VALUES (?, ?, ?, ?)'),
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
  listForTeacher: (teacherId) => stmt.listSessionsForTeacher.all(teacherId, teacherId),
  create({ teacherId, title, presentationId, status = 'importing' }) {
    let code;
    do code = randomCode(6);
    while (stmt.getSession.get(code));
    stmt.insertSession.run(code, newKey(), newKey(), teacherId || null, title, presentationId || null, status, null, now());
    if (teacherId) stmt.upsertMember.run(code, teacherId, 'owner');
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
  setCurrentSlide(code, idx, by = null) {
    stmt.setCurrentSlide.run(idx, by, now(), code);
  },
  /** Role of a signed-in teacher for this session: 'owner', 'cohost' or null. */
  roleFor(session, teacherId) {
    if (!teacherId) return null;
    if (session.teacher_id === teacherId) return 'owner';
    return stmt.getMember.get(session.code, teacherId)?.role || null;
  },
  addMember: (code, teacherId, role) => stmt.upsertMember.run(code, teacherId, role),
  remove: (code) => stmt.deleteSession.run(code),
  replaceSlides: db.transaction((code, slides) => {
    stmt.deleteSlides.run(code);
    for (const s of slides) stmt.upsertSlide.run(code, s.idx, s.objectId || null, s.title || null, s.image || null, s.notes || null, s.number ?? s.idx + 1);
  }),
  upsertSlide(code, s) {
    stmt.upsertSlide.run(code, s.idx, s.objectId || null, s.title || null, s.image || null, s.notes || null, s.number ?? s.idx + 1);
  },
  slides: (code) => stmt.listSlides.all(code),
  slide: (code, idx) => stmt.getSlide.get(code, idx),
};

export const Translations = {
  get: (code, idx, lang) => stmt.getTranslation.get(code, idx, lang),
  put: (code, idx, lang, hash, text) => stmt.putTranslation.run(code, idx, lang, hash, text, now()),
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
      out[row.slide_idx] = { great: row.great, confused: row.confused, question: row.question, open: 0 };
    }
    for (const row of stmt.openQuestions.all(code, code)) {
      (out[row.slide_idx] ??= { great: 0, confused: 0, question: 0, open: 0 }).open = row.open;
    }
    return out;
  },
  participants: (code) => stmt.distinctStudents.get(code).n,
};

export const Questions = {
  add(code, slideIdx, studentId, text, lang = null) {
    const info = stmt.insertQuestion.run(code, slideIdx, studentId, text, lang, now());
    return info.lastInsertRowid;
  },
  get: (code, id) => stmt.getQuestion.get(id, code),
  list: (code) => stmt.listQuestions.all(code),
  forStudent: (code, studentId) => stmt.studentQuestions.all(code, studentId),
  setAnswered: (code, id, answered) => stmt.setQuestionAnswered.run(answered ? 1 : 0, id, code),
  setSourceText: (code, id, text) => stmt.setQuestionSourceText.run(text, id, code),
  reply: (code, id, text, by) => stmt.setQuestionReply.run(text, by, now(), id, code),
};

/** Generic translation cache keyed by content hash + target language (questions, replies). */
export const TextCache = {
  get: (hash, lang) => stmt.getCachedText.get(hash, lang)?.text ?? null,
  put: (hash, lang, text) => stmt.putCachedText.run(hash, lang, text, now()),
};
