// MapTerm desktop app: runs the MapTerm server inside Electron and shows the page in a window.
// `npm run app` starts it from source; `npm run dist` builds installers (see package.json "build").
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { DATA_DIR, prepareDataDir } from '../src/server/config.js';
import { createServer } from '../src/server/app.js';
import { useNativeDialogs } from '../src/server/platform.js';

// A fixed port keeps the page's address, and so what it remembers between visits, the same
// on every launch. If something else is using it, any free port is used instead.
const PREFERRED_PORT = 47321;

// Keep Chromium's own files (cache, local storage) in a subfolder, away from MapTerm's data.
app.setPath('userData', path.join(DATA_DIR, 'window'));

let win = null, origin = null;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
}

async function startServer() {
  prepareDataDir();
  // Electron's dialogs behave the same on every OS (no zenity / osascript / PowerShell needed).
  useNativeDialogs({
    async pickFolder({ title, start }) {
      const r = await dialog.showOpenDialog(win, { title, defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths.length ? { ok: false, cancelled: true } : { ok: true, path: r.filePaths[0] };
    },
    async openFolder(dir) {
      const error = await shell.openPath(dir);
      return error ? { ok: false, error } : { ok: true };
    },
  });
  try {
    return await listen(createServer(), PREFERRED_PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    return listen(createServer(), 0);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    title: 'MapTerm', backgroundColor: '#eef1f4', show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(origin + '/');

  // The window only ever shows MapTerm; links to other sites open in the default browser.
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) { e.preventDefault(); external(url); } });

  // The page asks before unloading while SSH sessions or a command run are active.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Disconnect', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Disconnect open sessions?',
      detail: 'Closing or reloading MapTerm ends open SSH sessions and stops a running command run.',
    });
    if (choice === 0) e.preventDefault(); // unload anyway
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // MapTerm is already running; that copy brings its window forward
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    try {
      origin = `http://127.0.0.1:${await startServer()}`;
    } catch (e) {
      dialog.showErrorBox('MapTerm could not start', e.message);
      return app.quit();
    }
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); }); // macOS: dock icon reopens the window
  });

  // SSH sessions live in the window, so closing it quits MapTerm (on macOS too).
  app.on('window-all-closed', () => app.quit());
}
