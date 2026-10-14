// Small file and path helpers shared by session logs and command runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
// Local time, e.g. stamp(d) -> "2026-10-15 01:41:00", stamp(d, '-', '_') -> "2026-10-15_01-41-00" (for file names).
export const stamp = (d = new Date(), sep = ':', mid = ' ') =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${mid}${pad(d.getHours())}${sep}${pad(d.getMinutes())}${sep}${pad(d.getSeconds())}`;
// A name usable as a file or folder name on macOS, Linux and Windows. Windows also refuses
// names like CON or NUL, and names ending in a dot or space.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function safeName(name, fallback = 'device') {
  let s = String(name || '').replace(/[^\w.-]+/g, '_').slice(0, 60).replace(/^\.+|\.+$/g, '');
  if (WINDOWS_RESERVED.test(s)) s = '_' + s;
  return s || fallback;
}
// "~/x" or "~\x" -> the user's home folder (people type both on Windows).
export const expandHome = (p) => (p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);

// Create a file that does not exist yet (two devices can share a name).
export function openUnique(dir, base, ext) {
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${base}${i > 1 ? '-' + i : ''}${ext}`);
    try { return { file, fd: fs.openSync(file, 'wx') }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

// A new log file such as "R1_2026-10-15_01-41-00.log" (with -2, -3 ... if that exists).
export function newLogFile(dir, name) {
  return openUnique(dir, `${safeName(name)}_${stamp(new Date(), '-', '_')}`, '.log');
}
