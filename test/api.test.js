// Starts the real server on a free port with a temporary data folder and checks the HTTP API.
// (No SSH devices or OS keychain needed.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapterm-data-'));
process.env.MAPTERM_DATA_DIR = dataDir; // must be set before the server modules load
// The single topology.json of earlier versions; it should become the first map.
const oldTopology = { nodes: [{ id: 'a', name: 'R1', x: 1, y: 2 }, { id: 'b', name: 'R2', x: 3, y: 4 }], edges: [{ id: 'e', source: 'a', target: 'b' }] };
fs.writeFileSync(path.join(dataDir, 'topology.json'), JSON.stringify(oldTopology));
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

const json = async (...a) => (await call(...a)).json();

test('turns an earlier single topology into the first map', async () => {
  const { current, maps } = await json('/api/maps');
  assert.deepEqual(maps.map((m) => [m.name, m.devices]), [['My network', 2]]);
  const m = await json(`/api/maps/${current}`);
  assert.deepEqual({ nodes: m.nodes, edges: m.edges }, oldTopology);
  assert.equal(fs.existsSync(path.join(dataDir, 'topology.json')), false);
});

test('creates, saves, renames and deletes maps', async () => {
  const lab = (await json('/api/maps', 'POST', { name: 'Lab' })).map;
  assert.equal((await json('/api/maps', 'POST', { name: 'lab' })).ok, false, 'names are unique');
  const topo = { nodes: [{ id: 'x', name: 'SW1', x: 0, y: 0 }], edges: [] };
  assert.equal((await json(`/api/maps/${lab.id}`, 'PUT', topo)).ok, true);
  assert.deepEqual((await json(`/api/maps/${lab.id}`)).nodes, topo.nodes);
  assert.equal((await json(`/api/maps/${lab.id}`, 'PATCH', { name: 'Lab 2' })).ok, true);
  await json(`/api/maps/${lab.id}/open`, 'POST', {});
  assert.equal((await json('/api/maps')).current, lab.id, 'remembers the open map');
  const del = await json(`/api/maps/${lab.id}`, 'DELETE');
  assert.equal(del.ok, true);
  assert.deepEqual(del.maps.map((m) => m.name), ['My network']);
  const only = del.maps[0].id;
  assert.equal((await json(`/api/maps/${only}`, 'DELETE')).ok, false, 'the last map cannot be deleted');
});

test('duplicates with fresh device ids and keeps links connected', async () => {
  const { current } = await json('/api/maps');
  const copy = (await json('/api/maps', 'POST', { name: 'Copy', from: current })).map;
  const m = await json(`/api/maps/${copy.id}`);
  assert.deepEqual(m.nodes.map((n) => n.name), ['R1', 'R2']);
  assert.ok(m.nodes.every((n) => !['a', 'b'].includes(n.id)));
  assert.deepEqual([m.edges[0].source, m.edges[0].target], m.nodes.map((n) => n.id));
});

test('imports a map file, dropping credential links from another machine', async () => {
  const file = { nodes: [{ id: '1', name: 'FW', credId: 'c-from-elsewhere', x: 0, y: 0 }], edges: [] };
  const map = (await json('/api/maps', 'POST', { name: 'Imported', ...file })).map;
  assert.equal((await json(`/api/maps/${map.id}`)).nodes[0].credId, '');
  assert.equal((await json('/api/maps', 'POST', { name: 'Bad', nodes: 'nope', edges: [] })).ok, false);
});

test('keeps a separate log and results folder per map', async () => {
  const a = (await json('/api/maps', 'POST', { name: 'Site A' })).map;
  const b = (await json('/api/maps', 'POST', { name: 'Site B' })).map;
  const fresh = await json(`/api/maps/${a.id}`);
  assert.equal(fresh.logDir, '', 'no folder until the user chooses one');
  assert.equal(path.basename(fresh.suggestLogDir), 'Site A', 'suggests a folder named after the map');
  assert.equal((await json(`/api/maps/${a.id}`, 'PATCH', { logDir: 'relative/path' })).ok, false);
  const dirA = path.join(dataDir, 'logs-a'), dirB = path.join(dataDir, 'logs-b');
  assert.equal((await json(`/api/maps/${a.id}`, 'PATCH', { logDir: dirA, runDir: dirA })).logDir, dirA);
  assert.equal((await json(`/api/maps/${b.id}`, 'PATCH', { logDir: dirB })).logDir, dirB);
  assert.ok(fs.existsSync(dirA) && fs.existsSync(dirB), 'folders are created');
  assert.deepEqual([(await json(`/api/maps/${a.id}`)).logDir, (await json(`/api/maps/${b.id}`)).logDir], [dirA, dirB]);
  // A copy starts without folders, so it never writes into the original's.
  const copy = (await json('/api/maps', 'POST', { name: 'Site A copy', from: a.id })).map;
  assert.deepEqual([(await json(`/api/maps/${copy.id}`)).logDir, (await json(`/api/maps/${copy.id}`)).runDir], ['', '']);
});

