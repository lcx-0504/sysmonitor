'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  openSshTerminal, processSession, sessionTerminalOptions, quoteShellArgument, quoteRemoteShellArgument,
} = require('../src/view/ssh-terminal');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');

const SESSION_NAMES = ['train', 'my session', "it's", "'; touch pwned; '", '$HOME', '${SHELL}', '`id`', '$(id)', 'a\\b', 'trailing\\', '%s %n', '!event', 'semi;colon|pipe&', '会话 ünï'];

function sessionFor(type, name) {
  return { type, name, id: type === 'tmux' ? name : '4242.' + name };
}

function sessionSandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmonitor-session-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'record.json');
  const recorder = '#!/bin/sh\n{ printf \'%s\\0\' "$@"; printf \'%s\\0%s\\0\' "${TMUX+set}" "${TMUX_PANE+set}"; } > "$FAKE_RECORD"\nexit "$FAKE_EXIT"\n';
  for (const command of ['tmux', 'screen']) fs.writeFileSync(path.join(directory, command), recorder, { mode: 0o755 });
  const loginShell = path.join(directory, 'login-shell');
  fs.writeFileSync(loginShell, '#!/bin/sh\nprintf "login:%s\\n" "$1"\n', { mode: 0o755 });
  return {
    env: (exitCode) => ({
      PATH: `${directory}:/usr/bin:/bin`, HOME: directory, SHELL: loginShell,
      FAKE_RECORD: record, FAKE_EXIT: String(exitCode), TMUX: '/tmp/outer,1,0', TMUX_PANE: '%1',
    }),
    read() {
      const fields = fs.readFileSync(record, 'utf8').split('\0');
      fs.rmSync(record);
      return { args: fields.slice(0, -3), tmux: fields.at(-3) || null, pane: fields.at(-2) || null };
    },
  };
}

function assertAttached(sandbox, session, result, exitCode, label) {
  assert.equal(result.status, 0, label + ': ' + result.stderr);
  const record = sandbox.read();
  assert.deepEqual(record.args, session.type === 'tmux' ? ['attach-session', '-t', '=' + session.id] : ['-x', session.id], label);
  assert.equal(record.tmux, null, label);
  assert.equal(record.pane, null, label);
  assert.equal(result.stdout, (exitCode ? `cannot attach ${session.name}\n` : '') + 'login:-l\n', label);
}

test('SSH terminal launches ssh directly with literal arguments and no local shell command', () => {
  const created = [];
  let shown = 0;
  const terminal = { show: () => shown++, sendText: () => assert.fail('SSH must be the terminal process') };
  const vscode = { window: { createTerminal: (options) => { created.push(options); return terminal; } } };
  assert.equal(openSshTerminal(vscode, 'campus', null), terminal);
  assert.deepEqual(created[0], { name: 'SSH: campus', shellPath: 'ssh', shellArgs: ['campus'] });
  const config = "/tmp/config path/owner's ssh";
  openSshTerminal(vscode, 'campus', config);
  assert.deepEqual(created[1], { name: 'SSH: campus', shellPath: 'ssh', shellArgs: ['-F', config, 'campus'] });
  assert.equal(shown, 2);
});

test('SSH shortcut validates the selected host and launches without a monitor preflight', async () => {
  const created = [];
  const provider = Object.create(MultiMonitorViewProvider.prototype);
  provider.serverDirectory = {
    hasHost: (host) => host === 'campus',
    runShortcutAction: async (_host, _kind, action) => action(),
  };
  provider.vscode = {
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: { createTerminal: (options) => { created.push(options); return { show() {} }; } },
  };
  await provider.openTerminal('unknown');
  assert.equal(created.length, 0);
  await provider.openTerminal('campus');
  assert.deepEqual(created, [{ name: 'SSH: campus', shellPath: 'ssh', shellArgs: ['campus'] }]);
});

test('shell quoting escapes single quotes and keeps every other character literal', () => {
  assert.equal(quoteShellArgument('train'), "'train'");
  assert.equal(quoteShellArgument("it's"), "'it'\\''s'");
  assert.equal(quoteShellArgument('$HOME `id` a\\b'), "'$HOME `id` a\\b'");
  assert.equal(quoteRemoteShellArgument("it's a\\b!"), "'it'\\''s a'\\\\'b'\\!''");
});

