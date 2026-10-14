import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeName, expandHome, stamp, openUnique } from '../src/server/files.js';

test('safeName makes names that work as files on macOS, Linux and Windows', () => {
  assert.equal(safeName('R1'), 'R1');
  assert.equal(safeName('a b/c:d*e?'), 'a_b_c_d_e_');
  assert.equal(safeName('core-sw.'), 'core-sw');
  assert.equal(safeName('...hidden'), 'hidden');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  assert.equal(safeName('console'), 'console');
  assert.equal(safeName(''), 'device');
});

test('expandHome understands ~/ and ~\\', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/logs'), path.join(os.homedir(), 'logs'));
  assert.equal(expandHome('~\\logs'), path.join(os.homedir(), 'logs'));
  assert.equal(expandHome('/abs'), '/abs');
});

test('stamp formats local time for display and for file names', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(stamp(d), '2026-01-02 03:04:05');
  assert.equal(stamp(d, '-', '_'), '2026-01-02_03-04-05');
});

test('openUnique never reuses an existing file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapterm-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = openUnique(dir, 'R1', '.txt'), b = openUnique(dir, 'R1', '.txt');
  fs.closeSync(a.fd); fs.closeSync(b.fd);
  assert.equal(path.basename(a.file), 'R1.txt');
  assert.equal(path.basename(b.file), 'R1-2.txt');
});
