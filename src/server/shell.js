// Opens an interactive shell on a device over SSH or Telnet, behind one interface:
//
//   const sh = openShell({ protocol, host, port, auth, cols, rows, term, algorithms });
//   sh.on('ready') · sh.on('data', buffer) · sh.on('close') · sh.on('error', err)
//   sh.write(text) · sh.resize(cols, rows) · sh.end()
//
// auth is what credentials.js resolves ({ username, password | privateKey, passphrase }), or
// null for a Telnet session the user logs into by hand.
import { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';
import { TelnetClient } from './telnet.js';
import { loginResponder } from './cli.js';

export const DEFAULT_PORT = { ssh: 22, telnet: 23 };

export function openShell(opts) {
  return opts.protocol === 'telnet' ? telnetShell(opts) : sshShell(opts);
}

function telnetShell({ host, port, auth, cols = 80, rows = 24, term = 'xterm-256color' }) {
  const sh = new EventEmitter();
  let closed = false;
  const close = () => { if (!closed) { closed = true; sh.emit('close'); } };
  if (auth?.privateKey) {
    setImmediate(() => { sh.emit('error', new Error('SSH keys cannot be used over Telnet; give this device a credential set with a password')); close(); });
    Object.assign(sh, { write() {}, resize() {}, end() {} });
    return sh;
  }
  const t = new TelnetClient({ host, port: Number(port) || DEFAULT_PORT.telnet, cols, rows, term });
  // With credentials, answer the device's Username / Password prompts.
  const login = auth && (auth.username || auth.password)
    ? loginResponder((x) => t.write(x), auth, (why) => { sh.emit('error', new Error(`Telnet login failed: ${why}`)); t.end(); })
    : null;
  t.on('connect', () => sh.emit('ready'));
  t.on('data', (buf) => { sh.emit('data', buf); if (login) login(buf.toString('latin1')); });
  t.on('error', (e) => sh.emit('error', e));
  t.on('close', close);
  Object.assign(sh, { write: (s) => t.write(s), resize: (c, r) => t.resize(c, r), end: () => t.end() });
  t.connect();
  return sh;
}

function sshShell({ host, port, auth, cols = 80, rows = 24, term = 'xterm-256color', algorithms }) {
  const sh = new EventEmitter();
  const conn = new ssh2.Client();
  let stream = null, closed = false;
  const close = () => { if (!closed) { closed = true; sh.emit('close'); } };
  conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => auth.password || '')));
  conn.on('ready', () => conn.shell({ term, cols, rows }, (err, s) => {
    if (err) { sh.emit('error', err); return conn.end(); }
    stream = s;
    sh.emit('ready');
    s.on('data', (d) => sh.emit('data', d));
    s.on('close', () => { close(); conn.end(); });
  }));
  conn.on('error', (e) => sh.emit('error', e));
  conn.on('close', close);
  Object.assign(sh, {
    write: (s) => stream && stream.write(s),
    resize: (c, r) => stream && stream.setWindow(r, c, 0, 0),
    end: () => conn.end(),
  });
  conn.connect({
    host, port: Number(port) || DEFAULT_PORT.ssh,
    username: auth.username, password: auth.password, privateKey: auth.privateKey, passphrase: auth.passphrase,
    tryKeyboard: !!auth.password, readyTimeout: 15000, keepaliveInterval: 15000, algorithms,
  });
  return sh;
}
