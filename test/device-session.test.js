// The shared device session: each command's output as clean text, for parsing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCommands } from '../src/server/device-session.js';
import { fakeTelnetDevice, closeFakeDevices } from './helpers/fake-telnet-device.js';

after(closeFakeDevices);
const telnet = (port, extra = {}) => ({ device: { name: 'x', protocol: 'telnet', host: '127.0.0.1', port }, auth: {}, algorithms: {}, ...extra });

test('returns each command\'s output without the echoed command or the prompt', async () => {
  const port = await fakeTelnetDevice({ name: 'R9', responses: { 'show clock': '12:00:00.000 UTC Thu Oct 15 2026' } });
  const r = await runCommands({ ...telnet(port), commands: ['show clock', 'show version'] }).done;
  assert.equal(r.error, '');
  assert.deepEqual(r.outputs, ['12:00:00.000 UTC Thu Oct 15 2026', 'output of "show version"']);
});

test('pages through --More-- and leaves no pager text in the output', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `Device ID: neighbor-${i + 1}`);
  const port = await fakeTelnetDevice({ name: 'R9', responses: { 'show cdp neighbors detail': lines.join('\n') }, pageAfter: 5 });
  const r = await runCommands({ ...telnet(port), commands: ['show cdp neighbors detail'] }).done;
  assert.equal(r.error, '');
  assert.deepEqual(r.outputs[0].split('\n'), lines);
});

test('reports progress through the hooks', async () => {
  const port = await fakeTelnetDevice({ name: 'R9' });
  const seen = { status: [], commands: [], data: '' };
  await runCommands({ ...telnet(port), commands: ['a', 'b'] }, {
    onStatus: (s, d) => seen.status.push(d ? `${s}: ${d}` : s),
    onCommand: (i, c) => seen.commands.push(`${i}:${c}`),
    onData: (t) => { seen.data += t; },
  }).done;
  assert.deepEqual(seen.status, ['connecting', 'running: 1/2  a', 'running: 2/2  b']);
  assert.deepEqual(seen.commands, ['0:a', '1:b']);
  assert.match(seen.data, /R9#a\r\noutput of "a"/);
});

test('stop() ends the session', async () => {
  const port = await fakeTelnetDevice({ name: 'R9', silentUntilEnter: true });
  const job = runCommands({ ...telnet(port), commands: ['show clock'] });
  setTimeout(() => job.stop(), 100);
  const r = await job.done;
  assert.equal(r.error, 'Stopped');
});
