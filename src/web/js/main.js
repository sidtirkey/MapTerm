// MapTerm page entry point. Modules only declare things when imported; everything that
// touches the page or registers handlers happens in their init functions, run here in order.
import { $ } from './dom.js';
import { initMap, mode, setMode } from './map.js';
import { initLinks } from './links.js';
import { initSessions, sessions, activeId } from './sessions.js';
import { isRecKey, toggleRec } from './recording.js';
import { initSettings } from './settings.js';
import { initCredentials } from './credentials.js';
import { initRun, runInProgress } from './run.js';
import { initMaps, mapMenuOpen, closeMapMenu } from './maps.js';
import { initDiscovery, discoveryOpen, closeDiscovery } from './discover.js';

// Without MapTerm's access key (see src/server/access.js) nothing else would work: explain how
// to open it properly instead.
if ((await fetch('/api/maps')).status === 401) {
  $('#signin').hidden = false;
  throw new Error('MapTerm: open it from its access link');
}

initMap();
initLinks();
initSessions();
initSettings();
initCredentials();
initRun();
initMaps();
initDiscovery();

// Closing or reloading the page would end open terminal sessions and a running command run, so
// ask first (the desktop app shows its own dialog for this; browsers show "Leave site?").
window.addEventListener('beforeunload', (e) => {
  if ([...sessions.values()].some((s) => s.status !== 'dead') || runInProgress()) { e.preventDefault(); e.returnValue = ''; }
});

// Page-wide keys: Ctrl+Shift+L toggles recording of the active tab; Escape closes the
// top-most dialog, or leaves link-drawing / device-picking mode.
document.addEventListener('keydown', (e) => {
  if (isRecKey(e) && $('#modal').style.display !== 'flex' && sessions.has(activeId)) { e.preventDefault(); toggleRec(sessions.get(activeId)); return; }
  if (e.key !== 'Escape') return;
  if ($('#modal').style.display === 'flex') $('#mCancel').click();
  else if (mapMenuOpen()) closeMapMenu();
  else if (discoveryOpen()) closeDiscovery();
  else if ($('#credmodal').style.display === 'flex') $('#credClose').click();
  else if (mode === 'link' || mode === 'pick') setMode('select');
});
