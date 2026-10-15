// Reads neighbor-discovery output (CDP and LLDP "detail") into neighbor devices.
//
//   parseCdp(text)   Cisco IOS / IOS-XE / NX-OS  "show cdp neighbors detail"
//   parseLldp(text)  Cisco IOS / IOS-XE / NX-OS and Arista EOS  "show lldp neighbors detail"
//
//   parseVersion(text) "show version": the device's own serial number, base MAC and hostname
//
// parseCdp / parseLldp return one entry per link:
//   { name, platform, description, capabilities: Set, localIf, remoteIf, addresses: [{ ip, kind }], identity, via }
// neighborDevices(entries) merges them (CDP first, so its details win) into one row per device:
//   { name, kind, type, isNetworkDevice, platform, managementIp, addresses, links: [{ localIf, remoteIf }], identity, via }
// identity holds what identifies the device beyond its display name:
//   { serials: [], macs: [], chassisIds: [], names: [] }  (names: full reported names, with domain, lower case)
// Output from a device with CDP/LLDP disabled, or an unknown command, gives no entries.

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const IPV4_ONLY = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC = /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$|^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const NOT_ADVERTISED = /not advertised/i;

/* ---------- identifiers ---------- */

// MAC addresses in any notation ("0011.2233.4455", "00:11:22:33:44:55", "00-11-…") as 12 hex digits.
export const normalizeMac = (s) => (MAC.test(String(s || '').trim()) ? String(s).toLowerCase().replace(/[^0-9a-f]/g, '') : '');
// A serial number in a device ID, as NX-OS reports it: "N9K-2(FDO21120U8N)".
const serialIn = (deviceId) => ((String(deviceId).match(/\(([A-Za-z0-9]{6,})\)$/) || [])[1] || '').toUpperCase();
// The full reported name, lower case, without quotes or a serial number in brackets.
const fullName = (raw) => String(raw || '').trim().replace(/^"(.*)"$/, '$1').replace(/\([A-Za-z0-9]{6,}\)$/, '').trim().toLowerCase();
const identity = ({ serial = '', mac = '', chassis = '', name = '' }) => ({
  serials: serial ? [serial] : [], macs: mac ? [mac] : [], chassisIds: chassis ? [chassis] : [], names: name ? [name] : [],
});

/* ---------- names and interfaces ---------- */

// "R2.lab.example.com" -> "R2", "N9K-2(FDO21120U8N)" -> "N9K-2". MAC addresses and IPs used
// as names (by hosts that send no system name) are kept as they are.
export function cleanName(raw) {
  let n = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  n = n.replace(/\([A-Za-z0-9]{6,}\)$/, '').trim();
  if (!MAC.test(n) && !IPV4_ONLY.test(n)) n = n.split('.')[0];
  return n;
}

// Cisco-style short interface names, as engineers write them on diagrams.
const IF_SHORT = [
  [/^TwentyFiveGigE(thernet)?/i, 'Twe'], [/^HundredGigE(thernet)?/i, 'Hu'], [/^FortyGigabitEthernet/i, 'Fo'],
  [/^TenGigabitEthernet/i, 'Te'], [/^TwoGigabitEthernet/i, 'Tw'], [/^FiveGigabitEthernet/i, 'Fi'],
  [/^AppGigabitEthernet/i, 'Ap'], [/^GigabitEthernet/i, 'Gi'], [/^FastEthernet/i, 'Fa'],
  [/^Ethernet/i, 'Eth'], [/^Port-channel/i, 'Po'], [/^Loopback/i, 'Lo'], [/^Management/i, 'Ma'],
];
export function shortIf(name) {
  const n = String(name || '').trim().replace(/^"(.*)"$/, '$1');
  for (const [re, short] of IF_SHORT) if (re.test(n)) return n.replace(re, short);
  return n;
}

/* ---------- capabilities and device type ---------- */

// CDP: "Router Switch IGMP", "Host Phone Two-port Mac Relay", "Router Trans-Bridge".
function cdpCaps(text) {
  const caps = new Set();
  for (const w of String(text || '').toLowerCase().split(/\s+/)) {
    if (w === 'router') caps.add('router');
    else if (w === 'switch' || w.endsWith('-bridge')) caps.add('switch');
    else if (w === 'phone') caps.add('phone');
    else if (w === 'host') caps.add('host');
  }
  return caps;
}

