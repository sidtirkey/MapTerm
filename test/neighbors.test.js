import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCdp, parseLldp, neighborDevices, cleanName, shortIf } from '../src/server/neighbors.js';

const sample = (name) => fs.readFileSync(new URL(`./fixtures/neighbors/${name}`, import.meta.url), 'utf8');
// The parts of a neighbor row that matter for the map, easy to compare.
const summary = (devices) => devices.map((d) => ({
  name: d.name, kind: d.kind, network: d.isNetworkDevice, ip: d.managementIp,
  links: d.links.map((l) => `${l.localIf} > ${l.remoteIf}`),
}));

test('cleans neighbor names', () => {
  assert.equal(cleanName('R2.lab.example.com'), 'R2');
  assert.equal(cleanName('N9K-2(FDO21120U8N)'), 'N9K-2');
  assert.equal(cleanName('"spine1.dc1.example.com"'), 'spine1');
  assert.equal(cleanName('SEP001122334455'), 'SEP001122334455');
  assert.equal(cleanName('a4bb.6d00.1122'), 'a4bb.6d00.1122', 'a MAC address used as a name is kept');
  assert.equal(cleanName('10.20.0.77'), '10.20.0.77', 'an IP used as a name is kept');
});

test('shortens interface names', () => {
  const cases = {
    GigabitEthernet0_0_1: 'Gi0/0/1', TenGigabitEthernet1_1_1: 'Te1/1/1', TwentyFiveGigE1_0_1: 'Twe1/0/1',
    FortyGigabitEthernet1_0_49: 'Fo1/0/49', HundredGigE1_0_1: 'Hu1/0/1', FastEthernet0_1: 'Fa0/1',
    Ethernet1_49: 'Eth1/49', Ethernet49_1: 'Eth49/1', 'Port-channel10': 'Po10', 'Gi1_0_48': 'Gi1/0/48', 'Port 1': 'Port 1',
  };
  for (const [long, short] of Object.entries(cases)) assert.equal(shortIf(long.replace(/_/g, '/')), short);
  assert.equal(shortIf('"Ethernet2"'), 'Eth2');
});

test('IOS / IOS-XE CDP: routers, switches, access points, phones', () => {
  assert.deepEqual(summary(neighborDevices(parseCdp(sample('ios-cdp-detail.txt')))), [
    { name: 'AP-floor2', kind: 'ap', network: true, ip: '10.30.0.12', links: ['Gi0/1/1 > Gi0'] },
    { name: 'core-sw', kind: 'l3switch', network: true, ip: '10.255.0.3', links: ['Gi0/0/2 > Gi1/0/1', 'Gi0/0/3 > Gi1/0/2'] },
    { name: 'R2', kind: 'router', network: true, ip: '10.255.0.2', links: ['Gi0/0/1 > Gi0/0/0'] },
    { name: 'SEP001122334455', kind: 'phone', network: false, ip: '10.20.0.51', links: ['Gi0/1/0 > Port 1'] },
  ]);
});

test('CDP keeps every address, management addresses first', () => {
  const r2 = neighborDevices(parseCdp(sample('ios-cdp-detail.txt'))).find((d) => d.name === 'R2');
  assert.deepEqual(r2.addresses, [{ ip: '10.255.0.2', kind: 'management' }, { ip: '10.1.12.2', kind: 'interface' }]);
  assert.equal(r2.platform, 'cisco ISR4331/K9');
});

test('NX-OS CDP: system name, serial number removed, firewall recognised', () => {
  assert.deepEqual(summary(neighborDevices(parseCdp(sample('nxos-cdp-detail.txt')))), [
    { name: 'fw1', kind: 'firewall', network: true, ip: '192.168.1.50', links: ['Eth1/1 > Eth1/2'] },
    { name: 'N9K-2', kind: 'l3switch', network: true, ip: '192.168.1.12', links: ['Eth1/49 > Eth1/49'] },
  ]);
});

