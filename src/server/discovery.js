// Neighbor discovery: logs in to one device, reads its CDP and LLDP neighbors, and works out
// which of them are already on the map. Nothing is changed on the map here; the page shows the
// result for review and adds what the user picks.
import { runCommands } from './device-session.js';
import { parseCdp, parseLldp, parseVersion, neighborDevices, cleanName } from './neighbors.js';

// Paging off first (the session also answers --More--, but plain output parses best); "show
// version" gives the device's own serial number and MAC. All read-only.
export const DISCOVERY_COMMANDS = ['terminal length 0', 'show version', 'show cdp neighbors detail', 'show lldp neighbors detail'];

// What a discovery command's output says about the protocol: 'ok', 'off' (disabled on the
// device) or 'unsupported' (the device does not know the command, e.g. CDP on Arista).
// Devices say so in the first line or two, so neighbor details further down can't be misread.
export function protocolState(output) {
  const head = String(output).split('\n').filter((l) => l.trim()).slice(0, 3).join('\n');
  if (/not enabled|is disabled|not running/i.test(head)) return 'off';
  if (/invalid input|unrecognized command|incomplete command|command not found|unknown command|syntax error|% invalid/i.test(head)) return 'unsupported';
  return 'ok';
}

// What identifies a device on the map: the identity remembered from earlier discoveries, its
// address, and its name when that includes a domain.
function mapIdentity(node) {
  const id = node.identity || {};
  const name = String(node.name || '').toLowerCase();
  return {
    serials: new Set(id.serials || []), macs: new Set(id.macs || []), chassisIds: new Set(id.chassisIds || []),
    names: new Set([...(id.names || []), ...(name.includes('.') ? [name] : [])]),
    addresses: new Set([...(id.addresses || []), node.host].filter(Boolean)),
  };
}
const shares = (list, set) => list.some((x) => set.has(x));

// Hardware identifiers decide first: a shared serial number, MAC or chassis ID means the same
// device; serial numbers that differ mean different devices. (Differing MACs prove nothing:
// a device may report another MAC over LLDP than the base MAC in "show version".)
function hardware(nb, m) {
  if (shares(nb.identity.serials, m.serials)) return { same: 'serial' };
  if (shares(nb.identity.macs, m.macs) || shares(nb.identity.chassisIds, m.chassisIds)) return { same: 'mac' };
  if (nb.identity.serials.length && m.serials.size) return { different: true };
  return {};
}

// Finds each neighbor on the map, most reliable evidence first:
//   1. same serial number / MAC / chassis ID              -> certain
//   2. same full name (with domain) or one of its addresses -> certain
//   3. same short name only                               -> probable (the user confirms)
// Devices whose serial numbers prove they are different are never matched; one with the same
// name is reported as a clash instead. Several equally good candidates are listed for the
// user to choose from. Adds to each neighbor:
//   match: { id, by: 'serial' | 'mac' | 'name' | 'address' | 'short-name', certain } | null
//   candidates: [device ids] (when it is ambiguous) · clash: device id · onMap: match id or ''
// Links count as drawn when the same two interfaces already join the two devices.
export function matchToMap(neighbors, { nodes = [], edges = [] }, sourceId) {
  const others = nodes.filter((n) => n.id !== sourceId).map((n) => ({ n, id: mapIdentity(n), short: cleanName(n.name).toLowerCase() }));
  return neighbors.map((nb) => {
    const hw = others.map((o) => ({ ...o, ...hardware(nb, o.id) }));
    const possible = hw.filter((o) => !o.different);
    const short = nb.name.toLowerCase();
    const fulls = nb.identity.names.filter((x) => x.includes('.')), addrs = nb.addresses.map((a) => a.ip);
    let match = null, candidates = [];
    const sameHw = hw.filter((o) => o.same);
    if (sameHw.length) match = { id: sameHw[0].n.id, by: sameHw[0].same, certain: true };
    else {
      const byName = possible.filter((o) => shares(fulls, o.id.names)), byAddr = possible.filter((o) => shares(addrs, o.id.addresses));
      const sure = [...new Set([...byName, ...byAddr])];
      if (sure.length === 1) match = { id: sure[0].n.id, by: byName.includes(sure[0]) ? 'name' : 'address', certain: true };
      else if (sure.length > 1) candidates = sure;
      else {
        const byShort = possible.filter((o) => o.short === short);
        if (byShort.length === 1) match = { id: byShort[0].n.id, by: 'short-name', certain: false };
        else if (byShort.length > 1) candidates = byShort;
      }
    }
    const clash = match ? '' : hw.find((o) => o.different && o.short === short)?.n.id || '';
    const onMap = match ? match.id : '';
    const links = nb.links.map((l) => ({ ...l, onMap: !!onMap && linkDrawn(edges, sourceId, onMap, l) }));
    return { ...nb, match, candidates: candidates.map((o) => o.n.id), clash, onMap, links };
  });
}

// Whether a link already joins the source device and a map device with these interfaces.
export const linkDrawn = (edges, sourceId, targetId, l) => edges.some((e) =>
  (e.source === sourceId && e.target === targetId && (e.srcIf || '') === l.localIf && (e.dstIf || '') === l.remoteIf)
  || (e.source === targetId && e.target === sourceId && (e.srcIf || '') === l.remoteIf && (e.dstIf || '') === l.localIf));

// Runs the discovery commands on a device. hooks.onStatus(state, detail) reports progress.
// Resolves to { error, neighbors, self, protocols: { cdp, lldp }, raw: { cdp, lldp } }, where self
// is the device's own identity from "show version" ({ serials, macs, hostname }).
export function discoverNeighbors({ device, auth, map, sourceId, algorithms }, hooks = {}) {
  const job = runCommands({ device, auth, commands: DISCOVERY_COMMANDS, algorithms }, { onStatus: hooks.onStatus });
  const done = job.done.then(({ error, outputs }) => {
    const [, version = '', cdp = '', lldp = ''] = outputs;
    if (error) return { error, neighbors: [], self: null, protocols: {}, raw: { cdp, lldp } };
    const protocols = { cdp: protocolState(cdp), lldp: protocolState(lldp) };
    const entries = [...(protocols.cdp === 'ok' ? parseCdp(cdp) : []), ...(protocols.lldp === 'ok' ? parseLldp(lldp) : [])];
    // The source device itself, recognised by its own serial / MAC, is never one of its neighbors.
    const self = parseVersion(version);
    const neighbors = neighborDevices(entries).filter((nb) => !(nb.identity.serials.some((x) => self.serials.includes(x)) || nb.identity.macs.some((x) => self.macs.includes(x))));
    return { error: '', neighbors: matchToMap(neighbors, map, sourceId), self, protocols, raw: { cdp, lldp } };
  });
  return { done, stop: job.stop };
}