// LLDP: codes ("B,R") on Cisco, words ("Bridge, Router", "Station Only") on Arista.
function lldpCaps(text) {
  const caps = new Set();
  if (!text || NOT_ADVERTISED.test(text)) return caps;
  for (const w of text.toLowerCase().split(',').map((x) => x.trim())) {
    if (w === 'r' || w === 'router') caps.add('router');
    else if (w === 'b' || w === 'bridge') caps.add('switch');
    else if (w === 't' || w.startsWith('tele')) caps.add('phone');
    else if (w === 'w' || w.includes('wlan')) caps.add('wlan-ap');
    else if (w === 's' || w.startsWith('station')) caps.add('host');
  }
  return caps;
}

const FIREWALL = /\b(ASA\d*|FPR-?\d*|Firepower|FTD|PA-\d+|FortiGate|SRX\d+)\b/i;
const ROUTER_PLATFORM = /\b(ISR\d*|ASR\d*|CSR\d*|C8[0-9]{3}\w*|C1[01][0-9]{2}\w*|vEdge|cEdge)\b/i;
const AP_PLATFORM = /\bAIR-|\bC91[0-9]{2}AX|access point/i;

// The map icon to use: router, switch, l3switch, firewall, ap, or (not network devices)
// phone, host, other.
export function kindOf(caps, text) {
  if (caps.has('phone') || /\bphone\b/i.test(text)) return 'phone';
  if (FIREWALL.test(text)) return 'firewall';
  if (caps.has('wlan-ap') || AP_PLATFORM.test(text)) return 'ap';
  if (ROUTER_PLATFORM.test(text)) return 'router';
  if (caps.has('router') && caps.has('switch')) return 'l3switch';
  if (caps.has('switch')) return 'switch';
  if (caps.has('router')) return 'router';
  if (caps.has('host')) return 'host';
  return 'other';
}
const NETWORK_KINDS = new Set(['router', 'switch', 'l3switch', 'firewall', 'ap']);
const MAP_TYPE = { phone: 'pc', host: 'server', other: 'switch' };

/* ---------- helpers ---------- */

const field = (block, re) => {
  const m = block.match(re);
  const v = m && m[1].trim().replace(/^"(.*)"$/, '$1');
  return v && !NOT_ADVERTISED.test(v) ? v : '';
};

// The indented lines under a heading such as "Entry address(es):".
function section(block, heading) {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) { if (!/^\s+\S/.test(l)) break; out.push(l); }
  return out;
}
const ipsIn = (lines) => lines.map((l) => (l.match(IPV4) || [])[1]).filter(Boolean);

// First line of a "Version :" / "System Description:" value (which may start on the next line).
function firstLineAfter(block, heading) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => heading.test(l));
  if (i < 0) return '';
  const same = lines[i].replace(heading, '').trim();
  if (same) return same.replace(/^"(.*)"$/, '$1');
  return (lines.slice(i + 1).find((l) => l.trim()) || '').trim();
}

const normalize = (text) => String(text || '').replace(/\r/g, '');

/* ---------- CDP ---------- */

export function parseCdp(text) {
  const entries = [];
  for (const block of normalize(text).split(/^-{5,}\s*$/m)) {
    const deviceId = field(block, /^Device ID:\s*(.+)$/m);
    if (!deviceId) continue;
    const name = cleanName(field(block, /^System Name:\s*(.+)$/m) || deviceId);
    const pc = block.match(/^Platform:\s*(.+?),\s*Capabilities:\s*(.*)$/m) || [];
    const ip = block.match(/^Interface:\s*(.+?),\s*Port ID \(outgoing port\):\s*(.+)$/m) || [];
    const addresses = [
      ...ipsIn(section(block, /^(Management|Mgmt) address\(es\):/i)).map((a) => ({ ip: a, kind: 'management' })),
      ...ipsIn(section(block, /^(Entry|Interface) address\(es\):/i)).map((a) => ({ ip: a, kind: 'interface' })),
    ];
    entries.push({
      name, platform: (pc[1] || '').trim(), description: firstLineAfter(block, /^Version\s*:/),
      capabilities: cdpCaps(pc[2]), localIf: shortIf(ip[1]), remoteIf: shortIf(ip[2]), addresses, via: 'cdp',
      identity: identity({ serial: serialIn(deviceId), name: fullName(deviceId) }),
    });
  }
  return entries;
}

