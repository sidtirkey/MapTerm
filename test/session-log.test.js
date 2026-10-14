import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLog } from '../src/server/session-log.js';

// Feeds chunks through a SessionLog and returns what it wrote.
function clean(chunks, { seed, end = '' } = {}) {
  let out = '';
  const log = new SessionLog({ write: (s) => (out += s), end: (s) => (out += s) });
  if (seed) log.seed(...seed);
  chunks.forEach((c) => log.write(c));
  log.end(end);
  return out;
}

test('applies backspaces, so a corrected typo is logged as the final command', () => {
  assert.equal(clean(['R1#', 's', 'h', ' ', 'i', 'p', 'p', '\b \b', ' int br\r\n']), 'R1#sh ip int br\n');
});

test('drops colour codes, even when split across chunks', () => {
  assert.equal(clean(['\x1b[01;3', '2mR1\x1b[0m# ok\r\n']), 'R1# ok\n');
});

test('erases a --More-- pager that the device overwrote', () => {
  assert.equal(clean(['line 1\r\n --More-- ', '\r\x1b[K', 'line 2\r\n']), 'line 1\nline 2\n');
});

test('starts from the seeded prompt line', () => {
  assert.equal(clean(['show clock\r\n'], { seed: ['R1#', 3] }), 'R1#show clock\n');
});

test('writes the unfinished last line before the footer, and can discard it instead', () => {
  assert.equal(clean(['out\r\nR1#'], { end: '# done\n' }), 'out\nR1#\n# done\n');
  let out = '';
  const log = new SessionLog({ write: (s) => (out += s), end: (s) => (out += s) });
  log.write('out\r\nR1#');
  log.discardLine();
  log.end('');
  assert.equal(out, 'out\n');
});
