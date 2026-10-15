// The /ssh WebSocket: one connection per terminal tab (SSH or Telnet, with optional
// recording) or per command run.
//
// Messages from the page:
//   connect { protocol: 'ssh' | 'telnet', host, port, cols, rows, credId | username+password+enable }
//     (Telnet without credentials: the user logs in by hand in the terminal)
//   data { data } · resize { cols, rows } · log-start { mapId, name, seed, seedCol } · log-stop
//   batch { mapId, devices, commands, layout, canary } · batch-continue · batch-stop
// Messages to the page:
//   ready · data · closed · error · notice · log · log-error (needFolder: the map has no log folder yet)
//   batch-started · batch-status · batch-paused · batch-done · batch-error
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import { SSH_ALGORITHMS } from './config.js';
import { mapFolder } from './maps.js';
import { SessionLog } from './session-log.js';
import { stamp, newLogFile } from './files.js';
import { enabler, firstPrompt } from './cli.js';
import { runBatch } from './batch.js';
import { openShell, DEFAULT_PORT } from './shell.js';

export function attachTerminalServer(server, { resolveCreds }) {
  const wss = new WebSocketServer({
    server,
    path: '/ssh',
    // Block pages from other origins from opening SSH sessions through this server.
    verifyClient: ({ origin, req }) => {
      if (!origin) return true;
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    },
  });
  wss.on('connection', (ws) => handleConnection(ws, resolveCreds));
  return wss;
}

function handleConnection(ws, resolveCreds) {
  let shell = null, live = false, target = null, log = null, batch = null;
  const dec = new StringDecoder('utf8');
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  const startLog = (m) => {
    const dir = mapFolder(m.mapId, 'logDir');
    if (!dir) return send({ type: 'log-error', needFolder: true, message: 'Choose a log folder for this map first.' });
    try {
      fs.mkdirSync(dir, { recursive: true });
      const { file, fd } = newLogFile(dir, m.name);
      const out = fs.createWriteStream(null, { fd });
      out.on('error', (e) => { if (log && log.file === file) log = null; send({ type: 'log-error', message: e.message }); });
      out.write(`# MapTerm session log\n# Device: ${m.name || ''} (${target.host}:${target.port})  User: ${target.username}\n`
        + `# Started: ${stamp(new Date())}\n\n`);
      log = new SessionLog(out); log.file = file;
      log.seed(String(m.seed || ''), Number(m.seedCol) || 0);
      send({ type: 'log', on: true, file });
    } catch (e) { send({ type: 'log-error', message: e.message }); }
  };
  const stopLog = () => {
    if (!log) return;
    const l = log; log = null;
    l.end(`\n# Stopped: ${stamp(new Date())}\n`);
    send({ type: 'log', on: false, file: l.file });
  };

  const connect = async (m) => {
    const protocol = m.protocol === 'telnet' ? 'telnet' : 'ssh';
    let auth = null;
    try {
      // Telnet may connect without saved credentials; the user then logs in in the terminal.
      if (protocol === 'ssh' || m.credId || m.username) auth = await resolveCreds(m);
    } catch (e) { send({ type: 'error', message: e.message }); return ws.close(); }

    const port = Number(m.port) || DEFAULT_PORT[protocol];
    target = { host: m.host, port, username: auth?.username || '(typed in the terminal)' };
    shell = openShell({ protocol, host: m.host, port, auth, cols: m.cols || 80, rows: m.rows || 24, algorithms: SSH_ALGORITHMS });
    // With an enable password saved: at a ">" prompt after login, enter enable mode for the user.
    let watch = auth?.enable ? firstPrompt((line) => {
      watch = null;
      if (!line || !line.endsWith('>')) return;
      watch = enabler((x) => shell.write(x), auth.enable, (ok, why) => {
        watch = null;
        send({ type: 'notice', level: ok ? 'info' : 'warn', message: ok ? 'Entered enable mode' : `Could not enter enable mode: ${why}` });
      });
    }, 800, 30000) : null;
    // Telnet: a console-server line often shows nothing until a key is pressed; if the device
    // stays silent after connecting, press Enter once so the user sees where they are.
    let wake = null, heard = false;
    shell.on('ready', () => {
      live = true; send({ type: 'ready' });
      if (protocol === 'telnet') wake = setTimeout(() => { if (!heard) shell.write('\r'); }, 1500);
    });
    shell.on('data', (d) => {
      heard = true;
      const t = dec.write(d);
      if (watch) watch(t);
      if (log) log.write(t);
      send({ type: 'data', data: t });
    });
    shell.on('error', (e) => { stopLog(); send({ type: 'error', message: e.message }); ws.close(); });
    shell.on('close', () => { clearTimeout(wake); if (watch && watch.cancel) watch.cancel(); stopLog(); send({ type: 'closed' }); ws.close(); });
  };

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'batch' && !shell && !batch) {
      const dir = mapFolder(m.mapId, 'runDir');
      if (!dir) return send({ type: 'batch-error', message: 'Choose a results folder for this map first.' });
      batch = runBatch({ dir, devices: m.devices, commands: m.commands, layout: m.layout, canary: !!m.canary },
        { send, algorithms: SSH_ALGORITHMS, resolveCreds });
    } else if (m.type === 'batch-stop' && batch) {
      batch.abort();
    } else if (m.type === 'batch-continue' && batch) {
      batch.resume();
    } else if (m.type === 'connect' && !shell && !batch) {
      connect(m);
    } else if (m.type === 'data' && live) {
      shell.write(m.data);
    } else if (m.type === 'resize' && live) {
      shell.resize(m.cols, m.rows);
    } else if (m.type === 'log-start' && live && !log) {
      startLog(m);
    } else if (m.type === 'log-stop') {
      stopLog();
    }
  });

  ws.on('close', () => { stopLog(); if (shell) shell.end(); if (batch) batch.abort(); });
}
