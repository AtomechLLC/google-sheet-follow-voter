import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, zipDirectory } from '../src/zip.js';

/** Tiny reader: walk the central directory and return entry names + sizes. */
function listZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory record present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    out.push({ name, size, data: buf.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('buildZip produces readable stored entries', () => {
  const zip = buildZip([
    { name: 'a/hello.txt', data: Buffer.from('hello') },
    { name: 'a/b/empty.bin', data: Buffer.alloc(0) },
  ]);
  const entries = listZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [['a/hello.txt', 5], ['a/b/empty.bin', 0]]);
  assert.equal(entries[0].data.toString(), 'hello');
});

test('zipDirectory packages the extension folder with a root prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  fs.mkdirSync(path.join(dir, 'icons'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'icons', '16.png'), Buffer.from([1, 2, 3]));
  const names = listZip(zipDirectory(dir, 'ext')).map((e) => e.name);
  assert.deepEqual(names, ['ext/icons/16.png', 'ext/manifest.json']);
});
