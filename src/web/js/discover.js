// "Discover neighbors": reads a device's CDP / LLDP neighbors (on the server, see
// src/server/discovery.js), shows them for review, and adds the chosen ones to the map:
// new devices around the source device, links with interface names on both ends.
import { $, wsUrl } from './dom.js';
import { ask } from './dialog.js';
import { DEVICE_TYPES } from './icons.js';
import { cy, save, flushSave, uid, realNodes, splitHostPort, protocolName } from './map.js';
import { ifInUse } from './links.js';
import { credCache } from './sessions.js';
import { credSet } from './credentials.js';
import { currentMapId } from './maps.js';

const modal = $('#discmodal');
let ws = null;     // the discovery in progress
let review = null; // { source, rows } while the result is shown

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const close = () => { if (ws) { ws.close(); ws = null; } review = null; modal.style.display = 'none'; };
export const discoveryOpen = () => modal.style.display === 'flex';
export const closeDiscovery = close;

function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('on');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('on'), 4500);
}

function setStatus(text, { busy = false, error = false } = {}) {
  const s = $('#discstatus');
  s.className = error ? 'err' : '';
  s.replaceChildren(...(busy ? [Object.assign(document.createElement('span'), { className: 'spin' })] : []), text);
}

// Credentials for discovery follow the same rules as connecting: the device's credential set,
// credentials typed this session, nothing for Telnet, or ask now.
async function credsFor(n) {
  const d = n.data();
  if (credSet(d.credId) || d.protocol === 'telnet') return credCache.get(n.id()) || null;
  if (credCache.has(n.id())) return credCache.get(n.id());
  const v = await ask(`Log in to ${d.name}`, [
    { key: 'username', label: 'Username', value: d.username },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'enable', label: 'Enable password (optional)', type: 'password' },
  ], 'Discover', 'Discovery logs in and runs show cdp / show lldp neighbors detail (read-only). To skip this next time, give the device a credential set.');
  if (!v || !v.username) return undefined;
  credCache.set(n.id(), v);
  return v;
}

export async function discoverNeighbors(source) {
  const creds = await credsFor(source);
  if (creds === undefined) return;
  await flushSave(); // the server reads the saved map
  const name = source.data('name');
  $('#disctitle').textContent = `Neighbors of ${name}`;
  $('#disclist').replaceChildren(); $('#discraw').hidden = true; $('#discraw').open = false;
  $('#disccount').textContent = ''; $('#discAdd').hidden = true; $('#discCancel').textContent = 'Cancel';
  setStatus(`Connecting to ${name}…`, { busy: true });
  modal.style.display = 'flex';

  ws = new WebSocket(wsUrl('/ssh'));
  const socket = ws;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'discover', mapId: currentMapId(), nodeId: source.id(), creds }));
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'discover-status') {
      const cmd = (m.detail || '').replace(/^\d+\/\d+\s+/, '');
      setStatus(m.state === 'connecting' ? `Connecting to ${name}…` : cmd === 'enable' ? 'Entering enable mode…' : `Running ${cmd}…`, { busy: true });
    } else if (m.type === 'discover-result') {
      ws = null; socket.close();
      showResult(source, m);
    }
  };
  socket.onclose = () => { if (ws === socket) { ws = null; setStatus('Lost connection to the MapTerm server.', { error: true }); } };
}

const PROTOCOL_STATE = { ok: 'answered', off: 'switched off', unsupported: 'not supported by this device' };

