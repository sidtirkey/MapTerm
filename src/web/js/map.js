// The map: devices and links (Cytoscape), toolbar modes, saving, and the device / link
// context menus. Which map is shown is managed by maps.js.
import { $ } from './dom.js';
import { DEVICE_TYPES, deviceIcon } from './icons.js';
import { ask } from './dialog.js';
import { startLinkDraw, endLinkDraw, askLink } from './links.js';
import { connectNode, credCache, refreshMap } from './sessions.js';
import { credOptions } from './credentials.js';
import { updatePickbar } from './run.js';
import { currentMapId } from './maps.js';
import { discoverNeighbors } from './discover.js';

export let cy = null;
export let mode = 'select';

const hints = {
  select: 'Click a device to connect. Drag to rearrange.',
  add: 'Click empty space to place a device.',
  link: 'Click or release on the device to connect to. Esc or click empty space to cancel.',
  pick: 'Click devices to choose where the commands run, then Next.',
};

export function setMode(m) {
  if (mode === 'link' && m !== 'link') endLinkDraw();
  if (mode === 'pick' && m !== 'pick') cy.nodes().removeClass('chosen');
  // While picking, clicks only choose devices; they must not also select them (Delete removes selected devices).
  if (m === 'pick') cy.nodes().unselect();
  cy.autounselectify(m === 'pick');
  mode = m; closeMenu();
  $('#pickbar').classList.toggle('on', m === 'pick');
  if (m === 'pick') updatePickbar();
  [['select', 'bSel'], ['add', 'bAdd'], ['pick', 'bRun']].forEach(([k, id]) => $('#' + id).classList.toggle('on', k === m));
  $('#hint').textContent = hints[m];
}

export const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
// Devices on the map, excluding the invisible helper used while drawing a link.
export const realNodes = () => cy.nodes().not('.ghost');
const updateEmpty = () => { $('#empty').style.display = realNodes().length ? 'none' : 'flex'; };

