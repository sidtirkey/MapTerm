// A small Telnet client (RFC 854) for device command lines. It negotiates the options a CLI
// session needs: the server echoes, go-ahead is suppressed, and the terminal type and window
// size are sent. All other options are refused. Received data is passed on as bytes, with the
// Telnet commands removed.
import net from 'node:net';
import { EventEmitter } from 'node:events';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;
const TTYPE_IS = 0, TTYPE_SEND = 1;
const WE_DO = new Set([SGA, TTYPE, NAWS]); // options we agree to perform (server sent DO)
const THEY_DO = new Set([ECHO, SGA]);      // options we let the server perform (server sent WILL)

export class TelnetClient extends EventEmitter {
  constructor({ host, port = 23, cols = 80, rows = 24, term = 'xterm-256color', timeout = 15000 }) {
    super();
    Object.assign(this, { host, port, cols, rows, term, timeout });
    this.local = new Set();  // options we are performing
    this.remote = new Set(); // options the server is performing
    this.state = 'data'; this.cmd = 0; this.sb = [];
  }

  connect() {
    const s = this.sock = net.connect({ host: this.host, port: this.port });
    s.setTimeout(this.timeout, () => s.destroy(new Error(`Timed out connecting to ${this.host}:${this.port}`)));
    s.on('connect', () => { s.setTimeout(0); s.setNoDelay(true); this.emit('connect'); });
    s.on('data', (b) => this.receive(b));
    s.on('error', (e) => this.emit('error', e));
    s.on('close', () => this.emit('close'));
  }

  // Separates Telnet commands from data; works across chunk boundaries.
  receive(buf) {
    const out = [];
    for (const b of buf) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'; else out.push(b);
          break;
        case 'iac':
          if (b === IAC) { out.push(IAC); this.state = 'data'; }            // escaped 0xFF
          else if (b >= WILL && b <= DONT) { this.cmd = b; this.state = 'opt'; }
          else if (b === SB) { this.sb = []; this.state = 'sb'; }
          else this.state = 'data';                                          // GA, NOP, ...
          break;
        case 'opt':
          this.negotiate(this.cmd, b); this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb-iac'; else this.sb.push(b);
          break;
        case 'sb-iac':
          if (b === SE) { this.subnegotiation(this.sb); this.state = 'data'; }
          else { this.sb.push(b); this.state = 'sb'; }                       // IAC IAC inside SB
          break;
      }
    }
    if (out.length) this.emit('data', Buffer.from(out));
  }

  // Replies only when an option's state changes, so the two sides never loop.
  negotiate(cmd, opt) {
    if (cmd === DO) {
      if (WE_DO.has(opt)) { if (!this.local.has(opt)) { this.local.add(opt); this.send([IAC, WILL, opt]); } if (opt === NAWS) this.sendSize(); }
      else this.send([IAC, WONT, opt]);
    } else if (cmd === DONT) {
      if (this.local.delete(opt)) this.send([IAC, WONT, opt]);
    } else if (cmd === WILL) {
      if (THEY_DO.has(opt)) { if (!this.remote.has(opt)) { this.remote.add(opt); this.send([IAC, DO, opt]); } }
      else this.send([IAC, DONT, opt]);
    } else if (cmd === WONT) {
      if (this.remote.delete(opt)) this.send([IAC, DONT, opt]);
    }
  }

  subnegotiation([opt, kind]) {
    if (opt === TTYPE && kind === TTYPE_SEND) this.send([IAC, SB, TTYPE, TTYPE_IS, ...Buffer.from(this.term), IAC, SE]);
  }

  // Window size. A size containing the byte 0xFF (e.g. 255 or 511 columns) would need that byte
  // doubled, which some servers (busybox telnetd, some device CLIs) misread, turning a leftover
  // byte into typed input. One column or row less avoids the problem entirely.
  sendSize() {
    if (!this.local.has(NAWS)) return;
    const safe = (v) => ((v & 255) === 255 ? v - 1 : v);
    const w = safe(this.cols), h = safe(this.rows);
    this.send([IAC, SB, NAWS, w >> 8, w & 255, h >> 8, h & 255, IAC, SE]);
  }

  send(bytes) { if (this.sock && !this.sock.destroyed) this.sock.write(Buffer.from(bytes)); }

  // Text typed by the user or a command. 0xFF is escaped, and a lone CR is sent as CR NUL
  // (what Telnet expects for the Enter key).
  write(text) {
    const bytes = [];
    for (const b of Buffer.from(String(text).replace(/\r(?!\n)/g, '\r\0'), 'utf8')) bytes.push(...(b === IAC ? [IAC, IAC] : [b]));
    this.send(bytes);
  }

  resize(cols, rows) { this.cols = cols; this.rows = rows; this.sendSize(); }

  end() { if (this.sock) this.sock.end(); }
}
