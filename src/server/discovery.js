// Neighbor discovery: logs in to one device, reads its CDP and LLDP neighbors, and works out
// which of them are already on the map. Nothing is changed on the map here; the page shows the
// result for review and adds what the user picks.
import { runCommands } from './device-session.js';
import { parseCdp, parseLldp, neighborDevices, cleanName } from './neighbors.js';

// Paging off first (the session also answers --More--, but plain output parses best). Read-only.
export const DISCOVERY_COMMANDS = ['terminal length 0', 'show cdp neighbors detail', 'show lldp neighbors detail'];

// What a discovery command's output says about the protocol: 'ok', 'off' (disabled on the
// device) or 'unsupported' (the device does not know the command, e.g. CDP on Arista).
// Devices say so in the first line or two, so neighbor details further down can't be misread.
export function protocolState(output) {
  const head = String(output).split('\n').filter((l) => l.trim()).slice(0, 3).join('\n');
  if (/not enabled|is disabled|not running/i.test(head)) return 'off';
  if (/invalid input|unrecognized command|incomplete command|command not found|unknown command|syntax error|% invalid/i.test(head)) return 'unsupported';
  return 'ok';
}

// Marks neighbors (and their links) that are already on the map. A neighbor matches a device
// by name (ignoring case and domain) or by one of its addresses; a link matches when the same
// two interfaces already join the two devices.
export function matchToMap(neighbors, { nodes = [], edges = [] }, sourceId) {
  const byName = new Map(nodes.map((n) => [cleanName(n.name).toLowerCase(), n]));
  return neighbors.map((nb) => {
    const node = byName.get(nb.name.toLowerCase()) || nodes.find((n) => n.host && nb.addresses.some((a) => a.ip === n.host));
    const onMap = node && node.id !== sourceId ? node.id : '';
    const links = nb.links.map((l) => ({
      ...l,
      onMap: !!onMap && edges.some((e) =>
        (e.source === sourceId && e.target === onMap && (e.srcIf || '') === l.localIf && (e.dstIf || '') === l.remoteIf)
        || (e.source === onMap && e.target === sourceId && (e.srcIf || '') === l.remoteIf && (e.dstIf || '') === l.localIf)),
    }));
    return { ...nb, onMap, links };
  });
}

// Runs the discovery commands on a device. hooks.onStatus(state, detail) reports progress.
// Resolves to { error, neighbors, protocols: { cdp, lldp }, raw: { cdp, lldp } }.
export function discoverNeighbors({ device, auth, map, sourceId, algorithms }, hooks = {}) {
  const job = runCommands({ device, auth, commands: DISCOVERY_COMMANDS, algorithms }, { onStatus: hooks.onStatus });
  const done = job.done.then(({ error, outputs }) => {
    const [, cdp = '', lldp = ''] = outputs;
    if (error) return { error, neighbors: [], protocols: {}, raw: { cdp, lldp } };
    const protocols = { cdp: protocolState(cdp), lldp: protocolState(lldp) };
    const entries = [...(protocols.cdp === 'ok' ? parseCdp(cdp) : []), ...(protocols.lldp === 'ok' ? parseLldp(lldp) : [])];
    return { error: '', neighbors: matchToMap(neighborDevices(entries), map, sourceId), protocols, raw: { cdp, lldp } };
  });
  return { done, stop: job.stop };
}
