// Maps: each topology ("Production", "Lab", ...) is its own file, <data>/maps/<id>.json,
// holding { name, nodes, edges, logDir, runDir }. logDir (session recordings) and runDir
// ("Run commands" results) are chosen per map. The map last opened is remembered in settings.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, DEFAULT_LOG_DIR, DEFAULT_RUN_DIR, readSettings, writeSettings } from './config.js';
import { resolveDir, folderName } from './files.js';

const MAPS_DIR = path.join(DATA_DIR, 'maps');
const OLD_TOPOLOGY = path.join(DATA_DIR, 'topology.json'); // the single map of earlier versions
const FIRST_MAP_NAME = 'My network';

const isId = (id) => /^m[0-9a-f]{12}$/.test(id);
const fileOf = (id) => path.join(MAPS_DIR, `${id}.json`);
const newId = (prefix, bytes = 6) => prefix + crypto.randomBytes(bytes).toString('hex');

function read(id) {
  if (!isId(id)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    return { id, name: String(m.name || 'Untitled'), nodes: Array.isArray(m.nodes) ? m.nodes : [], edges: Array.isArray(m.edges) ? m.edges : [],
      logDir: String(m.logDir || ''), runDir: String(m.runDir || '') };
  } catch { return null; }
}

// Written to a temporary file first, so a crash mid-write never leaves a broken map.
function write({ id, name, nodes, edges, logDir = '', runDir = '' }) {
  const tmp = fileOf(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ name, logDir, runDir, nodes, edges }, null, 2));
  fs.renameSync(tmp, fileOf(id));
}

const all = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json')).map((f) => read(f.slice(0, -5))).filter(Boolean);
const nameTaken = (name, exceptId) => all().some((m) => m.id !== exceptId && m.name.toLowerCase() === name.toLowerCase());

// Copies get new device and link ids, so ids stay unique across maps (open SSH tabs are
// tied to a device id). Links whose ends are missing are dropped.
function withFreshIds(nodes, edges) {
  const ids = new Map();
  const n = nodes.filter((d) => d && d.id).map((d) => { const id = newId('n', 5); ids.set(d.id, id); return { ...d, id }; });
  const e = edges.filter((l) => l && ids.has(l.source) && ids.has(l.target))
    .map((l) => ({ ...l, id: newId('e', 5), source: ids.get(l.source), target: ids.get(l.target) }));
  return { nodes: n, edges: e };
}

// Creates the maps folder; turns an earlier version's topology.json into the first map.
export function prepareMaps() {
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  if (all().length) return;
  let old = { nodes: [], edges: [] };
  try { old = JSON.parse(fs.readFileSync(OLD_TOPOLOGY, 'utf8')); } catch { /* none: start empty */ }
  const id = newId('m');
  write({ id, name: FIRST_MAP_NAME, nodes: old.nodes || [], edges: old.edges || [] });
  writeSettings({ currentMap: id });
  if (fs.existsSync(OLD_TOPOLOGY)) fs.unlinkSync(OLD_TOPOLOGY);
}

export function listMaps() {
  const maps = all().map((m) => ({ id: m.id, name: m.name, devices: m.nodes.length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const saved = readSettings().currentMap;
  return { current: maps.some((m) => m.id === saved) ? saved : maps[0]?.id, maps };
}

// The folder a map uses for 'logDir' or 'runDir'; '' until the user has chosen one.
export const mapFolder = (id, kind) => read(id)?.[kind] || '';

// Suggested folders for a map that has none yet: a subfolder named after the map, inside the
// folder used before folders were per map (or the default).
function suggestions(m) {
  const s = readSettings();
  return { suggestLogDir: path.join(s.logDir || DEFAULT_LOG_DIR, folderName(m.name)), suggestRunDir: path.join(s.runDir || DEFAULT_RUN_DIR, folderName(m.name)) };
}

// Credential sets are shared by all maps.
export function countCredentialUse(credId) {
  return all().reduce((n, m) => n + m.nodes.filter((d) => d.credId === credId).length, 0);
}
export function forgetCredential(credId) {
  for (const m of all()) {
    if (!m.nodes.some((d) => d.credId === credId)) continue;
    write({ ...m, nodes: m.nodes.map((d) => (d.credId === credId ? { ...d, credId: '' } : d)) });
  }
}

export function mountMaps(app) {
  prepareMaps();
  const bad = (res, error) => res.json({ ok: false, error });

  app.get('/api/maps', (req, res) => res.json(listMaps()));

  // Create: empty, a copy of another map ({ from }), or an imported file ({ nodes, edges }).
  app.post('/api/maps', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return bad(res, 'Give the map a name.');
    if (nameTaken(name)) return bad(res, `There is already a map called "${name}".`);
    let nodes = [], edges = [];
    if (b.from) {
      const src = read(b.from);
      if (!src) return bad(res, 'The map to copy no longer exists.');
      ({ nodes, edges } = withFreshIds(src.nodes, src.edges));
    } else if (b.nodes || b.edges) {
      if (!Array.isArray(b.nodes) || !Array.isArray(b.edges || [])) return bad(res, 'That file is not a MapTerm map.');
      // Credential-set ids only mean something on the machine that made them.
      const known = new Set((readSettings().credentials || []).map((c) => c.id));
      ({ nodes, edges } = withFreshIds(b.nodes.map((d) => ({ ...d, credId: known.has(d.credId) ? d.credId : '' })), b.edges || []));
    }
    const id = newId('m');
    write({ id, name, nodes, edges });
    res.json({ ok: true, map: { id, name } });
  });

  app.get('/api/maps/:id', (req, res) => {
    const m = read(req.params.id);
    return m ? res.json({ ...m, ...suggestions(m) }) : res.status(404).json({ ok: false, error: 'Map not found.' });
  });

  // Save devices and links (the page sends the whole map after each change).
  app.put('/api/maps/:id', (req, res) => {
    const m = read(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'Map not found.' });
    const { nodes = [], edges = [] } = req.body || {};
    write({ ...m, nodes, edges });
    res.json({ ok: true });
  });

  // Rename, or choose the map's log / results folder. Any of: { name, logDir, runDir }.
  app.patch('/api/maps/:id', (req, res) => {
    const m = read(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'Map not found.' });
    const b = req.body || {};
    if ('name' in b) {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return bad(res, 'Give the map a name.');
      if (nameTaken(name, m.id)) return bad(res, `There is already a map called "${name}".`);
      m.name = name;
    }
    for (const kind of ['logDir', 'runDir']) {
      if (!(kind in b)) continue;
      const r = resolveDir(b[kind], suggestions(m)[kind === 'logDir' ? 'suggestLogDir' : 'suggestRunDir']);
      if (r.error) return bad(res, r.error);
      m[kind] = r.dir;
    }
    write(m);
    res.json({ ok: true, name: m.name, logDir: m.logDir, runDir: m.runDir });
  });

  app.delete('/api/maps/:id', (req, res) => {
    const maps = all();
    if (!maps.some((m) => m.id === req.params.id)) return res.status(404).json({ ok: false, error: 'Map not found.' });
    if (maps.length === 1) return bad(res, 'This is the only map; create another one first.');
    fs.unlinkSync(fileOf(req.params.id));
    res.json({ ok: true, ...listMaps() });
  });

  // Remember which map is open, for the next start.
  app.post('/api/maps/:id/open', (req, res) => {
    if (!read(req.params.id)) return res.status(404).json({ ok: false, error: 'Map not found.' });
    writeSettings({ currentMap: req.params.id });
    res.json({ ok: true });
  });
}
