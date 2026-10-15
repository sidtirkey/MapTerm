// Runs a list of commands on several devices and saves each device's transcript to a file.
// Commands go through one interactive shell per device, over SSH or Telnet (not one exec per
// command), so
// sequences such as "conf t" / "interface ..." / "end" keep their context. A command is
// treated as finished when the device's prompt comes back and the output goes quiet.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SessionLog } from './session-log.js';
import { stamp, safeName, openUnique } from './files.js';
import { PROMPT_END, MORE, lastLine, enabler } from './cli.js';
import { openShell } from './shell.js';

const PARALLEL = 8;              // devices worked on at once
const LOGIN_TIMEOUT = 20000;     // to reach the first prompt
const COMMAND_TIMEOUT = 60000;   // per command, for the prompt to come back
const LOGIN_SETTLE = 800;        // quiet time that confirms the first prompt (after banners)
const SETTLE = 400;              // quiet time that confirms a command has finished

// Where a device's cleaned output goes. SessionLog writes through one of these.
// One file for the whole session:
class DeviceFile {
  constructor(runDir, d, username) {
    const { file, fd } = openUnique(runDir, safeName(d.name), '.txt');
    this.name = path.basename(file);
    this.out = fs.createWriteStream(null, { fd }); this.out.on('error', () => {});
    this.out.write(`# MapTerm command run\n# Device: ${d.name} (${d.host}:${d.port || 22})  User: ${username || ''}\n# Started: ${stamp()}\n\n`);
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
    this.out.write(`# Device: ${this.d.name} (${this.d.host}:${this.d.port || 22})\n${header}# Run at: ${stamp()}\n\n`);
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
  const { runDir, commands, send, algorithms, conns } = ctx;
  const status = (state, detail = '') => send({ type: 'batch-status', id: d.id, state, detail });
  let auth = null, authError = null;
  if (!d.host) authError = 'No IP address or hostname set';
  else try { auth = await ctx.resolveCreds(d); } catch (e) { authError = e.message; }
  return new Promise((resolve) => {
    const perCommand = ctx.layout === 'command';
    const sink = perCommand ? new CommandFiles(runDir, d, commands.length) : new DeviceFile(runDir, d, auth?.username);
    const log = new SessionLog(sink);
    let sh = null, ready = false, finished = false, timer = null, settle = null, timedOut = 0;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(settle); if (sh) { conns.delete(sh); sh.end(); }
      if (error && ctx.aborted) error = 'Stopped';
      const note = error ? '' : timedOut ? `${timedOut} command(s) got no prompt back within ${COMMAND_TIMEOUT / 1000}s` : '';
      // Per-command files end with their command's output (no trailing prompt), and only
      // get a footer when something went wrong.
      if (perCommand && !error) log.discardLine();
      log.end(error ? `\n# Failed: ${error}\n` : perCommand ? '' : `\n# Finished: ${stamp()}${note ? ` (${note})` : ''}\n`);
      status(error ? 'failed' : note ? 'warn' : 'done', error || note);
      resolve({ name: d.name, file: sink.name, ok: !error, detail: error || note });
    };

    if (authError) return finish(authError);
    if (ctx.aborted) return finish('Stopped');
    status('connecting');
    // A wide terminal keeps devices from wrapping long output lines. Over Telnet the login
    // prompts are answered by the shell (see shell.js); the prompt detection below starts
    // once the device shows its command prompt.
    sh = openShell({ protocol: d.protocol === 'telnet' ? 'telnet' : 'ssh', host: d.host, port: d.port, auth, cols: 511, rows: 100, term: 'vt100', algorithms });
    conns.add(sh);
    sh.on('error', (e) => finish(e.message));
    sh.on('ready', () => {
      ready = true;
      const dec = new StringDecoder('utf8');
      let i = -1, base = null, seen = '', sincePager = '', enabling = null;
      const arm = (ms, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms); };

      const next = () => {
        if (finished) return;
        if (++i >= commands.length) return finish(null);
        status('running', `${i + 1}/${commands.length}  ${commands[i]}`);
        seen = ''; sincePager = '';
        sink.command(i, commands[i]); // the prompt line still in SessionLog's buffer lands in the new file
        sh.write(commands[i] + '\r');
        arm(COMMAND_TIMEOUT, () => {
          timedOut++;
          log.write(`\r\n# (no prompt after ${COMMAND_TIMEOUT / 1000}s; moving on)\r\n`);
          next();
        });
      };

      arm(LOGIN_TIMEOUT, () => finish('No prompt received after login'));
      sh.on('data', (chunk) => {
        const t = dec.write(chunk);
        log.write(t);
        seen = (seen + t).slice(-8192); sincePager += t;
        // Answer a pager once per appearance (the erase that follows must not trigger it again).
        if (MORE.test(lastLine(sincePager))) { sincePager = ''; sh.write(' '); return; }
        if (enabling) return enabling(t);

        clearTimeout(settle);
        const line = lastLine(seen);
        if (base === null) {
          if (PROMPT_END.test(line)) settle = setTimeout(() => {
            // "R1#" -> "R1", "nmcore11:~$" -> "nmcore11"; config modes like "R1(config)#" still match.
            base = line.replace(PROMPT_END, '').split(/[(:\s]/)[0];
            if (!(auth.enable && line.endsWith('>'))) return next();
            // At a ">" prompt with an enable password saved: enter enable mode first.
            clearTimeout(timer);
            status('running', 'enable');
            enabling = enabler((x) => sh.write(x), auth.enable, (ok, why) => {
              enabling = null;
              if (!ok) return finish(`Could not enter enable mode: ${why}`);
              next();
            });
          }, LOGIN_SETTLE);
        } else if (seen.includes('\n') && PROMPT_END.test(line) && line.startsWith(base)) {
          settle = setTimeout(next, SETTLE);
        }
      });
      // A last command such as "exit" may end the session on purpose.
      sh.on('close', () => finish(i >= commands.length - 1 && base !== null ? null : 'Session closed by the device'));
    });
    sh.on('close', () => { if (!ready) finish('Connection closed before the commands finished'); });
  });
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

  const ctx = { runDir, commands, layout: layout === 'command' ? 'command' : 'device', send, algorithms, resolveCreds, conns: new Set(), aborted: false };
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
    abort() { ctx.aborted = true; ctx.conns.forEach((c) => c.end()); if (waiting) waiting(false); },
    resume() { if (waiting) waiting(true); },
  };
}
