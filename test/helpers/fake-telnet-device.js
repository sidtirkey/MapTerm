// A small device CLI over Telnet for tests (no Docker needed). Options:
//   login             ask Username / Password first (password "pw")
//   silentUntilEnter  show nothing until the first Enter, like a console-server line
//   responses         { command: output } for known commands; others print 'output of "<cmd>"'
//   pageAfter         lines per page; longer output stops at " --More-- " until a key is sent
import net from 'node:net';

const servers = [];
export const closeFakeDevices = () => servers.forEach((s) => s.close());

export function fakeTelnetDevice({ name, login = false, silentUntilEnter = false, responses = {}, pageAfter = 0 }) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let state = login ? 'user' : 'cli', buf = '', woke = !silentUntilEnter, pending = null;
      const prompt = () => s.write(`\r\n${name}#`);
      const start = () => (login ? s.write('\r\nUsername: ') : prompt());
      // Writes output lines, pausing at --More-- every pageAfter lines.
      const page = (lines) => {
        const n = pageAfter || lines.length;
        s.write(lines.slice(0, n).map((l) => l + '\r\n').join(''));
        if (lines.length > n) { s.write(' --More-- '); pending = lines.slice(n); } else prompt();
      };
      if (woke) start();
      s.on('data', (b) => {
        if (pending) { s.write('\r          \r'); const rest = pending; pending = null; page(rest); return; }
        buf += b.toString('latin1').replace(/\0/g, '');
        for (let i; (i = buf.indexOf('\r')) >= 0;) {
          const line = buf.slice(0, i).replace(/^\n/, ''); buf = buf.slice(i + 1);
          if (!woke) { woke = true; start(); continue; }
          s.write(line + '\r\n');
          if (state === 'user') { state = 'pass'; s.write('Password: '); }
          else if (state === 'pass') { state = line === 'pw' ? 'cli' : 'user'; state === 'cli' ? prompt() : s.write('\r\nLogin invalid\r\nUsername: '); }
          else if (!line.trim()) prompt();
          else page((responses[line.trim()] ?? `output of "${line.trim()}"`).split('\n'));
        }
      });
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}
