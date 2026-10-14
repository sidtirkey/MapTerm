// The /ssh WebSocket: one connection per SSH tab (with optional recording) or per command run.
//
// Messages from the page:
//   connect { host, port, cols, rows, credId | username+password+enable }
//   data { data } · resize { cols, rows } · log-start { name, seed, seedCol } · log-stop
//   batch { devices, commands, layout, canary } · batch-continue · batch-stop
// Messages to the page:
//   ready · data · closed · error · notice · log · log-error
//   batch-started · batch-status · batch-paused · batch-done · batch-error
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import ssh2 from 'ssh2';
import { SSH_ALGORITHMS, readSettings } from './config.js';
import { SessionLog } from './session-log.js';
import { stamp, newLogFile } from './files.js';
import { enabler, firstPrompt } from './cli.js';
import { runBatch } from './batch.js';

const { Client } = ssh2;

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
  let conn = null, stream = null, target = null, log = null, batch = null;
  const dec = new StringDecoder('utf8');
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  const startLog = (m) => {
    const dir = readSettings().logDir;
    if (!dir) return send({ type: 'log-error', message: 'Choose a log folder first.' });
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

  const connect = (m) => {
    conn = new Client();
    resolveCreds(m).then((auth) => {
      conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => auth.password || '')));
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: m.cols || 80, rows: m.rows || 24 }, (err, s) => {
          if (err) { send({ type: 'error', message: err.message }); return ws.close(); }
          stream = s;
          send({ type: 'ready' });
          // With an enable password saved: at a ">" login prompt, enter enable mode for the user.
          let watch = auth.enable ? firstPrompt((line) => {
            watch = null;
            if (!line || !line.endsWith('>')) return;
            watch = enabler((x) => s.write(x), auth.enable, (ok, why) => {
              watch = null;
              send({ type: 'notice', level: ok ? 'info' : 'warn', message: ok ? 'Entered enable mode' : `Could not enter enable mode: ${why}` });
            });
          }) : null;
          s.on('data', (d) => {
            const t = dec.write(d);
            if (watch) watch(t);
            if (log) log.write(t);
            send({ type: 'data', data: t });
          });
          s.on('close', () => { if (watch && watch.cancel) watch.cancel(); stopLog(); send({ type: 'closed' }); ws.close(); });
        });
      });
      conn.on('error', (e) => { stopLog(); send({ type: 'error', message: e.message }); ws.close(); });
      target = { host: m.host, port: Number(m.port) || 22, username: auth.username };
      conn.connect({
        host: m.host, port: Number(m.port) || 22,
        username: auth.username, password: auth.password, privateKey: auth.privateKey, passphrase: auth.passphrase,
        tryKeyboard: !!auth.password, readyTimeout: 15000, keepaliveInterval: 15000,
        algorithms: SSH_ALGORITHMS,
      });
    }, (e) => { send({ type: 'error', message: e.message }); ws.close(); });
  };

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'batch' && !conn && !batch) {
      const dir = readSettings().runDir;
      if (!dir) return send({ type: 'batch-error', message: 'Choose a results folder first.' });
      batch = runBatch({ dir, devices: m.devices, commands: m.commands, layout: m.layout, canary: !!m.canary },
        { send, algorithms: SSH_ALGORITHMS, resolveCreds });
    } else if (m.type === 'batch-stop' && batch) {
      batch.abort();
    } else if (m.type === 'batch-continue' && batch) {
      batch.resume();
    } else if (m.type === 'connect' && !conn && !batch) {
      connect(m);
    } else if (m.type === 'data' && stream) {
      stream.write(m.data);
    } else if (m.type === 'resize' && stream) {
      stream.setWindow(m.rows, m.cols, 0, 0);
    } else if (m.type === 'log-start' && conn && !log) {
      startLog(m);
    } else if (m.type === 'log-stop') {
      stopLog();
    }
  });

  ws.on('close', () => { stopLog(); if (conn) conn.end(); if (batch) batch.abort(); });
}
