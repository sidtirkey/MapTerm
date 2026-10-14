// Reading a device's command line from its raw output: prompts, pagers and enable mode.

export const PROMPT_END = /[>#$%\]]$/;
// Pagers: "--More--", " --More-- ", "---(more 45%)---", "  ---- More ----", "<--- More --->", "Press any key to continue"
export const MORE = /(-+ ?\(?more\b.*?-+>?|press any key to continue.*)$/i;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// The last line of raw output roughly as it looks on screen; enough to spot a prompt or pager.
export function lastLine(raw) {
  let l = raw.replace(ANSI, '');
  l = l.slice(l.lastIndexOf('\n') + 1);
  const parts = l.split('\r').filter((p) => p.trim());
  l = parts.length ? parts[parts.length - 1] : '';
  while (/[^\x08]\x08/.test(l)) l = l.replace(/[^\x08]\x08/, '');
  return l.replace(/\x08/g, '').trim();
}

const ENABLE_TIMEOUT = 15000;
const ENABLE_SETTLE = 400;

// Enters privileged mode from a ">" prompt: sends "enable", answers the password prompt
// once, and reports whether a "#" prompt followed. Call it when the device is sitting at
// its ">" prompt; feed it every piece of output after that. done(ok, reason) is called once.
// The password is never echoed by the device, so it does not reach logs or the screen.
export function enabler(write, secret, done) {
  let state = 'sent', buf = '', settle = null;
  const end = (ok, reason) => {
    if (state === 'done') return;
    state = 'done'; clearTimeout(timer); clearTimeout(settle);
    done(ok, reason);
  };
  const timer = setTimeout(() => end(false, 'no response to "enable"'), ENABLE_TIMEOUT);
  write('enable\r');
  return (text) => {
    if (state === 'done') return;
    buf = (buf + text).slice(-4096);
    const line = lastLine(buf);
    clearTimeout(settle);
    if (/password:?$/i.test(line)) {
      // A second password prompt means the first answer was wrong; don't keep guessing.
      if (state === 'answered') return end(false, 'the enable password was rejected');
      state = 'answered'; buf = '';
      if (!secret) return end(false, 'the device asked for an enable password and none is saved');
      write(secret + '\r');
    } else if (line.endsWith('#')) {
      settle = setTimeout(() => end(true), ENABLE_SETTLE);
    } else if (line.endsWith('>') && buf.includes('\n')) {
      settle = setTimeout(() => end(false, state === 'answered' ? 'the enable password was rejected' : '"enable" was refused'), ENABLE_SETTLE);
    }
  };
}

// Waits for the first prompt after login (the output must go quiet on a prompt-like line).
// Calls onPrompt(line) once.
export function firstPrompt(onPrompt, settleMs = 800, timeoutMs = 20000) {
  let buf = '', settle = null, fired = false;
  const fire = (line) => { if (!fired) { fired = true; clearTimeout(timer); onPrompt(line); } };
  const timer = setTimeout(() => fire(null), timeoutMs);
  const feed = (text) => {
    if (fired) return;
    buf = (buf + text).slice(-4096);
    clearTimeout(settle);
    const line = lastLine(buf);
    if (PROMPT_END.test(line)) settle = setTimeout(() => fire(line), settleMs);
  };
  feed.cancel = () => { fired = true; clearTimeout(timer); clearTimeout(settle); };
  return feed;
}
