import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { Teachers, Sessions, slidesDir } from './db.js';

// openid + email identify the account, so signing in again reuses the same teacher (and decks).
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/presentations.readonly'];

/** Shown when Google no longer accepts the saved sign-in (expired or revoked refresh token). */
export const REAUTH_MESSAGE =
  'Your Google sign-in has expired. Open the Slide Pulse home page, click "Reconnect Google", then click Re-import slides.';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SLIDES_API = 'https://slides.googleapis.com/v1/presentations';

export const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

export function authorizationUrl(state) {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      ...params,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token error: ${body.error || res.status} ${body.error_description || ''}`.trim());
    err.code = body.error;
    throw err;
  }
  return body;
}

/** Email from the id_token. It comes straight from Google's token endpoint over TLS, so it is only decoded. */
function emailFromIdToken(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null; }
  catch { return null; }
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  return {
    email: emailFromIdToken(t.id_token),
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  };
}

/** Error thrown when the teacher must sign in with Google again. */
function reauthError() {
  const err = new Error(REAUTH_MESSAGE);
  err.reauth = true;
  return err;
}

/**
 * Returns a valid access token for the teacher, refreshing it when needed. Seen live: Google
 * answered a refresh with `invalid_grant` ("Token has been expired or revoked"; OAuth apps left
 * in Testing status get 7-day refresh tokens), and every import then failed. The dead tokens
 * are dropped so the home page can offer "Reconnect Google".
 */
export async function accessTokenFor(teacher) {
  const fresh = teacher.access_token && teacher.token_expires && teacher.token_expires - Date.now() > 60_000;
  if (fresh) return teacher.access_token;
  if (!teacher.refresh_token) throw reauthError();
  let t;
  try {
    t = await tokenRequest({ refresh_token: teacher.refresh_token, grant_type: 'refresh_token' });
  } catch (err) {
    if (err.code !== 'invalid_grant') throw err;
    Teachers.clearTokens(teacher.id);
    teacher.access_token = null;
    teacher.refresh_token = null;
    throw reauthError();
  }
  const expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
  Teachers.updateTokens(teacher.id, { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt });
  teacher.access_token = t.access_token;
  teacher.token_expires = expiresAt;
  return t.access_token;
}

export function parsePresentationId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s; // bare id
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding-window limiter: `await take(key)` resolves once fewer than `limit` calls for that key
 * happened in the last `windowMs`.
 */
export function createRateLimiter(limit, windowMs) {
  const calls = new Map(); // key -> timestamps of recent calls, oldest first
  return async function take(key) {
    if (!calls.has(key)) calls.set(key, []);
    const recent = calls.get(key);
    for (;;) {
      const now = Date.now();
      while (recent.length && now - recent[0] >= windowMs) recent.shift();
      if (recent.length < limit) { recent.push(now); return; }
      await sleep(windowMs - (now - recent[0]) + 20);
    }
  };
}

// Google allows 60 thumbnail requests per minute per user (300 per project), and answers 429 past
// that. A 258-slide deck fetched 68 thumbnails in 43 s and its import stopped there, so each
// teacher's thumbnail calls are paced just under the limit: small decks still import at once,
// big ones at about a slide a second.
const takeThumbnailSlot = createRateLimiter(55, 60_000);

/**
 * fetch with a 30 s timeout that retries rate limits (429), server errors and network failures
 * with exponential backoff (honouring Retry-After), as Google's usage-limit docs recommend.
 */
export async function fetchRetry(url, options = {}, { tries = 8, label = 'request', minRateLimitWait = 15_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null, err = null;
    try { res = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { err = e; }
    const retryable = err || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries - 1) {
      if (err) throw err;
      return res;
    }
    await res?.body?.cancel().catch(() => {});
    const after = Number(res?.headers.get('retry-after'));
    const backoff = Math.min(2 ** attempt * 1000, 64_000) + Math.random() * 1000;
    const wait = after > 0 ? after * 1000 : res?.status === 429 ? Math.max(backoff, minRateLimitWait) : backoff;
    console.warn(`[google] ${label}: ${err ? err.message : `HTTP ${res.status}`}; retry ${attempt + 1} in ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
}

