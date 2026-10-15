import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TelnetClient } from '../src/server/telnet.js';
import { openShell } from '../src/server/shell.js';
import { loginResponder } from '../src/server/cli.js';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31, LINEMODE = 34;

// A small Telnet "device": negotiates options, asks for a login, then shows a prompt.
// Everything the client sends is recorded.
function fakeDevice() {
  const got = [];
  const server = net.createServer((sock) => {
    sock.on('data', (b) => {
      got.push(...b);
      const text = Buffer.from(got).toString('latin1');
      if (text.includes('admin\r\0') && !sock.askedPw) { sock.askedPw = true; sock.write('Password: '); }
      if (text.includes('secret\r\0') && !sock.loggedIn) { sock.loggedIn = true; sock.write('\r\nR1>'); }
    });
    sock.write(Buffer.from([IAC, DO, NAWS, IAC, WILL, ECHO, IAC, DO, TTYPE, IAC, DO, LINEMODE, IAC, SB, TTYPE, 1, IAC, SE]));
    sock.write('\r\nUser Access Verification\r\n\r\nUsername: ');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, got })));
}
const includes = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

test('negotiates echo, terminal type and window size, refuses other options', async (t) => {
  const { server, port, got } = await fakeDevice();
  t.after(() => server.close());
  const c = new TelnetClient({ host: '127.0.0.1', port, cols: 132, rows: 40, term: 'vt100' });
  const text = [];
  c.on('data', (b) => text.push(b.toString()));
  c.connect();
  await new Promise((r) => setTimeout(r, 200));
  c.end();
  assert.ok(includes(got, [IAC, WILL, NAWS]), 'agrees to send its window size');
  assert.ok(includes(got, [IAC, SB, NAWS, 0, 132, 0, 40, IAC, SE]), 'sends 132x40');
  assert.ok(includes(got, [IAC, DO, ECHO]), 'lets the device echo');
  assert.ok(includes(got, [IAC, SB, TTYPE, 0, ...Buffer.from('vt100'), IAC, SE]), 'sends its terminal type');
  assert.ok(includes(got, [IAC, WONT, LINEMODE]), 'refuses unknown options');
  assert.match(text.join(''), /Username: $/, 'commands are removed from the data');
  assert.ok(!text.join('').includes('\xff'), 'no Telnet bytes leak into the data');
});

test('logs in with the saved username and password', async (t) => {
  const { server, port, got } = await fakeDevice();
  t.after(() => server.close());
  const sh = openShell({ protocol: 'telnet', host: '127.0.0.1', port, auth: { username: 'admin', password: 'secret' } });
  let out = '';
  sh.on('data', (b) => (out += b.toString()));
  await new Promise((resolve) => { const check = setInterval(() => { if (out.endsWith('R1>')) { clearInterval(check); resolve(); } }, 20); });
  sh.write('show ver\r');
  await new Promise((r) => setTimeout(r, 100));
  sh.end();
  assert.ok(includes(got, 'admin\r\0') && includes(got, 'secret\r\0'), 'answers Username and Password, Enter sent as CR NUL');
  assert.ok(includes(got, 'show ver\r\0'));
});

test('handles the byte 0xFF: unescaped in data received, kept out of window sizes sent', () => {
  const sent = [], data = [];
  const c = new TelnetClient({ host: 'x', cols: 255, rows: 24 });
  c.send = (b) => sent.push(...b);
  c.on('data', (b) => data.push(...b));
  c.receive(Buffer.from([0x41, IAC, IAC, 0x42]));
  assert.deepEqual(data, [0x41, 0xff, 0x42], 'IAC IAC from the device is one 0xFF byte');
  c.receive(Buffer.from([IAC, DO, NAWS]));
  assert.ok(includes(sent, [IAC, SB, NAWS, 0, 254, 0, 24, IAC, SE]), 'a width of 255 is sent as 254');
  c.resize(511, 100);
  assert.ok(includes(sent, [IAC, SB, NAWS, 1, 254, 0, 100, IAC, SE]), 'and 511 as 510');
});

test('the login responder answers each prompt once and reports a rejected login', () => {
  const typed = [], failures = [];
  const feed = loginResponder((x) => typed.push(x), { username: 'admin', password: 'pw' }, (why) => failures.push(why));
  feed('\r\nR1 login: '); feed('admin\r\nPassword: '); feed('\r\nLogin incorrect\r\nR1 login: ');
  assert.deepEqual(typed, ['admin\r', 'pw\r']);
  assert.deepEqual(failures, ['the login was rejected']);
});

test('the login responder reports a password prompt when none is saved', () => {
  const failures = [];
  const feed = loginResponder(() => {}, { username: 'admin' }, (why) => failures.push(why));
  feed('Password: ');
  assert.match(failures[0], /no(ne)? .*saved/);
});

test('SSH keys are refused over Telnet', async () => {
  const sh = openShell({ protocol: 'telnet', host: '127.0.0.1', port: 1, auth: { username: 'a', privateKey: Buffer.from('k') } });
  const err = await new Promise((resolve) => sh.on('error', resolve));
  assert.match(err.message, /SSH keys cannot be used over Telnet/);
});
