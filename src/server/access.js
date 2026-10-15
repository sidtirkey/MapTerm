// Access key: only MapTerm's own page may use its API and WebSocket, not other programs or
// other users on this computer (which could otherwise open sessions with the saved credentials).
//
// The key is random, kept in <data>/access.key (readable by this user only) and given to the
// browser once, through the link MapTerm prints at start-up (…/?token=<key>; the desktop app
// opens it itself). The browser then holds it in an HttpOnly, SameSite=Strict cookie, so page
// scripts can't read it and other sites can't send it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const KEY_FILE = path.join(DATA_DIR, 'access.key');

export function accessKey() {
  try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (k.length >= 32) return k; } catch { /* make one */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const k = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 });
  return k;
}

// One cookie per port, so the browser version and the desktop app don't overwrite each other.
const cookieName = (req) => `mapterm-${req.socket.localPort}`;

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Compares in constant time, so the key can't be guessed from response timings.
export function keyMatches(given, key) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const hasAccess = (req, key) => keyMatches(cookies(req)[cookieName(req)], key);

export function grantAccess(req, res, key) {
  res.setHeader('Set-Cookie', `${cookieName(req)}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
}
