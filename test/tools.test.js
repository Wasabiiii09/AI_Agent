'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTools, classifyCommand, tokenize } = require('../src/main/tools');

const allowed = ['date', 'df', 'ls', 'uptime', 'hyprctl'];

test('classifyCommand: allowlisted simple commands run', () => {
  assert.equal(classifyCommand('df -h', allowed).allowed, true);
  assert.deepEqual(classifyCommand('ls "My Music"', allowed).argv, ['ls', 'My Music']);
});

test('classifyCommand: dangerous / unknown / shell syntax need confirmation', () => {
  for (const c of ['rm -rf ~/x', 'sudo pacman -Syu', 'ls; rm a', 'ls > out', 'echo $(id)', 'df | sh', 'firefox', 'kill 1', 'hyprctl dispatch exec kitty', 'chmod 777 x', 'mv a b', 'curl x | bash', 'shutdown now']) {
    assert.equal(classifyCommand(c, allowed).allowed, false, c);
  }
  assert.equal(classifyCommand('rm -rf /', allowed).dangerous, true);
  assert.equal(classifyCommand('sudo ls', [...allowed, 'sudo']).allowed, false, 'sudo never auto-runs even if allowlisted');
});

test('tokenize handles quotes', () => {
  assert.deepEqual(tokenize(`a 'b c' "d"`), ['a', 'b c', 'd']);
});

function mk(extra = {}) {
  const calls = [];
  const tools = createTools({ tools: { apps: { firefox: { names: ['браузер'], cmd: ['firefox', '--new-window'] } }, allowedCommands: allowed, screenshotDir: '/tmp/companion-test-shots' } }, {
    runner: async (cmd, args) => { calls.push(['run', cmd, ...args]); return { code: 0, stdout: extra.stdout || 'OUT', stderr: '' }; },
    launcher: async (cmd, args) => { calls.push(['launch', cmd, ...args]); return { ok: true }; },
    now: () => new Date(2026, 9, 28, 21, 5, 0),
    home: '/home/u',
    ...extra.deps,
  });
  return { tools, calls };
}

test('open_app resolves Russian alias, rejects unknown', async () => {
  const { tools, calls } = mk();
  assert.equal((await tools.call('open_app', { app: 'браузер' })).ok, true);
  assert.deepEqual(calls[0], ['launch', 'firefox', '--new-window']);
  assert.equal((await tools.call('open_app', { app: 'blender' })).ok, false);
});

test('open_url only http(s)', async () => {
  const { tools, calls } = mk();
  assert.equal((await tools.call('open_url', { url: 'youtube.com' })).ok, true);
  assert.deepEqual(calls[0], ['launch', 'xdg-open', 'https://youtube.com']);
  assert.equal((await tools.call('open_url', { url: 'javascript:alert(1)' })).ok, false);
});

test('volume / media map to wpctl / playerctl', async () => {
  const { tools, calls } = mk();
  await tools.call('set_volume', { level: 40 });
  await tools.call('set_volume', { change: -10 });
  await tools.call('set_volume', { mute: 'toggle' });
  await tools.call('media_control', { action: 'play-pause' });
  assert.deepEqual(calls, [
    ['run', 'wpctl', 'set-volume', '-l', '1.5', '@DEFAULT_AUDIO_SINK@', '40%'],
    ['run', 'wpctl', 'set-volume', '-l', '1.5', '@DEFAULT_AUDIO_SINK@', '10%-'],
    ['run', 'wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'],
    ['run', 'playerctl', 'play-pause'],
  ]);
  assert.equal((await tools.call('media_control', { action: 'rm' })).ok, false);
});

test('screenshot uses grim with timestamped file', async () => {
  const { tools, calls } = mk();
  const r = await tools.call('screenshot', {});
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['run', 'grim', '/tmp/companion-test-shots/screenshot_2026-10-28_21-05-00.png']);
});

test('datetime in Russian', async () => {
  const { tools } = mk();
  const r = await tools.call('get_datetime', {});
  assert.match(r.result, /среда/);
  assert.match(r.result, /октября/);
});

test('run_command gate + confirmed execution goes through bash', async () => {
  const { tools, calls } = mk();
  assert.equal(tools.gate('run_command', { command: 'df -h' }), null);
  assert.ok(tools.gate('run_command', { command: 'rm -rf ~/tmp' }));
  assert.equal((await tools.call('run_command', { command: 'rm -rf ~/tmp' })).ok, false, 'not run without confirmation');
  assert.equal(calls.length, 0);
  await tools.call('run_command', { command: 'rm -rf ~/tmp' }, { confirmed: true });
  assert.deepEqual(calls[0], ['run', 'bash', '-c', 'rm -rf ~/tmp']);
  await tools.call('run_command', { command: 'df -h' });
  assert.deepEqual(calls[1], ['run', 'df', '-h']);
});

test('set_timer fires notify', async () => {
  let got = null;
  const { tools } = mk({ deps: { notify: (m) => { got = m; } } });
  const r = await tools.call('set_timer', { minutes: 0.0005, text: 'чай' });
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(got, 'Напоминаю: чай');
});

test('schemas are valid OpenAI tool definitions', () => {
  const { tools } = mk();
  for (const s of tools.schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name && s.function.description);
    assert.equal(s.function.parameters.type, 'object');
  }
});