/* ---------- LLDP ---------- */

// "… running on an Arista Networks DCS-7050SX-64" -> "Arista Networks DCS-7050SX-64".
const platformFrom = (desc) => ((desc.match(/running on an? (.+)$/i) || [])[1] || desc).slice(0, 80);

function lldpEntry({ name, chassis, localIf, remoteIf, description, caps, mgmt }) {
  if (!localIf) return null;
  // The chassis ID is usually the device's base MAC; other kinds are kept as an opaque ID.
  const mac = normalizeMac(chassis);
  return {
    name: cleanName(name || chassis), platform: description ? platformFrom(description) : '', description,
    capabilities: lldpCaps(caps), localIf: shortIf(localIf), remoteIf: shortIf(remoteIf),
    addresses: mgmt.map((a) => ({ ip: a, kind: 'management' })), via: 'lldp',
    identity: identity({ mac, chassis: mac || !chassis ? '' : chassis.toLowerCase(), name: name ? fullName(name) : '' }),
  };
}

// Arista EOS: "Interface Ethernet1 detected 1 LLDP neighbors:" then indented "Neighbor …" blocks.
function parseEos(text) {
  const entries = [];
  const parts = text.split(/^Interface (\S+) detected \d+ LLDP neighbors?:\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    for (const n of parts[i + 1].split(/^\s*Neighbor /m).slice(1)) {
      entries.push(lldpEntry({
        localIf: parts[i],
        chassis: field(n, /^\s*Chassis ID\s*:\s*(.+)$/m),
        remoteIf: field(n, /^\s*Port ID\s*:\s*(.+)$/m),
        name: field(n, /- System Name:\s*(.+)$/m),
        description: field(n, /- System Description:\s*(.+)$/m),
        caps: field(n, /Enabled Capabilities:\s*(.+)$/m) || field(n, /System Capabilities\s*:\s*(.+)$/m),
        mgmt: [...n.matchAll(/Management Address\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})/g)].map((m) => m[1]),
      }));
    }
  }
  return entries.filter(Boolean);
}

// Cisco IOS / IOS-XE (records separated by dashes, starting with "Local Intf") and NX-OS
// (records starting with "Chassis id", local port in "Local Port id").
function parseCiscoLldp(text) {
  const records = /^-{5,}\s*$/m.test(text) ? text.split(/^-{5,}\s*$/m) : text.split(/\n(?=Chassis id:)/);
  return records.map((r) => lldpEntry({
    localIf: field(r, /^Local (?:Intf|Port id):\s*(.+)$/m),
    chassis: field(r, /^Chassis id:\s*(.+)$/m),
    remoteIf: field(r, /^Port id:\s*(.+)$/m),
    name: field(r, /^System Name:\s*(.+)$/m),
    description: (() => { const d = firstLineAfter(r, /^System Description:/); return NOT_ADVERTISED.test(d) ? '' : d; })(),
    caps: field(r, /^Enabled Capabilities:\s*(.+)$/m) || field(r, /^System Capabilities:\s*(.+)$/m),
    mgmt: [...r.matchAll(/^\s*(?:IP|Management Address):\s*(\d{1,3}(?:\.\d{1,3}){3})/gm)].map((m) => m[1]),
  })).filter(Boolean);
}

export function parseLldp(text) {
  const t = normalize(text);
  return /^Interface \S+ detected \d+ LLDP neighbors?:/m.test(t) ? parseEos(t) : parseCiscoLldp(t);
}

/* ---------- show version ---------- */

