'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');

async function activate({ platform, remoteName, extensionKind = 2, language = 'zh-CN', realConfig = false, env = {} }) {
  const providers = new Map();
  const commands = new Map();
  const contexts = new Map();
  const managers = [];
  const sessions = [];
  const statusBars = [];
  const savedConfig = {};
  const disposable = { dispose() {} };
  let configurationUpgraded = false;
  class ConfigStore {
    onDidChange() { return disposable; }
    onDidChangeSaveState() { return disposable; }
    async upgrade() { await Promise.resolve(); configurationUpgraded = true; }
    refresh() {}
    getCurrent() { return { servers: { restoreTabs: true } }; }
  }
  class DeviceMonitorManager {
    constructor(options) { assert.equal(configurationUpgraded, true); this.options = options; managers.push(this); }
  }
  class MonitorSession {
    constructor(options) { assert.equal(configurationUpgraded || realConfig, true); this.options = options; this.started = false; this.service={readSnapshot:()=>({accelerators:{value:null}})}; sessions.push(this); }
    start() { this.started = true; }
    updateConfig() {}
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
      getConfiguration: () => ({ get: () => undefined, inspect:key=>({globalValue:savedConfig[key]}),update:async(key,value)=>{savedConfig[key]=value;} }),
      onDidChangeConfiguration: () => disposable,
    },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      registerWebviewViewProvider(id, provider) { providers.set(id, provider); return disposable; },
      registerWebviewPanelSerializer: () => disposable,
      createStatusBarItem(alignment,priority) {
        const item={alignment,priority,show() {},hide() {},dispose() {this.disposed=true;}};
        statusBars.push(item); return item;
      },
    },
    commands: {
      executeCommand(command, key, value) {
        if (command === 'setContext') contexts.set(key, value);
        return Promise.resolve();
      },
      registerCommand(id, callback) { commands.set(id, callback); return disposable; },
    },
    StatusBarAlignment:{Left:1,Right:2},
  };
  const modules = {
    './i18n': require('../src/i18n'),
    vscode,
    './config/config-store': realConfig ? require('../src/config/config-store') : { ConfigStore },
    './services/monitor-session': { MonitorSession },
    './view/monitor-view-provider': realConfig ? require('../src/view/monitor-view-provider') : { MonitorViewProvider },
    './view/multi-monitor-view-provider': { MultiMonitorViewProvider },
    './services/device-monitor-manager': { DeviceMonitorManager },
    './view/status-bar-controller': realConfig ? require('../src/view/status-bar-controller') : { StatusBarController },
  };
  const sandbox = {
    module: { exports: {} },
    process: { platform, env },
    require(id) { assert.ok(modules[id], 'Unexpected import: ' + id); return modules[id]; },
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/extension.js' });
  await sandbox.module.exports.activate({ subscriptions: [], extension: { extensionKind }, workspaceState: {}, globalState: {} });
  const provider = providers.get('sysmonitor.panel');
  let html = '';
  if (provider.resolveWebviewView && !realConfig) {
    const view = { webview: { html: '' } };
    provider.resolveWebviewView(view);
    html = view.webview.html;
  }
  return { managers, sessions, statusBars, contexts, provider, html, MultiMonitorViewProvider, MonitorViewProvider };
}

test('native SSH monitoring retains client-only metadata when full endpoints are unavailable', async () => {
  const result=await activate({platform:'linux',remoteName:'ssh-remote',env:{SSH_CLIENT:'192.0.2.3 41234 22'}});
  assert.equal(result.sessions[0].options.serviceOptions.sshClientIp,'192.0.2.3');
  assert.equal(result.sessions[0].options.serviceOptions.sshConnectionInfo,null);
});

test('panel settings update the native status bar through the shared config subscription', async t => {
  const {provider,statusBars} = await activate({platform:'linux',remoteName:'ssh-remote',realConfig:true});
  t.after(() => provider.configStore.dispose());
  const original = statusBars[0];
  const sidebarMessages = [], editorMessages = [];
  provider.view = {webview:{postMessage:message=>sidebarMessages.push(message)}}; provider.isReady = true;
  provider.editorPanels.set({webview:{postMessage:message=>editorMessages.push(message)}},true);
  provider.handleMessage({version:1,cmd:'setConfig',key:'statusBar',changes:[{path:['alignment'],value:'right'},{path:['priority'],value:50}]});
  assert.equal(statusBars.length,2);
  assert.equal(original.disposed,true);
  assert.equal(statusBars[1].alignment,2);
  assert.equal(statusBars[1].priority,50);
  assert.equal(sidebarMessages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(editorMessages.filter(message=>message.cmd === 'config').length,1);
  await provider.configStore.flush();
  assert.equal(statusBars.length,2);
  assert.equal(sidebarMessages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(editorMessages.filter(message=>message.cmd === 'config').length,1);
  assert.equal(sidebarMessages.at(-1).status,'saved');
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
    assert.equal(result.statusBars.length, 0);
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
