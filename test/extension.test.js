'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createFakeVscode, createMemento } = require('./fake-vscode');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');

async function activate({ platform, remoteName, extensionKind = 2, language = 'zh-CN', realConfig = false, env = {} }) {
  const managers = [];
  const sessions = [];
  const controllers = [];
  const flushes = [];
  const disposable = { dispose() {} };
  let configurationUpgraded = false;
  class ConfigStore {
    onDidChange() { return disposable; }
    onDidChangeSaveState() { return disposable; }
    async upgrade() { await Promise.resolve(); configurationUpgraded = true; }
    refresh() {}
    getCurrent() { return { servers: { restoreTabs: true } }; }
    flush() { flushes.push('flush'); return Promise.reject(new Error('settings are read only')); }
  }
  class DeviceMonitorManager {
    constructor(options) { assert.equal(configurationUpgraded, true); this.options = options; managers.push(this); }
  }
  class MonitorSession {
    constructor(options) { assert.equal(configurationUpgraded || realConfig, true); this.options = options; this.started = false; this.service={readSnapshot:()=>({accelerators:{value:null}})}; sessions.push(this); }
    start() { this.started = true; }
    updateConfig() {}
    isPaused() { return false; }
    viewState() { return null; }
    snapshotState() { return {}; }
  }
  class MultiMonitorViewProvider {
    constructor(options) { this.options = options; }
  }
  class MonitorViewProvider {
    constructor(options) { this.options = options; }
  }
  class StatusBarController {
    constructor(options) { controllers.push(options); }
  }
  const vscode = createFakeVscode({ remoteName, language });
  const modules = {
    './i18n': require('../src/i18n'),
    vscode,
    './config/config-store': realConfig ? require('../src/config/config-store') : { ConfigStore },
    './services/monitor-session': { MonitorSession },
    './view/monitor-view-provider': realConfig ? require('../src/view/monitor-view-provider') : { MonitorViewProvider },
    './view/multi-monitor-view-provider': { MultiMonitorViewProvider },
    './services/device-monitor-manager': { DeviceMonitorManager },
    './view/status-bar-controller': realConfig ? require('../src/view/status-bar-controller') : { StatusBarController },
    './view/action-visibility': require('../src/view/action-visibility'),
    './view/editor-panel': require('../src/view/editor-panel'),
  };
  const sandbox = {
    module: { exports: {} },
    process: { platform, env },
    require(id) { assert.ok(modules[id], 'Unexpected import: ' + id); return modules[id]; },
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/extension.js' });
  const subscriptions = [];
  await sandbox.module.exports.activate({ subscriptions, extension: { extensionKind }, workspaceState: createMemento(), globalState: createMemento() });
  const provider = vscode.fake.viewProviders.get('sysmonitor.panel').provider;
  let html = '';
  if (provider.resolveWebviewView && !realConfig) {
    const view = vscode.fake.createView();
    provider.resolveWebviewView(view);
    html = view.webview.html;
  }
  return {
    vscode, managers, sessions, controllers, flushes, subscriptions, provider, html, MultiMonitorViewProvider, MonitorViewProvider,
    commands: vscode.fake.registeredCommands, contexts: vscode.fake.contexts, executed: vscode.fake.executed,
    statusBarItems: vscode.fake.statusBarItems, deactivate: sandbox.module.exports.deactivate,
  };
}

test('native SSH monitoring retains client-only metadata when full endpoints are unavailable', async () => {
  const result=await activate({platform:'linux',remoteName:'ssh-remote',env:{SSH_CLIENT:'192.0.2.3 41234 22'}});
  assert.equal(result.sessions[0].options.serviceOptions.sshClientIp,'192.0.2.3');
  assert.equal(result.sessions[0].options.serviceOptions.sshConnectionInfo,null);
});

test('panel settings update the native status bar through the shared config subscription', async t => {
  const {provider,statusBarItems,vscode} = await activate({platform:'linux',remoteName:'ssh-remote',realConfig:true});
  t.after(() => provider.configStore.dispose());
  const original = statusBarItems[0];
  const view = vscode.fake.createView();
  await provider.resolveWebviewView(view);
  await view.receive({version:1,cmd:'ready'});
  const panel = vscode.fake.createPanel();
  await provider.attachEditor(panel, { page: 'perf' });
  await panel.receive({version:1,cmd:'ready'});
  view.messages.length = 0;
  panel.messages.length = 0;
  view.receive({version:1,cmd:'setConfig',key:'statusBar',changes:[{path:['alignment'],value:'right'},{path:['priority'],value:50}]});
  assert.equal(statusBarItems.length,2);
  assert.equal(original.disposed,true);
  assert.equal(statusBarItems[1].alignment,vscode.StatusBarAlignment.Right);
  assert.equal(statusBarItems[1].priority,50);
  assert.equal(view.messages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(panel.messages.filter(message=>message.cmd === 'config').length,1);
  await provider.configStore.flush();
  assert.equal(statusBarItems.length,2);
  assert.equal(view.messages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(panel.messages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(view.messages.at(-1).status,'saved');
  assert.deepEqual(vscode.fake.settingWrites.map(({ section, key, value }) => [section, key, value.alignment, value.priority]), [['sysmonitor', 'statusBar', 'right', 50]]);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`local ${platform} window retains multi-server SSH monitoring`, async () => {
    const result = await activate({ platform });
    assert.equal(result.managers.length, 1);
    assert.equal(result.managers[0].options.localLinux, platform === 'linux');
    assert.equal(result.sessions.length, 0);
    assert.ok(result.provider instanceof result.MultiMonitorViewProvider);
  });
}

for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
  test(`${remoteName} on a Linux workspace host starts remote collection`, async () => {
    const result = await activate({ platform: 'linux', remoteName });
    assert.equal(result.managers.length, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].started, true);
    assert.ok(result.provider instanceof result.MonitorViewProvider);
  });
}

test('remote SSH collection receives the complete connection endpoints including a custom port', async()=>{
  const result=await activate({platform:'linux',remoteName:'ssh-remote',env:{SSH_CONNECTION:'192.0.2.3 41234 192.0.2.4 2222'}});
  const info=result.sessions[0].options.serviceOptions.sshConnectionInfo();
  assert.equal(info.clientIp,'192.0.2.3');assert.equal(info.clientPort,41234);assert.equal(info.serverIp,'192.0.2.4');assert.equal(info.serverPort,2222);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`remote window falling back to local ${platform} never collects local metrics`, async () => {
    const result = await activate({ platform, remoteName: 'ssh-remote', extensionKind: 1 });
    assert.equal(result.managers.length, 0);
    assert.equal(result.sessions.length, 0);
    assert.equal(result.controllers.length, 0);
    assert.equal(result.statusBarItems.length, 0);
    assert.match(result.html, /请在远程环境中运行扩展/);
    assert.doesNotMatch(result.html, /当前远程环境不是 Linux/);
    assert.equal(result.contexts.get('sysmonitor.sidebarFixedActive'), false);
  });
}

test('a non-Linux remote workspace still displays the platform requirement', async () => {
  const result = await activate({ platform: 'darwin', remoteName: 'ssh-remote' });
  assert.equal(result.sessions.length, 0);
  assert.match(result.html, /当前远程环境不是 Linux（darwin）/);
});

test('local-host installation guidance is localized in English', async () => {
  const result = await activate({ platform: 'linux', remoteName: 'ssh-remote', extensionKind: 1, language: 'en' });
  assert.match(result.html, /System Monitor is running locally/);
  assert.doesNotMatch(result.html, /This remote is not Linux/);
});

const MODES = [
  { platform: 'darwin' },
  { platform: 'linux' },
  { platform: 'linux', remoteName: 'ssh-remote' },
  { platform: 'darwin', remoteName: 'ssh-remote' },
  { platform: 'linux', remoteName: 'ssh-remote', extensionKind: 1 },
];

test('every mode registers exactly the contributed commands and leaves hidden views unretained', async () => {
  const manifest = require('../package.json');
  const contributed = manifest.contributes.commands.map(({ command }) => command).sort();
  for (const mode of MODES) {
    const result = await activate(mode);
    assert.deepEqual([...result.commands.keys()].sort(), contributed, JSON.stringify(mode));
    for (const command of contributed) assert.equal(typeof result.commands.get(command), 'function', JSON.stringify(mode) + ' ' + command);
    assert.equal(result.vscode.fake.viewProviders.get('sysmonitor.panel').options, undefined, JSON.stringify(mode));
    assert.equal(typeof result.vscode.fake.serializers.get('sysmonitor.editor').deserializeWebviewPanel, 'function', JSON.stringify(mode));
  }
});

test('context keys are declared once, all used by manifest when clauses, and the only ones any mode sets', async () => {
  const { ACTION_CONTEXTS, TITLE_CONTEXTS } = require('../src/view/action-visibility');
  const manifest = require('../package.json');
  const declared = [...Object.values(ACTION_CONTEXTS), ...Object.values(TITLE_CONTEXTS)].sort();
  const clauses = Object.values(manifest.contributes.menus).flat().map((item) => item.when || '').join(' ');
  const referenced = new Set(clauses.match(/(?<!==\s*)\bsysmonitor\.\w+/g));
  assert.deepEqual([...referenced].sort(), declared);
  for (const mode of MODES) {
    const result = await activate(mode);
    for (const key of result.contexts.keys()) assert.ok(declared.includes(key), JSON.stringify(mode) + ' sets undeclared context ' + key);
  }
});

test('each mode routes its commands to its provider and leaves the remaining commands inert', async () => {
  const sidebarActions = {
    'sysmonitor.openEditor': ['moveSidebarDeviceToEditor'],
    'sysmonitor.openWindow': ['moveSidebarDeviceToEditor', true],
    'sysmonitor.openTerminal': ['openTerminalForSidebar'],
    'sysmonitor.openRemoteWindow': ['openRemoteWindowForSidebar'],
    'sysmonitor.editorTerminal': ['openTerminalForEditor'],
    'sysmonitor.editorRemoteWindow': ['openRemoteWindowForEditor'],
  };
  const editorActions = {
    'sysmonitor.copyToEditor': ['openEditorPanel'],
    'sysmonitor.copyToWindow': ['openFloatingPanel'],
    'sysmonitor.editorReturnSidebar': ['returnActiveEditorToSidebar'],
    'sysmonitor.editorMoveWindow': ['moveActiveEditorToNewWindow'],
  };
  const routes = [
    [{ platform: 'darwin' }, { ...sidebarActions, ...editorActions }, null],
    [{ platform: 'linux', remoteName: 'ssh-remote' }, editorActions, { sidebarSshActive: false, sidebarFixedActive: true, editorSshActive: false }],
    [{ platform: 'darwin', remoteName: 'ssh-remote' }, {}, { sidebarSshActive: false, sidebarFixedActive: false, editorSshActive: false }],
  ];
  const methods = [...new Set(Object.values({ ...sidebarActions, ...editorActions }).map(([name]) => name))];
  for (const [mode, expected, contexts] of routes) {
    const result = await activate(mode);
    const calls = [];
    for (const name of methods) result.provider[name] = (...args) => { calls.push([name, ...args]); };
    for (const [id, handler] of result.commands) {
      calls.length = 0;
      result.executed.length = 0;
      await handler();
      if (id === 'sysmonitor.openPanel') {
        assert.deepEqual(result.executed, [['workbench.view.extension.sysmonitor-container']], JSON.stringify(mode));
        assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(calls, expected[id] ? [expected[id]] : [], JSON.stringify(mode) + ' ' + id);
      }
    }
    if (contexts) {
      for (const [key, value] of Object.entries(contexts)) assert.equal(result.contexts.get('sysmonitor.' + key), value, JSON.stringify(mode) + ' ' + key);
    }
  }
});

test('device manager callbacks reach the multi-device views', async () => {
  const result = await activate({ platform: 'darwin' });
  const calls = [];
  result.provider.pauseChanged = (paused) => calls.push(['pause', paused]);
  result.provider.onDeviceUpdate = (id) => calls.push(['update', id]);
  result.provider.notifyResidualProcesses = (host, pids) => calls.push(['residual', host, pids]);
  const { onPauseChange, onUpdate, onResidualProcesses } = result.managers[0].options;
  onPauseChange(true);
  onUpdate('ssh:campus', {});
  onResidualProcesses('campus', [7], () => {});
  assert.deepEqual(calls, [['pause', true], ['update', 'ssh:campus'], ['residual', 'campus', [7]]]);
});

test('unsupported environments close restored monitor editors', async () => {
  const result = await activate({ platform: 'darwin', remoteName: 'ssh-remote' });
  const panel = result.vscode.fake.createPanel();
  await result.vscode.fake.serializers.get('sysmonitor.editor').deserializeWebviewPanel(panel, { page: 'proc' });
  assert.equal(panel.disposed, true);
  assert.deepEqual(panel.webview.htmlHistory, []);
});

test('deactivation waits for pending settings writes and ignores write failures', async () => {
  const result = await activate({ platform: 'darwin' });
  const pending = result.deactivate();
  assert.equal(typeof pending.then, 'function');
  assert.equal(await pending, undefined);
  assert.deepEqual(result.flushes, ['flush']);
});

test('the status bar controller owns its item instead of the extension subscriptions', async t => {
  const { provider, statusBarItems, subscriptions } = await activate({ platform: 'linux', remoteName: 'ssh-remote', realConfig: true });
  t.after(() => provider.configStore.dispose());
  assert.equal(subscriptions.includes(statusBarItems[0]), false);
  const controller = subscriptions.find((entry) => entry && typeof entry.recreate === 'function');
  controller.dispose();
  assert.equal(statusBarItems[0].disposed, true);
  controller.recreate();
  assert.equal(statusBarItems.length, 1);
});