// The device's own identifiers, from "show version":
//   IOS / IOS-XE  "Processor board ID FTX1840AB1C", Catalyst "System Serial Number : FOC…",
//                 "Base Ethernet MAC Address : 00:11:22:33:44:55", "R1 uptime is …"
//   NX-OS         "Processor Board ID FDO21120U8N", "Device name: N9K-1"
//   Arista EOS    "Serial number: JPE12345678", "System MAC address: 001c.7311.2233"
export function parseVersion(text) {
  const t = normalize(text);
  const pick = (...res) => { for (const re of res) { const m = t.match(re); if (m) return m[1].trim(); } return ''; };
  const serial = pick(/^\s*System [Ss]erial [Nn]umber\s*:\s*(\S+)/m, /^\s*Serial [Nn]umber\s*:\s*(\S+)/m, /^\s*Processor [Bb]oard ID\s+(\S+)/m);
  const mac = normalizeMac(pick(/^\s*Base [Ee]thernet MAC [Aa]ddress\s*:\s*(\S+)/m, /^\s*System MAC address\s*:\s*(\S+)/m));
  const hostname = pick(/^(\S+) uptime is/m, /^\s*Device name:\s*(\S+)/m);
  return { ...identity({ serial: serial.toUpperCase(), mac }), hostname };
}

/* ---------- one row per neighbor device ---------- */

const IP_OR_MAC = (n) => MAC.test(n) || IPV4_ONLY.test(n);
const union = (a = [], b = []) => [...new Set([...a, ...b])];

// Entries describe the same device when they share a serial number, MAC / chassis ID, full name
// or address, or (unless their serial numbers say otherwise) the same short name. So a device
// whose CDP entry has a name and whose LLDP entry only a MAC still becomes one row when an
// address ties them together.
export function neighborDevices(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  const join = (i, key) => { if (owner.has(key)) parent[find(i)] = find(owner.get(key)); else owner.set(key, i); };
  entries.forEach((e, i) => {
    e.identity.serials.forEach((x) => join(i, 's:' + x));
    e.identity.macs.forEach((x) => join(i, 'm:' + x));
    e.identity.chassisIds.forEach((x) => join(i, 'c:' + x));
    e.identity.names.filter((x) => x.includes('.')).forEach((x) => join(i, 'n:' + x));
    e.addresses.forEach((a) => join(i, 'a:' + a.ip));
  });
  // Then by short name, between groups whose serial numbers don't contradict each other.
  const groupId = (i) => find(i);
  const serialsOf = (root) => entries.filter((_, k) => groupId(k) === root).flatMap((e) => e.identity.serials);
  const byShort = new Map();
  entries.forEach((e, i) => {
    if (IP_OR_MAC(e.name)) return;
    const key = e.name.toLowerCase(), other = byShort.get(key);
    if (other === undefined) return byShort.set(key, i);
    const [a, b] = [serialsOf(groupId(i)), serialsOf(groupId(other))];
    if (!(a.length && b.length && !a.some((x) => b.includes(x)))) parent[groupId(i)] = groupId(other);
  });

  const groups = new Map();
  entries.forEach((e, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(e); });
  return [...groups.values()].map((group) => {
    const d = { name: '', platform: '', description: '', caps: new Set(), addresses: [], links: [], via: new Set(), identity: identity({}) };
    for (const e of group) {
      if (!d.name || (IP_OR_MAC(d.name) && !IP_OR_MAC(e.name))) d.name = e.name; // a real name beats a MAC
      d.platform ||= e.platform;
      d.description ||= e.description;
      e.capabilities.forEach((c) => d.caps.add(c));
      d.via.add(e.via);
      for (const k of Object.keys(d.identity)) d.identity[k] = union(d.identity[k], e.identity[k]);
      for (const a of e.addresses) {
        const known = d.addresses.find((x) => x.ip === a.ip);
        if (!known) d.addresses.push({ ...a });
        else if (a.kind === 'management') known.kind = 'management';
      }
      // The same link can be reported by both CDP and LLDP; parallel links stay separate.
      const link = d.links.find((l) => l.localIf === e.localIf);
      if (link) link.remoteIf ||= e.remoteIf;
      else d.links.push({ localIf: e.localIf, remoteIf: e.remoteIf });
    }
    const kind = kindOf(d.caps, `${d.platform} ${d.description}`);
    const addresses = [...d.addresses].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'management' ? -1 : 1));
    return {
      name: d.name, kind, type: MAP_TYPE[kind] || kind, isNetworkDevice: NETWORK_KINDS.has(kind),
      platform: d.platform, managementIp: addresses[0]?.ip || '', addresses, links: d.links, via: [...d.via].sort(),
      identity: d.identity,
    };
  }).sort((a, b) => (b.isNetworkDevice - a.isNetworkDevice) || a.name.localeCompare(b.name));
}

