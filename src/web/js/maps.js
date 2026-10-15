// Maps: several topologies ("Production", "Lab", ...) and the map menu in the toolbar
// (switch, new, duplicate, rename, export, import, delete). Open terminal tabs and a running
// command run are not affected by switching maps.
import { $, getJSON, postJSON } from './dom.js';
import { ask } from './dialog.js';
import { showMap, flushSave } from './map.js';

let current = null; // { id, name }
export const currentMapId = () => current?.id;

function setCurrent(id, name) {
  current = { id, name };
  $('#mapname').textContent = name;
  document.title = `${name} · MapTerm`;
}

async function openMap(id) {
  await flushSave(); // a pending save belongs to the map being left
  const m = await getJSON(`/api/maps/${id}`);
  setCurrent(m.id, m.name);
  showMap(m);
  postJSON(`/api/maps/${id}/open`, {});
}

/* ---------- the map menu ---------- */
const menu = $('#mapmenu');
const closeMapMenu = () => { menu.classList.remove('on'); $('#bMap').setAttribute('aria-expanded', 'false'); };
export const mapMenuOpen = () => menu.classList.contains('on');
export { closeMapMenu };

async function showMapMenu() {
  const { maps } = await getJSON('/api/maps');
  const item = (label, fn, cls = '', hint = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem'); if (cls) b.className = cls;
    const t = document.createElement('span'); t.textContent = label; b.append(t);
    if (hint) { const s = document.createElement('small'); s.textContent = hint; b.append(s); }
    b.onclick = () => { closeMapMenu(); fn(); };
    return b;
  };
  const sep = () => document.createElement('hr');
  menu.replaceChildren(
    ...maps.map((m) => item(m.name, () => m.id !== current.id && openMap(m.id), m.id === current.id ? 'cur' : '', `${m.devices} device${m.devices === 1 ? '' : 's'}`)),
    sep(),
    item('New map…', newMap),
    item(`Duplicate "${current.name}"…`, duplicateMap),
    item('Rename…', renameMap),
    sep(),
    item('Export to file…', exportMap),
    item('Import from file…', () => $('#mapfile').click()),
    sep(),
    item(`Delete "${current.name}"…`, deleteMap, 'danger'),
  );
  const r = $('#bMap').getBoundingClientRect();
  menu.style.left = r.left + 'px'; menu.style.top = r.bottom + 4 + 'px';
  menu.classList.add('on'); $('#bMap').setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

// Asks for a name and calls create(name) until the server accepts it.
async function askName(title, value, okText, create, note = '') {
  for (;;) {
    const v = await ask(title, [{ key: 'name', label: 'Map name', value }], okText, note);
    if (!v) return null;
    value = v.name;
    const r = await create(v.name.trim());
    if (r.ok) return r;
    note = r.error;
  }
}

async function newMap() {
  const r = await askName('New map', '', 'Create', (name) => postJSON('/api/maps', { name }), 'An empty map. Credential sets are shared by all maps.');
  if (r) openMap(r.map.id);
}

async function duplicateMap() {
  await flushSave();
  const r = await askName(`Duplicate "${current.name}"`, `${current.name} copy`, 'Duplicate', (name) => postJSON('/api/maps', { name, from: current.id }));
  if (r) openMap(r.map.id);
}

async function renameMap() {
  const id = current.id;
  const r = await askName('Rename map', current.name, 'Rename', (name) => postJSON(`/api/maps/${id}`, { name }, 'PATCH').then((x) => (x.ok ? { ...x, name } : x)));
  if (r && current.id === id) setCurrent(id, r.name);
}

async function deleteMap() {
  const m = await getJSON(`/api/maps/${current.id}`);
  const n = m.nodes.length;
  if (!(await ask(`Delete "${m.name}"?`, [], 'Delete',
    `${n === 1 ? '1 device' : `${n} devices`} and the links between them will be removed. Export the map first if you may want it again.`))) return;
  const r = await fetch(`/api/maps/${m.id}`, { method: 'DELETE' }).then((x) => x.json());
  if (!r.ok) return ask('Map not deleted', [], 'OK', r.error);
  openMap(r.current);
}

/* ---------- export / import (a .json file; never contains passwords) ---------- */
async function exportMap() {
  await flushSave();
  const m = await getJSON(`/api/maps/${current.id}`);
  // Credential-set links only mean something on this machine, so they are left out.
  const data = { mapterm: 1, name: m.name, nodes: m.nodes.map(({ credId, ...d }) => d), edges: m.edges };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${m.name.replace(/[^\w.-]+/g, '_')}.mapterm.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importMap(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || !Array.isArray(data.nodes)) return ask('Not a MapTerm map', [], 'OK', `${file.name} is not a map exported from MapTerm.`);
  const suggested = String(data.name || file.name.replace(/(\.mapterm)?\.json$/i, ''));
  const r = await askName('Import map', suggested, 'Import',
    (name) => postJSON('/api/maps', { name, nodes: data.nodes, edges: data.edges || [] }),
    `${data.nodes.length} device${data.nodes.length === 1 ? '' : 's'} from ${file.name}. Devices that need passwords will ask for them, or can be given a credential set.`);
  if (r) openMap(r.map.id);
}

export async function initMaps() {
  $('#bMap').onclick = (e) => { e.stopPropagation(); mapMenuOpen() ? closeMapMenu() : showMapMenu(); };
  document.addEventListener('pointerdown', (e) => { if (mapMenuOpen() && !menu.contains(e.target) && !$('#bMap').contains(e.target)) closeMapMenu(); });
  $('#mapfile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importMap(f); };
  const { current: id } = await getJSON('/api/maps');
  await openMap(id);
}
