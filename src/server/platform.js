// Operating-system integration: native folder chooser and "show in file manager".
// The server runs on the user's own machine, so these open on their desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { expandHome } from './files.js';

let picking = false;

// The desktop app (electron/main.js) supplies its own native dialogs, which work the same on
// every OS; the command-line tools below are used when MapTerm runs with `npm start`.
let native = null;
export function useNativeDialogs(dialogs) { native = dialogs; }

// Resolves to { ok, path } | { ok: false, cancelled } | { ok: false, error }.
export function pickFolder({ purpose, start }) {
  const prompt = purpose === 'run' ? 'Choose a folder for MapTerm command results' : 'Choose a folder for MapTerm session logs';
  start = expandHome(String(start || ''));
  if (!start || !fs.existsSync(start)) start = os.homedir();
  if (native) return native.pickFolder({ title: prompt, start });
  // Candidates per platform, tried in order until one is installed. The prompt and start
  // folder reach PowerShell through environment variables, never through the script text.
  const pickers = {
    darwin: [['osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)} default location (POSIX file ${JSON.stringify(start)}))`]]],
    win32: [['powershell.exe', ['-NoProfile', '-STA', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }; "
      + "$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = $env:MAPTERM_PROMPT; SelectedPath = $env:MAPTERM_START; ShowNewFolderButton = $true }; "
      + "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"]]],
    linux: [
      ['zenity', ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${path.join(start, '/')}`]],
      ['kdialog', ['--getexistingdirectory', start, '--title', prompt]],
    ],
  };
  const candidates = pickers[process.platform] || [];
  const none = { ok: false, error: 'No folder chooser is available on this system. Type the path instead.' };
  if (!candidates.length) return Promise.resolve(none);
  if (picking) return Promise.resolve({ ok: false, error: 'A folder chooser is already open.' });
  picking = true;
  const env = { ...process.env, MAPTERM_PROMPT: prompt, MAPTERM_START: start };
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) { picking = false; return resolve(none); }
      execFile(candidates[i][0], candidates[i][1], { env, timeout: 5 * 60 * 1000, windowsHide: false }, (err, stdout) => {
        if (err && err.code === 'ENOENT') return tryNext(i + 1);
        picking = false;
        const dir = String(stdout || '').trim().replace(/(.)[\\/]$/, '$1');
        resolve(dir ? { ok: true, path: dir } : { ok: false, cancelled: true });
      });
    };
    tryNext(0);
  });
}

// Shows a folder in Finder / Explorer / the desktop's file manager.
export function openFolder(dir) {
  dir = String(dir || '');
  if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return Promise.resolve({ ok: false, error: 'Folder not found.' });
  if (native) return native.openFolder(dir);
  const opener = { darwin: 'open', win32: 'explorer.exe' }[process.platform] || 'xdg-open';
  // explorer.exe exits with 1 even when it worked, so only a missing program counts as failure.
  return new Promise((resolve) => execFile(opener, [dir], (err) => resolve(err && err.code === 'ENOENT'
    ? { ok: false, error: `No file manager is available here. The results are in ${dir}` } : { ok: true })));
}
