import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { Teachers, Sessions, slidesDir } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/presentations.readonly'];
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
    throw new Error(`Google token error: ${body.error || res.status} ${body.error_description || ''}`.trim());
  }
  return body;
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  };
}

/** Returns a valid access token for the teacher, refreshing it when needed. */
export async function accessTokenFor(teacher) {
  const fresh = teacher.access_token && teacher.token_expires && teacher.token_expires - Date.now() > 60_000;
  if (fresh) return teacher.access_token;
  if (!teacher.refresh_token) throw new Error('Google sign-in expired. Please sign in again.');
  const t = await tokenRequest({ refresh_token: teacher.refresh_token, grant_type: 'refresh_token' });
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

async function slidesGet(token, url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
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
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Thumbnail download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

/**
 * Fetches the deck's slide list and thumbnails into data/slides/<code>/.
 * Updates the session row as it goes; `onProgress` is called after every change.
 */
export async function importPresentation({ teacher, session, onProgress = () => {} }) {
  const code = session.code;
  const dir = path.join(slidesDir, code);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const token = await accessTokenFor(teacher);
    const fields =
      'title,slides(objectId,pageElements(shape(text(textElements(textRun(content))))),' +
      'slideProperties(isSkipped,notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(text(textElements(textRun(content))))))))';
    const pres = await slidesGet(token, `${SLIDES_API}/${session.presentation_id}?fields=${encodeURIComponent(fields)}`);
    // Skipped slides are not shown in Present mode, so leave them out to keep numbering aligned.
    const slides = (pres.slides || []).filter((s) => !s.slideProperties?.isSkipped);
    const title = pres.title || session.title;

    Sessions.setStatus(code, {
      status: 'importing',
      message: `Fetching slide 1 of ${slides.length}…`,
      slideCount: slides.length,
      title,
    });
    // Keep old images visible while re-importing; replace metadata now.
    Sessions.replaceSlides(
      code,
      slides.map((s, i) => ({ idx: i, objectId: s.objectId, title: slideTitle(s), notes: slideNotes(s), image: null }))
    );
    onProgress();

    // Modest concurrency: the Slides API rate-limits per user.
    const CONCURRENCY = 3;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < slides.length) {
        const i = next++;
        const s = slides[i];
        const url =
          `${SLIDES_API}/${session.presentation_id}/pages/${encodeURIComponent(s.objectId)}/thumbnail` +
          `?thumbnailProperties.thumbnailSize=${config.thumbnailSize}&thumbnailProperties.mimeType=PNG`;
        const thumb = await slidesGet(await accessTokenFor(teacher), url);
        const file = `${i}-${Date.now().toString(36)}.png`;
        await downloadTo(thumb.contentUrl, path.join(dir, file));
        Sessions.upsertSlide(code, { idx: i, objectId: s.objectId, title: slideTitle(s), notes: slideNotes(s), image: file });
        done++;
        Sessions.setStatus(code, {
          status: 'importing',
          message: `Fetching slide ${Math.min(done + 1, slides.length)} of ${slides.length}…`,
        });
        onProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slides.length) }, worker));

    // Remove stale image files from previous imports.
    const keep = new Set(Sessions.slides(code).map((s) => s.image));
    for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });

    Sessions.setStatus(code, { status: 'ready', message: null, slideCount: slides.length, title });
    onProgress();
  } catch (err) {
    console.error(`[import ${code}]`, err);
    Sessions.setStatus(code, { status: 'error', message: err.message });
    onProgress();
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