test('IOS LLDP: another vendor, a phone, and a host that sends no name', () => {
  const devices = neighborDevices(parseLldp(sample('ios-lldp-detail.txt')));
  assert.deepEqual(summary(devices), [
    { name: 'spine2', kind: 'l3switch', network: true, ip: '192.168.0.12', links: ['Gi1/0/48 > Eth2'] },
    { name: 'a4bb.6d00.1122', kind: 'other', network: false, ip: '', links: ['Gi1/0/11 > a4bb.6d00.1122'] },
    { name: 'SEP7C2E0D112233', kind: 'phone', network: false, ip: '10.20.0.77', links: ['Gi1/0/10 > 7C2E.0D11.2233:P1'] },
  ]);
  assert.equal(devices[0].platform, 'Arista Networks DCS-7050SX-64');
});

test('NX-OS LLDP: local port from "Local Port id", servers are not network devices', () => {
  assert.deepEqual(summary(neighborDevices(parseLldp(sample('nxos-lldp-detail.txt')))), [
    { name: 'N9K-2', kind: 'l3switch', network: true, ip: '192.168.1.12', links: ['Eth1/50 > Eth1/50'] },
    { name: 'backup01', kind: 'host', network: false, ip: '10.2.10.20', links: ['Eth1/10 > ens192'] },
  ]);
});

test('Arista EOS LLDP: parallel links to one neighbor, quoted values, stations', () => {
  assert.deepEqual(summary(neighborDevices(parseLldp(sample('eos-lldp-detail.txt')))), [
    { name: 'spine1', kind: 'l3switch', network: true, ip: '192.168.0.11', links: ['Eth1 > Eth49/1', 'Eth2 > Eth50/1'] },
    { name: '0050.5600.aabb', kind: 'host', network: false, ip: '', links: ['Eth10 > 0050.5600.aabb'] },
  ]);
});

test('merges CDP and LLDP: one row per device, a link reported twice counted once', () => {
  const cdp = parseCdp(sample('nxos-cdp-detail.txt')), lldp = parseLldp(sample('nxos-lldp-detail.txt'));
  const n9k = neighborDevices([...cdp, ...lldp]).find((d) => d.name === 'N9K-2');
  assert.deepEqual(n9k.links.map((l) => `${l.localIf} > ${l.remoteIf}`), ['Eth1/49 > Eth1/49', 'Eth1/50 > Eth1/50']);
  assert.deepEqual(n9k.via, ['cdp', 'lldp']);
  assert.equal(n9k.platform, 'N9K-C93180YC-EX', 'CDP details win');
  const twice = neighborDevices([...cdp, ...cdp]).find((d) => d.name === 'N9K-2');
  assert.equal(twice.links.length, 1);
});

test('no neighbors when CDP or LLDP is off, or the command is unknown', () => {
  assert.deepEqual(parseCdp(sample('cdp-not-enabled.txt')), []);
  assert.deepEqual(parseLldp('% LLDP is not enabled'), []);
  assert.deepEqual(parseCdp("% Invalid input detected at '^' marker."), []);
  assert.deepEqual(parseLldp(''), []);
});

test('works with Windows line endings (some terminal servers send CRLF)', () => {
  const lf = neighborDevices(parseCdp(sample('ios-cdp-detail.txt')));
  const crlf = neighborDevices(parseCdp(sample('ios-cdp-detail.txt').replace(/\n/g, '\r\n')));
  assert.deepEqual(summary(crlf), summary(lf));
  const eos = neighborDevices(parseLldp(sample('eos-lldp-detail.txt').replace(/\n/g, '\r\n')));
  assert.deepEqual(summary(eos), summary(neighborDevices(parseLldp(sample('eos-lldp-detail.txt')))));
});

test('shortening an already short interface name changes nothing', () => {
  for (const n of ['Gi0/1', 'Te1/1/1', 'Eth1/49', 'Po10', 'mgmt0', 'Port 1']) assert.equal(shortIf(shortIf(n)), shortIf(n));
});
