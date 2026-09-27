'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');

function activate({ platform, remoteName, extensionKind = 2, language = 'zh-CN' }) {
  const providers = new Map();
  const commands = new Map();
  const contexts = new Map();
  const managers = [];
  const sessions = [];
  const statusBars = [];
  const disposable = { dispose() {} };
  class ConfigStore {
    refresh() {}
    getCurrent() { return { servers: { restoreTabs: true } }; }
  }
  class DeviceMonitorManager {
    constructor(options) { this.options = options; managers.push(this); }
  }
  class MonitorSession {
    constructor(options) { this.options = options; this.started = false; sessions.push(this); }
    start() { this.started = true; }
  }
  class MultiMonitorViewProvider {
    constructor(options) { this.options = options; }
  }
  class MonitorViewProvider {
    constructor(options) { this.options = options; }
  }
  class StatusBarController {
    constructor(options) { statusBars.push(options); }
  }
  const vscode = {
    ExtensionKind: { UI: 1, Workspace: 2 },
    env: { remoteName, language },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: () => disposable,
    },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      registerWebviewViewProvider(id, provider) { providers.set(id, provider); return disposable; },
      registerWebviewPanelSerializer: () => disposable,
    },
    commands: {
      executeCommand(command, key, value) {
        if (command === 'setContext') contexts.set(key, value);
        return Promise.resolve();
      },
      registerCommand(id, callback) { commands.set(id, callback); return disposable; },
    },
  };
  const modules = {
    vscode,
    './config/config-store': { ConfigStore },
    './services/monitor-session': { MonitorSession },
    './view/monitor-view-provider': { MonitorViewProvider },
    './view/multi-monitor-view-provider': { MultiMonitorViewProvider },
    './services/device-monitor-manager': { DeviceMonitorManager },
    './view/status-bar-controller': { StatusBarController },
  };
  const sandbox = {
    module: { exports: {} },
    process: { platform, env: {} },
    require(id) { assert.ok(modules[id], 'Unexpected import: ' + id); return modules[id]; },
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/extension.js' });
  sandbox.module.exports.activate({ subscriptions: [], extension: { extensionKind }, workspaceState: {}, globalState: {} });
  const provider = providers.get('sysmonitor.panel');
  let html = '';
  if (provider.resolveWebviewView) {
    const view = { webview: { html: '' } };
    provider.resolveWebviewView(view);
    html = view.webview.html;
  }
  return { managers, sessions, statusBars, contexts, provider, html, MultiMonitorViewProvider, MonitorViewProvider };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`local ${platform} window retains multi-server SSH monitoring`, () => {
    const result = activate({ platform });
    assert.equal(result.managers.length, 1);
    assert.equal(result.managers[0].options.localLinux, platform === 'linux');
    assert.equal(result.sessions.length, 0);
    assert.ok(result.provider instanceof result.MultiMonitorViewProvider);
  });
}

for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
  test(`${remoteName} on a Linux workspace host starts remote collection`, () => {
    const result = activate({ platform: 'linux', remoteName });
    assert.equal(result.managers.length, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].started, true);
    assert.ok(result.provider instanceof result.MonitorViewProvider);
  });
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`remote window falling back to local ${platform} never collects local metrics`, () => {
    const result = activate({ platform, remoteName: 'ssh-remote', extensionKind: 1 });
    assert.equal(result.managers.length, 0);
    assert.equal(result.sessions.length, 0);
    assert.equal(result.statusBars.length, 0);
    assert.match(result.html, /请在远程环境中运行扩展/);
    assert.doesNotMatch(result.html, /当前远程环境不是 Linux/);
    assert.equal(result.contexts.get('sysmonitor.sidebarFixedActive'), false);
  });
}

test('a non-Linux remote workspace still displays the platform requirement', () => {
  const result = activate({ platform: 'darwin', remoteName: 'ssh-remote' });
  assert.equal(result.sessions.length, 0);
  assert.match(result.html, /当前远程环境不是 Linux（darwin）/);
});

test('local-host installation guidance is localized in English', () => {
  const result = activate({ platform: 'linux', remoteName: 'ssh-remote', extensionKind: 1, language: 'en' });
  assert.match(result.html, /System Monitor is running locally/);
  assert.doesNotMatch(result.html, /This remote is not Linux/);
});
