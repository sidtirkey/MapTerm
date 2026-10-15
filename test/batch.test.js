// "Run commands" over Telnet, against small Telnet devices run in this process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBatch } from '../src/server/batch.js';
import { fakeTelnetDevice as device, closeFakeDevices } from './helpers/fake-telnet-device.js';

after(closeFakeDevices);

// Runs commands on the devices; resolves to { results: { name: status }, dir }.
function run(devices, commands = ['show clock']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapterm-batch-'));
  const resolveCreds = async (m) => {
    if (!m.username || !m.password) throw new Error('No username or password');
    return { username: m.username, password: m.password, enable: '' };
  };
  return new Promise((resolve) => {
    const results = {};
    runBatch({ dir, devices, commands, layout: 'device' }, {
      resolveCreds, algorithms: {},
      send: (m) => {
        if (m.type === 'batch-status' && !['connecting', 'running'].includes(m.state)) results[devices.find((d) => d.id === m.id).name] = `${m.state} ${m.detail || ''}`.trim();
        if (m.type === 'batch-done') resolve({ results, dir: m.dir });
      },
    });
  });
}
const transcript = (dir, name) => fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');

test('runs on a Telnet console that needs no login and stays silent until Enter', async () => {
  const port = await device({ name: 'console', silentUntilEnter: true });
  const { results, dir } = await run([{ id: '1', name: 'console', protocol: 'telnet', host: '127.0.0.1', port }]);
  assert.equal(results.console, 'done');
  assert.match(transcript(dir, 'console'), /console#show clock\noutput of "show clock"/);
});

test('logs in over Telnet with the given credentials', async () => {
  const port = await device({ name: 'R9', login: true });
  const { results, dir } = await run([{ id: '1', name: 'R9', protocol: 'telnet', host: '127.0.0.1', port, username: 'admin', password: 'pw' }]);
  assert.equal(results.R9, 'done');
  const t = transcript(dir, 'R9');
  assert.match(t, /Username: admin\nPassword:/);
  assert.match(t, /R9#show clock\noutput of "show clock"/);
});

test('reports a Telnet login prompt at once when no credentials are saved', async () => {
  const port = await device({ name: 'R9', login: true });
  const started = Date.now();
  const { results } = await run([{ id: '1', name: 'R9', protocol: 'telnet', host: '127.0.0.1', port }]);
  assert.match(results.R9, /^failed .*asked for a username and none is saved/);
  assert.ok(Date.now() - started < 5000, 'fails fast instead of waiting for the login timeout');
});

test('reports a rejected Telnet login', async () => {
  const port = await device({ name: 'R9', login: true });
  const { results } = await run([{ id: '1', name: 'R9', protocol: 'telnet', host: '127.0.0.1', port, username: 'admin', password: 'wrong' }]);
  assert.match(results.R9, /^failed .*login was rejected/);
});

test('labels a Telnet device without a port with port 23', async () => {
  const { dir } = await run([{ id: '1', name: 'no-port', protocol: 'telnet', host: '127.0.0.1' }]);
  assert.match(transcript(dir, 'no-port').split('\n')[1], /\(127\.0\.0\.1:23\)/);
});
