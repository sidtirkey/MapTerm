// Session recording: the REC button on each tab and Ctrl+Shift+L. The server writes the
// cleaned-up log file; this module only starts and stops it and shows status lines.
import { settings, askLogDir } from './settings.js';
import { activeId } from './sessions.js';

export const isRecKey = (e) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyL';
const REC_KEY = 'Ctrl+Shift+L';

// Status line in the terminal only; never sent to the device or the log. It is printed in
// place of the current line, which is then redrawn below it so the prompt stays under the cursor.
export function note(s, text, color = 90) {
  const b = s.term.buffer.active, x = b.cursorX;
  const line = b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
  s.term.write(`\r\x1b[2K\x1b[${color}m${text}\x1b[0m\r\n${line}\r${x ? `\x1b[${x}C` : ''}`);
}

// rec: null (not recording), 'pending' (asked the server), or the log file path.
export function setRec(s, rec) {
  s.rec = rec;
  const b = s.tab.querySelector('.rec');
  s.tab.classList.toggle('recording', !!rec);
  b.textContent = rec ? 'REC' : '●';
  b.title = rec === 'pending' ? 'Starting recording…'
    : rec ? `Recording to ${rec}\nClick or press ${REC_KEY} to stop` : `Record this session (${REC_KEY})`;
  b.setAttribute('aria-label', rec ? 'Stop recording' : 'Start recording');
}

export async function toggleRec(s) {
  if (s.rec === 'pending') return;
  if (s.rec) return s.out({ type: 'log-stop' });
  if (s.status !== 'live') return note(s, 'Recording starts once the session is connected.');
  if (!settings.logDir && !(await askLogDir('Choose where session logs are saved. You only need to do this once.'))) return;
  setRec(s, 'pending');
  // Seed the log with the line the cursor is on (normally the prompt).
  const b = s.term.buffer.active, line = b.getLine(b.baseY + b.cursorY);
  s.out({ type: 'log-start', name: s.name, seed: line ? line.translateToString(true) : '', seedCol: b.cursorX });
  if (activeId === s.id) s.term.focus();
}
