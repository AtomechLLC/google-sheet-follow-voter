import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// shared.js is a classic script (no ESM) so the extension can load it; evaluate it here.
const src = fs.readFileSync(new URL('../extension/shared.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const { parseSlidesUrl, parseDashboardLink, isNewer } = mod.exports;

test('parseSlidesUrl reads present-mode and editor URLs', () => {
  const id = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
  assert.deepEqual(parseSlidesUrl(`https://docs.google.com/presentation/d/${id}/present?slide=id.g2f1a_0_12`),
    { presentationId: id, objectId: 'g2f1a_0_12', mode: 'present', presenterView: false });
  assert.deepEqual(parseSlidesUrl(`https://docs.google.com/presentation/d/${id}/present?slide=id.p`),
    { presentationId: id, objectId: 'p', mode: 'present', presenterView: false });
  assert.deepEqual(parseSlidesUrl(`https://docs.google.com/presentation/u/1/d/${id}/edit#slide=id.g99`),
    { presentationId: id, objectId: 'g99', mode: 'edit', presenterView: false });
  assert.deepEqual(parseSlidesUrl(`https://docs.google.com/presentation/d/${id}/present`),
    { presentationId: id, objectId: null, mode: 'present', presenterView: false });
  assert.deepEqual(parseSlidesUrl(`https://docs.google.com/presentation/d/${id}/presentnotes?foo=1`),
    { presentationId: id, objectId: null, mode: 'present', presenterView: true });
  assert.equal(parseSlidesUrl('https://docs.google.com/spreadsheets/d/x/edit'), null);
});

test('parseDashboardLink extracts server, code and key', () => {
  assert.deepEqual(parseDashboardLink(' https://pulse.example.com/t/abc123?key=s3cr3t '),
    { server: 'https://pulse.example.com', code: 'ABC123', key: 's3cr3t' });
  assert.equal(parseDashboardLink('https://pulse.example.com/s/ABC123'), null);
  assert.equal(parseDashboardLink('not a url'), null);
});

test('isNewer compares dotted versions numerically', () => {
  assert.equal(isNewer('1.2.0', '1.1.2'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.1.2', '1.1.2'), false);
  assert.equal(isNewer('1.1.2', '1.2.0'), false);
  assert.equal(isNewer('2', '1.9.9'), true);
});
