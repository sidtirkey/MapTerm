// Classifies commands for the "Run commands" safety check. No DOM here, so the tests in
// test/commands.test.js can import it directly.
//
// The list is of commands known only to read state; anything else counts as a possible
// change. That errs on the side of asking: an unfamiliar harmless command asks for
// confirmation, but nothing that changes a device slips through unflagged.

const READ_ONLY = /^((sh|sho|show|dis|disp|display|ping|traceroute|tracert|trace|dir|more|who|whoami|uptime|uname|pwd|ls|cat|df|free|get|echo|cd|exit|end|quit|logout|en|enable|disable)(\s|$)|term(inal)?\s+(len(gth)?|width|pager|mon(itor)?|no\s+mon(itor)?)\b|set cli screen-(length|width)\b|screen-length\s+\d+\s+temporary\b|hostname$)/i;
// Read commands that still write somewhere: "show run | redirect flash:x", "echo x > file".
const WRITES_FILE = /\|\s*(redirect|tee|append|save)\b|>\s*\S/i;
// Changes that take a device, link or service down, or delete data.
const DISRUPTIVE = /^(reload|reboot|restart|shutdown|shut|halt|poweroff|erase|delete|del|format|squeeze|clear|wr(ite)?\s+erase|crypto\s+key\s+zeroize|request\s+system\s+(reboot|halt|power-off|zeroize))\b/i;

// 'read' | 'change' | 'disruptive'. "do <cmd>" (from configuration mode) counts as <cmd>.
export function classify(cmd) {
  const c = cmd.trim().replace(/^do\s+/i, '');
  if (DISRUPTIVE.test(c)) return 'disruptive';
  return READ_ONLY.test(c) && !WRITES_FILE.test(c) ? 'read' : 'change';
}