function showResult(source, r) {
  $('#discCancel').textContent = 'Close';
  if (r.raw.cdp || r.raw.lldp) {
    $('#discraw pre').textContent = `# show cdp neighbors detail\n${r.raw.cdp || '(nothing)'}\n\n# show lldp neighbors detail\n${r.raw.lldp || '(nothing)'}`;
    $('#discraw').hidden = false;
  }
  if (r.error) return setStatus(`Discovery failed: ${r.error}`, { error: true });
  const protocols = `CDP ${PROTOCOL_STATE[r.protocols.cdp] || '?'} · LLDP ${PROTOCOL_STATE[r.protocols.lldp] || '?'}`;
  if (!r.neighbors.length) return setStatus(`No neighbors found. ${protocols}.`);
  setStatus(`${plural(r.neighbors.length, 'neighbor')} found (${protocols}). Tick what to add; network devices are ticked.`);
  review = { source, rows: r.neighbors.map((nb) => makeRow(source, nb)) };
  const head = document.createElement('div');
  head.className = 'row head';
  head.innerHTML = '<span></span><span>Name</span><span>Type</span><span>Links (this device ↔ neighbor)</span><span>Management address</span><span>Platform</span>';
  const group = (title) => Object.assign(document.createElement('div'), { className: 'group', textContent: title });
  const net = review.rows.filter((x) => x.nb.isNetworkDevice), other = review.rows.filter((x) => !x.nb.isNetworkDevice);
  $('#disclist').replaceChildren(head,
    ...(net.length ? [group('Network devices'), ...net.map((x) => x.el)] : []),
    ...(other.length ? [group('Other neighbors (phones, servers, …)'), ...other.map((x) => x.el)] : []));
  $('#discAdd').hidden = false;
  updateCount();
}

// One review row: tick box, name, type, links, management address, platform.
function makeRow(source, nb) {
  const existing = nb.onMap ? cy.getElementById(nb.onMap) : null;
  const newLinks = nb.links.filter((l) => !l.onMap);
  const el = document.createElement('div');
  el.className = 'row';
  const tick = Object.assign(document.createElement('input'), { type: 'checkbox', checked: nb.isNetworkDevice && (!existing || newLinks.length > 0) });
  tick.disabled = !!existing && !newLinks.length;
  tick.setAttribute('aria-label', `Add ${nb.name}`);

  const nameCell = document.createElement('div');
  const name = Object.assign(document.createElement('input'), { type: 'text', value: nb.name });
  nameCell.append(name);
  if (existing) {
    name.disabled = true;
    nameCell.append(Object.assign(document.createElement('span'), { className: 'onmap', textContent: `On the map as ${existing.data('name')}` }));
  }

  const type = document.createElement('select');
  Object.entries(DEVICE_TYPES).forEach(([k, t]) => type.add(new Option(t.label, k)));
  type.value = DEVICE_TYPES[nb.type] ? nb.type : 'switch';
  type.disabled = !!existing;

  const links = document.createElement('div');
  links.className = 'links';
  for (const l of nb.links) {
    const line = Object.assign(document.createElement('div'), { textContent: `${l.localIf || '?'} ↔ ${l.remoteIf || '?'}` });
    if (l.onMap) { line.className = 'drawn'; line.title = 'Already drawn'; }
    links.append(line);
  }

  // A text box with the discovered addresses as suggestions; any address (or address:port) can be typed.
  const mgmtCell = document.createElement('div');
  const mgmt = Object.assign(document.createElement('input'), { type: 'text', value: nb.managementIp, placeholder: 'IP or hostname' });
  if (existing) { mgmt.value = existing.data('host') || ''; mgmt.disabled = true; }
  else if (nb.addresses.length) {
    const list = document.createElement('datalist');
    list.id = `addr-${uid()}`;
    nb.addresses.forEach((a) => list.append(new Option(`${a.ip} (${a.kind})`, a.ip)));
    mgmt.setAttribute('list', list.id);
    mgmtCell.append(list);
  }
  mgmtCell.prepend(mgmt);

  const platform = Object.assign(document.createElement('div'), { textContent: nb.platform || '—' });
  platform.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: `via ${nb.via.join(' + ').toUpperCase()}` }));

  el.append(tick, nameCell, type, links, mgmtCell, platform);
  const sync = () => { el.classList.toggle('off', !tick.checked); updateCount(); };
  tick.onchange = sync;
  el.classList.toggle('off', !tick.checked);
  return { nb, el, tick, name, type, mgmt, existing, newLinks };
}

function plan() {
  const chosen = review ? review.rows.filter((x) => x.tick.checked && !x.tick.disabled) : [];
  return { devices: chosen.filter((x) => !x.existing), links: chosen.reduce((n, x) => n + x.newLinks.length, 0), chosen };
}

