import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCdp, parseLldp, parseVersion, neighborDevices, cleanName, shortIf } from '../src/server/neighbors.js';

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

/* ---------- identities (serial numbers, MACs, full names) ---------- */

test('reads the device\'s own serial number, base MAC and hostname from show version', () => {
  const ios = 'Cisco IOS XE Software, Version 16.09.04\nR1 uptime is 3 weeks, 2 days\ncisco ISR4331/K9 (1RU) processor with 1795979K/6147K bytes of memory.\nProcessor board ID FDO21520AB1\n';
  const cat9k = 'Cisco IOS XE Software, Version 17.03.04\ncore-sw uptime is 1 year\nBase Ethernet MAC Address          : 70:b3:17:aa:bb:cc\nMotherboard Serial Number          : FOC12345XYZ\nSystem Serial Number               : FCW2233L0AB\n';
  const nxos = 'Cisco Nexus Operating System (NX-OS) Software\n  Device name: N9K-1\n  cisco Nexus9000 C93180YC-EX chassis\n  Processor Board ID FDO21120U8N\n';
  const eos = 'Arista DCS-7050SX-64\nHardware version: 01.01\nSerial number: JPE14211234\nSystem MAC address: 001c.7311.2233\n';
  assert.deepEqual(parseVersion(ios), { serials: ['FDO21520AB1'], macs: [], chassisIds: [], names: [], hostname: 'R1' });
  assert.deepEqual(parseVersion(cat9k), { serials: ['FCW2233L0AB'], macs: ['70b317aabbcc'], chassisIds: [], names: [], hostname: 'core-sw' });
  assert.deepEqual(parseVersion(nxos), { serials: ['FDO21120U8N'], macs: [], chassisIds: [], names: [], hostname: 'N9K-1' });
  assert.deepEqual(parseVersion(eos), { serials: ['JPE14211234'], macs: ['001c73112233'], chassisIds: [], names: [], hostname: '' });
});

test('captures identifiers from CDP and LLDP', () => {
  const n9k = neighborDevices(parseCdp(sample('nxos-cdp-detail.txt'))).find((d) => d.name === 'N9K-2');
  assert.deepEqual(n9k.identity.serials, ['FDO21120U8N'], 'NX-OS puts the serial number in the device ID');
  const r2 = neighborDevices(parseCdp(sample('ios-cdp-detail.txt'))).find((d) => d.name === 'R2');
  assert.deepEqual(r2.identity.names, ['r2.lab.example.com'], 'the full name, with its domain, is kept');
  const spine = neighborDevices(parseLldp(sample('eos-lldp-detail.txt'))).find((d) => d.name === 'spine1');
  assert.deepEqual(spine.identity.macs, ['001c73114455'], 'the LLDP chassis MAC, in one notation');
});

test('one device reported by CDP (name) and LLDP (MAC only) becomes one row when an address ties them', () => {
  const cdp = '-------------------------\nDevice ID: R2.lab.local\nEntry address(es): \n  IP address: 10.0.0.2\nPlatform: cisco ISR4331,  Capabilities: Router\nInterface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/1\n';
  const lldp = '------------------------------------------------\nLocal Intf: Gi0/2\nChassis id: 0011.2233.4455\nPort id: Gi0/2\nSystem Name - not advertised\n\nEnabled Capabilities: R\nManagement Addresses:\n    IP: 10.0.0.2\n';
  const rows = neighborDevices([...parseCdp(cdp), ...parseLldp(lldp)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'R2', 'a real name is preferred over a MAC');
  assert.deepEqual(rows[0].links.map((l) => l.localIf), ['Gi0/1', 'Gi0/2']);
  assert.deepEqual(rows[0].identity.macs, ['001122334455']);
});

test('two neighbors with the same short name but different serial numbers stay apart', () => {
  const block = (id, ifc) => `-------------------------\nDevice ID:${id}\nPlatform: N9K-C93180YC-EX, Capabilities: Router Switch\nInterface: ${ifc}, Port ID (outgoing port): Ethernet1/1\n`;
  const rows = neighborDevices(parseCdp(block('sw1(FDO1111AAAA)', 'Ethernet1/1') + block('sw1(FDO2222BBBB)', 'Ethernet1/2')));
  assert.equal(rows.length, 2);
});