/* ---------- persistence (no credentials stored) ---------- */
// Changes are saved shortly after they happen, to the map that was open when they happened.
let saveT, pendingSave = null;
export function save() {
  updateEmpty(); clearTimeout(saveT);
  const id = currentMapId();
  pendingSave = () => {
    pendingSave = null;
    const nodes = realNodes().map((n) => ({ ...n.data(), x: n.position('x'), y: n.position('y') }));
    const edges = cy.edges().not('.ghost').map((e) => ({ ...e.data() }));
    return fetch(`/api/maps/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes, edges }) }).catch(() => {});
  };
  saveT = setTimeout(pendingSave, 300);
}
// Saves now if a save is waiting (before switching maps, exporting, ...).
export function flushSave() { clearTimeout(saveT); return pendingSave ? pendingSave() : Promise.resolve(); }

// Replaces what is on the map with the given map's devices and links.
export function showMap(m) {
  setMode('select');
  cy.elements().remove();
  m.nodes.forEach(({ x, y, ...d }) => cy.add({ group: 'nodes', data: d, position: { x, y } }));
  m.edges.forEach((e) => cy.add({ group: 'edges', data: e }));
  if (m.nodes.length) cy.fit(undefined, 60); else cy.reset();
  updateEmpty();
  refreshMap(); // devices with an open terminal tab are highlighted
}

/* ---------- device form ---------- */
export const PROTOCOLS = { ssh: 'SSH', telnet: 'Telnet (unencrypted)' };
const DEFAULT_PORT = { ssh: '22', telnet: '23' };
export const protocolName = (d) => (d.protocol === 'telnet' ? 'Telnet' : 'SSH');
const nodeFields = (d = {}) => [
  { key: 'name', label: 'Device name', value: d.name },
  { key: 'type', label: 'Device type', value: d.type, options: Object.fromEntries(Object.entries(DEVICE_TYPES).map(([k, t]) => [k, t.label])) },
  { key: 'host', label: 'IP address or hostname', value: d.host },
  // Switching protocol moves the port between the two defaults (a custom port is kept).
  { key: 'protocol', label: 'Connect with', value: d.protocol || 'ssh', options: PROTOCOLS, onChange: (p, form) => {
    const port = form.querySelector('[name=port]');
    if (!port.value || Object.values(DEFAULT_PORT).includes(port.value)) port.value = DEFAULT_PORT[p];
  } },
  { key: 'port', label: 'Port', value: d.port || DEFAULT_PORT[d.protocol || 'ssh'] },
  { key: 'credId', label: 'Credentials', value: d.credId || '', options: { '': 'Ask when connecting', ...credOptions() } },
  { key: 'username', label: 'Username', value: d.username, showIf: ['credId', ''] },
];
// Accept "host:port" (or "[v6]:port") typed into the host field.
export function splitHostPort(v) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v.host || '') || /^([^:]+):(\d+)$/.exec(v.host || '');
  if (m) { v.host = m[1]; v.port = m[2]; }
  return v;
}

/* ---------- context menu ---------- */
export function closeMenu() { $('#menu').style.display = 'none'; }
function showMenu(pos, items) {
  const m = $('#menu'); m.innerHTML = '';
  items.forEach(([label, fn, cls]) => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls;
    b.onclick = () => { closeMenu(); fn(); }; m.appendChild(b);
  });
  m.style.display = 'block';
  const st = $('#stage');
  m.style.left = Math.min(pos.x + 8, st.clientWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(pos.y + 8, st.clientHeight - m.offsetHeight - 8) + 'px';
}

const STYLE = [
  { selector: 'node', style: {
    shape: 'round-rectangle', width: 60, height: 60, 'background-opacity': 0, 'border-width': 0,
    'background-image': (n) => deviceIcon(n.data('type')), 'background-fit': 'contain', 'background-clip': 'none',
    // Telnet devices are marked, since their sessions are not encrypted.
    label: (n) => n.data('name') + '\n' + (n.data('host') || '') + (n.data('protocol') === 'telnet' ? ' · telnet' : ''),
    'text-wrap': 'wrap', 'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 4, 'font-size': 12,
    'text-background-color': '#eef1f4', 'text-background-opacity': 0.85, 'text-background-padding': 2, 'text-background-shape': 'round-rectangle',
    color: '#1b2430', 'font-family': 'Segoe UI, Helvetica, Arial, sans-serif', 'line-height': 1.3 } },
  { selector: 'node.live', style: { 'underlay-color': '#0f9d73', 'underlay-opacity': 0.28, 'underlay-padding': 6, 'underlay-shape': 'round-rectangle' } },
  { selector: 'node.focus', style: { 'border-width': 2.5, 'border-color': '#2a56d6' } },
  { selector: 'node.chosen', style: { 'underlay-color': '#2a56d6', 'underlay-opacity': 0.22, 'underlay-padding': 7, 'underlay-shape': 'round-rectangle',
    'border-width': 2.5, 'border-color': '#2a56d6' } },
  { selector: 'node.fresh', style: { 'underlay-color': '#0f9d73', 'underlay-opacity': 0.3, 'underlay-padding': 9, 'underlay-shape': 'round-rectangle' } },
  { selector: 'node.pick', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': '#2a56d6' } },
  { selector: 'node:selected', style: { 'overlay-color': '#2a56d6', 'overlay-opacity': 0.12 } },
  { selector: 'edge', style: { width: 2.5, 'line-color': '#8794a5', 'curve-style': 'bezier', 'control-point-step-size': 36,
    'source-label': (e) => e.data('srcIf') || '', 'target-label': (e) => e.data('dstIf') || '', 'source-text-offset': 42, 'target-text-offset': 42,
    'font-size': 10, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', color: '#1b2430',
    'text-background-color': '#fff', 'text-background-opacity': 0.9, 'text-background-padding': 2, 'text-background-shape': 'round-rectangle' } },
  { selector: 'edge:selected', style: { 'line-color': '#2a56d6' } },
  { selector: 'node.ghost', style: { width: 1, height: 1, opacity: 0, events: 'no', label: '' } },
  { selector: 'edge.ghost', style: { 'line-color': '#2a56d6', 'line-style': 'dashed', width: 2, 'curve-style': 'straight', events: 'no',
    'target-arrow-shape': 'circle', 'target-arrow-color': '#2a56d6', 'arrow-scale': 0.8 } },
];

export function initMap() {
  cy = cytoscape({ container: $('#cy'), wheelSensitivity: 0.3, minZoom: 0.3, maxZoom: 2.5, style: STYLE });
  new ResizeObserver(() => { cy.resize(); }).observe($('#cy'));

  $('#bSel').onclick = () => setMode('select');
  $('#bAdd').onclick = () => setMode('add');
  setMode('select');

  cy.on('dragfree', 'node', save);

  cy.on('tap', async (evt) => {
    if (evt.target !== cy) return;
    closeMenu();
    if (mode !== 'add') return;
    const v = await ask('New device', nodeFields(), 'Add device');
    if (!v || !v.name) return;
    splitHostPort(v);
    cy.add({ group: 'nodes', data: { id: uid(), ...v }, position: evt.position });
    save(); setMode('select');
  });

  cy.on('tap', 'node', (evt) => {
    const n = evt.target;
    if (mode === 'pick') { n.toggleClass('chosen'); updatePickbar(); return; }
    if (mode !== 'select') return;
    showMenu(evt.renderedPosition, [
      [`Open ${protocolName(n.data())}`, () => connectNode(n)],
      ['Discover neighbors', () => discoverNeighbors(n)],
      ['Add link', () => startLinkDraw(n, evt.position)],
      ['Edit', async () => { const v = await ask('Edit device', nodeFields(n.data()), 'Save'); if (v && v.name) { n.data(splitHostPort(v)); credCache.delete(n.id()); save(); } }],
      ['Delete', () => { n.remove(); save(); }, 'danger'],
    ]);
  });
  cy.on('tap', 'edge', (evt) => {
    if (mode !== 'select') return;
    const e = evt.target;
    showMenu(evt.renderedPosition, [
      ['Edit interfaces', async () => { const v = await askLink(e.source(), e.target(), e); if (v) { e.data(v); save(); } }],
      ['Delete link', () => { e.remove(); save(); }, 'danger'],
    ]);
  });
  cy.on('dragstart zoom pan', closeMenu);

  // Delete / Backspace removes the selected devices and links (not while typing).
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.target.closest?.('.xterm,input,select,textarea,#mapmenu')) return;
    cy.$(':selected').remove(); save();
  });
}
