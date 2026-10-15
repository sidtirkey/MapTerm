// Folders chosen per map (session logs; "Run commands" results are chosen in its form) and
// the native folder chooser.
import { $, getJSON, postJSON } from './dom.js';
import { ask } from './dialog.js';
import { currentMapId } from './maps.js';

export const pickFolder = (start, purpose) => postJSON('/api/pick-folder', { start, purpose });

// Asks for a map's session-log folder until a usable one is saved. Resolves to the folder, or null.
export async function askLogDir(mapId, note = 'Each map keeps its session recordings in its own folder.') {
  const m = await getJSON(`/api/maps/${mapId}`);
  for (let value = m.logDir || m.suggestLogDir;;) {
    const v = await ask(`Log folder for "${m.name}"`, [{ key: 'logDir', label: 'Save session recordings in', value, browse: (x) => pickFolder(x, 'log') }], 'Save', note);
    if (!v) return null;
    value = v.logDir;
    const r = await postJSON(`/api/maps/${mapId}`, { logDir: v.logDir }, 'PATCH');
    if (r.ok) return r.logDir;
    note = r.error;
  }
}

export function initSettings() {
  $('#bLogs').onclick = () => askLogDir(currentMapId());
}
