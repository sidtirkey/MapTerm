// Drives one device's command line: connect (SSH or Telnet), log in, enter enable mode, then
// run commands one after another in the same session (so "conf t" / "interface …" / "end"
// keep their context). A command counts as finished when the device's prompt comes back and
// the output goes quiet; pagers (--More--) are answered along the way. Used by "Run commands"
// (batch.js) and neighbor discovery.
//
//   const job = runCommands({ device, auth, commands, algorithms }, hooks);
//   await job.done   -> { error, timedOut, outputs }   (error is '' on success; outputs[i] is
//                       command i's output as clean text, without the echoed command or prompt)
//   job.stop()       -> ends the session; done then resolves with error 'Stopped'
//
// hooks (all optional): onStatus(state, detail) · onData(text) raw output as it arrives ·
//   onCommand(i, command) just before command i is sent · onTimeout(i) command i got no prompt
import { StringDecoder } from 'node:string_decoder';
import { SessionLog } from './session-log.js';
import { PROMPT_END, MORE, lastLine, enabler } from './cli.js';
import { openShell } from './shell.js';

export const LOGIN_TIMEOUT = 20000;     // to reach the first prompt
export const COMMAND_TIMEOUT = 60000;   // per command, for the prompt to come back
const LOGIN_SETTLE = 800;               // quiet time that confirms the first prompt (after banners)
const SETTLE = 400;                     // quiet time that confirms a command has finished
const WAKE_AFTER = 1500;                // Telnet: quiet time without a prompt before pressing Enter
const WAKE_TRIES = 2;                   // (console-server lines often show nothing until Enter)

// Collects one command's output as clean text.
class OutputCapture {
  constructor(command) {
    this.command = command; this.text = '';
    this.log = new SessionLog({ write: (s) => { this.text += s; }, end: () => {} });
  }
  write(t) { this.log.write(t); }
  // Drops the prompt that ended the output, and the echoed command line it started with.
  finish() {
    this.log.discardLine(); this.log.end('');
    const lines = this.text.split('\n');
    if (lines[0].trim().endsWith(this.command.trim())) lines.shift();
    return lines.join('\n').replace(/\n+$/, '');
  }
}

export function runCommands({ device: d, auth, commands, algorithms }, hooks = {}) {
  const { onStatus = () => {}, onData = () => {}, onCommand = () => {}, onTimeout = () => {} } = hooks;
  const telnet = d.protocol === 'telnet';
  const outputs = [];
  let sh = null, ready = false, finished = false, timer = null, settle = null, wake = null, timedOut = 0, capture = null;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearTimeout(settle); clearTimeout(wake);
    if (capture) { outputs.push(capture.finish()); capture = null; }
    if (sh) sh.end();
    resolveDone({ error: error || '', timedOut, outputs });
  };

  onStatus('connecting');
  // A wide terminal keeps devices from wrapping long output lines. Over Telnet the login
  // prompts are answered by the shell (see shell.js); the prompt detection below starts
  // once the device shows its command prompt.
  sh = openShell({ protocol: telnet ? 'telnet' : 'ssh', host: d.host, port: d.port, auth, cols: 511, rows: 100, term: 'vt100', algorithms });
  sh.on('error', (e) => finish(e.message));
  sh.on('ready', () => {
    ready = true;
    const dec = new StringDecoder('utf8');
    let i = -1, base = null, seen = '', sincePager = '', enabling = null, wakes = 0;
    const arm = (ms, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
    // Telnet: until a prompt shows, press Enter after a quiet spell (console-server lines
    // and "Press RETURN to get started" screens wait for a key).
    const nudge = () => {
      clearTimeout(wake);
      if (telnet && base === null && wakes < WAKE_TRIES) wake = setTimeout(() => { wakes++; sh.write('\r'); }, WAKE_AFTER);
    };
    nudge();

    const next = () => {
      if (finished) return;
      if (capture) { outputs.push(capture.finish()); capture = null; }
      if (++i >= commands.length) return finish(null);
      onStatus('running', `${i + 1}/${commands.length}  ${commands[i]}`);
      seen = ''; sincePager = '';
      onCommand(i, commands[i]);
      capture = new OutputCapture(commands[i]);
      sh.write(commands[i] + '\r');
      arm(COMMAND_TIMEOUT, () => { timedOut++; onTimeout(i); next(); });
    };

    arm(LOGIN_TIMEOUT, () => finish('No prompt received after login'));
    sh.on('data', (chunk) => {
      const t = dec.write(chunk);
      onData(t);
      if (capture) capture.write(t);
      nudge();
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
          if (!(auth?.enable && line.endsWith('>'))) return next();
          // At a ">" prompt with an enable password saved: enter enable mode first.
          clearTimeout(timer);
          onStatus('running', 'enable');
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

  return { done, stop: () => finish('Stopped') };
}