test('refuses API requests from other websites', async () => {
  const res = await call('/api/maps', 'POST', { name: 'Evil' }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('never sends secrets back from the credentials API', async () => {
  const body = await (await call('/api/credentials')).json();
  assert.ok(Array.isArray(body.sets));
  assert.equal(typeof body.store, 'string');
});

test('discovers neighbors over the /ssh WebSocket', async () => {
  const { WebSocket } = await import('ws');
  const { fakeTelnetDevice, closeFakeDevices } = await import('./helpers/fake-telnet-device.js');
  const cdp = fs.readFileSync(new URL('./fixtures/neighbors/nxos-cdp-detail.txt', import.meta.url), 'utf8').trimEnd();
  const port = await fakeTelnetDevice({ name: 'N9K-1', responses: { 'terminal length 0': '', 'show cdp neighbors detail': cdp, 'show lldp neighbors detail': '% LLDP is not enabled' } });
  const map = (await json('/api/maps', 'POST', { name: 'Discovery' })).map;
  await json(`/api/maps/${map.id}`, 'PUT', { nodes: [
    { id: 'tel', name: 'N9K-1', protocol: 'telnet', host: '127.0.0.1', port, x: 0, y: 0 },
    { id: 'ssh', name: 'R1', protocol: 'ssh', host: '127.0.0.1', port: 1, x: 0, y: 0 },
  ], edges: [] });
  const discover = (nodeId) => new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ssh'), statuses = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'discover', mapId: map.id, nodeId })));
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'discover-status') statuses.push(m.state); if (m.type === 'discover-result') { ws.close(); resolve({ ...m, statuses }); } });
  });
  const ok = await discover('tel');
  assert.equal(ok.error, '');
  assert.deepEqual(ok.neighbors.map((n) => n.name), ['fw1', 'N9K-2']);
  assert.deepEqual(ok.protocols, { cdp: 'ok', lldp: 'off' });
  assert.ok(ok.statuses.includes('connecting') && ok.statuses.includes('running'), 'progress is reported');
  assert.match((await discover('ssh')).error, /No credentials for this device/);
  assert.match((await discover('gone')).error, /no longer on the map/);
  closeFakeDevices();
});

test('allows a second terminal session to the same device only when asked to', async () => {
  const { WebSocket } = await import('ws');
  const { fakeTelnetDevice, closeFakeDevices } = await import('./helpers/fake-telnet-device.js');
  const port = await fakeTelnetDevice({ name: 'SW9' });
  const device = { protocol: 'telnet', host: '127.0.0.1', port, name: 'SW9' };
  // Opens a terminal session; resolves to the first message that says how it went.
  const open = (extra = {}) => new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ssh');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', cols: 80, rows: 24, ...device, ...extra })));
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'ready' || m.type === 'busy') resolve({ ws, type: m.type, names: m.names }); });
  });
  const openNow = async () => (await json(`/api/terminals?host=127.0.0.1&port=${port}&protocol=telnet`)).open;
  assert.deepEqual(await openNow(), []);
  const first = await open();
  assert.equal(first.type, 'ready');
  assert.deepEqual(await openNow(), ['SW9'], 'the open session is listed');
  const second = await open();
  assert.deepEqual([second.type, second.names], ['busy', ['SW9']], 'a second session is refused');
  const forced = await open({ force: true });
  assert.equal(forced.type, 'ready', '...unless the user asked for it');
  assert.deepEqual(await openNow(), ['SW9', 'SW9']);
  first.ws.close(); forced.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await openNow(), [], 'closed sessions are forgotten');
  closeFakeDevices();
});
