// Starts the real server on a free port with a temporary data folder and checks the HTTP API.
// (No SSH devices or OS keychain needed.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapterm-data-'));
process.env.MAPTERM_DATA_DIR = dataDir; // must be set before the server modules load
const { createServer } = await import('../src/server/app.js');

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const call = (url, method = 'GET', body, headers = {}) => fetch(base + url, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
});

test('serves the page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>MapTerm<\/title>/);
});

test('saves the topology in the data folder', async () => {
  assert.deepEqual(await (await call('/api/topology')).json(), { nodes: [], edges: [] });
  const topo = { nodes: [{ id: 'a', name: 'R1', x: 1, y: 2 }], edges: [] };
  assert.equal((await (await call('/api/topology', 'PUT', topo)).json()).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'topology.json'), 'utf8')), topo);
});

test('validates folders before saving them', async () => {
  const bad = await (await call('/api/settings', 'PUT', { logDir: 'relative/path' })).json();
  assert.equal(bad.ok, false);
  const dir = path.join(dataDir, 'logs');
  const good = await (await call('/api/settings', 'PUT', { logDir: dir })).json();
  assert.deepEqual(good, { ok: true, logDir: dir });
  assert.equal((await (await call('/api/settings')).json()).logDir, dir);
});

test('refuses API requests from other websites', async () => {
  const res = await call('/api/settings', 'PUT', { logDir: '/tmp/x' }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('never sends secrets back from the credentials API', async () => {
  const body = await (await call('/api/credentials')).json();
  assert.ok(Array.isArray(body.sets));
  assert.equal(typeof body.store, 'string');
});
