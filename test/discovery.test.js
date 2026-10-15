import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { discoverNeighbors, matchToMap, protocolState } from '../src/server/discovery.js';
import { neighborDevices, parseCdp } from '../src/server/neighbors.js';
import { fakeTelnetDevice, closeFakeDevices } from './helpers/fake-telnet-device.js';

after(closeFakeDevices);
const sample = (name) => fs.readFileSync(new URL(`./fixtures/neighbors/${name}`, import.meta.url), 'utf8').trimEnd();
const INVALID = "                       ^\n% Invalid input detected at '^' marker.";

// Discovery against a fake Telnet device that answers with the given outputs.
async function discover(responses, map = { nodes: [], edges: [] }, opts = {}) {
  const port = await fakeTelnetDevice({ name: 'R1', responses: { 'terminal length 0': '', ...responses }, pageAfter: 25, ...opts });
  const device = { id: 'src', name: 'R1', protocol: 'telnet', host: '127.0.0.1', port };
  return discoverNeighbors({ device, auth: opts.login ? { username: 'admin', password: 'wrong' } : {}, map, sourceId: 'src', algorithms: {} }).done;
}

test('reads whether CDP / LLDP answered, are switched off, or are unknown to the device', () => {
  assert.equal(protocolState(sample('ios-cdp-detail.txt')), 'ok');
  assert.equal(protocolState(''), 'ok', 'no neighbors is still an answer');
  assert.equal(protocolState('% CDP is not enabled'), 'off');
  assert.equal(protocolState('% LLDP is not enabled'), 'off');
  assert.equal(protocolState(INVALID), 'unsupported');
  assert.equal(protocolState('-bash: show: command not found'), 'unsupported');
});

test('discovers CDP and LLDP neighbors through a paged session and merges them', async () => {
  const r = await discover({ 'show cdp neighbors detail': sample('ios-cdp-detail.txt'), 'show lldp neighbors detail': sample('ios-lldp-detail.txt') });
  assert.equal(r.error, '');
  assert.deepEqual(r.protocols, { cdp: 'ok', lldp: 'ok' });
  assert.deepEqual(r.neighbors.filter((n) => n.isNetworkDevice).map((n) => `${n.name} ${n.kind} ${n.managementIp}`),
    ['AP-floor2 ap 10.30.0.12', 'core-sw l3switch 10.255.0.3', 'R2 router 10.255.0.2', 'spine2 l3switch 192.168.0.12']);
  assert.match(r.raw.cdp, /Device ID: R2\.lab\.example\.com/, 'raw output is kept for troubleshooting');
  assert.ok(!/--More--/.test(r.raw.cdp + r.raw.lldp), 'no pager leftovers');
});

test('an Arista-style device: CDP unknown, LLDP answered', async () => {
  const r = await discover({ 'show cdp neighbors detail': INVALID, 'show lldp neighbors detail': sample('eos-lldp-detail.txt') });
  assert.deepEqual(r.protocols, { cdp: 'unsupported', lldp: 'ok' });
  assert.deepEqual(r.neighbors.map((n) => n.name), ['spine1', '0050.5600.aabb']);
});

test('both protocols switched off: no neighbors, and the result says why', async () => {
  const r = await discover({ 'show cdp neighbors detail': '% CDP is not enabled', 'show lldp neighbors detail': '% LLDP is not enabled' });
  assert.deepEqual(r.neighbors, []);
  assert.deepEqual(r.protocols, { cdp: 'off', lldp: 'off' });
});

test('marks neighbors already on the map by name or address, and links already drawn', () => {
  const neighbors = neighborDevices(parseCdp(sample('ios-cdp-detail.txt')));
  const map = {
    nodes: [
      { id: 'src', name: 'R1' },
      { id: 'n-r2', name: 'r2.lab.example.com' },        // same device, different case and with domain
      { id: 'n-core', name: 'CORE', host: '10.255.0.3' }, // different name, same management address
    ],
    edges: [
      { source: 'src', target: 'n-r2', srcIf: 'Gi0/0/1', dstIf: 'Gi0/0/0' },  // drawn from R1's side
      { source: 'n-core', target: 'src', srcIf: 'Gi1/0/2', dstIf: 'Gi0/0/3' }, // drawn from the neighbor's side
    ],
  };
  const m = Object.fromEntries(matchToMap(neighbors, map, 'src').map((n) => [n.name, n]));
  assert.equal(m.R2.onMap, 'n-r2');
  assert.deepEqual(m.R2.links.map((l) => l.onMap), [true]);
  assert.equal(m['core-sw'].onMap, 'n-core');
  assert.deepEqual(m['core-sw'].links.map((l) => `${l.localIf} ${l.onMap}`), ['Gi0/0/2 false', 'Gi0/0/3 true']);
  assert.equal(m['AP-floor2'].onMap, '');
});

test('a failed login is reported as the error', async () => {
  const r = await discover({}, undefined, { login: true });
  assert.match(r.error, /login was rejected/);
  assert.deepEqual(r.neighbors, []);
});
