// Secret storage for credential sets (passwords, enable passwords, key passphrases).
//   macOS:   the login Keychain, via `security`.
//   Windows: DPAPI (encrypted for the signed-in Windows user), via the built-in PowerShell;
//            the encrypted values are kept in secrets.dpapi.json in the data folder.
//   Linux:   the Secret Service keyring (GNOME Keyring, KWallet), via `secret-tool`.
//   Otherwise, or if the keyring is unavailable: memory only, lost when MapTerm restarts.
// Secrets are passed to these tools on stdin, never as arguments (which other users could see).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const SERVICE = 'MapTerm';
const LEGACY_SERVICE = 'NetMap'; // the project's earlier name; entries found under it are moved on first use
const DPAPI_FILE = path.join(DATA_DIR, 'secrets.dpapi.json');

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let out = '', err = '';
    // detached = a new session with no controlling terminal. Without it, `security` (via
    // getpass) prompts on the terminal MapTerm was started from instead of reading stdin.
    // On Windows, detached would open a console window, and isn't needed there.
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
}

// PowerShell: base64 in -> DPAPI protect/unprotect (CurrentUser) -> base64 out. Using base64
// both ways keeps non-ASCII passwords safe from console code pages.
const ps = (body) => ['-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ${body}`];
const PROTECT = ps(`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($in, $null, 'CurrentUser'))`);
const UNPROTECT = ps(`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($in, $null, 'CurrentUser'))`);
const readBlobs = () => { try { return JSON.parse(fs.readFileSync(DPAPI_FILE, 'utf8')); } catch { return {}; } };
const writeBlobs = (b) => fs.writeFileSync(DPAPI_FILE, JSON.stringify(b, null, 2));

const backends = {
  keychain: {
    label: 'macOS Keychain',
    // Stored as "b64:<base64>": `security -w` prints any non-ASCII value as hex, so keeping
    // the stored value ASCII means it reads back exactly as written.
    async set(id, secret, name) {
      const value = 'b64:' + Buffer.from(secret, 'utf8').toString('base64');
      // With -w last, `security` reads the password (and its confirmation) from stdin.
      const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-l', `MapTerm: ${name}`, '-w'], `${value}\n${value}\n`);
      if (r.code) throw new Error(`Keychain: ${r.err.trim() || 'could not save'}`);
    },
    async get(id, service = SERVICE) {
      const r = await run('security', ['find-generic-password', '-s', service, '-a', id, '-w']);
      if (r.code) return null;
      const v = r.out.replace(/\n$/, '');
      if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
      // Values saved before the b64 format: plain text, or hex if they held non-ASCII.
      return /^([0-9a-f]{2})+$/.test(v) && !v.startsWith('{') ? Buffer.from(v, 'hex').toString('utf8') : v;
    },
    async del(id, service = SERVICE) { await run('security', ['delete-generic-password', '-s', service, '-a', id]); },
  },
  dpapi: {
    label: 'Windows account (encrypted with DPAPI)',
    async set(id, secret) {
      const r = await run('powershell.exe', PROTECT, Buffer.from(secret, 'utf8').toString('base64'));
      if (r.code || !r.out.trim()) throw new Error(`Windows DPAPI: ${r.err.trim() || 'could not encrypt'}`);
      writeBlobs({ ...readBlobs(), [id]: r.out.trim() });
    },
    async get(id) {
      const blob = readBlobs()[id];
      if (!blob) return null;
      const r = await run('powershell.exe', UNPROTECT, blob);
      return r.code ? null : Buffer.from(r.out.trim(), 'base64').toString('utf8');
    },
    async del(id) {
      const b = readBlobs();
      if (id in b) { delete b[id]; writeBlobs(b); }
    },
  },
  secretTool: {
    label: 'system keyring',
    async set(id, secret, name) {
      const r = await run('secret-tool', ['store', `--label=MapTerm: ${name}`, 'service', SERVICE, 'account', id], secret);
      if (r.code) throw new Error(`Keyring: ${r.err.trim() || 'could not save'}`);
    },
    async get(id, service = SERVICE) {
      const r = await run('secret-tool', ['lookup', 'service', service, 'account', id]);
      return r.code ? null : r.out;
    },
    async del(id, service = SERVICE) { await run('secret-tool', ['clear', 'service', service, 'account', id]); },
  },
  memory: { label: 'memory only (re-enter after MapTerm restarts)', async set() {}, async get() { return null; }, async del() {} },
};

let backend = process.platform === 'darwin' ? backends.keychain
  : process.platform === 'win32' ? backends.dpapi
  : process.platform !== 'linux' ? backends.memory
  : spawnSync('secret-tool', ['--version']).error ? backends.memory : backends.secretTool;

const cache = new Map(); // id -> secrets object, so the store is read once per run of MapTerm

const vault = {
  get label() { return backend.label; },
  get persistent() { return backend !== backends.memory; },
  async set(id, secrets, name) {
    try {
      await backend.set(id, JSON.stringify(secrets), name);
    } catch (e) {
      // A Linux machine can have secret-tool but no running keyring (servers, WSL, SSH
      // sessions). Fall back to memory rather than refusing to save anything.
      if (backend !== backends.secretTool) throw e;
      backend = backends.memory;
    }
    cache.set(id, secrets);
  },
  // name labels the entry if it has to be moved from the old service name.
  async get(id, name = id) {
    if (cache.has(id)) return cache.get(id);
    let raw = await backend.get(id);
    if (raw == null && (backend === backends.keychain || backend === backends.secretTool)) {
      raw = await backend.get(id, LEGACY_SERVICE);
      if (raw != null) {
        try { await backend.set(id, raw, name); await backend.del(id, LEGACY_SERVICE); } catch { /* keep using the old entry */ }
      }
    }
    if (raw == null) return null;
    try { const s = JSON.parse(raw); cache.set(id, s); return s; } catch { return null; }
  },
  async del(id) {
    cache.delete(id);
    await backend.del(id);
    if (backend === backends.keychain || backend === backends.secretTool) await backend.del(id, LEGACY_SERVICE);
  },
};

export default vault;
