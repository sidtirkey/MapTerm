// HTTP API used by the page: topology, settings (log and results folders) and folder helpers.
// Credential sets have their own routes in credentials.js.
import fs from 'node:fs';
import path from 'node:path';
import { TOPOLOGY_FILE, DEFAULT_LOG_DIR, DEFAULT_RUN_DIR, readSettings, writeSettings } from './config.js';
import { expandHome } from './files.js';
import { pickFolder, openFolder } from './platform.js';

// A folder the user typed or picked: must be absolute, is created if needed, must be writable.
function resolveDir(input, example) {
  let dir = expandHome(String(input || '').trim());
  if (!dir || !path.isAbsolute(dir)) return { error: `Enter a full folder path, e.g. ${example}` };
  dir = path.resolve(dir);
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
  catch (e) { return { error: `Can't write to ${dir} (${e.code || e.message})` }; }
  return { dir };
}

export function mountApi(app) {
  // Topology is saved without credentials.
  app.get('/api/topology', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(TOPOLOGY_FILE, 'utf8'))); }
    catch { res.json({ nodes: [], edges: [] }); }
  });
  app.put('/api/topology', (req, res) => {
    const { nodes = [], edges = [] } = req.body || {};
    fs.writeFileSync(TOPOLOGY_FILE, JSON.stringify({ nodes, edges }, null, 2));
    res.json({ ok: true });
  });

  app.get('/api/settings', (req, res) => res.json({ ...readSettings(), defaultLogDir: DEFAULT_LOG_DIR, defaultRunDir: DEFAULT_RUN_DIR }));
  app.put('/api/settings', (req, res) => {
    const key = ['logDir', 'runDir'].find((k) => k in (req.body || {}));
    if (!key) return res.json({ ok: false, error: 'Nothing to save.' });
    const r = resolveDir(req.body[key], key === 'runDir' ? DEFAULT_RUN_DIR : DEFAULT_LOG_DIR);
    if (r.error) return res.json({ ok: false, error: r.error });
    writeSettings({ [key]: r.dir });
    res.json({ ok: true, [key]: r.dir });
  });

  app.post('/api/pick-folder', async (req, res) => res.json(await pickFolder(req.body || {})));
  app.post('/api/open-folder', async (req, res) => res.json(await openFolder(req.body?.path)));
}