async function slidesGet(token, url, label = 'Slides API') {
  const res = await fetchRetry(url, { headers: { authorization: `Bearer ${token}` } }, { label });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Google Slides API: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Speaker notes text for a slide (the notes page's speaker-notes shape). */
function slideNotes(slide) {
  const notesPage = slide.slideProperties?.notesPage;
  const target = notesPage?.notesProperties?.speakerNotesObjectId;
  if (!notesPage || !target) return null;
  const el = (notesPage.pageElements || []).find((e) => e.objectId === target);
  const paragraphs = [];
  for (const t of el?.shape?.text?.textElements || []) {
    if (t.textRun?.content) paragraphs.push(t.textRun.content);
  }
  const text = paragraphs.join('').replace(/\v/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

function slideTitle(slide) {
  // First non-empty text run on the slide, used as a label on the dashboard.
  for (const el of slide.pageElements || []) {
    const runs = el.shape?.text?.textElements || [];
    const text = runs.map((r) => r.textRun?.content || '').join('').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return null;
}

async function downloadTo(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchRetry(url, {}, { label: 'thumbnail download', tries: 4 });
      if (!res.ok || !res.body) throw new Error(`Thumbnail download failed: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * attempt);
    }
  }
}

/** Imports running in this process. A session left "importing" without one was cut off by a restart. */
const activeImports = new Set();
export const isImporting = (code) => activeImports.has(code);

/**
 * Fetches the deck's slide list and thumbnails into data/slides/<code>/.
 * Updates the session row as it goes; `onProgress` is called after every change.
 */
export async function importPresentation({ teacher, session, onProgress = () => {}, resume = false }) {
  const code = session.code;
  if (activeImports.has(code)) return;
  activeImports.add(code);
  const dir = path.join(slidesDir, code);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const token = await accessTokenFor(teacher);
    const fields =
      'title,slides(objectId,pageElements(shape(text(textElements(textRun(content))))),' +
      'slideProperties(isSkipped,notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(text(textElements(textRun(content))))))))';
    const pres = await slidesGet(token, `${SLIDES_API}/${session.presentation_id}?fields=${encodeURIComponent(fields)}`);
    // Skipped slides are not shown in Present mode, so leave them out of the deck students see.
    // Google still counts them in its "slide N" numbering, so remember each slide's Google number.
    const all = pres.slides || [];
    const numberOf = new Map(all.map((s, i) => [s.objectId, i + 1]));
    const slides = all.filter((s) => !s.slideProperties?.isSkipped);
    const title = pres.title || session.title;

    // Keep old images visible while re-importing (matched by slide id); replace metadata now.
    const before = new Map(
      Sessions.slides(code)
        .filter((s) => s.object_id && s.image && fs.existsSync(path.join(dir, s.image)))
        .map((s) => [s.object_id, s.image])
    );
    const row = (s, i, image) => ({ idx: i, objectId: s.objectId, title: slideTitle(s), notes: slideNotes(s), number: numberOf.get(s.objectId), image });
    Sessions.replaceSlides(code, slides.map((s, i) => row(s, i, before.get(s.objectId) || null)));
    // A resumed import (cut off by a restart) only fetches the images it does not have yet;
    // a re-import refreshes them all, since the slides may have been edited.
    const todo = slides.map((_, i) => i).filter((i) => !resume || !before.has(slides[i].objectId));
    let done = slides.length - todo.length;
    const progress = () => {
      const paced = todo.length > 55 ? ' (Google allows about 60 slide images a minute)' : '';
      return `Fetching slide images: ${done} of ${slides.length}${paced}…`;
    };
    Sessions.setStatus(code, { status: 'importing', message: progress(), slideCount: slides.length, title });
    onProgress();

    // Modest concurrency; takeThumbnailSlot keeps the request rate under Google's per-user limit.
    const CONCURRENCY = 3;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = todo[next++];
        const s = slides[i];
        const url =
          `${SLIDES_API}/${session.presentation_id}/pages/${encodeURIComponent(s.objectId)}/thumbnail` +
          `?thumbnailProperties.thumbnailSize=${config.thumbnailSize}&thumbnailProperties.mimeType=PNG`;
        await takeThumbnailSlot(teacher.id);
        const thumb = await slidesGet(await accessTokenFor(teacher), url, `thumbnail for slide ${i + 1}`);
        const file = `${i}-${Date.now().toString(36)}.png`;
        await downloadTo(thumb.contentUrl, path.join(dir, file));
        Sessions.upsertSlide(code, row(s, i, file));
        done++;
        Sessions.setStatus(code, { status: 'importing', message: progress() });
        onProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

    // Remove stale image files from previous imports.
    const keep = new Set(Sessions.slides(code).map((s) => s.image));
    for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });

    Sessions.setStatus(code, { status: 'ready', message: null, slideCount: slides.length, title });
    onProgress();
  } catch (err) {
    console.error(`[import ${code}]`, err);
    Sessions.setStatus(code, { status: 'error', message: err.reauth ? err.message : `${err.message} Click Re-import slides to try again.` });
    onProgress();
  } finally {
    activeImports.delete(code);
  }
}

/** Placeholder slides for DEMO_MODE (no Google credentials needed). */
export function createDemoSlides(code, count = 8) {
  const dir = path.join(slidesDir, code);
  fs.mkdirSync(dir, { recursive: true });
  const topics = [
    'Welcome & agenda', 'Why this matters', 'Key concept #1', 'Worked example',
    'Common mistakes', 'Key concept #2', 'Practice problem', 'Summary & next steps',
  ];
  const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const slides = [];
  for (let i = 0; i < count; i++) {
    const title = topics[i % topics.length];
    const hue = (i * 47) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<rect width="800" height="450" fill="hsl(${hue} 55% 92%)"/>
<rect x="0" y="0" width="800" height="90" fill="hsl(${hue} 60% 40%)"/>
<text x="40" y="60" font-family="system-ui, sans-serif" font-size="40" fill="#fff" font-weight="700">${esc(title)}</text>
<text x="40" y="170" font-family="system-ui, sans-serif" font-size="26" fill="#1f2937">• This is demo slide ${i + 1} of ${count}</text>
<text x="40" y="220" font-family="system-ui, sans-serif" font-size="26" fill="#1f2937">• Real decks are imported from Google Slides</text>
<text x="40" y="270" font-family="system-ui, sans-serif" font-size="26" fill="#1f2937">• Students tap a button on their phone</text>
<text x="760" y="420" text-anchor="end" font-family="system-ui, sans-serif" font-size="22" fill="#6b7280">${i + 1} / ${count}</text>
</svg>`;
    const file = `${i}.svg`;
    fs.writeFileSync(path.join(dir, file), svg);
    const notes = i % 4 === 3 ? null : `Speaker notes for "${title}".\n\nExplain the idea slowly. Ask the class for an example before moving on.\nRemind students they can tap "I didn't understand" at any time.`;
    slides.push({ idx: i, objectId: `demo-${i}`, title, notes, image: file });
  }
  Sessions.replaceSlides(code, slides);
  Sessions.setStatus(code, { status: 'ready', message: null, slideCount: count });
}