test('local session terminals run the attach script in /bin/sh without inherited tmux variables', () => {
  const tmux = sessionTerminalOptions({ type: 'tmux', name: 'train', id: 'train' }, { failureMessage: 'gone' });
  assert.deepEqual(tmux, {
    name: 'tmux: train', shellPath: '/bin/sh', env: { TMUX: null, TMUX_PANE: null },
    shellArgs: ['-c', 'unset TMUX TMUX_PANE; tmux attach-session -t \'=train\' || printf \'%s\\n\' \'gone\'; exec "${SHELL:-/bin/sh}" -l'],
  });
  const screen = sessionTerminalOptions({ type: 'screen', name: 'train', id: '4242.train' }, { failureMessage: 'gone' });
  assert.equal(screen.name, 'screen: train');
  assert.match(screen.shellArgs[1], / screen -x '4242\.train' \|\| /);
});

test('SSH session terminals pass the host and one remote sh command to ssh', () => {
  const options = sessionTerminalOptions({ type: 'screen', name: 'train', id: '4242.train' }, { failureMessage: 'gone', host: 'campus', configFile: '/tmp/ssh config' });
  assert.equal(options.name, 'campus · screen: train');
  assert.equal(options.shellPath, 'ssh');
  assert.equal(options.env, undefined);
  assert.deepEqual(options.shellArgs.slice(0, 4), ['-F', '/tmp/ssh config', '-t', 'campus']);
  assert.equal(options.shellArgs.length, 5);
  assert.match(options.shellArgs[4], /^sh -c '/);
  assert.deepEqual(sessionTerminalOptions({ type: 'tmux', name: 'x', id: 'x' }, { failureMessage: 'gone', host: 'campus' }).shellArgs.slice(0, 2), ['-t', 'campus']);
});

for (const type of ['tmux', 'screen']) {
  test(`${type} session names reach the attach command unchanged through the local shell`, (t) => {
    const sandbox = sessionSandbox(t);
    for (const exitCode of [0, 1]) for (const name of SESSION_NAMES) {
      const session = sessionFor(type, name);
      const options = sessionTerminalOptions(session, { failureMessage: `cannot attach ${name}` });
      const result = spawnSync(options.shellPath, options.shellArgs, { env: sandbox.env(exitCode), encoding: 'utf8' });
      assertAttached(sandbox, session, result, exitCode, `${exitCode} ${name}`);
    }
  });

  test(`${type} session names survive the remote login shell before sh runs the attach script`, (t) => {
    const sandbox = sessionSandbox(t);
    const loginShells = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/bin/ksh', '/bin/csh', '/bin/tcsh', '/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'].filter((shell) => fs.existsSync(shell));
    assert.ok(loginShells.includes('/bin/sh'));
    for (const shell of loginShells) for (const name of SESSION_NAMES) {
      const session = sessionFor(type, name);
      const options = sessionTerminalOptions(session, { failureMessage: `cannot attach ${name}`, host: 'campus' });
      const result = spawnSync(shell, ['-c', options.shellArgs.at(-1)], { env: sandbox.env(1), encoding: 'utf8' });
      assertAttached(sandbox, session, result, 1, `${shell} ${name}`);
    }
  });
}

test('session lookup uses the current process row and rejects malformed session data', () => {
  const viewModel = { processes: [
    { pid: 10, session: { type: 'tmux', name: 'train', id: 'train', extra: true } },
    { pid: 11, session: null },
    { pid: 12, session: { type: 'zellij', name: 'x', id: 'x' } },
    { pid: 13, session: { type: 'screen', name: 'x', id: '' } },
    { pid: 14, session: { type: 'tmux', name: 'line\nbreak', id: 'line\nbreak' } },
    { pid: 15, session: { type: 'screen', name: 7, id: '1.x' } },
  ] };
  assert.deepEqual(processSession(viewModel, 10), { type: 'tmux', name: 'train', id: 'train' });
  for (const pid of [11, 12, 13, 14, 15, 99, '10', 10.5]) assert.equal(processSession(viewModel, pid), null, String(pid));
  assert.equal(processSession(null, 10), null);
  assert.equal(processSession({ processes: null }, 10), null);
});
