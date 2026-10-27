import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slidepulse-import-'));
process.env.SESSION_SECRET = 'test';

const { importPresentation, createRateLimiter, fetchRetry, isImporting } = await import('../src/google.js');
const { Sessions, Teachers, slidesDir } = await import('../src/db.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** A fake Slides API: 5 slides (the 3rd skipped); the first thumbnail request for slide `g4` is rate-limited. */
function fakeGoogle() {
  const calls = { meta: 0, thumbs: [], downloads: 0 };
  let limited = false;
  const slides = ['g1', 'g2', 'g3', 'g4', 'g5'].map((objectId) => ({ objectId, slideProperties: { isSkipped: objectId === 'g3' } }));
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.startsWith('https://img.example/')) { calls.downloads++; return new Response(PNG, { status: 200 }); }
    const thumb = url.match(/\/pages\/([^/]+)\/thumbnail/);
    if (thumb) {
      calls.thumbs.push(thumb[1]);
      if (thumb[1] === 'g4' && !limited) {
        limited = true;
        return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429, headers: { 'retry-after': '0.05' } });
      }
      return Response.json({ contentUrl: `https://img.example/${thumb[1]}.png` });
    }
    calls.meta++;
    return Response.json({ title: 'Deck', slides });
  };
  return calls;
}

test('rate limiter lets `limit` calls through per window, then waits', async () => {
  const take = createRateLimiter(3, 200);
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await take('a');
  assert.ok(Date.now() - t0 < 100, 'first three are immediate');
  await take('a');
  assert.ok(Date.now() - t0 >= 180, 'the fourth waits for the window');
  const t1 = Date.now();
  await take('b');
  assert.ok(Date.now() - t1 < 50, 'keys are independent');
});

test('fetchRetry retries 429 honouring Retry-After and gives up after `tries`', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 3 ? new Response('', { status: 429, headers: { 'retry-after': '0.02' } }) : new Response('ok'));
  const res = await fetchRetry('https://x.example/');
  assert.equal(res.status, 200);
  assert.equal(n, 3);
  n = 0;
  globalThis.fetch = async () => { n++; return new Response('', { status: 503, headers: { 'retry-after': '0.01' } }); };
  const last = await fetchRetry('https://x.example/', {}, { tries: 2 });
  assert.equal(last.status, 503);
  assert.equal(n, 2);
});

test('import survives a 429, numbers skipped slides, and a resume fetches only missing images', async () => {
  const calls = fakeGoogle();
  const teacher = Teachers.create({ email: 't@example.com', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  const s = Sessions.create({ teacherId: teacher.id, title: 'Importing…', presentationId: 'deck1' });

  await importPresentation({ teacher, session: s });
  let row = Sessions.get(s.code);
  assert.equal(row.status, 'ready', row.status_message);
  const slides = Sessions.slides(s.code);
  assert.deepEqual(slides.map((x) => [x.object_id, x.number]), [['g1', 1], ['g2', 2], ['g4', 4], ['g5', 5]]);
  assert.ok(slides.every((x) => x.image && fs.existsSync(path.join(slidesDir, s.code, x.image))));
  assert.equal(calls.thumbs.filter((t) => t === 'g4').length, 2, 'the rate-limited thumbnail was retried');

  // Simulate an import cut off by a restart: one image missing, status still "importing".
  const lost = slides[2];
  Sessions.upsertSlide(s.code, { idx: lost.idx, objectId: lost.object_id, image: null, number: lost.number });
  Sessions.setStatus(s.code, { status: 'importing', message: 'Fetching…' });
  assert.equal(isImporting(s.code), false);
  calls.thumbs.length = 0;
  await importPresentation({ teacher, session: Sessions.get(s.code), resume: true });
  row = Sessions.get(s.code);
  assert.equal(row.status, 'ready');
  assert.deepEqual(calls.thumbs, ['g4'], 'only the missing image is fetched again');
  assert.ok(Sessions.slides(s.code).every((x) => x.image));
  assert.deepEqual(Sessions.listImporting().map((x) => x.code), []);
});

test('an expired Google sign-in (invalid_grant) fails the import with "Reconnect Google" and drops the dead tokens', async () => {
  const { REAUTH_MESSAGE } = await import('../src/google.js');
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const teacher = Teachers.create({ email: 'old@example.com', accessToken: 'stale', refreshToken: 'dead', expiresAt: Date.now() - 1000 });
  const s = Sessions.create({ teacherId: teacher.id, title: 'Importing…', presentationId: 'deck2' });
  await importPresentation({ teacher, session: s });
  const row = Sessions.get(s.code);
  assert.equal(row.status, 'error');
  assert.equal(row.status_message, REAUTH_MESSAGE);
  assert.equal(Teachers.get(teacher.id).refresh_token, null);
});

test('signing in again reuses the teacher (by email, or by this browser) so earlier decks stay theirs', () => {
  const a = Teachers.signIn({ email: 'Prof@Example.com', accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 });
  const s = Sessions.create({ teacherId: a.id, title: 'Deck', presentationId: 'deck3' });
  Teachers.clearTokens(a.id);
  const again = Teachers.signIn({ email: 'prof@example.com', accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 });
  assert.equal(again.id, a.id);
  assert.equal(again.refresh_token, 'r2');
  assert.deepEqual(Sessions.listForTeacher(again.id).map((x) => x.code), [s.code]);

  // A teacher made before emails were stored, still signed in through its cookie, is updated in place.
  const legacy = Teachers.create({ accessToken: 'x', refreshToken: null, expiresAt: 0 });
  const relinked = Teachers.signIn({ email: 'legacy@example.com', accessToken: 'y', refreshToken: 'r3', expiresAt: 3 }, legacy);
  assert.equal(relinked.id, legacy.id);
  assert.equal(relinked.email, 'legacy@example.com');

  // A different Google account in that browser gets its own teacher.
  const other = Teachers.signIn({ email: 'someone@example.com', accessToken: 'z', refreshToken: 'r4', expiresAt: 4 }, relinked);
  assert.notEqual(other.id, relinked.id);
});
