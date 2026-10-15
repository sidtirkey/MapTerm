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

/* ---------- telling devices apart (serial numbers first) ---------- */

const nb = (name, { serials = [], macs = [], names = [], ips = [] } = {}) => ({
  name, addresses: ips.map((ip) => ({ ip, kind: 'management' })), links: [{ localIf: 'Gi0/1', remoteIf: 'Gi0/1' }],
  identity: { serials, macs, chassisIds: [], names },
});
const src = { id: 'src', name: 'R1' };
const result = (neighbor, nodes) => matchToMap([neighbor], { nodes: [src, ...nodes], edges: [] }, 'src')[0];

test('the same serial number identifies a device even after it was renamed and readdressed', () => {
  const r = result(nb('R2', { serials: ['FGL1'], ips: ['10.0.0.2'] }), [{ id: 'n', name: 'Branch router', host: '172.16.0.2', identity: { serials: ['FGL1'] } }]);
  assert.deepEqual(r.match, { id: 'n', by: 'serial', certain: true });
});

test('the same MAC / chassis ID identifies a device', () => {
  const r = result(nb('core', { macs: ['00aabbcc0003'] }), [{ id: 'n', name: 'Core Switch 1', identity: { macs: ['00aabbcc0003'] } }]);
  assert.deepEqual(r.match, { id: 'n', by: 'mac', certain: true });
});

test('a remembered full name or address identifies a renamed device', () => {
  const byName = result(nb('R2', { names: ['r2.lab.local'] }), [{ id: 'n', name: 'Branch router', host: '127.0.0.1', identity: { names: ['r2.lab.local'] } }]);
  assert.deepEqual(byName.match, { id: 'n', by: 'name', certain: true });
  const byAddr = result(nb('R2', { ips: ['10.0.0.2'] }), [{ id: 'n', name: 'Branch router', host: '127.0.0.1', identity: { addresses: ['10.0.0.2'] } }]);
  assert.deepEqual(byAddr.match, { id: 'n', by: 'address', certain: true });
});

test('different serial numbers mean different devices, even with the same name', () => {
  const r = result(nb('sw1', { serials: ['FDO2222BBBB'], names: ['sw1.siteb.example.com'] }), [{ id: 'a', name: 'sw1', host: '10.1.0.1', identity: { serials: ['FDO1111AAAA'] } }]);
  assert.equal(r.match, null);
  assert.equal(r.clash, 'a', 'reported as a different device with the same name');
});

test('the same short name only is a probable match for the user to confirm', () => {
  const r = result(nb('R2'), [{ id: 'n', name: 'R2', host: '127.0.0.1' }]);
  assert.deepEqual(r.match, { id: 'n', by: 'short-name', certain: false });
});

test('several devices with the same name: no guess, the user chooses', () => {
  const r = result(nb('sw1'), [{ id: 'a', name: 'sw1', host: '10.1.0.1' }, { id: 'b', name: 'sw1', host: '10.2.0.1' }]);
  assert.equal(r.match, null);
  assert.deepEqual(r.candidates, ['a', 'b']);
});

test('a device listing itself as a neighbor is left out, recognised by its own serial number', async () => {
  const version = 'R1 uptime is 1 week\nProcessor board ID FTX9999SELF';
  const cdp = '-------------------------\nDevice ID:R1(FTX9999SELF)\nPlatform: N9K, Capabilities: Router Switch\nInterface: Ethernet1/1, Port ID (outgoing port): Ethernet1/2\n'
    + '-------------------------\nDevice ID:R2(FTX1111R2R2)\nPlatform: N9K, Capabilities: Router Switch\nInterface: Ethernet1/3, Port ID (outgoing port): Ethernet1/1\n';
  const r = await discover({ 'show version': version, 'show cdp neighbors detail': cdp, 'show lldp neighbors detail': '% LLDP is not enabled' });
  assert.deepEqual(r.self.serials, ['FTX9999SELF']);
  assert.deepEqual(r.neighbors.map((n) => n.name), ['R2']);
});