function updateCount() {
  const { devices, links } = plan();
  $('#disccount').textContent = devices.length || links ? `Adds ${plural(devices.length, 'device')} and ${plural(links, 'link')}` : 'Nothing selected';
  $('#discAdd').disabled = !devices.length && !links;
  $('#discAdd').textContent = devices.length ? `Add ${plural(devices.length, 'device')}` : 'Add links';
}

// Positions for new devices: a fan around the source device, 45° apart and pointing away from
// the rest of the map (so new devices and their links don't run through existing ones), each
// pushed outwards until it keeps clear of every device already there.
function placeAround(source, count) {
  const c = source.position(), rest = realNodes().not(source);
  let dir = -Math.PI / 2; // upwards when the source is alone
  if (rest.length) {
    const mx = rest.reduce((t, n) => t + n.position('x'), 0) / rest.length, my = rest.reduce((t, n) => t + n.position('y'), 0) / rest.length;
    if (Math.hypot(c.x - mx, c.y - my) > 1) dir = Math.atan2(c.y - my, c.x - mx);
  }
  const step = Math.PI / 4, spread = Math.min(Math.PI * 1.7, step * (count - 1));
  const taken = realNodes().map((n) => n.position());
  const clear = (p) => taken.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 130);
  const spots = [];
  for (let k = 0; k < count; k++) {
    const a = dir - spread / 2 + (count > 1 ? (spread * k) / (count - 1) : 0);
    let spot = null;
    for (let r = 240; !spot && r < 1600; r += 80) {
      for (const nudge of [0, 0.15, -0.15, 0.3, -0.3]) {
        const p = { x: c.x + r * Math.cos(a + nudge), y: c.y + r * Math.sin(a + nudge) };
        if (clear(p)) { spot = p; break; }
      }
    }
    spot ||= { x: c.x + 240, y: c.y + k * 130 };
    taken.push(spot); spots.push(spot);
  }
  return spots;
}

function addChosen() {
  const { source } = review, { devices, chosen } = plan();
  const s = source.data();
  const spots = placeAround(source, devices.length);
  const added = [], skipped = [];
  let links = 0, sameLogins = 0;
  for (const x of chosen) {
    let target = x.existing;
    if (!target) {
      // New devices connect the way the source device does (protocol, port, and, for network
      // devices, its credentials); an address typed as "host:port" sets its own port. Phones and
      // servers rarely share the network gear's login, so they ask when first connected.
      const addr = splitHostPort({ host: x.mgmt.value.trim(), port: s.port });
      const sameLogin = x.nb.isNetworkDevice;
      if (sameLogin && s.credId) sameLogins++;
      target = cy.add({ group: 'nodes', position: spots[added.length], data: {
        id: uid(), name: x.name.value.trim() || x.nb.name, type: x.type.value, host: addr.host, port: addr.port,
        protocol: s.protocol || 'ssh', credId: sameLogin ? s.credId || '' : '', username: sameLogin ? s.username || '' : '',
      } });
      added.push(target);
    }
    for (const l of x.newLinks) {
      // An interface can only be used by one link on a device.
      if (ifInUse(source, l.localIf) || ifInUse(target, l.remoteIf)) { skipped.push(`${l.localIf} ↔ ${l.remoteIf}`); continue; }
      cy.add({ group: 'edges', data: { id: uid(), source: source.id(), target: target.id(), srcIf: l.localIf, dstIf: l.remoteIf } });
      links++;
    }
  }
  save();
  close();
  if (added.length) {
    const fresh = cy.collection(added);
    fresh.addClass('fresh');
    setTimeout(() => fresh.removeClass('fresh'), 3000);
    cy.animate({ fit: { eles: cy.nodes(), padding: 60 } }, { duration: 500 });
  }
  const what = [added.length && plural(added.length, 'device'), links && plural(links, 'link')].filter(Boolean).join(' and ') || 'Nothing';
  toast(`${what} added from ${s.name}'s neighbors`
    + (added.length ? `; new devices connect with ${protocolName(s)}${sameLogins ? ` (${sameLogins === added.length ? 'all' : sameLogins} with ${s.name}'s credentials)` : ''}` : '')
    + (skipped.length ? `. Not added, interface already in use: ${skipped.join(', ')}` : '.'));
}

export function initDiscovery() {
  $('#discCancel').onclick = close;
  $('#discAdd').onclick = addChosen;
}
