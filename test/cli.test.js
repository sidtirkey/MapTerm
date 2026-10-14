import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_END, MORE, lastLine, enabler, firstPrompt } from '../src/server/cli.js';

test('lastLine returns the line on screen, without colours or overwritten text', () => {
  assert.equal(lastLine('show ver\r\nR1#'), 'R1#');
  assert.equal(lastLine('x\r\n\x1b[32mnmcore11:~$\x1b[0m '), 'nmcore11:~$');
  assert.equal(lastLine('abc\b\bd'), 'ad');
});

test('recognises prompts', () => {
  for (const p of ['R1>', 'R1#', 'R1(config-if)#', 'user@host:~$', 'admin@router>', '[admin@fw ~]$']) assert.match(p, PROMPT_END, p);
  assert.doesNotMatch('Building configuration...', PROMPT_END);
});

test('recognises pagers from different vendors', () => {
  for (const p of ['--More--', ' --More-- ', '---(more 45%)---', '---- More ----', '<--- More --->', 'Press any key to continue']) {
    assert.match(lastLine(p), MORE, p);
  }
  assert.doesNotMatch('show more-stuff', MORE);
});

// Drives an enabler with scripted device output; resolves to [ok, reason, what was typed].
function runEnabler(secret, replies) {
  return new Promise((resolve) => {
    const typed = [];
    const feed = enabler((x) => {
      typed.push(x);
      const reply = replies.shift();
      if (reply) setTimeout(() => feed(reply), 5);
    }, secret, (ok, why) => resolve([ok, why, typed]));
  });
}

test('enabler sends "enable" and the password, then succeeds at a # prompt', async () => {
  const [ok, , typed] = await runEnabler('cisco', ['enable\r\nPassword: ', '\r\nR1#']);
  assert.equal(ok, true);
  assert.deepEqual(typed, ['enable\r', 'cisco\r']);
});

test('enabler gives up after one wrong password instead of guessing', async () => {
  const [ok, why, typed] = await runEnabler('wrong', ['enable\r\nPassword: ', '\r\nPassword: ']);
  assert.equal(ok, false);
  assert.match(why, /rejected/);
  assert.equal(typed.length, 2);
});

test('enabler reports a password prompt when no enable password is saved', async () => {
  const [ok, why] = await runEnabler('', ['enable\r\nPassword: ']);
  assert.equal(ok, false);
  assert.match(why, /none is saved/);
});

test('firstPrompt waits for output to go quiet on a prompt', async () => {
  const line = await new Promise((resolve) => {
    const feed = firstPrompt(resolve, 30, 1000);
    feed('Welcome\r\n# banner line #\r\n');
    setTimeout(() => feed('R1>'), 5);
  });
  assert.equal(line, 'R1>');
});
