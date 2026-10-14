// Settings kept by the server (log and results folders) and the folder chooser.
import { $, getJSON, postJSON } from './dom.js';
import { ask } from './dialog.js';

export const settings = {};

export const pickFolder = (start, purpose) => postJSON('/api/pick-folder', { start, purpose });

// Asks for the session-log folder until a usable one is saved. Resolves to true if saved.
export async function askLogDir(note = '') {
  for (let value = settings.logDir || settings.defaultLogDir || '';;) {
    const v = await ask('Log folder', [{ key: 'logDir', label: 'Save session logs in', value, browse: pickFolder }], 'Save', note);
    if (!v) return false;
    value = v.logDir;
    const r = await postJSON('/api/settings', { logDir: v.logDir }, 'PUT');
    if (r.ok) { settings.logDir = r.logDir; return true; }
    note = r.error;
  }
}

export function initSettings() {
  getJSON('/api/settings').then((v) => Object.assign(settings, v)).catch(() => {});
  $('#bLogs').onclick = () => askLogDir();
}
