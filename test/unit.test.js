import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slidepulse-test-'));
process.env.SESSION_SECRET = 'test';

const { parsePresentationId, createDemoSlides } = await import('../src/google.js');
const db = await import('../src/db.js');
const { Sessions, Votes, Questions } = db;

test('parsePresentationId accepts edit/present/bare-id forms', () => {
  const id = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
  assert.equal(parsePresentationId(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`), id);
  assert.equal(parsePresentationId(`https://docs.google.com/presentation/u/1/d/${id}/present`), id);
  assert.equal(parsePresentationId(id), id);
  assert.equal(parsePresentationId('https://docs.google.com/spreadsheets/d/abc/edit'), null);
  assert.equal(parsePresentationId(''), null);
});

test('votes toggle and great/confused are mutually exclusive', () => {
  const s = Sessions.create({ title: 'T' });
  createDemoSlides(s.code, 3);
  assert.equal(Sessions.get(s.code).slide_count, 3);

  assert.equal(Votes.toggle(s.code, 1, 'student-a', 'great'), true);
  assert.deepEqual(Votes.counts(s.code)[1], { great: 1, confused: 0, question: 0 });
  Votes.toggle(s.code, 1, 'student-a', 'confused');
  assert.deepEqual(Votes.counts(s.code)[1], { great: 0, confused: 1, question: 0 });
  assert.equal(Votes.toggle(s.code, 1, 'student-a', 'confused'), false);
  assert.equal(Votes.counts(s.code)[1], undefined);

  Votes.toggle(s.code, 2, 'student-b', 'question');
  Questions.add(s.code, 2, 'student-b', 'Why?');
  assert.equal(Votes.participants(s.code), 1);
  assert.equal(Questions.list(s.code).length, 1);
});

test('demo slide images are well-formed SVG (ampersands escaped)', () => {
  const s = Sessions.create({ title: 'T' });
  createDemoSlides(s.code, 8);
  for (const sl of Sessions.slides(s.code)) {
    const svg = fs.readFileSync(path.join(process.env.DATA_DIR, 'slides', s.code, sl.image), 'utf8');
    assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot|apos);)/);
  }
});

test('co-instructor membership: roles and per-teacher listing', () => {
  const { Teachers } = db;
  const owner = Teachers.create({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
  const cohost = Teachers.create({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
  const s = Sessions.create({ teacherId: owner.id, title: 'Shared' });
  assert.ok(s.cohost_key && s.cohost_key !== s.key);

  assert.equal(Sessions.roleFor(s, owner.id), 'owner');
  assert.equal(Sessions.roleFor(s, cohost.id), null);
  Sessions.addMember(s.code, cohost.id, 'cohost');
  assert.equal(Sessions.roleFor(s, cohost.id), 'cohost');

  const mine = Sessions.listForTeacher(cohost.id).filter((x) => x.code === s.code);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, 'cohost');
  assert.equal(Sessions.listForTeacher(owner.id).find((x) => x.code === s.code).role, 'owner');

  Sessions.setCurrentSlide(s.code, 1, 'Sam');
  assert.equal(Sessions.get(s.code).changed_by, 'Sam');
});
