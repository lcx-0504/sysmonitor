'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openSshTerminal } = require('../src/view/ssh-terminal');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');

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
