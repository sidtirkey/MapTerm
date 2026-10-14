import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/web/js/commands.js';

const cases = {
  read: [
    'show version', 'sh ip int br', 'show run | include hostname', 'display interface brief',
    'terminal length 0', 'term len 0', 'set cli screen-length 0', 'screen-length 0 temporary',
    'ping 10.0.0.1', 'traceroute 8.8.8.8', 'dir flash:', 'enable', 'exit', 'end',
    'get system status', 'do show ip route',
  ],
  change: [
    'conf t', 'configure terminal', 'interface Gi0/1', 'no shutdown', 'ip address 10.0.0.1 255.255.255.0',
    'hostname R2', 'write memory', 'copy run start', 'commit', 'set interfaces ge-0/0/0 disable',
    'show run | redirect flash:backup.cfg', 'echo hi > /tmp/x', 'showtime',
  ],
  disruptive: [
    'shutdown', 'reload', 'write erase', 'delete flash:x.bin', 'clear ip bgp *', 'request system reboot',
  ],
};

for (const [expected, commands] of Object.entries(cases)) {
  test(`classifies ${expected} commands`, () => {
    for (const c of commands) assert.equal(classify(c), expected, c);
  });
}
