// Where MapTerm listens, where it keeps its data, and its saved settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from './files.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WEB_DIR = path.join(ROOT, 'src/web');
export const NODE_MODULES = path.join(ROOT, 'node_modules');

export const PORT = Number(process.env.PORT) || 3000;
// Passwords pass through this server, so it only listens on this machine unless told otherwise.
export const BIND = process.env.BIND || '127.0.0.1';

// Per-user data (topology, settings, Windows secrets), outside the source tree:
//   macOS   ~/Library/Application Support/MapTerm
//   Windows %APPDATA%\MapTerm
//   Linux   $XDG_CONFIG_HOME/mapterm (usually ~/.config/mapterm)
// MAPTERM_DATA_DIR overrides it.
function defaultDataDir() {
  if (process.env.MAPTERM_DATA_DIR) return path.resolve(expandHome(process.env.MAPTERM_DATA_DIR));
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'MapTerm');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'MapTerm');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mapterm');
}
export const DATA_DIR = defaultDataDir();
export const TOPOLOGY_FILE = path.join(DATA_DIR, 'topology.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_LOG_DIR = path.join(os.homedir(), 'MapTerm Logs');
export const DEFAULT_RUN_DIR = path.join(os.homedir(), 'MapTerm Results');

// Creates the data folder, and moves in data files that earlier versions kept next to the code.
export function prepareDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const moved = [];
  for (const name of ['topology.json', 'settings.json', 'secrets.dpapi.json']) {
    const from = path.join(ROOT, name), to = path.join(DATA_DIR, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.copyFileSync(from, to); // copy + delete also works across drives
    fs.unlinkSync(from);
    moved.push(name);
  }
  return moved;
}

export const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } };
export const writeSettings = (patch) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), ...patch }, null, 2));

// Older network gear often only offers legacy SSH algorithms; they are appended as fallbacks.
export const SSH_ALGORITHMS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
};
