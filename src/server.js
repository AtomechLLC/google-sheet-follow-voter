import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { config, googleConfigured } from './config.js';
import { Teachers, Sessions, Votes, Questions, slidesDir } from './db.js';
import {
  authorizationUrl,
  exchangeCode,
  parsePresentationId,
  importPresentation,
  createDemoSlides,
} from './google.js';
import { attachWebSocket, publicState, resultsState, broadcastSession, broadcastResults } from './live.js';
import { zipDirectory } from './zip.js';
import { translateText, translateBetween, translationInfo, provider as translationProvider } from './translate.js';
import { byCode } from './languages.js';
import { Translations, TextCache } from './db.js';
import { notifyStudent } from './live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const extensionDir = path.join(__dirname, '..', 'extension');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

// ---------- tiny signed-cookie helpers ----------
function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSignedCookie(res, name, value, maxAgeSec) {
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(`${value}.${sign(value)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
  );
}
function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function readSignedCookie(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const value = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(value);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

function currentTeacher(req) {
  const id = readSignedCookie(req, 'tid');
  return id ? Teachers.get(id) : null;
}

// ---------- auth ----------
app.get('/auth/google', (req, res) => {
  if (!googleConfigured) return res.status(503).send('Google sign-in is not configured on this server.');
  const state = crypto.randomBytes(16).toString('hex');
  setSignedCookie(res, 'oauth_state', state, 600);
  res.redirect(authorizationUrl(state));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const expected = readSignedCookie(req, 'oauth_state');
  clearCookie(res, 'oauth_state');
  if (error) return res.redirect(`/?error=${encodeURIComponent(String(error))}`);
  if (!code || !state || state !== expected) return res.redirect('/?error=state_mismatch');
  try {
    const tokens = await exchangeCode(String(code));
    const teacher = Teachers.create(tokens);
    setSignedCookie(res, 'tid', teacher.id, 60 * 60 * 24 * 180);
    res.redirect('/');
  } catch (err) {
    console.error('[oauth]', err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/auth/logout', (req, res) => {
  const t = currentTeacher(req);
  if (t) Teachers.remove(t.id);
  clearCookie(res, 'tid');
  res.json({ ok: true });
});

// ---------- pages ----------
const page = (file) => (req, res) => res.sendFile(path.join(publicDir, file));
app.get('/', page('index.html'));
app.get('/t/:code', page('teacher.html'));
app.get('/s/:code', page('student.html'));
app.get('/p/:code', page('present.html'));
app.get('/r/:code', page('remote.html'));
app.get('/join', (req, res) => {
  const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  res.redirect(code ? `/s/${code}` : '/');
});

// Downloadable copy of the Chrome extension, built once at startup from the extension/ folder.
let extensionZip = null;
let extensionVersion = null;
try {
  extensionZip = zipDirectory(extensionDir, 'slide-pulse-extension');
  extensionVersion = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')).version;
} catch (err) {
  console.warn('[extension] could not package extension/:', err.message);
}
export const currentExtensionVersion = () => extensionVersion;
app.get('/extension.zip', (req, res) => {
  if (!extensionZip) return res.status(404).send('Extension package not available on this server.');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="slide-pulse-extension.zip"');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(extensionZip);
});

app.use('/slides', express.static(slidesDir, { maxAge: '365d', immutable: true, fallthrough: false }));
app.use(express.static(publicDir, { maxAge: '1h' }));

// ---------- helpers ----------
const studentUrl = (code) => `${config.baseUrl}/s/${code}`;

function loadSession(req, res, next) {
  const code = String(req.params.code || '').toUpperCase();
  const session = Sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  req.session = session;
  next();
}

/** Resolve the caller's role for req.session: 'owner', 'cohost' or null. */
function roleFor(req) {
  const key = req.get('x-session-key') || req.query.key;
  if (key && key === req.session.key) return 'owner';
  if (key && key === req.session.cohost_key) return 'cohost';
  const teacher = currentTeacher(req);
  return teacher ? Sessions.roleFor(req.session, teacher.id) : null;
}

/** Instructor routes (owner or co-instructor). Sets req.role. */
function requireTeacher(req, res, next) {
  req.role = roleFor(req);
  if (!req.role) return res.status(403).json({ error: 'Not allowed' });
  next();
}

/** Owner-only routes: delete, re-import, invite. */
function requireOwner(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the presentation owner can do that' });
  next();
}

const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;

function sessionSummary(s, role = 'owner') {
  return {
    code: s.code,
    key: role === 'owner' ? s.key : s.cohost_key,
    role,
    title: s.title,
    status: s.status,
    statusMessage: s.status_message,
    slideCount: s.slide_count,
    currentSlide: s.current_slide,
    presentationId: s.presentation_id,
    createdAt: s.created_at,
    changedBy: s.changed_by,
    changedAt: s.changed_at,
    studentUrl: studentUrl(s.code),
    teacherUrl: `${config.baseUrl}/t/${s.code}?key=${role === 'owner' ? s.key : s.cohost_key}`,
    cohostUrl: role === 'owner' ? `${config.baseUrl}/t/${s.code}?key=${s.cohost_key}` : undefined,
    presentUrl: `${config.baseUrl}/p/${s.code}`,
    remoteUrl: `${config.baseUrl}/r/${s.code}?key=${role === 'owner' ? s.key : s.cohost_key}`,
  };
}

const cleanStudentId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

// ---------- teacher API ----------
app.get('/api/me', (req, res) => {
  const t = currentTeacher(req);
  res.json({
    signedIn: Boolean(t),
    googleConfigured,
    demoMode: config.demoMode,
    baseUrl: config.baseUrl,
    sessions: t ? Sessions.listForTeacher(t.id).map((row) => sessionSummary(row, row.role)) : [],
  });
});

app.post('/api/sessions', async (req, res) => {
  const teacher = currentTeacher(req);
  if (!teacher) return res.status(401).json({ error: 'Sign in with Google first' });
  const presentationId = parsePresentationId(req.body?.url);
  if (!presentationId) return res.status(400).json({ error: 'That does not look like a Google Slides link.' });
  const session = Sessions.create({ teacherId: teacher.id, title: 'Importing…', presentationId });
  res.status(201).json(sessionSummary(session));
  importPresentation({ teacher, session, onProgress: () => broadcastSession(session.code) });
});

app.post('/api/demo', (req, res) => {
  if (!config.demoMode) return res.status(404).json({ error: 'Demo mode is off' });
  const teacher = currentTeacher(req);
  const session = Sessions.create({ teacherId: teacher?.id, title: 'Demo deck', status: 'importing' });
  createDemoSlides(session.code, 8);
  res.status(201).json(sessionSummary(Sessions.get(session.code)));
});

app.get('/api/sessions/:code', loadSession, (req, res) => {
  res.json(publicState(req.session.code));
});

app.get('/api/sessions/:code/qr.svg', loadSession, async (req, res) => {
  const svg = await QRCode.toString(studentUrl(req.session.code), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
  });
  res.type('image/svg+xml').send(svg);
});

app.get('/api/sessions/:code/teacher', loadSession, requireTeacher, (req, res) => {
  // A signed-in instructor opening an invite link gets the session added to their list.
  const teacher = currentTeacher(req);
  if (teacher && !Sessions.roleFor(req.session, teacher.id)) Sessions.addMember(req.session.code, teacher.id, req.role);
  res.json({ ...sessionSummary(req.session, req.role), results: resultsState(req.session.code), extensionVersion });
});

app.post('/api/sessions/:code/slide', loadSession, requireTeacher, (req, res) => {
  const s = req.session;
  let idx = Number(req.body?.index);
  if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index must be an integer' });
  idx = Math.max(0, Math.min(Math.max(s.slide_count - 1, 0), idx));
  Sessions.setCurrentSlide(s.code, idx, cleanName(req.body?.by));
  broadcastSession(s.code);
  res.json({ currentSlide: idx });
});

app.post('/api/sessions/:code/reimport', loadSession, requireTeacher, requireOwner, (req, res) => {
  const s = req.session;
  if (!s.presentation_id) return res.status(400).json({ error: 'Demo sessions cannot be re-imported' });
  const teacher = Teachers.get(s.teacher_id);
  if (!teacher) return res.status(400).json({ error: 'The Google account that created this session is signed out.' });
  if (s.status === 'importing') return res.json({ ok: true });
  Sessions.setStatus(s.code, { status: 'importing', message: 'Re-importing…' });
  broadcastSession(s.code);
  res.json({ ok: true });
  importPresentation({ teacher, session: s, onProgress: () => broadcastSession(s.code) });
});

app.post('/api/sessions/:code/questions/:id', loadSession, requireTeacher, (req, res) => {
  const id = Number(req.params.id);
  Questions.setAnswered(req.session.code, id, Boolean(req.body?.answered));
  broadcastResults(req.session.code);
  res.json({ ok: true });
});

app.delete('/api/sessions/:code', loadSession, requireTeacher, requireOwner, (req, res) => {
  Sessions.remove(req.session.code);
  res.json({ ok: true });
});

// ---------- Chrome extension API (CORS-enabled; runs from the docs.google.com tab) ----------
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type, x-session-key');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
app.use('/api/ext', cors);

/** Latest extension version served by this site, so installed copies can warn when outdated. */
app.get('/api/ext/version', (req, res) => {
  res.json({ version: extensionVersion, downloadUrl: `${config.baseUrl}/extension.zip` });
});

/** Pairing: the extension pastes a dashboard link, we return what it needs to store. */
app.get('/api/ext/session/:code', loadSession, requireTeacher, (req, res) => {
  const s = req.session;
  res.json({
    code: s.code,
    title: s.title,
    presentationId: s.presentation_id,
    slideCount: s.slide_count,
    currentSlide: s.current_slide,
    demo: !s.presentation_id,
    role: req.role,
    latestExtensionVersion: extensionVersion,
  });
});

/** Follow: the extension reports the slide object id from the Slides URL. */
app.post('/api/ext/session/:code/slide', loadSession, requireTeacher, (req, res) => {
  const s = req.session;
  const objectId = String(req.body?.objectId || '').trim();
  const presentationId = String(req.body?.presentationId || '').trim();
  if (!objectId) return res.status(400).json({ error: 'objectId required' });
  if (s.presentation_id && presentationId && presentationId !== s.presentation_id) {
    return res.status(409).json({ error: 'This tab is a different presentation than the paired session.' });
  }
  const slide = Sessions.slides(s.code).find((sl) => sl.object_id === objectId);
  if (!slide) return res.status(404).json({ error: 'Slide not found in this session. Re-import the deck if you edited it.' });
  if (slide.idx !== s.current_slide) {
    Sessions.setCurrentSlide(s.code, slide.idx, cleanName(req.body?.by));
    broadcastSession(s.code);
  }
  res.json({ index: slide.idx, slideCount: s.slide_count });
});

// ---------- speaker notes + translation ----------
const inflightTranslations = new Map(); // "code:idx:lang" -> Promise

app.get('/api/sessions/:code/notes/:idx', loadSession, async (req, res, next) => {
  try {
    const idx = Number(req.params.idx);
    const lang = String(req.query.lang || translationInfo().source).toLowerCase();
    if (!Number.isInteger(idx)) return res.status(400).json({ error: 'bad slide index' });
    if (!byCode(lang)) return res.status(400).json({ error: 'unknown language' });
    const slide = Sessions.slide(req.session.code, idx);
    if (!slide) return res.status(404).json({ error: 'Slide not found' });
    if (!slide.notes) return res.json({ lang, hasNotes: false, text: '', translated: false });

    const hash = crypto.createHash('sha1').update(slide.notes).digest('hex');
    const cached = Translations.get(req.session.code, idx, lang);
    if (cached && cached.source_hash === hash) return res.json({ lang, hasNotes: true, text: cached.text, translated: true });

    const key = `${req.session.code}:${idx}:${lang}`;
    let job = inflightTranslations.get(key);
    if (!job) {
      job = translateText(slide.notes, lang).finally(() => inflightTranslations.delete(key));
      inflightTranslations.set(key, job);
    }
    const result = await job;
    if (result.translated) Translations.put(req.session.code, idx, lang, hash, result.text);
    res.json({ lang, hasNotes: true, ...result });
  } catch (err) {
    console.error('[translate]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- student API ----------
/** Translate arbitrary text with a content-hash cache; returns null when nothing to do. */
async function cachedTranslate(text, from, to) {
  if (!text || from === to) return null;
  const hash = crypto.createHash('sha1').update(`${from}\n${text}`).digest('hex');
  const hit = TextCache.get(hash, to);
  if (hit) return hit;
  const out = await translateBetween(text, from, to);
  if (out) TextCache.put(hash, to, out);
  return out;
}

async function studentQuestions(code, studentId, lang) {
  const source = translationInfo().source;
  const qs = Questions.forStudent(code, studentId);
  // Replies are written in the instructor's language; show them in the student's.
  await Promise.all(qs.map(async (q) => {
    if (q.reply && lang && lang !== source) {
      try { q.reply_translated = await cachedTranslate(q.reply, source, lang); } catch (err) { console.error('[translate reply]', err.message); }
    }
  }));
  return qs;
}

app.get('/api/sessions/:code/me', loadSession, async (req, res) => {
  const studentId = cleanStudentId(req.query.student);
  if (!studentId) return res.status(400).json({ error: 'bad student id' });
  const lang = byCode(String(req.query.lang || '').toLowerCase()) ? String(req.query.lang).toLowerCase() : null;
  res.json({
    votes: Votes.forStudent(req.session.code, studentId),
    questions: await studentQuestions(req.session.code, studentId, lang),
  });
});

app.post('/api/sessions/:code/vote', loadSession, (req, res) => {
  const s = req.session;
  const studentId = cleanStudentId(req.body?.studentId);
  const slide = Number(req.body?.slide);
  const kind = req.body?.kind;
  if (!studentId) return res.status(400).json({ error: 'bad student id' });
  if (!Number.isInteger(slide) || slide < 0 || slide >= Math.max(s.slide_count, 1)) {
    return res.status(400).json({ error: 'bad slide index' });
  }
  if (!['great', 'confused', 'question'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const active = Votes.toggle(s.code, slide, studentId, kind);
  broadcastResults(s.code);
  res.json({ active, votes: Votes.forStudent(s.code, studentId) });
});

app.post('/api/sessions/:code/question', loadSession, async (req, res) => {
  const s = req.session;
  const studentId = cleanStudentId(req.body?.studentId);
  const slide = Number(req.body?.slide);
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!studentId) return res.status(400).json({ error: 'bad student id' });
  if (!Number.isInteger(slide) || slide < 0 || slide >= Math.max(s.slide_count, 1)) {
    return res.status(400).json({ error: 'bad slide index' });
  }
  if (!text) return res.status(400).json({ error: 'Question text is empty' });
  const lang = byCode(String(req.body?.lang || '').toLowerCase()) ? String(req.body.lang).toLowerCase() : null;
  Votes.ensure(s.code, slide, studentId, 'question');
  const id = Questions.add(s.code, slide, studentId, text, lang);
  broadcastResults(s.code);
  res.status(201).json({ id, votes: Votes.forStudent(s.code, studentId), questions: await studentQuestions(s.code, studentId, lang) });
  // A question typed in another language is translated for the instructor in the background.
  const source = translationInfo().source;
  if (lang && lang !== source) {
    cachedTranslate(text, lang, source)
      .then((out) => { if (out) { Questions.setSourceText(s.code, id, out); broadcastResults(s.code); } })
      .catch((err) => console.error('[translate question]', err.message));
  }
});

app.post('/api/sessions/:code/questions/:id/reply', loadSession, requireTeacher, async (req, res) => {
  const id = Number(req.params.id);
  const q = Questions.get(req.session.code, id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Reply is empty' });
  Questions.reply(req.session.code, id, text, cleanName(req.body?.by));
  broadcastResults(req.session.code);
  res.json({ ok: true });
  // Tell the student who asked, in their language.
  try {
    const [updated] = (await studentQuestions(req.session.code, q.student_id, q.lang)).filter((x) => x.id === id);
    notifyStudent(req.session.code, q.student_id, { type: 'reply', question: updated });
  } catch (err) {
    console.error('[reply notify]', err.message);
  }
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const server = http.createServer(app);
attachWebSocket(server);
server.listen(config.port, () => {
  console.log(`Slide Pulse listening on ${config.baseUrl} (port ${config.port})`);
  if (!googleConfigured) console.warn('[google] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: Google Slides import is disabled.');
  if (config.demoMode) console.log('[demo] DEMO_MODE is on: /api/demo creates placeholder sessions.');
  console.log(translationProvider ? `[translate] provider: ${translationProvider.name}` : '[translate] no provider configured; speaker notes are shown untranslated.');
});
