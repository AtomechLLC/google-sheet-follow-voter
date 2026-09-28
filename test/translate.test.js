import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'slidepulse-tr-'));
process.env.SESSION_SECRET = 'test';
process.env.TRANSLATE_PROVIDER = 'mock';

const { translateText, translationInfo } = await import('../src/translate.js');
const { LANGUAGES } = await import('../src/languages.js');
const { STRINGS } = await import('../public/i18n.js');

test('language list covers the requested set incl. Russian and Romanian', () => {
  const codes = LANGUAGES.map((l) => l.code);
  for (const c of ['en', 'es', 'zh', 'hi', 'ar', 'fr', 'pt', 'bn', 'ru', 'ur', 'id', 'de', 'ja', 'ro']) assert.ok(codes.includes(c), c);
  assert.ok(LANGUAGES.find((l) => l.code === 'ar').rtl);
});

test('every language has a complete UI string set', () => {
  const keys = Object.keys(STRINGS.en);
  for (const l of LANGUAGES) {
    assert.ok(STRINGS[l.code], `strings for ${l.code}`);
    for (const k of keys) assert.ok(STRINGS[l.code][k], `${l.code}.${k}`);
  }
});

test('mock provider translates, source language passes through', async () => {
  assert.deepEqual(await translateText('Hello', 'en'), { text: 'Hello', translated: false });
  const ro = await translateText('Hello', 'ro');
  assert.equal(ro.translated, true);
  assert.match(ro.text, /Română/);
  assert.equal(translationInfo().languages.length, LANGUAGES.length);
});
