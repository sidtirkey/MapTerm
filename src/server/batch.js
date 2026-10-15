// "Run commands": runs a list of commands on several devices (several at once) and saves each
// device's transcript, one file per device or one file per command, plus a summary. Talking to
// each device (login, enable, prompts, pagers) is done by device-session.js.
import fs from 'node:fs';
import path from 'node:path';
import { SessionLog } from './session-log.js';
import { stamp, safeName, openUnique } from './files.js';
import { DEFAULT_PORT } from './shell.js';
import { runCommands, COMMAND_TIMEOUT } from './device-session.js';

const PARALLEL = 8; // devices worked on at once

const isTelnet = (d) => d.protocol === 'telnet';
const portOf = (d) => d.port || DEFAULT_PORT[isTelnet(d) ? 'telnet' : 'ssh'];

// Where a device's cleaned output goes. SessionLog writes through one of these.
// One file for the whole session:
class DeviceFile {
  constructor(runDir, d, username) {
    const { file, fd } = openUnique(runDir, safeName(d.name), '.txt');
    this.name = path.basename(file);
    this.out = fs.createWriteStream(null, { fd }); this.out.on('error', () => {});
    this.out.write(`# MapTerm command run\n# Device: ${d.name} (${d.host}:${portOf(d)})  User: ${username || ''}\n# Started: ${stamp()}\n\n`);
  }
  command() {}
  write(s) { this.out.write(s); }
  end(footer) { this.out.end(footer); }
}
// A folder per device with one numbered file per command, e.g. "R1/02_show_ip_int_br.txt".
// Each file runs from the prompt + command line to just before the next prompt; the
// login banner is not kept.
class CommandFiles {
  constructor(runDir, d, total) {
    for (let i = 1; ; i++) {
      this.dir = path.join(runDir, safeName(d.name) + (i > 1 ? '-' + i : ''));
      try { fs.mkdirSync(this.dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.name = path.basename(this.dir) + '/';
    this.d = d; this.width = Math.max(2, String(total).length); this.out = null;
  }
  open(base, header) {
    if (this.out) this.out.end();
    const { fd } = openUnique(this.dir, base, '.txt');
    this.out = fs.createWriteStream(null, { fd }); this.out.on('error', () => {});
    this.out.write(`# Device: ${this.d.name} (${this.d.host}:${portOf(this.d)})\n${header}# Run at: ${stamp()}\n\n`);
  }
  command(i, cmd) { this.open(`${String(i + 1).padStart(this.width, '0')}_${safeName(cmd, 'command')}`, `# Command: ${cmd}\n`); }
  write(s) { if (this.out) this.out.write(s); }
  end(footer) {
    if (!footer) return this.out && this.out.end();
    if (!this.out) this.open('error', ''); // failed before the first command
    this.out.end(footer);
  }
}

async function runDevice(d, ctx) {
  const { runDir, commands, send, algorithms } = ctx;
  const status = (state, detail = '') => send({ type: 'batch-status', id: d.id, state, detail });
  let auth = null, authError = null;
  if (!d.host) authError = 'No IP address or hostname set';
  // Telnet devices may have no login (e.g. console-server ports). If one asks for a login
  // anyway, the shell reports it at once.
  else if (isTelnet(d) && !d.credId && !d.username && !d.password) auth = {};
  else try { auth = await ctx.resolveCreds(d); } catch (e) { authError = e.message; }

  const perCommand = ctx.layout === 'command';
  const sink = perCommand ? new CommandFiles(runDir, d, commands.length) : new DeviceFile(runDir, d, auth?.username);
  const log = new SessionLog(sink);

  let result;
  if (authError) result = { error: authError, timedOut: 0 };
  else if (ctx.aborted) result = { error: 'Stopped', timedOut: 0 };
  else {
    const job = runCommands({ device: d, auth, commands, algorithms }, {
      onStatus: status,
      onData: (t) => log.write(t),
      onCommand: (i, cmd) => sink.command(i, cmd), // the prompt line still in SessionLog's buffer lands in the new file
      onTimeout: () => log.write(`\r\n# (no prompt after ${COMMAND_TIMEOUT / 1000}s; moving on)\r\n`),
    });
    ctx.jobs.add(job);
    result = await job.done;
    ctx.jobs.delete(job);
  }

  const error = result.error && ctx.aborted ? 'Stopped' : result.error;
  const note = error ? '' : result.timedOut ? `${result.timedOut} command(s) got no prompt back within ${COMMAND_TIMEOUT / 1000}s` : '';
  // Per-command files end with their command's output (no trailing prompt), and only
  // get a footer when something went wrong.
  if (perCommand && !error) log.discardLine();
  log.end(error ? `\n# Failed: ${error}\n` : perCommand ? '' : `\n# Finished: ${stamp()}${note ? ` (${note})` : ''}\n`);
  status(error ? 'failed' : note ? 'warn' : 'done', error || note);
  return { name: d.name, file: sink.name, ok: !error, detail: error || note };
}

// With canary set, the first device runs alone; the run then pauses ("batch-paused") until
// the client sends resume() (continue with the rest) or abort().
export function runBatch({ dir, devices, commands, layout, canary }, { send, algorithms, resolveCreds }) {
  devices = Array.isArray(devices) ? devices : [];
  commands = (Array.isArray(commands) ? commands : []).map((c) => String(c).trimEnd()).filter(Boolean);
  const none = { abort() {}, resume() {} };
  if (!devices.length || !commands.length) { send({ type: 'batch-error', message: 'Choose at least one device and one command.' }); return none; }

  let runDir;
  try {
    const base = path.join(dir, `run_${stamp(new Date(), '-', '_')}`);
    for (let i = 1; ; i++) { runDir = base + (i > 1 ? '-' + i : ''); if (!fs.existsSync(runDir)) break; }
    fs.mkdirSync(runDir, { recursive: true });
  } catch (e) { send({ type: 'batch-error', message: e.message }); return none; }

  const ctx = { runDir, commands, layout: layout === 'command' ? 'command' : 'device', send, algorithms, resolveCreds, jobs: new Set(), aborted: false };
  const started = new Date(), queue = devices.map((d, i) => [d, i]), results = [];
  let waiting = null; // resolves the pause after the first device: true = continue, false = stop
  send({ type: 'batch-started', dir: runDir, canary: !!canary && devices.length > 1 });

  const worker = async () => {
    while (queue.length) {
      const [d, i] = queue.shift(); // results keep the order the devices were given in
      if (ctx.aborted) { send({ type: 'batch-status', id: d.id, state: 'failed', detail: 'Stopped' }); results[i] = { name: d.name, ok: false, detail: 'Stopped' }; continue; }
      results[i] = await runDevice(d, ctx);
    }
  };
  (async () => {
    if (canary && devices.length > 1) {
      const [d] = queue.shift();
      const r = results[0] = await runDevice(d, ctx);
      if (!ctx.aborted) {
        send({ type: 'batch-paused', name: d.name, ok: r.ok, detail: r.detail, file: r.file, remaining: queue.length });
        if (!(await new Promise((go) => (waiting = go)))) ctx.aborted = true;
        waiting = null;
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  })().then(() => {
    const w = Math.max(...results.map((r) => r.name.length), 6);
    const lines = results.map((r) => `${r.name.padEnd(w)}  ${r.ok ? 'OK    ' : 'FAILED'}  ${r.file || '-'}${r.detail ? '  ' + r.detail : ''}`);
    fs.writeFileSync(path.join(runDir, 'summary.txt'),
      `# MapTerm command run\n# Started: ${stamp(started)}  Finished: ${stamp()}\n\n# Commands\n${commands.map((c) => '  ' + c).join('\n')}\n\n# Results\n${lines.join('\n')}\n`);
    send({ type: 'batch-done', dir: runDir, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });

  return {
    abort() { ctx.aborted = true; ctx.jobs.forEach((j) => j.stop()); if (waiting) waiting(false); },
    resume() { if (waiting) waiting(true); },
  };
}
