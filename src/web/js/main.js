// MapTerm page entry point. Modules only declare things when imported; everything that
// touches the page or registers handlers happens in their init functions, run here in order.
import { $ } from './dom.js';
import { initMap, mode, setMode } from './map.js';
import { initLinks } from './links.js';
import { initSessions, sessions, activeId } from './sessions.js';
import { isRecKey, toggleRec } from './recording.js';
import { initSettings } from './settings.js';
import { initCredentials } from './credentials.js';
import { initRun } from './run.js';

initMap();
initLinks();
initSessions();
initSettings();
initCredentials();
initRun();

// Page-wide keys: Ctrl+Shift+L toggles recording of the active tab; Escape closes the
// top-most dialog, or leaves link-drawing / device-picking mode.
document.addEventListener('keydown', (e) => {
  if (isRecKey(e) && $('#modal').style.display !== 'flex' && sessions.has(activeId)) { e.preventDefault(); toggleRec(sessions.get(activeId)); return; }
  if (e.key !== 'Escape') return;
  if ($('#modal').style.display === 'flex') $('#mCancel').click();
  else if ($('#credmodal').style.display === 'flex') $('#credClose').click();
  else if (mode === 'link' || mode === 'pick') setMode('select');
});
